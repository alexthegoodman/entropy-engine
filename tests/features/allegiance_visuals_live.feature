Feature: Allegiance's world in light and weather
  Sun shadows from buildings, trees and people (cascades around the camera), clouds drifting over
  the sky and their shadows on the ground, trees bending in the wind, and city surfaces drawn as
  brick, render, stone, tiles and wood with weathering.

  Scenario: A sunlit London street
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033, "weather": {"cloudCover": 0.45, "windSpeed": 7, "windHeading": 0.8}}
    And I call the tool "allegiance_new" with {"hometown": "London", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 600000}
    And I call the tool "allegiance_config" with {"dayClock": 14}
    And I advance 20 frames
    When I call the tool "allegiance_act" with {"action": "view-building"}
    And I advance 40 frames
    Then I call the tool "allegiance_state"
    And I capture "vis-street"

  Scenario: The same street without sun shadows
    When I call the tool "allegiance_config" with {"shadows": false}
    And I advance 2 frames
    And I capture "vis-street-unshadowed"
    When I call the tool "allegiance_config" with {"shadows": true}
    And I advance 2 frames

  Scenario: Shadows across the street
    When I call the tool "allegiance_act" with {"action": "face", "sunSide": 1.5708, "pitch": -0.3}
    And I advance 6 frames
    And I capture "vis-shadows"

  Scenario: Clouds over the rooftops
    When I call the tool "allegiance_act" with {"action": "face", "sunSide": 0.7, "pitch": 0.5}
    And I advance 6 frames
    And I capture "vis-sky"

  Scenario: A garden in the wind
    When I call the tool "allegiance_act" with {"action": "house"}
    And I call the tool "allegiance_act" with {"action": "face", "turn": 3.14159, "pitch": -0.1}
    And I advance 30 frames
    Then I call the tool "allegiance_state"
    And I capture "vis-garden"
    When I advance 25 frames
    And I capture "vis-garden-gust"
