/// QuadScape — Runtime rendering and physics streaming for the quadtree terrain.
///
/// Responsibilities:
///   1. Each frame, diff the *previous* visible-leaf set against the *current* one
///      driven by the viewer's world position.
///   2. For **newly visible** tiles → build mesh on CPU, upload to GPU, register
///      Rapier collider (leaf-only, closest to player).
///   3. For **tiles that moved to a coarser LOD or left view** → destroy GPU
///      buffers, remove collider from the physics world.
///   4. All LOD levels get vertex/index data; only LOD 0 leaves get physics.
///
/// Crack prevention recap (from the quadtree):
///   Edge rows/columns always sample from `pyramid[0]` (full resolution).
///   Interior samples use `pyramid[lod]`.  Neighbouring tiles therefore always
///   share identical border vertices regardless of their individual LOD levels.

use std::collections::HashMap;

use nalgebra::{Isometry3, Point3, Vector3};
use rapier3d::prelude::{
    ColliderBuilder, ColliderHandle, ColliderSet, RigidBodyBuilder, RigidBodyHandle,
    RigidBodySet,
};
use wgpu::util::DeviceExt;

use crate::core::vertex::Vertex;

// Pull in everything we built in the quadtree module.
use crate::heightfield_landscapes::QuadTree::{LeafData, MipLevel, Terrain, TileBounds, LOD_LEVELS};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/// Physics colliders are created only for leaf tiles whose LOD is ≤ this value.
/// LOD 0 = highest detail, closest to player.
pub const PHYSICS_LOD_THRESHOLD: usize = 0;

// /// World-unit radius around the viewer within which tiles are considered visible.
// pub const VIEW_RADIUS: f32 = 2048.0;

/// World-unit radius boundaries for each LOD ring.
/// A tile's centre distance from the viewer determines which LOD it renders at.
/// The final entry effectively doubles as VIEW_RADIUS.
pub const LOD_RINGS: [f32; LOD_LEVELS] = [
    128.0,   // LOD 0 — full detail + physics
    256.0,   // LOD 1
    512.0,  // LOD 2
    1024.0,  // LOD 3 — coarsest, matches VIEW_RADIUS
];

// You can now derive VIEW_RADIUS from the rings instead of a separate constant:
pub const VIEW_RADIUS: f32 = LOD_RINGS[LOD_LEVELS - 1];

/// Altitude scale: multiply the raw u8 altitude by this to get world-space Y.
/// Should match `Terrain::height_scale`.
// pub const ALTITUDE_SCALE: f32 = 25.0; // now set dynamically

// ---------------------------------------------------------------------------
// Per-tile GPU + physics state
// ---------------------------------------------------------------------------

/// Everything owned by a single live tile.
pub struct TileGpu {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    /// True when this tile has a live Rapier collider.
    pub has_physics: bool,
    /// Rapier handles — only populated when `has_physics` is true.
    pub rigid_body_handle: Option<RigidBodyHandle>,
    pub collider_handle: Option<ColliderHandle>,
    /// Which LOD level was used to build this tile's mesh.
    pub lod: usize,
}

// ---------------------------------------------------------------------------
// QuadScape
// ---------------------------------------------------------------------------

/// The live scene object.  One per loaded terrain chunk.
pub struct QuadScape {
    /// The static quadtree + mip pyramid.
    pub terrain: Terrain,

    /// All currently-live tiles, keyed by a stable tile ID derived from
    /// (x_min, z_min) at the tile's LOD leaf level.
    live_tiles: HashMap<TileKey, TileGpu>,

    /// The last viewer position used to build the live set.
    last_viewer: Vector3<f32>,
}

/// Stable, hashable identifier for a tile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub x_min: u32,
    pub z_min: u32,
}

impl TileKey {
    fn from_leaf(leaf: &LeafData) -> Self {
        TileKey {
            x_min: leaf.bounds.x_min,
            z_min: leaf.bounds.z_min,
        }
    }
}

// ---------------------------------------------------------------------------
// Mesh generation helpers
// ---------------------------------------------------------------------------

