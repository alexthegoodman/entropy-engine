//! Audio-quality BDD tier for the physically modelled grand piano: `tests/features/piano_synth.feature`.
//!
//! Notes are played offline through the real piano engine (no audio device, nothing timed by a clock)
//! and measured with `audio::piano::analysis` - verifying Railsback inharmonicity, nonlinear hammer
//! felt dynamics, coupled unison two-stage decay, individual dampers, and sympathetic resonance.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::ENGINE_SAMPLE_RATE;
use entropy_engine::audio::piano::{
    self, railsback_frequency, PianoAnalysis, PianoEngine, PianoParams, PianoPreset,
    KEY_COUNT,
};
use std::collections::HashMap;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

#[derive(cucumber::World)]
pub struct PianoWorld {
    pub params: PianoParams,
    pub key: usize,
    pub analysis: Option<PianoAnalysis>,
    pub named_analyses: HashMap<String, PianoAnalysis>,
    pub named_renders: HashMap<String, Vec<f32>>,
    pub last_render: Vec<f32>,
    pub last_engine: Option<PianoEngine>,
    pub named_engines: HashMap<String, PianoEngine>,
    pub bounced: Option<Vec<f32>>,
}

impl std::fmt::Debug for PianoWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PianoWorld(key={})", self.key)
    }
}

impl Default for PianoWorld {
    fn default() -> Self {
        let mut params = PianoParams::default();
        params.preset = PianoPreset::ConcertGrand;
        Self {
            params,
            key: 48, // A4
            analysis: None,
            named_analyses: HashMap::new(),
            named_renders: HashMap::new(),
            last_render: Vec::new(),
            last_engine: None,
            named_engines: HashMap::new(),
            bounced: None,
        }
    }
}

fn save_wav(name: &str, samples: &[f32], sample_rate: u32) {
    let dir = std::path::Path::new("test-artifacts/piano");
    let _ = std::fs::create_dir_all(dir);
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    if let Ok(mut w) = hound::WavWriter::create(dir.join(name), spec) {
        let peak = samples.iter().fold(1.0e-6f32, |m, v| m.max(v.abs()));
        for &v in samples {
            let s = (v * 32767.0).clamp(-32768.0, 32767.0) as i16;
            let _ = w.write_sample(s);
        }
        let _ = w.finalize();
    }
}

fn render_offline(
    params: &PianoParams,
    key: usize,
    strike_secs: f32,
    release_secs: f32,
) -> (Vec<f32>, PianoAnalysis, PianoEngine) {
    let mut engine = PianoEngine::new(SR, params);
    let freq = railsback_frequency(key);
    engine.note_on(freq, params.velocity);

    let strike_samples = (strike_secs * SR) as usize;
    let release_samples = (release_secs * SR) as usize;
    let total_samples = strike_samples + release_samples;
    let mut mono = Vec::with_capacity(total_samples);

    for _ in 0..strike_samples {
        let [l, r] = engine.next_frame();
        mono.push(0.5 * (l + r));
    }

    if release_samples > 0 {
        engine.note_off(freq);
        for _ in 0..release_samples {
            let [l, r] = engine.next_frame();
            mono.push(0.5 * (l + r));
        }
    }

    let hammer = &engine.keys[key].hammer;
    let contact_time_ms = hammer.contact_time * 1000.0;
    let peak_force_n = hammer.peak_force;

    let mut analysis = piano::analysis::measure(&mono, SR, freq);
    analysis.contact_time_ms = contact_time_ms;
    analysis.peak_force_n = peak_force_n;

    // Two-stage prompt vs aftersound estimation (prompt: 0.01..0.18s, aftersound: 0.80..2.20s for sustained notes)
    let s0 = (0.01 * SR) as usize;
    let s1 = (0.18 * SR) as usize;
    let (s2, s3) = if mono.len() >= (2.0 * SR) as usize {
        ((0.80 * SR) as usize, (2.20 * SR).min(mono.len() as f32) as usize)
    } else {
        ((0.50 * SR) as usize, (1.30 * SR).min(mono.len() as f32) as usize)
    };

    if s3 > s2 && s1 > s0 && mono.len() >= s3 {
        let rms_seg = |seg: &[f32]| {
            (seg.iter().map(|&x| x * x).sum::<f32>() / seg.len().max(1) as f32).sqrt()
        };
        let to_db = |v: f32| 20.0 * v.max(1.0e-9).log10();

        let prompt_diff = to_db(rms_seg(&mono[s0..s0 + (0.03 * SR) as usize]))
            - to_db(rms_seg(&mono[s1 - (0.03 * SR) as usize..s1]));
        let prompt_rate = (prompt_diff / 0.17).max(0.1);

        let after_diff = to_db(rms_seg(&mono[s2..s2 + (0.05 * SR) as usize]))
            - to_db(rms_seg(&mono[s3 - (0.05 * SR) as usize..s3]));
        let after_rate = (after_diff / ((s3 - s2) as f32 / SR)).max(0.05);

        analysis.prompt_decay_db_per_sec = prompt_rate;
        analysis.aftersound_decay_db_per_sec = after_rate;
        analysis.two_stage_ratio = prompt_rate / after_rate;
    }

    analysis.inharmonicity_b = piano::analysis::estimate_inharmonicity(&mono, SR, analysis.f0);

    (mono, analysis, engine)
}

