//! Double-precision vectors, frames and boxes. CAD accumulates error through long feature
//! histories, so the kernel works in f64 and only narrows to f32 when handing geometry to the GPU.

use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub};

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct V2 { pub x: f64, pub y: f64 }

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct V3 { pub x: f64, pub y: f64, pub z: f64 }

pub const fn v2(x: f64, y: f64) -> V2 { V2 { x, y } }
pub const fn v3(x: f64, y: f64, z: f64) -> V3 { V3 { x, y, z } }

macro_rules! vec_ops {
    ($t:ident, $($f:ident),+) => {
        impl Add for $t { type Output = $t; fn add(self, o: $t) -> $t { $t { $($f: self.$f + o.$f),+ } } }
        impl Sub for $t { type Output = $t; fn sub(self, o: $t) -> $t { $t { $($f: self.$f - o.$f),+ } } }
        impl Mul<f64> for $t { type Output = $t; fn mul(self, s: f64) -> $t { $t { $($f: self.$f * s),+ } } }
        impl Div<f64> for $t { type Output = $t; fn div(self, s: f64) -> $t { $t { $($f: self.$f / s),+ } } }
        impl Neg for $t { type Output = $t; fn neg(self) -> $t { $t { $($f: -self.$f),+ } } }
        impl AddAssign for $t { fn add_assign(&mut self, o: $t) { $(self.$f += o.$f;)+ } }
        impl $t {
            pub fn dot(self, o: $t) -> f64 { 0.0 $(+ self.$f * o.$f)+ }
            pub fn len(self) -> f64 { self.dot(self).sqrt() }
            pub fn dist(self, o: $t) -> f64 { (self - o).len() }
            /// Unit vector, or zero for a (near) zero vector.
            pub fn norm(self) -> $t { let l = self.len(); if l > 1e-300 { self / l } else { $t::default() } }
            pub fn lerp(self, o: $t, t: f64) -> $t { self + (o - self) * t }
            pub fn is_finite(self) -> bool { true $(&& self.$f.is_finite())+ }
        }
    };
}
vec_ops!(V2, x, y);
vec_ops!(V3, x, y, z);

impl V2 {
    /// z of the 3D cross product: positive when `o` is counter-clockwise from `self`.
    pub fn cross(self, o: V2) -> f64 { self.x * o.y - self.y * o.x }
    /// Rotated a quarter turn counter-clockwise.
    pub fn perp(self) -> V2 { v2(-self.y, self.x) }
    pub fn rotate(self, radians: f64) -> V2 { let (s, c) = radians.sin_cos(); v2(self.x * c - self.y * s, self.x * s + self.y * c) }
    pub fn arr(self) -> [f64; 2] { [self.x, self.y] }
}
impl From<[f64; 2]> for V2 { fn from(a: [f64; 2]) -> V2 { v2(a[0], a[1]) } }

impl V3 {
    pub fn cross(self, o: V3) -> V3 { v3(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x) }
    pub fn arr(self) -> [f64; 3] { [self.x, self.y, self.z] }
    pub fn get(self, axis: usize) -> f64 { match axis { 0 => self.x, 1 => self.y, _ => self.z } }
    pub fn set(&mut self, axis: usize, v: f64) { match axis { 0 => self.x = v, 1 => self.y = v, _ => self.z = v } }
    pub fn min(self, o: V3) -> V3 { v3(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z)) }
    pub fn max(self, o: V3) -> V3 { v3(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z)) }
    /// Rotated about the unit `axis` (Rodrigues).
    pub fn rotate(self, axis: V3, radians: f64) -> V3 {
        let (s, c) = radians.sin_cos();
        self * c + axis.cross(self) * s + axis * (axis.dot(self) * (1.0 - c))
    }
    /// Some unit vector perpendicular to this one.
    pub fn any_perp(self) -> V3 {
        let a = if self.x.abs() < 0.6 * self.len() { v3(1.0, 0.0, 0.0) } else { v3(0.0, 1.0, 0.0) };
        self.cross(a).norm()
    }
}
impl From<[f64; 3]> for V3 { fn from(a: [f64; 3]) -> V3 { v3(a[0], a[1], a[2]) } }

/// A right-handed coordinate frame: a sketch plane (z is its normal), a section's placement.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame { pub o: V3, pub x: V3, pub y: V3, pub z: V3 }

impl Default for Frame { fn default() -> Self { Frame::WORLD } }

