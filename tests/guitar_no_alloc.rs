//! Real-time safety (spec 4.12, 5.2): the engine allocates nothing after construction. A counting
//! global allocator watches every allocation made while `GuitarEngine::process` and `release_all`
//! run over ten seconds of notes, bends, noise and slaps.
//!
//! One test in this binary on purpose: the allocator is global, so a second test running on another
//! thread would count its own allocations here.

use entropy_engine::guitar::testsig::{self, Motion, Pluck};
use entropy_engine::guitar::{GuitarConfig, GuitarEngine, GuitarEvent, Mode, Polyphony, STANDARD_TUNING};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;

// Only the thread running the engine is watched: the test harness allocates on its own threads (its
// "running for over 60 seconds" notice, for one), and that is not the audio path.
thread_local! {
    static WATCHING: Cell<bool> = const { Cell::new(false) };
}
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if WATCHING.with(|w| w.get()) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        if WATCHING.with(|w| w.get()) {
            ALLOCS.fetch_add(1, Ordering::Relaxed);
            BYTES.fetch_add(new_size, Ordering::Relaxed);
        }
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static A: Counting = Counting;

#[test]
fn process_allocates_nothing() {
    for (mode, polyphony) in Mode::ALL.into_iter().flat_map(|m| [(m, Polyphony::Mono), (m, Polyphony::Poly)]) {
        let cfg = GuitarConfig::default().with_mode(mode).with_polyphony(polyphony);
        let mut plucks: Vec<Pluck> = (0..30)
            .map(|i| {
                let p = Pluck::note(40 + (i * 5) % 44).starting(0.2 + i as f32 * 0.3).loud(-16.0).seeded(i as u32 + 1);
                match i % 4 {
                    0 => p.moving(Motion::Vibrato { depth_cents: 40.0, rate_hz: 6.0, delay_s: 0.1 }),
                    1 => p.moving(Motion::Bend { cents: 150.0, start_s: 0.1, dur_s: 0.2 }),
                    2 => p.moving(Motion::Slide { semitones: 4.0, start_s: 0.1, dur_s: 0.2 }),
                    _ => p.ringing(0.25),
                }
            })
            .collect();
        // Chords, for the polyphonic engine's worst case: six strings to find at once.
        for (i, (_, shape)) in testsig::CHORD_SHAPES.iter().take(8).enumerate() {
            plucks.extend(testsig::strum(&testsig::shape_notes(shape, &STANDARD_TUNING), 0.35 + i as f32 * 1.2, 25.0, -18.0, true, i as u32 + 1));
        }
        let (mut x, _) = testsig::mix(cfg.sample_rate, 10.0, &plucks);
        testsig::add_hum(&mut x, cfg.sample_rate, 60.0, -50.0);
        testsig::add_noise(&mut x, -60.0, 3);
        testsig::add_slap(&mut x, cfg.sample_rate, 3.3, -6.0, 15.0, 8);

        let mut engine = GuitarEngine::new(cfg);
        // The sink is preallocated the way the audio thread's queue producer is: capacity up front.
        let mut events: Vec<GuitarEvent> = Vec::with_capacity(100_000);

        ALLOCS.store(0, Ordering::SeqCst);
        BYTES.store(0, Ordering::SeqCst);
        WATCHING.with(|w| w.set(true));
        for chunk in x.chunks(128) {
            engine.process(chunk, &mut events);
        }
        engine.release_all(&mut events);
        WATCHING.with(|w| w.set(false));

        let (allocs, bytes) = (ALLOCS.load(Ordering::SeqCst), BYTES.load(Ordering::SeqCst));
        println!("{} {}: {} events, {allocs} allocations ({bytes} bytes) in process", mode.name(), polyphony.name(), events.len());
        assert!(events.len() > 20, "the engine produced almost nothing, so the check proves little");
        assert_eq!(allocs, 0, "{allocs} allocations ({bytes} bytes) on the audio path in {} {} mode", mode.name(), polyphony.name());
    }
}
