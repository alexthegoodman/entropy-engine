// The collection of visualizer looks. `Visualizer::render` turns one `AudioFeatures` into one
// RGBA8 frame at the settings' size; it keeps whatever has to persist between frames (falling peak
// caps, waveform echoes, stars, rings) so the same instance must be fed every frame in order.
//
// Each frame is built in two layers: `frame` (the background and anything that should stay crisp)
// and `fg` (everything the audio lights up). `fg` is bloomed by `settings.glow` and composited over
// `frame`, then the title, artist and progress bar go on top, unbloomed.
use std::collections::VecDeque;
use std::f32::consts::{PI, TAU};

use crate::music_video::features::{AudioFeatures, ANALYSIS_BANDS};
use crate::music_video::raster::{lerp_color, load_cover_image, with_alpha, BloomScratch, Canvas, Color, TextAlign, TextPainter};
use crate::music_video::settings::{VisualStyle, VisualizerSettings};

const STAR_COUNT: usize = 360;
const WAVE_ECHOES: usize = 7;

struct Star {
    x: f32,
    y: f32,
    z: f32,
    band: usize,
}

struct Ring {
    /// Radius and stroke width as fractions of the short side.
    r: f32,
    width: f32,
    alpha: f32,
    color: Color,
}

pub struct Visualizer {
    settings: VisualizerSettings,
    background: Vec<Color>,
    frame: Canvas,
    fg: Canvas,
    bloom: BloomScratch,
    /// The title and artist, drawn once (they never change) as premultiplied pixels by index.
    text_overlay: Vec<(u32, Color)>,
    rgba: Vec<u8>,
    peaks: Vec<f32>,
    peak_hold: Vec<f32>,
    wave_history: VecDeque<Vec<f32>>,
    stars: Vec<Star>,
    rings: Vec<Ring>,
    last_beat_count: u32,
    ring_timer: f32,
    spin: f32,
    scroll: f32,
    rng: u64,
    /// Set when `background_image` couldn't be loaded; the gradient is used instead.
    pub background_error: Option<String>,
}

/// Groups the analysis bands into `n` bars. Mirrored: half as many distinct values with the bass
/// in the middle and the treble at both edges.
pub fn bars_from(bands: &[f32], n: usize, mirror: bool) -> Vec<f32> {
    let n = n.max(1);
    let distinct = if mirror { n.div_ceil(2) } else { n };
    // Bars span 40 Hz..12 kHz of the analysis range; the very top and bottom are mostly empty.
    let (lo, hi) = (ANALYSIS_BANDS as f32 * 0.04, ANALYSIS_BANDS as f32 * 0.93);
    let group: Vec<f32> = (0..distinct)
        .map(|i| {
            let a = lo + (hi - lo) * i as f32 / distinct as f32;
            let b = (lo + (hi - lo) * (i + 1) as f32 / distinct as f32).max(a + 1.0);
            let (a, b) = (a as usize, (b.ceil() as usize).min(bands.len()));
            let slice = &bands[a.min(b.saturating_sub(1))..b];
            let max = slice.iter().copied().fold(0.0, f32::max);
            let mean = slice.iter().sum::<f32>() / slice.len().max(1) as f32;
            0.6 * max + 0.4 * mean
        })
        .collect();
    if !mirror {
        return group;
    }
    (0..n)
        .map(|i| {
            let from_centre = (i as f32 + 0.5 - n as f32 * 0.5).abs();
            group[(from_centre as usize).min(distinct - 1)]
        })
        .collect()
}

