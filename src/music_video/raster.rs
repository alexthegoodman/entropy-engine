// A small anti-aliased CPU rasterizer: just enough to draw the visualizer styles into an RGBA
// frame without a GPU. That buys three things the live-scene exporter (`video_export::exporter`)
// can't offer: any output size (not pinned to the window), running on a background thread while
// the DAW stays responsive, and pixel-identical frames from the preview widget and the export.
//
// Pixels are premultiplied RGBA in f32, 0..1, in plain sRGB space (no linearization: the looks
// were tuned this way, and it matches how the GUI blends). Colours passed in are straight alpha.
// Shapes that can overlap themselves (polylines, polygons) render coverage into a mask first and
// composite once, so a translucent stroke doesn't darken where its segments meet.
use std::collections::HashMap;

pub type Color = [f32; 4];

/// Frames this small aren't worth a thread each.
const PARALLEL_MIN_PIXELS: usize = 128 * 1024;

fn band_rows(rows: usize, pixels: usize) -> usize {
    let threads = if pixels < PARALLEL_MIN_PIXELS {
        1
    } else {
        std::thread::available_parallelism().map_or(1, |n| n.get()).min(16)
    };
    rows.div_ceil(threads).max(1)
}

/// Runs `f(first_row, band)` over bands of whole rows on every core. The full-frame passes
/// (copy, clear, bloom, composite, conversion) are most of a frame's cost at 1080p.
fn par_rows<A: Send>(a: &mut [A], row_len: usize, f: impl Fn(usize, &mut [A]) + Sync) {
    let rows = a.len() / row_len.max(1);
    let band = band_rows(rows, a.len());
    if band >= rows {
        return f(0, a);
    }
    std::thread::scope(|scope| {
        for (i, chunk) in a.chunks_mut(band * row_len).enumerate() {
            let f = &f;
            scope.spawn(move || f(i * band, chunk));
        }
    });
}

pub fn lerp_color(a: Color, b: Color, t: f32) -> Color {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
}

pub fn with_alpha(c: Color, alpha: f32) -> Color {
    [c[0], c[1], c[2], c[3] * alpha.clamp(0.0, 1.0)]
}

/// Integer pixel bounds, half-open, already clipped to the canvas.
#[derive(Clone, Copy, Debug)]
struct Bounds {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
}

impl Bounds {
    fn empty() -> Self {
        Bounds { x0: usize::MAX, y0: usize::MAX, x1: 0, y1: 0 }
    }
    fn is_empty(&self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }
    fn union(&self, o: Bounds) -> Bounds {
        Bounds { x0: self.x0.min(o.x0), y0: self.y0.min(o.y0), x1: self.x1.max(o.x1), y1: self.y1.max(o.y1) }
    }
}

pub struct Canvas {
    pub width: usize,
    pub height: usize,
    pub px: Vec<Color>,
    /// Add instead of "over": light-emitting looks (stars, sparks) brighten where they overlap.
    pub additive: bool,
    mask: Vec<f32>,
}

impl Canvas {
    pub fn new(width: usize, height: usize) -> Self {
        let n = width * height;
        Self { width, height, px: vec![[0.0; 4]; n], additive: false, mask: vec![0.0; n] }
    }

    pub fn clear(&mut self, c: Color) {
        let p = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
        par_rows(&mut self.px, self.width, |_, band| band.fill(p));
    }

    /// Copies premultiplied pixels (same size) in, e.g. a precomputed background.
    pub fn copy_from(&mut self, pixels: &[Color]) {
        let w = self.width;
        par_rows(&mut self.px, w, |row, band| band.copy_from_slice(&pixels[row * w..row * w + band.len()]));
    }

    fn bounds(&self, x0: f32, y0: f32, x1: f32, y1: f32) -> Bounds {
        let clip = |v: f32, max: usize| if v.is_finite() { v.max(0.0).min(max as f32) as usize } else { 0 };
        Bounds {
            x0: clip(x0.floor(), self.width),
            y0: clip(y0.floor(), self.height),
            x1: clip(x1.ceil(), self.width),
            y1: clip(y1.ceil(), self.height),
        }
    }

