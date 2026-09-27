//! Low-level shape IR + immediate tessellation into the engine's native `Vertex` format.
//!
//! Each shape is tessellated to absolute pixel-space triangles the moment it's painted
//! (this GUI uses a single-pass architecture, no shape retention between frames), reusing
//! `lyon_tessellation` exactly like `src/shape_primitives/polygon.rs` already does for
//! in-world 2D content — just without that file's GPU-resource allocation, since here we
//! only need CPU-side vertex/index lists to append into a shared per-frame buffer.

use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{CornerRadius, Pos2, Rect};
use lyon_tessellation::{
    math::point, path::Path as LyonPath, BuffersBuilder, FillOptions, FillTessellator,
    FillVertex, StrokeOptions, StrokeTessellator, StrokeVertex, VertexBuffers,
};

pub enum Shape {
    ConvexPolygon { points: Vec<Pos2>, fill: Color32, stroke: Stroke },
}

impl Shape {
    pub fn convex_polygon(points: Vec<Pos2>, fill: Color32, stroke: Stroke) -> Shape {
        Shape::ConvexPolygon { points, fill, stroke }
    }
}

fn to_vertex(x: f32, y: f32, color: Color32) -> Vertex {
    Vertex::new(x, y, 0.0, color.to_array_f32())
}

fn fill_and_stroke(path: &LyonPath, fill: Color32, stroke: Stroke, closed_fill: bool) -> (Vec<Vertex>, Vec<u32>) {
    let mut geometry: VertexBuffers<Vertex, u32> = VertexBuffers::new();

    if closed_fill && fill.a() > 0 {
        let mut fill_tess = FillTessellator::new();
        let _ = fill_tess.tessellate_path(
            path,
            &FillOptions::default(),
            &mut BuffersBuilder::new(&mut geometry, |v: FillVertex| {
                to_vertex(v.position().x, v.position().y, fill)
            }),
        );
    }

    if stroke.width > 0.0 && stroke.color.a() > 0 {
        let mut stroke_tess = StrokeTessellator::new();
        let _ = stroke_tess.tessellate_path(
            path,
            &StrokeOptions::default().with_line_width(stroke.width),
            &mut BuffersBuilder::new(&mut geometry, |v: StrokeVertex| {
                to_vertex(v.position().x, v.position().y, stroke.color)
            }),
        );
    }

    (geometry.vertices, geometry.indices)
}

/// Same curve tolerance lyon's `FillOptions::default()` flattens with, in px.
const TOLERANCE: f32 = 0.1;

