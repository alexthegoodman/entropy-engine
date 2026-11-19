Feature: True Error - scenery kit and wear
  Fixed views of both missions for judging the scenery (te_dressing.ts: the kit's props, the wall
  kit, Noctis's roads and scrub) and the shaders' procedural wear. Played like the other features: point
  ENTROPY_TRUE_ERROR_BDD_FEATURE here (tests/true_error_live.rs plays it after the Noctis feature).

  Scenario: The Spire, dressed
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "climb", "frames": 4}
    And I call the tool "te_act" with {"action": "help", "on": false}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-13.6, 0, -15.6], "yaw": 1.57, "pitch": -0.05, "frames": 10}
    Then I capture "s00a-lab-spawn"
    When I call the tool "te_act" with {"action": "teleport", "pos": [-13.6, 0, -15.6], "yaw": 3.14, "pitch": -0.05, "frames": 10}
    Then I capture "s00b-lab-north"
    When I call the tool "te_act" with {"action": "camera", "pos": [-12, 1.7, -13], "target": [-8.2, 1.3, -19], "fov": 60, "frames": 4}
    Then I capture "s00c-lab-east-wall"
    When I call the tool "te_act" with {"action": "camera", "pos": [-15, 1.7, -14], "target": [-20, 1.3, -10.2], "fov": 60, "frames": 4}
    Then I capture "s00d-lab-north-wall"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-2, 0, 6], "yaw": 1.9, "pitch": -0.08, "frames": 10}
    Then I capture "s01-first-floor"
    When I call the tool "te_act" with {"action": "teleport", "pos": [6, 0, -4], "yaw": 1.2, "pitch": -0.15, "frames": 10}
    Then I capture "s02-blast-edge"
    When I call the tool "te_act" with {"action": "teleport", "pos": [-14, 7, 10], "yaw": 1.57, "pitch": -0.08, "frames": 10}
    Then I capture "s03-second-floor"
    When I call the tool "te_act" with {"action": "camera", "pos": [-20, 2.6, -20], "target": [0, 0.5, 0], "fov": 60, "frames": 4}
    Then I capture "s04-floor-wide"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "stage", "id": "reactor", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [6, -14, -12], "yaw": -1.2, "pitch": -0.08, "frames": 10}
    Then I capture "s05-reactor-floor"
    When I call the tool "te_act" with {"action": "stage", "id": "biochip", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [100, 14, 6], "yaw": 2.6, "pitch": -0.1, "frames": 10}
    Then I capture "s06-relay"

  Scenario: Noctis, dressed
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "fixed", "dt": 0.0333}
    And I call the tool "te_act" with {"action": "stage", "id": "noctis", "frames": 4}
    And I call the tool "te_act" with {"action": "help", "on": false}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-1.5, 0, 149], "yaw": 2.6, "pitch": -0.05, "frames": 10}
    Then I capture "s10-camp"
    When I call the tool "te_act" with {"action": "camera", "pos": [18, 3.5, 120], "target": [60, 1.5, 78], "fov": 55, "frames": 6}
    Then I capture "s11-spire-road"
    When I call the tool "te_act" with {"action": "camera", "pos": [30, 40, 150], "target": [0, 0, 40], "fov": 60, "frames": 6}
    Then I capture "s12-canyon-high"
    When I call the tool "te_act" with {"action": "camera", "pos": [70, 14, 50], "target": [120, 4, 42], "fov": 55, "frames": 6}
    Then I capture "s13-foundry"
    When I call the tool "te_act" with {"action": "camera", "pos": [44, 4, -30], "target": [-10, 0, -46], "fov": 55, "frames": 6}
    Then I capture "s14-barge-road"
    When I call the tool "te_act" with {"action": "camera", "pos": [-88, 9, -78], "target": [-116, 2, -106], "fov": 55, "frames": 6}
    Then I capture "s15-pumphouse"
    When I call the tool "te_act" with {"action": "camera", "pos": [96, 7, -76], "target": [132, -6, -120], "fov": 55, "frames": 6}
    Then I capture "s16-quarry"
    When I call the tool "te_act" with {"action": "camera", "pos": [-90, 18, 18], "target": [-120, 3, 50], "fov": 55, "frames": 6}
    Then I capture "s17-gate"
    When I call the tool "te_act" with {"action": "camera", "pos": [-40, 3, 96], "target": [-52, 1, 50], "fov": 60, "frames": 6}
    Then I capture "s18-highway-road"
    When I call the tool "te_act" with {"action": "release", "frames": 1}
    And I call the tool "te_act" with {"action": "teleport", "pos": [15, 0.8, 52], "yaw": 3.1, "pitch": -0.05, "frames": 10}
    Then I capture "s19-on-the-road"
    When I call the tool "te_act" with {"action": "stage", "id": "undercroft", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 2}
    And I call the tool "te_act" with {"action": "teleport", "pos": [90, -44, -168], "yaw": 1.57, "pitch": -0.05, "frames": 10}
    Then I capture "s20-metro-platform"
