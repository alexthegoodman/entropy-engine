//! Live tier for guitar-to-MIDI: `tests/features/guitar_live.feature`. A synthetic recording goes
//! through a real `GuitarSession` (the pipeline function a device callback calls, the lock-free queue,
//! the router thread) into the built-in voice on a real `AudioEngine` track, and the sound is read
//! back from the track's tap. Needs an audio output device, like `vst3_live`.
//!
//! Run in release: `cargo test --release --test guitar_live_bdd`.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::ENGINE_SAMPLE_RATE;
use entropy_engine::audio::AudioEngine;
use entropy_engine::guitar::pitch::{PitchDetector, TierDetector};
use entropy_engine::guitar::testsig::{self, Motion, Pluck, Truth};
use entropy_engine::guitar::{midi_to_hz, Algorithm, GuitarConfig, Mode};
use entropy_engine::guitar_live::{GuitarSession, RecordedNote, SyntheticInput, Waveform};
use realfft::RealFftPlanner;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const FS: f32 = 48_000.0;
const BLOCK: usize = 128;

#[derive(cucumber::World)]
struct LiveWorld {
    audio: Option<Arc<AudioEngine>>,
    track: String,
    session: Option<GuitarSession>,
    feeder: Option<SyntheticInput>,
    cfg: GuitarConfig,
    plucks: Vec<Pluck>,
    truth: Vec<Truth>,
    recording: Vec<f32>,
    /// How far into the recording has been played.
    cursor: usize,
    armed: bool,
    take: Vec<RecordedNote>,
    stop_after_arm: bool,
    latencies_ms: Vec<f32>,
    room: Option<(f32, f32, f32)>,
    slaps: Vec<(f32, f32)>,
    /// Events the engine emitted, counted independently by replaying the same recording offline.
    offline_events: usize,
}

impl std::fmt::Debug for LiveWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LiveWorld")
    }
}

impl Default for LiveWorld {
    fn default() -> Self {
        LiveWorld {
            audio: None,
            track: String::new(),
            session: None,
            feeder: None,
            cfg: GuitarConfig::default(),
            plucks: Vec::new(),
            truth: Vec::new(),
            recording: Vec::new(),
            cursor: 0,
            armed: false,
            take: Vec::new(),
            stop_after_arm: false,
            latencies_ms: Vec::new(),
            room: None,
            slaps: Vec::new(),
            offline_events: 0,
        }
    }
}

fn midi_of(name: &str) -> u8 {
    let mut chars = name.chars();
    let mut semitone = match chars.next().unwrap() {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        c => panic!("{c} is not a note"),
    };
    let rest: String = chars.collect();
    let (acc, oct) = match rest.strip_prefix('#') {
        Some(o) => (1, o.to_string()),
        None => (0, rest),
    };
    semitone += acc;
    ((oct.parse::<i32>().unwrap() + 1) * 12 + semitone) as u8
}

/// Feeds samples to the pipeline at real-time pace, on an absolute schedule so sleeping's coarse
/// granularity does not accumulate.
fn play_real_time(feeder: &mut SyntheticInput, samples: &[f32]) {
    let start = Instant::now();
    let mut fed = 0usize;
    for chunk in samples.chunks(BLOCK) {
        let due = start + Duration::from_secs_f64(fed as f64 / FS as f64);
        loop {
            let now = Instant::now();
            if now >= due {
                break;
            }
            let left = due - now;
            if left > Duration::from_millis(2) {
                std::thread::sleep(left - Duration::from_millis(1));
            } else {
                std::hint::spin_loop();
            }
        }
        feeder.feed(chunk);
        fed += chunk.len();
    }
}

impl LiveWorld {
    fn audio(&self) -> &Arc<AudioEngine> {
        self.audio.as_ref().expect("the real audio engine step comes first")
    }

