Feature: Allegiance performance with production streaming budgets
  Scenario: London street at rest and while walking
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I call the tool "allegiance_config" with {"fixedStep": null}
    And I advance 300 frames
    Then I call the tool "allegiance_state"
    And I advance 600 frames
    Then I call the tool "allegiance_state"
    When I hold the key "w" for 600 frames
    Then I call the tool "allegiance_state"