/// Build vertices and indices for a single tile.
///
/// Sampling rules (crack-prevention contract):
///   - Edge rows/columns (x == x_min, x == x_max, z == z_min, z == z_max)
///     → always sampled from `base_mip` (pyramid[0], full resolution).
///   - All interior samples → sampled from `lod_mip` (pyramid[lod]).
///
/// The step size in full-res coordinates is determined by the LOD mip's
/// resolution relative to the tile's full-res extent.
pub fn build_tile_mesh(
    bounds: &TileBounds,
    base_mip: &MipLevel,    // pyramid[0]
    lod_mip: &MipLevel,     // pyramid[lod]
    lod: usize,
    scale: f32,
    altitude_scale: f32,
) -> (Vec<Vertex>, Vec<u32>) {
    // How many samples wide/deep is this tile at the chosen LOD?
    // We clamp to at least 2 so degenerate tiles still produce geometry.
    let tile_full_w = bounds.width_samples();
    let tile_full_d = bounds.depth_samples();

    // Step size in full-res coords per LOD sample.
    let step = (1u32 << lod).max(1);

    // Number of LOD samples spanning the tile (interior grid).
    let cols = ((tile_full_w + step - 1) / step + 1).max(2);
    let rows = ((tile_full_d + step - 1) / step + 1).max(2);

    let mut vertices: Vec<Vertex> = Vec::with_capacity((cols * rows) as usize);
    let mut indices: Vec<u32> = Vec::with_capacity(((cols - 1) * (rows - 1) * 6) as usize);

    for row in 0..rows {
        for col in 0..cols {
            // Full-res sample coordinate for this grid position.
            // let full_x = (bounds.x_min + col * step).min(bounds.x_max);
            // let full_z = (bounds.z_min + row * step).min(bounds.z_max);

            // let is_edge = col == 0 || col == cols - 1 || row == 0 || row == rows - 1;

            // let is_edge = col < 2 || col >= cols - 2 || row < 2 || row >= rows - 2; // edge 2 vertices thick at full res

            // let altitude_raw = if is_edge {
            //     // Edge: always full-resolution sample — guarantees no cracks.
            //     base_mip.sample(full_x, full_z)
            // } else {
            //     // Interior: use the LOD mip for a lower sample density.
            //     // Map full-res coords into the LOD mip's coordinate space.
            //     let mip_x = full_x / (1u32 << lod);
            //     let mip_z = full_z / (1u32 << lod);
            //     lod_mip.sample(
            //         mip_x.min(lod_mip.width - 1),
            //         mip_z.min(lod_mip.depth - 1),
            //     )
            // };

            let step = 1 << lod;

            let full_x = (bounds.x_min + col * step).min(bounds.x_max);
            let full_z = (bounds.z_min + row * step).min(bounds.z_max);

            // two full-res rings in world space
            let border = step * 2;

            let is_edge =
                full_x < bounds.x_min + border ||
                full_x >= bounds.x_max.saturating_sub(border) ||
                full_z < bounds.z_min + border ||
                full_z >= bounds.z_max.saturating_sub(border);

            let altitude_raw = if is_edge {
                base_mip.sample(full_x, full_z)
            } else {
                let mip_x = full_x / step;
                let mip_z = full_z / step;
                lod_mip.sample(
                    mip_x.min(lod_mip.width - 1),
                    mip_z.min(lod_mip.depth - 1),
                )
            };

            let world_x = full_x as f32 * scale;
            // let world_y = altitude_raw as f32 * altitude_scale;
            let world_y = altitude_raw as f32 / 65535.0 * altitude_scale;
            let world_z = full_z as f32 * scale;

            // Flat-shading normal — will be overwritten by a normal-map pass
            // later or replaced with smooth normals during the render pass.
            let normal = compute_normal(
                full_x, full_z,
                bounds, base_mip, lod_mip, lod,
                scale, altitude_scale, is_edge,
            );

            let color = if is_edge {
                [1.0, 0.2, 0.2, 1.0] // red border band
            } else {
                [0.7, 0.7, 0.7, 1.0]
            };

            vertices.push(Vertex {
                position: [world_x, world_y, world_z],
                normal,
                tex_coords: [
                    (full_x - bounds.x_min) as f32 / (tile_full_w - 1) as f32,
                    (full_z - bounds.z_min) as f32 / (tile_full_d - 1) as f32,
                ],
                color
            });
        }
    }

    // Standard grid triangulation (two triangles per quad).
    for row in 0..(rows - 1) {
        for col in 0..(cols - 1) {
            let tl = row * cols + col;
            let tr = tl + 1;
            let bl = tl + cols;
            let br = bl + 1;

            // // Triangle 1: TL, BL, TR (upperleft)
            // indices.push(tl);
            // indices.push(bl);
            // indices.push(tr);

            // // Triangle 2: TR, BL, BR (bottomright)
            // indices.push(tr);
            // indices.push(bl);
            // indices.push(br);

            // Alternate triangulation
            indices.push(tl);
            indices.push(bl);
            indices.push(br);

            indices.push(tl);
            indices.push(br);
            indices.push(tr);
        }
    }

    (vertices, indices)
}

