//! Bounded public metadata tracker. One process owns one pinned room and snapshot path.
use super::{
    index::{MAX_INDEX_BYTES, PublicKey, RoomId, RoomIndex},
    rendezvous::{Announcement, MAX_ANNOUNCE_BYTES, MAX_HINTS, hex, parse_hex, unix_seconds},
    wire::ContentId,
};
use anyhow::{Context, Result};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
};
const MAX_HEADERS: usize = 8192;
const MAX_CONNECTIONS: usize = 32;
const MAX_ANNOUNCEMENTS: usize = 4096;
const MAX_PER_IP: usize = 128;
const MAX_RATE_IPS: usize = 4096;
const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
const RATE_WINDOW: Duration = Duration::from_secs(60);
const RATE_REQUESTS: u32 = 120;
struct LiveHint {
    claim: Announcement,
    deadline: Instant,
}
struct State {
    index: RoomIndex,
    path: PathBuf,
    hints: BTreeMap<(ContentId, PublicKey), LiveHint>,
}
#[derive(Clone)]
pub struct Tracker {
    state: Arc<Mutex<State>>,
}
fn persist(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp_name = path.as_os_str().to_os_string();
    temp_name.push(".pending");
    let tmp = PathBuf::from(temp_name);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    #[cfg(unix)]
    std::fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(())
}
impl Tracker {
    /// Pins/path are operator configuration. Invalid stored metadata fails startup.
    pub fn open(path: impl Into<PathBuf>, room: RoomId, maintainer: PublicKey) -> Result<Self> {
        let path = path.into();
        let index = match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(MAX_INDEX_BYTES as u64 + 1)
                    .read_to_end(&mut bytes)?;
                RoomIndex::from_bytes(room, maintainer, &bytes)?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                    std::fs::create_dir_all(parent)?;
                }
                let index = RoomIndex::new(room, maintainer);
                persist(&path, &index.to_bytes())?;
                index
            }
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            state: Arc::new(Mutex::new(State {
                index,
                path,
                hints: BTreeMap::new(),
            })),
        })
    }
    fn expire(state: &mut State) {
        let now = Instant::now();
        state
            .hints
            .retain(|_, h| h.deadline > now && state.index.contains(&h.claim.content));
    }
    fn handle(&self, request: Request, source: IpAddr) -> Reply {
        let mut state = self.state.lock().unwrap();
        Self::expire(&mut state);
        let parts: Vec<_> = request.path.split('/').collect();
        if parts.len() < 5
            || parts[0] != ""
            || parts[1] != "v1"
            || parts[2] != "rooms"
            || parts[3] != hex(&state.index.room())
        {
            return Reply::error(404, "unknown room or endpoint");
        }
        match (request.method.as_str(), parts[4], parts.len()) {
            ("GET", "index", 5) if request.body.is_empty() => {
                Reply::ok("application/msgpack", state.index.to_bytes())
            }
            ("PUT", "records", 5) => {
                if request.content_type.as_deref() != Some("application/msgpack") {
                    return Reply::error(415, "expected application/msgpack");
                }
                let mut next = state.index.clone();
                if let Err(e) = next.merge_bytes(&request.body) {
                    return Reply::error(400, &e.to_string());
                }
                let bytes = next.to_bytes();
                if bytes != state.index.to_bytes() {
                    if persist(&state.path, &bytes).is_err() {
                        return Reply::error(500, "index persistence failed");
                    }
                    state.index = next;
                    Self::expire(&mut state);
                }
                Reply::ok("application/json", b"{}".to_vec())
            }
            ("PUT", "announce", 5) => {
                if request.content_type.as_deref() != Some("application/json") {
                    return Reply::error(415, "expected application/json");
                }
                if request.body.len() > MAX_ANNOUNCE_BYTES {
                    return Reply::error(413, "announcement too large");
                }
                let claim: Announcement = match serde_json::from_slice(&request.body) {
                    Ok(c) => c,
                    Err(_) => return Reply::error(400, "invalid announcement"),
                };
                if claim.room != state.index.room() || claim.address.ip() != source {
                    return Reply::error(400, "wrong room or source IP");
                }
                let remaining = match claim.verify(unix_seconds()) {
                    Ok(ttl) => ttl,
                    Err(e) => return Reply::error(400, &e.to_string()),
                };
                if !state.index.contains(&claim.content) {
                    return Reply::error(403, "content is not eligible");
                }
                let key = (claim.content, claim.key);
                if let Some(old) = state.hints.get(&key) {
                    // Replays cannot extend a lease or move an endpoint.
                    if claim.issued_at <= old.claim.issued_at {
                        return Reply::ok("application/json", b"{}".to_vec());
                    }
                } else if state.hints.len() >= MAX_ANNOUNCEMENTS
                    || state
                        .hints
                        .values()
                        .filter(|h| h.claim.content == claim.content)
                        .count()
                        >= MAX_HINTS
                    || state
                        .hints
                        .values()
                        .filter(|h| h.claim.address.ip() == source)
                        .count()
                        >= MAX_PER_IP
                {
                    return Reply::error(429, "announcement table limit");
                }
                if state
                    .hints
                    .get(&key)
                    .is_some_and(|h| h.claim.address.ip() != source)
                    && state
                        .hints
                        .values()
                        .filter(|h| h.claim.address.ip() == source)
                        .count()
                        >= MAX_PER_IP
                {
                    return Reply::error(429, "source IP announcement limit");
                }
                state.hints.insert(
                    key,
                    LiveHint {
                        claim,
                        deadline: Instant::now() + Duration::from_secs(remaining),
                    },
                );
                Reply::ok("application/json", b"{}".to_vec())
            }
            ("GET", "peers", 6) if request.body.is_empty() => {
                let content = match parse_hex(parts[5]) {
                    Ok(c) => c,
                    Err(_) => return Reply::error(400, "invalid content id"),
                };
                let peers: Vec<_> = state
                    .hints
                    .values()
                    .filter(|h| h.claim.content == content)
                    .map(|h| &h.claim)
                    .collect();
                Reply::ok("application/json", serde_json::to_vec(&peers).unwrap())
            }
            _ => Reply::error(404, "unknown method or endpoint"),
        }
    }
    /// Own connection tasks; shutdown drains requests and releases the listening socket.
    pub async fn serve(
        self,
        listener: TcpListener,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<()> {
        let mut tasks = JoinSet::new();
        let mut rates = BTreeMap::<IpAddr, (Instant, u32)>::new();
        let mut sweep = tokio::time::interval(Duration::from_secs(1));
        loop {
            if *shutdown.borrow() {
                break;
            }
            tokio::select! {
                changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                _ = sweep.tick() => { rates.retain(|_, (start, _)| start.elapsed() < RATE_WINDOW); if let Ok(mut state) = self.state.try_lock() { Self::expire(&mut state); } }
                _ = tasks.join_next(), if !tasks.is_empty() => {}
                accepted = listener.accept(), if tasks.len() < MAX_CONNECTIONS => {
                    let (stream, source) = accepted?;
                    rates.retain(|_, (start, _)| start.elapsed() < RATE_WINDOW);
                    let allowed = if !rates.contains_key(&source.ip()) && rates.len() >= MAX_RATE_IPS { false } else {
                        let rate = rates.entry(source.ip()).or_insert((Instant::now(), 0));
                        rate.1 = rate.1.saturating_add(1); rate.1 <= RATE_REQUESTS
                    };
                    let tracker = self.clone();
                    tasks.spawn(async move { let _ = connection(tracker, stream, source, allowed).await; });
                }
            }
        }
        drop(listener);
        while tasks.join_next().await.is_some() {}
        Ok(())
    }
}
struct Request {
    method: String,
    path: String,
    content_type: Option<String>,
    body: Vec<u8>,
}
struct Reply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}
impl Reply {
    fn ok(content_type: &'static str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            content_type,
            body,
        }
    }
    fn error(status: u16, message: &str) -> Self {
        Self {
            status,
            content_type: "text/plain",
            body: message.as_bytes().to_vec(),
        }
    }
}
async fn read_request(
    stream: &mut TcpStream,
    allowed: bool,
) -> std::result::Result<Request, Reply> {
    let mut header = Vec::new();
    let mut byte = [0];
    while !header.ends_with(b"\r\n\r\n") {
        if header.len() >= MAX_HEADERS {
            return Err(Reply::error(431, "headers too large"));
        }
        if stream.read_exact(&mut byte).await.is_err() {
            return Err(Reply::error(400, "incomplete headers"));
        }
        header.push(byte[0]);
    }
    if !allowed {
        return Err(Reply::error(429, "source IP rate limit"));
    }
    let text =
        std::str::from_utf8(&header).map_err(|_| Reply::error(400, "invalid header text"))?;
    let mut lines = text.split("\r\n");
    let first: Vec<_> = lines.next().unwrap_or_default().split(' ').collect();
    if first.len() != 3 || first[2] != "HTTP/1.1" {
        return Err(Reply::error(400, "expected HTTP/1.1"));
    }
    let method = first[0].to_owned();
    let path = first[1].to_owned();
    let limit = if method == "PUT" && path.ends_with("/records") {
        MAX_INDEX_BYTES
    } else if method == "PUT" && path.ends_with("/announce") {
        MAX_ANNOUNCE_BYTES
    } else {
        0
    };
    let mut length = None;
    let mut content_type = None;
    let mut host = false;
    for line in lines.filter(|s| !s.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| Reply::error(400, "invalid header"))?;
        match name.to_ascii_lowercase().as_str() {
            "content-length" => {
                if length.is_some() {
                    return Err(Reply::error(400, "duplicate Content-Length"));
                }
                length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| Reply::error(400, "invalid Content-Length"))?,
                );
            }
            "transfer-encoding" | "expect" => {
                return Err(Reply::error(
                    400,
                    "chunked uploads and Expect are unsupported",
                ));
            }
            "content-type" => {
                if content_type.is_some() {
                    return Err(Reply::error(400, "duplicate Content-Type"));
                }
                content_type = Some(value.trim().to_owned());
            }
            "host" => {
                if host || value.trim().is_empty() {
                    return Err(Reply::error(400, "invalid Host"));
                }
                host = true;
            }
            _ => {}
        }
    }
    if !host {
        return Err(Reply::error(400, "missing Host"));
    }
    if method == "PUT" && length.is_none() {
        return Err(Reply::error(411, "Content-Length required"));
    }
    let length = length.unwrap_or(0);
    if length > limit {
        return Err(Reply::error(413, "body too large or unsupported"));
    }
    let mut body = vec![0; length];
    stream
        .read_exact(&mut body)
        .await
        .map_err(|_| Reply::error(400, "incomplete body"))?;
    Ok(Request {
        method,
        path,
        content_type,
        body,
    })
}
async fn connection(
    tracker: Tracker,
    mut stream: TcpStream,
    source: SocketAddr,
    allowed: bool,
) -> Result<()> {
    let reply =
        match tokio::time::timeout(REQUEST_DEADLINE, read_request(&mut stream, allowed)).await {
            Ok(Ok(request)) => {
                tokio::task::spawn_blocking(move || tracker.handle(request, source.ip()))
                    .await
                    .context("tracker worker")?
            }
            Ok(Err(reply)) => reply,
            Err(_) => return Ok(()),
        };
    let reason = match reply.status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        reply.status,
        reason,
        reply.content_type,
        reply.body.len()
    );
    tokio::time::timeout(REQUEST_DEADLINE, async {
        stream.write_all(header.as_bytes()).await?;
        stream.write_all(&reply.body).await?;
        stream.shutdown().await
    })
    .await??;
    Ok(())
}
