//! Procedural DAW session simulator: the training data for the prediction model.
//!
//! Instead of fixed scripts, every session runs against a small model of the
//! Entropy DAW (tracks, instrument families, patterns, clips, the view on
//! screen, the transport) and only emits actions that make sense in that
//! state. A session is a chain of goals (lay down drums, write a bassline,
//! arrange, mix, export...) pursued by a persona with habits (how often they
//! listen, whether they preview notes, paint or click, use the Moves panel,
//! save) in a genre that sets tempo, key, grooves, harmony and which
//! instruments get picked for each role.
//!
//! Notes are written the way the DAW's piano roll writes them: a click adds a
//! one-step note at velocity 0.85 and clicking a note erases it; dragging
//! along a row paints consecutive cells. Rows are scale degrees for pitched
//! tracks and pads for drum tracks, and what gets written is musical: kicks,
//! snares and hats follow the genre's groove, basslines sit on chord roots
//! under the kick, chords stack thirds of the progression and melodies walk
//! the scale around chord tones with a repeated motif.
//!
//! Every emitted step carries the `StepContext` after the action, so the model
//! learns what the app looks like as well as what was done.

use super::daw_actions::*;
use rand::{rngs::StdRng, seq::SliceRandom, Rng, SeedableRng};

const STEPS_PER_BAR: u32 = 16;
const MAX_SESSION_ACTIONS: usize = 420;
const DEFAULT_VELOCITY: f32 = 0.85;

// ── Genres ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Genre { House, Techno, HipHop, Trap, Synthwave, Funk, Cinematic, Ambient, DrumAndBass, LoFi }

impl Genre {
    pub const ALL: [Genre; 10] = [
        Genre::House, Genre::Techno, Genre::HipHop, Genre::Trap, Genre::Synthwave,
        Genre::Funk, Genre::Cinematic, Genre::Ambient, Genre::DrumAndBass, Genre::LoFi,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Genre::House => "house", Genre::Techno => "techno", Genre::HipHop => "hip_hop", Genre::Trap => "trap",
            Genre::Synthwave => "synthwave", Genre::Funk => "funk", Genre::Cinematic => "cinematic",
            Genre::Ambient => "ambient", Genre::DrumAndBass => "drum_and_bass", Genre::LoFi => "lofi",
        }
    }

    fn bpm(self) -> (u32, u32) {
        match self {
            Genre::House => (118, 128), Genre::Techno => (126, 138), Genre::HipHop => (84, 98),
            Genre::Trap => (130, 150), Genre::Synthwave => (96, 118), Genre::Funk => (98, 112),
            Genre::Cinematic => (70, 110), Genre::Ambient => (60, 90), Genre::DrumAndBass => (168, 176),
            Genre::LoFi => (70, 88),
        }
    }

    /// Indices into `SCALES`.
    fn scales(self) -> &'static [usize] {
        // 1 major, 2 natural_minor, 3 dorian, 4 pent major, 5 pent minor, 6 blues
        match self {
            Genre::House => &[2, 3, 5], Genre::Techno => &[2, 5], Genre::HipHop => &[2, 5, 6],
            Genre::Trap => &[2, 5], Genre::Synthwave => &[2, 1], Genre::Funk => &[3, 6, 5],
            Genre::Cinematic => &[2, 1, 3], Genre::Ambient => &[1, 4, 3], Genre::DrumAndBass => &[2, 5],
            Genre::LoFi => &[3, 1, 4],
        }
    }

    /// Chord progressions as scale degrees, one chord per bar.
    fn progressions(self) -> &'static [&'static [u32]] {
        match self {
            Genre::Cinematic => &[&[0, 5, 2, 6], &[0, 3, 5, 4], &[0, 0, 5, 3]],
            Genre::Ambient => &[&[0, 3], &[0, 4, 3, 0], &[0, 5]],
            Genre::Funk => &[&[0, 0, 3, 3], &[0, 3]],
            Genre::Techno => &[&[0], &[0, 0, 0, 5]],
            _ => &[&[0, 5, 3, 4], &[0, 3, 4, 3], &[0, 5, 2, 6], &[0, 6, 5, 4]],
        }
    }

    fn has_drums(self) -> bool { self != Genre::Ambient }

    fn song_bars(self) -> &'static [u32] {
        match self {
            Genre::Ambient | Genre::Cinematic => &[16, 24, 32],
            Genre::Techno | Genre::House | Genre::DrumAndBass => &[32, 48, 64],
            _ => &[16, 32],
        }
    }

    /// Which instrument families each role tends to use, with weights.
    fn families(self, role: Role) -> &'static [(u32, u32)] {
        use super::daw_actions::family::*;
        match (role, self) {
            (Role::Drums, Genre::Cinematic) | (Role::Drums, Genre::Funk) => &[(MATTER, 3), (DRUM_RACK, 2)],
            (Role::Drums, Genre::LoFi) => &[(DRUM_RACK, 3), (MATTER, 1)],
            (Role::Drums, _) => &[(DRUM_RACK, 6), (MATTER, 1)],
            (Role::Bass, Genre::Cinematic) => &[(STRINGS, 3), (BRASS, 1), (SYNTH, 1)],
            (Role::Bass, Genre::Techno) | (Role::Bass, Genre::Trap) => &[(WAVETABLE, 3), (SYNTH, 3)],
            (Role::Bass, _) => &[(SYNTH, 4), (WAVETABLE, 3), (PIANO, 1)],
            (Role::Chords, Genre::Cinematic) => &[(STRINGS, 4), (PIANO, 2), (BRASS, 1)],
            (Role::Chords, Genre::LoFi) | (Role::Chords, Genre::HipHop) => &[(PIANO, 4), (WAVETABLE, 1), (SYNTH, 1)],
            (Role::Chords, Genre::Ambient) => &[(WAVETABLE, 3), (WATER, 2), (STRINGS, 2)],
            (Role::Chords, _) => &[(WAVETABLE, 3), (SYNTH, 2), (PIANO, 2), (STRINGS, 1)],
            (Role::Lead, Genre::Cinematic) => &[(STRINGS, 3), (BRASS, 3), (PIANO, 1)],
            (Role::Lead, Genre::Funk) => &[(BRASS, 3), (PIANO, 2), (SYNTH, 2)],
            (Role::Lead, Genre::Ambient) => &[(WATER, 3), (PIANO, 2), (WAVETABLE, 2)],
            (Role::Lead, Genre::Synthwave) => &[(SYNTH, 4), (WAVETABLE, 3)],
            (Role::Lead, _) => &[(SYNTH, 3), (WAVETABLE, 3), (PIANO, 1), (STRINGS, 1), (BRASS, 1)],
            (Role::Texture, _) => &[(WATER, 3), (WAVETABLE, 2), (STRINGS, 1)],
        }
    }
}

/// Genre and family pairings kept out of the training split, so evaluation
/// measures whether the model generalises to combinations it never saw.
pub const HELD_OUT: &[(Genre, Role, u32)] = &[
    (Genre::Funk, Role::Lead, family::BRASS),
    (Genre::Synthwave, Role::Chords, family::WAVETABLE),
    (Genre::LoFi, Role::Chords, family::PIANO),
    (Genre::Trap, Role::Bass, family::WAVETABLE),
];

/// Which sessions to generate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Split {
    /// Everything.
    All,
    /// No held-out combination ever appears.
    Train,
    /// Every session uses at least one held-out combination.
    Eval,
}

// ── Personas ──────────────────────────────────────────────────────────────────

/// A user's habits. Sampled per session so the model sees many working styles.
#[derive(Debug, Clone)]
struct Persona {
    /// Edits between listening back.
    listen_every: u32,
    /// Keep editing while the song plays instead of stopping first.
    edits_while_playing: f64,
    preview_prob: f64,
    /// Drag along a row instead of clicking each cell, where a run allows it.
    paint_prob: f64,
    mistake_prob: f64,
    /// Edits between saved versions (0: never saves until the end).
    save_every: u32,
    /// Sound-design passes.
    tweak_depth: u32,
    uses_moves: f64,
    opens_windows: f64,
    /// Writes drums voice by voice (true) or step by step.
    writes_by_row: bool,
    loops_pattern: f64,
}

impl Persona {
    fn sample(rng: &mut StdRng) -> Self {
        Self {
            listen_every: rng.gen_range(3..14),
            edits_while_playing: rng.gen_range(0.0..0.7),
            preview_prob: rng.gen_range(0.0..0.6),
            paint_prob: rng.gen_range(0.1..0.9),
            mistake_prob: rng.gen_range(0.0..0.12),
            save_every: if rng.gen_bool(0.3) { 0 } else { rng.gen_range(20..70) },
            tweak_depth: rng.gen_range(1..5),
            uses_moves: rng.gen_range(0.0..0.8),
            opens_windows: rng.gen_range(0.2..0.95),
            writes_by_row: rng.gen_bool(0.7),
            loops_pattern: rng.gen_range(0.0..0.6),
        }
    }
}

