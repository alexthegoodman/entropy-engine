use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use cucumber::{given, then, when, World as _};
use entropy_engine::p2p::allow::{Allowlist, CatalogTransport};
use entropy_engine::p2p::index::{
    Action, CatalogItem, IndexError, Maintainer, Member, PublicationKind, RoomIndex,
};
use entropy_engine::p2p::meta::InfoDocument;
use entropy_engine::p2p::pieces::PieceStore;
use entropy_engine::p2p::session::{Session, SessionError};
use entropy_engine::p2p::transport::rustp2p::{KcpConfig, KcpTransport};
use entropy_engine::p2p::transport::{
    Datagram, P2pTransport, PeerId, ReliableChannel, RouteMode, TransportEvent,
};
use entropy_engine::p2p::wire::{Envelope, Msg, PROTOCOL_VERSION};

#[path = "common/p2p.rs"]
mod support;

type IoFuture<'a, T> = Pin<Box<dyn Future<Output = io::Result<T>> + Send + 'a>>;

struct Channel {
    bytes: Option<Bytes>,
    sent: Arc<Mutex<Vec<Bytes>>>,
}
impl ReliableChannel for Channel {
    fn send(&mut self, bytes: Bytes) -> IoFuture<'_, ()> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(bytes);
            Ok(())
        })
    }
    fn recv(&mut self) -> Pin<Box<dyn Future<Output = Option<io::Result<Bytes>>> + Send + '_>> {
        Box::pin(async { self.bytes.take().map(Ok) })
    }
}
struct Probe {
    events: tokio::sync::Mutex<VecDeque<TransportEvent>>,
    sent: Arc<Mutex<Vec<Bytes>>>,
}
impl Probe {
    fn new(events: Vec<TransportEvent>, sent: Arc<Mutex<Vec<Bytes>>>) -> Self {
        Self {
            events: tokio::sync::Mutex::new(events.into()),
            sent,
        }
    }
}
impl P2pTransport for Probe {
    fn local_id(&self) -> PeerId {
        "local".into()
    }
    fn route_mode(&self, _: &PeerId) -> Option<RouteMode> {
        Some(RouteMode::Direct)
    }
    fn send_datagram(&self, _: &PeerId, bytes: Bytes) -> IoFuture<'_, ()> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(bytes);
            Ok(())
        })
    }
    fn open_channel(&self, _: &PeerId) -> IoFuture<'_, Box<dyn ReliableChannel>> {
        Box::pin(async {
            Ok(Box::new(Channel {
                bytes: None,
                sent: self.sent.clone(),
            }) as Box<dyn ReliableChannel>)
        })
    }
    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>> {
        Box::pin(async {
            let event = self.events.lock().await.pop_front();
            match event {
                Some(ev) => Some(ev),
                None => std::future::pending().await,
            }
        })
    }
}

#[derive(Default, cucumber::World)]
struct RoomWorld {
    index: Option<RoomIndex>,
    info: Option<InfoDocument>,
    result: bool,
    sender: Option<KcpTransport>,
    receiver: Option<CatalogTransport>,
    receiver_port: u16,
    temp: Option<PathBuf>,
}
impl std::fmt::Debug for RoomWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("RoomWorld")
    }
}
impl Drop for RoomWorld {
    fn drop(&mut self) {
        if let Some(p) = &self.temp {
            // This fixture owns only a uniquely named child of the OS temp directory.
            if p.parent() == Some(std::env::temp_dir().as_path())
                && p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("entropy-room-")
            {
                let _ = std::fs::remove_dir_all(p);
            }
        }
    }
}
impl RoomWorld {
    fn info(&self) -> &InfoDocument {
        self.info.as_ref().unwrap()
    }
    fn directory(&mut self) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "entropy-room-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        self.temp = Some(p.clone());
        p
    }
}

#[given("a room with a pinned maintainer key")]
fn room(w: &mut RoomWorld) {
    let info = InfoDocument::for_bytes("room.bin", None, b"verified room bytes", 64, 0);
    w.index = Some(RoomIndex::new(
        support::ROOM,
        support::maintainer().public_key(),
    ));
    w.info = Some(info);
}

fn item(id: [u8; 32]) -> CatalogItem {
    CatalogItem {
        content: id,
        title: "Publication".into(),
        description: "".into(),
        media: None,
        kind: PublicationKind::Post,
        parent: None,
    }
}