    fn render(&mut self) {
        if !self.recording.is_empty() {
            return;
        }
        let mut seconds = self.plucks.iter().map(|p| p.start_s + 1.6).fold(1.0, f32::max);
        if let Some((s, _, _)) = self.room {
            seconds = seconds.max(s);
        }
        let (mut x, truth) = testsig::mix(FS, seconds, &self.plucks);
        if let Some((_, hum, hiss)) = self.room {
            testsig::add_hum(&mut x, FS, 60.0, hum);
            testsig::add_noise(&mut x, hiss, 77);
        }
        for &(t, db) in &self.slaps {
            testsig::add_slap(&mut x, FS, t, db, 15.0, 5);
        }
        self.recording = x;
        self.truth = truth;
        // Count what the engine emits on this exact recording, offline, to check delivery against.
        let r = entropy_engine::guitar::replay::run(&self.cfg, &self.recording, BLOCK);
        self.offline_events = r.events.len();
        if self.armed {
            self.session.as_ref().unwrap().arm_recording();
        }
    }

    fn play_until(&mut self, seconds: Option<f32>) {
        self.render();
        let end = seconds.map_or(self.recording.len(), |s| ((s * FS) as usize).min(self.recording.len()));
        if end > self.cursor {
            let chunk = self.recording[self.cursor..end].to_vec();
            play_real_time(self.feeder.as_mut().expect("a session"), &chunk);
            self.cursor = end;
        }
        if seconds.is_none() && self.room.is_none() {
            // Let the tail of the last note drain through the router and the output. With a room the
            // recording already carries its noise to the end, and silence would end a hanging note.
            let silence = vec![0.0f32; (0.5 * FS) as usize];
            play_real_time(self.feeder.as_mut().unwrap(), &silence);
        } else {
            // The router and the output device take a few milliseconds; give them that before reading.
            std::thread::sleep(Duration::from_millis(60));
        }
    }

    /// Pitch of what the track is playing right now, read with the engine's own detector.
    fn track_pitch(&self, track: &str) -> Option<f32> {
        let snap = self.audio().snapshot(track, 4096)?;
        let mut d = TierDetector::new(&mut RealFftPlanner::new(), Algorithm::Yin, ENGINE_SAMPLE_RATE as f32, 70.0, 1400.0, 1.0, 0);
        d.estimate(&snap.left).filter(|e| e.confidence > 0.8).map(|e| e.freq_hz)
    }

    fn track_peak_db(&self, track: &str) -> f32 {
        let snap = self.audio().snapshot(track, 2048).unwrap_or_else(|| panic!("track {track} has no tap"));
        let peak = snap.left.iter().chain(snap.right.iter()).fold(0.0f32, |a, &b| a.max(b.abs()));
        20.0 * peak.max(1e-9).log10()
    }
}

// --- Given ---------------------------------------------------------------------------------------

#[given(expr = "the real audio engine with a track {string}")]
fn real_engine(w: &mut LiveWorld, track: String) {
    let audio = Arc::new(AudioEngine::new());
    audio.ensure_track_bus(&track, 1.0, false, false, &[]);
    w.audio = Some(audio);
    w.track = track;
}

#[given("a guitar session fed from a recording")]
fn session(w: &mut LiveWorld) {
    let (session, feeder) = GuitarSession::synthetic(w.cfg.clone());
    w.session = Some(session);
    w.feeder = Some(feeder);
}

#[given(expr = "the guitar plays the {string} voice on {string}")]
fn voice(w: &mut LiveWorld, waveform: String, track: String) {
    let audio = w.audio().clone();
    w.session.as_mut().unwrap().play_built_in(&audio, &track, Waveform::from_name(&waveform).expect("a waveform")).expect("the voice is added to the track");
}

