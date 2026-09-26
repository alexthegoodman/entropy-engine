//! `WaterView`: a water track's instrument drawn from the model's own state, in the same neon style
//! as the kit, the bowed string and the brass - glowing lines, an orbiting camera, no attempt at
//! photorealism.
//!
//! Everything the water track can do stands on one table, each thing where its sound comes from.
//! What moves is what the audio engine publishes in `audio::matter::water_voice::WaterFrame`:
//!
//! * **the basin**: every bubble ringing in it, where it is (born under the drop that made it,
//!   rising to the surface), its size, and its ring - pulsing, fading as it rings out, coloured by
//!   its pitch; the last drop falls into it and its ripples spread from where it landed;
//! * **the glass rack**: the eight glasses with the water that tunes each one, their rims bending
//!   in the wall modes the audio rings with (orders 2, 3 and 4, exaggerated and slowed for the eye),
//!   and the mallet or spoon replaying each strike from what the contact measured - how long it
//!   stayed on the rim and how fast it came away;
//! * **the vessels being filled**: each drawn with the shape the note scaled it to, its water
//!   rising, the stream falling in, the bubbles the stream drags under, and the air column above
//!   the water glowing with its lowest mode (a quarter wave: still at the water, moving at the
//!   mouth);
//! * **the rain** on the track's surface (a lake, a window, a tin roof, a tent, a cymbal, a drum),
//!   each drop's splash drawn where the simulation landed it, the body lit by how much it rings;
//! * **the brook, the beach and the tub**: the shallow-water simulation's surface and bed along
//!   their lines, flecks carried at the water's own speed, foam wherever a bore is breaking - which
//!   is where their bubbles, and their sound, come from.
//!
//! The basin, the glasses and the vessels are drawn a little larger than life, the brook, the
//! beach and the tub much smaller, and heights of moving water exaggerated; the readout gives the
//! real numbers.
//!
//! **Physics View** (`WaterViewOptions::physics_view`) adds the bubbles ringing (pitch against
//! amplitude), the glasses' wall modes and the vessels' air columns, and each source's level.
//!
//! Interaction: click the basin to let a drop fall there (left is low, right is high); click a
//! glass to strike it; click a vessel to fill it to a note (the higher the click, the higher the
//! note); press and hold on the rain, the brook or the beach to make it rain, run or roll (drag up
//! for more); drag the tub from side to side to shake it. The pads along the bottom play each kind
//! of water; the PHYSICS chip toggles Physics View. The right mouse button, Alt, or a pen's barrel
//! button orbit the camera, as in the other instrument views.

use crate::audio::matter::bubble::BubbleDot;
use crate::audio::matter::rain::{RainTarget, RECENT};
use crate::audio::matter::water_voice::{Source, WaterFrame, WaterShared, WaterState, FILLS, GLASSES, PROFILE, SOURCES};
use crate::audio::matter::waves::BREAKING;
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::widgets_matter::{
    add, c32, draw_chip, inner, inside, mix3, panel, polyline, sub, Camera, Projector, AMBER, BG_BOTTOM, BG_TOP, BRASS, DIM, HEAD, LABEL, ROSE, SKY, TEAL, V3, VIOLET,
};

use std::f32::consts::{PI, TAU};

// ------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------

/// Water itself.
const WATER: [f32; 3] = [0.36, 0.66, 1.0];
/// Foam, splashes and the brightest bubbles.
const FOAM: [f32; 3] = [0.88, 0.95, 1.0];
/// Sand and stone.
const SAND: [f32; 3] = [0.62, 0.52, 0.40];

/// Each source's colour: the pads and the levels.
fn colour(s: Source) -> [f32; 3] {
    match s {
        Source::Drip => WATER,
        Source::Glass => TEAL,
        Source::Fill => SKY,
        Source::Rain => VIOLET,
        Source::Brook => [0.30, 0.86, 0.62],
        Source::Surf => [0.40, 0.72, 0.96],
        Source::Slosh => BRASS,
    }
}

fn label(s: Source) -> &'static str {
    match s {
        Source::Drip => "DRIP",
        Source::Glass => "GLASS",
        Source::Fill => "FILL",
        Source::Rain => "RAIN",
        Source::Brook => "BROOK",
        Source::Surf => "SURF",
        Source::Slosh => "TUB",
    }
}

/// A bubble's colour from its pitch: deep violet for a large, low bubble to near white for the
/// tiny ones that make rain's 14 kHz whisper.
fn pitch_colour(hz: f32) -> [f32; 3] {
    let t = ((hz.max(100.0).log2() - 100f32.log2()) / (16_000f32.log2() - 100f32.log2())).clamp(0.0, 1.0);
    if t < 0.5 {
        mix3(VIOLET, WATER, t * 2.0)
    } else {
        mix3(WATER, FOAM, (t - 0.5) * 2.0)
    }
}

// ------------------------------------------------------------------------------------------
// The table: where everything stands (view metres; see the module notes on scale)
// ------------------------------------------------------------------------------------------

/// The box the scene stands in.
const FIT: (V3, V3) = ([-1.62, -0.1, -2.05], [1.62, 0.45, 0.48]);

/// Glasses: drawn at 1.7 times their size, in a row at the front left.
const GLASS_SCALE: f32 = 1.7;
const GLASS_BOX: (f32, f32) = (0.075, 0.3);

fn glass_base(k: usize) -> V3 {
    let t = (k as f32 - 3.5) / 3.5;
    [-1.44 + 0.155 * k as f32, 0.0, 0.3 - 0.08 * t * t]
}

/// The basin: 1 m of water across (drips land up to half a metre either side), drawn at 0.66,
/// with its depth drawn 18 times deeper than it is (the bubbles are born millimetres down).
const BASIN: V3 = [0.12, 0.0, 0.26];
const BASIN_HALF: [f32; 2] = [0.33, 0.13];
const BASIN_TOP: f32 = 0.24;
const BASIN_WATER: f32 = 0.19;
const BASIN_SCALE: f32 = 0.66;
const BUBBLE_DEPTH_SCALE: f32 = 18.0;
const TAP_Y: f32 = 0.42;

/// Vessels being filled: each drawn 0.42 tall, whatever the note scaled it to.
const VESSELS: [V3; FILLS] = [[0.8, 0.0, 0.26], [1.2, 0.0, 0.26]];
const VESSEL_H: f32 = 0.42;
const VESSEL_BOX: f32 = 0.14;

/// The rain's body, at the back in the middle.
const RAIN: V3 = [0.1, 0.0, -0.55];
const RAIN_R: f32 = 0.33;

/// The tub (40 by 25 cm) at the back left, 1.4 times its size; its shaking drawn 4 times larger.
const TUB: V3 = [-1.0, 0.0, -0.5];
const TUB_SCALE: f32 = 1.4;
const TUB_SHAKE: f32 = 4.0;

/// The brook (4 m of it) at the back right, 0.225 times its length, its depth 1.6 times.
const BROOK: V3 = [0.98, 0.0, -0.55];
const BROOK_LEN: f32 = 0.9;
const BROOK_WIDE: f32 = 0.11;
const BROOK_UP: f32 = 1.6;

/// The beach behind everything: 110 m from the open sea (far) to the shore (near), heights 0.07.
const SURF_Z: (f32, f32) = (-2.02, -1.0);
const SURF_X: f32 = 1.55;
const SURF_UP: f32 = 0.07;
const SURF_BASE: f32 = -0.19;

// ------------------------------------------------------------------------------------------
// Public options / events / response
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct WaterViewOptions {
    pub height: f32,
    pub width: Option<f32>,
    /// The row of pads along the bottom.
    pub pads: bool,
    pub physics_view: bool,
    /// Extra visual exaggeration of the glasses' motion (1 = default).
    pub exaggeration: f32,
    /// A line shown over the scene (the water being built, say).
    pub status: Option<String>,
}

impl Default for WaterViewOptions {
    fn default() -> Self {
        Self { height: 440.0, width: None, pads: true, physics_view: false, exaggeration: 1.0, status: None }
    }
}

/// How long a press on the rain, the brook, the beach or the tub holds it for, s; while the
/// pointer stays down it is renewed every [`HOLD_EVERY`] s.
pub const HOLD_SECONDS: f32 = 0.35;
pub const HOLD_EVERY: f32 = 0.12;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WaterViewEvent {
    /// A click on the basin: a drop falls there (`x` -1 left .. 1 right).
    Drip { x: f32, velocity: f32 },
    /// A click on a glass: strike it. `pitch` is what its water tunes it to now (0: an empty place
    /// in the rack).
    Glass { index: usize, pitch: f32, velocity: f32 },
    /// A click on a vessel: fill one to a note, `height` 0 (its foot) .. 1 (its mouth).
    Fill { height: f32, velocity: f32 },
    /// A press held on the rain, the brook, the beach or the tub: keep it going for another
    /// [`HOLD_SECONDS`] (sent again while held).
    Hold { source: Source, velocity: f32 },
    /// A pad: play that kind of water.
    Pad { source: Source, velocity: f32 },
    /// The PHYSICS chip was clicked: the view the user asked for.
    PhysicsView(bool),
}

pub struct WaterViewResponse {
    pub events: Vec<WaterViewEvent>,
}

/// Something on the table the pointer can play.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Target {
    /// The basin, `x` -1 .. 1 across it.
    Basin(f32),
    Glass(usize),
    /// A vessel, `height` 0 .. 1 up it.
    Vessel(usize, f32),
    Rain,
    Brook,
    Surf,
    Tub,
}

