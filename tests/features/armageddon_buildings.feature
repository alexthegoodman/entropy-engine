Feature: Armageddon 2070 buildings and aim assist
  Inside a building there is only floor and its own partitions (no barriers, wrecks, crates or other
  walls run through it), and the aim assist setting (0-50%, 25% default) shows on the setup screen.
  Play it with ENTROPY_ARMAGEDDON_BDD_FEATURE=tests/features/armageddon_buildings.feature.

  Scenario: The setup screen shows the aim assist setting
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false, "assist": 0.25}
    And I call the tool "ar_start" with {"map": "glass-coast", "size": 32, "seed": 3, "screen": "setup"}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "b01-setup-aim-assist-25"
    When I call the tool "ar_config" with {"assist": 0.5}
    And I call the tool "ar_act" with {"action": "wait", "frames": 2}
    Then I capture "b02-setup-aim-assist-50"

  Scenario: Glass Coast - the Fish Market's houses are clear inside
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "glass-coast", "size": 32, "seed": 3, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_camera" with {"position": [-160, 62, 0], "target": [-142, 19, 28], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "b03-fish-market-from-above"
    When I call the tool "ar_camera" with {"position": [-144.6, 20.8, 21.6], "target": [-136, 20.4, 28.5], "fov": 75}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "b04-fish-market-house-inside"
    When I call the tool "ar_camera" with {"position": [-158.6, 21.4, 21.8], "target": [-151, 21, 28.5], "fov": 75}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "b05-fish-market-small-house-inside"

  Scenario: Kush Corridor - Qalat Sarai's perimeter wall ends at its corner tower
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "kush-corridor", "size": 32, "seed": 3, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_camera" with {"position": [-128, 40, -292], "target": [-108, 16, -268], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "b06-qalat-corner-tower-from-above"
    When I call the tool "ar_camera" with {"position": [-114.8, 18, -275.4], "target": [-110, 17.6, -270.5], "fov": 80}
    And I call the tool "ar_act" with {"action": "wait", "frames": 3}
    Then I capture "b07-qalat-corner-tower-inside"