#[given(expr = "a track {string} hosting the {string} plugin")]
fn host_plugin(w: &mut LiveWorld, track: String, plugin: String) {
    use entropy_engine::audio::vst3;
    let audio = w.audio().clone();
    audio.ensure_track_bus(&track, 1.0, false, false, &[]);
    let path = vst3::find_plugin_path(&plugin).unwrap_or_else(|| panic!("{plugin}.vst3 is not installed"));
    let (instrument, source) = vst3::load_instrument(&path, None).unwrap_or_else(|e| panic!("{plugin}: {e}"));
    vst3::insert_instrument(&track, instrument);
    assert!(audio.add_track_source(&track, source));
    // The plugin's first blocks after loading are not representative; let it settle.
    std::thread::sleep(Duration::from_millis(400));
}

#[given(expr = "the guitar plays {string} on MIDI channel {int}")]
fn play_vst3(w: &mut LiveWorld, track: String, channel: u32) {
    w.session.as_mut().unwrap().play_vst3(&track, (channel - 1) as u8).expect("the plugin is loaded on this thread");
}

#[given(expr = "{int} seconds of room noise: hum at {int} dBFS and hiss at {int} dBFS")]
fn room(w: &mut LiveWorld, seconds: u32, hum: i32, hiss: i32) {
    w.room = Some((seconds as f32, hum as f32, hiss as f32));
}

#[given(expr = "a fret hand slap at {int} dBFS at {float} seconds")]
fn slap(w: &mut LiveWorld, db: i32, at: f32) {
    w.slaps.push((at, db as f32));
}

#[given("recording is armed")]
fn armed(w: &mut LiveWorld) {
    w.armed = true;
}

#[given(expr = "a string tuned to {word} is picked at {int} dBFS")]
fn pick(w: &mut LiveWorld, note: String, db: i32) {
    let seed = w.plucks.len() as u32 + 1;
    w.plucks.push(Pluck::note(midi_of(&note)).starting(0.1).loud(db as f32).seeded(seed));
}

#[given(expr = "a string tuned to {word} is picked at {int} dBFS at {float} seconds")]
fn pick_at(w: &mut LiveWorld, note: String, db: i32, at: f32) {
    let seed = w.plucks.len() as u32 + 1;
    w.plucks.push(Pluck::note(midi_of(&note)).starting(at).loud(db as f32).seeded(seed));
}

#[given(expr = "the string is muted after {float} seconds")]
fn muted(w: &mut LiveWorld, s: f32) {
    w.plucks.last_mut().unwrap().ring_s = s;
}

#[given(expr = "its pitch is bent up {int} cents over {int} ms after {float} seconds")]
fn bent(w: &mut LiveWorld, cents: u32, ms: u32, after: f32) {
    w.plucks.last_mut().unwrap().motion = Motion::Bend { cents: cents as f32, start_s: after, dur_s: ms as f32 / 1000.0 };
}

#[given(expr = "its pitch has vibrato of {int} cents at {int} Hz after {float} seconds")]
fn vibrato(w: &mut LiveWorld, depth: u32, rate: u32, delay: f32) {
    w.plucks.last_mut().unwrap().motion = Motion::Vibrato { depth_cents: depth as f32, rate_hz: rate as f32, delay_s: delay };
}

#[given(expr = "the mode is changed to {string} while playing")]
fn mode_change(w: &mut LiveWorld, name: String) {
    let mut t = w.cfg.tunables();
    t.mode = Mode::from_name(&name).expect("a mode");
    w.session.as_mut().unwrap().set_tunables(t);
    // The audio thread picks the change up at its next buffer.
    let quiet = vec![0.0f32; BLOCK * 4];
    w.feeder.as_mut().unwrap().feed(&quiet);
}

// --- When ----------------------------------------------------------------------------------------

#[when(expr = "the recording is played up to {float} seconds")]
fn play_to(w: &mut LiveWorld, s: f32) {
    w.play_until(Some(s));
}

#[when("the recording is played to the end")]
fn play_end(w: &mut LiveWorld) {
    w.play_until(None);
    if w.armed {
        w.take = w.session.as_ref().unwrap().stop_recording();
    }
}