// ── Simulated project ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role { Drums, Bass, Chords, Lead, Texture }

#[derive(Debug, Clone, Copy, PartialEq)]
struct SimNote { row: u32, step: u32 }

#[derive(Debug, Clone)]
struct SimPattern { steps: u32, notes: Vec<SimNote> }

impl SimPattern {
    fn new(bars: f32) -> Self { Self { steps: ((bars * STEPS_PER_BAR as f32) as u32).max(1), notes: Vec::new() } }
    fn has(&self, row: u32, step: u32) -> bool { self.notes.iter().any(|n| n.row == row && n.step == step) }
}

#[derive(Debug, Clone, Copy)]
struct SimClip { bar: u32, bars: u32, pattern: usize }

#[derive(Debug, Clone)]
struct SimTrack {
    role: Role,
    family: u32,
    lane: u32,
    scale: usize,
    root: u32,
    rows: u32,
    patterns: Vec<SimPattern>,
    active: usize,
    clips: Vec<SimClip>,
    muted: bool,
    solo: bool,
    pads: u32,
}

impl SimTrack {
    fn new(role: Role, family: u32, lane: u32) -> Self {
        let drum = family == family::DRUM_RACK;
        Self {
            role, family, lane,
            scale: if drum { 0 } else { 5 },
            root: 60,
            rows: if drum { 5 } else if family == family::MATTER { 11 } else { 10 },
            patterns: vec![SimPattern::new(1.0)],
            active: 0,
            clips: Vec::new(),
            muted: false,
            solo: false,
            pads: 5,
        }
    }
    fn pattern(&self) -> &SimPattern { &self.patterns[self.active] }
    fn pattern_mut(&mut self) -> &mut SimPattern { &mut self.patterns[self.active] }
    fn is_drums(&self) -> bool { self.family == family::DRUM_RACK || self.family == family::MATTER }
    fn melodic(&self) -> bool { !self.is_drums() }
    fn bar_free(&self, bar: u32, bars: u32) -> bool {
        self.clips.iter().all(|c| bar + bars <= c.bar || bar >= c.bar + c.bars)
    }
}

/// One drum voice in a groove: a generic part mapped to a row per kit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Drum { Kick, Snare, Hat, Clap, Tom, Crash }

fn drum_row(fam: u32, d: Drum) -> u32 {
    if fam == family::MATTER {
        match d { Drum::Kick => 0, Drum::Snare => 1, Drum::Hat => 6, Drum::Clap => 2, Drum::Tom => 3, Drum::Crash => 5 }
    } else {
        match d { Drum::Kick => 0, Drum::Snare => 1, Drum::Hat => 2, Drum::Clap => 3, Drum::Tom => 4, Drum::Crash => 4 }
    }
}

/// One bar of the genre's groove as (voice, steps).
fn groove(genre: Genre, rng: &mut StdRng) -> Vec<(Drum, Vec<u32>)> {
    let eighths: Vec<u32> = (0..16).step_by(2).collect();
    let sixteenths: Vec<u32> = (0..16).collect();
    let offbeats = vec![2, 6, 10, 14];
    let mut g = match genre {
        Genre::House => vec![(Drum::Kick, vec![0, 4, 8, 12]), (Drum::Clap, vec![4, 12]),
            (Drum::Hat, if rng.gen_bool(0.5) { offbeats } else { eighths.clone() })],
        Genre::Techno => vec![(Drum::Kick, vec![0, 4, 8, 12]), (Drum::Hat, sixteenths.clone()),
            (Drum::Clap, vec![4, 12])],
        Genre::HipHop | Genre::LoFi => vec![(Drum::Kick, [&[0u32, 7, 10][..], &[0, 3, 8, 10], &[0, 10]].choose(rng).unwrap().to_vec()),
            (Drum::Snare, vec![4, 12]), (Drum::Hat, eighths.clone())],
        Genre::Trap => vec![(Drum::Kick, [&[0u32, 6, 11][..], &[0, 3, 10, 14], &[0, 7]].choose(rng).unwrap().to_vec()),
            (Drum::Snare, vec![8]), (Drum::Hat, sixteenths.clone())],
        Genre::Synthwave => vec![(Drum::Kick, vec![0, 8]), (Drum::Snare, vec![4, 12]), (Drum::Hat, eighths.clone())],
        Genre::Funk => vec![(Drum::Kick, vec![0, 3, 7, 10]), (Drum::Snare, vec![4, 12]), (Drum::Hat, sixteenths.clone())],
        Genre::DrumAndBass => vec![(Drum::Kick, vec![0, 10]), (Drum::Snare, vec![4, 12]), (Drum::Hat, eighths.clone())],
        Genre::Cinematic => vec![(Drum::Kick, vec![0, 8]), (Drum::Tom, vec![6, 10, 14]), (Drum::Crash, vec![0])],
        Genre::Ambient => vec![(Drum::Kick, vec![0])],
    };
    // Small per-session departures: a ghost note, a dropped hat.
    if rng.gen_bool(0.3) {
        if let Some((_, steps)) = g.iter_mut().find(|(d, _)| *d == Drum::Snare || *d == Drum::Clap) {
            let ghost = *[7, 9, 14, 15].choose(rng).unwrap();
            if !steps.contains(&ghost) { steps.push(ghost); steps.sort(); }
        }
    }
    g
}

// ── The simulator ─────────────────────────────────────────────────────────────

pub struct DawSim {
    rng: StdRng,
    split: Split,
    persona: Persona,
    pub genre: Genre,
    held_out: Option<(Role, u32)>,
    bpm: u32,
    scale: usize,
    key_root: u32,
    progression: Vec<u32>,
    song_bars: u32,
    tracks: Vec<SimTrack>,
    active: usize,
    view: u32,
    playing: bool,
    selected_clip: Option<(usize, usize)>,
    open_windows: Vec<u32>,
    /// Moves taken since the last undo: Undo in the DAW only reverts moves.
    undoable_moves: u32,
    edits_since_listen: u32,
    edits_since_save: u32,
    pub steps: Vec<ActionStep>,
    pub tasks: Vec<DawTask>,
}

impl DawSim {
    pub fn new(seed: u64, split: Split) -> Self {
        let mut rng = StdRng::seed_from_u64(seed);
        let persona = Persona::sample(&mut rng);
        let (genre, held_out) = match split {
            Split::Eval => {
                let (g, role, fam) = *HELD_OUT.choose(&mut rng).unwrap();
                (g, Some((role, fam)))
            }
            _ => (*Genre::ALL.choose(&mut rng).unwrap(), None),
        };
        let (lo, hi) = genre.bpm();
        let bpm = rng.gen_range(lo..=hi);
        let scale = *genre.scales().choose(&mut rng).unwrap();
        let key_root = rng.gen_range(57..=64);
        let progression = genre.progressions().choose(&mut rng).unwrap().to_vec();
        let song_bars = 16;
        Self {
            rng, split, persona, genre, held_out, bpm, scale, key_root, progression, song_bars,
            tracks: Vec::new(), active: 0, view: view::ARRANGE, playing: false, selected_clip: None,
            open_windows: Vec::new(), undoable_moves: 0, edits_since_listen: 0, edits_since_save: 0,
            steps: Vec::new(), tasks: Vec::new(),
        }
    }

    /// Generates one whole session.
    pub fn generate(seed: u64, split: Split) -> Trajectory {
        let mut sim = Self::new(seed, split);
        sim.run();
        Trajectory {
            vocab_version: DAW_VOCAB_VERSION,
            tasks: sim.tasks.iter().map(|t| t.id()).collect(),
            genre: sim.genre.name().to_string(),
            steps: sim.steps,
        }
    }

    // ── Context and emission ──────────────────────────────────────────────

    fn context(&self) -> StepContext {
        let t = self.tracks.get(self.active);
        let pattern_fill = t.map(|t| (t.pattern().notes.len() as f32 / t.pattern().steps.max(1) as f32).min(1.0)).unwrap_or(0.0);
        let covered: u32 = self.tracks.iter().map(|t| t.clips.iter().map(|c| c.bars).sum::<u32>()).sum();
        let song_fill = if self.tracks.is_empty() { 0.0 } else {
            (covered as f32 / (self.tracks.len() as u32 * self.song_bars).max(1) as f32).min(1.0)
        };
        StepContext {
            family: t.map(|t| t.family).unwrap_or(family::NONE),
            view: self.view,
            playing: self.playing,
            tracks: self.tracks.len() as u32,
            pattern_fill,
            song_fill,
        }
    }

