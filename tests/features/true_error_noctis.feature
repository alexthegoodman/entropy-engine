Feature: True Error - Mission 2, Noctis
  Played with ENTROPY_TRUE_ERROR_BDD_RESULT (tests/true_error_live.rs, ENTROPY_TRUE_ERROR_BDD_FEATURE
  pointing here). The pure-TypeScript tier is examples/studio-bundle/tests/true_error_noctis.test.ts.

  Scenario: Down to Noctis - the intro, the camp, the canyon, the Doctor's scattergun
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "mission", "n": 2, "frames": 60}
    Then I call the tool "te_expect" with {"mode": "intro", "mission": 2}
    And I capture "n01-intro-canyon"
    When I call the tool "te_act" with {"action": "step", "frames": 150}
    Then I capture "n02-intro-floor"
    When I call the tool "te_act" with {"action": "step", "frames": 180}
    Then I capture "n03-intro-doctor"
    When I call the tool "te_act" with {"action": "play", "frames": 20}
    And I call the tool "te_act" with {"action": "help", "on": true}
    Then I call the tool "te_expect" with {"mode": "play", "stage": "embark"}
    And I capture "n04-camp"
    When I call the tool "te_act" with {"action": "teleport", "pos": [-1, 0, 142.4], "yaw": 3.14, "frames": 4}
    And I call the tool "te_act" with {"action": "use", "frames": 30}
    Then I call the tool "te_expect" with {"stage": "noctis", "weapon": "scatter"}
    And I capture "n05-scattergun"
    When I call the tool "te_act" with {"action": "camera", "pos": [30, 40, 150], "target": [0, 0, 40], "fov": 60, "frames": 4}
    Then I capture "n06-canyon-south"
    When I call the tool "te_act" with {"action": "camera", "pos": [-20, 30, -110], "target": [0, 20, 200], "fov": 60, "frames": 4}
    Then I capture "n07-canyon-north-capital"

  Scenario: The Foundry, Gate Four and the barge
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "noctis", "frames": 4}
    And I call the tool "te_act" with {"action": "help", "on": false}
    And I call the tool "te_act" with {"action": "camera", "pos": [70, 14, 50], "target": [120, 4, 42], "fov": 55, "frames": 4}
    Then I capture "n10-foundry-outside"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "teleport", "pos": [108, 0, 39.8], "yaw": 1.57, "pitch": 0.02, "frames": 10}
    Then I capture "n11-foundry-line"
    When I call the tool "te_act" with {"action": "teleport", "pos": [128, 0, 37], "yaw": -2.5, "pitch": 0.05, "frames": 10}
    Then I capture "n12-foundry-racks"
    When I call the tool "te_act" with {"action": "teleport", "pos": [108, 5.2, 55.4], "yaw": -1.57, "frames": 4}
    And I call the tool "te_act" with {"action": "use", "frames": 10}
    Then I call the tool "te_expect" with {"weapon": "gravity"}
    And I capture "n13-gravity-launcher"
    When I call the tool "te_act" with {"action": "teleport", "pos": [141, 1.2, 50.6], "yaw": 3.14, "frames": 4}
    And I call the tool "te_act" with {"action": "use", "frames": 40}
    Then I call the tool "te_state"
    And I capture "n14-racks-awake"
    When I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "camera", "pos": [-90, 18, 18], "target": [-120, 3, 50], "fov": 55, "frames": 4}
    Then I capture "n15-gate-four"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-118, 1.2, 24], "yaw": 0.25, "pitch": 0.03, "frames": 6}
    And I call the tool "te_act" with {"action": "lens", "index": 4, "frames": 12}
    Then I capture "n16-gate-ghost-queue"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-75, 7, 77], "yaw": -1.57, "pitch": 0.0, "frames": 4}
    And I call the tool "te_act" with {"action": "lens", "index": 4, "frames": 12}
    Then I capture "n17-highway-sim-span"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "camera", "pos": [78, 11, -26], "target": [20, -3, -60], "fov": 55, "frames": 4}
    Then I capture "n18-barge"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "teleport", "pos": [63.5, 0, -42.6], "yaw": 3.14, "frames": 4}
    And I call the tool "te_act" with {"action": "crank", "frames": 160}
    Then I call the tool "te_state"
    And I capture "n19-cranking"
    When I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "crank", "frames": 340}
    And I call the tool "te_act" with {"action": "camera", "pos": [80, 6, -30], "target": [68, 10, -45], "fov": 55, "frames": 6}
    Then I call the tool "te_state"
    And I capture "n20-mast-up"

  Scenario: Hollows, cherubs, takedowns and the gravity well
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "noctis", "frames": 4}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-118, 1.2, 30], "yaw": 0.0, "pitch": 0.25, "frames": 40}
    Then I capture "n21-cherubs"
    When I call the tool "te_act" with {"action": "weapon", "name": "scatter", "frames": 2}
    And I call the tool "te_act" with {"action": "fire", "aimAt": "cherub-1", "frames": 30}
    Then I capture "n22-scattergun-fire"
    When I call the tool "te_act" with {"action": "teleport", "pos": [62, 0, 58], "yaw": 0.0, "pitch": 0.0, "frames": 2}
    And I call the tool "te_act" with {"action": "face", "at": [64, 1, 76], "frames": 40}
    Then I capture "n23-hollow-hunting"
    When I call the tool "te_act" with {"action": "weapon", "name": "gravity", "frames": 2}
    And I call the tool "te_act" with {"action": "fire", "aimAt": "n-hollow-1", "frames": 40}
    Then I capture "n24-gravity-well"
    When I call the tool "te_act" with {"action": "step", "frames": 30}
    Then I call the tool "te_state"
    And I capture "n25-crush"

  Scenario: Radio silence, the pumphouse, the Tithe, the Undercroft and the rim
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "camp", "frames": 4}
    And I call the tool "te_act" with {"action": "teleport", "pos": [12, 0, 136], "yaw": -0.9, "pitch": -0.15, "frames": 10}
    Then I capture "n30-camp-wrecked"
    When I call the tool "te_act" with {"action": "stage", "id": "beacons", "frames": 4}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-128, 0, -84], "yaw": 2.6, "pitch": 0.02, "frames": 10}
    Then I capture "n31-pumphouse-pods"
    When I call the tool "te_act" with {"action": "lens", "index": 2, "frames": 6}
    Then I capture "n32-pods-heat"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "stage", "id": "tithe", "frames": 30}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-108, 0, -91], "yaw": 2.2, "pitch": 0.02, "frames": 10}
    Then I capture "n33-the-tithe"
    When I call the tool "te_act" with {"action": "stage", "id": "undercroft", "frames": 6}
    And I call the tool "te_act" with {"action": "teleport", "pos": [130, -44, -142.5], "yaw": 3.14, "pitch": 0.05, "frames": 10}
    Then I capture "n34-the-pit"
    When I call the tool "te_act" with {"action": "lens", "index": 1, "frames": 6}
    Then I capture "n35-pit-night-lens"
    When I call the tool "te_act" with {"action": "lens", "index": 0, "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [94, -44, -152], "yaw": -1.75, "pitch": 0.1, "frames": 60}
    Then I call the tool "te_state"
    And I capture "n36-cable-heart"
    When I call the tool "te_act" with {"action": "stage", "id": "tunnel", "frames": 6}
    And I call the tool "te_act" with {"action": "teleport", "pos": [100, -44, -170], "yaw": 1.57, "pitch": 0.02, "frames": 10}
    Then I capture "n37-metro-tunnel"
    When I call the tool "te_act" with {"action": "stage", "id": "rim", "frames": 30}
    Then I call the tool "te_state"
    And I capture "n38-tithe-ambush"
    When I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "win", "frames": 60}
    Then I capture "n39-outro"
    When I call the tool "te_act" with {"action": "step", "frames": 360}
    Then I call the tool "te_state"
    And I capture "n40-complete"
