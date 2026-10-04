//! QuadScape::update for a solar system: every frame, diff the wanted chunk set (all planets)
//! against the live one, build the missing chunks that matter most within a budget (in parallel),
//! and drop stale chunks once their ground is covered by live replacements - so streaming never
//! opens a hole.
//!
//! Two ways to build: `update` builds within the call (scoped threads, joined before it returns;
//! the tests and unlimited-budget loading use it), `update_background` hands chunks to persistent
//! worker threads and only collects what they finished, so a frame never waits on a chunk.
//! Queued jobs that stop being wanted are cancelled before they start; finished chunks that are
//! no longer wanted are dropped; at most `max_builds` finished chunks are handed out per call,
//! which bounds the GPU uploads a frame does.
//!
//! The wanted set also respects a triangle budget: if the selection would draw more than
//! `triangle_budget` triangles, the split distance is tightened until it fits, so detail follows
//! you from orbit to the ground without ever passing the budget (2M by default).

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::math::*;
use super::mesh::{build_chunk, estimated_triangles, ChunkMesh};
use super::planet::Planet;
use super::quadtree::{nodes_overlap, select_chunks, ChunkNode, LodSettings};

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStats {
    pub live: usize,
    pub wanted: usize,
    pub pending: usize,
    /// Wanted chunks waiting on elevation tiles still downloading.
    pub waiting_for_data: usize,
    pub hidden: usize,
    /// Splits made to keep the tree balanced, this selection.
    pub balanced: usize,
    /// Live chunks with at least one stitched border.
    pub stitched: usize,
    pub built: usize,
    pub destroyed: usize,
    /// Deepest level live per planet.
    pub deepest: Vec<u32>,
    /// Live chunk count per planet.
    pub per_planet: Vec<usize>,
    pub triangles: usize,
    /// The split factor the triangle budget left (the configured one when within budget).
    pub split_factor: f64,
    /// Milliseconds spent building chunks this update (background mode: collecting finished ones).
    pub build_ms: f64,
    /// Background mode: chunks queued or building on worker threads.
    pub in_flight: usize,
    /// Background mode: finished chunks waiting for a later update (beyond max_builds).
    pub ready: usize,
    /// Background mode: queued jobs dropped because the chunk stopped being wanted, in total.
    pub cancelled: usize,
}

struct Job { key: String, node: ChunkNode, planets: Arc<Vec<Planet>>, epoch: u64 }
struct JobResult { key: String, node: ChunkNode, mesh: Option<ChunkMesh>, epoch: u64 }

#[derive(Default)]
struct JobQueue { jobs: VecDeque<Job>, shutdown: bool }

/// Persistent chunk builders. Threads exit when the streamer is dropped.
struct Workers {
    queue: Arc<(Mutex<JobQueue>, Condvar)>,
    results: mpsc::Receiver<JobResult>,
}

impl Workers {
    fn new(threads: usize) -> Self {
        let queue: Arc<(Mutex<JobQueue>, Condvar)> = Arc::default();
        let (tx, results) = mpsc::channel();
        for i in 0..threads {
            let queue = queue.clone();
            let tx = tx.clone();
            let _ = std::thread::Builder::new().name(format!("quadplanet-chunks-{i}")).spawn(move || loop {
                let job = {
                    let (lock, cv) = &*queue;
                    let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
                    loop {
                        if q.shutdown { return; }
                        if let Some(job) = q.jobs.pop_front() { break job; }
                        q = cv.wait(q).unwrap_or_else(|e| e.into_inner());
                    }
                };
                let mesh = build_chunk(&job.planets[job.node.planet as usize], &job.node);
                if tx.send(JobResult { key: job.key, node: job.node, mesh, epoch: job.epoch }).is_err() { return; }
            });
        }
        Self { queue, results }
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        let (lock, cv) = &*self.queue;
        let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
        q.shutdown = true;
        q.jobs.clear();
        cv.notify_all();
    }
}

/// A chunk whose elevation was not there yet is tried again after this long.
const RETRY_AFTER: Duration = Duration::from_millis(250);

struct LiveChunk { node: ChunkNode, triangles: usize }

