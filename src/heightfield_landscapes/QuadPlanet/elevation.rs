//! Real-world elevation for Earth-like planets: a streamed, cached pyramid of elevation tiles.
//!
//! The source is the Terrarium encoding of the open "Terrain Tiles" dataset (AWS Open Data,
//! originally Mapzen): 256x256 PNG tiles in the Web Mercator XYZ scheme, zoom 0-15, where each
//! pixel's elevation in meters is `R * 256 + G + B / 256 - 32768`. On land it is mostly SRTM
//! (with GMTED, NED, ETOPO1 and others filling gaps); the oceans carry bathymetry. Its zoom levels
//! are exactly the mip pyramid QuadScape builds by averaging (QuadTree.rs): a chunk samples the
//! zoom whose pixels match its own vertex spacing, so a coarse chunk seen from orbit reads a
//! handful of low-zoom tiles and the ground under your feet reads zoom 13 (~19 m pixels at the
//! equator). Optionally, a directory of SRTM `.hgt` files (1 or 3 arc-seconds) takes over for the
//! finest chunks wherever it has a file.
//!
//! Zoom 0 (one 256x256 tile for the whole world, built from the zoom-1 tiles by
//! scripts/quadplanet_base_tile.mjs) is compiled in, so an Earth planet always has continents and
//! oceans, even offline. Everything else is fetched on background threads and kept
//! on disk (`<cache>/terrarium/z/x/y.png`), so a second visit reads from the cache.
//!
//! Crack-free streaming needs every chunk that samples a point to get the same value there. A
//! value depends only on (point, band limit) and on which tiles are *final*: ready, or failed for
//! good (then the next coarser zoom is used). Chunk building uses [`Access::Gate`]: a sample that
//! touches a tile still in flight marks the build incomplete, and the streamer retries that chunk
//! once the tile has landed - so no chunk is ever built from data a neighbour won't also see.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::Duration;

pub const TILE: usize = 256;
/// Web Mercator stops here; the caps beyond it are blended toward a pole value.
pub const MERCATOR_MAX_LAT: f64 = 85.051_128_78;
pub const TERRARIUM_URL: &str = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/// Zoom 13 is ~19 m per pixel at the equator: SRTM's own resolution.
pub const DEFAULT_MAX_ZOOM: u8 = 13;
const MAX_ZOOM_LIMIT: u8 = 15;
const WORKERS: usize = 6;
const MAX_QUEUE: usize = 2048;
static BASE_TILE_PNG: &[u8] = include_bytes!("terrarium_z0.png");

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct TileId { pub z: u8, pub x: u32, pub y: u32 }

/// Elevations in meters, row-major, row 0 at the tile's north edge.
pub struct Tile { pub heights: Vec<f32> }

impl Tile {
    #[inline]
    fn at(&self, x: usize, y: usize) -> f64 { self.heights[y * TILE + x] as f64 }

    pub fn from_terrarium_png(bytes: &[u8]) -> Result<Tile, String> {
        let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?.to_rgb8();
        if img.width() as usize != TILE || img.height() as usize != TILE {
            return Err(format!("expected a {TILE}x{TILE} tile, got {}x{}", img.width(), img.height()));
        }
        let heights = img.pixels().map(|p| (p[0] as f32 * 256.0 + p[1] as f32 + p[2] as f32 / 256.0) - 32768.0).collect();
        Ok(Tile { heights })
    }
}

/// Where tiles come from.
#[derive(Clone)]
pub enum Loader {
    /// `{z}`/`{x}`/`{y}` URL template, cached on disk under `cache_dir` when set.
    Http { url: String, cache_dir: Option<PathBuf> },
    /// Nothing beyond the built-in zoom-0 tile.
    Offline,
    /// Tiles from a function (tests; synthetic worlds). `None` means the tile doesn't exist.
    Custom(Arc<dyn Fn(TileId) -> Option<Tile> + Send + Sync>),
}

