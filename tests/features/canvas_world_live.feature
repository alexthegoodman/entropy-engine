Feature: Build, light and play a small world through the same tool calls an MCP client makes
  # "I call the tool" goes through AddonEngine::call_tool, the function the MCP server calls, on the real
  # renderer. The screenshots prove the lighting buffer reaches the shader; the playtest and the held key
  # prove the headless and the real Play paths agree.
  Scenario: Block out a village, light it, playtest it and walk through it
    Given the real canvas demo is running in test mode
    When I advance 30 frames
    And I call the tool "canvas_new_scene" with {"name": "Live village", "confirmDiscard": true}
    And I call the tool "canvas_add_prefab" with {"prefab": "ground", "position": [0, 0], "name": "Ground", "params": {"width": 60, "depth": 60}}
    And I call the tool "canvas_add_prefab" with {"prefab": "ground", "position": [0, 2], "name": "Path", "params": {"width": 3, "depth": 26, "color": [190, 160, 110], "lift": 0.02}}
    And I call the tool "canvas_add_prefab" with {"prefab": "human", "position": [0, 0], "name": "Hero", "params": {"shirtColor": [200, 60, 60]}}
    And I call the tool "canvas_set_world" with {"player": "Hero"}
    And I call the tool "canvas_add_prefab" with {"prefab": "human", "position": [-6, 0], "name": "Elder", "params": {"shirtColor": [120, 80, 160]}}
    And I call the tool "canvas_add_prefab" with {"prefab": "house", "position": [9, 8], "name": "Cottage"}
    And I call the tool "canvas_add_prefab" with {"prefab": "house", "position": [-10, 9], "yaw": 0.4, "name": "Mill", "params": {"wallColor": [190, 200, 210], "roofColor": [60, 70, 110]}}
    And I call the tool "canvas_add_prefab" with {"prefab": "tree", "position": [-9, -3], "name": "Oak"}
    And I call the tool "canvas_add_prefab" with {"prefab": "tree", "position": [12, -4], "name": "Birch", "params": {"height": 4.5}}
    And I call the tool "canvas_add_prefab" with {"prefab": "pond", "position": [-8, -9], "name": "Pond", "params": {"radius": 3}}
    And I call the tool "canvas_add_prefab" with {"prefab": "lamppost", "position": [3, 4], "name": "Lamp"}
    And I call the tool "canvas_add_prefab" with {"prefab": "gate", "position": [0, -8], "name": "Gate"}
    And I call the tool "canvas_add_prefab" with {"prefab": "pickup", "position": [5, 0], "name": "Herb A", "params": {"color": [120, 220, 120]}}
    And I call the tool "canvas_add_prefab" with {"prefab": "pickup", "position": [8, -3], "name": "Herb B", "params": {"color": [120, 220, 120]}}
    And I call the tool "canvas_add_prefab" with {"prefab": "pickup", "position": [-2, 6], "name": "Herb C", "params": {"color": [120, 220, 120]}}
    And I call the tool "canvas_add_collectible" with {"target": "Herb A", "counter": "herbs", "message": "Herb collected: {herbs} of 3."}
    And I call the tool "canvas_add_collectible" with {"target": "Herb B", "counter": "herbs", "message": "Herb collected: {herbs} of 3."}
    And I call the tool "canvas_add_collectible" with {"target": "Herb C", "counter": "herbs", "message": "Herb collected: {herbs} of 3."}
    And I call the tool "canvas_add_rule" with {"when": {"type": "interact", "target": "Elder", "distance": 2, "prompt": "Talk"}, "once": true, "conditions": [{"counter": "herbs", "atLeast": 3}], "then": [{"do": "message", "text": "Thank you! The gate is open."}, {"do": "hide", "target": "Gate"}], "otherwise": [{"do": "message", "text": "You have {herbs} of 3 herbs."}]}
    And I call the tool "canvas_set_lighting" with {"preset": "golden_hour"}
    And I call the tool "canvas_set_camera" with {"position": [0, 15, 17], "target": [0, 0.5, 0]}
    And I advance 20 frames
    Then I capture "world-golden-hour"
    When I call the tool "canvas_set_lighting" with {"preset": "night", "lamps": [{"position": [3, 3.2, 4], "color": [1, 0.75, 0.4], "intensity": 3, "reach": 4}, {"position": [-6, 3, 2], "color": [0.6, 0.7, 1], "intensity": 1.5, "reach": 3}]}
    And I advance 6 frames
    Then I capture "world-night"
    When I call the tool "canvas_set_lighting" with {"preset": "day"}
    And I call the tool "canvas_world_stats"
    And I call the tool "canvas_playtest" with {"steps": [{"walkTo": "Elder"}, {"interact": true}, {"walkTo": "Herb A"}, {"walkTo": "Herb B"}, {"walkTo": "Herb C"}, {"walkTo": "Elder"}, {"interact": true}, {"expect": {"counters": {"herbs": 3}, "message": "gate is open", "shown": {"Gate": false}}}]}
    And I advance 6 frames
    Then I capture "world-after-playtest"
    When I click "TABBAR_SELECTED|panel_tabs|surfaces"
    And I advance 3 frames
    And I click "prefab_pickup"
    And I advance 4 frames
    Then I see the label "Added Pickup (1 surface)."
    When I click "game_play"
    And I advance 6 frames
    Then I see the label "WASD walk | E interact | Q R turn | wheel zoom"
    And I capture "world-play-start"
    When I hold the key "d" for 120 frames
    And I call the tool "canvas_get_play_state"
    And I advance 4 frames
    Then I see the label "Herb collected: 1 of 3."
    And I capture "world-play-walked"
    When I click "game_play"
    And I advance 8 frames
    Then I do not see the label "Herb collected: 1 of 3."
    When I call the tool "canvas_save_scene" with {"name": "Live village"}
    And I advance 4 frames
    Then I capture "world-edit-after-play"
