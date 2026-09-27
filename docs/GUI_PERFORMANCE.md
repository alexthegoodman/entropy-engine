# entropy_gui performance

How to measure `entropy_gui`'s per-frame cost, what the September 2026 profiling pass found, and
what is left. The reference workloads are CC Manager (a kanban board) and the DAW (control strip
plus the arrangement `TrackView`).

## Tools

### Headless benchmark: `gui_bench`

```bash
cargo run --release --bin gui_bench            # every scene
cargo run --release --bin gui_bench -- kanban  # scenes whose name contains "kanban"
```

This drives a plain `Context` through `Context::run` + `tessellate`, the same calls
`render_tabs` makes, with no window and no GPU. Scenes model CC Manager's board (20/100/400
cards), the DAW's tab (8x4, 16x8 and 32x16 tracks x clips) and a wall of labels. Each line gives
per-frame wall time (avg/p50/p95/max) and what the frame produced (draw calls, vertices, indices).
The geometry columns are a quick check that an optimization didn't change what gets drawn.

### In-app frame profiler: `ENTROPY_FRAME_PROFILE`

```bash
ENTROPY_FRAME_PROFILE=1 cargo run --release --bin example -- daw
```

Every `ENTROPY_FRAME_PROFILE_EVERY` frames (default 300) a table of per-phase times goes to
stderr (`src/core/frame_profile.rs`):

| phase | what it covers |
|---|---|
| `frame interval` | frame-to-frame time (vsync-bound when everything fits) |
| `acquire surface` | `get_current_texture` |
| `ui (js + layout)` | the whole `Context::run`: addon `onRender` JS plus widget layout/paint |
| `  ui onRender (js)` | the addon's `onRender` callbacks alone (a subset of the line above) |
| `ui upload` | draining the draw list and writing vertex/index buffers |
| `scene (addon update + 3d)` | `render_addon_frame` |
| `  addon update (js)` | addon `onUpdate` callbacks (a subset of the line above) |
| `ui draw + submit`, `present` | GPU submission and present |

Set `ENTROPY_FRAME_PROFILE_OUT=<file>` to also append each window as a JSON line, for comparing
runs. When the variable is unset, profiling costs one thread-local check per call site.

### CPU profiles with `perf`

Build with line tables, then record:

```bash
CARGO_PROFILE_RELEASE_DEBUG=line-tables-only cargo build --release --bin gui_bench
perf record -F 2000 --call-graph dwarf ./target/release/gui_bench kanban
perf report --no-children
```

Addon JS can be symbolized as well: `ENTROPY_V8_FLAGS=--perf-basic-prof` passes flags to V8
before the isolate starts, and V8 then writes the `/tmp/perf-<pid>.map` that `perf report` reads.

## What was fixed

Before the fix, `perf` put nearly all UI time in two places:

1. **Text shaping.** Every label, button and painted string went through a fresh fontdue
   `Layout` every frame, usually twice (`measure_text` to size, `Painter::text` to draw).
   Kanban's `wrap_text` also re-measured the growing line after each word, which is quadratic
   in word count and ran for every card twice a frame.
   - `text_layout::ShapeCache` now memoizes unwrapped shaping per `Context`, keyed by family,
     size and text (FxHash). Entries a frame didn't use are dropped at the start of the next.
   - `wrap_text` shapes the text once and wraps using each word's ink extent.
   - Kanban cards scrolled out of view are laid out and hit-tested but not painted.
2. **Tessellation.** Every rounded rect, circle and line segment went through lyon's
   general-purpose sweep-line fill tessellator. These shapes are all convex, so they are now
   triangle fans with mitered, centered strokes (`shape::convex_fill_and_stroke`, corners
   flattened to the same 0.1 px tolerance). Arbitrary `Shape::convex_polygon` fills still use
   lyon, because some callers pass outlines that aren't convex.

The wgpu backend also reuses its vertex/index staging `Vec`s between frames instead of
reallocating several MB each frame.

### Results

`gui_bench`, per-frame avg (4-core cloud VM):

| scene | before | after |
|---|---:|---:|
| CC Manager, 20 cards | 2.83 ms | 0.25 ms |
| CC Manager, 100 cards | 19.93 ms | 0.53 ms |
| CC Manager, 400 cards | 79.60 ms | 1.26 ms |
| DAW, 8 tracks x 4 clips | 3.49 ms | 0.61 ms |
| DAW, 16 x 8 | 5.89 ms | 1.01 ms |
| DAW, 32 x 16 | 11.86 ms | 1.86 ms |
| 500 labels | 3.04 ms | 0.84 ms |

Real app under `ENTROPY_FRAME_PROFILE` (Xvfb + lavapipe, same workloads before and after):

| | before | after |
|---|---:|---:|
| CC Manager, 100 cards: `ui (js + layout)` | 20.8 ms | 1.45 ms |
| CC Manager: frames rendered in 40 s | 850 (~21 fps) | 2200 (~55 fps, software-GPU bound) |
| DAW arrangement feature: UI layout + paint (Rust) | 4.3 ms | 1.8 ms |
| DAW: `ui onRender (js)` | ~1.5 ms | ~1.5-1.9 ms (unchanged, noise) |

## What's left

- **DAW `onRender` JS (~1.5-2 ms/frame)** is now the biggest UI cost. It's the addon rebuilding
  its widget list and crossing the op boundary for each widget. Run `perf` with
  `ENTROPY_V8_FLAGS=--perf-basic-prof` against a busy song to see which parts of
  `daw_synth_addon.ts` dominate.
- **Vertex size.** GUI vertices use the engine's 48-byte `Vertex` (a normal and z it never
  uses). A 20-byte GUI vertex (pos2, uv2, rgba8) would cut upload bandwidth by more than half.
  That needs its own shader layout, so it was left alone.
- **Per-shape allocation.** Each painted shape still allocates its own vertex/index `Vec`s
  before they're merged into the draw list. Tessellating straight into the draw list would
  remove that.
- **Draw-call count.** Flat fills (white texel) and text (glyph atlas) are separate textures,
  so a button is two draw calls, and each per-clip clip rect in `TrackView` starts a new batch.
  Putting a white texel in the glyph atlas would let fills and text batch together.
