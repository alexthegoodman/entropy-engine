Feature: Pilot the personal multicopter
  Scenario: Board with keyboard, take off with controller, and hover
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_new" with {"hometown": "Levittown", "lat": 40.7259, "lon": -73.5143, "seed": 17}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    When I hold the key "e" for 1 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_controller" with {"button": "South", "pressed": true, "left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 5 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": false}
    And I advance 65 frames
    Then I call the tool "allegiance_state"
    And I capture "car-hover"
    When I call the tool "allegiance_controller" with {"button": "West", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "West", "pressed": false}
    Then I call the tool "allegiance_state"

  Scenario: Resume in the cockpit in midair and fly on keyboard
    When I call the tool "allegiance_act" with {"action": "save"}
    And I call the tool "allegiance_ui" with {"mode": "title"}
    And I call the tool "allegiance_act" with {"action": "load"}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    When I hold the key "w" for 4 frames
    And I advance 65 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_controller" with {"left": [0, 0.7], "right": [0.3, 0.2]}
    And I advance 8 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 65 frames
    Then I call the tool "allegiance_state"
    And I capture "car-flight"

  Scenario: Land with controller, exit and park the car
    When I call the tool "allegiance_controller" with {"button": "DPadDown", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "DPadDown", "pressed": false}
    And I advance 260 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_controller" with {"button": "West", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "West", "pressed": false}
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    And I capture "car-parked"
