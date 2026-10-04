//! A small Mapbox Vector Tile (MVT 2.x) decoder: the protobuf format OpenStreetMap vector tiles
//! (OpenFreeMap, OpenMapTiles, Protomaps...) are served in. Only what the city layer needs:
//! layers by name, each feature's id, type, properties and geometry in tile units.
//!
//! The format, briefly: a tile is a list of layers; a layer has a name, an extent (tile units per
//! side, usually 4096), shared key and value tables, and features. A feature's properties are
//! pairs of indices into those tables, and its geometry is a run of commands (MoveTo, LineTo,
//! ClosePath) with zigzag-encoded deltas from the previous point.

use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    String(String),
    Float(f64),
    Int(i64),
    Bool(bool),
}

impl Value {
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Float(f) => Some(*f),
            Value::Int(i) => Some(*i as f64),
            Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
            Value::String(s) => s.parse().ok(),
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        if let Value::String(s) = self { Some(s) } else { None }
    }
    pub fn truthy(&self) -> bool {
        match self {
            Value::Bool(b) => *b,
            Value::Int(i) => *i != 0,
            Value::Float(f) => *f != 0.0,
            Value::String(s) => !s.is_empty() && s != "false" && s != "0",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeomType { Unknown, Point, LineString, Polygon }

#[derive(Clone, Debug)]
pub struct Feature {
    pub id: Option<u64>,
    pub geom_type: GeomType,
    pub properties: HashMap<String, Value>,
    /// Points for a point feature, lines for a line feature, rings for a polygon (closed: the
    /// first point is not repeated). Tile units, y down.
    pub geometry: Vec<Vec<[i32; 2]>>,
}

impl Feature {
    pub fn get(&self, key: &str) -> Option<&Value> { self.properties.get(key) }
    pub fn number(&self, key: &str) -> Option<f64> { self.get(key).and_then(Value::as_f64) }
    pub fn string(&self, key: &str) -> Option<&str> { self.get(key).and_then(Value::as_str) }
}

#[derive(Clone, Debug)]
pub struct Layer {
    pub name: String,
    pub extent: u32,
    pub features: Vec<Feature>,
}

struct Pb<'a> { b: &'a [u8], at: usize }

impl<'a> Pb<'a> {
    fn new(b: &'a [u8]) -> Self { Self { b, at: 0 } }
    fn done(&self) -> bool { self.at >= self.b.len() }
    fn varint(&mut self) -> Result<u64, String> {
        let mut v: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = *self.b.get(self.at).ok_or("truncated varint")?;
            self.at += 1;
            v |= ((byte & 0x7f) as u64) << shift;
            if byte & 0x80 == 0 { return Ok(v); }
        }
        Err("varint too long".into())
    }
    fn bytes(&mut self) -> Result<&'a [u8], String> {
        let n = self.varint()? as usize;
        let end = self.at.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("truncated field")?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn fixed(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).filter(|&e| e <= self.b.len()).ok_or("truncated fixed field")?;
        let s = &self.b[self.at..end];
        self.at = end;
        Ok(s)
    }
    /// The next field's number and wire type.
    fn key(&mut self) -> Result<(u32, u8), String> {
        let k = self.varint()?;
        Ok(((k >> 3) as u32, (k & 7) as u8))
    }
    fn skip(&mut self, wire: u8) -> Result<(), String> {
        match wire {
            0 => { self.varint()?; }
            1 => { self.fixed(8)?; }
            2 => { self.bytes()?; }
            5 => { self.fixed(4)?; }
            w => return Err(format!("unsupported wire type {w}")),
        }
        Ok(())
    }
    fn packed(&mut self) -> Result<Vec<u32>, String> {
        let mut inner = Pb::new(self.bytes()?);
        let mut out = Vec::new();
        while !inner.done() { out.push(inner.varint()? as u32); }
        Ok(out)
    }
}

fn zigzag(v: u32) -> i32 { ((v >> 1) as i32) ^ -((v & 1) as i32) }

fn decode_value(b: &[u8]) -> Result<Value, String> {
    let mut p = Pb::new(b);
    let mut out = Value::String(String::new());
    while !p.done() {
        let (field, wire) = p.key()?;
        out = match (field, wire) {
            (1, 2) => Value::String(String::from_utf8_lossy(p.bytes()?).into_owned()),
            (2, 5) => Value::Float(f32::from_le_bytes(p.fixed(4)?.try_into().unwrap()) as f64),
            (3, 1) => Value::Float(f64::from_le_bytes(p.fixed(8)?.try_into().unwrap())),
            (4, 0) => Value::Int(p.varint()? as i64),
            (5, 0) => Value::Int(p.varint()? as i64),
            (6, 0) => { let v = p.varint()?; Value::Int(((v >> 1) as i64) ^ -((v & 1) as i64)) }
            (7, 0) => Value::Bool(p.varint()? != 0),
            (_, w) => { p.skip(w)?; continue; }
        };
    }
    Ok(out)
}

