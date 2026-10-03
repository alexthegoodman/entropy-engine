//! DAW semantic action vocabulary for the UI prediction model.
//!
//! Defines the fixed set of semantic actions a DAW user can take, the typed
//! parameters each one carries, the application context recorded beside every
//! action, and the encoding the model sees. This is the shared vocabulary
//! consumed by the procedural data generator (`daw_sim`), the training binary,
//! the prediction model and the Entropy DAW (through `getActionVocab`).
//!
//! Parameters are stored in their natural units (BPM, MIDI notes, steps, list
//! indices) so trajectories stay readable, and normalised to [-1, 1] per
//! `ParamSpec` only when they are fed to the model. The DAW builds each
//! suggested step's controls (knobs, dropdowns, toggles) from the same specs.

use serde::{Deserialize, Serialize};

/// Bumped whenever action ids, parameter layouts or the context encoding
/// change. A checkpoint trained on another version is refused at load time.
pub const DAW_VOCAB_VERSION: u32 = 2;

/// Maximum number of f32 parameters any single action carries.
pub const MAX_ACTION_PARAMS: usize = 4;

/// Scalar application-state features recorded with every step:
/// playing, track count, active pattern fill, arrangement fill.
pub const STATE_DIMS: usize = 4;

// ── Choice lists ──────────────────────────────────────────────────────────────

/// A named list of options a `Choice` parameter indexes into. Ids match the
/// DAW's own ids (daw_synth_addon.ts and its daw_*.ts modules) so the app can
/// map an index back to the thing it names; labels are for the UI.
#[derive(Debug, Clone, Copy)]
pub struct ChoiceList {
    pub id: &'static str,
    pub options: &'static [(&'static str, &'static str)],
}

impl ChoiceList {
    pub fn len(&self) -> usize { self.options.len() }
    pub fn index_of(&self, id: &str) -> Option<usize> { self.options.iter().position(|(o, _)| *o == id) }
}

macro_rules! choice_list {
    ($name:ident, $id:literal, [$(($o:literal, $l:literal)),* $(,)?]) => {
        pub const $name: ChoiceList = ChoiceList { id: $id, options: &[$(($o, $l)),*] };
    };
}

choice_list!(FAMILIES, "families", [
    ("none", "None"), ("drum_rack", "Drum rack"), ("synth", "Synth"), ("wavetable", "Wavetable"),
    ("strings", "Bowed strings"), ("brass", "Brass"), ("piano", "Grand piano"), ("matter", "Matter kit"),
    ("water", "Water"), ("vst3", "VST3 plugin"),
]);
choice_list!(VIEWS, "views", [("arrange", "Arrange"), ("roll", "Piano Roll"), ("mixer", "Mixer")]);
choice_list!(WAVEFORMS, "waveforms", [
    ("sine", "Sine"), ("square", "Square"), ("saw", "Saw"), ("triangle", "Triangle"), ("noise", "Noise"),
]);
choice_list!(SCALES, "scales", [
    ("chromatic", "Chromatic"), ("major", "Major"), ("natural_minor", "Natural minor"), ("dorian", "Dorian"),
    ("pentatonic_major", "Pentatonic major"), ("pentatonic_minor", "Pentatonic minor"), ("blues", "Blues"),
]);
choice_list!(TRANSPORT_MODES, "transport_modes", [("song", "Song"), ("pattern", "Pattern loop")]);
choice_list!(PATTERN_LENGTHS, "pattern_lengths", [("0.5", "1/2 bar"), ("1", "1 bar"), ("2", "2 bars"), ("4", "4 bars")]);
choice_list!(SNAP_MODES, "snap_modes", [("bar", "Bar"), ("beat", "Beat"), ("step", "Step")]);
choice_list!(CHARACTER_KNOBS, "character_knobs", [
    ("pump", "Pump"), ("bounce", "Bounce"), ("gate", "Gate"), ("acid", "Acid"), ("grit", "Grit"),
    ("space", "Space"), ("humanize", "Humanize"),
]);
choice_list!(GATE_PATTERNS, "gate_patterns", [("eighths", "Eighths"), ("sixteenths", "Sixteenths"), ("syncopated", "Syncopated")]);
choice_list!(STUTTER_RATES, "stutter_rates", [("8th", "1/8"), ("16th", "1/16"), ("32nd", "1/32")]);
choice_list!(REVERB_PRESETS, "reverb_presets", [
    ("dry", "Dry"), ("room", "Room"), ("studio", "Studio"), ("plate", "Plate"), ("hall", "Hall"),
    ("cathedral", "Cathedral"), ("wash", "Wash"),
]);
choice_list!(EQ_PRESETS, "eq_presets", [
    ("flat", "Flat"), ("clean-low", "Clean low end"), ("warm", "Warm"), ("air", "Air"), ("presence", "Presence"),
    ("boom", "Boom"), ("scoop", "Scoop"), ("telephone", "Telephone"), ("radio", "Radio"), ("dark-verb", "Dark verb"),
]);
// Bare waveforms first (daw_wavetable.ts WT_PRESETS), then full patches (WT_INSTRUMENT_PRESETS).
choice_list!(WAVETABLE_PRESETS, "wavetable_presets", [
    ("sine", "Sine"), ("saw", "Sine to Saw"), ("square", "Sine to Square"), ("pwm", "Pulse Width"),
    ("vowels", "Vowels"), ("bell", "FM Bell"), ("terrain", "Terrain"), ("glass", "Glass"),
    ("modulated_bass", "Modulated Bass"), ("sub_pulse", "Sub Pulse"), ("acid_bass", "Acid Bass"),
    ("synth_riser", "Synth Riser"), ("sweeping_siren", "Sweeping Siren"), ("laser_zap", "Laser Zap"),
    ("simple_strings", "Simple Strings"), ("simple_horns", "Simple Horns"), ("warm_pad", "Warm Pad"),
    ("glass_pluck", "Glass Pluck"),
]);
choice_list!(STRINGS_INSTRUMENTS, "strings_instruments", [
    ("violin", "Violin"), ("viola", "Viola"), ("cello", "Cello"), ("bass", "Bass"), ("hardanger", "Hardanger"),
    ("glass", "Glass violin"), ("octobass", "Octobass"), ("wolfcello", "Wolf cello"),
]);
choice_list!(BRASS_INSTRUMENTS, "brass_instruments", [("trombone", "Trombone"), ("trumpet", "Trumpet"), ("horn", "Horn"), ("tuba", "Tuba")]);
choice_list!(BRASS_MUTES, "brass_mutes", [("open", "Open"), ("straight", "Straight"), ("cup", "Cup"), ("harmon", "Harmon")]);
choice_list!(BRASS_STYLES, "brass_styles", [
    ("chorale", "Chorale"), ("section", "Section"), ("fanfare", "Fanfare"), ("blazing", "Blazing"),
    ("glissando", "Glissando"), ("rough", "Rough"),
]);
choice_list!(PIANO_PRESETS, "piano_presets", [("ConcertGrand", "Concert Grand"), ("StudioGrand", "Studio Grand")]);
choice_list!(MATTER_PRESETS, "matter_presets", [
    ("studio", "Studio"), ("jazz", "Jazz"), ("rock", "Rock"), ("funk", "Funk"), ("brushes", "Brushes"), ("mallets", "Mallets"),
]);
choice_list!(WATER_PRESETS, "water_presets", [
    ("glass-harp", "Glass harp"), ("spoon-glasses", "Spoon on glasses"), ("drips", "Drips"), ("bottles", "Filling bottles"),
    ("vases", "Filling vases"), ("lakeside", "Lakeside"), ("tent", "Rain on a tent"), ("tin-roof", "Tin roof"),
    ("window", "Rain on the window"), ("cymbal-rain", "Rain on a cymbal"),
]);
choice_list!(WINDOWS, "windows", [
    ("analyzer", "Analyzer"), ("space", "Reverb & EQ"), ("wavetable", "Wavetable"), ("strings", "Bowed strings"),
    ("brass", "Brass"), ("piano", "Grand piano"), ("matter", "Matter kit"), ("water", "Water"),
    ("rack", "Sample rack"), ("guitar", "Guitar input"), ("visualizer", "Music video"),
]);

