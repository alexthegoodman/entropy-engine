# Allegiance performance investigation

Discussion proposal, 2026-10-04. No rendering or gameplay changes implemented.

## Source findings

- `allegiance_addon.ts::ensureDrawn` creates a native mesh per actor, with separate item and color uniforms. `drawPeople` writes a 24-float item per visible actor per frame. The 160 m distance filter is not camera-frustum culling.
- `mesh_cache_ops.rs::op_mesh_cache_create_mesh` clones cached vertex/index vectors into `MeshConfig`; `CustomMesh::new` then allocates vertex/index GPU buffers. Disk/CPU caching avoids regenerating humans but does not share their GPU geometry across actors.
- `render_addon_frame.rs` creates fallback textures/sampler once per non-PBR pass and a transform bind group per custom mesh per frame. `CustomMesh` already retains a model bind group, so investigate using it after checking layout and material compatibility.
- Instanced draws already exist: `MeshConfig.instance_count`, TS `Model.createMesh({ instanceCount })`, and `draw_indexed(..., 0..mesh.instance_count)`. Custom pipeline bindings support vertex-visible read-only storage. `MeshCache.createMesh` currently forces count 1. Existing building/people shaders still use one item uniform per draw.
- `qp_city.ts::generate` evaluates an entire Mesha house synchronously. A finite `buildMs` allows one complete evaluation, rather than interrupting it at that deadline. Background simplification does not move the original evaluation off the JS thread.
- `QuadPlanet/streamer.rs::update` creates scoped chunk-building threads and joins them before returning. Its elapsed-time check happens between batches, so a batch can exceed the budget.
- Houses sort candidates and recompute LOD selection every update. Static placements already avoid item writes until a rebase; preserve that optimization. The current house triangle budget is 3 million, with Allegiance overriding nearby full-detail houses to four and distant range to 260 m.
- Street pathfinding already has separate per-frame civilian/fighter limits. A new simulation architecture should follow measurements rather than assuming gameplay is the main expense.
- `al_nav.ts::findPath` allocates and initializes three full-grid scratch arrays per search. Reusable arrays with generation stamps and a wall-time/expansion budget across incremental searches are candidates if navigation timings justify them. The current A* already uses a heap.

## Suggested order

1. Measure normal play and streaming separately. Add CPU timings for street simulation, terrain selection/build/upload, house query/evaluation/spawn, people packing, and native draw encoding. Count live meshes, draw calls, GPU geometry bytes, uploaded bytes and native calls. Add GPU timestamps to distinguish GPU work from surface-acquisition waits.
2. Cache compatible transform/material bind groups and shared fallback resources. Skip inactive batches entirely. Measure before/after on identical routes.
3. Instance people first, then houses with repeated variants and small repeated props/tracers. Introduce shared native geometry even where instances cannot combine into one draw.
4. Replace synchronous chunk joins and house evaluations with owned background jobs. Bound completions, mesh uploads and new mesh creation per frame; cancel obsolete jobs on travel. Mesha evaluation is TypeScript, so a JS worker/runtime strategy or pre-generation is needed, not just a Rust simplification thread.
5. Add conservative frustum culling and projected-size LOD. Separate visibility from simulation: an offscreen fighter can still matter. Consider exterior-only house meshes when the player is outside, then more expensive occlusion/GPU culling only if measured scene costs justify them.

## Proposed TypeScript API

Illustrative names and shape, not implemented APIs:

```ts
const geometry = Entropy.MeshCache.acquireGeometry(namespace, key);
const batch = Entropy.Instances.create({
  geometry,
  pipelineId: peoplePipelineId,
  capacity: 128,
  strideFloats: 32,
  bindings: [worldBinding],
});

// Reuse a Float32Array; pack active actors contiguously.
// Matrix (16), shirt + amplitude (4), pants + phase (4), skin (4), hair (4).
Entropy.Instances.update(batch, {
  data: packed.subarray(0, count * 32),
  count,
  firstInstance: 0,
});

Entropy.Instances.destroy(batch);
Entropy.Geometry.release(geometry);
```

