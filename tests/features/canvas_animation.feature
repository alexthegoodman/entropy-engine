Feature: Drawn creations have a persistent hierarchy and independent animation
  Scenario: An arm rotates around its shoulder and returns to its editing pose
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I click "group_create"
    And I set "node_pivot_y" to "3"
    Then the surface has its original geometry
    When I click "clip_create"
    And I set "key_value" to "0"
    And I click "key_add"
    And I set "clip_time" to "1"
    And I set "key_value" to "1.5707963267948966"
    And I click "key_add"
    Then the surface center is at the raised arm position
    And the artwork matches exactly
    When I click "animation_stop"
    Then the surface has its original geometry
    And the artwork matches exactly

  Scenario: Nested groups carry their leaves and ungrouping preserves the world pose
    Given a canvas surface is ready
    When I click "group_create"
    And I click "group_create"
    And I set "node_pos_x" to "2"
    Then the surface center has moved two units right
    When I click "save_scene"
    Then the scene has a nested hierarchy
    When I click "group_remove"
    Then the surface center has moved two units right
    When I click "undo"
    Then the surface center has moved two units right

  Scenario: A stroke draws itself in and survives scene reload with stable identity
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I select the first stroke
    And I click "clip_create"
    And I name "clip_name" to "Smile"
    And I set "key_value" to "0"
    And I click "key_add"
    Then the artwork differs
    When I set "clip_time" to "1"
    And I set "key_value" to "1"
    And I click "key_add"
    Then the artwork matches exactly
    When I click "save_scene"
    Then the scene preserves stroke identity and the named clip
    When I click "new_scene"
    And I click "load_scene"
    And I click "scene_confirm_discard"
    And I set "clip_time" to "0"
    Then the artwork differs
    When I set "clip_time" to "1"
    Then the artwork matches exactly
    When I click "animation_stop"
    Then the artwork matches exactly

  Scenario: Preview is not an edit and playback pauses at the clip end
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I select the first stroke
    And I click "clip_create"
    And I set "key_value" to "0"
    And I click "key_add"
    And I click "save_scene"
    And I set "clip_time" to "0"
    Then the artwork differs
    And the scene is still saved
    When I click "clip_play"
    Then the preview advances to its end
    When I click "animation_stop"
    Then the artwork matches exactly
    And the scene is still saved

  Scenario: Retained erasing replays in order and stroke visibility is undoable
    Given a canvas surface is ready
    When I draw a stroke
    And I click "brush_btn_3"
    And I draw a stroke
    And I remember the artwork
    And I select the first stroke
    And I click "stroke_visible"
    Then the artwork differs
    When I click "undo"
    Then the artwork matches exactly

  Scenario: A parent cannot become a child of its descendant
    Given a canvas surface is ready
    When I click "group_create"
    And I click "group_create"
    And I click "parent_choice"
    And I click "parent_apply"
    Then the cycle is rejected
    When I click "save_scene"
    Then the scene has a nested hierarchy

  Scenario: Scene validation rejects invalid references and animation values
    Given a canvas surface is ready
    When I click "group_create"
    And I click "clip_create"
    And I click "key_add"
    And I click "save_scene"
    Then malformed animation and hierarchy are rejected

  Scenario: Older raster artwork remains intact beneath new retained strokes
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I click "save_scene"
    And I reload a version two copy
    Then the artwork matches exactly
    When I draw a different stroke
    Then the artwork differs
    When I select the first stroke
    And I click "stroke_visible"
    Then the artwork matches exactly

  Scenario: Surface scale is independent of painted texture and survives undo
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I set "node_scale_x" to "2"
    Then the surface width is doubled
    And the artwork matches exactly
    When I click "undo"
    Then the surface has its original geometry
    And the artwork matches exactly

  Scenario: The editable character example contains an arm and a drawn smile
    Given a canvas surface is ready
    When I click "animated_example"
    And I click "scene_confirm_discard"
    And I click "save_scene"
    Then the example has independent arm and smile tracks

  Scenario: Stroke visibility holds until its next key instead of fading
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I select the first stroke
    And I click "clip_create"
    And I click "key_channel"
    And I set "key_value" to "0"
    And I click "key_add"
    And I set "clip_time" to "1"
    And I set "key_value" to "1"
    And I click "key_add"
    And I set "clip_time" to "0.5"
    Then the artwork differs
    When I set "clip_time" to "1"
    Then the artwork matches exactly
    When I click "animation_stop"
    Then the artwork matches exactly