impl Target {
    /// The source a held press keeps going.
    fn held(self) -> Option<Source> {
        match self {
            Target::Rain => Some(Source::Rain),
            Target::Brook => Some(Source::Brook),
            Target::Surf => Some(Source::Surf),
            Target::Tub => Some(Source::Slosh),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
enum Drag {
    Orbit,
    /// Holding a texture: which, where the press started (screen y), and when it was last renewed.
    Hold { source: Source, y0: f32, last: f32 },
    None,
}

/// A glass strike being replayed (as the kit's sticks are).
#[derive(Clone, Copy, Default)]
struct Replay {
    seen: u32,
    t: f32,
    speed_in: f32,
    speed_out: f32,
    contact_ms: f32,
    force: f32,
    spoon: bool,
}

const RIPPLES: usize = 10;

struct ViewState {
    camera: Camera,
    drag: Option<Drag>,
    last_pointer: Option<Pos2>,
    last_time: f32,
    /// The view's own clock for slowed motion (glass rims, bubbles' pulse), s.
    t: f32,
    /// Display scale for the glasses' rims: follows their peak up at once, down slowly.
    glass_ref: f32,
    replay: [Replay; GLASSES],
    /// Drops seen, and the ripples spreading: (x across the basin, age s).
    drips: u64,
    ripples: [(f32, f32); RIPPLES],
    next_ripple: usize,
    /// Rain: landings seen, and each remembered landing's age (s).
    landed: u64,
    splash_age: [f32; RECENT],
    rain_ref: f32,
    /// Flecks on the brook, the beach and the tub: where along the line (0..1), and across (-1..1).
    brook_flecks: [(f32, f32); FLECKS],
    surf_flecks: [(f32, f32); FLECKS],
    level_top: f32,
}

const FLECKS: usize = 28;

impl Default for ViewState {
    fn default() -> Self {
        let fleck = |i: usize| ((i as f32 * 0.618_034).fract(), ((i as f32 * 0.414_214).fract() * 2.0 - 1.0) * 0.9);
        Self {
            camera: default_camera(),
            drag: None,
            last_pointer: None,
            last_time: 0.0,
            t: 0.0,
            glass_ref: 1.0e-6,
            replay: [Replay { t: 99.0, ..Default::default() }; GLASSES],
            drips: 0,
            ripples: [(0.0, 99.0); RIPPLES],
            next_ripple: 0,
            landed: 0,
            splash_age: [99.0; RECENT],
            rain_ref: 1.0e-9,
            brook_flecks: std::array::from_fn(fleck),
            surf_flecks: std::array::from_fn(|i| fleck(i + 7)),
            level_top: 1.0e-3,
        }
    }
}

/// From in front of the table, a little above it: the glasses, the basin and the vessels in front,
/// the tub, the rain and the brook behind them, and the sea at the back.
pub fn default_camera() -> Camera {
    Camera { yaw: 0.0, pitch: 0.78, dist: 1.9 }
}

/// Everything drawn this frame, read once from the shared state.
struct Scene {
    state: WaterState,
    frame: WaterFrame,
}

/// Screen-space panels.
struct Layout {
    scene: Rect,
    chip: Rect,
    bubbles: Option<Rect>,
    resonances: Option<Rect>,
    levels: Option<Rect>,
    readout: Pos2,
}

impl Layout {
    fn new(stage: Rect, physics: bool) -> Self {
        let chip = Rect::from_min_size(pos2(stage.max.x - 92.0, stage.min.y + 10.0), vec2(80.0, 22.0));
        let w = (stage.width() * 0.3).clamp(180.0, 280.0);
        let x = stage.max.x - w - 12.0;
        let avail = (stage.max.y - chip.max.y - 20.0).max(150.0);
        let h = ((avail - 16.0) / 3.0).clamp(60.0, 150.0);
        let at = |i: f32| Rect::from_min_size(pos2(x, chip.max.y + 8.0 * (i + 1.0) + h * i), vec2(w, h));
        let scene = if physics { Rect::from_min_max(stage.min, pos2(x - 8.0, stage.max.y)) } else { stage };
        Self { scene, chip, bubbles: physics.then(|| at(0.0)), resonances: physics.then(|| at(1.0)), levels: physics.then(|| at(2.0)), readout: pos2(stage.min.x + 14.0, stage.min.y + 12.0) }
    }

    fn in_panels(&self, p: Pos2) -> bool {
        [self.bubbles, self.resonances, self.levels].iter().flatten().any(|r| r.contains(p)) || self.chip.contains(p)
    }
}

const PAD_H: f32 = 56.0;

/// The pads' rectangles along the bottom of `rect`.
pub fn pad_rects(rect: Rect) -> [(Source, Rect); SOURCES] {
    let row = Rect::from_min_max(pos2(rect.min.x, rect.max.y - PAD_H), rect.max);
    let w = row.width() / SOURCES as f32;
    std::array::from_fn(|i| (Source::ALL[i], Rect::from_min_max(pos2(row.min.x + w * i as f32 + 3.0, row.min.y + 5.0), pos2(row.min.x + w * (i + 1) as f32 - 3.0, row.max.y - 3.0))))
}

fn stage_of(rect: Rect, opts: &WaterViewOptions) -> Rect {
    let pad_h = if opts.pads { PAD_H } else { 0.0 };
    Rect::from_min_max(rect.min, pos2(rect.max.x, rect.max.y - pad_h))
}

// ------------------------------------------------------------------------------------------
// The widget
// ------------------------------------------------------------------------------------------

pub struct WaterView {
    id: Id,
}

impl WaterView {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_salt) }
    }

    pub fn show(self, ui: &mut Ui, opts: &WaterViewOptions, shared: &WaterShared) -> WaterViewResponse {
        let ctx = ui.ctx().clone();
        let width = opts.width.unwrap_or_else(|| ui.available_width().max(360.0));
        let (resp, painter) = ui.allocate_painter(vec2(width, opts.height.max(260.0)), Sense::click_and_drag());
        let rect = resp.rect;
        let scene = Scene { state: shared.state(), frame: shared.frame() };

        let (pointer, mods) = ctx.input(|i| (i.pointer, i.modifiers));
        let mut st: ViewState = ctx.memory_mut(|m| m.take_view_state(self.id));
        let now = ctx.time();
        let dt = (now - st.last_time).clamp(0.0, 0.1);
        st.last_time = now;
        st.t += dt;
        let mut events: Vec<WaterViewEvent> = Vec::new();
        let pos = pointer.pos;

        let stage = stage_of(rect, opts);
        let pads = pad_rects(rect);
        let lay = Layout::new(stage, opts.physics_view);
        let proj = Projector::fit(&st.camera, lay.scene, FIT);

        // ---------------------------------------------------------------- input
        if st.drag.is_none() && (pointer.primary_pressed || pointer.secondary_pressed) {
            if let Some(p) = pos {
                let orbit = pointer.secondary_pressed || mods.alt || pointer.pen.is_some_and(|pn| pn.barrel);
                let pressure = pointer.pen.map(|pn| pn.pressure.max(0.2));
                st.drag = Some(Drag::None);
                if pointer.primary_pressed && lay.chip.contains(p) {
                    events.push(WaterViewEvent::PhysicsView(!opts.physics_view));
                } else if orbit && stage.contains(p) {
                    st.drag = Some(Drag::Orbit);
                } else if pointer.primary_pressed && opts.pads && p.y > stage.max.y {
                    if let Some((source, r)) = pads.iter().find(|(_, r)| r.contains(p)) {
                        let velocity = pressure.unwrap_or(0.35 + 0.65 * ((p.y - r.min.y) / r.height()).clamp(0.0, 1.0));
                        events.push(WaterViewEvent::Pad { source: *source, velocity });
                    }
                } else if pointer.primary_pressed && lay.scene.contains(p) && !lay.in_panels(p) {
                    let velocity = pressure.unwrap_or(0.7);
                    match target_at(&proj, p) {
                        Some(Target::Basin(x)) => events.push(WaterViewEvent::Drip { x, velocity }),
                        Some(Target::Glass(k)) => events.push(WaterViewEvent::Glass { index: k, pitch: scene.state.glass_pitch[k], velocity }),
                        Some(Target::Vessel(_, height)) => events.push(WaterViewEvent::Fill { height, velocity }),
                        Some(t) => {
                            if let Some(source) = t.held() {
                                let velocity = pressure.unwrap_or(if source == Source::Slosh { 0.4 } else { 0.6 });
                                events.push(WaterViewEvent::Hold { source, velocity });
                                st.drag = Some(Drag::Hold { source, y0: p.y, last: st.t });
                            }
                        }
                        None => {}
                    }
                }
            }
        }
        let still_down = pointer.primary_down || pointer.secondary_down;
        if let Some(Drag::Orbit) = st.drag {
            if let (Some(p), Some(last)) = (pos, st.last_pointer) {
                st.camera.orbit(p.x - last.x, p.y - last.y);
            }
        }
        if let Some(Drag::Hold { source, y0, last }) = st.drag {
            if still_down && st.t - last >= HOLD_EVERY {
                let velocity = match (source, pointer.pen) {
                    (_, Some(pn)) => pn.pressure.max(0.05),
                    // The tub is shaken as hard as the pointer moves it from side to side.
                    (Source::Slosh, None) => {
                        let speed = match (pos, st.last_pointer) {
                            (Some(p), Some(l)) if dt > 0.0 => (p.x - l.x).abs() / dt,
                            _ => 0.0,
                        };
                        (0.3 + speed / 900.0).clamp(0.3, 1.0)
                    }
                    // Dragging up is more: more rain, a faster brook, higher waves.
                    (_, None) => pos.map_or(0.6, |p| (0.6 + (y0 - p.y) / 220.0).clamp(0.05, 1.0)),
                };
                events.push(WaterViewEvent::Hold { source, velocity });
                st.drag = Some(Drag::Hold { source, y0, last: st.t });
            }
        }
        if !still_down {
            st.drag = None;
        }
        st.last_pointer = pos;

        // ---------------------------------------------------------------- state updates
        update(&mut st, &scene, dt);

        // ---------------------------------------------------------------- drawing
        for y in 0..24 {
            let (t0, t1) = (y as f32 / 24.0, (y + 1) as f32 / 24.0);
            let band = Rect::from_min_max(pos2(rect.min.x, rect.min.y + t0 * rect.height()), pos2(rect.max.x, rect.min.y + t1 * rect.height()));
            painter.rect_filled(band, 0u8, c32(mix3(BG_TOP, BG_BOTTOM, (t0 + t1) * 0.5), 1.0));
        }
        let clip = painter.with_clip_rect(stage);
        draw_surf(&clip, &proj, &scene, &st);
        draw_table(&clip, &proj);
        // The back row, then the front, each back to front.
        let mut back: Vec<(f32, u8)> = vec![(proj.depth(TUB), 0), (proj.depth(RAIN), 1), (proj.depth(BROOK), 2)];
        back.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, which) in back {
            match which {
                0 => draw_tub(&clip, &proj, &scene, &st),
                1 => draw_rain(&clip, &proj, &scene, &st),
                _ => draw_brook(&clip, &proj, &scene, &st),
            }
        }
        let mut front: Vec<(f32, u8)> = (0..GLASSES).map(|k| (proj.depth(glass_base(k)), k as u8)).collect();
        front.push((proj.depth(BASIN), 100));
        for (k, v) in VESSELS.iter().enumerate() {
            front.push((proj.depth(*v), 200 + k as u8));
        }
        front.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, which) in front {
            match which {
                100 => draw_basin(&clip, &proj, &scene, &st),
                w if w >= 200 => draw_vessel(&clip, &proj, (w - 200) as usize, &scene, &st),
                k => draw_glass(&clip, &proj, k as usize, &scene, &st, opts),
            }
        }
        draw_readout(&clip, &lay, &scene, opts);
        if let Some(r) = lay.bubbles {
            draw_bubble_panel(&clip, r, &scene);
        }
        if let Some(r) = lay.resonances {
            draw_resonances(&clip, r, &scene);
        }
        if let Some(r) = lay.levels {
            draw_levels(&clip, r, &scene, &st);
        }
        draw_chip(&clip, lay.chip, opts.physics_view);
        if opts.pads {
            draw_pads(&painter, &pads, &scene);
        }

        ctx.memory_mut(|m| m.put_view_state(self.id, st));
        WaterViewResponse { events }
    }
}

