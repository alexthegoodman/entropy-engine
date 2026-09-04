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

/// Circle approximation via arc-tangent cubic Beziers (browser border-radius technique).
const KAPPA: f32 = 0.5522847498;

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

fn rounded_rect_path(rect: Rect, radius: f32) -> LyonPath {
    let r = radius.max(0.0).min(rect.width().abs().min(rect.height().abs()) / 2.0);
    let (x0, y0, x1, y1) = (rect.min.x, rect.min.y, rect.max.x, rect.max.y);
    let k = r * KAPPA;

    let mut b = LyonPath::builder();
    b.begin(point(x0 + r, y0));
    b.line_to(point(x1 - r, y0));
    b.cubic_bezier_to(point(x1 - r + k, y0), point(x1, y0 + r - k), point(x1, y0 + r));
    b.line_to(point(x1, y1 - r));
    b.cubic_bezier_to(point(x1, y1 - r + k), point(x1 - r + k, y1), point(x1 - r, y1));
    b.line_to(point(x0 + r, y1));
    b.cubic_bezier_to(point(x0 + r - k, y1), point(x0, y1 - r + k), point(x0, y1 - r));
    b.line_to(point(x0, y0 + r));
    b.cubic_bezier_to(point(x0, y0 + r - k), point(x0 + r - k, y0), point(x0 + r, y0));
    b.close();
    b.build()
}

pub fn tessellate_rect(rect: Rect, corner_radius: CornerRadius, fill: Color32, stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    if !rect.is_positive() {
        return (Vec::new(), Vec::new());
    }
    let path = rounded_rect_path(rect, corner_radius.as_f32());
    fill_and_stroke(&path, fill, stroke, true)
}

pub fn tessellate_circle(center: Pos2, radius: f32, fill: Color32, stroke: Stroke) -> (Vec<Vertex>, Vec<u32>) {
    if radius <= 0.0 {
        return (Vec::new(), Vec::new());
    }
    const SEGMENTS: usize = 28;
    let mut b = LyonPath::builder();
    for i in 0..SEGMENTS {
        let a = (i as f32 / SEGMENTS as f32) * std::f32::consts::TAU;
        let p = point(center.x + radius * a.cos(), center.y + radius * a.sin());
        if i == 0 {
            b.begin(p);
        } else {
            b.line_to(p);
        }
    }
    b.close();
    let path = b.build();
    fill_and_stroke(&path, fill, stroke, true)
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
    let mut b = LyonPath::builder();
    b.begin(point(points[0].x, points[0].y));
    for p in &points[1..] {
        b.line_to(point(p.x, p.y));
    }
    b.end(false);
    let path = b.build();
    fill_and_stroke(&path, Color32::TRANSPARENT, stroke, false)
}

pub fn tessellate_shape(shape: &Shape) -> (Vec<Vertex>, Vec<u32>) {
    match shape {
        Shape::ConvexPolygon { points, fill, stroke } => tessellate_convex_polygon(points, *fill, *stroke),
    }
}