fn window_rms_db(samples: &[f32], t_center: f32, duration: f32) -> f32 {
    let half = (duration * 0.5 * SR) as usize;
    let center = (t_center * SR) as usize;
    let start = center.saturating_sub(half);
    let end = (center + half).min(samples.len());
    if start >= end {
        return -120.0;
    }
    let slice = &samples[start..end];
    let rms = (slice.iter().map(|&x| x * x).sum::<f32>() / slice.len() as f32).sqrt();
    20.0 * rms.max(1.0e-9).log10()
}

// ------------------------------------------------------------------------------------------
// Given Steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a grand piano preset {string}")]
fn a_grand_piano_preset(world: &mut PianoWorld, preset_name: String) {
    if let Some(preset) = PianoPreset::from_name(&preset_name) {
        world.params.preset = preset;
    }
}

#[given(expr = "a note on key {int}")]
fn a_note_on_key(world: &mut PianoWorld, key: i32) {
    let k = (key as usize).min(KEY_COUNT - 1);
    world.key = k;
    world.params.freq = railsback_frequency(k);
}

// ------------------------------------------------------------------------------------------
// When Steps
// ------------------------------------------------------------------------------------------

#[when(expr = "I play the key for {float} seconds")]
fn play_key(world: &mut PianoWorld, secs: f32) {
    let (samples, analysis, engine) = render_offline(&world.params, world.key, secs, 0.0);
    save_wav(&format!("key_{}_railsback.wav", world.key), &samples, SR as u32);
    world.last_render = samples;
    world.analysis = Some(analysis);
    world.last_engine = Some(engine);
}

#[when(expr = "I play the key with velocity {float} for {float} seconds")]
fn play_key_velocity(world: &mut PianoWorld, vel: f32, secs: f32) {
    world.params.velocity = vel;
    let (samples, analysis, engine) = render_offline(&world.params, world.key, secs, 0.0);
    save_wav(&format!("preset_{}.wav", world.params.preset.name().to_lowercase().replace(' ', "_")), &samples, SR as u32);
    world.last_render = samples;
    world.analysis = Some(analysis);
    world.last_engine = Some(engine);
}

#[when(expr = "I strike the key with velocity {float} for {float} seconds as {string}")]
fn strike_key_velocity_as(world: &mut PianoWorld, vel: f32, secs: f32, name: String) {
    let mut p = world.params;
    p.velocity = vel;
    let (samples, analysis, engine) = render_offline(&p, world.key, secs, 0.0);
    save_wav(&format!("strike_{name}.wav"), &samples, SR as u32);
    world.named_analyses.insert(name.clone(), analysis);
    world.named_renders.insert(name.clone(), samples);
    world.named_engines.insert(name, engine);
}

