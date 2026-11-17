Feature: Armageddon 2070
  Played with ENTROPY_ARMAGEDDON_BDD_RESULT (tests/armageddon_live.rs). Captures land beside the result.

  Scenario: Menus, the armory and the four battlefields
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false}
    And I advance 20 frames
    Then I capture "01-title"
    When I call the tool "ar_start" with {"map": "kush-corridor", "screen": "setup"}
    And I advance 3 frames
    Then I capture "02-battle-setup"
    When I call the tool "ar_start" with {"map": "glass-coast", "screen": "armory"}
    And I call the tool "ar_act" with {"action": "loadout", "role": "recon"}
    And I call the tool "ar_act" with {"action": "armory", "row": "arm:Finish", "dir": 1}
    And I advance 3 frames
    Then I capture "03-armory-recon-with-mimetic-plates"

  Scenario: Glass Coast - first person in a 128 vs 128 battle thinking with WIR
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false}
    And I call the tool "ar_start" with {"map": "glass-coast", "size": 128, "seed": 3, "screen": "play"}
    And I call the tool "ar_config" with {"check": true}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_act" with {"action": "wait", "frames": 30}
    Then I capture "04-deploy-at-hq"
    When I call the tool "ar_act" with {"action": "teleport", "to": "T3", "distance": 45}
    And I call the tool "ar_act" with {"action": "wait", "frames": 20}
    Then I capture "05-fish-market-cover"
    When I call the tool "ar_act" with {"action": "wait", "frames": 2400}
    And I call the tool "ar_act" with {"action": "teleport", "to": "enemy", "distance": 35}
    And I call the tool "ar_act" with {"action": "fire", "frames": 20}
    Then I capture "06-firefight"
    And I call the tool "ar_state"
    When I call the tool "ar_camera" with {"position": [-60, 90, -80], "target": [-300, 0, -120], "fov": 55}
    Then I capture "07-container-quay-from-above"
    When I call the tool "ar_camera" with {"release": true}
    And I call the tool "ar_act" with {"action": "scoreboard", "value": true}
    Then I capture "08-scoreboard"
    When I call the tool "ar_act" with {"action": "scoreboard", "value": false}
    And I call the tool "ar_act" with {"action": "map", "value": true}
    Then I capture "09-map"

  Scenario: Squad call, rewards, vehicles and mecha
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false}
    And I call the tool "ar_start" with {"map": "fusion-plant-seven", "size": 64, "seed": 5, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T3", "distance": 70}
    And I call the tool "ar_act" with {"action": "call", "to": "T3", "frames": 300}
    Then I capture "10-squad-called-to-the-control-block"
    When I call the tool "ar_act" with {"action": "reward", "id": "R101", "to": "T3", "frames": 5}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T3", "distance": 22}
    And I call the tool "ar_act" with {"action": "wait", "frames": 5}
    Then I capture "11-mine-kit-sixteen-mines"
    When I call the tool "ar_act" with {"action": "reward", "id": "R007", "to": "T2", "frames": 50}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T2", "distance": 110}
    And I call the tool "ar_act" with {"action": "wait", "frames": 10}
    Then I capture "12-hunter-protocol"
    When I call the tool "ar_act" with {"action": "teleport", "to": "base0", "distance": 0}
    And I call the tool "ar_act" with {"action": "enter", "vehicle": "V005", "frames": 5}
    And I call the tool "ar_act" with {"action": "drive", "frames": 90, "throttle": 1}
    Then I capture "13-main-battle-tank"
    When I call the tool "ar_act" with {"action": "exit"}
    And I call the tool "ar_act" with {"action": "enter", "vehicle": "V015", "frames": 5}
    And I call the tool "ar_act" with {"action": "drive", "frames": 120, "throttle": 1, "lift": 1}
    Then I capture "14-heavy-transport-helicopter"
    When I call the tool "ar_act" with {"action": "exit"}
    And I call the tool "ar_camera" with {"position": [0, 160, -380], "target": [0, 0, -150], "fov": 60}
    And I call the tool "ar_act" with {"action": "wait", "frames": 60}
    Then I capture "15-armor-and-air-over-the-plant"

  Scenario: Kush Corridor and Lhasa Arcology, and the debrief
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.033, "sound": false}
    And I call the tool "ar_start" with {"map": "kush-corridor", "size": 64, "seed": 9, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T6", "distance": 50}
    And I call the tool "ar_act" with {"action": "wait", "frames": 10}
    Then I capture "16-caravanserai"
    When I call the tool "ar_start" with {"map": "lhasa-arcology", "size": 64, "seed": 9, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T4", "distance": 45}
    And I call the tool "ar_act" with {"action": "wait", "frames": 10}
    Then I capture "17-arcology-spire"
    When I call the tool "ar_camera" with {"position": [-120, 120, 60], "target": [80, 20, 0], "fov": 60}
    Then I capture "18-lhasa-from-the-monastery"
    When I call the tool "ar_camera" with {"release": true}
    And I call the tool "ar_act" with {"action": "winTeam", "team": 0, "frames": 5}
    Then I capture "19-debrief"

  Scenario: Real input - weapon keys between battle steps, aiming down sights, the gamepad, enemy marks
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.0167, "sound": false}
    And I call the tool "ar_start" with {"map": "glass-coast", "size": 32, "seed": 4, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T2", "distance": 30}
    And I advance 3 frames
    Then I call the tool "ar_expect" with {"slot": "primary", "ads": false}
    # 60 fps against the 30 Hz battle: these taps alternate between frames that run a battle step and frames that do not.
    When I hold the key "2" for 1 frame
    And I advance 3 frames
    Then I call the tool "ar_expect" with {"slot": "sidearm"}
    When I hold the key "1" for 1 frame
    And I advance 2 frames
    Then I call the tool "ar_expect" with {"slot": "primary"}
    When I hold the key "2" for 1 frame
    And I advance 3 frames
    Then I call the tool "ar_expect" with {"slot": "sidearm"}
    When I hold the key "1" for 1 frame
    And I advance 3 frames
    Then I call the tool "ar_expect" with {"slot": "primary"}
    # The right mouse button aims down sights (Entropy sends it to addons as button 1).
    When I press the mouse button "right"
    And I advance 10 frames
    Then I call the tool "ar_expect" with {"ads": true}
    And I capture "20-aim-down-sights"
    When I release the mouse button "right"
    And I advance 2 frames
    Then I call the tool "ar_expect" with {"ads": false}
    # The gamepad: Y switches weapon, the left trigger aims, the sticks move and look, B crouches.
    When I hold the gamepad button "North" for 1 frame
    And I advance 3 frames
    Then I call the tool "ar_expect" with {"slot": "sidearm", "device": "pad"}
    When I press the gamepad button "LeftTrigger2"
    And I advance 6 frames
    Then I call the tool "ar_expect" with {"ads": true}
    When I release the gamepad button "LeftTrigger2"
    And I call the tool "ar_expect" with {}
    And I hold the gamepad sticks "0 1 0.8 0 0 0" for 40 frames
    Then I call the tool "ar_expect" with {"moved": true, "turned": true, "ads": false}
    When I hold the gamepad button "East" for 1 frame
    And I advance 3 frames
    Then I call the tool "ar_expect" with {"stance": "crouch"}
    # A 4x scope (the marksman preset) puts the scope picture up.
    When I call the tool "ar_act" with {"action": "loadout", "role": "marksman"}
    And I hold the key "1" for 1 frame
    And I press the mouse button "right"
    And I advance 12 frames
    Then I call the tool "ar_expect" with {"slot": "primary", "ads": true}
    And I capture "21-marksman-scope"
    When I release the mouse button "right"
    # Enemies wear red marks.
    And I call the tool "ar_act" with {"action": "teleport", "to": "enemy", "distance": 6}
    Then I capture "22-enemy-red-marks"

  Scenario: Weapons - aiming per optic, the viewmodels, launchers and the UGL, a supply drop, a vehicle by gamepad
    Given the real Armageddon 2070 game is running in test mode
    When I call the tool "ar_config" with {"fixedStep": 0.0167, "sound": false, "help": false}
    And I call the tool "ar_start" with {"map": "glass-coast", "size": 32, "seed": 4, "screen": "play"}
    And I call the tool "ar_act" with {"action": "banner"}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T2", "distance": 40}
    And I advance 20 frames
    Then I call the tool "ar_expect" with {"slot": "primary", "ads": false, "zoomed": false}
    And I capture "23-rifle-hip-holographic"
    # The rifleman's holographic sight: 1.45x, a ring reticle.
    When I press the mouse button "right"
    And I advance 30 frames
    Then I call the tool "ar_expect" with {"ads": true, "zoomed": true}
    And I capture "24-rifle-aimed-holographic"
    When I release the mouse button "right"
    # The recon rifle's 8x precision optic.
    And I call the tool "ar_act" with {"action": "loadout", "role": "recon"}
    And I hold the key "1" for 1 frame
    And I press the mouse button "right"
    And I advance 40 frames
    Then I call the tool "ar_expect" with {"ads": true, "zoomed": true}
    And I capture "25-sniper-8x-scope"
    When I release the mouse button "right"
    # The support gunner's LMG with a 2x combat optic (a chevron).
    And I call the tool "ar_act" with {"action": "loadout", "role": "support"}
    And I advance 20 frames
    Then I capture "26-lmg-hip"
    When I press the mouse button "right"
    And I advance 40 frames
    Then I capture "27-lmg-2x-combat-optic"
    When I release the mouse button "right"
    # The anti-armor launcher: hip, then its sight, then a rocket away.
    And I call the tool "ar_act" with {"action": "loadout", "role": "antiarmor"}
    And I hold the key "3" for 1 frame
    And I advance 40 frames
    Then I call the tool "ar_expect" with {"slot": "launcher", "launcherRounds": 4}
    And I capture "28-launcher-hip"
    When I press the mouse button "right"
    And I advance 30 frames
    Then I capture "29-launcher-aimed"
    When I hold the mouse button "left" for 1 frame
    And I advance 2 frames
    And I hold the mouse button "left" for 2 frames
    And I advance 4 frames
    Then I call the tool "ar_expect" with {"launcherRounds": 3}
    And I capture "30-rocket-away"
    When I release the mouse button "right"
    And I advance 360 frames
    Then I call the tool "ar_expect" with {"launcherRounds": 3}
    # A second rocket: the launcher carries four.
    When I hold the mouse button "left" for 1 frame
    And I advance 2 frames
    And I hold the mouse button "left" for 2 frames
    And I advance 4 frames
    Then I call the tool "ar_expect" with {"launcherRounds": 2}
    # A supply drop at T2 under a parachute; walking up to it restocks the launcher.
    When I call the tool "ar_act" with {"action": "reward", "id": "R002", "to": "T2", "frames": 100}
    Then I capture "31-supply-drop-falling"
    When I call the tool "ar_act" with {"action": "wait", "frames": 200}
    And I call the tool "ar_act" with {"action": "teleport", "to": "T2", "distance": 9}
    And I advance 3 frames
    Then I capture "32-supply-drop-landed"
    When I call the tool "ar_act" with {"action": "teleport", "to": "T2", "distance": 2}
    And I advance 90 frames
    Then I call the tool "ar_expect" with {"launcherRounds": 4}
    # The squad leader's underbarrel grenade launcher on 3, and the pistol on 2.
    When I call the tool "ar_act" with {"action": "loadout", "role": "leader"}
    And I hold the key "3" for 1 frame
    And I advance 40 frames
    Then I call the tool "ar_expect" with {"slot": "launcher", "launcherRounds": 4}
    And I capture "33-underbarrel-grenade-launcher"
    When I hold the key "2" for 1 frame
    And I press the mouse button "right"
    And I advance 40 frames
    Then I call the tool "ar_expect" with {"slot": "sidearm", "ads": true}
    And I capture "34-pistol-aimed"
    When I release the mouse button "right"
    # Into a tank with the gamepad's Y (beside the hull), out with D-pad up, back in with D-pad up.
    And I call the tool "ar_act" with {"action": "teleport", "to": "vehicle:V005", "distance": 6}
    And I advance 3 frames
    Then I capture "35-tank-prompt"
    When I hold the gamepad button "North" for 1 frame
    And I advance 4 frames
    Then I call the tool "ar_expect" with {"inVehicle": true, "device": "pad"}
    And I capture "36-tank-entered-with-gamepad"
    When I hold the gamepad button "DPadUp" for 1 frame
    And I advance 4 frames
    Then I call the tool "ar_expect" with {"inVehicle": false}
    When I hold the gamepad button "DPadUp" for 1 frame
    And I advance 4 frames
    Then I call the tool "ar_expect" with {"inVehicle": true}
