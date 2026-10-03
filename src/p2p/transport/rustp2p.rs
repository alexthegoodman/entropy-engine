//! KCP backend candidate: `rustp2p` datagrams + `rustp2p-reliable` streams, adapted onto
//! the `P2pTransport` seam.
//!
//! This is the "battle-tested" of the two phase-1 candidates. It is also the one that most
//! directly maps onto the control model in section 2 of the design: the `GroupCode` is
//! network isolation, `Algorithm::AesGcm` is the PSK encryption, and `DataInterceptor` is
//! the socket-level choke point that consults the allowlist.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{Datagram, P2pTransport, PeerId, ReliableChannel, RouteMode, TransportEvent};

use ::rustp2p as rp;
use ::rustp2p::cipher::Algorithm;

/// A `rustp2p::DataInterceptor` that drops any frame whose source node id is not
/// allowlisted, demonstrating the socket-level choke point from section 2.3.
///
/// Spike finding worth recording: `pre_handle` runs *before* decryption, so only frame
/// metadata is visible here - `src_id`/`dest_id`/`group_code`/`ttl`/`protocol` (the header
/// is plaintext). The content id inside the encrypted payload is NOT visible. Content-id
/// filtering therefore belongs in the post-decrypt network service (after `recv_from`),
/// not in this interceptor. Also note the crate treats a `true` return as *keep*, which is
/// the opposite of what docs.rs claims.
pub struct AllowInterceptor {
    /// Allowed source node ids (IPv4, big-endian).
    pub allow_src: Vec<u32>,
}

impl rp::DataInterceptor for AllowInterceptor {
    fn pre_handle<'life0, 'life1, 'async_trait>(
        &'life0 self,
        data: &'life1 mut rp::RecvResult<'_>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'async_trait>>
    where
        Self: 'async_trait,
        'life0: 'async_trait,
        'life1: 'async_trait,
    {
        let keep = data
            .net_packet()
            .ok()
            .map(|p| {
                let mut id = [0u8; 4];
                id.copy_from_slice(p.src_id());
                self.allow_src.contains(&u32::from_be_bytes(id))
            })
            .unwrap_or(false);
        Box::pin(async move { keep })
    }
}

/// Backend-specific construction config. Not part of `P2pTransport` by design.
pub struct KcpConfig {
    pub node_id: std::net::Ipv4Addr,
    pub udp_port: u16,
    pub tcp_port: u16,
    pub group_code: String,
    pub psk_password: String,
    /// Bootstrap peers as `"udp://ip:port"` / `"tcp://ip:port"` strings.
    pub bootstrap: Vec<String>,
    /// Source node ids the interceptor allows through (IPv4, big-endian).
    pub allow_src: Vec<u32>,
}

pub struct KcpTransport {
    endpoint: Arc<rp::EndPoint>,
    local: PeerId,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    allowed: Arc<std::sync::RwLock<Vec<u32>>>,
    rx: tokio::sync::Mutex<tokio::sync::mpsc::Receiver<TransportEvent>>,
    modes: Arc<Mutex<std::collections::HashMap<PeerId, RouteMode>>>,
}

struct LiveInterceptor(Arc<std::sync::RwLock<Vec<u32>>>);
impl rp::DataInterceptor for LiveInterceptor {
    fn pre_handle<'life0, 'life1, 'async_trait>(&'life0 self, data: &'life1 mut rp::RecvResult<'_>) -> Pin<Box<dyn Future<Output = bool> + Send + 'async_trait>>
    where Self: 'async_trait, 'life0: 'async_trait, 'life1: 'async_trait {
        let keep = data.net_packet().ok().is_some_and(|p| {
            let id = u32::from_be_bytes(p.src_id().try_into().unwrap());
            self.0.read().is_ok_and(|ids|ids.contains(&id))
        });
        Box::pin(async move { keep })
    }
}