    #[inline]
    fn blend(&mut self, idx: usize, c: Color, coverage: f32) {
        let a = c[3] * coverage;
        if a <= 0.0 {
            return;
        }
        let d = &mut self.px[idx];
        if self.additive {
            d[0] += c[0] * a;
            d[1] += c[1] * a;
            d[2] += c[2] * a;
            d[3] = (d[3] + a).min(1.0);
        } else {
            let k = 1.0 - a;
            d[0] = c[0] * a + d[0] * k;
            d[1] = c[1] * a + d[1] * k;
            d[2] = c[2] * a + d[2] * k;
            d[3] = a + d[3] * k;
        }
    }

    /// Vertical gradient over the whole canvas.
    pub fn fill_vertical_gradient(&mut self, top: Color, bottom: Color) {
        for y in 0..self.height {
            let c = lerp_color(top, bottom, y as f32 / (self.height.max(2) - 1) as f32);
            let p = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
            self.px[y * self.width..(y + 1) * self.width].fill(p);
        }
    }

    /// Axis-aligned rectangle with exact fractional edge coverage.
    pub fn fill_rect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, c: Color) {
        let (x0, x1) = (x0.min(x1), x0.max(x1));
        let (y0, y1) = (y0.min(y1), y0.max(y1));
        let b = self.bounds(x0, y0, x1, y1);
        for y in b.y0..b.y1 {
            let cy = (y1.min(y as f32 + 1.0) - y0.max(y as f32)).clamp(0.0, 1.0);
            for x in b.x0..b.x1 {
                let cx = (x1.min(x as f32 + 1.0) - x0.max(x as f32)).clamp(0.0, 1.0);
                self.blend(y * self.width + x, c, cx * cy);
            }
        }
    }

    /// Rounded rectangle (radius clamped to half the short side), anti-aliased by distance.
    pub fn fill_rounded_rect(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, radius: f32, c: Color) {
        let (x0, x1) = (x0.min(x1), x0.max(x1));
        let (y0, y1) = (y0.min(y1), y0.max(y1));
        let (hw, hh) = ((x1 - x0) * 0.5, (y1 - y0) * 0.5);
        if hw < 0.75 || hh < 0.75 {
            // Thinner than a pixel and a half: the distance test would lose it; area is right.
            return self.fill_rect(x0, y0, x1, y1, c);
        }
        let r = radius.clamp(0.0, hw.min(hh));
        let (cx, cy) = (x0 + hw, y0 + hh);
        let b = self.bounds(x0 - 1.0, y0 - 1.0, x1 + 1.0, y1 + 1.0);
        for y in b.y0..b.y1 {
            let qy = (y as f32 + 0.5 - cy).abs() - (hh - r);
            for x in b.x0..b.x1 {
                let qx = (x as f32 + 0.5 - cx).abs() - (hw - r);
                let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
                let d = outside + qx.max(qy).min(0.0) - r;
                let cov = (0.5 - d).clamp(0.0, 1.0);
                if cov > 0.0 {
                    self.blend(y * self.width + x, c, cov);
                }
            }
        }
    }

    pub fn fill_circle(&mut self, cx: f32, cy: f32, r: f32, c: Color) {
        if !(r > 0.0) {
            return;
        }
        // Below ~a pixel, keep the area (and so the brightness) right instead of the edge.
        let (r, c) = if r < 0.7 { (0.7, with_alpha(c, (r / 0.7).powi(2))) } else { (r, c) };
        let b = self.bounds(cx - r - 1.0, cy - r - 1.0, cx + r + 1.0, cy + r + 1.0);
        for y in b.y0..b.y1 {
            let dy = y as f32 + 0.5 - cy;
            for x in b.x0..b.x1 {
                let dx = x as f32 + 0.5 - cx;
                let cov = (r - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0);
                if cov > 0.0 {
                    self.blend(y * self.width + x, c, cov);
                }
            }
        }
    }

    /// A soft round light: full at the centre, fading to nothing at `r`.
    pub fn fill_radial_glow(&mut self, cx: f32, cy: f32, r: f32, c: Color) {
        if !(r > 0.5) {
            return;
        }
        let b = self.bounds(cx - r, cy - r, cx + r, cy + r);
        for y in b.y0..b.y1 {
            let dy = y as f32 + 0.5 - cy;
            for x in b.x0..b.x1 {
                let dx = x as f32 + 0.5 - cx;
                let t = 1.0 - (dx * dx + dy * dy).sqrt() / r;
                if t > 0.0 {
                    self.blend(y * self.width + x, c, t * t);
                }
            }
        }
    }

    pub fn stroke_circle(&mut self, cx: f32, cy: f32, r: f32, width: f32, c: Color) {
        if !(r > 0.0 && width > 0.0) {
            return;
        }
        let (w, c) = if width < 1.0 { (1.0, with_alpha(c, width)) } else { (width, c) };
        let reach = r + w * 0.5 + 1.0;
        let b = self.bounds(cx - reach, cy - reach, cx + reach, cy + reach);
        let inner = (r - w * 0.5 - 1.0).max(0.0);
        for y in b.y0..b.y1 {
            let dy = y as f32 + 0.5 - cy;
            for x in b.x0..b.x1 {
                let dx = x as f32 + 0.5 - cx;
                let d = (dx * dx + dy * dy).sqrt();
                if d < inner {
                    continue;
                }
                let cov = (w * 0.5 - (d - r).abs() + 0.5).clamp(0.0, 1.0);
                if cov > 0.0 {
                    self.blend(y * self.width + x, c, cov);
                }
            }
        }
    }

    /// A polyline with round joins and caps.
    pub fn stroke_polyline(&mut self, points: &[[f32; 2]], width: f32, c: Color, closed: bool) {
        if points.len() < 2 || !(width > 0.0) {
            return;
        }
        let (w, c) = if width < 1.0 { (1.0, with_alpha(c, width)) } else { (width, c) };
        let hw = w * 0.5;
        let mut touched = Bounds::empty();
        let segments = if closed { points.len() } else { points.len() - 1 };
        for s in 0..segments {
            let (a, b) = (points[s], points[(s + 1) % points.len()]);
            let bb = self.bounds(a[0].min(b[0]) - hw - 1.0, a[1].min(b[1]) - hw - 1.0, a[0].max(b[0]) + hw + 1.0, a[1].max(b[1]) + hw + 1.0);
            if bb.is_empty() {
                continue;
            }
            touched = touched.union(bb);
            let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
            let len2 = (ex * ex + ey * ey).max(1e-9);
            for y in bb.y0..bb.y1 {
                let py = y as f32 + 0.5 - a[1];
                // Only the columns this row of the capsule can reach: the part of the segment
                // within reach of this row, widened by the half-width. A long diagonal's bounding
                // box is mostly empty.
                let (x_lo, x_hi) = if ey.abs() > 1e-6 {
                    let (t0, t1) = ((py - hw - 1.0) / ey, (py + hw + 1.0) / ey);
                    let (t0, t1) = (t0.min(t1).clamp(0.0, 1.0), t0.max(t1).clamp(0.0, 1.0));
                    let (xa, xb) = (a[0] + ex * t0, a[0] + ex * t1);
                    let (lo, hi) = (xa.min(xb) - hw - 1.0, xa.max(xb) + hw + 1.0);
                    ((lo.floor().max(bb.x0 as f32) as usize).min(bb.x1), (hi.ceil().max(0.0) as usize).clamp(bb.x0, bb.x1))
                } else {
                    (bb.x0, bb.x1)
                };
                for x in x_lo..x_hi {
                    let px = x as f32 + 0.5 - a[0];
                    let t = ((px * ex + py * ey) / len2).clamp(0.0, 1.0);
                    let (dx, dy) = (px - ex * t, py - ey * t);
                    let cov = (hw - (dx * dx + dy * dy).sqrt() + 0.5).clamp(0.0, 1.0);
                    let m = &mut self.mask[y * self.width + x];
                    if cov > *m {
                        *m = cov;
                    }
                }
            }
        }
        self.composite_mask(touched, c);
    }

    /// A filled polygon (even-odd), anti-aliased with 4 sub-scanlines per pixel row and exact
    /// horizontal coverage.
    pub fn fill_polygon(&mut self, points: &[[f32; 2]], c: Color) {
        if points.len() < 3 {
            return;
        }
        const SUB: usize = 4;
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for p in points {
            min_x = min_x.min(p[0]);
            min_y = min_y.min(p[1]);
            max_x = max_x.max(p[0]);
            max_y = max_y.max(p[1]);
        }
        let b = self.bounds(min_x, min_y, max_x, max_y);
        if b.is_empty() {
            return;
        }
        let mut crossings: Vec<f32> = Vec::with_capacity(16);
        for y in b.y0..b.y1 {
            for s in 0..SUB {
                let sy = y as f32 + (s as f32 + 0.5) / SUB as f32;
                crossings.clear();
                for i in 0..points.len() {
                    let (p, q) = (points[i], points[(i + 1) % points.len()]);
                    if (p[1] <= sy) != (q[1] <= sy) {
                        crossings.push(p[0] + (sy - p[1]) / (q[1] - p[1]) * (q[0] - p[0]));
                    }
                }
                crossings.sort_by(f32::total_cmp);
                for pair in crossings.chunks_exact(2) {
                    let (xa, xb) = (pair[0].max(b.x0 as f32), pair[1].min(b.x1 as f32));
                    if xb <= xa {
                        continue;
                    }
                    let row = y * self.width;
                    let (first, last) = (xa.floor() as usize, (xb.ceil() as usize).min(b.x1));
                    for x in first..last {
                        let overlap = xb.min(x as f32 + 1.0) - xa.max(x as f32);
                        if overlap > 0.0 {
                            self.mask[row + x] += overlap / SUB as f32;
                        }
                    }
                }
            }
        }
        self.composite_mask(b, c);
    }

    fn composite_mask(&mut self, b: Bounds, c: Color) {
        if b.is_empty() {
            return;
        }
        for y in b.y0..b.y1 {
            for x in b.x0..b.x1 {
                let idx = y * self.width + x;
                let m = self.mask[idx];
                if m > 0.0 {
                    self.mask[idx] = 0.0;
                    self.blend(idx, c, m.min(1.0));
                }
            }
        }
    }

    /// Composites `layer` (same size, premultiplied) over this canvas.
    pub fn draw_layer(&mut self, layer: &Canvas) {
        let w = self.width;
        par_rows(&mut self.px, w, |row, band| {
            let src = &layer.px[row * w..row * w + band.len()];
            Self::over_band(band, src);
        });
    }

    fn over_band(band: &mut [Color], src: &[Color]) {
        for (d, s) in band.iter_mut().zip(src) {
            if s[3] <= 0.0 && s[0] <= 0.0 && s[1] <= 0.0 && s[2] <= 0.0 {
                continue;
            }
            let k = 1.0 - s[3].min(1.0);
            d[0] = s[0] + d[0] * k;
            d[1] = s[1] + d[1] * k;
            d[2] = s[2] + d[2] * k;
            d[3] = s[3].min(1.0) + d[3] * k;
        }
    }

    /// Adds a blurred copy of `layer` scaled by `strength`: a cheap bloom. The blur runs on a
    /// copy downsampled by `scale.factor`, so its cost barely depends on the output size.
    pub fn add_bloom(&mut self, layer: &Canvas, strength: f32, scratch: &mut BloomScratch) {
        if strength <= 0.0 || layer.width != self.width || layer.height != self.height {
            return;
        }
        let width = self.width;
        let (f, sw, sh) = Self::bloom_prepare(layer, scratch);
        let small = &scratch.a;
        let x_taps = bloom_x_taps(width, f, sw);
        par_rows(&mut self.px, width, |first, band| {
            let mut row = vec![[0.0f32; 3]; sw];
            for (k, out) in band.chunks_exact_mut(width).enumerate() {
                bloom_row(small, sw, sh, f, first + k, strength, &mut row);
                for (d, &(x0, x1, tx)) in out.iter_mut().zip(&x_taps) {
                    let (p, q) = (row[x0], row[x1]);
                    d[0] += p[0] + (q[0] - p[0]) * tx;
                    d[1] += p[1] + (q[1] - p[1]) * tx;
                    d[2] += p[2] + (q[2] - p[2]) * tx;
                }
            }
        });
    }

    /// The whole end of a frame in one pass over memory: this canvas (the background and crisp
    /// shapes) plus `layer`'s bloom (`strength`, 0 for none), with `layer` composited over, as
    /// opaque RGBA8 into `out`. Same result as `add_bloom` + `draw_layer` + `write_rgba8`.
    pub fn compose_rgba8(&self, layer: &Canvas, strength: f32, scratch: &mut BloomScratch, out: &mut Vec<u8>) {
        let (width, height) = (self.width, self.height);
        out.resize(width * height * 4, 0);
        let bloom = strength > 0.0;
        let (f, sw, sh) = if bloom { Self::bloom_prepare(layer, scratch) } else { (1, 1, 1) };
        let small = &scratch.a;
        let x_taps = if bloom { bloom_x_taps(width, f, sw) } else { Vec::new() };
        par_rows(out, width * 4, |first, band| {
            let mut row = vec![[0.0f32; 3]; sw];
            for (k, out_row) in band.chunks_exact_mut(width * 4).enumerate() {
                let y = first + k;
                if bloom {
                    bloom_row(small, sw, sh, f, y, strength, &mut row);
                }
                let (base, top) = (&self.px[y * width..(y + 1) * width], &layer.px[y * width..(y + 1) * width]);
                for x in 0..width {
                    let (b, s) = (base[x], top[x]);
                    let mut d = [b[0], b[1], b[2]];
                    if bloom {
                        let (x0, x1, tx) = x_taps[x];
                        let (p, q) = (row[x0], row[x1]);
                        d[0] += p[0] + (q[0] - p[0]) * tx;
                        d[1] += p[1] + (q[1] - p[1]) * tx;
                        d[2] += p[2] + (q[2] - p[2]) * tx;
                    }
                    let keep = 1.0 - s[3].min(1.0);
                    let o = &mut out_row[x * 4..x * 4 + 4];
                    o[0] = ((s[0] + d[0] * keep).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    o[1] = ((s[1] + d[1] * keep).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    o[2] = ((s[2] + d[2] * keep).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    o[3] = 255;
                }
            }
        });
    }

    /// Downsamples `layer` into `scratch.a` and blurs it there. Returns (factor, width, height)
    /// of the small image.
    fn bloom_prepare(layer: &Canvas, scratch: &mut BloomScratch) -> (usize, usize, usize) {
        let (width, height) = (layer.width, layer.height);
        let f = scratch.factor.max(1);
        let (sw, sh) = (width.div_ceil(f), height.div_ceil(f));
        scratch.a.resize(sw * sh, [0.0; 4]);
        scratch.b.resize(sw * sh, [0.0; 4]);
        // Downsample by box averaging.
        par_rows(&mut scratch.a, sw, |first, band| {
        for (k, out) in band.iter_mut().enumerate() {
            let (sy, sx) = (first + k / sw, k % sw);
            {
                let mut acc = [0.0f32; 4];
                let mut n = 0.0;
                for y in sy * f..((sy + 1) * f).min(height) {
                    for x in sx * f..((sx + 1) * f).min(width) {
                        let p = layer.px[y * width + x];
                        acc[0] += p[0];
                        acc[1] += p[1];
                        acc[2] += p[2];
                        n += 1.0;
                    }
                }
                *out = [acc[0] / n, acc[1] / n, acc[2] / n, 0.0];
            }
        }
        });
        // Three box passes each way approximate a gaussian.
        let radius = (sh / 40).max(2);
        for _ in 0..3 {
            box_blur(&scratch.a, &mut scratch.b, sw, sh, radius, true);
            box_blur(&scratch.b, &mut scratch.a, sw, sh, radius, false);
        }
        (f, sw, sh)
    }

    /// Straight-alpha-free RGBA8 (alpha forced opaque: the frame is always over a background).
    pub fn write_rgba8(&self, out: &mut Vec<u8>) {
        out.resize(self.width * self.height * 4, 0);
        let w = self.width;
        par_rows(out, w * 4, |row, band| {
            let src = &self.px[row * w..row * w + band.len() / 4];
            Self::rgba8_band(band, src);
        });
    }

    fn rgba8_band(out: &mut [u8], src: &[Color]) {
        for (o, p) in out.chunks_exact_mut(4).zip(src) {
            o[0] = (p[0].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            o[1] = (p[1].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            o[2] = (p[2].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            o[3] = 255;
        }
    }
}

/// Buffers `add_bloom` reuses across frames.
pub struct BloomScratch {
    pub factor: usize,
    a: Vec<Color>,
    b: Vec<Color>,
}

impl BloomScratch {
    /// Downsampling chosen so the blur works on roughly a 240-pixel-tall image at any size.
    pub fn for_height(height: usize) -> Self {
        Self { factor: (height / 240).max(1), a: Vec::new(), b: Vec::new() }
    }
}

/// Horizontal bilinear taps from a full-width row into the bloom's small image.
fn bloom_x_taps(width: usize, f: usize, sw: usize) -> Vec<(usize, usize, f32)> {
    (0..width)
        .map(|x| {
            let fx = ((x as f32 + 0.5) / f as f32 - 0.5).clamp(0.0, (sw - 1) as f32);
            let x0 = fx.floor() as usize;
            (x0, (x0 + 1).min(sw - 1), fx.fract())
        })
        .collect()
}

/// The bloom image interpolated vertically at full-size row `y`, times `strength`, into `row`.
fn bloom_row(small: &[Color], sw: usize, sh: usize, f: usize, y: usize, strength: f32, row: &mut [[f32; 3]]) {
    let fy = ((y as f32 + 0.5) / f as f32 - 0.5).clamp(0.0, (sh - 1) as f32);
    let (y0, ty) = (fy.floor() as usize, fy.fract());
    let y1 = (y0 + 1).min(sh - 1);
    for (sx, r) in row.iter_mut().enumerate() {
        let (a, b) = (small[y0 * sw + sx], small[y1 * sw + sx]);
        *r = [
            (a[0] + (b[0] - a[0]) * ty) * strength,
            (a[1] + (b[1] - a[1]) * ty) * strength,
            (a[2] + (b[2] - a[2]) * ty) * strength,
        ];
    }
}

fn box_blur(src: &[Color], dst: &mut [Color], w: usize, h: usize, r: usize, horizontal: bool) {
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    let at = |o: usize, i: usize| if horizontal { o * w + i } else { i * w + o };
    let norm = 1.0 / (2 * r + 1) as f32;
    for o in 0..outer {
        let mut acc = [0.0f32; 3];
        // Edge pixels repeat outward.
        for k in 0..=2 * r {
            let i = (k as isize - r as isize).clamp(0, inner as isize - 1) as usize;
            let p = src[at(o, i)];
            acc[0] += p[0];
            acc[1] += p[1];
            acc[2] += p[2];
        }
        for i in 0..inner {
            dst[at(o, i)] = [acc[0] * norm, acc[1] * norm, acc[2] * norm, 0.0];
            let out_i = (i as isize - r as isize).clamp(0, inner as isize - 1) as usize;
            let in_i = (i + r + 1).min(inner - 1);
            let (po, pi) = (src[at(o, out_i)], src[at(o, in_i)]);
            acc[0] += pi[0] - po[0];
            acc[1] += pi[1] - po[1];
            acc[2] += pi[2] - po[2];
        }
    }
}

/// Text drawn with fontdue, glyph bitmaps cached per size.
pub struct TextPainter {
    font: fontdue::Font,
    cache: HashMap<(char, u32), (fontdue::Metrics, Vec<u8>)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TextAlign {
    Left,
    Center,
}

impl TextPainter {
    /// `font_name` from the engine's catalog (`renderer_text::fonts::FontManager`), falling back
    /// to Figtree, the GUI's own face.
    pub fn new(font_name: &str) -> Self {
        let catalog = crate::renderer_text::fonts::FontManager::new();
        let bytes = catalog
            .get_font_by_name(font_name)
            .or_else(|| catalog.get_font_by_name("Figtree"))
            .expect("Figtree is in the engine's font catalog");
        let font = fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default())
            .or_else(|_| fontdue::Font::from_bytes(catalog.get_font_by_name("Figtree").unwrap(), fontdue::FontSettings::default()))
            .expect("Figtree parses");
        Self { font, cache: HashMap::new() }
    }

    fn glyph(&mut self, ch: char, px: f32) -> &(fontdue::Metrics, Vec<u8>) {
        let key = (ch, (px * 4.0) as u32);
        let font = &self.font;
        self.cache.entry(key).or_insert_with(|| font.rasterize(ch, px))
    }

    pub fn measure(&mut self, text: &str, px: f32) -> f32 {
        text.chars().map(|ch| self.glyph(ch, px).0.advance_width).sum()
    }

    /// Draws `text` with its baseline at `baseline`; `x` is the left edge or the centre.
    pub fn draw(&mut self, canvas: &mut Canvas, text: &str, x: f32, baseline: f32, px: f32, c: Color, align: TextAlign) {
        let mut pen = match align {
            TextAlign::Left => x,
            TextAlign::Center => x - self.measure(text, px) * 0.5,
        };
        for ch in text.chars() {
            let (m, bitmap) = self.glyph(ch, px).clone();
            let gx = (pen + m.xmin as f32).round() as isize;
            let gy = (baseline - m.height as f32 - m.ymin as f32).round() as isize;
            for row in 0..m.height {
                let y = gy + row as isize;
                if y < 0 || y >= canvas.height as isize {
                    continue;
                }
                for col in 0..m.width {
                    let x = gx + col as isize;
                    if x < 0 || x >= canvas.width as isize {
                        continue;
                    }
                    let cov = bitmap[row * m.width + col] as f32 / 255.0;
                    if cov > 0.0 {
                        canvas.blend(y as usize * canvas.width + x as usize, c, cov);
                    }
                }
            }
            pen += m.advance_width;
        }
    }
}

/// Loads a picture scaled and centre-cropped to cover `width` x `height`, darkened by `dim`, as
/// premultiplied pixels ready to copy under a frame.
pub fn load_cover_image(path: &str, width: u32, height: u32, dim: f32) -> Result<Vec<Color>, String> {
    let img = image::open(path).map_err(|e| format!("Couldn't open background image {path}: {e}"))?;
    let img = img.resize_to_fill(width, height, image::imageops::FilterType::Triangle).to_rgba8();
    let k = 1.0 - dim.clamp(0.0, 1.0);
    Ok(img
        .pixels()
        .map(|p| {
            let a = p[3] as f32 / 255.0;
            [p[0] as f32 / 255.0 * a * k, p[1] as f32 / 255.0 * a * k, p[2] as f32 / 255.0 * a * k, a]
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(c: &Canvas, x: usize, y: usize) -> Color {
        c.px[y * c.width + x]
    }

    #[test]
    fn rect_covers_fractional_edges() {
        let mut c = Canvas::new(8, 8);
        c.fill_rect(1.5, 1.0, 4.0, 3.0, [1.0, 1.0, 1.0, 1.0]);
        assert!((at(&c, 1, 1)[0] - 0.5).abs() < 1e-5);
        assert_eq!(at(&c, 2, 2)[0], 1.0);
        assert_eq!(at(&c, 5, 2)[0], 0.0);
    }

    #[test]
    fn circle_area_is_about_pi_r_squared() {
        let mut c = Canvas::new(64, 64);
        c.fill_circle(32.0, 32.0, 10.0, [1.0, 0.0, 0.0, 1.0]);
        let area: f32 = c.px.iter().map(|p| p[3]).sum();
        assert!((area - std::f32::consts::PI * 100.0).abs() < 4.0, "area {area}");
    }

    #[test]
    fn translucent_polyline_does_not_double_up_at_joins() {
        let mut c = Canvas::new(40, 40);
        c.stroke_polyline(&[[5.0, 20.0], [20.0, 20.0], [35.0, 20.0]], 6.0, [1.0, 1.0, 1.0, 0.5], false);
        assert!((at(&c, 20, 20)[3] - 0.5).abs() < 1e-5);
        assert!((at(&c, 12, 20)[3] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn polygon_fills_its_area() {
        let mut c = Canvas::new(32, 32);
        c.fill_polygon(&[[4.0, 4.0], [20.0, 4.0], [20.0, 20.0], [4.0, 20.0]], [0.0, 1.0, 0.0, 1.0]);
        let area: f32 = c.px.iter().map(|p| p[3]).sum();
        assert!((area - 256.0).abs() < 0.5, "area {area}");
        assert_eq!(at(&c, 10, 10)[1], 1.0);
    }

    #[test]
    fn bloom_spreads_light_beyond_the_shape() {
        let mut layer = Canvas::new(120, 120);
        layer.fill_circle(60.0, 60.0, 6.0, [1.0, 1.0, 1.0, 1.0]);
        let mut out = Canvas::new(120, 120);
        out.add_bloom(&layer, 1.0, &mut BloomScratch::for_height(120));
        assert!(at(&out, 60, 72)[0] > 0.0);
        assert_eq!(at(&out, 2, 2)[0], 0.0);
    }

    #[test]
    fn text_draws_ink() {
        let mut tp = TextPainter::new("Figtree");
        let mut c = Canvas::new(200, 60);
        tp.draw(&mut c, "Entropy", 10.0, 40.0, 28.0, [1.0, 1.0, 1.0, 1.0], TextAlign::Left);
        assert!(c.px.iter().any(|p| p[3] > 0.9));
        assert!(tp.measure("Entropy", 28.0) > 50.0);
    }
}
