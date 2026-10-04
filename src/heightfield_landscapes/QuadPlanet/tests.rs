//! QuadPlanet's pure tier, ported from the TypeScript suite when the terrain moved to Rust: the
//! cube-sphere quadtree, chunk meshes, streaming and terrain, without a window. The TypeScript
//! suite (examples/studio-bundle/tests/quadplanet.test.ts) keeps the walker/ship simulation; the
//! live tier is tests/quadplanet_live.rs.

use std::collections::{HashMap, HashSet};

use super::elevation::{Access, Lookup};
use super::math::*;
use super::mesh::*;
use super::planet::tests::{earth, ember, verdant};
use super::planet::{ChunkDetail, Planet, PlanetDef, CHUNK_SEGMENTS};
use super::quadtree::*;
use super::streamer::PlanetStreamer;

fn planet(def: PlanetDef) -> Planet { Planet::new(def, None, None).unwrap() }

fn with_detail(def: PlanetDef, detail: ChunkDetail) -> Planet {
    let mut d = def;
    d.chunk_detail = Some(detail);
    planet(d)
}

/// Every level with the border grid's own 17 vertices: the uniform mesh path.
fn uniform17() -> Planet { with_detail(verdant(), ChunkDetail::Explicit { vertices_per_level: vec![17.0; 14] }) }

fn vert(mesh: &ChunkMesh, i: usize) -> V3 {
    let d = &mesh.vertex_data[i * VERTEX_FLOATS..];
    add(mesh.origin, [d[0] as f64, d[1] as f64, d[2] as f64])
}

fn build(p: &Planet, n: &ChunkNode) -> ChunkMesh { build_chunk(p, n).expect("procedural and offline planets never wait for data") }

const NODE: ChunkNode = ChunkNode { planet: 0, face: 4, level: 5, ia: 13, ib: 17, stitch: 0 };

fn eye(p: &Planet) -> V3 {
    let site = p.find_landing_site(normalize([0.55, 0.42, 0.72]));
    let r = p.surface_radius(site, 0.0, &mut Lookup::new(Access::Fallback));
    add_scaled(p.def.center, site, r + 1.7)
}

#[test]
fn every_triangle_winds_counter_clockwise_from_outside() {
    let v = planet(verdant());
    for stitch in [0u8, 0b1111, 0b1111_1111, 0b1010_0101] {
        for p in [&v, &uniform17()] {
            let mesh = build(p, &ChunkNode { stitch, ..NODE });
            for t in 0..mesh.triangles {
                let [a, b, c] = [0, 1, 2].map(|k| vert(&mesh, mesh.index_data[t * 3 + k] as usize));
                assert!(dot(cross(sub(b, a), sub(c, a)), normalize(sub(a, p.def.center))) > 0.0);
            }
        }
    }
}

#[test]
fn stitching_keeps_the_whole_cell_covered() {
    let p = uniform17();
    let area = |stitch: u8| {
        let mesh = build(&p, &ChunkNode { stitch, ..NODE });
        (0..mesh.triangles).map(|t| {
            let [a, b, c] = [0, 1, 2].map(|k| vert(&mesh, mesh.index_data[t * 3 + k] as usize));
            length(cross(sub(b, a), sub(c, a))) / 2.0
        }).sum::<f64>()
    };
    let plain = area(0);
    for stitch in [0b0001, 0b1010, 0b1111] { assert!((area(stitch) - plain).abs() / plain < 0.05); }
}

#[test]
fn same_level_neighbours_share_border_vertices_exactly() {
    let p = uniform17();
    let left = build(&p, &NODE);
    let right = build(&p, &ChunkNode { ia: NODE.ia + 1, ..NODE });
    let v = CHUNK_SEGMENTS as usize + 1;
    for j in 0..v {
        assert_eq!(vert(&left, j * v + CHUNK_SEGMENTS as usize), vert(&right, j * v));
    }
}

