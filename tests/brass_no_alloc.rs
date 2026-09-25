//! Real-time safety: a live brass player allocates nothing on the audio thread - not while a note
//! sounds, not while notes arrive, slur, glide, re-tongue and release through its command queue,
//! not while its breath and bend are moved live, not while it publishes its state for the view. A
//! counting global allocator watches only the thread that pulls samples (the stand-in for the audio
//! thread); the thread sending notes may allocate freely, and so may building the player.
//!
//! One test in this binary on purpose: the allocator is global.

use entropy_engine::audio::brass::{Articulation, BrassCommand, BrassInstrumentVoice, BrassLive, BrassParams, BrassShared};
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
fn a_live_brass_player_allocates_nothing_on_the_audio_thread() {
    let shared = Arc::new(BrassShared::default());
    let base = BrassParams { vibrato_depth: 15.0, ..Default::default() };
    let (mut voice, handle) = BrassInstrumentVoice::new(shared.clone(), &base);
    let done = Arc::new(AtomicBool::new(false));

    // The "UI" thread: a phrase - tongued notes, a slur across positions, a glissando, a loud
    // re-tongued repeat - with live breath and bend moves.
    let sender = {
        let handle = handle.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let live = Arc::new(BrassLive::from_params(&base));
            let phrase = [
                (233.08f32, Articulation::Tongued),
                (196.0, Articulation::Legato),
                (293.66, Articulation::Legato),
                (174.61, Articulation::Glissando),
                (174.61, Articulation::Tongued),
                (349.23, Articulation::Tongued),
            ];
            for (k, &(freq, articulation)) in phrase.iter().enumerate() {
                let id = k as u64 + 1;
                let p = BrassParams { freq, articulation, ..base };
                let _ = handle.send(BrassCommand::NoteOn { id, params: p, gated: true, live: Some(live.clone()) });
                if id > 1 {
                    let _ = handle.send(BrassCommand::NoteOff { id: id - 1 });
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
                live.set("breath", 0.3 + 0.1 * k as f32);
                live.set("bend", if k % 2 == 0 { 40.0 } else { 0.0 });
            }
            let _ = handle.send(BrassCommand::AllNotesOff);
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
    assert!(shared.version() > 10, "the player should have published its state");
    assert_eq!(ALLOCS.load(Ordering::Relaxed), 0, "the audio thread allocated");
}
