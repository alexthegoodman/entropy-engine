//! Fast DSP-only iteration: rustc --edition=2024 -O scripts/piano_probe.rs -o test-artifacts/piano-probe.exe
//! Uses the production source directly; no copied model or external dependencies.
#![allow(dead_code)]
#[path="../src/audio/quality.rs"] pub mod quality;
#[path="../src/audio/physmod/dsp.rs"] pub mod dsp;
#[path="../src/audio/matter/contact.rs"] pub mod contact;
#[path="../src/audio/piano/string.rs"] pub mod string;
#[path="../src/audio/piano/hammer.rs"] pub mod hammer;
#[path="../src/audio/piano/pedal.rs"] pub mod pedal;
#[path="../src/audio/piano/soundboard.rs"] pub mod soundboard;
#[path="../src/audio/piano/engine.rs"] pub mod engine;
pub mod audio { pub use crate::quality; pub mod physmod {pub use crate::dsp;} pub mod matter {pub use crate::contact;} }
use engine::*;
use std::io::Write;
fn main() {
    std::fs::create_dir_all("test-artifacts/piano-probe").unwrap();
    for quality in quality::Quality::ALL {
        let p=PianoParams{quality,sustain_pedal:1.0,..Default::default()};
        let mut e=PianoEngine::new(44100.0,&p);
        for f in [130.81,196.0,261.63,329.63,392.0,523.25] {e.note_on(f,0.7);}
        let t=std::time::Instant::now();let mut peak=0.0f32;
        for _ in 0..44100 {let f=std::hint::black_box(e.next_frame());peak=peak.max(f[0].abs()).max(f[1].abs());}
        println!("Pedal chord {quality:?}: cost {:.1}% peak {peak}",t.elapsed().as_secs_f64()*100.0);
    }
    for (key,velocity,preset) in [(0,0.8,PianoPreset::ConcertGrand),(27,0.8,PianoPreset::ConcertGrand),(39,0.8,PianoPreset::ConcertGrand),(48,0.2,PianoPreset::ConcertGrand),(48,0.95,PianoPreset::ConcertGrand),(87,0.8,PianoPreset::ConcertGrand),(48,0.8,PianoPreset::WarmGrand),(48,0.8,PianoPreset::BrightGrand)] {
        let p=PianoParams {velocity,preset,..Default::default()};
        let mut engine=PianoEngine::new(44100.0,&p);
        engine.note_on(railsback_frequency(key),velocity);
        let mut file=std::io::BufWriter::new(std::fs::File::create(format!("test-artifacts/piano-probe/{key}-{velocity}-{preset:?}.f32")).unwrap());
        let start=std::time::Instant::now(); let mut peak=0.0f32;
        for _ in 0..44100*3 {let frame=engine.next_frame(); for v in frame {peak=peak.max(v.abs()); file.write_all(&v.to_le_bytes()).unwrap();}}
        println!("key {key} v {velocity} {preset:?}: peak {peak:.4}, contact {:.2}ms force {:.1}N cost {:.1}%",engine.keys[key].hammer.contact_time*1000.0,engine.keys[key].hammer.peak_force,start.elapsed().as_secs_f64()/3.0*100.0);
    }
}