/// Every choice list, for the vocabulary export.
pub const CHOICE_LISTS: &[ChoiceList] = &[
    FAMILIES, VIEWS, WAVEFORMS, SCALES, TRANSPORT_MODES, PATTERN_LENGTHS, SNAP_MODES, CHARACTER_KNOBS,
    GATE_PATTERNS, STUTTER_RATES, REVERB_PRESETS, EQ_PRESETS, WAVETABLE_PRESETS, STRINGS_INSTRUMENTS,
    BRASS_INSTRUMENTS, BRASS_MUTES, BRASS_STYLES, PIANO_PRESETS, MATTER_PRESETS, WATER_PRESETS, WINDOWS,
];

pub const NUM_FAMILIES: usize = FAMILIES.options.len();
pub const NUM_VIEWS: usize = VIEWS.options.len();

/// Instrument family ids (indices into `FAMILIES`).
pub mod family {
    pub const NONE: u32 = 0;
    pub const DRUM_RACK: u32 = 1;
    pub const SYNTH: u32 = 2;
    pub const WAVETABLE: u32 = 3;
    pub const STRINGS: u32 = 4;
    pub const BRASS: u32 = 5;
    pub const PIANO: u32 = 6;
    pub const MATTER: u32 = 7;
    pub const WATER: u32 = 8;
    pub const VST3: u32 = 9;
}

/// View ids (indices into `VIEWS`).
pub mod view {
    pub const ARRANGE: u32 = 0;
    pub const ROLL: u32 = 1;
    pub const MIXER: u32 = 2;
}

// ── Parameter specs ───────────────────────────────────────────────────────────

/// How a parameter is edited in the Suggested Next Steps panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamKind {
    /// A continuous value: a knob.
    Knob,
    /// A whole number (step, bar, row, count): a knob that snaps to integers.
    Int,
    /// An index into a `ChoiceList`: a dropdown.
    Choice,
    /// On or off: a checkbox.
    Toggle,
    /// A MIDI note number: a knob whose readout is the note name.
    Note,
    /// A track index into the current project: a dropdown of track names.
    Track,
}

/// One parameter of an action: its range, default and how to edit it.
#[derive(Debug, Clone, Copy)]
pub struct ParamSpec {
    pub name: &'static str,
    pub label: &'static str,
    pub kind: ParamKind,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: &'static str,
    /// Normalise on a log scale (frequencies).
    pub log: bool,
    /// The list a `Choice` indexes into.
    pub choices: Option<ChoiceList>,
}

