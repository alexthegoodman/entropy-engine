Feature: The sheet grid lays out cells, tracks selection, and navigates like a spreadsheet

  Each scenario drives the real `entropy_gui::SheetGrid` widget through a headless context, one
  frame at a time. Pointer and keyboard input are built exactly as the window backend builds
  them, events are read back from the widget, and what is drawn is rasterized on the CPU so the
  visual assertions look at pixels. Pictures land in test-artifacts/sheet-grid/.

  Scenario: Cells lay out in a uniform grid, row by row and column by column
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    When a frame is drawn
    Then cell 0,1 is 90 pixels right of cell 0,0
    And cell 1,0 is 22 pixels below cell 0,0
    And cell 2,3 is 90 pixels right of cell 2,2
    And I save the picture "sheet-grid-layout"

  Scenario: Clicking a cell selects it
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    When I click cell 0,0
    Then the events are "CellSelected(0,0)"
    When I click cell 2,3
    Then the events are "CellSelected(2,3)"

  Scenario: Arrow keys move the selection
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 is selected
    When I press "ArrowRight"
    Then the events are "CellSelected(1,2)"
    When I press "ArrowDown"
    Then the events are "CellSelected(2,2)"
    When I press "ArrowLeft"
    Then the events are "CellSelected(2,1)"
    When I press "ArrowUp"
    Then the events are "CellSelected(1,1)"

  Scenario: Navigation is clamped at the grid's edges
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 0,0 is selected
    When I press "ArrowLeft"
    Then there are no events
    When I press "ArrowUp"
    Then there are no events

  Scenario: Tab moves right and Enter moves down
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 0,0 is selected
    When I press "Tab"
    Then the events are "CellSelected(0,1)"
    When I press "Enter"
    Then the events are "CellSelected(1,1)"

  Scenario: Delete and Backspace ask to clear the selected cell
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,2 is selected
    When I press "Delete"
    Then the events are "CellClearRequested(1,2)"
    When I press "Backspace"
    Then the events are "CellClearRequested(1,2)"

  Scenario: A selected cell shows a white ring and an unselected one does not
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 is selected
    When a frame is drawn
    Then cell 1,1 has a white selection ring
    And cell 0,0 has no selection ring
    And I save the picture "sheet-grid-selected"

  Scenario: A cell's border color is drawn around it
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 2,1 has a red border
    When a frame is drawn
    Then cell 2,1 has a red border
    And I save the picture "sheet-grid-border"

  Scenario: Cell content and formula-error text are drawn
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 0,0 contains "Revenue"
    And cell 0,1 contains "1234"
    When a frame is drawn
    Then I save the picture "sheet-grid-content"