#[test]
fn variable_interiors_keep_every_used_border_vertex() {
    let base = uniform17();
    let boundary = |mesh: &ChunkMesh| {
        let used: HashSet<u32> = mesh.index_data.iter().copied().collect();
        let mut out: Vec<String> = used.into_iter().filter_map(|i| {
            let d = &mesh.vertex_data[i as usize * VERTEX_FLOATS..(i as usize + 1) * VERTEX_FLOATS];
            let u = (d[6] as f64 - (d[6] as f64).floor() - 0.001) / 0.99;
            let w = (d[7] as f64 - NODE.level as f64 - 0.001) / 0.99;
            (u.abs().min((1.0 - u).abs()).min(w.abs()).min((1.0 - w).abs()) < 1e-6).then(|| format!("{:?}{:?}", vert(mesh, i as usize), &d[3..]))
        }).collect();
        out.sort();
        out
    };
    for stitch in 0..16u8 {
        let n = ChunkNode { stitch: stitch | 0xf0, ..NODE };
        let original = boundary(&build(&base, &n));
        for vertices in [3.0, 4.0, 8.0, 16.0, 32.0, 64.0] {
            let p = with_detail(verdant(), ChunkDetail::Explicit { vertices_per_level: vec![vertices; 8] });
            let mesh = build(&p, &n);
            assert_eq!(boundary(&mesh), original, "{vertices} vertices, stitch {stitch}");
            assert_eq!(mesh.vertex_count, (vertices as usize - 2).pow(2) + original.len());
            let used: HashSet<u32> = mesh.index_data.iter().copied().collect();
            assert_eq!(used.len(), mesh.vertex_count);
            for t in (0..mesh.index_data.len()).step_by(3) {
                let [a, b, c] = [0, 1, 2].map(|k| vert(&mesh, mesh.index_data[t + k] as usize));
                assert!(dot(cross(sub(b, a), sub(c, a)), sub(a, p.def.center)) > 0.0);
            }
        }
    }
}

#[test]
fn positions_stay_small_and_exact_relative_to_their_origin() {
    let v = planet(verdant());
    let exact = |x: f64| (x as f32) as f64 == x && (x / POSITION_QUANTUM).fract() == 0.0;
    for mesh in [build(&v, &ChunkNode { level: v.max_level(), ia: 13 << 8, ib: 17 << 8, ..NODE }), build(&uniform17(), &NODE)] {
        for o in mesh.origin { assert!(exact(o - o.round())); }
        for i in 0..mesh.vertex_count * VERTEX_FLOATS {
            if i % VERTEX_FLOATS < 3 { assert!(exact(mesh.vertex_data[i] as f64)); }
        }
    }
}

#[test]
fn packs_material_level_and_grid_position_into_uv() {
    let mesh = build(&planet(verdant()), &NODE);
    let (u, v) = (mesh.vertex_data[6] as f64, mesh.vertex_data[7] as f64);
    assert!((u + 0.0005).floor() <= 2.0);
    assert_eq!((v + 0.0005).floor(), NODE.level as f64);
    assert!(pack_chunk_uv(MATERIAL_LAND, 1.0) < 1.0);
    assert_eq!((pack_chunk_uv(3, 1.0) as f64 + 0.0005).floor(), 3.0);
}

#[test]
fn keys_match_the_typescript_chunk_ids() {
    assert_eq!(ChunkNode { planet: 1, face: 2, level: 3, ia: 4, ib: 5, stitch: 0 }.key(), "qp-1-2-3-4-5-0");
    assert_eq!(ChunkNode { planet: 1, face: 2, level: 3, ia: 4, ib: 5, stitch: 9 }.key(), "qp-1-2-3-4-5-9");
}

// --- The quadtree around a viewer ------------------------------------------------------------

#[test]
fn is_finest_under_your_feet_and_never_overlaps() {
    let v = planet(verdant());
    let e = eye(&v);
    let sel = select_chunks(&v, 0, e, &LodSettings::default());
    let deepest = sel.leaves.iter().map(|(n, _)| n.level).max().unwrap();
    assert_eq!(deepest, v.max_level());
    let nearest = sel.leaves.iter().min_by(|a, b| distance(e, a.1).total_cmp(&distance(e, b.1))).unwrap();
    assert_eq!(nearest.0.level, deepest);
    assert!(sel.leaves.len() < 800);
    for i in 0..sel.leaves.len() {
        for j in i + 1..sel.leaves.len() { assert!(!nodes_overlap(&sel.leaves[i].0, &sel.leaves[j].0)); }
    }
}

