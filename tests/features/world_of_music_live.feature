Feature: World of Music
  Played with ENTROPY_WOM_BDD_RESULT (tests/world_of_music_live.rs). Captures land beside the result.

  Scenario: Landfall Cove - directing swarms, fruit, crates and the colour language
    Given the real World of Music game is running in test mode
    When I call the tool "wom_config" with {"fixedStep": 0.033, "sound": false}
    And I advance 10 frames
    Then I capture "01-title"
    When I call the tool "wom_start" with {"level": "cove", "screen": "intro", "storyAge": 9}
    And I advance 2 frames
    Then I capture "02-intro"
    When I call the tool "wom_start" with {"level": "cove"}
    And I call the tool "wom_act" with {"action": "wait", "frames": 60}
    Then I capture "03-landfall"
    When I call the tool "wom_act" with {"action": "banner"}
    And I call the tool "wom_camera" with {"position": [2.4, 4.6, 73.2], "target": [0, 3.7, 77.6], "fov": 46}
    And I advance 2 frames
    Then I capture "04-agent-tom-and-his-tones"
    When I call the tool "wom_camera" with {"release": true}
    And I call the tool "wom_act" with {"action": "direct", "to": "tree:0", "frames": 2}
    And I call the tool "wom_act" with {"action": "direct", "to": "crate:1", "frames": 2}
    And I call the tool "wom_act" with {"action": "direct", "to": "crate:0", "frames": 150}
    Then I capture "05-three-swarms-three-orders"
    When I call the tool "wom_act" with {"action": "wait", "frames": 450}
    Then I call the tool "wom_state"
    And I capture "06-fruit-and-relics"
    When I call the tool "wom_act" with {"action": "teleport", "to": "npc:bodhi", "distance": 3.5}
    And I call the tool "wom_act" with {"action": "talk"}
    And I call the tool "wom_act" with {"action": "wait", "frames": 50}
    Then I capture "07-bodhi"
    When I call the tool "wom_act" with {"action": "stall"}
    And I call the tool "wom_act" with {"action": "sell"}
    Then I capture "08-the-stall"
    When I call the tool "wom_act" with {"action": "stall"}
    And I call the tool "wom_act" with {"action": "teleport", "to": "npc:hoolu", "distance": 3}
    And I call the tool "wom_act" with {"action": "jam", "frames": 20}
    Then I capture "09-jam-with-hoolu"
    When I call the tool "wom_act" with {"action": "solveJam"}
    Then I call the tool "wom_state"

  Scenario: The Red Corruption, thinking with WIR
    Given the real World of Music game is running in test mode
    When I call the tool "wom_start" with {"level": "cove"}
    And I call the tool "wom_config" with {"check": true}
    And I call the tool "wom_act" with {"action": "banner"}
    And I call the tool "wom_act" with {"action": "teleport", "to": "grove", "distance": 22}
    And I call the tool "wom_act" with {"action": "wait", "frames": 30}
    Then I capture "10-the-smudged-grove"
    When I call the tool "wom_act" with {"action": "direct", "to": "enemy", "frames": 2}
    And I call the tool "wom_act" with {"action": "direct", "to": "enemy", "frames": 2}
    And I call the tool "wom_act" with {"action": "direct", "to": "enemy", "frames": 120}
    Then I capture "11-battle"
    When I call the tool "wom_act" with {"action": "wait", "frames": 240}
    Then I call the tool "wom_state"
    When I call the tool "wom_act" with {"action": "hurtTone", "swarm": 1}
    And I call the tool "wom_act" with {"action": "wait", "frames": 20}
    Then I capture "12-a-fallen-tone"

  Scenario: Puzzles, the giant and the islands beyond
    Given the real World of Music game is running in test mode
    When I call the tool "wom_start" with {"level": "cove"}
    And I call the tool "wom_act" with {"action": "banner"}
    And I call the tool "wom_act" with {"action": "teleport", "to": "gate:ridge", "distance": 16}
    And I call the tool "wom_act" with {"action": "direct", "to": "switch:sw-west", "frames": 2}
    And I call the tool "wom_act" with {"action": "direct", "to": "switch:sw-east", "frames": 300}
    Then I capture "13-two-switches-hold-the-gate"
    When I call the tool "wom_act" with {"action": "teleport", "to": "lever", "distance": 18}
    And I call the tool "wom_act" with {"action": "select", "index": 2}
    And I call the tool "wom_act" with {"action": "direct", "to": "lever", "frames": 200}
    Then I capture "14-hop-climbs-the-spire"
    When I call the tool "wom_act" with {"action": "teleport", "to": "basin", "distance": 20}
    And I call the tool "wom_act" with {"action": "wait", "frames": 60}
    Then I capture "15-gloomtusk"
    When I call the tool "wom_start" with {"level": "falls"}
    And I call the tool "wom_act" with {"action": "banner"}
    And I call the tool "wom_act" with {"action": "teleport", "to": "portal:a", "distance": 9}
    And I call the tool "wom_act" with {"action": "wait", "frames": 3}
    Then I capture "16-canopy-falls-rings"
    When I call the tool "wom_start" with {"level": "caldera"}
    And I call the tool "wom_act" with {"action": "banner"}
    And I call the tool "wom_act" with {"action": "purifyAll", "frames": 3}
    And I call the tool "wom_act" with {"action": "teleport", "to": "maw", "distance": 30}
    And I call the tool "wom_act" with {"action": "wait", "frames": 3}
    Then I capture "17-the-red-caldera"
    When I call the tool "wom_act" with {"action": "screen", "screen": "ending", "age": 9}
    Then I capture "18-we-are-coming-to-get-you"
