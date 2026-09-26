# DAW sample songs

These files are standalone DAW project JSON files. The DAW bundles them as templates: open **Songs**, choose one under **New song from** and click **Create**. That makes a new song in your library (see [the song library docs](../../../docs/DAW_SONG_LIBRARY.md)); the song you were working on is left as it was.

| File | Style | Arrangement |
| --- | --- | --- |
| `neon-tide-edm.json` | EDM, 128 BPM | Rising Phys Mod violins, a sparse drum break, and two drops |
| `afterhours-house.json` | House, 122 BPM | Four-on-the-floor drums, Phys Mod cello chops, and a sparse breakdown |
| `lowlight-hip-hop.json` | Hip hop, 92 BPM | Half-time drums, a drum-led breakdown, and a returning hook |
| `the-beacon-cinematic.json` | Heroic score, 104 BPM | D-minor string ascent, horn calls, and a trumpet-led finale |
| `shadow-passage-cinematic.json` | Suspense score, 88 BPM | Restless violas, muted horn questions, and a low-brass reveal |
| `homeward-light-cinematic.json` | Reflective score, 76 BPM | Lyrical violin, warm cello and viola, and a chorale horn farewell |
| `event-horizon-trap.json` | Cinematic trap, 144 BPM, D minor | Bell motif, half-time sub groove, 32nd-note hat rolls, violin answers and horn arrivals |
| `black-glass-suspense.json` | Suspense, 108 BPM, E Phrygian | Uneven clock pulse, col legno cello, viola answers and a low trombone reveal |
| `ion-runner-synthwave.json` | Synthwave, 118 BPM, F# minor | Saw theme and bass, square arpeggios, triangle answers and a wide wavetable finale |
| `velvet-switch-funk.json` | Funk, 106 BPM, C Dorian | Syncopated triangle keys, swung hats, square bass, cup-muted trumpet and trombone punches |
| `first-light-electronica.json` | Melodic electronica, 124 BPM, A major | Bell theme, warm keys, violin answers, pumping wavetable chords and horn lift |

All sounds use built-in voices and pads; no external samples or plugins are needed. To rebuild the JSON after changing the arrangements, run `node sample-songs/generate.mjs` from `examples/studio-bundle`.

## Listening guide for the five new songs

Each new song is 64 bars (about 1:47 to 2:25), with 9-11 tracks and named four-bar phrases. The six earlier templates remain 32 bars. New arrangements are authored in `generate-showcase.mjs`; it also runs as part of the main generator.

- **Bars 1-8:** introduce the song's sound and fragments of its theme.
- **Bars 9-24:** establish the groove, add motion, then leave a one-beat pause at the end of bar 24.
- **Bars 25-32:** first full arrival, with Matter cymbals and a second melodic voice.
- **Bars 33-40:** breakdown with contrasting harmony and exposed melodic fragments.
- **Bars 41-48:** rebuild, with a second pause before the finale.
- **Bars 49-60:** full return with a countermelody, wider chords and Matter tom fills.
- **Bars 61-64:** tonic coda and room for decay. Black Glass deliberately leaves a final Phrygian semitone hanging.

The two pauses use saved bus cuts, including effect tails. The keys are synthesized triangle patches, not sampled pianos. Synthwave intentionally emphasizes oscillator and wavetable voices; the other pieces pair them with modeled strings or brass. Matter provides physical cymbal and tom accents alongside the electronic drum rack.

## Verification

`npx vitest run tests/daw_sample_songs.test.ts tests/daw_songs_bdd.test.ts --pool=threads` checks all eleven templates through the production picker, library persistence, note/clip bounds, brass ranges, section contrast and the new songs' production export payloads.

To render four-bar finale previews with the actual Rust audio engine, set `ENTROPY_SHOWCASE_FIXTURES` to an absolute scratch folder, run the sample-song Vitest suite, then run `cargo test --release --test daw_showcase_audio -- --ignored --nocapture` from the engine root with the same variable. The optional native test reads those payloads, creates the wavetable presets, uses the production note converters and mixer, writes `<bpm>-finale.wav`, and checks audible output and headroom. It covers bars 49-52, not a full-song listening or live playback review.
