//! Planet definitions and the one height function everything agrees on: the chunk builder samples
//! it for vertices, the walker samples it for footing, the ship for landing, and the autopilot for
//! picking a landing site. The surface is a function of the unit direction from the planet's center.
//!
//! Two kinds of terrain:
//! - Procedural (Verdant, Ember, Glacia): seeded noise layers, from continents tens of kilometers
//!   across down to scree and meter-scale bumps.
//! - Earth: real elevation (elevation.rs: SRTM-derived tiles with ocean bathymetry) for everything
//!   the data resolves, with the procedural rock, boulder and bump layers on top for what it
//!   doesn't (the data stops at ~20 m; the ground you walk on needs detail down to ~0.3 m).

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::elevation::{Access, ElevationSource, Loader, Lookup, DEFAULT_MAX_ZOOM, TERRARIUM_URL};
use super::math::*;
use super::noise::Simplex3;

pub type Rgb = [f64; 3];
pub type Rgba = [f64; 4];

/// Deepest quadtree a planet may use, counting the root: enough for sub-meter cells on Earth.
pub const MAX_CHUNK_LEVELS: usize = 21;
/// Existing border grid and default interior: N quads, N+1 vertices per side.
pub const CHUNK_SEGMENTS: u32 = 16;
/// Target size of a leaf cell (world units): the deepest level is the first at least this fine.
pub const LEAF_CELL: f64 = 0.8;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChunkDetail {
    Half { leaf_vertices: f64, levels: f64 },
    Explicit { vertices_per_level: Vec<f64> },
}

/// Resolves and validates a detail setting into per-level vertex counts, leaf first.
pub fn chunk_resolutions(detail: &ChunkDetail) -> Result<Vec<u32>, String> {
    let sizes: Vec<f64> = match detail {
        ChunkDetail::Half { leaf_vertices, levels } => {
            if levels.fract() != 0.0 || !levels.is_finite() || *levels < 1.0 || *levels > MAX_CHUNK_LEVELS as f64 {
                return Err(format!("Chunk levels must be an integer from 1 to {MAX_CHUNK_LEVELS} (including the root)."));
            }
            let mut s: Vec<f64> = (0..*levels as usize).map(|i| (leaf_vertices / 2f64.powi(i as i32)).floor().max(3.0)).collect();
            s[0] = *leaf_vertices;
            s
        }
        ChunkDetail::Explicit { vertices_per_level } => vertices_per_level.clone(),
    };
    if sizes.is_empty() || sizes.len() > MAX_CHUNK_LEVELS || sizes.iter().any(|v| !v.is_finite() || v.fract() != 0.0 || *v < 3.0 || *v > 257.0) {
        return Err(format!("Specify 1–{MAX_CHUNK_LEVELS} levels, each with 3–257 vertices per side."));
    }
    Ok(sizes.into_iter().map(|v| v as u32).collect())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub deep_water: Rgb,
    pub shallow_water: Rgb,
    pub beach: Rgb,
    pub lowland: Rgb,
    pub highland: Rgb,
    pub rock: Rgb,
    pub snow: Rgb,
}

/// Where a planet's heights come from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TerrainSource {
    Procedural,
    /// Real elevation, streamed as tiles (see elevation.rs).
    Earth {
        /// Finest tile zoom (default 13: ~19 m pixels, SRTM's resolution; 15 is the maximum).
        #[serde(default)]
        max_zoom: Option<u8>,
        /// Only the built-in zoom-0 tile: continents, no network.
        #[serde(default)]
        offline: bool,
        /// A `{z}/{x}/{y}` Terrarium tile URL (default: the AWS Terrain Tiles bucket).
        #[serde(default)]
        tile_url: Option<String>,
        /// Directory of SRTM .hgt files to use where present.
        #[serde(default)]
        srtm_dir: Option<String>,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanetDef {
    pub id: String,
    pub name: String,
    pub center: V3,
    /// Mean radius (sea level) in world units (meters: the walker is 1.8 tall).
    pub radius: f64,
    pub seed: u32,
    pub continent_height: f64,
    pub mountain_height: f64,
    pub hill_height: f64,
    pub rock_height: f64,
    pub detail_height: f64,
    pub terrace_step: f64,
    pub continent_frequency: f64,
    pub has_sea: bool,
    pub frozen_sea: bool,
    pub palette: Palette,
    pub atmosphere_color: Rgb,
    pub atmosphere_height: f64,
    pub gravity: f64,
    pub polar_caps: f64,
    #[serde(default)]
    pub chunk_detail: Option<ChunkDetail>,
    #[serde(default)]
    pub terrain: Option<TerrainSource>,
}

/// What the ground is at one spot.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSample {
    /// Terrain height above the mean radius (can be negative under the sea).
    pub terrain: f64,
    /// Where you stand / what is drawn: max(terrain, 0) on a planet with a sea.
    pub surface: f64,
    /// True where the drawn surface is sea (water or ice), not land.
    pub sea: bool,
    /// 0..1: how much of this spot is rocky outcrop (for coloring).
    pub rock: f64,
    /// -1..1: slow patchiness (meadow vs dry grass, dune shades, blue ice...).
    pub patch: f64,
}