/// Compute a smooth central-difference normal for a vertex.
/// Falls back to up-vector at the boundaries.
fn compute_normal(
    full_x: u32,
    full_z: u32,
    bounds: &TileBounds,
    base_mip: &MipLevel,
    lod_mip: &MipLevel,
    lod: usize,
    scale: f32,
    altitude_scale: f32,
    is_edge: bool,
) -> [f32; 3] {
    let sample = |x: u32, z: u32| -> f32 {
        let alt = if is_edge {
            base_mip.sample(x, z)
        } else {
            let mx = (x / (1u32 << lod)).min(lod_mip.width - 1);
            let mz = (z / (1u32 << lod)).min(lod_mip.depth - 1);
            lod_mip.sample(mx, mz)
        };
        alt as f32 * altitude_scale
    };

    let step = scale;

    if full_x == 0
        || full_z == 0
        || full_x >= base_mip.width - 1
        || full_z >= base_mip.depth - 1
    {
        return [0.0, 1.0, 0.0];
    }

    let hL = sample(full_x - 1, full_z);
    let hR = sample(full_x + 1, full_z);
    let hD = sample(full_x, full_z - 1);
    let hU = sample(full_x, full_z + 1);

    let nx = (hL - hR) / (2.0 * step);
    let nz = (hD - hU) / (2.0 * step);
    let ny = 1.0_f32;
    let len = (nx * nx + ny * ny + nz * nz).sqrt().max(1e-6);
    [nx / len, ny / len, nz / len]
}

/// Upload a mesh to GPU and return the resulting `TileGpu` (no physics yet).
fn upload_tile_gpu(
    device: &wgpu::Device,
    vertices: &[Vertex],
    indices: &[u32],
    lod: usize,
) -> TileGpu {
    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("QuadScape Vertex Buffer"),
        contents: bytemuck::cast_slice(vertices),
        usage: wgpu::BufferUsages::VERTEX,
    });

    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("QuadScape Index Buffer"),
        contents: bytemuck::cast_slice(indices),
        usage: wgpu::BufferUsages::INDEX,
    });

    // println!("Upload tile to gpu {:?}", vertices.len());

    TileGpu {
        vertex_buffer,
        index_buffer,
        index_count: indices.len() as u32,
        has_physics: false,
        rigid_body_handle: None,
        collider_handle: None,
        lod,
    }
}

