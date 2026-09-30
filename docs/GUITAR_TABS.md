# Guitar Tabs

**Status:** v1, 2026-09-30 · Built on [Guitar-to-MIDI](GUITAR_TO_MIDI.md) · Nothing here has been played on a real guitar yet (see [Not yet checked](#not-yet-checked))

Guitar Tabs is an Entropy app for learning a tab by playing it. You paste an ASCII tab, check it in a
spreadsheet, then play along while a neon fretboard shows where your fingers go and Guitar-to-MIDI
checks every note you play.

```bash
cd examples/studio-bundle && npm install && npm run build && npm run build-guitar-tabs && cd ../..
cargo run --bin example -- guitar-tabs
```

It is also in the App Launcher. Everything is saved as you go (the pasted text, the reviewed song,
the guitar and practice settings) under `../guitar-tabs-data`.

![Guitar Tabs practising a chord change](../public/guitar-tabs-practice.png)

## 1. Paste

Paste with **Ctrl+V** in the box or with **Paste from clipboard**, or pick one of the examples. The
reading is shown straight away: how many steps, bars and systems, the tuning and tempo, and anything
that could not be read.

What it reads:

- Systems of six lines, highest string on top (`e|---0---|`). A tab written lowest string first is
  recognised by its string names (`E` on top, `e` at the bottom) and turned the right way up.
- The tuning from the string names (`D A D G B e` is Drop D, each string in the octave nearest standard
  tuning), or from a line like `Tuning: DADGAD` or `Drop D` when the strings are not named.
- `Tempo: 90` or `90 bpm`. The first short line of text before the tab is the title.
- Frets of one or two digits, aligned left or right in a chord (a `10` over a `9` is one chord).
- Bar lines. Bars that hold nothing are dropped and the rest numbered from 1.
- `x` for a muted string, shown but never graded.
- A technique after a fret (`h p b r / \ ~ s`) is kept for display. `0h2` is two steps: the 0, then
  the 2.
- `let ring` on a line above a system plays that system in chord mode.
- Annotation rows (`PM----|`) above the strings do not break a system apart.

**Timing comes from spacing.** Notes in the same column are one step. The distance to the next step is
its length in beats: the columns per beat come from the bar widths (most tabs write a 4/4 bar in 16
to 32 columns), and lengths are rounded to quarter beats between 1/4 and 4. Bar lines take a column
of text but no time. ASCII tab has no real rhythm notation, so check the Beats column in Review when a
song has one.

## 2. Review

The song as a spreadsheet, one row per step: step, bar, beats, the six strings (highest first, as the
tab reads), the notes they make, and how the step is listened to. Double-click a cell, or select it
and type:

| Column | Takes |
| --- | --- |
| A string | a fret (`7`), a fret and technique (`5h`), `x` for muted, or nothing |
| Bar | a whole number from 1 |
| Beats | a length above 0 (0.5 is an eighth note in 4/4) |
| Play as | `auto`, `pick` or `chord` |

Typing in the empty row after the last step adds a step; right-clicking a row number inserts or
deletes one. A step that asks for two notes on one string is shown in red. The title, tuning and tempo
sit above the grid, **Copy as tab** puts the song (edits included) back on the clipboard as ASCII tab,
and the neck below previews the selected step, with **Hear it** to sound it.

## 3. Practice

The neck shows three things at once:

- **The highway**, a tab staff scrolling toward a "now" line: every step's fret numbers on their strings,
  amber for now, blue for waiting, teal once hit, violet when partly played, rose when missed. Chord
  names sit over the columns and bar lines cross the staff.
- **Where the fingers go**: amber dots with the suggested finger in them (1 index to 4 little), rings
  at the nut for open strings and an X for muted ones. The next notes are numbered ghost rings.
- **What the guitar is heard playing**: teal dots for notes the step wants, rose with the note name for
  ones it doesn't, and their strings vibrate.

Three ways to play:

| Mode | What happens |
| --- | --- |
| **Own pace** | The cursor waits on each step until you play it. Wrong notes are counted, never fatal. **Skip** moves on (the step counts as missed). |
| **Real time** | A count-in, then the song runs at its tempo times the Tempo slider (25 to 150%). A step is hit when its notes land within 160 ms early to 220 ms late (never more than half the gap to the neighbouring steps); a step that passes unplayed is missed, one with only some of its notes is partly played. The guide synth plays each step as it comes, and the metronome can click the beats. |
| **Listen** | The song plays itself on the guide synth, with the highway and neck moving, so you hear what the tab sounds like first. |

**From bar / to** practises a range and **Loop** repeats it. The score line shows hits, partly played,
missed, wrong notes, the current and best streak, accuracy, and in Real time the mean timing error.
Space starts and pauses; H sounds the current step.

**Sound.** Two synths: the *guide* (a soft plucked saw on its own bus, with its own volume) plays the
tab, and *Hear my guitar through the synth* routes what Guitar-to-MIDI hears to the built-in voice,
so an unplugged electric or a quiet room still sounds. With a guitar amp in the room, turn the guide
down: the guitar input only hears the guitar, but you have to hear it too.

**No guitar?** Click the neck. The note sounds and counts exactly as if the guitar had played it, so a
lesson can be tried, and the app tested, with a mouse.

**The guitar input** card picks the audio input, starts and stops it, and calibrates the gate against
the room (the same settings as the DAW's Guitar Input panel, see GUITAR_TO_MIDI.md section 3.1).

## How playing is checked

Knowing what the tab expects makes the check far more reliable than open transcription (GUITAR_TO_MIDI.md
section 12). For each step the question is "is each of these notes there?":

- **Onsets.** Each frame the app reads `Guitar.status()`. A note is *fresh* when it joins the sounding
  set, or when the engine counted a new Note On while the same note kept sounding (a re-pick). Pick
  mode plays a hammer-on, pull-off or slide as pitch bend on the note already sounding, with no new
  Note On, so the detected pitch is watched too: when it settles within 30 cents of a new note while a
  note sounds, that note is fresh.
- **Single notes** must match exactly.
- **Chords** are gathered over several readings (strummed strings arrive one after another). With
  *Lenient chords* on (the default), a chord of three or more notes counts as played when its bass
  note and every pitch class are heard: those are the reliable part of chord detection, while octave
  doublings hidden in a lower string's partials are best effort. Off, every note must be heard.
- **Latency.** In Real time each note's time has the engine's own pick-to-note latency
  (`pipelineLatencyMs`) taken off, so a note played on the beat is graded on the beat.

**Pick mode or chord mode.** The detector has two modes (GUITAR_TO_MIDI.md section 12): pick mode for
single-note lines (fast, with bends) and chord mode for strings ringing together (60 to 90 ms to name
a chord). The app switches as the song goes, from the tab: a step with two or more notes is chord mode,
a single note pick mode. Switching releases whatever sounds, so one or two single notes between chords
stay in chord mode, and single notes on different strings right after a chord (an arpeggio of it) do
too. In Real time the switch happens 120 ms before the step that needs it, not on its first note. The
Play as column overrides the plan for any step.

## Where it lives

| Part | File |
| --- | --- |
| Reading tabs, the review sheet, fingering, the pick/chord plan | `examples/studio-bundle/src/apps/tabs/tab_model.ts` |
| Grading a run (own pace, real time, listen), onsets | `examples/studio-bundle/src/apps/tabs/tab_practice.ts` |
| The example tabs | `examples/studio-bundle/src/apps/tabs/tab_songs.ts` |
| The app: views, guitar input, synths, saving, MCP tools | `examples/studio-bundle/src/apps/tabs/tabs_addon.ts` |
| The neck (`Widget.fretboard`) | `src/entropy_gui/widgets_fretboard.rs` |
| Clipboard (Ctrl+V in text fields, `Entropy.Clipboard`) | `src/entropy_gui/clipboard.rs` |

The app registers two MCP tools: `tabs_load` (load a tab as if pasted) and `tabs_state` (the steps,
their notes and modes, and the practice score).

## Tests

| Tier | Command | What it covers |
| --- | --- | --- |
| Logic | `npm run test:guitar-tabs` (in examples/studio-bundle) | `tests/features/guitar_tabs.feature`: reading tabs of every shape above, the review sheet and its edits, writing a song back out as tab, fingering, the pick/chord plan, own-pace and real-time grading, latency, tempo and loops, onsets. |
| Widget | `cargo test --test fretboard_view` | The real `FretboardView` rasterized on the CPU: a lesson draws targets, ghosts, heard notes and the highway; a window up the neck; clicks land on the string and fret drawn there. Pictures in `test-artifacts/fretboard-view/`. |
| Live | `cargo test --test guitar_tabs_live` (Xvfb on Linux) | The real app and bundle: paste, review, own-pace grading with a wrong note, a chord tab loaded through `tabs_load` and played in chord mode, a real-time run with its count-in. Six screenshots in `test-artifacts/guitar-tabs-bdd-*/`. |

`npm run typecheck:guitar-tabs` typechecks the app.

## Known limits

- ASCII tab carries no rhythm, only spacing. Lengths are a guess to be checked in Review.
- One guitar part per tab: six-string systems only (bass and seven-string tabs are skipped with a
  warning), no tied notes, no repeat signs or "x2" (paste the part twice).
- Bends are shown but graded as the fretted note.
- A light re-strum of a chord still ringing is not heard as new notes (GUITAR_TO_MIDI.md section 12),
  so a strumming pattern of the same chord in Own pace needs a clear re-pick.
- Hammer-ons in chord mode take 50 ms to start a note.
- The fingering is a suggestion: one finger per fret from the hand's position, barres where three or
  more notes share the index finger's fret.

## Not yet checked

Everything above has been exercised with synthetic input only: the grading logic with made-up
readings, the live app with clicks on the neck. With a real guitar, please try: Ode to Joy in Own pace
and Real time (single notes, pick mode), the open chord changes (chord mode, lenient on and off), the
arpeggio study (let ring, chord mode), the warm-up riff's hammer-ons (pick mode, pitch settling), a mode
switch mid-song, and the Real time timing readout against how in time you felt you were.