struct Wanted { nodes: HashMap<String, (ChunkNode, V3)>, hidden: usize, balanced: usize, split_factor: f64 }

/// What an update changed, for the engine side to apply.
pub struct StreamUpdate {
    pub created: Vec<(String, ChunkNode, ChunkMesh)>,
    pub destroyed: Vec<String>,
    pub stats: StreamStats,
}

pub struct PlanetStreamer {
    live: HashMap<String, LiveChunk>,
    built_total: usize,
    destroyed_total: usize,
    last_stats: StreamStats,
    cache: Option<(V3, Wanted)>,
    pub lod: LodSettings,
    pub triangle_budget: usize,
    pub threads: usize,
    workers: Option<Workers>,
    /// Chunks queued or building on the workers.
    in_flight: HashSet<String>,
    /// Finished chunks not handed out yet.
    ready: Vec<(String, ChunkNode, ChunkMesh)>,
    /// Chunks that came back waiting for elevation data, and when.
    waiting: HashMap<String, Instant>,
    /// Bumped by `clear`: results of jobs from before it are dropped.
    epoch: u64,
    cancelled_total: usize,
}

impl PlanetStreamer {
    pub fn new(lod: LodSettings, triangle_budget: usize) -> Self {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
        Self {
            live: HashMap::new(), built_total: 0, destroyed_total: 0, last_stats: StreamStats::default(), cache: None, lod, triangle_budget, threads,
            workers: None, in_flight: HashSet::new(), ready: Vec::new(), waiting: HashMap::new(), epoch: 0, cancelled_total: 0,
        }
    }

    pub fn live_nodes(&self) -> impl Iterator<Item = (&String, &ChunkNode)> { self.live.iter().map(|(k, c)| (k, &c.node)) }
    pub fn stats(&self) -> &StreamStats { &self.last_stats }
    /// Forgets the cached selection (after a configuration change).
    pub fn invalidate(&mut self) { self.cache = None; }

    fn select(&mut self, planets: &[Planet], viewer: V3) -> &Wanted {
        // Selection (with balancing) takes milliseconds; a meter of movement can't change it much
        // (the smallest chunks are tens of meters across).
        let fresh = match &self.cache { Some((v, _)) => distance(*v, viewer) >= 1.0, None => true };
        if fresh {
            let mut lod = self.lod.clone();
            let mut wanted;
            loop {
                wanted = Wanted { nodes: HashMap::new(), hidden: 0, balanced: 0, split_factor: lod.split_factor };
                let mut triangles = 0;
                for (i, p) in planets.iter().enumerate() {
                    let sel = select_chunks(p, i as u32, viewer, &lod);
                    wanted.hidden += sel.hidden;
                    wanted.balanced += sel.balanced;
                    for (n, c) in sel.leaves {
                        triangles += estimated_triangles(p, n.level);
                        wanted.nodes.insert(n.key(), (n, c));
                    }
                }
                if triangles <= self.triangle_budget || lod.split_factor < 0.3 { break; }
                lod.split_factor *= 0.85;
            }
            self.cache = Some((viewer, wanted));
        }
        &self.cache.as_ref().unwrap().1
    }

