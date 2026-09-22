//! VST3 instrument hosting for the DAW, built on the `vst3-host` crate.
//!
//! A loaded plugin has three faces, each pinned to a thread on purpose:
//!
//! * **Main thread** - load, editor window, state save/restore, parameter edits. Confirmed the hard
//!   way: creating Maschine 3 on a worker thread and then touching it from the main thread died
//!   with `STATUS_ACCESS_VIOLATION`. Plugins are created and torn down on the thread that pumps
//!   the window messages (winit's), so the registry below is a `thread_local!`, not a global.
//! * **Audio thread** - `Vst3Source::next` renders one block at a time out of `Plugin::process_audio`.
//!   It only ever `try_lock`s the plugin and the command queue: if the main thread happens to hold
//!   either (opening an editor can take a few hundred ms), that block is silence, never a stall.
//! * **Anywhere** - `Vst3Shared`, a bag of atomics and a command queue both sides can see.
//!
//! The source is added to a track's existing `TrackBus` mixer (`AudioEngine::add_track_source`), so a
//! VST3 track gets the bus's gain/mute/solo and the delay/reverb chain exactly like a built-in voice.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rodio::Source;
use serde::Serialize;
use vst3_host::midi::{MidiChannel, MidiEvent};
use vst3_host::{AudioBuffers, Plugin, PluginInfo, PluginWindow, Vst3Host};

/// Same fixed rate the rest of `AudioEngine` renders at (rodio resamples to the device).
pub const SAMPLE_RATE: u32 = 44100;
/// Frames per `process` call. 512 @ 44.1kHz is 11.6ms: a note-on lands on the next block boundary,
/// so this is also the worst-case added trigger jitter.
pub const BLOCK_FRAMES: usize = 512;

fn channel_from_index(index: u8) -> MidiChannel {
    match index {
        0 => MidiChannel::Ch1,
        1 => MidiChannel::Ch2,
        2 => MidiChannel::Ch3,
        3 => MidiChannel::Ch4,
        4 => MidiChannel::Ch5,
        5 => MidiChannel::Ch6,
        6 => MidiChannel::Ch7,
        7 => MidiChannel::Ch8,
        8 => MidiChannel::Ch9,
        9 => MidiChannel::Ch10,
        10 => MidiChannel::Ch11,
        11 => MidiChannel::Ch12,
        12 => MidiChannel::Ch13,
        13 => MidiChannel::Ch14,
        14 => MidiChannel::Ch15,
        _ => MidiChannel::Ch16,
    }
}

// --- Scanning -----------------------------------------------------------------------------------

/// One installed VST3 plugin, as shown in the DAW's instrument picker.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vst3PluginEntry {
    pub name: String,
    pub vendor: String,
    /// The class's sub-categories, e.g. `Instrument|Synth` or `Fx|Analyzer`.
    pub category: String,
    pub path: String,
    pub is_instrument: bool,
    pub has_gui: bool,
    pub has_midi_input: bool,
    pub has_midi_output: bool,
    pub audio_inputs: u32,
    pub audio_outputs: u32,
}

pub fn default_scan_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from(r"C:\Program Files\Common Files\VST3"),
        PathBuf::from(r"C:\Program Files (x86)\Common Files\VST3"),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Programs").join("Common").join("VST3"));
    }
    dirs
}

/// Every `.vst3` file or bundle directory under `dir`, one level of subfolders deep (vendors like
/// to nest). This is our own walk because `vst3-host` 0.9.0's `discover_plugins` returned zero
/// results for a folder of single-file `.vst3` DLLs - the layout every plugin here uses.
fn find_vst3_paths(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.flatten() {
        let path = entry.path();
        let is_vst3 = path.extension().map(|e| e.eq_ignore_ascii_case("vst3")).unwrap_or(false);
        if is_vst3 {
            out.push(path);
        } else if depth > 0 && path.is_dir() {
            find_vst3_paths(&path, depth - 1, out);
        }
    }
}

