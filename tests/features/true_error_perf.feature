Feature: True Error - frame time at fixed views
  Not part of tests/true_error_live.rs: run it on its own through ENTROPY_TRUE_ERROR_BDD_FEATURE, with
  ENTROPY_WINDOW_SIZE=WxH for the resolution and ENTROPY_FRAME_PROFILE=1 for the GPU pass rows.
  Each view warms up, then `te_act mark` opens a window of real frames that the next te_state reports
  as frameMs (avg, p50, p95 in ms). The game runs at real time with every machine calmed.

  Scenario: The Spire and Noctis held still
    Given the real True Error game is running in test mode
    When I call the tool "te_act" with {"action": "play", "frames": 20}
    And I call the tool "te_act" with {"action": "calm", "frames": 1}
    And I call the tool "te_act" with {"action": "help", "on": false}

    # Act 1: the lab, over the shoulder.
    When I advance 90 frames
    And I call the tool "te_act" with {"action": "mark"}
    And I advance 240 frames
    Then I call the tool "te_state"
    And I capture "perf-01-lab"

    # The ledge, looking out over the skyline.
    When I call the tool "te_act" with {"action": "teleport", "pos": [8.5, 7, 3], "yaw": 3.1, "pitch": 0.0, "frames": 2}
    And I advance 90 frames
    And I call the tool "te_act" with {"action": "mark"}
    And I advance 240 frames
    Then I call the tool "te_state"
    And I capture "perf-02-ledge"

    # The atrium and the hypercube.
    When I call the tool "te_act" with {"action": "teleport", "pos": [7, 14, -6], "yaw": -0.9, "pitch": 0.12, "frames": 2}
    And I advance 90 frames
    And I call the tool "te_act" with {"action": "mark"}
    And I advance 240 frames
    Then I call the tool "te_state"
    And I capture "perf-03-atrium"

    # Outside: the spire, the bridge and the city behind.
    When I call the tool "te_act" with {"action": "camera", "pos": [30, 22, -40], "target": [-4, 12, 0], "fov": 50, "frames": 2}
    And I advance 90 frames
    And I call the tool "te_act" with {"action": "mark"}
    And I advance 240 frames
    Then I call the tool "te_state"
    And I capture "perf-04-exterior"
    And I call the tool "te_act" with {"action": "release", "frames": 1}

    # Noctis: the canyon from the rover, then wide.
    When I call the tool "te_act" with {"action": "stage", "id": "noctis", "frames": 4}
    And I call the tool "te_act" with {"action": "calm", "frames": 1}
    And I call the tool "te_act" with {"action": "teleport", "pos": [-1, 0, 142.4], "yaw": 3.14, "frames": 2}
    And I advance 90 frames
    And I call the tool "te_act" with {"action": "mark"}
    And I advance 240 frames
    Then I call the tool "te_state"
    And I capture "perf-05-noctis"

    When I call the tool "te_act" with {"action": "camera", "pos": [-20, 30, -110], "target": [0, 20, 200], "fov": 60, "frames": 2}
    And I advance 90 frames
    And I call the tool "te_act" with {"action": "mark"}
    And I advance 240 frames
    Then I call the tool "te_state"
    And I capture "perf-06-noctis-wide"
