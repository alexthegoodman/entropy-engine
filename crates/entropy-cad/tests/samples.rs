//! Contour Design's sample documents (written by examples/studio-bundle/tools/cad_fixtures.ts),
//! evaluated headlessly: every feature builds, and every body is closed and faces outward.
use entropy_cad::features::{Document, Evaluator, Options};

fn check(name: &str, bodies: usize, volume: std::ops::Range<f64>) {
    let text = std::fs::read_to_string(format!("{}/tests/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let doc: Document = serde_json::from_str(&text).unwrap();
    let started = std::time::Instant::now();
    let e = Evaluator::default().evaluate(&doc, &Options::default());
    let ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(e.issues.is_empty(), "{name}: {:?}", e.issues);
    assert_eq!(e.bodies.len(), bodies, "{name}");
    let total: f64 = e.bodies.iter().map(|b| b.mesh.volume()).sum();
    let tris: usize = e.bodies.iter().map(|b| b.mesh.tris.len()).sum();
    println!("{name}: {tris} triangles, volume {total:.0}, {ms:.0} ms");
    assert!(volume.contains(&total), "{name}: volume {total}");
    for b in &e.bodies {
        assert_eq!(b.mesh.open_edges(), 0, "{name}: {} is not closed", b.id);
        let m = &b.mesh;
        let wrong = (0..m.tris.len()).filter(|t| {
            let [p, q, r] = m.tri(*t);
            let g = (q - p).cross(r - p).norm();
            m.tris[*t].iter().any(|v| g.dot(m.normals[*v as usize]) < 0.0)
        }).count();
        assert!(wrong * 200 <= m.tris.len(), "{name}: {wrong} of {} triangles face away from their normals", m.tris.len());
    }
    assert!(ms < 3000.0, "{name} took {ms} ms");
}

#[test]
fn skiff() { check("skiff", 1, 1_000_000.0..1_500_000.0); }
#[test]
fn vessel() { check("vessel", 1, 80_000.0..160_000.0); }
#[test]
fn pebble() { check("pebble", 1, 150_000.0..260_000.0); }