/// Attach a Rapier trimesh collider to an already-uploaded tile.
///
/// Only called for leaf tiles with `lod <= PHYSICS_LOD_THRESHOLD`.
fn attach_physics(
    tile: &mut TileGpu,
    vertices: &[Vertex],
    indices: &[u32],
    world_origin: Vector3<f32>,
    rigid_body_set: &mut RigidBodySet,
    collider_set: &mut ColliderSet,
) {
    let rapier_verts: Vec<Point3<f32>> = vertices
        .iter()
        .map(|v| Point3::new(v.position[0], v.position[1], v.position[2]))
        .collect();

    let rapier_tris: Vec<[u32; 3]> = indices
        .chunks_exact(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect();

    let rb = RigidBodyBuilder::fixed()
        .position(Isometry3::translation(
            world_origin.x,
            world_origin.y,
            world_origin.z,
        ))
        .build();
    let rb_handle = rigid_body_set.insert(rb);

    let collider = ColliderBuilder::trimesh(rapier_verts, rapier_tris)
        .friction(0.85)
        .restitution(0.1)
        .build();

    let col_handle = collider_set.insert_with_parent(collider, rb_handle, rigid_body_set);

    tile.has_physics = true;
    tile.rigid_body_handle = Some(rb_handle);
    tile.collider_handle = Some(col_handle);
}

/// Remove a tile's collider and rigid body from the physics world.
fn detach_physics(
    tile: &mut TileGpu,
    rigid_body_set: &mut RigidBodySet,
    collider_set: &mut ColliderSet,
) {
    if let Some(col_handle) = tile.collider_handle.take() {
        collider_set.remove(col_handle, &mut Default::default(), rigid_body_set, true);
    }
    if let Some(rb_handle) = tile.rigid_body_handle.take() {
        rigid_body_set.remove(
            rb_handle,
            &mut Default::default(), // islands
            collider_set,
            &mut Default::default(), // impulse joints
            &mut Default::default(), // multibody joints
            true,
        );
    }
    tile.has_physics = false;
}

// ---------------------------------------------------------------------------
// QuadScape implementation
// ---------------------------------------------------------------------------

impl QuadScape {
    /// Create a new QuadScape from an already-built `Terrain`.
    pub fn new(terrain: Terrain) -> Self {
        QuadScape {
            terrain,
            live_tiles: HashMap::new(),
            last_viewer: Vector3::zeros(),
        }
    }

    // ------------------------------------------------------------------
    // Main per-frame update
    // ------------------------------------------------------------------

    /// Call once per frame (or whenever the viewer moves meaningfully).
    ///
    /// This diffs the desired tile set against the current live set and:
    ///   - Streams **in** new tiles (GPU upload + optional physics).
    ///   - Streams **out** stale tiles (GPU buffer drop + physics removal).
    ///
    /// `island_id` is forwarded to Rapier for multi-island setups; pass 0
    /// if you only have one physics world.
    pub fn update(
        &mut self,
        viewer: Vector3<f32>,
        device: &wgpu::Device,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
    ) {
        let desired_leaves = self.terrain.visible_leaves(viewer, VIEW_RADIUS);

        // Build desired key set, but override LOD based on distance from viewer.
        let desired_keys: HashMap<TileKey, (&LeafData, usize)> = desired_leaves
            .iter()
            .map(|l| {
                let cx = (l.bounds.x_min + l.bounds.x_max) as f32 * 0.5 * self.terrain.base_scale;
                let cz = (l.bounds.z_min + l.bounds.z_max) as f32 * 0.5 * self.terrain.base_scale;
                let dx = viewer.x - cx;
                let dz = viewer.z - cz;
                let dist = (dx * dx + dz * dz).sqrt();

                // Pick the finest LOD ring the tile's centre falls within.
                let lod = LOD_RINGS
                    .iter()
                    .position(|&ring_radius| dist <= ring_radius)
                    .unwrap_or(LOD_LEVELS - 1);

                (TileKey::from_leaf(l), (*l, lod))
            })
            .collect();

        // --- Stream out stale tiles ---
        let keys_to_remove: Vec<TileKey> = self
            .live_tiles
            .keys()
            .filter(|k| !desired_keys.contains_key(k))
            .copied()
            .collect();

        for key in keys_to_remove {
            if let Some(mut tile) = self.live_tiles.remove(&key) {
                if tile.has_physics {
                    detach_physics(&mut tile, rigid_body_set, collider_set);
                }
            }
        }

        // --- Stream in new tiles, or rebuild if LOD changed ---
        for (key, (leaf, lod)) in &desired_keys {
            // If the tile is already live at the same LOD, nothing to do.
            if let Some(existing) = self.live_tiles.get(key) {
                if existing.lod == *lod {
                    continue;
                }
                // LOD changed (player moved between rings) — rebuild the tile.
                if let Some(mut old) = self.live_tiles.remove(key) {
                    if old.has_physics {
                        detach_physics(&mut old, rigid_body_set, collider_set);
                    }
                }
            }

            let base_mip = &self.terrain.pyramid[0];
            let lx = LOD_LEVELS - 1;
            let ix = lod.min(&lx);
            let lod_mip = &self.terrain.pyramid[*ix];

            let (vertices, indices) = build_tile_mesh(
                &leaf.bounds,
                base_mip,
                lod_mip,
                *lod,
                self.terrain.base_scale,
                self.terrain.height_scale,
            );

            let mut tile_gpu = upload_tile_gpu(device, &vertices, &indices, *lod);

            if *lod <= PHYSICS_LOD_THRESHOLD {
                let origin = Vector3::new(
                    leaf.bounds.x_min as f32 * self.terrain.base_scale,
                    0.0,
                    leaf.bounds.z_min as f32 * self.terrain.base_scale,
                );
                attach_physics(
                    &mut tile_gpu,
                    &vertices,
                    &indices,
                    origin,
                    rigid_body_set,
                    collider_set,
                );
            }

            self.live_tiles.insert(*key, tile_gpu);
        }

        self.last_viewer = viewer;
    }

    // ------------------------------------------------------------------
    // Render helpers
    // ------------------------------------------------------------------

    /// Iterate all live tiles for submission to a render pass.
    ///
    /// Tiles are yielded in no guaranteed order — sort by LOD or distance
    /// in the render loop if you need front-to-back or LOD-ordered draws.
    pub fn iter_tiles(&self) -> impl Iterator<Item = (&TileKey, &TileGpu)> {
        self.live_tiles.iter()
    }

    /// Total live tile count (useful for diagnostics / HUD).
    pub fn live_tile_count(&self) -> usize {
        self.live_tiles.len()
    }

    /// Count of tiles currently with active physics colliders.
    pub fn physics_tile_count(&self) -> usize {
        self.live_tiles.values().filter(|t| t.has_physics).count()
    }

    // ------------------------------------------------------------------
    // Forced full teardown (e.g. on level unload)
    // ------------------------------------------------------------------

    /// Remove every live tile — GPU buffers dropped, all physics detached.
    pub fn teardown(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
    ) {
        for (_, mut tile) in self.live_tiles.drain() {
            if tile.has_physics {
                detach_physics(&mut tile, rigid_body_set, collider_set);
            }
        }
    }

    // ------------------------------------------------------------------
    // Convenience query (delegates to Terrain)
    // ------------------------------------------------------------------

    /// World-space altitude directly beneath `world_pos`, full resolution.
    pub fn altitude_at(&self, world_pos: Vector3<f32>) -> f32 {
        self.terrain.altitude_at(world_pos)
    }
}

// ---------------------------------------------------------------------------
// Wgpu render-pass helper (call inside your encoder loop)
// ---------------------------------------------------------------------------

/// Draw all live QuadScape tiles into `render_pass`.
///
/// Assumes the caller has already set:
///   - the correct pipeline
///   - camera / global bind groups
///
/// Each tile gets its own draw call (vertex + index buffer set).
pub fn draw_quadscape<'rp>(
    scape: &'rp QuadScape,
    render_pass: &mut wgpu::RenderPass<'rp>,
) {
    // println!("Draw quadscape {:?} {:?}", scape.live_tile_count(), scape.physics_tile_count());
    for (_key, tile) in scape.iter_tiles() {
        render_pass.set_vertex_buffer(0, tile.vertex_buffer.slice(..));
        render_pass.set_index_buffer(
            tile.index_buffer.slice(..),
            wgpu::IndexFormat::Uint32,
        );
        render_pass.draw_indexed(0..tile.index_count, 0, 0..1);
    }
}

// // Once, on startup:
// let terrain = Terrain::new(heightmap_bytes, 1024, 1024, 1.0); // from QuadTree
// let mut scape = QuadScape::new(terrain);

// // Every frame:
// scape.update(camera.position, &device, &mut rigid_body_set, &mut collider_set);

// // In your render pass:
// draw_quadscape(&scape, &mut render_pass);

// // On level unload:
// scape.teardown(&mut rigid_body_set, &mut collider_set);