//! One-shot fake forum scenario for the `p2p-forum` example.
//!
//! Launching `cargo run --bin example -- p2p-forum` against the default data dir seeds a small,
//! self-contained room so the window opens already joined with a handful of posts.
//! No tracker, second window or `p2p_room_setup` step is required.
//! The posts are signed by throwaway author keys with no corresponding private keys kept anywhere.
//! Seeded post bodies are written straight into the local piece store, so they display as already seeded.
//! Configured peers are empty to prevent transmitting UDP datagrams to closed loopback sockets.
//!
//! `seed_forum` is idempotent: if `<data_dir>/p2p-forum.json` already exists it does nothing, so a
//! real profile (or a demo the user has already added posts to) is never clobbered. See
//! docs/P2P_FORUM.md for the plan to transition away from this fake scenario.

use super::{
    index::{Action, CatalogItem, PublicationKind, RoomIndex, SigningKey},
    meta::InfoDocument,
    pieces::PieceStore,
    rendezvous::{hex, unix_seconds},
    service::{PeerConfig, ServiceConfig, MAX_POST_BYTES},
};
use anyhow::Result;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

struct DemoPost {
    author: &'static str,
    sequence: u64,
    title: &'static str,
    body: &'static str,
    /// Index into the post list this entry replies to, if any.
    parent: Option<usize>,
}

fn demo_posts() -> Vec<DemoPost> {
    vec![
        DemoPost {
            author: "alice",
            sequence: 1,
            title: "Welcome to the Entropy forum demo",
            body: "This room is seeded with fake data so you can poke around without setting up a tracker or a second window. The peer nodes listed as members are loopback sockets that are not actually running; every post you see was signed and stored locally when the demo folder was first created.",
            parent: None,
        },
        DemoPost {
            author: "bob",
            sequence: 1,
            title: "A first signed note",
            body: "Publishing here signs an entry into the shared room index and stores the body in the local piece store. Try writing your own post below and watching it appear as a seeded publication.",
            parent: None,
        },
        DemoPost {
            author: "carol",
            sequence: 1,
            title: "What are you all building?",
            body: "Nothing real is being transferred in this demo, but the same verified metadata and content paths are used. Fetching a body you do not already have would normally ask the tracker and configured peers.",
            parent: None,
        },
        DemoPost {
            author: "bob",
            sequence: 2,
            title: "Re: Welcome to the Entropy forum demo",
            body: "Replies reference a signed parent publication, so they stay attached to the post they answer even if the two arrive in a different order.",
            parent: Some(0),
        },
        DemoPost {
            author: "alice",
            sequence: 2,
            title: "Re: What are you all building?",
            body: "Withdraw your own posts, or leave and rejoin later to see your profile persist across restarts. The maintainer controls in this room are unused while the demo is self-contained.",
            parent: Some(2),
        },
    ]
}

/// Deterministic throwaway author identities. The private key exists only for signing during seed.
fn demo_author(name: &str) -> Result<SigningKey> {
    let seed: [u8; 32] = Sha256::digest(format!("entropy-p2p-demo-author-{name}").as_bytes()).into();
    Ok(SigningKey::from_seed(&seed)?)
}

fn persist_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("pending");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(tmp, path)?;
    Ok(())
}

fn write_post(profile: &Path, info: &InfoDocument, body: &[u8]) -> Result<()> {
    persist_file(
        &profile.join(format!("{}.info", hex(&info.content_id()))),
        &info.to_canonical(),
    )?;
    let mut store = PieceStore::open(profile, info)?;
    store.write_piece(0, body)?;
    store.promote()?;
    Ok(())
}

/// Seeds the fake forum under `data_dir` if it has not been seeded yet. Returns `true` when a
/// fresh scenario was written and `false` when an existing one was left untouched.
pub fn seed_forum(data_dir: &Path) -> Result<bool> {
    let config_path = data_dir.join("p2p-forum.json");
    if config_path.exists() {
        return Ok(false);
    }
    fs::create_dir_all(data_dir)?;
    let profile = data_dir.join("p2p-room");
    fs::create_dir_all(&profile)?;

    let room: [u8; 32] = Sha256::digest(SigningKey::generate_pkcs8()?).into();
    let maintainer = SigningKey::from_pkcs8(&SigningKey::generate_pkcs8()?)?.public_key();

    let mut index = RoomIndex::new(room, maintainer);
    let mut publication_ids: Vec<[u8; 32]> = Vec::new();
    for post in demo_posts() {
        let author = demo_author(post.author)?;
        let parent = post.parent.map(|i| publication_ids[i]);
        let info = InfoDocument::for_bytes(
            "post.txt",
            Some("text/plain; charset=utf-8".into()),
            post.body.as_bytes(),
            MAX_POST_BYTES as u32,
            unix_seconds() as i64,
        );
        let content = info.content_id();
        let entry = author.sign(
            room,
            post.sequence,
            Action::Publish(CatalogItem {
                content,
                title: post.title.to_string(),
                description: String::new(),
                media: None,
                kind: PublicationKind::Post,
                parent,
            }),
        )?;
        publication_ids.push(entry.entry.id());
        index.merge([entry])?;
        write_post(&profile, &info, post.body.as_bytes())?;
    }
    persist_file(&profile.join("room.msgpack"), &index.to_bytes())?;

    // The demo room is self-contained: all demo posts are pre-seeded in the local piece store.
    // We configure an empty peer list to avoid transmitting UDP datagrams to closed loopback ports,
    // which triggers Winsock ICMP Port Unreachable (WSAECONNRESET) loops on Windows.
    let config = ServiceConfig {
        room: hex(&room),
        maintainer: hex(&maintainer),
        node_id: "10.9.0.1".parse().unwrap(),
        port: 47201,
        group_code: "entropy-forum".into(),
        tracker: None,
        advertise_address: None,
        peers: Vec::new(),
    };
    persist_file(&config_path, &serde_json::to_vec_pretty(&config)?)?;
    Ok(true)
}