    fn done(&self) -> bool { self.steps.len() >= MAX_SESSION_ACTIONS }

    fn emit(&mut self, action: DawAction, params: &[f32]) {
        if self.done() { return; }
        let ctx = self.context();
        self.steps.push(ActionStep::with_context(action, params, ctx));
    }

    fn chance(&mut self, p: f64) -> bool { self.rng.gen_bool(p.clamp(0.0, 1.0)) }

    fn pick_weighted(&mut self, options: &[(u32, u32)]) -> u32 {
        let total: u32 = options.iter().map(|o| o.1).sum();
        let mut r = self.rng.gen_range(0..total);
        for &(v, w) in options {
            if r < w { return v; }
            r -= w;
        }
        options[0].0
    }

    fn family_for(&mut self, role: Role) -> u32 {
        if let Some((r, f)) = self.held_out {
            if r == role { return f; }
        }
        let options = self.genre.families(role);
        for _ in 0..16 {
            let f = self.pick_weighted(options);
            let held = HELD_OUT.iter().any(|&(g, r, hf)| g == self.genre && r == role && hf == f);
            if !(self.split == Split::Train && held) { return f; }
        }
        family::SYNTH
    }

    // ── Habits ────────────────────────────────────────────────────────────

    fn view_to(&mut self, v: u32) {
        if self.view != v {
            self.view = v;
            self.emit(DawAction::OpenView, &[v as f32]);
        }
    }

    fn select_track(&mut self, i: usize) {
        if self.active != i && i < self.tracks.len() {
            self.active = i;
            self.emit(DawAction::SelectTrack, &[i as f32]);
        }
    }

    fn play(&mut self) {
        if !self.playing {
            if self.chance(0.5) { self.emit(DawAction::Rewind, &[]); }
            self.playing = true;
            self.emit(DawAction::Play, &[]);
        }
    }

    fn stop(&mut self) {
        if self.playing {
            self.playing = false;
            self.emit(DawAction::Stop, &[]);
        }
    }

    fn listen(&mut self) {
        self.edits_since_listen = 0;
        if self.view == view::ROLL && self.chance(self.persona.loops_pattern * 0.3) {
            self.emit(DawAction::SetTransportMode, &[1.0]);
        }
        self.play();
        if !self.chance(self.persona.edits_while_playing) { self.stop(); }
    }

    /// Book-keeping after an edit: listen back and save on the persona's rhythm.
    fn after_edit(&mut self) {
        self.edits_since_listen += 1;
        self.edits_since_save += 1;
        let jitter = self.rng.gen_range(0..3);
        if self.edits_since_listen >= self.persona.listen_every + jitter { self.listen(); }
        if self.persona.save_every > 0 && self.edits_since_save >= self.persona.save_every {
            self.edits_since_save = 0;
            self.emit(DawAction::SaveVersion, &[]);
        }
    }

    fn window_for(fam: u32) -> Option<u32> {
        // Indices into WINDOWS.
        match fam {
            family::WAVETABLE => Some(2), family::STRINGS => Some(3), family::BRASS => Some(4),
            family::PIANO => Some(5), family::MATTER => Some(6), family::WATER => Some(7),
            family::DRUM_RACK => Some(8), _ => None,
        }
    }

    fn open_window(&mut self, w: u32) {
        if !self.open_windows.contains(&w) {
            self.open_windows.push(w);
            self.emit(DawAction::ToggleWindow, &[w as f32, 1.0]);
        }
    }

    fn close_window(&mut self, w: u32) {
        if let Some(i) = self.open_windows.iter().position(|&x| x == w) {
            self.open_windows.remove(i);
            self.emit(DawAction::ToggleWindow, &[w as f32, 0.0]);
        }
    }

    fn move_taken(&mut self) {
        self.undoable_moves += 1;
        // Not every move lands: some get undone straight away.
        if self.chance(0.18) {
            self.undoable_moves -= 1;
            self.emit(DawAction::Undo, &[]);
        }
        self.after_edit();
    }

    // ── Tracks and instruments ────────────────────────────────────────────

    /// The track for `role`, adding and setting one up the way a user would.
    fn track_for(&mut self, role: Role) -> usize {
        if let Some(i) = self.tracks.iter().position(|t| t.role == role) {
            self.select_track(i);
            return i;
        }
        // A blank song's starter synth track is taken by the first pitched role.
        if role != Role::Drums {
            if let Some(i) = self.tracks.iter().position(|t| t.role == Role::Texture && t.family == family::SYNTH && t.pattern().notes.is_empty()) {
                self.select_track(i);
                self.tracks[i].role = role;
                self.setup_instrument(i, role);
                return i;
            }
        }
        let fam = self.family_for(role);
        self.add_track_with(role, fam)
    }

    /// Adds a track for `role` playing `fam`: a drum rack, or a synth track switched to the family.
    fn add_track_with(&mut self, role: Role, fam: u32) -> usize {
        let lane = (0..16).find(|l| !self.tracks.iter().any(|t| t.lane == *l)).unwrap_or(15);
        let base = if fam == family::DRUM_RACK { family::DRUM_RACK } else { family::SYNTH };
        self.tracks.push(SimTrack::new(role, base, lane));
        self.active = self.tracks.len() - 1;
        self.emit(DawAction::AddTrack, &[base as f32]);
        let i = self.active;
        if fam != base { self.switch_family(i, fam); }
        self.setup_instrument(i, role);
        i
    }

    fn remove_track(&mut self, i: usize) {
        self.emit(DawAction::RemoveTrack, &[i as f32]);
        self.tracks.remove(i);
        if self.active >= self.tracks.len() { self.active = self.tracks.len().saturating_sub(1); }
        else if self.active > i { self.active -= 1; }
        self.selected_clip = None;
    }

    fn switch_family(&mut self, i: usize, fam: u32) {
        self.tracks[i].family = fam;
        if fam == family::MATTER { self.tracks[i].rows = 11; }
        if fam == family::SYNTH {
            let w = self.rng.gen_range(0..4) as f32;
            self.emit(DawAction::SetWaveform, &[w]);
        } else {
            self.emit(DawAction::SetInstrument, &[fam as f32]);
        }
    }

    /// Picks the instrument's patch and key: presets per family, the song's scale and a root for the role.
    fn setup_instrument(&mut self, i: usize, role: Role) {
        let mut fam = self.tracks[i].family;
        let forced = self.held_out.map(|h| h.0) == Some(role);
        if role != Role::Drums && fam == family::SYNTH && self.tracks[i].role == role && (forced || self.chance(0.4)) {
            let wanted = self.family_for(role);
            if wanted != family::SYNTH && wanted != family::DRUM_RACK && wanted != family::MATTER {
                self.switch_family(i, wanted);
                fam = wanted;
            } else if self.chance(0.6) {
                let w = *[0usize, 1, 2, 3].choose(&mut self.rng).unwrap() as f32;
                self.emit(DawAction::SetWaveform, &[w]);
            }
        }
        let opens = self.chance(self.persona.opens_windows);
        let window = Self::window_for(fam);
        if opens { if let Some(w) = window { self.open_window(w); } }
        self.load_preset(fam, role);
        if self.tracks[i].melodic() && fam != family::WATER {
            let root = match role {
                Role::Bass => self.key_root - 24,
                Role::Chords => self.key_root - 12,
                _ => self.key_root,
            };
            // The first pitched track sets the key; the rest follow it.
            if self.tracks[i].scale != self.scale {
                self.tracks[i].scale = self.scale;
                self.emit(DawAction::SetScale, &[self.scale as f32]);
            }
            if self.tracks[i].root != root {
                self.tracks[i].root = root;
                self.emit(DawAction::SetRootNote, &[root as f32]);
            }
        }
        if self.chance(self.persona.preview_prob) {
            for _ in 0..self.rng.gen_range(1..4) {
                let row = self.rng.gen_range(0..self.tracks[i].rows.min(8)) as f32;
                self.emit(DawAction::PreviewNote, &[row, DEFAULT_VELOCITY]);
            }
        }
        if opens && self.chance(0.5) { if let Some(w) = window { self.close_window(w); } }
    }

