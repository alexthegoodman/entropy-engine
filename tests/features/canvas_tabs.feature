Feature: The Canvas Surfaces sidebar is organized into tabs

  # The sidebar used to be one long stack of buttons and collapsing headers. It is now a slim
  # header that is always visible (play, undo, tool mode) above a tab bar, and each tab shows one
  # page. These scenarios run the production addon with a stand-in Entropy; the widget itself is
  # covered by tab_bar_bdd.

  Scenario: The sidebar opens on the Tool tab and lists every page
    Given a canvas surface is ready
    Then the tab bar lists "Tool, Surfaces, Animate, Scene, Help"
    And the "tool" tab is selected
    And I see the button "brush_btn_0"
    And I do not see the button "new_surface"
    And I do not see the button "save_scene"
    And I do not see the button "group_create"

  Scenario: Each tab shows only its own page
    Given a canvas surface is ready
    When I open the "surfaces" tab
    Then I see the button "new_surface"
    And I see the button "focus_surface"
    And I do not see the button "brush_btn_0"
    And I do not see the button "save_scene"
    When I open the "animate" tab
    Then I see the button "group_create"
    And I see the button "clip_create"
    And I do not see the button "new_surface"
    When I open the "scene" tab
    Then I see the button "save_scene"
    And I see the button "playable_example"
    And I do not see the button "group_create"
    When I open the "help" tab
    Then I see the label "Shortcuts"
    And I do not see the button "save_scene"
    When I open the "tool" tab
    Then I see the button "brush_btn_0"

  Scenario: Play, undo and the tool mode are reachable from every tab
    Given a canvas surface is ready
    When I open the "tool" tab
    Then the always visible controls are shown
    When I open the "surfaces" tab
    Then the always visible controls are shown
    When I open the "animate" tab
    Then the always visible controls are shown
    When I open the "scene" tab
    Then the always visible controls are shown
    When I open the "help" tab
    Then the always visible controls are shown

  Scenario: The chosen tab stays put from one frame to the next
    Given a canvas surface is ready
    When I open the "scene" tab
    And I redraw 5 frames
    Then the "scene" tab is selected
    And I see the button "save_scene"

  Scenario: Switching tabs is not an edit
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I open the "scene" tab
    And I open the "animate" tab
    And I open the "surfaces" tab
    Then the artwork matches exactly
    And I see the label "Undo: Stroke"

  Scenario: The Tool tab points at the Animate tab when a group is selected
    Given a canvas surface is ready
    When I open the "animate" tab
    And I click "animated_example"
    And I click "scene_confirm_discard"
    And I open the "animate" tab
    And I select the tree row "Character"
    And I click "mode_move"
    And I open the "tool" tab
    Then I see the label "Edit this group in the Animate tab."
    When I click "open_animate_tab"
    Then the "animate" tab is selected

  Scenario: Playing hides the tabs and stopping brings them back
    Given a canvas surface is ready
    When I open the playable example
    And I click "game_play"
    Then I see no tab bar
    When I click "game_play"
    Then the tab bar lists "Tool, Surfaces, Animate, Scene, Help"
