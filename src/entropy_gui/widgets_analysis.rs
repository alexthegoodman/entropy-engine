//! Signal-analysis widgets: `Oscilloscope`, `SpectrumView` and `LevelMeter`. Same domain-agnostic
//! shape as `KanbanBoard`/`TrackView`: the caller hands in flat data every frame (samples, dB bins,
//! a peak/RMS reading) and the widget owns only what has to persist between frames, kept in
//! `Memory` by widget id (smoothed levels, peak-hold ticks, phosphor trails). Nothing in here
//! knows about audio engines or buses; `deno::addon_engine` resolves a source name to data and
//! calls these.
//!
//! The drawing is deliberate about three things an analyzer gets wrong when it is just "plot the
//! array":
//!
//! * The scope **triggers**. A periodic signal drawn from wherever the newest sample happens to
//!   land crawls across the screen; here every frame starts at the same rising crossing, located
//!   to a fraction of a sample by linear interpolation, so a steady tone holds perfectly still.
//! * The spectrum is drawn on a **log frequency axis**, where a linear FFT has too few bins at
//!   the bass and far too many at the treble. Low columns interpolate between bins; high columns
//!   take the maximum of the bins they cover, so a narrow treble peak is never averaged away.
//! * The meter measures **since the last frame** (the caller supplies that), latches clipping
//!   until clicked, and falls at a fixed dB rate, so a 10 ms transient is visible for long
//!   enough to see.

use std::collections::VecDeque;

use lyon_tessellation::{math::point, path::Path as LyonPath, BuffersBuilder, LineJoin, StrokeOptions, StrokeTessellator, StrokeVertex, VertexBuffers};

use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape;
use crate::entropy_gui::ui::{interact, Ui};


const PANEL_TOP: Color32 = Color32::from_rgb(10, 13, 18);
const PANEL_BOTTOM: Color32 = Color32::from_rgb(16, 21, 29);
const GRID_MINOR: Color32 = Color32::from_white_alpha(13);
const GRID_MAJOR: Color32 = Color32::from_white_alpha(30);
const LABEL: Color32 = Color32::from_rgb(112, 124, 140);
const LABEL_FONT: f32 = 9.5;

/// Default trace colour: a cool phosphor mint.
pub const ACCENT: Color32 = Color32::from_rgb(92, 242, 196);
/// Second channel colour, and the "hot" end of the spectrum gradient.
pub const HOT: Color32 = Color32::from_rgb(255, 118, 96);

// ------------------------------------------------------------------------------------------
// Pure helpers (unit tested below, and driven by tests/audio_widgets_bdd.rs)
// ------------------------------------------------------------------------------------------

/// Where `db` sits between `min_db` (0.0) and `max_db` (1.0), clamped.
pub fn db_to_frac(db: f32, min_db: f32, max_db: f32) -> f32 {
    if max_db <= min_db {
        return 0.0;
    }
    ((db - min_db) / (max_db - min_db)).clamp(0.0, 1.0)
}

/// Position of `hz` on a log axis from `min_hz` (0.0) to `max_hz` (1.0), clamped.
pub fn hz_to_frac(hz: f32, min_hz: f32, max_hz: f32) -> f32 {
    ((hz.max(min_hz).ln() - min_hz.ln()) / (max_hz.ln() - min_hz.ln())).clamp(0.0, 1.0)
}

pub fn frac_to_hz(frac: f32, min_hz: f32, max_hz: f32) -> f32 {
    min_hz * (max_hz / min_hz).powf(frac)
}

/// Nearest equal-tempered note (A4 = 440 Hz) and the offset from it in cents.
pub fn note_name(hz: f32) -> Option<(String, i32)> {
    if !(hz > 8.0 && hz.is_finite()) {
        return None;
    }
    const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let midi = 69.0 + 12.0 * (hz / 440.0).log2();
    let nearest = midi.round();
    let cents = ((midi - nearest) * 100.0).round() as i32;
    let n = nearest as i32;
    Some((format!("{}{}", NAMES[n.rem_euclid(12) as usize], n.div_euclid(12) - 1), cents))
}

pub fn format_hz(hz: f32) -> String {
    if hz >= 1000.0 { format!("{:.2} kHz", hz / 1000.0) } else if hz >= 100.0 { format!("{:.0} Hz", hz) } else { format!("{:.1} Hz", hz) }
}

/// Every rising crossing of `level`, as a fractional sample index, in order. A crossing only
/// counts once the signal has first dipped `hysteresis` below `level`, so noise wobbling around
/// the level does not fire a burst of false triggers.
pub fn rising_crossings(samples: &[f32], level: f32, hysteresis: f32) -> Vec<f32> {
    let mut out = Vec::new();
    let mut armed = false;
    for i in 1..samples.len() {
        let (a, b) = (samples[i - 1], samples[i]);
        if a < level - hysteresis {
            armed = true;
        }
        if armed && a < level && b >= level {
            out.push((i - 1) as f32 + (level - a) / (b - a));
            armed = false;
        }
    }
    out
}

fn hysteresis_for(samples: &[f32]) -> f32 {
    let peak = samples.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    (peak * 0.05).max(1.0e-4)
}

/// The latest rising crossing of `level` that still leaves `window` samples after it, as a
/// fractional index into `samples`. Sub-sample precision is what keeps a steady tone from
/// shimmering: with 1024 samples across 400 px, integer alignment alone would jitter the trace
/// by up to 0.4 px between frames.
pub fn find_trigger(samples: &[f32], level: f32, window: usize) -> Option<f32> {
    if samples.len() < window + 2 {
        return None;
    }
    let h = hysteresis_for(samples);
    rising_crossings(samples, level, h).into_iter().rev().find(|t| t.floor() as usize + window <= samples.len())
}

/// Frequency of a periodic signal from the spacing of its rising crossings, or `None` when there
/// are too few, or the spacing is not steady enough to call it a pitch (noise, a chord).
pub fn estimate_frequency(samples: &[f32], sample_rate: f32) -> Option<f32> {
    let c = rising_crossings(samples, 0.0, hysteresis_for(samples));
    if c.len() < 3 {
        return None;
    }
    let periods: Vec<f32> = c.windows(2).map(|w| w[1] - w[0]).collect();
    let mean = periods.iter().sum::<f32>() / periods.len() as f32;
    if mean < 2.0 || periods.iter().any(|p| (p - mean).abs() > mean * 0.06) {
        return None;
    }
    Some(sample_rate / mean)
}

/// True when the two channels are the same signal, sample for sample (a mono source panned dead
/// centre). A stereo scope draws that as one trace: two identical traces at the same place would
/// just hide the first colour under the second.
pub fn channels_identical(left: &[f32], right: &[f32]) -> bool {
    left.len() == right.len() && left.iter().zip(right).all(|(a, b)| (a - b).abs() < 1.0e-6)
}

/// Pearson correlation of the two channels, -1 (out of phase) to +1 (identical); 0 for silence.
pub fn phase_correlation(left: &[f32], right: &[f32]) -> f32 {
    let n = left.len().min(right.len());
    let (mut lr, mut ll, mut rr) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        let (l, r) = (left[i] as f64, right[i] as f64);
        lr += l * r;
        ll += l * l;
        rr += r * r;
    }
    let d = (ll * rr).sqrt();
    if d < 1.0e-12 { 0.0 } else { (lr / d) as f32 }
}

