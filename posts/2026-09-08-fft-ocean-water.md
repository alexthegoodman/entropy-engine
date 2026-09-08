---
title: "FFT Ocean Water: A GPU Compute Pipeline for Entropy"
date: 2026-09-08
series: Entropy
crate_versions:
  unchanged:
    - wgpu = "27.0.1"
    - winit = "0.30.12"
    - deno_core = "0.332.0"
  edition: "2024"
  os: "Windows 11 (only platform currently tested)"
  backend: "wgpu default instance backend selection (not explicitly pinned to Vulkan/DX12)"
  tooling:
    - "deno 2.6.7 CLI (bundling the addon's TypeScript to JS; not a Cargo dependency)"
repo_link: entropy-engine @ 2e23e6d
---

Entropy Studio's example bundle has an FFT ocean addon: a Phillips-spectrum height field, evolved in the frequency domain and brought back to real space with a GPU-side Cooley-Tukey FFT, textured onto a displaced mesh with foam and capillary glints. All of it lives in one file, `examples/studio-bundle/src/fft_water_addon.ts`, 1,909 lines of TypeScript holding both the addon logic and seven embedded WGSL shaders. This post covers how that pipeline is built, and measures it running standalone through `src/bin/example_fft_water.rs` - the reference example for running one of these addons outside Entropy Studio entirely.

## What's actually being computed

The classic approach here - Tessendorf's statistical ocean model - starts from a Phillips spectrum: a function of wave vector `k` that says how much energy the ocean surface carries at that spatial frequency, given wind speed and direction. `SPECTRUM_INIT_SHADER` computes it once at startup:

```wgsl
// src/fft_water_addon.ts - phillips_spectrum, inside SPECTRUM_INIT_SHADER
fn phillips_spectrum(k: vec2<f32>) -> f32 {
    let k_length = length(k);
    if (k_length < 0.0001) {
        return 0.0;
    }

    let L = (params.wind_speed * params.wind_speed) / params.gravity;
    let k_length2 = k_length * k_length;
    let k_length4 = k_length2 * k_length2;

    let wind_dir = normalize(vec2<f32>(params.wind_direction_x, params.wind_direction_y));
    let k_normalized = k / k_length;
    let k_dot_w = dot(k_normalized, wind_dir);
    let k_dot_w2 = k_dot_w * k_dot_w;

    let damping = 0.001;
    let l2 = L * L * damping * damping;

    let phillips = params.amplitude *
                   exp(-1.0 / (k_length2 * L * L)) / k_length4 *
                   k_dot_w2 *
                   exp(-k_length2 * l2);

    return phillips;
}
```

Each texel of a 512x512 `rgba16float` storage texture holds one wave vector's initial complex amplitude `H0(k)`, built from that spectrum value and a Box-Muller Gaussian pair (`gaussian_random`), packed alongside its conjugate `H0*(-k)` so the eventual inverse FFT comes out real-valued.

`SPECTRUM_UPDATE_SHADER` runs every frame and rotates each `H0(k)` forward in time using the deep-water dispersion relation `omega = sqrt(g * |k|)`:

```wgsl
// src/fft_water_addon.ts - inside SPECTRUM_UPDATE_SHADER
let angular_frequency = sqrt(params.gravity * wave_number);
let phase_angle   = angular_frequency * params.time;
let phasor_forward  = vec2<f32>( cos(phase_angle), sin(phase_angle));
let phasor_backward = vec2<f32>( cos(phase_angle), -sin(phase_angle));

let animated_height_spectrum = complex_multiply(h0_k, phasor_forward)
                             + complex_multiply(h0_minus_k_conj, phasor_backward);
```

That same pass also derives `Dx`/`Dz` - horizontal (Gerstner-style) displacement spectra - by rotating the height spectrum by `-i * (k/|k|)`, which is what gives the surface its "choppy," peaked-crest look instead of pure sine-wave bumps.

