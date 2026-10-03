//! Synthetic transport exercises the real session, wire messages, verification and disk store.
#[path = "common/p2p.rs"]
mod support;

use std::collections::BTreeMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use entropy_engine::p2p::meta::InfoDocument;
use entropy_engine::p2p::pieces::PieceStore;
use entropy_engine::p2p::scheduler::{Limits, ScheduleMode};
use entropy_engine::p2p::session::Session;
use entropy_engine::p2p::transport::{
    Datagram, P2pTransport, PeerId, ReliableChannel, RouteMode, TransportEvent,
};
use entropy_engine::p2p::wire::{Envelope, Msg};

type IoFuture<'a, T> = Pin<Box<dyn Future<Output = io::Result<T>> + Send + 'a>>;
struct Channel(Option<Bytes>);
impl ReliableChannel for Channel {
    fn send(&mut self, _: Bytes) -> IoFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn recv(&mut self) -> Pin<Box<dyn Future<Output = Option<io::Result<Bytes>>> + Send + '_>> {
        Box::pin(async { self.0.take().map(Ok) })
    }
}

struct FakeSwarm {
    info: InfoDocument,
    data: Vec<u8>,
    maps: BTreeMap<PeerId, Vec<u32>>,
    tx: tokio::sync::mpsc::UnboundedSender<TransportEvent>,
    rx: tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<TransportEvent>>,
    log: Arc<Mutex<Vec<(PeerId, Msg)>>>,
    corrupt: bool,
    seek: Option<tokio::sync::watch::Sender<ScheduleMode>>,
    sought: std::sync::atomic::AtomicBool,
}

impl FakeSwarm {
    fn push(&self, ev: TransportEvent) {
        self.tx.send(ev).unwrap();
    }
}

impl P2pTransport for FakeSwarm {
    fn local_id(&self) -> PeerId {
        "leecher".into()
    }
    fn route_mode(&self, _: &PeerId) -> Option<RouteMode> {
        Some(RouteMode::Direct)
    }
    fn open_channel(&self, _: &PeerId) -> IoFuture<'_, Box<dyn ReliableChannel>> {
        Box::pin(async { Err(io::Error::other("leecher should not open channels")) })
    }
    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>> {
        Box::pin(async { self.rx.lock().await.recv().await })
    }
    fn send_datagram(&self, peer: &PeerId, bytes: Bytes) -> IoFuture<'_, ()> {
        let peer = peer.clone();
        Box::pin(async move {
            let msg = Envelope::decode(&bytes).unwrap().msg;
            self.log.lock().unwrap().push((peer.clone(), msg.clone()));
            match msg {
                Msg::Hello { .. } => {
                    let mut bitmap = vec![0; (self.info.piece_count() as usize).div_ceil(8)];
                    for &i in &self.maps[&peer] {
                        bitmap[i as usize / 8] |= 1 << (i % 8);
                    }
                    self.push(TransportEvent::Datagram(Datagram {
                        peer,
                        route: RouteMode::Direct,
                        payload: Envelope::new(Msg::Bitfield {
                            content: self.info.content_id(),
                            bitmap,
                        })
                        .encode()
                        .into(),
                    }));
                }
                Msg::Want { content, index } => {
                    assert!(self.maps[&peer].contains(&index));
                    if let Some(seek) = &self.seek {
                        if !self.sought.load(std::sync::atomic::Ordering::SeqCst) {
                            if index == 1 {
                                self.sought.store(true, std::sync::atomic::Ordering::SeqCst);
                                seek.send(ScheduleMode::SequentialAhead {
                                    playhead: 4,
                                    lookahead: 2,
                                })
                                .unwrap();
                            }
                            return Ok(()); // The first window stalls, then the player seeks.
                        }
                        if index == 5 {
                            seek.send(ScheduleMode::RarestFirst).unwrap();
                        }
                    }
                    let start = index as usize * self.info.piece_length as usize;
                    let mut data = self.data
                        [start..(start + self.info.piece_length as usize).min(self.data.len())]
                        .to_vec();
                    if self.corrupt && peer.as_str() == "a" && index == 0 {
                        data[0] ^= 255;
                    }
                    self.push(TransportEvent::IncomingChannel {
                        peer,
                        channel: Box::new(Channel(Some(
                            Envelope::new(Msg::Piece {
                                content,
                                index,
                                data,
                            })
                            .encode()
                            .into(),
                        ))),
                    });
                }
                _ => {}
            }
            Ok(())
        })
    }
}

