use cucumber::{World as _, given, then, when};
use entropy_engine::p2p::{
    index::{Action, Member, RoomIndex},
    meta::InfoDocument,
    rendezvous::{ANNOUNCE_TTL_SECS, Announcement, RendezvousClient, hex, unix_seconds},
    tracker::Tracker,
};
use std::{path::PathBuf, time::Duration};
#[path = "common/p2p.rs"]
mod support;

#[derive(Default, cucumber::World)]
struct TrackerWorld {
    root: PathBuf,
    client: Option<RendezvousClient>,
    base: String,
    stop: Option<tokio::sync::watch::Sender<bool>>,
    task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
    info: Option<InfoDocument>,
    batch: Option<RoomIndex>,
    result: bool,
}
impl std::fmt::Debug for TrackerWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TrackerWorld")
    }
}
impl Drop for TrackerWorld {
    fn drop(&mut self) {
        if let Some(tx) = &self.stop {
            let _ = tx.send(true);
        }
    }
}
impl TrackerWorld {
    fn client(&self) -> &RendezvousClient {
        self.client.as_ref().unwrap()
    }
    fn content(&self) -> [u8; 32] {
        self.info.as_ref().unwrap().content_id()
    }
    fn claim(&self, time: u64, seed: u8) -> Announcement {
        Announcement::sign(
            &Member::from_seed(&[seed; 32]).unwrap(),
            support::ROOM,
            self.content(),
            "10.0.0.1".into(),
            "127.0.0.1:45000".parse().unwrap(),
            time,
        )
    }
    async fn start(&mut self) {
        let tracker = Tracker::open(
            self.root.join("index.msgpack"),
            support::ROOM,
            support::maintainer().public_key(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        self.base = format!("http://{}", listener.local_addr().unwrap());
        self.client = Some(
            RendezvousClient::new(
                &self.base,
                support::ROOM,
                support::maintainer().public_key(),
            )
            .unwrap(),
        );
        let (stop, rx) = tokio::sync::watch::channel(false);
        self.stop = Some(stop);
        self.task = Some(tokio::spawn(tracker.serve(listener, rx)));
    }
    async fn halt(&mut self) {
        self.stop.take().unwrap().send(true).unwrap();
        self.task.take().unwrap().await.unwrap().unwrap();
    }
    async fn raw(&self, endpoint: &str, bytes: Vec<u8>, media: &str) -> u16 {
        reqwest::Client::new()
            .put(format!(
                "{}/v1/rooms/{}/{}",
                self.base,
                hex(&support::ROOM),
                endpoint
            ))
            .header("Content-Type", media)
            .body(bytes)
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }
}
#[given("a local tracker with one member publication")]
async fn setup(w: &mut TrackerWorld) {
    w.root = std::env::temp_dir().join(format!("entropy-tracker-bdd-{}", uuid::Uuid::new_v4()));
    let info = InfoDocument::for_bytes("tracker.bin", None, b"synthetic peer content", 8, 0);
    w.batch = Some(support::index(&info));
    w.info = Some(info);
    w.start().await;
    w.client()
        .put_records(w.batch.as_ref().unwrap())
        .await
        .unwrap();
}
#[when("two independent members publish with the maintainer offline")]
async fn members(w: &mut TrackerWorld) {
    let mut batch = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    let original = support::publish(w.info.as_ref().unwrap(), 1);
    let mut item = match original.entry.action {
        Action::Publish(item) => item,
        _ => unreachable!(),
    };
    item.title = "Second independent publication".into();
    batch
        .merge([Member::from_seed(&[5; 32])
            .unwrap()
            .sign(support::ROOM, 1, Action::Publish(item))
            .unwrap()])
        .unwrap();
    w.client().put_records(&batch).await.unwrap();
    let index = w.client().get_index().await.unwrap();
    w.result = index.publications().count() == 2 && index.entries().count() == 2;
}
#[when("the same signed records arrive twice")]
async fn duplicates(w: &mut TrackerWorld) {
    w.client()
        .put_records(w.batch.as_ref().unwrap())
        .await
        .unwrap();
    w.result = w.client().get_index().await.unwrap().entries().count() == 1;
}
#[when("invalid and unauthorized record batches arrive")]
async fn invalid(w: &mut TrackerWorld) {
    let bytes = w.batch.as_ref().unwrap().to_bytes();
    let mut bad = bytes.clone();
    *bad.last_mut().unwrap() ^= 1;
    assert_eq!(w.raw("records", bad, "application/msgpack").await, 400);

    let signed = Member::from_seed(&[5; 32])
        .unwrap()
        .sign(
            support::ROOM,
            2,
            Action::Tombstone {
                content: w.content(),
            },
        )
        .unwrap();
    #[derive(serde::Serialize)]
    struct Batch {
        schema: u32,
        room: [u8; 32],
        entries: Vec<entropy_engine::p2p::index::SignedEntry>,
    }
    let batch = Batch {
        schema: 2,
        room: support::ROOM,
        entries: vec![support::publish(w.info.as_ref().unwrap(), 1), signed],
    };
    // Valid signatures with invalid authority still reject the entire batch.
    assert_eq!(
        w.raw(
            "records",
            rmp_serde::to_vec_named(&batch).unwrap(),
            "application/msgpack"
        )
        .await,
        400
    );
    w.result = w.client().get_index().await.unwrap().to_bytes() == bytes;
}
#[when("a signed peer announces eligible content")]
async fn announces(w: &mut TrackerWorld) {
    let claim = w.claim(unix_seconds(), 3);
    w.client().put_announce(&claim).await.unwrap();
    let peers = w.client().get_peers(w.content()).await.unwrap();
    w.result = peers.len() == 1 && peers[0].peer == "10.0.0.1" && peers[0].address == claim.address;
}
#[when("the last seeder lease expires and is replayed")]
async fn expiry(w: &mut TrackerWorld) {
    let claim = w.claim(unix_seconds() - ANNOUNCE_TTL_SECS + 2, 3);
    w.client().put_announce(&claim).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        w.raw(
            "announce",
            serde_json::to_vec(&claim).unwrap(),
            "application/json"
        )
        .await,
        400
    );
    w.result = w.client().get_peers(w.content()).await.unwrap().is_empty()
        && w.client().get_index().await.unwrap().contains(&w.content());
}
#[when("a replay attempts to refresh the existing lease")]
async fn replay(w: &mut TrackerWorld) {
    let claim = w.claim(unix_seconds() - ANNOUNCE_TTL_SECS + 3, 3);
    w.client().put_announce(&claim).await.unwrap();
    tokio::time::sleep(Duration::from_secs(1)).await;
    w.client().put_announce(&claim).await.unwrap();
    tokio::time::sleep(Duration::from_millis(2200)).await;
    w.result = w.client().get_peers(w.content()).await.unwrap().is_empty();
}
#[when("moderation arrives after a live announcement")]
async fn moderation(w: &mut TrackerWorld) {
    w.client()
        .put_announce(&w.claim(unix_seconds(), 3))
        .await
        .unwrap();
    let mut batch = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    batch
        .merge([support::maintainer()
            .sign(
                support::ROOM,
                1,
                Action::Tombstone {
                    content: w.content(),
                },
            )
            .unwrap()])
        .unwrap();
    w.client().put_records(&batch).await.unwrap();
    w.client()
        .put_records(w.batch.as_ref().unwrap())
        .await
        .unwrap();
    w.result = w.client().get_peers(w.content()).await.unwrap().is_empty()
        && !w.client().get_index().await.unwrap().contains(&w.content())
        && w.client()
            .put_announce(&w.claim(unix_seconds(), 3))
            .await
            .is_err();
}
#[when("the tracker restarts after a live announcement")]
async fn restart(w: &mut TrackerWorld) {
    w.client()
        .put_announce(&w.claim(unix_seconds(), 3))
        .await
        .unwrap();
    let before = w.client().get_index().await.unwrap().to_bytes();
    w.halt().await;
    w.start().await;
    w.result = w.client().get_index().await.unwrap().to_bytes() == before
        && w.client().get_peers(w.content()).await.unwrap().is_empty();
}
#[when("foreign room pins and corrupted persisted records are supplied")]
async fn wrong_pins(w: &mut TrackerWorld) {
    let other =
        RendezvousClient::new(&w.base, [8; 32], support::maintainer().public_key()).unwrap();
    assert!(other.get_index().await.is_err());
    let mut policy = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    policy
        .merge([support::maintainer()
            .sign(
                support::ROOM,
                1,
                Action::SetPolicy {
                    member_publishing: true,
                },
            )
            .unwrap()])
        .unwrap();
    w.client().put_records(&policy).await.unwrap();
    let wrong = RendezvousClient::new(
        &w.base,
        support::ROOM,
        Member::from_seed(&[5; 32]).unwrap().public_key(),
    )
    .unwrap();
    assert!(wrong.get_index().await.is_err());
    w.halt().await;
    let path = w.root.join("index.msgpack");
    assert!(Tracker::open(&path, [8; 32], support::maintainer().public_key()).is_err());
    std::fs::write(&path, b"corrupt").unwrap();
    w.result = Tracker::open(&path, support::ROOM, support::maintainer().public_key()).is_err();
}
#[when("unlisted forged stale and foreign-address announcements arrive")]
async fn bad_claims(w: &mut TrackerWorld) {
    let now = unix_seconds();
    let mut forged = w.claim(now, 3);
    forged.peer = "forged".into();
    assert_eq!(
        w.raw(
            "announce",
            serde_json::to_vec(&forged).unwrap(),
            "application/json"
        )
        .await,
        400
    );
    let stale = w.claim(now - ANNOUNCE_TTL_SECS, 3);
    assert_eq!(
        w.raw(
            "announce",
            serde_json::to_vec(&stale).unwrap(),
            "application/json"
        )
        .await,
        400
    );
    let key = Member::from_seed(&[3; 32]).unwrap();
    let unknown = Announcement::sign(
        &key,
        support::ROOM,
        [1; 32],
        "10.0.0.1".into(),
        "127.0.0.1:45000".parse().unwrap(),
        now,
    );
    assert_eq!(
        w.raw(
            "announce",
            serde_json::to_vec(&unknown).unwrap(),
            "application/json"
        )
        .await,
        403
    );
    let foreign = Announcement::sign(
        &key,
        support::ROOM,
        w.content(),
        "10.0.0.1".into(),
        "192.0.2.1:45000".parse().unwrap(),
        now,
    );
    assert_eq!(
        w.raw(
            "announce",
            serde_json::to_vec(&foreign).unwrap(),
            "application/json"
        )
        .await,
        400
    );
    w.result = w.client().get_peers(w.content()).await.unwrap().is_empty();
}
#[when("one source exceeds the request rate limit")]
async fn rate(w: &mut TrackerWorld) {
    for _ in 0..119 {
        w.client().get_index().await.unwrap();
    }
    w.result = w
        .client()
        .get_index()
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("429");
}
#[when("peer hints reach their per-content capacity")]
async fn capacity(w: &mut TrackerWorld) {
    for seed in 20..84 {
        w.client()
            .put_announce(&w.claim(unix_seconds(), seed))
            .await
            .unwrap();
    }
    w.result = w
        .client()
        .put_announce(&w.claim(unix_seconds(), 84))
        .await
        .unwrap_err()
        .to_string()
        .contains("429")
        && w.client().get_peers(w.content()).await.unwrap().len() == 64;
}
#[when("oversized bodies and payload endpoints are requested")]
async fn oversized(w: &mut TrackerWorld) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = w.base.trim_start_matches("http://");
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let header = format!(
        "PUT /v1/rooms/{}/records HTTP/1.1\r\nHost: localhost\r\nContent-Length: 4194305\r\n\r\n",
        hex(&support::ROOM)
    );
    socket.write_all(header.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await.unwrap();
    assert!(
        String::from_utf8(bytes)
            .unwrap()
            .starts_with("HTTP/1.1 413")
    );
    let response = reqwest::get(format!(
        "{}/v1/rooms/{}/payload/{}",
        w.base,
        hex(&support::ROOM),
        hex(&w.content())
    ))
    .await
    .unwrap();
    w.result = response.status().as_u16() == 404;
}
#[when("a persistence write fails before commit")]
async fn persistence_failure(w: &mut TrackerWorld) {
    let before = w.client().get_index().await.unwrap().to_bytes();
    // Block the temporary snapshot filename without touching the committed file.
    std::fs::create_dir(w.root.join("index.msgpack.pending")).unwrap();
    let mut batch = RoomIndex::new(support::ROOM, support::maintainer().public_key());
    batch
        .merge([support::maintainer()
            .sign(
                support::ROOM,
                1,
                Action::Tombstone {
                    content: w.content(),
                },
            )
            .unwrap()])
        .unwrap();
    w.result = w.client().put_records(&batch).await.is_err()
        && w.client().get_index().await.unwrap().to_bytes() == before
        && std::fs::read(w.root.join("index.msgpack")).unwrap() == before;
}
#[when("concurrent publishers merge into one durable index")]
async fn concurrent(w: &mut TrackerWorld) {
    let mut jobs = tokio::task::JoinSet::new();
    for seed in 20..28 {
        let mut batch = RoomIndex::new(support::ROOM, support::maintainer().public_key());
        let item = match support::publish(w.info.as_ref().unwrap(), 1).entry.action {
            Action::Publish(item) => item,
            _ => unreachable!(),
        };
        batch
            .merge([Member::from_seed(&[seed; 32])
                .unwrap()
                .sign(support::ROOM, 1, Action::Publish(item))
                .unwrap()])
            .unwrap();
        let client = w.client().clone();
        jobs.spawn(async move {
            client.put_records(&batch).await.unwrap();
        });
    }
    while let Some(result) = jobs.join_next().await {
        result.unwrap();
    }
    let index = w.client().get_index().await.unwrap();
    w.result = index.publications().count() == 9
        && std::fs::read(w.root.join("index.msgpack")).unwrap() == index.to_bytes();
}
#[when("malformed HTTP framing and missing lengths arrive")]
async fn framing(w: &mut TrackerWorld) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (headers, status) in [
        ("Content-Length: 0\r\nContent-Length: 0\r\n", 400),
        ("Transfer-Encoding: chunked\r\n", 400),
        ("", 411),
    ] {
        let mut socket = tokio::net::TcpStream::connect(w.base.trim_start_matches("http://"))
            .await
            .unwrap();
        let request = format!(
            "PUT /v1/rooms/{}/records HTTP/1.1\r\nHost: localhost\r\n{}\r\n",
            hex(&support::ROOM),
            headers
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        socket.read_to_end(&mut bytes).await.unwrap();
        assert!(
            String::from_utf8(bytes)
                .unwrap()
                .starts_with(&format!("HTTP/1.1 {status}"))
        );
    }
    let mut socket = tokio::net::TcpStream::connect(w.base.trim_start_matches("http://"))
        .await
        .unwrap();
    let request = format!(
        "GET / HTTP/1.1\r\nHost: localhost\r\nX-Fill: {}\r\n\r\n",
        "a".repeat(8200)
    );
    socket.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    let _ = socket.read_to_end(&mut bytes).await;
    w.result = String::from_utf8(bytes)
        .unwrap()
        .starts_with("HTTP/1.1 431");
}
#[when("the client receives an oversized or forged tracker response")]
async fn hostile_response(w: &mut TrackerWorld) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (length, body) in [(4194305, Vec::new()), (7, b"forged!".to_vec())] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = RendezvousClient::new(
            &format!("http://{}", listener.local_addr().unwrap()),
            support::ROOM,
            support::maintainer().public_key(),
        )
        .unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            let mut byte = [0];
            while !headers.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            socket.write_all(&body).await.unwrap();
        });
        assert!(client.get_index().await.is_err());
        task.await.unwrap();
    }
    w.result = true;
}
#[when("the tracker shuts down with an incomplete request")]
async fn shutdown(w: &mut TrackerWorld) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let address = w.base.trim_start_matches("http://").to_owned();
    let mut socket = tokio::net::TcpStream::connect(&address).await.unwrap();
    socket.write_all(b"GET /v1/rooms/").await.unwrap();
    // A complete request verifies the server remains responsive beside the stalled connection.
    assert!(w.client().get_index().await.unwrap().contains(&w.content()));
    tokio::time::timeout(Duration::from_secs(12), w.halt())
        .await
        .unwrap();
    let listener = tokio::net::TcpListener::bind(&address).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(1), socket.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    w.result = bytes.is_empty();
    drop(listener);
}
#[then("the tracker preserves the required behavior")]
async fn check(w: &mut TrackerWorld) {
    assert!(w.result);
    if w.task.is_some() {
        w.halt().await;
    }
    std::fs::remove_dir_all(&w.root).unwrap();
}
#[tokio::main]
async fn main() {
    TrackerWorld::cucumber()
        .max_concurrent_scenarios(1)
        .fail_on_skipped()
        .run_and_exit("tests/features/p2p_tracker.feature")
        .await;
}