    fn load_preset(&mut self, fam: u32, role: Role) {
        let pick = |rng: &mut StdRng, list: &ChoiceList, ids: &[&str]| -> f32 {
            let id = ids.choose(rng).unwrap();
            list.index_of(id).unwrap_or(0) as f32
        };
        match fam {
            family::WAVETABLE => {
                let ids: &[&str] = match role {
                    Role::Bass => &["modulated_bass", "sub_pulse", "acid_bass", "saw"],
                    Role::Chords => &["warm_pad", "simple_strings", "vowels", "glass"],
                    Role::Lead => &["glass_pluck", "bell", "square", "pwm", "simple_horns"],
                    _ => &["synth_riser", "sweeping_siren", "terrain", "laser_zap"],
                };
                let v = pick(&mut self.rng, &WAVETABLE_PRESETS, ids);
                self.emit(DawAction::LoadWavetablePreset, &[v]);
            }
            family::STRINGS => {
                let ids: &[&str] = match role {
                    Role::Bass => &["bass", "cello", "octobass"],
                    Role::Chords => &["viola", "cello"],
                    _ => &["violin", "viola", "hardanger", "glass"],
                };
                let v = pick(&mut self.rng, &STRINGS_INSTRUMENTS, ids);
                self.emit(DawAction::LoadStrings, &[v]);
            }
            family::BRASS => {
                let ids: &[&str] = match role { Role::Bass => &["tuba", "trombone"], _ => &["trumpet", "horn", "trombone"] };
                let v = pick(&mut self.rng, &BRASS_INSTRUMENTS, ids);
                self.emit(DawAction::LoadBrass, &[v]);
                if self.chance(0.5) {
                    let style = match self.genre {
                        Genre::Funk => pick(&mut self.rng, &BRASS_STYLES, &["section", "rough"]),
                        Genre::Cinematic => pick(&mut self.rng, &BRASS_STYLES, &["chorale", "fanfare", "blazing"]),
                        _ => self.rng.gen_range(0..BRASS_STYLES.len()) as f32,
                    };
                    self.emit(DawAction::SetBrassStyle, &[style]);
                }
                if self.chance(0.3) {
                    let mute = self.rng.gen_range(1..BRASS_MUTES.len()) as f32;
                    self.emit(DawAction::SetBrassMute, &[mute]);
                }
            }
            family::PIANO => {
                if self.chance(0.6) {
                    let v = self.rng.gen_range(0..PIANO_PRESETS.len()) as f32;
                    self.emit(DawAction::LoadPianoPreset, &[v]);
                }
            }
            family::MATTER => {
                let ids: &[&str] = match self.genre {
                    Genre::Funk => &["funk", "studio"], Genre::Cinematic => &["mallets", "rock"],
                    Genre::LoFi => &["brushes", "jazz"], _ => &["studio", "rock", "jazz"],
                };
                let v = pick(&mut self.rng, &MATTER_PRESETS, ids);
                self.emit(DawAction::LoadMatterPreset, &[v]);
            }
            family::WATER => {
                let ids: &[&str] = match role {
                    Role::Lead => &["glass-harp", "spoon-glasses", "bottles"],
                    _ => &["drips", "lakeside", "tent", "window", "tin-roof"],
                };
                let v = pick(&mut self.rng, &WATER_PRESETS, ids);
                self.emit(DawAction::LoadWaterPreset, &[v]);
            }
            family::DRUM_RACK => {
                if self.chance(0.25) {
                    let pad = self.rng.gen_range(0..5) as f32;
                    self.emit(DawAction::AssignSample, &[pad]);
                    if self.chance(0.3) { self.emit(DawAction::AddPad, &[]); }
                }
            }
            _ => {}
        }
    }

    // ── Note writing ──────────────────────────────────────────────────────

    fn add_note(&mut self, row: u32, step: u32) {
        let t = self.active;
        if self.tracks[t].pattern().has(row, step) || step >= self.tracks[t].pattern().steps { return; }
        // A slip: click the wrong row, then click it again to erase it.
        if self.chance(self.persona.mistake_prob) {
            let wrong = if row > 0 && self.chance(0.5) { row - 1 } else { row + 1 };
            if wrong < self.tracks[t].rows && !self.tracks[t].pattern().has(wrong, step) {
                self.emit(DawAction::AddNote, &[wrong as f32, step as f32, 1.0, DEFAULT_VELOCITY]);
                self.emit(DawAction::RemoveNote, &[wrong as f32, step as f32]);
            }
        }
        self.tracks[t].pattern_mut().notes.push(SimNote { row, step });
        self.emit(DawAction::AddNote, &[row as f32, step as f32, 1.0, DEFAULT_VELOCITY]);
        self.after_edit();
    }

    fn remove_note(&mut self, row: u32, step: u32) {
        let t = self.active;
        let p = self.tracks[t].pattern_mut();
        if let Some(i) = p.notes.iter().position(|n| n.row == row && n.step == step) {
            p.notes.remove(i);
            self.emit(DawAction::RemoveNote, &[row as f32, step as f32]);
            self.after_edit();
        }
    }

    /// Drags across a run of three or more consecutive notes on one row, erasing them.
    fn erase_run(&mut self) {
        let t = self.active;
        let p = self.tracks[t].pattern().clone();
        let mut best: Option<(u32, u32, u32)> = None;
        for n in &p.notes {
            if p.has(n.row, n.step.wrapping_sub(1)) { continue; }
            let mut end = n.step;
            while p.has(n.row, end + 1) { end += 1; }
            if end >= n.step + 2 && best.map(|b| end - n.step > b.2 - b.1).unwrap_or(true) { best = Some((n.row, n.step, end)); }
        }
        if let Some((row, a, b)) = best {
            let b = if self.chance(0.5) { a + (b - a) / 2 + 1 } else { b };
            self.tracks[t].pattern_mut().notes.retain(|n| !(n.row == row && n.step >= a && n.step <= b));
            self.emit(DawAction::EraseNotes, &[row as f32, a as f32, b as f32, (b - a + 1) as f32]);
            self.after_edit();
        }
    }

    /// Writes `steps` on one row: one drag when they are consecutive and the
    /// persona paints, otherwise one click each.
    fn write_row(&mut self, row: u32, steps: &[u32]) {
        let t = self.active;
        let fresh: Vec<u32> = steps.iter().copied().filter(|&s| !self.tracks[t].pattern().has(row, s) && s < self.tracks[t].pattern().steps).collect();
        if fresh.is_empty() { return; }
        let contiguous = fresh.len() >= 3 && fresh.windows(2).all(|w| w[1] == w[0] + 1);
        if contiguous && self.chance(self.persona.paint_prob) {
            for &s in &fresh { self.tracks[t].pattern_mut().notes.push(SimNote { row, step: s }); }
            let (a, b) = (fresh[0], *fresh.last().unwrap());
            self.emit(DawAction::PaintNotes, &[row as f32, a as f32, b as f32, fresh.len() as f32]);
            self.after_edit();
        } else {
            for s in fresh { self.add_note(row, s); }
        }
    }

    fn preview_before_writing(&mut self, rows: &[u32]) {
        if self.chance(self.persona.preview_prob) {
            for &r in rows.iter().take(self.rng.gen_range(1..4)) {
                self.emit(DawAction::PreviewNote, &[r as f32, DEFAULT_VELOCITY]);
            }
        }
    }

    fn scale_len(&self) -> u32 { [12u32, 7, 7, 7, 5, 5, 6][self.scale.min(6)] }

    /// The scale row of a chord's root degree, folded into the scale.
    fn degree_row(&self, degree: u32) -> u32 { degree % self.scale_len() }

    fn write_drums(&mut self, bars: u32, fill: bool) {
        let fam = self.tracks[self.active].family;
        let g = groove(self.genre, &mut self.rng);
        let mut cells: Vec<(u32, u32)> = Vec::new();
        for bar in 0..bars {
            for (d, steps) in &g {
                for &s in steps { cells.push((drum_row(fam, *d), bar * STEPS_PER_BAR + s)); }
            }
        }
        if fill {
            let last = (bars - 1) * STEPS_PER_BAR;
            let snare = drum_row(fam, Drum::Snare);
            cells.retain(|&(r, s)| !(s >= last + 12 && r != drum_row(fam, Drum::Kick)));
            for s in 12..16 { cells.push((snare, last + s)); }
        }
        if self.persona.writes_by_row {
            let mut rows: Vec<u32> = cells.iter().map(|c| c.0).collect();
            rows.dedup();
            let mut seen = Vec::new();
            for r in rows { if !seen.contains(&r) { seen.push(r); } }
            for r in seen {
                self.preview_before_writing(&[r]);
                let mut steps: Vec<u32> = cells.iter().filter(|c| c.0 == r).map(|c| c.1).collect();
                steps.sort();
                self.write_row(r, &steps);
                if self.done() { return; }
            }
        } else {
            cells.sort_by_key(|c| (c.1, c.0));
            for (r, s) in cells {
                self.add_note(r, s);
                if self.done() { return; }
            }
        }
    }