struct Temp(PathBuf);
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn run(corrupt: bool, resume: bool, seek: bool) -> Vec<(PeerId, Msg)> {
    let data: Vec<u8> = (0..96).collect();
    let info = InfoDocument::for_bytes("swarm.bin", None, &data, 16, 0);
    let dir = Temp(std::env::temp_dir().join(format!(
            "entropy-swarm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    if resume {
        let mut store = PieceStore::open(&dir.0, &info).unwrap();
        store.write_piece(2, &data[32..48]).unwrap();
    }
    let mode = if seek {
        ScheduleMode::SequentialAhead {
            playhead: 0,
            lookahead: 2,
        }
    } else {
        ScheduleMode::RarestFirst
    };
    let (update_tx, update_rx) = tokio::sync::watch::channel(mode);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let log = Arc::new(Mutex::new(Vec::new()));
    let maps = if seek {
        BTreeMap::from([("a".into(), vec![0, 1, 2, 3, 4, 5])])
    } else {
        BTreeMap::from([
            ("a".into(), vec![0, 1, 2]),
            ("b".into(), vec![0, 3, 4]),
            ("c".into(), vec![2, 4, 5]),
        ])
    };
    let peers: Vec<_> = maps.keys().cloned().collect();
    let session = Session::new(
        Box::new(FakeSwarm {
            info: info.clone(),
            data: data.clone(),
            maps,
            tx,
            rx: tokio::sync::Mutex::new(rx),
            log: log.clone(),
            corrupt,
            seek: seek.then_some(update_tx),
            sought: false.into(),
        }),
        support::allow(&info),
    );
    let stats = session
        .download_swarm(
            &dir.0,
            &info,
            &peers,
            Duration::from_secs(3),
            mode,
            Limits {
                per_peer: 2,
                total: 3,
                request_timeout: Duration::from_millis(50),
            },
            seek.then_some(update_rx),
        )
        .await
        .unwrap();
    assert_eq!(stats.total_pieces, 6);
    let mut store = PieceStore::open(&dir.0, &info).unwrap();
    assert!(store.is_complete());
    store.verify_all().unwrap();
    let assembled =
        std::fs::read(dir.0.join("p2p").join(info.content_id_hex()).join("data")).unwrap();
    assert_eq!(assembled, data);
    let result = log.lock().unwrap().clone();
    result
}

#[tokio::test]
async fn complementary_swarm_completes_and_resumes_without_refetch() {
    let log = run(false, true, false).await;
    let mut fetched = std::collections::BTreeSet::new();
    for (peer, msg) in log {
        if let Msg::Want { index, .. } = msg {
            assert_ne!(index, 2, "resumed piece requested again");
            assert!(fetched.insert((peer, index)), "duplicate request");
        }
    }
    assert_eq!(fetched.len(), 5);
}

#[tokio::test]
async fn corrupt_piece_is_retried_and_never_promoted_unverified() {
    let log = run(true, false, false).await;
    let sources: Vec<_> = log
        .iter()
        .filter_map(|(p, m)| matches!(m, Msg::Want { index: 0, .. }).then_some(p.as_str()))
        .collect();
    assert_eq!(sources, ["a", "b"]);
}

#[tokio::test]
async fn session_seek_emits_cancels_and_reprioritizes_before_bulk_completion() {
    let log = run(false, false, true).await;
    let wants: Vec<_> = log
        .iter()
        .filter_map(|(_, m)| {
            if let Msg::Want { index, .. } = m {
                Some(*index)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(&wants[..4], [0, 1, 4, 5]);
    let cancels: Vec<_> = log
        .iter()
        .filter_map(|(_, m)| {
            if let Msg::Cancel { index, .. } = m {
                Some(*index)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(cancels, [0, 1]);
}
