Feature: Allegiance's textured materials
  Fieldstone maps (base color, normal, roughness, height) on the compounds' perimeter walls, with
  parallax occlusion close up and plain normal mapping further away.

  Scenario: A fieldstone wall up close and from across the road
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033, "weather": {"cloudCover": 0.3, "windSpeed": 4, "windHeading": 0.8}}
    And I call the tool "allegiance_new" with {"hometown": "London", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 600000}
    And I call the tool "allegiance_config" with {"dayClock": 40}
    And I call the tool "allegiance_act" with {"action": "compound"}
    And I advance 20 frames
    When I call the tool "allegiance_act" with {"action": "view-wall"}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    And I capture "mat-wall-near"
    When I call the tool "allegiance_act" with {"action": "view-wall", "distance": 12}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    And I capture "mat-wall-far"
