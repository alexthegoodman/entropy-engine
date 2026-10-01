Feature: Tiled app pointer gestures reach the addon
  The live creative suite routes GUI pointer input through the native widget and JS callback.

  Scenario: A Kanban card moves to another column after selection changes the editor
    Given the real DAW is running in test mode
    When I send the widget event "TAB_SELECT|CC Manager"
    And I advance 12 frames
    Then I see the label "CC Manager"
    And I capture "01-kanban-before"
    And I send GUI pointer "down" at "100" "125"
    And I advance 2 frames
    And I send GUI pointer "move" at "350" "125"
    And I advance 2 frames
    And I send GUI pointer "up" at "350" "125"
    And I advance 12 frames
    Then I capture "02-kanban-after"

  Scenario: A DAW track label responds in a tiled view
    When I send the widget event "TILE_LAYOUT|split_h"
    And I send the widget event "TILE_ASSIGN|0|Terminal"
    And I send the widget event "TILE_ASSIGN|1|DAW"
    And I advance 12 frames
    And I capture "03-daw-before"
    And I send GUI pointer "down" at "950" "265"
    And I send GUI pointer "up" at "950" "265"
    And I advance 12 frames
    Then I capture "04-daw-after"

    When I send GUI pointer "down" at "1190" "265"
    And I send GUI pointer "move" at "1146" "265"
    And I send GUI pointer "up" at "1146" "265"
    And I wait 500 milliseconds
    And I advance 12 frames
    Then I capture "05-daw-clip-moved"