#[when("I merge signed publications in different orders and reload them")]
fn merge(w: &mut RoomWorld) {
    let one = support::publish(w.info(), 1);
    let two = support::maintainer()
        .sign(support::ROOM, 2, Action::Publish(item([2; 32])))
        .unwrap();
    let mut a = w.index.clone().unwrap();
    let mut b = a.clone();
    assert_eq!(a.merge([one.clone(), two.clone()]).unwrap(), 2);
    assert_eq!(b.merge([two, one.clone()]).unwrap(), 2);
    assert_eq!(b.merge([one]).unwrap(), 0);
    let bytes = a.to_bytes();
    let loaded =
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &bytes).unwrap();
    assert_eq!(a.content_id(), b.content_id());
    assert_eq!(bytes, b.to_bytes());
    assert_eq!(
        a.items().collect::<Vec<_>>(),
        loaded.items().collect::<Vec<_>>()
    );
    let pkcs8 = Maintainer::generate_pkcs8().unwrap();
    let key = Maintainer::from_pkcs8(&pkcs8).unwrap();
    let mut generated = RoomIndex::new(support::ROOM, key.public_key());
    generated
        .merge([key
            .sign(support::ROOM, 1, Action::Publish(item([3; 32])))
            .unwrap()])
        .unwrap();
    w.result = true;
}
#[then("the catalog and snapshot identities agree")]
fn success(w: &mut RoomWorld) {
    assert!(w.result);
}

#[when("I publish and reload items with different optional media hints")]
fn media_hints(w: &mut RoomWorld) {
    use entropy_engine::p2p::meta::MediaInfo;
    let mut a = item(w.info().content_id());
    a.media = Some(MediaInfo {
        codec: None,
        duration_ms: Some(100),
        width: None,
        height: None,
    });
    let mut b = a.clone();
    b.media = Some(MediaInfo {
        codec: None,
        duration_ms: None,
        width: Some(100),
        height: None,
    });
    let signed = support::maintainer()
        .sign(support::ROOM, 1, Action::Publish(a.clone()))
        .unwrap();
    let other = support::maintainer()
        .sign(support::ROOM, 1, Action::Publish(b.clone()))
        .unwrap();
    assert_ne!(signed.entry.signing_bytes(), other.entry.signing_bytes());
    assert_ne!(signed.entry.id(), other.entry.id());
    let mut substituted = signed.clone();
    substituted.entry.action = Action::Publish(b);
    assert_eq!(
        w.index.as_mut().unwrap().merge([substituted]),
        Err(IndexError::BadSignature)
    );
    w.index.as_mut().unwrap().merge([signed]).unwrap();
    let bytes = w.index.as_ref().unwrap().to_bytes();
    let loaded =
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &bytes).unwrap();
    assert_eq!(loaded.items().next(), Some(&a));
    w.result = true;
}
#[then("the hints round-trip and cannot reuse each other's signatures")]
fn hints_preserved(w: &mut RoomWorld) {
    success(w);
}

#[when("I merge a valid publication followed by a forged entry")]
fn forged(w: &mut RoomWorld) {
    let good = support::publish(w.info(), 1);
    let mut bad = support::publish(w.info(), 2);
    if let Action::Publish(p) = &mut bad.entry.action {
        p.title.push_str(" tampered");
    }
    let before = w.index.as_ref().unwrap().to_bytes();
    assert_eq!(
        w.index.as_mut().unwrap().merge([good, bad]),
        Err(IndexError::BadSignature)
    );
    assert_eq!(w.index.as_ref().unwrap().to_bytes(), before);
    w.result = true;
}
#[then("the entire batch is rejected")]
fn rejected(w: &mut RoomWorld) {
    assert!(w.result);
    assert_eq!(w.index.as_ref().unwrap().entries().count(), 0);
}

#[when("I replay a signed entry with different trust settings")]
fn replay(w: &mut RoomWorld) {
    let record = support::publish(w.info(), 1);
    let mut wrong_room = RoomIndex::new([8; 32], support::maintainer().public_key());
    assert_eq!(
        wrong_room.merge([record.clone()]),
        Err(IndexError::WrongRoom)
    );
    let mut altered_room = record.clone();
    altered_room.entry.room = [8; 32];
    assert_eq!(
        wrong_room.merge([altered_room]),
        Err(IndexError::BadSignature)
    );
    let mut altered_author = record;
    altered_author.entry.author = Maintainer::from_seed(&[8; 32]).unwrap().public_key();
    assert_eq!(
        w.index.as_mut().unwrap().merge([altered_author]),
        Err(IndexError::BadSignature)
    );
    w.result = true;
}
#[then("both replays are rejected")]
fn replayed(w: &mut RoomWorld) {
    success(w);
}

#[when("I merge conflicting signed events at the same sequence")]
fn conflict(w: &mut RoomWorld) {
    let a = support::publish(w.info(), 1);
    let b = Member::from_seed(&[6; 32])
        .unwrap()
        .sign(support::ROOM, 1, Action::Publish(item([2; 32])))
        .unwrap();
    let mut other = w.index.clone().unwrap();
    w.index.as_mut().unwrap().merge([a.clone()]).unwrap();
    other.merge([b.clone()]).unwrap();
    w.index.as_mut().unwrap().merge([b]).unwrap();
    other.merge([a]).unwrap();
    assert_eq!(w.index.as_ref().unwrap().to_bytes(), other.to_bytes());
    assert_eq!(other.entries().count(), 2);
    assert_eq!(other.publications().count(), 0);
    w.result = true;
}
#[then("conflicting publications converge to hidden records")]
fn conflicted(w: &mut RoomWorld) {
    success(w);
}