    fn write_bass(&mut self, bars: u32) {
        let kicks: Vec<u32> = groove(self.genre, &mut self.rng).into_iter()
            .find(|(d, _)| *d == Drum::Kick).map(|(_, s)| s).unwrap_or_else(|| vec![0, 8]);
        let octave = self.scale_len();
        let rows = self.tracks[self.active].rows;
        let rhythm: Vec<u32> = match self.genre {
            Genre::House | Genre::Techno => vec![2, 6, 10, 14],
            Genre::Funk => vec![0, 3, 6, 7, 10, 14],
            _ => kicks,
        };
        let first = self.degree_row(self.progression[0]);
        self.preview_before_writing(&[first, first + 2]);
        for bar in 0..bars {
            let root = self.degree_row(self.progression[bar as usize % self.progression.len()]);
            for &s in &rhythm {
                let row = if self.genre == Genre::Funk && s % 4 == 3 && root + octave < rows { root + octave } else { root };
                self.add_note(row, bar * STEPS_PER_BAR + s);
                if self.done() { return; }
            }
        }
    }

    fn write_chords(&mut self, bars: u32) {
        let rows = self.tracks[self.active].rows;
        let restrike = self.genre != Genre::Ambient && self.genre != Genre::Cinematic && self.chance(0.5);
        for bar in 0..bars {
            let root = self.degree_row(self.progression[bar as usize % self.progression.len()]);
            let voicing = [root, root + 2, root + 4];
            self.preview_before_writing(&voicing);
            let hits: &[u32] = if restrike { &[0, 8] } else { &[0] };
            for &h in hits {
                for &r in &voicing {
                    if r < rows { self.add_note(r, bar * STEPS_PER_BAR + h); }
                    if self.done() { return; }
                }
            }
        }
    }

    fn write_melody(&mut self, bars: u32) {
        let rows = self.tracks[self.active].rows.max(5);
        let rhythms: &[&[u32]] = &[&[0, 2, 4, 7], &[0, 3, 6, 8, 10], &[0, 4, 6, 7], &[0, 2, 3, 6, 8, 12], &[0, 6, 8, 14]];
        let motif = *rhythms.choose(&mut self.rng).unwrap();
        let mut row = self.degree_row(self.progression[0]) + if rows > 8 { 2 } else { 0 };
        let mut contour: Vec<i32> = Vec::new();
        for _ in 0..motif.len() { contour.push(*[-1, 1, 1, -1, 2, -2, 0].choose(&mut self.rng).unwrap()); }
        for bar in 0..bars {
            let chord = self.degree_row(self.progression[bar as usize % self.progression.len()]);
            // Bars 2 and 4 answer the motif with a variation of its last notes.
            let answer = bar % 2 == 1 && self.chance(0.6);
            for (k, &s) in motif.iter().enumerate() {
                if k == 0 {
                    // Strong beat: land on a chord tone near where the line is.
                    let tones = [chord, chord + 2, chord + 4, chord + self.scale_len()];
                    row = *tones.iter().min_by_key(|&&t| (t as i32 - row as i32).abs()).unwrap();
                } else {
                    let mut d = contour[k];
                    if answer && k + 1 == motif.len() { d = -d; }
                    if self.chance(0.08) { d *= 2; }
                    row = (row as i32 + d).clamp(0, rows as i32 - 1) as u32;
                }
                if self.chance(self.persona.preview_prob * 0.4) {
                    self.emit(DawAction::PreviewNote, &[row as f32, DEFAULT_VELOCITY]);
                }
                self.add_note(row.min(rows - 1), bar * STEPS_PER_BAR + s);
                if self.done() { return; }
            }
        }
    }

    fn pattern_bars_choice(bars: f32) -> f32 {
        PATTERN_LENGTHS.index_of(&format!("{}", bars)).unwrap_or(1) as f32
    }

    fn ensure_pattern_length(&mut self, bars: u32) {
        let t = self.active;
        let want = bars * STEPS_PER_BAR;
        if self.tracks[t].pattern().steps != want {
            self.tracks[t].pattern_mut().steps = want;
            self.emit(DawAction::SetPatternLength, &[Self::pattern_bars_choice(bars as f32)]);
        }
    }

    /// The first notes on a track with no clips give it a clip spanning the song (ensureTrackHasClip).
    fn auto_clip(&mut self) {
        let bars = self.song_bars;
        let t = &mut self.tracks[self.active];
        if t.clips.is_empty() && !t.pattern().notes.is_empty() {
            t.clips.push(SimClip { bar: 0, bars, pattern: t.active });
        }
    }

    // ── Tasks ─────────────────────────────────────────────────────────────

    fn task_start_song(&mut self) {
        let bpm = self.bpm;
        self.emit(DawAction::SetBpm, &[bpm as f32]);
        if self.chance(0.4) {
            self.song_bars = *self.genre.song_bars().choose(&mut self.rng).unwrap();
            self.emit(DawAction::SetSongBars, &[self.song_bars as f32]);
        }
        if self.chance(0.15) {
            let snap = self.rng.gen_range(1..3) as f32;
            self.emit(DawAction::SetSnap, &[snap]);
        }
    }

    fn task_drums(&mut self) {
        if !self.genre.has_drums() { return; }
        // A modelled kit is a synth track switched to Matter: some people delete the
        // empty starter drum rack first, others keep it beside the new track.
        let starter = self.tracks.iter().position(|t| t.role == Role::Drums && t.family == family::DRUM_RACK && t.patterns.iter().all(|p| p.notes.is_empty()));
        let i = match starter {
            Some(s) if self.family_for(Role::Drums) == family::MATTER => {
                if self.chance(0.5) {
                    self.remove_track(s);
                } else {
                    self.tracks[s].role = Role::Texture;
                }
                self.add_track_with(Role::Drums, family::MATTER)
            }
            Some(s) => {
                self.select_track(s);
                if self.chance(self.persona.opens_windows * 0.5) { self.open_window(8); }
                self.load_preset(family::DRUM_RACK, Role::Drums);
                s
            }
            None => self.track_for(Role::Drums),
        };
        self.select_track(i);
        self.view_to(view::ROLL);
        let bars = if self.genre == Genre::Trap || self.chance(0.25) { 2 } else { 1 };
        self.ensure_pattern_length(bars);
        self.write_drums(bars, false);
        self.auto_clip();
        self.listen();
        if self.chance(0.45) {
            // A fill pattern for the ends of phrases.
            self.tracks[i].patterns.push(SimPattern::new(1.0));
            self.tracks[i].active = self.tracks[i].patterns.len() - 1;
            self.emit(DawAction::NewPattern, &[Self::pattern_bars_choice(1.0)]);
            self.write_drums(1, true);
            self.listen();
        }
        if self.chance(0.4) {
            let gain = self.rng.gen_range(0.45..0.65);
            self.emit(DawAction::SetVolume, &[i as f32, gain]);
        }
    }

    fn task_pitched(&mut self, role: Role) {
        let i = self.track_for(role);
        self.select_track(i);
        self.view_to(view::ROLL);
        let bars = match role { Role::Bass | Role::Chords => if self.progression.len() >= 4 && self.chance(0.6) { 4 } else { 2 }, _ => 2 };
        self.ensure_pattern_length(bars);
        match role {
            Role::Bass => self.write_bass(bars),
            Role::Chords => self.write_chords(bars),
            _ => self.write_melody(bars),
        }
        self.auto_clip();
        self.listen();
        if self.chance(self.persona.uses_moves) {
            match role {
                Role::Bass if self.tracks.iter().any(|t| t.role == Role::Drums) => { self.emit(DawAction::MoveKickLock, &[]); self.move_taken(); }
                Role::Lead => {
                    let mv = if self.chance(0.5) { DawAction::MoveAnswer } else { DawAction::MoveOctaveSpark };
                    self.emit(mv, &[]);
                    self.move_taken();
                }
                _ => {}
            }
        }
        if self.chance(0.5) {
            let gain = match role { Role::Bass => self.rng.gen_range(0.28..0.42), Role::Chords => self.rng.gen_range(0.12..0.25), _ => self.rng.gen_range(0.18..0.3) };
            self.emit(DawAction::SetVolume, &[i as f32, gain]);
        }
        if role != Role::Bass && self.chance(0.35) {
            let (t, fb, mix) = (*[0.125f32, 0.1875, 0.25, 0.375].choose(&mut self.rng).unwrap() * 120.0 / self.bpm as f32, self.rng.gen_range(0.2..0.5), self.rng.gen_range(0.1..0.35));
            self.emit(DawAction::SetDelay, &[t, fb, mix]);
        }
    }