/// The first `<name>.vst3` (file or bundle) in the default scan folders, without loading anything.
pub fn find_plugin_path(name: &str) -> Option<PathBuf> {
    let wanted = format!("{name}.vst3").to_lowercase();
    let mut paths = Vec::new();
    for dir in default_scan_dirs() {
        find_vst3_paths(&dir, 1, &mut paths);
    }
    paths.into_iter().find(|p| {
        p.file_name().map(|f| f.to_string_lossy().to_lowercase() == wanted).unwrap_or(false)
    })
}

/// Reads each plugin's factory metadata. This *loads* the plugin (Maschine 3 measured 1.9s, the
/// other three 90-140ms on the dev machine) and does it in-process, so a plugin that crashes during
/// its own init takes the app with it - `vst3-host` has an isolated probe for that, not used yet.
/// Returns the plugins that read cleanly plus a note for each one that didn't.
pub fn scan_plugins(dirs: &[PathBuf]) -> (Vec<Vst3PluginEntry>, Vec<String>) {
    let mut paths = Vec::new();
    for dir in dirs {
        find_vst3_paths(dir, 1, &mut paths);
    }
    paths.sort();
    paths.dedup();

    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        match vst3_host::discovery::get_plugin_info(&path) {
            Ok(info) => entries.push(Vst3PluginEntry {
                is_instrument: info.category.contains("Instrument"),
                name: info.name,
                vendor: info.vendor,
                category: info.category,
                path: path.to_string_lossy().to_string(),
                has_gui: info.has_gui,
                has_midi_input: info.has_midi_input,
                has_midi_output: info.has_midi_output,
                audio_inputs: info.audio_inputs,
                audio_outputs: info.audio_outputs,
            }),
            Err(e) => skipped.push(format!("{}: {e}", path.display())),
        }
    }
    (entries, skipped)
}

// --- Audio-thread side -----------------------------------------------------------------------

enum Command {
    NoteOn { channel: u8, note: u8, velocity: u8, hold_frames: u64 },
    /// A note that lasts until its own `NoteOff`: what a live player (the guitar input) sends.
    NoteOnHeld { channel: u8, note: u8, velocity: u8 },
    NoteOff { channel: u8, note: u8 },
    /// 14-bit pitch bend, 8192 is center.
    PitchBend { channel: u8, value: u16 },
    AllNotesOff,
}

struct PendingOff {
    frames_left: u64,
    channel: u8,
    note: u8,
}

/// State both threads see. Everything here is lock-free except the command queue, which the audio
/// thread only ever `try_lock`s.
struct Vst3Shared {
    commands: Mutex<Vec<Command>>,
    alive: AtomicBool,
    source_released: AtomicBool,
    /// Largest |sample| since the last `take_peak`, as f32 bits.
    peak_since_take: AtomicU32,
    lifetime_peak: AtomicU32,
    blocks: AtomicU64,
    /// Blocks rendered as silence because the main thread held the plugin lock.
    skipped_blocks: AtomicU64,
    notes_sent: AtomicU64,
}

fn fetch_max_f32(cell: &AtomicU32, value: f32) {
    let mut current = cell.load(Ordering::Relaxed);
    while value > f32::from_bits(current) {
        match cell.compare_exchange_weak(current, value.to_bits(), Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(actual) => current = actual,
        }
    }
}

/// Infinite stereo `rodio::Source` that pulls audio out of one plugin, a block at a time.
pub struct Vst3Source {
    plugin: Option<Arc<Mutex<Plugin>>>,
    shared: Arc<Vst3Shared>,
    bufs: AudioBuffers,
    /// Interleaved stereo for the current block.
    out: Vec<f32>,
    pos: usize,
    pending_offs: Vec<PendingOff>,
    /// Commands taken from the queue while the plugin lock was contended; retried next block.
    carry: Vec<Command>,
}