#[when("two members independently publish a post and a video")]
fn member_publications(w: &mut RoomWorld) {
    let a = support::publish(w.info(), 1);
    let member = Member::from_seed(&[5; 32]).unwrap();
    let mut video = item([3; 32]);
    video.kind = PublicationKind::Video;
    video.parent = Some(a.entry.id());
    let b = member
        .sign(support::ROOM, 1, Action::Publish(video))
        .unwrap();
    let mut other = w.index.clone().unwrap();
    w.index
        .as_mut()
        .unwrap()
        .merge([a.clone(), b.clone()])
        .unwrap();
    other.merge([b, a]).unwrap();
    assert_eq!(other.publications().count(), 2);
    assert_eq!(other.items().count(), 2);
    assert_eq!(other.to_bytes(), w.index.as_ref().unwrap().to_bytes());
    let reload = RoomIndex::from_bytes(
        support::ROOM,
        support::maintainer().public_key(),
        &other.to_bytes(),
    )
    .unwrap();
    assert_eq!(reload.publications().count(), 2);
    assert!(reload
        .publications()
        .all(|(_, r)| r.entry.author != support::maintainer().public_key()));
    w.result = true;
}

#[when("a stranger withdraws another member's publication before its arrival")]
fn stranger_withdrawal(w: &mut RoomWorld) {
    let publication = support::publish(w.info(), 1);
    let wrong = Member::from_seed(&[5; 32])
        .unwrap()
        .sign(
            support::ROOM,
            1,
            Action::Withdraw {
                publication: publication.entry.id(),
            },
        )
        .unwrap();
    let own = Member::from_seed(&[6; 32])
        .unwrap()
        .sign(
            support::ROOM,
            2,
            Action::Withdraw {
                publication: publication.entry.id(),
            },
        )
        .unwrap();
    let index = w.index.as_mut().unwrap();
    index.merge([wrong, publication.clone()]).unwrap();
    assert_eq!(index.publications().count(), 1);
    index.merge([own.clone()]).unwrap();
    assert_eq!(index.publications().count(), 0);
    let mut other = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    other.merge([own, publication]).unwrap();
    assert!(!other.contains(&w.info().content_id()));
    w.result = true;
}

#[when("a member attempts each maintainer-only action")]
fn unauthorized_moderation(w: &mut RoomWorld) {
    let member = Member::from_seed(&[6; 32]).unwrap();
    let publication = support::publish(w.info(), 1);
    for action in [
        Action::Remove {
            publication: publication.entry.id(),
        },
        Action::Tombstone {
            content: w.info().content_id(),
        },
        Action::BanAuthor {
            author: member.public_key(),
        },
        Action::SetPolicy {
            member_publishing: false,
        },
    ] {
        let bad = member.sign(support::ROOM, 2, action).unwrap();
        let before = w.index.as_ref().unwrap().to_bytes();
        assert_eq!(
            w.index.as_mut().unwrap().merge([publication.clone(), bad]),
            Err(IndexError::Unauthorized)
        );
        assert_eq!(before, w.index.as_ref().unwrap().to_bytes());
    }
    // A different externally pinned maintainer cannot accept the real maintainer's moderation.
    let mut other = RoomIndex::new(
        support::ROOM,
        Member::from_seed(&[5; 32]).unwrap().public_key(),
    );
    assert_eq!(
        other.merge([tombstone(w.info())]),
        Err(IndexError::Unauthorized)
    );
    w.result = true;
}

#[when("the maintainer removes one of two publications sharing a payload")]
fn publication_removal(w: &mut RoomWorld) {
    let cid = w.info().content_id();
    let a = support::publish(w.info(), 1);
    let b = Member::from_seed(&[5; 32])
        .unwrap()
        .sign(
            support::ROOM,
            1,
            Action::Publish(item(w.info().content_id())),
        )
        .unwrap();
    let removal = support::maintainer()
        .sign(
            support::ROOM,
            1,
            Action::Remove {
                publication: a.entry.id(),
            },
        )
        .unwrap();
    let index = w.index.as_mut().unwrap();
    index
        .merge([removal.clone(), a.clone(), b.clone()])
        .unwrap();
    assert_eq!(index.publications().count(), 1);
    assert!(index.contains(&cid));
    let mut other = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    other.merge([b, a, removal]).unwrap();
    assert_eq!(index.to_bytes(), other.to_bytes());
    other.merge([tombstone(w.info())]).unwrap();
    assert_eq!(other.publications().count(), 0);
    w.result = true;
}

