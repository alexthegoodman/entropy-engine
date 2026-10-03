//! Phase-4 two-process P2P peer: a single-content seed or leecher over the KCP backend on
//! loopback, driven entirely by CLI arguments (docs/P2P_PROTOCOL_DESIGN.md phase 4).
//!
//! This is the "fake peer node" the design calls for: `tests/p2p_session.rs` spawns two of these
//! and asserts full transfer, out-of-order pieces, duplicate/retried requests, and
//! disconnect/reconnect, without a display or a real network. It is also runnable by hand for a
//! manual smoke test.
//!
//! Seed flow: read the canonical info document, split `--content` into pieces into the local piece
//! store, promote it, then serve `Want` datagrams until `--serve-ms` elapses or `--limit` pieces
//! have been dispatched (the latter is how the reconnect test makes a seed "die" mid-transfer).
//! Leecher flow: download from `--peer` into `--data-dir`, resume whatever is already present, then
//! copy the assembled file to `--out`.

use std::io::Write as _;
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::time::Duration;

use entropy_engine::p2p::meta::InfoDocument;
use entropy_engine::p2p::pieces::PieceStore;
use entropy_engine::p2p::session::Session;
use entropy_engine::p2p::transport::PeerId;

const DEFAULT_SERVE_MS: u64 = 30_000;
const DEFAULT_TIMEOUT_MS: u64 = 60_000;

struct Args {
    role: String,
    node_id: Ipv4Addr,
    port: u16,
    group: String,
    psk: String,
    peer: Ipv4Addr,
    bootstrap: String,
    data_dir: PathBuf,
    info: PathBuf,
    content: Option<PathBuf>,
    out: Option<PathBuf>,
    limit: Option<u32>,
    serve_ms: u64,
    timeout_ms: u64,
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

fn parse_args() -> Result<Args, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let get = |name: &str| -> Result<String, String> {
        arg(&args, name).ok_or_else(|| format!("missing required argument {name}"))
    };

    let role = get("--role")?;
    let node_id: Ipv4Addr = get("--node-id")?
        .parse()
        .map_err(|_| "invalid --node-id")?;
    let port: u16 = get("--port")?.parse().map_err(|_| "invalid --port")?;
    let group = get("--group")?;
    let psk = get("--psk")?;
    let peer: Ipv4Addr = get("--peer")?.parse().map_err(|_| "invalid --peer")?;
    let bootstrap = get("--bootstrap")?;
    let data_dir: PathBuf = get("--data-dir")?.into();
    let info: PathBuf = get("--info")?.into();
    let content = arg(&args, "--content").map(PathBuf::from);
    let out = arg(&args, "--out").map(PathBuf::from);
    let limit = arg(&args, "--limit").map(|v| v.parse().unwrap_or(0));
    let serve_ms = arg(&args, "--serve-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_SERVE_MS);
    let timeout_ms = arg(&args, "--timeout-ms")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_TIMEOUT_MS);

    Ok(Args {
        role,
        node_id,
        port,
        group,
        psk,
        peer,
        bootstrap,
        data_dir,
        info,
        content,
        out,
        limit,
        serve_ms,
        timeout_ms,
    })
}

fn read_info(path: &std::path::Path) -> Result<InfoDocument, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read info document: {e}"))?;
    InfoDocument::from_canonical(&bytes).map_err(|e| format!("parse info document: {e}"))
}

fn kcp_config(args: &Args) -> entropy_engine::p2p::transport::rustp2p::KcpConfig {
    entropy_engine::p2p::transport::rustp2p::KcpConfig {
        node_id: args.node_id,
        udp_port: args.port,
        tcp_port: args.port,
        group_code: args.group.clone(),
        psk_password: args.psk.clone(),
        bootstrap: vec![args.bootstrap.clone()],
        allow_src: vec![u32::from_be_bytes(args.peer.octets())],
    }
}

async fn run_seed(args: &Args) -> Result<(), String> {
    let info = read_info(&args.info)?;
    let content_path = args
        .content
        .as_ref()
        .ok_or_else(|| "seed role requires --content".to_string())?;
    let content = std::fs::read(content_path).map_err(|e| format!("read content: {e}"))?;
    if content.len() as u64 != info.length {
        return Err(format!(
            "content is {} bytes but info document declares {}",
            content.len(),
            info.length
        ));
    }

    {
        let mut store = PieceStore::open(&args.data_dir, &info).map_err(|e| e.to_string())?;
        for (i, chunk) in content.chunks(info.piece_length as usize).enumerate() {
            store
                .write_piece(i as u32, chunk)
                .map_err(|e| format!("write piece {i}: {e}"))?;
        }
        store.promote().map_err(|e| e.to_string())?;
    }

    println!("SEED READY {} {}", info.content_id_hex(), info.piece_count());
    std::io::stdout().flush().ok();

    let transport =
        entropy_engine::p2p::transport::rustp2p::KcpTransport::start(kcp_config(args))
            .await
            .map_err(|e| e.to_string())?;
    let session = Session::new(Box::new(transport));
    let served = session
        .serve(&args.data_dir, &info, Duration::from_millis(args.serve_ms), args.limit)
        .await
        .map_err(|e| e.to_string())?;

    println!("SEED DONE {served}");
    std::io::stdout().flush().ok();
    Ok(())
}

async fn run_download(args: &Args) -> Result<(), String> {
    let info = read_info(&args.info)?;
    let out = args
        .out
        .as_ref()
        .ok_or_else(|| "download role requires --out".to_string())?;

    let transport =
        entropy_engine::p2p::transport::rustp2p::KcpTransport::start(kcp_config(args))
            .await
            .map_err(|e| e.to_string())?;
    let session = Session::new(Box::new(transport));
    let peer = PeerId::new(args.peer.to_string());

    println!("LEECH START {} {}", info.content_id_hex(), info.piece_count());
    std::io::stdout().flush().ok();

    let stats = session
        .download(
            &args.data_dir,
            &info,
            &peer,
            Duration::from_millis(args.timeout_ms),
        )
        .await
        .map_err(|e| e.to_string())?;

    let data_path = args
        .data_dir
        .join("p2p")
        .join(info.content_id_hex())
        .join("data");
    std::fs::copy(&data_path, out).map_err(|e| format!("copy assembled file: {e}"))?;

    println!("LEECH DONE {} (retries {})", stats.pieces_received, stats.retries);
    std::io::stdout().flush().ok();
    Ok(())
}

#[tokio::main]
async fn main() {
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("error"))
        .try_init();

    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("usage: p2p_peer --role seed|download --node-id <ip> --port <n> --group <code> --psk <pw> --peer <ip> --bootstrap <udp://ip:port> --data-dir <dir> --info <file> [--content <file> | --out <file>] [--limit <n>] [--serve-ms <ms>] [--timeout-ms <ms>]");
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };

    let result = match args.role.as_str() {
        "seed" => run_seed(&args).await,
        "download" => run_download(&args).await,
        other => Err(format!("unknown role {other:?} (expected seed|download)")),
    };

    if let Err(e) = result {
        eprintln!("ERROR: {e}");
        std::process::exit(1);
    }
}
