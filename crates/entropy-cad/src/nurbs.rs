//! Non-uniform rational B-spline curves: the one exact curve type everything else is built from.
//! Lines, circular and elliptical arcs, splines through points and control-polygon splines are all
//! constructors here, so every tool downstream (tessellation, closest point, curvature, sweeping)
//! is written once.
//!
//! Algorithm numbers refer to Piegl & Tiller, "The NURBS Book".

use crate::math::{v3, V3};

#[derive(Clone, Debug, PartialEq)]
pub struct NurbsCurve {
    pub degree: usize,
    pub knots: Vec<f64>,
    /// Homogeneous control points (w*x, w*y, w*z, w).
    pub ctrl: Vec<[f64; 4]>,
    /// The parameter range in use. A clamped curve uses its whole knot range; a periodic one the middle.
    pub domain: (f64, f64),
}

/// How finely to flatten a curve: the chord may stray `chord` from the curve, and neighbouring
/// segments may turn at most `angle` radians (which is what keeps small arcs round).
#[derive(Clone, Copy, Debug)]
pub struct Tolerance { pub chord: f64, pub angle: f64 }

impl Default for Tolerance { fn default() -> Self { Tolerance { chord: 0.02, angle: 6f64.to_radians() } } }

impl Tolerance {
    /// Coarser, for geometry rebuilt on every frame of a drag.
    pub fn draft(self) -> Tolerance { Tolerance { chord: self.chord * 4.0, angle: self.angle * 2.0 } }
}

fn hom(p: V3, w: f64) -> [f64; 4] { [p.x * w, p.y * w, p.z * w, w] }

impl NurbsCurve {
    fn clamped(degree: usize, ctrl: Vec<[f64; 4]>, interior: &[f64], u0: f64, u1: f64) -> NurbsCurve {
        let mut knots = vec![u0; degree + 1];
        knots.extend_from_slice(interior);
        knots.extend(std::iter::repeat(u1).take(degree + 1));
        debug_assert_eq!(knots.len(), ctrl.len() + degree + 1);
        NurbsCurve { degree, knots, ctrl, domain: (u0, u1) }
    }

    pub fn line(a: V3, b: V3) -> NurbsCurve { Self::clamped(1, vec![hom(a, 1.0), hom(b, 1.0)], &[], 0.0, 1.0) }

    /// An arc of the ellipse `center + ax*cos(t) + ay*sin(t)` from angle `start`, sweeping `sweep`
    /// radians (negative for clockwise, any number of turns). A circle when `ax` and `ay` are
    /// perpendicular and equally long. Exact (rational quadratic, A7.1).
    pub fn arc(center: V3, ax: V3, ay: V3, start: f64, sweep: f64) -> NurbsCurve {
        let n = ((sweep.abs() / std::f64::consts::FRAC_PI_2) - 1e-9).ceil().max(1.0) as usize;
        let step = sweep / n as f64;
        let w1 = (step * 0.5).cos();
        let at = |t: f64| center + ax * t.cos() + ay * t.sin();
        let mut ctrl = vec![hom(at(start), 1.0)];
        let mut interior = Vec::new();
        for i in 0..n {
            let a = start + step * i as f64;
            let mid = a + step * 0.5;
            ctrl.push(hom(center + (ax * mid.cos() + ay * mid.sin()) / w1, w1));
            ctrl.push(hom(at(a + step), 1.0));
            if i + 1 < n { let k = (i + 1) as f64 / n as f64; interior.push(k); interior.push(k); }
        }
        Self::clamped(2, ctrl, &interior, 0.0, 1.0)
    }

    pub fn circle(center: V3, ax: V3, ay: V3) -> NurbsCurve { Self::arc(center, ax, ay, 0.0, std::f64::consts::TAU) }

