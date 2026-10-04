//! A disk cache of generated meshes (`Entropy.MeshCache`, src/deno/mesh_cache_ops.rs).
//!
//! Procedural geometry is expensive to make and cheap to keep: a Mesha house takes tens of
//! milliseconds to evaluate and a few megabytes to store. Like a shader cache, the first time a
//! mesh is wanted it is built and written here; every later time (this session or the next) it is
//! read back instead. Meshes are kept in the engine's packed `mesh` vertex layout (12 floats a
//! vertex: position, normal, uv, color) with u32 indices, under a caller-chosen namespace and key.
//! Callers put whatever identifies the geometry in the key (generator id and version, parameter
//! values, level of detail), so a changed generator simply misses and rebuilds.
//!
//! - Files: `<root>/<namespace>/<2 hex>/<16 hex>.mesh`, named by a stable 64-bit hash of the key.
//!   The full key is stored in the file and checked on read, so a hash collision is a miss, not a
//!   wrong mesh. Writes go to a temporary file first and are renamed into place, so a crash never
//!   leaves a half-written mesh.
//! - Memory: recently used meshes stay decoded (least recently used go first past a byte limit),
//!   so spawning many copies of one mesh reads the disk once.
//! - Levels of detail: `put_async` can simplify the mesh first (helpers/mesh_simplify.rs) on a
//!   background thread; `status` reports `Pending` until it lands.
//!
//! A namespace is one folder; `stats`, `prune` (oldest first, by last use) and `clear` work on it.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use super::mesh_simplify::{simplify_packed, SimplifyParams, VERTEX_FLOATS};

const MAGIC: &[u8; 4] = b"EMC1";
const DEFAULT_MEMORY_LIMIT: usize = 512 * 1024 * 1024;
const WORKERS: usize = 2;

pub struct CachedMesh {
    pub key: String,
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    /// Caller's JSON (bounds, triangle counts, anything it wants back without the geometry).
    pub meta: String,
}

impl CachedMesh {
    pub fn bytes(&self) -> usize { self.vertices.len() * 4 + self.indices.len() * 4 + self.meta.len() + self.key.len() }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status { Ready, Pending, Missing }

impl Status {
    pub fn as_str(self) -> &'static str {
        match self { Status::Ready => "ready", Status::Pending => "pending", Status::Missing => "missing" }
    }
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub files: usize,
    pub bytes: u64,
    pub memory_meshes: usize,
    pub memory_bytes: usize,
    pub pending: usize,
    pub hits: u64,
    pub misses: u64,
    pub writes: u64,
}

struct Memory {
    entries: HashMap<String, (Arc<CachedMesh>, u64)>,
    bytes: usize,
    tick: u64,
}

struct Job {
    namespace: String,
    key: String,
    vertices: Vec<f32>,
    indices: Vec<u32>,
    meta: String,
    simplify: Option<SimplifyParams>,
}

struct Counters { hits: u64, misses: u64, writes: u64 }

pub struct MeshCache {
    root: PathBuf,
    memory: Mutex<Memory>,
    memory_limit: usize,
    pending: Mutex<HashSet<String>>,
    /// Jobs whose result failed to write, by full key, with the reason.
    failed: Mutex<HashMap<String, String>>,
    queue: Mutex<VecDeque<Job>>,
    wake: Condvar,
    counters: Mutex<Counters>,
}

/// One cache per root folder, shared by every addon that uses it.
pub fn cache_at(root: PathBuf) -> Arc<MeshCache> {
    static CACHES: OnceLock<Mutex<HashMap<PathBuf, Arc<MeshCache>>>> = OnceLock::new();
    let mut all = CACHES.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    all.entry(root.clone()).or_insert_with(|| MeshCache::new(root, DEFAULT_MEMORY_LIMIT)).clone()
}

