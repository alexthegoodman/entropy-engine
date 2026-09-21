//! Offline tier for guitar-to-MIDI: `tests/features/guitar_engine.feature` replays synthetic
//! recordings through the real `GuitarEngine` in 128 sample buffers and asserts on the events that
//! come out. No window, no audio device. The strings come from `guitar::testsig`, so every pitch,
//! pick and mute is known exactly.
//!
//! Run in release: `cargo test --release --test guitar_engine_bdd`. Debug builds run the same
//! scenarios but say nothing about timing.

use cucumber::{given, then, when, World as _};
use entropy_engine::guitar::calibrate::gate_from_noise;
use entropy_engine::guitar::replay::{check_well_formed, spans};
use entropy_engine::guitar::testsig::{self, Motion, Pluck, Truth};
use entropy_engine::guitar::{bend_cents, GuitarConfig, GuitarEngine, GuitarEvent, GuitarEventKind, Mode, BEND_CENTER};

const FS: f32 = 48_000.0;
const BLOCK: usize = 128;

#[derive(Clone, Copy, Debug)]
struct Room {
    seconds: f32,
    hum_db: f32,
    hiss_db: f32,
}

#[derive(Debug, cucumber::World)]
struct GuitarWorld {
    cfg: GuitarConfig,
    plucks: Vec<Pluck>,
    room: Option<Room>,
    thumps: Option<(usize, f32)>,
    slaps: Vec<(f32, f32, f32)>,
    seconds: Option<f32>,
    events: Vec<GuitarEvent>,
    truth: Vec<Truth>,
    samples: Vec<f32>,
}

impl Default for GuitarWorld {
    fn default() -> Self {
        GuitarWorld { cfg: GuitarConfig::default(), plucks: Vec::new(), room: None, thumps: None, slaps: Vec::new(), seconds: None, events: Vec::new(), truth: Vec::new(), samples: Vec::new() }
    }
}

/// "E2" -> 40, "F#3" -> 54. Middle C is C4 = 60.
fn midi_of(name: &str) -> u8 {
    let mut chars = name.chars();
    let letter = chars.next().expect("a note name");
    let mut semitone = match letter {
        'C' => 0,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        other => panic!("{other} is not a note"),
    };
    let rest: String = chars.collect();
    let (accidental, octave) = match rest.strip_prefix('#') {
        Some(o) => (1, o),
        None => (0, rest.as_str()),
    };
    semitone += accidental;
    let octave: i32 = octave.parse().unwrap_or_else(|_| panic!("no octave in {name}"));
    ((octave + 1) * 12 + semitone) as u8
}

impl GuitarWorld {
    fn last(&mut self) -> &mut Pluck {
        self.plucks.last_mut().expect("a string is picked first")
    }

    fn duration(&self) -> f32 {
        self.seconds.or(self.room.map(|r| r.seconds)).unwrap_or_else(|| self.plucks.iter().map(|p| p.start_s + 1.5).fold(1.0, f32::max))
    }

    fn render(&mut self) {
        let seconds = self.duration();
        let (mut x, truth) = testsig::mix(FS, seconds, &self.plucks);
        if let Some(r) = self.room {
            testsig::add_hum(&mut x, FS, 60.0, r.hum_db);
            testsig::add_noise(&mut x, r.hiss_db, 77);
        }
        if let Some((count, peak_db)) = self.thumps {
            // Spread evenly, but not at the very start or end, and off any note's pick.
            let times: Vec<f32> = (0..count).map(|i| 0.5 + (seconds - 1.0) * (i as f32 + 0.5) / count as f32 + 0.013 * i as f32).collect();
            testsig::add_handling_noise(&mut x, FS, &times, peak_db, 4242);
        }
        for &(t, db, ms) in &self.slaps {
            testsig::add_slap(&mut x, FS, t, db, ms, 99);
        }
        self.samples = x;
        self.truth = truth;
    }

    fn replay(&mut self) {
        self.render();
        let mut engine = GuitarEngine::new(self.cfg.clone());
        let mut events = Vec::new();
        for chunk in self.samples.chunks(BLOCK) {
            engine.process(chunk, &mut events);
        }
        engine.release_all(&mut events);
        self.events = events;
    }

