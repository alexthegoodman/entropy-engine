Feature: The Abyss - Chapter One: First Blood
  Played with ENTROPY_ABYSS_BDD_RESULT (tests/abyss_live.rs).

  Scenario: The world loads
    Given the real Abyss game is running in test mode
    When I call the tool "abyss_config" with {"fixedStep": 0.033}
    And I call the tool "abyss_settle"
    And I advance 5 frames
    Then I call the tool "abyss_state"
    When I call the tool "abyss_camera" with {"position": [-640, 160, -1500], "target": [100, -420, -100]}
    And I advance 3 frames
    Then I capture "01-rim"