/// FNV-1a: stable across Rust versions and platforms, unlike `DefaultHasher`.
pub fn stable_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Namespaces are folder names: letters, digits, `_`, `-` and `.`, not starting with a dot.
pub fn valid_namespace(ns: &str) -> bool {
    !ns.is_empty() && ns.len() <= 96 && !ns.starts_with('.')
        && ns.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn full_key(namespace: &str, key: &str) -> String { format!("{namespace}\u{1f}{key}") }

impl MeshCache {
    pub fn new(root: PathBuf, memory_limit: usize) -> Arc<Self> {
        let cache = Arc::new(Self {
            root,
            memory: Mutex::new(Memory { entries: HashMap::new(), bytes: 0, tick: 0 }),
            memory_limit,
            pending: Mutex::new(HashSet::new()),
            failed: Mutex::new(HashMap::new()),
            queue: Mutex::new(VecDeque::new()),
            wake: Condvar::new(),
            counters: Mutex::new(Counters { hits: 0, misses: 0, writes: 0 }),
        });
        for k in 0..WORKERS {
            let weak = Arc::downgrade(&cache);
            let _ = std::thread::Builder::new().name(format!("mesh-cache-{k}")).spawn(move || worker(weak));
        }
        cache
    }

    pub fn root(&self) -> &Path { &self.root }

    fn check(namespace: &str) -> Result<(), String> {
        if valid_namespace(namespace) { Ok(()) } else {
            Err(format!("Invalid mesh cache namespace {namespace:?}: use letters, digits, '_', '-' and '.'"))
        }
    }

    pub fn path(&self, namespace: &str, key: &str) -> PathBuf {
        let h = format!("{:016x}", stable_hash(key));
        self.root.join(namespace).join(&h[..2]).join(format!("{h}.mesh"))
    }

    pub fn status(&self, namespace: &str, key: &str) -> Status {
        let fk = full_key(namespace, key);
        if self.memory.lock().unwrap().entries.contains_key(&fk) { return Status::Ready; }
        if self.pending.lock().unwrap().contains(&fk) { return Status::Pending; }
        if Self::check(namespace).is_err() { return Status::Missing; }
        // A file under the key's hash is only ours if it holds this key; reading the header is
        // enough to tell.
        match read_key(&self.path(namespace, key)) { Some(k) if k == key => Status::Ready, _ => Status::Missing }
    }

    /// The reason the last background build of this key failed, if it did.
    pub fn failure(&self, namespace: &str, key: &str) -> Option<String> {
        self.failed.lock().unwrap().get(&full_key(namespace, key)).cloned()
    }

    pub fn get(&self, namespace: &str, key: &str) -> Option<Arc<CachedMesh>> {
        let fk = full_key(namespace, key);
        {
            let mut mem = self.memory.lock().unwrap();
            mem.tick += 1;
            let tick = mem.tick;
            if let Some((m, used)) = mem.entries.get_mut(&fk) {
                *used = tick;
                let m = m.clone();
                drop(mem);
                self.counters.lock().unwrap().hits += 1;
                return Some(m);
            }
        }
        if Self::check(namespace).is_err() { return None; }
        let path = self.path(namespace, key);
        let mesh = match read_mesh(&path) {
            Some(m) if m.key == key => Arc::new(m),
            _ => { self.counters.lock().unwrap().misses += 1; return None; }
        };
        // Touch it so `prune` (oldest first) keeps what is in use.
        if let Ok(f) = std::fs::File::options().append(true).open(&path) { let _ = f.set_modified(std::time::SystemTime::now()); }
        self.counters.lock().unwrap().hits += 1;
        self.remember(fk, mesh.clone());
        Some(mesh)
    }

    fn remember(&self, fk: String, mesh: Arc<CachedMesh>) {
        let mut mem = self.memory.lock().unwrap();
        mem.tick += 1;
        let tick = mem.tick;
        let size = mesh.bytes();
        if let Some((old, _)) = mem.entries.insert(fk, (mesh, tick)) { mem.bytes -= old.bytes(); }
        mem.bytes += size;
        if mem.bytes > self.memory_limit {
            let mut by_age: Vec<(u64, String)> = mem.entries.iter().map(|(k, (_, t))| (*t, k.clone())).collect();
            by_age.sort_unstable();
            for (_, k) in by_age {
                if mem.bytes <= self.memory_limit * 3 / 4 { break; }
                if let Some((m, _)) = mem.entries.remove(&k) { mem.bytes -= m.bytes(); }
            }
        }
    }

    /// Stores a mesh now (writes the file on this thread).
    pub fn put(&self, namespace: &str, key: &str, vertices: Vec<f32>, indices: Vec<u32>, meta: String) -> Result<Arc<CachedMesh>, String> {
        Self::check(namespace)?;
        validate(&vertices, &indices)?;
        let mesh = Arc::new(CachedMesh { key: key.to_string(), vertices, indices, meta });
        write_mesh(&self.path(namespace, key), &mesh)?;
        self.counters.lock().unwrap().writes += 1;
        self.remember(full_key(namespace, key), mesh.clone());
        Ok(mesh)
    }

    /// Stores a mesh from a background thread, simplified first when `simplify` is given. The key
    /// reads `Pending` until it is written.
    pub fn put_async(&self, namespace: &str, key: &str, vertices: Vec<f32>, indices: Vec<u32>, meta: String, simplify: Option<SimplifyParams>) -> Result<(), String> {
        Self::check(namespace)?;
        validate(&vertices, &indices)?;
        let fk = full_key(namespace, key);
        if !self.pending.lock().unwrap().insert(fk.clone()) { return Ok(()); }
        self.failed.lock().unwrap().remove(&fk);
        self.queue.lock().unwrap().push_back(Job { namespace: namespace.into(), key: key.into(), vertices, indices, meta, simplify });
        self.wake.notify_one();
        Ok(())
    }

    fn run(&self, job: Job) {
        let fk = full_key(&job.namespace, &job.key);
        let (vertices, indices) = match job.simplify {
            Some(p) => { let (v, i, _) = simplify_packed(&job.vertices, &job.indices, p); (v, i) }
            None => (job.vertices, job.indices),
        };
        if let Err(e) = self.put(&job.namespace, &job.key, vertices, indices, job.meta) {
            self.failed.lock().unwrap().insert(fk.clone(), e);
        }
        self.pending.lock().unwrap().remove(&fk);
    }

    /// Waits (up to `timeout`) for every background build to finish; for tests and tools.
    pub fn wait_idle(&self, timeout: std::time::Duration) -> bool {
        let start = std::time::Instant::now();
        while !self.pending.lock().unwrap().is_empty() {
            if start.elapsed() > timeout { return false; }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        true
    }

    pub fn remove(&self, namespace: &str, key: &str) -> bool {
        let fk = full_key(namespace, key);
        let mut mem = self.memory.lock().unwrap();
        if let Some((m, _)) = mem.entries.remove(&fk) { mem.bytes -= m.bytes(); }
        drop(mem);
        Self::check(namespace).is_ok() && std::fs::remove_file(self.path(namespace, key)).is_ok()
    }

    fn forget_namespace(&self, namespace: &str) {
        let prefix = full_key(namespace, "");
        let mut mem = self.memory.lock().unwrap();
        let keys: Vec<String> = mem.entries.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in keys { if let Some((m, _)) = mem.entries.remove(&k) { mem.bytes -= m.bytes(); } }
    }

    /// Deletes every mesh in the namespace; returns how many files went.
    pub fn clear(&self, namespace: &str) -> Result<usize, String> {
        Self::check(namespace)?;
        self.forget_namespace(namespace);
        let files = list_files(&self.root.join(namespace));
        for (p, _, _) in &files { let _ = std::fs::remove_file(p); }
        Ok(files.len())
    }

    /// Deletes the least recently used meshes until the namespace fits in `max_bytes`; returns how
    /// many files went.
    pub fn prune(&self, namespace: &str, max_bytes: u64) -> Result<usize, String> {
        Self::check(namespace)?;
        let mut files = list_files(&self.root.join(namespace));
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= max_bytes { return Ok(0); }
        files.sort_by_key(|f| f.2);
        let mut removed = 0;
        for (p, size, _) in files {
            if total <= max_bytes { break; }
            if std::fs::remove_file(&p).is_ok() { total -= size; removed += 1; }
        }
        if removed > 0 { self.forget_namespace(namespace); }
        Ok(removed)
    }

    pub fn stats(&self, namespace: &str) -> CacheStats {
        let files = if valid_namespace(namespace) { list_files(&self.root.join(namespace)) } else { Vec::new() };
        let prefix = full_key(namespace, "");
        let mem = self.memory.lock().unwrap();
        let (memory_meshes, memory_bytes) = mem.entries.iter().filter(|(k, _)| k.starts_with(&prefix))
            .fold((0, 0), |(n, b), (_, (m, _))| (n + 1, b + m.bytes()));
        drop(mem);
        let pending = self.pending.lock().unwrap().iter().filter(|k| k.starts_with(&prefix)).count();
        let c = self.counters.lock().unwrap();
        CacheStats { files: files.len(), bytes: files.iter().map(|f| f.1).sum(), memory_meshes, memory_bytes, pending, hits: c.hits, misses: c.misses, writes: c.writes }
    }
}

fn worker(cache: std::sync::Weak<MeshCache>) {
    loop {
        let Some(c) = cache.upgrade() else { return };
        let job = {
            let mut q = c.queue.lock().unwrap();
            loop {
                if let Some(j) = q.pop_front() { break Some(j); }
                let (guard, timeout) = c.wake.wait_timeout(q, std::time::Duration::from_millis(500)).unwrap();
                q = guard;
                if timeout.timed_out() && q.is_empty() { break None; }
            }
        };
        match job {
            Some(j) => c.run(j),
            // Let go of the cache between waits so a dropped cache (tests) ends its workers.
            None => { drop(c); continue; }
        }
    }
}

fn validate(vertices: &[f32], indices: &[u32]) -> Result<(), String> {
    if vertices.len() % VERTEX_FLOATS != 0 {
        return Err(format!("vertex data must be {VERTEX_FLOATS} floats a vertex (position, normal, uv, color); got {} floats", vertices.len()));
    }
    if indices.len() % 3 != 0 { return Err(format!("index count {} is not a multiple of 3", indices.len())); }
    let n = (vertices.len() / VERTEX_FLOATS) as u32;
    if let Some(bad) = indices.iter().find(|&&i| i >= n) { return Err(format!("index {bad} is past the {n} vertices")); }
    Ok(())
}

fn list_files(dir: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let mut out = Vec::new();
    let Ok(subdirs) = std::fs::read_dir(dir) else { return out };
    for sub in subdirs.flatten() {
        let Ok(entries) = std::fs::read_dir(sub.path()) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("mesh") { continue; }
            if let Ok(md) = e.metadata() {
                out.push((p, md.len(), md.modified().unwrap_or(std::time::UNIX_EPOCH)));
            }
        }
    }
    out
}

fn write_mesh(path: &Path, mesh: &CachedMesh) -> Result<(), String> {
    let dir = path.parent().ok_or("bad cache path")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mesh cache: {e}"))?;
    let mut buf = Vec::with_capacity(24 + mesh.key.len() + mesh.meta.len() + mesh.vertices.len() * 4 + mesh.indices.len() * 4);
    buf.extend_from_slice(MAGIC);
    buf.extend_from_slice(&(mesh.key.len() as u32).to_le_bytes());
    buf.extend_from_slice(mesh.key.as_bytes());
    buf.extend_from_slice(&(mesh.meta.len() as u32).to_le_bytes());
    buf.extend_from_slice(mesh.meta.as_bytes());
    buf.extend_from_slice(&(mesh.vertices.len() as u32).to_le_bytes());
    buf.extend_from_slice(&(mesh.indices.len() as u32).to_le_bytes());
    for v in &mesh.vertices { buf.extend_from_slice(&v.to_le_bytes()); }
    for i in &mesh.indices { buf.extend_from_slice(&i.to_le_bytes()); }
    // Unique temporary name: two threads may write the same key.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = path.with_extension(format!("tmp{}-{}", std::process::id(), SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&buf)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map_err(|e| format!("mesh cache write {}: {e}", path.display()))
}

struct Reader<'a> { b: &'a [u8], at: usize }

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(s)
    }
    fn u32(&mut self) -> Option<u32> { Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?)) }
    fn string(&mut self) -> Option<String> { let n = self.u32()? as usize; String::from_utf8(self.take(n)?.to_vec()).ok() }
}