impl Vst3Source {
    fn render_block(&mut self) {
        let mut cmds = std::mem::take(&mut self.carry);
        if let Ok(mut queue) = self.shared.commands.try_lock() {
            cmds.append(&mut queue);
        }

        let plugin = self.plugin.as_ref().expect("source used after release");
        let Ok(mut p) = plugin.try_lock() else {
            self.carry = cmds;
            self.out.iter_mut().for_each(|s| *s = 0.0);
            self.shared.skipped_blocks.fetch_add(1, Ordering::Relaxed);
            return;
        };

        for cmd in cmds {
            match cmd {
                Command::NoteOn { channel, note, velocity, hold_frames } => {
                    let event = MidiEvent::NoteOn { channel: channel_from_index(channel), note, velocity };
                    if p.send_midi_event_at(event, 0).is_ok() {
                        self.shared.notes_sent.fetch_add(1, Ordering::Relaxed);
                    }
                    self.pending_offs.push(PendingOff { frames_left: hold_frames, channel, note });
                }
                Command::NoteOnHeld { channel, note, velocity } => {
                    let event = MidiEvent::NoteOn { channel: channel_from_index(channel), note, velocity };
                    if p.send_midi_event_at(event, 0).is_ok() {
                        self.shared.notes_sent.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Command::NoteOff { channel, note } => {
                    let event = MidiEvent::NoteOff { channel: channel_from_index(channel), note, velocity: 0 };
                    let _ = p.send_midi_event_at(event, 0);
                }
                Command::PitchBend { channel, value } => {
                    let event = MidiEvent::PitchBend { channel: channel_from_index(channel), value: value.min(16383) };
                    let _ = p.send_midi_event_at(event, 0);
                }
                Command::AllNotesOff => {
                    let _ = p.midi_panic();
                    self.pending_offs.clear();
                }
            }
        }

        // Note-offs whose hold time ends inside this block go out at their exact sample offset,
        // sorted, since the VST3 event list is expected in ascending sampleOffset order.
        let mut due: Vec<(i32, u8, u8)> = Vec::new();
        self.pending_offs.retain_mut(|off| {
            if off.frames_left < BLOCK_FRAMES as u64 {
                due.push((off.frames_left as i32, off.channel, off.note));
                false
            } else {
                off.frames_left -= BLOCK_FRAMES as u64;
                true
            }
        });
        due.sort_by_key(|d| d.0);
        for (offset, channel, note) in due {
            let event = MidiEvent::NoteOff { channel: channel_from_index(channel), note, velocity: 0 };
            let _ = p.send_midi_event_at(event, offset);
        }

        self.bufs.clear();
        let rendered = p.process_audio(&mut self.bufs).is_ok();
        drop(p);

        let mut peak = 0.0f32;
        if rendered {
            let left = &self.bufs.outputs[0];
            let right = self.bufs.outputs.get(1).unwrap_or(left);
            for i in 0..BLOCK_FRAMES {
                let (l, r) = (left[i], right[i]);
                let l = if l.is_finite() { l } else { 0.0 };
                let r = if r.is_finite() { r } else { 0.0 };
                self.out[i * 2] = l;
                self.out[i * 2 + 1] = r;
                peak = peak.max(l.abs()).max(r.abs());
            }
        } else {
            self.out.iter_mut().for_each(|s| *s = 0.0);
        }
        fetch_max_f32(&self.shared.peak_since_take, peak);
        fetch_max_f32(&self.shared.lifetime_peak, peak);
        self.shared.blocks.fetch_add(1, Ordering::Relaxed);
    }
}

impl Iterator for Vst3Source {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        if !self.shared.alive.load(Ordering::Relaxed) {
            return None;
        }
        if self.pos >= self.out.len() {
            self.render_block();
            self.pos = 0;
        }
        let sample = self.out[self.pos];
        self.pos += 1;
        Some(sample)
    }
}

impl Source for Vst3Source {
    fn current_span_len(&self) -> Option<usize> { None }
    fn channels(&self) -> u16 { 2 }
    fn sample_rate(&self) -> u32 { SAMPLE_RATE }
    fn total_duration(&self) -> Option<Duration> { None }
}

impl Drop for Vst3Source {
    /// Drops this side's `Arc<Mutex<Plugin>>` *before* flagging release, so `Vst3Instrument::unload`
    /// knows the main thread now holds the last reference and the plugin's thread-affine teardown
    /// happens there, not on the audio thread.
    fn drop(&mut self) {
        self.plugin.take();
        self.shared.source_released.store(true, Ordering::Release);
    }
}

// --- Main-thread side --------------------------------------------------------------------------

/// A handle that can queue notes for one plugin from any thread. The `Vst3Instrument` itself is
/// main-thread only (plugins are thread-affine, so the registry below is a `thread_local!`); the
/// command queue it feeds is not, and is all a live player needs. Get one on the main thread with
/// `Vst3Instrument::sender`, then move it to whichever thread plays.
#[derive(Clone)]
pub struct Vst3Sender {
    shared: Arc<Vst3Shared>,
}

impl Vst3Sender {
    fn push(&self, cmd: Command) {
        self.shared.commands.lock().unwrap().push(cmd);
    }