The shader reads a storage-buffer record using WGSL `@builtin(instance_index)` ([specification](https://www.w3.org/TR/WGSL/#builtin-values)). Keep the initial abstraction small: immutable shared vertex/index buffers, a persistent per-batch storage buffer, validated packed uploads, and a mutable active count including zero. Support explicit dirty ranges for static placements. Avoid per-actor JSON serialization; accept typed-array bytes directly through the native op. Capacity growth and ownership must be explicit, with addon cleanup and hot reload covered.

Batch by geometry/cache key (body/equipment variant and LOD), pipeline, and compatible shared bindings. Actor tint, skin/hair color, stride, swing and aiming become record data, so animation need not be synchronized across the batch. Different equipment meshes still require different batches initially. Maintain gameplay IDs separately from packed slots. Preserve camera-relative transforms and rebase all affected batches together.

For migration experiments, existing `instanceCount` and storage buffers can prove shader instancing before the full API. Missing mutable counts and cached-geometry instance creation still need engine changes or a fixed-capacity prototype. GPU instancing reduces submissions and duplicate geometry; it does not remove the triangles and fragment shading of the drawn instances.

## Reproducible live replay

`tests/features/allegiance_profile_live.feature` starts London, settles its loading screen, explicitly restores `fixedStep: null`, then records resting and walking gameplay. Existing fixed-step Allegiance fixtures use unlimited terrain/house streaming budgets and should not serve as normal gameplay performance baselines.

Use the release example with these environment variables, from `entropy-engine/`:

```powershell
$env:ENTROPY_FRAME_PROFILE = '1'
$env:ENTROPY_FRAME_PROFILE_EVERY = '300'
$env:ENTROPY_FRAME_PROFILE_OUT = 'test-artifacts/allegiance-profile/frames.jsonl'
$env:ENTROPY_ALLEGIANCE_BDD_RESULT = 'test-artifacts/allegiance-profile/result.json'
$env:ENTROPY_ALLEGIANCE_BDD_FEATURE = 'tests/features/allegiance_profile_live.feature'
$env:ENTROPY_ALLEGIANCE_BDD_DATA = '<isolated fixture data directory>'
$env:ENTROPY_BDD_BUDGET_SECS = '480'
./target/release/example.exe allegiance
```

Create the output directory first. Reuse the same fixture cache for warm comparisons. The loading-settle tool is synchronous and uses unlimited budgets internally; exclude its early timing window. The current profiler reports CPU wall-clock phases, not GPU execution durations. Its `scene` phase includes `addon update`, so do not add those two rows together. Reporting windows are not exactly aligned to BDD steps.

## Initial live observations

Ran the existing release `target/release/example.exe` (file timestamp 2026-10-04 10:52) with the existing standalone bundle on Windows, Intel i5-12500, 1600 x 900. No rebuild in this session, GPU adapter/backend not established. Reused `test-artifacts/allegiance-people-1228/data`, a previous isolated fixture cache, rather than the user's campaign folder. Raw output: `test-artifacts/allegiance-profile-20261004/` (gitignored).

The second 300-frame reporting window, during resting normal-budget play:

| Phase | Average ms | Median ms | p95 ms |
| --- | ---: | ---: | ---: |
| Frame interval | 225.37 | 45.34 | 624.07 |
| Addon update (includes native calls) | 96.11 | 17.08 | 281.64 |
| Scene, including addon update | 183.18 | 37.68 | 432.19 |
| Surface acquisition | 40.74 | 0.03 | 180.43 |
| UI JS/layout | 0.07 | 0.05 | 0.14 |

At a later MCP checkpoint (frame 785), the game reported normal `fixedStep: null`, 699 live terrain chunks, no pending terrain/elevation work, approximately 1.70 million terrain triangles (including 1.65 million city triangles), seven Mesha houses with 336,720 additional triangles, and 34 civilians plus the player (LOD counts 8/16/11). House generation and queue counts were zero; base human generation was zero. People cache memory was approximately 105 MB across 13 cached meshes, which is CPU cache memory, not a GPU-memory measurement.

This establishes update and scene stalls in a cached street, not their root cause. `scene - addon update` averages about 87 ms in that window, but includes native rendering preparation, uploads and encoding, not isolated GPU execution. Surface acquisition may reflect GPU/presentation backpressure. The scene has far more terrain chunks than people; caching renderer resources across all custom meshes and measuring terrain visibility deserve attention alongside crowd instancing. Do not infer an FPS gain from these timings or assume all update time is JavaScript computation.

The BDD driver completed successfully at frame 1506. Five 300-frame windows were recorded. Later window averages ranged from 242 to 267 ms, with p95 from 685 to 760 ms. Holding W moved the player only about two metres before collision constrained progress; this is not a substantial streaming-route measurement. A future replay should choose a traversable route and include travel/cold-cache scenarios. The successful driver result means the scripted actions completed, not that a performance threshold passed. Stopped the completed fixture process during background-job shutdown.
