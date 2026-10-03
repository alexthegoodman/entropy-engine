//! Local metadata tracker. No transport or payload service.
use entropy_engine::p2p::{rendezvous::parse_hex, tracker::Tracker};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|s| s == "--help") {
        println!(
            "tracker --room-id HEX --maintainer-key HEX --index PATH [--bind 127.0.0.1:47110]\nOne process per snapshot path. Public metadata only; 90s announcement leases.\nHTTP source IP must match signed peer hint. Forwarded headers are not trusted."
        );
        return Ok(());
    }
    anyhow::ensure!(
        args.len() % 2 == 0,
        "expected flag/value pairs (see --help)"
    );
    let mut values = std::collections::BTreeMap::new();
    for pair in args.chunks_exact(2) {
        anyhow::ensure!(
            ["--room-id", "--maintainer-key", "--index", "--bind"].contains(&pair[0].as_str()),
            "unknown option {}",
            pair[0]
        );
        anyhow::ensure!(
            values.insert(pair[0].as_str(), pair[1].as_str()).is_none(),
            "duplicate option {}",
            pair[0]
        );
    }
    let required = |flag| {
        values
            .get(flag)
            .copied()
            .ok_or_else(|| anyhow::anyhow!("missing {flag} (see --help)"))
    };
    let tracker = Tracker::open(
        std::path::PathBuf::from(required("--index")?),
        parse_hex(required("--room-id")?)?,
        parse_hex(required("--maintainer-key")?)?,
    )?;
    let listener =
        tokio::net::TcpListener::bind(values.get("--bind").copied().unwrap_or("127.0.0.1:47110"))
            .await?;
    println!("TRACKER_READY {}", listener.local_addr()?);
    std::io::Write::flush(&mut std::io::stdout())?;
    let (stop, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        let _ = stop.send(true);
    });
    tracker.serve(listener, rx).await
}
