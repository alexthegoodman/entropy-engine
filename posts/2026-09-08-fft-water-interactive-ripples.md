---
title: "Interactive Ripples on Top of Entropy's FFT Ocean"
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
repo_link: entropy-engine @ ee5cc12 (this post's changes are addon-only, on top of that commit)
---

The [last post on the FFT ocean addon](2026-09-08-fft-ocean-water.md) ended by scoping interactivity out on purpose: nothing in that pipeline read from or wrote to the world, it was a closed loop from spectrum to displacement. This post closes that gap - mouse clicks and drags now leave real, propagating ripples on the surface, plus three convenience buttons for triggering them without a mouse at all. No Rust changed. `src/bin/example_fft_water.rs` is still the same 11 lines it was in the last post - every bit of this is addon-side TypeScript plus engine APIs that already existed.

## What's actually being added

The FFT spectrum is a bad fit for local disturbances - it's a sum of global sine waves over the whole ocean tile, there's no clean way to say "bump this one spot." So interactivity here is a second, independent simulation: a small height-field wave equation, added on top of the FFT displacement at sample time rather than merged into it.

The physics is the standard explicit leapfrog integration of the 2D wave equation:

```wgsl
// examples/studio-bundle/src/fft_water_addon.ts - RIPPLE_STEP_SHADER
let laplacian = h_l + h_r + h_u + h_d - 4.0 * h_c;
let h_next = (2.0 * h_c - h_p + params.c2 * laplacian) * params.damping;
```

`h_next` needs both `h_c` (current height) and `h_p` (previous height) - a second-order equation in time needs two prior states, not one. `c2` has to stay under roughly 0.25 for this 5-point stencil to stay stable; I used 0.15 for headroom.

A click or drag doesn't touch that equation directly. It runs a separate pass first that adds a Gaussian bump to the current height field at the clicked point:

```wgsl
// RIPPLE_SPLAT_SHADER
let d = distance(uv, vec2<f32>(params.centerU, params.centerV));
let falloff = exp(-(d * d) / (2.0 * params.radiusUV * params.radiusUV));
let bump = params.strength * falloff;
```

Then the step shader picks up that disturbed height field as its `h_c` for the next integration step, and the wave equation does the rest - the bump spreads into an actual ring instead of just fading in place.

## Why this needs 3 buffers, not 2

The leapfrog step reads five neighboring texels of the *same* texture (`h_l`, `h_r`, `h_u`, `h_d`, `h_c`) to compute one output texel. If the output texture were the same resource as the input, a thread could read a neighbor's value after that neighbor's thread had already overwritten it - a race with no defined outcome. So the write target has to be a texture disjoint from both `h(t)` and `h(t-1)`.

That means an actual ring of 3 textures, not a 2-buffer ping-pong: frame N reads ring[t] and ring[t-1], writes ring[t+1]; frame N+1 reads ring[t+1] and ring[t], writes back into the (now safely stale) ring[t-1] slot. I track this with a single rotating index in JS:

```typescript
// fft_water_addon.ts - updateRipples
const ringIdx = rippleState.ringIdx;
const prevIdx = (ringIdx + 2) % 3;
const nextIdx = (ringIdx + 1) % 3;
```

The mesh itself samples a fourth, fixed-ID texture (`textures.rippleRender`) that a small copy pass fills in every frame from whichever ring slot just became current, plus the finite-difference `dHdx`/`dHdz` derivatives needed to perturb the normal. This isn't extra ceremony for its own sake - `Entropy.Model.createMesh`'s texture bindings are fixed at mesh-creation time, and the mesh here is a 257x257-vertex grid that I don't want to re-upload every frame just to point at a different ring slot. The FFT pipeline already solves the identical problem the identical way: its own ping-pong buffers never touch the mesh directly, `DISPLACEMENT_SHADER` copies the final state into fixed `textures.displacement`/`textures.derivatives` every frame instead. I just followed the pattern that was already there.

Splats get the same treatment for the same reason, capped at 2 per frame through a pair of scratch textures - realistic given the update loop runs at ~120 calls/sec (measured below) and a mouse can't meaningfully queue more than that per frame.

## Wiring up the mouse

Picking a world point from a screen-space click needs a real ray, and I checked two APIs before finding the one that works. `Entropy.Selection.raycast` looked like the obvious candidate, but it's a stub:

```javascript
// src/deno/addon_setup.js:1103-1106
raycast: (screenX, screenY) => {
    // Need op_selection_raycast
    return null;
},
```

`Entropy.Camera.screenToWorldRay` is the real one - it calls `op_camera_screen_to_world`, which unprojects through the actual camera view/projection matrices for this frame (`src/deno/addon_ops.rs:1658`), not an approximation:

```typescript
function raycastToOceanPlane(screenX: number, screenY: number): [number, number, number] | null {
    const ray = Entropy.Camera.screenToWorldRay(screenX, screenY);
    const origin = ray.origin;
    const direction = ray.direction;
    if (Math.abs(direction[1]) < 1e-6) return null;
    const planeY = addonState.currentParams.oceanHeight;
    const t = (planeY - origin[1]) / direction[1];
    if (t < 0) return null;
    return [origin[0] + direction[0] * t, planeY, origin[2] + direction[2] * t];
}
```

That's a ray/plane intersection against the ocean's known world-space height, nothing more - the ocean is flat at the vertex-grid level (displacement is a shader-side effect), so the plane assumption is exact, not an approximation. From there it's `Entropy.Input.onMouseDown` for a bigger splash on click, `onMouseMove` gated on "is the button down" for a continuous smaller wake while dragging, and `onMouseUp` to stop it.

## Evidence

I ran this on the same machine as the last post: Intel UHD Graphics 770 (integrated), i5-12500, 32GB RAM, Windows 11 Pro 10.0.26200, 1920x1080@120Hz.

Build and run, this session:

```
cd examples/studio-bundle
deno bundle src/fft_water_addon.ts > dist/fft_water.js
cargo build --release --bin example_fft_water
./target/release/example_fft_water.exe
```

`cargo build` finished in 8.56s with one pre-existing, unrelated warning (`unused import: entropy_engine::startup`, already present before this session's changes). The binary ran across multiple test passes in this session totaling several minutes, with no wgpu validation errors and no crashes, through repeated clicking and dragging on the water and on the UI panel (see Failure notes for what that second case actually does).

I clicked and dragged on the water surface during a live run and screenshotted the result:

![A large ripple crater, distinct from the ambient FFT chop, expanding outward from a click point on the water surface](images/fft-water-interactive-ripples.png)

That's a real leapfrog wave-equation ring propagating outward, not a static decal - it keeps expanding and fading over the following frames.

**Measured update-loop rate**, same technique as the last post (uncomment the per-call debug print at the `onUpdatePlus("Global", ...)` registration, rebuild only the JS bundle, count lines against wall-clock time after a 5s warm-up, then revert):

- 2,763 `updateOcean()` invocations over 22.99 seconds -> **~120.2 calls/sec**.

The last post measured ~120 calls/sec on this same hardware, before any of this session's ripple passes existed. The two numbers match within measurement noise, which means the extra compute work - 1 step pass + 1 render-copy pass every frame, plus up to 2 splat passes when there's actual mouse input - isn't enough to push this addon off the display's 120Hz vsync cap (`PresentMode::Fifo`, `src/startup.rs:1031`) on this GPU. It says nothing about headroom left over; I didn't profile per-pass GPU time, so I can't say how close to the cap this now runs, only that it's still at the cap.

First-party numbers, all pulled from this repo and session directly:

- **Addon growth**: `examples/studio-bundle/src/fft_water_addon.ts` went from 1,909 to 2,323 lines (`git diff --stat`: +421/-7 lines this session).
- **`src/bin/example_fft_water.rs` unchanged**: still 11 lines, still the entire native entry point. Every part of this feature is addon TypeScript plus engine ops that already existed - the isolation this file was built for in the last post held up for a second, unrelated feature.
- **New GPU resources**: 4 new WGSL compute shaders (step, splat, render-copy, clear) and 6 new `Rgba16Float` storage textures at 256x256 (3 ring buffers + 2 splat scratch buffers + 1 fixed render target) - all far smaller than the FFT pipeline's own 512x512 buffers.
- **Ripple grid**: 256x256, dispatched as 32x32 workgroups at 8x8 threads each - 65,536 threads per pass, an exact match with no wasted edge threads since 256 is a clean multiple of 8.

## Decision log

- **A second simulation, not a modified FFT one.** The FFT spectrum has no concept of "a point" - every texel already represents a global wave vector, not a location. Building local disturbances into it would mean fighting the representation. A separate height-field sim that just gets added at sample time is simpler and is also how this is done in practice (Tessendorf's own papers treat wake/ripple injection as a separate technique layered on the spectral method, not a spectral-domain operation).
- **3 ring buffers over 2**, forced by wgpu/WGSL's storage-texture rules: a compute pass can't safely read a texture's neighboring texels while other invocations in the same dispatch are writing that same texture. See the buffer-count section above for the full argument.
- **A fixed render-copy texture, matching the FFT pipeline's own pattern**, so `Entropy.Model.createMesh`'s bindings never need to change and the 257x257-vertex water grid never needs re-uploading. This is precedent this addon already established for `textures.displacement`/`textures.derivatives`; the ripple layer just reuses it.
- **`Entropy.Camera.screenToWorldRay` over `Entropy.Selection.raycast`.** The latter is unimplemented (`addon_setup.js:1104`, `// Need op_selection_raycast`) - I found this by reading the source before trying to call it, not by hitting a runtime error, but it's worth flagging since the name alone reads like the right API for this.
- **Splats as an instantaneous height impulse**, not a velocity perturbation. A more physically complete model would add to a separate velocity field and let the height respond over subsequent steps. Adding straight to height is simpler, visually reads correctly as a splash, and is a legitimate simplification for this use case rather than a shortcut around something broken.
- **Capped at 2 splats per frame.** The update loop runs at ~120 calls/sec; a real mouse cannot usefully queue more disturbances than that per frame, so anything beyond 2 queued in one frame is dropped rather than chained further.

## Failure notes

- **Mouse events reach the addon's `Input` listeners and the UI panel underneath the cursor at the same time - confirmed by testing, not assumed.** Clicking or dragging on the FFT Ocean panel itself (its sliders, its own buttons) also raycasts through to the water and can queue a ripple splat at whatever world point happens to sit behind that screen pixel. There's no API exposed to an addon for "is the mouse currently captured by a UI widget," so this isn't something I fixed - it's a real, current limitation of building UI and 3D mouse-picking in the same addon under `EntropyApp`, worth knowing before relying on click-to-splash being exclusive to the 3D viewport.
- Nothing else genuinely failed this session. The build, the bundle, and the run all worked on the first coherent version of this design - the only real wrong turn was reaching for `Entropy.Selection.raycast` before finding it was a stub, caught by reading the source rather than by a failed call.

## What's next

Two things queued in the last post are now either done or reframed:

- **Interactivity** is done, as covered here - not a full physical model (no object-driven wakes yet, no buoyancy sampling the combined height field for anything to float on it), but real, propagating, mouse-driven ripples layered on the FFT ocean.
- **Rivers**, via the already-written but still-dead `jonswap_spectrum()` in `SPECTRUM_INIT_SHADER`, remains queued and untouched this session.

A reasonable next step for this specific feature is buoyancy: now that there's a combined height field (FFT + ripple) being sampled per-vertex on the GPU, reading that same value back on the CPU/JS side for a floating object is a much smaller problem than this post's ripple layer was.