#[test]
fn is_balanced_two_to_one() {
    let v = planet(verdant());
    let sel = select_chunks(&v, 0, eye(&v), &LodSettings::default());
    let mut index = LeafIndex::new(v.max_level());
    for (n, _) in &sel.leaves { index.add(*n); }
    for (n, _) in &sel.leaves {
        let s = node_param_size(n.level);
        let (a0, b0, e) = (-1.0 + n.ia as f64 * s, -1.0 + n.ib as f64 * s, s * 1e-4);
        for k in 0..8 {
            let t = ((k as f64 + 0.5) / 8.0) * s;
            for (a, b) in [(a0 + t, b0 - e), (a0 + t, b0 + s + e), (a0 - e, b0 + t), (a0 + s + e, b0 + t), (a0 - e, b0 - e), (a0 + s + e, b0 + s + e)] {
                if let Some(m) = index.find(n.face as usize, a, b) { assert!((m.level as i64 - n.level as i64).abs() <= 1); }
            }
        }
    }
}

/// The crack test. Every chunk's outline (the edges used by only one of its triangles) must be
/// matched, point for point, by the chunk on the other side - unless nothing is there (ground
/// below the horizon isn't drawn at all). Covers stitched edges, different levels and cube-face
/// seams. `tolerance` 0 demands bit-identical points: the procedural planets' chunks are small
/// enough for every offset to be exact in f32. Earth's coarse chunks are hundreds of kilometers
/// across, so their f32 offsets round at the millimeter (always hundreds of kilometers from the
/// camera: split distance is 1.5x a chunk's size).
fn assert_watertight(p: &Planet, planet_index: u32, viewer: V3, tolerance: f64) {
    let sel = select_chunks(p, planet_index, viewer, &LodSettings::default());
    let mut index = LeafIndex::new(p.max_level());
    for (n, _) in &sel.leaves { index.add(*n); }
    struct Edge { from: V3, to: V3, node: ChunkNode, uva: [f32; 2], uvb: [f32; 2] }
    let mut edges: Vec<Edge> = Vec::new();
    let mut stitched = 0;
    for (n, _) in &sel.leaves {
        let mesh = build(p, n);
        let mut count: HashMap<(u32, u32), u32> = HashMap::new();
        let undirected = |a: u32, b: u32| if a < b { (a, b) } else { (b, a) };
        for t in (0..mesh.index_data.len()).step_by(3) {
            for e in 0..3 { *count.entry(undirected(mesh.index_data[t + e], mesh.index_data[t + (e + 1) % 3])).or_default() += 1; }
        }
        let uv = |i: u32| { let d = &mesh.vertex_data[i as usize * VERTEX_FLOATS..]; [d[6], d[7]] };
        for t in (0..mesh.index_data.len()).step_by(3) {
            for e in 0..3 {
                let (a, b) = (mesh.index_data[t + e], mesh.index_data[t + (e + 1) % 3]);
                if count[&undirected(a, b)] != 1 { continue; }
                edges.push(Edge { from: vert(&mesh, a as usize), to: vert(&mesh, b as usize), node: *n, uva: uv(a), uvb: uv(b) });
            }
        }
        if n.stitch != 0 { stitched += 1; }
    }
    // Edges by the cell their start point falls in, for the reverse-edge search.
    let cell_size = (tolerance * 4.0).max(1.0);
    let cell = |v: V3| v.map(|x| (x / cell_size).floor() as i64);
    let mut by_cell: HashMap<[i64; 3], Vec<usize>> = HashMap::new();
    for (i, e) in edges.iter().enumerate() { by_cell.entry(cell(e.from)).or_default().push(i); }
    let same = |a: V3, b: V3| if tolerance == 0.0 { a == b } else { distance(a, b) <= tolerance };
    assert!(stitched > 10, "{}: only {stitched} stitched chunks", p.def.name);
    let mut matched = 0;
    for e in &edges {
        let c = cell(e.to);
        let mut found = false;
        'search: for dx in -1..=1 { for dy in -1..=1 { for dz in -1..=1 {
            for &j in by_cell.get(&[c[0] + dx, c[1] + dy, c[2] + dz]).map(|v| v.as_slice()).unwrap_or(&[]) {
                if same(edges[j].from, e.to) && same(edges[j].to, e.from) { found = true; break 'search; }
            }
        } } }
        if found { matched += 1; continue; }
        // Unmatched is only allowed where no chunk is on the other side.
        let n = e.node;
        let s = node_param_size(n.level);
        let seg = CHUNK_SEGMENTS as f64;
        let grid = |uv: [f32; 2]| [((uv[0] as f64).fract() - 0.001) / 0.99 * seg, (uv[1] as f64 - n.level as f64 - 0.001) / 0.99 * seg].map(f64::round);
        let ([i0, j0], [i1, j1]) = (grid(e.uva), grid(e.uvb));
        let out = 1e-4 * s;
        let a = -1.0 + n.ia as f64 * s + (i0 + i1) / 2.0 / seg * s + if i0 == 0.0 && i1 == 0.0 { -out } else if i0 == seg && i1 == seg { out } else { 0.0 };
        let b = -1.0 + n.ib as f64 * s + (j0 + j1) / 2.0 / seg * s + if j0 == 0.0 && j1 == 0.0 { -out } else if j0 == seg && j1 == seg { out } else { 0.0 };
        assert!(index.find(n.face as usize, a, b).is_none(), "crack at {} {n:?} edge {i0},{j0}-{i1},{j1}", p.def.name);
    }
    assert!(matched > 1000, "{}: {matched}", p.def.name);
}