impl ParamSpec {
    const fn new(name: &'static str, label: &'static str, kind: ParamKind, min: f32, max: f32, default: f32) -> Self {
        Self { name, label, kind, min, max, default, unit: "", log: false, choices: None }
    }
    const fn unit(mut self, unit: &'static str) -> Self { self.unit = unit; self }
    const fn log(mut self) -> Self { self.log = true; self }
    const fn choice(name: &'static str, label: &'static str, list: ChoiceList, default: f32) -> Self {
        Self {
            name, label, kind: ParamKind::Choice, min: 0.0, max: (list.options.len() - 1) as f32,
            default, unit: "", log: false, choices: Some(list),
        }
    }

    /// Maps a value in natural units to [-1, 1] for the model.
    pub fn normalize(&self, value: f32) -> f32 {
        if !value.is_finite() || self.max <= self.min { return 0.0; }
        let v = value.clamp(self.min, self.max);
        let t = if self.log && self.min > 0.0 {
            (v / self.min).ln() / (self.max / self.min).ln()
        } else {
            (v - self.min) / (self.max - self.min)
        };
        t * 2.0 - 1.0
    }

    /// Maps a model output in [-1, 1] back to natural units, rounding the
    /// discrete kinds so the result is always a value the control can show.
    pub fn denormalize(&self, x: f32) -> f32 {
        let t = ((x.clamp(-1.0, 1.0)) + 1.0) * 0.5;
        let v = if self.log && self.min > 0.0 {
            self.min * (self.max / self.min).powf(t)
        } else {
            self.min + t * (self.max - self.min)
        };
        match self.kind {
            ParamKind::Knob => v,
            ParamKind::Toggle => if v >= 0.5 * (self.min + self.max) { self.max } else { self.min },
            _ => v.round().clamp(self.min, self.max),
        }
    }
}

use ParamKind::*;

const P_FAMILY: ParamSpec = ParamSpec::choice("family", "Instrument", FAMILIES, 2.0);
const P_TRACK: ParamSpec = ParamSpec::new("track", "Track", Track, 0.0, 15.0, 0.0);
const P_BAR: ParamSpec = ParamSpec::new("bar", "Bar", Int, 0.0, 127.0, 0.0);
const P_BPM: ParamSpec = ParamSpec::new("bpm", "Tempo", Int, 40.0, 220.0, 120.0).unit("BPM");
const P_TRANSPORT_MODE: ParamSpec = ParamSpec::choice("mode", "Play", TRANSPORT_MODES, 0.0);
const P_ROW: ParamSpec = ParamSpec::new("row", "Row", Int, 0.0, 47.0, 4.0);
const P_STEP: ParamSpec = ParamSpec::new("step", "Step", Int, 0.0, 63.0, 0.0);
const P_END_STEP: ParamSpec = ParamSpec::new("end_step", "To step", Int, 0.0, 63.0, 15.0);
const P_LENGTH: ParamSpec = ParamSpec::new("length", "Length", Int, 1.0, 32.0, 2.0).unit("steps");
const P_VELOCITY: ParamSpec = ParamSpec::new("velocity", "Velocity", Knob, 0.0, 1.0, 0.85);
const P_COUNT: ParamSpec = ParamSpec::new("count", "Notes", Int, 1.0, 64.0, 4.0);
const P_PATTERN_BARS: ParamSpec = ParamSpec::choice("bars", "Length", PATTERN_LENGTHS, 1.0);
const P_PATTERN: ParamSpec = ParamSpec::new("pattern", "Pattern", Int, 0.0, 15.0, 0.0);
const P_LANE: ParamSpec = ParamSpec::new("lane", "Channel", Int, 0.0, 15.0, 0.0);
const P_CLIP_BARS: ParamSpec = ParamSpec::new("bars", "Length", Int, 1.0, 32.0, 4.0).unit("bars");
const P_SNAP: ParamSpec = ParamSpec::choice("snap", "Snap", SNAP_MODES, 0.0);
const P_SONG_BARS: ParamSpec = ParamSpec::new("bars", "Song bars", Int, 1.0, 256.0, 16.0);
const P_GAIN: ParamSpec = ParamSpec::new("gain", "Gain", Knob, 0.0, 1.0, 0.5);
const P_ON: ParamSpec = ParamSpec::new("on", "On", Toggle, 0.0, 1.0, 1.0);
const P_WAVEFORM: ParamSpec = ParamSpec::choice("waveform", "Waveform", WAVEFORMS, 2.0);
const P_SCALE: ParamSpec = ParamSpec::choice("scale", "Scale", SCALES, 5.0);
const P_ROOT: ParamSpec = ParamSpec::new("root", "Root", Note, 24.0, 84.0, 60.0);
const P_CUTOFF: ParamSpec = ParamSpec::new("cutoff", "Cutoff", Knob, 100.0, 20000.0, 4000.0).unit("Hz").log();
const P_RESONANCE: ParamSpec = ParamSpec::new("resonance", "Resonance", Knob, 0.1, 10.0, 1.0);
const P_ATTACK: ParamSpec = ParamSpec::new("attack", "Attack", Knob, 0.0, 1.0, 0.005).unit("s");
const P_DECAY: ParamSpec = ParamSpec::new("decay", "Decay", Knob, 0.0, 1.0, 0.08).unit("s");
const P_SUSTAIN: ParamSpec = ParamSpec::new("sustain", "Sustain", Knob, 0.0, 1.0, 0.6);
const P_RELEASE: ParamSpec = ParamSpec::new("release", "Release", Knob, 0.0, 2.0, 0.12).unit("s");
const P_DELAY_TIME: ParamSpec = ParamSpec::new("time", "Time", Knob, 0.0, 1.0, 0.25).unit("s");
const P_FEEDBACK: ParamSpec = ParamSpec::new("feedback", "Feedback", Knob, 0.0, 0.95, 0.35);
const P_MIX: ParamSpec = ParamSpec::new("mix", "Mix", Knob, 0.0, 1.0, 0.25);
const P_ROOM: ParamSpec = ParamSpec::new("room", "Room", Knob, 10.0, 30.0, 14.0).unit("m");
const P_REVERB_TIME: ParamSpec = ParamSpec::new("time", "Time", Knob, 0.1, 6.0, 1.6).unit("s");
const P_DAMPING: ParamSpec = ParamSpec::new("damping", "Damping", Knob, 0.0, 1.0, 0.5);
const P_REVERB_PRESET: ParamSpec = ParamSpec::choice("preset", "Reverb", REVERB_PRESETS, 2.0);
const P_EQ_PRESET: ParamSpec = ParamSpec::choice("preset", "EQ", EQ_PRESETS, 2.0);
const P_KNOB: ParamSpec = ParamSpec::choice("knob", "Knob", CHARACTER_KNOBS, 0.0);
const P_AMOUNT: ParamSpec = ParamSpec::new("amount", "Amount", Knob, 0.0, 1.0, 0.5);
const P_GATE_PATTERN: ParamSpec = ParamSpec::choice("pattern", "Pattern", GATE_PATTERNS, 1.0);
const P_WT_PRESET: ParamSpec = ParamSpec::choice("preset", "Preset", WAVETABLE_PRESETS, 16.0);
const P_POSITION: ParamSpec = ParamSpec::new("position", "Position", Knob, 0.0, 1.0, 0.5);
const P_STRINGS: ParamSpec = ParamSpec::choice("instrument", "Instrument", STRINGS_INSTRUMENTS, 2.0);
const P_BRASS: ParamSpec = ParamSpec::choice("instrument", "Instrument", BRASS_INSTRUMENTS, 1.0);
const P_BRASS_MUTE: ParamSpec = ParamSpec::choice("mute", "Mute", BRASS_MUTES, 0.0);
const P_BRASS_STYLE: ParamSpec = ParamSpec::choice("style", "Style", BRASS_STYLES, 1.0);
const P_PIANO: ParamSpec = ParamSpec::choice("preset", "Piano", PIANO_PRESETS, 0.0);
const P_PEDAL: ParamSpec = ParamSpec::new("sustain", "Pedal", Knob, 0.0, 1.0, 1.0);
const P_MATTER: ParamSpec = ParamSpec::choice("preset", "Kit", MATTER_PRESETS, 0.0);
const P_WATER: ParamSpec = ParamSpec::choice("preset", "Preset", WATER_PRESETS, 0.0);
const P_PLUGIN: ParamSpec = ParamSpec::new("plugin", "Plugin", Int, 0.0, 31.0, 0.0);
const P_PAD: ParamSpec = ParamSpec::new("pad", "Pad", Int, 0.0, 15.0, 0.0);
const P_STUTTER: ParamSpec = ParamSpec::choice("rate", "Rate", STUTTER_RATES, 1.0);
const P_BUILD_BARS: ParamSpec = ParamSpec::new("bars", "Bars", Int, 1.0, 8.0, 4.0);
const P_VIEW: ParamSpec = ParamSpec::choice("view", "View", VIEWS, 1.0);
const P_WINDOW: ParamSpec = ParamSpec::choice("window", "Window", WINDOWS, 0.0);

// ── Action vocabulary ─────────────────────────────────────────────────────────

/// Static metadata for one action.
#[derive(Debug, Clone, Copy)]
pub struct ActionSpec {
    pub name: &'static str,
    pub display_name: &'static str,
    pub category: &'static str,
    pub icon: &'static str,
    pub params: &'static [ParamSpec],
}

macro_rules! daw_actions {
    ($( $variant:ident => $name:literal, $display:literal, $cat:literal, $icon:literal, [$($p:ident),*]; )*) => {
        /// Every semantic action the DAW exposes to the prediction model. The
        /// discriminant is the action id the model predicts over.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[repr(u32)]
        pub enum DawAction { $($variant),* }

        impl DawAction {
            pub const ALL: &'static [DawAction] = &[$(DawAction::$variant),*];
        }

        const SPECS: &[ActionSpec] = &[$(ActionSpec {
            name: $name, display_name: $display, category: $cat, icon: $icon, params: &[$($p),*],
        }),*];
    };
}

daw_actions! {
    // Tracks
    AddTrack            => "add_track", "Add Track", "Track", "plus-circle", [P_FAMILY];
    RemoveTrack         => "remove_track", "Remove Track", "Track", "trash", [P_TRACK];
    SelectTrack         => "select_track", "Select Track", "Track", "cursor", [P_TRACK];
    SetInstrument       => "set_instrument", "Change Instrument", "Track", "swap", [P_FAMILY];
    // Transport
    Play                => "play", "Play", "Transport", "play", [];
    Stop                => "stop", "Stop", "Transport", "stop", [];
    Rewind              => "rewind", "Rewind", "Transport", "skip-back", [];
    Seek                => "seek", "Jump to Bar", "Transport", "crosshair", [P_BAR];
    SetBpm              => "set_bpm", "Set Tempo", "Transport", "metronome", [P_BPM];
    SetTransportMode    => "set_transport_mode", "Song or Loop", "Transport", "repeat", [P_TRANSPORT_MODE];
    // Piano roll
    AddNote             => "add_note", "Add Note", "Piano Roll", "music-note", [P_ROW, P_STEP, P_LENGTH, P_VELOCITY];
    RemoveNote          => "remove_note", "Remove Note", "Piano Roll", "eraser", [P_ROW, P_STEP];
    PaintNotes          => "paint_notes", "Paint Notes", "Piano Roll", "paint-brush", [P_ROW, P_STEP, P_END_STEP, P_COUNT];
    EraseNotes          => "erase_notes", "Erase Notes", "Piano Roll", "eraser", [P_ROW, P_STEP, P_END_STEP, P_COUNT];
    PreviewNote         => "preview_note", "Preview Note", "Piano Roll", "headphones", [P_ROW, P_VELOCITY];
    // Patterns
    NewPattern          => "new_pattern", "New Pattern", "Pattern", "file-plus", [P_PATTERN_BARS];
    DuplicatePattern    => "duplicate_pattern", "Duplicate Pattern", "Pattern", "copy", [];
    SelectPattern       => "select_pattern", "Select Pattern", "Pattern", "squares-four", [P_PATTERN];
    SetPatternLength    => "set_pattern_length", "Pattern Length", "Pattern", "ruler", [P_PATTERN_BARS];
    UsePatternInClip    => "use_pattern_in_clip", "Use Pattern in Clip", "Pattern", "check-circle", [];
    // Arrangement
    CreateClip          => "create_clip", "Draw Clip", "Arrangement", "rectangle", [P_LANE, P_BAR, P_CLIP_BARS];
    MoveClip            => "move_clip", "Move Clip", "Arrangement", "arrows-out-cardinal", [P_BAR];
    ResizeClip          => "resize_clip", "Resize Clip", "Arrangement", "arrows-horizontal", [P_CLIP_BARS];
    DeleteClip          => "delete_clip", "Delete Clip", "Arrangement", "scissors", [];
    DuplicateClip       => "duplicate_clip", "Duplicate Clip", "Arrangement", "copy-simple", [];
    SelectClip          => "select_clip", "Select Clip", "Arrangement", "selection", [P_LANE, P_BAR];
    SetSnap             => "set_snap", "Snap", "Arrangement", "magnet", [P_SNAP];
    SetSongBars         => "set_song_bars", "Song Length", "Arrangement", "timer", [P_SONG_BARS];
    // Mixer
    SetVolume           => "set_volume", "Set Gain", "Mixer", "speaker-high", [P_TRACK, P_GAIN];
    MuteTrack           => "mute_track", "Mute", "Mixer", "speaker-slash", [P_TRACK, P_ON];
    SoloTrack           => "solo_track", "Solo", "Mixer", "headphones", [P_TRACK, P_ON];
    // Sound
    SetWaveform         => "set_waveform", "Waveform", "Sound", "wave-sawtooth", [P_WAVEFORM];
    SetScale            => "set_scale", "Scale", "Sound", "music-notes-simple", [P_SCALE];
    SetRootNote         => "set_root_note", "Root Note", "Sound", "music-note-simple", [P_ROOT];
    SetFilter           => "set_filter", "Filter", "Sound", "funnel", [P_CUTOFF, P_RESONANCE];
    SetEnvelope         => "set_envelope", "Envelope", "Sound", "chart-line", [P_ATTACK, P_DECAY, P_SUSTAIN, P_RELEASE];
    // Effects
    SetDelay            => "set_delay", "Delay", "Effects", "repeat-once", [P_DELAY_TIME, P_FEEDBACK, P_MIX];
    SetReverb           => "set_reverb", "Reverb", "Effects", "waves", [P_ROOM, P_REVERB_TIME, P_DAMPING, P_MIX];
    SetReverbPreset     => "set_reverb_preset", "Reverb Space", "Effects", "cube", [P_REVERB_PRESET];
    SetEqPreset         => "set_eq_preset", "EQ Preset", "Effects", "equalizer", [P_EQ_PRESET];
    SetCharacter        => "set_character", "Character", "Effects", "sparkle", [P_KNOB, P_AMOUNT];
    SetGatePattern      => "set_gate_pattern", "Gate Pattern", "Effects", "pulse", [P_GATE_PATTERN];
    // Instruments
    LoadWavetablePreset => "load_wavetable_preset", "Wavetable Preset", "Instrument", "wave-sine", [P_WT_PRESET];
    SetWavetablePosition=> "set_wavetable_position", "Wavetable Position", "Instrument", "slideshow", [P_POSITION];
    LoadStrings         => "load_strings", "Bowed Instrument", "Instrument", "waveform", [P_STRINGS];
    LoadBrass           => "load_brass", "Brass Instrument", "Instrument", "megaphone", [P_BRASS];
    SetBrassMute        => "set_brass_mute", "Brass Mute", "Instrument", "megaphone-simple", [P_BRASS_MUTE];
    SetBrassStyle       => "set_brass_style", "Brass Style", "Instrument", "music-notes", [P_BRASS_STYLE];
    LoadPianoPreset     => "load_piano_preset", "Piano", "Instrument", "piano-keys", [P_PIANO];
    SetPianoPedal       => "set_piano_pedal", "Sustain Pedal", "Instrument", "sneaker-move", [P_PEDAL];
    LoadMatterPreset    => "load_matter_preset", "Drum Kit", "Instrument", "circles-three", [P_MATTER];
    LoadWaterPreset     => "load_water_preset", "Water Preset", "Instrument", "drop", [P_WATER];
    LoadVst3            => "load_vst3", "VST3 Plugin", "Instrument", "plug", [P_PLUGIN];
    AssignSample        => "assign_sample", "Assign Sample", "Instrument", "file-audio", [P_PAD];
    AddPad              => "add_pad", "Add Pad", "Instrument", "plus-square", [];
    // Moves
    MoveVariation       => "move_variation", "Make Variation", "Moves", "shuffle", [P_AMOUNT];
    MoveThinOut         => "move_thin_out", "Thin Out", "Moves", "minus-circle", [P_AMOUNT];
    MoveStutter         => "move_stutter", "Stutter", "Moves", "dots-three", [P_STUTTER];
    MoveOctaveSpark     => "move_octave_spark", "Octave Spark", "Moves", "lightning", [];
    MoveAnswer          => "move_answer", "Answer Phrase", "Moves", "chat-circle", [];
    MoveKickLock        => "move_kick_lock", "Kick Lock", "Moves", "lock", [];
    MoveBuild           => "move_build", "Build", "Moves", "trend-up", [P_BUILD_BARS];
    MoveDropGap         => "move_drop_gap", "Drop Gap", "Moves", "arrow-line-down", [];
    MoveEchoOut         => "move_echo_out", "Echo Out", "Moves", "speaker-simple-low", [];
    Undo                => "undo", "Undo", "Moves", "arrow-u-up-left", [];
    // View
    OpenView            => "open_view", "Switch View", "View", "layout", [P_VIEW];
    ToggleWindow        => "toggle_window", "Window", "View", "app-window", [P_WINDOW, P_ON];
    // Project
    SaveVersion         => "save_version", "Save Version", "Project", "floppy-disk", [];
    ExportWav           => "export_wav", "Export WAV", "Project", "download-simple", [];
    ExportVideo         => "export_video", "Export Music Video", "Project", "film-strip", [];
    // Guitar
    StartGuitar         => "start_guitar", "Start Guitar Input", "Guitar", "guitar", [];
    StopGuitar          => "stop_guitar", "Stop Guitar Input", "Guitar", "stop-circle", [];
}

/// Total number of distinct semantic actions in the DAW vocabulary.
pub const NUM_DAW_ACTIONS: usize = DawAction::ALL.len();

/// Padding action ID.
pub const PAD_ACTION: u32 = NUM_DAW_ACTIONS as u32;

/// Beginning-of-sequence sentinel.
pub const BOS_ACTION: u32 = NUM_DAW_ACTIONS as u32 + 1;

/// End-of-sequence sentinel.
pub const EOS_ACTION: u32 = NUM_DAW_ACTIONS as u32 + 2;

/// Full vocabulary size including sentinels.
pub const ACTION_VOCAB_SIZE: usize = NUM_DAW_ACTIONS + 3;

impl DawAction {
    pub fn id(self) -> u32 { self as u32 }

