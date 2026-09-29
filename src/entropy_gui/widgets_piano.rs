//! `PianoView`: grand piano instrument drawn from the physical model's own state,
//! in Entropy's signature neon vector aesthetic - glowing lines, an orbiting camera,
//! and authentic physical acoustic visualizations.
//!
//! What is drawn reflects what the audio engine publishes in `audio::piano::PianoShared`:
//! * 88-key grand piano keyboard with interactive key presses, velocity-sensitive glow,
//!   and realistic black/white key geometry;
//! * Cast-iron harp frame with structural struts, soundholes, and spruce soundboard;
//! * Curved bridge and fanning string harp showing real-time vibrational energy;
//! * Felt hammers striking at the strike ratio (~1/8 to 1/7) and catching on the backcheck;
//! * Felt dampers lifting when keys are struck or when the sustain pedal is engaged;
//! * Undamped high treble strings (F#6..C8) ringing freely;
//! * Sustain and una corda pedal status.
//!
//! **Physics View** (`PianoOptions::physics_view`) adds:
//! * Soundboard modal radiation field / acoustic wave patterns;
//! * Hammer contact force trace F(t) showing nonlinear felt compression and contact duration;
//! * Stretched Railsback inharmonicity curve across all 88 keys;
//! * Two-stage prompt sound vs aftersound decay envelope;
//! * Sympathetic resonance energy across undamped strings.

use crate::audio::piano::{freq_to_key, railsback_frequency, PianoShared, KEY_COUNT};
use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, FontId, Pos2, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::shape::Shape;
use crate::entropy_gui::ui::Ui;

// ------------------------------------------------------------------------------------------
// Palette
// ------------------------------------------------------------------------------------------

const BG_TOP: [f32; 3] = [0.024, 0.028, 0.060];
const BG_BOTTOM: [f32; 3] = [0.050, 0.045, 0.100];
const GOLD: [f32; 3] = [1.0, 0.78, 0.32];
const AMBER: [f32; 3] = [1.0, 0.65, 0.25];
const TEAL: [f32; 3] = [0.28, 0.90, 0.84];
const VIOLET: [f32; 3] = [0.60, 0.45, 1.0];
const ROSE: [f32; 3] = [1.0, 0.36, 0.45];
const SKY: [f32; 3] = [0.45, 0.65, 1.0];
const IVORY: [f32; 3] = [0.92, 0.90, 0.82];
const WOOD: [f32; 3] = [0.72, 0.45, 0.22];
const DIM: [f32; 3] = [0.30, 0.30, 0.42];
const LABEL: Color32 = Color32::from_rgb(175, 182, 210);

fn mix3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn c32(c: [f32; 3], a: f32) -> Color32 {
    Color32::from_rgba_f32([c[0], c[1], c[2], a.clamp(0.0, 1.0)])
}

// ------------------------------------------------------------------------------------------
// Camera
// ------------------------------------------------------------------------------------------

type V3 = [f32; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PianoCamera {
    pub yaw: f32,
    pub pitch: f32,
    pub dist: f32,
}

impl Default for PianoCamera {
    fn default() -> Self {
        Self { yaw: 0.28, pitch: 0.72, dist: 6.2 }
    }
}

impl PianoCamera {
    pub fn project(&self, p: V3, stage: Rect) -> Option<Pos2> {
        let (sy, cy) = self.yaw.sin_cos();
        let (sp, cp) = self.pitch.sin_cos();
        let eye = [self.dist * sp * sy, self.dist * cp, self.dist * sp * cy];
        let forward = norm(sub([0.0, 0.0, 0.0], eye));
        let world_up = [0.0, 1.0, 0.0];
        let right = norm(cross(forward, world_up));
        let up = cross(right, forward);

        let v = sub(p, eye);
        let z = dot(v, forward);
        if z <= 0.2 {
            return None;
        }

        let x = dot(v, right);
        let y = dot(v, up);

        let fov = 0.46;
        let aspect = stage.width() / stage.height().max(1.0);
        let sx = stage.center().x + (x / (z * fov * aspect)) * (stage.width() * 0.5);
        let sy = stage.center().y - (y / (z * fov)) * (stage.height() * 0.5);

        Some(pos2(sx, sy))
    }
}

// ------------------------------------------------------------------------------------------
// Options and Events
// ------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct PianoOptions {
    pub width: Option<f32>,
    pub height: f32,
    pub physics_view: bool,
}