#[when(expr = "calibration listens to the room for {int} seconds")]
fn calibrate_room(w: &mut LiveWorld, seconds: u32) {
    w.session.as_ref().unwrap().calibrate(false, seconds as f32);
    w.play_until(Some(seconds as f32 + 0.3));
}

#[when(expr = "calibration listens to playing for {float} seconds")]
fn calibrate_playing(w: &mut LiveWorld, seconds: f32) {
    w.session.as_ref().unwrap().calibrate(true, seconds);
    w.play_until(Some(seconds + 0.3));
}

#[when("the calibration is applied")]
fn apply_calibration(w: &mut LiveWorld) {
    let applied = w.session.as_mut().unwrap().apply_calibration();
    println!("    calibration: {applied:?}");
    assert!(matches!(applied, Some(entropy_engine::guitar_live::CalState::SilenceDone) | Some(entropy_engine::guitar_live::CalState::PlayingDone)), "calibration ended as {applied:?}");
}

#[when("the session is stopped")]
fn stop_session(w: &mut LiveWorld) {
    w.session.as_mut().unwrap().stop();
    std::thread::sleep(Duration::from_millis(400));
}

#[when("the input device is lost")]
fn device_lost(w: &mut LiveWorld) {
    w.session.as_ref().unwrap().mark_device_lost();
    // The voice releases over about 60 ms per e-fold; give it long enough to fall below hearing.
    std::thread::sleep(Duration::from_millis(900));
}

#[when(expr = "{int} picks of E4 are played in real time")]
fn timed_picks(w: &mut LiveWorld, n: u32) {
    let tap = w.audio().tap(&w.track).expect("a tap");
    for trial in 0..n {
        let (x, _) = testsig::mix(FS, 1.0, &[Pluck::note(64).starting(0.0).loud(-14.0).ringing(0.25).seeded(trial + 1)]);
        let heard: Arc<std::sync::atomic::AtomicU64> = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let origin = Instant::now();
        let poller = {
            let (tap, heard, stop) = (tap.clone(), heard.clone(), stop.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let snap = tap.snapshot(96);
                    let peak = snap.left.iter().fold(0.0f32, |a, &b| a.max(b.abs()));
                    if peak > 0.003 && heard.load(Ordering::Relaxed) == 0 {
                        heard.store(origin.elapsed().as_micros() as u64 + 1, Ordering::Relaxed);
                    }
                    std::thread::sleep(Duration::from_micros(150));
                }
            })
        };
        // The pick is at the very first sample of the first block, fed at `origin`.
        play_real_time(w.feeder.as_mut().unwrap(), &x);
        stop.store(true, Ordering::Relaxed);
        poller.join().unwrap();
        let t = heard.load(Ordering::Relaxed);
        assert!(t > 0, "trial {trial}: the track never sounded");
        w.latencies_ms.push((t - 1) as f32 / 1000.0);
        std::thread::sleep(Duration::from_millis(300));
    }
}

// --- Then ----------------------------------------------------------------------------------------

#[then(expr = "{string} is sounding at {word} within {int} cents")]
fn sounding_note(w: &mut LiveWorld, track: String, note: String, cents: u32) {
    let want = midi_to_hz(midi_of(&note) as f32, 440.0);
    let hz = w.track_pitch(&track).unwrap_or_else(|| panic!("no pitch in {track} (peak {:.1} dBFS)", w.track_peak_db(&track)));
    let off = 1200.0 * (hz / want).log2();
    println!("    the track plays {hz:.2} Hz, {off:+.1} cents from {note} ({want:.2} Hz)");
    assert!(off.abs() <= cents as f32, "{off:+.1} cents from {note}");
}