/// What changes between frames: new drops and their ripples, new strikes, new raindrops, the
/// flecks carried along, the display scales.
fn update(st: &mut ViewState, scene: &Scene, dt: f32) {
    let (s, f) = (&scene.state, &scene.frame);
    if s.drips != st.drips {
        if s.drips > st.drips && st.drips > 0 || s.drips == 1 {
            st.ripples[st.next_ripple] = (f.drip_x, 0.0);
            st.next_ripple = (st.next_ripple + 1) % RIPPLES;
        }
        st.drips = s.drips;
    }
    for r in st.ripples.iter_mut() {
        r.1 += dt;
    }
    for (k, rp) in st.replay.iter_mut().enumerate() {
        if f.glass_strikes[k] != rp.seen {
            *rp = Replay { seen: f.glass_strikes[k], t: 0.0, speed_in: f.glass_speed_in[k], speed_out: f.glass_speed_out[k], contact_ms: f.glass_contact_ms[k], force: f.glass_force[k], spoon: f.glass_spoon[k] };
        } else {
            rp.t += dt;
            if rp.t < 0.2 {
                rp.speed_out = f.glass_speed_out[k];
                rp.contact_ms = f.glass_contact_ms[k];
                rp.force = rp.force.max(f.glass_force[k]);
            }
        }
    }
    let peak = f.glass_modes.iter().flatten().fold(0.0f32, |m, v| m.max(v.0));
    st.glass_ref = if peak > st.glass_ref { peak } else { (st.glass_ref * (-dt / 1.5).exp()).max(peak).max(1.0e-7) };
    // Raindrops: every landing the simulation remembered since the last frame splashes now.
    let new = f.rain_landed.saturating_sub(st.landed).min(RECENT as u64);
    for i in 0..new {
        let slot = ((f.rain_landed - 1 - i) % RECENT as u64) as usize;
        st.splash_age[slot] = 0.0;
    }
    st.landed = f.rain_landed;
    for a in st.splash_age.iter_mut() {
        *a += dt;
    }
    st.rain_ref = if f.rain_energy > st.rain_ref { f.rain_energy } else { (st.rain_ref * (-dt / 3.0).exp()).max(1.0e-9) };
    // Flecks ride the water at its own speed along the line.
    let carry = |flecks: &mut [(f32, f32); FLECKS], speed: &[f32; PROFILE], length: f32| {
        for fl in flecks.iter_mut() {
            let i = ((fl.0 * (PROFILE - 1) as f32) as usize).min(PROFILE - 1);
            fl.0 += speed[i] * dt / length;
            if !(0.0..=1.0).contains(&fl.0) {
                fl.0 = fl.0.rem_euclid(1.0);
            }
        }
    };
    carry(&mut st.brook_flecks, &f.brook_speed, 4.0);
    carry(&mut st.surf_flecks, &f.surf_speed, 110.0);
    let top = s.levels.iter().fold(0.0f32, |m, v| m.max(*v));
    st.level_top = if top > st.level_top { top } else { (st.level_top * (-dt / 4.0).exp()).max(1.0e-3) };
}

// ------------------------------------------------------------------------------------------
// Interaction geometry
// ------------------------------------------------------------------------------------------

/// A point on the basin's water, `x` -1 .. 1 across it, in the middle of its depth.
fn basin_point(x: f32) -> V3 {
    [BASIN[0] + x * (BASIN_HALF[0] - 0.02), BASIN_WATER, BASIN[2]]
}

/// A point on a vessel's axis, `h` 0 (foot) .. 1 (mouth).
fn vessel_point(k: usize, h: f32) -> V3 {
    add(VESSELS[k], [0.0, h * VESSEL_H, 0.0])
}

/// The box each target stands in (min, max).
fn target_box(t: Target) -> (V3, V3) {
    match t {
        Target::Basin(_) => (sub(BASIN, [BASIN_HALF[0], 0.0, BASIN_HALF[1]]), add(BASIN, [BASIN_HALF[0], BASIN_TOP, BASIN_HALF[1]])),
        Target::Glass(k) => {
            let b = glass_base(k);
            (sub(b, [GLASS_BOX.0, 0.0, GLASS_BOX.0]), add(b, [GLASS_BOX.0, GLASS_BOX.1, GLASS_BOX.0]))
        }
        Target::Vessel(k, _) => (sub(VESSELS[k], [VESSEL_BOX, 0.0, VESSEL_BOX]), add(VESSELS[k], [VESSEL_BOX, VESSEL_H + 0.02, VESSEL_BOX])),
        Target::Rain => (sub(RAIN, [RAIN_R, 0.0, RAIN_R]), add(RAIN, [RAIN_R, 0.45, RAIN_R])),
        Target::Tub => (sub(TUB, [0.3, 0.0, 0.19]), add(TUB, [0.3, 0.2, 0.19])),
        Target::Brook => (sub(BROOK, [BROOK_LEN * 0.5, 0.0, BROOK_WIDE + 0.03]), add(BROOK, [BROOK_LEN * 0.5, 0.25, BROOK_WIDE + 0.03])),
        Target::Surf => ([-SURF_X, SURF_BASE, SURF_Z.0], [SURF_X, 0.1, SURF_Z.1]),
    }
}

fn all_targets() -> impl Iterator<Item = Target> {
    (0..GLASSES).map(Target::Glass).chain([Target::Basin(0.0), Target::Vessel(0, 0.0), Target::Vessel(1, 0.0), Target::Rain, Target::Tub, Target::Brook, Target::Surf])
}

/// The convex outline of a box on screen.
fn outline(proj: &Projector, (lo, hi): (V3, V3)) -> Option<Vec<Pos2>> {
    let mut pts = Vec::with_capacity(8);
    for x in [lo[0], hi[0]] {
        for y in [lo[1], hi[1]] {
            for z in [lo[2], hi[2]] {
                pts.push(proj.project([x, y, z])?);
            }
        }
    }
    Some(hull(pts))
}

