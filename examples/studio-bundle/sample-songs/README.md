# DAW sample songs

These files are standalone DAW project JSON files. The DAW bundles them as templates: open **Songs**, pick one in the **New song** browser (grouped into collections, with a search and a write-up of each song) and click **Create**. That makes a new song in your library (see [the song library docs](../../../docs/DAW_SONG_LIBRARY.md)); the song you were working on is left as it was.

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
| `folded-city-score.json` | Film score: dream thriller, 64 BPM, E minor | Glass-harp "totem", blazing tuba and trombone blasts, octobass drone, a viola ostinato and a hard cut |
| `tidewater-signal-score.json` | Film score: island mystery, 66 BPM, A minor | Surf, a glass-harp lullaby, glass violin, pizzicato basses, trombone glissandi and hollow-metal Matter hits |
| `ashen-crown-score.json` | Film score: fantasy epic, 92 BPM, D Dorian | A 3+3+2 cello gallop, a Hardanger fiddle theme, low mallet war drums and the full brass section |
| `rooftop-pursuit-score.json` | Film score: action chase, 140 BPM, F minor to F# minor | Col legno ticks, spiccato violins, a rock kit played like taiko, rough trombone stabs and drainpipe drips |
| `lanterns-over-the-sound-score.json` | Film score: end credits, 76 BPM, D major | A brook, glass-harp arpeggios, a hymn from solo cello to tutti, a muted distant trumpet |

Every drum part is played by the Matter physically modeled kit (the old drum rack is gone from the samples). Matter has no hi-hat, so hat parts play on the ride at low velocity and claps on the snare edge. All sounds use built-in voices; no external samples or plugins are needed. To rebuild the JSON after changing the arrangements, run `node sample-songs/generate.mjs` from `examples/studio-bundle`.

## Listening guide for the five new songs

Each new song is 64 bars (about 1:47 to 2:25), with 9-11 tracks and named four-bar phrases. The six earlier templates remain 32 bars. New arrangements are authored in `generate-showcase.mjs`; it also runs as part of the main generator.

- **Bars 1-8:** introduce the song's sound and fragments of its theme.
- **Bars 9-24:** establish the groove, add motion, then leave a one-beat pause at the end of bar 24.
- **Bars 25-32:** first full arrival, with Matter cymbals and a second melodic voice.
- **Bars 33-40:** breakdown with contrasting harmony and exposed melodic fragments.
- **Bars 41-48:** rebuild, with a second pause before the finale.
- **Bars 49-60:** full return with a countermelody, wider chords and Matter tom fills.
- **Bars 61-64:** tonic coda and room for decay. Black Glass deliberately leaves a final Phrygian semitone hanging.

The two pauses use saved bus cuts, including effect tails. The keys are synthesized triangle patches, not sampled pianos. Synthwave intentionally emphasizes oscillator and wavetable voices; the other pieces pair them with modeled strings or brass. Matter provides the whole kit, with physical cymbal and tom accents.

## Film scores: physically modeled only

The five `*-score.json` cues are the **Film scores** collection. Every track is a physically modeled instrument - bowed strings (violin, viola, cello, bass, and the Hardanger fiddle, glass violin and octobass), brass (horn, trumpet, trombone, tuba), the Matter kit and Water - with no oscillators, wavetables, samples or drum-rack voices. They are meant to be opened up and learned from:

- **Sections as patterns.** Each track has one pattern per section, named after it ("The kick", "The hatch", "Winter march"), so the arrangement reads like a cue sheet.
- **Orchestration by track.** Section strings are separate tracks (violins, violas, cellos, basses), mostly one line each: overlapping notes slur on a bowed string or a brass player, simultaneous ones double-stop.
- **Playing styles as settings.** Blazing and rough brass, glissando trombones, chorale horns, a straight-muted trumpet, pizzicato and col legno strings, mallets and yarn on Matter - all saved on the track, so opening the instrument window shows how.
- **Space and humanize.** Each bus has the Space knob set for a hall, and strings have a little Humanize.
- **Hard cuts.** Folded City, Tidewater Signal and Rooftop Pursuit use saved bus cuts for silences that stop reverb tails too.

They are written in `generate-film-scores.mjs`, in pitch names and absolute bar positions, which `generate.mjs` also runs.

## Verification

`npx vitest run tests/daw_sample_songs.test.ts tests/daw_songs_bdd.test.ts --pool=threads` checks all sixteen templates through the production template browser, library persistence, note/clip bounds, brass ranges, section contrast and the new songs' production export payloads.

To render four-bar finale previews with the actual Rust audio engine, set `ENTROPY_SHOWCASE_FIXTURES` to an absolute scratch folder, run the sample-song Vitest suite, then run `cargo test --release --test daw_showcase_audio -- --ignored --nocapture` from the engine root with the same variable. The optional native test reads those payloads, creates the wavetable presets, uses the production note converters and mixer, writes `<bpm>-finale.wav`, and checks audible output and headroom. It covers bars 49-52, not a full-song listening or live playback review.

The Film scores render whole: set `ENTROPY_FILM_SCORE_FIXTURES` to an absolute scratch folder, run the sample-song Vitest suite, then `cargo test --release --test daw_film_score_audio -- --ignored --nocapture`. It writes `<slug>.wav` for each cue, with its hard cuts, and prints each one's peak, RMS and loudness in four-bar windows.
