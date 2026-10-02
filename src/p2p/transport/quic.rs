//! QUIC overlay backend candidate: `rustp2p-quic` (quinn streams + encrypted datagrams over
//! `rustp2p-core` NAT traversal), adapted onto the `P2pTransport` seam.
//!
//! This is the "modern" candidate. It lacks the KCP crate's `GroupCode` and
//! `DataInterceptor` (those are KCP-specific), so the control model maps differently: QUIC
//! is always TLS-encrypted, the `Identity`/`PeerId` is the trust binding, and the
//! direct-vs-relay enforcement point is `LinkMode`/`is_relay`.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;

use bytes::Bytes;

use super::{Datagram, P2pTransport, PeerId, ReliableChannel, RouteMode, TransportEvent};

use ::rustp2p_quic as rpq;

/// Backend-specific construction config. Not part of `P2pTransport` by design.
pub struct QuicConfig {
    pub peer_id: String,
    /// Deterministic seed for the self-signed QUIC certificate.
    pub seed: String,
    pub bind_addr: SocketAddr,
    /// Directly reachable bootstrap addresses (entry points only).
    pub bootstrap: Vec<SocketAddr>,
}

pub struct QuicTransport {
    endpoint: rpq::Endpoint,
    local: PeerId,
    rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<TransportEvent>>,
}

/// A reliable QUIC channel framed into messages with a `u32` length prefix, since the
/// underlying QUIC stream is a byte stream while `ReliableChannel` is message-oriented.
struct QuicChannel {
    send: Option<rpq::ReliableSendStream>,
    recv: rpq::ReliableRecvStream,
}

async fn read_exact(stream: &mut rpq::ReliableRecvStream, n: usize) -> io::Result<Vec<u8>> {
    let mut out = vec![0u8; n];
    let mut filled = 0usize;
    while filled < n {
        match stream.read(&mut out[filled..]).await {
            Ok(Some(0)) | Ok(None) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "quic stream closed mid-message",
                ));
            }
            Ok(Some(k)) => filled += k,
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

impl ReliableChannel for QuicChannel {
    fn send(
        &mut self,
        data: Bytes,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let len = (data.len() as u32).to_be_bytes();
        Box::pin(async move {
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
            let len_buf = match read_exact(&mut self.recv, 4).await {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return None,
                Err(e) => return Some(Err(e)),
            };
            let n = u32::from_be_bytes([len_buf[0], len_buf[1], len_buf[2], len_buf[3]]) as usize;
            match read_exact(&mut self.recv, n).await {
                Ok(b) => Some(Ok(Bytes::from(b))),
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => None,
                Err(e) => Some(Err(e)),
            }
        })
    }
}

impl QuicTransport {
    pub async fn start(cfg: QuicConfig) -> io::Result<Self> {
        let identity = rpq::Identity::new(cfg.peer_id.clone(), cfg.seed.as_bytes())
            .map_err(super::io_other)?;

        let mut builder = rpq::Endpoint::builder()
            .identity(identity)
            .bind(cfg.bind_addr);
        if !cfg.bootstrap.is_empty() {
            builder = builder.bootstrap(cfg.bootstrap);
        }

        let endpoint = builder.build().await.map_err(super::io_other)?;
        let local = PeerId::new(cfg.peer_id);

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<TransportEvent>();

        let drain_ep = endpoint.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = drain_ep.recv() => {
                        match msg {
                            Ok(m) => {
                                let mode = if m.is_relay { RouteMode::Relayed } else { RouteMode::Direct };
                                let peer = PeerId::new(m.src.as_str());
                                let dg = Datagram { peer, payload: m.payload, route: mode };
                                if tx.send(TransportEvent::Datagram(dg)).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    inc = drain_ep.accept_bi() => {
                        match inc {
                            Ok(s) => {
                                let peer = PeerId::new(s.peer_id.as_str());
                                let ch = QuicChannel { send: Some(s.send), recv: s.recv };
                                if tx.send(TransportEvent::IncomingChannel { peer, channel: Box::new(ch) }).is_err() {
                                    break;
                                }
                            }
                            Err(_) => break,
                        }
                    }
                }
            }
        });

        Ok(Self {
            endpoint,
            local,
            rx: tokio::sync::Mutex::new(rx),
        })
    }

    /// Adds a bootstrap address and returns the discovered peer id. Convenience for the
    /// spike: after this, `send_datagram` can target that peer by id.
    pub async fn add_bootstrap(&self, addr: SocketAddr) -> io::Result<PeerId> {
        let id = self.endpoint.add_bootstrap(addr).await.map_err(super::io_other)?;
        Ok(PeerId::new(id.as_str()))
    }
}

impl P2pTransport for QuicTransport {
    fn local_id(&self) -> PeerId {
        self.local.clone()
    }

    fn send_datagram(
        &self,
        peer: &PeerId,
        payload: Bytes,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let id = rpq::PeerId::from(peer.as_str());
        Box::pin(async move {
            self.endpoint.send_to(id, payload.as_ref()).await.map_err(super::io_other)
        })
    }

    fn open_channel(
        &self,
        peer: &PeerId,
    ) -> Pin<Box<dyn Future<Output = io::Result<Box<dyn ReliableChannel>>> + Send + '_>> {
        let id = rpq::PeerId::from(peer.as_str());
        Box::pin(async move {
            let (send, recv) = self.endpoint.open_bi(id).await.map_err(super::io_other)?;
            Ok(Box::new(QuicChannel {
                send: Some(send),
                recv,
            }) as Box<dyn ReliableChannel>)
        })
    }

    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>> {
        Box::pin(async move { self.rx.lock().await.recv().await })
    }

    fn route_mode(&self, peer: &PeerId) -> Option<RouteMode> {
        let id = rpq::PeerId::from(peer.as_str());
        self.endpoint
            .link_mode(id)
            .map(|m| match m {
                rpq::LinkMode::Direct => RouteMode::Direct,
                rpq::LinkMode::Relay => RouteMode::Relayed,
            })
    }
}