/// Convex hull (monotone chain).
fn hull(mut pts: Vec<Pos2>) -> Vec<Pos2> {
    pts.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    let cross = |o: Pos2, a: Pos2, b: Pos2| (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    let mut h: Vec<Pos2> = Vec::with_capacity(pts.len() * 2);
    for pass in 0..2 {
        let start = h.len();
        let it: Box<dyn Iterator<Item = &Pos2>> = if pass == 0 { Box::new(pts.iter()) } else { Box::new(pts.iter().rev()) };
        for &p in it {
            while h.len() >= start + 2 && cross(h[h.len() - 2], h[h.len() - 1], p) <= 0.0 {
                h.pop();
            }
            h.push(p);
        }
        h.pop();
    }
    h
}

/// What is under a screen point: the nearest target to the eye whose outline contains it, and
/// where on it (across the basin, up a vessel).
fn target_at(proj: &Projector, p: Pos2) -> Option<Target> {
    let mut best: Option<(f32, Target)> = None;
    for t in all_targets() {
        let b = target_box(t);
        let Some(poly) = outline(proj, b) else { continue };
        if poly.len() < 3 || !inside(&poly, p) {
            continue;
        }
        let depth = proj.depth([(b.0[0] + b.1[0]) * 0.5, (b.0[1] + b.1[1]) * 0.5, (b.0[2] + b.1[2]) * 0.5]);
        if best.is_none_or(|(d, _)| depth < d) {
            best = Some((depth, t));
        }
    }
    // Neighbouring glasses' outlines overlap: of those under the pointer, the one whose middle is
    // nearest it on screen.
    if let Some((_, Target::Glass(_))) = best {
        let middle = |k: usize| proj.project(add(glass_base(k), [0.0, 0.12, 0.0])).map_or(f32::MAX, |q| (q - p).length());
        let under = (0..GLASSES).filter(|&k| outline(proj, target_box(Target::Glass(k))).is_some_and(|poly| inside(&poly, p)));
        if let Some(k) = under.min_by(|&a, &b| middle(a).total_cmp(&middle(b))) {
            best = best.map(|(d, _)| (d, Target::Glass(k)));
        }
    }
    let nearest = |f: &dyn Fn(f32) -> V3| -> f32 {
        let mut near = (f32::MAX, 0.0);
        for i in 0..=60 {
            let u = i as f32 / 60.0;
            if let Some(q) = proj.project(f(u)) {
                let d = (q - p).length();
                if d < near.0 {
                    near = (d, u);
                }
            }
        }
        near.1
    };
    best.map(|(_, t)| match t {
        Target::Basin(_) => Target::Basin(nearest(&|u| basin_point(u * 2.0 - 1.0)) * 2.0 - 1.0),
        Target::Vessel(k, _) => Target::Vessel(k, nearest(&|u| vessel_point(k, u))),
        t => t,
    })
}

/// Where a target is drawn (at rest) for a widget occupying `rect` with the default camera: for
/// tests and automation that want to click it.
pub fn target_screen(rect: Rect, opts: &WaterViewOptions, t: Target) -> Option<Pos2> {
    let proj = Projector::fit(&default_camera(), Layout::new(stage_of(rect, opts), opts.physics_view).scene, FIT);
    let w = match t {
        Target::Basin(x) => basin_point(x),
        Target::Glass(k) => add(glass_base(k), [0.0, 0.12, 0.0]),
        Target::Vessel(k, h) => vessel_point(k, h),
        Target::Rain => add(RAIN, [0.0, 0.08, 0.0]),
        Target::Tub => add(TUB, [0.0, 0.08, 0.0]),
        Target::Brook => add(BROOK, [0.0, 0.08, 0.0]),
        Target::Surf => [-0.6, SURF_BASE + 0.13, -1.7],
    };
    proj.project(w)
}

// ------------------------------------------------------------------------------------------
// Drawing: shared pieces
// ------------------------------------------------------------------------------------------

fn seg(painter: &Painter, proj: &Projector, a: V3, b: V3, width: f32, colour: [f32; 3], alpha: f32) {
    if let (Some(p), Some(q)) = (proj.project(a), proj.project(b)) {
        painter.line_segment([p, q], Stroke::new(width, c32(colour, alpha)));
    }
}

/// A glowing line through world points.
fn line3(painter: &Painter, proj: &Projector, pts: &[V3], glow: f32, core: f32, colour: [f32; 3], alpha: f32) {
    let s: Vec<Pos2> = pts.iter().filter_map(|w| proj.project(*w)).collect();
    if s.len() == pts.len() {
        polyline(painter, &s, glow, core, colour, alpha);
    }
}

/// A horizontal ellipse (circle in the `x z` plane) at `c`, `rx` by `rz`, as world points.
fn ring(c: V3, rx: f32, rz: f32, n: usize) -> Vec<V3> {
    (0..=n).map(|j| {
        let a = TAU * j as f32 / n as f32;
        [c[0] + rx * a.cos(), c[1], c[2] + rz * a.sin()]
    }).collect()
}

fn fill_poly(painter: &Painter, proj: &Projector, pts: &[V3], colour: [f32; 3], alpha: f32) {
    let s: Vec<Pos2> = pts.iter().filter_map(|w| proj.project(*w)).collect();
    if s.len() == pts.len() && s.len() > 2 {
        painter.add(Shape::convex_polygon(hull(s), c32(colour, alpha), Stroke::new(0.0, Color32::TRANSPARENT)));
    }
}

/// A bubble: a glowing ring pulsing (slowed a thousandfold and more) at its size.
fn draw_bubble(painter: &Painter, proj: &Projector, at: V3, d: &BubbleDot, t: f32, seed: f32) {
    let Some(p) = proj.project(at) else { return };
    let depth = proj.depth(at).max(0.1);
    let size = (d.radius * 2.2 * proj.focal / depth).clamp(1.2, 9.0);
    let pulse = 1.0 + 0.18 * d.amp * (TAU * (1.5 + (d.freq / 1000.0).min(6.0)) * t + seed).sin();
    let a = (0.25 + 0.75 * d.amp).clamp(0.0, 1.0);
    let c = pitch_colour(d.freq);
    painter.circle_filled(p, size * pulse * 2.2, c32(c, 0.12 * a));
    painter.circle_stroke(p, size * pulse, Stroke::new(1.0, c32(mix3(c, FOAM, 0.3), 0.35 + 0.6 * a)));
}

// ------------------------------------------------------------------------------------------
// Drawing: the stations
// ------------------------------------------------------------------------------------------

fn draw_table(painter: &Painter, proj: &Projector) {
    // The table's edge and a few boards, under the front row and the back.
    let (x0, x1, z0, z1) = (-1.62, 1.45, -0.85, 0.48);
    line3(painter, proj, &[[x0, 0.0, z1], [x1, 0.0, z1], [x1, 0.0, z0], [x0, 0.0, z0], [x0, 0.0, z1]], 0.0, 1.0, DIM, 0.35);
    for k in 1..6 {
        let z = z0 + (z1 - z0) * k as f32 / 6.0;
        seg(painter, proj, [x0, 0.0, z], [x1, 0.0, z], 1.0, DIM, 0.12);
    }
}

fn draw_basin(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState) {
    let f = &scene.frame;
    let (hx, hz) = (BASIN_HALF[0], BASIN_HALF[1]);
    let corner = |sx: f32, y: f32, sz: f32| -> V3 { [BASIN[0] + sx * hx, y, BASIN[2] + sz * hz] };
    let lit = (scene.state.levels[Source::Drip.index()] * 4.0).sqrt().clamp(0.0, 1.0);
    // The water: a body you can see into, its top, and the tank's edges.
    fill_poly(painter, proj, &[corner(-1.0, 0.0, 1.0), corner(1.0, 0.0, 1.0), corner(1.0, BASIN_WATER, 1.0), corner(-1.0, BASIN_WATER, 1.0)], mix3(BG_BOTTOM, WATER, 0.2 + 0.1 * lit), 0.45);
    fill_poly(painter, proj, &[corner(-1.0, BASIN_WATER, -1.0), corner(1.0, BASIN_WATER, -1.0), corner(1.0, BASIN_WATER, 1.0), corner(-1.0, BASIN_WATER, 1.0)], mix3(BG_TOP, WATER, 0.25 + 0.15 * lit), 0.4);
    let edges = |y: f32| vec![corner(-1.0, y, -1.0), corner(1.0, y, -1.0), corner(1.0, y, 1.0), corner(-1.0, y, 1.0), corner(-1.0, y, -1.0)];
    line3(painter, proj, &edges(0.0), 0.0, 1.0, HEAD, 0.35);
    line3(painter, proj, &edges(BASIN_TOP), 3.0, 1.2, HEAD, 0.45);
    for (sx, sz) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
        seg(painter, proj, corner(sx, 0.0, sz), corner(sx, BASIN_TOP, sz), 1.0, HEAD, 0.35);
    }
    // The surface: the ripples of each drop spreading, and the waterline.
    for &(x, age) in st.ripples.iter() {
        if age > 2.0 {
            continue;
        }
        let c = [BASIN[0] + (x * BASIN_SCALE).clamp(-hx + 0.02, hx - 0.02), BASIN_WATER, BASIN[2]];
        for k in 0..3 {
            let r = 0.015 + 0.16 * (age - 0.12 * k as f32).max(0.0);
            if r > 0.015 {
                let fade = (1.0 - age / 2.0).powi(2) * (1.0 - 0.3 * k as f32);
                let pts: Vec<V3> = ring(c, r, r * 0.8, 40).into_iter().map(|p| [p[0].clamp(BASIN[0] - hx, BASIN[0] + hx), p[1], p[2].clamp(BASIN[2] - hz, BASIN[2] + hz)]).collect();
                line3(painter, proj, &pts, 3.0, 1.0, FOAM, 0.6 * fade);
            }
        }
    }
    line3(painter, proj, &edges(BASIN_WATER), 3.0, 1.3, WATER, 0.55 + 0.4 * lit);
    // The bubbles, each where it is.
    for (i, d) in f.bubbles[..f.n_bubbles].iter().enumerate() {
        let x = (d.pan * BASIN_SCALE).clamp(-hx + 0.01, hx - 0.01);
        let y = BASIN_WATER - (d.depth * BUBBLE_DEPTH_SCALE).min(BASIN_WATER - 0.01);
        // Spread a little front to back so a crowd of bubbles reads as one.
        let z = BASIN[2] + 0.5 * hz * ((i as f32 * 0.618_034).fract() * 2.0 - 1.0);
        draw_bubble(painter, proj, [BASIN[0] + x, y, z], d, st.t, i as f32);
    }
    // The tap: a post at the basin's back left, its arm out over where the last drop fell.
    let tap_x = if st.drips > 0 { (f.drip_x * BASIN_SCALE).clamp(-hx + 0.02, hx - 0.02) } else { 0.0 };
    let post = [BASIN[0] - hx, 0.0, BASIN[2] - hz];
    let elbow = [BASIN[0] - hx, TAP_Y, BASIN[2] - hz];
    let nozzle = [BASIN[0] + tap_x, TAP_Y, BASIN[2]];
    line3(painter, proj, &[post, elbow, [nozzle[0], TAP_Y, BASIN[2] - hz], nozzle, add(nozzle, [0.0, -0.025, 0.0])], 4.0, 1.8, DIM, 0.85);
    if st.drips > 0 {
        if let Some(p) = proj.project(add(nozzle, [0.0, -0.03, 0.0])) {
            painter.circle_filled(p, 2.5, c32(WATER, 0.9));
        }
    }
    if let Some(&(x, age)) = st.ripples.iter().min_by(|a, b| a.1.total_cmp(&b.1)) {
        if age < 0.45 {
            let xv = BASIN[0] + (x * BASIN_SCALE).clamp(-hx + 0.02, hx - 0.02);
            let k = 1.0 - age / 0.45;
            // A streak as long as its speed, falling into the water; the splash's crown.
            let len = (0.05 + 0.1 * f.drip_speed).min(0.2);
            let top = BASIN_WATER + len * (1.0 - age / 0.45).max(0.2);
            seg(painter, proj, [xv, top, BASIN[2]], [xv, BASIN_WATER + 0.004, BASIN[2]], 3.5, FOAM, 0.2 * k);
            seg(painter, proj, [xv, top, BASIN[2]], [xv, BASIN_WATER + 0.004, BASIN[2]], 1.2, FOAM, 0.7 * k);
            for j in 0..6 {
                let a = TAU * j as f32 / 6.0;
                let r = 0.012 + 0.04 * age;
                seg(painter, proj, [xv, BASIN_WATER, BASIN[2]], [xv + r * a.cos(), BASIN_WATER + 0.03 * k, BASIN[2] + 0.8 * r * a.sin()], 1.0, FOAM, 0.6 * k);
            }
        }
    }
}

