Feature: QuadPlanet cities - OpenStreetMap buildings and roads on Earth, with Mesha houses
  Earth's buildings and roads come from OpenStreetMap vector tiles (OpenFreeMap), streamed in
  around you: every building is a box, every road a ribbon on the real ground, and buildings the
  house model fits are drawn as Mesha houses - full, with their rooms, close by; simplified
  farther out. Played with ENTROPY_QUADPLANET_BDD_FEATURE=tests/features/quadplanet_city_live.feature.

  Scenario: A street in Levittown, New York
    When I call the tool "quadplanet_goto" with {"lat": 40.72147, "lon": -73.503905, "mode": "teleport"}
    And I call the tool "quadplanet_city" with {"lod0Radius": 40, "maxLod0": 6, "lod1Radius": 220}
    And I call the tool "quadplanet_settle" with {"timeoutMs": 240000}
    And I advance 5 frames
    Then I call the tool "quadplanet_city" with {"nearest": 8}
    And I capture "01-street"
    When I call the tool "quadplanet_view" with {"mode": "follow", "zoom": 30, "pitch": 0.3, "yaw": 1.6}
    And I advance 5 frames
    Then I capture "02-street-wide"
    When I call the tool "quadplanet_view" with {"mode": "follow", "zoom": 30, "pitch": 0.3, "yaw": -1.6}
    And I advance 5 frames
    Then I capture "02b-street-other-way"
    When I call the tool "quadplanet_view" with {"mode": "overhead", "height": 140}
    And I call the tool "quadplanet_settle" with {"timeoutMs": 120000}
    And I advance 5 frames
    Then I call the tool "quadplanet_state"
    And I capture "03-overhead-near"
    When I call the tool "quadplanet_view" with {"mode": "overhead", "height": 700}
    And I call the tool "quadplanet_settle" with {"timeoutMs": 120000}
    And I advance 5 frames
    Then I call the tool "quadplanet_state"
    And I capture "04-overhead-far"