    /// The circular arc from `a` to `b` through `via`, in the plane of the three points. Collinear
    /// points give the straight line from `a` to `b`.
    pub fn arc_through(a: V3, via: V3, b: V3) -> NurbsCurve {
        match circumcircle(a, via, b) {
            None => Self::line(a, b),
            Some((c, n)) => {
                let ax = a - c;
                let ay = n.cross(ax);
                let angle = |p: V3| { let d = p - c; let t = d.dot(ay).atan2(d.dot(ax)); if t < 0.0 { t + std::f64::consts::TAU } else { t } };
                // `n` is oriented so a -> via -> b runs counter-clockwise: the sweep is b's angle.
                let _ = angle(via);
                Self::arc(c, ax, ay, 0.0, angle(b).max(1e-9))
            }
        }
    }

    /// A smooth (curvature-continuous) cubic through every point: the curve designers draw with.
    /// `tension[i]` scales the tangent at point i (1 is the natural spline; lower pulls the curve
    /// tight around the point, higher lets it swing wide) so one side of a shape can be made fuller
    /// than the other without adding points. Missing entries are 1.
    pub fn through(points: &[V3], closed: bool, tension: &[f64]) -> NurbsCurve {
        let mut pts: Vec<V3> = Vec::with_capacity(points.len());
        let mut ten: Vec<f64> = Vec::with_capacity(points.len());
        for (i, p) in points.iter().enumerate() {
            if pts.last().map_or(true, |q| q.dist(*p) > 1e-9) { pts.push(*p); ten.push(tension.get(i).copied().unwrap_or(1.0)); }
        }
        if closed && pts.len() > 2 && pts[0].dist(*pts.last().unwrap()) <= 1e-9 { pts.pop(); ten.pop(); }
        let n = pts.len();
        if n == 0 { return Self::line(V3::default(), V3::default()); }
        if n == 1 { return Self::line(pts[0], pts[0]); }
        if n == 2 { return Self::line(pts[0], pts[1]); }
        let closed = closed && n >= 3;
        let segs = if closed { n } else { n - 1 };
        // Centripetal spacing: no loops or overshoot where points bunch up.
        let h: Vec<f64> = (0..segs).map(|i| pts[i].dist(pts[(i + 1) % n]).sqrt().max(1e-9)).collect();
        // Tangents m_i making the piecewise cubic C2: a (cyclic) tridiagonal system, solved densely.
        let mut a = vec![vec![0.0f64; n]; n];
        let mut rhs = vec![V3::default(); n];
        for i in 0..n {
            if !closed && i == 0 {
                a[0][0] = 2.0; a[0][1] = 1.0;
                rhs[0] = (pts[1] - pts[0]) * (3.0 / h[0]);
            } else if !closed && i == n - 1 {
                a[i][i - 1] = 1.0; a[i][i] = 2.0;
                rhs[i] = (pts[i] - pts[i - 1]) * (3.0 / h[i - 1]);
            } else {
                let (prev, next) = ((i + n - 1) % n, (i + 1) % n);
                let (hp, hn) = (h[(i + segs - 1) % segs], h[i % segs]);
                a[i][prev] += hn; a[i][i] += 2.0 * (hp + hn); a[i][next] += hp;
                rhs[i] = (pts[i] - pts[prev]) * (3.0 * hn / hp) + (pts[next] - pts[i]) * (3.0 * hp / hn);
            }
        }
        let m = solve(a, rhs);
        // Each span as a Bezier; joined they are a cubic B-spline with triple interior knots.
        let mut ctrl = vec![hom(pts[0], 1.0)];
        let mut interior = Vec::new();
        let mut t = 0.0;
        for i in 0..segs {
            let j = (i + 1) % n;
            ctrl.push(hom(pts[i] + m[i] * (h[i] / 3.0 * ten[i]), 1.0));
            ctrl.push(hom(pts[j] - m[j] * (h[i] / 3.0 * ten[j]), 1.0));
            ctrl.push(hom(pts[j], 1.0));
            t += h[i];
            if i + 1 < segs { interior.extend([t, t, t]); }
        }
        Self::clamped(3, ctrl, &interior, 0.0, t)
    }

