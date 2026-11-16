Feature: DAW next-step brain and Suggested Next Steps
  As an electronic music producer in Entropy DAW
  I want the edits I make recorded with their parameters and context, and suggested next steps with real controls
  So that I can compose, arrange and mix faster without digging through menus

  Scenario: The action vocabulary covers the song's edits, with typed parameters
    Given the DAW action vocabulary is loaded
    Then it should contain at least 50 distinct DAW actions
    And the vocabulary should include action "add_note" in category "Piano Roll"
    And the vocabulary should include action "paint_notes" in category "Piano Roll"
    And the vocabulary should include action "set_volume" in category "Mixer"
    And the vocabulary should include action "load_strings" in category "Instrument"
    And the vocabulary should include action "load_matter_preset" in category "Instrument"
    And the vocabulary should include action "move_kick_lock" in category "Moves"
    And the vocabulary should include action "create_clip" in category "Arrangement"
    And action "add_note" should have parameters "row:int, step:int, length:int, velocity:knob"
    And action "set_volume" should have parameters "track:track, gain:knob"
    And action "set_filter" should have parameters "cutoff:knob, resonance:knob"
    And action "load_brass" should have parameters "instrument:choice"
    And every choice parameter should name a choice list that exists
    And every action should have a valid display name and Phosphor icon

  Scenario: Interface actions are not part of the vocabulary
    Given the DAW action vocabulary is loaded
    Then the vocabulary should not include "open_view, toggle_window, select_track, select_clip, select_pattern, play, stop, rewind, seek, set_transport_mode, set_snap, preview_note, undo, save_version, start_guitar, stop_guitar"

  Scenario: The DAW's test world uses the current vocabulary
    Given the DAW action vocabulary is loaded
    Then the studio bundle's vocabulary fixture should match it

  Scenario: The embedded brain loads and agrees with its written rule
    When I ask whether the brain is available
    Then the brain should be available
    And the runtime should reproduce the rule's test vectors exactly

  Scenario: A plan from a piano-roll history carries parameters for every step
    Given a history of "set_bpm 124; add_note 0 0 1 0.85; add_note 0 4 1 0.85" on a "drum_rack" track
    When I request a plan of 5 steps
    Then the plan should have 5 steps
    And every step should carry one value per parameter, inside its range
    And every step should have a confidence between 0 and 1
    And step 1 should be "add_note" with parameters "0, 8, 1, 0.85"

  Scenario: A new track is set up the way the brain was written
    Given a history of "add_track 2; set_instrument 4" on a "strings" track
    When I request a plan of 3 steps
    Then the plan should be "load_strings, set_scale, set_root_note"

  Scenario: Another plan starts somewhere else
    Given a history of "add_track 2; set_instrument 5; load_brass 1" on a "brass" track
    When I request a plan of 3 steps
    And I request alternative plan 1 of 3 steps
    Then the alternative plan should open with a different action

  Scenario: Interface actions in a history are ignored
    Given a history of "add_note 0 0 1 0.85; open_view 1; toggle_window 2 1; play; add_note 0 4 1 0.85; not_a_real_action 3" on a "drum_rack" track
    When I request a plan of 3 steps
    Then the plan should be the same as for "add_note 0 0 1 0.85; add_note 0 4 1 0.85"

  Scenario: A requested plan is ready on the first poll
    Given a history of "set_bpm 124; add_note 0 0 1 0.85" on a "drum_rack" track
    When I request a plan of 5 steps through a ticket
    And I poll that ticket once
    Then the plan should have 5 steps
    And every step should carry one value per parameter, inside its range