From there it's a real 2D inverse FFT: `FFT_HORIZONTAL_SHADER` and `FFT_VERTICAL_SHADER` each run `log2(N)` Cooley-Tukey butterfly stages (bit-reversal on stage 0, twiddle-factor complex multiply-add after), ping-ponging between two textures. `DISPLACEMENT_SHADER` normalizes the FFT output by `N`, applies the checkerboard sign correction FFT-based ocean sims need, and writes out final vertex displacement plus a Jacobian-derived foam mask - the determinant of the horizontal displacement gradient goes negative where the surface folds over itself, which is a legitimate wave-breaking signal, not a hack.

At resolution 512, that's `log2(512) = 9` butterfly stages per direction - 18 FFT dispatches - plus one spectrum-update, one displacement, and one glint-noise dispatch: 21 compute dispatches per invocation of `updateOcean()`, each covering a `64x64` workgroup grid at `8x8` threads per group (262,144 invocations per dispatch, matching the 512x512 texel grid exactly). That count comes straight from reading the dispatch loop; see Evidence below for how often `updateOcean()` actually fires, measured this session.

## Running it standalone

`src/bin/example_fft_water.rs` is the entire standalone entry point:

```rust
#[cfg(target_os = "windows")]
use entropy_engine::startup;

#[tokio::main]
async fn main() {
    #[cfg(target_os = "windows")]
    entropy_engine::EntropyApp::new()
        .with_bundle("examples/studio-bundle/dist/fft_water.js")
        .run()
        .expect("Couldn't run app");
}
```

That `.with_bundle()` call is the whole point of Entropy's ongoing repositioning away from "a game engine you launch via `cargo run --bin editor`" - a JS addon written for Studio's project system should still run on its own, pointed at nothing but a compiled bundle. The engine-level work that makes that true for this addon - a couple of APIs that needed to exist at the top level rather than only addon-scoped - is covered in the decision log below; none of it is something a reader following this example needs to redo.

Building it from a clean checkout needs the addon bundled first - this example has its own npm script rather than the general one documented in the CLAUDE.md quickstart:

```
cd examples/studio-bundle
deno bundle src/fft_water_addon.ts > dist/fft_water.js
cargo build --release --bin example_fft_water
./target/release/example_fft_water.exe
```

## Evidence

I ran this exact sequence this session: rebuilt the bundle, built `--bin example_fft_water --release` (finished in under a second - nothing in the Rust side had changed since the last build at this commit), launched the binary, let the ocean animate for several seconds, and screenshotted the live window - not a mockup, not a render from a script:

