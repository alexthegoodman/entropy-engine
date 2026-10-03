Feature: DAW Next Actions UI Prediction Model
  As an electronic music producer in Entropy DAW
  I want the actions I take recorded with their parameters and context, and suggested next steps with real controls
  So that I can compose, arrange and mix faster without digging through menus

  Scenario: The action vocabulary covers the whole DAW, with typed parameters
    Given the DAW action vocabulary is loaded
    Then it should contain at least 70 distinct DAW actions
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

  Scenario: The DAW's test world uses the current vocabulary
    Given the DAW action vocabulary is loaded
    Then the studio bundle's vocabulary fixture should match it

  Scenario: A checkpoint trained on the old vocabulary is refused with a clear message
    Given a prediction checkpoint saved with vocabulary version 1
    When I try to load that checkpoint
    Then loading should fail with a message naming vocabulary "v1"

  Scenario: With no model installed, the status says so and plans are empty rather than errors
    Given no prediction model is installed
    And a history of "play; stop" on a "synth" track in the "arrange" view
    When I ask whether a model is installed
    And I request a plan of 5 steps
    Then the model should be unavailable, saying "holds no metadata.json and model.bin"
    And the plan should have 0 steps

  Scenario: A checkpoint missing its model.bin counts as no model
    Given a checkpoint with metadata but no model.bin
    And a history of "play" on a "synth" track in the "arrange" view
    When I ask whether a model is installed
    And I request a plan of 3 steps
    Then the model should be unavailable, saying "model.bin"
    And the plan should have 0 steps

  Scenario: An installed model reports itself available
    Given a freshly initialised prediction checkpoint
    When I ask whether a model is installed
    Then the model should be available

  Scenario: A plan from a piano-roll history carries parameters for every step
    Given a freshly initialised prediction checkpoint
    And a history of "set_bpm 124; open_view 1; add_note 0 0 1 0.85; add_note 0 4 1 0.85" on a "drum_rack" track in the "roll" view
    When I request a plan of 5 steps
    Then the plan should have 5 steps
    And every step should carry one value per parameter, inside its range
    And every step should have a confidence between 0 and 1

  Scenario: Another plan starts somewhere else
    Given a freshly initialised prediction checkpoint
    And a history of "add_track 2; set_instrument 5; load_brass 1" on a "brass" track in the "arrange" view
    When I request a plan of 3 steps
    And I request alternative plan 1 of 3 steps
    Then the alternative plan should open with a different action

  Scenario: Unknown actions in a history are ignored rather than failing
    Given a freshly initialised prediction checkpoint
    And a history of "play; not_a_real_action 3; stop" on a "synth" track in the "mixer" view
    When I request a plan of 2 steps
    Then the plan should have 2 steps