/// How a lookup treats a tile that isn't loaded yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Access {
    /// Request it and use coarser data meanwhile, flagging the lookup `missing` (chunk building:
    /// the result is thrown away and the chunk retried once the tile lands).
    Gate,
    /// Request it and use coarser data meanwhile (the walker's footing, LOD distances, landing
    /// site search - anything on the render/main thread, which must never block on the network).
    Fallback,
    /// Load it now, waiting on the network if need be. Only for callers that are themselves off
    /// the main thread or explicitly want to pay for it (tests; the low-level `sample` op's
    /// opt-in `wait`) - never call this from the per-frame game loop.
    Block,
}

/// Per-caller lookup state: the access mode, whether anything was missing, and the last few
/// tiles touched (a chunk's samples hit the same one or two tiles thousands of times).
pub struct Lookup {
    pub access: Access,
    pub missing: bool,
    recent: Vec<(TileId, Arc<Tile>)>,
}

impl Lookup {
    pub fn new(access: Access) -> Self { Self { access, missing: false, recent: Vec::with_capacity(8) } }
}

enum Slot {
    Pending,
    Ready { tile: Arc<Tile>, used: AtomicU64 },
    Failed,
}

struct Inner {
    loader: Loader,
    slots: RwLock<HashMap<TileId, Slot>>,
    queue: Mutex<Vec<TileId>>,
    wake: Condvar,
    closed: AtomicBool,
    tick: AtomicU64,
    loaded: AtomicUsize,
    failed: AtomicUsize,
    capacity: usize,
    workers_started: AtomicBool,
}

/// Counts for the HUD and the state tool.
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElevationStats { pub resident: usize, pub pending: usize, pub loaded: usize, pub failed: usize, pub max_zoom: u8 }

pub struct ElevationSource {
    inner: Arc<Inner>,
    base: Arc<Tile>,
    pub max_zoom: u8,
    /// Planet radius, for meters per pixel.
    radius: f64,
    /// Mean of the base tile's top and bottom rows: what the polar caps blend toward.
    pole_north: f64,
    pole_south: f64,
    srtm: Option<Srtm>,
}

impl Drop for ElevationSource {
    fn drop(&mut self) {
        self.inner.closed.store(true, Ordering::SeqCst);
        self.inner.wake.notify_all();
    }
}

/// One elevation sample: meters above sea level and the slope (meters per meter, east / north).
#[derive(Clone, Copy, Debug, Default)]
pub struct Elevation { pub height: f64, pub east: f64, pub north: f64 }

impl Elevation {
    pub fn slope(&self) -> f64 { self.east.hypot(self.north) }
}

impl ElevationSource {
    pub fn new(loader: Loader, max_zoom: u8, radius: f64, srtm_dir: Option<PathBuf>) -> Self {
        let base = Arc::new(Tile::from_terrarium_png(BASE_TILE_PNG).expect("built-in zoom-0 elevation tile"));
        let row_mean = |y: usize| (0..TILE).map(|x| base.at(x, y)).sum::<f64>() / TILE as f64;
        let (pole_north, pole_south) = (row_mean(0), row_mean(TILE - 1));
        let inner = Arc::new(Inner {
            loader,
            slots: RwLock::new(HashMap::new()),
            queue: Mutex::new(Vec::new()),
            wake: Condvar::new(),
            closed: AtomicBool::new(false),
            tick: AtomicU64::new(0),
            loaded: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            capacity: 768,
            workers_started: AtomicBool::new(false),
        });
        Self { inner, base, max_zoom: max_zoom.min(MAX_ZOOM_LIMIT), radius, pole_north, pole_south, srtm: srtm_dir.map(Srtm::new) }
    }

    pub fn stats(&self) -> ElevationStats {
        let slots = self.inner.slots.read().unwrap();
        let mut s = ElevationStats { max_zoom: self.max_zoom, ..Default::default() };
        for slot in slots.values() {
            match slot { Slot::Ready { .. } => s.resident += 1, Slot::Pending => s.pending += 1, Slot::Failed => {} }
        }
        s.loaded = self.inner.loaded.load(Ordering::Relaxed);
        s.failed = self.inner.failed.load(Ordering::Relaxed);
        s
    }