fn peer_to_node_id(peer: &PeerId) -> io::Result<rp::NodeID> {
    let ip: std::net::Ipv4Addr = peer
        .as_str()
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "peer id is not an ipv4 address"))?;
    Ok(ip.into())
}

/// A reliable KCP channel framed into messages with a `u32` length prefix. `rustp2p`'s KCP stream
/// is a byte stream while `ReliableChannel` is message-oriented, so this adapter applies the same
/// framing the QUIC backend uses, keeping the seam uniform.
struct KcpChannel {
    send: Option<rp::KcpStreamWrite>,
    recv: rp::KcpStreamRead,
}

async fn read_exact_kcp(recv: &mut rp::KcpStreamRead, n: usize) -> io::Result<Vec<u8>> {
    let mut out = vec![0u8; n];
    let mut filled = 0usize;
    while filled < n {
        let k = recv.read(&mut out[filled..]).await?;
        if k == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "kcp stream closed mid-message",
            ));
        }
        filled += k;
    }
    Ok(out)
}

impl ReliableChannel for KcpChannel {
    fn send(
        &mut self,
        data: Bytes,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let len = (data.len() as u32).to_be_bytes();
        Box::pin(async move {
            super::check_frame_len(data.len())?;
            let send = self
                .send
                .as_mut()
                .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "send half closed"))?;
            send.write_all(&len).await?;
            send.write_all(data.as_ref()).await
        })
    }

    fn recv(&mut self) -> Pin<Box<dyn Future<Output = Option<io::Result<Bytes>>> + Send + '_>> {
        Box::pin(async move {
            let len_buf = match read_exact_kcp(&mut self.recv, 4).await {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return None,
                Err(e) => return Some(Err(e)),
            };
            let n = u32::from_be_bytes([len_buf[0], len_buf[1], len_buf[2], len_buf[3]]) as usize;
            if let Err(e) = super::check_frame_len(n) { return Some(Err(e)); }
            match read_exact_kcp(&mut self.recv, n).await {
                Ok(b) => Some(Ok(Bytes::from(b))),
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => None,
                Err(e) => Some(Err(e)),
            }
        })
    }
}

