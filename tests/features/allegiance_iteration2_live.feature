Feature: Allegiance iteration 2 in the real game
  Mesha city buildings on London's map footprints, leafy street trees kept off the roads, a
  furnished house, calling the flying car, real shots at the outpost's defenders (each one that
  falls leaves the garrison for good), aiming down sights with aim assist, and the skyline.

  Scenario: A London street of Mesha buildings and street trees
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_new" with {"hometown": "London", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 600000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_act" with {"action": "view-building"}
    And I advance 40 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-street"

  Scenario: A furnished house
    When I call the tool "allegiance_act" with {"action": "house", "loot": true}
    And I call the tool "allegiance_act" with {"action": "enter"}
    And I call the tool "allegiance_act" with {"action": "view-furniture"}
    And I advance 8 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-interior"
    When I call the tool "allegiance_act" with {"action": "leave-house"}
    And I advance 3 frames

  Scenario: Call the car
    When I call the tool "allegiance_act" with {"action": "call-car"}
    And I advance 60 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-car-coming"
    When I advance 900 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-car-landed"

  Scenario: Defenders fall and stay down
    When I call the tool "allegiance_act" with {"action": "equip", "weapon": "rifle"}
    And I call the tool "allegiance_act" with {"action": "compound"}
    And I advance 45 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-outpost"
    When I call the tool "allegiance_act" with {"action": "shoot-guard", "shots": 8}
    And I advance 60 frames
    Then I call the tool "allegiance_state"

  Scenario: Aim down sights with aim assist
    When I call the tool "allegiance_act" with {"action": "face-guard", "offset": 0.025}
    And I call the tool "allegiance_act" with {"action": "ads", "on": true}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-ads"
    When I call the tool "allegiance_act" with {"action": "ads", "on": false}
    And I advance 10 frames
    Then I call the tool "allegiance_state"

  Scenario: The skyline from the car
    When I call the tool "allegiance_act" with {"action": "to-car"}
    And I advance 3 frames
    And I hold the key "e" for 1 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": true, "left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": false}
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    And I capture "it2-skyline"
