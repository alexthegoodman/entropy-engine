# QuadPlanet

QuadPlanet (`cargo run --bin example --release -- quadplanet`, after `npm run build-quadplanet`
in `examples/studio-bundle`) is the QuadScape quadtree terrain turned into planets you can walk
on, with a ship to fly between them - three procedural planets and the real Earth.

Like QuadScape, the terrain is Rust (`src/heightfield_landscapes/QuadPlanet/`) exposed to
TypeScript (`Entropy.QuadPlanet`, see [The API](#the-api)): planet definitions go in, and chunk
meshes come out straight into the addon's pipeline. The app itself (the walker, ship, autopilot,
camera, HUD, shader and MCP tools) is an ordinary addon in
`examples/studio-bundle/src/apps/quadplanet/`.

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
| Earth | 6,371 km | 8,849 m (Everest) | 60 km (drawn) | 9.81 m/s² |

Earth hangs about 20,000 km from Verdant, filling a good part of its sky. The autopilot gets you
there in 15 seconds.

## From QuadScape to a planet

QuadScape (`src/heightfield_landscapes/QuadTree.rs` and `QuadScape.rs`) streams one flat
heightfield: a quadtree over the map, a tile's level of detail chosen by its distance to the
viewer (`LOD_RINGS`), and a per-frame diff of the tiles it wants against the live ones. New tiles
are built and uploaded, stale ones dropped. QuadPlanet keeps that loop and changes what it runs
on:

| QuadScape | QuadPlanet (`QuadPlanet/quadtree.rs`, `mesh.rs`, `streamer.rs`) |
|---|---|
| One quadtree over a heightmap | Six quadtrees, one per face of a cube, every grid point pushed onto the sphere (the spherified-cube mapping keeps cells close to equal-area) and out by the terrain height |
| Four fixed LOD rings | A node splits while the viewer is closer than 1.5x its own size, down to the deepest configured level (13 by default: ~19 m chunks with vertices 0.3 m apart on Verdant), so detail follows you continuously from orbit to the ground |
| Heights from a u16 heightmap | Heights from seeded 3D noise sampled on the unit sphere (`planet.rs`), so there are no seams at cube edges and nothing pinches at the poles; or, on Earth, from real elevation tiles (see [Earth](#earth)) |
| Coarse LODs read an averaged mip pyramid | Coarse chunks sample band-limited noise: octaves finer than ~3 samples of the chunk's spacing are faded out. It is the same idea in frequency, and it is what keeps coasts and limbs from aliasing into spikes from orbit. Earth reads a real mip pyramid: the tile zoom matching the chunk's spacing |
| Tile borders pinned to full-res samples, so neighbours agree on them | Same rule, adapted to chunks that double in size per level: the tree is kept 2:1 balanced, a chunk bordering a coarser one uses only the coarse chunk's vertices on that edge (it triangulates around the skipped ones), and every border vertex is sampled at the detail level of the coarsest chunk touching it. Neighbours share bit-identical edges, even across cube faces, with no skirts |
| Tiles outside `VIEW_RADIUS` dropped | Chunks below the horizon are skipped, counting how far past it the highest peak still shows |
| Stale tiles dropped the same frame | A stale chunk stays until every wanted chunk overlapping it is built, so streaming never opens a hole |

The default configuration (`qp_config.ts`) has 14 levels: 64x64-vertex leaf chunks, 32x32
above them, and 48-64 on the few planet-sized chunks seen from orbit. Earth has 20 levels for the
same ~19 m leaf chunks (its root faces are 10,000 km across). Standing on Verdant that is about
460 chunks for the planet under you and about 20 each for the others; standing on Earth, about
580 (horizon culling does most of the work there: from 2 m up, nothing past ~340 km can show,
even Everest). Building is bounded per frame (10 chunks or 12 ms) and runs on every core (one
chunk per thread). The chunks that look biggest go first (distance divided by size), so the
ground at your feet comes first and distant ranges don't leave holes in the horizon. A run with
`fixedStep` set streams everything each frame, so it looks the same on any machine.

**Triangle budget.** Every selection is costed before anything is built: if all planets together
would draw more than the budget (2,000,000 triangles by default; `triangleBudget` in `create` or
`quadplanet_config`), the split distance is tightened (x0.85 at a time) until it fits. The
finest level still reaches your feet; the rings of detail just draw in closer. Standing on
Verdant or Earth the split factor settles around 1.3 instead of 1.5, at ~1.9M triangles.

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
three vertices per side. Valid counts are 3–257; valid level counts are 1–21, including root
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

`Planet::sample` (`planet.rs`) builds the procedural planets' ground from layers at the
following scales (ported from the TypeScript that designed them: the same seeds give the same
planets, checked against values the TypeScript printed):

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

## Earth

Earth (`terrain: { kind: "earth" }` on a planet definition) takes its heights from real
elevation data, and anchors itself to real places through OpenStreetMap.

**Elevation** (`elevation.rs`). The source is the Terrarium encoding of the open
[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) dataset on AWS Open Data: 256x256
PNG tiles in the Web Mercator XYZ scheme, where a pixel's elevation is `R*256 + G + B/256 -
32768` meters. On land it is mostly SRTM (GMTED, NED, ETOPO1 and others fill the gaps); the
oceans carry bathymetry. Its zoom levels are exactly the mip pyramid QuadScape builds by
averaging: each sample reads the zoom whose pixels match the chunk's vertex spacing at that
latitude, with Catmull-Rom (bicubic) interpolation and its analytic slope. A chunk seen from
orbit reads a handful of low-zoom tiles; the ground under your feet reads zoom 13 (~19 m pixels
at the equator, SRTM's own resolution; `maxZoom` goes to 15).

- **Offline.** The whole world at zoom 0 (one 256x256 tile, 146 KB) is compiled in, so Earth
  always has its continents, oceans and ice sheets. (It is built from the four zoom-1 tiles by
  `scripts/quadplanet_base_tile.mjs`: the published zoom-0 tile has bedrock under Greenland and
  Antarctica.) `terrain: { kind: "earth", offline: true }` uses nothing else.
- **Streaming and caching.** Other tiles are fetched on background threads (newest request first)
  and kept on disk under `<data dir>/quadplanet/terrarium/z/x/y.png` (`cacheDir` to move it), so a
  second visit reads from disk. A few hundred decoded tiles stay in memory (least recently used
  go first). A location costs a few dozen small tiles.
- **No cracks while data arrives.** Neighbouring chunks must sample a shared border point
  identically, so a chunk is never built from data a neighbour might not see: a build that
  touches a tile still in flight is thrown away and retried once it lands (the stale coarser
  chunk stays until then, so nothing opens). A tile that fails to load for good is final, and
  the next coarser zoom stands in for it, deterministically.
- **SRTM files.** `srtmDir` points at a directory of SRTM `.hgt` files (`N45E007.hgt`, 1 or 3
  arc-seconds, as distributed by USGS and mirrors); wherever it has a file, chunks fine enough to
  show its resolution read it instead of the tiles.
- **Small-scale ground.** The data stops at ~20 m and the ground you walk on needs detail down to
  ~0.3 m, so the procedural rock, boulder, scree and bump layers go on top (at a few meters of
  amplitude; steep slopes from the data's own gradient are rocky). Biome colors come from
  latitude and real elevation: forest and grassland, the subtropical desert belts, tundra, a snow
  line from ~5 km in the tropics down to sea level at the poles, and pack ice on polar seas.

The frame: +Y is the north pole, latitude 0 / longitude 0 faces +Z, east is +X (so a camera on
+Z looking at Earth with +Y up sees a map the right way round).

**Places** (`geo.rs`). `quadplanet_goto` and the HUD's **Earth** box take a latitude/longitude
("46.0, 7.6"), one of a few built-in landmarks (Everest, K2, the Matterhorn, Mont Blanc, the Grand
Canyon, Half Dome, Fuji, Kilimanjaro, Denali, Aconcagua, Table Mountain, Uluru, Mauna Kea; these
work offline), or any name OpenStreetMap knows, looked up with
[Nominatim](https://nominatim.org/). On foot you are set down exactly there, the ship parked on
the nearest flat ground within a kilometer (or beside you); aboard, the autopilot flies you there.
The sun moves to mid-morning over the place (`keepSun` to leave it), so a place on the night side
isn't dark. While you are on Earth the HUD shows your latitude, longitude, height above sea level
and the name of the place (a background reverse lookup, at most once per ~1 km). The public
Nominatim asks for at most one request a second, an identifying User-Agent and caching; all three
are done, and `geocoderUrl` points at your own instance for heavier use.

Attribution: elevation from Terrain Tiles (SRTM, GMTED, NED, ETOPO1 and others; see the
dataset's attribution page), places © OpenStreetMap contributors (ODbL). The HUD shows both on
Earth.

## Rendering at planet scale

- **Camera-relative positions.** f32 can't place a vertex to the millimeter hundreds of
  kilometers from the origin (or on Earth, thousands). Each chunk's vertices are stored relative to its own origin, and
  everything is drawn relative to a *render origin* kept within 2 km of the camera. Each chunk
  has its own small uniform holding its translation (chunk origin minus render origin). When
  the camera moves more than 2 km, the origin moves and those uniforms are rewritten; the meshes
  never are. Positions and origins are snapped to a 1/1024 m grid, so within 16 km of the
  camera the GPU's sum is exact and neighbouring chunks meet bit for bit. (Earth's coarsest
  chunks are hundreds of kilometers across, so their offsets round at the millimeter; they are
  never nearer than 1.5x their own size.)
- **Atmosphere at Earth scale.** The shader's ray-sphere test computes |oc|² - r² as
  (|oc| - r)(|oc| + r): with Earth's radius both squares are ~4e13 and their f32 difference would
  lose everything below a few hundred meters of altitude.
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

## The API

`Entropy.QuadPlanet` (typed in `examples/studio-bundle/src/addon.d.ts`; ops in
`src/deno/quadplanet_ops.rs`). `id` is what `create` returned; `planet` is a planet's id or name.

| Call | What it does |
|---|---|
| `create({ id?, planets, defaultChunkDetail?, pipelineId, worldBufferId, splitFactor?, minLevel?, triangleBudget?, cacheDir?, geocoderUrl? })` | A planet system (re-creating an id, as a hot reload does, replaces it). Each chunk mesh uses `pipelineId`, with `worldBufferId` at group 2 binding 0 and its own 24-float uniform (model matrix, tint, texture origin) at binding 1. |
| `update(id, viewer, { renderOrigin?, maxBuilds?, maxMs? })` | Streams around `viewer` within the budget (`Infinity` for everything now), places chunks relative to `renderOrigin`, and returns the stream stats (live, pending, waitingForData, triangles, splitFactor, per planet counts and depths...). |
| `sample(id, planet, direction, { wait?, spacing? })` | The ground along a direction: `terrain`, `surface`, `sea`, `rock`, `radius` (center to surface), `lat`, `lon`. Finest detail unless `spacing`; `wait` loads missing elevation tiles first. |
| `normal(id, planet, direction, step?)` / `findLandingSite(id, planet, preferred)` | Surface normal; a flat dry spot for the ship near `preferred`. |
| `info(id)` / `configure(id, { planet?, chunkDetail?, splitFactor?, minLevel?, triangleBudget? })` | Per-planet levels, vertices per level, relief and elevation tile counts; change detail (rebuilds the terrain) or LOD settings. |
| `clear(id)` / `destroy(id)` | Drop every chunk (they stream back) / the whole system. |
| `geocode(id, query)` / `placeName(id, lat, lon)` | OpenStreetMap place search (blocks for the request); the name at a coordinate once looked up in the background, else null. |

The app points its simulation at it through a `TerrainBackend` (`qp_planet.ts`), so the walker's
feet meet exactly the ground that is drawn.

## The rest of the app

- `qp_planet.ts`: the planet definitions sent to the Rust side, and the terrain queries the
  simulation uses (through a `TerrainBackend`), plus Earth's latitude/longitude helpers and
  landmarks.
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

`quadplanet_state` (mode, planet, altitude, speed, autopilot progress, on Earth `geo`: latitude,
longitude, elevation and place name; chunk counts and depth per planet, elevation tile counts),
`quadplanet_planets`, `quadplanet_config` (`fixedStep` for reproducible runs, `debugLod`,
`exposure`, `chunkDetail`, `splitFactor`, `triangleBudget`), `quadplanet_interact` (E),
`quadplanet_autopilot` (`target`), `quadplanet_goto` (`place`, or `lat` and `lon`; `mode` fly or
teleport; `keepSun`), `quadplanet_settle` (stream until nothing is pending, elevation downloads
included, up to `timeoutMs`: for reproducible captures), and `quadplanet_view` (`orbit` /
`overhead` / `follow`).

## Tests

- `cargo test --release --lib QuadPlanet` covers the terrain: cube-face seams, triangle winding
  (the engine culls back faces), watertight borders between chunks of different levels (every
  chunk outline matched bit for bit by its neighbour, on Earth to the millimeter), 2:1 balance,
  LOD selection, the triangle budget, streaming that never drops drawn ground, band limiting,
  landing sites, noise and terrain values matching the TypeScript originals, and Earth: the
  built-in tile's continents, zoom selection, bicubic continuity across tile seams, and chunks
  waiting for tiles in flight.
- `npm run test:quadplanet` (`tests/quadplanet.test.ts`) covers the simulation over a stand-in
  terrain: walking on the far side of a planet, boarding, autopilot flights to every planet and to
  a chosen place on Earth, latitude/longitude, landmarks, and the render data.
- `cargo test --release --test quadplanet_live -- --nocapture` (under `xvfb-run -a` on a headless
  box) plays `tests/features/quadplanet_live.feature` in the real window at a fixed step. It walks
  to the ship with real key presses, boards, lifts off, autopilots to Ember and walks there, takes
  orbit shots with the LOD view, flies on to Glacia, then looks at Earth from orbit and goes to
  the Matterhorn. It checks the tools' replies (planet, altitude, quadtree depth reached, the
  Matterhorn's latitude, longitude and elevation) and the captured pixels (a blue sky over green
  ground, black space between planets, orange Ember, several LOD colors, ice on Glacia, Earth's
  oceans and continents). `ENTROPY_QUADPLANET_BDD_FEATURE=<file>` plays another feature file
  instead, without rebuilding (ad-hoc captures of other places).

## Limits

- The simulation runs in world-space doubles (JavaScript numbers); only rendering is camera
  relative. A much larger system than a few thousand kilometers would still need the
  simulation itself rebased.
- The walker and ship use the analytic surface, not Rapier colliders.
- Earth: land below sea level (the Dead Sea, Death Valley, the Caspian shore, parts of the
  Netherlands) is drawn as sea, since elevation alone can't tell a depression from the ocean; an
  OpenStreetMap land/water mask would. Ice shelves read as sea (the data has the sea floor under
  them). Beyond Web Mercator's 85° the polar caps blend to one height. Imagery is not used: the
  colors are biomes from latitude and elevation.
- Earth doesn't rotate; the sun moves instead when you go somewhere (see Places).
- There are no cast shadows, and the ship lands only where the autopilot finds flat ground or
  where you set it down.
