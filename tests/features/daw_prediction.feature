Feature: DAW Next Actions UI Prediction Model
  As an electronic music producer in Entropy DAW
  I want real-time suggested next steps and action history context
  So that I can compose, arrange, and mix faster with intelligent MoE assistance

  Scenario: Semantic action vocabulary provides full DAW metadata
    Given the DAW action vocabulary is loaded
    Then it should contain at least 30 distinct DAW actions
    And the vocabulary should include action "add_track" in category "Track"
    And the vocabulary should include action "set_bpm" in category "Transport"
    And the vocabulary should include action "place_clip" in category "Arrangement"
    And the vocabulary should include action "set_volume" in category "Mixer"
    And the vocabulary should include action "set_eq" in category "Effects"
    And every action should have a valid display name and Phosphor icon

  Scenario: Inference predicts next actions from a beatmaking context
    Given an action history sequence of "add_track, select_track, set_bpm, add_note"
    When I request 4 predicted next steps from the model
    Then the response should contain 4 predicted actions
    And each prediction should have a confidence score between 0 and 100 percent
    And each prediction should have a category, display name, and icon

  Scenario: Inference predicts next actions from a mixing context
    Given an action history sequence of "set_volume, set_pan, set_eq"
    When I request 3 predicted next steps from the model
    Then the response should contain 3 predicted actions
    And the predicted actions should have valid action IDs

  Scenario: Inference handles empty context by suggesting starter workflow
    Given an empty action history sequence
    When I request 5 predicted next steps from the model
    Then the response should contain 5 predicted actions