/// Highest mountain on Earth (Everest, 8,849 m) with a little headroom.
const EARTH_RELIEF: f64 = 8_900.0;

pub struct Planet {
    pub def: PlanetDef,
    /// Configured vertex counts per level, leaf first (None: the 17-vertex defaults).
    pub sizes: Option<Vec<u32>>,
    noise: Arc<Simplex3>,
    pub elevation: Option<Arc<ElevationSource>>,
    finest: f64,
}

/// Noise shared by every planet for vertex color variation.
fn jitter_noise() -> &'static Simplex3 {
    static N: std::sync::OnceLock<Simplex3> = std::sync::OnceLock::new();
    N.get_or_init(|| Simplex3::new(77))
}
fn color_noise() -> &'static Simplex3 {
    static N: std::sync::OnceLock<Simplex3> = std::sync::OnceLock::new();
    N.get_or_init(|| Simplex3::new(4711))
}

/// How many octaves of a noise layer a mesh with this sample spacing can show: octaves whose
/// features are under ~3 samples across would only alias (the spiky coasts and limbs a coarse
/// chunk gets from sampling full-detail noise), so they are faded out.
fn octaves_for(period: f64, lacunarity: f64, spacing: f64) -> f64 {
    (period / (3.0 * spacing)).ln() / lacunarity.ln() + 1.0
}

impl Planet {
    /// `cache_dir` is where streamed elevation tiles are kept (Earth only).
    pub fn new(def: PlanetDef, default_detail: Option<&ChunkDetail>, cache_dir: Option<PathBuf>) -> Result<Self, String> {
        let detail = def.chunk_detail.as_ref().or(default_detail);
        let sizes = detail.map(chunk_resolutions).transpose()?;
        let elevation = match &def.terrain {
            Some(TerrainSource::Earth { max_zoom, offline, tile_url, srtm_dir }) => {
                let loader = if *offline { Loader::Offline } else {
                    Loader::Http { url: tile_url.clone().unwrap_or_else(|| TERRARIUM_URL.to_string()), cache_dir }
                };
                Some(Arc::new(ElevationSource::new(loader, max_zoom.unwrap_or(DEFAULT_MAX_ZOOM), def.radius, srtm_dir.as_ref().map(PathBuf::from))))
            }
            _ => None,
        };
        let mut p = Planet { noise: Arc::new(Simplex3::new(def.seed)), def, sizes, elevation, finest: 0.0 };
        p.finest = p.compute_finest();
        Ok(p)
    }

    /// Replaces the chunk detail (validated first), keeping the elevation cache.
    pub fn set_detail(&mut self, detail: Option<ChunkDetail>, default_detail: Option<&ChunkDetail>) -> Result<(), String> {
        let sizes = detail.as_ref().or(default_detail).map(chunk_resolutions).transpose()?;
        self.def.chunk_detail = detail;
        self.sizes = sizes;
        self.finest = self.compute_finest();
        Ok(())
    }

    pub fn is_earth(&self) -> bool { self.elevation.is_some() }

    /// Edge length of a quadtree node of this level on the planet's surface (world units).
    pub fn level_world_size(&self, level: u32) -> f64 {
        (2.0 / (1u64 << level) as f64) * self.def.radius * (std::f64::consts::PI / 4.0)
    }

    /// Existing border/default grid spacing at this level (world units).
    pub fn level_spacing(&self, level: u32) -> f64 { self.level_world_size(level) / CHUNK_SEGMENTS as f64 }

    /// Configured deepest level, or the first whose default cells are at most LEAF_CELL across.
    pub fn max_level(&self) -> u32 {
        if let Some(s) = &self.sizes { return s.len() as u32 - 1; }
        ((self.level_world_size(0) / (CHUNK_SEGMENTS as f64 * LEAF_CELL)).log2().ceil() as u32).max(1)
    }

    /// Nominal grid width at a level, including endpoints.
    pub fn chunk_vertices(&self, level: u32) -> u32 {
        match &self.sizes {
            Some(s) => s[(s.len() as i64 - 1 - level as i64).clamp(0, s.len() as i64 - 1) as usize],
            None => CHUNK_SEGMENTS + 1,
        }
    }

