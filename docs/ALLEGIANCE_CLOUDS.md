# Allegiance cloud cost

Allegiance uses a shared cloud-noise atlas instead of evaluating fractal 3D noise for every
sky and surface fragment. The reference procedural path remains available for profiling.

## Implementation

`al_clouds.ts` bakes a periodic 64³ noise field once with a GPU compute dispatch. A 528 × 528
RGBA16F texture stores padded slices. RG holds coarse/fine noise for a slice; BA holds the
next slice, including the last-to-first wrap. One linear texture fetch and a Z blend produce
trilinear noise. The allocation is 2,230,272 bytes (2.13 MiB).

Ground cloud shadows use the three-octave field. Sky density and its sun-facing light probe
share the six-octave field. Weather coverage is applied after sampling, and the existing
camera-relative cloud offset and wind drift still determine the sample position. Movement,
travel, weather changes and world rebasing do not require another bake.

The cache smooths small cloud features; the light probe also uses the fine field rather than
the reference four-octave probe. This is an approximation, not pixel-identical rendering.
Wrapped border texels prevent XY seams; packing both Z planes prevents slice discontinuities.
The atlas uses ordinary linear filtering, with explicit wrapping in the shader.

`QuadPlanet.create({ extraBindings })` now appends shared resources to both terrain chunks and
city tiles. Existing callers default to an empty list. Allegiance binds the same atlas to
terrain, people, props and instanced houses/scenery, so their cloud shadows agree.

## Verification

Measured 2026-10-05 on Windows, Intel UHD Graphics 770, Vulkan driver 101.7085,
1600 × 900, release build. The seed-7 London spawn replay holds the camera beside the
parked car, with cloud cover 0.35 and unchanged geometry. The captures show an open grassy
view, not a dense city street; these numbers are specific to this view and weather.

| Rendering path | Mean frame interval |
| --- | ---: |
| Reference procedural clouds | 68.25 ms |
| Cached clouds | 46.00 ms |
| Clear sky | 44.83 ms |

Clouds add 1.17 ms (2.54% of cached frame time) across the full comparison. GPU timestamps
independently put the cloud delta at 1.22 ms. The later cached/clear/cached bracket averages
44.45 ms cached versus 42.98 ms clear, or 3.32% cloud cost. Both checks pass the 5% target. Individual
conditions drift with GPU clocks, so the later bracket is also required by the checker.
The complete comparison reduces mean frame time by 32.6%; this is not a guarantee for other
views, resolutions or weather conditions. Normal simulation was resumed and completed.

Raw evidence and captures: `test-artifacts/allegiance-isolation/clouds-final.jsonl`,
`clouds-final-result.json`, `clouds-final-summary.json`, `cloud-reference.png` and
`cloud-cached.png` (gitignored). BDD captures retain the large cloud forms with softer detail.

The earlier single-subsystem replays found no material gain from stopping settled-scene
simulation, terrain streaming or house updates. Hiding people saved about 5%, hiding scenery
about 15%, and disabling sun shadows about 14%. Disabling clouds saved about 29%; the split
was approximately 12 ms for sky clouds and 6 ms for cloud shadows. Disabling procedural
surface materials saved about 36%, making that the largest remaining measured suspect.

The first 128³ cache with two texture reads still cost approximately 8-9% per frame. The
final cache packs both Z planes into one read, uses a smaller working set, and avoids the
surface sampler's anisotropic filtering. Frame and GPU comparisons above measure the final
combination; they do not isolate the contribution of each of those three changes.

Run the release example from `entropy-engine/` with:

```powershell
$env:ENTROPY_FRAME_PROFILE = '1'
$env:ENTROPY_FRAME_PROFILE_EVERY = '30'
$env:ENTROPY_FRAME_PROFILE_OUT = 'test-artifacts/clouds/frames.jsonl'
$env:ENTROPY_ALLEGIANCE_BDD_RESULT = 'test-artifacts/clouds/result.json'
$env:ENTROPY_ALLEGIANCE_BDD_FEATURE = 'tests/features/allegiance_cloud_profile_live.feature'
$env:ENTROPY_ALLEGIANCE_BDD_DATA = 'test-artifacts/clouds/data'
./target/release/example.exe allegiance
node scripts/analyze-allegiance-profile.mjs test-artifacts/clouds/frames.jsonl test-artifacts/clouds/summary.json
node scripts/check-allegiance-cloud-budget.mjs test-artifacts/clouds/summary.json test-artifacts/clouds/result.json
```

Create the artifact directory first. Use a warm isolated cache for frame-cost measurements;
fresh downloads and asset generation measure loading instead. Do not append another replay
to the same profile file when comparing experiment IDs.

The feature alternates procedural clouds, cached clouds and clear sky on the same frozen
geometry, with production streaming budgets (`fixedStep: null`). Each condition lasts 180
frames. The analyzer drops mixed windows and the first pure window to let GPU work drain.
GPU pass time is normalized by completed readback counts; profiler GPU medians can accumulate
multiple readbacks and should not be interpreted as one pass.

The budget check computes incremental cloud cost as cached frame time minus clear-sky frame
time, divided by cached frame time. It checks the 5% target and the BDD state/camera controls.
The feature also captures reference/cached visuals and resumes normal simulation at the end.

Other profiling replays isolate people, scenery, shadows, simulation, streaming, house updates
and individual shader features. All diagnostic controls require `ENTROPY_FRAME_PROFILE=1`,
are transient, and default to normal gameplay. The production depth path is unchanged.