#[when("an author ban arrives before stale and future publications")]
fn author_ban(w: &mut RoomWorld) {
    let a = support::publish(w.info(), 1);
    let future = support::publish(w.info(), 2);
    let ban = support::maintainer()
        .sign(
            support::ROOM,
            1,
            Action::BanAuthor {
                author: a.entry.author,
            },
        )
        .unwrap();
    let index = w.index.as_mut().unwrap();
    index.merge([ban, a]).unwrap();
    index.merge([future]).unwrap();
    assert_eq!(index.publications().count(), 0);
    let bytes = index.to_bytes();
    let reload =
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &bytes).unwrap();
    assert_eq!(reload.publications().count(), 0);
    w.result = true;
}

#[when("room publishing policy changes arrive out of order")]
fn room_policy(w: &mut RoomWorld) {
    let a = support::publish(w.info(), 1);
    let close = support::maintainer()
        .sign(
            support::ROOM,
            10,
            Action::SetPolicy {
                member_publishing: false,
            },
        )
        .unwrap();
    let open = support::maintainer()
        .sign(
            support::ROOM,
            11,
            Action::SetPolicy {
                member_publishing: true,
            },
        )
        .unwrap();
    let index = w.index.as_mut().unwrap();
    index.merge([a.clone(), close.clone()]).unwrap();
    assert_eq!(index.publications().count(), 0);
    index.merge([open.clone()]).unwrap();
    assert_eq!(index.publications().count(), 1);
    let mut other = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    other.merge([open, close, a]).unwrap();
    assert_eq!(other.to_bytes(), index.to_bytes());
    let conflict = support::maintainer()
        .sign(
            support::ROOM,
            11,
            Action::SetPolicy {
                member_publishing: false,
            },
        )
        .unwrap();
    index.merge([conflict]).unwrap();
    assert_eq!(index.publications().count(), 0);
    w.result = true;
}

#[when("a peer exchanges signed room metadata before any payload is listed")]
async fn metadata_bootstrap(w: &mut RoomWorld) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let allow = Allowlist::new(w.index.clone().unwrap());
    let mut changes = allow.subscribe();
    let snapshot = support::index(w.info()).to_bytes();
    let cid = w.info().content_id();
    let transport = CatalogTransport::new(
        Box::new(Probe::new(
            vec![
                // Datagram snapshots cannot bypass the reliable metadata boundary.
                datagram(Msg::RoomRecords {
                    snapshot: snapshot.clone(),
                }),
                channel(Msg::RoomRecords { snapshot: vec![0] }, &sent),
                channel(
                    Msg::RoomRecords {
                        snapshot: snapshot.clone(),
                    },
                    &sent,
                ),
                datagram(Msg::Have {
                    content: cid,
                    index: 0,
                }),
            ],
            sent.clone(),
        )),
        allow.clone(),
    );
    assert!(!allow.contains(&cid));
    assert_eq!(
        transport
            .send_datagram(
                &"seed".into(),
                Envelope::new(Msg::RoomRecords {
                    snapshot: snapshot.clone()
                })
                .encode()
                .into()
            )
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::PermissionDenied
    );
    let mut outbound = transport.open_channel(&"seed".into()).await.unwrap();
    outbound
        .send(Envelope::new(Msg::RoomRecords { snapshot }).encode().into())
        .await
        .unwrap();
    assert!(
        !allow.contains(&cid),
        "sending metadata must not merge local policy"
    );
    assert!(allow.permits(&Msg::GetRoomRecords {
        room: support::ROOM
    }));
    assert!(!allow.permits(&Msg::GetRoomRecords { room: [0; 32] }));
    let Some(TransportEvent::IncomingChannel { mut channel, .. }) = transport.next_event().await
    else {
        panic!("expected metadata channel")
    };
    assert_eq!(
        channel.recv().await.unwrap().unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(!allow.contains(&cid));
    assert!(!changes.has_changed().unwrap());
    let Some(TransportEvent::IncomingChannel { mut channel, .. }) = transport.next_event().await
    else {
        panic!("expected valid metadata channel")
    };
    channel.recv().await.unwrap().unwrap();
    assert!(changes.has_changed().unwrap());
    changes.borrow_and_update();
    assert!(allow.contains(&cid));
    assert!(matches!(
        transport.next_event().await,
        Some(TransportEvent::Datagram(_))
    ));
    let mut forged = support::publish(w.info(), 2);
    forged.signature[0] ^= 1;
    assert_eq!(
        w.index.as_mut().unwrap().merge([forged]),
        Err(IndexError::BadSignature)
    );
    let wrong = RoomIndex::new([0; 32], support::maintainer().public_key()).to_bytes();
    assert!(!allow.permits(&Msg::RoomRecords { snapshot: wrong }));
    assert!(!allow.permits(&Msg::RoomRecords {
        snapshot: vec![0; entropy_engine::p2p::index::MAX_INDEX_BYTES + 1]
    }));
    w.result = true;
}