    /// A B-spline pulled toward (not through) its control points, up to cubic. A point's weight is
    /// how hard it pulls: the classic NURBS handle for making a curve fuller on one side.
    pub fn control(points: &[V3], weights: &[f64], closed: bool) -> NurbsCurve {
        let n = points.len();
        if n == 0 { return Self::line(V3::default(), V3::default()); }
        if n == 1 { return Self::line(points[0], points[0]); }
        let w = |i: usize| weights.get(i).copied().filter(|w| *w > 1e-6).unwrap_or(1.0);
        if closed && n >= 3 {
            let p = 3.min(n - 1).max(2);
            let ctrl: Vec<[f64; 4]> = (0..n + p).map(|i| hom(points[i % n], w(i % n))).collect();
            let knots: Vec<f64> = (0..ctrl.len() + p + 1).map(|i| i as f64).collect();
            return NurbsCurve { degree: p, knots, ctrl, domain: (p as f64, (n + p) as f64) };
        }
        let p = 3.min(n - 1);
        let ctrl: Vec<[f64; 4]> = (0..n).map(|i| hom(points[i], w(i))).collect();
        let spans = n - p;
        let interior: Vec<f64> = (1..spans).map(|i| i as f64).collect();
        Self::clamped(p, ctrl, &interior, 0.0, spans as f64)
    }

    fn find_span(&self, u: f64) -> usize {
        let n = self.ctrl.len() - 1;
        let p = self.degree;
        if u >= self.knots[n + 1] { return n; }
        if u <= self.knots[p] { return p; }
        let (mut lo, mut hi) = (p, n + 1);
        let mut mid = (lo + hi) / 2;
        while u < self.knots[mid] || u >= self.knots[mid + 1] {
            if u < self.knots[mid] { hi = mid; } else { lo = mid; }
            mid = (lo + hi) / 2;
        }
        mid
    }

    /// Nonzero basis functions and their derivatives up to order `n` at `u` (A2.3): `ders[k][j]`.
    fn ders_basis(&self, span: usize, u: f64, n: usize) -> Vec<Vec<f64>> {
        let p = self.degree;
        let k = &self.knots;
        let mut ndu = vec![vec![0.0f64; p + 1]; p + 1];
        let mut left = vec![0.0f64; p + 1];
        let mut right = vec![0.0f64; p + 1];
        ndu[0][0] = 1.0;
        for j in 1..=p {
            left[j] = u - k[span + 1 - j];
            right[j] = k[span + j] - u;
            let mut saved = 0.0;
            for r in 0..j {
                ndu[j][r] = right[r + 1] + left[j - r];
                let temp = if ndu[j][r] != 0.0 { ndu[r][j - 1] / ndu[j][r] } else { 0.0 };
                ndu[r][j] = saved + right[r + 1] * temp;
                saved = left[j - r] * temp;
            }
            ndu[j][j] = saved;
        }
        let mut ders = vec![vec![0.0f64; p + 1]; n + 1];
        for j in 0..=p { ders[0][j] = ndu[j][p]; }
        let mut a = vec![vec![0.0f64; p + 1]; 2];
        for r in 0..=p {
            let (mut s1, mut s2) = (0usize, 1usize);
            a[0][0] = 1.0;
            for kk in 1..=n.min(p) {
                let mut d = 0.0;
                let rk = r as isize - kk as isize;
                let pk = p - kk;
                if r >= kk {
                    a[s2][0] = if ndu[pk + 1][rk as usize] != 0.0 { a[s1][0] / ndu[pk + 1][rk as usize] } else { 0.0 };
                    d = a[s2][0] * ndu[rk as usize][pk];
                }
                let j1 = if rk >= -1 { 1 } else { (-rk) as usize };
                let j2 = if r as isize - 1 <= pk as isize { kk - 1 } else { p - r };
                for j in j1..=j2 {
                    let idx = (rk + j as isize) as usize;
                    a[s2][j] = if ndu[pk + 1][idx] != 0.0 { (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][idx] } else { 0.0 };
                    d += a[s2][j] * ndu[idx][pk];
                }
                if r <= pk {
                    a[s2][kk] = if ndu[pk + 1][r] != 0.0 { -a[s1][kk - 1] / ndu[pk + 1][r] } else { 0.0 };
                    d += a[s2][kk] * ndu[r][pk];
                }
                ders[kk][r] = d;
                std::mem::swap(&mut s1, &mut s2);
            }
        }
        let mut f = p as f64;
        for kk in 1..=n.min(p) {
            for j in 0..=p { ders[kk][j] *= f; }
            f *= (p - kk) as f64;
        }
        ders
    }