    pub fn from_id(id: u32) -> Option<Self> { Self::ALL.get(id as usize).copied() }

    pub fn from_name(name: &str) -> Option<Self> { Self::ALL.iter().copied().find(|a| a.name() == name) }

    pub fn spec(self) -> &'static ActionSpec { &SPECS[self as usize] }

    pub fn name(self) -> &'static str { self.spec().name }

    /// Human-readable display label for the UI.
    pub fn display_name(self) -> &'static str { self.spec().display_name }

    /// Category for grouping and UI badges.
    pub fn category(self) -> &'static str { self.spec().category }

    /// Phosphor icon name for rendering in UI buttons and step lists.
    pub fn icon(self) -> &'static str { self.spec().icon }

    pub fn params(self) -> &'static [ParamSpec] { self.spec().params }

    /// Number of meaningful float parameters this action carries.
    pub fn param_count(self) -> usize { self.params().len() }

    /// Suggested sensible default parameters for this action.
    pub fn default_params(self) -> [f32; MAX_ACTION_PARAMS] {
        let mut p = [0.0; MAX_ACTION_PARAMS];
        for (slot, spec) in p.iter_mut().zip(self.params()) { *slot = spec.default; }
        p
    }

    /// The model's view of `raw` parameters: each in [-1, 1], unused slots 0.
    pub fn normalize_params(self, raw: &[f32; MAX_ACTION_PARAMS]) -> [f32; MAX_ACTION_PARAMS] {
        let mut p = [0.0; MAX_ACTION_PARAMS];
        for (i, spec) in self.params().iter().enumerate() { p[i] = spec.normalize(raw[i]); }
        p
    }