    fn note_ons(&self) -> Vec<(u64, u8, u8)> {
        self.events.iter().filter_map(|e| if let GuitarEventKind::NoteOn { note, velocity } = e.kind { Some((e.sample, note, velocity)) } else { None }).collect()
    }

    fn note_offs(&self) -> Vec<u64> {
        self.events.iter().filter_map(|e| matches!(e.kind, GuitarEventKind::NoteOff { .. }).then_some(e.sample)).collect()
    }

    fn ms(&self, samples: f32) -> f32 {
        samples / FS * 1000.0
    }
}

// --- Given ---------------------------------------------------------------------------------------

#[given("the default settings")]
fn default_settings(w: &mut GuitarWorld) {
    *w = GuitarWorld::default();
}

#[given(expr = "the {word} mode")]
fn mode(w: &mut GuitarWorld, name: String) {
    w.cfg.mode = Mode::from_name(&name).unwrap_or_else(|| panic!("no mode {name}"));
}

#[given(expr = "the pitch bend range is {int} semitones")]
fn bend_range(w: &mut GuitarWorld, n: u32) {
    w.cfg.bend_range = n as f32;
}

#[given(expr = "a string tuned to {word} is picked at {int} dBFS")]
fn pick(w: &mut GuitarWorld, note: String, db: i32) {
    let seed = w.plucks.len() as u32 + 1;
    w.plucks.push(Pluck::note(midi_of(&note)).starting(0.1).loud(db as f32).seeded(seed));
}

#[given(expr = "a string tuned to {word} is picked at {int} dBFS at {float} seconds")]
fn pick_at(w: &mut GuitarWorld, note: String, db: i32, at: f32) {
    let seed = w.plucks.len() as u32 + 1;
    w.plucks.push(Pluck::note(midi_of(&note)).starting(at).loud(db as f32).seeded(seed));
}

#[given(expr = "{int} notes picked {int} ms apart: {string}")]
fn run_of_notes(w: &mut GuitarWorld, count: u32, gap: u32, names: String) {
    let notes: Vec<&str> = names.split_whitespace().collect();
    assert_eq!(notes.len() as u32, count, "the count and the list disagree");
    for (i, n) in notes.iter().enumerate() {
        // Each string is damped just before the next is picked, as a player's hand does. A monophonic
        // tracker is not asked to separate two strings ringing at once.
        let mut p = Pluck::note(midi_of(n)).starting(0.2 + i as f32 * gap as f32 / 1000.0).loud(-14.0).ringing((gap as f32 - 20.0) / 1000.0).seeded(i as u32 + 1);
        p.mute_ms = 8.0;
        w.plucks.push(p);
    }
    w.seconds = Some(0.2 + count as f32 * gap as f32 / 1000.0 + 0.6);
}

#[given(expr = "the string decays with a time constant of {float} seconds")]
fn decay(w: &mut GuitarWorld, s: f32) {
    w.last().decay_s = s;
}

#[given(expr = "the string is muted after {float} seconds")]
fn mute(w: &mut GuitarWorld, s: f32) {
    w.last().ring_s = s;
}

#[given(expr = "its pitch has vibrato of {int} cents at {int} Hz after {float} seconds")]
fn vibrato(w: &mut GuitarWorld, depth: u32, rate: u32, delay: f32) {
    w.last().motion = Motion::Vibrato { depth_cents: depth as f32, rate_hz: rate as f32, delay_s: delay };
}

#[given(expr = "its pitch is bent up {int} cents over {int} ms after {float} seconds")]
fn bend_up(w: &mut GuitarWorld, cents: u32, ms: u32, after: f32) {
    w.last().motion = Motion::Bend { cents: cents as f32, start_s: after, dur_s: ms as f32 / 1000.0 };
}

#[given(expr = "it slides up {int} semitones over {int} ms after {float} seconds")]
fn slide_up(w: &mut GuitarWorld, semis: u32, ms: u32, after: f32) {
    w.last().motion = Motion::Slide { semitones: semis as f32, start_s: after, dur_s: ms as f32 / 1000.0 };
}

#[given(expr = "its fundamental is only {float} of normal")]
fn weak_fundamental(w: &mut GuitarWorld, f: f32) {
    w.last().fundamental = f;
}

