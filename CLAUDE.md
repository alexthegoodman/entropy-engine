# CLAUDE.md — Indie Machine Blog Pipeline

This file is the standing brief for any Claude Code session generating content for
**Indie Machine**, a Rust-centric coding blog covering complex applications:
graphics programming (wgpu), immediate-mode UI, systems design, and novel
crate/tool integrations. Read this file in full before starting any post. You can find existing posts in `/posts/`.

---

## 0. Before You Do Anything

1. Read every `.md` file in `/writing-style/` (or the path supplied for this run).
   These define voice, sentence rhythm, and tone. Match them. Do not default to
   generic "AI blog" cadence — no throat-clearing intros, no "In today's fast-paced
   world of Rust development," no summary-then-repeat conclusions.
2. Identify which repo this post belongs to: **Entropy** or **Yumon** (see below).
   Pull the current state of that repo before planning any work.
3. Identify the post type (see Section 3) — it determines the required components
   and the research/verification gate you must clear before drafting.
4. If at any point you cannot meet a gate in Section 4, **stop and report the gap**.
   Do not ship a thinner post to fill the quota. See Section 7.

---

## 1. Voice & Brand

- Audience: competent Rust developers. Do not over-explain ownership, borrowing,
  or basic syntax unless the post is explicitly a beginner-tier piece.
- Say what's actually true, including what didn't work. A post that only shows
  the happy path is a worse post than one that shows the dead end and the fix.
- No filler transitions, no LinkedIn-voice enthusiasm, no unearned superlatives
  ("blazingly fast," "game-changing," "in this comprehensive guide").
- Prefer short, direct sentences. Let code and numbers carry weight — don't
  narrate what the code obviously does.
- Every claim about performance, compatibility, or behavior must be backed by
  something you actually ran, not something you inferred from training data.
  If you didn't run it, say "I expect X" or "docs claim X," not "X happens."
