//! Regression contracts for musical behaviour and the live/offline boundary.
use entropy_engine::audio::piano::*;
use entropy_engine::audio::quality::Quality;
use std::sync::Arc;
const SR:usize=44100;
fn rms(x:&[f32])->f32 {(x.iter().map(|v|v*v).sum::<f32>()/x.len() as f32).sqrt()}
fn frames(e:&mut PianoEngine,n:usize)->Vec<f32> {(0..n).map(|_|{let f=e.next_frame();(f[0]+f[1])*0.5}).collect()}
#[test]
fn given_all_88_keys_when_struck_then_the_measured_fundamentals_are_in_tune_and_finite() {
    let mut report=Vec::new();
    for key in 0..88 {
        let target=railsback_frequency(key);
        let mut e=PianoEngine::new(SR as f32,&PianoParams::default()); e.note_on(target,0.8);
        let x=frames(&mut e,SR);
        assert!(x.iter().all(|v|v.is_finite()&&v.abs()<1.0),"key {key}");
        let hz=analysis::pitch(&x[SR/20..],SR as f32,target);
        let cents=1200.0*(hz/target).log2();
        assert!(cents.abs()<3.0,"key {key}: {hz} vs {target}, {cents} cents");
        assert!(rms(&x)>0.0005,"silent key {key}");
        report.push(serde_json::json!({"key":key,"targetHz":target,"pitchHz":hz,"cents":cents,"rms":rms(&x)}));
    }
    std::fs::create_dir_all("test-artifacts/piano").unwrap();
    std::fs::write("test-artifacts/piano/88-key-tuning.json",serde_json::to_vec_pretty(&report).unwrap()).unwrap();
}
#[test]
fn given_a_timed_note_when_restruck_then_the_old_release_does_not_stop_the_new_note() {
    let shared=Arc::new(PianoShared::default());
    let (mut voice,h)=PianoInstrumentVoice::new(shared.clone(),&PianoParams::default());
    h.timed_note(1,440.0,0.8,0.2);
    let _:Vec<_>=voice.by_ref().take(SR/5).collect();
    h.timed_note(2,440.0,0.8,0.8);
    let _:Vec<_>=voice.by_ref().take(SR).collect();
    assert!(shared.keys[48].key_down.load(std::sync::atomic::Ordering::Relaxed));
    let _:Vec<_>=voice.by_ref().take(SR).collect();
    assert!(!shared.keys[48].key_down.load(std::sync::atomic::Ordering::Relaxed));
}
#[test]
fn given_a_timed_note_when_rendered_live_and_offline_then_the_audio_matches() {
    let p=PianoParams {duration:0.2,..Default::default()};
    let (mut v,h)=PianoInstrumentVoice::new(Arc::new(PianoShared::default()),&p);
    h.timed_note(1,p.freq,p.velocity,p.duration);
    let live:Vec<_>=v.by_ref().take(SR*2).collect();
    let offline=render_note(&p,0.8);
    assert_eq!(live,&offline[..live.len()]);
}
#[test]
fn given_pedals_when_half_pressed_then_decay_is_between_closed_and_open() {
    let mut levels=Vec::new();
    for pedal in [0.0,0.5,1.0] {
        let p=PianoParams{sustain_pedal:pedal,sympathetic_coupling:0.0,..Default::default()};
        let mut e=PianoEngine::new(SR as f32,&p);e.note_on(261.63,0.8);frames(&mut e,SR/5);e.note_off(261.63);
        let x=frames(&mut e,SR/2);levels.push(rms(&x[SR/8..SR/4]));
    }
    assert!(levels[0]<levels[1] && levels[1]<levels[2],"{levels:?}");
}
#[test]
fn given_zero_velocity_or_silence_then_no_note_or_invented_pitch_is_reported() {
    let mut e=PianoEngine::new(SR as f32,&PianoParams::default()); e.note_on(440.0,0.0);
    let x=frames(&mut e,2048);assert_eq!(rms(&x),0.0);assert_eq!(analysis::pitch(&x,SR as f32,440.0),0.0);
}
#[test]
fn given_different_voicings_and_stiffness_then_rendered_audio_changes() {
    let analyze=|preset,scale|analysis::analyze_note(&PianoParams{preset,inharmonicity_scale:scale,..Default::default()},1.0);
    let warm=analyze(PianoPreset::WarmGrand,1.0);let bright=analyze(PianoPreset::BrightGrand,1.0);
    assert!(bright.centroid_hz>warm.centroid_hz*1.05,"{} {}",warm.centroid_hz,bright.centroid_hz);
    let a=analyze(PianoPreset::ConcertGrand,0.0);let b=analyze(PianoPreset::ConcertGrand,3.0);
    assert!(b.inharmonicity_b>a.inharmonicity_b+0.0001,"{} {}",a.inharmonicity_b,b.inharmonicity_b);
}
#[test]
fn given_a_pedal_chord_when_panic_is_sent_then_held_keys_and_pedal_are_released() {
    let s=Arc::new(PianoShared::default());let (mut v,h)=PianoInstrumentVoice::new(s.clone(),&PianoParams::default());
    h.set_pedal(1.0,0.0);for (i,f) in [261.63,329.63,392.0].into_iter().enumerate(){h.note_on(i as u64,f,0.8);}
    v.by_ref().take(4096).for_each(drop);h.all_notes_off();v.by_ref().take(4096).for_each(drop);
    assert!(s.keys.iter().all(|k|!k.key_down.load(std::sync::atomic::Ordering::Relaxed)));
    assert_eq!(f32::from_bits(s.sustain_pedal.load(std::sync::atomic::Ordering::Relaxed)),0.0);
}
#[test]
fn given_a_live_instrument_when_replaced_then_its_source_finishes_after_a_fade() {
    let (mut v,h)=PianoInstrumentVoice::new(Arc::new(PianoShared::default()),&PianoParams::default());h.note_on(1,440.0,0.8);
    v.by_ref().take(1000).for_each(drop);h.stop();assert!(v.take(2000).count()<2000);
}
#[test]
fn report_callback_cost_for_a_pedalled_chord() {
    for q in Quality::ALL {
        let mut e=PianoEngine::new(SR as f32,&PianoParams{quality:q,sustain_pedal:1.0,..Default::default()});
        for f in [130.81,196.0,261.63,329.63,392.0,523.25] {e.note_on(f,0.7);}
        let t=std::time::Instant::now();let mut worst=0.0f64;
        for _ in 0..172 {let block=std::time::Instant::now();for _ in 0..256 {std::hint::black_box(e.next_frame());}worst=worst.max(block.elapsed().as_secs_f64());}
        println!("{q:?}: one second / {:.3}s CPU elapsed, worst256 {:.2}ms",t.elapsed().as_secs_f64(),worst*1000.0);
    }
}