#[test]
fn is_watertight_on_procedural_planets() {
    let v = planet(verdant());
    let e = eye(&v);
    assert_watertight(&v, 0, e, 0.0);
    let em = planet(ember());
    let site = normalize([-0.5, 0.2, 0.84]);
    let r = em.surface_radius(site, 0.0, &mut Lookup::new(Access::Fallback));
    assert_watertight(&em, 1, add_scaled(em.def.center, site, r), 0.0);
    assert_watertight(&with_detail(verdant(), ChunkDetail::Half { leaf_vertices: 32.0, levels: 8.0 }), 0, e, 0.0);
    assert_watertight(&with_detail(verdant(), ChunkDetail::Explicit { vertices_per_level: vec![24.0, 12.0, 8.0, 6.0, 4.0, 3.0, 3.0, 3.0] }), 0, e, 0.0);
}

#[test]
fn is_watertight_on_earth() {
    // Offline Earth: real continents from the built-in tile, the procedural detail on top.
    let p = planet(earth(true));
    let alps = lat_lon_to_dir(46.5, 9.8);
    let r = p.surface_radius(alps, 0.0, &mut Lookup::new(Access::Fallback));
    assert_watertight(&p, 0, add_scaled(p.def.center, alps, r + 2.0), 0.02);
}

#[test]
fn from_deep_space_is_a_handful_of_coarse_chunks() {
    let far: V3 = [260_000.0, 45_000.0, -170_000.0];
    for (i, def) in [verdant(), ember()].into_iter().enumerate() {
        let p = planet(def);
        let sel = select_chunks(&p, i as u32, far, &LodSettings::default());
        assert!(sel.leaves.len() <= 24);
        assert_eq!(sel.leaves.iter().map(|(n, _)| n.level).max().unwrap(), 1);
    }
}

// --- Streaming -------------------------------------------------------------------------------

/// Every wanted chunk's ground must be drawn by live chunks at every moment: by itself, by a live
/// ancestor, or by live descendants that tile it completely.
fn covered(want: &ChunkNode, live: &[ChunkNode]) -> bool {
    let same: Vec<&ChunkNode> = live.iter().filter(|l| nodes_overlap(l, want)).collect();
    if same.iter().any(|l| l.level <= want.level) { return true; }
    let area: f64 = same.iter().map(|l| 0.25f64.powi((l.level - want.level) as i32)).sum();
    (area - 1.0).abs() < 1e-9
}