#[then("member publishing and moderation invariants hold")]
fn member_invariants(w: &mut RoomWorld) {
    success(w);
}

#[when("a member fills the current record capacity")]
fn record_capacity(w: &mut RoomWorld) {
    use entropy_engine::p2p::index::MAX_ENTRIES;
    let member = Member::from_seed(&[6; 32]).unwrap();
    let entries: Vec<_> = (1..=MAX_ENTRIES as u64)
        .map(|sequence| {
            member
                .sign(support::ROOM, sequence, Action::Publish(item([3; 32])))
                .unwrap()
        })
        .collect();
    let index = w.index.as_mut().unwrap();
    assert_eq!(index.merge(entries).unwrap(), MAX_ENTRIES);
    let before = index.to_bytes();
    let extra = member
        .sign(
            support::ROOM,
            MAX_ENTRIES as u64 + 1,
            Action::Publish(item([4; 32])),
        )
        .unwrap();
    assert_eq!(index.merge([extra]), Err(IndexError::TooLarge));
    assert_eq!(before, index.to_bytes());
    let reload =
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &before).unwrap();
    assert_eq!(reload.entries().count(), MAX_ENTRIES);
    w.result = true;
}

fn tombstone(info: &InfoDocument) -> entropy_engine::p2p::index::SignedEntry {
    support::maintainer()
        .sign(
            support::ROOM,
            2,
            Action::Tombstone {
                content: info.content_id(),
            },
        )
        .unwrap()
}
#[when("a tombstone arrives before stale and newer publications")]
fn deleted(w: &mut RoomWorld) {
    let stale = support::publish(w.info(), 1);
    let newer = support::publish(w.info(), 3);
    let dead = tombstone(w.info());
    let cid = w.info().content_id();
    let index = w.index.as_mut().unwrap();
    index.merge([dead]).unwrap();
    index.merge([stale.clone(), newer]).unwrap();
    let mut remote = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    remote.merge([stale]).unwrap();
    index.merge_bytes(&remote.to_bytes()).unwrap();
    let loaded = RoomIndex::from_bytes(
        support::ROOM,
        support::maintainer().public_key(),
        &index.to_bytes(),
    )
    .unwrap();
    assert!(!loaded.contains(&cid));
    assert_eq!(loaded.entries().count(), 3);
    w.result = true;
}
#[then("the content stays removed after merge and reload")]
fn stays_deleted(w: &mut RoomWorld) {
    success(w);
}

#[when("I load malformed or unsupported snapshots")]
fn malformed(w: &mut RoomWorld) {
    let index = support::index(w.info());
    let mut bytes = index.to_bytes();
    bytes.push(0);
    assert!(
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &bytes).is_err()
    );
    for schema in [1, 99] {
        let mut record = support::publish(w.info(), 1);
        record.entry.schema = schema;
        assert_eq!(
            w.index.as_mut().unwrap().merge([record]),
            Err(IndexError::InvalidEntry)
        );
    }
    let legacy = Envelope {
        protocol: 1,
        msg: Msg::Hello { version: 1 },
    }
    .encode();
    assert!(matches!(
        Envelope::decode(&legacy),
        Err(entropy_engine::p2p::wire::WireError::UnsupportedProtocol { found: 1 })
    ));
    let bytes = rmp_serde::to_vec(&(99u32, support::ROOM, Vec::<u8>::new())).unwrap();
    assert!(
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &bytes).is_err()
    );
    let bytes = vec![0; entropy_engine::p2p::index::MAX_INDEX_BYTES + 1];
    assert!(matches!(
        RoomIndex::from_bytes(support::ROOM, support::maintainer().public_key(), &bytes),
        Err(IndexError::TooLarge)
    ));
    w.result = true;
}
#[then("all malformed snapshots are rejected")]
fn malformed_rejected(w: &mut RoomWorld) {
    success(w);
}

#[when("I supply oversized catalog metadata or wire envelopes")]
fn oversized(w: &mut RoomWorld) {
    let mut publication = item(w.info().content_id());
    publication.title = "x".repeat(257);
    assert!(matches!(
        support::maintainer().sign(support::ROOM, 1, Action::Publish(publication)),
        Err(IndexError::InvalidEntry)
    ));
    let mut publication = item(w.info().content_id());
    publication.description = "x".repeat(4097);
    assert!(matches!(
        support::maintainer().sign(support::ROOM, 1, Action::Publish(publication)),
        Err(IndexError::InvalidEntry)
    ));
    let bytes = vec![0; entropy_engine::p2p::transport::MAX_FRAME_BYTES + 1];
    assert!(Envelope::decode(&bytes).is_err());
    w.result = true;
}
#[then("the size limits reject them")]
fn sizes_rejected(w: &mut RoomWorld) {
    success(w);
}