    /// True while any requested tile is still in flight.
    pub fn busy(&self) -> bool {
        self.inner.slots.read().unwrap().values().any(|s| matches!(s, Slot::Pending))
    }

    fn circumference(&self) -> f64 { 2.0 * std::f64::consts::PI * self.radius }

    /// Mercator zoom whose pixels are about `spacing` meters at this latitude.
    pub fn zoom_for(&self, lat: f64, spacing: f64) -> u8 {
        let lat = lat.clamp(-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT).to_radians();
        let meters_z0 = self.circumference() * lat.cos() / TILE as f64;
        let z = (meters_z0 / spacing.max(1e-3)).log2().ceil();
        if z.is_nan() || z <= 0.0 { 0 } else { (z as u32).min(self.max_zoom as u32) as u8 }
    }

    /// Elevation at a latitude/longitude (degrees), band-limited to a mesh with vertices
    /// `spacing` meters apart.
    pub fn sample(&self, lat: f64, lon: f64, spacing: f64, lk: &mut Lookup) -> Elevation {
        let cap = lat.abs().min(90.0);
        let mut e = self.sample_mercator(lat.clamp(-MERCATOR_MAX_LAT, MERCATOR_MAX_LAT), lon, spacing, lk);
        if let Some(srtm) = &self.srtm {
            if let Some(h) = srtm.sample(lat, lon, spacing, self.radius) { e = h; }
        }
        if cap > MERCATOR_MAX_LAT - 0.5 {
            // Mercator has no poles: fade the last row into one pole height so the cap is
            // smooth instead of a pinwheel of the edge row's longitudes.
            let pole = if lat > 0.0 { self.pole_north } else { self.pole_south };
            let t = super::math::smoothstep(MERCATOR_MAX_LAT - 0.5, 90.0, cap);
            e.height += (pole - e.height) * t;
            e.east *= 1.0 - t;
            e.north *= 1.0 - t;
        }
        e
    }

    fn sample_mercator(&self, lat: f64, lon: f64, spacing: f64, lk: &mut Lookup) -> Elevation {
        let mut z = self.zoom_for(lat, spacing);
        loop {
            if let Some(e) = self.sample_zoom(z, lat, lon, lk) { return e; }
            if z == 0 { unreachable!("zoom 0 is built in"); }
            z -= 1;
        }
    }

    /// Catmull-Rom (bicubic) interpolation of the pixel centers at zoom `z`, with its analytic
    /// gradient. `None` when a tile it needs isn't available.
    fn sample_zoom(&self, z: u8, lat: f64, lon: f64, lk: &mut Lookup) -> Option<Elevation> {
        let n = (TILE as u64) << z;
        let nf = n as f64;
        let la = lat.to_radians();
        let x = ((lon + 180.0) / 360.0).rem_euclid(1.0) * nf - 0.5;
        let y = (1.0 - (la.tan() + 1.0 / la.cos()).ln() / std::f64::consts::PI) / 2.0 * nf - 0.5;
        let (x0, y0) = (x.floor(), y.floor());
        let (tx, ty) = (x - x0, y - y0);
        let mut grid = [[0.0f64; 4]; 4];
        for (j, row) in grid.iter_mut().enumerate() {
            let py = (y0 as i64 + j as i64 - 1).clamp(0, n as i64 - 1) as u64;
            for (i, v) in row.iter_mut().enumerate() {
                let px = (x0 as i64 + i as i64 - 1).rem_euclid(n as i64) as u64;
                *v = self.pixel(z, px, py, lk)?;
            }
        }
        let (wx, dx) = catmull_rom(tx);
        let (wy, dy) = catmull_rom(ty);
        let (mut h, mut gx, mut gy) = (0.0, 0.0, 0.0);
        for j in 0..4 {
            for i in 0..4 {
                let v = grid[j][i];
                h += v * wx[i] * wy[j];
                gx += v * dx[i] * wy[j];
                gy += v * wx[i] * dy[j];
            }
        }
        // Mercator is conformal: a pixel spans the same ground both ways.
        let meters = self.circumference() * la.cos() / nf;
        Some(Elevation { height: h, east: gx / meters, north: -gy / meters })
    }

