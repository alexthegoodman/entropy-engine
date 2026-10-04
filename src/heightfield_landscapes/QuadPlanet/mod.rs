//! QuadPlanet: the QuadScape quadtree terrain wrapped around whole planets, streamed on the Rust
//! side and exposed to TypeScript as `Entropy.QuadPlanet` (src/deno/quadplanet_ops.rs), the way
//! QuadScape is exposed as `Entropy.Quadscape`.
//!
//! - `planet`: planet definitions and the height function (procedural noise, or Earth's real
//!   elevation from `elevation`).
//! - `quadtree`: six cube-face quadtrees per planet, split by distance, horizon-culled, 2:1
//!   balanced and stitched so neighbouring chunks meet without cracks.
//! - `mesh`: chunk meshes in the engine's vertex layout.
//! - `streamer`: the per-frame diff of wanted and live chunks, built in parallel within a time
//!   budget and a triangle budget.
//! - `elevation`: streamed, cached SRTM-derived elevation tiles (and local .hgt files).
//! - `geo`: OpenStreetMap place search (Nominatim), to anchor Earth to real places.
//! - `mvt`, `osm`: OpenStreetMap vector tiles (buildings and roads, from OpenFreeMap by default).
//! - `city`: those buildings and roads placed on Earth's ground and streamed around the viewer:
//!   a box per building and road ribbons as one mesh per tile, and placements the addon draws
//!   its own models at (houses).
//!
//! The addon supplies the render pipeline and a "world" uniform buffer; each chunk gets its own
//! small uniform (its placement relative to the render origin, see `ITEM_FLOATS`), so chunks stay
//! exact near the camera however far the planet is from the world origin.

pub mod city;
pub mod elevation;
pub mod geo;
pub mod math;
pub mod mesh;
pub mod mvt;
pub mod noise;
pub mod osm;
pub mod planet;
pub mod quadtree;
pub mod streamer;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use self::city::{CityConfig, CityEnv, CityLayer, HouseRule};
use self::geo::Geocoder;
use self::math::*;
use self::planet::{ChunkDetail, Planet, PlanetDef};
use self::quadtree::LodSettings;
use self::streamer::PlanetStreamer;

/// Floats in a chunk's uniform: model matrix (16), tint (4), texture origin (4).
pub const ITEM_FLOATS: usize = 24;
/// The shader's texture noise repeats every this many meters (qp_shader.ts TEX_PERIOD).
pub const TEX_PERIOD: f64 = 1024.0;
/// Default cap on triangles drawn across every planet at once.
pub const DEFAULT_TRIANGLE_BUDGET: usize = 2_000_000;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuadPlanetConfig {
    #[serde(default)]
    pub id: Option<String>,
    pub planets: Vec<PlanetDef>,
    /// Chunk detail for planets without their own.
    #[serde(default)]
    pub default_chunk_detail: Option<ChunkDetail>,
    /// The addon's render pipeline (a "mesh" layout pipeline; see qp_shader.ts).
    pub pipeline_id: String,
    /// Uniform buffer bound at group 2 binding 0 of every chunk; each chunk's own uniform goes at
    /// group 2 binding 1.
    pub world_buffer_id: String,
    #[serde(default)]
    pub split_factor: Option<f64>,
    #[serde(default)]
    pub min_level: Option<u32>,
    #[serde(default)]
    pub triangle_budget: Option<f64>,
    /// Where elevation tiles are cached (default `<data dir>/quadplanet`).
    #[serde(default)]
    pub cache_dir: Option<String>,
    /// A Nominatim endpoint for place search (default the public OpenStreetMap one).
    #[serde(default)]
    pub geocoder_url: Option<String>,
    /// OpenStreetMap buildings and roads on Earth (city.rs); on by default for an Earth planet
    /// that isn't offline.
    #[serde(default)]
    pub city: Option<CityConfig>,
}

/// A live chunk's uniform buffer and where it sits.
pub struct ChunkItem {
    pub buffer_id: String,
    pub origin: V3,
    pub tex_origin: V3,
    /// Every vertex lies within this distance of `origin` (frustum culling).
    pub radius: f32,
}

