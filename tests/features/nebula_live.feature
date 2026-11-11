Feature: Nebula Kingdom
  Played with ENTROPY_NEBULA_BDD_RESULT (tests/nebula_live.rs). Captures land beside the result.

  Scenario: A Wisp in the Cradle Shoals
    Given the real Nebula Kingdom game is running in test mode
    When I call the tool "nebula_config" with {"fixedStep": 0.033, "sound": false}
    And I advance 20 frames
    Then I call the tool "nebula_state"
    And I capture "01-title"
    When I call the tool "nebula_start" with {"region": "cradle"}
    And I call the tool "nebula_act" with {"action": "wait", "frames": 90}
    Then I capture "02-cradle"
    When I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_camera" with {"position": [1.8, 0.7, -2.6], "target": [0, 0, 0], "fov": 50}
    And I advance 2 frames
    Then I capture "03-the-nebula"
    When I call the tool "nebula_camera" with {"release": true}
    And I call the tool "nebula_act" with {"action": "fly", "to": "mote", "frames": 240}
    Then I call the tool "nebula_state"
    When I call the tool "nebula_act" with {"action": "teleport", "to": "pell", "distance": 2.5}
    And I call the tool "nebula_act" with {"action": "siphon", "frames": 70}
    Then I capture "04-mining-pell"
    When I call the tool "nebula_act" with {"action": "siphon", "frames": 400}
    Then I call the tool "nebula_state"
    When I call the tool "nebula_act" with {"action": "teleport", "to": "gnawer", "distance": 9}
    And I call the tool "nebula_act" with {"action": "fly", "to": "gnawer", "frames": 45, "fire": true, "hold": true}
    Then I capture "05-the-lance"
    When I call the tool "nebula_act" with {"action": "teleport", "to": "envoy", "distance": 5}
    And I call the tool "nebula_act" with {"action": "attune"}
    And I call the tool "nebula_act" with {"action": "wait", "frames": 40}
    Then I capture "06-attuned-to-the-envoy"
    When I call the tool "nebula_act" with {"action": "teleport", "to": "hearth", "distance": 5}
    And I advance 3 frames
    Then I capture "07-hearth-a-living-world"

  Scenario: Governments, stars and black holes
    Given the real Nebula Kingdom game is running in test mode
    When I call the tool "nebula_start" with {"region": "hearthring"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "candle", "distance": 4}
    And I call the tool "nebula_act" with {"action": "siphon", "frames": 60}
    Then I capture "08-the-first-star"
    When I call the tool "nebula_start" with {"region": "bazaar"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "sump", "distance": 14}
    And I advance 3 frames
    Then I capture "09-the-sump"
    When I call the tool "nebula_start" with {"region": "cinders"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "throne", "distance": 10}
    And I advance 3 frames
    Then I capture "10-the-throne-star"
    When I call the tool "nebula_start" with {"region": "choir"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "medusa", "distance": 6}
    And I call the tool "nebula_act" with {"action": "attune"}
    And I call the tool "nebula_act" with {"action": "wait", "frames": 30}
    Then I capture "11-the-choir"
    When I call the tool "nebula_act" with {"action": "decoy"}
    And I call the tool "nebula_act" with {"action": "wait", "frames": 20}
    Then I call the tool "nebula_state"
    When I call the tool "nebula_start" with {"region": "throne"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "king", "distance": 30}
    And I advance 3 frames
    Then I capture "12-the-hollow-king"

  Scenario: The Star Chart, the Codex, and a fold between galaxies
    Given the real Nebula Kingdom game is running in test mode
    When I call the tool "nebula_start" with {"region": "wake"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "screen", "screen": "chart", "select": "cradle"}
    Then I capture "13-star-chart"
    When I call the tool "nebula_act" with {"action": "screen", "screen": "codex"}
    Then I capture "14-codex"
    When I call the tool "nebula_act" with {"action": "facet", "id": "current"}
    And I call the tool "nebula_act" with {"action": "screen", "screen": "play"}
    And I call the tool "nebula_act" with {"action": "fold", "region": "cradle", "frames": 24}
    Then I capture "15-folding"
    When I call the tool "nebula_act" with {"action": "wait", "frames": 260}
    And I call the tool "nebula_act" with {"action": "banner"}
    Then I call the tool "nebula_state"
    And I capture "16-a-giant-comes-home"

  Scenario: The Field Guide, the gamepad, blasts, forms and mercy
    Given the real Nebula Kingdom game is running in test mode
    When I call the tool "nebula_config" with {"fixedStep": 0.033, "sound": false, "device": "pad"}
    And I call the tool "nebula_start" with {"title": true}
    And I advance 3 frames
    Then I capture "17-title-gamepad-controls"
    When I call the tool "nebula_start" with {"region": "cradle"}
    And I call the tool "nebula_act" with {"action": "wait", "frames": 40}
    Then I call the tool "nebula_state"
    And I capture "18-field-guide"
    When I call the tool "nebula_start" with {"region": "bazaar"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "wait", "frames": 20}
    And I call the tool "nebula_act" with {"action": "lesson"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "sump", "distance": 14}
    And I advance 3 frames
    Then I capture "19-slingshot-explained"
    When I call the tool "nebula_start" with {"region": "marches"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "blast", "id": "beam"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "prism", "distance": 9}
    And I call the tool "nebula_act" with {"action": "fly", "to": "prism", "frames": 20, "fire": true, "hold": true}
    Then I capture "20-sunthread-on-glass"
    When I call the tool "nebula_start" with {"region": "tollgate", "level": 8}
    And I call the tool "nebula_act" with {"action": "form", "id": "emission"}
    And I call the tool "nebula_act" with {"action": "screen", "screen": "codex"}
    Then I capture "21-codex-forms-and-blasts"
    When I call the tool "nebula_act" with {"action": "screen", "screen": "play"}
    And I call the tool "nebula_act" with {"action": "banner"}
    And I call the tool "nebula_act" with {"action": "teleport", "to": "vash", "distance": 7}
    And I call the tool "nebula_act" with {"action": "fly", "to": "vash", "frames": 360, "fire": true, "hold": true}
    Then I call the tool "nebula_state"
    And I capture "22-mercy-or-hunger"
