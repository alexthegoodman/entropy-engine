//! Small f64 vector helpers for QuadPlanet. Plain arrays keep the hot loops (chunk building)
//! allocation-free, and doubles keep kilometer-scale planets (and Earth, 6,371 km in radius)
//! exact to well under a millimeter before anything is made camera-relative for the GPU.

pub type V3 = [f64; 3];

#[inline] pub fn add(a: V3, b: V3) -> V3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
#[inline] pub fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
#[inline] pub fn scale(a: V3, s: f64) -> V3 { [a[0] * s, a[1] * s, a[2] * s] }
#[inline] pub fn add_scaled(a: V3, b: V3, s: f64) -> V3 { [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s] }
#[inline] pub fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
#[inline] pub fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
#[inline] pub fn length(a: V3) -> f64 { (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt() }
#[inline] pub fn distance(a: V3, b: V3) -> f64 { length(sub(a, b)) }
#[inline] pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 { x.max(lo).min(hi) }
#[inline] pub fn lerp(a: V3, b: V3, t: f64) -> V3 { [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }

pub fn smoothstep(e0: f64, e1: f64, x: f64) -> f64 {
    let t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

pub fn normalize(a: V3) -> V3 {
    let l = length(a);
    if l > 1e-12 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 1.0, 0.0] }
}

/// Any unit vector perpendicular to the unit `n`.
pub fn any_perpendicular(n: V3) -> V3 {
    let helper = if n[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
    normalize(cross(helper, n))
}

/// Rotates `v` around the unit `axis` by `angle` radians (Rodrigues).
pub fn rotate_around(v: V3, axis: V3, angle: f64) -> V3 {
    let (s, c) = angle.sin_cos();
    let k = cross(axis, v);
    let d = dot(axis, v) * (1.0 - c);
    [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d]
}

// --- Geography -------------------------------------------------------------------------------
//
// A planet's own frame: +Y is the north pole, latitude 0 / longitude 0 is +Z, and east is +X,
// so a camera out on +Z looking at the planet with +Y up sees east to its right, as on a map.

/// Unit direction (planet frame) of a latitude/longitude in degrees.
pub fn lat_lon_to_dir(lat: f64, lon: f64) -> V3 {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    [la.cos() * lo.sin(), la.sin(), la.cos() * lo.cos()]
}

/// Latitude and longitude in degrees of a unit direction (planet frame).
pub fn dir_to_lat_lon(d: V3) -> (f64, f64) {
    let lat = clamp(d[1], -1.0, 1.0).asin().to_degrees();
    let lon = d[0].atan2(d[2]).to_degrees();
    (lat, lon)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lat_lon_round_trips_and_east_is_plus_x() {
        for &(lat, lon) in &[(0.0, 0.0), (45.0, 90.0), (-33.9, 151.2), (27.99, 86.93), (-89.0, -170.0)] {
            let (a, b) = dir_to_lat_lon(lat_lon_to_dir(lat, lon));
            assert!((a - lat).abs() < 1e-9 && (b - lon).abs() < 1e-9, "{lat},{lon} -> {a},{b}");
        }
        let east = lat_lon_to_dir(0.0, 90.0);
        assert!((east[0] - 1.0).abs() < 1e-12);
        assert!((lat_lon_to_dir(90.0, 0.0)[1] - 1.0).abs() < 1e-12);
    }
}