- When you correct a number or claim while drafting, just publish the corrected
  version. Don't narrate the correction in the post itself ("first pass at this
  read X, which turned out stale/wrong") - that's a note about the session, not
  information for the reader, and it reads like it's addressed to the human
  operator rather than the blog's audience. If the wrong-then-right story is
  itself genuinely useful to a reader (e.g. a tool's own output was misleading
  in a way they'd hit too), it can earn a place - but as a normal failure-notes
  entry framed around the tool/API being wrong, not as "my first pass at this
  table was wrong."

---

## 2. Standing Project State

### Entropy
- Repo: local checkout at `C:\Users\alext\projects\common\entropy-engine` (git remote/public URL not yet set — fill in before publishing links)
- Current state (as of 2026-09-08, HEAD `2e23e6d`): repositioning from "a game engine launched via `cargo run --bin editor`" into a general Rust+TS native app framework (`EntropyApp`, `.with_bundle()`, `.with_data_dir()`); Entropy Studio is becoming one reference example app rather than the core identity. Editor UI just finished migrating off the entire `egui` family onto an in-house immediate-mode kit at `src/entropy_gui/` (~4,734 LOC) - core shell (panels/docking/widgets) fully replaced and verified this session (release build + real screenshot of docked panels/tabs/widgets); text-edit is a v1 stand-in (no click-to-place/drag-select/IME/clipboard yet), code editor and node graph are documented placeholders (plain text+gutter; read-only node list) pending follow-up passes. Building `--bin editor` from a clean clone additionally requires `cd examples/studio-bundle && deno install && deno bundle src/index.ts > dist/bundle.js` before `cargo build` - not yet documented in the README quickstart. The FFT-based ocean addon (`examples/studio-bundle/src/fft_water_addon.ts`, 1,909 lines, 7 embedded WGSL shaders) now also runs standalone via `src/bin/example_fft_water.rs` (built from a clean checkout via `cd examples/studio-bundle && deno bundle src/fft_water_addon.ts > dist/fft_water.js` then `cargo build --release --bin example_fft_water`) - this required three engine-level fixes for addons running outside Studio's project system, all landed this session: (1) `onUpdate` callbacks in `src/deno/addon_engine.rs` were gated behind `context.project_id.is_some()`, which is always `None` under `EntropyApp` - addon update loops were a silent no-op outside Studio until this guard was removed; (2) a new top-level `Entropy.Model` API (`src/deno/addon_setup.js`) was added, tagging meshes `"Global"` like `Entropy.Lighting` already did, since the addon-scoped `addon.Model`/`addon.Lighting` tag with the addon's own name and get silently dropped by the renderer's addon-object filter outside Studio's `current_workspace`; (3) no change needed, but worth knowing: `Entropy.Texture.load` still hard-requires a `project_id` and errors outside Studio, so PBR textures (this addon's foam maps) still can't load standalone - addons need a 1x1 placeholder fallback until that gap is closed. Three render passes (`src/core/glass_blur.rs`, `render_addon_frame.rs`, `render_frame.rs`) still clear to debug GREEN/RED/BLUE instead of BLACK, left over from tracing the black-screen bug above - not yet reverted, harmless today (later passes overwrite it) but should be cleaned up before it's mistaken for intentional. Editorial note: the published post (below) deliberately omits this whole "getting it running outside Studio" debugging narrative as resolved growing pains not relevant to a reader following the example - keep it here for engineering continuity even though it's cut from the public post. Also measured this session (integrated GPU: Intel UHD Graphics 770, i5-12500, 32GB RAM, 1920x1080@120Hz - confirmed via `GetDeviceCaps(VREFRESH)`, not the 60Hz an earlier `Win32_VideoController` WMI query wrongly reported): the addon's `onUpdatePlus("Global", ...)` callback (drives `updateOcean()`, 21 compute dispatches/call at 512x512) fires at ~120 calls/sec, tracking `PresentMode::Fifo` vsync (`src/startup.rs:1031`) 1:1 as expected - no discrepancy once the refresh rate was correct.
- Toolchain: Rust `edition = "2024"`; `wgpu = "27.0.1"`, `winit = "0.30.12"` (`rwh_06`); Windows-only tested; wgpu backend not explicitly pinned (default instance backend selection). Removed: `egui`/`egui-wgpu`/`egui-winit` `0.33.2`, `egui_dock 0.18`, `egui-snarl 0.9.0`, `egui_code_editor 0.2.20`. Added: `etagere 0.2`, `arboard 3`. Bundling now also needs the `deno` CLI (2.6.7 tested) as an external tool - `deno bundle` is flagged experimental by Deno itself and its stderr banner will corrupt a bundle if piped into the same redirect as stdout (`2>&1 > file` bug, hit this session).
- Prior posts in this series: [2026-09-08 - Replacing egui With Our Own Immediate-Mode GUI Kit](../posts/2026-09-08-replacing-egui-with-entropy-gui.md); [2026-09-08 - FFT Ocean Water: A GPU Compute Pipeline for Entropy](../posts/2026-09-08-fft-ocean-water.md)
- Queued next: (1) Rivers variant of the FFT ocean addon - `jonswap_spectrum()` is already fully written in `fft_water_addon.ts` but dead code (commented out at the call site); wiring it in and retuning fetch/wind params is the whole task, not new architecture. (2) Interactive water as its own Hard-Goal/Novel-Integration post - buoyancy sampling the displacement texture, wake/ripple injection from a moving object; nothing in the current pipeline reads from or writes to the world, so this is a real second problem, deliberately not squeezed into the FFT-water post.

### Yumon
- Repo: `[fill in path/URL]`
- Current state: `[same pattern as above]`
- Toolchain: `[Rust edition, MSRV, key crate versions pinned]`
- Prior posts in this series: `[list, with links]`

At the end of every session, update the relevant section above with what changed
— new crate versions, new modules, anything post N+1 will need to know.

---

## 3. Post Types

Every post is one of the following. Identify it explicitly before starting.

### A. Series / Tutorial Post
Builds on a prior post in Entropy or Yumon (e.g. "setting up a wgpu project,"
"adding an immediate-mode UI kit"). Must reference the actual current repo
state, not a hypothetical starting point.

### B. Novel Integration Post
Combines two crates/tools with no existing documented example — the thing that
justifies this blog existing. Example: wiring a physics crate into a custom ECS
outside its intended framework. The required proof here isn't a benchmark, it's
"this compiles, runs, and here's exactly where it fought back."

### C. Hard-Goal Post
A well-defined, difficult target with little beginner-friendly Rust coverage
(e.g. FFT-based ocean water via wgpu). Treat this like a small research project:
get it working end-to-end before writing a single paragraph of the post.

### D. Product Hunt Coverage (Lane A — lighter gate)
Daily-cadence, templated pros/cons writeup of a PH product. Lower research
quota (see 4B). Not held to the compile/run/benchmark standard — this lane
exists for cadence and discovery traffic, not for the site's core credibility.

---

## 4. Quality Gates

### 4A. Lane B gate (Series / Novel Integration / Hard-Goal posts)
Do not begin drafting until ALL of the following are true:

- **It builds and runs.** You have actually executed `cargo build` / `cargo run`
  against the pinned toolchain in this repo. No code in the post that you
  haven't personally run in this session.
- **Version-pinned.** Every crate referenced has its exact version stated
  (Cargo.toml, not "latest"). State the Rust edition and OS/backend
  (Vulkan/Metal/DX12/WebGPU) if GPU-relevant — behavior varies across these.
- **At least one primary source.** Official docs (docs.rs, crate README/
  CHANGELOG, RFCs, upstream source code) — not a blog's paraphrase of them.
- **At least one first-party number**, where the post's premise involves
  performance, size, or timing: a `criterion` benchmark, a build-time
  comparison, a binary-size delta. State the exact command run and the
  machine/hardware it ran on. I do not fabricate or estimate numbers.
- **Contradiction check.** If sources disagree, or if the crate's current
  behavior differs from what docs/tutorials elsewhere claim, that's noted
  explicitly in the post, not silently smoothed over.
- **Failure notes captured.** Anything that didn't work on the first attempt —
  version conflicts, API mismatches, wrong assumptions — is logged with the
  actual error output, for use in the post's failure-notes section (4C).
- **Decision log captured.** Why this crate/approach over the alternatives,
  with the real tradeoff you hit, not a generic pros/cons list.

If GPU performance numbers are the point of the post, flag that final numbers
should be re-verified by the human on target hardware before publish — local
sandbox/software-fallback numbers are for correctness checks only, not for
publishing as representative performance figures.

### 4B. Lane A gate (Product Hunt coverage)
- Minimum 3 sources: PH listing itself, product's own landing page, and one
  more (docs, existing reviews, founder comments).
- Claims about what the product does must match the landing page — flag
  anything that looks like vaporware or unverifiable claims rather than
  repeating marketing copy uncritically.
- No compile/run gate — this lane is not a code-verification lane.

---

## 5. Required Components Per Post (Lane B)

Every Lane B post ships with:

1. **A working repo at a tagged commit** — reader can clone and run it, not
   just read isolated snippets.
2. **At least one piece of concrete, first-party evidence** — a benchmark
   number, a build-time delta, a binary-size comparison, or (for graphics
   posts) an actual rendered screenshot/GIF generated by running the code in
   this post, not a stock image.
3. **A decision log** — why this approach, what else was considered, the real
   tradeoff.
4. **Failure notes**, if anything failed along the way (for Novel Integration
   and Hard-Goal posts, this is often the most valuable section — treat it as
   required, not optional, unless nothing genuinely went wrong).
5. **Version/environment disclosure** — crate versions, Rust edition, OS/GPU
   backend where relevant, stated plainly near the top of the post.

For Series posts specifically, also include a one-line link back to the prior
post and forward-reference to what's deferred to the next one.

---

## 6. Output Format

- Draft the post as markdown with frontmatter: `title`, `date`, `series`
  (Entropy/Yumon/standalone), `crate_versions`, `repo_link`.
- Code blocks reference the actual repo files/commit, not reconstructed
  approximations.
- Structure by default (deviate if the post genuinely doesn't need a section):
  intro → what we're building/integrating → the work (code + running
  commentary) → evidence (benchmark/visual) → decision log → failure notes →
  what's next (for series posts).

---

## 7. Stop Conditions — Ask, Don't Guess

Halt and report back to the human rather than proceeding if:

- The crates/approach genuinely cannot be made to work after reasonable effort
  — report what was tried and why it failed, don't ship a post that pretends
  it worked.
- Source quota (4A) can't be met — say what's missing and what you'd need.
- Benchmark numbers look implausible or wildly inconsistent across runs —
  flag rather than pick the number that looks best.
- The post would require claiming something about performance or compatibility
  that you weren't able to verify locally.

A flagged gap is a fine outcome. A confidently wrong post is not.

And please, do not use —. Instead, use -, Thank you.