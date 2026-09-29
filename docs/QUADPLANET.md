# QuadPlanet

QuadPlanet (`cargo run --bin example --release -- quadplanet`, after `npm run build-quadplanet`
in `examples/studio-bundle`) is the QuadScape quadtree terrain turned into planets you can walk
on, with a ship to fly between them. It is an ordinary addon app: all of it is TypeScript in
`examples/studio-bundle/src/apps/quadplanet/`, drawing through `Entropy.Model.createMesh` and one
custom WGSL pipeline.

![Verdant from orbit](../public/quadplanet-verdant-from-orbit.png)

## Scale

One world unit is a meter. The walker is 1.8 m tall, and the mountains are kilometers high: the
highest peaks on Verdant stand about 3.4 km above the sea, well over a thousand times your
height. The planets are 58–100 km in radius and some 600 km apart. That is small for a real
planet (Earth's radius is 6,371 km), but large enough that the ground looks flat underfoot and
a range sinks below the horizon as you walk away from it. It is also small enough to fly
between planets in about 15 seconds.

| Planet | Radius | Highest peaks | Atmosphere | Gravity |
|---|---|---|---|---|
| Verdant | 100 km | ~3.4 km | 8 km | 9.8 m/s² |
| Ember | 72 km | ~2.8 km | 6 km | 8.2 m/s² |
| Glacia | 58 km | ~2.3 km | 5 km | 7.4 m/s² |

## From QuadScape to a planet

QuadScape (`src/heightfield_landscapes/QuadTree.rs` and `QuadScape.rs`) streams one flat
heightfield: a quadtree over the map, a tile's level of detail chosen by its distance to the
viewer (`LOD_RINGS`), and a per-frame diff of the tiles it wants against the live ones. New tiles
are built and uploaded, stale ones dropped. QuadPlanet keeps that loop and changes what it runs
on:

| QuadScape | QuadPlanet (`qp_quadtree.ts`) |
|---|---|
| One quadtree over a heightmap | Six quadtrees, one per face of a cube, every grid point pushed onto the sphere (the spherified-cube mapping keeps cells close to equal-area) and out by the terrain height |
| Four fixed LOD rings | A node splits while the viewer is closer than 1.5x its own size, down to the deepest configured level (13 by default: ~19 m chunks with vertices 0.3 m apart on Verdant), so detail follows you continuously from orbit to the ground |
| Heights from a u16 heightmap | Heights from seeded 3D noise sampled on the unit sphere (`qp_planet.ts`), so there are no seams at cube edges and nothing pinches at the poles |
| Coarse LODs read an averaged mip pyramid | Coarse chunks sample band-limited noise: octaves finer than ~3 samples of the chunk's spacing are faded out. It is the same idea in frequency, and it is what keeps coasts and limbs from aliasing into spikes from orbit |
| Tile borders pinned to full-res samples, so neighbours agree on them | Same rule, adapted to chunks that double in size per level: the tree is kept 2:1 balanced, a chunk bordering a coarser one uses only the coarse chunk's vertices on that edge (it triangulates around the skipped ones), and every border vertex is sampled at the detail level of the coarsest chunk touching it. Neighbours share bit-identical edges, even across cube faces, with no skirts |
| Tiles outside `VIEW_RADIUS` dropped | Chunks below the horizon are skipped, counting how far past it the highest peak still shows |
| Stale tiles dropped the same frame | A stale chunk stays until every wanted chunk overlapping it is built, so streaming never opens a hole |

The default configuration (`qp_config.ts`) has 14 levels: 64x64-vertex leaf chunks, 32x32
above them, and 48-64 on the few planet-sized chunks seen from orbit. Standing on Verdant that
is about 560 chunks (some 2M triangles) for the planet under you and about 20 each for the
other two. Building is bounded per frame (10 chunks or
12 ms). The chunks that look biggest go first (distance divided by size), so the ground at your
feet comes first and distant ranges don't leave holes in the horizon. A run with `fixedStep`
set streams everything each frame, so it looks the same on any machine.

## Configuring chunk detail

Set `DEFAULT_CHUNK_DETAIL` in
[`qp_config.ts`](../examples/studio-bundle/src/apps/quadplanet/qp_config.ts) for all planets,
or add `chunkDetail` to an individual `PlanetDef`. The configuration file includes examples
for both modes. Leave it undefined for the existing defaults, and run `npm run build-quadplanet`
in `examples/studio-bundle` after editing it.

```ts
// Eight levels, from leaf to root: 64, 32, 16, 8, 4, 3, 3, 3 vertices per side.
export const DEFAULT_CHUNK_DETAIL: ChunkDetail | undefined = {
    mode: "half", leafVertices: 64, levels: 8,
};

// Or choose every level explicitly, deepest leaf first and root face last.
// The list length is the number of levels (eight here).
export const DEFAULT_CHUNK_DETAIL: ChunkDetail | undefined = {
    mode: "explicit", verticesPerLevel: [64, 48, 32, 24, 16, 12, 8, 4],
};
```

Planets are big, so the tree is deep. With fewer levels, the leaves are too coarse to walk on:
eight levels would make Verdant's leaf chunks about 1.2 km across.

These counts describe the nominal grid width including endpoints: `64` gives a 62x62 interior.
The existing border vertices, their sampling, and edge stitching are retained. Triangle strips
connect the configured interior to that boundary, so the total vertex count is the interior
count plus the existing border count. Counts need not be powers of two.

Automatic mode halves the vertex count at each coarser level, rounding down and stopping at
three vertices per side. Valid counts are 3–257; valid level counts are 1–18, including root
level 0. Explicit mode uses exactly the supplied list. An eight-level configuration has its
deepest leaf at quadtree level 7. Replace configuration objects rather than mutating them.

You can also apply settings while running through `quadplanet_config`:

```json
{"planet":"Verdant","chunkDetail":{"mode":"half","leafVertices":64,"levels":8}}
```

```json
{"chunkDetail":{"mode":"explicit","verticesPerLevel":[64,48,32,24,16,12,8,4]}}
```

Omit `planet` to apply to all planets. `{"chunkDetail":null}` restores the source defaults.
Applying settings rebuilds the streamed terrain; `quadplanet_state` reports each planet's
resolved `verticesPerLevel` list in leaf-to-root order.

## Terrain: rock that appears as you close in

`sampleSurface` (`qp_planet.ts`) builds the ground from layers at the following scales:

| Layer | Size | Where |
|---|---|---|
| Continents | tens of km | everywhere; the sea fills the low ground |
| Mountain belts | ridged ranges ~25 km between crests, finest octave ~40 m, up to 4.2 km high | on land, tallest inside broad belts |
| Hills | ~2 km | on land |
| Crags and outcrops | ~240 m down to ~12 m | on rough ground and throughout the mountains |
| Boulders | a few meters | on all land, denser on rocky ground |
| Scree | ~2.6 m stones | on rocky ground only |
| Bumps | ~6 m | everywhere |

Rock is a property of the ground rather than a single layer. Mountain slopes and rough patches
of lowland get crags, boulders and scree. Every layer is band-limited to the mesh sampling it,
so from orbit a slope is smooth, from the air it is a field of crags, and on foot you walk among
loose stones. The sample's `rock` weight and the slope together pick how rocky the ground is
colored. The weight is also passed to the shader in the vertex color's alpha.

## Rendering at planet scale

- **Camera-relative positions.** f32 can't place a vertex to the millimeter hundreds of
  kilometers from the origin. Each chunk's vertices are stored relative to its own origin, and
  everything is drawn relative to a *render origin* kept within 2 km of the camera. Each chunk
  has its own small uniform holding its translation (chunk origin minus render origin). When
  the camera moves more than 2 km, the origin moves and those uniforms are rewritten; the meshes
  never are. Positions and origins are snapped to a 1/1024 m grid, so within 16 km of the
  camera the GPU's sum is exact. Neighbouring chunks still meet bit for bit, as before.
- **Logarithmic depth.** The engine's depth buffer is 24-bit with a 0.1 m near plane, which
  would leave hundreds of meters of depth resolution at a far mountain range. The QuadPlanet
  shader writes depth as log2(1 + distance), accurate from the walker's boots to the next
  planet.
- **Procedural textures.** The fragment shader textures terrain with 3D value noise and bumps
  the normal with the noise's analytic gradient:
  - rock: lumpy grain, fracture lines and faint strata;
  - soil and grass: tufts, bare earth and pebbles;
  - snow: drifts and glinting crystals;
  - water: wind ripples;
  - ice: fracture lines.

  Each octave fades out once it is finer than a pixel, so close ground is detailed and distant
  ground doesn't shimmer. The noise repeats every 1024 m. Each chunk gets its origin modulo
  that period (`tex_origin`), so the pattern is continuous across chunks, and the numbers the
  shader works with stay small.

Engine support added for this:

- `Entropy.Buffer.destroy(id)` frees each chunk's uniform when the chunk goes.
- A camera set in an addon's update now applies to that same frame, like the buffers the
  update wrote. Before, it lagged a frame behind them, so moving the render origin would have
  shown a one-frame jump.

## The rest of the app

- `qp_sim.ts`: the game state, independent of the engine. The walker's gravity points at the
  planet's center and footing comes from the same height function the chunks sample. The ship
  lifts off, flies with a hover assist that levels it inside an atmosphere, and lands when it
  touches down slowly. The autopilot flies a cubic Bezier from the ship to a sunlit, flat landing
  site on the target planet, lifted clear of every planet on the way, and eases in and out. The
  chase camera stays above the ground.
- `qp_shader.ts`: terrain, water, ice, the ship, the walker and the sky in one shader. The sky is
  a sphere that follows the camera. It draws stars and the sun, plus the scattering along the view
  ray through each planet's atmosphere shell, so a planet has a day sky, dark space above it and
  a glowing rim from orbit. Terrain is hazed by the same shell (aerial perspective).
- `qp_models.ts`: the procedural ship and walker. They move by a per-object model matrix in a
  uniform buffer, so they never re-upload geometry.
- `quadplanet_addon.ts`: engine wiring, input, the HUD and the MCP tools.

The engine gained one API for this: `Entropy.Camera.setTransform(position, target, up?)`. The
optional `up` keeps the horizon level when you walk on the far side of a planet.

## Controls

| On foot | In the ship |
|---|---|
| W / S walk, A / D turn, Shift run, Space jump | W thrust, Shift boost (thrust and climb), S brake, A / D yaw, arrow keys pitch, Space / C climb and sink |
| E board (within 9 m of the ship) | E step out (landed), T autopilot to the next planet |

Drag to orbit the camera, scroll to zoom. L colors every chunk by its quadtree level and O
outlines each chunk (in white: a drawn line, not a gap). V toggles an orbit view of the nearest
planet. The `quadplanet_view` tool's `overhead` mode looks straight down on you with the detail
centered on you, which shows the rings of levels.

## MCP tools

`quadplanet_state` (mode, planet, altitude, speed, autopilot progress, chunk counts and depth per
planet), `quadplanet_planets`, `quadplanet_config` (`fixedStep` for reproducible runs, `debugLod`,
`exposure`), `quadplanet_interact` (E), `quadplanet_autopilot` (`target`), and `quadplanet_view`
(`orbit` / `follow`).

## Tests

- `npm run test:quadplanet` (`tests/quadplanet.test.ts`) covers the pure tier: cube-face seams,
  triangle winding (the engine culls back faces), watertight borders between chunks of different levels (every chunk outline matched bit for bit by its neighbour), 2:1 balance, LOD selection, streaming that never
  drops drawn ground, band limiting, landing sites, walking on the far side of a planet, boarding,
  and autopilot flights to every planet.
- `cargo test --release --test quadplanet_live -- --nocapture` (under `xvfb-run -a` on a headless
  box) plays `tests/features/quadplanet_live.feature` in the real window at a fixed step. It walks
  to the ship with real key presses, boards, lifts off, autopilots to Ember and walks there, takes
  orbit shots with the LOD view, then flies on to Glacia. It checks the tools' replies (planet,
  altitude, quadtree depth reached) and the captured pixels (a blue sky over green ground, black
  space between planets, orange Ember, several LOD colors, ice on Glacia).

## Limits

- The simulation runs in world-space doubles (JavaScript numbers); only rendering is camera
  relative. A much larger system than a few thousand kilometers would still need the
  simulation itself rebased.
- The walker and ship use the analytic surface, not Rapier colliders.
- There are no cast shadows, and the ship lands only where the autopilot finds flat ground or
  where you set it down.
