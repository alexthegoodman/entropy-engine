Feature: The Abyss - Chapter One: First Blood, Chapter Two: Retaliation
  Played with ENTROPY_ABYSS_BDD_RESULT (tests/abyss_live.rs).

  Scenario: The world loads
    Given the real Abyss game is running in test mode
    When I call the tool "abyss_config" with {"fixedStep": 0.033}
    And I call the tool "abyss_settle"
    And I advance 5 frames
    Then I call the tool "abyss_state"
    When I call the tool "abyss_camera" with {"position": [-640, 160, -1500], "target": [100, -420, -100]}
    And I advance 3 frames
    Then I capture "01-rim"

  Scenario: Chapter Two - the firebase, the hollow, and flying Kesh
    Given the real Abyss game is running in test mode
    When I call the tool "abyss_config" with {"fixedStep": 0.033, "sound": false}
    And I call the tool "abyss_settle"
    And I call the tool "abyss_start" with {"phase": "open"}
    And I call the tool "abyss_cinema" with {"t": 22}
    And I advance 2 frames
    Then I capture "ch2-01-aftermath"
    When I call the tool "abyss_cinema" with {"skip": true}
    And I advance 200 frames
    Then I call the tool "abyss_state"
    And I capture "ch2-02-firebase"
    When I call the tool "abyss_act" with {"action": "face", "x": -26, "z": -524}
    And I call the tool "abyss_act" with {"action": "move", "forward": 1, "frames": 45}
    And I advance 3 frames
    Then I capture "ch2-03-voss"
    When I call the tool "abyss_start" with {"phase": "hollow"}
    And I advance 40 frames
    Then I capture "ch2-04-trail"
    When I call the tool "abyss_act" with {"action": "teleport", "x": 88, "z": -86}
    And I advance 5 frames
    And I call the tool "abyss_cinema" with {"t": 5}
    And I advance 2 frames
    Then I capture "ch2-05-hollow"
    When I call the tool "abyss_start" with {"phase": "skybound"}
    And I advance 10 frames
    And I call the tool "abyss_act" with {"action": "face", "x": 76, "z": -56, "pitch": -0.05}
    And I advance 2 frames
    Then I capture "ch2-06-kesh"
    When I call the tool "abyss_act" with {"action": "interact"}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.35, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.35, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.35, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.35, "frames": 30}
    And I advance 2 frames
    Then I call the tool "abyss_state"
    And I capture "ch2-07-flight"
    When I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I call the tool "abyss_act" with {"action": "fly", "forward": 1, "flap": true, "pitch": 0.5, "yaw": 3.4, "frames": 30}
    And I advance 2 frames
    Then I call the tool "abyss_state"
    And I capture "ch2-08-rim"

  Scenario: The opening, the fleeing city, and the Whispering Vein
    Given the real Abyss game is running in test mode
    When I call the tool "abyss_config" with {"fixedStep": 0.033, "sound": false}
    And I call the tool "abyss_settle"
    And I call the tool "abyss_start" with {"phase": "intro"}
    And I call the tool "abyss_cinema" with {"t": 6}
    And I advance 2 frames
    Then I capture "ex-01-union"
    When I call the tool "abyss_cinema" with {"t": 26}
    And I advance 2 frames
    Then I capture "ex-02-below"
    When I call the tool "abyss_start" with {"phase": "floor"}
    And I call the tool "abyss_act" with {"action": "teleport", "x": 120, "z": -560}
    And I advance 20 frames
    And I call the tool "abyss_act" with {"action": "face", "x": 318, "z": -476}
    And I advance 40 frames
    Then I call the tool "abyss_state"
    And I capture "ex-03-citizens"
    When I call the tool "abyss_start" with {"phase": "roam"}
    And I advance 10 frames
    And I call the tool "abyss_act" with {"action": "teleport", "x": -199, "z": 440}
    And I advance 3 frames
    And I call the tool "abyss_act" with {"action": "face", "x": -205, "z": 466}
    And I advance 3 frames
    Then I call the tool "abyss_state"
    And I capture "ex-04-vein"