impl Visualizer {
    pub fn new(settings: &VisualizerSettings) -> Self {
        let settings = settings.sanitized();
        let (w, h) = (settings.width as usize, settings.height as usize);
        let mut bg = Canvas::new(w, h);
        bg.fill_vertical_gradient(settings.background, settings.background_bottom);
        let mut background_error = None;
        if let Some(path) = &settings.background_image {
            match load_cover_image(path, settings.width, settings.height, settings.background_dim) {
                Ok(pixels) => {
                    // Images with transparency sit on the gradient.
                    for (d, s) in bg.px.iter_mut().zip(pixels) {
                        let k = 1.0 - s[3];
                        *d = [s[0] + d[0] * k, s[1] + d[1] * k, s[2] + d[2] * k, 1.0];
                    }
                }
                Err(e) => background_error = Some(e),
            }
        }
        let text_overlay = text_overlay(&settings);
        let mut v = Self {
            background: bg.px,
            frame: Canvas::new(w, h),
            fg: Canvas::new(w, h),
            bloom: BloomScratch::for_height(h),
            text_overlay,
            rgba: Vec::new(),
            peaks: Vec::new(),
            peak_hold: Vec::new(),
            wave_history: VecDeque::new(),
            stars: Vec::new(),
            rings: Vec::new(),
            last_beat_count: 0,
            ring_timer: 0.0,
            spin: 0.0,
            scroll: 0.0,
            rng: 0x9E37_79B9_7F4A_7C15 ^ (settings.seed as u64).wrapping_mul(0x2545_F491_4F6C_DD1D),
            background_error,
            settings,
        };
        v.stars = (0..STAR_COUNT).map(|_| v.new_star(None)).collect();
        v
    }

    pub fn settings(&self) -> &VisualizerSettings {
        &self.settings
    }

