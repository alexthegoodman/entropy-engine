Feature: Suggested Next Steps learns from what you do and lets you tweak every step
  Every action taken in the DAW is recorded with its parameters and the context after it, and the
  model's suggested steps are drawn with real controls built from each action's parameters.

  Scenario: A note clicked into the piano roll is recorded with where it went
    Given the DAW is open with Suggested Next Steps showing
    When I open the "roll" view
    And I click the piano roll at row 3, step 6
    Then the model last saw "add_note" with params "3, 6, 1, 0.85"
    And that action happened on a "drum_rack" track in the "roll" view

  Scenario: Dragging along a row is one paint stroke, not four notes
    Given the DAW is open with Suggested Next Steps showing
    When I open the "roll" view
    And I drag across row 3 from step 0 to step 3
    Then the model last saw "paint_notes" with params "3, 0, 3, 4"
    And the model saw no "add_note"

  Scenario: Clicking a note again erases it, and that is recorded too
    Given the DAW is open with Suggested Next Steps showing
    When I open the "roll" view
    And I click the piano roll at row 0, step 0
    Then the model last saw "remove_note" with params "0, 0"

  Scenario: A fader drag is one action that keeps where it stopped
    Given the DAW is open with Suggested Next Steps showing
    When I open the "mixer" view
    And I drag the gain of "Bass" through 0.2, 0.3 and 0.4
    Then the model saw "set_volume" 1 time
    And the model last saw "set_volume" with params "1, 0.4"

  Scenario: Switching a track's instrument and loading a preset are recorded
    Given the DAW is open with Suggested Next Steps showing
    When I select the track "Lead"
    And I open the "Brass" instrument window
    And I press "br_make"
    And I press "br_instrument_horn"
    Then the model saw "set_instrument" with params "5"
    And the model last saw "load_brass" with params "2"
    And that action happened on a "brass" track in the "arrange" view

  Scenario: A view switch is recorded once, where it settles
    Given the DAW is open with Suggested Next Steps showing
    When I open the "mixer" view
    Then the model last saw "open_view" with params "2"
    And the model saw "open_view" 1 time

  Scenario: Each suggested step is drawn with controls built from its parameters
    Given the model will suggest "set_volume 1 0.3; set_reverb_preset 4; add_note 3 8 1 0.85"
    And the DAW is open with Suggested Next Steps showing
    Then step 1 has a dropdown "pred_0_track" on "Bass"
    And step 1 has a knob "pred_0_gain" at 0.3
    And step 2 has a dropdown "pred_1_preset" on "Hall"
    And step 3 has a knob "pred_2_row" labelled "Row: Clap"
    And step 3 has a knob "pred_2_velocity" at 0.85

  Scenario: A step applies with the value dialled in on its knob
    Given the model will suggest "set_volume 1 0.3"
    And the DAW is open with Suggested Next Steps showing
    When I turn knob "pred_0_gain" to 0.7
    And I press "pred_apply_0"
    Then the track "Bass" has gain 0.7
    And the model last saw "set_volume" with params "1, 0.7" as a suggestion

  Scenario: A suggested note lands in the pattern being edited
    Given the model will suggest "add_note 3 8 1 0.85"
    And the DAW is open with Suggested Next Steps showing
    When I press "pred_apply_0"
    Then the "Drums" pattern "Groove" has a note on row 3 at step 8

  Scenario: A suggested instrument preset switches the track to that instrument first
    Given the model will suggest "load_strings 2"
    And the DAW is open with Suggested Next Steps showing
    When I select the track "Lead"
    And I press "pred_apply_0"
    Then the track "Lead" plays the "physmod" waveform with instrument "cello"
    And the model last saw "load_strings" with params "2" as a suggestion

  Scenario: Asking for another plan asks the model for its next alternative
    Given the DAW is open with Suggested Next Steps showing
    When I press "prediction_refresh_btn"
    Then the last plan request asked for alternative 1

  Scenario: With no model installed the panel waits quietly and keeps recording
    Given no prediction model is installed
    And the DAW is open with Suggested Next Steps showing
    When I open the "roll" view
    And I click the piano roll at row 3, step 6
    Then the panel shows "Suggestions start once a prediction model is installed"
    And the panel shows "No prediction model installed"
    And the model was never asked for a plan
    And the DAW recorded "add_note" for when a model arrives

  Scenario: A model that is installed but fails says how to get a working one
    Given the model cannot load: "the prediction checkpoint was trained on DAW action vocabulary v1"
    And the DAW is open with Suggested Next Steps showing
    Then the panel shows "vocabulary v1"
    And the panel shows "train_prediction"