#[given(expr = "its partials start at phase seed {int}")]
fn phase_seed(w: &mut GuitarWorld, seed: u32) {
    w.last().seed = seed;
}

#[given(expr = "a {int} ms slap at {int} dBFS at {float} seconds")]
fn slap_at(w: &mut GuitarWorld, ms: u32, db: i32, at: f32) {
    w.slaps.push((at, db as f32, ms as f32));
}

#[given("its fundamental is weak and its odd partials are weaker")]
fn octave_ambiguous(w: &mut GuitarWorld) {
    let p = w.last();
    p.fundamental = 0.2;
    p.odd_gain = 0.1;
}

#[given(expr = "{int} seconds of room noise: hum at {int} dBFS and hiss at {int} dBFS")]
fn room(w: &mut GuitarWorld, seconds: u32, hum: i32, hiss: i32) {
    w.room = Some(Room { seconds: seconds as f32, hum_db: hum as f32, hiss_db: hiss as f32 });
}

#[given(expr = "{int} handling thumps at {int} dBFS")]
fn thumps(w: &mut GuitarWorld, n: u32, db: i32) {
    w.thumps = Some((n as usize, db as f32));
}

// --- When ----------------------------------------------------------------------------------------

#[when("the recording is replayed")]
fn replayed(w: &mut GuitarWorld) {
    w.replay();
}

#[when(expr = "the recording is replayed for {float} seconds")]
fn replayed_for(w: &mut GuitarWorld, s: f32) {
    w.seconds = Some(s);
    w.replay();
}

#[when(expr = "the gate is calibrated on {int} seconds of that room")]
fn calibrate_gate(w: &mut GuitarWorld, s: u32) {
    // The room alone, rendered without the notes or thumps, exactly what a silent capture would hold.
    let saved = (std::mem::take(&mut w.plucks), w.thumps.take());
    w.render();
    let noise = w.samples[..(s as f32 * FS) as usize].to_vec();
    let (open, close) = gate_from_noise(&noise, FS, &w.cfg);
    println!("    calibrated gate: open {open:.1} dBFS, close {close:.1} dBFS (defaults {:.1} / {:.1})", w.cfg.gate_open_db, w.cfg.gate_close_db);
    w.cfg.gate_open_db = open;
    w.cfg.gate_close_db = close;
    w.plucks = saved.0;
    w.thumps = saved.1;
}

#[when(expr = "the engine is stopped {float} seconds in")]
fn stopped(w: &mut GuitarWorld, at: f32) {
    w.render();
    let mut engine = GuitarEngine::new(w.cfg.clone());
    let mut events = Vec::new();
    let n = (at * FS) as usize;
    for chunk in w.samples[..n].chunks(BLOCK) {
        engine.process(chunk, &mut events);
    }
    let sounding = engine.diagnostics().note;
    assert!(sounding.is_some(), "nothing was sounding at {at} s, so stopping proves nothing");
    engine.release_all(&mut events);
    w.events = events;
}

// --- Then ----------------------------------------------------------------------------------------

#[then(expr = "exactly {int} Note On(s) is/are emitted")]
fn count_ons(w: &mut GuitarWorld, n: usize) {
    assert_eq!(w.note_ons().len(), n, "Note Ons: {:?}", w.note_ons());
}

#[then(expr = "exactly {int} Note Off(s) is/are emitted")]
fn count_offs(w: &mut GuitarWorld, n: usize) {
    assert_eq!(w.note_offs().len(), n, "events: {:?}", w.events.iter().map(|e| e.kind).collect::<Vec<_>>());
}

#[then(expr = "exactly {int} Note Off is emitted before the last Note On")]
fn offs_before_last_on(w: &mut GuitarWorld, n: usize) {
    let last_on = w.note_ons().last().expect("a Note On").0;
    let offs = w.note_offs().into_iter().filter(|&t| t <= last_on).count();
    assert_eq!(offs, n);
}

#[then("no note is emitted")]
fn none(w: &mut GuitarWorld) {
    assert!(w.note_ons().is_empty(), "{} Note Ons in {:.0} s, first at {:.2} s: {:?}", w.note_ons().len(), w.duration(), w.note_ons()[0].0 as f32 / FS, &w.note_ons()[..w.note_ons().len().min(5)]);
    assert!(w.events.is_empty(), "events with no notes: {:?}", w.events);
}

