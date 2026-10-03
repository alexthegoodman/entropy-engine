//! The peer session: seed/serve and download/resume for a single content item over any
//! `P2pTransport` (docs/P2P_PROTOCOL_DESIGN.md phases 4 and 5).
//!
//! Downloads use the phase-5 scheduler with live peer bitfields, bounded requests, and retries.
//! The single-peer entry point delegates to rarest-first; the swarm entry point also accepts
//! a watch channel for sequential windows and seek reprioritization.
//!
//! Control flows over the datagram plane (`Hello`, `Bitfield`, `Have`, `Want`, `Cancel`, `Done`);
//! piece bytes flow over reliable
//! channels (`Piece`), one fresh channel per request as section 4.2 describes.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;

use super::allow::{Allowlist, CatalogTransport};
use super::meta::InfoDocument;
use super::pieces::PieceStore;
use super::scheduler::{Limits, ScheduleMode, Scheduler};
use super::transport::{P2pTransport, PeerId, TransportEvent};
use super::wire::{self, ContentId, Msg};

/// Availability probe and scheduler tick cadence. Request expiry is configured separately
/// through `Limits::request_timeout`.
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
    NotAllowed(ContentId),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Io(e) => write!(f, "session io error: {e}"),
            SessionError::Piece(e) => write!(f, "session piece error: {e}"),
            SessionError::Wire(e) => write!(f, "session wire error: {e}"),
            SessionError::Timeout => write!(f, "session timed out"),
            SessionError::WrongContent { expected, got } => {
                write!(
                    f,
                    "piece for unexpected content id (expected {expected:x?}, got {got:x?})"
                )
            }
            SessionError::NotAllowed(content) => {
                write!(f, "content {content:x?} is not in the room catalog")
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
    allow: Allowlist,
}