    /// Parameters in natural units from the model's normalised output.
    pub fn denormalize_params(self, norm: &[f32]) -> Vec<f32> {
        self.params().iter().enumerate().map(|(i, s)| s.denormalize(norm.get(i).copied().unwrap_or(0.0))).collect()
    }
}

/// Normalised parameters for any id, sentinels included (all zero).
pub fn normalize_step_params(action_id: u32, raw: &[f32; MAX_ACTION_PARAMS]) -> [f32; MAX_ACTION_PARAMS] {
    DawAction::from_id(action_id).map(|a| a.normalize_params(raw)).unwrap_or([0.0; MAX_ACTION_PARAMS])
}

/// How many parameter slots of `action_id` carry a value (0 for sentinels).
pub fn param_mask(action_id: u32) -> [f32; MAX_ACTION_PARAMS] {
    let n = DawAction::from_id(action_id).map(|a| a.param_count()).unwrap_or(0);
    let mut m = [0.0; MAX_ACTION_PARAMS];
    for slot in m.iter_mut().take(n) { *slot = 1.0; }
    m
}

// ── Step context ──────────────────────────────────────────────────────────────

/// What the DAW looked like right after an action: the instrument family of
/// the track being worked on, the view on screen, and a few scalars. This is
/// the "application state" half of the model's input.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StepContext {
    /// Instrument family of the active track (index into `FAMILIES`).
    #[serde(rename = "f", default)]
    pub family: u32,
    /// The DAW view on screen (index into `VIEWS`).
    #[serde(rename = "v", default)]
    pub view: u32,
    #[serde(rename = "pl", default)]
    pub playing: bool,
    /// Number of tracks in the song.
    #[serde(rename = "tr", default)]
    pub tracks: u32,
    /// Active pattern: notes per step, capped at 1.
    #[serde(rename = "pf", default)]
    pub pattern_fill: f32,
    /// Arrangement: fraction of track-bars covered by clips.
    #[serde(rename = "sf", default)]
    pub song_fill: f32,
}

