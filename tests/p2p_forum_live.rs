//! Two real native windows and compiled addon bundles, driven by the existing BDD driver.
use entropy_engine::p2p::{
    index::SigningKey,
    rendezvous::hex,
    service::{PeerConfig, ServiceConfig},
};
use std::{
    fs,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct Windows(Vec<Child>);
impl Drop for Windows {
    fn drop(&mut self) {
        for child in &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
#[test]
fn two_windows_publish_and_read_with_maintainer_offline() {
    let root = std::env::current_dir()
        .unwrap()
        .join("test-artifacts")
        .join(format!(
            "forum-live-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
    fs::create_dir_all(&root).unwrap();
    let maintainer = SigningKey::from_pkcs8(&SigningKey::generate_pkcs8().unwrap())
        .unwrap()
        .public_key();
    let ports: Vec<_> = (0..2)
        .map(|_| {
            std::net::UdpSocket::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        })
        .collect();
    let mut windows = Windows(Vec::new());
    for i in 0..2 {
        let config = ServiceConfig {
            room: hex(&[33; 32]),
            maintainer: hex(&maintainer),
            node_id: format!("10.33.0.{}", i + 1).parse().unwrap(),
            port: ports[i],
            group_code: "forum-live".into(),
            tracker: None,
            advertise_address: None,
            peers: vec![PeerConfig {
                id: format!("10.33.0.{}", 2 - i).parse().unwrap(),
                address: format!("127.0.0.1:{}", ports[1 - i]).parse().unwrap(),
            }],
        };
        let data = root.join(format!("profile-{i}"));
        fs::create_dir_all(&data).unwrap();
        let role = if i == 0 { "alice" } else { "bob" };
        let other = if i == 0 { "bob" } else { "alice" };
        let log = fs::File::create(root.join(format!("{role}.log"))).unwrap();
        let child = Command::new(env!("CARGO_BIN_EXE_example"))
            .arg("p2p-forum")
            .env("ENTROPY_MCP_PORT", "0")
            .env("ENTROPY_P2P_DATA", data)
            .env("ENTROPY_P2P_BDD_RESULT", root.join(format!("{role}.json")))
            .env(
                "ENTROPY_P2P_BDD_CONFIG",
                serde_json::to_string(&config).unwrap(),
            )
            .env("ENTROPY_P2P_BDD_ROLE", role)
            .env("ENTROPY_P2P_BDD_TITLE", format!("Post from {role}"))
            .env("ENTROPY_P2P_BDD_BODY", format!("Hello from {role}"))
            .env("ENTROPY_P2P_BDD_OTHER_TITLE", format!("Post from {other}"))
            .env("ENTROPY_P2P_BDD_OTHER_BODY", format!("Hello from {other}"))
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap();
        windows.0.push(child);
    }
    let deadline = Instant::now() + Duration::from_secs(120);
    for child in &mut windows.0 {
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "window failed; logs: {}", root.display());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "window deadline; logs: {}",
                root.display()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    for (role, other) in [("alice", "bob"), ("bob", "alice")] {
        let result: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(format!("{role}.json"))).unwrap()).unwrap();
        assert_eq!(result["status"], "passed", "{result:#}");
        let artifacts = result["artifacts"].as_array().unwrap();
        assert_eq!(artifacts.len(), 1);
        let capture = image::open(artifacts[0].as_str().unwrap())
            .unwrap()
            .to_rgba8();
        assert!(capture.width() >= 1000 && capture.height() >= 600);
        assert!(
            capture
                .pixels()
                .map(|p| p.0)
                .collect::<std::collections::HashSet<_>>()
                .len()
                > 100
        );
        let tools = result["tools"].as_array().unwrap();
        let state = &tools.last().unwrap()["result"];
        let posts = state["posts"].as_array().unwrap();
        assert_eq!(posts.len(), 2, "{state:#}");
        assert!(
            posts
                .iter()
                .any(|p| p["body"] == format!("Hello from {other}")),
            "{state:#}"
        );
        assert_eq!(state["isMaintainer"], false);
    }
    println!(
        "Two forum windows exchanged verified posts; screenshots: {}",
        root.display()
    );
}
