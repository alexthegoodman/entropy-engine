Feature: An MCP client can block out, light, script and playtest a small RPG world in Canvas Surfaces
  # Every scenario drives the production addon through the tool callbacks the MCP server would call.
  # Play is exercised through canvas_playtest (headless, same logic and collision as Play) and once
  # through the real Play button with the keyboard.

  Scenario: The tool list is complete and consistent
    Then every tool in the schema file is registered with a handler
    And every tool has a description that says what it returns or does
    And every required argument is declared as a property
    And no tool text contains a long dash

  Scenario: Bad arguments are rejected instead of ignored
    When I call "canvas_create_surface" with {"posiiton": [0, 1, 0]}
    Then the call fails mentioning "Unknown argument"
    When I call "canvas_create_surface" with {"kind": "box"}
    Then the call fails mentioning "Missing required argument: position"
    When I call "canvas_create_surface" with {"position": [0, 1, 0], "kind": "torus"}
    Then the call fails mentioning "kind must be one of"

  Scenario: Prefabs place blocked-out groups that a person can paint over
    Given an empty scene
    When I call "canvas_add_prefab" with {"prefab": "house", "position": [5, 5], "yaw": 0.5}
    Then the call succeeds
    And the scene has 6 surfaces and 1 group
    And "House Walls" is solid and "House Door" is not
    And "House Gable front" has a triangular cut
    And every surface of "House" is one flat colour
    When I call "canvas_add_prefab" with {"prefab": "house", "position": [-5, 5]}
    Then the scene has 12 surfaces and 2 groups
    And a group named "House 2" exists
    When I call "canvas_add_prefab" with {"prefab": "castle", "position": [0, 0]}
    Then the call fails mentioning "Available: house"
    When I call "canvas_list_prefabs"
    Then the result lists 12 prefabs

  Scenario: Surfaces are created, changed, painted and deleted by name
    Given an empty scene
    When I call "canvas_create_surface" with {"name": "Lawn", "kind": "plane", "position": [0, 0, 0], "pitch": -1.5708, "size": {"width": 20, "height": 20}, "color": [80, 160, 70]}
    Then the call succeeds
    And "Lawn" is painted with 80 160 70
    When I call "canvas_create_surface" with {"name": "Lawn", "kind": "sphere", "position": [1, 1, 1]}
    Then the result field "surface.name" equals "Lawn 2"
    When I call "canvas_update_surface" with {"surface": "Lawn 2", "position": [4, 2, 0], "size": {"radius": 0.5}, "solid": true}
    Then "Lawn 2" is at 4 2 0 and is solid
    When I call "canvas_update_surface" with {"surface": "Lawn 2", "position": [9, 9, 9], "size": {"width": 4}}
    Then the call fails mentioning "does not apply to a sphere"
    And "Lawn 2" is at 4 2 0 and is solid
    When I call "canvas_fill_surface" with {"surface": "Lawn 2", "color": "#ff0000"}
    Then "Lawn 2" is painted with 255 0 0
    When I call "canvas_delete" with {"ref": "Lawn 2"}
    Then the scene has 1 surface and 0 groups

  Scenario: Repainting refuses to erase a person's brush strokes
    Given an empty scene
    When I call "canvas_create_surface" with {"name": "Canvas", "position": [0, 1.5, 0], "color": [250, 248, 244]}
    And I draw a stroke on "Canvas"
    And I call "canvas_fill_surface" with {"surface": "Canvas", "color": [0, 0, 255]}
    Then the call fails mentioning "brush stroke"
    When I call "canvas_fill_surface" with {"surface": "Canvas", "color": [0, 0, 255], "overwrite": true}
    Then "Canvas" is painted with 0 0 255

  Scenario: Lighting presets, overrides and limits
    When I call "canvas_set_lighting" with {"preset": "night"}
    Then the lighting buffer holds the night ambient colour
    When I call "canvas_set_lighting" with {"lamps": [{"position": [0, 3, 0], "color": [1, 0.8, 0.5], "intensity": 2, "reach": 4}]}
    Then the lighting buffer holds 1 lit lamp
    When I call "canvas_set_lighting" with {"preset": "sunset"}
    Then the call fails mentioning "preset must be one of"
    When I call "canvas_set_lighting" with {"sunIntensity": 99}
    Then the call fails mentioning "sunIntensity"
    When I call "canvas_set_lighting" with {"lamps": [{"position": [0, 0, 0]}, {"position": [0, 0, 0]}, {"position": [0, 0, 0]}, {"position": [0, 0, 0]}, {"position": [0, 0, 0]}]}
    Then the call fails mentioning "at most 4"
    When I call "canvas_undo"
    Then the lighting buffer holds 0 lit lamps
    And the lighting buffer holds the night ambient colour

  Scenario: A whole quest is scripted with rules and verified by a headless playtest
    Given the village quest world
    When I call "canvas_get_logic"
    Then the logic has no problems
    When I playtest the quest
    Then the playtest passed
    And the messages include "You have 0 of 3 herbs."
    And the messages include "Thank you! The gate is open."
    And the counter "herbs" is 3
    And the playtest left the scene exactly as it was

  Scenario: A playtest reports what went wrong
    Given the village quest world
    When I call "canvas_playtest" with {"steps": [{"walkTo": "Elder"}, {"interact": true}, {"expect": {"counters": {"herbs": 3}, "message": "gate is open"}}]}
    Then the playtest failed mentioning "expected herbs = 3, got 0"
    And the playtest left the scene exactly as it was

  Scenario: Solid surfaces stop the player and waypoints get around them
    Given the village quest world
    When I call "canvas_add_prefab" with {"prefab": "house", "position": [0, 8], "name": "Blocker", "params": {"width": 6, "depth": 3}}
    And I call "canvas_playtest" with {"steps": [{"walkTo": [0, 12]}]}
    Then the playtest failed mentioning "solid surface"
    When I call "canvas_playtest" with {"steps": [{"walkTo": [6, 8]}, {"walkTo": [6, 12]}, {"walkTo": [0, 12]}]}
    Then the playtest passed

  Scenario: A hidden pickup cannot be picked up again, even without a once node
    Given the village quest world
    When I call "canvas_set_logic" with {"nodes": [{"id": "n", "kind": "near", "target": "Herb A", "distance": 1.2}, {"id": "h", "kind": "hide", "target": "Herb A"}, {"id": "a", "kind": "add", "variable": "herbs", "amount": 1}], "connections": [{"from": "n", "to": "h"}, {"from": "h", "to": "a"}]}
    And I call "canvas_playtest" with {"steps": [{"walkTo": [5, 0]}, {"walkTo": [-5, 0]}, {"walkTo": [5, 0]}, {"expect": {"counters": {"herbs": 1}}}]}
    Then the playtest passed

  Scenario: The player cannot walk outside the world bounds
    Given the village quest world
    When I call "canvas_set_world" with {"bounds": 10}
    And I call "canvas_playtest" with {"steps": [{"walkTo": [30, 0]}]}
    Then the playtest failed mentioning "world bounds"

  Scenario: Deleting something a rule uses is reported and stops Play
    Given the village quest world
    When I call "canvas_delete" with {"ref": "Herb A", "deleteChildren": true}
    Then the result field "orphanedLogicNodes" equals 2
    When I call "canvas_play"
    Then the call fails mentioning "Choose a surface"

  Scenario: The keyboard walks the player in the real Play mode and Stop restores everything
    Given the village quest world
    When I call "canvas_play"
    Then the call succeeds
    And the play state says walking
    And the editing grid is hidden
    When I hold the key "d" for 1 seconds
    Then the player has moved right of the start
    And the camera follows the player
    When I call "canvas_stop"
    Then the player is back at the start
    And the play state says not playing
    And the editing grid is back

  Scenario: A collectible disappears in real Play and comes back after Stop
    Given the village quest world
    When I call "canvas_play"
    And I hold the key "d" for 1 seconds
    Then the play state counter "herbs" is 1
    And "Herb A" is hidden
    When I call "canvas_stop"
    Then "Herb A" is shown

  Scenario: Save and load keep the world, and unpainted surfaces stay small
    Given the village quest world
    When I call "canvas_save_scene" with {"name": "Mossbridge"}
    Then the call succeeds
    And the saved scene stores flat surfaces as colours, not pixels
    And the saved scene is under 3 megabytes
    When I call "canvas_new_scene" with {"confirmDiscard": true}
    Then the scene has 0 surfaces and 0 groups
    When I call "canvas_load_scene" with {"scene": "Mossbridge"}
    Then the scene has the village again
    And the player is "Hero"
    And the lighting is the day preset

  Scenario: Unsaved work is protected
    Given the village quest world
    When I call "canvas_new_scene"
    Then the call fails mentioning "unsaved changes"
    When I call "canvas_load_scene" with {"scene": "Nothing"}
    Then the call fails mentioning "No saved scene"

  Scenario: Each tool call is one undo step
    Given an empty scene
    When I call "canvas_add_prefab" with {"prefab": "tree", "position": [3, 3]}
    And I call "canvas_add_prefab" with {"prefab": "rock", "position": [4, 4]}
    Then the scene has 3 surfaces and 2 groups
    When I call "canvas_undo"
    Then the scene has 2 surfaces and 1 group
    When I call "canvas_redo"
    Then the scene has 3 surfaces and 2 groups

  Scenario: The budget tool reports surface count and estimated save size
    Given the village quest world
    When I call "canvas_world_stats"
    Then the result field "surfaceLimit" equals 128
    And the result field "paintedSurfaces" equals 0
    And the estimated save size is under 4 megabytes

  Scenario: Animation clips can be authored and played from a rule
    Given an empty scene
    When I call "canvas_add_prefab" with {"prefab": "chest", "position": [2, 0], "name": "Chest"}
    And I call "canvas_create_clip" with {"name": "Open", "duration": 1}
    And I call "canvas_set_keyframes" with {"clip": "Open", "target": "Chest", "channel": "y", "keys": [{"time": 0, "value": 0}, {"time": 1, "value": 0.5}]}
    Then the call succeeds
    When I call "canvas_set_keyframes" with {"clip": "Open", "target": "Chest", "channel": "y", "keys": [{"time": 5, "value": 0}]}
    Then the call fails mentioning "0 to the clip's 1 s"
    When I call "canvas_add_rule" with {"when": {"type": "click", "target": "Chest"}, "once": true, "then": [{"do": "clip", "clip": "Open"}, {"do": "message", "text": "It creaks open."}]}
    Then the call succeeds
    And the logic has no problems

  Scenario: Every prefab can be placed and the scene saved
    Given an empty scene
    When I place every prefab
    And I call "canvas_save_scene" with {"name": "All prefabs"}
    Then the call succeeds
    And the scene has 25 surfaces and 12 groups

  Scenario: The Mossbridge level script builds within budget and its whole quest can be finished
    Given the Mossbridge level built from its script
    Then the level fits the budget
    And the logic has no problems
    When I playtest the Mossbridge quest
    Then the playtest passed
    And the messages include "Keeper: The lantern has gone out. Bring me 5 glowcaps."
    And the messages include "Keeper: The north gate is open. Light the lantern."
    And the messages include "The lantern blazes. Mossbridge is lit again. You win!"
    And the counter "glowcaps" is 5
    And the playtest left the scene exactly as it was

  Scenario: The gate keeps the player out of the shrine until the Keeper opens it
    Given the Mossbridge level built from its script
    When I playtest the Mossbridge "gate_blocks" check
    Then the playtest failed mentioning "solid surface"

  Scenario: There is no gap beside the gate for the player to squeeze through
    Given the Mossbridge level built from its script
    When I playtest the Mossbridge "gap_east" check
    Then the playtest failed mentioning "solid surface"
    When I playtest the Mossbridge "gap_west" check
    Then the playtest failed mentioning "solid surface"
