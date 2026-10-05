//! `Entropy.QuadPlanet`: Rust-side planet terrain streaming for TypeScript, as `Entropy.Quadscape`
//! is for flat terrain. The addon owns the pipeline, the shader and a "world" uniform; the system
//! here owns the planets, the quadtrees and every chunk: `update` selects and builds chunks and
//! queues them as engine meshes (each with its own small uniform placing it relative to the render
//! origin), and drops the stale ones. Terrain queries (`sample`, `normal`, `findLandingSite`)
//! answer from the same height function the chunks are built from, so a walker's feet meet the
//! drawn ground. See src/heightfield_landscapes/QuadPlanet/mod.rs.

use std::sync::Arc;

use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use serde::{Deserialize, Serialize};

use crate::deno::addon_engine::AddonEngine;
use crate::deno::addon_ops::{AddonContext, BindingConfig, MeshConfig, ResourceType};
use crate::heightfield_landscapes::QuadPlanet::elevation::{Access, Lookup};
use crate::heightfield_landscapes::QuadPlanet::geo::Place;
use crate::heightfield_landscapes::QuadPlanet::math::{dir_to_lat_lon, normalize, V3};
use crate::heightfield_landscapes::QuadPlanet::planet::{ChunkDetail, SurfaceSample};
use crate::heightfield_landscapes::QuadPlanet::city::{tile_uniform, CityStats, LiveTile, Placement};
use crate::heightfield_landscapes::QuadPlanet::streamer::StreamStats;
use crate::heightfield_landscapes::QuadPlanet::{ChunkItem, PlanetInfo, QuadPlanetConfig, QuadPlanetSystem, ITEM_FLOATS};

fn err(e: impl Into<String>) -> JsErrorBox { JsErrorBox::generic(e.into()) }

fn with_system<T>(state: &mut OpState, id: &str, f: impl FnOnce(&mut QuadPlanetSystem) -> Result<T, String>) -> Result<T, JsErrorBox> {
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    let sys = ctx.quadplanets.get_mut(id).ok_or_else(|| err(format!("no QuadPlanet {id:?}")))?;
    f(sys).map_err(err)
}

/// Queues removal of a chunk's mesh and frees its uniform.
fn drop_chunk(ctx: &mut AddonContext, addon_name: &str, key: &str, item: Option<ChunkItem>) {
    ctx.pending_meshes.retain(|(name, config)| !(name == addon_name && config.id.as_deref() == Some(key)));
    ctx.pending_mesh_clears.push((addon_name.to_string(), key.to_string()));
    if let Some(item) = item { ctx.buffers.remove(&item.buffer_id); }
}

fn clear_all(ctx: &mut AddonContext, sys: &mut QuadPlanetSystem) {
    for key in sys.streamer.clear() {
        let item = sys.items.remove(&key);
        drop_chunk(ctx, &sys.addon_name, &key, item);
    }
}

fn drop_city_tile(ctx: &mut AddonContext, addon_name: &str, tile: LiveTile) {
    ctx.pending_meshes.retain(|(name, config)| !(name == addon_name && config.id.as_deref() == Some(tile.mesh_id.as_str())));
    ctx.pending_mesh_clears.push((addon_name.to_string(), tile.mesh_id));
    ctx.buffers.remove(&tile.buffer_id);
}

/// Removes every city tile's mesh (they stream back in on the next update).
fn clear_city(ctx: &mut AddonContext, sys: &mut QuadPlanetSystem) {
    let Some(city) = sys.city.as_mut() else { return };
    let tiles: Vec<LiveTile> = city.live.drain().map(|(_, t)| t).collect();
    for t in tiles { drop_city_tile(ctx, &sys.addon_name, t); }
}