#[then(expr = "{string} is sounding at {float} Hz within {int} cents")]
fn sounding_hz(w: &mut LiveWorld, track: String, want: f32, cents: u32) {
    let hz = w.track_pitch(&track).unwrap_or_else(|| panic!("no pitch in {track} (peak {:.1} dBFS)", w.track_peak_db(&track)));
    let off = 1200.0 * (hz / want).log2();
    println!("    the track plays {hz:.2} Hz, {off:+.1} cents from {want} Hz");
    assert!(off.abs() <= cents as f32, "{off:+.1} cents");
}

#[then(expr = "{string} is silent")]
fn silent(w: &mut LiveWorld, track: String) {
    let db = w.track_peak_db(&track);
    println!("    {track}'s last 2048 frames peak at {db:.1} dBFS");
    assert!(db < -60.0, "{db:.1} dBFS: still sounding");
}

#[then(expr = "{string} is audible")]
fn audible(w: &mut LiveWorld, track: String) {
    let db = w.track_peak_db(&track);
    println!("    {track}'s last 2048 frames peak at {db:.1} dBFS");
    for st in entropy_engine::audio::vst3::all_stats() {
        println!("    plugin {} on {}: {} blocks, {} skipped, {} notes received, lifetime peak {:.4}", st.plugin, st.track_id, st.blocks, st.skipped_blocks, st.notes_sent, st.lifetime_peak);
    }
    let d = w.session.as_ref().unwrap().diagnostics();
    println!("    guitar: {} notes found, routed {}", d.stats.notes, w.session.as_ref().unwrap().routed());
    assert!(db > -50.0, "{db:.1} dBFS: nothing is playing");
}

#[then(expr = "the guitar found exactly {int} note(s)")]
fn found_notes(w: &mut LiveWorld, n: u64) {
    assert_eq!(w.session.as_ref().unwrap().diagnostics().stats.notes, n);
}

#[then("the router delivered every event the engine emitted")]
fn delivered(w: &mut LiveWorld) {
    let s = w.session.as_ref().unwrap();
    std::thread::sleep(Duration::from_millis(100));
    let d = s.diagnostics();
    println!("    routed {} events; the same recording offline emits {}; dropped {} bends, {} note events", s.routed(), w.offline_events, d.dropped_bends, d.dropped_events);
    // The offline count includes the final release_all, which the live feed does not do.
    assert!(s.routed() as usize >= w.offline_events.saturating_sub(2), "routed {} of {}", s.routed(), w.offline_events);
    assert_eq!(d.dropped_events, 0);
}

#[given(expr = "the string decays with a time constant of {float} seconds")]
fn decay(w: &mut LiveWorld, s: f32) {
    w.plucks.last_mut().unwrap().decay_s = s;
}

#[then("a note is still held")]
fn held(w: &mut LiveWorld) {
    let d = w.session.as_ref().unwrap().diagnostics();
    println!("    the tracker is {} on note {:?}, level {:.1} dBFS", d.state.name(), d.note, d.level_db);
    assert!(d.note.is_some(), "the note ended by itself");
}

#[then("no note is held")]
fn not_held(w: &mut LiveWorld) {
    let d = w.session.as_ref().unwrap().diagnostics();
    println!("    the tracker is {} on note {:?}, level {:.1} dBFS", d.state.name(), d.note, d.level_db);
    assert!(d.note.is_none(), "note {:?} is still held", d.note);
}

#[then(expr = "the gate sits above {int} dBFS")]
fn gate_above(w: &mut LiveWorld, db: i32) {
    let open = w.session.as_ref().unwrap().config().gate_open_db;
    println!("    gate opens at {open:.1} dBFS");
    assert!(open > db as f32, "gate at {open:.1}");
}

#[then(expr = "the velocity range runs from below {int} dBFS to above {int} dBFS")]
fn velocity_range(w: &mut LiveWorld, lo: i32, hi: i32) {
    let c = w.session.as_ref().unwrap().config();
    println!("    velocity floor {:.1} dBFS, ceiling {:.1} dBFS", c.velocity_floor_db, c.velocity_ceil_db);
    assert!(c.velocity_floor_db < lo as f32 && c.velocity_ceil_db > hi as f32);
}