impl Frame {
    pub const WORLD: Frame = Frame { o: v3(0.0, 0.0, 0.0), x: v3(1.0, 0.0, 0.0), y: v3(0.0, 1.0, 0.0), z: v3(0.0, 0.0, 1.0) };
    /// Orthonormal frame from an origin, an x direction and an approximate y.
    pub fn from_xy(o: V3, x: V3, y: V3) -> Frame {
        let x = x.norm();
        let z = x.cross(y).norm();
        Frame { o, x, y: z.cross(x), z }
    }
    pub fn point(&self, p: V2) -> V3 { self.o + self.x * p.x + self.y * p.y }
    pub fn point3(&self, p: V3) -> V3 { self.o + self.x * p.x + self.y * p.y + self.z * p.z }
    pub fn dir(&self, d: V3) -> V3 { self.x * d.x + self.y * d.y + self.z * d.z }
    /// World point in this frame's coordinates (z is the height off its plane).
    pub fn local(&self, p: V3) -> V3 { let d = p - self.o; v3(d.dot(self.x), d.dot(self.y), d.dot(self.z)) }
    /// Where the ray `origin + t * dir` crosses the frame's plane, in plane coordinates.
    pub fn intersect_ray(&self, origin: V3, dir: V3) -> Option<V2> {
        let denom = dir.dot(self.z);
        if denom.abs() < 1e-12 { return None; }
        let t = (self.o - origin).dot(self.z) / denom;
        if t < 0.0 { return None; }
        let l = self.local(origin + dir * t);
        Some(v2(l.x, l.y))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Aabb { pub min: V3, pub max: V3 }

impl Aabb {
    pub const EMPTY: Aabb = Aabb { min: v3(f64::INFINITY, f64::INFINITY, f64::INFINITY), max: v3(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY) };
    pub fn of(points: impl IntoIterator<Item = V3>) -> Aabb { let mut b = Aabb::EMPTY; for p in points { b.add(p); } b }
    pub fn add(&mut self, p: V3) { self.min = self.min.min(p); self.max = self.max.max(p); }
    pub fn union(self, o: Aabb) -> Aabb { Aabb { min: self.min.min(o.min), max: self.max.max(o.max) } }
    pub fn is_empty(&self) -> bool { self.min.x > self.max.x }
    pub fn center(&self) -> V3 { (self.min + self.max) * 0.5 }
    pub fn size(&self) -> V3 { self.max - self.min }
    pub fn diagonal(&self) -> f64 { if self.is_empty() { 0.0 } else { self.size().len() } }
    pub fn grown(self, by: f64) -> Aabb { Aabb { min: self.min - v3(by, by, by), max: self.max + v3(by, by, by) } }
    pub fn overlaps(&self, o: &Aabb) -> bool {
        self.min.x <= o.max.x && self.max.x >= o.min.x && self.min.y <= o.max.y && self.max.y >= o.min.y && self.min.z <= o.max.z && self.max.z >= o.min.z
    }
    /// Slab test: does the ray reach the box before `t_max`?
    pub fn hit_by(&self, origin: V3, inv_dir: V3, t_max: f64) -> bool {
        let (mut t0, mut t1) = (0.0f64, t_max);
        for a in 0..3 {
            let (o, i) = (origin.get(a), inv_dir.get(a));
            let (mut ta, mut tb) = ((self.min.get(a) - o) * i, (self.max.get(a) - o) * i);
            if ta > tb { std::mem::swap(&mut ta, &mut tb); }
            // NaN (0 * inf) compares false and leaves the interval alone, which is what we want.
            if ta > t0 { t0 = ta; }
            if tb < t1 { t1 = tb; }
            if t0 > t1 { return false; }
        }
        true
    }
}

/// Signed area of a closed polygon (positive when counter-clockwise).
pub fn polygon_area(p: &[V2]) -> f64 {
    let mut a = 0.0;
    for i in 0..p.len() { let (u, v) = (p[i], p[(i + 1) % p.len()]); a += u.cross(v); }
    a * 0.5
}

/// Area centroid of a closed polygon (its vertex average if it has no area).
pub fn polygon_centroid(p: &[V2]) -> V2 {
    let (mut a, mut c) = (0.0, V2::default());
    for i in 0..p.len() {
        let (u, v) = (p[i], p[(i + 1) % p.len()]);
        let k = u.cross(v);
        a += k;
        c += (u + v) * k;
    }
    if a.abs() < 1e-12 { return p.iter().fold(V2::default(), |s, q| s + *q) / p.len().max(1) as f64; }
    c / (3.0 * a)
}

/// Even-odd point in polygon.
pub fn point_in_polygon(q: V2, p: &[V2]) -> bool {
    let mut inside = false;
    let mut j = p.len().wrapping_sub(1);
    for i in 0..p.len() {
        let (a, b) = (p[i], p[j]);
        if (a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x { inside = !inside; }
        j = i;
    }
    inside
}

/// Closest point on segment `a..b` to `q`, as (parameter 0..1, point).
pub fn closest_on_segment(q: V2, a: V2, b: V2) -> (f64, V2) {
    let d = b - a;
    let l2 = d.dot(d);
    let t = if l2 < 1e-300 { 0.0 } else { ((q - a).dot(d) / l2).clamp(0.0, 1.0) };
    (t, a + d * t)
}
