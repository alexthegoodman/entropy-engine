Feature: Build and play an interactive painted scene in the real engine
  # The sidebar is tabbed: new_surface is on the Surfaces tab, save_scene, load_scene and
  # playable_example on the Scene tab, which stays selected for the rest of the run.
  Scenario: Author graph properties and wires, save, play, stop and reload
    Given the real canvas demo is running in test mode
    When I advance 30 frames
    And I send pointer "down" at "660" "410"
    And I send pointer "move" at "740" "440"
    And I send pointer "up" at "740" "440"
    And I advance 4 frames
    And I click "TABBAR_SELECTED|panel_tabs|surfaces"
    And I advance 3 frames
    And I click "new_surface"
    And I advance 4 frames
    And I click "TABBAR_SELECTED|panel_tabs|scene"
    And I advance 3 frames
    And I set "scene_name" to "BDD painted surfaces"
    And I click "save_scene"
    And I advance 8 frames
    Then I capture "canvas-logic-painted"
    When I click "playable_example"
    And I advance 4 frames
    And I click "scene_confirm_discard"
    And I advance 12 frames
    Then I do not see the label "Click my face to say hello!"
    And I capture "canvas-logic-editor"
    When I click "SNARL_NODE_SELECTED|canvas_logic|demo-welcome"
    And I advance 4 frames
    And I set "logic_message" to "Click my face to say hello!"
    And I click "SNARL_DISCONNECT|canvas_logic|demo-once|next|demo-wave|in"
    And I advance 4 frames
    And I click "SNARL_CONNECT|canvas_logic|demo-once|next|demo-wave|in"
    And I advance 4 frames
    Then I capture "canvas-logic-graph"
    When I click "save_scene"
    And I advance 8 frames
    And I click "game_play"
    And I advance 8 frames
    Then I see the label "Click my face to say hello!"
    And I capture "canvas-logic-playing"
    When I send pointer "down" at "700" "310"
    And I send pointer "up" at "700" "310"
    And I wait 650 milliseconds
    And I advance 2 frames
    Then I capture "canvas-logic-wave"
    When I wait 1600 milliseconds
    And I advance 4 frames
    Then I see the label "Hello, friend! Stop and Play to try again."
    And I capture "canvas-logic-reply"
    When I click "game_play"
    And I advance 8 frames
    Then I see the label "Drawn character"
    And I do not see the label "Hello, friend! Stop and Play to try again."
    And I capture "canvas-logic-stopped"
    When I click "load_scene"
    And I advance 8 frames
    Then I do not see the label "Click my face to say hello!"
    When I click "game_play"
    And I advance 8 frames
    Then I see the label "Click my face to say hello!"
    When I send pointer "down" at "700" "310"
    And I send pointer "up" at "700" "310"
    And I wait 2300 milliseconds
    And I advance 4 frames
    Then I see the label "Hello, friend! Stop and Play to try again."
    And I capture "canvas-logic-reloaded"
    When I click "game_play"
    And I advance 8 frames