#[when("I attempt to download and serve an unlisted item")]
async fn unknown(w: &mut RoomWorld) {
    let path = w.directory();
    let sent = Arc::new(Mutex::new(Vec::new()));
    let session = Session::new(
        Box::new(Probe::new(vec![], sent.clone())),
        Allowlist::new(w.index.clone().unwrap()),
    );
    assert!(matches!(
        session
            .download(&path, w.info(), &"seed".into(), Duration::from_secs(1))
            .await,
        Err(SessionError::NotAllowed(_))
    ));
    assert!(matches!(
        session
            .serve(&path, w.info(), Duration::from_secs(1), None)
            .await,
        Err(SessionError::NotAllowed(_))
    ));
    assert!(!path.join("p2p").exists());
    assert!(sent.lock().unwrap().is_empty());
    w.result = true;
}
#[then("neither operation creates files or sends requests")]
fn no_files(w: &mut RoomWorld) {
    success(w);
}

fn datagram(msg: Msg) -> TransportEvent {
    TransportEvent::Datagram(Datagram {
        peer: "seed".into(),
        payload: Envelope::new(msg).encode().into(),
        route: RouteMode::Direct,
    })
}
fn channel(msg: Msg, sent: &Arc<Mutex<Vec<Bytes>>>) -> TransportEvent {
    TransportEvent::IncomingChannel {
        peer: "seed".into(),
        channel: Box::new(Channel {
            bytes: Some(Envelope::new(msg).encode().into()),
            sent: sent.clone(),
        }),
    }
}
#[when("a peer sends an unlisted piece before an indexed piece")]
async fn pieces(w: &mut RoomWorld) {
    let path = w.directory();
    let sent = Arc::new(Mutex::new(Vec::new()));
    let cid = w.info().content_id();
    let events = vec![
        datagram(Msg::Have {
            content: [99; 32],
            index: 0,
        }),
        datagram(Msg::Bitfield {
            content: cid,
            bitmap: vec![1],
        }),
        channel(
            Msg::Piece {
                content: [99; 32],
                index: 0,
                data: b"verified room bytes".to_vec(),
            },
            &sent,
        ),
        channel(
            Msg::Piece {
                content: cid,
                index: 0,
                data: b"verified room bytes".to_vec(),
            },
            &sent,
        ),
    ];
    let session = Session::new(Box::new(Probe::new(events, sent)), support::allow(w.info()));
    session
        .download(&path, w.info(), &"seed".into(), Duration::from_secs(2))
        .await
        .unwrap();
    let root = path.join("p2p");
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    let entry = root.join(w.info().content_id_hex());
    assert_eq!(
        std::fs::read(entry.join("data")).unwrap(),
        b"verified room bytes"
    );
    assert!(entry.join("sealed").exists());
    w.result = true;
}
#[then("only the indexed content is verified and promoted")]
fn only_indexed(w: &mut RoomWorld) {
    success(w);
}

#[when("I send unlisted controls metadata and pieces")]
async fn outbound(w: &mut RoomWorld) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let allow = support::allow(w.info());
    let transport = CatalogTransport::new(Box::new(Probe::new(vec![], sent.clone())), allow);
    let peer: PeerId = "seed".into();
    let mut ch = transport.open_channel(&peer).await.unwrap();
    let other = InfoDocument::for_bytes("unknown.bin", None, b"other", 64, 0);
    let messages = vec![
        Msg::Want {
            content: [99; 32],
            index: 0,
        },
        Msg::Have {
            content: [99; 32],
            index: 0,
        },
        Msg::GetInfo { content: [99; 32] },
        Msg::Bitfield {
            content: [99; 32],
            bitmap: vec![1],
        },
        Msg::Cancel {
            content: [99; 32],
            index: 0,
        },
        Msg::Done { content: [99; 32] },
        Msg::Info {
            document: other.to_canonical(),
        },
        Msg::Piece {
            content: [99; 32],
            index: 0,
            data: vec![1],
        },
    ];
    for msg in messages {
        let bytes: Bytes = Envelope::new(msg).encode().into();
        assert_eq!(
            transport
                .send_datagram(&peer, bytes.clone())
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::PermissionDenied
        );
        assert_eq!(
            ch.send(bytes).await.unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }
    assert!(sent.lock().unwrap().is_empty());
    ch.send(
        Envelope::new(Msg::Info {
            document: w.info().to_canonical(),
        })
        .encode()
        .into(),
    )
    .await
    .unwrap();
    assert_eq!(sent.lock().unwrap().len(), 1);
    w.result = true;
}
#[then("the transport rejects all unlisted messages")]
fn blocked(w: &mut RoomWorld) {
    success(w);
}

