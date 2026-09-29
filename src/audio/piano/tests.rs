use super::*;
use crate::audio::analysis::ENGINE_SAMPLE_RATE;

const SR: f32 = ENGINE_SAMPLE_RATE as f32;

#[test]
fn test_render_note_produces_audio() {
    let params = PianoParams::default();
    let audio = render_note(&params, 0.5);
    assert!(!audio.is_empty(), "render_note should return audio samples");
    let peak = audio.iter().fold(0.0f32, |m, &x| m.max(x.abs()));
    assert!(peak > 0.001, "render_note audio should have audible peak");
    assert!(peak <= 2.0, "render_note audio should be bounded");
}

#[test]
fn test_render_performance_chords() {
    let chord = [
        PerformedPianoNote {
            start: 0.0,
            params: PianoParams {
                freq: 261.63,
                velocity: 0.7,
                duration: 0.5,
                ..Default::default()
            },
        },
        PerformedPianoNote {
            start: 0.05,
            params: PianoParams {
                freq: 329.63,
                velocity: 0.7,
                duration: 0.5,
                ..Default::default()
            },
        },
    ];
    let audio = render_performance(&chord, 0.5);
    assert!(!audio.is_empty());
    assert!(audio.iter().all(|s| s.is_finite()));
}

// ---------------------------------------------------------------- listening

/// Renders a few piano phrases to `test-artifacts/piano/` for listening (these are for ears).
/// `cargo test --release --lib audio::piano::tests::listening_examples -- --ignored`
#[test]
#[ignore]
fn listening_examples() {
    let dir = std::path::Path::new("test-artifacts/piano");
    std::fs::create_dir_all(dir).unwrap();
    let write = |name: &str, x: &[f32]| {
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: ENGINE_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(dir.join(name), spec).unwrap();
        let peak = x.iter().fold(1.0e-6f32, |m, v| m.max(v.abs()));
        for v in x {
            let s = (v * 32767.0).clamp(-32768.0, 32767.0) as i16;
            w.write_sample(s).unwrap();
        }
        w.finalize().unwrap();
    };

    // 1. A C major triad on Concert Grand: C3, G3, C4, E4.
    let triad = [
        PerformedPianoNote {
            start: 0.0,
            params: PianoParams { freq: 130.81, velocity: 0.75, duration: 2.0, ..Default::default() },
        },
        PerformedPianoNote {
            start: 0.02,
            params: PianoParams { freq: 196.00, velocity: 0.72, duration: 2.0, ..Default::default() },
        },
        PerformedPianoNote {
            start: 0.04,
            params: PianoParams { freq: 261.63, velocity: 0.78, duration: 2.0, ..Default::default() },
        },
        PerformedPianoNote {
            start: 0.06,
            params: PianoParams { freq: 329.63, velocity: 0.80, duration: 2.0, ..Default::default() },
        },
    ];
    write("c_major_triad.wav", &render_performance(&triad, 2.0));

    // 2. Arpeggio with full sustain pedal down, exciting soundboard sympathy.
    let mut pedal_params = PianoParams::default();
    pedal_params.sustain_pedal = 1.0;
    pedal_params.sympathetic_coupling = 1.0;
    let arpeggio = [
        PerformedPianoNote { start: 0.0, params: PianoParams { freq: 130.81, velocity: 0.80, duration: 0.4, ..pedal_params } },
        PerformedPianoNote { start: 0.25, params: PianoParams { freq: 196.00, velocity: 0.75, duration: 0.4, ..pedal_params } },
        PerformedPianoNote { start: 0.50, params: PianoParams { freq: 261.63, velocity: 0.75, duration: 0.4, ..pedal_params } },
        PerformedPianoNote { start: 0.75, params: PianoParams { freq: 329.63, velocity: 0.75, duration: 0.4, ..pedal_params } },
        PerformedPianoNote { start: 1.00, params: PianoParams { freq: 392.00, velocity: 0.80, duration: 0.4, ..pedal_params } },
        PerformedPianoNote { start: 1.25, params: PianoParams { freq: 523.25, velocity: 0.85, duration: 1.5, ..pedal_params } },
    ];
    write("arpeggio_pedal.wav", &render_performance(&arpeggio, 2.5));

    // 3. Dynamic hammer strike from pianissimo to fortissimo.
    let velocities = [0.15f32, 0.35, 0.55, 0.75, 0.95];
    let dynamics: Vec<PerformedPianoNote> = velocities
        .iter()
        .enumerate()
        .map(|(i, &v)| PerformedPianoNote {
            start: i as f64 * 0.8,
            params: PianoParams { freq: 440.0, velocity: v, duration: 0.7, ..Default::default() },
        })
        .collect();
    write("dynamics_pp_to_ff.wav", &render_performance(&dynamics, 1.0));

    // 4. Una corda soft pedal comparison (normal vs una corda).
    let mut soft_params = PianoParams::default();
    soft_params.una_corda = 1.0;
    let una_corda_notes = [
        PerformedPianoNote { start: 0.0, params: PianoParams { freq: 440.0, velocity: 0.7, duration: 1.2, ..Default::default() } },
        PerformedPianoNote { start: 1.4, params: PianoParams { freq: 440.0, velocity: 0.7, duration: 1.2, ..soft_params } },
    ];
    write("una_corda_comparison.wav", &render_performance(&una_corda_notes, 1.0));
}
