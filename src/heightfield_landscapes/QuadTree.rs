/// Terrain Quadtree
///
/// Terminology:
///   - `width`    = X extent of the heightmap (columns)
///   - `depth`    = Z extent of the heightmap (rows)  ← avoids confusion with vertical height
///   - `altitude` = the sampled Y value at a given (x,z) cell
///
/// LOD strategy
///   - LOD 0 = full resolution (leaf nodes)
///   - LOD 1..N = power-of-two down-samples, kept in a mip-pyramid
///   - Edge rows/columns of every LOD tile are **always sampled from the next-finer mip**
///     so that neighbouring tiles at different LODs share identical border altitudes,
///     eliminating T-junction cracks without any skirt geometry.

use nalgebra::Vector3;

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/// Number of LOD levels built and stored (0 = full res, 3 = coarsest).
pub const LOD_LEVELS: usize = 4;

/// Minimum tile side length in *full-resolution* samples before we stop splitting.
pub const MIN_TILE_SIZE: u32 = 16;

// ---------------------------------------------------------------------------
// Mip pyramid  (power-of-two downsamples of the raw heightmap)
// ---------------------------------------------------------------------------

/// A single level of the mip pyramid.
/// Width/depth are measured in *samples at this LOD's resolution*.
#[derive(Debug, Clone)]
pub struct MipLevel {
    pub lod: usize,
    /// Horizontal sample count at this resolution.
    pub width: u32,
    /// Depth (Z-axis) sample count at this resolution.
    pub depth: u32,
    /// Row-major altitude values (u8, 0..=255).
    pub altitudes: Vec<u8>,
}

impl MipLevel {
    /// Sample altitude, clamping coords to valid range.
    #[inline]
    pub fn sample(&self, x: u32, z: u32) -> u8 {
        let x = x.min(self.width - 1);
        let z = z.min(self.depth - 1);
        self.altitudes[(z * self.width + x) as usize]
    }

    /// Bilinear sample in [0,1]² normalised coordinates.
    pub fn sample_normalised(&self, nx: f32, nz: f32) -> f32 {
        let fx = (nx * (self.width - 1) as f32).max(0.0);
        let fz = (nz * (self.depth - 1) as f32).max(0.0);
        let x0 = fx.floor() as u32;
        let z0 = fz.floor() as u32;
        let tx = fx.fract();
        let tz = fz.fract();

        let a = self.sample(x0, z0) as f32;
        let b = self.sample(x0 + 1, z0) as f32;
        let c = self.sample(x0, z0 + 1) as f32;
        let d = self.sample(x0 + 1, z0 + 1) as f32;

        let top = a + (b - a) * tx;
        let bot = c + (d - c) * tx;
        top + (bot - top) * tz
    }
}

/// Build the full mip pyramid from the base heightmap.
///
/// Each level halves width and depth (rounding up), averaging 2×2 blocks
/// *except* for edge samples which are preserved to guarantee crack-free borders.
pub fn build_mip_pyramid(base: Vec<u8>, width: u32, depth: u32) -> Vec<MipLevel> {
    assert_eq!(
        base.len(),
        (width * depth) as usize,
        "base length must equal width × depth"
    );

    let mut pyramid = Vec::with_capacity(LOD_LEVELS);

    // LOD 0 — original resolution
    pyramid.push(MipLevel {
        lod: 0,
        width,
        depth,
        altitudes: base,
    });

    for lod in 1..LOD_LEVELS {
        let prev = &pyramid[lod - 1];
        let new_w = ((prev.width + 1) / 2).max(2);
        let new_d = ((prev.depth + 1) / 2).max(2);
        let mut data = vec![0u8; (new_w * new_d) as usize];

        for z in 0..new_d {
            for x in 0..new_w {
                // Source pixel corners in the previous mip
                let sx = (x * 2).min(prev.width - 1);
                let sz = (z * 2).min(prev.depth - 1);

                let is_x_edge = x == 0 || x == new_w - 1;
                let is_z_edge = z == 0 || z == new_d - 1;

                let val = if is_x_edge || is_z_edge {
                    // *** Edge preservation ***
                    // Always use the source sample directly so neighbouring
                    // tiles share identical border altitudes.
                    prev.sample(sx, sz)
                } else {
                    // Average the 2×2 block
                    let a = prev.sample(sx, sz) as u16;
                    let b = prev.sample(sx + 1, sz) as u16;
                    let c = prev.sample(sx, sz + 1) as u16;
                    let d = prev.sample(sx + 1, sz + 1) as u16;
                    ((a + b + c + d + 2) / 4) as u8
                };

                data[(z * new_w + x) as usize] = val;
            }
        }

        pyramid.push(MipLevel {
            lod,
            width: new_w,
            depth: new_d,
            altitudes: data,
        });
    }

    pyramid
}

