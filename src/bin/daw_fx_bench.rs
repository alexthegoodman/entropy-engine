// Headless benchmark for the DAW's new per-note delay/reverb FX chain and offline WAV
// export path (`crate::audio::render_pattern_to_wav`). No window, no rodio OutputStream -
// this only exercises the offline render path, which is exactly what an export does.
//
// Run: cargo run --release --bin daw_fx_bench

use entropy_engine::audio::{render_pattern_to_wav, NoteEvent, NoteParams};
use std::time::Instant;

fn make_pattern(bars: u32, fx_on: bool) -> Vec<NoteEvent> {
    let bpm = 96.0;
    let steps_per_beat = 4.0;
    let step_dur = 60.0 / bpm / steps_per_beat;
    let steps_per_bar = 16;

    let mut events = Vec::new();

    let (delay_time, delay_feedback, delay_mix, reverb_room, reverb_time, reverb_damping, reverb_mix) =
        if fx_on {
            (0.18, 0.4, 0.3, 14.0, 1.6, 0.5, 0.35)
        } else {
            (0.0, 0.0, 0.0, 10.0, 1.0, 0.5, 0.0)
        };

    for bar in 0..bars {
        let base_step = bar * steps_per_bar;
        // Drums: kick on 0/8, snare on 4/12, hihat every other step.
        for &(offset, voice, freq) in &[(0u32, "kick", 55.0), (8, "kick", 55.0), (4, "snare", 200.0), (12, "snare", 200.0)] {
            events.push(NoteEvent {
                start_time: ((base_step + offset) as f64) * step_dur,
                voice: voice.to_string(),
                params: NoteParams {
                    freq,
                    duration: step_dur * 0.95,
                    cutoff: 1800.0,
                    resonance: 1.0,
                    gain: 0.55,
                    attack: 0.002,
                    decay: 0.12,
                    sustain: 0.0,
                    release: 0.08,
                    delay_time, delay_feedback, delay_mix,
                    reverb_room_size: reverb_room, reverb_time, reverb_damping, reverb_mix,
                    ..Default::default()
                },
            });
        }
        for hh in (0..steps_per_bar).step_by(2) {
            events.push(NoteEvent {
                start_time: ((base_step + hh) as f64) * step_dur,
                voice: "hihat".to_string(),
                params: NoteParams {
                    freq: 1000.0,
                    duration: step_dur * 0.6,
                    cutoff: 8000.0,
                    resonance: 1.0,
                    gain: 0.35,
                    attack: 0.001,
                    decay: 0.05,
                    sustain: 0.0,
                    release: 0.03,
                    delay_time, delay_feedback, delay_mix,
                    reverb_room_size: reverb_room, reverb_time, reverb_damping, reverb_mix,
                    ..Default::default()
                },
            });
        }
        // Bass: two-note saw riff.
        for &(offset, freq) in &[(0u32, 65.4), (8, 73.4)] {
            events.push(NoteEvent {
                start_time: ((base_step + offset) as f64) * step_dur,
                voice: "saw".to_string(),
                params: NoteParams {
                    freq,
                    duration: step_dur * 2.0 * 0.95,
                    cutoff: 4000.0,
                    resonance: 1.0,
                    gain: 0.3,
                    attack: 0.005,
                    decay: 0.08,
                    sustain: 0.6,
                    release: 0.12,
                    delay_time, delay_feedback, delay_mix,
                    reverb_room_size: reverb_room, reverb_time, reverb_damping, reverb_mix,
                    ..Default::default()
                },
            });
        }
    }

    events
}

fn run_case(label: &str, bars: u32, fx_on: bool, out_path: &std::path::Path) {
    let events = make_pattern(bars, fx_on);
    let n_events = events.len();

    let start = Instant::now();
    let rendered_duration = render_pattern_to_wav(&events, 44100, out_path).expect("render failed");
    let elapsed = start.elapsed();

    // Read the file back with hound (independent of our own return value) to confirm what
    // actually landed on disk, not just what the function claims it wrote - including that
    // it's real non-silent audio, not an all-zero buffer.
    let mut reader = hound::WavReader::open(out_path).expect("failed to reopen exported wav");
    let spec = reader.spec();
    let n_samples = reader.len() as u64;
    let file_duration = n_samples as f64 / spec.sample_rate as f64 / spec.channels as f64;

    let mut peak: i64 = 0;
    let mut sum_sq: f64 = 0.0;
    let mut count: u64 = 0;
    for s in reader.samples::<i16>() {
        let v = s.expect("bad sample") as i64;
        peak = peak.max(v.abs());
        sum_sq += (v as f64) * (v as f64);
        count += 1;
    }
    let rms = (sum_sq / count as f64).sqrt();

    let speed_multiplier = rendered_duration / elapsed.as_secs_f64();

    println!(
        "[{label}] events={n_events} bars={bars} fx_on={fx_on} render_claimed_dur={:.3}s wav_file_dur={:.3}s (ch={}, sr={}) elapsed={:.1}ms speed={:.1}x realtime peak={:.3} rms={:.4}",
        rendered_duration, file_duration, spec.channels, spec.sample_rate, elapsed.as_secs_f64() * 1000.0, speed_multiplier,
        peak as f64 / i16::MAX as f64, rms / i16::MAX as f64
    );
}

fn main() {
    let out_dir = std::env::temp_dir().join("daw_fx_bench");
    std::fs::create_dir_all(&out_dir).expect("failed to create bench output dir");

    println!("Output WAVs written to: {}", out_dir.display());
    println!();

    // Short pattern (4 bars, ~10s), FX off vs on.
    run_case("4bar-dry", 4, false, &out_dir.join("4bar_dry.wav"));
    run_case("4bar-fx", 4, true, &out_dir.join("4bar_fx.wav"));

    // Longer pattern (32 bars, ~80s) to see whether the ratio holds at scale.
    run_case("32bar-dry", 32, false, &out_dir.join("32bar_dry.wav"));
    run_case("32bar-fx", 32, true, &out_dir.join("32bar_fx.wav"));
}