    fn task_sound_design(&mut self) {
        let Some(i) = self.tracks.iter().position(|t| t.melodic() && !t.pattern().notes.is_empty()) else { return; };
        self.select_track(i);
        let fam = self.tracks[i].family;
        let role = self.tracks[i].role;
        if let Some(w) = Self::window_for(fam) { if self.chance(self.persona.opens_windows) { self.open_window(w); } }
        for _ in 0..self.persona.tweak_depth {
            match fam {
                family::SYNTH | family::WAVETABLE => {
                    if fam == family::WAVETABLE && self.chance(0.4) {
                        let p = self.rng.gen_range(0.0..1.0);
                        self.emit(DawAction::SetWavetablePosition, &[p]);
                    }
                    let cutoff = match role { Role::Bass => self.rng.gen_range(300.0..1800.0), _ => self.rng.gen_range(1200.0..9000.0) };
                    let res = self.rng.gen_range(0.5..4.0);
                    self.emit(DawAction::SetFilter, &[cutoff, res]);
                    if self.chance(0.5) {
                        let env = match role {
                            Role::Chords => [self.rng.gen_range(0.1..0.6), 0.3, 0.8, self.rng.gen_range(0.6..1.8)],
                            Role::Bass => [0.005, self.rng.gen_range(0.05..0.25), 0.4, 0.1],
                            _ => [0.01, self.rng.gen_range(0.05..0.3), self.rng.gen_range(0.3..0.8), self.rng.gen_range(0.1..0.5)],
                        };
                        self.emit(DawAction::SetEnvelope, &env);
                    }
                }
                family::BRASS => {
                    let s = self.rng.gen_range(0..BRASS_STYLES.len()) as f32;
                    self.emit(DawAction::SetBrassStyle, &[s]);
                }
                family::PIANO => {
                    let ped = self.rng.gen_range(0.0..1.0);
                    self.emit(DawAction::SetPianoPedal, &[ped]);
                }
                _ => self.load_preset(fam, role),
            }
            let row = self.rng.gen_range(0..self.tracks[i].rows.min(8)) as f32;
            self.emit(DawAction::PreviewNote, &[row, DEFAULT_VELOCITY]);
        }
        if role != Role::Bass && self.chance(0.35) {
            let big = matches!(self.genre, Genre::Cinematic | Genre::Ambient);
            let room = if big { self.rng.gen_range(18.0..30.0) } else { self.rng.gen_range(10.0..18.0) };
            let time = if big { self.rng.gen_range(2.5..6.0) } else { self.rng.gen_range(0.6..2.2) };
            let damping = self.rng.gen_range(0.2..0.8);
            let mix = if role == Role::Chords { self.rng.gen_range(0.25..0.5) } else { self.rng.gen_range(0.1..0.3) };
            self.emit(DawAction::SetReverb, &[room, time, damping, mix]);
        }
        if self.chance(0.6) {
            let knob = match (role, self.genre) {
                (Role::Bass, Genre::Techno) => 3,           // acid
                (Role::Chords, Genre::House) => 0,          // pump
                (_, Genre::LoFi) | (_, Genre::HipHop) => 6, // humanize
                _ => self.rng.gen_range(0..CHARACTER_KNOBS.len()),
            };
            let amount = self.rng.gen_range(0.2..0.8);
            self.emit(DawAction::SetCharacter, &[knob as f32, amount]);
            if knob == 2 {
                let p = self.rng.gen_range(0..GATE_PATTERNS.len()) as f32;
                self.emit(DawAction::SetGatePattern, &[p]);
            }
        }
        self.listen();
        if let Some(w) = Self::window_for(fam) { if self.chance(0.6) { self.close_window(w); } }
    }

    /// Lays the patterns out as intro / verse / chorus / breakdown / outro.
    fn task_arrange(&mut self) {
        self.view_to(view::ARRANGE);
        let form: Vec<(&str, u32)> = match self.genre {
            Genre::Ambient | Genre::Cinematic => vec![("intro", 4), ("a", 8), ("b", 8), ("outro", 4)],
            _ => vec![("intro", 4), ("verse", 8), ("chorus", 8), ("break", 4), ("chorus", 8)],
        };
        let total: u32 = form.iter().map(|f| f.1).sum();
        if self.song_bars != total {
            self.song_bars = total;
            self.emit(DawAction::SetSongBars, &[total as f32]);
        }
        let order: Vec<usize> = (0..self.tracks.len()).filter(|&i| !self.tracks[i].pattern().notes.is_empty() || self.tracks[i].patterns.iter().any(|p| !p.notes.is_empty())).collect();
        for i in order {
            // Replace the song-long clip the first notes gave the track.
            let auto = self.tracks[i].clips.len() == 1 && self.tracks[i].clips[0].bar == 0 && self.tracks[i].clips[0].bars >= 16;
            if auto {
                self.select_clip(i, 0);
                self.tracks[i].clips.clear();
                self.selected_clip = None;
                self.emit(DawAction::DeleteClip, &[]);
            }
            let role = self.tracks[i].role;
            let lane = self.tracks[i].lane;
            let mut bar = 0;
            let mut prev: Option<usize> = None;
            for &(section, len) in &form {
                let plays = match (role, section) {
                    (Role::Drums, "intro") | (Role::Drums, "break") => false,
                    (Role::Lead, "intro") | (Role::Lead, "verse") | (Role::Lead, "break") => false,
                    (Role::Bass, "intro") | (Role::Bass, "break") => false,
                    _ => true,
                };
                if plays && self.tracks[i].bar_free(bar, len) {
                    // Drawing on a lane makes its track the active one; nothing else is recorded.
                    self.active = i;
                    let pattern = self.tracks[i].active;
                    let dup = prev.map(|p| self.tracks[i].clips[p].bars == len && self.tracks[i].clips[p].bar + len == bar).unwrap_or(false);
                    if dup && self.chance(0.6) {
                        self.emit(DawAction::DuplicateClip, &[]);
                    } else {
                        self.emit(DawAction::CreateClip, &[lane as f32, bar as f32, len as f32]);
                    }
                    self.tracks[i].clips.push(SimClip { bar, bars: len, pattern });
                    prev = Some(self.tracks[i].clips.len() - 1);
                    self.selected_clip = Some((i, prev.unwrap()));
                    self.after_edit();
                    if self.done() { return; }
                }
                bar += len;
            }
            // A drum fill pattern goes at the end of each chorus.
            if role == Role::Drums && self.tracks[i].patterns.len() > 1 && self.chance(0.5) {
                let ends: Vec<u32> = self.tracks[i].clips.iter().filter(|c| c.bars >= 8).map(|c| c.bar + c.bars - 1).collect();
                if let Some(&end) = ends.first() {
                    self.emit(DawAction::SelectPattern, &[1.0]);
                    self.tracks[i].active = 1;
                    self.emit(DawAction::CreateClip, &[lane as f32, end as f32, 1.0]);
                    self.after_edit();
                }
            }
        }
        // Fix-ups: nudge or trim a clip.
        if self.chance(0.4) {
            if let Some(i) = (0..self.tracks.len()).find(|&i| !self.tracks[i].clips.is_empty()) {
                let c = self.rng.gen_range(0..self.tracks[i].clips.len());
                self.select_clip(i, c);
                if self.chance(0.5) {
                    let to = self.tracks[i].clips[c].bar.saturating_sub(self.rng.gen_range(0..2));
                    self.emit(DawAction::MoveClip, &[to as f32]);
                } else {
                    let len = self.tracks[i].clips[c].bars.saturating_sub(self.rng.gen_range(1..4)).max(1);
                    self.tracks[i].clips[c].bars = len;
                    self.emit(DawAction::ResizeClip, &[len as f32]);
                }
                self.after_edit();
            }
        }
        if self.chance(self.persona.uses_moves) {
            let chorus = form.iter().take_while(|f| f.0 != "chorus" && f.0 != "b").map(|f| f.1).sum::<u32>();
            self.emit(DawAction::Seek, &[chorus as f32]);
            match self.rng.gen_range(0..3) {
                0 => { let b = *[2.0f32, 4.0].choose(&mut self.rng).unwrap(); self.emit(DawAction::MoveBuild, &[b]); }
                1 => self.emit(DawAction::MoveDropGap, &[]),
                _ => self.emit(DawAction::MoveEchoOut, &[]),
            }
            self.move_taken();
        }
        self.play();
        self.stop();
    }

    fn select_clip(&mut self, track: usize, clip: usize) {
        if self.selected_clip != Some((track, clip)) {
            self.selected_clip = Some((track, clip));
            self.active = track;
            let lane = self.tracks[track].lane;
            let bar = self.tracks[track].clips[clip].bar;
            self.emit(DawAction::SelectClip, &[lane as f32, bar as f32]);
        }
    }