fn decode_geometry(cmds: &[u32], geom_type: GeomType) -> Vec<Vec<[i32; 2]>> {
    let mut out: Vec<Vec<[i32; 2]>> = Vec::new();
    let (mut x, mut y) = (0i32, 0i32);
    let mut i = 0;
    while i < cmds.len() {
        let id = cmds[i] & 7;
        let count = (cmds[i] >> 3) as usize;
        i += 1;
        match id {
            1 | 2 => {
                for _ in 0..count {
                    let (Some(&dx), Some(&dy)) = (cmds.get(i), cmds.get(i + 1)) else { return out };
                    i += 2;
                    x = x.wrapping_add(zigzag(dx));
                    y = y.wrapping_add(zigzag(dy));
                    if id == 1 && (geom_type != GeomType::Point || out.is_empty()) { out.push(Vec::new()); }
                    if let Some(last) = out.last_mut() { last.push([x, y]); }
                }
            }
            7 => {} // ClosePath: rings are kept open (the first point isn't repeated)
            _ => return out,
        }
    }
    out
}

fn decode_feature(b: &[u8], keys: &[String], values: &[Value]) -> Result<Feature, String> {
    let mut p = Pb::new(b);
    let mut f = Feature { id: None, geom_type: GeomType::Unknown, properties: HashMap::new(), geometry: Vec::new() };
    let mut tags = Vec::new();
    let mut cmds = Vec::new();
    while !p.done() {
        match p.key()? {
            (1, 0) => f.id = Some(p.varint()?),
            (2, 2) => tags = p.packed()?,
            (3, 0) => f.geom_type = match p.varint()? { 1 => GeomType::Point, 2 => GeomType::LineString, 3 => GeomType::Polygon, _ => GeomType::Unknown },
            (4, 2) => cmds = p.packed()?,
            (_, w) => p.skip(w)?,
        }
    }
    for pair in tags.chunks_exact(2) {
        if let (Some(k), Some(v)) = (keys.get(pair[0] as usize), values.get(pair[1] as usize)) {
            f.properties.insert(k.clone(), v.clone());
        }
    }
    f.geometry = decode_geometry(&cmds, f.geom_type);
    Ok(f)
}

/// Decodes the layers named in `wanted` (all layers when it is empty).
pub fn decode(tile: &[u8], wanted: &[&str]) -> Result<Vec<Layer>, String> {
    let mut p = Pb::new(tile);
    let mut layers = Vec::new();
    while !p.done() {
        let (field, wire) = p.key()?;
        if field != 3 || wire != 2 { p.skip(wire)?; continue; }
        let body = p.bytes()?;
        // First pass: the name, extent and tables; features need the tables to decode.
        let mut lp = Pb::new(body);
        let (mut name, mut extent) = (String::new(), 4096u32);
        let mut keys = Vec::new();
        let mut values = Vec::new();
        let mut features = Vec::new();
        while !lp.done() {
            match lp.key()? {
                (1, 2) => name = String::from_utf8_lossy(lp.bytes()?).into_owned(),
                (2, 2) => features.push(lp.bytes()?),
                (3, 2) => keys.push(String::from_utf8_lossy(lp.bytes()?).into_owned()),
                (4, 2) => values.push(decode_value(lp.bytes()?)?),
                (5, 0) => extent = lp.varint()? as u32,
                (_, w) => lp.skip(w)?,
            }
        }
        if !wanted.is_empty() && !wanted.contains(&name.as_str()) { continue; }
        let features = features.into_iter().map(|b| decode_feature(b, &keys, &values)).collect::<Result<Vec<_>, _>>()?;
        layers.push(Layer { name, extent: extent.max(1), features });
    }
    Ok(layers)
}