fn catmull_rom(p0: f32, p1: f32, p2: f32, p3: f32, t: f32) -> f32 {
    0.5 * (2.0 * p1 + (p2 - p0) * t + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t * t + (3.0 * p1 - p0 - 3.0 * p2 + p3) * t * t * t)
}

/// The dB level to show for the frequency range `f_lo..f_hi` of a linear-frequency spectrum
/// (`bins_db[k]` is at `k * bin_hz`). A range narrower than one bin is interpolated (Catmull-Rom,
/// between the four nearest bins); a wider one takes the maximum over the bins inside it.
pub fn pool_range(bins_db: &[f32], bin_hz: f32, f_lo: f32, f_hi: f32) -> f32 {
    let last = bins_db.len() as isize - 1;
    if last < 1 || bin_hz <= 0.0 {
        return -120.0;
    }
    let (k_lo, k_hi) = (f_lo / bin_hz, f_hi / bin_hz);
    let at = |k: isize| bins_db[k.clamp(0, last) as usize];
    let first = k_lo.ceil() as isize;
    let final_ = k_hi.floor() as isize;
    if final_ - first >= 1 || (first <= final_ && k_hi - k_lo >= 1.0) {
        return (first..=final_).map(at).fold(f32::MIN, f32::max);
    }
    let k = 0.5 * (k_lo + k_hi);
    let k0 = k.floor() as isize;
    let t = k - k0 as f32;
    // Interpolate in linear amplitude and never leave the range of the two bracketing bins. Doing
    // it on the dB values instead overshoots badly: a Hann lobe has nulls two bins from its peak
    // (about -100 dB), the cubic swings through them, and a -6 dBFS tone was drawn at -1.7 dBFS.
    let amp = |k: isize| 10.0f32.powf(at(k) / 20.0);
    let (a1, a2) = (amp(k0), amp(k0 + 1));
    let v = catmull_rom(amp(k0 - 1), a1, a2, amp(k0 + 2), t).clamp(a1.min(a2), a1.max(a2));
    (20.0 * v.max(1.0e-6).log10()).clamp(-120.0, 12.0)
}

/// One dB value per screen column across a log axis of `width_px` columns.
pub fn spectrum_columns(bins_db: &[f32], bin_hz: f32, width_px: usize, min_hz: f32, max_hz: f32) -> Vec<f32> {
    (0..width_px)
        .map(|c| {
            let lo = frac_to_hz(c as f32 / width_px as f32, min_hz, max_hz);
            let hi = frac_to_hz((c + 1) as f32 / width_px as f32, min_hz, max_hz);
            pool_range(bins_db, bin_hz, lo, hi)
        })
        .collect()
}

/// Screen-space polyline points for one scope trace: `window` samples of `samples[0..]`, shifted
/// left by the sub-sample `frac`, as normalised `[x in 0..1, y in -1..1]`. A window wider than
/// twice the pixel width is reduced to a min/max pair per column, so a fast peak between two
/// columns is still drawn.
pub fn trace_points(samples: &[f32], frac: f32, window: usize, width_px: usize, gain: f32) -> Vec<[f32; 2]> {
    let window = window.min(samples.len());
    if window < 2 {
        return Vec::new();
    }
    let y = |v: f32| (v * gain).clamp(-1.05, 1.05);
    if window <= width_px * 2 {
        return (0..window).map(|k| [(k as f32 - frac) / (window - 1) as f32, y(samples[k])]).collect();
    }
    let mut pts = Vec::with_capacity(width_px * 2);
    for c in 0..width_px {
        let (a, b) = (c * window / width_px, ((c + 1) * window / width_px).min(window));
        if a >= b {
            continue;
        }
        let (mut lo, mut hi) = (f32::MAX, f32::MIN);
        for v in &samples[a..b] {
            lo = lo.min(*v);
            hi = hi.max(*v);
        }
        let x = (c as f32 + 0.5) / width_px as f32;
        // Alternate the order so the line zig-zags through both extremes without doubling back.
        if c % 2 == 0 { pts.extend([[x, y(hi)], [x, y(lo)]]) } else { pts.extend([[x, y(lo)], [x, y(hi)]]) }
    }
    pts
}

// ------------------------------------------------------------------------------------------
// Drawing helpers
// ------------------------------------------------------------------------------------------

/// An open polyline stroke with round joins. `shape::tessellate_line` uses lyon's default miter
/// join, which at the pointed apex of a narrow spectral peak extends the outline several pixels
/// past the data (measured: a -6 dBFS tone drawn as -4.6), and a trace that reverses direction
/// (a mono figure on the goniometer) gets spikes at every turn. A round join stays inside
/// half a line-width of the true point.
fn polyline(painter: &Painter, pts: &[Pos2], width: f32, color: Color32) {
    stroke_polyline(painter, pts, width, color, LineJoin::Round);
}

/// A translucent, wide stroke (a glow, an afterglow trail) does not need round joins: the joins
/// are hidden by the softness, and a bevel is one triangle where a round join is an arc. On a
/// min/max scope trace, where the line turns nearly 180 degrees at every column, that is most
/// of the vertices.
fn glow_polyline(painter: &Painter, pts: &[Pos2], width: f32, color: Color32) {
    stroke_polyline(painter, pts, width, color, LineJoin::Bevel);
}

fn stroke_polyline(painter: &Painter, pts: &[Pos2], width: f32, color: Color32, join: LineJoin) {
    if pts.len() < 2 || width <= 0.0 || color.a() == 0 {
        return;
    }
    let mut b = LyonPath::builder();
    b.begin(point(pts[0].x, pts[0].y));
    for p in &pts[1..] {
        b.line_to(point(p.x, p.y));
    }
    b.end(false);
    let path = b.build();
    let c = color.to_array_f32();
    let mut geometry: VertexBuffers<Vertex, u32> = VertexBuffers::new();
    let _ = StrokeTessellator::new().tessellate_path(
        &path,
        // A tolerance of half a pixel is plenty for strokes this thin and halves the arc segments.
        &StrokeOptions::default().with_line_width(width).with_line_join(join).with_tolerance(0.5),
        &mut BuffersBuilder::new(&mut geometry, |v: StrokeVertex| Vertex::new(v.position().x, v.position().y, 0.0, c)),
    );
    painter.mesh(geometry.vertices, geometry.indices);
}

/// A filled area under `top` down to `bottom_y`, vertex-coloured so the fill fades toward the
/// floor: one triangle strip, one mesh.
fn gradient_strip(painter: &Painter, top: &[Pos2], top_colors: &[Color32], bottom_y: f32, bottom_color: Color32) {
    if top.len() < 2 {
        return;
    }
    let mut verts = Vec::with_capacity(top.len() * 2);
    let mut idx = Vec::with_capacity(top.len() * 6);
    for (i, p) in top.iter().enumerate() {
        verts.push(Vertex::new(p.x, p.y, 0.0, top_colors[i].to_array_f32()));
        verts.push(Vertex::new(p.x, bottom_y.max(p.y), 0.0, bottom_color.to_array_f32()));
        if i > 0 {
            let b = (i * 2) as u32;
            idx.extend([b - 2, b - 1, b, b - 1, b + 1, b]);
        }
    }
    painter.mesh(verts, idx);
}