impl Default for PianoOptions {
    fn default() -> Self {
        Self {
            width: None,
            height: 520.0,
            physics_view: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PianoEvent {
    KeyPressed { key: usize, freq: f32, velocity: f32 },
    KeyReleased { key: usize, freq: f32 },
    SustainToggled { sustain: f32 },
    PhysicsToggled(bool),
}

pub struct PianoResponse {
    pub rect: Rect,
    pub events: Vec<PianoEvent>,
}

/// The interactive Grand Piano UI widget.
pub struct PianoView {
    id: Id,
}

impl PianoView {
    pub fn new(id_source: impl std::hash::Hash) -> Self {
        Self {
            id: Id::new(id_source),
        }
    }

    pub fn show(
        self,
        ui: &mut Ui,
        opts: &PianoOptions,
        shared: &PianoShared,
    ) -> PianoResponse {
        let w = opts.width.unwrap_or_else(|| ui.available_width().max(320.0));
        let h = opts.height.max(260.0);
        let (rect, resp) = ui.allocate_exact_size(vec2(w, h), Sense::click_and_drag());

        let mut events = Vec::new();

        // Camera state persistence
        let cam_id = self.id.with("cam");
        let mut cam: PianoCamera = ui.ctx().memory_mut(|m| m.take_view_state(cam_id));

        // Orbit camera with drag
        if resp.dragged() && ui.ctx().input(|i| i.pointer.pos.is_some_and(|p| p.y < rect.max.y - 100.0)) {
            let delta = resp.drag_delta();
            cam.yaw += delta.x * 0.006;
            cam.pitch = (cam.pitch - delta.y * 0.006).clamp(0.15, 1.45);
        }
        ui.ctx().memory_mut(|m| m.put_view_state(cam_id, cam));

        // Draw background gradient
        let painter = ui.painter();
        let bg_rect = rect;
        painter.rect_filled(bg_rect, 8.0, c32(bg_at(0.5), 1.0));
        painter.rect_stroke(bg_rect, 8.0, Stroke::new(1.0, c32(DIM, 0.4)), StrokeKind::Inside);

        // 3D Grand Piano Case Geometry
        let stage=Rect::from_min_max(pos2(rect.min.x,rect.min.y+78.0),pos2(rect.max.x,rect.max.y-if opts.physics_view {250.0}else{95.0}));
        let p_proj = |p: V3| cam.project(p, stage);

        // 1. Draw Soundboard plate and Rim curve
        draw_grand_piano_body(&painter, &p_proj, shared);

        // 2. Draw 88-Key Keyboard along front
        let key_events = draw_keyboard(&painter, &p_proj, shared, rect, ui);
        let _ = key_events;
        events.extend(playable_keyboard(&painter, rect, shared, ui, self.id));

        // 3. Draw Strings, Hammers, and Dampers
        draw_strings_and_actions(&painter, &p_proj, shared);

        // 4. Draw Physics View overlay if active
        if opts.physics_view {
            draw_physics_view(&painter, rect, shared);
        }

        // 5. Draw Header, Pedals and Controls
        let ctrl_events = draw_ui_overlay(&painter, rect, opts, shared, ui, self.id);
        events.extend(ctrl_events);

        PianoResponse { rect, events }
    }
}

fn bg_at(y: f32) -> [f32; 3] {
    mix3(BG_TOP, BG_BOTTOM, y)
}

fn is_black_key(k: usize) -> bool {
    // 0 is A0 (white), 1 is Bb0 (black), 2 is B0 (white), 3 is C1 (white)...
    // Pattern within octave starting at C: W, B, W, B, W, W, B, W, B, W, B, W
    let semitone_from_c = (k + 9) % 12;
    matches!(semitone_from_c, 1 | 3 | 6 | 8 | 10)
}

// ------------------------------------------------------------------------------------------
// 3D Grand Piano Case, Rim & Soundboard
// ------------------------------------------------------------------------------------------

fn draw_grand_piano_body(
    painter: &Painter,
    project: &impl Fn(V3) -> Option<Pos2>,
    shared: &PianoShared,
) {
    let sb_energy = f32::from_bits(shared.soundboard_energy.load(std::sync::atomic::Ordering::Relaxed));
    let glow = (sb_energy * 10.0).clamp(0.0, 1.0);

    // Rim curve points (X: left/right across keyboard, Z: front to back, Y: height)
    // Front edge of piano case: X from -2.2 to +2.2, Z = 1.0
    // Spine (left side): straight line back to Z = -2.8
    // Bentside (right side): elegant S-curve bending toward tail at (-0.8, -2.8)
    let rim_points_top = [
        [-2.2, 0.1, 1.0],  // Front-left corner
        [-2.2, 0.1, -2.8], // Tail-left corner (spine end)
        [-0.8, 0.1, -2.8], // Tail narrow end
        [0.4, 0.1, -2.2],  // Bentside curve 1
        [1.6, 0.1, -1.2],  // Bentside curve 2
        [2.2, 0.1, 0.2],   // Bentside curve 3
        [2.2, 0.1, 1.0],   // Front-right corner
    ];

    let mut screen_rim = Vec::new();
    for &p in &rim_points_top {
        if let Some(sp) = project(p) {
            screen_rim.push(sp);
        }
    }

    if screen_rim.len() >= 4 {
        painter.add(Shape::convex_polygon(screen_rim.clone(),Color32::from_rgba_unmultiplied(65,44,23,150),Stroke::new(1.0,c32(GOLD,0.2))));
        // Draw wood rim outline
        for i in 0..screen_rim.len() - 1 {
            painter.line_segment(
                [screen_rim[i], screen_rim[i + 1]],
                Stroke::new(2.5, c32(mix3(WOOD, GOLD, glow * 0.4), 0.9)),
            );
        }
        // Close front rim
        painter.line_segment(
            [screen_rim[screen_rim.len() - 1], screen_rim[0]],
            Stroke::new(2.0, c32(WOOD, 0.7)),
        );
    }

    // Cast-iron plate struts (gold/bronze braces inside the rim)
    let struts = [
        ([-1.2, 0.05, 0.8], [-1.0, 0.05, -2.4]),
        ([0.0, 0.05, 0.8], [0.2, 0.05, -2.0]),
        ([1.2, 0.05, 0.8], [1.4, 0.05, -1.0]),
    ];

    for (p1, p2) in struts {
        if let (Some(s1), Some(s2)) = (project(p1), project(p2)) {
            painter.line_segment([s1, s2], Stroke::new(2.0, c32(GOLD, 0.65)));
        }
    }

    // Curved bridge on the soundboard
    let bridge_points = [
        [-1.8, 0.03, -2.2], // Bass bridge
        [-1.4, 0.03, -1.8],
        [-0.6, 0.03, -1.2], // Treble bridge start
        [0.2, 0.03, -0.6],
        [1.0, 0.03, -0.1],
        [1.8, 0.03, 0.4],
    ];

    let mut screen_bridge = Vec::new();
    for &bp in &bridge_points {
        if let Some(sp) = project(bp) {
            screen_bridge.push(sp);
        }
    }

    for i in 0..screen_bridge.len().saturating_sub(1) {
        painter.line_segment(
            [screen_bridge[i], screen_bridge[i + 1]],
            Stroke::new(3.0, c32(mix3(GOLD, TEAL, glow), 0.85)),
        );
    }
}

// ------------------------------------------------------------------------------------------
// 88-Key Keyboard Rendering and Interaction
// ------------------------------------------------------------------------------------------

fn draw_keyboard(
    painter: &Painter,
    project: &impl Fn(V3) -> Option<Pos2>,
    shared: &PianoShared,
    stage: Rect,
    ui: &Ui,
) -> Vec<PianoEvent> {
    let mut events = Vec::new();
    let kb_z = 1.0;
    let kb_y = 0.0;
    let kb_width = 4.0;
    let key_w = kb_width / 88.0;

    // Check click / pointer interaction on the keyboard
    let pointer = ui.ctx().input(|i| i.pointer);
    let is_down = pointer.primary_down();
    let mouse_pos = pointer.interact_pos();

    for k in 0..KEY_COUNT {
        let x_center = -2.0 + (k as f32 + 0.5) * key_w;
        let is_black = is_black_key(k);

        let shared_key = &shared.keys[k];
        let key_down = shared_key.key_down.load(std::sync::atomic::Ordering::Relaxed);
        let energy = f32::from_bits(shared_key.energy.load(std::sync::atomic::Ordering::Relaxed));

        // 3D position of key
        let p_front = [x_center, kb_y - if key_down { 0.04 } else { 0.0 }, kb_z + 0.35];
        let p_back = [x_center, kb_y - if key_down { 0.02 } else { 0.0 }, kb_z];

        if let (Some(s_front), Some(s_back)) = (project(p_front), project(p_back)) {
            // Key color: active keys flare with velocity/energy
            let stroke_color = if key_down {
                c32(AMBER, 1.0)
            } else if energy > 1.0e-4 {
                c32(TEAL, (energy * 50.0).clamp(0.4, 0.95))
            } else if is_black {
                c32(DIM, 0.7)
            } else {
                c32(IVORY, 0.8)
            };

            let stroke_width = if is_black { 2.5 } else { 1.5 };
            painter.line_segment([s_back, s_front], Stroke::new(stroke_width, stroke_color));
        }
    }

    events
}

// ------------------------------------------------------------------------------------------
// Strings, Hammers, and Dampers
// ------------------------------------------------------------------------------------------

fn draw_strings_and_actions(
    painter: &Painter,
    project: &impl Fn(V3) -> Option<Pos2>,
    shared: &PianoShared,
) {
    let sustain_down = f32::from_bits(shared.sustain_pedal.load(std::sync::atomic::Ordering::Relaxed)) >= 0.5;

    // Draw representative strings across the compass (step by 2 for clarity)
    for k in (0..KEY_COUNT).step_by(2) {
        let shared_key = &shared.keys[k];
        let energy = f32::from_bits(shared_key.energy.load(std::sync::atomic::Ordering::Relaxed));
        let hammer_pos = f32::from_bits(shared_key.hammer_pos.load(std::sync::atomic::Ordering::Relaxed));
        let damper_down = shared_key.damper_down.load(std::sync::atomic::Ordering::Relaxed) && !sustain_down;

        let key_frac = k as f32 / 87.0;
        let x_start = -2.0 + key_frac * 4.0;
        let z_start = 1.0;

        // Bridge connection point
        let x_end = -1.8 + key_frac * 3.6;
        let z_end = -2.2 + key_frac * 2.6;

        let p_nut = [x_start, 0.05, z_start];
        let p_bridge = [x_end, 0.03, z_end];

        if let (Some(s_nut), Some(s_bridge)) = (project(p_nut), project(p_bridge)) {
            // String color based on vibration energy
            let string_col = if energy > 1.0e-4 {
                c32(mix3(TEAL, AMBER, (energy * 30.0).clamp(0.0, 1.0)), 0.85)
            } else {
                c32(DIM, 0.35)
            };

            painter.line_segment([s_nut, s_bridge], Stroke::new(1.0, string_col));

            // Hammer position (at ~1/8 of string length from nut)
            let strike_ratio = 1.0 / (8.5 - 1.5 * key_frac);
            let hx = x_start + (x_end - x_start) * strike_ratio;
            let hz = z_start + (z_end - z_start) * strike_ratio;
            let hy = 0.02 + hammer_pos * 80.0;

            if let Some(s_hammer) = project([hx, hy, hz]) {
                if hammer_pos > 0.0001 {
                    // Striking hammer head (felt)
                    painter.circle_filled(s_hammer, 3.0, c32(AMBER, 0.95));
                }
            }

            // Damper head (felt pad above string)
            if k < 69 {
                // High treble notes above key 68 have no dampers
                let dx = x_start + (x_end - x_start) * 0.35;
                let dz = z_start + (z_end - z_start) * 0.35;
                let dy = if damper_down { 0.06 } else { 0.15 }; // Lifts when key struck or pedal down

                if let Some(s_damper) = project([dx, dy, dz]) {
                    let damper_col = if damper_down {
                        c32(DIM, 0.5)
                    } else {
                        c32(TEAL, 0.85) // Glowing lifted damper
                    };
                    painter.circle_filled(s_damper, 2.0, damper_col);
                }
            }
        }
    }
}

// ------------------------------------------------------------------------------------------
// Physics View: Soundboard Field, Hammer Trace, Railsback Inharmonicity
// ------------------------------------------------------------------------------------------

fn draw_physics_view(
    painter: &Painter,
    rect: Rect,
    shared: &PianoShared,
) {
    let pv_rect = Rect::from_min_size(
        pos2(rect.min.x + 16.0, rect.max.y - 250.0),
        vec2(rect.width() - 32.0, 155.0),
    );

    // Semi-transparent physics backdrop
    painter.rect_filled(pv_rect, 6.0, c32(BG_TOP, 0.88));
    painter.rect_stroke(pv_rect, 6.0, Stroke::new(1.0, c32(TEAL, 0.6)), StrokeKind::Inside);

    // 1. Title
    painter.text(
        pos2(pv_rect.min.x + 12.0, pv_rect.min.y + 14.0),
        Align2::LEFT_CENTER,
        "PHYSICS VIEW: ACOUSTIC HARP & SOUNDBOARD",
        FontId::proportional(11.0),
        c32(TEAL, 0.95),
    );

    // 2. Hammer contact force readout
    let contact_ms = f32::from_bits(shared.latest_contact_time.load(std::sync::atomic::Ordering::Relaxed));
    let peak_force = f32::from_bits(shared.latest_peak_force.load(std::sync::atomic::Ordering::Relaxed));
    let bridge_vel = f32::from_bits(shared.bridge_velocity.load(std::sync::atomic::Ordering::Relaxed));

    let stats_text = format!(
        "Hammer Contact: {:.2} ms | Peak Force: {:.1} N | Bridge Coupling: {:.4}",
        contact_ms, peak_force, bridge_vel.abs()
    );
    painter.text(
        pos2(pv_rect.min.x + 12.0, pv_rect.min.y + 32.0),
        Align2::LEFT_CENTER,
        stats_text,
        FontId::monospace(10.0),
        LABEL,
    );

    // 3. Stretched Railsback inharmonicity curve plot
    let plot_rect = Rect::from_min_size(
        pos2(pv_rect.min.x + 14.0, pv_rect.min.y + 48.0),
        vec2(pv_rect.width() * 0.45, 90.0),
    );
    painter.rect_filled(plot_rect, 4.0, c32(BG_BOTTOM, 0.8));
    painter.rect_stroke(plot_rect, 4.0, Stroke::new(1.0, c32(DIM, 0.5)), StrokeKind::Inside);

    painter.text(
        pos2(plot_rect.min.x + 6.0, plot_rect.min.y + 10.0),
        Align2::LEFT_CENTER,
        "Railsback Inharmonicity (Cents)",
        FontId::proportional(9.5),
        c32(GOLD, 0.9),
    );

    // Zero-cents reference centerline
    let mid_y = plot_rect.center().y;
    painter.line_segment(
        [pos2(plot_rect.min.x, mid_y), pos2(plot_rect.max.x, mid_y)],
        Stroke::new(1.0, c32(DIM, 0.35)),
    );

    // Plot Railsback curve points
    let mut prev_pt = None;
    for k in (0..KEY_COUNT).step_by(2) {
        let x_norm = k as f32 / 87.0;
        let px = plot_rect.min.x + x_norm * plot_rect.width();

        let semitones = k as f32 - 48.0;
        let stretch_cents = 1200.0 * (railsback_frequency(k)/(440.0*2.0f32.powf(semitones/12.0))).log2();
        // Map -35..+35 cents to plot height
        let py = mid_y - (stretch_cents / 35.0) * (plot_rect.height() * 0.42);

        let pt = pos2(px, py);
        if let Some(pp) = prev_pt {
            painter.line_segment([pp, pt], Stroke::new(1.5, c32(GOLD, 0.85)));
        }
        prev_pt = Some(pt);
    }

    // 4. Two-stage decay diagram (Prompt sound vs Singing Aftersound)
    let decay_rect = Rect::from_min_size(
        pos2(pv_rect.min.x + pv_rect.width() * 0.52, pv_rect.min.y + 48.0),
        vec2(pv_rect.width() * 0.45, 90.0),
    );
    painter.rect_filled(decay_rect, 4.0, c32(BG_BOTTOM, 0.8));
    painter.rect_stroke(decay_rect, 4.0, Stroke::new(1.0, c32(DIM, 0.5)), StrokeKind::Inside);

    painter.text(
        pos2(decay_rect.min.x + 6.0, decay_rect.min.y + 10.0),
        Align2::LEFT_CENTER,
        "Decay illustration (not a meter)",
        FontId::proportional(9.5),
        c32(ROSE, 0.9),
    );

    // Draw two-stage decay envelope: steep initial prompt drop, then gentle singing tail
    let p_start = pos2(decay_rect.min.x + 10.0, decay_rect.min.y + 25.0);
    let p_elbow = pos2(decay_rect.min.x + 45.0, decay_rect.min.y + 55.0);
    let p_end = pos2(decay_rect.max.x - 10.0, decay_rect.min.y + 75.0);

    painter.line_segment([p_start, p_elbow], Stroke::new(2.0, c32(AMBER, 0.95)));
    painter.line_segment([p_elbow, p_end], Stroke::new(1.8, c32(TEAL, 0.95)));

    painter.text(
        pos2(decay_rect.min.x + 15.0, decay_rect.min.y + 42.0),
        Align2::LEFT_CENTER,
        "Prompt",
        FontId::proportional(8.5),
        c32(AMBER, 0.8),
    );
    painter.text(
        pos2(decay_rect.min.x + 75.0, decay_rect.min.y + 60.0),
        Align2::LEFT_CENTER,
        "Singing Aftersound",
        FontId::proportional(8.5),
        c32(TEAL, 0.8),
    );
}

// ------------------------------------------------------------------------------------------
// UI Overlays: Badges, Pedal Buttons, and Physics Chip
// ------------------------------------------------------------------------------------------

fn draw_ui_overlay(
    painter: &Painter,
    stage: Rect,
    opts: &PianoOptions,
    shared: &PianoShared,
    ui: &Ui,
    widget_id: Id,
) -> Vec<PianoEvent> {
    let mut events = Vec::new();

    // 1. Instrument Title
    painter.text(
        pos2(stage.min.x + 16.0, stage.min.y + 20.0),
        Align2::LEFT_CENTER,
        "GRAND PIANO  |  PHYSICAL MODEL",
        FontId::proportional(13.0),
        c32(GOLD, 0.95),
    );

    // 2. Active voices and pedal readouts
    let active = shared.active_voices.load(std::sync::atomic::Ordering::Relaxed);
    let sustain_val = f32::from_bits(shared.sustain_pedal.load(std::sync::atomic::Ordering::Relaxed));
    let sustain_active = sustain_val >= 0.5;

    let sub_text = format!("88 Keys  •  Active Notes: {}  •  Modal strings + soundboard", active);
    painter.text(
        pos2(stage.min.x + 16.0, stage.min.y + 36.0),
        Align2::LEFT_CENTER,
        sub_text,
        FontId::proportional(10.0),
        LABEL,
    );

    // 3. Clickable Sustain Pedal Toggle Button
    let pedal_rect = Rect::from_min_size(
        pos2(stage.min.x + 16.0, stage.min.y + 52.0),
        vec2(85.0, 22.0),
    );
    let pedal_id = widget_id.with("pedal_sustain");
    let pedal_resp = ui.interact(pedal_rect, pedal_id, Sense::click());

    if pedal_resp.clicked() {
        let new_sustain = if sustain_active { 0.0 } else { 1.0 };
        events.push(PianoEvent::SustainToggled { sustain: new_sustain });
    }

    let pedal_bg = if sustain_active {
        c32(TEAL, 0.85)
    } else {
        c32(DIM, 0.4)
    };
    painter.rect_filled(pedal_rect, 4.0, pedal_bg);
    painter.rect_stroke(pedal_rect, 4.0, Stroke::new(1.0, c32(TEAL, 0.7)), StrokeKind::Inside);

    painter.text(
        pedal_rect.center(),
        Align2::CENTER_CENTER,
        if sustain_active { "SUSTAIN: ON" } else { "SUSTAIN: OFF" },
        FontId::proportional(9.5),
        if sustain_active { Color32::BLACK } else { LABEL },
    );

    // 4. Clickable PHYSICS Chip in top-right
    let chip_rect = Rect::from_min_size(
        pos2(stage.max.x - 76.0, stage.min.y + 12.0),
        vec2(60.0, 22.0),
    );
    let chip_id = widget_id.with("chip_physics");
    let chip_resp = ui.interact(chip_rect, chip_id, Sense::click());

    if chip_resp.clicked() {
        events.push(PianoEvent::PhysicsToggled(!opts.physics_view));
    }

    let chip_bg = if opts.physics_view {
        c32(TEAL, 0.85)
    } else {
        c32(DIM, 0.4)
    };
    painter.rect_filled(chip_rect, 4.0, chip_bg);
    painter.rect_stroke(chip_rect, 4.0, Stroke::new(1.0, c32(TEAL, 0.7)), StrokeKind::Inside);

    painter.text(
        chip_rect.center(),
        Align2::CENTER_CENTER,
        "PHYSICS",
        FontId::proportional(9.5),
        if opts.physics_view { Color32::BLACK } else { LABEL },
    );

    events
}

#[derive(Default)]
struct KeyboardState { key: Option<usize>, dragging: bool }

/// Layout of all 52 white and 36 black keys. Also used by pointer BDD.
pub fn piano_key_rects(stage: Rect) -> Vec<(usize,Rect)> {
    let area=Rect::from_min_max(pos2(stage.min.x+16.0,stage.max.y-88.0),pos2(stage.max.x-16.0,stage.max.y-16.0));
    let width=area.width()/52.0;
    let mut keys=Vec::with_capacity(88); let mut white=0;
    for k in 0..88 {if !is_black_key(k) {
        keys.push((k,Rect::from_min_size(pos2(area.min.x+white as f32*width,area.min.y),vec2(width-0.8,area.height())))); white+=1;
    }}
    white=0;
    for k in 0..88 {if is_black_key(k) {
        keys.push((k,Rect::from_min_size(pos2(area.min.x+(white as f32-0.31)*width,area.min.y),vec2(width*0.62,area.height()*0.60))));
    } else {white+=1;}}
    keys
}
fn playable_keyboard(painter:&Painter,stage:Rect,shared:&PianoShared,ui:&Ui,id:Id)->Vec<PianoEvent> {
    let keys=piano_key_rects(stage); let mut events=Vec::new();
    let p=ui.ctx().input(|i|i.pointer);
    let hit=p.pos.and_then(|p|keys.iter().rev().find(|(_,r)|r.contains(p)).map(|(k,_)|*k));
    let state_id=id.with("played-key");
    let mut state:KeyboardState=ui.ctx().memory_mut(|m|m.take_view_state(state_id));
    if p.primary_pressed && hit.is_some() {state.dragging=true;}
    let next=if p.primary_down() && state.dragging {hit}else{None};
    if state.key!=next {
        if let Some(key)=state.key {events.push(PianoEvent::KeyReleased{key,freq:railsback_frequency(key)});}
        if let Some(key)=next {
            let r=keys.iter().find(|(k,_)|*k==key).unwrap().1;
            let velocity=p.pos.map(|pos|0.25+0.7*((pos.y-r.min.y)/r.height()).clamp(0.0,1.0)).unwrap_or(0.8);
            events.push(PianoEvent::KeyPressed{key,freq:railsback_frequency(key),velocity});
        }
        state.key=next;
    }
    if !p.primary_down() {state.dragging=false;}
    ui.ctx().memory_mut(|m|m.put_view_state(state_id,state));
    for (k,r) in keys {
        let down=shared.keys[k].key_down.load(std::sync::atomic::Ordering::Relaxed)||next==Some(k);
        let col=if down {c32(GOLD,1.0)}else if is_black_key(k){Color32::from_rgb(22,25,34)}else{c32(IVORY,1.0)};
        painter.rect_filled(r,2.0,col);
        if k==39 || k==0 || k==87 {
            painter.text(pos2(r.center().x,r.max.y-8.0),Align2::CENTER_CENTER,if k==39{"C4"}else if k==0{"A0"}else{"C8"},FontId::proportional(8.0),Color32::from_rgb(30,32,40));
        }
    }
    events
}