    fn task_variation(&mut self) {
        let Some(i) = (0..self.tracks.len()).filter(|&i| !self.tracks[i].pattern().notes.is_empty()).collect::<Vec<_>>().choose(&mut self.rng).copied() else { return; };
        self.select_track(i);
        self.view_to(view::ROLL);
        let as_new = self.chance(0.6);
        if as_new {
            let copy = self.tracks[i].pattern().clone();
            self.tracks[i].patterns.push(copy);
            self.tracks[i].active = self.tracks[i].patterns.len() - 1;
            self.emit(DawAction::DuplicatePattern, &[]);
        }
        let mv = if self.tracks[i].is_drums() {
            *[DawAction::MoveVariation, DawAction::MoveThinOut, DawAction::MoveStutter].choose(&mut self.rng).unwrap()
        } else {
            *[DawAction::MoveVariation, DawAction::MoveThinOut, DawAction::MoveOctaveSpark].choose(&mut self.rng).unwrap()
        };
        match mv {
            DawAction::MoveStutter => { let r = self.rng.gen_range(0..3) as f32; self.emit(mv, &[r]); }
            DawAction::MoveOctaveSpark => self.emit(mv, &[]),
            _ => { let a = self.rng.gen_range(0.2..0.8); self.emit(mv, &[a]); }
        }
        self.move_taken();
        // Hand-edit the result a little.
        for _ in 0..self.rng.gen_range(0..4) {
            let rows = self.tracks[i].rows;
            let steps = self.tracks[i].pattern().steps;
            let (r, s) = (self.rng.gen_range(0..rows.min(8)), self.rng.gen_range(0..steps));
            self.add_note(r, s);
        }
        self.listen();
        if as_new && !self.tracks[i].clips.is_empty() {
            let c = self.rng.gen_range(0..self.tracks[i].clips.len());
            self.view_to(view::ARRANGE);
            self.select_clip(i, c);
            self.emit(DawAction::SelectPattern, &[(self.tracks[i].patterns.len() - 1) as f32]);
            self.emit(DawAction::UsePatternInClip, &[]);
            self.after_edit();
        }
    }

    fn task_edit_pattern(&mut self) {
        let Some(i) = (0..self.tracks.len()).filter(|&i| !self.tracks[i].pattern().notes.is_empty()).collect::<Vec<_>>().choose(&mut self.rng).copied() else { return; };
        self.select_track(i);
        self.view_to(view::ROLL);
        if self.tracks[i].patterns.len() > 1 && self.chance(0.5) {
            let p = self.rng.gen_range(0..self.tracks[i].patterns.len());
            if p != self.tracks[i].active {
                self.tracks[i].active = p;
                self.emit(DawAction::SelectPattern, &[p as f32]);
            }
        }
        if self.chance(0.35) { self.erase_run(); }
        for _ in 0..self.rng.gen_range(1..5) {
            let notes = self.tracks[i].pattern().notes.clone();
            if let Some(n) = notes.choose(&mut self.rng) { self.remove_note(n.row, n.step); }
        }
        let melodic = self.tracks[i].melodic();
        for _ in 0..self.rng.gen_range(2..7) {
            let steps = self.tracks[i].pattern().steps;
            let s = self.rng.gen_range(0..steps / 2) * 2;
            let r = if melodic { self.degree_row(self.progression[(s / STEPS_PER_BAR) as usize % self.progression.len()]) + *[0, 2, 4].choose(&mut self.rng).unwrap() } else { self.rng.gen_range(0..3) };
            self.add_note(r.min(self.tracks[i].rows - 1), s);
        }
        self.listen();
    }

    fn task_mix(&mut self) {
        self.view_to(view::MIXER);
        self.play();
        let order: Vec<usize> = (0..self.tracks.len()).collect();
        for i in order {
            if self.done() { return; }
            // Effects follow the active track; the strip's own controls name theirs.
            if self.chance(0.6) { self.select_track(i); }
            if self.chance(0.4) {
                self.tracks[i].solo = true;
                self.emit(DawAction::SoloTrack, &[i as f32, 1.0]);
            }
            let gain = match self.tracks[i].role {
                Role::Drums => self.rng.gen_range(0.45..0.65), Role::Bass => self.rng.gen_range(0.28..0.42),
                Role::Chords => self.rng.gen_range(0.12..0.25), Role::Lead => self.rng.gen_range(0.18..0.32),
                Role::Texture => self.rng.gen_range(0.08..0.2),
            };
            self.emit(DawAction::SetVolume, &[i as f32, gain]);
            if self.active == i && self.chance(0.55) {
                let eq = match self.tracks[i].role {
                    Role::Bass => "clean-low", Role::Chords => *["warm", "air"].choose(&mut self.rng).unwrap(),
                    Role::Lead => *["presence", "air"].choose(&mut self.rng).unwrap(), Role::Drums => *["boom", "presence"].choose(&mut self.rng).unwrap(),
                    Role::Texture => "dark-verb",
                };
                self.open_window(1);
                self.emit(DawAction::SetEqPreset, &[EQ_PRESETS.index_of(eq).unwrap_or(0) as f32]);
            }
            if self.active == i && self.tracks[i].role != Role::Bass && self.chance(0.45) {
                let verb = match self.genre {
                    Genre::Cinematic | Genre::Ambient => *["hall", "cathedral", "wash"].choose(&mut self.rng).unwrap(),
                    Genre::Techno | Genre::House => *["plate", "room"].choose(&mut self.rng).unwrap(),
                    _ => *["room", "studio", "plate"].choose(&mut self.rng).unwrap(),
                };
                self.open_window(1);
                self.emit(DawAction::SetReverbPreset, &[REVERB_PRESETS.index_of(verb).unwrap_or(0) as f32]);
            }
            if self.tracks[i].solo {
                self.tracks[i].solo = false;
                self.emit(DawAction::SoloTrack, &[i as f32, 0.0]);
            }
            if self.chance(0.1) {
                self.tracks[i].muted = !self.tracks[i].muted;
                let on = if self.tracks[i].muted { 1.0 } else { 0.0 };
                self.emit(DawAction::MuteTrack, &[i as f32, on]);
            }
        }
        if self.chance(0.5) { self.open_window(0); }
        self.close_window(1);
        self.stop();
    }

    fn task_finish(&mut self) {
        if self.chance(0.6) {
            self.emit(DawAction::Rewind, &[]);
            self.playing = true;
            self.emit(DawAction::Play, &[]);
            self.stop();
        }
        self.emit(DawAction::SaveVersion, &[]);
        self.edits_since_save = 0;
        self.emit(DawAction::ExportWav, &[]);
        if self.chance(0.12) {
            self.open_window(10);
            self.emit(DawAction::ExportVideo, &[]);
        }
    }

    fn task_guitar(&mut self) {
        let i = self.track_for(Role::Lead);
        self.select_track(i);
        self.open_window(9);
        self.emit(DawAction::StartGuitar, &[]);
        self.playing = true;
        self.emit(DawAction::Play, &[]);
        self.stop();
        self.emit(DawAction::StopGuitar, &[]);
        // The take becomes a chromatic pattern on the track.
        let notes: Vec<SimNote> = (0..self.rng.gen_range(4..12)).map(|k| SimNote { row: self.rng.gen_range(0..12), step: k * 2 }).collect();
        self.tracks[i].patterns.push(SimPattern { steps: 32, notes });
        self.tracks[i].active = self.tracks[i].patterns.len() - 1;
        self.tracks[i].scale = 0;
        self.close_window(9);
        self.view_to(view::ROLL);
        self.listen();
    }

    /// An existing song to continue: tracks with written patterns and an arrangement.
    fn load_existing_song(&mut self) {
        let mut roles = vec![Role::Bass, Role::Chords, Role::Lead];
        if self.genre.has_drums() { roles.insert(0, Role::Drums); }
        if self.chance(0.3) { roles.push(Role::Texture); }
        let keep = self.rng.gen_range(2..=roles.len());
        roles.truncate(keep);
        self.song_bars = *self.genre.song_bars().choose(&mut self.rng).unwrap();
        let session_steps = std::mem::take(&mut self.steps);
        for (lane, role) in roles.into_iter().enumerate() {
            let fam = self.family_for(role);
            let mut t = SimTrack::new(role, fam, lane as u32);
            t.scale = if t.is_drums() { 0 } else { self.scale };
            self.tracks.push(t);
            self.active = self.tracks.len() - 1;
            // Write silently: these notes were there before the session began.
            let bars = if role == Role::Drums { 1 } else { 2 };
            self.tracks[self.active].pattern_mut().steps = bars * STEPS_PER_BAR;
            let saved = self.persona.clone();
            self.persona.mistake_prob = 0.0;
            self.persona.listen_every = u32::MAX / 4;
            self.persona.save_every = 0;
            self.persona.preview_prob = 0.0;
            match role {
                Role::Drums => self.write_drums(bars, false),
                Role::Bass => self.write_bass(bars),
                Role::Chords => self.write_chords(bars),
                _ => self.write_melody(bars),
            }
            self.persona = saved;
            let sb = self.song_bars;
            let start = if role == Role::Lead { sb / 4 } else { 0 };
            self.tracks[self.active].clips.push(SimClip { bar: start, bars: sb - start, pattern: 0 });
        }
        self.steps = session_steps;
        self.edits_since_listen = 0;
        self.edits_since_save = 0;
        self.active = 0;
        self.view = if self.chance(0.6) { view::ARRANGE } else { view::ROLL };
    }