    pub fn note_on_held(&self, channel: u8, note: u8, velocity: u8) {
        self.push(Command::NoteOnHeld { channel, note: note.min(127), velocity: velocity.clamp(1, 127) });
    }

    pub fn note_off(&self, channel: u8, note: u8) {
        self.push(Command::NoteOff { channel, note: note.min(127) });
    }

    pub fn pitch_bend(&self, channel: u8, value: u16) {
        self.push(Command::PitchBend { channel, value: value.min(16383) });
    }

    pub fn all_notes_off(&self) {
        self.push(Command::AllNotesOff);
    }
}

pub struct Vst3Instrument {
    pub info: PluginInfo,
    plugin: Arc<Mutex<Plugin>>,
    shared: Arc<Vst3Shared>,
    window: Option<PluginWindow>,
    dirty_since: Option<Instant>,
    /// A state snapshot taken on editor close / after edits, waiting for the addon to collect it.
    captured_state: Option<Vec<u8>>,
    // Declared last so it drops after the plugin (see `discovery::get_plugin_info`'s comment about
    // the host context outliving the module).
    _host: Vst3Host,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vst3Stats {
    pub track_id: String,
    pub plugin: String,
    pub blocks: u64,
    pub skipped_blocks: u64,
    pub notes_sent: u64,
    pub lifetime_peak: f32,
    pub editor_open: bool,
}

/// Loads `path` on the calling (main) thread, optionally restores a saved state, starts
/// processing, and returns the controlling half plus the audio source to hand to a mixer.
pub fn load_instrument(path: &Path, state: Option<&[u8]>) -> Result<(Vst3Instrument, Vst3Source), String> {
    let mut host = Vst3Host::builder()
        .sample_rate(SAMPLE_RATE as f64)
        .block_size(BLOCK_FRAMES)
        .build()
        .map_err(|e| format!("VST3 host init failed: {e}"))?;
    let mut plugin = host.load_plugin(path).map_err(|e| format!("load failed: {e}"))?;
    if let Some(bytes) = state {
        // A stale/foreign blob is not fatal: the plugin still loads with its defaults.
        if let Err(e) = plugin.load_state(bytes) {
            eprintln!("[vst3] {}: state restore failed, using defaults: {e}", path.display());
        }
    }
    plugin.start_processing().map_err(|e| format!("start_processing failed: {e}"))?;
    let info = plugin.info().clone();
    let plugin = Arc::new(Mutex::new(plugin));

    let shared = Arc::new(Vst3Shared {
        commands: Mutex::new(Vec::new()),
        alive: AtomicBool::new(true),
        source_released: AtomicBool::new(false),
        peak_since_take: AtomicU32::new(0),
        lifetime_peak: AtomicU32::new(0),
        blocks: AtomicU64::new(0),
        skipped_blocks: AtomicU64::new(0),
        notes_sent: AtomicU64::new(0),
    });
    let source = Vst3Source {
        plugin: Some(plugin.clone()),
        shared: shared.clone(),
        bufs: AudioBuffers::new(0, 2, BLOCK_FRAMES, SAMPLE_RATE as f64),
        out: vec![0.0; BLOCK_FRAMES * 2],
        pos: BLOCK_FRAMES * 2,
        pending_offs: Vec::new(),
        carry: Vec::new(),
    };
    let instrument = Vst3Instrument {
        info,
        plugin,
        shared,
        window: None,
        dirty_since: None,
        captured_state: None,
        _host: host,
    };
    Ok((instrument, source))
}

impl Vst3Instrument {
    fn push(&self, cmd: Command) {
        self.shared.commands.lock().unwrap().push(cmd);
    }

