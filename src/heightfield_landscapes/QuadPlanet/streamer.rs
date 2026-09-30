//! QuadScape::update for a solar system: every frame, diff the wanted chunk set (all planets)
//! against the live one, build the missing chunks that matter most within a budget (in parallel),
//! and drop stale chunks once their ground is covered by live replacements - so streaming never
//! opens a hole.
//!
//! The wanted set also respects a triangle budget: if the selection would draw more than
//! `triangle_budget` triangles, the split distance is tightened until it fits, so detail follows
//! you from orbit to the ground without ever passing the budget (2M by default).

use std::collections::HashMap;
use std::time::Instant;

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
    /// Milliseconds spent building chunks this update.
    pub build_ms: f64,
}

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
}

impl PlanetStreamer {
    pub fn new(lod: LodSettings, triangle_budget: usize) -> Self {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
        Self { live: HashMap::new(), built_total: 0, destroyed_total: 0, last_stats: StreamStats::default(), cache: None, lod, triangle_budget, threads }
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
        for (key, node, mesh) in &created {
            self.live.insert(key.clone(), LiveChunk { node: *node, triangles: mesh.triangles });
        }
        let build_ms = started.elapsed().as_secs_f64() * 1000.0;

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
        self.live.drain().map(|(k, _)| k).collect()
    }
}