/// A glass: its wall, its rim bending in its modes, the water that tunes it, and the striker.
fn draw_glass(painter: &Painter, proj: &Projector, k: usize, scene: &Scene, st: &ViewState, opts: &WaterViewOptions) {
    let (s, f) = (&scene.state, &scene.frame);
    let base = glass_base(k);
    let pitch = s.glass_pitch[k];
    let real_h = if s.glass_height[k] > 0.0 { s.glass_height[k] } else { 0.10 };
    let h = (real_h * GLASS_SCALE).clamp(0.1, GLASS_BOX.1 - 0.01);
    let r = (f.glass_radius[k] * GLASS_SCALE).clamp(0.035, GLASS_BOX.0 - 0.005);
    let energy = s.glass_energy[k];
    let glow = if pitch > 0.0 { ((energy.max(1.0e-14).log10() + 9.0) / 5.0).clamp(0.0, 1.0) } else { 0.0 };
    // The rim's displacement at angle theta: each mode's order around the rim, its amplitude
    // (against the recent loudest, exaggerated), its ring slowed for the eye. Angle 0 faces the
    // viewer, where the striker lands.
    let bend = |theta: f32| -> f32 {
        let mut w = 0.0;
        for (i, &(amp, hz)) in f.glass_modes[k].iter().enumerate() {
            if amp <= 0.0 || hz <= 0.0 {
                continue;
            }
            let m = (i + 2) as f32;
            let e = 0.16 * opts.exaggeration * amp / st.glass_ref.max(1.0e-9);
            let slow = 1.6 * (hz / f.glass_modes[k][0].1.max(1.0)).sqrt();
            w += e.min(0.25) * (m * theta).cos() * (TAU * slow * st.t).cos();
        }
        w
    };
    let point = |theta: f32, y: f32| -> V3 {
        // The wall bends most at the rim (as `(z / H)^(3/2)`, the model's wall shape).
        let rr = r * (1.0 + bend(theta) * (y / h).clamp(0.0, 1.0).powf(1.5));
        [base[0] + rr * theta.sin(), y, base[2] + rr * theta.cos()]
    };
    let n = 40;
    let rim: Vec<V3> = (0..=n).map(|j| point(TAU * j as f32 / n as f32, h)).collect();
    let foot: Vec<V3> = (0..=n).map(|j| point(TAU * j as f32 / n as f32, 0.0)).collect();
    let col = if pitch > 0.0 { mix3(HEAD, TEAL, 0.35 + 0.4 * glow) } else { DIM };
    // Its water, filled.
    if pitch > 0.0 {
        let level = (s.glass_level[k] / real_h).clamp(0.0, 1.0) * h;
        let wl: Vec<V3> = (0..=n).map(|j| point(TAU * j as f32 / n as f32, level)).collect();
        let mut body = foot.clone();
        body.extend(wl.iter().copied());
        fill_poly(painter, proj, &body, mix3(BG_BOTTOM, WATER, 0.35), 0.5);
        line3(painter, proj, &wl, 3.0, 1.2, WATER, 0.8);
    }
    line3(painter, proj, &foot, 0.0, 1.0, col, 0.45);
    for j in 0..8 {
        let a = TAU * (j as f32 + 0.5) / 8.0;
        let pts: Vec<V3> = (0..=6).map(|i| point(a, h * i as f32 / 6.0)).collect();
        line3(painter, proj, &pts, 0.0, 0.8, col, 0.3 + 0.3 * glow);
    }
    // The rim: lit where it moves outward (amber) and inward (teal), as the kit's heads.
    for j in 0..n {
        let (a0, a1) = (TAU * j as f32 / n as f32, TAU * (j + 1) as f32 / n as f32);
        let w = 0.5 * (bend(a0) + bend(a1));
        let t = (w / 0.12).clamp(-1.0, 1.0);
        let c = if t >= 0.0 { mix3(col, AMBER, t) } else { mix3(col, TEAL, -t) };
        if let (Some(p), Some(q)) = (proj.project(rim[j]), proj.project(rim[j + 1])) {
            if glow > 0.05 {
                painter.line_segment([p, q], Stroke::new(3.0 + 4.0 * glow, c32(c, 0.12 + 0.2 * glow)));
            }
            painter.line_segment([p, q], Stroke::new(1.5, c32(mix3(c, [1.0; 3], 0.2), 0.6 + 0.4 * glow)));
        }
    }
    // Its pitch under it.
    if pitch > 0.0 {
        if let Some(p) = proj.project(add(base, [0.0, 0.0, r + 0.04])) {
            painter.text(p, Align2::CENTER_TOP, note_name(pitch), FontId::proportional(9.0), c32(mix3(LABEL_C, TEAL, glow), 0.9));
        }
    }
    draw_glass_striker(painter, proj, k, r, h, st);
}

const LABEL_C: [f32; 3] = [0.67, 0.69, 0.80];

/// The mallet or spoon replaying the glass's latest strike, slowed so its millisecond on the rim
/// can be seen.
fn draw_glass_striker(painter: &Painter, proj: &Projector, k: usize, r: f32, h: f32, st: &ViewState) {
    let rp = st.replay[k];
    if rp.seen == 0 || rp.t > 1.0 {
        return;
    }
    let base = glass_base(k);
    let contact = (rp.contact_ms / 1000.0 * 40.0).clamp(0.05, 0.3);
    let away = if rp.t < contact {
        0.0
    } else {
        let bounce = (rp.speed_out / rp.speed_in.max(1.0e-3)).clamp(0.0, 1.2);
        (0.1 * bounce * ((rp.t - contact) / 0.3).min(1.0) + 0.08 * ((rp.t - contact - 0.3) / 0.4).clamp(0.0, 1.0)).min(0.14)
    };
    let fade = (1.0 - (rp.t - 0.6).max(0.0) / 0.4).clamp(0.0, 1.0);
    let hit = [base[0], h * 0.92, base[2] + r];
    let tip = add(hit, [0.0, 0.25 * away, away]);
    let hand = add(tip, [0.1, 0.16, 0.12]);
    if rp.t < contact + 0.1 {
        if let Some(p) = proj.project(hit) {
            let kf = 1.0 - (rp.t / (contact + 0.1)).clamp(0.0, 1.0);
            let rr = 3.0 + 2.5 * (1.0 + rp.force).log10();
            painter.circle_filled(p, rr * 2.0, c32(AMBER, 0.18 * kf));
            painter.circle_filled(p, rr, c32([1.0, 0.95, 0.85], 0.6 * kf));
        }
    }
    if let (Some(p), Some(q)) = (proj.project(tip), proj.project(hand)) {
        let c = if rp.spoon { [0.85, 0.87, 0.95] } else { [0.95, 0.85, 0.65] };
        painter.line_segment([p, q], Stroke::new(4.0, c32(AMBER, 0.1 * fade)));
        painter.line_segment([p, q], Stroke::new(if rp.spoon { 1.4 } else { 1.8 }, c32(c, 0.85 * fade)));
        if rp.spoon {
            painter.circle_stroke(p, 3.5, Stroke::new(1.4, c32(c, 0.9 * fade)));
        } else {
            painter.circle_filled(p, 4.0, c32([0.9, 0.55, 0.45], 0.9 * fade));
        }
    }
}

/// A vessel being filled: its shape, its water rising, the stream, the bubbles, and the air
/// column's lowest mode.
fn draw_vessel(painter: &Painter, proj: &Projector, k: usize, scene: &Scene, st: &ViewState) {
    let (s, f) = (&scene.state, &scene.frame);
    let [radius, height, neck_r, neck_l] = f.fill_shape[k];
    let has_neck = neck_r > 0.0 && neck_l > 0.0;
    let total = height + if has_neck { neck_l } else { 0.0 };
    let sc = VESSEL_H / total.max(1.0e-3);
    let (br, bh) = ((radius * sc).min(VESSEL_BOX - 0.005), height * sc);
    let nr = if has_neck { (neck_r * sc).min(br) } else { br };
    let base = VESSELS[k];
    let lit = (s.levels[Source::Fill.index()] * 4.0).sqrt().clamp(0.0, 1.0) * if s.filling[k] { 1.0 } else { 0.4 };
    let radius_at = |y: f32| if y <= bh || !has_neck { br } else { nr };
    let circle = |y: f32, r: f32| ring(add(base, [0.0, y, 0.0]), r, r, 36);
    let level = (f.fill_level_m[k] * sc).clamp(0.0, VESSEL_H);
    let col = mix3(HEAD, SKY, 0.3 + 0.5 * lit);
    // The water.
    if level > 0.001 {
        let mut body = circle(0.0, br);
        body.extend(circle(level, radius_at(level)));
        fill_poly(painter, proj, &body, mix3(BG_BOTTOM, WATER, 0.35), 0.5);
        if level > bh && has_neck {
            let mut neck = circle(bh, nr);
            neck.extend(circle(level, nr));
            fill_poly(painter, proj, &neck, mix3(BG_BOTTOM, WATER, 0.4), 0.5);
        }
        line3(painter, proj, &circle(level, radius_at(level)), 3.0, 1.3, WATER, 0.85);
    }
    // The air column above the water, glowing with its lowest mode: a quarter wave, its pressure
    // greatest at the water and nothing at the mouth (its motion the other way round).
    let air = f.fill_air[k][0];
    if air > 0.0 && level < VESSEL_H - 0.005 && (s.filling[k] || level > 0.001) {
        let a = if s.filling[k] { 0.8 } else { 0.35 };
        let n = 10;
        for i in 0..n {
            let u = (i as f32 + 0.5) / n as f32;
            let y = level + (VESSEL_H - level) * u;
            let pressure = (0.5 * PI * u).cos() * (TAU * 2.0 * st.t).sin().abs();
            let r = radius_at(y) * 0.8;
            line3(painter, proj, &circle(y, r), 0.0, 1.0, mix3(SKY, AMBER, pressure), a * (0.15 + 0.5 * pressure));
        }
        if let Some(p) = proj.project(add(base, [0.0, VESSEL_H + 0.03, 0.0])) {
            painter.text(p, Align2::CENTER_BOTTOM, format!("{} ({:.0} Hz)", note_name(air), air), FontId::proportional(9.0), c32(mix3(LABEL_C, SKY, lit), 0.95));
        }
    }
    // The bubbles the stream drags under.
    for (i, d) in f.fill_bubbles[k][..f.n_fill_bubbles[k]].iter().enumerate() {
        let ang = i as f32 * 2.399_963;
        let rr = radius_at(0.0) * 0.6 * (i as f32 * 0.618_034).fract();
        let y = (level - d.depth * sc * 6.0).clamp(0.005, level.max(0.005));
        draw_bubble(painter, proj, add(base, [rr * ang.cos(), y, rr * ang.sin()]), d, st.t, i as f32);
    }
    // The glass.
    line3(painter, proj, &circle(0.0, br), 0.0, 1.0, col, 0.5);
    line3(painter, proj, &circle(bh, br), 0.0, 1.0, col, 0.5);
    if has_neck {
        line3(painter, proj, &circle(bh, nr), 0.0, 1.0, col, 0.5);
    }
    line3(painter, proj, &circle(VESSEL_H, nr), 3.0, 1.4, col, 0.7);
    for j in 0..10 {
        let a = TAU * (j as f32 + 0.5) / 10.0;
        let at = |r: f32, y: f32| add(base, [r * a.cos(), y, r * a.sin()]);
        seg(painter, proj, at(br, 0.0), at(br, bh), 0.9, col, 0.35);
        if has_neck {
            seg(painter, proj, at(br, bh), at(nr, bh), 0.9, col, 0.35);
            seg(painter, proj, at(nr, bh), at(nr, VESSEL_H), 0.9, col, 0.35);
        }
    }
    // The stream, from a spout above the mouth, as thick as its flow.
    if f.fill_flow[k] > 0.0 {
        let from = (f.fill_from[k] * sc).clamp(VESSEL_H + 0.04, VESSEL_H + 0.18);
        let top = add(base, [0.0, from, 0.0]);
        let bottom = add(base, [0.0, level, 0.0]);
        let w = (2.0 + 1.5e3 * f.fill_flow[k].sqrt()).clamp(1.5, 7.0);
        if let (Some(p), Some(q)) = (proj.project(top), proj.project(bottom)) {
            painter.line_segment([p, q], Stroke::new(w * 2.5, c32(WATER, 0.18)));
            painter.line_segment([p, q], Stroke::new(w, c32(mix3(WATER, FOAM, 0.4), 0.85)));
        }
        seg(painter, proj, top, add(top, [-0.08, 0.035, 0.0]), 4.0, DIM, 0.8);
        // Where it plunges in, foam.
        line3(painter, proj, &ring(bottom, 0.02 + 0.01 * (TAU * 3.0 * st.t).sin().abs(), 0.02, 16), 2.5, 1.0, FOAM, 0.7);
    }
    if let Some(p) = proj.project(add(base, [0.0, 0.0, br + 0.05])) {
        painter.text(p, Align2::CENTER_TOP, format!("{:.0} cm", total * 100.0), FontId::proportional(9.0), c32(LABEL_C, 0.8));
    }
}

