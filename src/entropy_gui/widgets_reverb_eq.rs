//! `ReverbEqView`: a track's reverb and EQ as one picture, drawn the same neon way as the wavetable
//! terrain. The reverb and EQ themselves are `audio::eq` and the bus's fundsp reverb; this widget
//! only shows them and hands back edits.
//!
//! One rect, two regions:
//!
//! * **Space.** A 3D room the size of the reverb's room, with a sound source and a listener in it.
//!   The direct path and the first reflections off every wall are drawn as rays with pulses
//!   running along them. The floor of the room is a waterfall: frequency across, time running
//!   back, level up. In **Decay** view the waterfall is the reverb's tail as it will sound, shaped
//!   by the EQ (the bus runs the EQ after the reverb): a long time is a long surface, damping pulls
//!   the treble down sooner than the bass, and a cut in the EQ is a valley running the whole way
//!   back. In **Live** view it is what the track is actually playing, scrolling back in time.
//!   Hidden lines are removed by painter's order with an opaque curtain under every ridge, as in
//!   `WavetableView`. Drag orbits, the wheel zooms.
//! * **EQ.** The six bands over the track's live spectrum on a log axis. Drag a node for frequency
//!   and gain, the wheel over it for Q (bandwidth, shelf slope or cut resonance), right-click or
//!   double-click to switch it on or off. The chips along the top do the same for a band without
//!   aiming at its node. The curve is `eq::response_db`, the maths the filters run.
//!
//! Like the other views, every piece of geometry a caller may want (node positions, pill and chip
//! rects, the projector) comes back in the response, so a test can aim at a node, not a pixel.

use std::collections::VecDeque;
use std::f32::consts::PI;

use crate::audio::eq::{self, BandKind, EqBand, EqParams, EQ_BANDS};
use crate::core::vertex::Vertex;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::widgets_analysis::{format_hz, frac_to_hz, hz_to_frac};

// ------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.026, 0.030, 0.068];
const BG_BOTTOM: [f32; 3] = [0.058, 0.046, 0.118];
const PANEL_TOP: Color32 = Color32::from_rgb(10, 12, 24);
const PANEL_BOTTOM: Color32 = Color32::from_rgb(17, 15, 34);
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.58, 0.45, 1.0];
const PINK: [f32; 3] = [1.0, 0.38, 0.66];
const AMBER: [f32; 3] = [1.0, 0.78, 0.36];
const WHITE: [f32; 3] = [1.0, 1.0, 1.0];
const LABEL: Color32 = Color32::from_rgb(120, 128, 156);
const LABEL_DIM: Color32 = Color32::from_rgb(88, 96, 124);
const LABEL_BRIGHT: Color32 = Color32::from_rgb(196, 204, 230);

/// One colour per band, low to high.
pub const BAND_COLORS: [[f32; 3]; EQ_BANDS] = [
    [1.00, 0.36, 0.46],
    [1.00, 0.66, 0.28],
    [0.78, 0.96, 0.36],
    [0.30, 0.92, 0.80],
    [0.36, 0.70, 1.00],
    [0.70, 0.50, 1.00],
];

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn rgba(c: [f32; 3], a: f32) -> [f32; 4] {
    [c[0], c[1], c[2], a.clamp(0.0, 1.0)]
}

fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
}

/// The waterfall's colour at `t` (0 front, 1 back): teal, through violet, to pink.
fn ramp(t: f32) -> [f32; 3] {
    if t < 0.5 { mix3(TEAL, VIOLET, t * 2.0) } else { mix3(VIOLET, PINK, (t - 0.5) * 2.0) }
}

fn bg_at(y_frac: f32) -> [f32; 3] {
    mix3(BG_TOP, BG_BOTTOM, y_frac)
}

// ------------------------------------------------------------------------------------------
// The reverb model the Decay view draws
// ------------------------------------------------------------------------------------------

/// The reverb settings, as the bus's reverb effect takes them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReverbSettings {
    /// Metres, 10..30.
    pub room_size: f32,
    /// Seconds to fall 60 dB.
    pub time: f32,
    /// High-frequency damping, 0..1.
    pub damping: f32,
    /// Wet level, 0..1.
    pub mix: f32,
}

impl Default for ReverbSettings {
    fn default() -> Self {
        Self { room_size: 10.0, time: 1.2, damping: 0.5, mix: 0.0 }
    }
}

impl ReverbSettings {
    pub fn clamped(self) -> Self {
        let f = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Self { room_size: f(self.room_size, 10.0, 30.0, 10.0), time: f(self.time, 0.05, 20.0, 1.2), damping: f(self.damping, 0.0, 1.0, 0.5), mix: f(self.mix, 0.0, 1.0, 0.0) }
    }

    /// 0 for the smallest room the reverb makes, 1 for the largest.
    pub fn size01(&self) -> f32 {
        ((self.room_size - 10.0) / 20.0).clamp(0.0, 1.0)
    }
}

/// The longest time the waterfall shows, seconds.
pub const T_MAX: f32 = 8.0;
/// The level at the waterfall's floor, dB.
pub const FLOOR_DB: f32 = -60.0;

/// Seconds for the tail to fall 60 dB at `hz`. Damping shortens the treble more the higher it goes;
/// the bass keeps the full time.
pub fn t60_at(r: &ReverbSettings, hz: f32) -> f32 {
    let x = (hz / 2000.0).powi(2);
    let treble = x / (1.0 + x);
    r.time.max(0.05) / (1.0 + r.damping.clamp(0.0, 1.0) * 3.2 * treble)
}

/// When the first reflections arrive, seconds: a bigger room takes longer to answer.
pub fn predelay(r: &ReverbSettings) -> f32 {
    0.012 + r.room_size.clamp(10.0, 30.0) * 0.0022
}

fn hash01(a: u32, b: u32) -> f32 {
    let mut h = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA77);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    (h & 0xFFFF) as f32 / 65_535.0
}

/// The reverb tail's level at `hz`, `t` seconds after a note, dB relative to a full-mix tail: the
/// build-up to the first reflections, their early spikes, then the damped decay. Before the EQ and
/// the mix (see `decay_level_db`).
pub fn tail_shape_db(r: &ReverbSettings, hz: f32, t: f32) -> f32 {
    let pre = predelay(r);
    let build = if t < pre {
        let u = (t / pre).clamp(0.0, 1.0);
        -36.0 * (1.0 - u * u * (3.0 - 2.0 * u))
    } else {
        0.0
    };
    let decay = -60.0 * (t - pre).max(0.0) / t60_at(r, hz);
    // Early reflections: a handful of spikes, sparse and loud at first and denser and softer as the
    // room fills in. A bigger room spreads them further apart.
    let mut early = 0.0f32;
    for (k, m) in [1.0f32, 1.28, 1.52, 1.9, 2.35, 2.9, 3.6].iter().enumerate() {
        let at = pre * m;
        let w = 0.004 + 0.0025 * k as f32;
        let d = (t - at) / w;
        early += (7.0 - k as f32 * 0.7) * (-d * d).exp();
    }
    // Diffuse grain: smooth value noise across frequency (a room's modes), fading as the tail
    // smooths out.
    let fx = hz_to_frac(hz, 20.0, 20_000.0) * 28.0;
    let (fi, ff) = (fx.floor() as u32, fx.fract());
    let ti = (t * 60.0) as u32;
    let ease = ff * ff * (3.0 - 2.0 * ff);
    let noise = hash01(fi, ti) * (1.0 - ease) + hash01(fi + 1, ti) * ease;
    let grain = (noise - 0.5) * 3.0 * (1.0 - (t / 1.2).min(1.0));
    build + decay + early + grain
}

/// The Decay view's level at (`hz`, `t`), dB: the tail's shape, raised or lowered by the EQ and the
/// mix. The bus runs the EQ after the reverb, so the EQ shapes the tail the whole way back.
pub fn decay_level_db(r: &ReverbSettings, eq: &EqParams, sr: f32, hz: f32, t: f32) -> f32 {
    let mix_db = if r.mix > 1.0e-3 { (20.0 * r.mix.log10()).max(FLOOR_DB) } else { FLOOR_DB };
    tail_shape_db(r, hz, t) + mix_db + eq::response_db(eq, hz, sr)
}

// ------------------------------------------------------------------------------------------
// 3D
// ------------------------------------------------------------------------------------------

pub type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt().max(1.0e-9);
    scale(a, 1.0 / l)
}
fn lerp3(a: V3, b: V3, t: f32) -> V3 {
    add(a, scale(sub(b, a), t))
}

/// Depth of the waterfall's stage. In the Decay view time runs toward the viewer, from the note at
/// the back (`-STAGE_D / 2`) to `T_MAX` at the front, the way a cumulative spectral decay plot is
/// drawn: every later, quieter slice stands in front of the louder one before it, so the whole tail
/// is in view. The Live view runs the other way, newest at the front.
pub const STAGE_D: f32 = 2.0;
/// World height of the 60 dB between the floor and a full-level tail.
pub const HEIGHT_SCALE: f32 = 0.70;

