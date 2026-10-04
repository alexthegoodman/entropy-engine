//! OpenStreetMap buildings and roads for Earth, from hosted vector tiles.
//!
//! The default source is OpenFreeMap (https://openfreemap.org): free OpenMapTiles-schema vector
//! tiles of the whole planet, no API key, commercial use allowed with attribution ("©
//! OpenStreetMap contributors"). Its TileJSON (`https://tiles.openfreemap.org/planet`) names the
//! current weekly build's `{z}/{x}/{y}` URL; any other OpenMapTiles-schema source works too
//! (`osmTileUrl`: a TileJSON URL or a `{z}/{x}/{y}` template).
//!
//! Tiles are Web Mercator XYZ, like the elevation tiles; the city layer reads zoom 14, the
//! schema's most detailed (about 2.4 km a side at the equator, 4096 units across, so ~0.6 m per
//! unit). They are fetched on the city layer's worker threads and kept on disk
//! (`<cache>/osm/14/x/y.pbf`) for good: a place you've been looks the same next time, whatever
//! has changed upstream since.
//!
//! What is read:
//! - `building`: footprint polygons with `render_height` / `render_min_height` (meters, from OSM
//!   `height` / `building:levels`, or a default) and sometimes `colour`. At zoom 14 buildings
//!   with the same attributes are merged into one multipolygon, so each exterior ring is one
//!   building and feature ids can't name buildings. Outlines with `hide_3d` (drawn by their
//!   `building:part`s instead) are skipped. A building that crosses a tile edge appears in both
//!   tiles' buffers; it belongs to the tile its centroid is in.
//! - `transportation`: road and path center lines with a `class` (motorway ... path); tunnels
//!   are skipped. Lines are clipped to the tile so neighbours don't draw the same stretch twice.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use super::elevation::TileId;
use super::mvt::{self, GeomType};

pub const OPENFREEMAP_TILEJSON: &str = "https://tiles.openfreemap.org/planet";
/// The OpenMapTiles schema's most detailed zoom (buildings appear from 13; 14 has them all).
pub const CITY_ZOOM: u8 = 14;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RoadClass { Motorway, Trunk, Primary, Secondary, Tertiary, Minor, Service, Track, Path, Rail }

impl RoadClass {
    pub fn from_omt(class: &str) -> Option<RoadClass> {
        Some(match class {
            "motorway" => RoadClass::Motorway,
            "trunk" => RoadClass::Trunk,
            "primary" => RoadClass::Primary,
            "secondary" => RoadClass::Secondary,
            "tertiary" => RoadClass::Tertiary,
            "minor" | "busway" | "raceway" => RoadClass::Minor,
            "service" => RoadClass::Service,
            "track" => RoadClass::Track,
            "path" => RoadClass::Path,
            "rail" | "transit" => RoadClass::Rail,
            _ => return None,
        })
    }

    /// Paved width in meters.
    pub fn width(self) -> f64 {
        match self {
            RoadClass::Motorway => 15.0,
            RoadClass::Trunk => 12.0,
            RoadClass::Primary => 10.0,
            RoadClass::Secondary => 8.5,
            RoadClass::Tertiary => 7.5,
            RoadClass::Minor => 6.0,
            RoadClass::Service => 4.0,
            RoadClass::Track => 3.0,
            RoadClass::Path => 1.8,
            RoadClass::Rail => 3.2,
        }
    }

    /// Roads a house would face (not footpaths or rail).
    pub fn is_street(self) -> bool { !matches!(self, RoadClass::Path | RoadClass::Track | RoadClass::Rail) }

    /// sRGB surface color.
    pub fn color(self) -> [f32; 3] {
        match self {
            RoadClass::Motorway | RoadClass::Trunk => [0.2, 0.2, 0.21],
            RoadClass::Primary | RoadClass::Secondary | RoadClass::Tertiary => [0.24, 0.24, 0.25],
            RoadClass::Minor | RoadClass::Service => [0.29, 0.29, 0.3],
            RoadClass::Track => [0.47, 0.41, 0.33],
            RoadClass::Path => [0.62, 0.58, 0.52],
            RoadClass::Rail => [0.36, 0.33, 0.3],
        }
    }
}

