# Material Lab and shared parallax materials

`examples/studio-bundle/src/materials/` is a small shared module any addon can use to put the PBR
sets in `assets/materials/<set>/` (basecolor, normal, roughness, height, metallic) on its own mesh
pipeline, with parallax occlusion mapping (POM) from the height map. The Material Lab
(`src/apps/material_lab/`, `cargo run --bin example --release -- material-lab`) is a bare wall for
working on it and the template for plugging it in.

## API

`materials/pbr_sets.ts`

- `PbrSet { name, tile, depth }`: folder name, meters per repeat, relief depth in meters.
- `materialLayout({ base = 2, metallic, group = 2, prefix })`: bindings for the five maps and the
  repeat sampler (`entries` for the pipeline's bind group, `bindings` for each mesh).
- `loadMaterialSets(sets, Entropy.Texture.loadArray, layout)`: one mipmapped texture array per map,
  a layer per set; returns the `set/map` names that fell back to the checker/neutral layer.
- `setTablesWgsl(sets)`: WGSL `POM_TILE` / `POM_DEPTH` arrays indexed by layer.

`materials/pom.ts`

- `pomDeclarations(layout)` + `POM_WGSL` (or `pomTracer({ height, sampler })` when the shader
  already declares its own texture and sampler names): `pom_frame` (tangent frame from screen
  derivatives, no tangent attribute needed) and `pom_trace`.
- `PomSettings` and presets: `POM_CLASSIC` (the old 8-24 step tracer with one secant guess),
  `POM_REFINED` (16-48 jittered steps, 6 binary-search iterations, height blur 2), `POM_FULL`
  (refined + 16 self-shadow samples + depth write), `POM_ULTRA` (the lab's reference, far too slow
  to ship). `packPomSettings` fills the 12-float uniform; `pomSettingsWgsl` makes a constant.

`lab_shader.ts` shows the whole pattern: frame, view and light rays in tangent space, one
`pom_trace` call, maps sampled at the hit, and the shaded point moved down the view ray so
`frag_depth` follows the relief.

## Lab tools (MCP)

`lab_config` (material, left/right mode off|classic|refined|full|ultra with `leftOptions` /
`rightOptions`, sun, exposure, depthScale, fadeNear/fadeFar, pole), `lab_view` (distance, yaw,
pitch, x, y, fov), `lab_state`.

## Tests

`cargo test --release --test material_lab_live -- --nocapture --test-threads=1` plays
`tests/features/material_lab_live.feature` and writes captures plus `scores.txt` under
`test-artifacts/material-lab-*`. It scores classic and refined against the ultra reference (mean
absolute error per channel, 0-255) for fieldstone at three poses and for every material at a slant,
and checks that writing depth changes where a pole piercing the wall meets the relief.
`ENTROPY_MATERIALLAB_BDD_FEATURE=<path>` plays another feature without rebuilding.
`npm run typecheck:material-lab` typechecks the module.

## Notes

- Uniform writes need a `Float32Array`: a plain `number[]` is taken as raw bytes (the lab rendered
  black until that was fixed).
- Smoothing the height the rays march through (`smooth`) trades exactness for fewer streaks along
  steep faces; the score against ultra is higher with it on by design.
- Allegiance (`games/allegiance/al_materials.ts`) uses the refined tracer without shadows or depth
  write; its own log depth and sun shadows are not wired to the relief yet.
- Nothing here has been run in the browser (WASM) build. The WGSL is plain fragment code
  (`textureSampleGrad`, uniforms, no storage textures), but that is unverified.