// ---------------------------------------------------------------------------
// Quadtree node
// ---------------------------------------------------------------------------

/// World-space bounds of a quadtree tile, expressed in full-resolution sample coords.
#[derive(Debug, Clone, Copy)]
pub struct TileBounds {
    /// Inclusive minimum X sample index (full-res).
    pub x_min: u32,
    /// Inclusive minimum Z sample index (full-res).
    pub z_min: u32,
    /// Inclusive maximum X sample index (full-res).
    pub x_max: u32,
    /// Inclusive maximum Z sample index (full-res).
    pub z_max: u32,
}

impl TileBounds {
    #[inline]
    pub fn width_samples(&self) -> u32 {
        self.x_max - self.x_min + 1
    }

    #[inline]
    pub fn depth_samples(&self) -> u32 {
        self.z_max - self.z_min + 1
    }

    #[inline]
    pub fn centre_x(&self) -> u32 {
        (self.x_min + self.x_max) / 2
    }

    #[inline]
    pub fn centre_z(&self) -> u32 {
        (self.z_min + self.z_max) / 2
    }

    /// Return true if the *world* position (ignoring Y) falls within this tile.
    /// `world_to_sample` converts world units → full-res sample indices.
    pub fn contains_world(&self, pos: Vector3<f32>, scale: f32) -> bool {
        let sx = (pos.x / scale) as i64;
        let sz = (pos.z / scale) as i64;
        sx >= self.x_min as i64
            && sx <= self.x_max as i64
            && sz >= self.z_min as i64
            && sz <= self.z_max as i64
    }
}

/// Pre-computed altitude range for a tile (used for frustum/occlusion culling later).
#[derive(Debug, Clone, Copy)]
pub struct AltitudeRange {
    pub min: u8,
    pub max: u8,
}

/// A single node in the quadtree.
///
/// Leaf nodes hold:
///   - their assigned LOD level (determines which mip to use for interior samples)
///   - the altitude range of their tile
///
/// Internal nodes hold four children (NW, NE, SW, SE).
#[derive(Debug)]
pub enum QuadNode {
    Leaf(LeafData),
    Internal(Box<InternalData>),
}

#[derive(Debug)]
pub struct LeafData {
    pub bounds: TileBounds,
    pub lod: usize,
    pub altitude_range: AltitudeRange,
}

#[derive(Debug)]
pub struct InternalData {
    pub bounds: TileBounds,
    pub altitude_range: AltitudeRange,
    /// Children in order: [NW, NE, SW, SE]
    pub children: [QuadNode; 4],
}

impl QuadNode {
    pub fn bounds(&self) -> TileBounds {
        match self {
            QuadNode::Leaf(l) => l.bounds,
            QuadNode::Internal(i) => i.bounds,
        }
    }

    pub fn altitude_range(&self) -> AltitudeRange {
        match self {
            QuadNode::Leaf(l) => l.altitude_range,
            QuadNode::Internal(i) => i.altitude_range,
        }
    }