#[derive(Clone, Debug)]
pub struct OsmBuilding {
    /// Exterior ring as (latitude, longitude) in degrees.
    pub ring: Vec<[f64; 2]>,
    /// Ring area in square meters (on the ground).
    pub area: f64,
    pub height: f64,
    pub min_height: f64,
    /// sRGB, when the map gives one.
    pub colour: Option<[f32; 3]>,
}

#[derive(Clone, Debug)]
pub struct OsmRoad {
    /// (latitude, longitude) in degrees.
    pub points: Vec<[f64; 2]>,
    pub class: RoadClass,
    pub bridge: bool,
}

#[derive(Clone, Debug, Default)]
pub struct OsmTile {
    pub buildings: Vec<OsmBuilding>,
    pub roads: Vec<OsmRoad>,
}

/// Latitude/longitude (degrees) of a point in Mercator tile units (`extent` per tile side).
pub fn tile_point_to_lat_lon(id: TileId, extent: u32, x: f64, y: f64) -> [f64; 2] {
    let n = (1u64 << id.z) as f64;
    let gx = (id.x as f64 + x / extent as f64) / n;
    let gy = (id.y as f64 + y / extent as f64) / n;
    let lon = gx * 360.0 - 180.0;
    let lat = (std::f64::consts::PI * (1.0 - 2.0 * gy)).sinh().atan().to_degrees();
    [lat, lon]
}

/// The zoom-`z` tile containing a latitude/longitude.
pub fn tile_of(lat: f64, lon: f64, z: u8) -> TileId {
    let n = (1u64 << z) as f64;
    let la = lat.clamp(-85.0511, 85.0511).to_radians();
    let x = (((lon + 180.0) / 360.0).rem_euclid(1.0) * n).floor() as u32;
    let y = ((1.0 - (la.tan() + 1.0 / la.cos()).ln() / std::f64::consts::PI) / 2.0 * n).floor().clamp(0.0, n - 1.0) as u32;
    TileId { z, x: x.min(n as u32 - 1), y }
}

/// Meters per tile unit at a latitude, on a sphere of `radius`.
pub fn meters_per_unit(z: u8, extent: u32, lat: f64, radius: f64) -> f64 {
    2.0 * std::f64::consts::PI * radius * lat.to_radians().cos() / (1u64 << z) as f64 / extent as f64
}

/// "#rgb", "#rrggbb" or a common CSS color name, as sRGB.
pub fn parse_colour(s: &str) -> Option<[f32; 3]> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(hex) = s.strip_prefix('#') {
        let v = |h: &str| u8::from_str_radix(h, 16).ok().map(|b| b as f32 / 255.0);
        return match hex.len() {
            6 => Some([v(&hex[0..2])?, v(&hex[2..4])?, v(&hex[4..6])?]),
            3 => {
                let d = |i: usize| v(&hex[i..i + 1].repeat(2));
                Some([d(0)?, d(1)?, d(2)?])
            }
            _ => None,
        };
    }
    let named: [f32; 3] = match s.as_str() {
        "white" => [0.95, 0.94, 0.92],
        "grey" | "gray" | "silver" => [0.62, 0.62, 0.62],
        "darkgrey" | "darkgray" => [0.4, 0.4, 0.4],
        "lightgrey" | "lightgray" => [0.8, 0.8, 0.8],
        "black" => [0.12, 0.12, 0.12],
        "brown" => [0.5, 0.33, 0.22],
        "red" | "maroon" => [0.62, 0.25, 0.2],
        "yellow" => [0.88, 0.8, 0.45],
        "beige" | "tan" | "wheat" => [0.84, 0.76, 0.6],
        "orange" => [0.85, 0.55, 0.3],
        "pink" => [0.88, 0.7, 0.7],
        "blue" => [0.4, 0.5, 0.65],
        "green" => [0.45, 0.58, 0.42],
        "cream" | "ivory" => [0.94, 0.91, 0.82],
        _ => return None,
    };
    Some(named)
}