#[when(expr = "I play the key for {float} seconds then release for {float} seconds as {string}")]
fn play_and_release_as(world: &mut PianoWorld, strike: f32, release: f32, name: String) {
    let (samples, analysis, engine) = render_offline(&world.params, world.key, strike, release);
    save_wav(&format!("damper_{name}.wav"), &samples, SR as u32);
    world.named_analyses.insert(name.clone(), analysis);
    world.named_renders.insert(name.clone(), samples);
    world.named_engines.insert(name, engine);
}

#[when(expr = "I hold the key for {float} seconds without releasing as {string}")]
fn hold_key_as(world: &mut PianoWorld, hold_secs: f32, name: String) {
    let (samples, analysis, engine) = render_offline(&world.params, world.key, hold_secs, 0.0);
    save_wav(&format!("held_{name}.wav"), &samples, SR as u32);
    world.named_analyses.insert(name.clone(), analysis);
    world.named_renders.insert(name.clone(), samples);
    world.named_engines.insert(name, engine);
}

#[when(expr = "I play the key with sustain pedal down for {float} seconds as {string}")]
fn play_pedal_down_as(world: &mut PianoWorld, secs: f32, name: String) {
    let mut p = world.params;
    p.sustain_pedal = 1.0;
    p.sympathetic_coupling = 1.0;
    p.soundboard_resonance = 1.0;
    let (samples, analysis, engine) = render_offline(&p, world.key, secs, 0.0);
    save_wav(&format!("pedal_{name}.wav"), &samples, SR as u32);
    world.named_analyses.insert(name.clone(), analysis);
    world.named_renders.insert(name.clone(), samples);
    world.named_engines.insert(name, engine);
}

#[when(expr = "I play the key with sustain pedal up for {float} seconds as {string}")]
fn play_pedal_up_as(world: &mut PianoWorld, secs: f32, name: String) {
    let mut p = world.params;
    p.sustain_pedal = 0.0;
    let (samples, analysis, engine) = render_offline(&p, world.key, secs, 0.0);
    save_wav(&format!("pedal_{name}.wav"), &samples, SR as u32);
    world.named_analyses.insert(name.clone(), analysis);
    world.named_renders.insert(name.clone(), samples);
    world.named_engines.insert(name, engine);
}

#[when(expr = "I play the key with una corda at {float} for {float} seconds as {string}")]
fn play_una_corda_as(world: &mut PianoWorld, una_corda: f32, secs: f32, name: String) {
    let mut p = world.params;
    p.una_corda = una_corda;
    let (samples, analysis, engine) = render_offline(&p, world.key, secs, 0.0);
    save_wav(&format!("una_corda_{name}.wav"), &samples, SR as u32);
    world.named_analyses.insert(name.clone(), analysis);
    world.named_renders.insert(name.clone(), samples);
    world.named_engines.insert(name, engine);
}

#[when(expr = "I bounce two piano notes to a WAV file, one at {float} seconds and one at {float} seconds")]
fn bounce_two_piano_notes(world: &mut PianoWorld, first: f64, second: f64) {
    let mk = |start: f64, freq: f32| entropy_engine::audio::PianoEvent {
        start_time: start,
        instrument: "piano-bounce".to_string(),
        params: PianoParams {
            freq,
            duration: 0.5,
            gain: 0.8,
            velocity: 0.8,
            preset: world.params.preset,
            ..world.params
        },
    };
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("piano");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("bounce.wav");
    let (seconds, warnings) = entropy_engine::audio::render_events_piano_to_wav(
        &[mk(first, 261.63), mk(second, 329.63)],
        44_100,
        &path,
    ).expect("the bounce is written");
    assert!(seconds >= 0.8, "bounce duration should cover both notes");
    assert!(warnings.is_empty(), "expected no warnings");
    let mut reader = hound::WavReader::open(&path).expect("the WAV can be read back");
    let samples: Vec<f32> = reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
    world.bounced = Some(samples);
}

#[then("the WAV file is created and can be read back")]
fn wav_file_created(world: &mut PianoWorld) {
    assert!(world.bounced.is_some(), "WAV samples must be loaded");
}

