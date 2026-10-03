//! The peer session: seed/serve and download/resume for a single content item over any
//! `P2pTransport` (docs/P2P_PROTOCOL_DESIGN.md phase 4 - the two-peer localhost session).
//!
//! Phase 4 is deliberately single-content and single-peer: one node seeds a content id, another
//! downloads it over loopback. There is no scheduler here (that is phase 5) and no room index
//! (phase 6). The leecher asks for *all* missing pieces and re-asks on a fixed retry cadence, so
//! route discovery, dropped datagrams, duplicate requests, and a seeder that dies and comes back
//! all recover through the same loop. The piece store (phase 3) makes arrival order irrelevant and
//! re-writing a piece idempotent, which is exactly the two acceptance concerns "out-of-order
//! pieces" and "duplicate/retried requests".
//!
//! Control flows over the datagram plane (`Want`, `Done`, `Hello`); piece bytes flow over reliable
//! channels (`Piece`), one fresh channel per request as section 4.2 describes.

use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;

use super::meta::InfoDocument;
use super::pieces::PieceStore;
use super::transport::{P2pTransport, PeerId, TransportEvent};
use super::wire::{self, ContentId, Msg};

/// How often a leecher re-announces the pieces it still needs. This single knob is what makes
/// retries, route discovery, and reconnect all converge.
pub const DEFAULT_RETRY: Duration = Duration::from_millis(250);
/// Bound on a single piece transfer once its channel is open.
const PIECE_RECV_TIMEOUT: Duration = Duration::from_secs(10);
/// Attempts/backoff a seeder makes to open a channel and push a piece before giving up on it.
const SERVE_SEND_ATTEMPTS: usize = 8;
const SERVE_SEND_BACKOFF: Duration = Duration::from_millis(200);
/// Grace a seeder gives in-flight piece sends before returning when it hits its serve limit.
const SERVE_FLUSH_GRACE: Duration = Duration::from_millis(500);
/// How long a freshly sent piece stream is held open so KCP completes delivery (handshake + ACK)
/// before the stream is torn down.
const SERVE_DELIVER_GRACE: Duration = Duration::from_millis(1000);

#[derive(Debug)]
pub enum SessionError {
    Io(std::io::Error),
    Piece(super::pieces::PieceError),
    Wire(wire::WireError),
    Timeout,
    WrongContent { expected: ContentId, got: ContentId },
    TransportClosed,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Io(e) => write!(f, "session io error: {e}"),
            SessionError::Piece(e) => write!(f, "session piece error: {e}"),
            SessionError::Wire(e) => write!(f, "session wire error: {e}"),
            SessionError::Timeout => write!(f, "session timed out"),
            SessionError::WrongContent { expected, got } => {
                write!(f, "piece for unexpected content id (expected {expected:x?}, got {got:x?})")
            }
            SessionError::TransportClosed => write!(f, "transport closed unexpectedly"),
        }
    }
}

impl std::error::Error for SessionError {}

impl From<std::io::Error> for SessionError {
    fn from(e: std::io::Error) -> Self {
        SessionError::Io(e)
    }
}

impl From<super::pieces::PieceError> for SessionError {
    fn from(e: super::pieces::PieceError) -> Self {
        SessionError::Piece(e)
    }
}

impl From<wire::WireError> for SessionError {
    fn from(e: wire::WireError) -> Self {
        SessionError::Wire(e)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadStats {
    pub pieces_received: u32,
    pub total_pieces: u32,
    pub retries: u32,
}

/// A single node participating in a content transfer. Constructed over a boxed transport so it is
/// backend-agnostic; `serve` and `download` are the two roles phase 4 exercises.
pub struct Session {
    transport: Arc<dyn P2pTransport>,
}

impl Session {
    pub fn new(transport: Box<dyn P2pTransport>) -> Self {
        Self {
            transport: Arc::from(transport),
        }
    }

    /// Serve `info`'s content from the seed store under `data_dir` until `until` elapses, or until
    /// `limit` pieces have been served. Returns the number of pieces dispatched.
    pub async fn serve(
        &self,
        data_dir: &Path,
        info: &InfoDocument,
        until: Duration,
        limit: Option<u32>,
    ) -> Result<u32, SessionError> {
        let store = Arc::new(std::sync::Mutex::new(PieceStore::open(data_dir, info)?));
        let content = info.content_id();
        let deadline = tokio::time::Instant::now() + until;
        let mut served = 0u32;

        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(served);
            }
            if let Some(l) = limit {
                if served >= l {
                    tokio::time::sleep(SERVE_FLUSH_GRACE).await;
                    return Ok(served);
                }
            }

            let remaining = deadline.saturating_duration_since(now);
            match tokio::time::timeout(remaining, self.transport.next_event()).await {
                Err(_) => return Ok(served),
                Ok(None) => return Ok(served),
                Ok(Some(TransportEvent::Datagram(dg))) => {
                    let msg = match wire::Envelope::decode(&dg.payload) {
                        Ok(env) => env.msg,
                        Err(_) => continue,
                    };
                    match msg {
                        Msg::Want { content: c, index } if c == content => {
                            let store = Arc::clone(&store);
                            let transport = Arc::clone(&self.transport);
                            let peer = dg.peer;
                            tokio::spawn(async move {
                                let _ = serve_piece(store, transport, peer, content, index).await;
                            });
                            served += 1;
                        }
                        Msg::Hello { .. } => {
                            let transport = Arc::clone(&self.transport);
                            let peer = dg.peer;
                            let reply = wire::Envelope::new(Msg::Hello {
                                version: wire::PROTOCOL_VERSION,
                            })
                            .encode();
                            tokio::spawn(async move {
                                let _ = transport.send_datagram(&peer, Bytes::from(reply)).await;
                            });
                        }
                        _ => {}
                    }
                }
                // A leecher does not push data to us in this phase; an inbound channel is not
                // part of the seed contract and is ignored.
                Ok(Some(_)) => {}
            }
        }
    }