/// Clips a polyline (tile units) to the box [lo, hi]^2, splitting it where it leaves and
/// re-enters (Liang-Barsky per segment).
pub fn clip_polyline(line: &[[f64; 2]], lo: f64, hi: f64) -> Vec<Vec<[f64; 2]>> {
    let mut out: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut current: Vec<[f64; 2]> = Vec::new();
    for w in line.windows(2) {
        let (p, q) = (w[0], w[1]);
        let d = [q[0] - p[0], q[1] - p[1]];
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        let mut inside = true;
        for (pp, qq) in [(-d[0], p[0] - lo), (d[0], hi - p[0]), (-d[1], p[1] - lo), (d[1], hi - p[1])] {
            if pp == 0.0 {
                if qq < 0.0 { inside = false; break; }
            } else {
                let r = qq / pp;
                if pp < 0.0 { if r > t1 { inside = false; break; } if r > t0 { t0 = r; } }
                else { if r < t0 { inside = false; break; } if r < t1 { t1 = r; } }
            }
        }
        if !inside {
            if current.len() >= 2 { out.push(std::mem::take(&mut current)); } else { current.clear(); }
            continue;
        }
        let a = [p[0] + d[0] * t0, p[1] + d[1] * t0];
        let b = [p[0] + d[0] * t1, p[1] + d[1] * t1];
        if current.last().map_or(true, |l| (l[0] - a[0]).abs() > 1e-9 || (l[1] - a[1]).abs() > 1e-9) {
            if current.len() >= 2 { out.push(std::mem::take(&mut current)); } else { current.clear(); }
            current.push(a);
        }
        current.push(b);
        if t1 < 1.0 && current.len() >= 2 { out.push(std::mem::take(&mut current)); }
    }
    if current.len() >= 2 { out.push(current); }
    out
}

/// Reads one tile's buildings and roads. `radius` is the planet's, for footprint areas.
pub fn parse_tile(id: TileId, bytes: &[u8], radius: f64) -> Result<OsmTile, String> {
    let layers = mvt::decode(bytes, &["building", "transportation"])?;
    let mut tile = OsmTile::default();
    for layer in &layers {
        let ext = layer.extent;
        let e = ext as f64;
        let center_lat = tile_point_to_lat_lon(id, ext, e / 2.0, e / 2.0)[0];
        let m = meters_per_unit(id.z, ext, center_lat, radius);
        match layer.name.as_str() {
            "building" => for f in &layer.features {
                if f.geom_type != GeomType::Polygon { continue; }
                if f.get("hide_3d").is_some_and(|v| v.truthy()) { continue; }
                let height = f.number("render_height").unwrap_or(5.0).max(1.0);
                let min_height = f.number("render_min_height").unwrap_or(0.0).max(0.0).min(height - 0.5);
                let colour = f.string("colour").and_then(parse_colour);
                for ring in &f.geometry {
                    if ring.len() < 3 { continue; }
                    let a2 = mvt::ring_area2(ring);
                    if a2 <= 0.0 { continue; } // a hole
                    // Area-weighted centroid decides which tile owns a building on an edge.
                    let (mut cx, mut cy) = (0.0, 0.0);
                    for i in 0..ring.len() {
                        let p = ring[i];
                        let q = ring[(i + 1) % ring.len()];
                        let c = p[0] as f64 * q[1] as f64 - q[0] as f64 * p[1] as f64;
                        cx += (p[0] + q[0]) as f64 * c;
                        cy += (p[1] + q[1]) as f64 * c;
                    }
                    cx /= 3.0 * a2;
                    cy /= 3.0 * a2;
                    if !(cx >= 0.0 && cx < e && cy >= 0.0 && cy < e) { continue; }
                    tile.buildings.push(OsmBuilding {
                        ring: ring.iter().map(|p| tile_point_to_lat_lon(id, ext, p[0] as f64, p[1] as f64)).collect(),
                        area: a2 / 2.0 * m * m,
                        height,
                        min_height,
                        colour,
                    });
                }
            },
            "transportation" => for f in &layer.features {
                if f.geom_type != GeomType::LineString { continue; }
                let Some(class) = f.string("class").and_then(RoadClass::from_omt) else { continue };
                let brunnel = f.string("brunnel").unwrap_or("");
                if brunnel == "tunnel" { continue; }
                if f.get("indoor").is_some_and(|v| v.truthy()) { continue; }
                for line in &f.geometry {
                    let pts: Vec<[f64; 2]> = line.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
                    for piece in clip_polyline(&pts, 0.0, e) {
                        tile.roads.push(OsmRoad {
                            points: piece.iter().map(|p| tile_point_to_lat_lon(id, ext, p[0], p[1])).collect(),
                            class,
                            bridge: brunnel == "bridge",
                        });
                    }
                }
            },
            _ => {}
        }
    }
    Ok(tile)
}

