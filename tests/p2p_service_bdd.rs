use cucumber::{World as _, given, then, when};
use entropy_engine::p2p::{
    index::{RoomIndex, SigningKey},
    rendezvous::{RendezvousClient, hex},
    service::{Command, P2pService, PeerConfig, ServiceConfig, ServiceView},
    tracker::Tracker,
};
use std::{path::PathBuf, time::Duration};

#[derive(Default, cucumber::World)]
struct ForumWorld {
    root: PathBuf,
    configs: Vec<ServiceConfig>,
    services: Vec<Option<P2pService>>,
    tracker_stop: Option<tokio::sync::watch::Sender<bool>>,
    tracker_task: Option<tokio::task::JoinHandle<anyhow::Result<()>>>,
    tracker_addr: Option<std::net::SocketAddr>,
    posts: Vec<String>,
    author: String,
    sequence: u64,
}
impl std::fmt::Debug for ForumWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ForumWorld")
    }
}
impl Drop for ForumWorld {
    fn drop(&mut self) {
        for s in self.services.iter_mut().filter_map(Option::take) {
            s.join();
        }
        if let Some(s) = &self.tracker_stop {
            let _ = s.send(true);
        }
    }
}
impl ForumWorld {
    fn service(&self, i: usize) -> &P2pService {
        self.services[i].as_ref().unwrap()
    }
    fn start(&mut self, i: usize) {
        self.services[i] = Some(
            P2pService::start(self.root.join(i.to_string()), self.configs[i].clone()).unwrap(),
        );
    }
    async fn wait(&self, i: usize, condition: impl Fn(&ServiceView) -> bool) -> ServiceView {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        loop {
            let v = self.service(i).snapshot();
            if condition(&v) {
                return v;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "profile {i}: {}",
                serde_json::to_string(&v).unwrap()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    async fn tracker(&mut self) {
        let c = &self.configs[0];
        let listener = tokio::net::TcpListener::bind(self.tracker_addr.unwrap())
            .await
            .unwrap();
        let tracker = Tracker::open(
            self.root.join("tracker.msgpack"),
            entropy_engine::p2p::rendezvous::parse_hex(&c.room).unwrap(),
            entropy_engine::p2p::rendezvous::parse_hex(&c.maintainer).unwrap(),
        )
        .unwrap();
        let (tx, rx) = tokio::sync::watch::channel(false);
        self.tracker_stop = Some(tx);
        self.tracker_task = Some(tokio::spawn(tracker.serve(listener, rx)));
    }
}
fn free_port() -> u16 {
    std::net::UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
#[given("four isolated forum profiles and a metadata tracker")]
async fn setup(w: &mut ForumWorld) {
    w.root = std::env::current_dir()
        .unwrap()
        .join("test-artifacts")
        .join(format!(
            "p2p-service-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
    std::fs::create_dir_all(&w.root).unwrap();
    let key = SigningKey::generate_pkcs8().unwrap();
    let maintainer = SigningKey::from_pkcs8(&key).unwrap().public_key();
    std::fs::create_dir_all(w.root.join("3")).unwrap();
    std::fs::write(w.root.join("3/author.pk8"), key).unwrap();
    let room = hex(&[29; 32]);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    w.tracker_addr = Some(listener.local_addr().unwrap());
    drop(listener);
    let nodes: Vec<_> = (1..=5)
        .map(|i| PeerConfig {
            id: format!("10.29.0.{i}").parse().unwrap(),
            address: format!("127.0.0.1:{}", free_port()).parse().unwrap(),
        })
        .collect();
    w.configs = (0..5)
        .map(|i| ServiceConfig {
            room: room.clone(),
            maintainer: hex(&maintainer),
            node_id: nodes[i].id,
            port: nodes[i].address.port(),
            group_code: "forum-bdd".into(),
            tracker: Some(format!("http://{}", w.tracker_addr.unwrap())),
            advertise_address: None,
            peers: nodes
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, p)| p.clone())
                .collect(),
        })
        .collect();
    w.services = (0..5).map(|_| None).collect();
    w.tracker().await;
    for i in 0..3 {
        w.start(i);
        w.wait(i, |v| v.running).await;
    }
}
#[when("members A and B publish with the maintainer offline")]
async fn publish(w: &mut ForumWorld) {
    assert!(w.services[3].is_none());
    for (i, title) in ["Member A", "Member B"].iter().enumerate() {
        w.service(i)
            .command(Command::Publish {
                title: (*title).into(),
                body: format!("Body from {title}"),
                parent: None,
            })
            .unwrap();
        let v = w
            .wait(i, |v| v.posts.iter().any(|p| p.title == *title))
            .await;
        w.posts.push(
            v.posts
                .iter()
                .find(|p| p.title == *title)
                .unwrap()
                .id
                .clone(),
        );
    }
}
#[then("member C sees both signed publications")]
async fn catalog(w: &mut ForumWorld) {
    w.wait(2, |v| v.posts.len() == 2).await;
}
#[when("C downloads both posts and A and B leave")]
async fn fetch(w: &mut ForumWorld) {
    for p in &w.posts {
        w.service(2)
            .command(Command::Fetch {
                publication: p.clone(),
            })
            .unwrap();
    }
    let v = w
        .wait(2, |v| {
            v.posts.len() == 2 && v.posts.iter().all(|p| p.body.is_some())
        })
        .await;
    assert!(
        v.posts
            .iter()
            .any(|p| p.body.as_deref() == Some("Body from Member A"))
    );
    assert!(
        v.posts
            .iter()
            .any(|p| p.body.as_deref() == Some("Body from Member B"))
    );
    for i in 0..2 {
        w.services[i].take().unwrap().join();
    }
}
#[then("a fresh reader downloads both bodies from C")]
async fn reseed(w: &mut ForumWorld) {
    // Configure only C so this is evidence of re-serving, not a surviving original seeder.
    let c_id = w.configs[2].node_id;
    w.configs[4].peers.retain(|p| p.id == c_id);
    w.start(4);
    w.wait(4, |v| v.posts.len() == 2).await;
    for p in &w.posts {
        w.service(4)
            .command(Command::Fetch {
                publication: p.clone(),
            })
            .unwrap();
    }
    w.wait(4, |v| {
        v.posts.iter().filter(|p| p.body.is_some()).count() == 2
    })
    .await;
}
#[when("C restarts and publishes again")]
async fn restart(w: &mut ForumWorld) {
    let v = w.service(2).snapshot();
    w.author = v.author;
    w.service(2)
        .command(Command::Publish {
            title: "C before restart".into(),
            body: "Persistent author".into(),
            parent: None,
        })
        .unwrap();
    let v = w
        .wait(2, |v| v.posts.iter().any(|p| p.title == "C before restart"))
        .await;
    w.sequence = v
        .posts
        .iter()
        .find(|p| p.title == "C before restart")
        .unwrap()
        .sequence;
    w.services[2].take().unwrap().join();
    w.start(2);
    w.wait(2, |v| v.running).await;
    w.service(2)
        .command(Command::Publish {
            title: "C after restart".into(),
            body: "New sequence".into(),
            parent: None,
        })
        .unwrap();
}
#[then("its author key survives and its sequence increases")]
async fn identity(w: &mut ForumWorld) {
    let v = w
        .wait(2, |v| v.posts.iter().any(|p| p.title == "C after restart"))
        .await;
    assert_eq!(v.author, w.author);
    assert!(
        v.posts
            .iter()
            .find(|p| p.title == "C after restart")
            .unwrap()
            .sequence
            > w.sequence
    );
    assert!(
        v.posts
            .iter()
            .filter(|p| w.posts.contains(&p.id))
            .all(|p| p.body.is_some())
    );
}
#[when("the maintainer removes a publication and a stale member returns")]
async fn moderate(w: &mut ForumWorld) {
    w.start(3);
    w.wait(3, |v| v.posts.iter().any(|p| p.id == w.posts[0]))
        .await;
    w.service(3)
        .command(Command::Remove {
            publication: w.posts[0].clone(),
        })
        .unwrap();
    w.wait(2, |v| !v.posts.iter().any(|p| p.id == w.posts[0]))
        .await;
    w.start(0);
}
#[then("every connected reader keeps that publication hidden")]
async fn hidden(w: &mut ForumWorld) {
    for i in [0, 2, 3, 4] {
        w.wait(i, |v| {
            v.running
                && v.posts.iter().any(|p| p.id == w.posts[1])
                && !v.posts.iter().any(|p| p.id == w.posts[0])
        })
        .await;
    }
    tokio::time::sleep(Duration::from_secs(6)).await;
    for i in [0, 2, 3, 4] {
        assert!(
            !w.service(i)
                .snapshot()
                .posts
                .iter()
                .any(|p| p.id == w.posts[0])
        );
    }
}
#[when("the tracker stops and a member publishes")]
async fn outage(w: &mut ForumWorld) {
    w.tracker_stop.take().unwrap().send(true).unwrap();
    w.tracker_task.take().unwrap().await.unwrap().unwrap();
    w.service(0)
        .command(Command::Publish {
            title: "Offline publication".into(),
            body: "Peer bootstrap without HTTP".into(),
            parent: None,
        })
        .unwrap();
    let v = w.wait(0, |v| v.posts.len() == 1).await;
    w.posts = vec![v.posts[0].id.clone()];
}
#[then("configured peers replicate and download without the tracker")]
async fn peer_only(w: &mut ForumWorld) {
    w.wait(1, |v| v.posts.len() == 1).await;
    w.service(1)
        .command(Command::Fetch {
            publication: w.posts[0].clone(),
        })
        .unwrap();
    let v = w.wait(1, |v| v.posts[0].body.is_some()).await;
    assert_eq!(
        v.posts[0].body.as_deref(),
        Some("Peer bootstrap without HTTP")
    );
}
#[when("the tracker returns")]
async fn returns(w: &mut ForumWorld) {
    w.tracker().await;
}
#[then("pending publications reach its durable snapshot")]
async fn durable(w: &mut ForumWorld) {
    w.wait(0, |v| v.tracker_online).await;
    let c = &w.configs[0];
    let client = RendezvousClient::new(
        c.tracker.as_ref().unwrap(),
        entropy_engine::p2p::rendezvous::parse_hex(&c.room).unwrap(),
        entropy_engine::p2p::rendezvous::parse_hex(&c.maintainer).unwrap(),
    )
    .unwrap();
    let index: RoomIndex = client.get_index().await.unwrap();
    assert_eq!(index.publications().count(), 1);
}
#[then("a second service cannot share the author's profile")]
async fn isolation(w: &mut ForumWorld) {
    let service = P2pService::start(w.root.join("0"), w.configs[0].clone()).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while service.snapshot().error.is_none() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        service
            .snapshot()
            .error
            .unwrap()
            .contains("profile already in use")
    );
    service.join();
}
#[tokio::main]
async fn main() {
    ForumWorld::cucumber()
        .max_concurrent_scenarios(1)
        .fail_on_skipped()
        .run_and_exit("tests/features/p2p_service.feature")
        .await;
}

#[when("a reader joins with an empty bootstrap list")]
async fn tracker_only(w: &mut ForumWorld) {
    w.configs[4].peers.clear();
    w.start(4);
    w.wait(4, |v| v.posts.len() == 2).await;
    for p in &w.posts {
        w.service(4)
            .command(Command::Fetch {
                publication: p.clone(),
            })
            .unwrap();
    }
}
#[then("it discovers sources and downloads both verified bodies")]
async fn discovered(w: &mut ForumWorld) {
    let v = w
        .wait(4, |v| {
            v.posts.len() == 2 && v.posts.iter().all(|p| p.body.is_some())
        })
        .await;
    assert!(
        v.posts
            .iter()
            .any(|p| p.body.as_deref() == Some("Body from Member A"))
    );
    assert!(
        v.posts
            .iter()
            .any(|p| p.body.as_deref() == Some("Body from Member B"))
    );
}
#[when("the maintainer closes the room and C restarts")]
async fn close(w: &mut ForumWorld) {
    w.start(3);
    w.wait(3, |v| v.posts.len() == 2).await;
    w.service(3)
        .command(Command::Policy { open: false })
        .unwrap();
    w.wait(2, |v| !v.member_publishing && v.posts.is_empty())
        .await;
    w.services[2].take().unwrap().join();
    w.start(2);
}
#[then("member publications are hidden")]
async fn closed(w: &mut ForumWorld) {
    w.wait(2, |v| {
        v.running && !v.member_publishing && v.posts.is_empty()
    })
    .await;
}
#[when("the maintainer reopens the room")]
async fn reopen(w: &mut ForumWorld) {
    w.service(3)
        .command(Command::Policy { open: true })
        .unwrap();
}
#[then("C's verified cached posts are visible and seeded again")]
async fn cached(w: &mut ForumWorld) {
    w.wait(2, |v| {
        v.member_publishing
            && v.posts.len() == 2
            && v.posts
                .iter()
                .all(|p| p.body.is_some() && p.availability == "Seeding")
    })
    .await;
}
#[when("member A withdraws its publication")]
async fn withdraw(w: &mut ForumWorld) {
    w.start(0);
    w.wait(0, |v| v.posts.len() == 2).await;
    w.service(0)
        .command(Command::Withdraw {
            publication: w.posts[0].clone(),
        })
        .unwrap();
    // Reuse the no-resurrection assertion with a fresh observer too.
    w.start(4);
}

#[when("an offline author publishes metadata without a seeder")]
async fn unavailable(w: &mut ForumWorld) {
    use entropy_engine::p2p::{
        index::{Action, CatalogItem, PublicationKind},
        meta::InfoDocument,
        rendezvous::parse_hex,
    };
    let c = &w.configs[0];
    let room = parse_hex(&c.room).unwrap();
    let maintainer = parse_hex(&c.maintainer).unwrap();
    let key = SigningKey::from_pkcs8(&SigningKey::generate_pkcs8().unwrap()).unwrap();
    let info = InfoDocument::for_bytes(
        "post.txt",
        Some("text/plain; charset=utf-8".into()),
        b"Nobody is seeding this",
        16384,
        1,
    );
    let mut batch = RoomIndex::new(room, maintainer);
    batch
        .merge([key
            .sign(
                room,
                1,
                Action::Publish(CatalogItem {
                    content: info.content_id(),
                    title: "Unavailable post".into(),
                    description: String::new(),
                    media: None,
                    kind: PublicationKind::Post,
                    parent: None,
                }),
            )
            .unwrap()])
        .unwrap();
    RendezvousClient::new(c.tracker.as_ref().unwrap(), room, maintainer)
        .unwrap()
        .put_records(&batch)
        .await
        .unwrap();
}
#[then("C lists the post as having no seeders and no cached body")]
async fn no_seeders(w: &mut ForumWorld) {
    let v = w.wait(2, |v| v.posts.len() == 1).await;
    assert_eq!(v.posts[0].title, "Unavailable post");
    assert_eq!(v.posts[0].availability, "No seeders");
    assert!(v.posts[0].body.is_none());
}

#[when("the maintainer bans A and A tries to publish again")]
async fn banned_publish(w: &mut ForumWorld) {
    w.start(3);
    w.wait(3, |v| v.posts.len() == 2).await;
    w.service(3)
        .command(Command::Ban {
            author: w.service(0).snapshot().author,
        })
        .unwrap();
    w.wait(0, |v| !v.posts.iter().any(|p| p.id == w.posts[0]))
        .await;
    w.service(0)
        .command(Command::Publish {
            title: "Banned publication".into(),
            body: "Do not acknowledge this as published".into(),
            parent: None,
        })
        .unwrap();
}
#[then("A receives a publication error and no new post appears")]
async fn publication_error(w: &mut ForumWorld) {
    let v = w.wait(0, |v| v.command_error.is_some()).await;
    assert!(
        v.command_error
            .unwrap()
            .contains("blocked by room moderation")
    );
    assert!(!v.posts.iter().any(|p| p.title == "Banned publication"));
}
