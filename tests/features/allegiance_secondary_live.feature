Feature: Comrades, the flying car's levels of detail, rooftop landing, the territory overlay, shops and invasions
  Your comrades walk in a loose column a few meters behind you, hold a spot when told and come
  back when called. When you take off they ride in their own cars in formation. In the air every
  house and block is drawn as its simplified exterior, and high up the ground shows who governs
  it. The car lands quickly, on clear ground or a flat roof; from a roof you take the stairs.
  Shops carry sky markers. An invasion on the march raises an alert with one-click dispatch.

  Scenario: Comrades walk a few meters behind you
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033, "weather": {"cloudCover": 0.15, "windSpeed": 2, "windHeading": 0.6}}
    And I call the tool "allegiance_new" with {"hometown": "London", "lat": 51.5033, "lon": -0.1196, "seed": 7, "mission": false}
    And I call the tool "allegiance_settle" with {"timeoutMs": 600000}
    And I advance 20 frames
    And I call the tool "allegiance_act" with {"action": "view", "firstPerson": false, "distance": 11, "pitch": -0.3}
    And I hold the key "w" for 90 frames
    And I advance 90 frames
    Then I call the tool "allegiance_state"
    And I capture "comrades-column"

  Scenario: The previous and the new level-of-detail budgets on the same street
    When I call the tool "allegiance_config" with {"houseLod": {"lod0Radius": 40, "maxLod0": 4, "lod1Radius": 260, "triangleBudget": 3000000}, "buildingLod": {"lod0Radius": 90, "maxLod0": 40, "lod1Radius": 600, "triangleBudget": 4000000}}
    And I advance 40 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"houseLod": null, "buildingLod": null}
    And I advance 40 frames
    Then I call the tool "allegiance_state"

  Scenario: Comrades hold a spot, then fall in again
    When I hold the key "t" for 1 frames
    And I advance 3 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_act" with {"action": "walk", "dx": 0, "dz": -35}
    And I advance 60 frames
    Then I call the tool "allegiance_state"
    When I hold the key "t" for 1 frames
    And I advance 300 frames
    Then I call the tool "allegiance_state"

  Scenario: Comrades fly in their own cars; from the air the houses are exteriors and the ground shows its governors
    When I call the tool "allegiance_act" with {"action": "to-car"}
    And I advance 5 frames
    And I hold the key "e" for 1 frames
    And I advance 3 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": true, "left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"left": [0, 0], "right": [0, 0]}
    And I advance 10 frames
    And I call the tool "allegiance_controller" with {"button": "South", "pressed": false}
    And I advance 30 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_act" with {"action": "altitude", "meters": 650}
    And I call the tool "allegiance_act" with {"action": "view", "pitch": -0.75}
    And I advance 90 frames
    Then I call the tool "allegiance_state"
    And I capture "territory-overlay"

  Scenario: Land fast on a flat roof, and take the stairs
    When I call the tool "allegiance_act" with {"action": "over-roof", "above": 280}
    And I call the tool "allegiance_act" with {"action": "view", "pitch": -0.35}
    And I advance 5 frames
    And I hold the key "l" for 1 frames
    And I advance 900 frames
    Then I call the tool "allegiance_state"
    And I capture "roof-landing"
    When I hold the key "e" for 1 frames
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    When I hold the key "e" for 1 frames
    And I advance 5 frames
    Then I call the tool "allegiance_state"

  Scenario: Shops carry sky markers
    When I hold the key "e" for 1 frames
    And I advance 5 frames
    And I call the tool "allegiance_act" with {"action": "face-shop"}
    And I call the tool "allegiance_act" with {"action": "view", "firstPerson": true}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "shop-markers"

  Scenario: An invasion on the march, and one click sends help
    When I call the tool "allegiance_act" with {"action": "govern", "amount": 0.01}
    And I call the tool "allegiance_act" with {"action": "threaten", "count": 3000}
    And I call the tool "allegiance_act" with {"action": "troops", "count": 4000}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    And I capture "invasion-alert"
    When I call the tool "allegiance_click" with {"id": "threat-send-50"}
    And I advance 5 frames
    Then I call the tool "allegiance_state"

  Scenario: A squad fans out and takes cover
    When I call the tool "allegiance_act" with {"action": "squad", "count": 5}
    And I advance 450 frames
    Then I call the tool "allegiance_state"

  Scenario: The autopilot flies you toward a town 30 km away
    When I call the tool "allegiance_act" with {"action": "to-car"}
    And I advance 3 frames
    And I hold the key "e" for 1 frames
    And I advance 3 frames
    And I call the tool "allegiance_act" with {"action": "autopilot", "lat": 51.77, "lon": -0.12, "weapon": "Hatfield"}
    And I advance 900 frames
    Then I call the tool "allegiance_state"
    And I capture "autopilot"