    /// Per-level vertex counts, leaf first (for the tools).
    pub fn vertices_per_level(&self) -> Vec<u32> {
        let m = self.max_level();
        (0..=m).map(|j| self.chunk_vertices(m - j)).collect()
    }

    fn compute_finest(&self) -> f64 {
        let level = self.max_level();
        self.level_spacing(level).min(self.level_world_size(level) / (self.chunk_vertices(level) - 1) as f64)
    }

    /// The finest spacing anything samples at: the deepest chunks' grid. The walker's footing
    /// uses it too, so feet meet the ground that is drawn.
    pub fn finest_spacing(&self) -> f64 { self.finest }

    /// Largest height above sea level the terrain can reach (for horizon culling).
    pub fn max_relief(&self) -> f64 {
        let p = &self.def;
        let detail = p.rock_height + p.detail_height * 6.0;
        if self.is_earth() { EARTH_RELIEF + detail } else {
            p.continent_height + p.mountain_height + p.hill_height + detail + p.terrace_step
        }
    }

    /// The lowest ground that can block a view (a sea is flat at the mean radius).
    pub fn lowest_blocking_radius(&self) -> f64 {
        if self.def.has_sea { self.def.radius } else { self.def.radius - self.def.continent_height }
    }

    /// Noise coordinates for a layer whose largest features are `period` world units across.
    fn layer(&self, d: V3, period: f64, offset: f64) -> V3 {
        let f = self.def.radius / period;
        [d[0] * f + offset, d[1] * f - offset * 0.7, d[2] * f + offset * 0.3]
    }

    /// Terrain at the unit direction `d` (from the planet's center). `spacing` is the distance
    /// between the samples being taken (a chunk's grid step): coarse chunks get a smoother,
    /// band-limited version of the same surface, like QuadScape's mips.
    pub fn sample(&self, d: V3, spacing: f64, lk: &mut Lookup) -> SurfaceSample {
        let sp = spacing.max(self.finest);
        match &self.elevation {
            Some(src) => self.sample_earth(src, d, sp, lk),
            None => self.sample_procedural(d, sp),
        }
    }

    /// The procedural layers, from continents (tens of kilometers) and mountain belts kilometers
    /// high, through hills and crags, down to boulders, scree and meter-scale bumps. Rock is not
    /// one layer but a property of the ground: mountain slopes and rough patches of lowland get
    /// crags, boulder fields and stones, and because each of those is band-limited to the mesh,
    /// the rocks appear as you close in on them.
    fn sample_procedural(&self, d: V3, sp: f64) -> SurfaceSample {
        let p = &self.def;
        let n = &*self.noise;
        let f = p.continent_frequency;
        // Warp the continent field a little so coastlines aren't blobby.
        let wx = n.noise(d[0] * 2.3 + 11.0, d[1] * 2.3, d[2] * 2.3) * 0.18;
        let wy = n.noise(d[0] * 2.3, d[1] * 2.3 + 23.0, d[2] * 2.3) * 0.18;
        let continents = n.fbm(d[0] * f + wx, d[1] * f + wy, d[2] * f, 5, 2.0, 0.5, octaves_for(p.radius / f, 2.0, sp)) + 0.08;
        // Land mask: 0 at the coast, 1 well inland (mountains only grow on land).
        let land = smoothstep(0.0, 0.35, continents);
        // Mountain belts: long ridged ranges (crests ~25 km apart, the finest octave ~40 m).
        let g = self.layer(d, 60000.0, 5.3);
        let belt = smoothstep(-0.2, 0.3, n.fbm(g[0], g[1], g[2], 3, 2.0, 0.5, octaves_for(60000.0, 2.0, sp)));
        let k = self.layer(d, 26000.0, 3.1);
        let ridges = n.ridged(k[0], k[1], k[2], 9, octaves_for(26000.0, 2.1, sp));
        let mountains = ridges.powf(2.1) * land * (0.2 + 0.8 * belt);
        let h = self.layer(d, 1800.0, 31.7);
        let hills = n.fbm(h[0], h[1], h[2], 5, 2.1, 0.5, octaves_for(1800.0, 2.1, sp));
        let m = self.layer(d, 900.0, 57.1);
        let patch = n.fbm(m[0], m[1], m[2], 3, 2.0, 0.5, octaves_for(900.0, 2.0, sp));
        let rough = smoothstep(0.02, 0.4, patch) * land;
        let alpine = smoothstep(0.04, 0.3, mountains);
        let rocky = rough.max(alpine);
        let (rocks, boulders, stones, bumps) = self.fine_layers(d, sp, rocky, land);

        let mut terrain = continents * p.continent_height + mountains * p.mountain_height + hills * p.hill_height * (0.25 + 0.75 * land);
        // Mesas: the broad landforms flattened into steps with steep risers (before the crags and
        // bumps go on, so those stay sharp). Only meshes fine enough to hold the risers get them.
        if p.terrace_step > 0.0 && terrain > 0.0 {
            let t = terrain / p.terrace_step;
            let stepped = (t.floor() + smoothstep(0.25, 0.75, t - t.floor())) * p.terrace_step;
            terrain += (stepped - terrain) * 0.8 * (1.0 - smoothstep(8.0, 40.0, sp)) * land;
        }
        terrain += rocks * p.rock_height + boulders * p.detail_height * 2.4 + stones * p.detail_height * 0.5
            + bumps * p.detail_height * (0.3 + 0.5 * land + 0.4 * rocky);
        let rock = clamp(rocks * 1.8 + alpine * 0.55 + boulders * 0.6 + stones * 0.6, 0.0, 1.0);
        if p.has_sea && terrain < 0.0 { return SurfaceSample { terrain, surface: 0.0, sea: true, rock: 0.0, patch }; }
        SurfaceSample { terrain, surface: terrain, sea: false, rock, patch }
    }