/// Creates a planet system; returns its id. Re-creating an id (a hot reload) replaces it.
#[op2]
#[string]
pub fn op_quadplanet_create(state: &mut OpState, #[string] addon_name: String, #[serde] config: QuadPlanetConfig) -> Result<String, JsErrorBox> {
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    let sys = QuadPlanetSystem::new(addon_name, config, ctx.data_dir.clone()).map_err(err)?;
    let id = sys.id.clone();
    if let Some(mut old) = ctx.quadplanets.remove(&id) { clear_all(ctx, &mut old); clear_city(ctx, &mut old); }
    ctx.quadplanets.insert(id.clone(), sys);
    Ok(id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    viewer: V3,
    #[serde(default)]
    render_origin: Option<V3>,
    #[serde(default)]
    max_builds: Option<f64>,
    #[serde(default)]
    max_ms: Option<f64>,
}

/// Streams around `viewer` within the budget (Infinity for both: everything this frame) and
/// places every chunk relative to `renderOrigin`.
#[op2]
#[serde]
pub fn op_quadplanet_update(state: &mut OpState, #[string] id: String, #[serde] args: UpdateArgs) -> Result<UpdateOut, JsErrorBox> {
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    let mut sys = ctx.quadplanets.remove(&id).ok_or_else(|| err(format!("no QuadPlanet {id:?}")))?;
    let result = update(ctx, &mut sys, args);
    ctx.quadplanets.insert(id, sys);
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOut {
    #[serde(flatten)]
    stats: StreamStats,
    /// Earth's buildings and roads (null without a city layer).
    city: Option<CityStats>,
    settlements: Vec<crate::heightfield_landscapes::QuadPlanet::osm::OsmSettlement>,
}

/// Radius around a mesh's own origin that holds every vertex (12-float vertices, position first),
/// with a little slack: with the origin, the mesh's bounding sphere for frustum culling.
fn local_radius(vertices: &[f32]) -> f32 {
    let r2 = vertices.chunks_exact(crate::heightfield_landscapes::QuadPlanet::mesh::VERTEX_FLOATS)
        .map(|v| v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
        .fold(0.0f32, f32::max);
    r2.sqrt() * 1.01 + 1.0
}

/// A mesh's bounding sphere in render space.
fn render_bounds(origin: V3, radius: f32, render_origin: V3) -> ([f32; 3], f32) {
    ([(origin[0] - render_origin[0]) as f32, (origin[1] - render_origin[1]) as f32, (origin[2] - render_origin[2]) as f32], radius)
}

fn update(ctx: &mut AddonContext, sys: &mut QuadPlanetSystem, args: UpdateArgs) -> Result<UpdateOut, JsErrorBox> {
    let Some(gpu) = ctx.gpu_resources.clone() else { return Err(err("GPU resources not available")) };
    let budget = |v: Option<f64>, d: f64| { let v = v.unwrap_or(d); if v.is_finite() { v.max(0.0) } else { f64::MAX } };
    let max_builds = budget(args.max_builds, 10.0).min(usize::MAX as f64) as usize;
    let max_ms = budget(args.max_ms, 12.0);

    let origin = args.render_origin.unwrap_or(sys.render_origin);
    if origin != sys.render_origin {
        sys.render_origin = origin;
        for (key, item) in &sys.items {
            if let Some(buffer) = ctx.buffers.get(&item.buffer_id) {
                gpu.queue.write_buffer(buffer, 0, bytemuck::cast_slice(&sys.item_uniform(item)));
            }
            ctx.pending_mesh_bounds.push((key.clone(), Some(render_bounds(item.origin, item.radius, origin))));
        }
        if let Some(city) = &sys.city {
            for t in city.live.values() {
                if let Some(buffer) = ctx.buffers.get(&t.buffer_id) {
                    gpu.queue.write_buffer(buffer, 0, bytemuck::cast_slice(&tile_uniform(t.origin, t.basis, origin)));
                }
                ctx.pending_mesh_bounds.push((t.mesh_id.clone(), Some(render_bounds(t.origin, t.radius, origin))));
            }
        }
    }

    let out = sys.streamer.update_background(&sys.planets, args.viewer, max_builds, max_ms);
    let allowed = AddonEngine::is_render_allowed(&sys.addon_name);
    for (key, node, mesh) in out.created {
        let radius = local_radius(&mesh.vertex_data);
        let item = ChunkItem { buffer_id: format!("{}:{key}", sys.id), origin: mesh.origin, tex_origin: sys.tex_origin(node.planet as usize, mesh.origin), radius };
        let (bc, br) = render_bounds(mesh.origin, radius, sys.render_origin);
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&format!("QuadPlanet chunk {key}")),
            size: (ITEM_FLOATS * 4) as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue.write_buffer(&buffer, 0, bytemuck::cast_slice(&sys.item_uniform(&item)));
        ctx.buffers.insert(item.buffer_id.clone(), Arc::new(buffer));
        if allowed {
            ctx.pending_meshes.push((sys.addon_name.clone(), MeshConfig {
                shared_geometry: None,
                bounds: Some([bc[0], bc[1], bc[2], br]),
                id: Some(key.clone()),
                position: [0.0; 3],
                rotation: None,
                scale: None,
                vertex_data: mesh.vertex_data,
                index_data: mesh.index_data,
                pipeline_id: sys.pipeline_id.clone(),
                render_role: None,
                instance_count: Some(1),
                bindings: Some([
                    BindingConfig { group: 2, binding: 0, resource: ResourceType::Buffer { id: sys.world_buffer_id.clone() } },
                    BindingConfig { group: 2, binding: 1, resource: ResourceType::Buffer { id: item.buffer_id.clone() } },
                ].into_iter().chain(sys.extra_bindings.iter().cloned()).collect()),
                physics: None,
                behavior_id: None,
                yumon_id: None,
                is_npc: None,
                player: None,
            }));
        }
        sys.items.insert(key, item);
    }
    for key in out.destroyed {
        let item = sys.items.remove(&key);
        drop_chunk(ctx, &sys.addon_name, &key, item);
    }
    let city = update_city(ctx, sys, &gpu, args.viewer, allowed);
    let settlements = sys.city.as_ref().map(|c| c.live.values().flat_map(|t| t.settlements.clone()).collect()).unwrap_or_default();
    Ok(UpdateOut { stats: out.stats, city, settlements })
}

/// Streams Earth's city tiles around the viewer: each finished tile becomes one mesh (its
/// buildings' boxes and its roads) with a uniform placing its frame relative to the render origin.
fn update_city(ctx: &mut AddonContext, sys: &mut QuadPlanetSystem, gpu: &Arc<crate::core::gpu_resources::GpuResources>, viewer: V3, allowed: bool) -> Option<CityStats> {
    let render_origin = sys.render_origin;
    let city = sys.city.as_mut()?;
    let out = city.update(viewer);
    for t in out.destroyed { drop_city_tile(ctx, &sys.addon_name, t); }
    for (tile, built) in out.created {
        let mesh_id = format!("{}:city:{}:{}:{}", sys.id, tile.z, tile.x, tile.y);
        let buffer_id = format!("{mesh_id}:item");
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(&format!("QuadPlanet city tile {}/{}/{}", tile.z, tile.x, tile.y)),
            size: (ITEM_FLOATS * 4) as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        gpu.queue.write_buffer(&buffer, 0, bytemuck::cast_slice(&tile_uniform(built.origin, built.basis, render_origin)));
        ctx.buffers.insert(buffer_id.clone(), Arc::new(buffer));
        let triangles = built.indices.len() / 3;
        let radius = local_radius(&built.vertices);
        let (bc, br) = render_bounds(built.origin, radius, render_origin);
        if allowed && triangles > 0 {
            ctx.pending_meshes.push((sys.addon_name.clone(), MeshConfig {
                shared_geometry: None,
                bounds: Some([bc[0], bc[1], bc[2], br]),
                id: Some(mesh_id.clone()),
                position: [0.0; 3],
                rotation: None,
                scale: None,
                vertex_data: built.vertices,
                index_data: built.indices,
                pipeline_id: sys.pipeline_id.clone(),
                render_role: None,
                instance_count: Some(1),
                bindings: Some([
                    BindingConfig { group: 2, binding: 0, resource: ResourceType::Buffer { id: sys.world_buffer_id.clone() } },
                    BindingConfig { group: 2, binding: 1, resource: ResourceType::Buffer { id: buffer_id.clone() } },
                ].into_iter().chain(sys.extra_bindings.iter().cloned()).collect()),
                physics: None,
                behavior_id: None,
                yumon_id: None,
                is_npc: None,
                player: None,
            }));
        }
        city.live.insert(tile, LiveTile { mesh_id, buffer_id, radius, origin: built.origin, basis: built.basis, placements: built.placements, settlements: built.settlements, triangles, roads: built.roads, road_lines: built.road_lines });
    }
    Some(city.stats())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildingsArgs {
    position: V3,
    radius: f64,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    limit: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearBuilding {
    distance: f64,
    #[serde(flatten)]
    placement: Placement,
}

/// Earth's buildings (from the city tiles streamed so far) within `radius` of `position`, nearest
/// first: where each stands, which way it faces, its size and the ground under it.
#[op2]
#[serde]
pub fn op_quadplanet_buildings(state: &mut OpState, #[string] id: String, #[serde] args: BuildingsArgs) -> Result<Vec<NearBuilding>, JsErrorBox> {
    with_system(state, &id, |sys| {
        let Some(city) = &sys.city else { return Ok(Vec::new()) };
        let limit = args.limit.filter(|l| l.is_finite()).map(|l| l.max(0.0) as usize).unwrap_or(usize::MAX);
        Ok(city.near(args.position, args.radius.max(0.0), args.kind.as_deref(), limit).into_iter()
            .map(|(distance, p)| NearBuilding { distance, placement: p.clone() }).collect())
    })
}

/// Earth's roads (center lines in latitude/longitude, with their paved widths) from the city
/// tiles streamed so far, near (lat, lon): everything whose extent comes within `radius` meters.
#[op2]
#[serde]
pub fn op_quadplanet_roads(state: &mut OpState, #[string] id: String, lat: f64, lon: f64, radius: f64) -> Result<Vec<crate::heightfield_landscapes::QuadPlanet::city::RoadLine>, JsErrorBox> {
    with_system(state, &id, |sys| {
        let Some(city) = &sys.city else { return Ok(Vec::new()) };
        Ok(city.roads_near(lat, lon, radius.max(0.0)).into_iter().cloned().collect())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleOut {
    #[serde(flatten)]
    sample: SurfaceSample,
    /// Distance from the planet's center to the drawn surface.
    radius: f64,
    lat: f64,
    lon: f64,
}

/// The ground along a direction from a planet's center, at the finest (walkable) detail unless
/// `spacing` asks for a band-limited version. `access` "block" waits for elevation tiles that
/// aren't loaded; otherwise coarser data stands in until they arrive.
#[op2]
#[serde]
pub fn op_quadplanet_sample(state: &mut OpState, #[string] id: String, #[string] planet: String, #[serde] direction: V3, #[string] access: String, spacing: f64) -> Result<SampleOut, JsErrorBox> {
    with_system(state, &id, |sys| {
        let p = &sys.planets[sys.planet_index(&planet)?];
        let d = normalize(direction);
        let mut lk = Lookup::new(if access == "block" { Access::Block } else { Access::Fallback });
        let sample = p.sample(d, spacing, &mut lk);
        let (lat, lon) = dir_to_lat_lon(d);
        Ok(SampleOut { sample, radius: p.def.radius + sample.surface, lat, lon })
    })
}

#[op2]
#[serde]
pub fn op_quadplanet_normal(state: &mut OpState, #[string] id: String, #[string] planet: String, #[serde] direction: V3, step: f64) -> Result<V3, JsErrorBox> {
    with_system(state, &id, |sys| {
        let p = &sys.planets[sys.planet_index(&planet)?];
        Ok(p.surface_normal(normalize(direction), step.max(1e-3), 0.0, &mut Lookup::new(Access::Fallback)))
    })
}

/// A flat, dry spot near `preferred` big enough for the ship. Non-blocking: answers from
/// whatever elevation is cached now, falling back to coarser data while the rest streams in.
#[op2]
#[serde]
pub fn op_quadplanet_landing_site(state: &mut OpState, #[string] id: String, #[string] planet: String, #[serde] preferred: V3) -> Result<V3, JsErrorBox> {
    with_system(state, &id, |sys| {
        let p = &sys.planets[sys.planet_index(&planet)?];
        Ok(p.find_landing_site(preferred))
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    planets: Vec<PlanetInfo>,
    split_factor: f64,
    min_level: u32,
    triangle_budget: usize,
    stats: StreamStats,
    city: Option<CityInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CityInfo {
    planet: String,
    radius: f64,
    max_altitude: f64,
    stats: CityStats,
    house_rule: crate::heightfield_landscapes::QuadPlanet::city::HouseRule,
    /// The last few tiles that couldn't be loaded, and why.
    errors: Vec<String>,
}

#[op2]
#[serde]
pub fn op_quadplanet_info(state: &mut OpState, #[string] id: String) -> Result<SystemInfo, JsErrorBox> {
    with_system(state, &id, |sys| Ok(SystemInfo {
        planets: sys.info(),
        split_factor: sys.streamer.lod.split_factor,
        min_level: sys.streamer.lod.min_level,
        triangle_budget: sys.streamer.triangle_budget,
        stats: sys.streamer.stats().clone(),
        city: sys.city.as_ref().map(|c| CityInfo {
            planet: sys.planets[c.planet].def.name.clone(),
            radius: c.radius,
            max_altitude: c.max_altitude,
            stats: c.stats(),
            house_rule: c.env().rule.clone(),
            errors: c.last_errors.clone(),
        }),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureArgs {
    /// Limit a chunkDetail change to one planet (default: all of them).
    #[serde(default)]
    planet: Option<String>,
    /// Present (even as null, which restores the planets' own/default detail) to change detail.
    #[serde(default, deserialize_with = "present")]
    chunk_detail: Option<Option<ChunkDetail>>,
    #[serde(default)]
    split_factor: Option<f64>,
    #[serde(default)]
    min_level: Option<u32>,
    #[serde(default)]
    triangle_budget: Option<f64>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<ChunkDetail>>, D::Error> {
    Ok(Some(Option::deserialize(d)?))
}

/// Changes detail or LOD settings; a detail change rebuilds the streamed terrain.
#[op2]
pub fn op_quadplanet_configure(state: &mut OpState, #[string] id: String, #[serde] args: ConfigureArgs) -> Result<(), JsErrorBox> {
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    let mut sys = ctx.quadplanets.remove(&id).ok_or_else(|| err(format!("no QuadPlanet {id:?}")))?;
    let result = (|| -> Result<(), String> {
        if let Some(detail) = args.chunk_detail {
            let targets: Vec<usize> = match &args.planet { Some(k) => vec![sys.planet_index(k)?], None => (0..sys.planets.len()).collect() };
            // Validate once before changing anything.
            if let Some(d) = &detail { crate::heightfield_landscapes::QuadPlanet::planet::chunk_resolutions(d)?; }
            let default = sys.default_detail.clone();
            for i in targets { Arc::make_mut(&mut sys.planets)[i].set_detail(detail.clone(), default.as_ref())?; }
            clear_all(ctx, &mut sys);
        }
        if let Some(s) = args.split_factor { sys.streamer.lod.split_factor = s.clamp(0.25, 8.0); sys.streamer.invalidate(); }
        if let Some(m) = args.min_level { sys.streamer.lod.min_level = m; sys.streamer.invalidate(); }
        if let Some(b) = args.triangle_budget { sys.streamer.triangle_budget = b.max(10_000.0) as usize; sys.streamer.invalidate(); }
        Ok(())
    })();
    ctx.quadplanets.insert(id, sys);
    result.map_err(err)
}

/// Removes every chunk (they stream back in on the next update).
#[op2(fast)]
pub fn op_quadplanet_clear(state: &mut OpState, #[string] id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if let Some(mut sys) = ctx.quadplanets.remove(&id) {
            clear_all(ctx, &mut sys);
            clear_city(ctx, &mut sys);
            ctx.quadplanets.insert(id, sys);
        }
    }
}

#[op2(fast)]
pub fn op_quadplanet_destroy(state: &mut OpState, #[string] id: String) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        if let Some(mut sys) = ctx.quadplanets.remove(&id) { clear_all(ctx, &mut sys); clear_city(ctx, &mut sys); }
    }
}

/// OpenStreetMap place search (blocks for the request, cached).
#[op2]
#[serde]
pub fn op_quadplanet_geocode(state: &mut OpState, #[string] id: String, #[string] query: String) -> Result<Vec<Place>, JsErrorBox> {
    with_system(state, &id, |sys| sys.geocoder.search(&query))
}

#[derive(Serialize)]
pub struct PlaceName { name: Option<String> }

/// The OpenStreetMap name of the place at a coordinate, once known (looked up in the background;
/// null until then).
#[op2]
#[serde]
pub fn op_quadplanet_place_name(state: &mut OpState, #[string] id: String, lat: f64, lon: f64) -> Result<PlaceName, JsErrorBox> {
    with_system(state, &id, |sys| Ok(PlaceName { name: sys.geocoder.reverse(lat, lon) }))
}