impl Default for StepContext {
    fn default() -> Self {
        Self { family: family::DRUM_RACK, view: view::ARRANGE, playing: false, tracks: 2, pattern_fill: 0.0, song_fill: 0.0 }
    }
}

impl StepContext {
    pub fn state_vector(&self) -> [f32; STATE_DIMS] {
        [
            if self.playing { 1.0 } else { 0.0 },
            (self.tracks as f32 / 16.0).min(1.0),
            self.pattern_fill.clamp(0.0, 1.0),
            self.song_fill.clamp(0.0, 1.0),
        ]
    }

    /// Best-effort guess at the context after `action`, for chaining
    /// predictions without a running DAW.
    pub fn advance(&self, action: DawAction, params: &[f32]) -> Self {
        let p = |i: usize| params.get(i).copied().unwrap_or(0.0);
        let mut c = *self;
        match action {
            DawAction::Play => c.playing = true,
            DawAction::Stop => c.playing = false,
            DawAction::AddTrack => { c.tracks = (c.tracks + 1).min(16); c.family = p(0) as u32; c.pattern_fill = 0.0; }
            DawAction::RemoveTrack => c.tracks = c.tracks.saturating_sub(1).max(1),
            DawAction::SetInstrument => c.family = p(0) as u32,
            DawAction::OpenView => c.view = (p(0) as u32).min(NUM_VIEWS as u32 - 1),
            DawAction::AddNote => c.pattern_fill = (c.pattern_fill + 1.0 / 16.0).min(1.0),
            DawAction::PaintNotes => c.pattern_fill = (c.pattern_fill + p(3) / 16.0).min(1.0),
            DawAction::RemoveNote => c.pattern_fill = (c.pattern_fill - 1.0 / 16.0).max(0.0),
            DawAction::EraseNotes => c.pattern_fill = (c.pattern_fill - p(3) / 16.0).max(0.0),
            DawAction::NewPattern => c.pattern_fill = 0.0,
            DawAction::CreateClip | DawAction::DuplicateClip => c.song_fill = (c.song_fill + 0.05).min(1.0),
            DawAction::DeleteClip => c.song_fill = (c.song_fill - 0.05).max(0.0),
            _ => {}
        }
        c
    }
}

