//! `Entropy.MeshCache`: generated meshes kept on disk (src/helpers/mesh_cache.rs), like a shader
//! cache. The first time a mesh is wanted, the addon builds it and `put`s it; after that (this
//! session or any later one) `createMesh` spawns it straight from the cache on the Rust side,
//! without the geometry ever crossing back into JavaScript. `put` can also make a level of detail:
//! with `simplify`, the mesh is simplified to an error in meters on a background thread, and
//! `status` reads "pending" until it is written.
//!
//! The cache lives under the addon data folder (`<data dir>/mesh-cache/<namespace>/`), shared by
//! every addon; namespaces keep apps apart.

use deno_core::{op2, OpState};
use deno_error::JsErrorBox;
use serde::Deserialize;

use crate::deno::addon_engine::AddonEngine;
use crate::deno::addon_ops::{resolve_addon_root, AddonContext, BindingConfig, MeshConfig};
use crate::helpers::mesh_cache::{cache_at, CacheStats, MeshCache};
use crate::helpers::mesh_simplify::SimplifyParams;
use crate::core::custom_mesh::SharedGeometry;

fn err(e: impl Into<String>) -> JsErrorBox { JsErrorBox::generic(e.into()) }

fn cache(state: &mut OpState) -> Result<std::sync::Arc<MeshCache>, JsErrorBox> {
    let ctx = state.try_borrow::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    Ok(cache_at(cache_root(ctx)))
}

fn floats(bytes: &[u8]) -> Result<Vec<f32>, JsErrorBox> {
    if bytes.len() % 4 != 0 { return Err(err("vertex data must be a Float32Array")); }
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect())
}

fn u32s(bytes: &[u8]) -> Result<Vec<u32>, JsErrorBox> {
    if bytes.len() % 4 != 0 { return Err(err("index data must be a Uint32Array")); }
    Ok(bytes.chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect())
}

