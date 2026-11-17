Feature: Armageddon 2070 map review
  Ad-hoc captures of the ground between territories, for reviewing cover. Play it with
  ENTROPY_ARMAGEDDON_BDD_FEATURE=tests/features/armageddon_maps.feature (and ENTROPY_ARMAGEDDON_BDD_RESULT).

  Scenario: Glass Coast - Glass Dunes to the Coast Road Checkpoint, and a wall up close
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "glass-coast", "size": 32, "seed": 3, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_camera" with {"position": [150, 75, -70], "target": [250, 15, 150], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "m01-glass-dunes-to-checkpoint-from-above"
    When I call the tool "ar_camera" with {"position": [226, 27.4, 93], "target": [276, 24, 211], "fov": 70}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "m02-glass-dunes-to-checkpoint-on-foot"
    When I call the tool "ar_camera" with {"position": [35, 24.8, -486.8], "target": [47, 24.6, -488.5], "fov": 70}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "m03-hq-wall-up-close"
    When I call the tool "ar_camera" with {"position": [-160, 70, 60], "target": [-125, 18, 25], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "m04-fish-market-buildings"

  Scenario: Fusion Plant Seven - the Control Block to the southern HQ
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "fusion-plant-seven", "size": 32, "seed": 3, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_camera" with {"position": [60, 80, -110], "target": [-5, 5, -330], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "m05-control-block-to-hq-from-above"
    When I call the tool "ar_camera" with {"position": [-5, 8.3, -270], "target": [0, 6.5, -100], "fov": 70}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "m06-control-block-to-hq-on-foot"

  Scenario: Lhasa Arcology - the Barracks Quarter to the Old Town
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "lhasa-arcology", "size": 32, "seed": 3, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_camera" with {"position": [270, 70, 270], "target": [60, 5, 200], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "m07-barracks-to-old-town-from-above"
    When I call the tool "ar_camera" with {"position": [88, 5.4, 211], "target": [-50, 17, 211], "fov": 70}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "m08-barracks-to-old-town-on-foot"

  Scenario: Kush Corridor - the Mill Village to the Radar Knoll
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "kush-corridor", "size": 32, "seed": 3, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_camera" with {"position": [100, 110, 10], "target": [215, 50, 170], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "m09-mill-village-to-radar-knoll-from-above"
    When I call the tool "ar_camera" with {"position": [195, 50.9, 143], "target": [251, 85, 226], "fov": 70}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "m10-mill-village-to-radar-knoll-on-foot"