/// Where a raindrop landing at `(u, v)` (fractions of the face's radius) meets each surface, and
/// the surface's outline.
fn rain_point(target: RainTarget, u: f32, v: f32) -> V3 {
    let r = RAIN_R;
    match target {
        RainTarget::Lake => [RAIN[0] + u * r, 0.015, RAIN[2] + v * r * 0.9],
        // A pane leaning back like a skylight.
        RainTarget::Window => {
            let (x, y) = (u * r * 0.75, v * r * 0.75);
            [RAIN[0] + x, 0.2 + 0.7 * y, RAIN[2] - 0.7 * y]
        }
        // A roof panel pitched a little toward the viewer.
        RainTarget::Roof => [RAIN[0] + u * r, 0.16 - 0.12 * v, RAIN[2] + v * r * 0.9],
        // A tent: its ridge along x, its fly falling away on both sides.
        RainTarget::Tent => [RAIN[0] + u * r, 0.32 - 0.28 * v.abs(), RAIN[2] + v * r * 0.8],
        RainTarget::Cymbal => {
            let d = (u * u + v * v).sqrt().min(1.0);
            [RAIN[0] + u * r * 0.85, 0.3 + 0.03 * (1.0 - d), RAIN[2] + v * r * 0.85]
        }
        RainTarget::Drum => [RAIN[0] + u * r * 0.7, 0.3, RAIN[2] + v * r * 0.7],
    }
}

fn draw_rain(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState) {
    let (s, f) = (&scene.state, &scene.frame);
    let target = f.rain_target;
    let lit = if target == RainTarget::Lake {
        ((f.rain_bubbles as f32).sqrt() / 12.0).clamp(0.0, 1.0)
    } else {
        ((f.rain_energy / st.rain_ref.max(1.0e-12)).max(1.0e-6).log10() / 3.0 + 1.0).clamp(0.0, 1.0) * if f.rain_energy > 1.0e-12 { 1.0 } else { 0.0 }
    };
    let col = mix3(DIM, VIOLET, 0.4 + 0.6 * lit);
    let outline = |n: usize| -> Vec<V3> {
        (0..=n).map(|j| {
            let a = TAU * j as f32 / n as f32;
            rain_point(target, a.cos(), a.sin())
        }).collect()
    };
    match target {
        RainTarget::Lake => {
            let o = outline(48);
            fill_poly(painter, proj, &o, mix3(BG_TOP, WATER, 0.2 + 0.2 * lit), 0.45);
            line3(painter, proj, &o, 3.0, 1.2, WATER, 0.5 + 0.4 * lit);
            for k in 1..3 {
                let c = RAIN;
                line3(painter, proj, &ring([c[0], 0.015, c[2]], RAIN_R * k as f32 / 3.0, RAIN_R * 0.9 * k as f32 / 3.0, 40), 0.0, 0.8, WATER, 0.15);
            }
        }
        RainTarget::Window | RainTarget::Roof => {
            let q = |u: f32, v: f32| rain_point(target, u, v);
            let frame = [q(-1.0, -1.0), q(1.0, -1.0), q(1.0, 1.0), q(-1.0, 1.0), q(-1.0, -1.0)];
            fill_poly(painter, proj, &frame, mix3(BG_TOP, col, 0.2 + 0.2 * lit), 0.4);
            line3(painter, proj, &frame, 3.0, 1.4, col, 0.6 + 0.4 * lit);
            if target == RainTarget::Roof {
                // The corrugations.
                for i in 0..9 {
                    let u = -1.0 + 2.0 * (i as f32 + 0.5) / 9.0;
                    seg(painter, proj, q(u, -1.0), q(u, 1.0), 1.0, col, 0.45);
                }
            } else {
                seg(painter, proj, q(0.0, -1.0), q(0.0, 1.0), 1.5, col, 0.5);
            }
            // Legs down to the table.
            for u in [-1.0, 1.0] {
                for v in [-1.0, 1.0] {
                    let p = q(u, v);
                    seg(painter, proj, p, [p[0], 0.0, p[2]], 1.2, DIM, 0.4);
                }
            }
        }
        RainTarget::Tent => {
            let q = |u: f32, v: f32| rain_point(target, u, v);
            for v in [-1.0, 1.0] {
                let side = [q(-1.0, 0.0), q(1.0, 0.0), q(1.0, v), q(-1.0, v)];
                fill_poly(painter, proj, &side, mix3(BG_TOP, col, 0.2 + 0.25 * lit), 0.4);
                line3(painter, proj, &[side[0], side[1], side[2], side[3], side[0]], 3.0, 1.2, col, 0.55 + 0.4 * lit);
                for i in 1..6 {
                    let u = -1.0 + 2.0 * i as f32 / 6.0;
                    seg(painter, proj, q(u, 0.0), q(u, v), 0.8, col, 0.3);
                }
            }
        }
        RainTarget::Cymbal | RainTarget::Drum => {
            let o = outline(48);
            let c = add(RAIN, [0.0, 0.3, 0.0]);
            if target == RainTarget::Drum {
                let shell: Vec<V3> = o.iter().map(|p| [p[0], 0.12, p[2]]).collect();
                line3(painter, proj, &shell, 0.0, 1.0, col, 0.4);
                for j in (0..48).step_by(4) {
                    seg(painter, proj, o[j], shell[j], 0.9, col, 0.35);
                }
                for j in 0..3 {
                    let a = TAU * j as f32 / 3.0 + 0.4;
                    let p = [RAIN[0] + RAIN_R * 0.72 * a.cos(), 0.14, RAIN[2] + RAIN_R * 0.72 * a.sin()];
                    seg(painter, proj, p, [p[0], 0.0, p[2]], 1.4, DIM, 0.45);
                }
            } else {
                seg(painter, proj, c, [c[0], 0.0, c[2]], 2.0, DIM, 0.5);
            }
            fill_poly(painter, proj, &o, mix3(BG_BOTTOM, if target == RainTarget::Cymbal { BRASS } else { HEAD }, 0.15 + 0.25 * lit), 0.5);
            line3(painter, proj, &o, 4.0, 1.5, if target == RainTarget::Cymbal { mix3(BRASS, col, 0.3) } else { col }, 0.6 + 0.4 * lit);
        }
    }
    // Rain falling: as many streaks as the rain is heavy (more drops, and larger), falling into
    // the places the simulation's last drops landed.
    let rate = s.rain_rate;
    if rate > 0.0 {
        let n = ((1.0 + rate).ln() * 9.0).clamp(4.0, 48.0) as usize;
        for i in 0..n {
            let speed = 1.3 + 0.4 * (i as f32 * 0.37).fract();
            let phase = st.t * speed + i as f32 * 0.618_034;
            let cyc = phase.floor();
            let u = hash(i as f32 * 12.9898 + cyc * 78.233) * 2.0 - 1.0;
            let v = hash(i as f32 * 39.346 + cyc * 11.135) * 2.0 - 1.0;
            let (u, v) = if u * u + v * v > 1.0 { (u * 0.7, v * 0.7) } else { (u, v) };
            let land = rain_point(target, u, v);
            let y = land[1] + 0.6 * (1.0 - phase.fract());
            let len = 0.02 + 0.03 * (rate / 20.0).min(1.0);
            seg(painter, proj, [land[0], y + len, land[2]], [land[0], y, land[2]], 1.0, [0.7, 0.75, 1.0], 0.45);
        }
    }
    // Splashes where the drops landed.
    for (i, p) in f.rain_recent.iter().enumerate() {
        let age = st.splash_age[i];
        if age > 0.5 {
            continue;
        }
        let at = rain_point(target, p[0], p[1]);
        let k = 1.0 - age / 0.5;
        if target == RainTarget::Lake {
            line3(painter, proj, &ring(at, 0.01 + 0.05 * age, 0.008 + 0.04 * age, 16), 0.0, 1.0, FOAM, 0.7 * k);
        } else if let Some(q) = proj.project(at) {
            painter.circle_filled(q, 2.0 + 5.0 * age, c32(FOAM, 0.25 * k));
            painter.circle_filled(q, 1.5, c32(FOAM, 0.9 * k));
        }
    }
}

/// A line of moving water: bed and surface along it, extruded across its width; `along(i)` places
/// profile point `i` and `across` the width direction.
struct Line<'a> {
    surface: &'a [f32; PROFILE],
    bed: &'a [f32; PROFILE],
    breaking: bool,
}

impl Line<'_> {
    /// Whether the water between points `i` and `i + 1` is a breaking jump (the model's own
    /// criterion: depths across it in a ratio past `BREAKING`).
    fn jump(&self, i: usize) -> bool {
        let (h0, h1) = (self.surface[i] - self.bed[i], self.surface[i + 1] - self.bed[i + 1]);
        let (lo, hi) = (h0.min(h1), h0.max(h1));
        self.breaking && lo > 1.0e-3 && hi / lo > BREAKING
    }

    fn wet(&self, i: usize) -> bool {
        self.surface[i] - self.bed[i] > 2.0e-4
    }
}