    /// `hold_seconds` is when the matching note-off is sent, counted in rendered frames rather than
    /// wall-clock time so it stays exact even if the audio thread hiccups.
    pub fn note_on(&self, channel: u8, note: u8, velocity: u8, hold_seconds: f64) {
        let hold_frames = (hold_seconds.max(0.0) * SAMPLE_RATE as f64) as u64;
        self.push(Command::NoteOn { channel, note: note.min(127), velocity: velocity.clamp(1, 127), hold_frames });
    }

    pub fn note_off(&self, channel: u8, note: u8) {
        self.push(Command::NoteOff { channel, note: note.min(127) });
    }

    /// A thread-safe way to queue notes for this plugin.
    pub fn sender(&self) -> Vst3Sender {
        Vst3Sender { shared: self.shared.clone() }
    }

    /// A note that sounds until `note_off`, for live input where the length is not known yet.
    pub fn note_on_held(&self, channel: u8, note: u8, velocity: u8) {
        self.push(Command::NoteOnHeld { channel, note: note.min(127), velocity: velocity.clamp(1, 127) });
    }

    /// 14-bit pitch bend (0..=16383, 8192 is center). What the plugin does with it depends on its own
    /// bend range setting.
    pub fn pitch_bend(&self, channel: u8, value: u16) {
        self.push(Command::PitchBend { channel, value: value.min(16383) });
    }

    pub fn all_notes_off(&self) {
        self.push(Command::AllNotesOff);
    }

    /// Takes the peak level (linear, 0..1+) rendered since the previous call.
    pub fn take_peak(&self) -> f32 {
        f32::from_bits(self.shared.peak_since_take.swap(0, Ordering::Relaxed))
    }

    pub fn stats(&self, track_id: &str) -> Vst3Stats {
        Vst3Stats {
            track_id: track_id.to_string(),
            plugin: self.info.name.clone(),
            blocks: self.shared.blocks.load(Ordering::Relaxed),
            skipped_blocks: self.shared.skipped_blocks.load(Ordering::Relaxed),
            notes_sent: self.shared.notes_sent.load(Ordering::Relaxed),
            lifetime_peak: f32::from_bits(self.shared.lifetime_peak.load(Ordering::Relaxed)),
            editor_open: self.editor_open(),
        }
    }

    pub fn has_editor(&self) -> bool {
        self.plugin.lock().map(|p| p.has_editor()).unwrap_or(false)
    }

    pub fn editor_open(&self) -> bool {
        self.window.as_ref().map(|w| w.is_open()).unwrap_or(false)
    }

    /// Title of the native editor window, which is how the BDD screenshot code finds its HWND.
    pub fn editor_window_title(&self) -> String {
        format!("{} - VST3", self.info.name)
    }

    pub fn open_editor(&mut self) -> Result<(), String> {
        if self.editor_open() {
            return Ok(());
        }
        self.window = None;
        let mut window = PluginWindow::new(self.plugin.clone());
        window.open().map_err(|e| format!("editor failed to open: {e}"))?;
        self.window = Some(window);
        Ok(())
    }

    pub fn close_editor(&mut self) {
        if let Some(mut window) = self.window.take() {
            window.close();
            self.capture_state();
        }
    }

