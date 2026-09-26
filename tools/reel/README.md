# Entropy DAW reel

A 15-second, 1080p60 showreel for Entropy DAW's physically modelled instruments. Nothing in it is
recorded or keyframed by hand from the outside in:

- **Every sound is played by the engine's physical models**: seven brass players (trombones,
  horns, trumpets, tuba), three bowed strings (violin, cello, double bass) and the drum kit with
  its cymbals, from `src/audio/brass`, `src/audio/physmod` and `src/audio/matter`, compiled
  unmodified. No samples. (The snare's and cymbals' "sampled high band" is a statistical sample of
  *modes*, not recorded audio.)
- **Every instrument on screen is drawn from the model's own state** at that frame, the way the
  DAW's views draw it: the air column's pressure along the bore, the lips opening and closing, the
  slide and the valves, each string's real displacement and the bow's regime, each drum head's and
  cymbal's displacement field, the measured contact of every strike, the resonance ladder and the
  playing map. The views are ports of `BrassView`, `PhysModView` and `MatterView`
  (`src/entropy_gui/widgets_brass.rs`, `widgets_physmod.rs`, `widgets_matter.rs`), in their palette.

## How it is made

| Step | Where | What |
|---|---|---|
| Play and record | `exporter/` (Rust) | Plays the score on the models; writes one stem per part, 60 fps telemetry (`telemetry.json`), the mix (`mix.wav`: a convolution hall and a look-ahead limiter) and the mix's level and spectrum per frame (`mix_env.json`). |
| Draw | `renderer/` (Canvas 2D + WebGL 2) | `instruments.js`: the three views and the Physics View panels. `scenes.js`: the timeline. `post.js`: bloom, chromatic aberration, grain. Deterministic: any frame renders on its own. |
| Capture | `renderer/capture.mjs` | Headless Chromium renders the frames (in parallel workers); ffmpeg encodes them with the mix. |

```sh
# 1. Play the score (under a minute on 4 cores). Writes tools/reel/out/.
cd tools/reel/exporter
cargo run --release -- ../out

# 2. Render and encode (10-15 minutes with 3 workers on 4 cores, software WebGL).
cd ../renderer
npm install
node capture.mjs video ../out/entropy-daw-reel.mp4 ../out/mix.wav 3

# Stills of any frames, for review:
node capture.mjs stills ../out/stills 150 450 750
```

Needs Rust, Node, ffmpeg with libx264, and a Chromium that Playwright can launch (headless WebGL 2
through SwiftShader is enough).

## The score (120 BPM, B-flat minor to B-flat major)

| Time | Picture | Sound |
|---|---|---|
| 0.0 - 2.5 s | The lips' equations; the tube builds from the mouthpiece as the camera pulls back. *This is not a sample.* | One trombone breath, 0.8 to 15 kPa: the wave in the bore steepens into a shock (the readout is the model's own). Bass, a yarn-mallet cymbal roll and a floor tom roll swell with it. |
| 2.5 s | *It's physics.* | Low brass hit, open fifth; kick, floor tom, crash. |
| 3.0 - 5.0 s | One tube morphing trombone, trumpet, horn, tuba on the stabs. | Brass stabs; cello ostinato; drums. |
| 5.0 - 7.0 s | The violin: string shapes, the Helmholtz corner, the bow's regime, the playable window. | Violin melody. |
| 7.0 - 9.0 s | The kit, cut on the hits; each strike's measured contact. | Kick, snare wires, toms. |
| 9.0 - 10.5 s | The crash's bending field and its modes. | Crash (von Karman couplings), splash, ride. |
| 10.5 - 12.33 s | Physics View: the slide travelling 7th to 1st position, the resonance ladder, the playing map; then everything at once. | A trombone smear B2 to F3 on one partial; the section swells on F with a snare roll. |
| 12.5 - 15 s | The string takes the shape of the trombone's pressure wave; *Entropy DAW*. | Tutti B-flat major. |

`exporter/src/tubing.rs` is copied from `widgets_brass.rs` (the tubing laid out from the bore);
keep it in step if the view changes. Fonts: Figtree from `src/fonts/figtree`, JetBrains Mono
(SIL OFL, `renderer/fonts/OFL.txt`).
