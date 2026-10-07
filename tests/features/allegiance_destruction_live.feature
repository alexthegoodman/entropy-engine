Feature: The Cobra, fire and explosions, and destructible buildings in the real game
  A Cobra stands in the founding outpost's courtyard. Take it, rise over the walls and fire its
  solar missiles: they explode in fire and smoke, the outpost's buildings break apart into pieces
  that come down and settle as rubble, fires burn on, and a map house falls the same way. The
  ruins are kept with the campaign and come back as rubble after save and continue.

  Scenario: Take the outpost's Cobra
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033, "weather": {"cloudCover": 0.2, "windSpeed": 2, "windHeading": 0.6}}
    And I call the tool "allegiance_new" with {"hometown": "London", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 600000}
    And I advance 20 frames
    And I call the tool "allegiance_act" with {"action": "compound"}
    And I advance 30 frames
    And I call the tool "allegiance_act" with {"action": "to-cobra"}
    And I call the tool "allegiance_act" with {"action": "view", "firstPerson": false, "distance": 9, "pitch": -0.2}
    And I advance 30 frames
    Then I call the tool "allegiance_state"
    And I capture "cobra-parked"
    When I hold the key "e" for 1 frames
    And I advance 3 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": true, "left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 12 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": false}
    And I advance 20 frames
    Then I call the tool "allegiance_state"

  Scenario: Solar missiles bring down the outpost's buildings
    When I call the tool "allegiance_act" with {"action": "aim-at", "at": "structure", "pitch": -0.3}
    And I advance 5 frames
    And I call the tool "allegiance_act" with {"action": "cobra-fire", "at": "structure", "count": 5}
    And I advance 4 frames
    Then I call the tool "allegiance_state"
    And I capture "cobra-blast"
    When I advance 45 frames
    Then I call the tool "allegiance_state"
    And I capture "cobra-collapse"
    When I call the tool "allegiance_act" with {"action": "fx-run", "seconds": 14}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    And I capture "cobra-rubble"

  Scenario: A map house breaks apart too
    When I call the tool "allegiance_act" with {"action": "aim-at", "at": "building", "pitch": -0.3}
    And I advance 5 frames
    And I call the tool "allegiance_act" with {"action": "cobra-fire", "at": "building", "count": 6}
    And I advance 30 frames
    Then I call the tool "allegiance_state"
    And I capture "house-collapse"

  Scenario: The ruins are kept with the campaign
    When I call the tool "allegiance_act" with {"action": "fx-run", "seconds": 14}
    And I call the tool "allegiance_act" with {"action": "save"}
    And I call the tool "allegiance_ui" with {"mode": "title"}
    And I advance 5 frames
    And I call the tool "allegiance_act" with {"action": "load"}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "ruins-continued"