#[then(expr = "the first Note On is for {word}")]
fn first_note(w: &mut GuitarWorld, note: String) {
    let ons = w.note_ons();
    let first = ons.first().unwrap_or_else(|| panic!("no Note On at all"));
    assert_eq!(first.1, midi_of(&note), "expected {note} ({}), got MIDI {}", midi_of(&note), first.1);
}

#[then(expr = "the first Note On comes within {int} ms of the pick")]
fn latency(w: &mut GuitarWorld, ms: u32) {
    let on = w.note_ons()[0].0;
    let took = w.ms(on as f32 - w.truth[0].onset as f32);
    println!("    Note On {took:.1} ms after the pick (bound {ms} ms)");
    assert!(took <= ms as f32, "took {took:.1} ms, bound {ms} ms");
}

#[then(expr = "the notes played are {string}")]
fn notes_played(w: &mut GuitarWorld, names: String) {
    let want: Vec<u8> = names.split_whitespace().map(midi_of).collect();
    let got: Vec<u8> = w.note_ons().iter().map(|o| o.1).collect();
    assert_eq!(got, want, "played {got:?}, wanted {want:?}");
}

#[then("the event stream is well formed")]
fn well_formed(w: &mut GuitarWorld) {
    if let Err(e) = check_well_formed(&w.events) {
        panic!("{e}");
    }
}

#[then("the Note Off comes before the recording ends")]
fn off_before_end(w: &mut GuitarWorld) {
    let off = w.note_offs()[0];
    let end = w.samples.len() as u64;
    // release_all at the end stamps the last sample; a natural release is earlier than that.
    assert!(off + (0.05 * FS) as u64 <= end, "the only Note Off is the stop at the end ({off} of {end})");
}

#[then("the only Note Off is the stop at the end")]
fn off_only_at_end(w: &mut GuitarWorld) {
    let offs = w.note_offs();
    let end = w.samples.len() as u64;
    assert_eq!(offs.len(), 1, "{} Note Offs", offs.len());
    assert!(offs[0] + (0.05 * FS) as u64 > end, "the Note Off at {} came well before the end ({end}): the note did end by itself", offs[0]);
}

#[then(expr = "the Note Off comes within {int} ms of the mute")]
fn off_after_mute(w: &mut GuitarWorld, ms: u32) {
    let mute = w.truth[0].mute.expect("the string is muted");
    let off = w.note_offs()[0];
    let took = w.ms(off as f32 - mute as f32);
    println!("    Note Off {took:.1} ms after the mute began (bound {ms} ms)");
    assert!(took >= 0.0 && took <= ms as f32, "{took:.1} ms");
}

/// The bend a receiving synth holds at input sample `t`: the last message describing an instant at or
/// before it, in cents from the note's center.
fn held_bend_cents(events: &[GuitarEvent], t: u64, range: f32) -> f32 {
    events
        .iter()
        .filter_map(|e| if let GuitarEventKind::PitchBend { value } = e.kind { Some((e.source_sample, value)) } else { None })
        .take_while(|&(src, _)| src <= t)
        .last()
        .map_or(0.0, |(_, v)| bend_cents(v, range))
}

#[then(expr = "the bend follows the pitch within {int} cents at the median")]
fn bend_tracks(w: &mut GuitarWorld, cents: u32) {
    let p = w.plucks[0];
    let onset = w.truth[0].onset;
    let first_on = w.note_ons()[0].0;
    let mut errors: Vec<f32> = Vec::new();
    // From half a second after the first Note On to the last second, in 2 ms steps.
    let (start, end) = (first_on + (0.5 * FS) as u64, w.samples.len() as u64 - (0.3 * FS) as u64);
    let mut t = start;
    while t < end {
        let truth = p.motion.cents_at((t - onset) as f32 / FS);
        errors.push((held_bend_cents(&w.events, t, w.cfg.bend_range) - truth).abs());
        t += (0.002 * FS) as u64;
    }
    errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let median = errors[errors.len() / 2];
    let p95 = errors[errors.len() * 95 / 100];
    println!("    bend error: median {median:.2} cents, p95 {p95:.2} cents over {} points", errors.len());
    assert!(median <= cents as f32, "median {median:.2} cents");
}

