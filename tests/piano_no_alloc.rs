//! Real-time safety: a live grand piano instrument allocates nothing on the audio thread - not
//! while strings vibrate, not while note-on/note-off commands arrive through its non-blocking command
//! queue, not while pedals change, and not while publishing its lock-free state to the UI.
//!
//! A counting global allocator watches only the thread that pulls audio frames; the thread sending
//! notes or UI interaction may allocate freely.
//!
//! One test in this binary on purpose: the allocator is global.

use entropy_engine::audio::piano::{
    PianoInstrumentVoice, PianoParams, PianoPreset, PianoShared,
};
use entropy_engine::audio::quality::Quality;
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
fn a_live_grand_piano_allocates_nothing_on_the_audio_thread() {
    for quality in Quality::ALL {
        play_live_phrase(quality);
    }
}

fn play_live_phrase(quality: Quality) {
    ALLOCS.store(0, Ordering::Relaxed);
    let shared = Arc::new(PianoShared::default());
    let mut params = PianoParams::default();
    params.quality = quality;
    params.preset = PianoPreset::ConcertGrand;

    let (mut voice, handle) = PianoInstrumentVoice::new(shared.clone(), &params);
    let done = Arc::new(AtomicBool::new(false));

    // Stand-in "UI/sequencer" thread: sends note-on, note-off, and continuous pedal actions
    let sender = {
        let handle = handle.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            // Note frequencies: C4 (261.63), E4 (329.63), G4 (392.00), B4 (493.88), C5 (523.25)
            let notes = [261.63f32, 329.63, 392.00, 493.88, 523.25];
            for (i, &f) in notes.iter().enumerate() {
                handle.note_on(i as u64 + 1, f, 0.75 + 0.05 * i as f32);
                std::thread::sleep(std::time::Duration::from_millis(40));

                if i == 2 {
                    // Depress sustain pedal mid-phrase
                    handle.set_pedal(1.0, 0.0);
                }

                if i > 1 {
                    handle.note_off((i - 1) as u64, notes[i - 2]);
                }
            }

            // Una corda test
            handle.set_pedal(1.0, 1.0);
            std::thread::sleep(std::time::Duration::from_millis(50));

            // Release sustain pedal
            handle.set_pedal(0.0, 0.0);
            std::thread::sleep(std::time::Duration::from_millis(40));

            handle.all_notes_off();
            done.store(true, Ordering::Relaxed);
        })
    };

    // Warm up one buffer block before starting allocator watch
    let _ = voice.by_ref().take(128).count();

    ON_AUDIO_THREAD.with(|c| c.set(true));
    let mut frames = 0usize;
    let mut peak = 0.0f32;

    while frames < 44_100 * 2 {
        let Some(s) = voice.next() else { break };
        peak = peak.max(s.abs());
        frames += 1;

        if frames % 2048 == 0 {
            // Yield briefly so sender thread runs concurrently
            ON_AUDIO_THREAD.with(|c| c.set(false));
            std::thread::sleep(std::time::Duration::from_millis(2));
            ON_AUDIO_THREAD.with(|c| c.set(true));
        }
    }

    ON_AUDIO_THREAD.with(|c| c.set(false));
    sender.join().unwrap();

    assert!(done.load(Ordering::Relaxed), "Sequencer thread must finish");
    assert!(peak > 0.005, "{quality:?}: audio must sound (measured peak = {peak})");
    assert_eq!(
        ALLOCS.load(Ordering::Relaxed),
        0,
        "{quality:?}: audio thread allocated during live playback!"
    );
}
