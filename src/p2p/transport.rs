//! The `P2pTransport` seam (docs/P2P_PROTOCOL_DESIGN.md, section 3).
//!
//! Everything above this trait - content addressing, the piece store, the scheduler, the
//! allowlist, the rendezvous client - codes against `P2pTransport` and the shared types in
//! this file, never against a concrete backend. The two candidate backends (KCP via
//! `rustp2p` and the QUIC overlay via `rustp2p-quic`) both implement it; a LAN/mDNS backend
//! would be a third implementation. Construction is deliberately *not* part of the trait:
//! how a backend is configured (group code, PSK, bootstrap peers) is backend-specific.

use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;

use bytes::Bytes;

pub mod quic;
pub mod rustp2p;

/// Reject oversized reliable frames before allocating their payload buffer.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub(crate) fn check_frame_len(len: usize) -> io::Result<()> {
    if len > MAX_FRAME_BYTES {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "p2p frame exceeds size limit",
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod frame_tests {
    use super::*;
    #[test]
    fn frame_length_boundaries() {
        assert!(check_frame_len(MAX_FRAME_BYTES).is_ok());
        assert_eq!(
            check_frame_len(MAX_FRAME_BYTES + 1).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        assert!(check_frame_len(u32::MAX as usize).is_err());
        assert!(check_frame_len(usize::MAX).is_err());
    }
}

/// A stable, transport-neutral peer identifier.
///
/// `rustp2p` addresses peers by IPv4 `NodeID`; `rustp2p-quic` addresses them by an
/// application-chosen string `PeerId`. This newtype is the common denominator.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct PeerId(String);

impl PeerId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl fmt::Debug for PeerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PeerId({})", self.0)
    }
}

impl From<String> for PeerId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for PeerId {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

/// How a message reached us. The no-relay rule (section 6) requires piece data to be
/// direct-only; control traffic may be relayed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteMode {
    Direct,
    Relayed,
}

/// A best-effort datagram (control message) received from a peer.
#[derive(Clone, Debug)]
pub struct Datagram {
    pub peer: PeerId,
    pub payload: Bytes,
    pub route: RouteMode,
}

/// A reliable, ordered, message-oriented channel to a peer (piece data).
///
/// Message semantics are used because the candidate backends differ underneath:
/// `rustp2p-reliable` is already message-based (KCP), while `rustp2p-quic` is a byte
/// stream, so the QUIC backend frames each message with a `u32` length prefix.
pub trait ReliableChannel: Send {
    fn send(&mut self, data: Bytes) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>>;

    fn recv(&mut self) -> Pin<Box<dyn Future<Output = Option<io::Result<Bytes>>> + Send + '_>>;
}

/// An event surfaced by the transport to the network service.
pub enum TransportEvent {
    PeerConnected(PeerId),
    PeerDisconnected(PeerId),
    Datagram(Datagram),
    IncomingChannel {
        peer: PeerId,
        channel: Box<dyn ReliableChannel>,
    },
}

/// The stable seam all upper layers code against.
pub trait P2pTransport: Send + Sync {
    /// This node's own peer id.
    fn local_id(&self) -> PeerId;

    /// Sends a best-effort datagram to a peer.
    fn send_datagram(
        &self,
        peer: &PeerId,
        payload: Bytes,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>>;

    /// Opens an outbound reliable channel to a peer.
    fn open_channel(
        &self,
        peer: &PeerId,
    ) -> Pin<Box<dyn Future<Output = io::Result<Box<dyn ReliableChannel>>> + Send + '_>>;

    /// Receives the next transport event, or `None` once the transport has shut down.
    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>>;

    /// The current best-route mode for a peer, if known. This is what the no-relay
    /// enforcement point (section 8) consults to drop piece data that arrived relayed.
    fn route_mode(&self, peer: &PeerId) -> Option<RouteMode>;
}

/// Maps any displayable error onto an `io::Error` of kind `Other`. Used at the backend
/// boundary where the crates expose their own (non-`io`) error types.
pub(crate) fn io_other(e: impl fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::Other, e.to_string())
}