    fn pixel(&self, z: u8, px: u64, py: u64, lk: &mut Lookup) -> Option<f64> {
        if z == 0 { return Some(self.base.at(px as usize, py as usize)); }
        let id = TileId { z, x: (px / TILE as u64) as u32, y: (py / TILE as u64) as u32 };
        let tile = self.tile(id, lk)?;
        Some(tile.at((px % TILE as u64) as usize, (py % TILE as u64) as usize))
    }

    fn tile(&self, id: TileId, lk: &mut Lookup) -> Option<Arc<Tile>> {
        if let Some((_, t)) = lk.recent.iter().find(|(k, _)| *k == id) { return Some(t.clone()); }
        let found = self.lookup_or_request(id, lk.access);
        match found {
            Found::Ready(t) => {
                if lk.recent.len() == 8 { lk.recent.remove(0); }
                lk.recent.push((id, t.clone()));
                Some(t)
            }
            Found::Final => None,
            Found::Waiting => {
                if lk.access == Access::Gate { lk.missing = true; }
                None
            }
        }
    }

    fn lookup_or_request(&self, id: TileId, access: Access) -> Found {
        let tick = self.inner.tick.fetch_add(1, Ordering::Relaxed);
        {
            let slots = self.inner.slots.read().unwrap();
            match slots.get(&id) {
                Some(Slot::Ready { tile, used }) => { used.store(tick, Ordering::Relaxed); return Found::Ready(tile.clone()); }
                Some(Slot::Failed) => return Found::Final,
                Some(Slot::Pending) if access != Access::Block => return Found::Waiting,
                _ => {}
            }
        }
        if matches!(self.inner.loader, Loader::Offline) {
            self.inner.slots.write().unwrap().insert(id, Slot::Failed);
            return Found::Final;
        }
        if access == Access::Block {
            // Load it on this thread (via a plain thread: reqwest's blocking client can't run on
            // a Tokio worker, which the engine's main thread is).
            let inner = self.inner.clone();
            let result = std::thread::spawn(move || load_tile(&inner.loader, id)).join().ok().flatten();
            return self.finish(id, result).map(Found::Ready).unwrap_or(Found::Final);
        }
        {
            let mut slots = self.inner.slots.write().unwrap();
            if slots.contains_key(&id) { return Found::Waiting; }
            slots.insert(id, Slot::Pending);
        }
        self.ensure_workers();
        let mut queue = self.inner.queue.lock().unwrap();
        queue.push(id);
        if queue.len() > MAX_QUEUE {
            // The oldest requests are for where the viewer was long ago; forget them (they are
            // re-requested if they are ever wanted again).
            let excess = queue.len() - MAX_QUEUE;
            let stale: Vec<TileId> = queue.drain(..excess).collect();
            let mut slots = self.inner.slots.write().unwrap();
            for s in stale { if matches!(slots.get(&s), Some(Slot::Pending)) { slots.remove(&s); } }
        }
        self.inner.wake.notify_one();
        Found::Waiting
    }

    fn finish(&self, id: TileId, tile: Option<Tile>) -> Option<Arc<Tile>> {
        finish(&self.inner, id, tile)
    }

    fn ensure_workers(&self) {
        if self.inner.workers_started.swap(true, Ordering::SeqCst) { return; }
        for k in 0..WORKERS {
            let inner = self.inner.clone();
            let _ = std::thread::Builder::new().name(format!("quadplanet-tiles-{k}")).spawn(move || worker(inner));
        }
    }

    /// Waits (up to `timeout`) until nothing is in flight; for tests and tools.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let start = std::time::Instant::now();
        while self.busy() {
            if start.elapsed() > timeout { return false; }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }
}

enum Found { Ready(Arc<Tile>), Final, Waiting }