    /// Position and the first `n` derivatives at `u` (A4.2), `n` up to 2.
    pub fn derivs(&self, u: f64, n: usize) -> [V3; 3] {
        let u = u.clamp(self.domain.0, self.domain.1);
        let span = self.find_span(u);
        let nd = self.ders_basis(span, u, n);
        let p = self.degree;
        let mut a = [V3::default(); 3];
        let mut w = [0.0f64; 3];
        for k in 0..=n.min(2) {
            for j in 0..=p {
                let c = self.ctrl[span - p + j];
                a[k] += v3(c[0], c[1], c[2]) * nd[k][j];
                w[k] += c[3] * nd[k][j];
            }
        }
        let mut out = [V3::default(); 3];
        out[0] = a[0] / w[0];
        if n >= 1 { out[1] = (a[1] - out[0] * w[1]) / w[0]; }
        if n >= 2 { out[2] = (a[2] - out[1] * (2.0 * w[1]) - out[0] * w[2]) / w[0]; }
        out
    }

    pub fn point(&self, u: f64) -> V3 { self.derivs(u, 0)[0] }
    pub fn tangent(&self, u: f64) -> V3 { self.derivs(u, 1)[1].norm() }
    pub fn start(&self) -> V3 { self.point(self.domain.0) }
    pub fn end(&self) -> V3 { self.point(self.domain.1) }

    /// Curvature (1/radius) at `u`, signed for a curve in the xy plane: positive where it turns left.
    pub fn curvature(&self, u: f64) -> f64 {
        let d = self.derivs(u, 2);
        let s = d[1].len();
        if s < 1e-12 { return 0.0; }
        let c = d[1].cross(d[2]);
        let k = c.len() / (s * s * s);
        if c.z < 0.0 { -k } else { k }
    }

    /// Distinct knot values inside the domain, with both ends.
    fn breaks(&self) -> Vec<f64> {
        let (a, b) = self.domain;
        let mut out = vec![a];
        for &k in &self.knots { if k > a + 1e-12 && k < b - 1e-12 && k > out.last().unwrap() + 1e-12 { out.push(k); } }
        out.push(b);
        out
    }

    /// Flattens the curve to a polyline of (parameter, point), ends included.
    pub fn tessellate(&self, tol: Tolerance) -> Vec<(f64, V3)> {
        let mut out = vec![(self.domain.0, self.start())];
        let breaks = self.breaks();
        for w in breaks.windows(2) {
            // Start from `degree` pieces a span so an S-shaped span can't hide behind its chord.
            let pieces = if self.degree <= 1 { 1 } else { self.degree };
            for i in 0..pieces {
                let (ua, ub) = (w[0] + (w[1] - w[0]) * i as f64 / pieces as f64, w[0] + (w[1] - w[0]) * (i + 1) as f64 / pieces as f64);
                let (pa, pb) = (self.point(ua), self.point(ub));
                self.flatten(ua, pa, ub, pb, tol, 0, &mut out);
            }
        }
        out
    }

    fn flatten(&self, ua: f64, pa: V3, ub: f64, pb: V3, tol: Tolerance, depth: u32, out: &mut Vec<(f64, V3)>) {
        let um = 0.5 * (ua + ub);
        let pm = self.point(um);
        let flat = self.degree <= 1 || depth >= 12 || {
            let chord = pb - pa;
            let len = chord.len();
            let off = |p: V3| if len < 1e-12 { p.dist(pa) } else { (p - pa).cross(chord).len() / len };
            let dev = off(pm).max(off(self.point(ua + 0.25 * (ub - ua)))).max(off(self.point(ua + 0.75 * (ub - ua))));
            let turn = self.tangent(ua).dot(self.tangent(ub)).clamp(-1.0, 1.0).acos();
            dev <= tol.chord && turn <= tol.angle
        };
        if flat { out.push((ub, pb)); return; }
        self.flatten(ua, pa, um, pm, tol, depth + 1, out);
        self.flatten(um, pm, ub, pb, tol, depth + 1, out);
    }

