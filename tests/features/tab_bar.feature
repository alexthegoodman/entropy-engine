Feature: The tab bar lays out, reports clicks and shows which tab is selected

  Each scenario drives the real entropy_gui::TabBar through a headless context, one frame at a
  time. Pointer input is built the way the window backend builds it (a hover frame, a press
  frame, a release frame), events are read back from the widget, and what is drawn is
  rasterized on the CPU so the look assertions are facts about pixels. Pictures land in
  test-artifacts/tab-bar/.

  Scenario: The Canvas Surfaces tabs fit one line of the sidebar, scrollbar included
    Given a tab bar with the tabs "Tool, Surfaces, Animate, Scene, Help" in a 296 pixel column
    When a frame is drawn
    Then every tab is on the same line
    And the tabs fill the column from edge to edge
    And no two tabs overlap
    And I save the picture "tabs-sidebar"

  Scenario: Tabs that do not fit wrap instead of being clipped
    Given a tab bar with the tabs "Tool, Surfaces, Animate, Scene, Help" in a 150 pixel column
    When a frame is drawn
    Then the tabs use more than one line
    And no tab reaches past the right edge of the column
    And I save the picture "tabs-wrapped"

  Scenario: Clicking another tab selects it
    Given a tab bar with the tabs "Tool, Surfaces, Animate, Scene, Help" in a 296 pixel column
    And the "tool" tab is selected
    When I click the "scene" tab
    Then the events are "Selected(scene)"

  Scenario: Clicking the selected tab or the gap between tabs does nothing
    Given a tab bar with the tabs "Tool, Surfaces, Animate, Scene, Help" in a 296 pixel column
    And the "surfaces" tab is selected
    When I click the "surfaces" tab
    Then there are no events
    When I click the gap after the "tool" tab
    Then there are no events

  Scenario: The selected tab has an accent underline and brighter text
    Given a tab bar with the tabs "Tool, Surfaces, Animate, Scene, Help" in a 296 pixel column
    And the "animate" tab is selected
    When a frame is drawn
    Then the "animate" tab has an underline and the "scene" tab does not
    And the "animate" label is brighter than the "scene" label
    And I save the picture "tabs-selected"

  Scenario: Hovering a tab that is not selected lights it up
    Given a tab bar with the tabs "Tool, Surfaces, Animate, Scene, Help" in a 296 pixel column
    And the "tool" tab is selected
    When a frame is drawn
    And the pointer rests on the "help" tab
    Then the "help" tab is lighter than the "scene" tab