#[when("I revoke content after preparing a send and opening channels")]
async fn pending_revocation(w: &mut RoomWorld) {
    let sent = Arc::new(Mutex::new(Vec::new()));
    let cid = w.info().content_id();
    let allow = support::allow(w.info());
    let transport = CatalogTransport::new(
        Box::new(Probe::new(
            vec![channel(
                Msg::Piece {
                    content: cid,
                    index: 0,
                    data: b"verified room bytes".to_vec(),
                },
                &sent,
            )],
            sent.clone(),
        )),
        allow.clone(),
    );
    let peer: PeerId = "seed".into();
    let bytes: Bytes = Envelope::new(Msg::Want {
        content: cid,
        index: 0,
    })
    .encode()
    .into();
    let pending = transport.send_datagram(&peer, bytes.clone());
    let mut outgoing = transport.open_channel(&peer).await.unwrap();
    let Some(TransportEvent::IncomingChannel { mut channel, .. }) = transport.next_event().await
    else {
        panic!("expected a channel")
    };
    let mut index = support::index(w.info());
    index.merge([tombstone(w.info())]).unwrap();
    allow.merge_bytes(&index.to_bytes()).unwrap();
    assert_eq!(
        pending.await.unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        outgoing.send(bytes).await.unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert_eq!(
        channel.recv().await.unwrap().unwrap_err().kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(sent.lock().unwrap().is_empty());
    w.result = true;
}
#[then("no prepared message can bypass the tombstone")]
fn pending_blocked(w: &mut RoomWorld) {
    success(w);
}

#[when(regex = r"^I (tombstone|withdraw) a stalled active download$")]
async fn revoke_download(w: &mut RoomWorld, operation: String) {
    let path = w.directory();
    let sent = Arc::new(Mutex::new(Vec::new()));
    let allow = support::allow(w.info());
    let session = Session::new(
        Box::new(Probe::new(
            vec![datagram(Msg::Bitfield {
                content: w.info().content_id(),
                bitmap: vec![1],
            })],
            sent.clone(),
        )),
        allow.clone(),
    );
    let snapshot = {
        let mut i = support::index(w.info());
        let removal = if operation == "withdraw" {
            Member::from_seed(&[6; 32])
                .unwrap()
                .sign(
                    support::ROOM,
                    2,
                    Action::Withdraw {
                        publication: support::publish(w.info(), 1).entry.id(),
                    },
                )
                .unwrap()
        } else {
            tombstone(w.info())
        };
        i.merge([removal]).unwrap();
        i.to_bytes()
    };
    let cid = w.info().content_id();
    let revoke = async {
        for _ in 0..100 {
            if sent
                .lock()
                .unwrap()
                .iter()
                .any(|b| matches!(Envelope::decode(b).unwrap().msg, Msg::Want { .. }))
            {
                allow.merge_bytes(&snapshot).unwrap();
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("download did not request a piece");
    };
    let peer: PeerId = "seed".into();
    let (result, ()) = tokio::join!(
        session.download(&path, w.info(), &peer, Duration::from_secs(2)),
        revoke
    );
    assert!(matches!(result, Err(SessionError::NotAllowed(c)) if c == cid));
    assert!(!path
        .join("p2p")
        .join(w.info().content_id_hex())
        .join("sealed")
        .exists());
    w.result = true;
}
#[then("the download stops without promoting the file")]
fn download_revoked(w: &mut RoomWorld) {
    success(w);
}

#[when("I tombstone an active seeder")]
async fn revoke_seed(w: &mut RoomWorld) {
    let path = w.directory();
    let mut store = PieceStore::open(&path, w.info()).unwrap();
    store.write_piece(0, b"verified room bytes").unwrap();
    store.promote().unwrap();
    let sent = Arc::new(Mutex::new(Vec::new()));
    let allow = support::allow(w.info());
    let session = Session::new(
        Box::new(Probe::new(
            vec![datagram(Msg::Want {
                content: w.info().content_id(),
                index: 0,
            })],
            sent.clone(),
        )),
        allow.clone(),
    );
    let snapshot = {
        let mut i = support::index(w.info());
        i.merge([tombstone(w.info())]).unwrap();
        i.to_bytes()
    };
    let revoke = async {
        for _ in 0..100 {
            if !sent.lock().unwrap().is_empty() {
                allow.merge_bytes(&snapshot).unwrap();
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("seed did not start serving");
    };
    let (result, ()) = tokio::join!(
        session.serve(&path, w.info(), Duration::from_secs(2), None),
        revoke
    );
    assert!(matches!(result, Err(SessionError::NotAllowed(_))));
    assert!(!allow.permits(&Msg::Want {
        content: w.info().content_id(),
        index: 0
    }));
    w.result = true;
}
#[then("the seeder stops and rejects further traffic")]
fn seed_revoked(w: &mut RoomWorld) {
    success(w);
}

fn port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn cfg(node: u8, port: u16, bootstrap: u16, group: &str, allowed: &[u8]) -> KcpConfig {
    KcpConfig {
        node_id: Ipv4Addr::new(10, 6, 0, node),
        udp_port: port,
        tcp_port: port,
        group_code: group.into(),
        psk_password: "synthetic-room-test".into(),
        bootstrap: vec![format!("udp://127.0.0.1:{bootstrap}")],
        allow_src: allowed
            .iter()
            .map(|&n| u32::from(Ipv4Addr::new(10, 6, 0, n)))
            .collect(),
    }
}

async fn receive_marker(
    sender: &KcpTransport,
    receiver: &CatalogTransport,
    index: u32,
    content: [u8; 32],
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "correct-room route did not establish"
        );
        let bytes = Envelope::new(Msg::Want { content, index }).encode();
        let _ = sender.send_datagram(&"10.6.0.1".into(), bytes.into()).await;
        if let Ok(Some(TransportEvent::Datagram(dg))) =
            tokio::time::timeout(Duration::from_millis(100), receiver.next_event()).await
        {
            let msg = Envelope::decode(&dg.payload).unwrap().msg;
            assert!(
                match &msg {
                    Msg::Want { content: c, .. } => *c == content,
                    Msg::Hello { .. } => true,
                    _ => false,
                },
                "unexpected delivered message {msg:?}"
            );
            if msg == (Msg::Want { content, index }) {
                return;
            }
        }
    }
}

#[given("two KCP peers in the same room")]
async fn peers(w: &mut RoomWorld) {
    room(w);
    let a = port();
    let mut b = port();
    while b == a {
        b = port();
    }
    let receiver = KcpTransport::start(cfg(1, a, b, "phase6-room", &[2, 3]))
        .await
        .unwrap();
    let sender = KcpTransport::start(cfg(2, b, a, "phase6-room", &[1]))
        .await
        .unwrap();
    let receiver = CatalogTransport::new(Box::new(receiver), support::allow(w.info()));
    receive_marker(&sender, &receiver, 0, w.info().content_id()).await;
    w.sender = Some(sender);
    w.receiver = Some(receiver);
    w.receiver_port = a;
}

#[when("the sender announces an unknown content id")]
async fn network_unknown(w: &mut RoomWorld) {
    let sender = w.sender.as_ref().unwrap();
    let receiver = w.receiver.as_ref().unwrap();
    for msg in [
        Msg::Have {
            content: [99; 32],
            index: 0,
        },
        Msg::Want {
            content: [99; 32],
            index: 0,
        },
        Msg::Done { content: [99; 32] },
    ] {
        sender
            .send_datagram(&"10.6.0.1".into(), Envelope::new(msg).encode().into())
            .await
            .unwrap();
    }
    receive_marker(sender, receiver, 99, w.info().content_id()).await;
    w.result = true;
}
#[then("the receiver sees only catalog-listed controls")]
fn controls_filtered(w: &mut RoomWorld) {
    success(w);
}

async fn foreign(w: &mut RoomWorld, wrong_group: bool) {
    let (node, group) = if wrong_group {
        (3, "wrong-room")
    } else {
        (4, "phase6-room")
    };
    let rogue = KcpTransport::start(cfg(node, port(), w.receiver_port, group, &[1]))
        .await
        .unwrap();
    let receiver = w.receiver.as_ref().unwrap();
    let peer = PeerId::new(format!("10.6.0.{node}"));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tokio::time::Instant::now() < deadline {
        let _ = rogue
            .send_datagram(
                &"10.6.0.1".into(),
                Envelope::new(Msg::Hello {
                    version: PROTOCOL_VERSION,
                })
                .encode()
                .into(),
            )
            .await;
        if let Ok(Some(TransportEvent::Datagram(dg))) =
            tokio::time::timeout(Duration::from_millis(100), receiver.next_event()).await
        {
            assert_ne!(
                dg.peer, peer,
                "foreign group or unlisted peer delivered traffic"
            );
        }
    }
    // The positive control still works after the rejected attempt.
    receive_marker(
        w.sender.as_ref().unwrap(),
        receiver,
        1,
        w.info().content_id(),
    )
    .await;
    w.result = true;
}
#[when("a peer with the wrong group code tries to join")]
async fn wrong_group(w: &mut RoomWorld) {
    foreign(w, true).await;
}
#[when("a peer outside the socket allowlist sends traffic")]
async fn wrong_peer(w: &mut RoomWorld) {
    foreign(w, false).await;
}
#[then("the foreign peer delivers no traffic")]
fn isolated(w: &mut RoomWorld) {
    success(w);
}

#[tokio::main]
async fn main() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("error"))
        .try_init();
    RoomWorld::cucumber()
        .fail_on_skipped()
        .run_and_exit("tests/features/p2p_room.feature")
        .await;
}