    /// `max_builds` and `max_ms` bound the work per call (chunk building is the expensive part).
    pub fn update(&mut self, planets: &[Planet], viewer: V3, max_builds: usize, max_ms: f64) -> StreamUpdate {
        let started = Instant::now();
        let threads = self.threads;
        self.select(planets, viewer);
        let wanted = &self.cache.as_ref().unwrap().1;

        // Build the missing chunks that look biggest first: distance relative to size, so the
        // ground under your feet comes first, but a distant range's coarse chunk is not left as a
        // hole in the horizon while dozens of small nearby ones stream in.
        let mut missing: Vec<(f64, &String, &ChunkNode)> = wanted.nodes.iter().filter(|(k, _)| !self.live.contains_key(*k))
            .map(|(k, (n, c))| (distance(viewer, *c) / planets[n.planet as usize].level_world_size(n.level), k, n)).collect();
        missing.sort_by(|a, b| a.0.total_cmp(&b.0));

        let mut created = Vec::new();
        let mut waiting = 0;
        let mut next = 0;
        // Batches of one chunk per thread, until the build budget or the time runs out. A chunk
        // whose elevation tiles are still downloading comes back empty and is tried again later.
        while next < missing.len() && created.len() < max_builds && (created.is_empty() || started.elapsed().as_secs_f64() * 1000.0 < max_ms) {
            let take = threads.min(missing.len() - next).min(max_builds - created.len()).max(1);
            let batch = &missing[next..next + take];
            next += take;
            let results: Vec<Option<ChunkMesh>> = if take == 1 {
                vec![build_chunk(&planets[batch[0].2.planet as usize], batch[0].2)]
            } else {
                std::thread::scope(|s| {
                    let handles: Vec<_> = batch.iter().map(|(_, _, n)| s.spawn(move || build_chunk(&planets[n.planet as usize], n))).collect();
                    handles.into_iter().map(|h| h.join().ok().flatten()).collect()
                })
            };
            for ((_, key, node), mesh) in batch.iter().zip(results) {
                match mesh {
                    Some(mesh) => created.push(((*key).clone(), **node, mesh)),
                    None => waiting += 1,
                }
            }
        }
        let build_ms = started.elapsed().as_secs_f64() * 1000.0;
        self.finish(planets, viewer, created, waiting, build_ms)
    }

    /// Like `update`, but chunks are built on persistent worker threads: this call only queues
    /// the most important missing chunks (replacing the previous queue, so the order follows the
    /// viewer and unwanted jobs are cancelled before they start) and hands out up to `max_builds`
    /// chunks the workers have finished. `max_ms` bounds nothing here but is kept for symmetry;
    /// an unbounded budget (loading screens) falls back to building everything within the call.
    pub fn update_background(&mut self, planets: &Arc<Vec<Planet>>, viewer: V3, max_builds: usize, max_ms: f64) -> StreamUpdate {
        if max_ms >= 1.0e12 {
            // Collect anything the workers finished first, so nothing is built twice.
            self.collect();
            return self.update(planets, viewer, max_builds, max_ms);
        }
        let started = Instant::now();
        self.select(planets, viewer);
        self.collect();
        let wanted = &self.cache.as_ref().unwrap().1;

        // Hand out finished chunks that are still wanted, nearest-looking first.
        let mut ready = std::mem::take(&mut self.ready);
        ready.retain(|(k, _, _)| wanted.nodes.contains_key(k) && !self.live.contains_key(k));
        ready.sort_by(|a, b| {
            let pa = distance(viewer, a.2.center) / planets[a.1.planet as usize].level_world_size(a.1.level);
            let pb = distance(viewer, b.2.center) / planets[b.1.planet as usize].level_world_size(b.1.level);
            pa.total_cmp(&pb)
        });
        let keep = ready.split_off(ready.len().min(max_builds));
        let created = ready;
        self.ready = keep;

        // Requeue: the missing chunks that matter most, minus those building or finished.
        let now = Instant::now();
        self.waiting.retain(|k, t| wanted.nodes.contains_key(k) && now.duration_since(*t) < RETRY_AFTER);
        let mut missing: Vec<(f64, &String, &ChunkNode)> = wanted.nodes.iter()
            .filter(|(k, _)| !self.live.contains_key(*k) && !self.waiting.contains_key(*k))
            .map(|(k, (n, c))| (distance(viewer, *c) / planets[n.planet as usize].level_world_size(n.level), k, n)).collect();
        missing.sort_by(|a, b| a.0.total_cmp(&b.0));
        let threads = self.threads;
        let workers = self.workers.get_or_insert_with(|| Workers::new(threads));
        {
            let (lock, cv) = &*workers.queue;
            let mut q = lock.lock().unwrap_or_else(|e| e.into_inner());
            for job in q.jobs.drain(..) {
                self.in_flight.remove(&job.key);
                if !wanted.nodes.contains_key(&job.key) { self.cancelled_total += 1; }
            }
            // Finished chunks (handed out now or kept for later) are not built again.
            let ready_keys: HashSet<&String> = self.ready.iter().chain(created.iter()).map(|(k, _, _)| k).collect();
            // Enough queued to keep every worker busy until the next frame, not so many that a
            // turn of the camera leaves a long stale queue.
            let depth = threads * 3;
            for (_, key, node) in missing {
                if q.jobs.len() >= depth { break; }
                if self.in_flight.contains(key) || ready_keys.contains(key) { continue; }
                q.jobs.push_back(Job { key: key.clone(), node: *node, planets: planets.clone(), epoch: self.epoch });
                self.in_flight.insert(key.clone());
            }
            cv.notify_all();
        }
        let waiting = self.waiting.len();
        let build_ms = started.elapsed().as_secs_f64() * 1000.0;
        self.finish(planets, viewer, created, waiting, build_ms)
    }

