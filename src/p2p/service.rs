//! Long-lived room actor. Disk and network work run on a dedicated worker, never a frame/audio
//! thread. The forum MVP uses one verified piece per UTF-8 post; larger assets use Session.
use super::{
    allow::Allowlist,
    index::{Action, CatalogItem, PublicationKind, RoomIndex, SigningKey},
    meta::InfoDocument,
    pieces::PieceStore,
    rendezvous::{Announcement, RendezvousClient, hex, parse_hex, unix_seconds},
    transport::{
        P2pTransport, PeerId, TransportEvent,
        rustp2p::{KcpConfig, KcpTransport},
    },
    wire::{ContentId, Envelope, Msg},
};
use anyhow::{Context, Result, ensure};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, watch},
    task::JoinSet,
};

pub const MAX_POST_BYTES: usize = 16 * 1024;
const MAX_TASKS: usize = 16;
pub const MIN_POLL_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerConfig {
    pub id: Ipv4Addr,
    pub address: SocketAddr,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceConfig {
    pub room: String,
    pub maintainer: String,
    pub node_id: Ipv4Addr,
    pub port: u16,
    pub group_code: String,
    pub tracker: Option<String>,
    pub advertise_address: Option<SocketAddr>,
    #[serde(default)]
    pub peers: Vec<PeerConfig>,
}
#[derive(Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Publish {
        title: String,
        body: String,
        parent: Option<String>,
    },
    Fetch {
        publication: String,
    },
    Withdraw {
        publication: String,
    },
    Remove {
        publication: String,
    },
    Ban {
        author: String,
    },
    Block {
        content: String,
    },
    Policy {
        open: bool,
    },
    Sync,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostView {
    pub id: String,
    pub content: String,
    pub author: String,
    pub title: String,
    pub parent: Option<String>,
    pub sequence: u64,
    pub body: Option<String>,
    pub availability: String,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub running: bool,
    pub author: String,
    pub is_maintainer: bool,
    pub member_publishing: bool,
    pub tracker_online: bool,
    pub posts: Vec<PostView>,
    pub error: Option<String>,
    pub command_error: Option<String>,
    pub last_publication: Option<String>,
    pub revision: u64,
}
pub struct P2pService {
    commands: mpsc::Sender<Command>,
    stop: watch::Sender<bool>,
    view: watch::Receiver<ServiceView>,
    worker: Option<std::thread::JoinHandle<()>>,
    last_poll: Option<Instant>,
    min_poll_interval: Duration,
}
impl P2pService {
    /// Returns immediately. Startup failures are delivered by poll just like network errors.
    pub fn start(data_dir: PathBuf, config: ServiceConfig) -> Result<Self> {
        parse_hex(&config.room)?;
        parse_hex(&config.maintainer)?;
        ensure!(
            config.port != 0 && config.peers.len() <= 64,
            "invalid port or too many peers"
        );
        ensure!(
            config.group_code.len() <= 16 && !config.group_code.is_empty(),
            "group code must be 1-16 bytes"
        );
        if let Some(url) = &config.tracker {
            RendezvousClient::new(
                url,
                parse_hex(&config.room)?,
                parse_hex(&config.maintainer)?,
            )?;
        }
        let (commands, rx) = mpsc::channel(32);
        let (stop, stopped) = watch::channel(false);
        let (view_tx, view) = watch::channel(ServiceView::default());
        let worker = std::thread::Builder::new()
            .name("p2p-room".into())
            .spawn(move || {
                let result = (|| -> Result<()> {
                    let runtime = tokio::runtime::Builder::new_multi_thread()
                        .worker_threads(2)
                        .enable_all()
                        .build()?;
                    runtime.block_on(run(data_dir, config, rx, stopped, view_tx.clone()))
                })();
                view_tx.send_modify(|v| {
                    v.running = false;
                    if let Err(e) = result {
                        v.error = Some(e.to_string());
                    }
                });
            })?;
        Ok(Self {
            commands,
            stop,
            view,
            worker: Some(worker),
            last_poll: None,
            min_poll_interval: MIN_POLL_INTERVAL,
        })
    }
    pub fn with_min_poll_interval(mut self, interval: Duration) -> Self {
        self.min_poll_interval = interval;
        self
    }
    pub fn command(&self, command: Command) -> Result<()> {
        if let Command::Publish { title, body, .. } = &command {
            ensure!(
                !title.trim().is_empty() && title.len() <= 256,
                "title must be 1-256 bytes"
            );
            ensure!(
                !body.trim().is_empty() && body.len() <= MAX_POST_BYTES,
                "body must be 1-16384 bytes"
            );
        }
        self.commands
            .try_send(command)
            .context("room command queue full or service stopped")
    }
    pub fn snapshot(&self) -> ServiceView {
        self.view.borrow().clone()
    }
    pub fn poll(&mut self) -> Option<ServiceView> {
        let now = Instant::now();
        if let Some(last) = self.last_poll {
            if now.duration_since(last) < self.min_poll_interval {
                return None;
            }
        }
        if self.view.has_changed().unwrap_or(true) {
            self.last_poll = Some(now);
            Some(self.view.borrow_and_update().clone())
        } else {
            None
        }
    }
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
    pub fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(|w| w.is_finished())
    }
    /// Tests/CLI may wait for complete socket release. UI stop uses the non-blocking signal.
    pub fn join(mut self) {
        self.stop();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for P2pService {
    fn drop(&mut self) {
        self.stop();
    }
}

fn persist(path: &Path, bytes: &[u8]) -> Result<()> {
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
    #[cfg(unix)]
    File::open(path.parent().unwrap())?.sync_all()?;
    Ok(())
}
fn private_key(path: &Path) -> Result<SigningKey> {
    if !path.exists() {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(&SigningKey::generate_pkcs8()?)?;
        file.sync_all()?;
    }
    Ok(SigningKey::from_pkcs8(&fs::read(path)?)?)
}
struct Local {
    dir: PathBuf,
    index: RoomIndex,
    key: SigningKey,
    discovery: SigningKey,
    sequence: u64,
    // The OS releases this exclusive lock even after a crash. Two windows need separate profiles.
    _lock: File,
}
impl Local {
    fn open(dir: PathBuf, config: &ServiceConfig) -> Result<Self> {
        fs::create_dir_all(&dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("profile.lock"))?;
        lock.try_lock()
            .context("P2P profile already in use; choose a separate data directory")?;
        let room = parse_hex(&config.room)?;
        let maintainer = parse_hex(&config.maintainer)?;
        let identity = serde_json::to_vec(&(room, maintainer, config.node_id))?;
        let identity_path = dir.join("identity.json");
        if identity_path.exists() {
            ensure!(
                fs::read(&identity_path)? == identity,
                "profile room/maintainer/node pins changed; use a new profile"
            );
        } else {
            persist(&identity_path, &identity)?;
        }
        let path = dir.join("room.msgpack");
        let index = if path.exists() {
            RoomIndex::from_bytes(room, maintainer, &fs::read(path)?)?
        } else {
            RoomIndex::new(room, maintainer)
        };
        let key = private_key(&dir.join("author.pk8"))?;
        let discovery = private_key(&dir.join("discovery.pk8"))?;
        let path = dir.join("sequence");
        let sequence: u64 = if path.exists() {
            fs::read_to_string(path)?.parse()?
        } else {
            0
        };
        let observed = index
            .entries()
            .filter(|r| r.entry.author == key.public_key())
            .map(|r| r.entry.sequence)
            .max()
            .unwrap_or(0);
        ensure!(
            sequence >= observed,
            "author sequence is behind stored index; restore profile together"
        );
        Ok(Self {
            dir,
            index,
            key,
            discovery,
            sequence,
            _lock: lock,
        })
    }
    fn merge(&mut self, bytes: &[u8], allow: &Allowlist) -> Result<()> {
        let mut merged = self.index.clone();
        merged.merge_bytes(bytes)?;
        if merged.to_bytes() == self.index.to_bytes() {
            return Ok(());
        }
        persist(&self.dir.join("room.msgpack"), &merged.to_bytes())?;
        allow.merge_bytes(&merged.to_bytes())?;
        self.index = merged;
        Ok(())
    }
    fn sign(&mut self, action: Action, allow: &Allowlist) -> Result<String> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .context("author sequence exhausted")?;
        // Reserve before signing/sending. Failure/crash can leave a gap, never a reused sequence.
        persist(
            &self.dir.join("sequence"),
            self.sequence.to_string().as_bytes(),
        )?;
        let record = self.key.sign(self.index.room(), self.sequence, action)?;
        let id = hex(&record.entry.id());
        let publication = matches!(record.entry.action, Action::Publish(_));
        let mut next = self.index.clone();
        next.merge([record])?;
        ensure!(
            !publication || next.publications().any(|(p, _)| hex(&p) == id),
            "publication is blocked by room moderation"
        );
        self.merge(&next.to_bytes(), allow)?;
        Ok(id)
    }
}
fn valid_post(info: &InfoDocument) -> bool {
    info.media_type.as_deref() == Some("text/plain; charset=utf-8")
        && info.length > 0
        && info.length <= MAX_POST_BYTES as u64
        && info.piece_length == MAX_POST_BYTES as u32
        && info.piece_count() == 1
        && super::meta::decode_pieces(&info.pieces).is_ok_and(|h| h.len() == 1)
}
struct Download {
    peer: PeerId,
    requested: tokio::time::Instant,
}
enum Work {
    Incoming(PeerId, Msg),
    Sent,
    Sync(Result<(RoomIndex, BTreeMap<ContentId, Vec<Announcement>>)>),
}
fn send(
    tasks: &mut JoinSet<Result<Work>>,
    transport: Arc<dyn P2pTransport>,
    allow: Allowlist,
    peer: PeerId,
    msg: Msg,
    reliable: bool,
) {
    if tasks.len() >= MAX_TASKS || !allow.permits(&msg) || peer == transport.local_id() {
        return;
    }
    tasks.spawn(async move {
        tokio::time::timeout(Duration::from_secs(5), async {
            // Check immediately before send, including futures queued before moderation.
            ensure!(allow.permits(&msg), "content removed");
            let bytes = Bytes::from(Envelope::new(msg).encode());
            if reliable {
                let mut channel = transport.open_channel(&peer).await?;
                channel.send(bytes).await?;
                tokio::time::sleep(Duration::from_secs(1)).await;
            } else {
                transport.send_datagram(&peer, bytes).await?;
            }
            Ok(Work::Sent)
        })
        .await
        .context("send timed out")?
    });
}