/// World x of a frequency: 20 Hz at -1, 20 kHz at 1.
pub fn world_x(hz: f32) -> f32 {
    -1.0 + 2.0 * hz_to_frac(hz, 20.0, 20_000.0)
}

/// World z of a time in the Decay view. The axis is square-root spaced, so the first half second,
/// where the early reflections and short tails live, gets room.
pub fn world_z(t: f32) -> f32 {
    -STAGE_D / 2.0 + STAGE_D * (t / T_MAX).clamp(0.0, 1.0).sqrt()
}

/// World height of a level.
pub fn world_y(db: f32) -> f32 {
    ((db - FLOOR_DB) / -FLOOR_DB).max(0.0) * HEIGHT_SCALE
}

/// Half-extents of the room (x, height, z) for a room size. The room always holds the stage.
pub fn room_extents(r: &ReverbSettings) -> V3 {
    let s = r.size01();
    [1.10 + 0.32 * s, 1.0 + 0.30 * s, STAGE_D / 2.0 + 0.12 + 0.30 * s]
}

/// An orbit camera around the middle of the room.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self { yaw: 0.55, pitch: 0.50, dist: 6.5, zoom: 1.0 }
    }
}

impl Camera {
    pub const PITCH_MIN: f32 = 0.06;
    pub const PITCH_MAX: f32 = 1.50;

    pub fn orbit(&mut self, dx: f32, dy: f32) {
        self.yaw += dx * 0.008;
        self.pitch = (self.pitch + dy * 0.008).clamp(Self::PITCH_MIN, Self::PITCH_MAX);
    }

    pub fn top_view() -> Self {
        Self { yaw: 0.0, pitch: Self::PITCH_MAX, ..Self::default() }
    }

    /// From the side, time running left to right: the tail's length at a glance.
    pub fn side_view() -> Self {
        Self { yaw: PI / 2.0, pitch: 0.12, ..Self::default() }
    }
}

/// A camera fitted to a rect.
#[derive(Clone, Copy, Debug)]
pub struct Projector {
    eye: V3,
    right: V3,
    up: V3,
    fwd: V3,
    focal: f32,
    shift: Pos2,
    /// The frequency axis is stretched by this much on screen, so a wide rect is filled.
    xs: f32,
    pub rect: Rect,
}

impl Projector {
    /// Fits a room with half-extents `room` to `avail`. The stage stays the same size in the world,
    /// so a bigger room shows as the waterfall shrinking inside it.
    pub fn new(cam: &Camera, avail: Rect, room: V3) -> Self {
        let (sy, cy) = cam.yaw.sin_cos();
        let (sp, cp) = cam.pitch.sin_cos();
        let eye = [cam.dist * cp * sy, cam.dist * sp + 0.45, cam.dist * cp * cy];
        let target = [0.0, 0.45, 0.0];
        let fwd = norm(sub(target, eye));
        let right = norm(cross(fwd, [0.0, 1.0, 0.0]));
        let up = cross(right, fwd);
        let mut p = Projector { eye, right, up, fwd, focal: 1.0, shift: pos2(0.0, 0.0), xs: 1.0, rect: avail };
        let big = room;
        let bounds = |p: &Projector| {
            let mut lo = pos2(f32::MAX, f32::MAX);
            let mut hi = pos2(f32::MIN, f32::MIN);
            for &x in &[-big[0], big[0]] {
                for &y in &[0.0, big[1]] {
                    for &z in &[-big[2], big[2]] {
                        if let Some((q, _)) = p.project_raw([x, y, z]) {
                            lo = pos2(lo.x.min(q.x), lo.y.min(q.y));
                            hi = pos2(hi.x.max(q.x), hi.y.max(q.y));
                        }
                    }
                }
            }
            (lo, hi)
        };
        let (lo, hi) = bounds(&p);
        let want = (avail.width() / avail.height().max(1.0)) / ((hi.x - lo.x).max(1.0e-3) / (hi.y - lo.y).max(1.0e-3));
        p.xs = (want * 0.9).clamp(1.0, 2.3);
        let (lo, hi) = bounds(&p);
        let (bw, bh) = ((hi.x - lo.x).max(1.0e-3), (hi.y - lo.y).max(1.0e-3));
        p.focal = (avail.width() / bw).min(avail.height() / bh) * cam.zoom.clamp(0.5, 2.8) * 1.04;
        p.shift = pos2(avail.center().x - (lo.x + hi.x) * 0.5 * p.focal, avail.center().y - (lo.y + hi.y) * 0.5 * p.focal);
        p
    }

    fn project_raw(&self, w: V3) -> Option<(Pos2, f32)> {
        let v = sub([w[0] * self.xs, w[1], w[2]], self.eye);
        let depth = dot(v, self.fwd);
        if depth < 0.05 {
            return None;
        }
        Some((pos2(dot(v, self.right) / depth * self.focal + self.shift.x, -dot(v, self.up) / depth * self.focal + self.shift.y), depth))
    }

    /// The pixel a world point lands on, and its distance along the view direction.
    pub fn project(&self, w: V3) -> Option<(Pos2, f32)> {
        self.project_raw(w)
    }

    pub fn depth(&self, w: V3) -> f32 {
        dot(sub([w[0] * self.xs, w[1], w[2]], self.eye), self.fwd)
    }

    fn pixel_scale(&self) -> f32 {
        (self.focal / 260.0).clamp(0.5, 2.5)
    }
}

// ------------------------------------------------------------------------------------------
// The EQ plot's axes
// ------------------------------------------------------------------------------------------

/// The EQ plot spans ±this many dB.
pub const EQ_DB_SPAN: f32 = 20.0;
/// The live spectrum under the curve spans this many dB below full scale.
pub const SPECTRUM_FLOOR_DB: f32 = -90.0;

/// The pixel for (hz, dB) in the EQ plot.
pub fn eq_point(plot: Rect, hz: f32, db: f32) -> Pos2 {
    pos2(plot.min.x + hz_to_frac(hz, 20.0, 20_000.0) * plot.width(), plot.center().y - (db / EQ_DB_SPAN).clamp(-1.2, 1.2) * plot.height() * 0.5)
}

/// The (hz, dB) under a pixel of the EQ plot.
pub fn eq_value(plot: Rect, p: Pos2) -> (f32, f32) {
    let hz = frac_to_hz(((p.x - plot.min.x) / plot.width().max(1.0)).clamp(0.0, 1.0), 20.0, 20_000.0);
    let db = (plot.center().y - p.y) / (plot.height() * 0.5).max(1.0) * EQ_DB_SPAN;
    (hz, db)
}

/// Where a band's node sits: at its frequency and gain, or for a cut, on its own curve at its
/// corner (about -3 dB), where it can be grabbed.
pub fn node_db(band: &EqBand, sr: f32) -> f32 {
    if band.kind.is_cut() {
        let b = EqBand { enabled: true, ..*band };
        eq::band_response_db(&b, band.freq, sr).clamp(-EQ_DB_SPAN, EQ_DB_SPAN)
    } else {
        band.gain_db
    }
}

pub fn band_short_name(kind: BandKind) -> &'static str {
    match kind {
        BandKind::LowCut => "Low cut",
        BandKind::LowShelf => "Low shelf",
        BandKind::Peak => "Bell",
        BandKind::HighShelf => "High shelf",
        BandKind::HighCut => "High cut",
    }
}

fn band_chip_label(kind: BandKind) -> &'static str {
    match kind {
        BandKind::LowCut => "LC",
        BandKind::LowShelf => "LS",
        BandKind::Peak => "BELL",
        BandKind::HighShelf => "HS",
        BandKind::HighCut => "HC",
    }
}

/// A band after the wheel turned `notches` over it: Q grows or shrinks by a fixed ratio per notch.
pub fn wheel_q(band: &EqBand, notches: f32) -> EqBand {
    let q = (band.q * (notches * 0.12).exp()).clamp(eq::MIN_Q, eq::MAX_Q);
    EqBand { q, ..*band }
}

// ------------------------------------------------------------------------------------------
// Options, events, response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpaceView {
    /// The reverb's tail as it will sound.
    Decay,
    /// What the track is playing, scrolling back in time.
    Live,
}

