Feature: True Error - Level 1, the Central Spire
  Played with ENTROPY_TRUE_ERROR_BDD_RESULT (tests/true_error_live.rs).
  The pure-TypeScript tier is examples/studio-bundle/tests/true_error_*.test.ts.

  Scenario: Title, intro and the climb to the hypercube
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I advance 30 frames
    Then I call the tool "te_state"
    And I capture "01-title"
    When I call the tool "te_act" with {"action": "begin", "frames": 75}
    Then I capture "02-intro-city"
    When I call the tool "te_act" with {"action": "step", "frames": 150}
    Then I capture "03-intro-spire"
    When I call the tool "te_act" with {"action": "step", "frames": 150}
    Then I capture "04-intro-lens"
    When I call the tool "te_act" with {"action": "step", "frames": 160}
    Then I capture "05-intro-doctor"
    When I call the tool "te_act" with {"action": "play", "frames": 20}
    And I call the tool "te_act" with {"action": "help", "on": true}
    Then I call the tool "te_state"
    And I capture "06-lab-over-the-shoulder"
    When I call the tool "te_act" with {"action": "look", "yaw": 0.0, "pitch": -0.05, "frames": 4}
    And I call the tool "te_act" with {"action": "move", "dx": 0, "dy": 1, "frames": 70}
    Then I call the tool "te_state"
    And I capture "07-lab-door"
    When I call the tool "te_act" with {"action": "teleport", "pos": [-2, 0, 6], "yaw": 1.9, "pitch": -0.08, "frames": 10}
    Then I capture "08-first-floor-edge"
    When I call the tool "te_act" with {"action": "teleport", "pos": [9, 0, -2], "yaw": 1.57, "pitch": -0.25, "frames": 10}
    Then I capture "09-the-drop"
    When I call the tool "te_act" with {"action": "teleport", "pos": [-12, 0, -6], "yaw": 1.57, "pitch": -0.02, "frames": 4}
    And I call the tool "te_act" with {"action": "face", "at": [2, 0.5, -8], "frames": 30}
    And I call the tool "te_act" with {"action": "fire", "aimAt": "roller-1", "frames": 12}
    Then I capture "10-photon-rifle"
    When I call the tool "te_act" with {"action": "camera", "pos": [-10.6, 1.6, -5.2], "target": [-12, 1.2, -6], "fov": 45, "frames": 2}
    Then I capture "10b-rifle-close"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    When I call the tool "te_act" with {"action": "fire", "aimAt": "roller-1", "frames": 14}
    And I call the tool "te_act" with {"action": "step", "frames": 10}
    Then I call the tool "te_state"
    And I capture "11-machine-down"
    When I call the tool "te_act" with {"action": "teleport", "pos": [-12, 7, 0], "yaw": 1.57, "pitch": -0.05, "frames": 10}
    Then I capture "12-dark-zone"
    When I call the tool "te_act" with {"action": "teleport", "pos": [8.5, 7, 3], "yaw": 3.1, "pitch": 0.0, "frames": 10}
    Then I capture "13-ledge"
    When I call the tool "te_act" with {"action": "lens", "index": 4, "frames": 10}
    Then I capture "14-simulation-lens"
    When I call the tool "te_act" with {"action": "lens", "index": 2, "frames": 6}
    Then I capture "15-heat-lens"
    When I call the tool "te_act" with {"action": "lens", "index": 1, "frames": 6}
    Then I capture "16-night-lens"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [8, 7, -20.5], "yaw": 0, "pitch": 0.2, "frames": 10}
    Then I capture "17-fallen-slab"
    When I call the tool "te_act" with {"action": "teleport", "pos": [7, 14, -6], "yaw": -0.9, "pitch": 0.12, "frames": 10}
    Then I call the tool "te_state"
    And I capture "18-atrium-hypercube"
    When I call the tool "te_act" with {"action": "camera", "pos": [-8, 16, -12], "target": [0, 18, 2], "fov": 55, "frames": 4}
    Then I capture "19-hypercube-wide"
    When I call the tool "te_act" with {"action": "camera", "pos": [30, 22, -40], "target": [-4, 12, 0], "fov": 50, "frames": 4}
    Then I capture "20-spire-east-face"
    When I call the tool "te_act" with {"action": "release", "frames": 2}
    And I call the tool "te_act" with {"action": "win", "frames": 100}
    Then I capture "21-outro"
    When I call the tool "te_act" with {"action": "step", "frames": 420}
    Then I call the tool "te_state"
    And I capture "22-level-complete"

  Scenario: The gamepad - skip, move, look, aim, fire, lenses
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "restart", "frames": 2}
    Then I call the tool "te_expect" with {"mode": "intro"}
    When I hold the gamepad button "East" for 1 frame
    And I advance 3 frames
    Then I call the tool "te_expect" with {"mode": "play", "device": "pad"}
    When I hold the gamepad sticks "0 1 0 0 0 0" for 40 frames
    Then I call the tool "te_expect" with {"moved": true, "turned": false}
    When I hold the gamepad sticks "0.8 0 0 0 0 0" for 2 frames
    And I hold the gamepad sticks "0 0 0.8 0 0 0" for 20 frames
    Then I call the tool "te_expect" with {"turned": true}
    When I press the gamepad button "LeftTrigger2"
    And I advance 8 frames
    Then I call the tool "te_expect" with {"aiming": true}
    When I press the gamepad button "RightTrigger2"
    And I advance 12 frames
    And I release the gamepad button "RightTrigger2"
    And I release the gamepad button "LeftTrigger2"
    And I advance 4 frames
    Then I call the tool "te_expect" with {"fired": true, "aiming": false}
    When I hold the gamepad button "North" for 1 frame
    And I advance 2 frames
    Then I call the tool "te_expect" with {"lens": "NIGHT"}
    When I hold the gamepad button "DPadLeft" for 1 frame
    And I advance 2 frames
    Then I call the tool "te_expect" with {"lens": "STANDARD"}
    And I capture "23-gamepad-help"
