Feature: Allegiance uses disk-cached Mesha humans at different distances
  Scenario: Full nearby people and a street crowd
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "people-01-street"
    When I call the tool "allegiance_act" with {"action": "approach"}
    And I call the tool "allegiance_act" with {"action": "view", "firstPerson": true, "pitch": 0}
    And I advance 4 frames
    Then I capture "people-02-near"
    And I call the tool "allegiance_state"
    When I call the tool "allegiance_act" with {"action": "view", "firstPerson": false, "distance": 20, "pitch": -0.2}
    And I advance 4 frames
    Then I capture "people-03-distance"
    And I call the tool "allegiance_state"

  Scenario: Returning to the same street reuses cached people
    When I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
