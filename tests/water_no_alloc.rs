//! Real-time safety: a live water track allocates nothing on the audio thread - not while notes
//! arrive through its command queue (drips tuned to notes, glasses retuned and struck, vessels
//! reshaped and filled), not while bubbles are born, rise and glide, not while rain lands on its
//! surface, not while the brook, the surf and a shaken tub run their surface simulations, and not
//! while it publishes its state. A counting global allocator watches only the thread that pulls
//! samples (the stand-in for the audio thread); the thread sending notes may allocate freely (it
//! solves each note's physics), and so may building the water.
//!
//! One test per surface the rain falls on that has a body to splash (a lake, a tent, a cymbal), in
//! one binary on purpose: the allocator is global.

use entropy_engine::audio::matter::rain::RainTarget;
use entropy_engine::audio::matter::water_voice::{Water, WaterAction, WaterCommand, WaterShared, WaterSpec, WaterVoice, DEFAULT_MIX, SOURCES};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

thread_local! {
    static ON_AUDIO_THREAD: Cell<bool> = const { Cell::new(false) };
}

struct Counting;

static ALLOCS: AtomicUsize = AtomicUsize::new(0);

fn count() {
    if ON_AUDIO_THREAD.try_with(|c| c.get()).unwrap_or(false) {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static A: Counting = Counting;

fn play(rain: RainTarget) -> (f32, u64) {
    let spec = WaterSpec { rain, ..WaterSpec::default() };
    let shared = Arc::new(WaterShared::default());
    let (mut voice, handle) = WaterVoice::new(shared.clone(), Water::new(spec, 44_100.0));
    let done = Arc::new(AtomicBool::new(false));

    // The "UI" thread: a phrase of drips, more glasses than the rack holds (so some are retuned),
    // two fills at once and a third, rain, the brook, the surf, the tub, and the mix changed.
    let sender = {
        let handle = handle.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let notes = [
                WaterAction::Drip { pitch: 880.0, x: -0.5 },
                WaterAction::Drip { pitch: 0.0, x: 0.2 },
                WaterAction::Rain { rate: 20.0, duration: 1.5 },
                WaterAction::Brook { speed: 0.6, duration: 1.0 },
                WaterAction::Surf { height: 1.2, duration: 1.0 },
                WaterAction::Slosh { strength: 1.0, duration: 1.0 },
                WaterAction::Fill { pitch: 330.0, duration: 0.8 },
                WaterAction::Fill { pitch: 494.0, duration: 0.6 },
                WaterAction::Fill { pitch: 220.0, duration: 0.5 },
            ];
            for (k, a) in notes.iter().enumerate() {
                let _ = handle.send(a.command(&spec));
                if k == 4 {
                    let _ = handle.send(WaterCommand::Mix([0.7; SOURCES]));
                }
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            for k in 0..11 {
                let pitch = 440.0 * 2.0f32.powf(k as f32 / 12.0);
                let _ = handle.send(WaterAction::Glass { pitch, speed: 0.5, spoon: k % 3 == 0 }.command(&spec));
                std::thread::sleep(std::time::Duration::from_millis(30));
            }
            let _ = handle.send(WaterCommand::Mix(DEFAULT_MIX));
            done.store(true, Ordering::Relaxed);
        })
    };

    let _ = voice.by_ref().take(256).count();
    ON_AUDIO_THREAD.with(|c| c.set(true));
    let (mut frames, mut peak) = (0usize, 0.0f32);
    while frames < 44_100 * 2 * 3 {
        let Some(v) = voice.next() else { break };
        peak = peak.max(v.abs());
        frames += 1;
        if frames % 4096 == 0 {
            ON_AUDIO_THREAD.with(|c| c.set(false));
            std::thread::sleep(std::time::Duration::from_millis(5));
            ON_AUDIO_THREAD.with(|c| c.set(true));
        }
    }
    ON_AUDIO_THREAD.with(|c| c.set(false));
    sender.join().unwrap();
    assert!(done.load(Ordering::Relaxed));
    (peak, shared.version())
}

#[test]
fn live_water_allocates_nothing_on_the_audio_thread() {
    for rain in [RainTarget::Lake, RainTarget::Tent, RainTarget::Cymbal] {
        let (peak, version) = play(rain);
        assert!(peak > 0.01, "the water should have sounded (peak {peak}, rain on {})", rain.name());
        assert!(version > 10, "the water should have published its state");
        assert_eq!(ALLOCS.load(Ordering::Relaxed), 0, "the audio thread allocated (rain on {})", rain.name());
    }
}