// ── Encoded action step ───────────────────────────────────────────────────────

/// A single timestep in an action sequence: an action id, up to
/// MAX_ACTION_PARAMS parameters in natural units, and the context after it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionStep {
    #[serde(rename = "a")]
    pub action_id: u32,
    #[serde(rename = "p")]
    pub params: [f32; MAX_ACTION_PARAMS],
    #[serde(rename = "c", default)]
    pub context: StepContext,
}

impl ActionStep {
    pub fn new(action: DawAction, params: &[f32]) -> Self {
        Self::with_context(action, params, StepContext::default())
    }

    pub fn with_context(action: DawAction, params: &[f32], context: StepContext) -> Self {
        let mut p = action.default_params();
        let n = params.len().min(MAX_ACTION_PARAMS).min(action.param_count());
        p[..n].copy_from_slice(&params[..n]);
        Self { action_id: action.id(), params: p, context }
    }

    pub fn pad() -> Self {
        Self { action_id: PAD_ACTION, params: [0.0; MAX_ACTION_PARAMS], context: StepContext::default() }
    }

    pub fn bos() -> Self { Self::bos_with(StepContext::default()) }

    pub fn bos_with(context: StepContext) -> Self {
        Self { action_id: BOS_ACTION, params: [0.0; MAX_ACTION_PARAMS], context }
    }

    pub fn eos() -> Self {
        Self { action_id: EOS_ACTION, params: [0.0; MAX_ACTION_PARAMS], context: StepContext::default() }
    }

    pub fn action(&self) -> Option<DawAction> { DawAction::from_id(self.action_id) }
}

