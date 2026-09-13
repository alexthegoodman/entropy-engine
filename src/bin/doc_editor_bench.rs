//! Headless benchmark for `entropy_gui::widgets_doc_editor` - exercises the exact same
//! `DocEditorState` methods the live widget calls (no window, no wgpu; `shape_text` only
//! needs an `entropy_gui::Context` for its `FontRegistry`, which loads fine off-screen).
//!
//! Two things are measured:
//! 1. Per-keystroke cost (`insert_char` + `ensure_all_layout` + `paginate`, the same three
//!    calls `DocEditor::show` makes every frame) at increasing document sizes, typing into a
//!    paragraph near the middle of the document each time. The claim under test: this cost is
//!    flat with total document size, because reshaping is per-paragraph (invalidated only for
//!    the edited paragraph) and pagination is O(total lines) pure arithmetic over already-
//!    cached line counts, not O(total lines) of fontdue shaping.
//! 2. Per-keystroke cost as a function of the EDITED PARAGRAPH's own length, since reshaping
//!    is per-paragraph, not per-line - a keystroke in a very long single paragraph reshapes
//!    all of it. This is the documented v1 limitation, measured rather than asserted.
//!
//! Run with `cargo run --release --bin doc_editor_bench` - release matters, fontdue shaping
//! in a debug build is meaningfully slower and not representative.

use entropy_engine::entropy_gui::{Context, DocEditorState, PageConfig};
use std::time::Instant;

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (((sorted.len() - 1) as f64) * p).round() as usize;
    sorted[idx]
}

fn stats_line(label: &str, mut times_ms: Vec<f64>) {
    times_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let sum: f64 = times_ms.iter().sum();
    let avg = sum / times_ms.len() as f64;
    println!(
        "{label:<48} avg {avg:>8.4} ms  p50 {:>8.4}  p95 {:>8.4}  p99 {:>8.4}  max {:>8.4}",
        percentile(&times_ms, 0.50),
        percentile(&times_ms, 0.95),
        percentile(&times_ms, 0.99),
        times_ms.last().copied().unwrap_or(0.0),
    );
}

/// Times `keystrokes` sequential single-character insertions at the end of the paragraph at
/// `paragraph_count / 2`, each followed by the same reshape+paginate pass the live widget runs
/// every frame after a keystroke. Returns one wall-clock duration (ms) per keystroke.
fn bench_typing(ctx: &Context, page: PageConfig, paragraph_count: usize, keystrokes: usize) -> Vec<f64> {
    let mut state = DocEditorState::new();
    state.seed_sample(paragraph_count);
    state.ensure_all_layout(ctx, page);
    let _ = state.paginate(page);

    let target = paragraph_count / 2;
    state.set_cursor(target, usize::MAX);

    let mut times = Vec::with_capacity(keystrokes);
    for i in 0..keystrokes {
        let ch = if i % 8 == 7 { ' ' } else { (b'a' + (i % 26) as u8) as char };
        let t0 = Instant::now();
        state.insert_char(ch);
        state.ensure_all_layout(ctx, page);
        let pages = state.paginate(page);
        let dt_ms = t0.elapsed().as_secs_f64() * 1000.0;
        times.push(dt_ms);
        std::hint::black_box(pages.len());
    }
    times
}

/// Times `keystrokes` insertions all into ONE paragraph that is pre-grown to `paragraph_len`
/// characters before any timing starts - isolates the "reshape cost scales with the edited
/// paragraph's own length" claim from document-size effects.
fn bench_long_paragraph(ctx: &Context, page: PageConfig, paragraph_len: usize, keystrokes: usize) -> Vec<f64> {
    let mut state = DocEditorState::new();
    state.seed_sample(1);
    state.set_cursor(0, usize::MAX);
    let mut i = 0usize;
    while state.char_count() < paragraph_len {
        let ch = if i % 8 == 7 { ' ' } else { (b'a' + (i % 26) as u8) as char };
        state.insert_char(ch);
        i += 1;
    }
    state.ensure_all_layout(ctx, page);

    let mut times = Vec::with_capacity(keystrokes);
    for j in 0..keystrokes {
        let ch = if j % 8 == 7 { ' ' } else { (b'a' + (j % 26) as u8) as char };
        let t0 = Instant::now();
        state.insert_char(ch);
        state.ensure_all_layout(ctx, page);
        let pages = state.paginate(page);
        let dt_ms = t0.elapsed().as_secs_f64() * 1000.0;
        times.push(dt_ms);
        std::hint::black_box(pages.len());
    }
    times
}

fn main() {
    let ctx = Context::default();
    let page = PageConfig::us_letter();

    println!("=== Per-keystroke cost vs. total document size (typing at the midpoint paragraph) ===");
    for &paragraph_count in &[1usize, 10, 50, 150, 300, 600] {
        let mut probe = DocEditorState::new();
        probe.seed_sample(paragraph_count);
        probe.ensure_all_layout(&ctx, page);
        let pages = probe.paginate(page);
        let times = bench_typing(&ctx, page, paragraph_count, 300);
        stats_line(&format!("{paragraph_count:>4} paragraphs ({:>3} pages, {:>6} words):", pages.len(), probe.word_count()), times);
    }

    println!();
    println!("=== Per-keystroke cost vs. the EDITED paragraph's own length (single paragraph doc) ===");
    for &plen in &[100usize, 1_000, 5_000, 20_000] {
        let times = bench_long_paragraph(&ctx, page, plen, 150);
        stats_line(&format!("paragraph ~{plen:>6} chars:"), times);
    }

    println!();
    println!("=== Paginate-only cost at a large document (no edits, cache fully warm) ===");
    let mut big = DocEditorState::new();
    big.seed_sample(600);
    big.ensure_all_layout(&ctx, page);
    let mut times = Vec::with_capacity(200);
    for _ in 0..200 {
        let t0 = Instant::now();
        let pages = big.paginate(page);
        let dt_ms = t0.elapsed().as_secs_f64() * 1000.0;
        times.push(dt_ms);
        std::hint::black_box(pages.len());
    }
    stats_line("paginate() over 600 paragraphs:", times);
}