/// Index ranges `[start, end)` of consecutive `true` values, each grown by one point either side
/// so the drawn line meets its neighbours instead of stopping a column short.
fn active_runs(active: &[bool]) -> Vec<(usize, usize)> {
    let mut runs = Vec::new();
    let mut i = 0;
    while i < active.len() {
        if active[i] {
            let start = i;
            while i < active.len() && active[i] {
                i += 1;
            }
            runs.push((start.saturating_sub(1), (i + 1).min(active.len())));
        } else {
            i += 1;
        }
    }
    runs
}

fn panel(painter: &Painter, rect: Rect) {
    painter.rect_filled_gradient(rect, PANEL_TOP, PANEL_TOP, PANEL_BOTTOM, PANEL_BOTTOM);
    painter.rect_stroke(rect, 4u8, Stroke::new(1.0, Color32::from_white_alpha(38)), StrokeKind::Middle);
}

fn label(painter: &Painter, pos: Pos2, align: Align2, text: impl ToString, color: Color32) {
    painter.text(pos, align, text, FontId::proportional(LABEL_FONT), color);
}

fn with_alpha(c: Color32, a: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(c.r(), c.g(), c.b(), (a.clamp(0.0, 1.0) * 255.0) as u8)
}

// ------------------------------------------------------------------------------------------
// Oscilloscope
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScopeMode {
    /// One trace: the mid signal, (L + R) / 2.
    Mono,
    /// Left and right overlaid in two colours.
    Stereo,
    /// Left against right, turned 45 degrees (a goniometer): mono is a vertical line, out-of-phase
    /// is horizontal, and the width of the figure is the width of the stereo image.
    Xy,
}

#[derive(Clone, Debug)]
pub struct ScopeOptions {
    pub mode: ScopeMode,
    pub height: f32,
    /// Samples across the screen in `Mono`/`Stereo`, and how many the `Xy` figure is built from.
    pub window_frames: usize,
    pub trigger: bool,
    pub trigger_level: f32,
    pub color: Color32,
    /// How long, in seconds, an old trace glows after it was drawn. 0 turns the afterglow off.
    pub persistence: f32,
    pub sample_rate: f32,
    /// Vertical zoom: 1.0 puts full scale at the edge of the graticule.
    pub gain: f32,
    /// Fixed width in points; `None` fills the width left in the layout, which is what you want
    /// for a widget on its own row and not for one of several side by side.
    pub width: Option<f32>,
}

impl Default for ScopeOptions {
    fn default() -> Self {
        Self {
            mode: ScopeMode::Mono,
            height: 180.0,
            window_frames: 1024,
            trigger: true,
            trigger_level: 0.0,
            color: ACCENT,
            persistence: 0.12,
            sample_rate: 44_100.0,
            gain: 1.0,
            width: None,
        }
    }
}

struct Trail {
    born: f32,
    traces: Vec<Vec<[f32; 2]>>,
}

#[derive(Default)]
struct ScopeState {
    trails: VecDeque<Trail>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct ScopeResponse {
    pub rect: Rect,
    /// The graticule: what the trace is drawn inside. Square in `Xy` mode.
    pub plot: Rect,
    /// True when this frame locked to a trigger crossing, false when it free-ran.
    pub triggered: bool,
    pub frequency_hz: Option<f32>,
    pub correlation: f32,
}

pub struct Oscilloscope {
    id: Id,
    opts: ScopeOptions,
}

impl Oscilloscope {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("oscilloscope").with(id_salt), opts: ScopeOptions::default() }
    }

    pub fn options(mut self, opts: ScopeOptions) -> Self {
        self.opts = opts;
        self
    }

    /// Draws the scope. Pass about twice `window_frames` of the most recent samples: the extra
    /// history is where the trigger crossing is searched for.
    pub fn show(self, ui: &mut Ui, left: &[f32], right: &[f32]) -> ScopeResponse {
        let ctx = ui.ctx().clone();
        let o = self.opts;
        let width = o.width.unwrap_or_else(|| ui.available_size().x.max(120.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, o.height), Sense::hover());
        let rect = resp.rect;
        panel(&painter, rect);
        let plot = rect.shrink(6.0);
        let clip = painter.with_clip_rect(plot);
        let now = ctx.time();
        let mut state: ScopeState = ctx.memory_mut(|m| m.take_view_state(self.id));

        let n = left.len().min(right.len());
        let xy = o.mode == ScopeMode::Xy;
        // The goniometer is a circle: a square inside the plot with room above for its "M" label
        // and below for the correlation bar.
        let square = if xy {
            let side = (plot.width().min(plot.height()) - 30.0).max(20.0);
            Rect::from_center_size(pos2(plot.center().x, plot.center().y - 4.0), vec2(side, side))
        } else {
            plot
        };
        let mut out = ScopeResponse { rect, plot: square, ..Default::default() };

        // Graticule first, so a trace always lies over it.
        draw_scope_graticule(&painter, plot, square, xy, o.gain);

        if n >= 2 {
            let mid: Vec<f32> = (0..n).map(|i| (left[i] + right[i]) * 0.5).collect();
            let window = o.window_frames.clamp(2, n);
            let trig_src: &[f32] = if o.mode == ScopeMode::Stereo { &left[..n] } else { &mid };
            let trig = if o.trigger && !xy { find_trigger(trig_src, o.trigger_level, window) } else { None };
            let (start, frac) = match trig {
                Some(t) => (t.floor() as usize, t.fract()),
                None => (n - window, 0.0),
            };
            out.triggered = trig.is_some();
            out.frequency_hz = estimate_frequency(&mid, o.sample_rate);
            out.correlation = phase_correlation(&left[n - window..n], &right[n - window..n]);

            let px = plot.width() as usize;
            let traces: Vec<Vec<[f32; 2]>> = match o.mode {
                ScopeMode::Mono => vec![trace_points(&mid[start..], frac, window, px, o.gain)],
                ScopeMode::Stereo if channels_identical(&left[..n], &right[..n]) => vec![trace_points(&left[start..n], frac, window, px, o.gain)],
                ScopeMode::Stereo => vec![trace_points(&left[start..n], frac, window, px, o.gain), trace_points(&right[start..n], frac, window, px, o.gain)],
                ScopeMode::Xy => {
                    let g = o.gain;
                    let pts = (n - window..n)
                        .map(|i| [((right[i] - left[i]) * 0.5 * g).clamp(-1.05, 1.05), ((left[i] + right[i]) * 0.5 * g).clamp(-1.05, 1.05)])
                        .collect();
                    vec![pts]
                }
            };

            let colors = [o.color, HOT];
            let to_screen = |p: &[f32; 2]| -> Pos2 {
                if xy {
                    pos2(square.center().x + p[0] * square.width() * 0.5, square.center().y - p[1] * square.height() * 0.5)
                } else {
                    pos2(plot.min.x + p[0] * plot.width(), plot.center().y - p[1] * plot.height() * 0.5)
                }
            };

            // Afterglow: older traces, faintest first.
            if o.persistence > 0.0 {
                for trail in &state.trails {
                    let age = (now - trail.born) / o.persistence;
                    if !(0.0..1.0).contains(&age) {
                        continue;
                    }
                    let a = (1.0 - age).powi(2) * 0.42;
                    for (i, t) in trail.traces.iter().enumerate() {
                        let pts: Vec<Pos2> = t.iter().map(to_screen).collect();
                        glow_polyline(&clip, &pts, 1.4, with_alpha(colors[i.min(1)], a));
                    }
                }
            }

            // The live trace: a wide soft halo, a medium one, then a bright thin core.
            for (i, t) in traces.iter().enumerate() {
                let pts: Vec<Pos2> = t.iter().map(to_screen).collect();
                let c = colors[i.min(1)];
                glow_polyline(&clip, &pts, 4.5, with_alpha(c, 0.16));
                polyline(&clip, &pts, 1.4, c.lerp(Color32::WHITE, 0.35));
            }

            // One stored trail per quarter of the persistence time, not one per frame: at 60 fps a
            // 0.12 s afterglow would otherwise be seven full traces re-tessellated every frame, and
            // four are enough to read as a smear.
            let due = state.trails.back().map_or(true, |t| now - t.born >= o.persistence * 0.25);
            if o.persistence > 0.0 && due {
                state.trails.push_back(Trail { born: now, traces });
                while state.trails.front().map_or(false, |t| now - t.born > o.persistence) || state.trails.len() > 10 {
                    state.trails.pop_front();
                }
            }

            // Readouts.
            if xy {
                label(&painter, pos2(rect.min.x + 8.0, rect.min.y + 6.0), Align2::LEFT_TOP, format!("corr {:+.2}", out.correlation), LABEL);
                draw_correlation_bar(&painter, Rect::from_min_size(pos2(rect.min.x + 8.0, rect.max.y - 14.0), vec2(rect.width() - 16.0, 5.0)), out.correlation);
            } else {
                let status = if o.trigger { if out.triggered { "TRIG" } else { "FREE" } } else { "AUTO" };
                let status_color = if out.triggered { o.color } else { LABEL };
                label(&painter, pos2(rect.max.x - 8.0, rect.min.y + 6.0), Align2::RIGHT_TOP, status, status_color);
                if let Some(f) = out.frequency_hz {
                    label(&painter, pos2(rect.min.x + 8.0, rect.min.y + 6.0), Align2::LEFT_TOP, format_hz(f), Color32::from_gray(200));
                }
                let ms_per_div = window as f32 / o.sample_rate * 1000.0 / 10.0;
                label(&painter, pos2(rect.min.x + 8.0, rect.max.y - 5.0), Align2::LEFT_BOTTOM, format!("{ms_per_div:.2} ms/div"), LABEL);
                // Trigger level marker on the left edge.
                if o.trigger {
                    let y = plot.center().y - (o.trigger_level * o.gain).clamp(-1.0, 1.0) * plot.height() * 0.5;
                    let tri = [pos2(plot.min.x, y - 4.0), pos2(plot.min.x + 6.0, y), pos2(plot.min.x, y + 4.0)];
                    painter.add(shape::Shape::convex_polygon(tri.to_vec(), with_alpha(status_color, 0.9), Stroke::NONE));
                }
            }
        } else {
            label(&painter, rect.center(), Align2::CENTER_CENTER, "no signal source", LABEL);
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, state));
        out
    }
}

