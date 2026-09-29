# QuadPlanet

QuadPlanet (`cargo run --bin example --release -- quadplanet`, after `npm run build-quadplanet`
in `examples/studio-bundle`) is the QuadScape quadtree terrain turned into planets you can walk
on, with a ship to fly between them. It is an ordinary addon app: all of it is TypeScript in
`examples/studio-bundle/src/apps/quadplanet/`, drawing through `Entropy.Model.createMesh` and one
custom WGSL pipeline.

![Verdant from orbit](../public/quadplanet-verdant-from-orbit.png)

## From QuadScape to a planet

QuadScape (`src/heightfield_landscapes/QuadTree.rs` and `QuadScape.rs`) streams one flat
heightfield: a quadtree over the map, a tile's level of detail chosen by its distance to the
viewer (`LOD_RINGS`), and a per-frame diff of the tiles it wants against the live ones. New tiles
are built and uploaded, stale ones dropped. QuadPlanet keeps that loop and changes what it runs
on:

| QuadScape | QuadPlanet (`qp_quadtree.ts`) |
|---|---|
| One quadtree over a heightmap | Six quadtrees, one per face of a cube, every grid point pushed onto the sphere (the spherified-cube mapping keeps cells close to equal-area) and out by the terrain height |
| Four fixed LOD rings | A node splits while the viewer is closer than 1.5x its own size, down to a level where a leaf cell is about 1 m (level 7 on Verdant, 6 on Ember and Glacia), so detail follows you continuously from orbit to the ground |
| Heights from a u16 heightmap | Heights from seeded 3D noise sampled on the unit sphere (`qp_planet.ts`), so there are no seams at cube edges and nothing pinches at the poles |
| Coarse LODs read an averaged mip pyramid | Coarse chunks sample band-limited noise: octaves finer than ~3 samples of the chunk's spacing are faded out. It is the same idea in frequency, and it is what keeps coasts and limbs from aliasing into spikes from orbit |
| Tile borders pinned to full-res samples | Neighbours can differ by several levels and meet across cube edges, so every chunk hangs a skirt under its edges that fills any sliver |
| Tiles outside `VIEW_RADIUS` dropped | Chunks below the horizon are skipped, counting how far past it the highest peak still shows |
| Stale tiles dropped the same frame | A stale chunk stays until every wanted chunk overlapping it is built, so streaming never opens a hole |

Each chunk is a 17x17 vertex grid plus its skirt. Standing on Verdant that is about 270 chunks
(some 230k triangles) for the planet under you and about 20 each for the other two. Building is
bounded per frame (10 chunks or 12 ms), closest first.

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
| W / S walk, A / D turn, Shift run, Space jump | W thrust, Shift boost, S brake, A / D yaw, arrow keys pitch, Space / C climb and sink |
| E board (within 9 u of the ship) | E step out (landed), T autopilot to the next planet |

Drag to orbit the camera, scroll to zoom. L tints every chunk by its quadtree level and outlines
it. V toggles an orbit view of the nearest planet.

## MCP tools

`quadplanet_state` (mode, planet, altitude, speed, autopilot progress, chunk counts and depth per
planet), `quadplanet_planets`, `quadplanet_config` (`fixedStep` for reproducible runs, `debugLod`,
`exposure`), `quadplanet_interact` (E), `quadplanet_autopilot` (`target`), and `quadplanet_view`
(`orbit` / `follow`).

## Tests

- `npm run test:quadplanet` (`tests/quadplanet.test.ts`) covers the pure tier: cube-face seams,
  triangle winding (the engine culls back faces), skirts, LOD selection, streaming that never
  drops drawn ground, band limiting, landing sites, walking on the far side of a planet, boarding,
  and autopilot flights to every planet.
- `cargo test --release --test quadplanet_live -- --nocapture` (under `xvfb-run -a` on a headless
  box) plays `tests/features/quadplanet_live.feature` in the real window at a fixed step. It walks
  to the ship with real key presses, boards, lifts off, autopilots to Ember and walks there, takes
  orbit shots with the LOD view, then flies on to Glacia. It checks the tools' replies (planet,
  altitude, quadtree depth reached) and the captured pixels (a blue sky over green ground, black
  space between planets, orange Ember, several LOD colors, ice on Glacia).

## Limits

- Positions are world-space `f32`, fine for this system (planets within about 10,000 units of the
  origin). A much larger system would need camera-relative rendering.
- The walker and ship use the analytic surface, not Rapier colliders.
- There are no cast shadows, and the ship lands only where the autopilot finds flat ground or
  where you set it down.