/// Where tiles come from.
pub enum OsmLoader {
    Http {
        /// A TileJSON URL or a `{z}/{x}/{y}` template.
        url: String,
        /// The template, once a TileJSON has been read.
        resolved: Mutex<Option<String>>,
        cache_dir: Option<PathBuf>,
    },
    /// Tile bytes from a function (tests). `None`: no such tile.
    Custom(Box<dyn Fn(TileId) -> Option<Vec<u8>> + Send + Sync>),
}

/// Why a tile isn't here.
#[derive(Debug, PartialEq)]
pub enum LoadError {
    /// No such tile (the source said so): treat as empty.
    Missing,
    /// Network trouble: worth trying again later.
    Transient(String),
}

thread_local! {
    static CLIENT: std::cell::RefCell<Option<reqwest::blocking::Client>> = const { std::cell::RefCell::new(None) };
}

fn http_get(url: &str) -> Result<Vec<u8>, LoadError> {
    CLIENT.with(|c| {
        let mut c = c.borrow_mut();
        let client = c.get_or_insert_with(|| reqwest::blocking::Client::builder()
            .user_agent(super::geo::USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client"));
        match client.get(url).send().and_then(|r| r.error_for_status()) {
            Ok(r) => r.bytes().map(|b| b.to_vec()).map_err(|e| LoadError::Transient(e.to_string())),
            Err(e) if e.status().is_some_and(|s| s.as_u16() == 404 || s.as_u16() == 204) => Err(LoadError::Missing),
            Err(e) => Err(LoadError::Transient(e.to_string())),
        }
    })
}

/// The `{z}/{x}/{y}` template a TileJSON document names.
pub fn template_from_tilejson(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("tiles")?.as_array()?.first()?.as_str().map(str::to_string)
}

impl OsmLoader {
    pub fn http(url: Option<String>, cache_dir: Option<PathBuf>) -> Self {
        OsmLoader::Http { url: url.unwrap_or_else(|| OPENFREEMAP_TILEJSON.to_string()), resolved: Mutex::new(None), cache_dir }
    }

    fn template(&self) -> Result<String, LoadError> {
        let OsmLoader::Http { url, resolved, .. } = self else { unreachable!() };
        if url.contains("{z}") { return Ok(url.clone()); }
        if let Some(t) = resolved.lock().unwrap().clone() { return Ok(t); }
        let body = http_get(url)?;
        let t = template_from_tilejson(&String::from_utf8_lossy(&body))
            .ok_or_else(|| LoadError::Transient(format!("{url} is not a TileJSON with tiles")))?;
        *resolved.lock().unwrap() = Some(t.clone());
        Ok(t)
    }

    /// The tile's bytes: from the disk cache, else fetched (and cached).
    pub fn load(&self, id: TileId) -> Result<Vec<u8>, LoadError> {
        match self {
            OsmLoader::Custom(f) => f(id).ok_or(LoadError::Missing),
            OsmLoader::Http { cache_dir, .. } => {
                let path = cache_dir.as_ref().map(|d| d.join("osm").join(id.z.to_string()).join(id.x.to_string()).join(format!("{}.pbf", id.y)));
                if let Some(p) = &path {
                    if let Ok(bytes) = std::fs::read(p) { return Ok(bytes); }
                }
                let url = self.template()?.replace("{z}", &id.z.to_string()).replace("{x}", &id.x.to_string()).replace("{y}", &id.y.to_string());
                let bytes = match http_get(&url) {
                    Err(LoadError::Missing) => Vec::new(), // no data here (open sea): an empty tile
                    other => other?,
                };
                if let Some(p) = &path {
                    if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
                    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
                    if std::fs::write(&tmp, &bytes).is_ok() { let _ = std::fs::rename(&tmp, p); }
                }
                Ok(bytes)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::mvt::tests::encode_layer;
    use super::super::mvt::Value;

    #[test]
    fn tile_coordinates_round_trip() {
        let id = tile_of(46.0207, 7.7491, 14);
        assert_eq!((id.x, id.y), (8544, 5827));
        let nw = tile_point_to_lat_lon(id, 4096, 0.0, 0.0);
        let se = tile_point_to_lat_lon(id, 4096, 4096.0, 4096.0);
        assert!(nw[0] > 46.0207 && se[0] < 46.0207 && nw[1] < 7.7491 && se[1] > 7.7491);
        assert!((meters_per_unit(14, 4096, 0.0, 6_371_000.0) - 0.5966).abs() < 1e-3);
    }

    #[test]
    fn parses_colours() {
        assert_eq!(parse_colour("#ff0000"), Some([1.0, 0.0, 0.0]));
        assert_eq!(parse_colour("#0f0"), Some([0.0, 1.0, 0.0]));
        assert!(parse_colour("Brown").is_some());
        assert!(parse_colour("#12").is_none() && parse_colour("plaid").is_none());
    }

    #[test]
    fn clips_lines_to_the_tile_and_splits_them() {
        let pieces = clip_polyline(&[[-10.0, 5.0], [5.0, 5.0], [5.0, 20.0], [5.0, -5.0]], 0.0, 10.0);
        assert_eq!(pieces.len(), 2, "{pieces:?}");
        assert_eq!(pieces[0], vec![[0.0, 5.0], [5.0, 5.0], [5.0, 10.0]]);
        assert_eq!(pieces[1], vec![[5.0, 10.0], [5.0, 0.0]]);
        assert!(clip_polyline(&[[-5.0, -5.0], [-1.0, -1.0]], 0.0, 10.0).is_empty());
    }

    #[test]
    fn reads_buildings_and_roads_and_keeps_edge_buildings_in_one_tile() {
        let id = TileId { z: 14, x: 8544, y: 5827 };
        let inside = vec![vec![[100, 100], [140, 100], [140, 130], [100, 130]]];
        // Centroid outside the tile: it belongs to the neighbour.
        let edge = vec![vec![[-40, 100], [10, 100], [10, 130], [-40, 130]]];
        let hole_and_merged = vec![vec![[200, 200], [260, 200], [260, 260], [200, 260]], vec![[210, 210], [210, 220], [220, 220], [220, 210]], vec![[300, 300], [330, 300], [330, 320], [300, 320]]];
        let mut bytes = encode_layer("building", &[
            (3, vec![("render_height", Value::Int(9)), ("render_min_height", Value::Int(0))], inside),
            (3, vec![("render_height", Value::Int(9))], edge),
            (3, vec![("render_height", Value::Int(6)), ("colour", Value::String("#808080".into()))], hole_and_merged),
            (3, vec![("render_height", Value::Int(20)), ("hide_3d", Value::Bool(true))], vec![vec![[500, 500], [600, 500], [600, 600], [500, 600]]]),
        ]);
        bytes.extend(encode_layer("transportation", &[
            (2, vec![("class", Value::String("minor".into()))], vec![vec![[-100, 50], [5000, 50]]]),
            (2, vec![("class", Value::String("primary".into())), ("brunnel", Value::String("tunnel".into()))], vec![vec![[0, 60], [100, 60]]]),
            (2, vec![("class", Value::String("ferry".into()))], vec![vec![[0, 70], [100, 70]]]),
        ]));
        let t = parse_tile(id, &bytes, 6_371_000.0).unwrap();
        assert_eq!(t.buildings.len(), 3, "the inside one, and the merged multipolygon's two exteriors");
        assert_eq!(t.buildings[0].height, 9.0);
        assert!(t.buildings[2].colour.is_some());
        let unit = meters_per_unit(14, 4096, 46.02, 6_371_000.0);
        assert!((t.buildings[0].area - 40.0 * 30.0 * unit * unit).abs() / t.buildings[0].area < 0.01);
        assert_eq!(t.roads.len(), 1);
        assert_eq!(t.roads[0].class, RoadClass::Minor);
        let east_edge = tile_point_to_lat_lon(id, 4096, 4096.0, 0.0)[1];
        assert!((t.roads[0].points.last().unwrap()[1] - east_edge).abs() < 1e-9, "clipped at the tile edge");
    }

    #[test]
    fn reads_the_tile_url_from_tilejson() {
        let json = r#"{"tilejson":"3.0.0","tiles":["https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"]}"#;
        assert_eq!(template_from_tilejson(json).as_deref(), Some("https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"));
        assert!(template_from_tilejson("{}").is_none());
    }
}