fn draw_scope_graticule(painter: &Painter, plot: Rect, square: Rect, xy: bool, gain: f32) {
    let clip = painter.with_clip_rect(plot);
    if xy {
        let c = square.center();
        let r = square.width() * 0.5;
        for k in [0.5f32, 1.0] {
            clip.circle_stroke(c, r * k, Stroke::new(1.0, if k == 1.0 { GRID_MAJOR } else { GRID_MINOR }));
        }
        clip.line_segment([pos2(c.x, c.y - r), pos2(c.x, c.y + r)], Stroke::new(1.0, GRID_MAJOR));
        clip.line_segment([pos2(c.x - r, c.y), pos2(c.x + r, c.y)], Stroke::new(1.0, GRID_MINOR));
        // Pure-left and pure-right diagonals.
        clip.line_segment([pos2(c.x - r * 0.5, c.y - r * 0.5), pos2(c.x + r * 0.5, c.y + r * 0.5)], Stroke::new(1.0, GRID_MINOR));
        clip.line_segment([pos2(c.x + r * 0.5, c.y - r * 0.5), pos2(c.x - r * 0.5, c.y + r * 0.5)], Stroke::new(1.0, GRID_MINOR));
        label(painter, pos2(c.x - r * 0.5 - 3.0, c.y - r * 0.5 - 3.0), Align2::RIGHT_BOTTOM, "L", LABEL);
        label(painter, pos2(c.x + r * 0.5 + 3.0, c.y - r * 0.5 - 3.0), Align2::LEFT_BOTTOM, "R", LABEL);
        label(painter, pos2(c.x, c.y - r - 2.0), Align2::CENTER_BOTTOM, "M", LABEL);
        return;
    }
    for i in 0..=10 {
        let x = plot.min.x + plot.width() * i as f32 / 10.0;
        clip.line_segment([pos2(x, plot.min.y), pos2(x, plot.max.y)], Stroke::new(1.0, if i == 5 { GRID_MAJOR } else { GRID_MINOR }));
    }
    for i in 0..=8 {
        let y = plot.min.y + plot.height() * i as f32 / 8.0;
        clip.line_segment([pos2(plot.min.x, y), pos2(plot.max.x, y)], Stroke::new(1.0, if i == 4 { GRID_MAJOR } else { GRID_MINOR }));
    }
    // Fine ticks along the centre axes, five per division.
    let cy = plot.center().y;
    for i in 0..=50 {
        let x = plot.min.x + plot.width() * i as f32 / 50.0;
        let len = if i % 5 == 0 { 4.0 } else { 2.0 };
        clip.line_segment([pos2(x, cy - len), pos2(x, cy + len)], Stroke::new(1.0, GRID_MAJOR));
    }
    let top = 1.0 / gain.max(1.0e-3);
    label(painter, pos2(plot.max.x - 4.0, plot.min.y + 2.0), Align2::RIGHT_TOP, format!("+{top:.1}"), LABEL);
    label(painter, pos2(plot.max.x - 4.0, plot.max.y - 2.0), Align2::RIGHT_BOTTOM, format!("-{top:.1}"), LABEL);
}

fn draw_correlation_bar(painter: &Painter, rect: Rect, corr: f32) {
    painter.rect_filled(rect, 2u8, Color32::from_white_alpha(14));
    let mid = rect.center().x;
    let x = mid + corr.clamp(-1.0, 1.0) * rect.width() * 0.5;
    let color = if corr >= 0.0 { Color32::from_rgb(70, 214, 130) } else { Color32::from_rgb(255, 96, 96) };
    painter.rect_filled(Rect::from_min_max(pos2(mid.min(x), rect.min.y), pos2(mid.max(x), rect.max.y)), 2u8, with_alpha(color, 0.85));
    painter.line_segment([pos2(mid, rect.min.y - 2.0), pos2(mid, rect.max.y + 2.0)], Stroke::new(1.0, GRID_MAJOR));
}

