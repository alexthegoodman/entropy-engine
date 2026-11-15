# World of Music

A third-person swarm-directing game on a tropical planet whose people see no color - they see
music. Agent Tom, from the World of Color, arrives through a one-way wormhole with three swarms
of three Tones each, answering signals caught on the Link that joins 1,001 dimensions, and
purifies the Red Corruption island by island. At the end the Link announces they are coming to
get him.

```bash
cd examples/studio-bundle && npm run build-world-of-music && cd ../..
cargo run --bin example --release -- world-of-music
```

Code: `examples/studio-bundle/src/games/world_of_music/`. Saves: `../world-of-music-data`.

## Color is a language

Every scene is black, white and grey, cel-shaded in three flat bands with ink hatching in
shadow and ink outlines. Color never restores; it only ever means one thing:

| color | means |
|---|---|
| red | the Red Corruption and nothing else (creatures, hearts, anchors, veins) |
| magenta | fruit: food for Tones |
| amber | relics: sell them for chimes |
| teal | mechanisms: switches, gates, levers, portals, climbable cliff rungs |
| a Tone's hue (azure, lemon, lime, violet) | that Tone and its music |
| white light | the music of the people who live here |

Music is visible: every chirp, instrument note and pipe note sends a pulse of its color racing
out through a web of veins in the ground (a Voronoi network in the terrain shader). Corrupted
ground turns to ink and its veins beat red.

## The look

- `wom_shader.ts`: TOON (banded light, hatching, chroma, veins, corruption), INK (inverted hull,
  back faces only), GLOW (additive notes, sparks, bolts, rings), and the SCREEN pass.
- The screen pass is the dreamy haze: a depth of field focused on Tom (24-tap golden-angle disc,
  weighted so sharp foreground does not smear), bloom from colored light only, a pale haze with
  distance, ink lines where depth breaks, grain and vignette. `P` toggles it.
- It runs through a new engine call, `Entropy.Screen.setEffect({ pipeline, buffers })`
  (`src/core/render_addon_frame.rs`, after composites and before the gizmo and UI): the frame is
  copied, then a `form: "composite"` pipeline reads the copy and the depth buffer. Depth is
  written as `w / (w + 60)` so the pass recovers distance exactly.

## Playing

- Point and click: the selected swarm goes and does the obvious thing at the pointer (attack,
  break a crate, shake a fruit tree, sit on a switch, climb to a lever, walk a portal, sing at a
  heart or anchor, revive a fallen Tone). Then the next swarm with a Tone standing is selected,
  so the next click sends it. Tab / 1-8 choose; right click recalls; `V` divides a swarm of six.
- Tones eat fruit; every three fruit a swarm eats, its best-fed Tone splits in two (up to 12).
- A fallen Tone lies as a grey ghost note for 20 s; Tom or its swarm standing by revives it.
  After that it passes away.
- Relics are carried home by Tones and sold at Bodhi's stall (koala, marimba); chimes buy
  traits per swarm: Brawn, Blaster, Climbing Claws, Wings, Phase, Heft, Resonance, Tempo,
  Harmony - so swarms come in many permutations. The stall also hatches new swarms (max 8).
- Puzzles: switch plates need weight (Heft doubles a Tone), climbable teal cliffs need claws,
  teal rings need Phase, deep water needs Wings.
- Friends play instruments (marimba, flute, handpan, drum, kalimba). Hoolu (owl) and Clatter
  (crab) jam: listen to a phrase, echo it on the Prism Pipe (`F`, then 1-5). Hoolu teaches the
  Gathering Song (`G`): every swarm comes home and heals.
- Islands: Landfall Cove (switches, a claw-only lever, Gloomtusk 6x Tom's size), Canopy Falls
  (portals, a phasing-only switch), The Red Caldera (The Red Maw, 10x). Bosses are shielded
  by anchors that must be sung pure first, and slam red rings you jump.

## Enemies think with WIR

Corrupted creatures run Yumon Pet's WIR tactical networks (`yumon-pet/docs/WIR.md`, "Tactical
enemies"): programs compiled to ReLU weights and proven exact against their rules. Smudges use
the grunt brain, Thornbacks the rusher, Spitters the sniper.

`wom_wir.ts` lays a 1.5 m grid over each corrupted patch. Every 0.3 s: exposure from what the
friends (Tom and the Tones) can see; two distance fields from the WIR 8-move path-step stencil
(to the nearest friend, ally cells costing 3; and to cover); the WIR senses stencil at each
enemy's cell; then its brain picks one of 8 headings or hold, fire and reload. The game moves
the creature smoothly to that neighbor cell. The plain rules are in the file too, and
`wom_config {check: true}` (and the tests) compare every field cell, sense vector and decision
against them.

Weights come from `cargo run --release -- tactics --export ...` in `yumon-pet/wir`, imported by
`node tools/wom_import_wir.mjs <tactics_demo.json>` into `wom_wir_data.ts`.

## Tests

- `npm run test:world-of-music` (in `examples/studio-bundle`): islands (every puzzle needs the
  swarm it was built for), the simulation (orders and auto-select, crates and relics, fruit and
  splits, revive window, both switch puzzles, the claw lever, the portal, the stall, clearing a
  patch, the campaign), WIR networks vs rules (random inputs and a live arena), render packing.
- `xvfb-run -a cargo test --release --test world_of_music_live`: three scenarios through the real
  window (tests/features/world_of_music_live.feature), 18 captures.
