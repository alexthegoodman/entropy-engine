//! Real-time safety: a wavetable voice allocates nothing while it sounds, even while another thread
//! sculpts the very table it is reading. A counting global allocator watches only the thread that
//! plays the voices (the stand-in for the audio thread), so the sculpting thread's own allocations
//! (rebuilding band limits, undo snapshots) are free to happen, and the test proves that they do not
//! leak into the audio path or make it wait.
//!
//! One test in this binary on purpose: the allocator is global.

use entropy_engine::audio::wavetable::{BrushTool, Stamp, Wavetable, WavetableParams, WavetableVoice};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

thread_local! {
    // `const` so reading it from inside the allocator never allocates.
    static ON_AUDIO_THREAD: Cell<bool> = const { Cell::new(false) };
}

struct Counting;

static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);

fn count(size: usize) {
    if ON_AUDIO_THREAD.try_with(|c| c.get()).unwrap_or(false) {
        ALLOCS.fetch_add(1, Ordering::Relaxed);
        BYTES.fetch_add(size, Ordering::Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static A: Counting = Counting;

#[test]
fn a_sounding_voice_allocates_nothing_while_the_table_is_sculpted() {
    let mut table = Wavetable::new(32);
    table.load_preset("terrain");
    let shared = table.shared();
    let table = Arc::new(Mutex::new(table));

    // A spread of voices: unison from 1 to 7, gated and timed, low and high.
    let gates: Vec<Arc<AtomicBool>> = (0..8).map(|_| Arc::new(AtomicBool::new(true))).collect();
    let mut voices: Vec<WavetableVoice> = (0..8)
        .map(|i| {
            let mut p = WavetableParams::default();
            p.freq = 55.0 * 2f32.powf(i as f32 * 0.9);
            p.unison = 1 + (i as u8 % 7);
            p.position = i as f32 / 8.0;
            p.lfo_rate = 0.5 + i as f32;
            p.lfo_depth = 0.6;
            p.cutoff = if i % 2 == 0 { 20_000.0 } else { 1800.0 };
            p.duration = 30.0;
            WavetableVoice::new(shared.clone(), p, if i % 2 == 0 { Some(gates[i].clone()) } else { None })
        })
        .collect();

    // The other thread sculpts continuously: dabs and commits, the way a pen stroke does.
    let stop = Arc::new(AtomicBool::new(false));
    let editor = {
        let (table, stop) = (table.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut n = 0u32;
            while !stop.load(Ordering::Relaxed) {
                let mut t = table.lock().unwrap();
                let tool = [BrushTool::Raise, BrushTool::Lower, BrushTool::Smooth, BrushTool::Level][(n % 4) as usize];
                let mut s = Stamp::new(tool, (n % 32) as f32, (n as f32 * 0.137) % 1.0);
                s.radius = 0.2;
                s.amount = 0.4;
                if let Some((a, b)) = t.stamp(&s) {
                    t.commit(a, b);
                }
                n += 1;
            }
            n
        })
    };

    // Five seconds of every voice, in 128-frame callbacks, with a gate flipped along the way.
    let frames_per_callback = 128;
    let callbacks = 44_100 * 5 / frames_per_callback;
    let mut finite = true;
    let mut peak = 0.0f32;
    ALLOCS.store(0, Ordering::SeqCst);
    BYTES.store(0, Ordering::SeqCst);
    ON_AUDIO_THREAD.with(|c| c.set(true));
    for cb in 0..callbacks {
        if cb == callbacks / 2 {
            gates[0].store(false, Ordering::Relaxed);
        }
        for v in voices.iter_mut() {
            for _ in 0..frames_per_callback * 2 {
                if let Some(x) = v.next() {
                    finite &= x.is_finite();
                    peak = peak.max(x.abs());
                }
            }
        }
    }
    ON_AUDIO_THREAD.with(|c| c.set(false));
    stop.store(true, Ordering::Relaxed);
    let edits = editor.join().unwrap();

    let (allocs, bytes) = (ALLOCS.load(Ordering::SeqCst), BYTES.load(Ordering::SeqCst));
    println!("{} voices for 5 s while another thread made {edits} edits: {allocs} allocations ({bytes} bytes) on the audio thread, peak {peak:.3}", voices.len());
    assert!(edits > 50, "the sculpting thread made only {edits} edits, so the check proves little");
    assert!(finite, "a voice produced a NaN or infinity while the table was being edited");
    assert!(peak < 4.0, "a voice reached {peak} while the table was being edited");
    assert!(peak > 0.05, "the voices were nearly silent, so the check proves little");
    assert_eq!(allocs, 0, "{allocs} allocations ({bytes} bytes) on the audio path");
}