    /// Crags (~240 m down to ~12 m), boulders, scree and bumps, band-limited to the mesh.
    fn fine_layers(&self, d: V3, sp: f64, rocky: f64, land: f64) -> (f64, f64, f64, f64) {
        let n = &*self.noise;
        let r = self.layer(d, 240.0, 71.3);
        let crags = if rocky > 0.0 { n.ridged(r[0], r[1], r[2], 5, octaves_for(240.0, 2.1, sp)) } else { 0.0 };
        let rocks = crags.powf(2.5) * rocky;
        // Boulders and hummocks over all land (thicker on rocky ground): mounds a few meters across.
        let o = self.layer(d, 14.0, 91.3);
        let boulder_octaves = octaves_for(14.0, 2.0, sp);
        let lump = if boulder_octaves > 0.0 { n.fbm(o[0], o[1], o[2], 2, 2.0, 0.45, boulder_octaves) } else { 0.0 };
        let boulders = ((lump - 0.12).max(0.0) / 0.88).powf(1.5) * land * (0.35 + 0.65 * rocky);
        // Scree: sharp stones a couple of meters across, only on rocky ground.
        let q = self.layer(d, 2.6, 43.7);
        let stone_octaves = octaves_for(2.6, 2.1, sp);
        let stones = if stone_octaves > 0.0 && rocky > 0.0 { n.ridged(q[0], q[1], q[2], 2, stone_octaves).powi(3) * rocky } else { 0.0 };
        // Meter-scale bumps: tussocks, ripples, lumps of soil.
        let b = self.layer(d, 6.0, 13.9);
        let bump_octaves = octaves_for(6.0, 2.05, sp);
        let bumps = if bump_octaves > 0.0 { n.fbm(b[0], b[1], b[2], 3, 2.05, 0.5, bump_octaves) } else { 0.0 };
        (rocks, boulders, stones, bumps)
    }

    /// Real elevation, plus the procedural small-scale layers (only rock and ground texture the
    /// data is too coarse to hold; they never move a coastline or a summit by more than meters).
    fn sample_earth(&self, src: &ElevationSource, d: V3, sp: f64, lk: &mut Lookup) -> SurfaceSample {
        let p = &self.def;
        let (lat, lon) = dir_to_lat_lon(d);
        let e = src.sample(lat, lon, sp, lk);
        let m = self.layer(d, 900.0, 57.1);
        let patch = self.noise.fbm(m[0], m[1], m[2], 3, 2.0, 0.5, octaves_for(900.0, 2.0, sp));
        if p.has_sea && e.height <= 0.0 {
            return SurfaceSample { terrain: e.height.min(-0.01), surface: 0.0, sea: true, rock: 0.0, patch };
        }
        // Steep ground (from the data's own gradient) is rocky; so are rough patches.
        let steep = smoothstep(0.35, 0.9, e.slope());
        let rocky = steep.max(smoothstep(0.1, 0.45, patch) * 0.35);
        let (rocks, boulders, stones, bumps) = self.fine_layers(d, sp, rocky, 1.0);
        let terrain = e.height + rocks * p.rock_height + boulders * p.detail_height * 2.4 + stones * p.detail_height * 0.5
            + bumps * p.detail_height * (0.8 + 0.4 * rocky);
        let rock = clamp(rocks * 1.8 + steep * 0.6 + boulders * 0.6 + stones * 0.6, 0.0, 1.0);
        if p.has_sea && terrain < 0.0 { return SurfaceSample { terrain, surface: 0.0, sea: true, rock: 0.0, patch }; }
        SurfaceSample { terrain, surface: terrain, sea: false, rock, patch }
    }