pub struct QuadPlanetSystem {
    pub id: String,
    pub addon_name: String,
    /// Shared with the streamer's background chunk builders (immutable once built; a detail
    /// change copies on write).
    pub planets: std::sync::Arc<Vec<Planet>>,
    pub streamer: PlanetStreamer,
    pub pipeline_id: String,
    pub world_buffer_id: String,
    pub render_origin: V3,
    pub items: HashMap<String, ChunkItem>,
    pub geocoder: Geocoder,
    pub default_detail: Option<ChunkDetail>,
    pub city: Option<CityLayer>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanetInfo {
    pub id: String,
    pub name: String,
    pub terrain: &'static str,
    pub max_level: u32,
    pub vertices_per_level: Vec<u32>,
    pub max_relief: f64,
    pub finest_spacing: f64,
    pub elevation: Option<elevation::ElevationStats>,
}

impl QuadPlanetSystem {
    pub fn new(addon_name: String, config: QuadPlanetConfig, data_dir: Option<PathBuf>) -> Result<Self, String> {
        if config.planets.is_empty() { return Err("QuadPlanet needs at least one planet.".into()); }
        let cache = config.cache_dir.map(PathBuf::from).or_else(|| Some(data_dir.unwrap_or_else(|| PathBuf::from("data")).join("quadplanet")));
        let planets = config.planets.into_iter()
            .map(|def| Planet::new(def, config.default_chunk_detail.as_ref(), cache.clone()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut lod = LodSettings::default();
        if let Some(s) = config.split_factor { lod.split_factor = s.clamp(0.25, 8.0); }
        if let Some(m) = config.min_level { lod.min_level = m; }
        let city_config = config.city.clone().unwrap_or(CityConfig { enabled: true, tile_url: None, radius: None, max_altitude: None, house: None });
        let city = if !city_config.enabled { None } else {
            planets.iter().position(|p| p.elevation.is_some() && !p.is_offline()).map(|i| {
                let p = &planets[i];
                let env = CityEnv {
                    center: p.def.center,
                    radius: p.def.radius,
                    has_sea: p.def.has_sea,
                    spacing: p.finest_spacing(),
                    elevation: p.elevation.clone().unwrap(),
                    rule: HouseRule::default(),
                };
                CityLayer::new(i, &city_config, env, cache.clone())
            })
        };
        let budget = config.triangle_budget.map(|b| b.max(10_000.0) as usize).unwrap_or(DEFAULT_TRIANGLE_BUDGET);
        Ok(Self {
            id: config.id.unwrap_or_else(|| "quadplanet".into()),
            addon_name,
            planets: std::sync::Arc::new(planets),
            streamer: PlanetStreamer::new(lod, budget),
            pipeline_id: config.pipeline_id,
            world_buffer_id: config.world_buffer_id,
            render_origin: [0.0; 3],
            items: HashMap::new(),
            geocoder: Geocoder::new(config.geocoder_url),
            default_detail: config.default_chunk_detail,
            city,
        })
    }

    /// A planet by id or name (case-insensitive).
    pub fn planet_index(&self, key: &str) -> Result<usize, String> {
        let k = key.to_lowercase();
        self.planets.iter().position(|p| p.def.id.to_lowercase() == k || p.def.name.to_lowercase() == k).ok_or_else(|| {
            format!("Unknown planet {key:?}; try {}", self.planets.iter().map(|p| p.def.name.as_str()).collect::<Vec<_>>().join(", "))
        })
    }

    pub fn info(&self) -> Vec<PlanetInfo> {
        self.planets.iter().map(|p| PlanetInfo {
            id: p.def.id.clone(),
            name: p.def.name.clone(),
            terrain: if p.is_earth() { "earth" } else { "procedural" },
            max_level: p.max_level(),
            vertices_per_level: p.vertices_per_level(),
            max_relief: p.max_relief(),
            finest_spacing: p.finest_spacing(),
            elevation: p.elevation.as_ref().map(|e| e.stats()),
        }).collect()
    }

    /// The chunk's origin relative to its planet, wrapped into the texture noise's period.
    pub fn tex_origin(&self, planet: usize, origin: V3) -> V3 {
        let c = self.planets[planet].def.center;
        let w = |k: usize| { let x = origin[k] - c[k]; x - TEX_PERIOD * (x / TEX_PERIOD).floor() };
        [w(0), w(1), w(2)]
    }

    /// A chunk's uniform: a translation to (origin - render origin), white tint, texture origin.
    pub fn item_uniform(&self, item: &ChunkItem) -> [f32; ITEM_FLOATS] {
        let t = sub(item.origin, self.render_origin);
        [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            t[0] as f32, t[1] as f32, t[2] as f32, 1.0,
            1.0, 1.0, 1.0, 0.0,
            item.tex_origin[0] as f32, item.tex_origin[1] as f32, item.tex_origin[2] as f32, 0.0,
        ]
    }
}
