//! Create an isolated local demo room. No running peers or hosted services are required.
use anyhow::{Result, ensure};
use entropy_engine::p2p::{
    index::{RoomIndex, SigningKey},
    rendezvous::hex,
    service::{PeerConfig, ServiceConfig},
};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
fn main() -> Result<()> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .unwrap_or_else(|| "test-artifacts/forum-demo".into()),
    );
    ensure!(
        !root.exists(),
        "destination already exists; choose a new folder"
    );
    let key = SigningKey::generate_pkcs8()?;
    let maintainer = SigningKey::from_pkcs8(&key)?.public_key();
    let room: [u8; 32] = Sha256::digest(SigningKey::generate_pkcs8()?).into();
    let names = ["alice", "bob", "reader", "maintainer"];
    let peers: Vec<_> = (0..4)
        .map(|i| PeerConfig {
            id: format!("10.9.0.{}", i + 1).parse().unwrap(),
            address: format!("127.0.0.1:{}", 47201 + i).parse().unwrap(),
        })
        .collect();
    for (i, name) in names.iter().enumerate() {
        let profile = root.join(name);
        fs::create_dir_all(profile.join("p2p-room"))?;
        let config = ServiceConfig {
            room: hex(&room),
            maintainer: hex(&maintainer),
            node_id: peers[i].id,
            port: peers[i].address.port(),
            group_code: "entropy-forum".into(),
            tracker: Some("http://127.0.0.1:47110".into()),
            advertise_address: None,
            peers: peers
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, p)| p.clone())
                .collect(),
        };
        fs::write(
            profile.join("p2p-forum.json"),
            serde_json::to_vec_pretty(&config)?,
        )?;
        if *name == "maintainer" {
            let path = profile.join("p2p-room/author.pk8");
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            use std::io::Write;
            let mut file = options.open(path)?;
            file.write_all(&key)?;
            file.sync_all()?;
        }
    }
    fs::write(
        root.join("tracker.msgpack"),
        RoomIndex::new(room, maintainer).to_bytes(),
    )?;
    println!("Created local profiles in {}", root.display());
    println!(
        "cargo run --bin tracker -- --room-id {} --maintainer-key {} --index {}/tracker.msgpack",
        hex(&room),
        hex(&maintainer),
        root.to_string_lossy().replace('\\', "/")
    );
    println!(
        "In separate PowerShell terminals, set $env:ENTROPY_P2P_DATA to {}/alice or {}/bob, then run cargo run --bin example -- p2p-forum and click Join room.",
        root.display(),
        root.display()
    );
    Ok(())
}
