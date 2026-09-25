//! Real-time safety: the brass instrument allocates nothing once built - not while a note sounds,
//! not while notes arrive, slur, glide, re-tongue and release, not while it reports its state. A
//! counting global allocator watches only the thread that renders (the stand-in for the audio
//! thread). Building the instrument (its resonance table, its delay lines) may allocate: that
//! happens off the audio thread.
//!
//! One test in this binary on purpose: the allocator is global.

use entropy_engine::audio::brass::{Articulation, BrassParams, Engine};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

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
fn a_playing_brass_instrument_allocates_nothing() {
    let base = BrassParams { vibrato_depth: 15.0, ..Default::default() };
    let mut engine = Engine::new(44_100.0, &base);
    let sr = 44_100.0f32;

    ON_AUDIO_THREAD.with(|c| c.set(true));
    // A phrase: tongued notes, a slur across positions, a lip slur, a glissando, a loud note, a
    // re-tongued repeat, a release.
    let phrase = [
        (233.08f32, Articulation::Tongued, 0.5f32),
        (196.0, Articulation::Legato, 0.5),
        (293.66, Articulation::Legato, 0.5),
        (174.61, Articulation::Glissando, 0.9),
        (174.61, Articulation::Tongued, 0.9),
        (349.23, Articulation::Tongued, 0.6),
    ];
    let mut peak = 0.0f32;
    for (i, &(freq, articulation, breath)) in phrase.iter().enumerate() {
        engine.note_on(i as u64 + 1, BrassParams { freq, articulation, breath, ..base }, true);
        if i > 0 {
            engine.note_off(i as u64);
        }
        for _ in 0..(0.3 * sr) as usize {
            peak = peak.max(engine.next_frame()[0].abs());
        }
        let _ = engine.report();
    }
    engine.all_notes_off();
    for _ in 0..(0.3 * sr) as usize {
        engine.next_frame();
    }
    ON_AUDIO_THREAD.with(|c| c.set(false));

    assert!(peak > 0.01, "the phrase should have sounded (peak {peak})");
    assert_eq!(ALLOCS.load(Ordering::Relaxed), 0, "the audio thread allocated");
}
