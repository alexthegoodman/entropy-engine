Feature: Quick knobs and moves for electronic music in the DAW
  One knob per idea on each track (Pump, Bounce, Gate, Acid, Grit, Space, Humanize) and one-click
  moves (Make Variation, Thin Out, Stutter, Octave Spark, Answer, Kick Lock, Build, Drop Gap, Echo
  Out), all undoable. The starter song runs at 96 bpm: a step is 156.25 ms, a bar 2500 ms.

  Scenario: Pump puts a beat-synced ducker on the track's bus, and zero takes it off again
    Given the DAW is open
    When I select the track "Bass"
    And I turn the knob "char_pump" to 0.6
    Then the bus of "Bass" chains "delay, reverb, pump"
    And the "pump" effect of "Bass" has amount 0.6 at 96 bpm
    When I turn the knob "char_pump" to 0
    Then the bus of "Bass" chains "delay, reverb"

  Scenario: The character chain runs grit, gate, space, then pump, and the gate plays the chosen figure
    Given the DAW is open
    When I select the track "Pad"
    And I turn the knob "char_pump" to 0.3
    And I turn the knob "char_space" to 0.5
    And I turn the knob "char_gate" to 0.8
    And I turn the knob "char_grit" to 0.2
    And I choose option 2 of "char_gate_pattern"
    Then the bus of "Pad" chains "delay, reverb, grit, gate, space, pump"
    And the "gate" effect of "Pad" has pattern 2

  Scenario: Pump and Gate are put on the beat when the song starts playing
    Given the DAW is open
    When I select the track "Bass"
    And I turn the knob "char_pump" to 1
    And I park the playhead at bar 3 beat 2
    And I click "transport_toggle"
    Then the "pump" effect of "Bass" is 1 beat into the bar

  Scenario: Acid sweeps the synth's filter, resonance, envelope and drive, and gives them back at zero
    Given the DAW is open
    When I select the track "Bass"
    And I turn the knob "char_acid" to 0.5
    Then the voice of "Bass" has a cutoff below 1000 Hz and resonance above 3
    When I park the playhead at bar 3 beat 1
    And I click "transport_toggle"
    And I advance 1000 milliseconds
    Then the last note on "Bass" played with a filter envelope and drive
    When I turn the knob "char_acid" to 0
    Then the voice of "Bass" has a cutoff of 4000 Hz and resonance 1

  Scenario: Bounce pushes offbeat sixteenths late, live and in the export alike
    Given the DAW is open
    When I call the tool "daw_set_notes" with {"trackId": "trk-drums", "patternId": "pat-drums-groove", "rows": [{"row": 2, "pattern": "xxxxxxxxxxxxxxxx"}]}
    And I select the track "Drums"
    And I turn the knob "char_bounce" to 1
    And I click "transport_toggle"
    And I advance 400 milliseconds
    Then the hihat on step 1 sounded at least 205 ms after Play
    When I click "export_wav"
    Then the export's hihat on step 1 starts a third of a step late
    And the export's hihat on step 2 starts less than a tenth of a step late

  Scenario: Humanize is the same on every playthrough and in the export
    Given the DAW is open
    When I select the track "Drums"
    And I turn the knob "char_humanize" to 1
    And I click "export_wav"
    And I click "export_wav"
    Then the last two exports are identical
    And some of the export's drum hits are off the grid by less than an eighth of a step

  Scenario: An export mixes every track through its own bus, with its gain after the effects
    Given the DAW is open
    When I select the track "Bass"
    And I turn the knob "char_grit" to 0.4
    And I click "export_wav"
    Then the export has a bus for "Bass" with gain 0.3 and effects "grit"
    And the export's "Bass" notes name their track and carry only their own velocity

  Scenario: Make Variation revises the pattern and Undo puts it back
    Given the DAW is open
    When I select the track "Lead"
    And I remember the notes of the pattern "pat-lead-melody"
    And I click "move_variation"
    Then the pattern "pat-lead-melody" has changed
    And I see a label containing "variation"
    When I click "move_undo"
    Then the pattern "pat-lead-melody" is as I remembered it
    And I see the label "Undid Make Variation."

  Scenario: Thin Out keeps the downbeats
    Given the DAW is open
    When I select the track "Drums"
    And I click "move_thin"
    Then the pattern "pat-drums-groove" has fewer notes than 12
    And the pattern "pat-drums-groove" still has a note on row 0 at step 0

  Scenario: Build writes an accelerating roll into the four bars before the section
    Given the DAW is open
    When I park the playhead at bar 9 beat 1
    And I click "move_build"
    Then "Drums" has a clip playing "Build 4" from bar 5 to bar 9
    And no other "Drums" clip plays between bar 5 and bar 9
    And the pattern "Build 4" on "Drums" has thirty-second notes at the end and a rising filter sweep
    When I click "move_undo"
    Then "Drums" has no clip playing "Build 4"

  Scenario: Drop Gap without tails silences the drums through the last beat, live and in the export
    Given the DAW is open
    When I park the playhead at bar 9 beat 1
    And I untick "Keep tails"
    And I click "move_drop_gap"
    Then no "Drums" clip plays between bar 8 beat 4 and bar 9
    And I see a label containing "Hard cut: Drums silent from bar 8 beat 4 to bar 9"
    And the bus of "Drums" chains "delay, reverb, fader"
    When I park the playhead at bar 8 beat 3
    And I click "transport_toggle"
    And I advance 800 milliseconds
    Then the "fader" effect of "Drums" has amount 0
    When I advance 700 milliseconds
    Then the "fader" effect of "Drums" has amount 1
    When I click "export_wav"
    Then the export's bus for "Drums" is silent from bar 8 beat 4 to bar 9

  Scenario: Drop Gap on everything keeps tails by default
    Given the DAW is open
    When I park the playhead at bar 9 beat 1
    And I choose option 1 of "move_gap_scope"
    And I choose option 1 of "move_gap_length"
    And I click "move_drop_gap"
    Then no "Bass" clip plays between bar 8 beat 3 and bar 9
    And no "Drums" clip plays between bar 8 beat 3 and bar 9
    And the bus of "Drums" chains "delay, reverb"

  Scenario: Echo Out repeats the end of the selected phrase, fading, after it
    Given the DAW is open
    When I select the clip "clip-lead-4"
    And I click "move_echo_out"
    Then "Lead" has a clip playing "Echo" from bar 9 to bar 10
    And the pattern "Echo" on "Lead" fades and darkens

  Scenario: Kick Lock shows its changes, playing them, before they are applied
    Given the DAW is open
    When I call the tool "daw_set_notes" with {"trackId": "trk-bass", "patternId": "pat-bass-root", "notes": [{"row": 0, "step": 0, "length": 10}, {"row": 2, "step": 9, "length": 4}]}
    And I select the track "Bass"
    And I click "move_kick_lock"
    Then I see the label "Kick Lock preview (playing now): 2 notes change."
    And the piano roll shows notes of length "8, 5"
    When I click "move_kick_cancel"
    Then the piano roll shows notes of length "10, 4"
    When I click "move_kick_lock"
    And I click "move_kick_apply"
    Then the saved pattern "pat-bass-root" has notes starting at "0, 8" of length "8, 5"

  Scenario: The moves are there for the chat too
    Given the DAW is open
    When I call the tool "daw_character" with {"trackId": "trk-pad", "space": 0.7, "gate": 0.5, "gatePattern": "eighths"}
    Then the bus of "Pad" chains "delay, reverb, gate, space"
    When I call the tool "daw_move" with {"action": "stutter", "trackId": "trk-lead", "rate": "32nd"}
    Then the tool status mentions "stutters"
    When I call the tool "daw_move" with {"action": "octave_spark", "trackId": "trk-bass"}
    Then the tool status mentions "octave-up"
    When I call the tool "daw_move" with {"action": "answer", "trackId": "trk-lead", "clipId": "clip-lead-4"}
    Then the tool status mentions "answers from bar 7"
    When I call the tool "daw_move" with {"action": "build", "bars": 2, "boundaryBar": 7}
    Then "Drums" has a clip playing "Build 2" from bar 5 to bar 7

  Scenario: Character settings are saved with the project
    Given the DAW is open
    When I select the track "Pad"
    And I turn the knob "char_space" to 0.5
    And I reopen the DAW
    And I select the track "Pad"
    Then the knob "char_space" shows 0.5
    And the bus of "Pad" chains "delay, reverb, space"