// ------------------------------------------------------------------------------------------
// Spectrum
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpectrumStyle {
    /// A smooth filled curve with a bright outline.
    Filled,
    /// Log-spaced bands drawn as bars, `bands_per_octave` to the octave.
    Bars,
}

#[derive(Clone, Debug)]
pub struct SpectrumOptions {
    pub style: SpectrumStyle,
    pub height: f32,
    pub min_db: f32,
    pub max_db: f32,
    pub min_hz: f32,
    pub max_hz: f32,
    pub bands_per_octave: u32,
    /// Time constant (seconds) for a level rising on screen; a fall is at a fixed rate instead,
    /// `fall_db_per_s`, because an exponential fall in dB toward the -120 dB floor starts at
    /// several hundred dB per second and a release would be over before it could be seen.
    pub attack: f32,
    pub fall_db_per_s: f32,
    pub peak_hold: bool,
    /// Seconds a peak marker holds before it falls, and how fast (dB per second) it then falls.
    pub peak_hold_time: f32,
    pub peak_fall_db_per_s: f32,
    /// Display tilt in dB per octave about 1 kHz. 4.5 makes pink noise look flat; 0 is honest.
    pub tilt_db_per_octave: f32,
    pub color: Color32,
    /// Fixed width in points; `None` fills the width left in the layout.
    pub width: Option<f32>,
}

impl Default for SpectrumOptions {
    fn default() -> Self {
        Self {
            style: SpectrumStyle::Filled,
            height: 180.0,
            min_db: -90.0,
            max_db: 0.0,
            min_hz: 20.0,
            max_hz: 20_000.0,
            bands_per_octave: 3,
            attack: 0.015,
            fall_db_per_s: 48.0,
            peak_hold: true,
            peak_hold_time: 1.1,
            peak_fall_db_per_s: 18.0,
            tilt_db_per_octave: 0.0,
            color: ACCENT,
            width: None,
        }
    }
}

#[derive(Default)]
struct SpectrumState {
    smoothed: Vec<f32>,
    peaks: Vec<f32>,
    peak_age: Vec<f32>,
    last_time: Option<f32>,
}

