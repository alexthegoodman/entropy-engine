Feature: Allegiance - rivals, travel and saving
  Played by tests/allegiance_live.rs with ENTROPY_ALLEGIANCE_BDD_FEATURE: a rival orator sets up
  across the square and draws a crowd; you confront them and win the debate; then you travel to
  Paris (a day on the road, a new city streamed in), save, go back to the title and continue.

  Scenario: A rival rally and a debate
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I call the tool "allegiance_act" with {"action": "rally"}
    And I advance 200 frames
    Then I call the tool "allegiance_state"
    And I capture "t1-rival-rally"
    When I call the tool "allegiance_act" with {"action": "approach", "weapon": "orator"}
    And I call the tool "allegiance_act" with {"action": "view", "distance": 4, "pitch": -0.15}
    And I call the tool "allegiance_act" with {"action": "talk"}
    And I advance 3 frames
    Then I call the tool "allegiance_state"
    And I capture "t2-confront-orator"
    When I call the tool "allegiance_key" with {"key": "1"}
    And I advance 60 frames
    Then I call the tool "allegiance_state"
    And I capture "t3-debate"
    When I call the tool "allegiance_speech" with {"action": "auto", "grade": "good"}
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    And I capture "t4-debate-won"
    When I call the tool "allegiance_speech" with {"action": "close"}

  Scenario: Travel to Paris, save and continue
    When I call the tool "allegiance_act" with {"action": "funds", "amount": 5000}
    And I call the tool "allegiance_act" with {"action": "travel", "region": "paris"}
    And I advance 3 frames
    Then I call the tool "allegiance_state"
    And I capture "t5-loading-paris"
    When I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "t6-paris"
    When I call the tool "allegiance_act" with {"action": "save"}
    And I call the tool "allegiance_ui" with {"mode": "title"}
    And I advance 5 frames
    And I call the tool "allegiance_act" with {"action": "load"}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    And I capture "t7-continued"