    /// Per-frame housekeeping: pumps the editor window's deferred resize/DPI work, notices the user
    /// closing the window with its title-bar button, and debounces "the user edited a parameter"
    /// into a state snapshot.
    pub fn service(&mut self) {
        let mut user_closed = false;
        if let Some(window) = &self.window {
            if window.closed_by_user() {
                user_closed = true;
            } else {
                let _ = window.service_platform_events();
            }
        }
        if user_closed {
            self.close_editor();
            return;
        }

        if self.window.is_some() {
            if let Ok(mut p) = self.plugin.try_lock() {
                if !p.take_parameter_edits().is_empty() {
                    self.dirty_since = Some(Instant::now());
                }
            }
            if self.dirty_since.map(|t| t.elapsed() > Duration::from_secs(1)).unwrap_or(false) {
                self.capture_state();
            }
        }
    }

    fn capture_state(&mut self) {
        self.dirty_since = None;
        if let Ok(bytes) = self.plugin.lock().unwrap().save_state() {
            self.captured_state = Some(bytes);
        }
    }

    /// A snapshot taken by `service`/`close_editor` since the last poll, if any.
    pub fn take_captured_state(&mut self) -> Option<Vec<u8>> {
        self.captured_state.take()
    }

    pub fn save_state(&self) -> Result<Vec<u8>, String> {
        self.plugin.lock().unwrap().save_state().map_err(|e| e.to_string())
    }

    pub fn load_state(&self, bytes: &[u8]) -> Result<(), String> {
        self.plugin.lock().unwrap().load_state(bytes).map_err(|e| e.to_string())
    }

    pub fn parameter_count(&self) -> usize {
        self.plugin.lock().unwrap().get_parameters().map(|p| p.len()).unwrap_or(0)
    }

    /// Parameters whose name contains `query` (case-insensitive), capped at `limit`. Vital alone
    /// exposes 2983, so there is deliberately no "return everything" call.
    pub fn find_parameters(&self, query: &str, limit: usize) -> Vec<ParameterView> {
        let q = query.to_lowercase();
        let plugin = self.plugin.lock().unwrap();
        let Ok(all) = plugin.get_parameters() else { return Vec::new() };
        all.into_iter()
            .filter(|p| !p.is_read_only && p.name.to_lowercase().contains(&q))
            .take(limit)
            .map(|p| {
                let display = plugin.format_parameter(p.id, p.value).unwrap_or_default();
                ParameterView { id: p.id, name: p.name, value: p.value, display, step_count: p.step_count }
            })
            .collect()
    }

    pub fn get_parameter(&self, id: u32) -> Result<f64, String> {
        self.plugin.lock().unwrap().get_parameter(id).map_err(|e| e.to_string())
    }

    pub fn set_parameter(&self, id: u32, value: f64) -> Result<(), String> {
        self.plugin.lock().unwrap().set_parameter(id, value.clamp(0.0, 1.0)).map_err(|e| e.to_string())
    }