    /// Distance from the planet's center to the drawn surface along the unit direction `d`.
    pub fn surface_radius(&self, d: V3, spacing: f64, lk: &mut Lookup) -> f64 {
        self.def.radius + self.sample(d, spacing, lk).surface
    }

    /// Surface normal at direction `d` by central differences on the sphere (`step` in world
    /// units) of the surface band-limited to `spacing`. The tangent frame depends only on `d`, so
    /// any two chunks asking about the same point get exactly the same normal.
    pub fn surface_normal(&self, d: V3, step: f64, spacing: f64, lk: &mut Lookup) -> V3 {
        let up = normalize(d);
        let t1 = any_perpendicular(up);
        let t2 = cross(up, t1);
        let a = self.def.radius;
        let mut at = |o1: f64, o2: f64| {
            let dd = normalize(add(up, add(scale(t1, o1 / a), scale(t2, o2 / a))));
            scale(dd, self.surface_radius(dd, spacing, lk))
        };
        let px = at(step, 0.0);
        let nx = at(-step, 0.0);
        let pz = at(0.0, step);
        let nz = at(0.0, -step);
        let n = normalize(cross(sub(px, nx), sub(pz, nz)));
        if dot(n, up) < 0.0 { scale(n, -1.0) } else { n }
    }

    /// Biome color from height, slope (`up_dot` = dot(surface normal, radial up)), latitude and a
    /// little noise, plus in alpha the rock weight for the shader's textures. `spacing` is the
    /// mesh's sample spacing: a thin band like the beach can only be drawn where the mesh is fine
    /// enough to resolve it, or coarse chunks turn it into big interpolated patches.
    pub fn color(&self, s: &SurfaceSample, up_dot: f64, d: V3, spacing: f64) -> Rgba {
        let jf = self.def.radius / 9.0;
        let jitter = jitter_noise().noise(d[0] * jf, d[1] * jf, d[2] * jf);
        if self.is_earth() { self.earth_color(s, up_dot, d, jitter, spacing) } else { self.procedural_color(s, up_dot, d, jitter, spacing) }
    }

    fn procedural_color(&self, s: &SurfaceSample, up_dot: f64, d: V3, jitter: f64, spacing: f64) -> Rgba {
        let p = &self.def;
        let pal = &p.palette;
        if s.sea {
            let depth = clamp(-s.terrain / (p.continent_height * 0.6), 0.0, 1.0);
            let c = mix(pal.shallow_water, pal.deep_water, depth.sqrt());
            return [c[0], c[1], c[2], 0.0];
        }
        let h = s.terrain;
        let relief = p.continent_height + p.mountain_height;
        let t = clamp(h / relief, 0.0, 1.0);
        let mut c = mix(pal.lowland, pal.highland, smoothstep(0.05, 0.4, t + jitter * 0.05));
        // Patchy ground: lusher and drier stretches (dune shades on Ember, blue ice on Glacia).
        c = mix(c, pal.highland, smoothstep(-0.1, 0.35, s.patch) * 0.45);
        c = self.bare_earth(c, d, spacing);
        // Outcrops show their stone, and Ember's terraces show banded strata on the risers.
        c = mix(c, pal.rock, s.rock * 0.8);
        if p.terrace_step > 0.0 {
            let band = 0.5 + 0.5 * ((h / p.terrace_step) * std::f64::consts::PI * 5.0 + s.patch * 2.0).sin();
            c = mix(c, pal.beach, band * 0.3 * (1.0 - smoothstep(0.85, 0.97, up_dot)));
        }
        if p.has_sea && !p.frozen_sea && h < 6.0 {
            let beach = (1.0 - smoothstep(2.0, 6.0, h)) * (1.0 - smoothstep(12.0, 40.0, spacing));
            c = mix(c, pal.beach, beach);
        }
        // Steep ground is bare rock.
        let steep = 1.0 - smoothstep(0.72, 0.9, up_dot);
        c = mix(c, pal.rock, steep * 0.9);
        // High peaks and polar caps get snow, but not on cliffs.
        let lat = d[1].abs();
        let snow_line = 0.5 - p.polar_caps * 0.4 * smoothstep(0.55, 0.95, lat) + jitter * 0.04;
        let snow = smoothstep(snow_line, snow_line + 0.08, t + p.polar_caps * 0.35 * smoothstep(0.7, 0.98, lat)) * smoothstep(0.62, 0.8, up_dot);
        c = mix(c, pal.snow, snow);
        let v = 1.0 + jitter * 0.07;
        let rock = clamp(s.rock.max(steep), 0.0, 1.0) * (1.0 - snow);
        [c[0] * v, c[1] * v, c[2] * v, rock]
    }

