//! Writing bodies out for other tools: binary STL for printing and slicing, OBJ for everything else.

use crate::features::Body;

/// Binary STL of the bodies together, in document units.
pub fn stl(bodies: &[Body]) -> Vec<u8> {
    let count: usize = bodies.iter().map(|b| b.mesh.tris.len()).sum();
    let mut out = Vec::with_capacity(84 + count * 50);
    let mut header = [0u8; 80];
    header[..11].copy_from_slice(b"entropy-cad");
    out.extend_from_slice(&header);
    out.extend_from_slice(&(count as u32).to_le_bytes());
    for b in bodies {
        for t in 0..b.mesh.tris.len() {
            let [p, q, r] = b.mesh.tri(t);
            let n = (q - p).cross(r - p).norm();
            for v in [n, p, q, r] { for c in v.arr() { out.extend_from_slice(&(c as f32).to_le_bytes()); } }
            out.extend_from_slice(&[0, 0]);
        }
    }
    out
}

/// Wavefront OBJ: one object per body, one group per face, with smooth normals.
pub fn obj(bodies: &[Body]) -> String {
    use std::fmt::Write;
    let mut out = String::from("# entropy-cad\n");
    let mut base = 1usize;
    for b in bodies {
        let m = &b.mesh;
        let _ = writeln!(out, "o {}", if b.name.is_empty() { &b.id } else { &b.name }.replace(char::is_whitespace, "_"));
        for p in &m.positions { let _ = writeln!(out, "v {:.6} {:.6} {:.6}", p.x, p.y, p.z); }
        for n in &m.normals { let _ = writeln!(out, "vn {:.5} {:.5} {:.5}", n.x, n.y, n.z); }
        let mut order: Vec<usize> = (0..m.tris.len()).collect();
        order.sort_by_key(|t| m.face[*t]);
        let mut current = u32::MAX;
        for t in order {
            if m.face[t] != current {
                current = m.face[t];
                let tag = &m.faces[current as usize];
                let _ = writeln!(out, "g {}_{}", tag.feature, tag.part.replace(':', "_"));
            }
            let [a, b, c] = m.tris[t].map(|v| v as usize + base);
            let _ = writeln!(out, "f {a}//{a} {b}//{b} {c}//{c}");
        }
        base += m.positions.len();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{Document, Evaluator, Options};

    #[test]
    fn exports_carry_every_triangle() {
        let doc: Document = serde_json::from_str(r#"{"features":[
            {"id":"s","type":"sketch","points":[{"id":"c","x":0,"y":0}],"entities":[{"id":"ring","type":"circle","center":"c","radius":5}]},
            {"id":"e","name":"Puck one","type":"extrude","profile":{"sketch":"s"},"forward":{"distance":2}}]}"#).unwrap();
        let e = Evaluator::default().evaluate(&doc, &Options::default());
        let tris = e.bodies[0].mesh.tris.len();
        let bytes = stl(&e.bodies);
        assert_eq!(bytes.len(), 84 + tris * 50);
        assert_eq!(u32::from_le_bytes(bytes[80..84].try_into().unwrap()) as usize, tris);
        let text = obj(&e.bodies);
        assert!(text.contains("o Puck_one\n") && text.contains("g e_side_ring\n") && text.contains("g e_end\n"));
        assert_eq!(text.lines().filter(|l| l.starts_with("f ")).count(), tris);
        assert_eq!(text.lines().filter(|l| l.starts_with("v ")).count(), e.bodies[0].mesh.positions.len());
    }
}