#[test]
fn streams_nearest_first_and_never_drops_ground_before_its_replacement() {
    let planets = vec![planet(verdant())];
    let mut streamer = PlanetStreamer::new(LodSettings::default(), usize::MAX);
    let a = eye(&planets[0]);
    let first = streamer.update(&planets, a, 100_000, 1e9);
    assert_eq!(first.stats.pending, 0);
    // The first chunk built is one under the viewer (a deepest-level chunk).
    assert_eq!(first.created[0].1.level, planets[0].max_level());

    // Fly up and away; stream a few chunks per frame. Ground that was drawn stays drawn.
    let b = scale(a, 1.6);
    let wanted: Vec<ChunkNode> = select_chunks(&planets[0], 0, b, &LodSettings::default()).leaves.into_iter().map(|(n, _)| n).collect();
    let mut before: Vec<ChunkNode> = streamer.live_nodes().map(|(_, n)| *n).collect();
    let mut checked = 0;
    let mut stats = first.stats;
    for _ in 0..400 {
        stats = streamer.update(&planets, b, 3, 1e9).stats;
        let after: Vec<ChunkNode> = streamer.live_nodes().map(|(_, n)| *n).collect();
        for w in &wanted {
            if !covered(w, &before) { continue; }
            assert!(covered(w, &after));
            checked += 1;
        }
        before = after;
        if stats.pending == 0 { break; }
    }
    assert!(checked > 100);
    for w in &wanted { assert!(covered(w, &before)); }
    assert_eq!(stats.pending, 0);
    assert!(stats.destroyed > 0);
    assert_eq!(stats.live, stats.wanted);
}