#[then(expr = "no more than {int} bend messages per second are sent")]
fn bend_rate(w: &mut GuitarWorld, per_s: u32) {
    let times: Vec<u64> = w.events.iter().filter(|e| matches!(e.kind, GuitarEventKind::PitchBend { .. })).map(|e| e.sample).collect();
    let secs = w.samples.len() as f32 / FS;
    let rate = times.len() as f32 / secs;
    // The strictest reading: no window of one second holds more.
    let worst = times.iter().map(|&t| times.iter().filter(|&&u| u >= t && u < t + FS as u64).count()).max().unwrap_or(0);
    println!("    {} bend messages, {rate:.0} per second on average, {worst} in the busiest second", times.len());
    assert!(worst as u32 <= per_s, "{worst} in one second");
}

#[then("the bend values never fall while the string rises")]
fn bend_monotonic(w: &mut GuitarWorld) {
    let bends: Vec<(u64, u16)> = spans(&w.events)[0].bends.clone();
    let mut biggest_fall = 0.0f32;
    for pair in bends.windows(2) {
        let (a, b) = (bend_cents(pair[0].1, w.cfg.bend_range), bend_cents(pair[1].1, w.cfg.bend_range));
        biggest_fall = biggest_fall.max(a - b);
    }
    println!("    {} bend messages, largest step down {biggest_fall:.2} cents", bends.len());
    assert!(biggest_fall <= 3.0, "the bend fell by {biggest_fall:.2} cents");
}

#[then(expr = "the last bend is within {int} cents of {int} cents")]
fn last_bend(w: &mut GuitarWorld, tol: u32, target: u32) {
    let bends = &spans(&w.events)[0].bends;
    let last = bend_cents(bends.last().expect("a bend").1, w.cfg.bend_range);
    println!("    last bend {last:.1} cents (target {target})");
    assert!((last - target as f32).abs() <= tol as f32, "{last:.1} cents");
}

#[then("the bend is centered before the second Note On")]
fn centered_before_second(w: &mut GuitarWorld) {
    let idx = w.events.iter().enumerate().filter(|(_, e)| matches!(e.kind, GuitarEventKind::NoteOn { .. })).nth(1).expect("a second Note On").0;
    let last_bend = w.events[..idx].iter().rev().find_map(|e| if let GuitarEventKind::PitchBend { value } = e.kind { Some(value) } else { None });
    assert_eq!(last_bend, Some(BEND_CENTER), "the last bend before the second Note On");
}

#[then(expr = "the pitch sounding at the end is {word} within {int} cents")]
fn final_pitch(w: &mut GuitarWorld, note: String, tol: u32) {
    let last_on = w.events.iter().rposition(|e| matches!(e.kind, GuitarEventKind::NoteOn { .. })).expect("a Note On");
    let GuitarEventKind::NoteOn { note: center, .. } = w.events[last_on].kind else { unreachable!() };
    let bend = w.events[last_on..].iter().filter_map(|e| if let GuitarEventKind::PitchBend { value } = e.kind { Some(value) } else { None }).rev().nth(1).map_or(0.0, |v| bend_cents(v, w.cfg.bend_range));
    // The last bend message after the final Note On is the stop's reset to center, so the one before it is what was heard.
    let heard = (center as f32 - midi_of(&note) as f32) * 100.0 + bend;
    println!("    last Note On {center}, bend {bend:.1} cents: {heard:+.1} cents from {note}");
    assert!(heard.abs() <= tol as f32, "{heard:.1} cents from {note}");
}

#[then(expr = "the first Note On has a velocity of at least {int} and at most {int}")]
fn velocity(w: &mut GuitarWorld, lo: u32, hi: u32) {
    let v = w.note_ons()[0].2 as u32;
    println!("    velocity {v}");
    assert!(v >= lo && v <= hi, "velocity {v} not in {lo}..={hi}");
}

fn main() {
    futures::executor::block_on(GuitarWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/guitar_engine.feature"));
}