/// Outline of a rounded rect, clockwise on screen, each corner flattened to within `TOLERANCE`.
fn rounded_rect_outline(rect: Rect, radius: f32, out: &mut Vec<[f32; 2]>) {
    let r = radius.max(0.0).min(rect.width().abs().min(rect.height().abs()) / 2.0);
    let (x0, y0, x1, y1) = (rect.min.x, rect.min.y, rect.max.x, rect.max.y);
    if r < 0.5 {
        out.extend_from_slice(&[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        return;
    }
    // Segments per quarter circle so the chord's sagitta stays under TOLERANCE.
    let step = 2.0 * (1.0 - TOLERANCE / r).max(-1.0).acos();
    let n = ((std::f32::consts::FRAC_PI_2 / step).ceil() as usize).clamp(1, 32);
    // One rotation step, applied to each corner's axis-aligned start direction (no trig per
    // vertex: this runs for every rounded rect on screen, every frame).
    let (sin, cos) = (std::f32::consts::FRAC_PI_2 / n as f32).sin_cos();
    // (corner center, start direction): top-right, bottom-right, bottom-left, top-left - y grows down.
    let corners: [(f32, f32, f32, f32); 4] = [(x1 - r, y0 + r, 0.0, -1.0), (x1 - r, y1 - r, 1.0, 0.0), (x0 + r, y1 - r, 0.0, 1.0), (x0 + r, y0 + r, -1.0, 0.0)];
    for (cx, cy, mut dx, mut dy) in corners {
        for k in 0..=n {
            if k == n {
                // Land exactly on the axis so adjacent edges stay straight.
                (dx, dy) = (dx.round(), dy.round());
            }
            out.push([cx + r * dx, cy + r * dy]);
            (dx, dy) = (dx * cos - dy * sin, dx * sin + dy * cos);
        }
    }
}

/// Removes consecutive (and wrap-around, when `closed`) points closer than a hundredth of a
/// pixel, so every remaining edge has a usable direction.
fn dedup_points(points: &mut Vec<[f32; 2]>, closed: bool) {
    points.dedup_by(|b, a| (a[0] - b[0]).abs() < 0.01 && (a[1] - b[1]).abs() < 0.01);
    if closed && points.len() > 1 {
        let (f, l) = (points[0], points[points.len() - 1]);
        if (f[0] - l[0]).abs() < 0.01 && (f[1] - l[1]).abs() < 0.01 {
            points.pop();
        }
    }
}

/// Triangle fan over a convex outline.
fn fill_convex(points: &[[f32; 2]], fill: Color32, vertices: &mut Vec<Vertex>, indices: &mut Vec<u32>) {
    if points.len() < 3 || fill.a() == 0 {
        return;
    }
    let base = vertices.len() as u32;
    vertices.extend(points.iter().map(|p| to_vertex(p[0], p[1], fill)));
    for i in 1..points.len() as u32 - 1 {
        indices.extend_from_slice(&[base, base + i, base + i + 1]);
    }
}

fn normal(a: [f32; 2], b: [f32; 2]) -> [f32; 2] {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt().max(1e-6);
    [-dy / len, dx / len]
}

/// Offset (both sides) at a join between edges with unit normals `n0` and `n1`: a miter,
/// capped at lyon's default miter limit (4 half-widths) so a very sharp corner cannot spike.
fn miter(n0: [f32; 2], n1: [f32; 2], half_width: f32) -> [f32; 2] {
    let (mx, my) = (n0[0] + n1[0], n0[1] + n1[1]);
    let len = (mx * mx + my * my).sqrt();
    if len < 1e-4 {
        return [n0[0] * half_width, n0[1] * half_width];
    }
    let (mx, my) = (mx / len, my / len);
    let cos = (mx * n0[0] + my * n0[1]).max(0.25);
    let scale = half_width / cos;
    [mx * scale, my * scale]
}

/// A stroke of `width` centered on the polyline (butt caps when open), as one quad per edge
/// sharing mitered join vertices.
fn stroke_polyline(points: &[[f32; 2]], closed: bool, stroke: Stroke, vertices: &mut Vec<Vertex>, indices: &mut Vec<u32>) {
    let n = points.len();
    if n < 2 || stroke.width <= 0.0 || stroke.color.a() == 0 {
        return;
    }
    let hw = stroke.width * 0.5;
    let base = vertices.len() as u32;
    for i in 0..n {
        let offset = if closed {
            let prev = points[(i + n - 1) % n];
            let next = points[(i + 1) % n];
            miter(normal(prev, points[i]), normal(points[i], next), hw)
        } else if i == 0 {
            let nm = normal(points[0], points[1]);
            [nm[0] * hw, nm[1] * hw]
        } else if i == n - 1 {
            let nm = normal(points[n - 2], points[n - 1]);
            [nm[0] * hw, nm[1] * hw]
        } else {
            miter(normal(points[i - 1], points[i]), normal(points[i], points[i + 1]), hw)
        };
        let p = points[i];
        vertices.push(to_vertex(p[0] + offset[0], p[1] + offset[1], stroke.color));
        vertices.push(to_vertex(p[0] - offset[0], p[1] - offset[1], stroke.color));
    }
    let edges = if closed { n } else { n - 1 };
    for i in 0..edges as u32 {
        let j = (i + 1) % n as u32;
        let (a, b, c, d) = (base + 2 * i, base + 2 * i + 1, base + 2 * j, base + 2 * j + 1);
        indices.extend_from_slice(&[a, b, c, b, d, c]);
    }
}

/// Fill then stroke of a closed convex outline - the fast path rects and circles take instead
/// of lyon's general sweep-line tessellator, which they never needed and which dominated
/// per-frame UI cost (every button, panel, pill and clip is a rounded rect).
fn convex_fill_and_stroke(mut points: Vec<[f32; 2]>, fill: Color32, stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    dedup_points(&mut points, true);
    let mut vertices = Vec::with_capacity(points.len() * 3);
    let mut indices = Vec::with_capacity(points.len() * 9);
    fill_convex(&points, fill, &mut vertices, &mut indices);
    stroke_polyline(&points, true, stroke, &mut vertices, &mut indices);
    (vertices, indices)
}

pub fn tessellate_rect(rect: Rect, corner_radius: CornerRadius, fill: Color32, stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    if !rect.is_positive() {
        return (Vec::new(), Vec::new());
    }
    let mut points = Vec::with_capacity(20);
    rounded_rect_outline(rect, corner_radius.as_f32(), &mut points);
    convex_fill_and_stroke(points, fill, stroke)
}

/// Like `tessellate_rect`, but every vertex gets a UV computed from its position within
/// `rect` (remapped into `uv`) instead of a flat fill color - used to paint a rounded quad
/// sampling an arbitrary texture (the "glass" backdrop blur) rather than a solid color.
/// `tint` still multiplies the sampled color (usually opaque white - the translucency is
/// layered separately, as a plain `tessellate_rect` fill on top).
pub fn tessellate_rounded_rect_textured(rect: Rect, radius: f32, uv: Rect, tint: Color32) -> (Vec<Vertex>, Vec<u32>) {
    if !rect.is_positive() {
        return (Vec::new(), Vec::new());
    }
    let mut points = Vec::with_capacity(20);
    rounded_rect_outline(rect, radius, &mut points);
    dedup_points(&mut points, true);
    let color = tint.to_array_f32();
    let vertices = points
        .iter()
        .map(|p| {
            let u = uv.min.x + (p[0] - rect.min.x) / rect.width().max(1e-5) * uv.width();
            let vcoord = uv.min.y + (p[1] - rect.min.y) / rect.height().max(1e-5) * uv.height();
            Vertex { position: [p[0], p[1], 0.0], normal: [0.0, 0.0, 0.0], tex_coords: [u, vcoord], color }
        })
        .collect();
    let indices = (1..points.len().saturating_sub(1) as u32).flat_map(|i| [0, i, i + 1]).collect();
    (vertices, indices)
}

pub fn tessellate_circle(center: Pos2, radius: f32, fill: Color32, stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    if radius <= 0.0 {
        return (Vec::new(), Vec::new());
    }
    const SEGMENTS: usize = 28;
    let points = (0..SEGMENTS)
        .map(|i| {
            let a = (i as f32 / SEGMENTS as f32) * std::f32::consts::TAU;
            [center.x + radius * a.cos(), center.y + radius * a.sin()]
        })
        .collect();
    convex_fill_and_stroke(points, fill, stroke)
}

pub fn tessellate_convex_polygon(points: &[Pos2], fill: Color32, stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    if points.len() < 2 {
        return (Vec::new(), Vec::new());
    }
    let mut b = LyonPath::builder();
    b.begin(point(points[0].x, points[0].y));
    for p in &points[1..] {
        b.line_to(point(p.x, p.y));
    }
    b.close();
    let path = b.build();
    fill_and_stroke(&path, fill, stroke, true)
}

/// Open polyline — stroke only (a closed fill on an open path isn't meaningful).
pub fn tessellate_line(points: &[Pos2], stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    if points.len() < 2 || stroke.width <= 0.0 || stroke.color.a() == 0 {
        return (Vec::new(), Vec::new());
    }
    let mut pts: Vec<[f32; 2]> = points.iter().map(|p| [p.x, p.y]).collect();
    dedup_points(&mut pts, false);
    let mut vertices = Vec::with_capacity(pts.len() * 2);
    let mut indices = Vec::with_capacity(pts.len() * 6);
    stroke_polyline(&pts, false, stroke, &mut vertices, &mut indices);
    (vertices, indices)
}

pub fn tessellate_shape(shape: &Shape) -> (Vec<Vertex>, Vec<u32>) {
    match shape {
        Shape::ConvexPolygon { points, fill, stroke } => tessellate_convex_polygon(points, *fill, *stroke),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entropy_gui::geometry::{pos2, vec2};

    fn area(v: &[Vertex], idx: &[u32]) -> f32 {
        idx.chunks(3)
            .map(|t| {
                let (a, b, c) = (v[t[0] as usize].position, v[t[1] as usize].position, v[t[2] as usize].position);
                ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs() / 2.0
            })
            .sum()
    }

    #[test]
    fn filled_rects_cover_their_area() {
        let rect = Rect::from_min_size(pos2(10.0, 20.0), vec2(120.0, 40.0));
        let (v, i) = tessellate_rect(rect, CornerRadius::same(0), Color32::WHITE, Stroke::NONE);
        assert!((area(&v, &i) - 4800.0).abs() < 0.01);
        // Rounded: the rect minus (4 - pi) r^2 of corners, to within the flattening tolerance.
        let (v, i) = tessellate_rect(rect, CornerRadius::same(8), Color32::WHITE, Stroke::NONE);
        let expected = 4800.0 - (4.0 - std::f32::consts::PI) * 64.0;
        assert!((area(&v, &i) - expected).abs() < 4.0, "{} vs {expected}", area(&v, &i));
        for p in &v {
            assert!(p.position[0] >= 10.0 - 1e-3 && p.position[0] <= 130.0 + 1e-3 && p.position[1] >= 20.0 - 1e-3 && p.position[1] <= 60.0 + 1e-3);
        }
    }

    #[test]
    fn a_radius_past_half_the_side_is_a_pill_not_a_spike() {
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(40.0, 10.0));
        let (v, i) = tessellate_rect(rect, CornerRadius::same(50), Color32::WHITE, Stroke::NONE);
        let expected = 40.0 * 10.0 - (4.0 - std::f32::consts::PI) * 25.0;
        // Chords sit inside the arc, so flattening loses up to ~tolerance x arc length.
        assert!((area(&v, &i) - expected).abs() < 3.0, "{} vs {expected}", area(&v, &i));
    }

    #[test]
    fn strokes_are_centered_on_the_outline() {
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(100.0, 50.0));
        let (v, i) = tessellate_rect(rect, CornerRadius::same(0), Color32::TRANSPARENT, Stroke::new(2.0, Color32::WHITE));
        // Outer 102x52 minus inner 98x48.
        assert!((area(&v, &i) - (102.0 * 52.0 - 98.0 * 48.0)).abs() < 0.01);
        let (v, i) = tessellate_line(&[pos2(0.0, 0.0), pos2(30.0, 0.0)], Stroke::new(3.0, Color32::WHITE));
        assert_eq!((v.len(), i.len()), (4, 6));
        assert!((area(&v, &i) - 90.0).abs() < 1e-3);
        // A polyline with a repeated point still strokes both segments.
        let (v, i) = tessellate_line(&[pos2(0.0, 0.0), pos2(10.0, 0.0), pos2(10.0, 0.0), pos2(10.0, 10.0)], Stroke::new(2.0, Color32::WHITE));
        assert!(v.iter().all(|p| p.position.iter().all(|c| c.is_finite())));
        assert!(area(&v, &i) > 35.0);
    }

    #[test]
    fn circles_fill_close_to_pi_r_squared() {
        let (v, i) = tessellate_circle(pos2(50.0, 50.0), 10.0, Color32::WHITE, Stroke::NONE);
        assert!((area(&v, &i) - std::f32::consts::PI * 100.0).abs() < 3.0);
        assert!(tessellate_circle(pos2(0.0, 0.0), 0.0, Color32::WHITE, Stroke::NONE).0.is_empty());
    }
}
