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

  Scenario: Typing over a selected cell starts editing with the typed text, replacing its content
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 contains "old"
    And cell 1,1 is selected
    When I type "9"
    Then the events are "CellEditStarted(1,1,9)"
    And cell 1,1 is being edited with "9"

  Scenario: Double-clicking a cell edits its existing content instead of replacing it
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 contains "old"
    When I double-click cell 1,1
    Then cell 1,1 is being edited with "old"

  Scenario: Enter commits the edit and moves the selection down
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 contains "old"
    When I double-click cell 1,1
    And I press "Enter"
    Then the events are "CellEditCommitted(1,1), CellSelected(2,1)"
    And nothing is being edited

  Scenario: Tab commits the edit and moves the selection right
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 contains "old"
    When I double-click cell 1,1
    And I press "Tab"
    Then the events are "CellEditCommitted(1,1), CellSelected(1,2)"
    And nothing is being edited

  Scenario: Escape cancels the edit and discards the draft
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 contains "old"
    When I double-click cell 1,1
    And I press "Escape"
    Then the events are "CellEditCancelled(1,1)"
    And nothing is being edited

  Scenario: Clicking a different cell while editing commits the edit first
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    And cell 1,1 contains "old"
    When I double-click cell 1,1
    And I click cell 3,2
    Then the events are "CellEditCommitted(1,1), CellSelected(3,2)"
    And nothing is being edited

  Scenario: A row header's menu inserts a row above, below, or deletes it
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    When I right-click the row header for row 2 and choose "Insert row above"
    Then the events are "InsertRowRequested(2)"
    When I right-click the row header for row 2 and choose "Insert row below"
    Then the events are "InsertRowRequested(3)"
    When I right-click the row header for row 2 and choose "Delete row"
    Then the events are "DeleteRowRequested(2)"

  Scenario: A column header's menu inserts a column left, right, or deletes it
    Given a sheet grid of 5 rows and 4 columns at 90 by 22 cells
    When I right-click the column header for column 1 and choose "Insert column left"
    Then the events are "InsertColumnRequested(1)"
    When I right-click the column header for column 1 and choose "Insert column right"
    Then the events are "InsertColumnRequested(2)"
    When I right-click the column header for column 1 and choose "Delete column"
    Then the events are "DeleteColumnRequested(1)"