    /// Stops the audio side, waits (bounded) for the mixer to drop the source, then drops the plugin
    /// here on the main thread. If the audio thread never lets go, the plugin is leaked rather than
    /// torn down from the wrong thread - a leak is survivable, a teardown crash is not.
    ///
    /// Returns true when the teardown ran here cleanly, false when the plugin had to be leaked.
    pub fn unload(mut self) -> bool {
        self.close_editor();
        self.shared.alive.store(false, Ordering::Relaxed);
        let deadline = Instant::now() + Duration::from_millis(750);
        while !self.shared.source_released.load(Ordering::Acquire) {
            if Instant::now() > deadline {
                eprintln!("[vst3] {}: audio thread did not release the source; leaking the plugin", self.info.name);
                std::mem::forget(self);
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParameterView {
    pub id: u32,
    pub name: String,
    pub value: f64,
    pub display: String,
    pub step_count: i32,
}

// --- Per-track registry (main thread only) --------------------------------------------------------

thread_local! {
    static INSTRUMENTS: RefCell<HashMap<String, Vst3Instrument>> = RefCell::new(HashMap::new());
    static SCAN_CACHE: RefCell<Option<(Vec<Vst3PluginEntry>, Vec<String>)>> = RefCell::new(None);
}

/// Runs `f` on the instrument loaded for `track_id`, if any.
pub fn with_instrument<R>(track_id: &str, f: impl FnOnce(&mut Vst3Instrument) -> R) -> Option<R> {
    INSTRUMENTS.with(|map| map.borrow_mut().get_mut(track_id).map(f))
}

pub fn insert_instrument(track_id: &str, instrument: Vst3Instrument) {
    let previous = INSTRUMENTS.with(|map| map.borrow_mut().insert(track_id.to_string(), instrument));
    if let Some(old) = previous {
        old.unload();
    }
}

pub fn remove_instrument(track_id: &str) {
    if let Some(old) = INSTRUMENTS.with(|map| map.borrow_mut().remove(track_id)) {
        old.unload();
    }
}

/// Scan results are cached for the session (Maschine alone is ~2s to read); `refresh` rescans.
pub fn cached_scan(refresh: bool) -> (Vec<Vst3PluginEntry>, Vec<String>) {
    SCAN_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if refresh || cache.is_none() {
            *cache = Some(scan_plugins(&default_scan_dirs()));
        }
        cache.clone().unwrap()
    })
}

/// Called once per frame from the app loop so editor windows stay serviced and user-closed editors
/// get noticed even if no addon code runs that frame.
pub fn service_all() {
    INSTRUMENTS.with(|map| {
        for instrument in map.borrow_mut().values_mut() {
            instrument.service();
        }
    });
}

/// Unloads every instrument, on this (main) thread. Called as the app exits: dropping the registry
/// from a thread-local destructor instead could run a plugin's teardown while the audio thread still
/// holds it.
pub fn unload_all() {
    let all: Vec<Vst3Instrument> = INSTRUMENTS.with(|map| map.borrow_mut().drain().map(|(_, i)| i).collect());
    for instrument in all {
        instrument.unload();
    }
}

pub fn all_stats() -> Vec<Vst3Stats> {
    INSTRUMENTS.with(|map| map.borrow().iter().map(|(id, i)| i.stats(id)).collect())
}

pub fn editor_window_titles() -> Vec<(String, String)> {
    INSTRUMENTS.with(|map| {
        map.borrow()
            .iter()
            .filter(|(_, i)| i.editor_open())
            .map(|(id, i)| (id.clone(), i.editor_window_title()))
            .collect()
    })
}

// --- Offline rendering (WAV export) -------------------------------------------------------------
//
// A hosted plugin has no analogue of the built-in voices' per-note fundsp graph: it is one
// continuous stateful processor, not something you can render note-by-note and additively mix.
// So a track's whole note list is instead fed to a fresh, temporary plugin instance (its own
// `Vst3Host`, never the one in the per-track registry above) as a sorted MIDI timeline, driven
// block by block the same way `Vst3Source::render_block` drives the realtime one, but with no
// mixer, no editor and no thread hop - the plugin is loaded, rendered, and dropped within this one
// call, on the calling (main) thread, exactly where plugin lifecycle is required to live.

/// A tail added past a track's last note-off so the plugin's own release/reverb/delay can ring
/// out, matching the reasoning `render_events_to_wav` already uses for the built-in voices.
pub const OFFLINE_TAIL_SECONDS: f64 = 3.0;

/// One scheduled note for an offline render - see `render_offline_track`.
#[derive(Clone, Debug)]
pub struct OfflineNoteEvent {
    pub start_time: f64,
    pub duration: f64,
    pub channel: u8,
    pub note: u8,
    pub velocity: u8,
}

/// A track's plugin plus the notes to play it, for one offline render.
pub struct Vst3RenderTrack {
    pub plugin_path: PathBuf,
    /// A blob from `Vst3Instrument::save_state`; `None` renders the plugin's default patch.
    pub state: Option<Vec<u8>>,
    pub notes: Vec<OfflineNoteEvent>,
}

impl Vst3RenderTrack {
    /// The last second this track could still be sounding at, `OFFLINE_TAIL_SECONDS` past its
    /// last note-off. 0 if it has no notes.
    pub fn end_seconds(&self) -> f64 {
        let last_off = self.notes.iter().fold(0.0f64, |m, n| m.max(n.start_time.max(0.0) + n.duration.max(0.0)));
        if self.notes.is_empty() { 0.0 } else { last_off + OFFLINE_TAIL_SECONDS }
    }
}

/// Renders `track`'s notes through a fresh instance of its plugin, for exactly `total_frames`
/// frames at `SAMPLE_RATE`, returning interleaved stereo f32. A plugin that fails to load or start
/// (missing file, incompatible state) reports an error rather than silently producing silence, so
/// an export can tell the human which track was left out and why.
pub fn render_offline_track(track: &Vst3RenderTrack, total_frames: usize) -> Result<Vec<f32>, String> {
    let mut host = Vst3Host::builder()
        .sample_rate(SAMPLE_RATE as f64)
        .block_size(BLOCK_FRAMES)
        .build()
        .map_err(|e| format!("VST3 host init failed: {e}"))?;
    let mut plugin = host.load_plugin(&track.plugin_path).map_err(|e| format!("load failed: {e}"))?;
    if let Some(bytes) = &track.state {
        if let Err(e) = plugin.load_state(bytes) {
            eprintln!("[vst3] {}: state restore failed for offline render, using defaults: {e}", track.plugin_path.display());
        }
    }
    plugin.start_processing().map_err(|e| format!("start_processing failed: {e}"))?;

    #[derive(Clone, Copy)]
    enum Ev {
        On(u8, u8, u8),
        Off(u8, u8),
    }
    let mut timeline: Vec<(usize, Ev)> = Vec::with_capacity(track.notes.len() * 2);
    for n in &track.notes {
        let on_sample = (n.start_time.max(0.0) * SAMPLE_RATE as f64).round() as usize;
        let off_sample = ((n.start_time.max(0.0) + n.duration.max(0.0)) * SAMPLE_RATE as f64).round() as usize;
        timeline.push((on_sample, Ev::On(n.channel, n.note.min(127), n.velocity.clamp(1, 127))));
        timeline.push((off_sample.max(on_sample + 1), Ev::Off(n.channel, n.note.min(127))));
    }
    timeline.sort_by_key(|(sample, _)| *sample);

    let mut bufs = AudioBuffers::new(0, 2, BLOCK_FRAMES, SAMPLE_RATE as f64);
    let n_blocks = (total_frames + BLOCK_FRAMES - 1) / BLOCK_FRAMES;
    let mut out = vec![0.0f32; n_blocks * BLOCK_FRAMES * 2];
    let mut idx = 0usize;

    for block in 0..n_blocks {
        let block_start = block * BLOCK_FRAMES;
        let block_end = block_start + BLOCK_FRAMES;
        while idx < timeline.len() && timeline[idx].0 < block_end {
            let (sample, event) = timeline[idx];
            let offset = sample.saturating_sub(block_start).min(BLOCK_FRAMES - 1) as i32;
            let midi = match event {
                Ev::On(channel, note, velocity) => MidiEvent::NoteOn { channel: channel_from_index(channel), note, velocity },
                Ev::Off(channel, note) => MidiEvent::NoteOff { channel: channel_from_index(channel), note, velocity: 0 },
            };
            let _ = plugin.send_midi_event_at(midi, offset);
            idx += 1;
        }

        bufs.clear();
        if plugin.process_audio(&mut bufs).is_ok() {
            let left = &bufs.outputs[0];
            let right = bufs.outputs.get(1).unwrap_or(left);
            for i in 0..BLOCK_FRAMES {
                let (l, r) = (left[i], right[i]);
                out[(block_start + i) * 2] = if l.is_finite() { l } else { 0.0 };
                out[(block_start + i) * 2 + 1] = if r.is_finite() { r } else { 0.0 };
            }
        }
    }

    out.truncate(total_frames * 2);
    Ok(out)
}
