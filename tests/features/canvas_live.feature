Feature: Canvas groups and animation in the real engine
  Scenario: Author an arm group and save its animation through real widget events
    Given the real canvas demo is running in test mode
    When I advance 30 frames
    And I set "scene_name" to "BDD animated creation"
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
    When I click "save_scene"
    And I advance 8 frames
    And I click "load_scene"
    And I advance 8 frames
    And I set "clip_time" to "1"
    And I advance 8 frames
    Then I capture "canvas-wave-reloaded"
    When I click "animation_stop"
    And I click "save_scene"
    And I advance 8 frames
    And I click "animated_example"
    And I advance 8 frames
    And I set "clip_time" to "0"
    And I advance 8 frames
    Then I capture "canvas-character-before"
    When I set "clip_time" to "1"
    And I advance 8 frames
    Then I capture "canvas-character-wave-smile"
    When I click "save_scene"
    And I advance 8 frames
    And I click "load_scene"
    And I advance 8 frames
    And I set "clip_time" to "1"
    And I advance 8 frames
    Then I capture "canvas-character-reloaded"