/// Twice the signed area of a ring (shoelace, tile units). Positive for an exterior ring in MVT
/// (clockwise on screen, where y points down).
pub fn ring_area2(ring: &[[i32; 2]]) -> f64 {
    let mut a = 0.0;
    for i in 0..ring.len() {
        let p = ring[i];
        let q = ring[(i + 1) % ring.len()];
        a += p[0] as f64 * q[1] as f64 - q[0] as f64 * p[1] as f64;
    }
    a
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn varint(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 { out.push(b); break; }
            out.push(b | 0x80);
        }
    }
    fn field_bytes(out: &mut Vec<u8>, field: u32, bytes: &[u8]) {
        varint(out, ((field as u64) << 3) | 2);
        varint(out, bytes.len() as u64);
        out.extend_from_slice(bytes);
    }
    fn zz(v: i32) -> u32 { ((v << 1) ^ (v >> 31)) as u32 }

    /// Encodes a layer of polygon/line features for tests: (geometry type, properties, rings).
    pub fn encode_layer(name: &str, features: &[(u8, Vec<(&str, Value)>, Vec<Vec<[i32; 2]>>)]) -> Vec<u8> {
        let mut keys: Vec<String> = Vec::new();
        let mut values: Vec<Value> = Vec::new();
        let mut body = Vec::new();
        field_bytes(&mut body, 1, name.as_bytes());
        for (kind, props, rings) in features {
            let mut f = Vec::new();
            let mut tags = Vec::new();
            for (k, v) in props {
                let ki = keys.iter().position(|x| x == k).unwrap_or_else(|| { keys.push(k.to_string()); keys.len() - 1 });
                let vi = values.iter().position(|x| x == v).unwrap_or_else(|| { values.push(v.clone()); values.len() - 1 });
                tags.push(ki as u64);
                tags.push(vi as u64);
            }
            let mut t = Vec::new();
            for v in tags { varint(&mut t, v); }
            field_bytes(&mut f, 2, &t);
            varint(&mut f, 3 << 3);
            varint(&mut f, *kind as u64);
            let mut g = Vec::new();
            let (mut x, mut y) = (0, 0);
            for ring in rings {
                varint(&mut g, 1 | (1 << 3));
                varint(&mut g, zz(ring[0][0] - x) as u64);
                varint(&mut g, zz(ring[0][1] - y) as u64);
                (x, y) = (ring[0][0], ring[0][1]);
                varint(&mut g, 2 | (((ring.len() - 1) as u64) << 3));
                for p in &ring[1..] {
                    varint(&mut g, zz(p[0] - x) as u64);
                    varint(&mut g, zz(p[1] - y) as u64);
                    (x, y) = (p[0], p[1]);
                }
                if *kind == 3 { varint(&mut g, 7 | (1 << 3)); }
            }
            field_bytes(&mut f, 4, &g);
            field_bytes(&mut body, 2, &f);
        }
        for k in &keys { field_bytes(&mut body, 3, k.as_bytes()); }
        for v in &values {
            let mut vb = Vec::new();
            match v {
                Value::String(s) => field_bytes(&mut vb, 1, s.as_bytes()),
                Value::Float(f) => { varint(&mut vb, (3 << 3) | 1); vb.extend_from_slice(&f.to_le_bytes()); }
                Value::Int(i) => { varint(&mut vb, 4 << 3); varint(&mut vb, *i as u64); }
                Value::Bool(b) => { varint(&mut vb, 7 << 3); varint(&mut vb, *b as u64); }
            }
            field_bytes(&mut body, 4, &vb);
        }
        varint(&mut body, 5 << 3);
        varint(&mut body, 4096);
        let mut tile = Vec::new();
        field_bytes(&mut tile, 3, &body);
        tile
    }

    #[test]
    fn decodes_polygons_lines_and_properties() {
        let square = vec![vec![[100, 100], [200, 100], [200, 200], [100, 200]]];
        let mut tile = encode_layer("building", &[(3, vec![("render_height", Value::Int(9)), ("colour", Value::String("#aa8844".into()))], square.clone())]);
        tile.extend(encode_layer("transportation", &[(2, vec![("class", Value::String("minor".into()))], vec![vec![[0, 0], [10, -5], [20, 7]]])]));
        let layers = decode(&tile, &[]).unwrap();
        assert_eq!(layers.len(), 2);
        let b = &layers[0];
        assert_eq!((b.name.as_str(), b.extent), ("building", 4096));
        assert_eq!(b.features[0].geom_type, GeomType::Polygon);
        assert_eq!(b.features[0].geometry, square);
        assert_eq!(b.features[0].number("render_height"), Some(9.0));
        assert_eq!(b.features[0].string("colour"), Some("#aa8844"));
        assert!(ring_area2(&b.features[0].geometry[0]) > 0.0, "clockwise on screen is positive");
        let r = &layers[1].features[0];
        assert_eq!(r.geom_type, GeomType::LineString);
        assert_eq!(r.geometry, vec![vec![[0, 0], [10, -5], [20, 7]]]);
        // Only the wanted layers.
        assert_eq!(decode(&tile, &["transportation"]).unwrap().len(), 1);
    }

    #[test]
    fn rejects_truncated_tiles() {
        let tile = encode_layer("building", &[(3, vec![], vec![vec![[0, 0], [5, 0], [5, 5]]])]);
        assert!(decode(&tile[..tile.len() - 3], &[]).is_err());
    }
}