fn draw_line_water(painter: &Painter, proj: &Projector, line: &Line, at: &dyn Fn(usize, f32, f32) -> V3, slices: &[f32], lit: f32, water: [f32; 3], t: f32) {
    // The bed.
    for &w in slices.iter().step_by(slices.len().max(2) - 1) {
        let pts: Vec<V3> = (0..PROFILE).map(|i| at(i, line.bed[i], w)).collect();
        line3(painter, proj, &pts, 0.0, 1.0, SAND, 0.5);
    }
    // The water: a filled side, then the surface at each slice across, and cross lines.
    let side: Vec<V3> = (0..PROFILE).filter(|&i| line.wet(i)).flat_map(|i| [at(i, line.bed[i], slices[slices.len() - 1]), at(i, line.surface[i], slices[slices.len() - 1])]).collect();
    for pair in side.chunks(2).collect::<Vec<_>>().windows(2) {
        let quad = [pair[0][0], pair[1][0], pair[1][1], pair[0][1]];
        fill_poly(painter, proj, &quad, mix3(BG_BOTTOM, water, 0.25 + 0.15 * lit), 0.35);
    }
    for &w in slices {
        let mut run: Vec<V3> = Vec::new();
        for i in 0..PROFILE {
            if line.wet(i) {
                run.push(at(i, line.surface[i], w));
            } else if !run.is_empty() {
                line3(painter, proj, &run, 3.0, 1.1, water, 0.35 + 0.55 * lit);
                run.clear();
            }
        }
        if run.len() > 1 {
            line3(painter, proj, &run, 3.0, 1.1, water, 0.35 + 0.55 * lit);
        }
    }
    let (first, last) = (slices[0], slices[slices.len() - 1]);
    for i in (0..PROFILE).step_by(4) {
        if line.wet(i) {
            seg(painter, proj, at(i, line.surface[i], first), at(i, line.surface[i], last), 0.8, water, 0.2 + 0.3 * lit);
        } else {
            seg(painter, proj, at(i, line.bed[i], first), at(i, line.bed[i], last), 0.8, SAND, 0.3);
        }
    }
    // Each crest, all the way across: the waves as they come in.
    for i in 1..PROFILE - 1 {
        let (a, b, c) = (line.surface[i - 1], line.surface[i], line.surface[i + 1]);
        if line.wet(i) && b > a && b >= c && b - a.min(c) > 1.0e-4 {
            let (p, q) = (at(i, b, first), at(i, b, last));
            seg(painter, proj, p, q, 4.0, water, 0.12 * lit);
            seg(painter, proj, p, q, 1.3, mix3(water, FOAM, 0.35), 0.4 + 0.5 * lit);
        }
    }
    // Foam on every breaking jump: where the bubbles come from.
    for i in 0..PROFILE - 1 {
        if line.jump(i) {
            for (j, &w) in slices.iter().enumerate() {
                let p = at(i, line.surface[i].max(line.surface[i + 1]), w);
                if let Some(q) = proj.project(p) {
                    let flicker = 0.6 + 0.4 * (t * 23.0 + i as f32 * 1.7 + j as f32).sin().abs();
                    painter.circle_filled(q, 5.0 * flicker, c32(FOAM, 0.15 * lit.max(0.3)));
                    painter.circle_filled(q, 1.8, c32(FOAM, 0.9 * flicker * lit.max(0.3)));
                }
            }
        }
    }
}

fn draw_flecks(painter: &Painter, proj: &Projector, flecks: &[(f32, f32); FLECKS], line: &Line, at: &dyn Fn(usize, f32, f32) -> V3, lit: f32) {
    for fl in flecks {
        let i = ((fl.0 * (PROFILE - 1) as f32) as usize).min(PROFILE - 1);
        if !line.wet(i) {
            continue;
        }
        if let Some(q) = proj.project(at(i, line.surface[i], fl.1)) {
            painter.circle_filled(q, 1.4, c32(FOAM, 0.7 * lit));
        }
    }
}

fn draw_brook(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState) {
    let f = &scene.frame;
    let lit = (0.25 + 0.75 * f.brook_fader).clamp(0.0, 1.0);
    let at = |i: usize, h: f32, w: f32| -> V3 {
        let u = i as f32 / (PROFILE - 1) as f32;
        [BROOK[0] - 0.5 * BROOK_LEN + u * BROOK_LEN, 0.02 + h * BROOK_UP, BROOK[2] + w * BROOK_WIDE]
    };
    // Banks.
    for w in [-1.0f32, 1.0] {
        seg(painter, proj, at(0, 0.0, w * 1.25), at(PROFILE - 1, 0.0, w * 1.25), 1.0, SAND, 0.35);
    }
    let line = Line { surface: &f.brook_surface, bed: &f.brook_bed, breaking: f.brook_bores > 0 && f.brook_fader > 0.0 };
    if f.brook_surface.iter().all(|v| *v == 0.0) {
        return;
    }
    draw_line_water(painter, proj, &line, &at, &[-1.0, -0.33, 0.33, 1.0], lit, colour(Source::Brook), st.t);
    draw_flecks(painter, proj, &st.brook_flecks, &line, &at, lit);
}

fn draw_surf(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState) {
    let f = &scene.frame;
    if f.surf_surface.iter().all(|v| *v == 0.0) {
        return;
    }
    let lit = (0.2 + 0.8 * f.surf_fader).clamp(0.0, 1.0);
    // The sea's still level on the base line; the beach rising toward the table.
    let still = f.surf_surface[0].max(f.surf_bed[0] + 0.1);
    let at = |i: usize, h: f32, w: f32| -> V3 {
        let u = i as f32 / (PROFILE - 1) as f32;
        [w * SURF_X, SURF_BASE + 0.13 + (h - still) * SURF_UP, SURF_Z.0 + u * (SURF_Z.1 - SURF_Z.0)]
    };
    let line = Line { surface: &f.surf_surface, bed: &f.surf_bed, breaking: f.surf_bores > 0 && f.surf_fader > 0.0 };
    draw_line_water(painter, proj, &line, &at, &[-1.0, -0.6, -0.2, 0.2, 0.6, 1.0], lit, colour(Source::Surf), st.t);
    draw_flecks(painter, proj, &st.surf_flecks, &line, &at, lit);
}

fn draw_tub(painter: &Painter, proj: &Projector, scene: &Scene, st: &ViewState) {
    let f = &scene.frame;
    let lit = (scene.state.levels[Source::Slosh.index()] * 4.0).sqrt().clamp(0.0, 1.0).max(if scene.state.slosh > 0.0 { 0.5 } else { 0.2 });
    let (len, wide, wall) = (0.4 * TUB_SCALE, 0.25 * TUB_SCALE * 0.5, 0.14 * TUB_SCALE);
    let shift = f.tub_pose.0 * TUB_SCALE * TUB_SHAKE;
    let at = |i: usize, h: f32, w: f32| -> V3 {
        let u = i as f32 / (PROFILE - 1) as f32;
        [TUB[0] - 0.5 * len + u * len + shift, 0.012 + h * TUB_SCALE, TUB[2] + w * wide]
    };
    let corner = |sx: f32, y: f32, sz: f32| -> V3 { [TUB[0] + sx * 0.5 * len + shift, y, TUB[2] + sz * wide] };
    let rim = |y: f32| vec![corner(-1.0, y, -1.0), corner(1.0, y, -1.0), corner(1.0, y, 1.0), corner(-1.0, y, 1.0), corner(-1.0, y, -1.0)];
    let col = mix3(DIM, BRASS, 0.3 + 0.5 * lit);
    line3(painter, proj, &rim(0.0), 0.0, 1.0, col, 0.5);
    for (sx, sz) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
        seg(painter, proj, corner(sx, 0.0, sz), corner(sx, wall, sz), 1.0, col, 0.5);
    }
    if f.tub_surface.iter().any(|v| *v != 0.0) {
        let line = Line { surface: &f.tub_surface, bed: &f.tub_bed, breaking: f.tub_bores > 0 };
        draw_line_water(painter, proj, &line, &at, &[-1.0, 0.0, 1.0], lit, colour(Source::Slosh).map(|c| c * 0.4 + 0.3), st.t);
    }
    line3(painter, proj, &rim(wall), 3.0, 1.3, col, 0.7);
}

// ------------------------------------------------------------------------------------------
// Readout and panels
// ------------------------------------------------------------------------------------------

/// `hz` as the nearest note (A4 = 440).
pub fn note_name(hz: f32) -> String {
    if hz <= 0.0 {
        return String::new();
    }
    const NAMES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    let midi = (69.0 + 12.0 * (hz / 440.0).log2()).round() as i32;
    format!("{}{}", NAMES[midi.rem_euclid(12) as usize], midi.div_euclid(12) - 1)
}