fn finish(inner: &Inner, id: TileId, tile: Option<Tile>) -> Option<Arc<Tile>> {
    let mut slots = inner.slots.write().unwrap();
    let out = match tile {
        Some(t) => {
            let t = Arc::new(t);
            slots.insert(id, Slot::Ready { tile: t.clone(), used: AtomicU64::new(inner.tick.load(Ordering::Relaxed)) });
            inner.loaded.fetch_add(1, Ordering::Relaxed);
            Some(t)
        }
        None => {
            slots.insert(id, Slot::Failed);
            inner.failed.fetch_add(1, Ordering::Relaxed);
            None
        }
    };
    // Least recently used tiles go once over capacity; they reload from the disk cache.
    let ready = slots.values().filter(|s| matches!(s, Slot::Ready { .. })).count();
    if ready > inner.capacity {
        let mut by_age: Vec<(u64, TileId)> = slots.iter().filter_map(|(k, s)| match s {
            Slot::Ready { used, .. } if *k != id => Some((used.load(Ordering::Relaxed), *k)),
            _ => None,
        }).collect();
        by_age.sort_unstable_by_key(|(t, _)| *t);
        for (_, k) in by_age.into_iter().take(ready - inner.capacity * 7 / 8) { slots.remove(&k); }
    }
    out
}

fn worker(inner: Arc<Inner>) {
    loop {
        let id = {
            let mut queue = inner.queue.lock().unwrap();
            loop {
                if inner.closed.load(Ordering::SeqCst) { return; }
                // Newest first: the viewer's latest needs.
                if let Some(id) = queue.pop() { break id; }
                queue = inner.wake.wait_timeout(queue, Duration::from_millis(500)).unwrap().0;
            }
        };
        if !matches!(inner.slots.read().unwrap().get(&id), Some(Slot::Pending)) { continue; }
        let tile = load_tile(&inner.loader, id);
        finish(&inner, id, tile);
    }
}

thread_local! {
    static CLIENT: std::cell::RefCell<Option<reqwest::blocking::Client>> = const { std::cell::RefCell::new(None) };
}

fn load_tile(loader: &Loader, id: TileId) -> Option<Tile> {
    match loader {
        Loader::Offline => None,
        Loader::Custom(f) => f(id),
        Loader::Http { url, cache_dir } => {
            let cached = cache_dir.as_ref().map(|d| d.join("terrarium").join(id.z.to_string()).join(id.x.to_string()).join(format!("{}.png", id.y)));
            if let Some(path) = &cached {
                if let Ok(bytes) = std::fs::read(path) {
                    if let Ok(t) = Tile::from_terrarium_png(&bytes) { return Some(t); }
                    let _ = std::fs::remove_file(path);
                }
            }
            let url = url.replace("{z}", &id.z.to_string()).replace("{x}", &id.x.to_string()).replace("{y}", &id.y.to_string());
            for attempt in 0..2 {
                let bytes = CLIENT.with(|c| {
                    let mut c = c.borrow_mut();
                    let client = c.get_or_insert_with(|| reqwest::blocking::Client::builder()
                        .user_agent(super::geo::USER_AGENT)
                        .timeout(Duration::from_secs(20))
                        .build()
                        .expect("http client"));
                    client.get(&url).send().and_then(|r| r.error_for_status()).and_then(|r| r.bytes())
                });
                match bytes {
                    Ok(bytes) => {
                        let tile = Tile::from_terrarium_png(&bytes).ok()?;
                        if let Some(path) = &cached {
                            if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
                            let _ = std::fs::write(path, &bytes);
                        }
                        return Some(tile);
                    }
                    Err(e) if e.status().is_some() => return None, // 404 and friends: no such tile
                    Err(_) if attempt == 0 => std::thread::sleep(Duration::from_millis(400)),
                    Err(_) => {}
                }
            }
            None
        }
    }
}

