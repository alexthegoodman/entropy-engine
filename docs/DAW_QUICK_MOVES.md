# DAW quick knobs and moves

The DAW has two panels for working fast: **Character**, seven knobs on the selected track, and
**Moves**, one-click edits to a pattern or to the arrangement. The chat can use both too, through
the `daw_character` and `daw_move` tools.

## Character knobs

Each knob runs from 0 (off) to 1. None of them changes your notes. Every knob is saved with the
track and sounds the same in playback and in **Export Song to WAV**.

| Knob | What it does | How |
| --- | --- | --- |
| **Pump** | Beat-synced volume ducking. Low settings breathe a little; high settings give the deep house pump. | A bus effect: the level drops on every beat and recovers along a curve. Higher settings make the duck deeper and the recovery longer. Its clock follows the song: it is re-anchored on Play, on a seek, on a tempo change and once a bar. |
| **Bounce** | A deliberate groove for house hats, garage percussion and basslines. | Offbeat sixteenths are pushed late (up to a 66% swing) and played softer. Offbeat eighths are accented and laid back a little. The groove is the same every bar. |
| **Gate** | Chops chords and pads into rhythmic pulses. The knob sets the depth. | A bus effect with a pattern picker: straight eighths, sixteenths, or a syncopated 3+3+2 figure. The gate opens in 1 ms and closes in 5 ms, so it does not click. |
| **Acid** | Filter cutoff, resonance, filter envelope and drive moved together. | The knob writes the track's cutoff and resonance, so those sliders follow it, and gives each note a filter envelope and tanh drive. The ranges are tuned so most of the knob's travel is usable. At 0, the track gets back the cutoff and resonance it had before. Only the built-in oscillators (sine, square, saw, triangle, noise) have the envelope and drive. |
| **Grit** | Saturation first, then rougher digital texture. | A bus effect: tanh drive, then (past about a third of the knob) bit reduction and sample-rate reduction. Output is compensated to match the input's loudness, so turning Grit up does not simply make the track louder. |
| **Space** | Moves a sound from close and dry to distant and washed out. | A bus effect: less direct sound, more reverb, and less top end on both. Low end is also trimmed from the direct sound as it moves away. |
| **Humanize** | Small differences in timing and velocity. | Every note that plays gets a small nudge in time (up to about 15 ms at 120 bpm) and in velocity. The nudge depends on the note and its place in the song, so a loop's repeats differ, but every playthrough and the export are identical. Downbeats move half as much. |

Pump, Gate, Grit and Space work on every kind of track: built-in synths, drum pads with samples,
wavetable and bowed-string tracks, and hosted VST3 instruments. They run after the track's delay
and reverb, in the order Grit, Gate, Space, Pump. A knob at 0 takes its effect out of the chain,
so an untouched track costs nothing.

## Moves

Every move can be undone with **Undo** in the Moves panel. The last 20 moves are kept.

### On the pattern in the piano roll

- **Make Variation**: keeps the anchors (downbeats, the first and last notes of the phrase, and
  kicks on the beat) and revises the rest. **Amount** sets how much. **Vary** sets what:
  - *Rhythm*: nudges, drops, echoes and ghost notes.
  - *Notes*: moves pitches to nearby scale degrees. On a drum track it reshapes accents instead,
    so a kick never turns into a snare.
  - *Fill*: rewrites the last beat as a fill.
  - *Mixed*: rhythm and notes, plus a fill at high amounts.

  Each press gives a different variation. Tick **As new pattern** to keep the original.
- **Thin Out**: removes the weakest notes (off the strong beats, quiet, short) and keeps the
  downbeats and phrase anchors. **Amount** is the share of removable notes that go. Use it to make
  a verse or breakdown from a busy chorus.
- **Stutter**: rewrites the last beat as its first slice repeated every 1/8, 1/16 or 1/32 note,
  getting louder toward the end. If the last beat starts empty, the last notes played before it
  repeat instead. This works on MIDI notes; audio slicing is not done yet.
- **Octave Spark**: adds up to three short octave-up notes on free offbeats in the last half-bar
  of a bass or lead. Strong notes keep their timing and length.
- **Kick Lock**: finds the kick under the bassline and shortens every bass note still ringing when
  a kick hits. With **Align attacks** ticked, it also moves a bass note that starts one step off a
  kick onto the kick. It opens a **preview** first: the proposed notes show in the piano roll and
  play, with a list of what changed. Press **Apply** or **Cancel**; painting a note also applies.

### In the arrangement

Build and Drop Gap work at a section boundary: the bar line nearest the playhead. Click the
ruler on the first bar of the new section first. Echo Out and Answer work on the selected clip.

- **Build**: writes an accelerating drum roll into the 2 or 4 bars before the boundary, on the
  active drum track (or the first one). The roll goes quarters, eighths, sixteenths, then
  thirty-seconds, with velocity rising all the way. The kick carries on underneath except in the
  last bar. **Filter sweep** opens the roll's filter as it rises. This only affects built-in drum
  voices; a sample pad rises in level only.
- **Drop Gap**: clears the last beat or half-bar before the drop, on the drums or on everything.
  With **Keep tails** ticked, notes already sounding and delay and reverb tails ring into the gap.
  Without it, the tracks are silenced outright. That hard cut is listed in the panel, where you
  can remove it, and it also applies to the export.
- **Echo Out**: repeats the selected clip's last beat or half-bar through one bar after the clip.
  Each repeat is quieter and darker than the one before, which is useful as a transition.
- **Answer**: makes a short response from the selected phrase's own notes:
  1. It keeps the first half of the phrase.
  2. It plays that half's pitches in reverse order.
  3. It ends on the note the phrase started on.
  4. It moves the answer an octave: down when the phrase sits high and there is room, up
     otherwise.

  The answer goes after the phrase. If the clip loops its phrase, the answer replaces the second
  pass.

Moves that place a pattern clear the span they need on that lane. A clip that gets cut on its left
keeps playing its pattern from where it was (the clip's `offsetSteps`) rather than restarting it.

## Under the hood

- `examples/studio-bundle/src/apps/daw_moves.ts` holds every rule: the knob mappings, `grooveAt`
  (Bounce and Humanize) and the moves. It is pure TypeScript, tested by
  `tests/daw_moves.test.ts` and, through the real addon, by `tests/features/daw_moves.feature`.
- `src/audio/character.rs` has the Pump, Gate, Grit, Space and Fader DSP, with unit tests. The
  live bus and the offline export run the same structs. For the export, `render_mix_to_wav` sums
  each track's events on its own bus, then runs the chain, the track's gain and any hard cuts.
- Notes can now carry `offset` (fractions of a step, for 32nds and grooves) and `tone` (a
  multiplier on the track's cutoff, for Build's sweep and Echo Out's fade). The sequencer queues
  each step half a step early and fires each note at its exact time, so Humanize can play a note
  early as well as late.
