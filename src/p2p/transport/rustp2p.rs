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
    rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<TransportEvent>>,
    modes: Arc<Mutex<std::collections::HashMap<PeerId, RouteMode>>>,
}

fn peer_to_node_id(peer: &PeerId) -> io::Result<rp::NodeID> {
    let ip: std::net::Ipv4Addr = peer
        .as_str()
        .parse()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "peer id is not an ipv4 address"))?;
    Ok(ip.into())
}

impl KcpTransport {
    pub async fn start(cfg: KcpConfig) -> io::Result<Self> {
        let group_code = rp::GroupCode::try_from(cfg.group_code.as_str())
            .map_err(|e| super::io_other(e))?;

        let mut builder = rp::Builder::new()
            .node_id(cfg.node_id.into())
            .udp_port(cfg.udp_port)
            .tcp_port(cfg.tcp_port)
            .group_code(group_code)
            .encryption(Algorithm::AesGcm(cfg.psk_password))
            .interceptor(AllowInterceptor {
                allow_src: cfg.allow_src,
            });

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

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<TransportEvent>();
        let modes = Arc::new(Mutex::new(std::collections::HashMap::new()));

        // Drain the datagram receive loop into the bounded event queue. This is the
        // `mcp_rx` bridge pattern from the design: network I/O never touches the frame.
        let drain_ep = Arc::clone(&endpoint);
        let drain_modes = Arc::clone(&modes);
        tokio::spawn(async move {
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
                        if tx.send(TransportEvent::Datagram(dg)).is_err() {
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
            rx: tokio::sync::Mutex::new(rx),
            modes,
        })
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
        _peer: &PeerId,
    ) -> Pin<Box<dyn Future<Output = io::Result<Box<dyn ReliableChannel>>> + Send + '_>> {
        // `rustp2p-reliable` dialing is message-based KCP and its outbound-dial API is not
        // yet wired in this spike; the datagram/control plane is what the four spike
        // concerns exercise. Wire this after the backend decision.
        Box::pin(async move {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "KCP reliable-channel dialing not wired in the phase-1 spike",
            ))
        })
    }

    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>> {
        Box::pin(async move { self.rx.lock().await.recv().await })
    }

    fn route_mode(&self, peer: &PeerId) -> Option<RouteMode> {
        self.modes.lock().ok()?.get(peer).copied()
    }
}
