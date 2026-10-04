Feature: Allegiance Iteration 1 settlements and controller play
  Scenario: Start in a real hometown and control play and menus
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": false}
    Then I call the tool "allegiance_state"
    And I capture "iteration1-setup"
    When I call the tool "allegiance_new" with {"hometown": "Levittown", "lat": 40.7259, "lon": -73.5143, "party": "Dawn Front", "ideology": "liberty", "seed": 17}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 35 frames
    Then I call the tool "allegiance_state"
    And I capture "iteration1-hometown"
    When I call the tool "allegiance_controller" with {"left": [0, 0.6], "right": [0.6, 0.2]}
    And I advance 4 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_controller" with {"button": "Start", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "Start", "pressed": false}
    And I call the tool "allegiance_controller" with {"button": "RightTrigger", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "RightTrigger", "pressed": false}
    And I call the tool "allegiance_controller" with {"button": "RightTrigger", "pressed": true}
    And I call the tool "allegiance_controller" with {"button": "RightTrigger", "pressed": false}
    Then I call the tool "allegiance_state"
    And I capture "iteration1-territory"

  Scenario: Save and resume the same independently simulated hometown
    When I call the tool "allegiance_act" with {"action": "save"}
    And I call the tool "allegiance_ui" with {"mode": "title"}
    And I call the tool "allegiance_act" with {"action": "load"}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    And I capture "iteration1-resumed"