impl Session {
    pub fn new(transport: Box<dyn P2pTransport>, allow: Allowlist) -> Self {
        Self {
            transport: Arc::new(CatalogTransport::new(transport, allow.clone())),
            allow,
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
        let content = info.content_id();
        let store = self
            .allow
            .with_allowed(&content, || PieceStore::open(data_dir, info))
            .ok_or(SessionError::NotAllowed(content))??;
        let store = Arc::new(std::sync::Mutex::new(store));
        let mut policy_changed = self.allow.subscribe();
        let deadline = tokio::time::Instant::now() + until;
        let mut served = 0u32;
        let mut sends: BTreeMap<(PeerId, u32), tokio::task::JoinHandle<()>> = BTreeMap::new();

        loop {
            if !self.allow.contains(&content) {
                for task in sends.values() {
                    task.abort();
                }
                return Err(SessionError::NotAllowed(content));
            }
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
            let event = tokio::select! {
                _ = policy_changed.changed() => continue,
                event = tokio::time::timeout(remaining, self.transport.next_event()) => event,
            };
            match event {
                Err(_) => return Ok(served),
                Ok(None) => return Ok(served),
                Ok(Some(TransportEvent::Datagram(dg))) => {
                    let msg = match wire::Envelope::decode(&dg.payload) {
                        Ok(env) => env.msg,
                        Err(_) => continue,
                    };
                    match msg {
                        Msg::Want { content: c, index } if c == content => {
                            sends.retain(|_, task| !task.is_finished());
                            let key = (dg.peer.clone(), index);
                            if index >= info.piece_count()
                                || sends.contains_key(&key)
                                || sends.len() >= Limits::default().total
                                || sends.keys().filter(|(p, _)| p == &dg.peer).count()
                                    >= Limits::default().per_peer
                                || !store
                                    .lock()
                                    .map_err(|_| io::Error::other("seed store lock poisoned"))?
                                    .has_piece(index)
                            {
                                continue;
                            }
                            let store = Arc::clone(&store);
                            let allow = self.allow.clone();
                            let transport = Arc::clone(&self.transport);
                            let peer = dg.peer;
                            sends.insert(
                                key,
                                tokio::spawn(async move {
                                    let _ =
                                        serve_piece(store, transport, peer, content, index, allow)
                                            .await;
                                }),
                            );
                            served += 1;
                        }
                        Msg::Cancel { content: c, index } if c == content => {
                            if let Some(task) = sends.remove(&(dg.peer, index)) {
                                task.abort();
                            }
                        }
                        Msg::Hello { version } if version == wire::PROTOCOL_VERSION => {
                            let transport = Arc::clone(&self.transport);
                            let peer = dg.peer;
                            let bitmap = {
                                let s = store
                                    .lock()
                                    .map_err(|_| io::Error::other("seed store lock poisoned"))?;
                                let mut bitmap =
                                    vec![0u8; (info.piece_count() as usize).div_ceil(8)];
                                for i in 0..info.piece_count() {
                                    if s.has_piece(i) {
                                        bitmap[i as usize / 8] |= 1 << (i % 8);
                                    }
                                }
                                bitmap
                            };
                            let reply =
                                wire::Envelope::new(Msg::Bitfield { content, bitmap }).encode();
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
        self.download_swarm(
            data_dir,
            info,
            std::slice::from_ref(peer),
            timeout,
            ScheduleMode::RarestFirst,
            Limits::default(),
            None,
        )
        .await
    }

    /// Download from explicitly configured peers. Availability is learned through Hello/Bitfield
    /// and Have. Mode updates cancel requests outside the new window; late responses are ignored.
    /// Sequential mode waits when its window is ready until the caller advances it or switches to
    /// rarest-first. Completion still means the entire file is verified and promoted.
    #[allow(clippy::too_many_arguments)]
    pub async fn download_swarm(
        &self,
        data_dir: &Path,
        info: &InfoDocument,
        peers: &[PeerId],
        timeout: Duration,
        mode: ScheduleMode,
        limits: Limits,
        mut updates: Option<tokio::sync::watch::Receiver<ScheduleMode>>,
    ) -> Result<DownloadStats, SessionError> {
        let content = info.content_id();
        let mut store = self
            .allow
            .with_allowed(&content, || PieceStore::open(data_dir, info))
            .ok_or(SessionError::NotAllowed(content))??;
        let mut policy_changed = self.allow.subscribe();
        let total = info.piece_count();
        let have = (0..total).map(|i| store.has_piece(i)).collect();
        let mut scheduler = Scheduler::new(have, mode, limits);
        let started = tokio::time::Instant::now();
        let deadline = started + timeout;
        let mut tick = tokio::time::interval(DEFAULT_RETRY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut retries = 0;
        let mut receivers: tokio::task::JoinSet<(PeerId, Option<io::Result<Bytes>>)> =
            tokio::task::JoinSet::new();

        while !scheduler.complete() {
            if !self.allow.contains(&content) {
                return Err(SessionError::NotAllowed(content));
            }
            tokio::select! {
                _ = policy_changed.changed() => continue,
                _ = tokio::time::sleep_until(deadline) => return Err(SessionError::Timeout),
                _ = tick.tick() => {
                    retries += 1;
                    // A periodic probe also recovers lost availability datagrams and peer restarts.
                    for peer in peers {
                        let hello = wire::Envelope::new(Msg::Hello { version: wire::PROTOCOL_VERSION });
                        let _ = self.transport.send_datagram(peer, Bytes::from(hello.encode())).await;
                    }
                }
                changed = async {
                    match updates.as_mut() {
                        Some(rx) => rx.changed().await,
                        None => std::future::pending().await,
                    }
                } => {
                    if changed.is_err() { updates = None; }
                    else {
                        let mode = *updates.as_mut().unwrap().borrow_and_update();
                        for r in scheduler.set_mode(mode) {
                            let msg = wire::Envelope::new(Msg::Cancel { content, index: r.index });
                            let _ = self.transport.send_datagram(&r.peer, Bytes::from(msg.encode())).await;
                        }
                    }
                }
                result = receivers.join_next(), if !receivers.is_empty() => {
                    if let Some(Ok((peer, Some(Ok(bytes))))) = result {
                        if let Ok(env) = wire::Envelope::decode(&bytes) {
                            if let Msg::Piece { content: c, index, data } = env.msg {
                                if c == content && scheduler.is_requested(&peer, index) {
                                    let result = self.allow.with_allowed(&content, || store.write_piece(index, &data))
                                        .ok_or(SessionError::NotAllowed(content))?;
                                    match result {
                                        Ok(()) => { scheduler.verified(&peer, index); }
                                        Err(super::pieces::PieceError::HashMismatch { .. }
                                            | super::pieces::PieceError::InvalidLength { .. }) => {
                                            scheduler.failed(&peer, index);
                                        }
                                        Err(e) => return Err(e.into()),
                                    }
                                }
                            }
                        }
                    }
                }
                ev = self.transport.next_event() => {
                    match ev {
                        Some(TransportEvent::IncomingChannel { peer, mut channel }) => {
                            if peers.contains(&peer) && receivers.len() < limits.total {
                                receivers.spawn(async move {
                                    let result = tokio::time::timeout(PIECE_RECV_TIMEOUT, channel.recv()).await.ok().flatten();
                                    (peer, result)
                                });
                            }
                        }
                        Some(TransportEvent::Datagram(dg)) if peers.contains(&dg.peer) => {
                            if let Ok(env) = wire::Envelope::decode(&dg.payload) {
                                match env.msg {
                                    Msg::Bitfield { content: c, bitmap } if c == content
                                        && bitmap.len() == (total as usize).div_ceil(8) => {
                                        scheduler.set_peer(dg.peer, (0..total).filter(|&i|
                                            bitmap[i as usize / 8] & (1 << (i % 8)) != 0));
                                    }
                                    Msg::Have { content: c, index } if c == content => scheduler.peer_have(dg.peer, index),
                                    _ => {}
                                }
                            }
                        }
                        Some(TransportEvent::PeerDisconnected(peer)) => scheduler.remove_peer(&peer),
                        None => return Err(SessionError::TransportClosed),
                        _ => {}
                    }
                }
            }
            let plan = scheduler.poll(started.elapsed());
            for r in plan.cancel {
                let msg = wire::Envelope::new(Msg::Cancel {
                    content,
                    index: r.index,
                });
                let _ = self
                    .transport
                    .send_datagram(&r.peer, Bytes::from(msg.encode()))
                    .await;
            }
            for r in plan.want {
                let msg = wire::Envelope::new(Msg::Want {
                    content,
                    index: r.index,
                });
                if self
                    .transport
                    .send_datagram(&r.peer, Bytes::from(msg.encode()))
                    .await
                    .is_err()
                {
                    scheduler.failed(&r.peer, r.index);
                }
            }
        }
        self.allow
            .with_allowed(&content, || {
                store.verify_all()?;
                store.promote()
            })
            .ok_or(SessionError::NotAllowed(content))??;
        for peer in peers {
            let msg = wire::Envelope::new(Msg::Done { content });
            let _ = self
                .transport
                .send_datagram(peer, Bytes::from(msg.encode()))
                .await;
        }
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
    allow: Allowlist,
) -> Result<(), SessionError> {
    let piece = allow
        .with_allowed(&content, || {
            let mut s = store
                .lock()
                .map_err(|_| io::Error::other("seed store lock poisoned"))?;
            s.read_piece(index).map_err(SessionError::from)
        })
        .ok_or(SessionError::NotAllowed(content))??;

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