#[test]
fn background_streaming_never_blocks_bounds_handouts_and_keeps_ground_covered() {
    let planets = std::sync::Arc::new(vec![planet(verdant())]);
    let mut streamer = PlanetStreamer::new(LodSettings::default(), usize::MAX);
    let a = eye(&planets[0]);
    // The first call only queues: nothing is built on the calling thread.
    let first = streamer.update_background(&planets, a, 4, 12.0);
    assert!(first.created.is_empty());
    assert!(first.stats.in_flight > 0);
    let mut before: Vec<ChunkNode> = Vec::new();
    let mut stats = first.stats;
    let started = std::time::Instant::now();
    while started.elapsed() < std::time::Duration::from_secs(60) {
        let u = streamer.update_background(&planets, a, 4, 12.0);
        assert!(u.created.len() <= 4, "at most max_builds chunks handed out per call");
        let after: Vec<ChunkNode> = streamer.live_nodes().map(|(_, n)| *n).collect();
        for w in &before { assert!(covered(w, &after), "ground stays drawn"); }
        before = after;
        stats = u.stats;
        if stats.pending == 0 { break; }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    assert_eq!(stats.pending, 0);
    assert_eq!(stats.live, stats.wanted);
    assert_eq!(stats.in_flight, 0);

    // Flying away cancels queued work for the old place; chunks it finished are dropped, not shown.
    let far = scale(a, 3.0);
    streamer.update_background(&planets, far, 0, 12.0);
    let back = streamer.update_background(&planets, a, 1000, 12.0);
    let wanted_here: HashSet<String> = select_chunks(&planets[0], 0, a, &LodSettings::default()).leaves.into_iter().map(|(n, _)| n.key()).collect();
    for (k, _, _) in &back.created { assert!(wanted_here.contains(k)); }

    // clear() forgets in-flight work: nothing from before it is handed out after.
    streamer.update_background(&planets, far, 0, 12.0);
    streamer.clear();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let after_clear = streamer.update_background(&planets, a, 1000, 12.0);
    assert!(after_clear.created.is_empty(), "results from before clear() are dropped");
}

#[test]
fn background_streaming_with_an_unlimited_budget_builds_everything_now() {
    let planets = std::sync::Arc::new(vec![planet(verdant())]);
    let mut streamer = PlanetStreamer::new(LodSettings::default(), usize::MAX);
    let s = streamer.update_background(&planets, eye(&planets[0]), usize::MAX, f64::MAX).stats;
    assert_eq!(s.pending, 0);
    assert_eq!(s.live, s.wanted);
}

#[test]
fn keeps_within_the_triangle_budget() {
    let planets = vec![planet(verdant())];
    let e = eye(&planets[0]);
    let mut free = PlanetStreamer::new(LodSettings::default(), usize::MAX);
    let all = free.update(&planets, e, 100_000, 1e9).stats;
    let budget = all.triangles / 2;
    let mut tight = PlanetStreamer::new(LodSettings::default(), budget);
    let s = tight.update(&planets, e, 100_000, 1e9).stats;
    assert!(s.triangles <= budget, "{} > {budget}", s.triangles);
    assert!(s.split_factor < 1.5);
    assert_eq!(s.deepest[0], planets[0].max_level(), "still finest under your feet");
}

#[test]
fn standing_on_earth_fits_the_default_budget() {
    let planets = vec![planet(earth(true))];
    let d = lat_lon_to_dir(27.98, 86.92);
    let r = planets[0].surface_radius(d, 0.0, &mut Lookup::new(Access::Fallback));
    let mut streamer = PlanetStreamer::new(LodSettings::default(), super::DEFAULT_TRIANGLE_BUDGET);
    let s = streamer.update(&planets, add_scaled(planets[0].def.center, d, r + 1.8), 100_000, 1e9).stats;
    assert!(s.triangles <= super::DEFAULT_TRIANGLE_BUDGET, "{}", s.triangles);
    assert_eq!(s.deepest[0], planets[0].max_level());
    assert_eq!(s.pending, 0);
}

#[test]
fn clears_every_chunk_it_made() {
    let planets = vec![planet(verdant()), planet(ember())];
    let mut streamer = PlanetStreamer::new(LodSettings::default(), usize::MAX);
    let u = streamer.update(&planets, [0.0, 0.0, 300_000.0], 100_000, 1e9);
    assert!(!u.created.is_empty());
    let cleared = streamer.clear();
    assert_eq!(cleared.len(), u.created.len());
    assert_eq!(streamer.live_nodes().count(), 0);
}

// --- Terrain ---------------------------------------------------------------------------------

#[test]
fn terrain_is_deterministic_and_within_relief() {
    for def in [verdant(), ember(), earth(true)] {
        let p = planet(def);
        let mut lk = Lookup::new(Access::Fallback);
        for k in 0..200 {
            let kf = k as f64;
            let d = normalize([(kf * 1.7).sin(), (kf * 2.3).cos(), (kf * 0.37 + 1.0).sin()]);
            let s = p.sample(d, 0.0, &mut lk);
            assert_eq!(p.sample(d, 0.0, &mut lk), s);
            assert!(s.terrain <= p.max_relief(), "{} {}", p.def.name, s.terrain);
            if !p.def.has_sea { assert!(!s.sea); }
        }
    }
}

#[test]
fn drops_detail_a_coarse_mesh_cannot_show() {
    let v = planet(verdant());
    let mut lk = Lookup::new(Access::Fallback);
    let d = normalize([0.3, 0.8, -0.5]);
    assert_eq!(v.sample(d, v.finest_spacing() / 2.0, &mut lk), v.sample(d, v.finest_spacing(), &mut lk));
    let rough = |spacing: f64, lk: &mut Lookup| {
        (0..300).map(|k| {
            let kf = k as f64;
            let a = normalize([kf.sin(), (kf * 1.3).cos(), (kf * 0.7 + 2.0).sin()]);
            let b = normalize([a[0] + 3.0 / v.def.radius, a[1], a[2]]);
            (v.sample(a, spacing, lk).terrain - v.sample(b, spacing, lk).terrain).abs()
        }).sum::<f64>()
    };
    assert!(rough(80.0, &mut lk) < rough(v.finest_spacing(), &mut lk) * 0.7);
}

#[test]
fn mountains_are_a_thousand_times_the_walker() {
    let v = planet(verdant());
    let mut lk = Lookup::new(Access::Fallback);
    let highest = (0..20000).map(|k| {
        let z = 1.0 - 2.0 * (k as f64 + 0.5) / 20000.0;
        let r = (1.0 - z * z).sqrt();
        let a = k as f64 * 2.39996;
        v.sample([r * a.cos(), z, r * a.sin()], 0.0, &mut lk).terrain
    }).fold(0.0, f64::max);
    assert!(highest > 1000.0 * 1.8);
    assert!(v.def.radius > 20.0 * highest);
}