    /// Bare earth showing through in patches tens of meters across, on meshes fine enough to
    /// hold them.
    fn bare_earth(&self, c: Rgb, d: V3, spacing: f64) -> Rgb {
        let fine = 1.0 - smoothstep(8.0, 30.0, spacing);
        if fine <= 0.0 { return c; }
        let k = self.def.radius / 25.0;
        let m = color_noise().noise(d[0] * k, d[1] * k, d[2] * k);
        mix(c, self.def.palette.beach, smoothstep(0.35, 0.75, m) * fine * 0.4)
    }

    /// Earth's biomes from latitude and real elevation: forest and grassland, the subtropical
    /// desert belts, tundra toward the poles, and a snow line that drops from ~5 km in the tropics
    /// to sea level in the Arctic and Antarctic.
    fn earth_color(&self, s: &SurfaceSample, up_dot: f64, d: V3, jitter: f64, spacing: f64) -> Rgba {
        const DESERT: Rgb = [0.80, 0.67, 0.46];
        const TUNDRA: Rgb = [0.46, 0.46, 0.37];
        const SEA_ICE: Rgb = [0.86, 0.9, 0.94];
        let pal = &self.def.palette;
        let (lat, _) = dir_to_lat_lon(d);
        let alat = lat.abs();
        if s.sea {
            let depth = clamp(-s.terrain / 4000.0, 0.0, 1.0);
            let mut c = mix(pal.shallow_water, pal.deep_water, depth.sqrt());
            // Polar pack ice.
            c = mix(c, SEA_ICE, smoothstep(76.0, 82.0, alat + jitter * 2.0));
            return [c[0], c[1], c[2], 0.0];
        }
        let h = s.terrain;
        let mut c = mix(pal.lowland, pal.highland, smoothstep(200.0, 2600.0, h + jitter * 150.0));
        let dry = smoothstep(0.0, 1.0, 1.0 - ((alat - 24.0) / 13.0).abs()) * (0.55 + 0.45 * smoothstep(-0.4, 0.4, s.patch + jitter * 0.3));
        c = mix(c, DESERT, dry);
        c = mix(c, TUNDRA, smoothstep(52.0, 66.0, alat + jitter * 3.0) * 0.75);
        c = mix(c, pal.highland, smoothstep(-0.1, 0.35, s.patch) * 0.25);
        c = self.bare_earth(c, d, spacing);
        c = mix(c, pal.rock, s.rock * 0.8);
        if h < 4.0 {
            let beach = (1.0 - smoothstep(1.5, 4.0, h)) * (1.0 - smoothstep(12.0, 40.0, spacing));
            c = mix(c, pal.beach, beach);
        }
        let steep = 1.0 - smoothstep(0.72, 0.9, up_dot);
        c = mix(c, pal.rock, steep * 0.9);
        let snow_line = 5000.0 - 5400.0 * smoothstep(22.0, 78.0, alat) + jitter * 180.0;
        let snow = smoothstep(snow_line, snow_line + 300.0, h) * smoothstep(0.62, 0.8, up_dot);
        c = mix(c, pal.snow, snow);
        let v = 1.0 + jitter * 0.07;
        let rock = clamp(s.rock.max(steep), 0.0, 1.0) * (1.0 - snow);
        [c[0] * v, c[1] * v, c[2] * v, rock]
    }