/// Catmull-Rom weights for the four samples around fraction `t`, and their derivatives.
fn catmull_rom(t: f64) -> ([f64; 4], [f64; 4]) {
    let t2 = t * t;
    let t3 = t2 * t;
    (
        [
            0.5 * (-t3 + 2.0 * t2 - t),
            0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
            0.5 * (-3.0 * t3 + 4.0 * t2 + t),
            0.5 * (t3 - t2),
        ],
        [
            0.5 * (-3.0 * t2 + 4.0 * t - 1.0),
            0.5 * (9.0 * t2 - 10.0 * t),
            0.5 * (-9.0 * t2 + 8.0 * t + 1.0),
            0.5 * (3.0 * t2 - 2.0 * t),
        ],
    )
}

// --- SRTM .hgt files -------------------------------------------------------------------------

/// A directory of SRTM `.hgt` files (`N27E086.hgt`: big-endian i16 meters, 1201 or 3601 samples
/// a side covering one degree, rows north to south, voids -32768). Used for chunks fine enough to
/// show its resolution, wherever a file exists; anything else comes from the tiles.
struct Srtm {
    dir: PathBuf,
    cells: RwLock<HashMap<(i32, i32), Option<Arc<Hgt>>>>,
}

struct Hgt { n: usize, data: Vec<i16> }

impl Srtm {
    fn new(dir: PathBuf) -> Self { Self { dir, cells: RwLock::new(HashMap::new()) } }

    fn cell(&self, lat: i32, lon: i32) -> Option<Arc<Hgt>> {
        if let Some(c) = self.cells.read().unwrap().get(&(lat, lon)) { return c.clone(); }
        let name = format!("{}{:02}{}{:03}.hgt", if lat >= 0 { 'N' } else { 'S' }, lat.abs(), if lon >= 0 { 'E' } else { 'W' }, lon.abs());
        let hgt = read_hgt(&self.dir.join(&name)).or_else(|| read_hgt(&self.dir.join(name.to_lowercase()))).map(Arc::new);
        self.cells.write().unwrap().insert((lat, lon), hgt.clone());
        hgt
    }

    /// Bilinear sample, or `None` where there's no file, a void, or the mesh is too coarse to
    /// benefit (those chunks keep reading the smoother tile pyramid).
    fn sample(&self, lat: f64, lon: f64, spacing: f64, radius: f64) -> Option<Elevation> {
        let (cl, co) = (lat.floor() as i32, lon.floor() as i32);
        let h = self.cell(cl, co)?;
        let deg = 1.0 / (h.n - 1) as f64;
        let meters_n = radius * deg.to_radians();
        if spacing > meters_n * 2.0 { return None; }
        let fx = (lon - co as f64) / deg;
        let fy = ((cl + 1) as f64 - lat) / deg;
        let (x0, y0) = ((fx.floor() as usize).min(h.n - 2), (fy.floor() as usize).min(h.n - 2));
        let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
        let v = |x: usize, y: usize| h.data[y * h.n + x];
        let q = [v(x0, y0), v(x0 + 1, y0), v(x0, y0 + 1), v(x0 + 1, y0 + 1)];
        if q.iter().any(|&s| s == i16::MIN) { return None; }
        let [a, b, c, d] = q.map(|s| s as f64);
        let height = a * (1.0 - tx) * (1.0 - ty) + b * tx * (1.0 - ty) + c * (1.0 - tx) * ty + d * tx * ty;
        let meters_e = meters_n * lat.to_radians().cos().max(1e-6);
        let east = ((b - a) * (1.0 - ty) + (d - c) * ty) / meters_e;
        let north = -((c - a) * (1.0 - tx) + (d - b) * tx) / meters_n;
        Some(Elevation { height, east, north })
    }
}