/// "ready", "pending" (a background `put` is still simplifying or writing it) or "missing".
#[op2]
#[string]
pub fn op_mesh_cache_status(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<String, JsErrorBox> {
    Ok(cache(state)?.status(&namespace, &key).as_str().to_string())
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PutOptions {
    #[serde(default)]
    simplify: Option<SimplifyOptions>,
    /// Write on a background thread (implied by `simplify`).
    #[serde(default)]
    background: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimplifyOptions {
    /// Largest deviation allowed, in meters (mesh units).
    max_error: f32,
    /// Connected parts smaller than this (bounding box diagonal, meters) are dropped.
    #[serde(default)]
    min_feature: f32,
    /// Stop at this share of the triangles even if the error allows more (default 0: no floor).
    #[serde(default)]
    target_ratio: f32,
}

/// `put` for any thread: the addon op below and the worker isolates' (worker_ops.rs).
pub fn put_mesh(c: &MeshCache, namespace: &str, key: &str, vertices: &[u8], indices: &[u8], meta: String, options: Option<PutOptions>) -> Result<(), String> {
    let options = options.unwrap_or_default();
    let (v, i) = (floats(vertices).map_err(|e| e.to_string())?, u32s(indices).map_err(|e| e.to_string())?);
    match options.simplify {
        Some(s) => {
            if !(s.max_error.is_finite() && s.max_error >= 0.0) { return Err("simplify.maxError must be a number of meters >= 0".into()); }
            let p = SimplifyParams { max_error: s.max_error, min_feature: s.min_feature.max(0.0), target_ratio: s.target_ratio.clamp(0.0, 1.0) };
            c.put_async(namespace, key, v, i, meta, Some(p))
        }
        None if options.background => c.put_async(namespace, key, v, i, meta, None),
        None => c.put(namespace, key, v, i, meta).map(|_| ()),
    }
}

/// Where this addon's mesh cache lives (`<data dir>/mesh-cache`).
pub fn cache_root(ctx: &AddonContext) -> std::path::PathBuf {
    resolve_addon_root(ctx).unwrap_or_else(|| std::path::PathBuf::from("data")).join("mesh-cache")
}

/// Stores a mesh: packed vertices (12 floats each: position, normal, uv, color), u32 indices and
/// a JSON string of the caller's own metadata.
#[op2]
pub fn op_mesh_cache_put(
    state: &mut OpState,
    #[string] namespace: String,
    #[string] key: String,
    #[buffer] vertices: &[u8],
    #[buffer] indices: &[u8],
    #[string] meta: String,
    #[serde] options: Option<PutOptions>,
) -> Result<(), JsErrorBox> {
    let c = cache(state)?;
    forget_geometry(state, &namespace, &key);
    put_mesh(&c, &namespace, &key, vertices, indices, meta, options).map_err(err)
}

/// The caller's metadata for a cached mesh, or null.
#[op2]
#[string]
pub fn op_mesh_cache_meta(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<Option<String>, JsErrorBox> {
    Ok(cache(state)?.get(&namespace, &key).map(|m| m.meta.clone()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshInfo {
    vertex_count: usize,
    triangle_count: usize,
    /// The caller's metadata (JSON text), as stored.
    meta: String,
}

/// A cached mesh's size and metadata, without its geometry; null if it isn't cached.
#[op2]
#[serde]
pub fn op_mesh_cache_info(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<Option<MeshInfo>, JsErrorBox> {
    Ok(cache(state)?.get(&namespace, &key).map(|m| MeshInfo { vertex_count: m.vertices.len() / 12, triangle_count: m.indices.len() / 3, meta: m.meta.clone() }))
}

/// A cached mesh's vertex data as bytes (the JS side views them as a Float32Array), or null.
#[op2]
#[buffer]
pub fn op_mesh_cache_vertices(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<Option<Vec<u8>>, JsErrorBox> {
    Ok(cache(state)?.get(&namespace, &key).map(|m| m.vertices.iter().flat_map(|f| f.to_le_bytes()).collect()))
}

#[op2]
#[buffer]
pub fn op_mesh_cache_indices(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<Option<Vec<u8>>, JsErrorBox> {
    Ok(cache(state)?.get(&namespace, &key).map(|m| m.indices.iter().flat_map(|i| i.to_le_bytes()).collect()))
}

/// Everything `Entropy.Model.createMesh` takes except the geometry, which comes from the cache.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnConfig {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    position: Option<[f32; 3]>,
    #[serde(default)]
    rotation: Option<[f32; 3]>,
    #[serde(default)]
    scale: Option<[f32; 3]>,
    pipeline_id: String,
    #[serde(default)]
    render_role: Option<String>,
    #[serde(default)]
    bindings: Option<Vec<BindingConfig>>,
    /// Instances to draw (default 1). The pipeline's shader places each one from its own data,
    /// e.g. a storage buffer indexed by `@builtin(instance_index)`; 0 draws nothing until
    /// `Entropy.Model.setInstanceCount` raises it.
    #[serde(default)]
    instance_count: Option<u32>,
    /// Bounding sphere [x, y, z, radius] in render space (see Entropy.Model.setBounds).
    #[serde(default)]
    bounds: Option<[f32; 4]>,
}

/// Forgets the shared GPU geometry of `namespace/key` (its cached mesh changed or went away):
/// meshes already drawing it keep it, later spawns upload the new data.
fn forget_geometry(state: &mut OpState, namespace: &str, key: &str) {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        ctx.shared_geometry.remove(&format!("{namespace}/{key}"));
    }
}

/// Spawns a cached mesh as an engine mesh (as `Entropy.Model.createMesh` does with geometry
/// passed in). Returns false, spawning nothing, when the mesh isn't in the cache.
///
/// Every mesh spawned from one cache entry draws the same GPU vertex/index buffers: the first
/// spawn uploads them, later ones (while any of those meshes lives) reuse them without copying
/// the geometry at all.
#[op2]
pub fn op_mesh_cache_create_mesh(state: &mut OpState, #[string] addon_name: String, #[string] namespace: String, #[string] key: String, #[serde] config: SpawnConfig) -> Result<bool, JsErrorBox> {
    let geometry_key = format!("{namespace}/{key}");
    let resident = state.try_borrow::<AddonContext>()
        .and_then(|ctx| ctx.shared_geometry.get(&geometry_key))
        .and_then(std::sync::Weak::upgrade);
    let geometry = match resident {
        Some(g) => g,
        None => {
            let Some(mesh) = cache(state)?.get(&namespace, &key) else { return Ok(false) };
            if !AddonEngine::is_render_allowed(&addon_name) { return Ok(true); }
            let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
            let gpu = ctx.gpu_resources.clone().ok_or_else(|| err("GPU resources not available"))?;
            let g = std::sync::Arc::new(SharedGeometry::upload(&gpu.device, &geometry_key, bytemuck::cast_slice(&mesh.vertices), bytemuck::cast_slice(&mesh.indices)));
            // Drop entries whose meshes are all gone before adding one.
            ctx.shared_geometry.retain(|_, w| w.strong_count() > 0);
            ctx.shared_geometry.insert(geometry_key, std::sync::Arc::downgrade(&g));
            g
        }
    };
    if !AddonEngine::is_render_allowed(&addon_name) { return Ok(true); }
    let ctx = state.try_borrow_mut::<AddonContext>().ok_or_else(|| err("addon context unavailable"))?;
    ctx.pending_meshes.push((addon_name, MeshConfig {
        id: config.id,
        position: config.position.unwrap_or([0.0; 3]),
        rotation: config.rotation,
        scale: config.scale,
        vertex_data: Vec::new(),
        index_data: Vec::new(),
        shared_geometry: Some(geometry),
        bounds: config.bounds,
        pipeline_id: config.pipeline_id,
        render_role: config.render_role,
        instance_count: Some(config.instance_count.unwrap_or(1)),
        bindings: config.bindings,
        physics: None,
        behavior_id: None,
        yumon_id: None,
        is_npc: None,
        player: None,
    }));
    Ok(true)
}

#[op2(fast)]
pub fn op_mesh_cache_remove(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<bool, JsErrorBox> {
    forget_geometry(state, &namespace, &key);
    Ok(cache(state)?.remove(&namespace, &key))
}

#[op2(fast)]
pub fn op_mesh_cache_clear(state: &mut OpState, #[string] namespace: String) -> Result<u32, JsErrorBox> {
    if let Some(ctx) = state.try_borrow_mut::<AddonContext>() {
        let prefix = format!("{namespace}/");
        ctx.shared_geometry.retain(|k, _| !k.starts_with(&prefix));
    }
    cache(state)?.clear(&namespace).map(|n| n as u32).map_err(err)
}

/// Deletes the least recently used meshes in the namespace until it fits in `max_bytes`.
#[op2(fast)]
pub fn op_mesh_cache_prune(state: &mut OpState, #[string] namespace: String, max_bytes: f64) -> Result<u32, JsErrorBox> {
    cache(state)?.prune(&namespace, max_bytes.max(0.0) as u64).map(|n| n as u32).map_err(err)
}

#[op2]
#[serde]
pub fn op_mesh_cache_stats(state: &mut OpState, #[string] namespace: String) -> Result<CacheStats, JsErrorBox> {
    Ok(cache(state)?.stats(&namespace))
}

/// Why the last background `put` of this key failed, or null.
#[op2]
#[string]
pub fn op_mesh_cache_failure(state: &mut OpState, #[string] namespace: String, #[string] key: String) -> Result<Option<String>, JsErrorBox> {
    Ok(cache(state)?.failure(&namespace, &key))
}