#[derive(Clone, Copy, Debug)]
pub struct SpectrumHover {
    pub hz: f32,
    pub db: f32,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SpectrumResponse {
    pub rect: Rect,
    /// Where the curve is drawn: x maps `min_hz..max_hz` logarithmically, y maps `max_db` (top) to `min_db`.
    pub plot: Rect,
    pub hover: Option<SpectrumHover>,
}

pub struct SpectrumView {
    id: Id,
    opts: SpectrumOptions,
}

impl SpectrumView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("spectrum_view").with(id_salt), opts: SpectrumOptions::default() }
    }

    pub fn options(mut self, opts: SpectrumOptions) -> Self {
        self.opts = opts;
        self
    }

    /// `bins_db[k]` is the level at `k * sample_rate / (2 * (bins_db.len() - 1))` Hz, in dBFS.
    pub fn show(self, ui: &mut Ui, bins_db: &[f32], sample_rate: f32) -> SpectrumResponse {
        let ctx = ui.ctx().clone();
        let o = self.opts;
        let width = o.width.unwrap_or_else(|| ui.available_size().x.max(160.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, o.height), Sense::hover());
        let rect = resp.rect;
        panel(&painter, rect);
        // Room on the left for dB labels and below for Hz labels.
        let plot = Rect::from_min_max(pos2(rect.min.x + 30.0, rect.min.y + 8.0), pos2(rect.max.x - 8.0, rect.max.y - 16.0));
        let clip = painter.with_clip_rect(plot.expand(1.0));
        let now = ctx.time();
        let mut state: SpectrumState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let dt = state.last_time.map_or(0.0, |t| (now - t).clamp(0.0, 0.25));
        state.last_time = Some(now);

        // Grid: every 12 dB, and the 1-2-5 frequencies with the decades stronger.
        let mut db = o.max_db;
        while db >= o.min_db - 0.01 {
            let y = plot.max.y - db_to_frac(db, o.min_db, o.max_db) * plot.height();
            clip.line_segment([pos2(plot.min.x, y), pos2(plot.max.x, y)], Stroke::new(1.0, if db == 0.0 { GRID_MAJOR } else { GRID_MINOR }));
            label(&painter, pos2(plot.min.x - 4.0, y), Align2::RIGHT_CENTER, format!("{db:.0}"), LABEL);
            db -= 12.0;
        }
        let mut decade = 10.0f32;
        while decade <= o.max_hz {
            for m in [1.0f32, 2.0, 5.0] {
                let hz = decade * m;
                if hz < o.min_hz || hz > o.max_hz {
                    continue;
                }
                let x = plot.min.x + hz_to_frac(hz, o.min_hz, o.max_hz) * plot.width();
                let major = m == 1.0 && matches!(hz as u32, 100 | 1000 | 10_000);
                clip.line_segment([pos2(x, plot.min.y), pos2(x, plot.max.y)], Stroke::new(1.0, if major { GRID_MAJOR } else { GRID_MINOR }));
                if m == 1.0 || m == 5.0 || hz == 20.0 {
                    let text = if hz >= 1000.0 { format!("{}k", hz / 1000.0) } else { format!("{hz}") };
                    label(&painter, pos2(x, rect.max.y - 3.0), Align2::CENTER_BOTTOM, text, LABEL);
                }
            }
            decade *= 10.0;
        }

        if bins_db.len() < 2 {
            label(&painter, rect.center(), Align2::CENTER_CENTER, "no signal source", LABEL);
            ctx.memory_mut(|m| m.put_view_state(self.id, state));
            return SpectrumResponse { rect, plot, hover: None };
        }

        let bin_hz = sample_rate / (2.0 * (bins_db.len() - 1) as f32);
        let w = plot.width().max(2.0) as usize;
        // Cells are columns for the filled curve, log bands for bars; both are then smoothed alike.
        let (mut values, centers): (Vec<f32>, Vec<f32>) = match o.style {
            SpectrumStyle::Filled => {
                let v = spectrum_columns(bins_db, bin_hz, w, o.min_hz, o.max_hz);
                let c = (0..w).map(|i| frac_to_hz((i as f32 + 0.5) / w as f32, o.min_hz, o.max_hz)).collect();
                (v, c)
            }
            SpectrumStyle::Bars => {
                let bpo = o.bands_per_octave.max(1) as f32;
                let count = ((o.max_hz / o.min_hz).log2() * bpo).ceil() as usize;
                let edge = |i: usize| o.min_hz * 2.0f32.powf(i as f32 / bpo);
                let v = (0..count).map(|i| pool_range(bins_db, bin_hz, edge(i), edge(i + 1).min(o.max_hz))).collect();
                let c = (0..count).map(|i| (edge(i) * edge(i + 1)).sqrt()).collect();
                (v, c)
            }
        };
        let tilt = |hz: f32| o.tilt_db_per_octave * (hz / 1000.0).log2();
        for (v, c) in values.iter_mut().zip(&centers) {
            *v += tilt(*c);
        }

        if state.smoothed.len() != values.len() {
            state.smoothed = values.clone();
            state.peaks = values.clone();
            state.peak_age = vec![0.0; values.len()];
        } else {
            let up = 1.0 - (-dt / o.attack.max(1.0e-3)).exp();
            for i in 0..values.len() {
                let s = state.smoothed[i];
                state.smoothed[i] = if values[i] > s { s + (values[i] - s) * up } else { (s - o.fall_db_per_s * dt).max(values[i]) };
                if state.smoothed[i] >= state.peaks[i] {
                    state.peaks[i] = state.smoothed[i];
                    state.peak_age[i] = 0.0;
                } else {
                    state.peak_age[i] += dt;
                    if state.peak_age[i] > o.peak_hold_time {
                        state.peaks[i] = (state.peaks[i] - o.peak_fall_db_per_s * dt).max(state.smoothed[i]);
                    }
                }
            }
        }

        let level_y = |db: f32| plot.max.y - db_to_frac(db, o.min_db, o.max_db) * plot.height();
        let level_color = |db: f32| o.color.lerp(HOT, db_to_frac(db, o.min_db, o.max_db).powi(3));
        match o.style {
            SpectrumStyle::Filled => {
                let pts: Vec<Pos2> = state.smoothed.iter().enumerate().map(|(i, v)| pos2(plot.min.x + i as f32 + 0.5, level_y(*v))).collect();
                let tops: Vec<Color32> = state.smoothed.iter().map(|v| with_alpha(level_color(*v), 0.72)).collect();
                gradient_strip(&clip, &pts, &tops, plot.max.y, with_alpha(o.color, 0.03));
                // A faint hairline everywhere, so the floor reads as an axis; the bright glowing
                // outline only where there is actually signal above it.
                polyline(&clip, &pts, 1.0, with_alpha(o.color, 0.28));
                let above: Vec<bool> = state.smoothed.iter().map(|v| *v > o.min_db + 1.5).collect();
                for (a, b) in active_runs(&above) {
                    glow_polyline(&clip, &pts[a..b], 3.5, with_alpha(o.color, 0.16));
                    polyline(&clip, &pts[a..b], 1.4, o.color.lerp(Color32::WHITE, 0.3));
                }
                if o.peak_hold {
                    let peaks: Vec<Pos2> = state.peaks.iter().enumerate().map(|(i, v)| pos2(plot.min.x + i as f32 + 0.5, level_y(*v))).collect();
                    let held: Vec<bool> = state.peaks.iter().map(|v| *v > o.min_db + 1.5).collect();
                    for (a, b) in active_runs(&held) {
                        polyline(&clip, &peaks[a..b], 1.0, with_alpha(Color32::WHITE, 0.4));
                    }
                }
            }
            SpectrumStyle::Bars => {
                let count = state.smoothed.len();
                let slot = plot.width() / count as f32;
                for i in 0..count {
                    let x0 = plot.min.x + i as f32 * slot + slot * 0.12;
                    let x1 = plot.min.x + (i + 1) as f32 * slot - slot * 0.12;
                    let top = level_y(state.smoothed[i]);
                    let bar = Rect::from_min_max(pos2(x0, top), pos2(x1, plot.max.y));
                    if bar.height() > 0.5 {
                        clip.rect_filled_gradient(bar, level_color(state.smoothed[i]), level_color(state.smoothed[i]), with_alpha(o.color, 0.25), with_alpha(o.color, 0.25));
                    }
                    if o.peak_hold && state.peaks[i] > o.min_db + 1.5 {
                        let y = level_y(state.peaks[i]);
                        clip.rect_filled(Rect::from_min_max(pos2(x0, y - 1.0), pos2(x1, y + 1.0)), 0u8, with_alpha(Color32::WHITE, 0.75));
                    }
                }
            }
        }

        // Hover readout: a crosshair, a dot on the curve, and "1.00 kHz  -23.4 dB  C6 +12c".
        let mut hover = None;
        let hover_id = self.id.with("hover");
        let hr = interact(&ctx, plot, hover_id, Sense::hover());
        let pointer = ctx.input(|i| i.pointer.hover_pos());
        if let (true, Some(p)) = (hr.hovered(), pointer) {
            if plot.contains(p) {
                let frac = (p.x - plot.min.x) / plot.width();
                let hz = frac_to_hz(frac, o.min_hz, o.max_hz);
                let cell = match o.style {
                    SpectrumStyle::Filled => ((p.x - plot.min.x) as usize).min(state.smoothed.len() - 1),
                    SpectrumStyle::Bars => ((frac * state.smoothed.len() as f32) as usize).min(state.smoothed.len() - 1),
                };
                let shown = state.smoothed[cell];
                let db = shown - tilt(centers[cell]);
                hover = Some(SpectrumHover { hz, db });
                painter.line_segment([pos2(p.x, plot.min.y), pos2(p.x, plot.max.y)], Stroke::new(1.0, Color32::from_white_alpha(70)));
                painter.circle_filled(pos2(p.x, level_y(shown)), 3.0, Color32::WHITE);
                let note = note_name(hz).map(|(n, c)| format!("   {n} {c:+}c")).unwrap_or_default();
                let text = format!("{}   {:.1} dB{}", format_hz(hz), db, note);
                let approx_w = text.len() as f32 * 5.6 + 12.0;
                let tag_x = if p.x + 10.0 + approx_w > plot.max.x { p.x - 10.0 - approx_w } else { p.x + 10.0 };
                let tag = Rect::from_min_size(pos2(tag_x.max(plot.min.x), plot.min.y + 4.0), vec2(approx_w, 17.0));
                painter.rect_filled(tag, 3u8, Color32::from_rgba_unmultiplied(8, 10, 14, 220));
                painter.text(pos2(tag.min.x + 6.0, tag.center().y), Align2::LEFT_CENTER, text, FontId::proportional(10.5), Color32::from_gray(225));
            }
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, state));
        SpectrumResponse { rect, plot, hover }
    }
}

// ------------------------------------------------------------------------------------------
// Level meter
// ------------------------------------------------------------------------------------------

/// What the meter is told each frame: linear peak and RMS per channel since the previous frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct MeterReading {
    pub peak: [f32; 2],
    pub rms: [f32; 2],
}

#[derive(Clone, Debug)]
pub struct MeterOptions {
    pub width: f32,
    pub height: f32,
    pub min_db: f32,
    pub max_db: f32,
    /// Seconds a peak tick holds, then how fast (dB per second) both it and the bar fall.
    pub hold_time: f32,
    pub fall_db_per_s: f32,
    pub show_scale: bool,
}

impl Default for MeterOptions {
    fn default() -> Self {
        Self { width: 36.0, height: 120.0, min_db: -60.0, max_db: 3.0, hold_time: 1.4, fall_db_per_s: 26.0, show_scale: false }
    }
}

