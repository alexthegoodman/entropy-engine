Feature: Multitasking tiled layouts and taskbar snap flyout
  The creative suite supports tiled multitasking layouts where apps share the work area
  and retain their own floating windows.

  Scenario: Taskbar Snap flyout toggles and displays multitasking options
    Given the real DAW is running in test mode
    When I advance 30 frames
    Then I see the label "Analyzer"
    And I do not see the label "Snap Layouts & Multitasking"

    When I send the widget event "TOGGLE_LAYOUT_MENU"
    And I advance 3 frames
    Then I see the label "Snap Layouts & Multitasking"
    And I capture "01-snap-flyout-open"

    When I send the widget event "TOGGLE_LAYOUT_MENU"
    And I advance 3 frames
    Then I do not see the label "Snap Layouts & Multitasking"

  Scenario: Tiled multitasking with Terminal and DAW
    When I send the widget event "TILE_LAYOUT|split_h"
    And I send the widget event "TILE_ASSIGN|0|Terminal"
    And I send the widget event "TILE_ASSIGN|1|DAW"
    And I advance 10 frames
    Then I see the label "Terminal"
    And I see the label "DAW"
    And I see the label "Analyzer"
    And I do not see the label "Library"
    And I capture "02-split-terminal-daw"

  Scenario: 3-Way Grid multitasking with Terminal, DAW and CC Manager
    When I send the widget event "TILE_LAYOUT|three_grid"
    And I send the widget event "TILE_ASSIGN|0|Terminal"
    And I send the widget event "TILE_ASSIGN|1|DAW"
    And I send the widget event "TILE_ASSIGN|2|CC Manager"
    And I advance 10 frames
    Then I see the label "Terminal"
    And I see the label "DAW"
    And I see the label "Analyzer"
    And I see the label "CC Manager"
    And I capture "03-three-way-grid"

  Scenario: Quad Grid multitasking with 4 apps simultaneously
    When I send the widget event "TILE_LAYOUT|quad_grid"
    And I send the widget event "TILE_ASSIGN|0|Terminal"
    And I send the widget event "TILE_ASSIGN|1|DAW"
    And I send the widget event "TILE_ASSIGN|2|CC Manager"
    And I send the widget event "TILE_ASSIGN|3|guitar-tabs"
    And I advance 10 frames
    Then I see the label "Terminal"
    And I see the label "DAW"
    And I see the label "Analyzer"
    And I see the label "CC Manager"
    And I see the label "Guitar Tabs"
    And I capture "04-quad-grid-multitask"

  Scenario: Restoring Single mode hides inactive apps and their floating windows
    When I send the widget event "TILE_LAYOUT|single"
    And I send the widget event "TAB_SELECT|terminal"
    And I advance 10 frames
    Then I see the label "Terminal"
    And I do not see the label "Analyzer"
    And I do not see the label "Guitar Tabs"
    And I capture "05-restored-single-terminal"
