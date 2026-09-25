//! Real-time safety: a live bowed-string instrument allocates nothing on the audio thread - not
//! while strings sound, not while notes arrive, slur, double-stop and release through its command
//! queue, not while the bow is moved live, not while it publishes its state for the view. A
//! counting global allocator watches only the thread that pulls samples (the stand-in for the
//! audio thread); the thread sending notes may allocate freely.
//!
//! One test in this binary on purpose: the allocator is global.

use entropy_engine::audio::physmod::{InstrumentCommand, PhysModInstrumentVoice, PhysModLive, PhysModParams, PhysModShared, Articulation};
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

#[test]
fn a_live_instrument_allocates_nothing_on_the_audio_thread() {
    let shared = Arc::new(PhysModShared::default());
    let base = PhysModParams { sympathetic: [587.33, 659.25, 0.0, 0.0, 0.0, 0.0], ..Default::default() };
    let (mut voice, handle) = PhysModInstrumentVoice::new(shared.clone(), &base);
    let done = Arc::new(AtomicBool::new(false));

    // The "UI" thread: a phrase of notes - slurs, a double stop, pizzicato, live bow moves.
    let sender = {
        let handle = handle.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let live = Arc::new(PhysModLive::from_params(&base));
            let notes = [(1u64, 440.0f32, Articulation::Arco), (2, 493.88, Articulation::Arco), (3, 523.25, Articulation::Arco), (4, 659.25, Articulation::Pizzicato), (5, 293.66, Articulation::Arco), (6, 369.99, Articulation::Arco)];
            for (k, &(id, freq, articulation)) in notes.iter().enumerate() {
                let p = PhysModParams { freq, articulation, ..base };
                let _ = handle.send(InstrumentCommand::NoteOn { id, params: p, gated: true, live: Some(live.clone()) });
                std::thread::sleep(std::time::Duration::from_millis(60));
                live.bow_force.store((0.3 + 0.1 * k as f32).to_bits(), Ordering::Relaxed);
                live.bow_position.store((0.08 + 0.02 * k as f32).to_bits(), Ordering::Relaxed);
                if id > 1 {
                    let _ = handle.send(InstrumentCommand::NoteOff { id: id - 1 });
                }
            }
            let _ = handle.send(InstrumentCommand::AllNotesOff);
            done.store(true, Ordering::Relaxed);
        })
    };

    // Warm up one block so any lazily-initialised thread-local state exists before counting.
    let _ = voice.by_ref().take(64).count();
    ON_AUDIO_THREAD.with(|c| c.set(true));
    let mut frames = 0usize;
    let mut peak = 0.0f32;
    while frames < 44_100 * 3 {
        let Some(v) = voice.next() else { break };
        peak = peak.max(v.abs());
        frames += 1;
        if frames % 4096 == 0 {
            // Let the sender run at roughly real time.
            ON_AUDIO_THREAD.with(|c| c.set(false));
            std::thread::sleep(std::time::Duration::from_millis(5));
            ON_AUDIO_THREAD.with(|c| c.set(true));
        }
    }
    ON_AUDIO_THREAD.with(|c| c.set(false));
    sender.join().unwrap();
    assert!(done.load(Ordering::Relaxed));
    assert!(peak > 0.01, "the phrase should have sounded (peak {peak})");
    assert!(shared.string_count() == 6, "4 bowed + 2 sympathetic strings published");
    assert_eq!(ALLOCS.load(Ordering::Relaxed), 0, "the audio thread allocated");
}
