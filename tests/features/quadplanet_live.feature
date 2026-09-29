Feature: QuadPlanet in the real window
  Planets are quadtree terrain wrapped around a sphere: six cube-face quadtrees streamed around the
  camera, finest where you stand. You start on Verdant next to your ship, walk over to it, board,
  lift off, let the autopilot fly you across to Ember, and step out and walk there. The run uses a
  fixed simulation step so the same keys always walk the same distance. Screenshots of the real
  window are kept for visual verification, and tests/quadplanet_live.rs checks the tools' replies
  and the pixels.

  Background:
    Given the real QuadPlanet app is running in test mode

  Scenario: Standing on Verdant
    When I call the tool "quadplanet_config" with {"fixedStep": 0.0333}
    And I advance 120 frames
    Then I see the label "W/S walk  A/D turn  Shift run  Space jump  E board"
    And I call the tool "quadplanet_state"
    And I capture "01-standing-on-verdant"

  Scenario: The rings of detail around you
    When I call the tool "quadplanet_config" with {"debugLod": true, "debugOutlines": true}
    And I call the tool "quadplanet_view" with {"mode": "overhead", "height": 450}
    And I advance 60 frames
    Then I capture "01b-detail-rings-around-you"
    When I call the tool "quadplanet_config" with {"debugLod": false, "debugOutlines": false}
    And I call the tool "quadplanet_view" with {"mode": "follow"}
    And I advance 60 frames

  Scenario: Walking over to the ship
    When I hold the key "w" for 40 frames
    And I advance 3 frames
    Then I call the tool "quadplanet_state"
    And I capture "02-walked-to-the-ship"

  Scenario: Boarding and lift-off
    When I hold the key "e" for 1 frame
    And I advance 2 frames
    Then I call the tool "quadplanet_state"
    When I hold the key " " for 45 frames
    And I hold the key "w" for 30 frames
    Then I call the tool "quadplanet_state"
    And I capture "03-lift-off"

  Scenario: The autopilot flies to Ember
    When I call the tool "quadplanet_autopilot" with {"target": "Ember"}
    And I advance 170 frames
    Then I call the tool "quadplanet_state"
    And I capture "04-between-planets"
    When I advance 330 frames
    Then I call the tool "quadplanet_state"
    And I capture "05-landed-on-ember"

  Scenario: Walking on Ember
    When I hold the key "e" for 1 frame
    And I hold the key "w" for 45 frames
    And I advance 20 frames
    Then I call the tool "quadplanet_state"
    And I capture "06-walking-on-ember"

  Scenario: The quadtree seen from orbit
    When I call the tool "quadplanet_view" with {"mode": "orbit", "planet": "Ember", "distance": 1.35}
    And I call the tool "quadplanet_config" with {"debugLod": true}
    And I advance 30 frames
    Then I call the tool "quadplanet_state"
    And I capture "07-ember-quadtree-from-orbit"
    When I call the tool "quadplanet_config" with {"debugLod": false}
    And I call the tool "quadplanet_view" with {"mode": "orbit", "planet": "Verdant", "distance": 3.3}
    And I advance 40 frames
    Then I capture "08-verdant-from-orbit"
    When I call the tool "quadplanet_view" with {"mode": "follow"}
    And I advance 20 frames
    Then I call the tool "quadplanet_state"
    And I capture "09-back-on-ember"

  Scenario: On to Glacia
    When I hold the key "s" for 20 frames
    And I hold the key "e" for 1 frame
    And I advance 2 frames
    Then I call the tool "quadplanet_state"
    When I call the tool "quadplanet_autopilot" with {"target": "Glacia"}
    And I advance 720 frames
    Then I call the tool "quadplanet_state"
    And I capture "10-landed-on-glacia"
    When I hold the key "e" for 1 frame
    And I hold the key "d" for 20 frames
    And I hold the key "w" for 40 frames
    And I advance 10 frames
    Then I call the tool "quadplanet_state"
    And I capture "11-walking-on-glacia"
