Feature: The DAW has a wavetable synth whose table is sculpted as terrain

  These scenarios run the production DAW addon against a stand-in engine. Widgets are captured
  each render so a step can call the exact callbacks the real widgets would (a key pressed on the
  terrain's keyboard, a stroke that ends, a slider dragged), and every engine call is recorded. The
  stand-in wavetable registry keeps a table as a string that records what was done to it, so a test
  can tell a preset from a stroke from an operation. The table itself, the brush, the widget and the
  voice are tested in Rust: `cargo test --release --lib wavetable` and `--test wavetable_view_bdd`.

  Scenario: The Wavetable window stays out of the way until it is asked for
    Given the DAW is open
    Then the Wavetable window is hidden
    When I click "toggle_wavetable"
    Then the Wavetable window is shown
    When I click "toggle_wavetable"
    Then the Wavetable window is hidden

  Scenario: A synth track becomes a wavetable synth and the window shows its terrain
    Given the DAW is open
    And the track "Lead" is selected
    Then the Wavetable window offers to make "Lead" a wavetable synth
    When I click "wt_make"
    Then the track "Lead" is a wavetable track
    And the terrain widget shows the table of "Lead"
    And the engine has a table for "Lead" that started as "saw"
    And I see the label "Lead - start from"

  Scenario: The editor only works on built-in synth tracks
    Given the DAW is open
    And the track "Drums" is selected
    Then I see the label "The wavetable editor works on a built-in synth track. Select one in the arrangement."

  Scenario: A wavetable track sounds through the wavetable voice and not the built-in oscillator
    Given the DAW is open
    And "Lead" is a wavetable track
    When I click "transport_toggle"
    And I advance 13000 milliseconds
    Then the track "Lead" has played wavetable notes
    And the track "Lead" has not played the built-in voice "square"
    And every wavetable note on "Lead" reads the table of "Lead"
    And the track "Bass" has played the built-in voice "saw"

  Scenario: A wavetable note carries the track's envelope, filter and the table's settings
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"params","params":{"position":0.7,"unison":5,"lfoRate":3,"lfoDepth":0.4}}
    And I call the tool "daw_set_track_params" with {"trackId":"trk-lead","cutoff":1800,"attack":0.2}
    And I click "preview_row_0"
    Then the last wavetable note on "Lead" has position 0.7, unison 5, cutoff 1800 and attack 0.2

  Scenario: The preview keys play the wavetable too
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I click "preview_row_0"
    Then the track "Lead" has played wavetable notes

  Scenario: Pressing a key on the terrain's keyboard holds a note until the key is released
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I press the key 60 on the terrain with velocity 0.9
    Then a note is held on "Lead" at 261.6 Hz
    When I release the key 60 on the terrain
    Then no note is held on "Lead"

  Scenario: Sculpting plays a note for the length of the stroke, when Hear while sculpting is on
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When a stroke begins on the terrain
    Then a note is held on "Lead" at 130.8 Hz
    When the stroke ends on the terrain
    Then no note is held on "Lead"

  Scenario: With Hear while sculpting off a stroke is silent
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I switch "Hear while sculpting" off
    And a stroke begins on the terrain
    Then no note is held on "Lead"

  Scenario: Hold latches a note that the Position knob then moves through the table
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I click "wt_latch"
    Then a note is held on "Lead" at 130.8 Hz
    And the held note reads position 0.35
    When I turn the knob "Position" to 0.8
    Then the held note reads position 0.8
    When I click "wt_latch"
    Then no note is held on "Lead"

  Scenario: A stroke while a note is latched does not start a second note
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I click "wt_latch"
    And a stroke begins on the terrain
    Then exactly 1 note is held on "Lead"

  Scenario: What is sculpted is saved with the project and comes back on reopening
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I sculpt the table of "Lead"
    And I advance 400 milliseconds
    Then the saved project has the table of "Lead" as it is in the engine
    When the DAW is reopened
    Then the engine was given the saved table of "Lead" back
    And the track "Lead" is a wavetable track

  Scenario: A preset replaces the table and is saved
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I click "wt_preset_vowels"
    And I advance 400 milliseconds
    Then the engine table of "Lead" started as "vowels"
    And the saved project has the table of "Lead" as it is in the engine

  Scenario: Whole-table operations edit the engine's table
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I click "wt_op_normalize"
    And I click "wt_op_invert"
    Then the engine table of "Lead" was edited by "op normalize" then "op invert"

  Scenario: Two wavetable tracks keep two tables
    Given the DAW is open
    And "Lead" is a wavetable track
    And "Pad" is a wavetable track
    And the track "Pad" is selected
    When I click "wt_preset_glass"
    Then the engine table of "Pad" started as "glass"
    And the engine table of "Lead" started as "saw"

  Scenario: A table that cannot be read falls back to its preset and says so
    Given the DAW was saved with a wavetable track whose table is garbage
    And the track "Lead" is selected
    Then the engine has a table for "Lead" that started as "vowels"
    And I see a label containing "could not be read"

  Scenario: A saved project from before wavetables opens unchanged
    Given the DAW is open
    Then no track is a wavetable track
    And the engine has no tables

  Scenario: Deleting a wavetable track removes its table
    Given the DAW is open
    And "Lead" is a wavetable track
    When I call the tool "daw_delete_track" with {"trackId":"trk-lead"}
    Then the engine removed the table of "Lead"

  Scenario: The WAV export renders wavetable tracks from the table
    Given the DAW is open
    When I click "export_wav"
    And I remember how many built-in notes the export has
    And "Lead" is a wavetable track
    And I click "export_wav"
    Then the export has wavetable notes for "Lead" reading its own table
    And the built-in notes and the wavetable notes together are what the built-in notes were before

  Scenario: A muted wavetable track is left out of the export like any other
    Given the DAW is open
    And "Lead" is a wavetable track
    When I call the tool "daw_set_track_params" with {"trackId":"trk-lead","muted":true}
    And I click "export_wav"
    Then the export has no wavetable notes

  # ------------------------------------------------------------------- the AI tool

  Scenario: An AI tool sculpts the same table and can hear the result
    Given the DAW is open
    And "Lead" is a wavetable track
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"preset","preset":"vowels"}
    Then the tool succeeded
    And the engine table of "Lead" started as "vowels"
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"sculpt","stamps":[{"tool":"raise","frame":12,"phase":0.3,"amount":0.6},{"tool":"smooth","frame":12,"phase":0.5}]}
    Then the tool succeeded
    And the engine table of "Lead" was edited by "stamp x2"
    And the saved project has the table of "Lead" as it is in the engine
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":57,"position":0.9}
    Then the tool succeeded
    And the tool heard about 220 Hz and a brightness above 3000 Hz
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":57,"position":0.0}
    Then the tool heard a brightness below 1000 Hz

  Scenario: The AI tool refuses a track that is not a wavetable track and a brush that does not exist
    Given the DAW is open
    When I call the tool "daw_wavetable" with {"trackId":"trk-bass","action":"info"}
    Then the tool failed saying "not a wavetable track"
    Given "Lead" is a wavetable track
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"sculpt","stamps":[{"tool":"paint","frame":1,"phase":0.1}]}
    Then the tool failed saying "no brush called paint"
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"preset","preset":"chaos"}
    Then the tool failed saying "Unknown preset"

  Scenario: The AI tool's parameters are clamped like the sliders
    Given the DAW is open
    And "Lead" is a wavetable track
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"params","params":{"unison":40,"position":-3,"detuneCents":900}}
    Then the tool succeeded
    And the tool reports unison 7, position 0 and detune 60

  # ---- The guitar input plays the wavetable ----
  # The voice the guitar plays is a Rust voice (wavetable_voice.rs, guitar_live_bdd.rs); these
  # scenarios cover what the panel asks of it.

  Scenario: The guitar's Voice list offers the wavetable
    Given the DAW is open
    And the Guitar Input window is open
    Then the guitar Voice list is "sine, triangle, saw, square, wavetable"

  Scenario: The guitar plays the table the Wavetable window edits
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Lead"
    When the guitar is started
    Then the guitar was started on the "wavetable" voice with the table of "Lead"
    And the terrain widget shows the table of "Lead"
    And I see the label "Plays Lead's wavetable. Sculpt it in the Wavetable window."

  Scenario: The guitar carries the track's own wavetable settings and filter
    Given the DAW is open
    And "Lead" is a wavetable track
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Lead"
    When the guitar is started
    Then the guitar's wavetable sound has unison 1, position 0.35 and the track's cutoff and envelope

  Scenario: A track that is not a wavetable synth yet still has a table to play
    Given the DAW is open
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Bass"
    Then I see the label "Plays Bass's wavetable. Make it a wavetable synth to sculpt it."
    When the guitar is started
    Then the guitar was started on the "wavetable" voice with the table of "Bass"
    And the engine has a table for "Bass" that started as "saw"

  Scenario: A control in the Wavetable window changes what the running guitar plays
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Lead"
    And the guitar is started
    And I advance 200 milliseconds
    When I turn the knob "Unison" to 5
    And I advance 200 milliseconds
    Then the guitar was pointed again at the table of "Lead" with unison 5

  Scenario: The track's own filter changes reach the running guitar too
    Given the DAW is open
    And "Lead" is a wavetable track
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Lead"
    And the guitar is started
    And I advance 200 milliseconds
    When I call the tool "daw_set_track_params" with {"trackId":"trk-lead","cutoff":900}
    And I advance 200 milliseconds
    Then the guitar was pointed again with cutoff 900

  Scenario: Position moves the voice that is sounding instead of replacing it
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Lead"
    And the guitar is started
    And I advance 200 milliseconds
    And I remember how many times the guitar was pointed
    When I turn the knob "Position" to 0.7
    And I advance 200 milliseconds
    Then the guitar voice was moved to position 0.7 and not replaced

  Scenario: The built-in voices are unchanged
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    And the Guitar Input window is open
    And the guitar plays the "saw" voice on "Lead"
    When the guitar is started
    Then the guitar was started on the "saw" voice with no wavetable
    When I turn the knob "Unison" to 5
    And I advance 200 milliseconds
    Then the guitar was never pointed again

  Scenario: A guitar that is not running is not sent anything
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    And the Guitar Input window is open
    And the guitar plays the "wavetable" voice on "Lead"
    When I turn the knob "Unison" to 5
    And I advance 200 milliseconds
    Then the guitar was never started or pointed

  # --- Instrument presets: a full patch (table, motion, the track's own filter/envelope) applied
  # in one step. See WT_INSTRUMENT_PRESETS in daw_wavetable.ts.

  Scenario: Applying an instrument preset sets the table, the motion settings and the track's voice
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"instrument","instrumentPreset":"modulated_bass"}
    Then the tool succeeded
    And the tool reports instrument preset "modulated_bass"
    And the engine has a table for "Lead" that started as "saw"
    And the track "Lead" has cutoff 1600 and resonance 2.2

  Scenario: An unknown instrument preset fails instead of changing anything
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"instrument","instrumentPreset":"not-a-real-preset"}
    Then the tool failed saying "Unknown instrumentPreset"
    And the engine has a table for "Lead" that started as "saw"

  Scenario: The instrument preset tree groups presets by folder and applies one on selection
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I open the instrument preset folder "Strings & Horns"
    And I select the instrument preset "Simple Strings"
    Then the engine has a table for "Lead" that started as "saw"
    And the track "Lead" has cutoff 6500 and resonance 0.4

  Scenario: Loading a bare waveform clears the instrument preset it started from
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"instrument","instrumentPreset":"simple_horns"}
    Then the tool reports instrument preset "simple_horns"
    When I click "wt_preset_saw"
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"info"}
    Then the tool reports no instrument preset

  Scenario: An instrument preset survives a save and reopen
    Given the DAW is open
    And "Lead" is a wavetable track
    And the track "Lead" is selected
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"instrument","instrumentPreset":"synth_riser"}
    And the DAW is reopened
    And the track "Lead" is selected
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"info"}
    Then the tool reports instrument preset "synth_riser"