#[then(expr = "the WAV is audible from {float} seconds")]
fn wav_audible(world: &mut PianoWorld, t: f32) {
    let samples = world.bounced.as_ref().expect("no WAV was bounced");
    let start_idx = (t * 44_100.0) as usize;
    let end_idx = ((t + 0.3) * 44_100.0) as usize;
    let peak = samples[start_idx..end_idx.min(samples.len())].iter().fold(0.0f32, |m, v| m.max(v.abs()));
    assert!(peak > 0.001, "Expected audible audio from {}s, peak was {}", t, peak);
}

// ------------------------------------------------------------------------------------------
// Then Steps
// ------------------------------------------------------------------------------------------

#[then(expr = "its fundamental frequency is within {float} cents of the Railsback target for key {int}")]
fn pitch_within_railsback(world: &mut PianoWorld, max_cents: f32, key: i32) {
    let k = key as usize;
    let target = railsback_frequency(k);
    let a = world.analysis.as_ref().expect("Analysis must be available");
    let cents_off = 1200.0 * (a.f0 / target).log2().abs();
    println!(
        "Key {}: measured f0 = {:.2} Hz (target {:.2} Hz, error {:.2} cents, allowance {:.2} cents)",
        k, a.f0, target, cents_off, max_cents
    );
    assert!(
        cents_off <= max_cents,
        "Key {}: measured f0 = {:.2} Hz differs by {:.2} cents from target {:.2} Hz (max {})",
        k, a.f0, cents_off, target, max_cents
    );
}

#[then("the inharmonicity coefficient B is positive")]
fn inharmonicity_b_positive(world: &mut PianoWorld) {
    let a = world.analysis.as_ref().expect("Analysis must be available");
    println!("Inharmonicity coefficient B = {:.6e}", a.inharmonicity_b);
    assert!(
        a.inharmonicity_b >= 0.0,
        "Inharmonicity coefficient B should be non-negative, got {:.6e}",
        a.inharmonicity_b
    );
}

#[then(expr = "the contact time of {string} is shorter than {string}")]
fn contact_time_shorter(world: &mut PianoWorld, name1: String, name2: String) {
    let a1 = world.named_analyses.get(&name1).expect("Missing analysis 1");
    let a2 = world.named_analyses.get(&name2).expect("Missing analysis 2");
    println!(
        "Hammer contact time: {} = {:.2} ms vs {} = {:.2} ms",
        name1, a1.contact_time_ms, name2, a2.contact_time_ms
    );
    assert!(
        a1.contact_time_ms < a2.contact_time_ms,
        "Expected {} contact time ({:.2} ms) < {} ({:.2} ms)",
        name1, a1.contact_time_ms, name2, a2.contact_time_ms
    );
}

#[then(expr = "the peak force of {string} is greater than {string}")]
fn peak_force_greater(world: &mut PianoWorld, name1: String, name2: String) {
    let a1 = world.named_analyses.get(&name1).expect("Missing analysis 1");
    let a2 = world.named_analyses.get(&name2).expect("Missing analysis 2");
    println!(
        "Hammer peak force: {} = {:.2} N vs {} = {:.2} N",
        name1, a1.peak_force_n, name2, a2.peak_force_n
    );
    assert!(
        a1.peak_force_n > a2.peak_force_n,
        "Expected {} peak force ({:.2} N) > {} ({:.2} N)",
        name1, a1.peak_force_n, name2, a2.peak_force_n
    );
}

#[then(expr = "the spectral centroid of {string} is higher than {string}")]
fn centroid_higher(world: &mut PianoWorld, name1: String, name2: String) {
    let a1 = world.named_analyses.get(&name1).expect("Missing analysis 1");
    let a2 = world.named_analyses.get(&name2).expect("Missing analysis 2");
    println!(
        "Spectral centroid: {} = {:.1} Hz vs {} = {:.1} Hz",
        name1, a1.centroid_hz, name2, a2.centroid_hz
    );
    assert!(
        a1.centroid_hz > a2.centroid_hz,
        "Expected {} centroid ({:.1} Hz) > {} ({:.1} Hz)",
        name1, a1.centroid_hz, name2, a2.centroid_hz
    );
}