    /// A walkable spot near the preferred direction: dry land (not sea, unless the sea is frozen)
    /// with a flat patch around it big enough for the ship. Searches a spiral of directions
    /// around `preferred` (deterministic for a planet) and takes the first good one, or failing
    /// that the flattest dry spot it saw. On Earth the spiral is kilometers, not radians, wide,
    /// and is searched on coarse data first so it touches a handful of tiles, not thousands.
    pub fn find_landing_site(&self, preferred: V3) -> V3 {
        let mut lk = Lookup::new(Access::Block);
        let up = normalize(preferred);
        let t1 = any_perpendicular(up);
        let finest = self.finest;
        let earth = self.is_earth();
        let step_angle = if earth { 1500.0 / self.def.radius } else { (3000.0 / self.def.radius).min(0.03) };
        let search = if earth { 300.0 } else { finest };
        let frozen = self.def.frozen_sea;
        let min_height = if self.def.has_sea && !frozen { 3.0 } else { -1e9 };
        // Level ground in a ring `reach` meters around `d`, sampled at `spacing`.
        let check = |d: V3, spacing: f64, reach: f64, lk: &mut Lookup| -> Option<(f64, f64)> {
            let s = self.sample(d, spacing, lk);
            let walkable = frozen || !s.sea;
            if !walkable || s.surface < min_height { return None; }
            let n = self.surface_normal(d, reach.min(spacing.max(1.5)), spacing, lk);
            let tilt = 1.0 - dot(n, d);
            let side = any_perpendicular(d);
            let mut spread: f64 = 0.0;
            for k in 0..6 {
                let off = rotate_around(side, d, (k as f64 / 6.0) * std::f64::consts::PI * 2.0);
                let dd = normalize(add_scaled(d, off, reach / self.def.radius));
                let ss = self.sample(dd, spacing, lk);
                spread = spread.max(if !frozen && ss.sea { f64::INFINITY } else { (ss.surface - s.surface).abs() });
            }
            Some((tilt, spread))
        };
        let mut best: Option<V3> = None;
        let mut best_score = f64::INFINITY;
        let mut candidates: Vec<(f64, V3)> = Vec::new();
        for i in 0..900 {
            let ang = i as f64 * 2.39996; // golden angle
            let radius = (i as f64).sqrt() * step_angle;
            let axis = rotate_around(t1, up, ang);
            let d = normalize(rotate_around(up, axis, radius));
            let reach = if earth { search } else { 8.0 };
            let Some((tilt, spread)) = check(d, search, reach, &mut lk) else { continue };
            let spread_limit = if earth { 12.0 } else { 1.6 };
            if tilt < 0.03 && spread < spread_limit {
                if !earth { return d; }
                // Nearest first: the spiral runs outward.
                candidates.push((i as f64, d));
                if candidates.len() >= 12 { break; }
            }
            let score = tilt * 40.0 + spread + radius * 2.0;
            if score < best_score { best_score = score; best = Some(d); }
        }
        if earth {
            // Verify the coarse picks, nearest first, on the ground the walker will stand on.
            let mut fine_best: Option<(f64, V3)> = None;
            for (_, d) in candidates.iter().take(12) {
                if let Some((tilt, spread)) = check(*d, finest, 8.0, &mut lk) {
                    if tilt < 0.03 && spread < 1.6 { return *d; }
                    let score = tilt * 40.0 + spread;
                    if fine_best.map_or(true, |(s, _)| score < s) { fine_best = Some((score, *d)); }
                }
            }
            if let Some((_, d)) = fine_best { return d; }
        }
        best.unwrap_or(up)
    }
}

fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let t = clamp(t, 0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// The planets as the TypeScript app defines them (qp_planet.ts).
    pub fn verdant() -> PlanetDef {
        serde_json::from_value(serde_json::json!({
            "id": "verdant", "name": "Verdant", "center": [0, 0, 0], "radius": 100000, "seed": 1337,
            "continentHeight": 700, "mountainHeight": 4200, "hillHeight": 180, "rockHeight": 70, "detailHeight": 1.1, "terraceStep": 0, "continentFrequency": 1.6,
            "hasSea": true, "frozenSea": false,
            "palette": {
                "deepWater": [0.02, 0.09, 0.22], "shallowWater": [0.06, 0.32, 0.45], "beach": [0.78, 0.72, 0.52],
                "lowland": [0.36, 0.52, 0.24], "highland": [0.46, 0.5, 0.3], "rock": [0.5, 0.47, 0.44], "snow": [0.94, 0.95, 0.97]
            },
            "atmosphereColor": [0.42, 0.66, 1.0], "atmosphereHeight": 8000, "gravity": 9.8, "polarCaps": 0.55,
            "chunkDetail": { "mode": "explicit", "verticesPerLevel": [64, 32, 32, 32, 32, 32, 32, 32, 32, 48, 48, 64, 64, 64] }
        })).unwrap()
    }

    pub fn ember() -> PlanetDef {
        let mut e = verdant();
        e.id = "ember".into(); e.name = "Ember".into(); e.center = [520_000.0, 90_000.0, -340_000.0]; e.radius = 72_000.0; e.seed = 4242;
        e.continent_height = 520.0; e.mountain_height = 3500.0; e.hill_height = 150.0; e.rock_height = 90.0; e.detail_height = 1.0;
        e.terrace_step = 45.0; e.continent_frequency = 2.1; e.has_sea = false;
        e
    }

    pub fn earth(offline: bool) -> PlanetDef {
        let mut e = verdant();
        e.id = "earth".into(); e.name = "Earth".into(); e.center = [-18_000_000.0, 2_000_000.0, 9_000_000.0]; e.radius = 6_371_000.0; e.seed = 1969;
        e.rock_height = 10.0; e.detail_height = 0.9;
        e.chunk_detail = Some(ChunkDetail::Explicit { vertices_per_level: [vec![64.0], vec![32.0; 13], vec![48.0; 2], vec![96.0], vec![128.0; 3]].concat() });
        e.terrain = Some(TerrainSource::Earth { max_zoom: None, offline, tile_url: None, srtm_dir: None });
        e
    }

    fn planet(def: PlanetDef) -> Planet { Planet::new(def, None, None).unwrap() }

    #[test]
    fn surface_matches_the_typescript_planets() {
        // Printed by qp_planet.ts sampleSurface before the port.
        let v = planet(verdant());
        let s = v.sample([0.6, 0.48, 0.64], 0.0, &mut Lookup::new(Access::Fallback));
        assert!((s.terrain - -197.53010779684152).abs() < 1e-6, "{s:?}");
        assert!(s.sea && s.surface == 0.0);
        let e = planet(ember());
        let s = e.sample([0.6, -0.48, 0.64], 50.0, &mut Lookup::new(Access::Fallback));
        assert!((s.terrain - 255.58027957627635).abs() < 1e-6, "{s:?}");
        assert!((s.rock - 0.0070306210356206305).abs() < 1e-9);
    }

    #[test]
    fn resolves_chunk_detail_like_the_typescript_config() {
        assert_eq!(chunk_resolutions(&ChunkDetail::Half { leaf_vertices: 64.0, levels: 8.0 }).unwrap(), vec![64, 32, 16, 8, 4, 3, 3, 3]);
        for bad in [0.0, 2.0, 3.5, 258.0, f64::NAN, f64::INFINITY] {
            assert!(chunk_resolutions(&ChunkDetail::Half { leaf_vertices: bad, levels: 8.0 }).is_err());
        }
        for levels in [0.0, 1.5, (MAX_CHUNK_LEVELS + 1) as f64, f64::NAN] {
            assert!(chunk_resolutions(&ChunkDetail::Half { leaf_vertices: 32.0, levels }).is_err());
        }
        assert!(chunk_resolutions(&ChunkDetail::Explicit { vertices_per_level: vec![] }).is_err());
        let mut p = planet(verdant());
        p.set_detail(Some(ChunkDetail::Explicit { vertices_per_level: vec![48.0, 24.0, 12.0, 8.0] }), None).unwrap();
        assert_eq!(p.max_level(), 3);
        assert_eq!((0..4).map(|l| p.chunk_vertices(l)).collect::<Vec<_>>(), vec![8, 12, 24, 48]);
    }

    #[test]
    fn walkable_detail_on_every_planet_including_earth() {
        for def in [verdant(), ember(), earth(true)] {
            let p = planet(def);
            let l = p.max_level();
            let chunk = p.level_world_size(l);
            let cell = chunk / (p.chunk_vertices(l) - 1) as f64;
            assert!(chunk > 8.0 && chunk < 40.0, "{}: {chunk}", p.def.name);
            assert!(cell < 0.5);
            assert_eq!(p.finest_spacing(), cell);
        }
    }

    #[test]
    fn offline_earth_has_real_continents() {
        let p = planet(earth(true));
        let mut lk = Lookup::new(Access::Fallback);
        let at = |lat: f64, lon: f64, lk: &mut Lookup| p.sample(lat_lon_to_dir(lat, lon), 50_000.0, lk);
        assert!(at(0.0, -150.0, &mut lk).sea, "mid-Pacific");
        assert!(at(-15.0, -30.0, &mut lk).sea, "South Atlantic");
        assert!(!at(23.0, 12.0, &mut lk).sea, "Sahara");
        assert!(!at(-25.0, 135.0, &mut lk).sea, "Australia");
        assert!(at(33.0, 88.0, &mut lk).terrain > 3000.0, "Tibet");
        let sahara = at(23.0, 12.0, &mut lk);
        let c = p.color(&sahara, 1.0, lat_lon_to_dir(23.0, 12.0), 50_000.0);
        assert!(c[0] > c[2] + 0.2, "the Sahara is sandy: {c:?}");
    }

    #[test]
    fn finds_flat_dry_landing_sites() {
        for def in [verdant(), ember(), earth(true)] {
            let p = planet(def);
            let sun = normalize([0.55, 0.42, 0.72]);
            let d = p.find_landing_site(sun);
            let mut lk = Lookup::new(Access::Fallback);
            assert!(!p.sample(d, 0.0, &mut lk).sea, "{}", p.def.name);
            assert!(dot(p.surface_normal(d, 1.5, 0.0, &mut lk), d) > 0.9);
        }
    }
}