impl KcpTransport {
    pub async fn start(cfg: KcpConfig) -> io::Result<Self> {
        let allowed = Arc::new(std::sync::RwLock::new(cfg.allow_src));
        let group_code = rp::GroupCode::try_from(cfg.group_code.as_str())
            .map_err(|e| super::io_other(e))?;

        let mut builder = rp::Builder::new()
            .node_id(cfg.node_id.into())
            .udp_port(cfg.udp_port)
            .tcp_port(cfg.tcp_port)
            .group_code(group_code)
            .interceptor(LiveInterceptor(allowed.clone()));

        if !cfg.psk_password.is_empty() {
            builder = builder.encryption(Algorithm::AesGcm(cfg.psk_password));
        }

        if !cfg.bootstrap.is_empty() {
            let mut peers = Vec::with_capacity(cfg.bootstrap.len());
            for s in &cfg.bootstrap {
                let peer = rp::PeerNodeAddress::from_str(s)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
                peers.push(peer);
            }
            builder = builder.peers(peers);
        }

        let endpoint = Arc::new(builder.build().await?);
        let local = PeerId::new(cfg.node_id.to_string());

        let (tx, rx) = tokio::sync::mpsc::channel::<TransportEvent>(64);
        let modes = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let accept_tx = tx.clone();

        // Drain the datagram receive loop into the bounded event queue. This is the
        // `mcp_rx` bridge pattern from the design: network I/O never touches the frame.
        let drain_ep = Arc::clone(&endpoint);
        let drain_modes = Arc::clone(&modes);
        let task1 = tokio::spawn(async move {
            loop {
                match drain_ep.recv_from().await {
                    Ok((data, meta)) => {
                        let mode = if meta.is_relay() {
                            RouteMode::Relayed
                        } else {
                            RouteMode::Direct
                        };
                        let src: std::net::Ipv4Addr = meta.src_id().into();
                        let peer = PeerId::new(src.to_string());
                        if let Ok(mut g) = drain_modes.lock() {
                            g.insert(peer.clone(), mode);
                        }
                        let dg = Datagram {
                            peer,
                            payload: Bytes::copy_from_slice(data.payload()),
                            route: mode,
                        };
                        if tx.send(TransportEvent::Datagram(dg)).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Accept incoming KCP streams (piece data) and surface them as reliable channels. KCP
        // data is routed internally by `rustp2p` (it never appears on `recv_from`), so this
        // listener is the one place inbound streams are observed.
        let accept_ep = Arc::clone(&endpoint);
        let task2 = tokio::spawn(async move {
            let listener = accept_ep.kcp_listener();
            loop {
                match listener.accept().await {
                    Ok((stream, node_id)) => {
                        let src: std::net::Ipv4Addr = node_id.into();
                        let peer = PeerId::new(src.to_string());
                        let (write, read) = stream.split();
                        let channel = KcpChannel {
                            send: Some(write),
                            recv: read,
                        };
                        if accept_tx
                            .send(TransportEvent::IncomingChannel {
                                peer,
                                channel: Box::new(channel),
                            })
                            .await.is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            endpoint,
            local,
            tasks: vec![task1, task2],
            allowed,
            rx: tokio::sync::Mutex::new(rx),
            modes,
        })
    }

    /// Discovery remains a hint; room signatures and payload hashes provide authorization.
    /// Replace the bounded set of candidate sockets and source IDs, preserving explicit pins
    /// at the service layer. Numeric sockets avoid DNS work in the actor.
    pub async fn update_peers(&self, peers: &[(std::net::Ipv4Addr, std::net::SocketAddr)]) -> io::Result<()> {
        if peers.len() > 64 { return Err(io::Error::other("too many discovery peers")); }
        let addresses = peers.iter().map(|(_,address)| rp::PeerNodeAddress::from_str(&format!("udp://{address}"))).collect::<Result<Vec<_>,_>>().map_err(super::io_other)?;
        self.endpoint.node_context().update_direct_nodes(addresses).await?;
        *self.allowed.write().map_err(|_|io::Error::other("peer lock poisoned"))? = peers.iter().map(|(id,_)|u32::from(*id)).collect();
        Ok(())
    }
}

impl P2pTransport for KcpTransport {
    fn local_id(&self) -> PeerId {
        self.local.clone()
    }

    fn send_datagram(
        &self,
        peer: &PeerId,
        payload: Bytes,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let endpoint = Arc::clone(&self.endpoint);
        let dest = match peer_to_node_id(peer) {
            Ok(d) => d,
            Err(e) => return Box::pin(async move { Err(e) }),
        };
        Box::pin(async move { endpoint.send_to(payload.as_ref(), dest).await })
    }

    fn open_channel(
        &self,
        peer: &PeerId,
    ) -> Pin<Box<dyn Future<Output = io::Result<Box<dyn ReliableChannel>>> + Send + '_>> {
        let endpoint = Arc::clone(&self.endpoint);
        let dest = match peer_to_node_id(peer) {
            Ok(d) => d,
            Err(e) => return Box::pin(async move { Err(e) }),
        };
        Box::pin(async move {
            let stream = endpoint.open_kcp_stream(dest)?;
            let (write, read) = stream.split();
            Ok(Box::new(KcpChannel {
                send: Some(write),
                recv: read,
            }) as Box<dyn ReliableChannel>)
        })
    }

    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>> {
        Box::pin(async move { self.rx.lock().await.recv().await })
    }

    fn route_mode(&self, peer: &PeerId) -> Option<RouteMode> {
        self.modes.lock().ok()?.get(peer).copied()
    }
}

impl Drop for KcpTransport {
    fn drop(&mut self) {
        for task in &self.tasks { task.abort(); }
        let _ = self.endpoint.shutdown();
    }
}