    /// Arc length (5-point Gauss-Legendre on quarter spans).
    pub fn length(&self) -> f64 {
        const X: [f64; 5] = [0.0, 0.538_469_310_105_683, -0.538_469_310_105_683, 0.906_179_845_938_664, -0.906_179_845_938_664];
        const W: [f64; 5] = [0.568_888_888_888_889, 0.478_628_670_499_366, 0.478_628_670_499_366, 0.236_926_885_056_189, 0.236_926_885_056_189];
        let mut total = 0.0;
        for w in self.breaks().windows(2) {
            for q in 0..4 {
                let (a, b) = (w[0] + (w[1] - w[0]) * q as f64 / 4.0, w[0] + (w[1] - w[0]) * (q + 1) as f64 / 4.0);
                let (c, h) = (0.5 * (a + b), 0.5 * (b - a));
                for i in 0..5 { total += W[i] * h * self.derivs(c + h * X[i], 1)[1].len(); }
            }
        }
        total
    }

    /// The parameter and point on the curve nearest `q`.
    pub fn closest(&self, q: V3) -> (f64, V3) {
        let poly = self.tessellate(Tolerance::default());
        let (mut best_u, mut best_d) = (self.domain.0, f64::INFINITY);
        for w in poly.windows(2) {
            let d = w[1].1 - w[0].1;
            let l2 = d.dot(d);
            let t = if l2 < 1e-300 { 0.0 } else { ((q - w[0].1).dot(d) / l2).clamp(0.0, 1.0) };
            let dist = q.dist(w[0].1 + d * t);
            if dist < best_d { best_d = dist; best_u = w[0].0 + (w[1].0 - w[0].0) * t; }
        }
        // Newton on (C(u) - q) . C'(u) = 0 from the polyline's answer.
        let mut u = best_u;
        for _ in 0..8 {
            let d = self.derivs(u, 2);
            let r = d[0] - q;
            let denom = d[1].dot(d[1]) + r.dot(d[2]);
            if denom.abs() < 1e-14 { break; }
            let next = (u - r.dot(d[1]) / denom).clamp(self.domain.0, self.domain.1);
            if (next - u).abs() < 1e-12 { u = next; break; }
            u = next;
        }
        let p = self.point(u);
        if p.dist(q) <= best_d + 1e-12 { (u, p) } else { (best_u, self.point(best_u)) }
    }

    /// The same curve after an affine map of space.
    pub fn mapped(&self, f: impl Fn(V3) -> V3) -> NurbsCurve {
        let ctrl = self.ctrl.iter().map(|c| hom(f(v3(c[0] / c[3], c[1] / c[3], c[2] / c[3])), c[3])).collect();
        NurbsCurve { degree: self.degree, knots: self.knots.clone(), ctrl, domain: self.domain }
    }
}

/// Center of the circle through three points and the unit normal that makes a -> b -> c
/// counter-clockwise; None if they are (nearly) collinear.
pub fn circumcircle(a: V3, b: V3, c: V3) -> Option<(V3, V3)> {
    let (ab, ac) = (b - a, c - a);
    let n = ab.cross(ac);
    let n2 = n.dot(n);
    if n2 < 1e-18 * (ab.dot(ab) * ac.dot(ac)).max(1e-300) { return None; }
    let center = a + (n.cross(ab) * ac.dot(ac) + ac.cross(n) * ab.dot(ab)) / (2.0 * n2);
    Some((center, n.norm()))
}

