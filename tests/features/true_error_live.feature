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
    # Aim assist at its default 50%: just beside a machine, holding LT pulls the crosshair onto it.
    When I call the tool "te_act" with {"action": "teleport", "pos": [-12, 0, -6], "yaw": 1.57, "pitch": -0.02, "frames": 4}
    And I call the tool "te_act" with {"action": "aimNear", "id": "roller-1", "off": 0.06, "frames": 1}
    Then I call the tool "te_expect" with {"onTarget": false}
    When I press the gamepad button "LeftTrigger2"
    And I advance 30 frames
    Then I call the tool "te_expect" with {"onTarget": true, "aiming": true}
    And I capture "24-aim-assist"
    And I release the gamepad button "LeftTrigger2"

  Scenario: Crouch, roll and a collectible held up and kept
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "bridge", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [36, 14, 0], "yaw": 1.57, "pitch": -0.05, "frames": 10}
    Then I call the tool "te_expect" with {"stage": "bridge", "crouched": false}
    And I capture "30-bridge-girder"
    When I call the tool "te_act" with {"action": "crouch", "on": true, "frames": 12}
    Then I call the tool "te_expect" with {"crouched": true}
    And I capture "31-crouched"
    When I call the tool "te_act" with {"action": "crouch", "on": false, "frames": 12}
    And I call the tool "te_act" with {"action": "teleport", "pos": [37.5, 14, 0], "yaw": 1.57, "pitch": -0.05, "frames": 2}
    And I call the tool "te_act" with {"action": "roll", "frames": 6}
    Then I call the tool "te_expect" with {"rolling": true}
    And I capture "32-rolling"
    When I call the tool "te_act" with {"action": "step", "frames": 30}
    Then I call the tool "te_state"
    When I call the tool "te_act" with {"action": "teleport", "pos": [48.6, 14, -0.6], "yaw": 3.14, "pitch": -0.3, "frames": 6}
    Then I capture "33-commuter-pass-on-bench"
    When I call the tool "te_act" with {"action": "inspect", "id": "commuter-pass", "frames": 20}
    Then I call the tool "te_expect" with {"mode": "inspect", "inspecting": "commuter-pass"}
    And I capture "34-inspect"
    When I call the tool "te_act" with {"action": "keep", "frames": 10}
    Then I call the tool "te_expect" with {"mode": "play", "kept": 1}
    When I call the tool "te_act" with {"action": "camera", "pos": [48, 24, -26], "target": [48, 14, 0], "fov": 55, "frames": 4}
    Then I capture "35-sky-bridge-wide"
    # The crawler patrols west from x 86: its head should lead (left in this frame).
    When I call the tool "te_act" with {"action": "camera", "pos": [84, 16.5, 1.9], "target": [84, 14.3, -0.7], "fov": 45, "frames": 2}
    Then I capture "36-crawler-side"
    And I call the tool "te_act" with {"action": "release", "frames": 1}

  Scenario: The Relay Tower - the chasm, the vault, the breakers
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "biochip", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [103, 14, 10], "yaw": 1.57, "pitch": -0.25, "frames": 10}
    Then I capture "40-chasm"
    When I call the tool "te_act" with {"action": "lens", "index": 4, "frames": 10}
    Then I capture "41-chasm-sim-beams"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [120.6, 14, 11.8], "yaw": 0.6, "pitch": -0.1, "frames": 4}
    And I call the tool "te_act" with {"action": "face", "at": [122, 15, 13], "frames": 6}
    Then I capture "42-vault-biochip"
    When I call the tool "te_act" with {"action": "use", "frames": 10}
    Then I call the tool "te_expect" with {"biochip": true, "stage": "conduit"}
    When I call the tool "te_act" with {"action": "teleport", "pos": [104, 7, -13], "yaw": 1.57, "pitch": -0.05, "frames": 10}
    Then I capture "43-archive-dark"
    When I call the tool "te_act" with {"action": "teleport", "pos": [121, 7, -13], "yaw": 1.57, "pitch": -0.05, "frames": 10}
    Then I capture "44-breakers"
    When I call the tool "te_act" with {"action": "lens", "index": 2, "frames": 8}
    Then I capture "45-breakers-heat"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [123, 7, -9.8], "yaw": 1.57, "pitch": -0.05, "frames": 4}
    And I call the tool "te_act" with {"action": "use", "frames": 20}
    Then I call the tool "te_expect" with {"stage": "descent"}
    When I call the tool "te_act" with {"action": "camera", "pos": [140, 30, -40], "target": [108, 10, 0], "fov": 50, "frames": 4}
    Then I capture "46-relay-tower"
    And I call the tool "te_act" with {"action": "release", "frames": 1}

  Scenario: The Descent and the Return - reactor, hold-out, lift, Warden
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "descent", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [92, 0, -8.2], "yaw": 3.14, "pitch": -0.35, "frames": 10}
    Then I capture "50-stair-shaft"
    When I call the tool "te_act" with {"action": "stage", "id": "crossing", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [64, -14, -12], "yaw": -1.57, "pitch": -0.05, "frames": 10}
    Then I capture "51-lower-bridge"
    When I call the tool "te_act" with {"action": "stage", "id": "reactor", "frames": 4}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-4.4, -14, -4], "yaw": -1.57, "pitch": -0.05, "frames": 10}
    Then I capture "52-reactor-console"
    When I call the tool "te_act" with {"action": "use", "frames": 10}
    Then I call the tool "te_expect" with {"stage": "holdout"}
    When I call the tool "te_act" with {"action": "step", "frames": 240}
    Then I call the tool "te_state"
    And I capture "53-holdout"
    When I call the tool "te_act" with {"action": "stage", "id": "lift", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-21.85, -14, 15.6], "yaw": 0, "pitch": -0.05, "frames": 6}
    And I call the tool "te_act" with {"action": "use", "frames": 30}
    Then I call the tool "te_expect" with {"stage": "ride", "riding": true}
    And I capture "54-lift-ride"
    When I call the tool "te_act" with {"action": "step", "frames": 600}
    Then I call the tool "te_expect" with {"stage": "warden"}
    # A fresh start at the Warden: it patrols where it landed, so the frame is the same every run.
    When I call the tool "te_act" with {"action": "stage", "id": "warden", "frames": 90}
    And I call the tool "te_act" with {"action": "camera", "pos": [-1, 16, -3], "target": [2, 15, -7], "fov": 45, "frames": 2}
    Then I capture "55-warden"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "win", "frames": 100}
    Then I capture "57-awaken"