fn draw_readout(painter: &Painter, lay: &Layout, scene: &Scene, opts: &WaterViewOptions) {
    let (s, f) = (&scene.state, &scene.frame);
    let mut y = lay.readout.y;
    let line = |txt: String, y: &mut f32, c: Color32| {
        painter.text(pos2(lay.readout.x, *y), Align2::LEFT_TOP, txt, FontId::proportional(11.0), c);
        *y += 15.0;
    };
    if let Some(st) = &opts.status {
        line(st.clone(), &mut y, c32(AMBER, 0.95));
    }
    let mut any = false;
    if s.drips > 0 && (s.bubbles > 0 || s.levels[Source::Drip.index()] > 1.0e-3) {
        any = true;
        let d = f.drip_radius * 2000.0;
        line(format!("DRIP  {:.1} mm drop at {:.2} m/s (from {:.0} cm) - bubble born at {:.0} Hz, {} ringing", d, f.drip_speed, f.drip_height * 100.0, s.last_drip, s.bubbles), &mut y, c32(WATER, 0.95));
    }
    let ringing: Vec<usize> = (0..GLASSES).filter(|&k| s.glass_pitch[k] > 0.0 && s.glass_energy[k] > 1.0e-12).collect();
    if let Some(&k) = ringing.iter().max_by(|a, b| s.glass_energy[**a].total_cmp(&s.glass_energy[**b])) {
        any = true;
        line(format!("GLASS  {} ({:.0} Hz): {:.0} mm of water in {:.0} - {} at {:.2} m/s, {:.1} ms on the rim, out at {:.2}", note_name(s.glass_pitch[k]), s.glass_pitch[k], s.glass_level[k] * 1000.0, s.glass_height[k] * 1000.0, if f.glass_spoon[k] { "spoon" } else { "mallet" }, f.glass_speed_in[k], f.glass_contact_ms[k], f.glass_speed_out[k]), &mut y, c32(TEAL, 0.95));
    }
    for k in 0..FILLS {
        if s.filling[k] {
            any = true;
            line(format!("FILL  {:.0}% full - the air rings at {:.0} Hz ({}), rising", s.fill_level[k] * 100.0, s.fill_pitch[k], note_name(s.fill_pitch[k])), &mut y, c32(SKY, 0.95));
        }
    }
    if s.rain_rate > 0.0 {
        any = true;
        line(format!("RAIN  {:.1} mm/h on the {} - {:.0} drops so far", s.rain_rate, f.rain_target.name(), s.raindrops), &mut y, c32(VIOLET, 0.95));
    }
    if f.brook_fader > 0.01 {
        any = true;
        line(format!("BROOK  {:.2} m/s over the rocks - its jumps dissipating {:.1} W", s.brook_speed, s.brook_dissipation), &mut y, c32(colour(Source::Brook), 0.95));
    }
    if f.surf_fader > 0.01 {
        any = true;
        line(format!("SURF  {:.1} m waves - {} breakers so far", s.surf_height, s.surf_breakers), &mut y, c32(colour(Source::Surf), 0.95));
    }
    if s.slosh > 0.0 || f.tub_bores > 0 {
        any = true;
        line(format!("TUB  shaken at {:.0}% of what slops it over - {} bores breaking", s.slosh * 100.0, f.tub_bores), &mut y, c32(BRASS, 0.95));
    }
    if !any {
        line("click the basin to drip - a glass to strike it - a vessel to fill it; hold the rain, brook or beach; drag the tub".into(), &mut y, LABEL);
    }
}

/// The physics panels' frequency axis (log), Hz.
const HZ: (f32, f32) = (80.0, 16_000.0);

fn hz_to_x(plot: Rect, hz: f32) -> f32 {
    let (lo, hi) = HZ;
    plot.min.x + (hz.clamp(lo, hi).ln() - lo.ln()) / (hi.ln() - lo.ln()) * plot.width()
}

fn hz_axis(painter: &Painter, r: Rect, plot: Rect) {
    for (hz, t) in [(100.0f32, "100"), (1000.0, "1k"), (10_000.0, "10k Hz")] {
        painter.text(pos2(hz_to_x(plot, hz), r.max.y - 3.0), Align2::CENTER_BOTTOM, t, FontId::proportional(8.0), LABEL);
    }
}

fn draw_bubble_panel(painter: &Painter, r: Rect, scene: &Scene) {
    let f = &scene.frame;
    panel(painter, r, "BUBBLES RINGING");
    let plot = inner(r);
    let mut n = 0;
    let mut bar = |d: &BubbleDot| {
        if d.freq <= 0.0 {
            return;
        }
        n += 1;
        let x = hz_to_x(plot, d.freq);
        let t = ((20.0 * d.amp.max(1.0e-6).log10() + 60.0) / 60.0).clamp(0.0, 1.0);
        let y = plot.max.y - t * plot.height();
        let c = pitch_colour(d.freq);
        painter.line_segment([pos2(x, plot.max.y), pos2(x, y)], Stroke::new(3.0, c32(c, 0.15 + 0.2 * t)));
        painter.line_segment([pos2(x, plot.max.y), pos2(x, y)], Stroke::new(1.0, c32(c, 0.5 + 0.5 * t)));
    };
    for d in &f.bubbles[..f.n_bubbles] {
        bar(d);
    }
    for k in 0..FILLS {
        for d in &f.fill_bubbles[k][..f.n_fill_bubbles[k]] {
            bar(d);
        }
    }
    if scene.state.last_drip > 0.0 {
        let x = hz_to_x(plot, scene.state.last_drip);
        painter.line_segment([pos2(x, plot.min.y), pos2(x, plot.max.y)], Stroke::new(1.0, c32(ROSE, 0.5)));
    }
    hz_axis(painter, r, plot);
    painter.text(pos2(plot.max.x, r.min.y + 5.0), Align2::RIGHT_TOP, format!("{n} shown, dB from birth"), FontId::proportional(8.5), LABEL);
}

fn draw_resonances(painter: &Painter, r: Rect, scene: &Scene) {
    let (s, f) = (&scene.state, &scene.frame);
    panel(painter, r, "GLASS WALLS AND AIR COLUMNS");
    let plot = inner(r);
    let top = f.glass_modes.iter().flatten().fold(1.0e-12f32, |m, v| m.max(v.0));
    for k in 0..GLASSES {
        if s.glass_pitch[k] <= 0.0 {
            continue;
        }
        for &(amp, hz) in &f.glass_modes[k] {
            if hz <= 0.0 {
                continue;
            }
            let x = hz_to_x(plot, hz);
            let t = if amp > 0.0 { ((20.0 * (amp / top).log10() + 60.0) / 60.0).clamp(0.0, 1.0) } else { 0.0 };
            let y = plot.max.y - (0.04 + 0.96 * t) * plot.height();
            painter.line_segment([pos2(x, plot.max.y), pos2(x, y)], Stroke::new(1.2, c32(TEAL, 0.35 + 0.6 * t)));
        }
    }
    for k in 0..FILLS {
        if !s.filling[k] {
            continue;
        }
        for (i, &hz) in f.fill_air[k].iter().enumerate() {
            if hz > 0.0 {
                let x = hz_to_x(plot, hz);
                let h = plot.height() * (0.9 - 0.2 * i as f32);
                painter.line_segment([pos2(x, plot.max.y), pos2(x, plot.max.y - h)], Stroke::new(if i == 0 { 2.0 } else { 1.0 }, c32(SKY, if i == 0 { 0.9 } else { 0.5 })));
            }
        }
    }
    hz_axis(painter, r, plot);
    painter.text(pos2(plot.max.x, r.min.y + 5.0), Align2::RIGHT_TOP, "walls m = 2, 3, 4 - air", FontId::proportional(8.5), LABEL);
}

fn draw_levels(painter: &Painter, r: Rect, scene: &Scene, st: &ViewState) {
    panel(painter, r, "LEVEL OF EACH SOURCE");
    let plot = inner(r);
    let h = plot.height() / SOURCES as f32;
    let top = st.level_top.log10();
    for (i, src) in Source::ALL.iter().enumerate() {
        let v = scene.state.levels[i];
        let y = plot.min.y + h * i as f32;
        // Six decades down from the loudest.
        let t = if v > 0.0 { ((v.log10() - top + 3.0) / 3.0).clamp(0.0, 1.0) } else { 0.0 };
        let bar = Rect::from_min_max(pos2(plot.min.x + 34.0, y + 2.0), pos2(plot.min.x + 34.0 + t * (plot.width() - 34.0), y + h - 2.0));
        painter.rect_filled(bar, 2u8, c32(colour(*src), 0.25 + 0.5 * t));
        painter.text(pos2(r.min.x + 8.0, y + h * 0.5), Align2::LEFT_CENTER, label(*src), FontId::proportional(8.0), if t > 0.05 { c32(colour(*src), 1.0) } else { LABEL });
    }
}

fn draw_pads(painter: &Painter, pads: &[(Source, Rect); SOURCES], scene: &Scene) {
    for (s, r) in pads {
        let lit = (scene.state.levels[s.index()] * 6.0).sqrt().clamp(0.0, 1.0);
        painter.rect_filled(*r, 6u8, c32(mix3([0.07, 0.07, 0.13], colour(*s), 0.15 + 0.6 * lit), 0.95));
        painter.rect_stroke(*r, 6u8, Stroke::new(1.0 + 1.5 * lit, c32(colour(*s), 0.5 + 0.5 * lit)), crate::entropy_gui::geometry::StrokeKind::Middle);
        painter.text(r.center(), Align2::CENTER_CENTER, label(*s), FontId::proportional(10.0), if lit > 0.4 { Color32::from_rgb(12, 14, 26) } else { c32(colour(*s), 1.0) });
    }
}

/// A cheap hash to `0..1`.
fn hash(x: f32) -> f32 {
    (x.sin() * 43_758.547).fract().abs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_target_is_found_where_it_is_drawn() {
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(1100.0, 640.0));
        let opts = WaterViewOptions::default();
        let stage = stage_of(rect, &opts);
        let proj = Projector::fit(&default_camera(), Layout::new(stage, false).scene, FIT);
        let mut targets: Vec<Target> = (0..GLASSES).map(Target::Glass).collect();
        targets.extend([Target::Basin(-0.5), Target::Basin(0.6), Target::Vessel(0, 0.3), Target::Vessel(1, 0.8), Target::Rain, Target::Tub, Target::Brook, Target::Surf]);
        for t in targets {
            let p = target_screen(rect, &opts, t).expect("on screen");
            assert!(stage.contains(p), "{t:?} at {p:?}");
            let found = target_at(&proj, p).unwrap_or_else(|| panic!("nothing found at {t:?}"));
            match (t, found) {
                (Target::Basin(a), Target::Basin(b)) => assert!((a - b).abs() < 0.1, "basin {a} found at {b}"),
                (Target::Vessel(a, ha), Target::Vessel(b, hb)) => {
                    assert_eq!(a, b);
                    assert!((ha - hb).abs() < 0.1, "vessel {a}: height {ha} found at {hb}");
                }
                (a, b) => assert_eq!(a, b),
            }
        }
    }

    #[test]
    fn pads_tile_the_bottom_row() {
        let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(700.0, 400.0));
        let pads = pad_rects(rect);
        for w in pads.windows(2) {
            assert!(w[0].1.max.x <= w[1].1.min.x);
        }
        assert!(pads.iter().all(|(_, r)| r.min.y >= 400.0 - PAD_H));
    }

    #[test]
    fn notes_are_named() {
        assert_eq!(note_name(440.0), "A4");
        assert_eq!(note_name(261.63), "C4");
        assert_eq!(note_name(0.0), "");
    }

    #[test]
    fn a_hull_is_convex_and_holds_its_points() {
        let pts = vec![pos2(0.0, 0.0), pos2(4.0, 0.0), pos2(4.0, 4.0), pos2(0.0, 4.0), pos2(2.0, 2.0), pos2(1.0, 3.0)];
        let h = hull(pts);
        assert_eq!(h.len(), 4);
        assert!(inside(&h, pos2(2.0, 2.0)));
        assert!(!inside(&h, pos2(5.0, 2.0)));
    }
}
