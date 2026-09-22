Feature: The real sheet addon computes formulas, colors cells, edits inline, and persists it all

  Every step below runs against the real compiled `sheet` example and the real bundled
  dist/sheet.js - unlike tests/sheet_grid_bdd.rs (which drives entropy_gui::SheetGrid directly
  in a headless context to prove the widget's own interaction logic), this proves the addon
  wiring itself: that the widget's event names match what addon_setup.js's dispatcher and
  sheet_addon.ts's callbacks expect, that formulas actually compute through the real bundle, and
  that edits actually reach disk. Selection/edit/insert/delete steps below inject the exact
  event string the real widget emits (e.g. "SHEET_CELL_SELECTED|sheet_grid|0|0") rather than a
  real mouse click, the same convention the tab bar and Kanban live tiers already use for
  widget-level events - real pointer-driven clicks and real keyboard input (arrow-key nav,
  double-click, type-to-edit) are the fast headless tier's job, not this one's (see
  tests/sheet_grid_bdd.rs). A formula bar edit still needs an explicit
  "SHEET_EDIT_COMMITTED|sheet_grid|row|col" step before it lands in the document - the real
  widget generates that event itself on Enter/Tab/click-away, but since this tier selects cells
  by injecting SHEET_CELL_SELECTED directly rather than a real click, nothing else would commit
  the previous cell's draft first. Regions used by different scenarios below are chosen not to
  overlap, since this is one continuous run against one long-lived app instance, not independent
  runs.

  Scenario: Given the real sheet addon is running in test mode
    Given the real sheet addon is running in test mode

  Scenario: Two values and a formula that reads them compute through the real bundle
    When I click "SHEET_CELL_SELECTED|sheet_grid|0|0"
    And I advance 1 frames
    And I set "formula_bar" to "10"
    And I advance 1 frames
    And I click "SHEET_EDIT_COMMITTED|sheet_grid|0|0"
    And I advance 2 frames
    And I click "SHEET_CELL_SELECTED|sheet_grid|0|1"
    And I advance 1 frames
    And I set "formula_bar" to "20"
    And I advance 1 frames
    And I click "SHEET_EDIT_COMMITTED|sheet_grid|0|1"
    And I advance 2 frames
    And I click "SHEET_CELL_SELECTED|sheet_grid|0|2"
    And I advance 1 frames
    And I set "formula_bar" to "=A1+B1"
    And I advance 1 frames
    And I click "SHEET_EDIT_COMMITTED|sheet_grid|0|2"
    And I advance 2 frames
    And I capture "sheet-formula"

  Scenario: A border color set through the color picker persists on the same cell, alongside its formula
    When I click "SHEET_CELL_SELECTED|sheet_grid|0|2"
    And I advance 1 frames
    And I set "border_color" to "1,0,0,1"
    And I advance 2 frames
    And I capture "sheet-border"

  Scenario: The grid's own inline edit events commit through to the document
    When I click "SHEET_CELL_SELECTED|sheet_grid|5|0"
    And I advance 1 frames
    And I click "SHEET_EDIT_STARTED|sheet_grid|5|0|"
    And I advance 1 frames
    And I click "SHEET_EDIT_CHANGED|sheet_grid|5|0|inline value"
    And I advance 1 frames
    And I click "SHEET_EDIT_COMMITTED|sheet_grid|5|0"
    And I advance 2 frames
    And I capture "sheet-inline-edit"

  Scenario: Inserting and deleting a row and column round-trip cleanly, far from the populated cells
    When I click "SHEET_INSERT_ROW|sheet_grid|20"
    And I advance 2 frames
    And I click "SHEET_INSERT_COL|sheet_grid|8"
    And I advance 2 frames
    And I capture "sheet-after-insert"
    And I click "SHEET_DELETE_ROW|sheet_grid|20"
    And I advance 2 frames
    And I click "SHEET_DELETE_COL|sheet_grid|8"
    And I advance 2 frames
    And I capture "sheet-after-delete"

  Scenario: Undo reverts the most recent committed edit and nothing else
    When I click "SHEET_CELL_SELECTED|sheet_grid|4|4"
    And I advance 1 frames
    And I set "formula_bar" to "before undo"
    And I advance 1 frames
    And I click "SHEET_EDIT_COMMITTED|sheet_grid|4|4"
    And I advance 2 frames
    And I click "undo_btn"
    And I advance 2 frames
    And I capture "sheet-after-undo"
