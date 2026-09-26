//! Real-time safety: a live drum kit allocates nothing on the audio thread - not while hits arrive
//! through its command queue, not while its heads ring, glide and set the snare wires rattling, not
//! while the pieces hear each other, not while its cymbals couple their modes, not while it
//! publishes its state for the view, not while tools are rubbed on it (brush strokes, a rod scraped
//! along a cymbal, a tool held and dragged live, tools switched between strokes), and not while it
//! hands blocks to its worker threads. A
//! counting global allocator watches only the thread that pulls samples (the stand-in for the audio
//! thread); the thread sending hits may allocate freely, and so may building the kit.
//!
//! The kit is played twice: all on the audio thread (so every piece's rendering is watched), then
//! with worker threads (so the hand-off is).
//!
//! One test in this binary on purpose: the allocator is global.

use entropy_engine::audio::matter::kit::{stroke_for, KitHit, KitSpec, Piece, StrokeKind, PIECES};
use entropy_engine::audio::matter::rub::ToolSpec;
use entropy_engine::audio::matter::{Kit, KitCommand, KitVoice, MatterShared};
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

fn play(workers: usize) -> (f32, u64) {
    let shared = Arc::new(MatterShared::default());
    let kit = Kit::with_workers(KitSpec { brushes: true, ..KitSpec::default() }, 44_100.0, workers);
    let (mut voice, handle) = KitVoice::new(shared.clone(), kit);
    let done = Arc::new(AtomicBool::new(false));

    // The "UI" thread: a fill round the kit, loud enough to glide the toms and rattle the snare from
    // across the kit, a crash, the ride, a flam, then the mix and the sympathy switched.
    let sender = {
        let handle = handle.clone();
        let done = done.clone();
        std::thread::spawn(move || {
            let hits = [
                (Piece::Kick, 5.0),
                (Piece::Snare, 4.0),
                (Piece::RackTom, 6.0),
                (Piece::FloorTom, 7.0),
                (Piece::Crash, 5.0),
                (Piece::Ride, 3.0),
                (Piece::Snare, 0.5),
                (Piece::Snare, 3.0),
                (Piece::Splash, 4.0),
                (Piece::Kick, 6.0),
            ];
            for (k, &(piece, speed)) in hits.iter().enumerate() {
                let _ = handle.send(KitCommand::Strike(KitHit::at(piece, speed, 0.4)));
                if k == 6 {
                    let _ = handle.send(KitCommand::Mix([1.5; PIECES]));
                }
                if k == 8 {
                    let _ = handle.send(KitCommand::Sympathetic(false));
                }
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            // Brushes on the snare, a rod along the ride (another tool, fewer tips), a finger on the
            // floor tom, and a brush held on the rack tom and dragged, then lifted.
            let strokes = [
                (Piece::Snare, stroke_for(Piece::Snare, StrokeKind::Swirl, ToolSpec::brush(), 0.6, 0.8, 0.4)),
                (Piece::Snare, stroke_for(Piece::Snare, StrokeKind::Sweep, ToolSpec::brush(), 1.0, 1.2, 0.2)),
                (Piece::Ride, stroke_for(Piece::Ride, StrokeKind::Sweep, ToolSpec::rod(), 0.3, 3.0, 0.3)),
                (Piece::FloorTom, stroke_for(Piece::FloorTom, StrokeKind::Swirl, ToolSpec::finger(), 0.2, 2.0, 0.3)),
            ];
            for (piece, st) in strokes {
                let _ = handle.send(KitCommand::Strike(KitHit::stroke(piece, st)));
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            for k in 0..12 {
                let pressure = if k == 11 { 0.0 } else { 1.0 };
                let _ = handle.send(KitCommand::Hold { piece: Piece::RackTom, x: -0.06 + 0.01 * k as f32, y: 0.02, pressure });
                std::thread::sleep(std::time::Duration::from_millis(15));
            }
            done.store(true, Ordering::Relaxed);
        })
    };

    // Warm up a block so any lazily-initialised thread-local state exists before counting.
    let _ = voice.by_ref().take(256).count();
    ON_AUDIO_THREAD.with(|c| c.set(true));
    let mut frames = 0usize;
    let mut peak = 0.0f32;
    while frames < 44_100 * 2 * 3 {
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
    (peak, shared.version())
}

#[test]
fn a_live_kit_allocates_nothing_on_the_audio_thread() {
    for workers in [0, 2] {
        let (peak, version) = play(workers);
        assert!(peak > 0.01, "the kit should have sounded (peak {peak}, {workers} workers)");
        assert!(version > 10, "the kit should have published its state");
        assert_eq!(ALLOCS.load(Ordering::Relaxed), 0, "the audio thread allocated ({workers} workers)");
    }
}