#[derive(Default)]
struct MeterState {
    level: [f32; 2],
    rms: [f32; 2],
    hold: [f32; 2],
    hold_age: [f32; 2],
    clipped: [bool; 2],
    last_time: Option<f32>,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct MeterResponse {
    pub rect: Rect,
    /// The two bar columns, left channel first. Their shared top and bottom edges are `max_db`
    /// and `min_db`.
    pub columns: [Rect; 2],
    /// Which channels are latched as having clipped (peak at or above full scale).
    pub clipped: [bool; 2],
    /// True on the frame the user clicked the meter to clear the clip latches.
    pub cleared: bool,
}

pub struct LevelMeter {
    id: Id,
    opts: MeterOptions,
}

/// Green through amber to red, by level.
pub fn meter_color(db: f32) -> Color32 {
    let stops: [(f32, Color32); 5] = [
        (-60.0, Color32::from_rgb(40, 176, 132)),
        (-20.0, Color32::from_rgb(64, 214, 122)),
        (-9.0, Color32::from_rgb(232, 214, 74)),
        (-3.0, Color32::from_rgb(255, 154, 60)),
        (0.0, Color32::from_rgb(255, 72, 72)),
    ];
    if db <= stops[0].0 {
        return stops[0].1;
    }
    for w in stops.windows(2) {
        if db <= w[1].0 {
            return w[0].1.lerp(w[1].1, (db - w[0].0) / (w[1].0 - w[0].0));
        }
    }
    stops[4].1
}

impl LevelMeter {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("level_meter").with(id_salt), opts: MeterOptions::default() }
    }

    pub fn options(mut self, opts: MeterOptions) -> Self {
        self.opts = opts;
        self
    }

    pub fn show(self, ui: &mut Ui, reading: MeterReading) -> MeterResponse {
        let ctx = ui.ctx().clone();
        let o = self.opts;
        let scale_w = if o.show_scale { 22.0 } else { 0.0 };
        let (resp, painter) = ui.allocate_painter(vec2(o.width + scale_w, o.height), Sense::click());
        let rect = resp.rect;
        let now = ctx.time();
        let mut st: MeterState = ctx.memory_mut(|m| m.take_view_state(self.id));
        if st.last_time.is_none() {
            // A meter that has heard nothing yet is at the bottom of its scale, not at 0 dBFS
            // (the `Default` of an f32): starting there drew a full-scale bar that then drained
            // at the fall rate for a couple of seconds after every open.
            st.level = [-120.0; 2];
            st.rms = [-120.0; 2];
            st.hold = [-120.0; 2];
        }
        let dt = st.last_time.map_or(0.0, |t| (now - t).clamp(0.0, 0.25));
        st.last_time = Some(now);

        let cleared = resp.clicked();
        if cleared {
            st.clipped = [false; 2];
        }

        // LED strip on top, bars below.
        let led_h = 5.0;
        let bars = Rect::from_min_max(pos2(rect.min.x + scale_w, rect.min.y + led_h + 3.0), rect.max);
        let bar_w = ((bars.width() - 3.0) / 2.0).floor().max(4.0);
        let rms_tau = 0.3;
        let mut columns = [Rect::from_min_size(bars.min, vec2(bar_w, bars.height())); 2];
        for ch in 0..2 {
            let db = crate::audio::analysis::to_db(reading.peak[ch]);
            // Instant attack, fixed-rate fall: a 10 ms transient stays readable.
            st.level[ch] = if db >= st.level[ch] { db } else { (st.level[ch] - o.fall_db_per_s * dt).max(db).max(o.min_db - 6.0) };
            if db >= st.hold[ch] {
                st.hold[ch] = db;
                st.hold_age[ch] = 0.0;
            } else {
                st.hold_age[ch] += dt;
                if st.hold_age[ch] > o.hold_time {
                    st.hold[ch] = (st.hold[ch] - o.fall_db_per_s * dt).max(st.level[ch]);
                }
            }
            let rms_db = crate::audio::analysis::to_db(reading.rms[ch]);
            let k = 1.0 - (-dt / rms_tau).exp();
            st.rms[ch] += (rms_db - st.rms[ch]) * if dt == 0.0 { 1.0 } else { k };
            if reading.peak[ch] >= 1.0 {
                st.clipped[ch] = true;
            }

            let x0 = bars.min.x + ch as f32 * (bar_w + 3.0);
            let col = Rect::from_min_size(pos2(x0, bars.min.y), vec2(bar_w, bars.height()));
            columns[ch] = col;
            painter.rect_filled(col, 2u8, Color32::from_white_alpha(12));
            let y_of = |d: f32| col.max.y - db_to_frac(d, o.min_db, o.max_db) * col.height();

            // Filled in segments so the gradient follows the level scale, not the bar height.
            let top = st.level[ch].clamp(o.min_db, o.max_db);
            let seg_edges = [o.min_db, -20.0, -9.0, -3.0, 0.0, o.max_db];
            for w in seg_edges.windows(2) {
                let (a, b) = (w[0], w[1].min(top));
                if b > a {
                    painter.rect_filled_gradient(Rect::from_min_max(pos2(col.min.x, y_of(b)), pos2(col.max.x, y_of(a))), meter_color(b), meter_color(b), meter_color(a), meter_color(a));
                }
            }
            // RMS: a brighter narrow core down the middle of the bar.
            let rms_top = st.rms[ch].clamp(o.min_db, o.max_db);
            if rms_top > o.min_db {
                let core = Rect::from_min_max(pos2(col.center().x - 1.5, y_of(rms_top)), pos2(col.center().x + 1.5, col.max.y));
                painter.rect_filled(core, 1u8, Color32::from_white_alpha(120));
            }
            // Peak-hold tick.
            if st.hold[ch] > o.min_db {
                let y = y_of(st.hold[ch].clamp(o.min_db, o.max_db));
                painter.rect_filled(Rect::from_min_max(pos2(col.min.x, y - 1.0), pos2(col.max.x, y + 1.0)), 0u8, meter_color(st.hold[ch]).lerp(Color32::WHITE, 0.4));
            }
            // Clip LED.
            let led = Rect::from_min_size(pos2(x0, rect.min.y), vec2(bar_w, led_h));
            painter.rect_filled(led, 2u8, if st.clipped[ch] { Color32::from_rgb(255, 60, 60) } else { Color32::from_white_alpha(16) });
        }

        if o.show_scale {
            let ticks = [0.0f32, -6.0, -12.0, -24.0, -48.0];
            for d in ticks {
                if d < o.min_db || d > o.max_db {
                    continue;
                }
                let y = bars.max.y - db_to_frac(d, o.min_db, o.max_db) * bars.height();
                label(&painter, pos2(rect.min.x + scale_w - 4.0, y), Align2::RIGHT_CENTER, format!("{d:.0}"), LABEL);
            }
        }

        let out = MeterResponse { rect, columns, clipped: st.clipped, cleared };
        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, frames: usize, phase: f32, sr: f32) -> Vec<f32> {
        (0..frames).map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr + phase).sin()).collect()
    }

    #[test]
    fn note_names_and_cents() {
        assert_eq!(note_name(440.0), Some(("A4".into(), 0)));
        assert_eq!(note_name(261.63), Some(("C4".into(), 0)));
        assert_eq!(note_name(1046.5), Some(("C6".into(), 0)));
        let (n, c) = note_name(450.0).unwrap();
        assert_eq!(n, "A4");
        assert_eq!(c, 39, "450 Hz is 39 cents above A4");
        let (n, c) = note_name(430.0).unwrap();
        assert_eq!((n.as_str(), c), ("A4", -40), "430 Hz is 39.85 cents flat");
        assert_eq!(note_name(0.0), None);
    }

    #[test]
    fn hz_axis_round_trips_and_pins_the_ends() {
        assert_eq!(hz_to_frac(20.0, 20.0, 20_000.0), 0.0);
        assert!((hz_to_frac(20_000.0, 20.0, 20_000.0) - 1.0).abs() < 1e-6);
        assert!((hz_to_frac(632.4555, 20.0, 20_000.0) - 0.5).abs() < 1e-4, "the geometric mean is the middle");
        for hz in [25.0, 440.0, 3141.0] {
            assert!((frac_to_hz(hz_to_frac(hz, 20.0, 20_000.0), 20.0, 20_000.0) - hz).abs() < hz * 1e-4);
        }
    }

    #[test]
    fn the_trigger_finds_a_crossing_to_a_fraction_of_a_sample_at_any_phase() {
        let sr = 44_100.0;
        for phase in [0.0f32, 0.9, 2.1, 4.0, 5.9] {
            let s = sine(440.0, 3000, phase, sr);
            let t = find_trigger(&s, 0.0, 1024).expect("a 440 Hz sine has crossings");
            // The value of the underlying sine at the returned position must be ~0 and rising.
            let v = (2.0 * std::f32::consts::PI * 440.0 * t / sr + phase).sin();
            assert!(v.abs() < 0.01, "phase {phase}: sine is {v} at the trigger, index {t}");
            assert!(t.floor() as usize + 1024 <= s.len(), "the window must fit after the trigger");
        }
    }

    #[test]
    fn noise_around_the_level_does_not_trigger_repeatedly_but_a_real_edge_does() {
        let mut s = vec![0.0f32; 400];
        for (i, v) in s.iter_mut().enumerate() {
            *v = if i % 2 == 0 { 0.001 } else { -0.001 };
        }
        // Hysteresis is 5% of the peak, so a wobble of 0.001 around 0 is one crossing at most.
        assert!(rising_crossings(&s, 0.0, 0.05).len() <= 1);
        let mut edge = vec![-0.5f32; 100];
        edge.extend(vec![0.5f32; 100]);
        assert_eq!(rising_crossings(&edge, 0.0, 0.05).len(), 1);
    }

    #[test]
    fn a_short_buffer_or_silence_never_triggers() {
        assert_eq!(find_trigger(&[0.0; 100], 0.0, 1024), None);
        assert_eq!(find_trigger(&vec![0.0; 4000], 0.0, 1024), None);
    }

    #[test]
    fn frequency_is_estimated_for_a_pitch_and_refused_for_a_chord() {
        let sr = 44_100.0;
        let f = estimate_frequency(&sine(441.0, 4096, 0.3, sr), sr).unwrap();
        assert!((f - 441.0).abs() < 1.5, "{f}");
        let chord: Vec<f32> = sine(300.0, 4096, 0.0, sr).iter().zip(sine(470.0, 4096, 0.0, sr)).map(|(a, b)| a + b).collect();
        assert_eq!(estimate_frequency(&chord, sr), None, "two unrelated tones are not a pitch");
    }

    #[test]
    fn identical_channels_are_detected_and_a_difference_is_not_missed() {
        let s = sine(300.0, 500, 0.0, 44_100.0);
        assert!(channels_identical(&s, &s));
        let mut t = s.clone();
        t[250] += 0.01;
        assert!(!channels_identical(&s, &t));
        assert!(!channels_identical(&s, &s[..400]));
    }

    #[test]
    fn correlation_spans_minus_one_to_one() {
        let s = sine(300.0, 2000, 0.0, 44_100.0);
        let inv: Vec<f32> = s.iter().map(|v| -v).collect();
        let quad = sine(300.0, 2000, std::f32::consts::FRAC_PI_2, 44_100.0);
        assert!((phase_correlation(&s, &s) - 1.0).abs() < 1e-5);
        assert!((phase_correlation(&s, &inv) + 1.0).abs() < 1e-5);
        assert!(phase_correlation(&s, &quad).abs() < 0.02, "a quarter-cycle apart is uncorrelated");
        assert_eq!(phase_correlation(&[0.0; 10], &[0.0; 10]), 0.0);
    }

    #[test]
    fn a_narrow_treble_peak_survives_max_pooling_and_a_bass_peak_is_interpolated() {
        // 4096-point spectrum at 44.1 kHz: 10.77 Hz per bin. One hot bin near 12 kHz, one near 60 Hz.
        let bin_hz: f32 = 44_100.0 / 4096.0;
        let mut bins = vec![-100.0f32; 2049];
        let hot = (12_000.0 / bin_hz).round() as usize;
        bins[hot] = -6.0;
        bins[6] = -10.0;
        let cols = spectrum_columns(&bins, bin_hz, 600, 20.0, 20_000.0);
        let (top_col, top) = cols.iter().enumerate().fold((0, f32::MIN), |m, (i, v)| if *v > m.1 { (i, *v) } else { m });
        assert_eq!(top, -6.0, "pooling must keep the single hot bin at full height");
        let expect = (hz_to_frac(hot as f32 * bin_hz, 20.0, 20_000.0) * 600.0) as usize;
        assert!((top_col as i32 - expect as i32).abs() <= 1, "column {top_col}, expected {expect}");
        // The 60 Hz peak (bin 6 = 64.6 Hz) is spread across neighbouring columns by interpolation.
        let bass_col = (hz_to_frac(6.0 * bin_hz, 20.0, 20_000.0) * 600.0) as usize;
        let lit = (bass_col.saturating_sub(12)..bass_col + 12).filter(|c| cols[*c] > -60.0).count();
        assert!(lit >= 5, "interpolation should give the bass peak a shape, only {lit} columns lit");
    }

    #[test]
    fn interpolation_never_draws_a_level_the_fft_did_not_measure() {
        // A Hann-shaped lobe with its nulls, sampled at 10.77 Hz per bin: the worst case for
        // interpolating dB values directly.
        let bin_hz: f32 = 44_100.0 / 4096.0;
        let mut bins = vec![-110.0f32; 2049];
        bins[91] = -100.0;
        bins[92] = -13.0;
        bins[93] = -6.2;
        bins[94] = -12.0;
        bins[95] = -100.0;
        let mut worst = f32::MIN;
        let mut f = 950.0f32;
        while f < 1050.0 {
            worst = worst.max(pool_range(&bins, bin_hz, f, f + 0.5));
            f += 0.5;
        }
        assert!(worst <= -6.2 + 1.0e-3, "drew {worst} dB from data that peaks at -6.2");
        assert!(worst > -6.4, "and it should still reach the peak bin, got {worst}");
    }

    #[test]
    fn min_max_reduction_keeps_a_one_sample_spike() {
        let mut s = vec![0.0f32; 8192];
        s[4000] = 0.9;
        let pts = trace_points(&s, 0.0, 8192, 100, 1.0);
        assert!(pts.iter().any(|p| (p[1] - 0.9).abs() < 1e-6), "the spike must still be drawn");
        assert_eq!(pts.len(), 200);
        let dense = trace_points(&s, 0.0, 100, 400, 1.0);
        assert_eq!(dense.len(), 100, "a window narrower than the plot is drawn sample for sample");
    }

    #[test]
    fn meter_colours_run_green_to_red() {
        assert!(meter_color(-40.0).g() > meter_color(-40.0).r());
        assert!(meter_color(0.0).r() > 200 && meter_color(0.0).g() < 100);
        assert_eq!(meter_color(6.0), meter_color(0.0));
    }
}