/// Gaussian elimination with partial pivoting, one right-hand side per coordinate.
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<V3>) -> Vec<V3> {
    let n = b.len();
    for col in 0..n {
        let pivot = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs())).unwrap();
        a.swap(col, pivot);
        b.swap(col, pivot);
        let d = a[col][col];
        if d.abs() < 1e-14 { continue; }
        for row in col + 1..n {
            let f = a[row][col] / d;
            if f == 0.0 { continue; }
            for k in col..n { a[row][k] -= f * a[col][k]; }
            b[row] = b[row] - b[col] * f;
        }
    }
    let mut x = vec![V3::default(); n];
    for row in (0..n).rev() {
        let mut s = b[row];
        for k in row + 1..n { s = s - x[k] * a[row][k]; }
        x[row] = if a[row][row].abs() < 1e-14 { V3::default() } else { s / a[row][row] };
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::{PI, TAU};

    const X: V3 = v3(1.0, 0.0, 0.0);
    const Y: V3 = v3(0.0, 1.0, 0.0);

    #[test]
    fn a_circle_is_exact_everywhere() {
        let c = NurbsCurve::circle(v3(3.0, -2.0, 0.0), X * 5.0, Y * 5.0);
        for i in 0..=200 {
            let p = c.point(i as f64 / 200.0);
            assert!((p.dist(v3(3.0, -2.0, 0.0)) - 5.0).abs() < 1e-12);
        }
        assert!((c.length() - TAU * 5.0).abs() < 1e-6, "{}", c.length());
        assert!((c.curvature(0.3) - 0.2).abs() < 1e-9, "{}", c.curvature(0.3));
        assert!(c.start().dist(c.end()) < 1e-12);
    }

    #[test]
    fn an_arc_sweeps_either_way_and_more_than_a_turn() {
        let ccw = NurbsCurve::arc(V3::default(), X, Y, 0.0, PI * 0.75);
        assert!(ccw.end().dist(v3((PI * 0.75).cos(), (PI * 0.75).sin(), 0.0)) < 1e-12);
        let cw = NurbsCurve::arc(V3::default(), X, Y, 0.0, -PI * 0.5);
        assert!(cw.end().dist(v3(0.0, -1.0, 0.0)) < 1e-12);
        assert!(cw.curvature(0.5) < 0.0);
        let helix_turns = NurbsCurve::arc(V3::default(), X, Y, 0.0, TAU * 2.5);
        assert!((helix_turns.length() - TAU * 2.5).abs() < 1e-6);
    }

    #[test]
    fn an_ellipse_arc_lands_on_the_ellipse() {
        let e = NurbsCurve::circle(V3::default(), X * 4.0, Y * 1.5);
        for i in 0..50 {
            let p = e.point(i as f64 / 50.0);
            assert!(((p.x / 4.0).powi(2) + (p.y / 1.5).powi(2) - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn a_three_point_arc_passes_through_all_three() {
        let (a, via, b) = (v3(0.0, 0.0, 0.0), v3(5.0, 3.0, 0.0), v3(10.0, 0.0, 0.0));
        let c = NurbsCurve::arc_through(a, via, b);
        assert!(c.start().dist(a) < 1e-9 && c.end().dist(b) < 1e-9);
        assert!(c.closest(via).1.dist(via) < 1e-7);
        // The other way round bulges the other way.
        let d = NurbsCurve::arc_through(a, v3(5.0, -3.0, 0.0), b);
        assert!(d.point(0.5).y < 0.0);
        // Collinear: a line.
        assert_eq!(NurbsCurve::arc_through(a, v3(5.0, 0.0, 0.0), b).degree, 1);
    }

    #[test]
    fn a_spline_goes_through_its_points_smoothly() {
        let pts = [v3(0.0, 0.0, 0.0), v3(10.0, 8.0, 0.0), v3(25.0, -3.0, 0.0), v3(40.0, 12.0, 0.0), v3(41.0, 30.0, 0.0)];
        let c = NurbsCurve::through(&pts, false, &[]);
        for p in pts { assert!(c.closest(p).1.dist(p) < 1e-7); }
        // C2 at the interior joins: curvature agrees from both sides.
        for k in c.breaks().iter().skip(1).rev().skip(1) {
            let (a, b) = (c.curvature(k - 1e-7), c.curvature(k + 1e-7));
            assert!((a - b).abs() < 1e-4, "curvature jumps at {k}: {a} vs {b}");
        }
        // Natural ends: no curvature.
        assert!(c.curvature(c.domain.0).abs() < 1e-9);
    }

    #[test]
    fn a_closed_spline_has_no_seam() {
        let pts = [v3(0.0, 0.0, 0.0), v3(30.0, 5.0, 0.0), v3(35.0, 30.0, 0.0), v3(10.0, 42.0, 0.0), v3(-12.0, 20.0, 0.0)];
        let c = NurbsCurve::through(&pts, true, &[]);
        assert!(c.start().dist(c.end()) < 1e-9);
        assert!(c.tangent(c.domain.0).dist(c.tangent(c.domain.1)) < 1e-9);
        assert!((c.curvature(c.domain.0) - c.curvature(c.domain.1)).abs() < 1e-9);
    }

    #[test]
    fn tension_makes_one_side_fuller() {
        let pts = [v3(0.0, 0.0, 0.0), v3(10.0, 10.0, 0.0), v3(20.0, 0.0, 0.0)];
        let even = NurbsCurve::through(&pts, false, &[]);
        let full = NurbsCurve::through(&pts, false, &[1.0, 2.5, 1.0]);
        // Still through the points, but wider at the shoulder.
        assert!(full.closest(pts[1]).1.dist(pts[1]) < 1e-7);
        let widest = |c: &NurbsCurve| c.tessellate(Tolerance::default()).iter().map(|p| p.1.y).fold(0.0, f64::max);
        assert!((widest(&even) - 10.0).abs() < 0.5);
        let reach = |c: &NurbsCurve| c.tessellate(Tolerance::default()).iter().filter(|p| p.1.y > 8.0).map(|p| p.1.x).fold(f64::INFINITY, f64::min);
        assert!(reach(&full) < reach(&even) - 0.5, "{} vs {}", reach(&full), reach(&even));
    }

    #[test]
    fn a_control_spline_is_pulled_by_weight() {
        let pts = [v3(0.0, 0.0, 0.0), v3(10.0, 20.0, 0.0), v3(20.0, 0.0, 0.0)];
        let light = NurbsCurve::control(&pts, &[], false);
        let heavy = NurbsCurve::control(&pts, &[1.0, 6.0, 1.0], false);
        assert!(light.start().dist(pts[0]) < 1e-12 && light.end().dist(pts[2]) < 1e-12);
        assert!(heavy.point(1.0 * 0.5).y > light.point(0.5).y + 3.0);
        // Closed and periodic: the seam is smooth.
        let ring = NurbsCurve::control(&[v3(0.0, 0.0, 0.0), v3(10.0, 0.0, 0.0), v3(10.0, 10.0, 0.0), v3(0.0, 10.0, 0.0)], &[], true);
        assert!(ring.start().dist(ring.end()) < 1e-9);
        assert!(ring.tangent(ring.domain.0).dist(ring.tangent(ring.domain.1)) < 1e-9);
    }

    #[test]
    fn tessellation_respects_its_tolerance() {
        let c = NurbsCurve::circle(V3::default(), X * 50.0, Y * 50.0);
        for chord in [1.0, 0.1, 0.01] {
            let poly = c.tessellate(Tolerance { chord, angle: PI });
            let worst = poly.windows(2).map(|w| 50.0 - ((w[0].1 + w[1].1) * 0.5).len()).fold(0.0, f64::max);
            assert!(worst <= chord * 1.01, "sagitta {worst} over {chord}");
            assert!(poly.len() < (TAU * 50.0 / (8.0 * 50.0 * chord).sqrt()) as usize * 3 + 16, "{} points for {chord}", poly.len());
        }
        // The angle limit alone keeps a tiny circle round.
        let small = NurbsCurve::circle(V3::default(), X * 0.01, Y * 0.01);
        assert!(small.tessellate(Tolerance::default()).len() >= 48);
    }

    #[test]
    fn closest_point_refines_past_the_polyline() {
        let c = NurbsCurve::circle(V3::default(), X * 10.0, Y * 10.0);
        let (_, p) = c.closest(v3(30.0, 40.0, 0.0));
        assert!(p.dist(v3(6.0, 8.0, 0.0)) < 1e-9);
    }
}
