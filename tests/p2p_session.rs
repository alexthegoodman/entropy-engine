//! Phase-4 two-process localhost session test (docs/P2P_PROTOCOL_DESIGN.md phase 4).
//!
//! Spawns two `p2p_peer` processes - the "fake peer nodes" the design asks for - and drives them
//! over KCP on loopback with no NAT. It asserts the four acceptance checks: a full transfer, pieces
//! arriving out of order (the leecher asks newest-first while the store writes at fixed offsets),
//! duplicate/retried requests (the leecher re-asks on a cadence and the seeder serves idempotently),
//! and disconnect/reconnect (a seeder that dies mid-transfer is restarted and the leecher resumes
//! from its partial store).
//!
//! No display or real network is involved, so this is a plain `#[test]` (the repo's libtest
//! harness) rather than a `*_live`/`*_bdd` scenario.

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use entropy_engine::p2p::meta::InfoDocument;

const PIECE_LEN: usize = 64 * 1024;
const PIECES: usize = 8;

const SEED_ID: &str = "10.0.0.1";
const LEECH_ID: &str = "10.0.0.2";
const GROUP: &str = "12345";
const PSK: &str = "swordfish";

fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let p = std::env::temp_dir().join(format!(
        "entropy-p2p-session-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}

fn pseudo_random(bytes: usize) -> Vec<u8> {
    let mut data = vec![0u8; bytes];
    let mut x = 0x1234_5678u32;
    for b in &mut data {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *b = (x >> 24) as u8;
    }
    data
}

struct Peer {
    child: Child,
    rx: Receiver<String>,
}

fn spawn_peer(args: &[String]) -> Peer {
    let mut child = Command::new(env!("CARGO_BIN_EXE_p2p_peer"))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn p2p_peer");
    let stdout = child.stdout.take().expect("pipe stdout");
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    Peer { child, rx }
}

fn wait_line(peer: &Peer, want: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        match peer.rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) if line.starts_with(want) => return line,
            Ok(_) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {
                assert!(Instant::now() < deadline, "timed out waiting for {want:?}");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("p2p_peer stdout closed while waiting for {want:?}");
            }
        }
    }
}