impl SpaceView {
    pub fn name(self) -> &'static str {
        match self {
            SpaceView::Decay => "decay",
            SpaceView::Live => "live",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "decay" => Some(SpaceView::Decay),
            "live" => Some(SpaceView::Live),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ReverbEqOptions {
    pub width: Option<f32>,
    pub height: f32,
    pub reverb: ReverbSettings,
    pub eq: EqParams,
    pub selected: Option<usize>,
    pub view: SpaceView,
    /// The track's live spectrum (dB per FFT bin, DC first) and its sample rate. Empty when there
    /// is nothing to show.
    pub spectrum_db: Vec<f32>,
    pub sample_rate: f32,
    /// A caption along the bottom of the space, e.g. the track's name.
    pub caption: Option<String>,
}

impl Default for ReverbEqOptions {
    fn default() -> Self {
        Self {
            width: None,
            height: 620.0,
            reverb: ReverbSettings::default(),
            eq: EqParams::default(),
            selected: None,
            view: SpaceView::Decay,
            spectrum_db: Vec::new(),
            sample_rate: 48_000.0,
            caption: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ReverbEqEvent {
    /// A band's new settings (a node was dragged, the wheel turned over it, or it was switched).
    BandChanged { index: usize, band: EqBand },
    /// `None` when the selection was cleared.
    BandSelected(Option<usize>),
    /// A drag or a switch finished: a good moment to save.
    EditEnded,
    ViewSelected(SpaceView),
}

#[derive(Clone, Debug)]
pub struct ReverbEqResponse {
    pub rect: Rect,
    pub space: Rect,
    pub eq_area: Rect,
    /// The EQ plot inside `eq_area` (see `eq_point`).
    pub eq_plot: Rect,
    /// Each band's node, whether it is on or not.
    pub nodes: Vec<Pos2>,
    /// The band chips along the top of the EQ area.
    pub chips: Vec<Rect>,
    /// The space's buttons: (label, rect).
    pub pills: Vec<(String, Rect)>,
    pub projector: Projector,
    pub camera: Camera,
    pub events: Vec<ReverbEqEvent>,
    /// The band under the pointer, if any.
    pub hovered_band: Option<usize>,
}

// ------------------------------------------------------------------------------------------
// State kept between frames
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
enum Drag {
    Orbit,
    /// A node, with where in the node the pointer caught it (so the node does not jump).
    Node { index: usize, grab: (f32, f32), moved: bool },
}

/// Live spectra resampled onto the waterfall's frequency columns, newest first.
const LIVE_ROWS: usize = 40;
const COLS: usize = 96;

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
    history: VecDeque<Vec<f32>>,
    /// `Context::time` of the last history row.
    last_row_at: f32,
    /// The EQ plot's spectrum, smoothed with a fall rate (dB per column).
    spectrum: Vec<f32>,
    /// Loudness of the track right now, 0..1, smoothed: what the rays pulse with.
    energy: f32,
    /// The room's half-extents as drawn, gliding toward the reverb's room size.
    room: Option<V3>,
    /// The last press on a node: (band, time), for double-clicks.
    last_click: Option<(usize, f32)>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self { camera: Camera::default(), drag: None, last_pointer: None, history: VecDeque::new(), last_row_at: f32::MIN, spectrum: Vec::new(), energy: 0.0, room: None, last_click: None }
    }
}

/// A spectrum resampled onto `n` log-spaced columns from 20 Hz to 20 kHz. Wide columns take the
/// loudest bin they cover (so a narrow peak is never averaged away), narrow ones interpolate. A
/// gentle +3 dB/octave tilt around 1 kHz makes music, which falls toward the treble, read level.
pub fn resample_spectrum(bins_db: &[f32], sample_rate: f32, n: usize) -> Vec<f32> {
    if bins_db.len() < 4 || n == 0 {
        return vec![SPECTRUM_FLOOR_DB; n];
    }
    let bin_hz = sample_rate * 0.5 / (bins_db.len() - 1) as f32;
    let at = |hz: f32| {
        let b = (hz / bin_hz).clamp(0.0, (bins_db.len() - 1) as f32);
        let (i, f) = (b.floor() as usize, b.fract());
        let j = (i + 1).min(bins_db.len() - 1);
        bins_db[i] * (1.0 - f) + bins_db[j] * f
    };
    (0..n)
        .map(|c| {
            let lo = frac_to_hz(c as f32 / n as f32, 20.0, 20_000.0);
            let hi = frac_to_hz((c + 1) as f32 / n as f32, 20.0, 20_000.0);
            let centre = (lo * hi).sqrt();
            let (bl, bh) = ((lo / bin_hz).ceil() as usize, (hi / bin_hz).floor() as usize);
            let v = if bh > bl && bh < bins_db.len() { bins_db[bl..=bh].iter().cloned().fold(f32::MIN, f32::max) } else { at(centre) };
            let tilt = 3.0 * (centre / 1000.0).log2();
            (v + tilt).max(SPECTRUM_FLOOR_DB)
        })
        .collect()
}

// ------------------------------------------------------------------------------------------
// Drawing helpers
// ------------------------------------------------------------------------------------------

/// A stroke along `pts` as a triangle strip, coloured per point.
fn ribbon(painter: &Painter, pts: &[Pos2], width: f32, color_at: impl Fn(usize) -> [f32; 4]) {
    let n = pts.len();
    if n < 2 || width <= 0.0 {
        return;
    }
    let seg = |a: Pos2, b: Pos2| {
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let l = (dx * dx + dy * dy).sqrt().max(1.0e-6);
        (dx / l, dy / l)
    };
    let mut verts = Vec::with_capacity(n * 2);
    let mut idx = Vec::with_capacity(n * 6);
    let half = width * 0.5;
    for i in 0..n {
        let a = if i > 0 { seg(pts[i - 1], pts[i]) } else { seg(pts[0], pts[1]) };
        let b = if i + 1 < n { seg(pts[i], pts[i + 1]) } else { a };
        let (mut tx, mut ty) = (a.0 + b.0, a.1 + b.1);
        let tl = (tx * tx + ty * ty).sqrt();
        if tl < 1.0e-4 {
            tx = a.0;
            ty = a.1;
        } else {
            tx /= tl;
            ty /= tl;
        }
        let (nx, ny) = (-ty, tx);
        let m = 1.0 / (nx * -a.1 + ny * a.0).abs().max(0.55);
        let c = color_at(i);
        verts.push(Vertex::new(pts[i].x + nx * half * m, pts[i].y + ny * half * m, 0.0, c));
        verts.push(Vertex::new(pts[i].x - nx * half * m, pts[i].y - ny * half * m, 0.0, c));
        if i > 0 {
            let k = (i * 2) as u32;
            idx.extend([k - 2, k - 1, k, k - 1, k + 1, k]);
        }
    }
    painter.mesh(verts, idx);
}

/// The band between `top` and `bottom` (same length), coloured per column.
fn band(painter: &Painter, top: &[Pos2], bottom: &[Pos2], top_color: impl Fn(usize) -> [f32; 4], bottom_color: impl Fn(usize) -> [f32; 4]) {
    let n = top.len().min(bottom.len());
    if n < 2 {
        return;
    }
    let mut verts = Vec::with_capacity(n * 2);
    let mut idx = Vec::with_capacity(n * 6);
    for i in 0..n {
        verts.push(Vertex::new(top[i].x, top[i].y, 0.0, top_color(i)));
        verts.push(Vertex::new(bottom[i].x, bottom[i].y, 0.0, bottom_color(i)));
        if i > 0 {
            let k = (i * 2) as u32;
            idx.extend([k - 2, k - 1, k, k - 1, k + 1, k]);
        }
    }
    painter.mesh(verts, idx);
}

/// A glowing line: a wide faint ribbon under a narrow bright one.
fn neon(painter: &Painter, pts: &[Pos2], c: [f32; 3], alpha: f32, core: f32) {
    ribbon(painter, pts, core * 5.0, |_| rgba(c, 0.10 * alpha));
    ribbon(painter, pts, core * 2.4, |_| rgba(c, 0.22 * alpha));
    ribbon(painter, pts, core, |_| rgba(mix3(c, WHITE, 0.25), alpha));
}

fn glow_dot(painter: &Painter, p: Pos2, r: f32, c: [f32; 3], a: f32) {
    painter.circle_filled(p, r * 3.2, c32(c, 0.06 * a));
    painter.circle_filled(p, r * 1.9, c32(c, 0.16 * a));
    painter.circle_filled(p, r, c32(mix3(c, WHITE, 0.45), a));
}

fn text(painter: &Painter, p: Pos2, align: Align2, s: impl ToString, size: f32, color: Color32) -> Rect {
    painter.text(p, align, s, FontId::proportional(size), color)
}

fn pill(painter: &Painter, r: Rect, label: &str, active: bool, hot: bool, accent: [f32; 3]) {
    if active {
        painter.rect_filled(r.expand(3.0), 10u8, c32(accent, 0.16));
        painter.rect_filled(r, 8u8, c32(mix3(accent, VIOLET, 0.25), 0.92));
    } else {
        painter.rect_filled(r, 8u8, Color32::from_rgba_unmultiplied(20, 22, 42, if hot { 235 } else { 190 }));
        painter.rect_stroke(r, 8u8, Stroke::new(1.0, Color32::from_white_alpha(if hot { 70 } else { 34 })), StrokeKind::Middle);
    }
    let color = if active { Color32::from_rgb(8, 12, 24) } else { LABEL_BRIGHT };
    text(painter, r.center(), Align2::CENTER, label, 11.5, color);
}

// ------------------------------------------------------------------------------------------
// Layout
// ------------------------------------------------------------------------------------------

struct Layout {
    space: Rect,
    eq_area: Rect,
    eq_plot: Rect,
    /// The space's picture, clear of its toolbar and captions.
    stage: Rect,
}

fn layout(rect: Rect) -> Layout {
    let gap = 8.0;
    let eq_h = (rect.height() * 0.40).clamp(170.0, 300.0);
    let space = Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - eq_h - gap));
    let eq_area = Rect::from_min_max(pos2(rect.min.x, space.max.y + gap), rect.max);
    let eq_plot = Rect::from_min_max(pos2(eq_area.min.x + 40.0, eq_area.min.y + 40.0), pos2(eq_area.max.x - 14.0, eq_area.max.y - 22.0));
    let stage = Rect::from_min_max(pos2(space.min.x + 16.0, space.min.y + 44.0), pos2(space.max.x - 16.0, space.max.y - 26.0));
    Layout { space, eq_area, eq_plot, stage }
}

const VIEW_PILLS: [(SpaceView, &str); 2] = [(SpaceView::Decay, "Decay"), (SpaceView::Live, "Live")];
const CAMERA_PILLS: [&str; 3] = ["3D", "Top", "Side"];

fn pill_rects(ctx: &crate::entropy_gui::context::Context, space: Rect) -> Vec<(String, Rect)> {
    let h = 24.0;
    let top = space.min.y + 10.0;
    let mut out = Vec::new();
    let mut x = space.min.x + 12.0;
    for (_, label) in VIEW_PILLS {
        let w = Painter::measure_text(ctx, FontId::proportional(11.5), label).x + 22.0;
        out.push((label.to_string(), Rect::from_min_size(pos2(x, top), vec2(w, h))));
        x += w + 5.0;
    }
    x += 10.0;
    for label in CAMERA_PILLS {
        let w = Painter::measure_text(ctx, FontId::proportional(11.5), label).x + 16.0;
        out.push((label.to_string(), Rect::from_min_size(pos2(x, top), vec2(w, h))));
        x += w + 4.0;
    }
    out
}

fn chip_rects(ctx: &crate::entropy_gui::context::Context, eq_area: Rect, bands: &[EqBand; EQ_BANDS]) -> Vec<Rect> {
    let h = 22.0;
    let top = eq_area.min.y + 9.0;
    let mut x = eq_area.min.x + 40.0;
    bands
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let label = format!("{} {}", i + 1, band_chip_label(b.kind));
            let w = Painter::measure_text(ctx, FontId::proportional(10.5), &label).x + 26.0;
            let r = Rect::from_min_size(pos2(x, top), vec2(w, h));
            x += w + 5.0;
            r
        })
        .collect()
}