![FFT ocean rendering displaced, choppy waves with capillary glints and the addon's live parameter UI, screenshotted from the running window this session](images/fft-water-ocean-glints.png)

**Test hardware**, this machine, this session:

| | |
|---|---|
| GPU | Intel(R) UHD Graphics 770 (integrated, driver 32.0.101.7085) |
| CPU | 12th Gen Intel(R) Core(TM) i5-12500, 6 cores / 12 threads |
| RAM | 32 GB |
| Display | 1920x1080 @ 120 Hz |
| OS | Windows 11 Pro (64-bit), build 10.0.26200 |

This is integrated graphics, not a discrete GPU - worth keeping in mind for every number below, and worth re-verifying on other hardware before treating any of it as representative.

**Measured update-loop rate.** `fft_water_addon.ts` already had a per-call debug print at its `onUpdatePlus("Global", ...)` registration (the callback that drives `updateOcean()` - and, per the code comment there, the one that actually fires under a bare `EntropyApp`, since `current_addon_name` defaults to `"Global"` outside Studio), just commented out. I uncommented it, rebuilt only the JS bundle (no Rust rebuild needed - the addon loads at runtime), ran the binary, and counted lines against wall-clock time over an 18.38s window after a 5s warm-up:

- 2,206 `updateOcean()` invocations in 18.38 seconds -> **~120 calls/sec**.

That lines up exactly with this display's 120 Hz refresh - wgpu's swapchain is configured with `PresentMode::Fifo` (`src/startup.rs:1031`), which caps presentation to vsync, and the update loop is tracking it 1:1. After measuring, I reverted the debug print and rebuilt the bundle back to the clean, committed state - `git status` on `fft_water_addon.ts` confirms no diff.

First-party numbers, all pulled from this repo and this session directly:

- **Addon size**: 1,909 lines in `fft_water_addon.ts` (`wc -l`), holding both the TypeScript addon logic and 7 embedded WGSL shader sources.
- **Example entry point**: 11 lines (`src/bin/example_fft_water.rs`).
- **Binary**: 74,707,968 bytes (71.24 MiB) release `example_fft_water.exe`, this session, this machine - close to the 71.25 MiB `editor.exe` from the previous post, which tracks: both binaries link the same engine.
- **Compute cost per update**: 21 dispatches at 512x512 resolution (18 FFT butterfly passes + spectrum update + displacement + glint noise), 262,144 shader invocations each - so, at the measured ~120 calls/sec, on the order of 2,520 compute dispatches/sec and roughly 660M shader invocations/sec sustained on integrated graphics. That multiplication is arithmetic on top of a measured number, not a second measurement - it is not a substitute for an actual GPU-timestamp profile, which this session doesn't have.

## Decision log

- **Phillips spectrum is live, JONSWAP is written but dead code.** `SPECTRUM_INIT_SHADER` defines a full `jonswap_spectrum()` function - peak-enhanced Pierson-Moskowitz with directional spreading - right next to `phillips_spectrum()`, but the call site has it commented out: `// let ph = jonswap_spectrum(k); // better at higher wind speeds, maybe for rivers`. Phillips is what actually runs today. This is the concrete shape of the "rivers" addon queued as this series' next post - not a new file, but flipping one commented-out line and re-tuning the wind/fetch parameters for a narrower, faster-moving body of water.
- **`Entropy.UI.createWindow` over `addon.UI.createTab`.** `addon.UI.createTab` fills the entire window with an opaque panel - correct inside Studio, where it docks into one pane of the existing chrome, but there's no docking host under a bare `EntropyApp`. A floating window (visible in the screenshot above) leaves the ocean visible behind it regardless of host.
- **`Entropy.Lighting`/`Entropy.Model` (global-tagged) over the addon-scoped `addon.Lighting`/`addon.Model`.** The scoped APIs tag lights and meshes with the registering addon's own name, which only renders while Studio's chrome has that addon's tab focused - state a bare `EntropyApp` embed never sets. The top-level `Entropy.*` variants tag as `"Global"` instead, which always renders regardless of host. `Entropy.Model` didn't exist as a top-level API before this addon needed it; it's a minimal addition (just the two ops `createWaterMesh` needs), added alongside `Entropy.Lighting`, which already worked this way.

## Failure notes

- **Foam PBR textures don't load outside a Studio project**, and this one is a live limitation, not something routed around. `Entropy.Texture.load` reads from a per-project `textures/` directory and errors "Project id not set" without a `project_id`, which `EntropyApp` never has. The addon substitutes a 1x1 white texture for color/normal/roughness and, deliberately, a **zero-alpha** placeholder for foam opacity specifically - since the fragment shader does `foam_blend = foam_opacity` and mixes toward the foam albedo by that value, an opaque white placeholder there would wash the entire ocean out solid white. Zero alpha keeps the blend at 0, so the real water colors and the Jacobian foam mask still show correctly; the actual Foam002 PBR textures just never load standalone. That's why the screenshot above has bright capillary glints (a separate noise-based pass, unaffected) but no textured whitecap foam.

## What's next

Two follow-ups are now concrete rather than speculative:

- **Rivers**, by wiring in the already-written but dead `jonswap_spectrum()` and retuning fetch/wind parameters for a narrower body of water instead of open ocean - a parameter and call-site change, not new architecture.
- **Interactivity** - buoyancy sampling the displacement texture, wake/ripple injection from a moving object - deliberately scoped out of this post. Nothing in the current pipeline reads from or writes to the world; it's a closed simulation loop. That's a big enough second problem (and a real risk of not converging in one session) that it gets its own post rather than being squeezed into this one.
