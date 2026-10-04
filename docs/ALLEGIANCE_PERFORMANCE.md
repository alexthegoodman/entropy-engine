# Allegiance performance investigation

Discussion proposal, 2026-10-04. A first round of changes is now implemented: see
[Implemented](#implemented-2026-10-04) at the end. The findings below describe the code before it.

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

## Implemented (2026-10-04)

The first pass covers steps 2-5 of the suggested order where the source made the win clear, and
adds the counters step 1 asked for. It changes no gameplay rules, and the default visual quality is
unchanged except where noted.

### Engine (Rust)

- **Addon mesh resources are made once, not per frame.** `CustomMesh` now builds both group-1
  bind groups (the model one and the non-PBR pass's `unlit_bind_group`) at creation. The non-PBR
  pass used to create a bind group, three placeholder textures and a sampler per mesh every frame
  (one set of textures per frame after an earlier fix); every addon mesh also made its own three
  1x1 textures and sampler at creation. One `FallbackMaterial` (`RendererState::mesh_fallback_material`)
  now serves every addon mesh. (`src/core/custom_mesh.rs`, `render_addon_frame.rs`)
- **Unchanged transforms are not re-uploaded.** `CustomMesh::upload_transform` remembers the last
  matrix written; the PBR, non-PBR and shadow passes use it. Terrain chunks, city tiles and houses
  are static, so a street with ~700 chunks no longer does ~700 `write_buffer` calls a frame for
  identity matrices.
- **Inactive meshes are skipped entirely.** A mesh with `instance_count == 0` is left out of
  every pass. `Entropy.Model.setInstanceCount(meshId, n)` (new; `op_mesh_set_instance_count`)
  changes the count after creation, including to zero, and `Model.createMesh` now accepts
  `instanceCount: 0`.
- **Shared GPU geometry for cached meshes.** `Entropy.MeshCache.createMesh` uploads a cache entry's
  vertex/index buffers once (`SharedGeometry`, tracked weakly in `AddonContext::shared_geometry`)
  and every further spawn of that key draws the same buffers, without copying the geometry out of
  the cache again. Houses of one variant and people of one body variant now share GPU memory.
  `put`/`remove`/`clear` forget the entry so a changed mesh is uploaded fresh.
  `MeshCache.createMesh` also takes `instanceCount` now (it was forced to 1).
- **Terrain chunks build on persistent worker threads.** `PlanetStreamer::update_background`
  (used by `Entropy.QuadPlanet.update`) queues the most important missing chunks for a small pool
  of workers and only collects what they finished: the frame never joins a build. The queue is
  rebuilt every update, so its order follows the viewer and jobs that stop being wanted are
  cancelled before they start; finished chunks no longer wanted are dropped; at most `maxBuilds`
  finished chunks are handed out per update, which bounds per-frame uploads. `clear` discards
  in-flight work by epoch. An unlimited budget (`fixedStep`, the loading settle tool) still builds
  everything within the call, as before. Stats gain `inFlight`, `ready` and `cancelled`.
- **City tile race fixed.** `CityLayer::update` queued wanted tiles before draining finished ones,
  and workers reported a tile before leaving `busy`; a tile finishing in that window was built and
  handed out twice (it showed up as an intermittent `city::tests` failure under CPU load).
  Finished tiles are now collected first, and reporting plus leaving `busy` is atomic with respect
  to `update`.
- **Addon phases in the profiler.** `Entropy.Profile.record(name, ms)` / `count(name, value)` /
  `enabled()` feed the same table; Allegiance reports `al street sim`, `al nav`, `al people`,
  `al terrain stream`, `al houses` and `al ui` (no cost when profiling is off).
- **Profiler counters.** `frame_profile::count` adds per-frame counters to the
  `ENTROPY_FRAME_PROFILE` table and JSON lines: `#mesh draws`, `#mesh instances`,
  `#mesh triangles (k)` and `#mesh transform uploads`.

### Allegiance and QuadPlanet (TypeScript)

- **People are instanced** (`al_crowd.ts`). Every visible person of one body variant (sex, LOD and
  gear: one MeshCache key) is an instance of one mesh. The people shader reads a 32-float record
  (matrix, shirt + swing, pants + phase, skin, hair) from a read-only storage buffer by
  `@builtin(instance_index)`, passing the index to the fragment stage as a flat varying. A frame
  packs people into reused `Float32Array`s and does one buffer write per batch; a count change is
  one `setInstanceCount`. Changing an actor's LOD moves them to another batch instead of spawning a
  mesh. Batches grow by doubling, keep their mesh while empty (zero instances, no draw) and are
  destroyed after 600 idle frames or on `hideWorld`. Before: one mesh, two uniform buffers and a
  write per person, and a new native mesh on every LOD change.
- **Conservative view culling for people**: people certainly behind the camera or outside a 66
  degree cone are not packed. LOD selection and the simulation still run for them.
- **People triangle budget.** Drawn people are sorted nearest first and `budgetLods` demotes them
  once 6 are in full detail or 3 million person triangles are spent (you count first).
  `allegiance_config { peopleMaxFull, peopleTriangles }` changes the limits. Without it a rally of
  80 listeners within 25 m wanted ~20 million triangles; a quiet street fits unchanged (below).
- **People LOD distance scale.** `allegiance_config { peopleDetail }` scales the LOD ranges (1 is
  the previous behavior). A full-detail Mesha human is ~410k triangles, LOD 1 ~65-85k, LOD 2
  ~5-7k (from `allegiance_people.test.ts`), so the 8/16/11 split observed earlier was roughly
  4.5 million person triangles, more than all terrain. 0.3-0.5 is a sensible "low" setting.
  This is a hook for a future graphics-quality menu, not a menu.
- **Hidden props draw nothing.** The podium, flag and 20 tracers were drawn every frame with a
  collapsed matrix; they now toggle between 0 and 1 instances.
- **`PeopleMeshes` per-frame work.** Ready keys are remembered (no native status call per person
  per frame) and the human cache key (a `JSON.stringify`) is memoized.
- **Houses do no work for a still camera.** Once every wanted house is drawn at its wanted LOD and
  nothing is being made, `CityHouses.update` returns immediately until the camera moves 5 cm, the
  render origin moves or the city data changes. It used to re-sort up to 4,000 candidates and
  recheck caches every frame.
- **Spaced house evaluations.** `CityOptions.minBuildIntervalMs` (Allegiance: 250 ms) keeps a
  cold street from producing a run of consecutive 10-150 ms frames; it becomes an occasional hitch
  until the disk cache is warm. Moving Mesha evaluation off the JS thread still needs a worker
  runtime or pre-generation (unchanged).
- **Path search scratch reuse.** `NavGrid.findPath` reuses its g/came arrays across searches with
  generation stamps instead of allocating and filling three 78,400-cell arrays per search, and the
  heap swaps without array destructuring.

### Tests

- Rust: `background_streaming_never_blocks_bounds_handouts_and_keeps_ground_covered` and
  `background_streaming_with_an_unlimited_budget_builds_everything_now` (QuadPlanet tests).
- TypeScript: `tests/allegiance_crowd.test.ts` (batching, growth, idle cleanup, missing keys,
  culling, shader contract) and two `quadplanet_city.test.ts` cases (still camera, build spacing).
- The live people feature (`tests/allegiance_live.rs`, `allegiance_people_live_feature`) still
  reports per-LOD counts; they now count everyone within range (including you), drawn or culled.

### Verification in this container

The container has no GPU (Mesa's software Vulkan): frames take ~1 s, nearly all of it rasterizing
on the CPU, so live frame times cannot show these changes and were not used as evidence. One
release replay of `allegiance_profile_live.feature` per build (pre-change `625b753` vs this work,
same warm fixture, both stopped by the 900 s budget after 600 frames) gave equal `addon update`
averages (~95 ms) and equal frame intervals within noise. The new counters from that replay:
~737 mesh draws a frame (~700 of them terrain chunks), 0 transform uploads in steady state
(previously one per mesh per frame), and 5.3-6.3 million triangles, mostly people. That is
what motivated the triangle budget.

Deterministic checks instead:

- Live people feature with the final code: 35 people in range drew 18-26 visible instances in
  7-10 instanced draws (one per body variant), the rest culled; it was one mesh and draw per
  person, visible or not. Full-detail people stayed within the cap.
- Crowd model (50 seeded crowds, measured per-LOD human triangle counts, the game's LOD, culling
  and budget code; triangles of drawn people only):

  | Scene | Draws before -> after | Person triangles before -> after (detail 1 / 0.6 / 0.4) |
  | --- | ---: | ---: |
  | Street, 34 civilians over 160 m | 34 -> at most 12 | 2.87M -> 1.44M / 0.98M / 0.60M |
  | Rally, 80 listeners within 25 m | 80 -> at most 12 | 20.5M -> 2.93M / 2.93M / 2.86M |
  | Battle, 34 civilians + 8 soldiers | 42 -> at most 18 | 3.68M -> 1.76M / 1.23M / 0.81M |

- Unit tests: 581 Rust library tests (including the new streaming tests, and the city tests run
  repeatedly under load), 104 Allegiance/QuadPlanet TypeScript tests, both typechecks.

### How this sets up the AAA roadmap

- **Instance records are the `Scene.submitInstances` contract in miniature.** Adding velocity
  (previous matrix), animation state or material parameters for the roadmap's temporal AA, motion
  blur and skinned crowds is a record-layout change plus a shader read, not a new submission path.
- **Shadows and depth pre-passes multiply draws.** A shadow cascade, depth/normal or velocity pass
  over people costs one draw per batch, not per person, once those passes use the same instanced
  shader variants (the roadmap's requirement that color, shadow and velocity share deformation).
- **Shared geometry is the asset-handle foundation** for modular facade kits, props and street
  dressing: repeated pieces cost one upload. Moving houses to instanced kit pieces would make
  their draws batchable the same way people's are.
- **Bounded background jobs** are the pattern the roadmap's `WorldJobs.request/poll/cancel`
  describes; the chunk streamer now follows it.
- **Counters** give the per-stage measurements the roadmap's performance budgets need.

### Not done yet

GPU timestamp queries, instancing houses (each house variant is one mesh per placement still,
though their geometry is now shared), moving Mesha evaluation off the JS thread, frustum culling of
terrain chunks and houses on the native side, and exterior-only house meshes. Bounds on city-tile
uploads per frame (tiles are already built in the background) would complete the upload budget.