// ------------------------------------------------------------------------------------------
// The widget
// ------------------------------------------------------------------------------------------

pub struct ReverbEqView {
    id: Id,
    opts: ReverbEqOptions,
}

impl ReverbEqView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("reverb_eq_view").with(id_salt), opts: ReverbEqOptions::default() }
    }

    pub fn options(mut self, opts: ReverbEqOptions) -> Self {
        self.opts = opts;
        self
    }

    pub fn show(self, ui: &mut Ui) -> ReverbEqResponse {
        let ctx = ui.ctx().clone();
        let mut o = self.opts;
        o.reverb = o.reverb.clamped();
        o.eq = o.eq.clamped();
        let sr = if o.sample_rate > 1000.0 { o.sample_rate } else { 48_000.0 };
        let width = o.width.unwrap_or_else(|| ui.available_size().x.max(420.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, o.height.max(420.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let lay = layout(rect);

        let (pointer, scroll, mods) = ctx.input(|i| (i.pointer, i.scroll_delta.y, i.modifiers));
        let now = ctx.time();
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let mut events: Vec<ReverbEqEvent> = Vec::new();
        let pos = pointer.pos;
        let over = |r: Rect| pos.is_some_and(|p| r.contains(p));

        // --- the live signal: the waterfall's history, the plot's spectrum, the rays' energy ---
        let live = resample_spectrum(&o.spectrum_db, sr, COLS);
        let has_signal = !o.spectrum_db.is_empty();
        if now - st.last_row_at >= 1.0 / 30.0 || now < st.last_row_at {
            st.history.push_front(live.clone());
            st.history.truncate(LIVE_ROWS);
            st.last_row_at = now;
        }
        if st.spectrum.len() != COLS {
            st.spectrum = vec![SPECTRUM_FLOOR_DB; COLS];
        }
        let dt = ctx.input(|i| i.dt).clamp(0.0, 0.1);
        for (s, v) in st.spectrum.iter_mut().zip(&live) {
            // Rise at once, fall at 60 dB/s: peaks stay readable.
            *s = if *v > *s { *v } else { (*s - 60.0 * dt).max(*v) };
        }
        let loud = live.iter().map(|d| ((d - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB).clamp(0.0, 1.0)).fold(0.0f32, f32::max);
        let target_energy = ((loud - 0.35) / 0.55).clamp(0.0, 1.0);
        st.energy += (target_energy - st.energy) * if target_energy > st.energy { 0.5 } else { 0.08 };

        // --- geometry the pointer needs ---
        let pills = pill_rects(&ctx, lay.space);
        let chips = chip_rects(&ctx, lay.eq_area, &o.eq.bands);
        let nodes: Vec<Pos2> = o.eq.bands.iter().map(|b| eq_point(lay.eq_plot, b.freq, node_db(b, sr))).collect();
        let pill_under = pos.and_then(|p| pills.iter().find(|(_, r)| r.contains(p)).map(|(l, _)| l.clone()));
        let chip_under = pos.and_then(|p| chips.iter().position(|r| r.contains(p)));
        let node_under = pos.and_then(|p| {
            if !lay.eq_plot.expand(10.0).contains(p) {
                return None;
            }
            // The nearest node within reach; the selected one wins a tie, so a stacked pair can
            // still be pulled apart.
            let mut best: Option<(usize, f32)> = None;
            for (i, n) in nodes.iter().enumerate() {
                let d = ((n.x - p.x).powi(2) + (n.y - p.y).powi(2)).sqrt() - if o.selected == Some(i) { 2.0 } else { 0.0 };
                if d < 13.0 && best.is_none_or(|(_, bd)| d < bd) {
                    best = Some((i, d));
                }
            }
            best.map(|b| b.0)
        });

        let toggle = |events: &mut Vec<ReverbEqEvent>, i: usize| {
            let b = o.eq.bands[i];
            events.push(ReverbEqEvent::BandChanged { index: i, band: EqBand { enabled: !b.enabled, ..b } });
            events.push(ReverbEqEvent::EditEnded);
        };

        // --- start of a gesture ---
        if st.drag.is_none() && (pointer.primary_pressed || pointer.secondary_pressed) {
            if let Some(p) = pos {
                let primary = pointer.primary_pressed;
                if primary && pill_under.is_some() {
                    let label = pill_under.clone().unwrap_or_default();
                    match label.as_str() {
                        "3D" => st.camera = Camera { zoom: st.camera.zoom, ..Camera::default() },
                        "Top" => st.camera = Camera { zoom: st.camera.zoom, ..Camera::top_view() },
                        "Side" => st.camera = Camera { zoom: st.camera.zoom, ..Camera::side_view() },
                        other => {
                            if let Some((v, _)) = VIEW_PILLS.iter().find(|(_, l)| *l == other) {
                                events.push(ReverbEqEvent::ViewSelected(*v));
                            }
                        }
                    }
                } else if let Some(i) = chip_under {
                    if primary {
                        events.push(ReverbEqEvent::BandSelected(Some(i)));
                    } else {
                        toggle(&mut events, i);
                    }
                } else if let Some(i) = node_under {
                    if primary {
                        let double = st.last_click.is_some_and(|(j, t)| j == i && now - t < 0.35);
                        st.last_click = Some((i, now));
                        if o.selected != Some(i) {
                            events.push(ReverbEqEvent::BandSelected(Some(i)));
                        }
                        if double {
                            toggle(&mut events, i);
                            st.last_click = None;
                        } else {
                            let n = nodes[i];
                            st.drag = Some(Drag::Node { index: i, grab: (p.x - n.x, p.y - n.y), moved: false });
                        }
                    } else {
                        toggle(&mut events, i);
                    }
                } else if primary && lay.eq_plot.contains(p) && o.selected.is_some() {
                    events.push(ReverbEqEvent::BandSelected(None));
                } else if lay.space.contains(p) {
                    st.drag = Some(Drag::Orbit);
                }
            }
        }

        // --- an active gesture ---
        let still_down = pointer.primary_down || pointer.secondary_down;
        if let Some(drag) = st.drag {
            match drag {
                Drag::Orbit => {
                    if let (Some(p), Some(last)) = (pos, st.last_pointer) {
                        st.camera.orbit(p.x - last.x, p.y - last.y);
                    }
                }
                Drag::Node { index, grab, moved } => {
                    if let (Some(p), true) = (pos, still_down) {
                        let (hz, db) = eq_value(lay.eq_plot, pos2(p.x - grab.0, p.y - grab.1));
                        let b = o.eq.bands[index];
                        // Shift snaps the gain to half-decibels, for exact settings.
                        let gain = if b.kind.is_cut() { b.gain_db } else if mods.shift { (db * 2.0).round() / 2.0 } else { db };
                        let next = EqBand { enabled: true, freq: hz, gain_db: gain.clamp(-eq::MAX_GAIN_DB, eq::MAX_GAIN_DB), ..b }.clamped();
                        let changed = (next.freq - b.freq).abs() > 1.0e-3 * b.freq || (next.gain_db - b.gain_db).abs() > 1.0e-3 || next.enabled != b.enabled;
                        if changed {
                            events.push(ReverbEqEvent::BandChanged { index, band: next });
                            st.drag = Some(Drag::Node { index, grab, moved: true });
                        }
                    }
                    if !still_down && moved {
                        events.push(ReverbEqEvent::EditEnded);
                    }
                }
            }
            if !still_down {
                st.drag = None;
            }
        }
        st.last_pointer = pos;

        // --- the wheel: Q over a node (or anywhere in the plot for the selected band), zoom in space ---
        if scroll.abs() > 0.0 && st.drag.is_none() {
            if over(lay.eq_plot) {
                if let Some(i) = node_under.or(o.selected) {
                    let notches = (scroll / 50.0).clamp(-3.0, 3.0);
                    let next = wheel_q(&o.eq.bands[i], notches);
                    events.push(ReverbEqEvent::BandChanged { index: i, band: next });
                    events.push(ReverbEqEvent::EditEnded);
                }
            } else if over(lay.stage) {
                st.camera.zoom = (st.camera.zoom * (scroll * 0.0016).exp()).clamp(0.6, 2.4);
            }
        }

        // What the picture shows this frame already includes this frame's edits, so a drag never
        // lags a frame behind the pointer.
        let mut shown = o.eq;
        for e in &events {
            if let ReverbEqEvent::BandChanged { index, band } = e {
                shown.bands[*index] = *band;
            }
        }
        let selected = events.iter().rev().find_map(|e| if let ReverbEqEvent::BandSelected(s) = e { Some(*s) } else { None }).unwrap_or(o.selected);
        let nodes: Vec<Pos2> = shown.bands.iter().map(|b| eq_point(lay.eq_plot, b.freq, node_db(b, sr))).collect();
        let hovered_band = match st.drag {
            Some(Drag::Node { index, .. }) => Some(index),
            _ => node_under.or(chip_under),
        };

        // --- paint ---
        let want = room_extents(&o.reverb);
        let room = match st.room {
            Some(r) => {
                let k = 1.0 - (-dt * 10.0).exp();
                [r[0] + (want[0] - r[0]) * k, r[1] + (want[1] - r[1]) * k, r[2] + (want[2] - r[2]) * k]
            }
            None => want,
        };
        st.room = Some(room);
        let proj = Projector::new(&st.camera, lay.stage, room);
        draw_space(&painter, &lay, &proj, &o, &shown, sr, &st, now, has_signal);
        let view = events.iter().rev().find_map(|e| if let ReverbEqEvent::ViewSelected(v) = e { Some(*v) } else { None }).unwrap_or(o.view);
        for (label, r) in &pills {
            let active = VIEW_PILLS.iter().any(|(v, l)| l == label && *v == view);
            pill(&painter, *r, label, active, pill_under.as_deref() == Some(label.as_str()), TEAL);
        }
        draw_readout(&painter, lay.space, &o.reverb);
        draw_eq(&painter, &lay, &shown, sr, &st.spectrum, &nodes, &chips, selected, hovered_band, pos, has_signal);

        let camera = st.camera;
        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        ReverbEqResponse {
            rect,
            space: lay.space,
            eq_area: lay.eq_area,
            eq_plot: lay.eq_plot,
            nodes,
            chips,
            pills,
            projector: proj,
            camera,
            events,
            hovered_band,
        }
    }
}

// ------------------------------------------------------------------------------------------
// The space
// ------------------------------------------------------------------------------------------

struct Ridge {
    row: usize,
    depth: f32,
}

#[allow(clippy::too_many_arguments)]
fn draw_space(painter: &Painter, lay: &Layout, proj: &Projector, o: &ReverbEqOptions, eq_params: &EqParams, sr: f32, st: &ViewState, now: f32, has_signal: bool) {
    let rect = lay.space;
    let painter = painter.with_clip_rect(rect);
    painter.rect_filled_gradient(rect, c32(BG_TOP, 1.0), c32(BG_TOP, 1.0), c32(BG_BOTTOM, 1.0), c32(BG_BOTTOM, 1.0));
    painter.rect_stroke(rect, 6u8, Stroke::new(1.0, Color32::from_white_alpha(30)), StrokeKind::Middle);
    // A soft bloom behind the room.
    let bloom_c = pos2(rect.center().x, rect.min.y + rect.height() * 0.46);
    for i in 0..9 {
        let t = i as f32 / 8.0;
        painter.circle_filled(bloom_c, rect.width() * (0.10 + 0.32 * t), c32(mix3(VIOLET, TEAL, 0.3), 0.011 * (1.0 - t * 0.6)));
    }

    let r = o.reverb;
    let ext = st.room.unwrap_or_else(|| room_extents(&r));
    let (rx, ry, rz) = (ext[0], ext[1], ext[2]);
    let px = proj.pixel_scale();
    let centre_depth = proj.depth([0.0, 0.0, 0.0]);

    // The room's corners and edges. Edges behind the middle of the room are drawn first (the
    // waterfall hides them where it stands in front); the rest go on top of it.
    let corner = |i: usize| -> V3 { [if i & 1 == 0 { -rx } else { rx }, if i & 2 == 0 { 0.0 } else { ry }, if i & 4 == 0 { -rz } else { rz }] };
    let edges: [(usize, usize); 12] = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)];
    let edge_pts = |a: V3, b: V3| -> Vec<Pos2> { (0..=12).filter_map(|k| proj.project(lerp3(a, b, k as f32 / 12.0)).map(|p| p.0)).collect() };
    let draw_edge = |a: V3, b: V3, alpha: f32| {
        let pts = edge_pts(a, b);
        let mid = lerp3(a, b, 0.5);
        let fog = (1.0 - 0.45 * ((proj.depth(mid) - centre_depth) / (rx + rz)).clamp(0.0, 1.0)).clamp(0.3, 1.0);
        neon(&painter, &pts, mix3(VIOLET, TEAL, 0.2), alpha * fog, 1.3 * px.min(1.4));
    };
    let mut front_edges = Vec::new();
    for (a, b) in edges {
        let (ca, cb) = (corner(a), corner(b));
        let behind = proj.depth(lerp3(ca, cb, 0.5)) > centre_depth;
        if behind {
            draw_edge(ca, cb, 0.75);
        } else {
            front_edges.push((ca, cb));
        }
    }

    // The floor grid: frequency decades across, time marks back.
    let floor_line = |a: V3, b: V3, alpha: f32| {
        let pts = edge_pts(a, b);
        ribbon(&painter, &pts, 1.0, |_| rgba(TEAL, alpha));
    };
    for hz in [100.0f32, 1000.0, 10_000.0] {
        floor_line([world_x(hz), 0.0, STAGE_D / 2.0], [world_x(hz), 0.0, -STAGE_D / 2.0], 0.10);
    }
    for t in [0.5f32, 1.0, 2.0, 4.0] {
        floor_line([-1.0, 0.0, world_z(t)], [1.0, 0.0, world_z(t)], 0.08);
    }
    floor_line([-1.0, 0.0, STAGE_D / 2.0], [1.0, 0.0, STAGE_D / 2.0], 0.22);

    // --- the waterfall ---
    let live_view = o.view == SpaceView::Live;
    let rows = if live_view { LIVE_ROWS } else { 44 };
    // Decay rows are square-root spaced like the axis, so they sit evenly on screen; live rows are
    // one history row each, newest at the front.
    let row_t = |row: usize| -> f32 {
        let u = row as f32 / (rows - 1) as f32;
        u * u * T_MAX
    };
    let row_z = |row: usize| if live_view { STAGE_D / 2.0 - STAGE_D * row as f32 / (rows - 1) as f32 } else { world_z(row_t(row)) };
    let cols = COLS;
    let col_hz = |c: usize| frac_to_hz(c as f32 / (cols - 1) as f32, 20.0, 20_000.0);
    // Reverb off: draw the tail it would have at full mix, as a ghost, so the shape is still there
    // to set up before the mix is raised.
    let ghost = !live_view && r.mix < 0.02;
    let shape_r = if ghost { ReverbSettings { mix: 1.0, ..r } } else { r };
    let eq_col: Vec<f32> = (0..cols).map(|c| eq::response_db(eq_params, col_hz(c), sr)).collect();
    let level = |row: usize, c: usize| -> f32 {
        if live_view {
            // Missing history reads as silence.
            st.history.get(row).and_then(|h| h.get(c)).copied().map(|d| (d - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB * 72.0 - 60.0).unwrap_or(FLOOR_DB)
        } else {
            let hz = col_hz(c);
            let mix_db = if shape_r.mix > 1.0e-3 { (20.0 * shape_r.mix.log10()).max(FLOOR_DB) } else { FLOOR_DB };
            tail_shape_db(&shape_r, hz, row_t(row)) + mix_db + eq_col[c]
        }
    };

    let mut ridges: Vec<Ridge> = (0..rows).map(|row| Ridge { row, depth: proj.depth([0.0, 0.0, row_z(row)]) }).collect();
    let (dmin, dmax) = ridges.iter().fold((f32::MAX, f32::MIN), |(a, b), r| (a.min(r.depth), b.max(r.depth)));
    ridges.sort_by(|a, b| b.depth.partial_cmp(&a.depth).unwrap_or(std::cmp::Ordering::Equal));
    let bg = |y: f32| bg_at(((y - rect.min.y) / rect.height()).clamp(0.0, 1.0));
    let surface_alpha = if ghost { 0.38 } else { 1.0 };
    for ridge in &ridges {
        let z = row_z(ridge.row);
        let mut top = Vec::with_capacity(cols);
        let mut base = Vec::with_capacity(cols);
        let mut hts = Vec::with_capacity(cols);
        for c in 0..cols {
            let db = level(ridge.row, c);
            let h = (world_y(db) / HEIGHT_SCALE).min(1.4);
            let x = world_x(col_hz(c));
            let (Some((a, _)), Some((b, _))) = (proj.project([x, world_y(db), z]), proj.project([x, 0.0, z])) else { continue };
            top.push(a);
            base.push(b);
            hts.push(h);
        }
        if top.len() < 2 {
            continue;
        }
        let t = ridge.row as f32 / (rows - 1) as f32;
        let fog = 1.0 - 0.5 * ((ridge.depth - dmin) / (dmax - dmin).max(1.0e-3));
        let colour = if live_view { mix3(TEAL, PINK, t) } else { ramp(t) };
        // Row 0 is the onset in the Decay view (the EQ curve itself) and now in the Live view.
        let front = ridge.row == 0;
        // 1. The opaque curtain that hides what is behind this ridge.
        band(&painter, &top, &base, |i| rgba(bg(top[i].y), 1.0), |i| rgba(bg(base[i].y), 1.0));
        // 2. A tinted wash under the crest, stronger where the tail is loud.
        let wash = 26.0 * px;
        let low: Vec<Pos2> = top.iter().zip(&base).map(|(a, b)| pos2(a.x, (a.y + wash).min(b.y.max(a.y)))).collect();
        band(&painter, &top, &low, |i| rgba(colour, (0.06 + 0.40 * hts[i].min(1.0)) * fog * surface_alpha), |_| rgba(colour, 0.0));
        // 3. Glow, then the line, brightening toward the loud parts. The front ridge (now: the EQ
        // curve itself in the Decay view) is drawn hot.
        let (glow_w, core_w) = if front { (9.0, 2.2) } else { (4.5, 1.2) };
        ribbon(&painter, &top, glow_w, |i| rgba(mix3(colour, WHITE, 0.2), (if front { 0.30 } else { 0.10 * fog }) * (0.5 + 0.5 * hts[i].min(1.0)) * surface_alpha));
        ribbon(&painter, &top, core_w, |i| {
            let crest = hts[i].clamp(0.0, 1.0).powf(1.4);
            let heat = if front { 0.45 + 0.4 * crest } else { 0.28 * crest };
            rgba(mix3(colour, WHITE, heat + 0.1), (if front { 1.0 } else { (0.16 + 0.84 * hts[i].min(1.0).sqrt()) * fog }) * surface_alpha)
        });
    }

    // In the Live view the EQ curve floats along the front of the stage, so what the EQ does to
    // what is playing reads at a glance.
    if live_view {
        let pts: Vec<Pos2> = (0..cols)
            .filter_map(|c| proj.project([world_x(col_hz(c)), HEIGHT_SCALE * 1.05 + eq_col[c] / EQ_DB_SPAN * HEIGHT_SCALE * 0.4, STAGE_D / 2.0 + 0.02]).map(|p| p.0))
            .collect();
        neon(&painter, &pts, AMBER, 0.9, 1.8 * px.min(1.3));
    }

    // --- source, listener and the paths between them ---
    let src: V3 = [-0.55 * rx, 0.84 * ry, -0.40 * rz];
    let lis: V3 = [0.50 * rx, 0.78 * ry, 0.50 * rz];
    let damp = r.damping.clamp(0.0, 1.0);
    let wet = if ghost { 0.35 } else { (r.mix.sqrt()).clamp(0.2, 1.0) };
    let pulse_gain = 0.45 + 0.55 * st.energy;
    let mut paths: Vec<(Vec<V3>, f32)> = vec![(vec![src, lis], 1.0)];
    // First reflections off the four walls and the ceiling, by the image-source method: mirror the
    // source in the wall and aim at the listener; where that line crosses the wall is the bounce.
    let walls: [(usize, f32); 5] = [(0, rx), (0, -rx), (2, rz), (2, -rz), (1, ry)];
    for (axis, plane) in walls {
        let mut image = src;
        image[axis] = 2.0 * plane - src[axis];
        let d = lis[axis] - image[axis];
        if d.abs() < 1.0e-5 {
            continue;
        }
        let u = (plane - image[axis]) / d;
        let hit = lerp3(image, lis, u);
        paths.push((vec![src, hit, lis], (1.0 - 0.55 * damp) * wet));
    }
    let len_of = |p: &[V3]| p.windows(2).map(|w| dot(sub(w[1], w[0]), sub(w[1], w[0])).sqrt()).sum::<f32>();
    // A pulse leaves the source every `period` seconds and runs along every path at the same speed,
    // so the reflections visibly arrive after the direct sound, later in a bigger room.
    let period = 1.4 + 0.6 * r.size01();
    let speed = 2.4;
    for (k, (path, strength)) in paths.iter().enumerate() {
        let pts3: Vec<V3> = path.windows(2).flat_map(|w| (0..16).map(move |j| lerp3(w[0], w[1], j as f32 / 16.0))).chain(std::iter::once(*path.last().unwrap())).collect();
        let pts: Vec<Pos2> = pts3.iter().filter_map(|p| proj.project(*p).map(|q| q.0)).collect();
        let (c, core) = if k == 0 { (AMBER, 1.5) } else { (mix3(TEAL, VIOLET, (k as f32 / 5.0) * 0.8), 1.0) };
        let a = strength * if k == 0 { 0.6 } else { 0.5 };
        ribbon(&painter, &pts, core * 4.0 * px.min(1.3), |_| rgba(c, 0.07 * a));
        ribbon(&painter, &pts, core * px.min(1.3), |_| rgba(mix3(c, WHITE, 0.2), a));
        if k > 0 {
            if let Some((b, _)) = proj.project(path[1]) {
                glow_dot(&painter, b, 2.6 * px.min(1.3), c, 0.8 * strength);
            }
        }
        // The pulse.
        let len = len_of(path);
        let u = (now % period) * speed / len.max(1.0e-3);
        if (0.0..=1.0).contains(&u) {
            let mut left = u * len;
            let mut at = path[0];
            for w in path.windows(2) {
                let seg = dot(sub(w[1], w[0]), sub(w[1], w[0])).sqrt();
                if left <= seg {
                    at = lerp3(w[0], w[1], left / seg.max(1.0e-6));
                    break;
                }
                left -= seg;
                at = w[1];
            }
            if let Some((p, _)) = proj.project(at) {
                let fade = if k == 0 { 1.0 } else { 1.0 - 0.5 * u * damp };
                glow_dot(&painter, p, 3.0 * px.min(1.3), mix3(c, WHITE, 0.3), strength * fade * pulse_gain);
            }
        }
    }
    if let Some((p, _)) = proj.project(src) {
        let throb = 1.0 + 0.35 * st.energy;
        glow_dot(&painter, p, 5.5 * px.min(1.3) * throb, PINK, 1.0);
        text(&painter, pos2(p.x, p.y - 14.0 * throb), Align2::CENTER_BOTTOM, "SOURCE", 9.0, LABEL);
    }
    if let Some((p, _)) = proj.project(lis) {
        glow_dot(&painter, p, 5.0 * px.min(1.3), TEAL, 1.0);
        text(&painter, pos2(p.x, p.y - 13.0), Align2::CENTER_BOTTOM, "LISTENER", 9.0, LABEL);
    }

    for (a, b) in front_edges {
        draw_edge(a, b, 0.95);
    }
    // The room's size at its top front corner.
    if let Some((p, _)) = proj.project([-rx, ry, rz]) {
        text(&painter, pos2(p.x + 6.0, p.y - 4.0), Align2::LEFT_BOTTOM, format!("{:.0} m room", r.room_size), 10.0, c32(mix3(VIOLET, WHITE, 0.4), 0.9));
    }

    // Axis labels: frequency along the front foot, time up the right side of the stage.
    for (hz, label) in [(100.0f32, "100"), (1000.0, "1k"), (10_000.0, "10k")] {
        if let Some((p, _)) = proj.project([world_x(hz), 0.0, STAGE_D / 2.0]) {
            painter.line_segment([p, pos2(p.x, p.y + 4.0)], Stroke::new(1.0, Color32::from_white_alpha(60)));
            text(&painter, pos2(p.x, p.y + 6.0), Align2::CENTER_TOP, label, 9.0, LABEL_DIM);
        }
    }
    if let (Some((a, _)), Some((b, _))) = (proj.project([-1.0, 0.0, STAGE_D / 2.0]), proj.project([1.0, 0.0, STAGE_D / 2.0])) {
        text(&painter, pos2((a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + 19.0), Align2::CENTER_TOP, "FREQUENCY", 9.0, LABEL);
    }
    let time_marks: &[(f32, &str)] = if live_view { &[(STAGE_D / 2.0, "now"), (-STAGE_D / 2.0, "1.3 s ago")] } else { &[(world_z(0.0), "0"), (world_z(0.5), "0.5 s"), (world_z(1.0), "1 s"), (world_z(2.0), "2 s"), (world_z(4.0), "4 s"), (world_z(8.0), "8 s")] };
    for (z, label) in time_marks {
        if let Some((p, _)) = proj.project([1.0, 0.0, *z]) {
            text(&painter, pos2(p.x + 6.0, p.y), Align2::LEFT_CENTER, *label, 9.0, LABEL_DIM);
        }
    }
    // The RT60 line on the floor: where the bass has fallen 60 dB.
    if !live_view {
        let t60 = predelay(&r) + t60_at(&r, 100.0);
        if t60 < T_MAX {
            let pts = edge_pts([-1.0, 0.002, world_z(t60)], [1.0, 0.002, world_z(t60)]);
            ribbon(&painter, &pts, 1.4, |_| rgba(AMBER, 0.5));
            if let Some(p) = pts.first() {
                text(&painter, pos2(p.x - 6.0, p.y), Align2::RIGHT_CENTER, "RT60", 9.0, c32(AMBER, 0.8));
            }
        }
    }

    let foot = pos2(rect.min.x + 12.0, rect.max.y - 9.0);
    let note = if live_view {
        if has_signal { "What the track is playing, newest at the front".to_string() } else { "Nothing is playing on this track".to_string() }
    } else if ghost {
        "Mix is at zero: this is the tail you will hear once you raise it".to_string()
    } else {
        "The reverb's tail, shaped by the EQ: the note at the back, time running toward you".to_string()
    };
    let caption = match &o.caption {
        Some(c) if !c.is_empty() => format!("{c}  -  {note}"),
        _ => note,
    };
    text(&painter, foot, Align2::LEFT_BOTTOM, caption, 10.5, LABEL);
    text(&painter, pos2(rect.max.x - 12.0, rect.max.y - 9.0), Align2::RIGHT_BOTTOM, "drag to orbit  -  wheel to zoom", 9.5, LABEL_DIM);
}

fn draw_readout(painter: &Painter, space: Rect, r: &ReverbSettings) {
    let items = [
        ("DECAY", format!("{:.2} s", r.time)),
        ("ROOM", format!("{:.0} m", r.room_size)),
        ("DAMPING", format!("{:.0}%", r.damping * 100.0)),
        ("MIX", format!("{:.0}%", r.mix * 100.0)),
    ];
    let col = 68.0;
    for (k, (label, value)) in items.iter().rev().enumerate() {
        let x = space.max.x - 14.0 - k as f32 * col;
        text(painter, pos2(x, space.min.y + 12.0), Align2::RIGHT_TOP, value, 12.5, LABEL_BRIGHT);
        text(painter, pos2(x, space.min.y + 29.0), Align2::RIGHT_TOP, *label, 8.5, LABEL_DIM);
    }
}

// ------------------------------------------------------------------------------------------
// The EQ
// ------------------------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn draw_eq(painter: &Painter, lay: &Layout, eq_params: &EqParams, sr: f32, spectrum: &[f32], nodes: &[Pos2], chips: &[Rect], selected: Option<usize>, hovered: Option<usize>, pointer: Option<Pos2>, has_signal: bool) {
    let area = lay.eq_area;
    let plot = lay.eq_plot;
    painter.rect_filled_gradient(area, PANEL_TOP, PANEL_TOP, PANEL_BOTTOM, PANEL_BOTTOM);
    painter.rect_stroke(area, 6u8, Stroke::new(1.0, Color32::from_white_alpha(30)), StrokeKind::Middle);
    let p = painter.with_clip_rect(area);

    // Grid.
    for hz in [20.0f32, 50.0, 100.0, 200.0, 500.0, 1000.0, 2000.0, 5000.0, 10_000.0, 20_000.0] {
        let x = eq_point(plot, hz, 0.0).x;
        let major = matches!(hz as u32, 100 | 1000 | 10_000);
        p.line_segment([pos2(x, plot.min.y), pos2(x, plot.max.y)], Stroke::new(1.0, Color32::from_white_alpha(if major { 24 } else { 11 })));
        let label = if hz >= 1000.0 { format!("{}k", hz as u32 / 1000) } else { format!("{}", hz as u32) };
        text(&p, pos2(x, plot.max.y + 4.0), Align2::CENTER_TOP, label, 9.0, LABEL_DIM);
    }
    for db in [-18.0f32, -12.0, -6.0, 0.0, 6.0, 12.0, 18.0] {
        let y = eq_point(plot, 1000.0, db).y;
        let zero = db == 0.0;
        p.line_segment([pos2(plot.min.x, y), pos2(plot.max.x, y)], Stroke::new(1.0, Color32::from_white_alpha(if zero { 40 } else { 11 })));
        text(&p, pos2(plot.min.x - 6.0, y), Align2::RIGHT_CENTER, if zero { "0 dB".to_string() } else { format!("{:+}", db as i32) }, 9.0, LABEL_DIM);
    }

    // The live spectrum, from the floor up, on its own scale.
    if has_signal && spectrum.len() >= 2 {
        let n = spectrum.len();
        let top: Vec<Pos2> = (0..n)
            .map(|c| {
                let x = plot.min.x + (c as f32 + 0.5) / n as f32 * plot.width();
                let f = ((spectrum[c] - SPECTRUM_FLOOR_DB) / -SPECTRUM_FLOOR_DB).clamp(0.0, 1.0);
                pos2(x, plot.max.y - f * plot.height())
            })
            .collect();
        let bottom: Vec<Pos2> = top.iter().map(|q| pos2(q.x, plot.max.y)).collect();
        band(&p, &top, &bottom, |_| rgba(TEAL, 0.20), |_| rgba(VIOLET, 0.03));
        ribbon(&p, &top, 1.0, |_| rgba(TEAL, 0.45));
    }

    // Curves stay inside the plot: a steep cut runs off its bottom rather than into the labels.
    let curves = p.with_clip_rect(plot.expand(1.0));
    // Each band's own curve, faintly, in its colour.
    let steps = 220usize;
    let xs: Vec<f32> = (0..=steps).map(|i| frac_to_hz(i as f32 / steps as f32, 20.0, 20_000.0)).collect();
    let zero_y = eq_point(plot, 1000.0, 0.0).y;
    for (i, b) in eq_params.bands.iter().enumerate() {
        if !b.is_active() {
            continue;
        }
        let c = BAND_COLORS[i];
        let pts: Vec<Pos2> = xs.iter().map(|&hz| eq_point(plot, hz, eq::band_response_db(b, hz, sr))).collect();
        let base: Vec<Pos2> = pts.iter().map(|q| pos2(q.x, zero_y)).collect();
        let a = if selected == Some(i) || hovered == Some(i) { 0.22 } else { 0.10 };
        band(&curves, &pts, &base, |_| rgba(c, a), |_| rgba(c, a * 0.4));
        ribbon(&curves, &pts, 1.0, |_| rgba(c, a * 2.6));
    }

    // The whole EQ: a filled glow down to 0 dB, then the line.
    let total: Vec<Pos2> = xs.iter().map(|&hz| eq_point(plot, hz, eq::response_db(eq_params, hz, sr))).collect();
    let base: Vec<Pos2> = total.iter().map(|q| pos2(q.x, zero_y)).collect();
    band(&curves, &total, &base, |_| rgba(AMBER, 0.16), |_| rgba(AMBER, 0.02));
    neon(&curves, &total, AMBER, 1.0, 2.0);

    // Nodes, the selected one last so it sits on top.
    let mut order: Vec<usize> = (0..nodes.len()).collect();
    order.sort_by_key(|&i| (selected == Some(i), hovered == Some(i)));
    for i in order {
        let b = &eq_params.bands[i];
        let c = BAND_COLORS[i];
        let n = nodes[i];
        let sel = selected == Some(i);
        let hot = hovered == Some(i);
        if b.enabled {
            if sel {
                p.circle_filled(n, 17.0, c32(c, 0.10));
                p.circle_stroke(n, 11.0, Stroke::new(1.5, c32(mix3(c, WHITE, 0.4), 0.95)));
            }
            glow_dot(&p, n, if hot || sel { 7.0 } else { 6.0 }, c, 1.0);
            text(&p, n, Align2::CENTER, format!("{}", i + 1), 9.0, Color32::from_rgb(10, 12, 24));
        } else {
            p.circle_filled(n, 6.5, Color32::from_rgba_unmultiplied(16, 18, 34, 220));
            p.circle_stroke(n, 6.5, Stroke::new(1.2, c32(c, if hot || sel { 0.8 } else { 0.4 })));
            text(&p, n, Align2::CENTER, format!("{}", i + 1), 9.0, c32(c, 0.7));
        }
    }

    // Band chips along the top.
    for (i, r) in chips.iter().enumerate() {
        let b = &eq_params.bands[i];
        let c = BAND_COLORS[i];
        let sel = selected == Some(i);
        let hot = hovered == Some(i);
        let fill = if sel { c32(mix3(c, BG_TOP, 0.55), 0.95) } else { Color32::from_rgba_unmultiplied(20, 22, 42, if hot { 235 } else { 190 }) };
        p.rect_filled(*r, 7u8, fill);
        p.rect_stroke(*r, 7u8, Stroke::new(1.0, if sel { c32(c, 0.9) } else { Color32::from_white_alpha(if hot { 70 } else { 30 }) }), StrokeKind::Middle);
        let dot = pos2(r.min.x + 10.0, r.center().y);
        if b.enabled {
            p.circle_filled(dot, 3.5, c32(c, 1.0));
        } else {
            p.circle_stroke(dot, 3.5, Stroke::new(1.0, c32(c, 0.6)));
        }
        text(&p, pos2(r.min.x + 18.0, r.center().y), Align2::LEFT_CENTER, format!("{} {}", i + 1, band_chip_label(b.kind)), 10.5, if b.enabled { LABEL_BRIGHT } else { LABEL });
    }

    // What the selected (or hovered) band is set to, top right; the pointer's position in the plot
    // bottom right.
    if let Some(i) = hovered.or(selected) {
        let b = &eq_params.bands[i];
        let detail = if b.kind.is_cut() {
            format!("{}  {}  Q {:.2}{}", band_short_name(b.kind), format_hz(b.freq), b.q, if b.enabled { "" } else { "  (off)" })
        } else {
            format!("{}  {}  {:+.1} dB  Q {:.2}{}", band_short_name(b.kind), format_hz(b.freq), b.gain_db, b.q, if b.enabled { "" } else { "  (off)" })
        };
        text(&p, pos2(area.max.x - 14.0, area.min.y + 20.0), Align2::RIGHT_CENTER, detail, 11.5, c32(mix3(BAND_COLORS[i], WHITE, 0.45), 1.0));
    } else {
        text(&p, pos2(area.max.x - 14.0, area.min.y + 20.0), Align2::RIGHT_CENTER, "drag a node  -  wheel for Q  -  right-click to switch", 10.0, LABEL_DIM);
    }
    if let Some(q) = pointer.filter(|q| plot.contains(*q)) {
        let (hz, db) = eq_value(plot, q);
        text(&p, pos2(plot.max.x - 4.0, plot.max.y - 4.0), Align2::RIGHT_BOTTOM, format!("{}  {:+.1} dB", format_hz(hz), db), 9.5, LABEL);
    }
    if eq_params.output_db.abs() > 0.05 {
        text(&p, pos2(plot.min.x + 4.0, plot.min.y + 2.0), Align2::LEFT_TOP, format!("output {:+.1} dB", eq_params.output_db), 9.5, LABEL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48_000.0;

    #[test]
    fn eq_plot_mapping_round_trips() {
        let plot = Rect::from_min_max(pos2(40.0, 300.0), pos2(840.0, 500.0));
        for (hz, db) in [(20.0f32, -18.0f32), (440.0, 0.0), (5000.0, 7.5), (20_000.0, 18.0)] {
            let (h2, d2) = eq_value(plot, eq_point(plot, hz, db));
            assert!((h2 / hz - 1.0).abs() < 1.0e-3, "{hz} -> {h2}");
            assert!((d2 - db).abs() < 1.0e-3, "{db} -> {d2}");
        }
    }

    #[test]
    fn damping_shortens_the_treble_and_leaves_the_bass() {
        let dry = ReverbSettings { damping: 0.0, time: 2.0, ..Default::default() };
        let damp = ReverbSettings { damping: 1.0, time: 2.0, ..Default::default() };
        assert!((t60_at(&dry, 8000.0) - 2.0).abs() < 1.0e-4);
        assert!(t60_at(&damp, 8000.0) < 0.6, "damped treble rings {}", t60_at(&damp, 8000.0));
        assert!(t60_at(&damp, 80.0) > 1.95);
    }

    #[test]
    fn the_decay_view_follows_the_eq_and_the_mix() {
        let r = ReverbSettings { mix: 0.5, time: 2.0, ..Default::default() };
        let mut cut = EqParams::default();
        cut.bands[3] = EqBand::new(BandKind::Peak, true, 3000.0, -12.0, 1.0);
        let t = 0.4;
        let flat = decay_level_db(&r, &EqParams::default(), SR, 3000.0, t);
        let notched = decay_level_db(&r, &cut, SR, 3000.0, t);
        assert!((flat - notched - 12.0).abs() < 0.2, "the cut runs the whole way back ({flat} vs {notched})");
        let full = decay_level_db(&ReverbSettings { mix: 1.0, ..r }, &EqParams::default(), SR, 3000.0, t);
        assert!((full - flat - 6.02).abs() < 0.05);
        // A longer time keeps the tail up for longer.
        let long = decay_level_db(&ReverbSettings { time: 5.0, ..r }, &EqParams::default(), SR, 500.0, 1.5);
        let short = decay_level_db(&r, &EqParams::default(), SR, 500.0, 1.5);
        assert!(long > short + 20.0);
    }

    #[test]
    fn a_bigger_room_answers_later_and_is_bigger() {
        let small = ReverbSettings { room_size: 10.0, ..Default::default() };
        let big = ReverbSettings { room_size: 30.0, ..Default::default() };
        assert!(predelay(&big) > predelay(&small) * 1.8);
        let (a, b) = (room_extents(&small), room_extents(&big));
        assert!(b[0] > a[0] && b[1] > a[1] && b[2] > a[2]);
        // The room always holds the stage.
        assert!(a[0] > 1.0 && a[2] > STAGE_D / 2.0);
    }

    #[test]
    fn the_decay_waterfall_runs_from_the_note_at_the_back_toward_the_viewer() {
        assert_eq!(world_z(0.0), -STAGE_D / 2.0);
        assert_eq!(world_z(T_MAX), STAGE_D / 2.0);
        assert!(world_z(0.5) > world_z(0.1));
        assert_eq!(world_x(20.0), -1.0);
        assert!((world_x(20_000.0) - 1.0).abs() < 1.0e-6);
        assert_eq!(world_y(FLOOR_DB - 10.0), 0.0);
        assert!((world_y(0.0) - HEIGHT_SCALE).abs() < 1.0e-6);
    }

    #[test]
    fn a_resampled_spectrum_keeps_a_narrow_peak() {
        let n = 2049;
        let bin_hz = SR * 0.5 / (n - 1) as f32;
        let mut bins = vec![-100.0f32; n];
        let peak = (9000.0 / bin_hz).round() as usize;
        bins[peak] = -6.0;
        let cols = resample_spectrum(&bins, SR, 96);
        let best = cols.iter().cloned().fold(f32::MIN, f32::max);
        // -6 dB plus the tilt at ~9 kHz.
        assert!(best > -6.0 && best < 5.0, "peak read as {best}");
        assert!(resample_spectrum(&[], SR, 8).iter().all(|&v| v == SPECTRUM_FLOOR_DB));
    }

    #[test]
    fn a_cut_node_sits_on_its_own_corner() {
        let b = EqBand::new(BandKind::LowCut, false, 120.0, 0.0, 0.707);
        let db = node_db(&b, SR);
        assert!((db + 3.0).abs() < 0.3, "a Butterworth corner is about -3 dB, got {db}");
        let bell = EqBand::new(BandKind::Peak, true, 1000.0, 4.5, 1.0);
        assert_eq!(node_db(&bell, SR), 4.5);
        assert!(wheel_q(&bell, 1.0).q > bell.q && wheel_q(&bell, -1.0).q < bell.q);
    }
}