#[then(expr = "the spectral centroid of {string} is lower than {string}")]
fn centroid_lower(world: &mut PianoWorld, name1: String, name2: String) {
    let a1 = world.named_analyses.get(&name1).expect("Missing analysis 1");
    let a2 = world.named_analyses.get(&name2).expect("Missing analysis 2");
    println!(
        "Spectral centroid: {} = {:.1} Hz vs {} = {:.1} Hz",
        name1, a1.centroid_hz, name2, a2.centroid_hz
    );
    assert!(
        a1.centroid_hz < a2.centroid_hz,
        "Expected {} centroid ({:.1} Hz) < {} ({:.1} Hz)",
        name1, a1.centroid_hz, name2, a2.centroid_hz
    );
}

#[then(expr = "{string} is at least {float} dB louder in RMS than {string}")]
fn louder_rms(world: &mut PianoWorld, name1: String, db: f32, name2: String) {
    let a1 = world.named_analyses.get(&name1).expect("Missing analysis 1");
    let a2 = world.named_analyses.get(&name2).expect("Missing analysis 2");
    let diff = a1.rms_db - a2.rms_db;
    println!(
        "RMS level difference: {} ({:.1} dBFS) - {} ({:.1} dBFS) = {:.1} dB",
        name1, a1.rms_db, name2, a2.rms_db, diff
    );
    assert!(
        diff >= db,
        "Expected {} to be at least {:.1} dB louder than {}, got {:.1} dB",
        name1, db, name2, diff
    );
}

#[then(expr = "{string} is quieter than {string}")]
fn quieter_rms(world: &mut PianoWorld, name1: String, name2: String) {
    let a1 = world.named_analyses.get(&name1).expect("Missing analysis 1");
    let a2 = world.named_analyses.get(&name2).expect("Missing analysis 2");
    println!(
        "RMS comparison: {} ({:.1} dBFS) vs {} ({:.1} dBFS)",
        name1, a1.rms_db, name2, a2.rms_db
    );
    assert!(
        a1.rms_db < a2.rms_db,
        "Expected {} to be quieter than {}, got {:.1} vs {:.1} dBFS",
        name1, name2, a1.rms_db, a2.rms_db
    );
}

#[then(expr = "the prompt decay rate is at least {float} times the aftersound decay rate")]
fn prompt_ratio_check(world: &mut PianoWorld, ratio: f32) {
    let a = world.analysis.as_ref().expect("Analysis must be available");
    println!(
        "Two-stage decay: prompt = {:.1} dB/s, aftersound = {:.1} dB/s, ratio = {:.2}",
        a.prompt_decay_db_per_sec, a.aftersound_decay_db_per_sec, a.two_stage_ratio
    );
    assert!(
        a.two_stage_ratio >= ratio,
        "Expected two-stage ratio >= {:.2}, got {:.2}",
        ratio, a.two_stage_ratio
    );
}

#[then(expr = "the prompt decay rate exceeds {float} dB per second")]
fn prompt_decay_rate_exceeds(world: &mut PianoWorld, rate: f32) {
    let a = world.analysis.as_ref().expect("Analysis must be available");
    assert!(
        a.prompt_decay_db_per_sec >= rate,
        "Prompt decay rate {:.1} dB/s should exceed {:.1} dB/s",
        a.prompt_decay_db_per_sec, rate
    );
}

#[then(expr = "the aftersound decay rate is less than {float} dB per second")]
fn aftersound_decay_rate_less(world: &mut PianoWorld, rate: f32) {
    let a = world.analysis.as_ref().expect("Analysis must be available");
    assert!(
        a.aftersound_decay_db_per_sec <= rate,
        "Aftersound decay rate {:.1} dB/s should be less than {:.1} dB/s",
        a.aftersound_decay_db_per_sec, rate
    );
}