    fn random(&mut self) -> f32 {
        // xorshift64*: deterministic per seed, so a re-export draws the same stars.
        self.rng ^= self.rng >> 12;
        self.rng ^= self.rng << 25;
        self.rng ^= self.rng >> 27;
        ((self.rng.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as f32) / (1u64 << 24) as f32
    }

    fn new_star(&mut self, z: Option<f32>) -> Star {
        let x = self.random() * 2.0 - 1.0;
        let y = self.random() * 2.0 - 1.0;
        let z = z.unwrap_or_else(|| 0.05 + self.random() * 0.95);
        let band = (self.random() * ANALYSIS_BANDS as f32) as usize % ANALYSIS_BANDS;
        Star { x, y, z, band }
    }

    /// Draws one frame. `dt` is the time since the previous frame; `progress` (0..1) drives the
    /// song-position bar when the settings ask for one.
    pub fn render(&mut self, f: &AudioFeatures, dt: f32, progress: Option<f32>) -> &[u8] {
        let dt = if dt.is_finite() { dt.clamp(0.0, 0.25) } else { 0.0 };
        self.frame.copy_from(&self.background);
        self.fg.clear([0.0; 4]);

        match self.settings.style {
            VisualStyle::Bars => self.draw_bars(f, dt),
            VisualStyle::Radial => self.draw_radial(f, dt),
            VisualStyle::Wave => self.draw_wave(f),
            VisualStyle::Particles => self.draw_particles(f, dt),
            VisualStyle::Rings => self.draw_rings(f, dt),
            VisualStyle::Horizon => self.draw_horizon(f, dt),
        }
        self.last_beat_count = f.beat_count;

        self.frame.compose_rgba8(&self.fg, self.settings.glow * 1.8, &mut self.bloom, &mut self.rgba);
        self.draw_overlays(progress);
        &self.rgba
    }

    fn dims(&self) -> (f32, f32, f32, f32) {
        let (w, h) = (self.frame.width as f32, self.frame.height as f32);
        let s = w.min(h);
        (w, h, s, s / 720.0)
    }

    fn draw_bars(&mut self, f: &AudioFeatures, dt: f32) {
        let (w, h, _s, unit) = self.dims();
        let st = self.settings.clone();
        let n = st.bar_count as usize;
        let vals = bars_from(&f.bands, n, st.mirror);
        self.peaks.resize(n, 0.0);
        self.peak_hold.resize(n, 0.0);
        let (left, right) = (w * 0.06, w * 0.94);
        let slot = (right - left) / n as f32;
        let bw = (slot * 0.64).max(1.0);
        let base = h * 0.7;
        let max_h = h * 0.5;
        for (i, v) in vals.iter().copied().enumerate() {
            let x = left + slot * i as f32 + (slot - bw) * 0.5;
            let bh = (v * max_h).max(unit * 3.0);
            let color = lerp_color(st.primary, st.secondary, v.powf(0.8));
            self.fg.fill_rounded_rect(x, base - bh, x + bw, base, bw * 0.35, color);
            // Reflection: three fading strips on the crisp layer.
            let gap = unit * 4.0;
            for k in 0..3 {
                let (t0, t1) = (k as f32 / 3.0, (k + 1) as f32 / 3.0);
                let refl = bh * 0.32;
                self.frame.fill_rect(x, base + gap + refl * t0, x + bw, base + gap + refl * t1, with_alpha(color, 0.16 * (1.0 - t0)));
            }
            // Peak caps hold briefly, then fall.
            if v >= self.peaks[i] {
                self.peaks[i] = v;
                self.peak_hold[i] = 0.3;
            } else if self.peak_hold[i] > 0.0 {
                self.peak_hold[i] -= dt;
            } else {
                self.peaks[i] = (self.peaks[i] - dt * 0.55).max(v);
            }
            let py = base - (self.peaks[i] * max_h).max(unit * 3.0) - unit * 5.0;
            self.fg.fill_rounded_rect(x, py - unit * 3.0, x + bw, py, unit * 1.5, with_alpha(st.primary, 0.9));
        }
    }

    fn draw_radial(&mut self, f: &AudioFeatures, dt: f32) {
        let (w, h, s, unit) = self.dims();
        let st = self.settings.clone();
        let (cx, cy) = (w * 0.5, h * 0.5);
        self.spin += dt * (0.04 + 0.4 * f.level);
        let base_r = s * 0.17 * (1.0 + 0.12 * f.bass + 0.1 * f.beat);
        let spokes = (st.bar_count as usize * 2).max(16);
        let vals = bars_from(&f.bands, spokes, st.mirror);
        let width = (TAU * base_r / spokes as f32 * 0.55).clamp(1.0, s * 0.02);
        self.fg.fill_radial_glow(cx, cy, base_r * 1.25, with_alpha(st.secondary, 0.12 + 0.35 * f.beat));
        for (k, v) in vals.iter().copied().enumerate() {
            let angle = self.spin + k as f32 / spokes as f32 * TAU - PI * 0.5;
            let (dx, dy) = (angle.cos(), angle.sin());
            let r0 = base_r + unit * 8.0;
            let r1 = r0 + s * 0.012 + v * s * 0.27;
            let color = lerp_color(st.primary, st.secondary, v.powf(0.8));
            self.fg.stroke_polyline(&[[cx + dx * r0, cy + dy * r0], [cx + dx * r1, cy + dy * r1]], width, color, false);
        }
        self.frame.fill_circle(cx, cy, base_r - unit * 2.0, with_alpha(st.background_bottom, 0.85));
        self.fg.stroke_circle(cx, cy, base_r, unit * 3.0, with_alpha(st.primary, 0.95));
        self.fg.stroke_circle(cx, cy, base_r * (0.55 + 0.25 * f.level), unit * 1.5, with_alpha(st.secondary, 0.5 + 0.5 * f.beat));
    }

    fn draw_wave(&mut self, f: &AudioFeatures) {
        let (w, h, _s, unit) = self.dims();
        let st = self.settings.clone();
        self.wave_history.push_front(f.waveform.clone());
        self.wave_history.truncate(WAVE_ECHOES);
        let (x0, x1, cy, amp) = (w * 0.05, w * 0.95, h * 0.5, h * 0.3);
        self.frame.fill_rect(x0, cy - unit * 0.5, x1, cy + unit * 0.5, [1.0, 1.0, 1.0, 0.06]);
        let trace = |wave: &[f32], scale: f32, invert: f32| -> Vec<[f32; 2]> {
            let last = (wave.len() - 1).max(1) as f32;
            wave.iter().enumerate().map(|(i, v)| [x0 + (x1 - x0) * i as f32 / last, cy - v * amp * scale * invert]).collect()
        };
        // Oldest echo first, so the live trace ends up on top.
        for age in (1..self.wave_history.len()).rev() {
            let fade = 1.0 - age as f32 / WAVE_ECHOES as f32;
            let pts = trace(&self.wave_history[age], 1.0 + age as f32 * 0.07, 1.0);
            self.fg.stroke_polyline(&pts, unit * 2.0, with_alpha(st.secondary, 0.4 * fade * fade), false);
        }
        if st.mirror {
            let pts = trace(&f.waveform, 1.0, -1.0);
            self.fg.stroke_polyline(&pts, unit * 2.5, with_alpha(st.secondary, 0.7), false);
        }
        let pts = trace(&f.waveform, 1.0, 1.0);
        self.fg.stroke_polyline(&pts, unit * (3.5 + 3.0 * f.beat), st.primary, false);
    }

    fn draw_particles(&mut self, f: &AudioFeatures, dt: f32) {
        let (w, h, s, unit) = self.dims();
        let st = self.settings.clone();
        let (cx, cy) = (w * 0.5, h * 0.5);
        let speed = 0.1 + 0.9 * f.level + 1.8 * f.beat;
        self.fg.fill_radial_glow(cx, cy, s * (0.18 + 0.25 * f.bass), with_alpha(st.secondary, 0.1 + 0.35 * f.beat));
        self.fg.additive = true;
        let focal = s * 0.5;
        for i in 0..self.stars.len() {
            let prev_z = self.stars[i].z;
            self.stars[i].z -= speed * dt * 0.5;
            let star = &self.stars[i];
            let (sx, sy) = (cx + star.x / star.z.max(0.01) * focal, cy + star.y / star.z.max(0.01) * focal);
            if star.z <= 0.02 || sx < -20.0 || sx > w + 20.0 || sy < -20.0 || sy > h + 20.0 {
                self.stars[i] = self.new_star(Some(1.0));
                continue;
            }
            let band_v = f.bands[star.band];
            let near = 1.0 - star.z;
            let size = unit * (0.5 + 2.4 * near) * (1.0 + band_v);
            let color = with_alpha(lerp_color(st.primary, st.secondary, star.band as f32 / ANALYSIS_BANDS as f32), near.powf(0.7) * (0.35 + 0.65 * band_v));
            // A streak back to where the star was a few frames ago reads as speed.
            let trail_z = (prev_z + speed * dt * 1.5).min(1.0);
            let (tx, ty) = (cx + star.x / trail_z * focal, cy + star.y / trail_z * focal);
            self.fg.stroke_polyline(&[[tx, ty], [sx, sy]], size, color, false);
        }
        self.fg.additive = false;
    }

    fn draw_rings(&mut self, f: &AudioFeatures, dt: f32) {
        let (w, h, s, unit) = self.dims();
        let st = self.settings.clone();
        let (cx, cy) = (w * 0.5, h * 0.5);
        let new_beats = f.beat_count.saturating_sub(self.last_beat_count);
        for k in 0..new_beats.min(3) {
            let color = if (f.beat_count - k) % 2 == 0 { st.primary } else { st.secondary };
            self.rings.push(Ring { r: 0.1, width: 0.01 * (1.0 + 1.5 * f.bass), alpha: 1.0, color });
        }
        // A faint ring now and then keeps quiet passages moving.
        self.ring_timer += dt;
        if self.ring_timer > 0.7 {
            self.ring_timer = 0.0;
            self.rings.push(Ring { r: 0.1, width: 0.004, alpha: 0.35, color: st.primary });
        }
        let grow = 0.3 + 0.5 * f.level;
        for ring in &mut self.rings {
            ring.r += dt * grow * (0.6 + ring.r);
        }
        self.rings.retain(|r| r.r < 1.0);
        for ring in &self.rings {
            let fade = (1.0 - ring.r / 1.0).powf(1.5);
            self.fg.stroke_circle(cx, cy, ring.r * s, (ring.width * s).max(1.0), with_alpha(ring.color, ring.alpha * fade));
        }
        // Spectrum dots round the centre.
        let n = st.bar_count as usize;
        let vals = bars_from(&f.bands, n, st.mirror);
        let dot_r = s * 0.13;
        for (k, v) in vals.iter().copied().enumerate() {
            let a = k as f32 / n as f32 * TAU - PI * 0.5 - self.spin * 0.5;
            let color = lerp_color(st.primary, st.secondary, v);
            self.fg.fill_circle(cx + a.cos() * dot_r, cy + a.sin() * dot_r, unit * (1.5 + 7.0 * v), color);
        }
        // Spinning hexagon.
        self.spin += dt * (0.3 + 2.0 * f.level);
        let pr = s * (0.06 + 0.04 * f.level + 0.03 * f.beat);
        let hex: Vec<[f32; 2]> = (0..6).map(|k| {
            let a = self.spin + k as f32 / 6.0 * TAU;
            [cx + a.cos() * pr, cy + a.sin() * pr]
        }).collect();
        self.frame.fill_polygon(&hex, with_alpha(st.secondary, 0.18 + 0.3 * f.beat));
        self.fg.stroke_polyline(&hex, unit * 3.0, st.primary, true);
    }

    fn draw_horizon(&mut self, f: &AudioFeatures, dt: f32) {
        let (w, h, s, unit) = self.dims();
        let st = self.settings.clone();
        let horizon = h * 0.66;
        let (cx, sun_y) = (w * 0.5, horizon - s * 0.06);
        // Sun: glow, disc, then retro stripes cut out of its lower half in the floor colour.
        let sun_r = s * 0.16 * (1.0 + 0.08 * f.beat + 0.06 * f.bass);
        self.fg.fill_radial_glow(cx, sun_y, sun_r * 2.3, with_alpha(st.secondary, 0.22 + 0.3 * f.beat));
        self.frame.fill_circle(cx, sun_y, sun_r, lerp_color(st.secondary, st.primary, 0.15));
        for k in 0..5 {
            let y = sun_y + sun_r * (0.1 + k as f32 * 0.18);
            self.frame.fill_rect(cx - sun_r, y, cx + sun_r, y + sun_r * 0.03 * (k + 1) as f32, st.background_bottom);
        }
        // Floor grid: horizontal lines rushing toward the viewer, converging verticals.
        self.scroll = (self.scroll + dt * (0.15 + 0.8 * f.level)).fract();
        self.frame.fill_rect(0.0, horizon, w, h, with_alpha(st.background_bottom, 0.9));
        let grid = with_alpha(st.primary, 0.18 + 0.2 * f.beat);
        for k in 0..10 {
            let t = ((k as f32 + self.scroll) / 10.0).powi(2);
            let y = horizon + (h - horizon) * t;
            self.frame.fill_rect(0.0, y, w, y + unit * (0.6 + 1.5 * t), grid);
        }
        for k in -8i32..=8 {
            let x_far = cx + k as f32 * w * 0.03;
            let x_near = cx + k as f32 * w * 0.16;
            self.frame.stroke_polyline(&[[x_far, horizon], [x_near, h]], unit, with_alpha(grid, 0.8), false);
        }
        // Hills: three layers of the (mirrored) spectrum, back to front.
        let steps = 72;
        for layer in 0..3 {
            let depth = layer as f32 / 2.0;
            let mut vals = bars_from(&f.bands, steps, true);
            // A little blur so the hills roll instead of stepping.
            let copy = vals.clone();
            for i in 0..steps {
                let (a, b) = (copy[i.saturating_sub(1)], copy[(i + 1).min(steps - 1)]);
                vals[i] = 0.25 * a + 0.5 * copy[i] + 0.25 * b;
            }
            let scale = 0.12 + 0.2 * depth;
            let mut pts = Vec::with_capacity(steps + 2);
            for (i, v) in vals.iter().enumerate() {
                let x = w * i as f32 / (steps - 1) as f32;
                let lift = (0.04 + v * 0.9) * h * scale * (1.0 + 0.3 * (1.0 - depth) * (i as f32 * 0.37 + layer as f32).sin().abs());
                pts.push([x, horizon - lift]);
            }
            let color = with_alpha(lerp_color(st.secondary, st.primary, depth), 0.45 + 0.4 * depth);
            let outline = pts.clone();
            pts.push([w, horizon]);
            pts.push([0.0, horizon]);
            self.frame.fill_polygon(&pts, lerp_color(st.background, color, 0.35 + 0.25 * depth));
            self.fg.stroke_polyline(&outline, unit * (1.5 + depth * 1.5), color, false);
            // Mirror in the floor.
            let reflection: Vec<[f32; 2]> = pts.iter().map(|p| [p[0], horizon + (horizon - p[1]) * 0.35]).collect();
            self.frame.fill_polygon(&reflection, with_alpha(color, 0.08));
        }
    }

    /// The progress bar and the title/artist, over the finished RGBA8 frame (never bloomed).
    fn draw_overlays(&mut self, progress: Option<f32>) {
        let (w, h, _s, unit) = self.dims();
        let (width, height) = (self.frame.width, self.frame.height);
        let blend = |rgba: &mut [u8], i: usize, c: Color| {
            let o = &mut rgba[i * 4..i * 4 + 3];
            for ch in 0..3 {
                o[ch] = ((c[ch] + o[ch] as f32 / 255.0 * (1.0 - c[3])).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        };
        if let (true, Some(p)) = (self.settings.show_progress, progress) {
            let bar_h = (unit * 5.0).max(2.0);
            let top = ((h - bar_h).round().max(0.0) as usize).min(height);
            let filled = ((w * p.clamp(0.0, 1.0)).round() as usize).min(width);
            let track = [0.1, 0.1, 0.1, 0.1];
            let c = self.settings.primary;
            let fill = [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
            for y in top..height {
                for x in 0..width {
                    blend(&mut self.rgba, y * width + x, if x < filled { fill } else { track });
                }
            }
        }
        for &(i, c) in &self.text_overlay {
            blend(&mut self.rgba, i as usize, c);
        }
    }
}

/// Renders the title and artist once, bottom-left with a soft shadow, and keeps only the pixels
/// they touch.
fn text_overlay(st: &VisualizerSettings) -> Vec<(u32, Color)> {
    if st.title.trim().is_empty() && st.artist.trim().is_empty() {
        return Vec::new();
    }
    let (w, h) = (st.width as usize, st.height as usize);
    let s = w.min(h) as f32;
    let unit = s / 720.0;
    let mut layer = Canvas::new(w, h);
    let mut text = TextPainter::new(&st.font);
    let margin = s * 0.06;
    let (title_px, artist_px) = (s * 0.06, s * 0.037);
    let bar_h = (unit * 5.0).max(2.0);
    let mut baseline = h as f32 - margin - if st.show_progress { bar_h } else { 0.0 };
    let shadow = [0.0, 0.0, 0.0, 0.55];
    let off = unit * 2.0;
    if !st.artist.trim().is_empty() {
        text.draw(&mut layer, &st.artist, margin + off, baseline + off, artist_px, shadow, TextAlign::Left);
        text.draw(&mut layer, &st.artist, margin, baseline, artist_px, [1.0, 1.0, 1.0, 0.75], TextAlign::Left);
        baseline -= artist_px * 1.45;
    }
    if !st.title.trim().is_empty() {
        text.draw(&mut layer, &st.title, margin + off, baseline + off, title_px, shadow, TextAlign::Left);
        text.draw(&mut layer, &st.title, margin, baseline, title_px, [1.0, 1.0, 1.0, 1.0], TextAlign::Left);
    }
    layer.px.iter().enumerate().filter(|(_, p)| p[3] > 0.0).map(|(i, p)| (i as u32, *p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loud_features() -> AudioFeatures {
        let mut f = AudioFeatures::default();
        for (i, b) in f.bands.iter_mut().enumerate() {
            *b = 0.3 + 0.6 * ((i as f32) * 0.2).sin().abs();
        }
        for (i, v) in f.waveform.iter_mut().enumerate() {
            *v = 0.7 * (i as f32 * 0.1).sin();
        }
        f.level = 0.8;
        f.bass = 0.7;
        f.mid = 0.5;
        f.treble = 0.4;
        f.beat = 1.0;
        f.beat_count = 1;
        f.onset = true;
        f
    }

    fn lit_pixels(rgba: &[u8], background: &[u8]) -> usize {
        rgba.chunks_exact(4).zip(background.chunks_exact(4)).filter(|(a, b)| a != b).count()
    }

    #[test]
    fn every_style_draws_something_over_its_background() {
        for style in VisualStyle::ALL {
            let settings = VisualizerSettings { style, width: 320, height: 180, show_progress: false, ..Default::default() };
            let mut quiet = Visualizer::new(&settings);
            let background = quiet.background.iter().map(|p| p.map(|c| (c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)).collect::<Vec<_>>().concat();
            let mut v = Visualizer::new(&settings);
            let f = loud_features();
            let frame = v.render(&f, 1.0 / 30.0, None).to_vec();
            assert_eq!(frame.len(), 320 * 180 * 4);
            let lit = lit_pixels(&frame, &background);
            assert!(lit > 320 * 180 / 50, "{style:?} lit only {lit} pixels");
            // Silence draws less than a loud frame does.
            let silent = quiet.render(&AudioFeatures::default(), 1.0 / 30.0, None).to_vec();
            assert!(lit_pixels(&silent, &background) < lit, "{style:?}");
        }
    }

    #[test]
    fn frames_are_deterministic_for_a_seed() {
        let settings = VisualizerSettings { style: VisualStyle::Particles, width: 160, height: 90, ..Default::default() };
        let f = loud_features();
        let (mut a, mut b) = (Visualizer::new(&settings), Visualizer::new(&settings));
        for _ in 0..3 {
            assert_eq!(a.render(&f, 1.0 / 30.0, Some(0.5)), b.render(&f, 1.0 / 30.0, Some(0.5)));
        }
    }

    #[test]
    fn title_and_progress_bar_are_drawn() {
        let base = VisualizerSettings { width: 320, height: 180, ..Default::default() };
        let plain = Visualizer::new(&VisualizerSettings { show_progress: false, ..base.clone() }).render(&AudioFeatures::default(), 0.0, Some(0.5)).to_vec();
        let titled = Visualizer::new(&VisualizerSettings { title: "Night Drive".into(), artist: "Entropy".into(), ..base }).render(&AudioFeatures::default(), 0.0, Some(0.5)).to_vec();
        assert!(lit_pixels(&titled, &plain) > 300);
        // Progress bar: bottom-left pixel is the primary colour, bottom-right is not.
        let px = |x: usize, y: usize| &titled[(y * 320 + x) * 4..(y * 320 + x) * 4 + 3];
        assert_ne!(px(10, 179), px(310, 179));
    }

    #[test]
    fn mirrored_bars_are_symmetric_with_bass_in_the_middle() {
        let bands: Vec<f32> = (0..ANALYSIS_BANDS).map(|i| 1.0 - i as f32 / ANALYSIS_BANDS as f32).collect();
        let bars = bars_from(&bands, 10, true);
        for i in 0..5 {
            assert_eq!(bars[i], bars[9 - i]);
        }
        assert!(bars[4] > bars[0]);
    }

    #[test]
    fn missing_background_image_falls_back_to_the_gradient() {
        let v = Visualizer::new(&VisualizerSettings { width: 64, height: 64, background_image: Some("/nope/missing.png".into()), ..Default::default() });
        assert!(v.background_error.is_some());
    }
}