async fn run(
    dir: PathBuf,
    config: ServiceConfig,
    mut commands: mpsc::Receiver<Command>,
    mut stop: watch::Receiver<bool>,
    view: watch::Sender<ServiceView>,
) -> Result<()> {
    let mut local = Local::open(dir, &config)?;
    let allow = Allowlist::new(local.index.clone());
    let mut peers = config.peers.clone();
    peers.retain(|p| p.id != config.node_id && !(p.address.ip().is_loopback() && p.address.port() == config.port));
    let backend = Arc::new(
        KcpTransport::start(KcpConfig {
            node_id: config.node_id,
            udp_port: config.port,
            tcp_port: 0,
            group_code: config.group_code.clone(),
            psk_password: String::new(),
            bootstrap: peers
                .iter()
                .map(|p| format!("udp://{}", p.address))
                .collect(),
            allow_src: peers.iter().map(|p| u32::from(p.id)).collect(),
        })
        .await?,
    );
    let transport: Arc<dyn P2pTransport> = backend.clone();
    let client = config
        .tracker
        .as_ref()
        .map(|url| RendezvousClient::new(url, local.index.room(), local.index.maintainer()))
        .transpose()?;
    let mut infos = BTreeMap::<ContentId, InfoDocument>::new();
    let mut bodies = BTreeMap::<ContentId, String>::new();
    // Only eligible, bounded post metadata is loaded. Payload hashes are checked on restart.
    let stored_posts: BTreeMap<_, _> = local
        .index
        .entries()
        .filter_map(|r| {
            if let Action::Publish(item) = &r.entry.action {
                (item.kind == PublicationKind::Post).then_some((item.content, item.clone()))
            } else {
                None
            }
        })
        .collect();
    for item in stored_posts.values() {
        let path = local.dir.join(format!("{}.info", hex(&item.content)));
        if !path.exists() {
            continue;
        }
        let info = InfoDocument::from_canonical(&fs::read(path)?)?;
        ensure!(
            info.content_id() == item.content && valid_post(&info),
            "invalid persisted post metadata"
        );
        let mut store = PieceStore::open(&local.dir, &info)?;
        if store.is_complete() && store.verify_all().is_ok() {
            if let Ok(text) = String::from_utf8(store.read_piece(0)?) {
                bodies.insert(item.content, text);
            }
        }
        infos.insert(item.content, info);
    }
    let mut hints = BTreeMap::<ContentId, Vec<Announcement>>::new();
    let mut wanted = BTreeSet::<ContentId>::new();
    let mut pending = BTreeMap::<ContentId, Download>::new();
    let mut tasks = JoinSet::<Result<Work>>::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut ticks = 0u64;
    let mut sync_active = false;
    let mut dirty = true;
    let mut status = ServiceView {
        running: true,
        author: hex(&local.key.public_key()),
        is_maintainer: local.key.public_key() == local.index.maintainer(),
        ..Default::default()
    };
    loop {
        // Derived catalog is the authority for every serving, download and visible-body decision.

        pending.retain(|id, _| allow.contains(id));
        wanted.retain(|id| allow.contains(id));
        status.posts = local
            .index
            .publications()
            .filter_map(|(id, r)| {
                let Action::Publish(item) = &r.entry.action else {
                    return None;
                };
                if item.kind != PublicationKind::Post {
                    return None;
                }
                let body = bodies.get(&item.content).cloned();
                let availability = if body.is_some() {
                    "Seeding"
                } else if pending.contains_key(&item.content) {
                    "Downloading"
                } else if hints
                    .get(&item.content)
                    .is_some_and(|hs| hs.iter().any(|h| h.issued_at + 90 > unix_seconds()))
                {
                    "Available"
                } else {
                    "No seeders"
                };
                Some(PostView {
                    id: hex(&id),
                    content: hex(&item.content),
                    author: hex(&r.entry.author),
                    title: item.title.clone(),
                    parent: item.parent.map(|p| hex(&p)),
                    sequence: r.entry.sequence,
                    body,
                    availability: availability.into(),
                })
            })
            .collect();
        status.member_publishing = local.index.member_publishing();
        status.revision += 1;
        view.send_replace(status.clone());
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            command = commands.recv() => {
                let Some(command) = command else { break };
                let result = (|| -> Result<()> {
                    match command {
                        Command::Publish { title, body, parent } => {
                            ensure!(local.index.member_publishing() || status.is_maintainer, "room publishing is closed");
                            let parent = parent.map(|p| parse_hex(&p)).transpose()?;
                            if let Some(p) = parent { ensure!(local.index.publications().any(|(id,_)| id == p), "reply parent is not visible"); }
                            let info = InfoDocument::for_bytes("post.txt", Some("text/plain; charset=utf-8".into()), body.as_bytes(), MAX_POST_BYTES as u32, unix_seconds() as i64);
                            let content = info.content_id();
                            // Store before publishing. A failed index write leaves only a local orphan.
                            let mut store = PieceStore::open(&local.dir, &info)?;
                            store.write_piece(0, body.as_bytes())?; store.promote()?;
                            persist(&local.dir.join(format!("{}.info", hex(&content))), &info.to_canonical())?;
                            status.last_publication = Some(local.sign(Action::Publish(CatalogItem { content, title: title.trim().into(), description: String::new(), media: None, kind: PublicationKind::Post, parent }), &allow)?);
                            bodies.insert(content, body); infos.insert(content, info); dirty = true;
                        }
                        Command::Fetch { publication } => {
                            let id = parse_hex(&publication)?;
                            let item = local.index.publications().find(|(p,_)| *p==id).context("post is not visible")?.1;
                            if let Action::Publish(item) = &item.entry.action { ensure!(item.kind == PublicationKind::Post, "not a post"); wanted.insert(item.content); }
                        }
                        Command::Withdraw { publication } => { local.sign(Action::Withdraw { publication: parse_hex(&publication)? }, &allow)?; dirty = true; }
                        Command::Remove { publication } => { local.sign(Action::Remove { publication: parse_hex(&publication)? }, &allow)?; dirty = true; }
                        Command::Ban { author } => { local.sign(Action::BanAuthor { author: parse_hex(&author)? }, &allow)?; dirty = true; }
                        Command::Block { content } => { local.sign(Action::Tombstone { content: parse_hex(&content)? }, &allow)?; dirty = true; }
                        Command::Policy { open } => { local.sign(Action::SetPolicy { member_publishing: open }, &allow)?; dirty = true; }
                        Command::Sync => { ticks = 0; dirty = true; }
                    } Ok(())
                })();
                status.command_error = result.err().map(|e| e.to_string());
                status.error = status.command_error.clone();
            }
            _ = tick.tick() => {
                // Metadata exchange works with the tracker offline as long as a configured peer is reachable.
                if ticks % 5 == 0 {
                    for peer in &peers { send(&mut tasks, transport.clone(), allow.clone(), PeerId::new(peer.id.to_string()), Msg::GetRoomRecords { room: local.index.room() }, false); }
                    if !sync_active && tasks.len() < MAX_TASKS {
                        if let Some(client) = client.clone() {
                            let index = local.index.clone();
                            let upload = dirty; dirty = false;
                            let claims: Vec<_> = if ticks % 5 == 0 { bodies.keys().filter(|c| allow.contains(c)).cycle().skip((ticks as usize / 5 * 4) % bodies.len().max(1)).take(bodies.len().min(4)).map(|c| Announcement::sign(&local.discovery, index.room(), *c, config.node_id.to_string(), config.advertise_address.unwrap_or_else(|| SocketAddr::new("127.0.0.1".parse().unwrap(), config.port)), unix_seconds())).collect() } else { Vec::new() };
                            let candidates: BTreeSet<_> = wanted.iter().copied().chain(local.index.items().filter(|i| i.kind == PublicationKind::Post).map(|i|i.content)).collect();
                            let mut queries: Vec<_> = wanted.iter().filter(|c| !bodies.contains_key(*c)).copied().take(2).collect();
                            for content in candidates.iter().copied().cycle().skip((ticks as usize / 5 * 2) % candidates.len().max(1)).take(candidates.len()) {
                                if queries.len() >= 2 { break; }
                                if !queries.contains(&content) { queries.push(content); }
                            }
                            tasks.spawn(async move {
                                let result = async move {
                                if upload { client.put_records(&index).await?; }
                                let index = client.get_index().await?;
                                for claim in claims { if index.contains(&claim.content) { client.put_announce(&claim).await?; } }
                                let mut hints = BTreeMap::new();
                                for content in queries { if index.contains(&content) { hints.insert(content, client.get_peers(content).await?); } }
                                Ok((index, hints))
                                }.await;
                                Ok(Work::Sync(result))
                            }); sync_active = true;
                        }
                    }
                }
                pending.retain(|_, p| p.requested.elapsed() < Duration::from_secs(3));
                for content in wanted.iter().copied().filter(|c| !bodies.contains_key(c)).take(4) {
                    if pending.contains_key(&content) { continue; }
                    // Hints never override the configured socket/peer pins. Try all configured sources
                    // in turn: availability claims are untrusted and may be missing during an outage.
                    if peers.is_empty() { continue; }
                    let peer = &peers[(ticks as usize / 3) % peers.len()];
                    let peer = PeerId::new(peer.id.to_string());
                    let msg = if infos.contains_key(&content) { Msg::Want { content, index: 0 } } else { Msg::GetInfo { content } };
                    send(&mut tasks, transport.clone(), allow.clone(), peer.clone(), msg, false);
                    pending.insert(content, Download { peer, requested: tokio::time::Instant::now() });
                }
                ticks += 1;
            }
            event = transport.next_event() => {
                match event {
                    None => break,
                    Some(TransportEvent::Datagram(dg)) => {
                        if let Ok(env) = Envelope::decode(&dg.payload) {
                            if allow.permits(&env.msg) { if let Err(e) = handle(dg.peer, env.msg, false, &mut local, &allow, &transport, &mut tasks, &mut infos, &mut bodies, &mut wanted, &mut pending) { status.error = Some(e.to_string()); } }
                        }
                    }
                    Some(TransportEvent::IncomingChannel { peer, mut channel }) if tasks.len() < MAX_TASKS => {
                        tasks.spawn(async move {
                            let bytes = tokio::time::timeout(Duration::from_secs(5), channel.recv()).await?.context("empty channel")??;
                            Ok(Work::Incoming(peer, Envelope::decode(&bytes)?.msg))
                        });
                    }
                    _ => {}
                }
            }
            work = tasks.join_next(), if !tasks.is_empty() => {
                match work {
                    Some(Ok(Ok(Work::Incoming(peer, msg)))) => {
                        // Incoming snapshots must persist before changing the active catalog.
                        if let Msg::RoomRecords { snapshot } = &msg {
                            let before = local.index.to_bytes();
                            if local.merge(snapshot, &allow).is_ok() && local.index.to_bytes() != before { dirty = true; }
                        } else if allow.permits(&msg) {
                            if let Err(e) = handle(peer, msg, true, &mut local, &allow, &transport, &mut tasks, &mut infos, &mut bodies, &mut wanted, &mut pending) { status.error = Some(e.to_string()); }
                        }
                    }
                    Some(Ok(Ok(Work::Sync(Ok((index, new_hints)))))) => {
                        sync_active = false; status.tracker_online = true;
                        if let Err(e) = local.merge(&index.to_bytes(), &allow) { status.error = Some(e.to_string()); }
                        let before = peers.len();
                        for hint in new_hints.values().flatten() {
                            let Ok(id) = hint.peer.parse::<Ipv4Addr>() else { continue };
                            let is_self_socket = hint.address.ip().is_loopback() && hint.address.port() == config.port;
                            if id != config.node_id && !is_self_socket && peers.len() < 64 && !peers.iter().any(|p|p.id == id) {
                                peers.push(PeerConfig { id, address: hint.address });
                            }
                        }
                        if peers.len() != before { backend.update_peers(&peers.iter().map(|p|(p.id,p.address)).collect::<Vec<_>>()).await?; }
                        hints.extend(new_hints);
                    }
                    Some(Ok(Ok(Work::Sync(Err(e))))) => { sync_active = false; dirty = true; status.tracker_online = false; status.error = Some(format!("Tracker offline: {e}")); }
                    Some(Ok(Err(_))) | Some(Err(_)) => {
                        // An individual peer failure does not end the room. Reset sync only when
                        // its task finishes; sync errors have a separate result variant below.
                    }
                    _ => {}
                }
            }
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    drop(transport);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle(
    peer: PeerId,
    msg: Msg,
    reliable: bool,
    local: &mut Local,
    allow: &Allowlist,
    transport: &Arc<dyn P2pTransport>,
    tasks: &mut JoinSet<Result<Work>>,
    infos: &mut BTreeMap<ContentId, InfoDocument>,
    bodies: &mut BTreeMap<ContentId, String>,
    wanted: &mut BTreeSet<ContentId>,
    pending: &mut BTreeMap<ContentId, Download>,
) -> Result<()> {
    match msg {
        Msg::GetRoomRecords { .. } => send(
            tasks,
            transport.clone(),
            allow.clone(),
            peer,
            Msg::RoomRecords {
                snapshot: local.index.to_bytes(),
            },
            true,
        ),
        Msg::GetInfo { content } if bodies.contains_key(&content) => {
            if let Some(info) = infos.get(&content) {
                send(
                    tasks,
                    transport.clone(),
                    allow.clone(),
                    peer,
                    Msg::Info {
                        document: info.to_canonical(),
                    },
                    true,
                );
            }
        }
        Msg::Want { content, index: 0 } if bodies.contains_key(&content) => {
            send(
                tasks,
                transport.clone(),
                allow.clone(),
                peer,
                Msg::Piece {
                    content,
                    index: 0,
                    data: bodies[&content].as_bytes().to_vec(),
                },
                true,
            );
        }
        Msg::Info { document } if reliable => {
            let info = InfoDocument::from_canonical(&document)?;
            let content = info.content_id();
            ensure!(
                valid_post(&info) && info.to_canonical() == document,
                "unsupported post metadata"
            );
            if wanted.contains(&content) && pending.get(&content).is_some_and(|p| p.peer == peer) {
                persist(
                    &local.dir.join(format!("{}.info", hex(&content))),
                    &document,
                )?;
                infos.insert(content, info);
                pending.remove(&content);
            }
        }
        Msg::Piece {
            content,
            index: 0,
            data,
        } if reliable && wanted.contains(&content) => {
            if !pending.get(&content).is_some_and(|p| p.peer == peer) {
                return Ok(());
            }
            let info = infos.get(&content).context("piece before metadata")?;
            let body = String::from_utf8(data.clone())?;
            allow
                .with_allowed(&content, || -> Result<()> {
                    let mut store = PieceStore::open(&local.dir, info)?;
                    store.write_piece(0, &data)?;
                    store.promote()?;
                    Ok(())
                })
                .context("post removed")??;
            bodies.insert(content, body);
            pending.remove(&content);
            wanted.remove(&content);
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_poll_throttling() {
        let (commands, _rx) = mpsc::channel(32);
        let (stop, _stopped) = watch::channel(false);
        let (view_tx, view) = watch::channel(ServiceView::default());

        let mut service = P2pService {
            commands,
            stop,
            view,
            worker: None,
            last_poll: None,
            min_poll_interval: Duration::from_millis(500),
        };

        view_tx.send_modify(|v| v.running = true);

        // First poll succeeds and clones
        let first = service.poll();
        assert!(first.is_some());
        assert!(first.unwrap().running);

        // Immediate next poll within 500ms is throttled, returning None
        view_tx.send_modify(|v| {
            v.posts.push(PostView {
                title: "hello".into(),
                ..Default::default()
            })
        });
        assert!(service.poll().is_none());

        // Fast-forward last_poll to simulate 501ms passing
        service.last_poll = Some(Instant::now() - Duration::from_millis(501));

        // Now poll succeeds and retrieves the unconsumed change
        let second = service.poll();
        assert!(second.is_some());
        assert_eq!(second.unwrap().posts.len(), 1);

        // Immediate subsequent poll is throttled again
        assert!(service.poll().is_none());
    }
}