    /// Recursively compute the assigned LOD for the tile that contains `world_pos`.
    /// Returns `None` if the position is outside this node.
    pub fn lod_at(&self, world_pos: Vector3<f32>, scale: f32) -> Option<usize> {
        if !self.bounds().contains_world(world_pos, scale) {
            return None;
        }
        match self {
            QuadNode::Leaf(l) => Some(l.lod),
            QuadNode::Internal(i) => {
                for child in &i.children {
                    if let Some(lod) = child.lod_at(world_pos, scale) {
                        return Some(lod);
                    }
                }
                None
            }
        }
    }

    /// Walk the tree, collecting all leaf tiles visible within `radius` of `viewer`.
    pub fn collect_visible_leaves<'a>(
        &'a self,
        viewer: Vector3<f32>,
        radius: f32,
        scale: f32,
        out: &mut Vec<&'a LeafData>,
    ) {
        let b = self.bounds();
        // Quick AABB reject in XZ plane
        let cx = (b.x_min + b.x_max) as f32 * 0.5 * scale;
        let cz = (b.z_min + b.z_max) as f32 * 0.5 * scale;
        let half_w = b.width_samples() as f32 * 0.5 * scale;
        let half_d = b.depth_samples() as f32 * 0.5 * scale;

        let dx = (viewer.x - cx).abs() - half_w;
        let dz = (viewer.z - cz).abs() - half_d;
        let dist_sq = (dx.max(0.0).powi(2)) + (dz.max(0.0).powi(2));
        if dist_sq > radius * radius {
            return;
        }

        match self {
            QuadNode::Leaf(l) => out.push(l),
            QuadNode::Internal(i) => {
                for child in &i.children {
                    child.collect_visible_leaves(viewer, radius, scale, out);
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Quadtree builder
// ---------------------------------------------------------------------------

/// Builds a `QuadNode` tree.
///
/// `lod_bias_fn` receives the *distance in world units* from the viewer to the
/// tile centre and returns the desired LOD (0 = full detail).  You can swap in
/// any distance-based heuristic without touching the tree logic.
fn build_node(
    bounds: TileBounds,
    pyramid: &[MipLevel],
    depth_budget: usize, // remaining split budget
) -> QuadNode {
    let w = bounds.width_samples();
    let d = bounds.depth_samples();

    // Compute altitude range from the finest mip
    let base = &pyramid[0];
    let mut alt_min = u8::MAX;
    let mut alt_max = u8::MIN;
    // Sample corners + centre for a cheap range estimate (exact range on leaf)
    let sample_pts = [
        (bounds.x_min, bounds.z_min),
        (bounds.x_max, bounds.z_min),
        (bounds.x_min, bounds.z_max),
        (bounds.x_max, bounds.z_max),
        (bounds.centre_x(), bounds.centre_z()),
    ];
    for (sx, sz) in sample_pts {
        let v = base.sample(sx, sz);
        alt_min = alt_min.min(v);
        alt_max = alt_max.max(v);
    }
    let altitude_range = AltitudeRange {
        min: alt_min,
        max: alt_max,
    };

    // Leaf condition: too small to split further, or budget exhausted
    if depth_budget == 0 || w <= MIN_TILE_SIZE || d <= MIN_TILE_SIZE {
        // Assign LOD inversely proportional to remaining budget
        let lod = (LOD_LEVELS - 1).min(LOD_LEVELS.saturating_sub(depth_budget + 1));
        return QuadNode::Leaf(LeafData {
            bounds,
            lod,
            altitude_range,
        });
    }

    // Split into four quadrants
    let mid_x = bounds.centre_x();
    let mid_z = bounds.centre_z();

    let quadrants = [
        // NW
        TileBounds {
            x_min: bounds.x_min,
            z_min: bounds.z_min,
            x_max: mid_x,
            z_max: mid_z,
        },
        // NE
        TileBounds {
            x_min: mid_x,
            z_min: bounds.z_min,
            x_max: bounds.x_max,
            z_max: mid_z,
        },
        // SW
        TileBounds {
            x_min: bounds.x_min,
            z_min: mid_z,
            x_max: mid_x,
            z_max: bounds.z_max,
        },
        // SE
        TileBounds {
            x_min: mid_x,
            z_min: mid_z,
            x_max: bounds.x_max,
            z_max: bounds.z_max,
        },
    ];

    let [nw, ne, sw, se] = quadrants.map(|q| build_node(q, pyramid, depth_budget - 1));

    let child_min = [nw.altitude_range().min, ne.altitude_range().min, sw.altitude_range().min, se.altitude_range().min]
        .into_iter()
        .min()
        .unwrap();
    let child_max = [nw.altitude_range().max, ne.altitude_range().max, sw.altitude_range().max, se.altitude_range().max]
        .into_iter()
        .max()
        .unwrap();

    QuadNode::Internal(Box::new(InternalData {
        bounds,
        altitude_range: AltitudeRange {
            min: child_min,
            max: child_max,
        },
        children: [nw, ne, sw, se],
    }))
}

// ---------------------------------------------------------------------------
// Top-level terrain structure
// ---------------------------------------------------------------------------

/// The complete terrain representation: a mip pyramid + a static quadtree.
pub struct Terrain {
    /// Full-res width (X, columns).
    pub width: u32,
    /// Full-res depth (Z, rows).
    pub depth: u32,
    /// World-space units per full-res sample.
    pub scale: f32,
    /// Mip pyramid (LOD 0 = full res, LOD N = coarsest).
    pub pyramid: Vec<MipLevel>,
    /// Static quadtree root.
    pub root: QuadNode,
}

impl Terrain {
    /// Construct a terrain from a flat, row-major altitude buffer.
    ///
    /// # Arguments
    /// * `altitudes` – raw `u8` heights, `width × depth` values
    /// * `width`     – number of columns (X axis)
    /// * `depth`     – number of rows    (Z axis) — *not* vertical height
    /// * `scale`     – world units per sample (e.g. 1.0 m/sample)
    pub fn new(altitudes: Vec<u8>, width: u32, depth: u32, scale: f32) -> Self {
        assert!(
            width.is_power_of_two() && depth.is_power_of_two(),
            "width and depth should be powers of two for clean mip-mapping (got {}×{})",
            width, depth
        );

        let pyramid = build_mip_pyramid(altitudes, width, depth);

        // depth_budget drives how many times we split; LOD_LEVELS - 1 splits
        // produce LOD_LEVELS distinct leaf-level assignments.
        let root_bounds = TileBounds {
            x_min: 0,
            z_min: 0,
            x_max: width - 1,
            z_max: depth - 1,
        };
        let root = build_node(root_bounds, &pyramid, LOD_LEVELS - 1);

        Terrain {
            width,
            depth,
            scale,
            pyramid,
            root,
        }
    }

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    /// Sample the altitude (in world Y units) at any world position.
    /// Uses bilinear interpolation on the full-res mip.
    pub fn altitude_at(&self, world_pos: Vector3<f32>) -> f32 {
        let nx = (world_pos.x / (self.scale * (self.width - 1) as f32)).clamp(0.0, 1.0);
        let nz = (world_pos.z / (self.scale * (self.depth - 1) as f32)).clamp(0.0, 1.0);
        self.pyramid[0].sample_normalised(nx, nz) * self.scale
    }

    /// Return the LOD level of the tile covering `world_pos`.
    pub fn lod_at(&self, world_pos: Vector3<f32>) -> Option<usize> {
        self.root.lod_at(world_pos, self.scale)
    }

    /// Gather all leaf tiles within `radius` world-units of `viewer`.
    /// Results are ready for a subsequent mesh-generation pass.
    pub fn visible_leaves(&self, viewer: Vector3<f32>, radius: f32) -> Vec<&LeafData> {
        let mut out = Vec::new();
        self.root
            .collect_visible_leaves(viewer, radius, self.scale, &mut out);
        out
    }

    /// Return the `MipLevel` that should supply *interior* sample data for a
    /// given LOD.  Edge samples must always come from `pyramid[0]`.
    pub fn mip_for_lod(&self, lod: usize) -> &MipLevel {
        &self.pyramid[lod.min(LOD_LEVELS - 1)]
    }

    /// Convert a full-res sample coordinate to world space.
    #[inline]
    pub fn sample_to_world(&self, x: u32, z: u32, altitude: u8) -> Vector3<f32> {
        Vector3::new(
            x as f32 * self.scale,
            altitude as f32 * self.scale,
            z as f32 * self.scale,
        )
    }

    /// Count leaf and internal nodes (useful for diagnostics).
    pub fn node_stats(&self) -> (usize, usize) {
        fn count(node: &QuadNode) -> (usize, usize) {
            match node {
                QuadNode::Leaf(_) => (0, 1),
                QuadNode::Internal(i) => {
                    let (mut int, mut leaf) = (1, 0);
                    for child in &i.children {
                        let (ci, cl) = count(child);
                        int += ci;
                        leaf += cl;
                    }
                    (int, leaf)
                }
            }
        }
        count(&self.root)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn flat_terrain(size: u32, altitude: u8) -> Terrain {
        let data = vec![altitude; (size * size) as usize];
        Terrain::new(data, size, size, 1.0)
    }

    #[test]
    fn test_mip_pyramid_levels() {
        let t = flat_terrain(128, 128);
        assert_eq!(t.pyramid.len(), LOD_LEVELS);
        assert_eq!(t.pyramid[0].width, 128);
        assert_eq!(t.pyramid[1].width, 64);
        assert_eq!(t.pyramid[2].width, 32);
        assert_eq!(t.pyramid[3].width, 16);
    }

    #[test]
    fn test_edge_preservation() {
        // A gradient heightmap — edges must be preserved exactly across mips
        let size = 64u32;
        let mut data = vec![0u8; (size * size) as usize];
        for z in 0..size {
            for x in 0..size {
                data[(z * size + x) as usize] = x as u8;
            }
        }
        let terrain = Terrain::new(data, size, size, 1.0);

        // LOD 1 left edge (x=0) must match LOD 0 left edge
        for z in 0..terrain.pyramid[1].depth {
            assert_eq!(
                terrain.pyramid[1].sample(0, z),
                terrain.pyramid[0].sample(0, z * 2),
                "left edge mismatch at z={}",
                z
            );
        }
    }

    #[test]
    fn test_altitude_query() {
        let t = flat_terrain(64, 100);
        let alt = t.altitude_at(Vector3::new(32.0, 0.0, 32.0));
        assert!((alt - 100.0).abs() < 1.0);
    }

    #[test]
    fn test_lod_assignment() {
        let t = flat_terrain(256, 64);
        let lod = t.lod_at(Vector3::new(10.0, 0.0, 10.0));
        assert!(lod.is_some());
        assert!(lod.unwrap() < LOD_LEVELS);
    }

    #[test]
    fn test_node_stats_nonzero() {
        let t = flat_terrain(256, 64);
        let (internal, leaves) = t.node_stats();
        assert!(internal > 0, "expected internal nodes");
        assert!(leaves > 0, "expected leaf nodes");
        println!("internal={internal} leaves={leaves}");
    }

    #[test]
    fn test_visible_leaves() {
        let t = flat_terrain(256, 64);
        let viewer = Vector3::new(128.0, 0.0, 128.0);
        let visible = t.visible_leaves(viewer, 9999.0);
        assert!(!visible.is_empty());
    }
}