#[then("the diagnostics report the device as lost")]
fn lost(w: &mut LiveWorld) {
    assert!(w.session.as_ref().unwrap().diagnostics().device_lost);
}

#[then(expr = "the take holds these notes: {string}")]
fn take_notes(w: &mut LiveWorld, names: String) {
    let want: Vec<u8> = names.split_whitespace().map(midi_of).collect();
    let got: Vec<u8> = w.take.iter().map(|n| n.note).collect();
    assert_eq!(got, want, "recorded {:?}", w.take);
}

#[then(expr = "each recorded note starts within {int} ms of its pick")]
fn take_timing(w: &mut LiveWorld, ms: u32) {
    for (rec, truth) in w.take.iter().zip(w.truth.iter()) {
        let want = truth.onset as f32 / FS;
        let off_ms = (rec.start_s - want) * 1000.0;
        println!("    note {}: recorded at {:.3} s, picked at {:.3} s ({off_ms:+.1} ms)", rec.note, rec.start_s, want);
        assert!(off_ms.abs() <= ms as f32, "{off_ms:+.1} ms");
    }
}

#[then("the D4 note carries bend data")]
fn take_bends(w: &mut LiveWorld) {
    let d4 = w.take.iter().find(|n| n.note == 62).expect("a D4");
    println!("    {} bend points over {:.2} s", d4.bends.len(), d4.end_s - d4.start_s);
    assert!(d4.bends.len() > 10, "{} bend points", d4.bends.len());
    let swing = d4.bends.iter().map(|b| b.1).fold(f32::MIN, f32::max) - d4.bends.iter().map(|b| b.1).fold(f32::MAX, f32::min);
    assert!(swing > 30.0, "the bends swing {swing:.1} cents");
}

#[then(expr = "the last note came at least {int} ms after its pick")]
fn note_latency(w: &mut LiveWorld, ms: u32) {
    let d = w.session.as_ref().unwrap().diagnostics();
    println!("    pipeline latency of the last note: {:.1} ms", d.pipeline_latency_ms);
    assert!(d.pipeline_latency_ms >= ms as f32, "{:.1} ms", d.pipeline_latency_ms);
}

#[then("no callback ran longer than the audio it covered")]
fn no_overruns(w: &mut LiveWorld) {
    let d = w.session.as_ref().unwrap().diagnostics();
    println!("    {} callbacks, mean {:.1} us, max {} us for {:.0} us of audio each", d.callbacks, d.mean_callback_us, d.max_callback_us, BLOCK as f32 / FS * 1e6);
    assert_eq!(d.overruns, 0);
}

#[then("no note event was dropped")]
fn no_drops(w: &mut LiveWorld) {
    assert_eq!(w.session.as_ref().unwrap().diagnostics().dropped_events, 0);
}

#[then(expr = "the sound reaches the track within {int} ms of the pick at the median")]
fn latency_median(w: &mut LiveWorld, ms: u32) {
    let mut l = w.latencies_ms.clone();
    l.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = l[l.len() / 2];
    println!("    pick fed to sound in the track, {} trials: {:?} ms, median {median:.1} ms", l.len(), l.iter().map(|x| (x * 10.0).round() / 10.0).collect::<Vec<_>>());
    println!("    (a lower bound on guitar-in to speaker-out: the capture device and the output device's own buffers are not in it)");
    assert!(median <= ms as f32, "median {median:.1} ms");
}

impl Drop for LiveWorld {
    fn drop(&mut self) {
        // Plugin teardown is thread-affine: end the session first so nothing is still sending, then
        // unload every hosted instrument on this thread.
        self.session = None;
        self.feeder = None;
        entropy_engine::audio::vst3::unload_all();
    }
}

fn main() {
    futures::executor::block_on(LiveWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/guitar_live.feature"));
}
