Feature: Allegiance upgrades in the real game
  Scenario: Start in first person with five comrades and the founding mission
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_new" with {"hometown": "Levittown", "lat": 40.7259, "lon": -73.5143, "seed": 17}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 40 frames
    Then I call the tool "allegiance_state"
    And I capture "upgrades-first-person"

  Scenario: Storm the outpost and found the party headquarters
    When I call the tool "allegiance_act" with {"action": "compound"}
    And I advance 45 frames
    Then I call the tool "allegiance_state"
    And I capture "upgrades-outpost"
    When I call the tool "allegiance_act" with {"action": "storm"}
    And I call the tool "allegiance_act" with {"action": "flag"}
    And I advance 230 frames
    Then I call the tool "allegiance_state"
    And I capture "upgrades-hq"

  Scenario: Shop at the quartermaster and check the inventory
    When I call the tool "allegiance_act" with {"action": "shop", "kind": "hq"}
    Then I call the tool "allegiance_state"
    And I capture "upgrades-shop"
    When I call the tool "allegiance_act" with {"action": "shop-buy", "kind": "car", "item": "turbine"}
    And I call the tool "allegiance_act" with {"action": "shop-close"}
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_key" with {"key": "i"}
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_key" with {"key": "i"}

  Scenario: Enter a house and search it
    When I call the tool "allegiance_act" with {"action": "house", "loot": true}
    And I call the tool "allegiance_act" with {"action": "enter"}
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    And I capture "upgrades-house"
    When I call the tool "allegiance_act" with {"action": "loot"}
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_act" with {"action": "leave-house"}
    And I advance 3 frames
    Then I call the tool "allegiance_state"

  Scenario: Fall in battle and come back at the checkpoint
    When I call the tool "allegiance_act" with {"action": "checkpoint"}
    And I call the tool "allegiance_act" with {"action": "squad", "count": 3}
    And I call the tool "allegiance_act" with {"action": "die"}
    And I advance 5 frames
    Then I call the tool "allegiance_state"

  Scenario: Fly with a building boost under the sky markers
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
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": false}
    And I call the tool "allegiance_controller" with {"button": "LeftThumb", "pressed": true, "left": [0, 1], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 1], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 1], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 1], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 1], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 1], "right": [0, 0]}
    And I advance 12 frames
    Then I call the tool "allegiance_state"
    And I capture "upgrades-flight"