// ── Trajectories ──────────────────────────────────────────────────────────────

/// High-level goals the procedural generator chains into sessions. A session
/// records the goals it pursued; the model never sees them, they exist for
/// data statistics and evaluation breakdowns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u32)]
pub enum DawTask {
    StartSong       = 0,
    BuildDrums      = 1,
    WriteBass       = 2,
    WriteChords     = 3,
    WriteMelody     = 4,
    SoundDesign     = 5,
    Arrange         = 6,
    MakeVariation   = 7,
    Mix             = 8,
    Finish          = 9,
    EditPattern     = 10,
    GuitarTake      = 11,
}

impl DawTask {
    pub const ALL: [DawTask; 12] = [
        Self::StartSong, Self::BuildDrums, Self::WriteBass, Self::WriteChords, Self::WriteMelody,
        Self::SoundDesign, Self::Arrange, Self::MakeVariation, Self::Mix, Self::Finish,
        Self::EditPattern, Self::GuitarTake,
    ];

    pub fn id(self) -> u32 { self as u32 }
}

pub const NUM_DAW_TASKS: usize = DawTask::ALL.len();

/// One generated session: the goals it pursued and every action taken.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trajectory {
    #[serde(default)]
    pub vocab_version: u32,
    pub tasks: Vec<u32>,
    #[serde(default)]
    pub genre: String,
    pub steps: Vec<ActionStep>,
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_ids_are_contiguous() {
        for (i, action) in DawAction::ALL.iter().enumerate() {
            assert_eq!(action.id() as usize, i);
        }
        assert_eq!(SPECS.len(), NUM_DAW_ACTIONS);
    }

    #[test]
    fn round_trip_action_id_and_name() {
        for &action in DawAction::ALL {
            assert_eq!(DawAction::from_id(action.id()), Some(action));
            assert_eq!(DawAction::from_name(action.name()), Some(action));
        }
        assert_eq!(DawAction::from_id(NUM_DAW_ACTIONS as u32), None);
    }

    #[test]
    fn names_are_unique() {
        let mut names: Vec<_> = DawAction::ALL.iter().map(|a| a.name()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), NUM_DAW_ACTIONS);
    }

    #[test]
    fn sentinel_ids_are_distinct() {
        assert_ne!(PAD_ACTION, BOS_ACTION);
        assert_ne!(BOS_ACTION, EOS_ACTION);
        assert!(PAD_ACTION >= NUM_DAW_ACTIONS as u32);
    }

    #[test]
    fn every_action_fits_the_param_slots() {
        for &a in DawAction::ALL {
            assert!(a.param_count() <= MAX_ACTION_PARAMS, "{} has too many params", a.name());
            for p in a.params() {
                assert!(p.max > p.min, "{}.{} has an empty range", a.name(), p.name);
                assert!(p.default >= p.min && p.default <= p.max, "{}.{} default out of range", a.name(), p.name);
                assert_eq!(p.kind == ParamKind::Choice, p.choices.is_some(), "{}.{}", a.name(), p.name);
            }
        }
    }

    #[test]
    fn normalize_round_trips() {
        for &a in DawAction::ALL {
            let raw = a.default_params();
            let back = a.denormalize_params(&a.normalize_params(&raw));
            for (i, spec) in a.params().iter().enumerate() {
                let tol = if spec.log { spec.default * 1e-3 } else { 1e-3 * (spec.max - spec.min) };
                assert!((back[i] - raw[i]).abs() <= tol.max(1e-4), "{}.{}: {} -> {}", a.name(), spec.name, raw[i], back[i]);
            }
            for v in a.normalize_params(&raw).iter() {
                assert!((-1.0..=1.0).contains(v));
            }
        }
    }

    #[test]
    fn discrete_params_denormalize_to_whole_numbers() {
        let spec = DawAction::AddNote.params()[1];
        assert_eq!(spec.denormalize(0.123), spec.denormalize(0.123).round());
        let choice = DawAction::SetScale.params()[0];
        let v = choice.denormalize(0.9);
        assert!(v.fract() == 0.0 && v < SCALES.len() as f32);
    }

    #[test]
    fn action_step_preserves_params_and_fills_defaults() {
        let step = ActionStep::new(DawAction::AddNote, &[5.0, 8.0]);
        assert_eq!(step.action_id, DawAction::AddNote.id());
        assert_eq!(step.params[..2], [5.0, 8.0]);
        assert_eq!(step.params[2], P_LENGTH.default);
        let play = ActionStep::new(DawAction::Play, &[1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(play.params, [0.0; MAX_ACTION_PARAMS]);
    }

    #[test]
    fn context_advance_tracks_transport_and_view() {
        let c = StepContext::default().advance(DawAction::Play, &[]);
        assert!(c.playing);
        let c = c.advance(DawAction::OpenView, &[view::MIXER as f32]);
        assert_eq!(c.view, view::MIXER);
        let c = c.advance(DawAction::AddTrack, &[family::BRASS as f32]);
        assert_eq!(c.family, family::BRASS);
    }

    #[test]
    fn step_serializes_compactly() {
        let step = ActionStep::new(DawAction::SetBpm, &[128.0]);
        let json = serde_json::to_string(&step).unwrap();
        assert!(json.len() < 120, "{json}");
        let back: ActionStep = serde_json::from_str(&json).unwrap();
        assert_eq!(back.params, step.params);
    }
}