    /// Moves finished jobs from the workers into `ready`.
    fn collect(&mut self) {
        let Some(workers) = &self.workers else { return };
        while let Ok(r) = workers.results.try_recv() {
            if r.epoch != self.epoch { continue; }
            self.in_flight.remove(&r.key);
            match r.mesh {
                Some(mesh) => self.ready.push((r.key, r.node, mesh)),
                None => { self.waiting.insert(r.key, Instant::now()); }
            }
        }
    }

    fn finish(&mut self, planets: &[Planet], _viewer: V3, created: Vec<(String, ChunkNode, ChunkMesh)>, waiting: usize, build_ms: f64) -> StreamUpdate {
        let wanted = &self.cache.as_ref().unwrap().1;
        for (key, node, mesh) in &created {
            self.live.insert(key.clone(), LiveChunk { node: *node, triangles: mesh.triangles });
        }

        // Drop stale chunks whose ground is fully covered by live wanted chunks.
        let mut by_face: HashMap<(u32, u8), Vec<&ChunkNode>> = HashMap::new();
        for (n, _) in wanted.nodes.values() { by_face.entry((n.planet, n.face)).or_default().push(n); }
        let mut destroyed = Vec::new();
        for (key, chunk) in &self.live {
            if wanted.nodes.contains_key(key) { continue; }
            let covered = by_face.get(&(chunk.node.planet, chunk.node.face)).map_or(true, |ws| {
                ws.iter().filter(|w| nodes_overlap(w, &chunk.node)).all(|w| self.live.contains_key(&w.key()))
            });
            if covered { destroyed.push(key.clone()); }
        }
        for key in &destroyed { self.live.remove(key); }
        self.built_total += created.len();
        self.destroyed_total += destroyed.len();

        let mut stats = StreamStats {
            wanted: wanted.nodes.len(),
            hidden: wanted.hidden,
            balanced: wanted.balanced,
            split_factor: wanted.split_factor,
            pending: wanted.nodes.keys().filter(|k| !self.live.contains_key(*k)).count(),
            waiting_for_data: waiting,
            built: self.built_total,
            destroyed: self.destroyed_total,
            deepest: vec![0; planets.len()],
            per_planet: vec![0; planets.len()],
            build_ms,
            in_flight: self.in_flight.len(),
            ready: self.ready.len(),
            cancelled: self.cancelled_total,
            ..Default::default()
        };
        for c in self.live.values() {
            stats.live += 1;
            stats.per_planet[c.node.planet as usize] += 1;
            let d = &mut stats.deepest[c.node.planet as usize];
            *d = (*d).max(c.node.level);
            stats.triangles += c.triangles;
            if c.node.stitch != 0 { stats.stitched += 1; }
        }
        self.last_stats = stats.clone();
        StreamUpdate { created, destroyed, stats }
    }

    /// Removes everything; returns the keys that were live.
    pub fn clear(&mut self) -> Vec<String> {
        self.cache = None;
        self.epoch += 1;
        self.in_flight.clear();
        self.ready.clear();
        self.waiting.clear();
        if let Some(w) = &self.workers {
            w.queue.0.lock().unwrap_or_else(|e| e.into_inner()).jobs.clear();
        }
        self.live.drain().map(|(k, _)| k).collect()
    }
}