fn read_hgt(path: &Path) -> Option<Hgt> {
    let bytes = std::fs::read(path).ok()?;
    let count = bytes.len() / 2;
    let n = (count as f64).sqrt().round() as usize;
    if n * n != count || n < 2 { return None; }
    let data = bytes.chunks_exact(2).map(|b| i16::from_be_bytes([b[0], b[1]])).collect();
    Some(Hgt { n, data })
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: f64 = 6_371_000.0;

    #[test]
    fn built_in_tile_has_oceans_and_mountains() {
        let src = ElevationSource::new(Loader::Offline, 13, R, None);
        let mut lk = Lookup::new(Access::Fallback);
        // Mid-Pacific is deep; the Tibetan plateau is high; the Sahara is dry land.
        assert!(src.sample(0.0, -150.0, 1e5, &mut lk).height < -3000.0);
        assert!(src.sample(33.0, 88.0, 1e5, &mut lk).height > 3000.0);
        assert!(src.sample(23.0, 12.0, 1e5, &mut lk).height > 0.0);
        // The polar caps blend toward the last rows: Arctic Ocean in the north, the Antarctic
        // ice sheet in the south. (The built-in tile is made from zoom 1, which has the ice
        // surface; the published zoom-0 tile has bedrock there. scripts/quadplanet_base_tile.mjs)
        assert!(src.pole_north < -1000.0 && src.pole_south > 1500.0, "{} {}", src.pole_north, src.pole_south);
        assert!(src.sample(-80.0, 90.0, 1e5, &mut lk).height > 3000.0, "the East Antarctic plateau");
        assert!(src.sample(72.0, -40.0, 1e5, &mut lk).height > 2500.0, "the Greenland ice sheet");
    }

    #[test]
    fn picks_the_zoom_matching_the_mesh() {
        let src = ElevationSource::new(Loader::Offline, 13, R, None);
        assert_eq!(src.zoom_for(0.0, 200_000.0), 0);
        assert_eq!(src.zoom_for(0.0, 20.0), 13);
        assert!(src.zoom_for(0.0, 1000.0) >= 7 && src.zoom_for(0.0, 1000.0) <= 8);
        // Mercator pixels shrink toward the poles, so the same spacing needs a lower zoom.
        assert!(src.zoom_for(60.0, 1000.0) < src.zoom_for(0.0, 1000.0));
    }

    fn synthetic() -> Loader {
        // Every tile's heights encode its own pixel coordinates, smoothly: a plane in Mercator
        // pixel space. Bicubic interpolation reproduces a plane exactly, across tile seams too.
        Loader::Custom(Arc::new(|id: TileId| {
            let mut heights = vec![0.0f32; TILE * TILE];
            for y in 0..TILE {
                for x in 0..TILE {
                    let gx = (id.x as usize * TILE + x) as f64 / (1u64 << id.z) as f64;
                    let gy = (id.y as usize * TILE + y) as f64 / (1u64 << id.z) as f64;
                    heights[y * TILE + x] = (gx * 0.5 - gy * 0.25) as f32;
                }
            }
            Some(Tile { heights })
        }))
    }

    #[test]
    fn gate_mode_waits_for_tiles_then_agrees_with_block_mode() {
        let src = ElevationSource::new(synthetic(), 12, R, None);
        let mut gate = Lookup::new(Access::Gate);
        let _ = src.sample(10.0, 20.0, 30.0, &mut gate);
        assert!(gate.missing, "first touch requests the tile");
        assert!(src.wait_idle(Duration::from_secs(10)));
        let mut gate = Lookup::new(Access::Gate);
        let a = src.sample(10.0, 20.0, 30.0, &mut gate);
        assert!(!gate.missing);
        let other = ElevationSource::new(synthetic(), 12, R, None);
        let b = other.sample(10.0, 20.0, 30.0, &mut Lookup::new(Access::Block));
        assert_eq!(a.height, b.height);
    }

    #[test]
    fn interpolates_smoothly_across_tile_seams() {
        let src = ElevationSource::new(synthetic(), 6, R, None);
        let mut lk = Lookup::new(Access::Block);
        // Zoom 6 tiles are 5.625 degrees of longitude wide: step across the seam at 5.625.
        let n = (TILE << 6) as f64;
        for k in -20..20 {
            let lon = 5.625 + k as f64 * 0.001;
            let e = src.sample(0.0, lon, 1.0, &mut lk);
            let x = ((lon + 180.0) / 360.0) * n - 0.5;
            let y = n / 2.0 - 0.5;
            let expect = (x * 0.5 - y * 0.25) / 64.0;
            assert!((e.height - expect).abs() < 1e-3, "{lon}: {} vs {expect}", e.height);
        }
    }
}