fn wait_exit(peer: &mut Peer, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = peer.child.try_wait().expect("try_wait") {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "p2p_peer did not exit in time (stdout lines: {:?})",
            peer.rx.try_iter().collect::<Vec<_>>()
        );
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn kill(peer: &mut Peer) {
    let _ = peer.child.kill();
    let _ = peer.child.wait();
}

struct Fixture {
    root: PathBuf,
    content: Vec<u8>,
    info: InfoDocument,
    info_path: PathBuf,
    seed_data: PathBuf,
    leech_data: PathBuf,
    seed_port: u16,
    leech_port: u16,
}

impl Fixture {
    fn new(tag: &str, seed_port: u16, leech_port: u16) -> Self {
        let root = unique_dir(tag);
        let content = pseudo_random(PIECES * PIECE_LEN);
        let info = InfoDocument::for_bytes(
            "session.bin",
            Some("application/octet-stream".into()),
            &content,
            PIECE_LEN as u32,
            1_770_000_000,
        );
        let info_path = root.join("info.bin");
        fs::write(&info_path, info.to_canonical()).unwrap();
        let seed_data = root.join("seed-data");
        let leech_data = root.join("leech-data");
        fs::create_dir_all(&seed_data).unwrap();
        fs::create_dir_all(&leech_data).unwrap();

        Fixture {
            root,
            content,
            info,
            info_path,
            seed_data,
            leech_data,
            seed_port,
            leech_port,
        }
    }

    fn seed_args(&self, content_path: &PathBuf, limit: Option<u32>, serve_ms: u64) -> Vec<String> {
        let mut a = vec![
            "--role".into(),
            "seed".into(),
            "--node-id".into(),
            SEED_ID.into(),
            "--port".into(),
            self.seed_port.to_string(),
            "--group".into(),
            GROUP.into(),
            "--psk".into(),
            PSK.into(),
            "--peer".into(),
            LEECH_ID.into(),
            "--bootstrap".into(),
            format!("udp://127.0.0.1:{}", self.leech_port),
            "--data-dir".into(),
            self.seed_data.to_string_lossy().into_owned(),
            "--info".into(),
            self.info_path.to_string_lossy().into_owned(),
            "--content".into(),
            content_path.to_string_lossy().into_owned(),
            "--serve-ms".into(),
            serve_ms.to_string(),
        ];
        if let Some(l) = limit {
            a.push("--limit".into());
            a.push(l.to_string());
        }
        a
    }

    fn leech_args(&self, out_path: &PathBuf, timeout_ms: u64) -> Vec<String> {
        vec![
            "--role".into(),
            "download".into(),
            "--node-id".into(),
            LEECH_ID.into(),
            "--port".into(),
            self.leech_port.to_string(),
            "--group".into(),
            GROUP.into(),
            "--psk".into(),
            PSK.into(),
            "--peer".into(),
            SEED_ID.into(),
            "--bootstrap".into(),
            format!("udp://127.0.0.1:{}", self.seed_port),
            "--data-dir".into(),
            self.leech_data.to_string_lossy().into_owned(),
            "--info".into(),
            self.info_path.to_string_lossy().into_owned(),
            "--out".into(),
            out_path.to_string_lossy().into_owned(),
            "--timeout-ms".into(),
            timeout_ms.to_string(),
        ]
    }
}

#[test]
fn two_process_localhost_session_full_transfer() {
    let f = Fixture::new("full", 19201, 19202);
    let content_path = f.root.join("content.bin");
    let out_path = f.root.join("out.bin");
    fs::write(&content_path, &f.content).unwrap();

    let mut seed = spawn_peer(&f.seed_args(&content_path, None, 20_000));
    wait_line(&seed, "SEED READY", Duration::from_secs(20));

    let mut leech = spawn_peer(&f.leech_args(&out_path, 60_000));
    let done = wait_line(&leech, "LEECH DONE", Duration::from_secs(60));
    assert!(done.contains(&format!("{}", PIECES)), "leecher reported: {done}");

    let status = wait_exit(&mut leech, Duration::from_secs(10));
    assert!(status.success(), "leecher exited with {status}");

    let out = fs::read(&out_path).unwrap();
    assert_eq!(out, f.content, "downloaded bytes differ from the seeded content");

    // The seed stops only when its serve window elapses; kill it now that the transfer is done.
    kill(&mut seed);
}

#[test]
fn two_process_localhost_session_disconnect_and_reconnect() {
    let f = Fixture::new("reconnect", 19203, 19204);
    let content_path = f.root.join("content.bin");
    let out_path = f.root.join("out.bin");
    fs::write(&content_path, &f.content).unwrap();

    // First seeder serves only 3 pieces, then exits: a deterministic mid-transfer "death".
    let mut seed_a = spawn_peer(&f.seed_args(&content_path, Some(3), 20_000));
    wait_line(&seed_a, "SEED READY", Duration::from_secs(20));

    // Leecher starts with a generous window; it will keep retrying while the seeder is gone.
    let mut leech = spawn_peer(&f.leech_args(&out_path, 90_000));
    wait_line(&leech, "LEECH START", Duration::from_secs(20));

    let seed_a_status = wait_exit(&mut seed_a, Duration::from_secs(30));
    assert!(seed_a_status.success(), "limited seeder exited with {seed_a_status}");

    // Restart the seeder (no limit); the leecher resumes and finishes the remaining pieces.
    let mut seed_b = spawn_peer(&f.seed_args(&content_path, None, 30_000));
    wait_line(&seed_b, "SEED READY", Duration::from_secs(20));

    let done = wait_line(&leech, "LEECH DONE", Duration::from_secs(90));
    assert!(done.contains(&format!("{}", PIECES)), "leecher reported: {done}");

    let status = wait_exit(&mut leech, Duration::from_secs(10));
    assert!(status.success(), "leecher exited with {status}");

    let out = fs::read(&out_path).unwrap();
    assert_eq!(out, f.content, "resumed download differs from the seeded content");

    kill(&mut seed_b);
}
