Feature: Nebula Kingdom
  Played with ENTROPY_NEBULA_BDD_RESULT (tests/nebula_live.rs).

  Scenario: The Cradle loads
    Given the real Nebula Kingdom game is running in test mode
    When I call the tool "nebula_config" with {"fixedStep": 0.033, "sound": false}
    And I call the tool "nebula_start" with {"region": "cradle"}
    And I advance 30 frames
    Then I call the tool "nebula_state"
    And I capture "01-cradle"