    /// Download `info`'s content into `data_dir` from `peer`, retrying until complete or `timeout`.
    /// Resumes from whatever is already in the store, so a partial download continues exactly where
    /// it left off.
    pub async fn download(
        &self,
        data_dir: &Path,
        info: &InfoDocument,
        peer: &PeerId,
        timeout: Duration,
    ) -> Result<DownloadStats, SessionError> {
        let store = Arc::new(tokio::sync::Mutex::new(PieceStore::open(data_dir, info)?));
        let content = info.content_id();
        let total = info.piece_count();
        let deadline = tokio::time::Instant::now() + timeout;
        let mut retries = 0u32;

        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(SessionError::Timeout);
            }

            // Ask for every still-missing piece, newest-last so requests and storage order differ
            // (exercises out-of-order writes). Re-asking is idempotent and is also how a restarted
            // seeder is reached once its route comes back.
            let missing = store.lock().await.missing();
            if missing.is_empty() {
                break;
            }
            retries += 1;
            for index in missing.into_iter().rev() {
                let msg = wire::Envelope::new(Msg::Want { content, index }).encode();
                let _ = self
                    .transport
                    .send_datagram(peer, Bytes::from(msg))
                    .await;
            }

            tokio::select! {
                _ = tokio::time::sleep(DEFAULT_RETRY) => {}
                ev = self.transport.next_event() => {
                    match ev {
                        Some(TransportEvent::IncomingChannel { mut channel, .. }) => {
                            match tokio::time::timeout(PIECE_RECV_TIMEOUT, channel.recv()).await {
                                Ok(Some(Ok(bytes))) => {
                                    let env = wire::Envelope::decode(&bytes)?;
                                    if let Msg::Piece { content: c, index, data } = env.msg {
                                        if c != content {
                                            return Err(SessionError::WrongContent {
                                                expected: content,
                                                got: c,
                                            });
                                        }
                                        store.lock().await.write_piece(index, &data)?;
                                    }
                                }
                                Ok(Some(Err(e))) => return Err(SessionError::Io(e)),
                                Ok(None) | Err(_) => {} // channel closed/timeout; the retry loop recovers
                            }
                        }
                        Some(TransportEvent::Datagram(_)) => {}
                        Some(_) => {}
                        None => return Err(SessionError::TransportClosed),
                    }
                }
            }
        }

        {
            let mut s = store.lock().await;
            s.verify_all()?;
            s.promote()?;
        }

        let _ = self
            .transport
            .send_datagram(peer, Bytes::from(wire::Envelope::new(Msg::Done { content }).encode()))
            .await;

        Ok(DownloadStats {
            pieces_received: total,
            total_pieces: total,
            retries,
        })
    }
}

/// Reads a piece from the shared seed store and pushes it to `peer` over a fresh reliable channel.
/// A missing piece (the seed store is incomplete) or an unreachable peer simply drops the request;
/// the leecher re-asks later.
async fn serve_piece(
    store: Arc<std::sync::Mutex<PieceStore>>,
    transport: Arc<dyn P2pTransport>,
    peer: PeerId,
    content: ContentId,
    index: u32,
) -> Result<(), SessionError> {
    let piece = {
        let mut s = store
            .lock()
            .map_err(|_| io::Error::other("seed store lock poisoned"))?;
        match s.read_piece(index) {
            Ok(p) => p,
            Err(_) => return Ok(()),
        }
    };

    let msg = wire::Envelope::new(Msg::Piece {
        content,
        index,
        data: piece,
    })
    .encode();

    for _ in 0..SERVE_SEND_ATTEMPTS {
        match transport.open_channel(&peer).await {
            Ok(mut channel) => {
                if channel.send(Bytes::from(msg.clone())).await.is_ok() {
                    // KCP delivery is async (the stream's flush runs on its own task, and `poll_flush`
                    // is a no-op), so hold the channel open briefly so the handshake + data + ACK
                    // complete before the stream and its route-table entry are torn down.
                    tokio::time::sleep(SERVE_DELIVER_GRACE).await;
                    return Ok(());
                }
            }
            Err(_) => {}
        }
        tokio::time::sleep(SERVE_SEND_BACKOFF).await;
    }

    Err(SessionError::Io(io::Error::new(
        io::ErrorKind::BrokenPipe,
        "could not deliver piece",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrong_content_reports_both_ids() {
        let e = SessionError::WrongContent {
            expected: [1u8; 32],
            got: [2u8; 32],
        };
        let s = e.to_string();
        assert!(s.contains("unexpected content id"), "{s}");
    }

    #[test]
    fn download_stats_default_is_empty() {
        assert_eq!(
            DownloadStats::default(),
            DownloadStats {
                pieces_received: 0,
                total_pieces: 0,
                retries: 0,
            }
        );
    }
}