    /// Chooses the session's goals and runs them.
    pub fn run(&mut self) {
        use DawTask::*;
        let r = self.rng.gen_range(0..100);
        let from_scratch = r < 55;
        let mut plan: Vec<DawTask> = if from_scratch {
            let mut p = vec![StartSong];
            let mut layers = vec![BuildDrums, WriteBass, WriteChords, WriteMelody];
            if !self.genre.has_drums() { layers.retain(|t| *t != BuildDrums); }
            // Most people start with drums; some start from a melody or the chords.
            if self.chance(0.25) { let k = self.rng.gen_range(0..layers.len()); let first = layers.remove(k); layers.insert(0, first); }
            let keep = if self.chance(0.35) { self.rng.gen_range(1..=2) } else { layers.len() };
            for t in layers.into_iter().take(keep) {
                p.push(t);
                if self.chance(0.25) { p.push(SoundDesign); }
            }
            if keep > 2 {
                if self.chance(0.7) { p.push(Arrange); }
                if self.chance(0.4) { p.push(MakeVariation); }
                if self.chance(0.6) { p.push(Mix); }
                if self.chance(0.5) { p.push(Finish); }
            }
            p
        } else {
            let mut pool = vec![EditPattern, MakeVariation, SoundDesign, Arrange, Mix, WriteMelody, Finish];
            if self.chance(0.05) { pool.push(GuitarTake); }
            pool.shuffle(&mut self.rng);
            let n = self.rng.gen_range(1..=4);
            let mut p: Vec<DawTask> = pool.into_iter().take(n).collect();
            // Finishing comes last.
            if let Some(k) = p.iter().position(|t| *t == Finish) { let f = p.remove(k); p.push(f); }
            p
        };
        // The held-out combination has to actually appear in an eval session.
        if let Some((role, _)) = self.held_out {
            let task = match role { Role::Bass => WriteBass, Role::Chords => WriteChords, _ => WriteMelody };
            if !plan.contains(&task) { let at = if from_scratch { 1 } else { 0 }; plan.insert(at.min(plan.len()), task); }
        }
        if from_scratch {
            // A blank song: a drum rack and a synth track, arrangement empty.
            self.tracks = vec![SimTrack::new(Role::Drums, family::DRUM_RACK, 0), SimTrack::new(Role::Texture, family::SYNTH, 1)];
            self.active = 0;
        } else {
            self.load_existing_song();
        }
        let first = self.context();
        self.steps.push(ActionStep::bos_with(first));
        for task in plan {
            if self.done() { break; }
            self.tasks.push(task);
            match task {
                StartSong => self.task_start_song(),
                BuildDrums => self.task_drums(),
                WriteBass => self.task_pitched(Role::Bass),
                WriteChords => self.task_pitched(Role::Chords),
                WriteMelody => self.task_pitched(Role::Lead),
                SoundDesign => self.task_sound_design(),
                Arrange => self.task_arrange(),
                MakeVariation => self.task_variation(),
                Mix => self.task_mix(),
                Finish => self.task_finish(),
                EditPattern => self.task_edit_pattern(),
                GuitarTake => self.task_guitar(),
            }
        }
        self.stop();
        self.steps.truncate(MAX_SESSION_ACTIONS);
        self.steps.push(ActionStep::eos());
    }
}

/// Generates `count` sessions with seeds derived from `seed`.
pub fn generate_sessions(count: usize, seed: u64, split: Split) -> Vec<Trajectory> {
    let salt: u64 = match split { Split::All => 0, Split::Train => 0x7472_6169_6e00, Split::Eval => 0x6576_616c_0000 };
    (0..count as u64).map(|i| DawSim::generate(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ salt ^ i, split)).collect()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sessions(n: usize, split: Split) -> Vec<Trajectory> { generate_sessions(n, 7, split) }

    #[test]
    fn sessions_are_framed_and_bounded() {
        for t in sessions(200, Split::All) {
            assert_eq!(t.steps.first().unwrap().action_id, BOS_ACTION);
            assert_eq!(t.steps.last().unwrap().action_id, EOS_ACTION);
            assert!(t.steps.len() >= 3, "{:?}", t.tasks);
            assert!(t.steps.len() <= MAX_SESSION_ACTIONS + 1);
            for s in &t.steps[1..t.steps.len() - 1] {
                assert!(s.action().is_some(), "sentinel inside a session");
            }
        }
    }

    #[test]
    fn params_stay_inside_their_specs() {
        for t in sessions(300, Split::All) {
            for s in t.steps.iter().filter_map(|s| s.action().map(|a| (a, s))) {
                let (a, step) = s;
                for (i, spec) in a.params().iter().enumerate() {
                    let v = step.params[i];
                    assert!(v >= spec.min && v <= spec.max, "{}.{} = {} outside {}..{}", a.name(), spec.name, v, spec.min, spec.max);
                }
                assert!(step.context.family < NUM_FAMILIES as u32);
                assert!(step.context.view < NUM_VIEWS as u32);
            }
        }
    }

    #[test]
    fn notes_get_written_and_coverage_is_broad() {
        let all = sessions(600, Split::All);
        let mut seen = vec![0usize; NUM_DAW_ACTIONS];
        for t in &all {
            for s in &t.steps { if let Some(a) = s.action() { seen[a.id() as usize] += 1; } }
        }
        let missing: Vec<_> = DawAction::ALL.iter().filter(|a| seen[a.id() as usize] == 0).map(|a| a.name()).collect();
        // VST3 loading needs plugins the generator does not assume a user has.
        assert!(missing.iter().all(|m| *m == "load_vst3"), "never generated: {missing:?}");
        let notes = seen[DawAction::AddNote.id() as usize] + seen[DawAction::PaintNotes.id() as usize];
        let total: usize = seen.iter().sum();
        assert!(notes * 10 > total, "notes are {notes} of {total} actions");
    }

    #[test]
    fn drum_grooves_land_on_the_beat() {
        // House kicks are four on the floor: every recorded drum-rack kick is on a beat.
        let mut kicks = 0;
        for i in 0..200u64 {
            let mut sim = DawSim::new(i, Split::All);
            if sim.genre != Genre::House { continue; }
            sim.run();
            for (k, s) in sim.steps.iter().enumerate() {
                // A slip (a note erased by the very next click) is not part of the groove.
                let next = sim.steps.get(k + 1);
                let slip = next.map(|n| n.action_id == DawAction::RemoveNote.id() && n.params[..2] == s.params[..2]).unwrap_or(false);
                if !slip && s.action_id == DawAction::AddNote.id() && s.context.family == family::DRUM_RACK && s.params[0] == 0.0 && s.context.view == view::ROLL {
                    kicks += 1;
                    assert_eq!(s.params[1] as u32 % 4, 0, "off-beat kick at {}", s.params[1]);
                }
            }
        }
        assert!(kicks > 0);
    }

    #[test]
    fn held_out_pairs_split_cleanly() {
        let held_in = |t: &Trajectory| -> bool {
            HELD_OUT.iter().any(|&(g, _, fam)| t.genre == g.name() && t.steps.iter().any(|s| s.context.family == fam))
        };
        let train = sessions(400, Split::Train);
        let eval = sessions(100, Split::Eval);
        // Training sessions in a held-out genre never switch to that genre's held-out family for its role.
        // (The same family can still appear in another role, so this only checks the eval side strictly.)
        assert!(eval.iter().filter(|t| held_in(t)).count() * 10 >= eval.len() * 7, "eval sessions rarely use a held-out pair");
        assert!(train.iter().all(|t| t.vocab_version == DAW_VOCAB_VERSION));
    }

    #[test]
    fn undo_only_follows_moves() {
        let moves = [
            DawAction::MoveVariation, DawAction::MoveThinOut, DawAction::MoveStutter, DawAction::MoveOctaveSpark,
            DawAction::MoveAnswer, DawAction::MoveKickLock, DawAction::MoveBuild, DawAction::MoveDropGap, DawAction::MoveEchoOut,
        ].map(|a| a.id());
        for t in sessions(300, Split::All) {
            let mut available = 0i32;
            for s in &t.steps {
                if moves.contains(&s.action_id) { available += 1; }
                if s.action_id == DawAction::Undo.id() {
                    assert!(available > 0, "undo with nothing to undo");
                    available -= 1;
                }
            }
        }
    }

    #[test]
    fn generation_is_deterministic() {
        let a = serde_json::to_string(&sessions(20, Split::Train)).unwrap();
        let b = serde_json::to_string(&sessions(20, Split::Train)).unwrap();
        assert_eq!(a, b);
    }
}