#[then(expr = "{string} is at least {float} dB quieter than {string} at {float} seconds")]
fn damper_quench_check(world: &mut PianoWorld, name1: String, diff_db: f32, name2: String, t: f32) {
    let s1 = world.named_renders.get(&name1).expect("Missing render 1");
    let s2 = world.named_renders.get(&name2).expect("Missing render 2");
    let rms1 = window_rms_db(s1, t, 0.1);
    let rms2 = window_rms_db(s2, t, 0.1);
    let drop = rms2 - rms1;
    println!(
        "Damper quench at {:.2}s: {} = {:.1} dBFS vs {} = {:.1} dBFS (drop = {:.1} dB, required = {:.1} dB)",
        t, name1, rms1, name2, rms2, drop, diff_db
    );
    assert!(
        drop >= diff_db,
        "Expected damper to quench note by >= {:.1} dB at {:.2}s, got {:.1} dB",
        diff_db, t, drop
    );
}

#[then(expr = "{string} level is within {float} dB of {string} at {float} seconds")]
fn undamped_treble_check(world: &mut PianoWorld, name1: String, tol_db: f32, name2: String, t: f32) {
    let s1 = world.named_renders.get(&name1).expect("Missing render 1");
    let s2 = world.named_renders.get(&name2).expect("Missing render 2");
    let rms1 = window_rms_db(s1, t, 0.1);
    let rms2 = window_rms_db(s2, t, 0.1);
    let diff = (rms1 - rms2).abs();
    println!(
        "Undamped treble check at {:.2}s: {} = {:.1} dBFS vs {} = {:.1} dBFS (diff = {:.1} dB, tol = {:.1} dB)",
        t, name1, rms1, name2, rms2, diff, tol_db
    );
    assert!(
        diff <= tol_db,
        "Undamped treble key should ring similarly whether released or held: diff {:.1} dB > tol {:.1} dB",
        diff, tol_db
    );
}

#[then(expr = "{string} has greater soundboard energy than {string}")]
fn greater_soundboard_energy(world: &mut PianoWorld, name1: String, name2: String) {
    let e1 = world.named_engines.get(&name1).expect("Missing engine 1");
    let e2 = world.named_engines.get(&name2).expect("Missing engine 2");
    let total_e1 = e1.soundboard.total_energy();
    let total_e2 = e2.soundboard.total_energy();
    println!(
        "Soundboard modal energy: {} = {:.4e} vs {} = {:.4e}",
        name1, total_e1, name2, total_e2
    );
    assert!(
        total_e1 >= total_e2,
        "Sustain pedal down should couple soundboard modes: {:.4e} vs {:.4e}",
        total_e1, total_e2
    );
}

#[then(expr = "{string} excites sympathetic vibrations across undamped strings")]
fn sympathetic_vibrations_check(world: &mut PianoWorld, name: String) {
    let e = world.named_engines.get(&name).expect("Missing engine");
    let active_undamped_keys = e.keys.iter().enumerate().filter(|(i, k)| *i != world.key && k.unison.energy > 1.0e-9).count();
    println!("Sympathetically excited unplayed keys: {}", active_undamped_keys);
    assert!(
        active_undamped_keys > 0,
        "Sustain pedal down should excite sympathetic strings across the harp"
    );
}

#[then(expr = "the rendered sound has peak level between {float} dB and {float} dB")]
fn peak_level_between(world: &mut PianoWorld, min_db: f32, max_db: f32) {
    let a = world.analysis.as_ref().expect("Analysis must be available");
    println!("Peak level = {:.1} dBFS (allowed {} .. {})", a.peak_db, min_db, max_db);
    assert!(
        a.peak_db >= min_db && a.peak_db <= max_db,
        "Peak level {:.1} dBFS out of range [{}, {}]",
        a.peak_db, min_db, max_db
    );
}

#[then("the audio waveform is finite and bounded")]
fn waveform_finite_and_bounded(world: &mut PianoWorld) {
    for &sample in &world.last_render {
        assert!(sample.is_finite(), "Audio sample was not finite: {}", sample);
        assert!(sample.abs() <= 2.0, "Audio sample exceeded bound: {}", sample);
    }
}

fn main() {
    futures::executor::block_on(
        PianoWorld::cucumber()
            .max_concurrent_scenarios(1)
            .fail_on_skipped()
            .run_and_exit("tests/features/piano_synth.feature"),
    );
}