fn read_key(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 8];
    f.read_exact(&mut head).ok()?;
    if &head[..4] != MAGIC { return None; }
    let n = u32::from_le_bytes(head[4..8].try_into().ok()?) as usize;
    if n > 1 << 20 { return None; }
    let mut key = vec![0u8; n];
    f.read_exact(&mut key).ok()?;
    String::from_utf8(key).ok()
}

fn read_mesh(path: &Path) -> Option<CachedMesh> {
    let bytes = std::fs::read(path).ok()?;
    let mut r = Reader { b: &bytes, at: 0 };
    if r.take(4)? != MAGIC { return None; }
    let key = r.string()?;
    let meta = r.string()?;
    let nv = r.u32()? as usize;
    let ni = r.u32()? as usize;
    let vertices = r.take(nv.checked_mul(4)?)?.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
    let indices = r.take(ni.checked_mul(4)?)?.chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect();
    if r.at != bytes.len() { return None; }
    Some(CachedMesh { key, vertices, indices, meta })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("entropy-mesh-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn quad() -> (Vec<f32>, Vec<u32>) {
        let mut v = Vec::new();
        for (x, z) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)] {
            v.extend_from_slice(&[x, 0.0, z, 0.0, 1.0, 0.0, 3.0, 0.0, 0.5, 0.5, 0.5, 0.0]);
        }
        (v, vec![0, 2, 1, 0, 3, 2])
    }

    #[test]
    fn round_trips_through_disk_and_survives_a_new_cache() {
        let root = temp_root("roundtrip");
        let (v, i) = quad();
        {
            let c = MeshCache::new(root.clone(), 1 << 20);
            assert_eq!(c.status("houses", "a|lod0"), Status::Missing);
            c.put("houses", "a|lod0", v.clone(), i.clone(), "{\"t\":2}".into()).unwrap();
            assert_eq!(c.status("houses", "a|lod0"), Status::Ready);
        }
        // A fresh cache (the next session) reads it back from disk.
        let c = MeshCache::new(root.clone(), 1 << 20);
        assert_eq!(c.status("houses", "a|lod0"), Status::Ready);
        let m = c.get("houses", "a|lod0").unwrap();
        assert_eq!(m.vertices, v);
        assert_eq!(m.indices, i);
        assert_eq!(m.meta, "{\"t\":2}");
        assert!(c.get("houses", "b|lod0").is_none());
        assert_eq!(c.stats("houses").files, 1);
        assert_eq!(c.clear("houses").unwrap(), 1);
        assert_eq!(c.status("houses", "a|lod0"), Status::Missing);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_bad_input_and_namespaces() {
        let c = MeshCache::new(temp_root("bad"), 1 << 20);
        let (v, _) = quad();
        assert!(c.put("houses", "k", v.clone(), vec![0, 1, 9], String::new()).is_err());
        assert!(c.put("houses", "k", v[..7].to_vec(), vec![], String::new()).is_err());
        assert!(c.put("../escape", "k", v, vec![], String::new()).is_err());
        assert!(!valid_namespace(".hidden") && valid_namespace("qp-houses.v1"));
    }

    #[test]
    fn background_puts_simplify_and_report_pending_then_ready() {
        let root = temp_root("async");
        let c = MeshCache::new(root.clone(), 1 << 20);
        // A 20 x 20 grid of flat quads simplifies to almost nothing at any error.
        let n = 20;
        let mut v = Vec::new();
        let mut idx = Vec::new();
        for z in 0..=n { for x in 0..=n { v.extend_from_slice(&[x as f32, 0.0, z as f32, 0.0, 1.0, 0.0, 3.0, 0.0, 0.2, 0.3, 0.4, 0.0]); } }
        for z in 0..n { for x in 0..n {
            let a = (z * (n + 1) + x) as u32; let b = a + 1; let d = a + (n + 1) as u32; let e = d + 1;
            idx.extend_from_slice(&[a, d, b, b, d, e]);
        } }
        c.put_async("lods", "grid|1", v, idx, String::new(), Some(SimplifyParams { max_error: 0.01, min_feature: 0.0, target_ratio: 0.0 })).unwrap();
        assert!(c.wait_idle(std::time::Duration::from_secs(10)));
        assert_eq!(c.status("lods", "grid|1"), Status::Ready);
        let m = c.get("lods", "grid|1").unwrap();
        assert!(m.indices.len() / 3 <= 4, "{} triangles left", m.indices.len() / 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_drops_least_recently_used_first() {
        let root = temp_root("prune");
        let c = MeshCache::new(root.clone(), 1 << 20);
        let (v, i) = quad();
        for k in 0..4 {
            c.put("p", &format!("k{k}"), v.clone(), i.clone(), String::new()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let one = c.stats("p").bytes / 4;
        assert_eq!(c.prune("p", one * 2).unwrap(), 2);
        assert_eq!(c.status("p", "k0"), Status::Missing);
        assert_eq!(c.status("p", "k3"), Status::Ready);
        let _ = std::fs::remove_dir_all(&root);
    }
}
