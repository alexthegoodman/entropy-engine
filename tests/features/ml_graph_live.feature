Feature: The real ML Graph addon trains a deterministic MLP and validates model architectures

  The model architecture presets are shape-checked designs. Only the MLP trainer executes
  today, so the training assertions below concern real Burn models on fixed XOR and seeded
  two-moons data. This file is consumed directly by BrowserBddDriver.

  Scenario: Train the default dense graph on XOR
    Given the real ML graph addon is running in test mode
    When I advance 20 frames
    And I click "ml_train"
    And I wait 4000 milliseconds
    And I advance 5 frames
    Then I see the label "ML training completed"
    And I capture "ml-xor-trained"

  Scenario: Add a second Dense node and train on seeded two moons
    When I click "ml_dataset"
    And I advance 3 frames
    And I click "ml_add_dense"
    And I advance 3 frames
    And I click "ml_train"
    And I wait 8000 milliseconds
    And I advance 5 frames
    Then I see the label "ML training completed"
    And I capture "ml-two-moons-trained"

  Scenario: Train the edited graph on a second four-sample truth table
    When I click "ml_dataset"
    And I advance 3 frames
    And I click "ml_train"
    And I wait 4000 milliseconds
    And I advance 5 frames
    Then I see the label "ML training completed"
    And I capture "ml-and-trained"

  Scenario: Inspect all three architecture presets
    When I click "ml_view_architecture"
    And I advance 3 frames
    Then I see the label "Graph valid"
    And I capture "ml-npc-architecture"
    When I click "ml_preset"
    And I advance 3 frames
    Then I see the label "Graph valid"
    And I capture "ml-pet-architecture"
    When I click "ml_preset"
    And I advance 3 frames
    Then I see the label "Graph valid"
    And I capture "ml-mini-pic-architecture"

  Scenario: Broken U-Net wiring is reported and reset restores it
    When I click "ml_save_graph"
    And I advance 3 frames
    And I click "SNARL_DISCONNECT|ml_architecture_graph|mid_attn|out|merge3|a"
    And I advance 3 frames
    Then I see the label "Graph invalid"
    And I capture "ml-mini-pic-invalid"
    When I click "ml_load_graph"
    And I advance 3 frames
    Then I see the label "Graph valid"
    And I capture "ml-mini-pic-reloaded"
