Feature: Canvas groups and animation in the real engine
  # The sidebar is tabbed: scene_name, save_scene and load_scene live on the Scene tab, the
  # hierarchy, clip and keyframe controls on the Animate tab. A tab click is the same widget event
  # a real click sends, and it needs a couple of frames before the next page's widgets exist.
  Scenario: Author an arm group and save its animation through real widget events
    Given the real canvas demo is running in test mode
    When I advance 30 frames
    And I click "TABBAR_SELECTED|panel_tabs|scene"
    And I advance 3 frames
    And I set "scene_name" to "BDD animated creation"
    And I click "TABBAR_SELECTED|panel_tabs|animate"
    And I advance 3 frames
    And I click "group_create"
    And I advance 4 frames
    And I set "node_name" to "Arm"
    And I set "node_pivot_y" to "3"
    And I click "clip_create"
    And I advance 4 frames
    And I set "clip_name" to "Wave"
    And I set "key_value" to "0"
    And I click "key_add"
    And I advance 4 frames
    And I set "clip_time" to "1"
    And I set "key_value" to "1.5707963267948966"
    And I click "key_add"
    And I advance 8 frames
    Then I capture "canvas-arm-wave"
    When I click "animation_stop"
    And I advance 8 frames
    Then I capture "canvas-editing-pose"
    When I click "TABBAR_SELECTED|panel_tabs|scene"
    And I advance 3 frames
    And I click "save_scene"
    And I advance 8 frames
    And I click "load_scene"
    And I advance 8 frames
    And I click "TABBAR_SELECTED|panel_tabs|animate"
    And I advance 3 frames
    And I set "clip_time" to "1"
    And I advance 8 frames
    Then I capture "canvas-wave-reloaded"
    When I click "animation_stop"
    And I click "TABBAR_SELECTED|panel_tabs|scene"
    And I advance 3 frames
    And I click "save_scene"
    And I advance 8 frames
    And I click "TABBAR_SELECTED|panel_tabs|animate"
    And I advance 3 frames
    And I click "animated_example"
    And I advance 8 frames
    And I set "clip_time" to "0"
    And I advance 8 frames
    Then I capture "canvas-character-before"
    When I set "clip_time" to "1"
    And I advance 8 frames
    Then I capture "canvas-character-wave-smile"
    When I click "TABBAR_SELECTED|panel_tabs|scene"
    And I advance 3 frames
    And I click "save_scene"
    And I advance 8 frames
    And I click "load_scene"
    And I advance 8 frames
    And I click "TABBAR_SELECTED|panel_tabs|animate"
    And I advance 3 frames
    And I set "clip_time" to "1"
    And I advance 8 frames
    Then I capture "canvas-character-reloaded"
    When I click "TABBAR_SELECTED|panel_tabs|tool"
    And I advance 3 frames
    Then I capture "canvas-tab-tool"
    When I click "TABBAR_SELECTED|panel_tabs|surfaces"
    And I advance 3 frames
    Then I capture "canvas-tab-surfaces"
    When I click "TABBAR_SELECTED|panel_tabs|help"
    And I advance 3 frames
    Then I capture "canvas-tab-help"
