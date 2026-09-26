Feature: Every app's controls work from the keyboard and give clear feedback

  Each scenario drives the real entropy_gui kit through a headless context, one frame at a time,
  with synthetic keys, text and pointer input. The screen is one form: Play and Stop buttons, a
  Loop checkbox, a Name field, a Wave dropdown, a Cutoff knob (20 to 20000 Hz, default 1000), an
  "Open settings" button that shows a Settings window (Apply, Reset), and a short scrolling list
  of twenty rows. Pictures land in test-artifacts/keyboard_ux/.

  # --- Keyboard navigation and visible focus -------------------------------------------------

  Scenario: Tab walks the controls in order and Shift+Tab walks back
    Given the form is on screen
    When I press Tab
    Then "Play" has keyboard focus
    When I press Tab
    Then "Stop" has keyboard focus
    When I press Tab
    Then "Loop" has keyboard focus
    When I press Shift+Tab
    Then "Stop" has keyboard focus

  Scenario: Enter and Space activate the focused control
    Given the form is on screen
    When I press Tab
    And I press Enter
    Then "Play" was activated 1 time
    When I press Space
    Then "Play" was activated 2 times
    When I press Tab
    And I press Tab
    And I press Space
    Then the Loop checkbox is on

  Scenario: A focus ring shows for keyboard focus but not for a click
    Given the form is on screen
    When I click "Stop"
    Then "Stop" has keyboard focus
    And no focus ring is drawn around "Stop"
    When I press Tab
    And I press Shift+Tab
    Then "Stop" has keyboard focus
    And a focus ring is drawn around "Stop"
    And I save the picture "focus-ring-on-stop"

  Scenario: Escape and a click on empty space both let go of focus
    Given the form is on screen
    When I press Tab
    And I press Escape
    Then nothing has keyboard focus
    When I press Tab
    And I click empty space
    Then nothing has keyboard focus

  Scenario: Typing goes to a focused text field, and app shortcuts stand down meanwhile
    Given the form is on screen
    When I tab to "Name"
    Then the GUI wants the keyboard for typing
    When I type "Lead synth"
    Then the Name field reads "Lead synth"
    When I press Enter
    Then "Play" was activated 0 times
    When I press Escape
    Then nothing has keyboard focus
    And the GUI does not want the keyboard for typing

  Scenario: A dropdown opens, moves and picks from the keyboard, then gives focus back
    Given the form is on screen
    When I tab to "Wave"
    And I press Down
    Then the "Wave" dropdown is open
    And "Sine" has keyboard focus
    When I press Down
    Then "Square" has keyboard focus
    When I press Enter
    Then the Wave is "Square"
    And the "Wave" dropdown is closed
    And "Wave" has keyboard focus

  Scenario: Escape closes a dropdown and returns focus to it
    Given the form is on screen
    When I tab to "Wave"
    And I press Enter
    Then the "Wave" dropdown is open
    When I press Escape
    Then the "Wave" dropdown is closed
    And "Wave" has keyboard focus

  Scenario: A window opened from the keyboard takes focus, and closing it gives focus back
    Given the form is on screen
    When I tab to "Open settings"
    And I press Enter
    Then the Settings window is open
    And "Apply" has keyboard focus
    When I press Tab
    Then "Reset" has keyboard focus
    When I press Tab
    Then "Apply" has keyboard focus
    When I press Escape
    Then the Settings window is closed
    And "Open settings" has keyboard focus

  # --- Knobs and numeric input -----------------------------------------------------------------

  Scenario: Arrow keys step a focused knob, Shift steps finely, Home and End jump to the ends
    Given the form is on screen
    When I tab to "Cutoff"
    And I press Up
    Then the Cutoff is 1199.8
    When I press Shift+Down
    Then the Cutoff is 1179.82
    When I press End
    Then the Cutoff is 20000
    When I press Home
    Then the Cutoff is 20

  Scenario: Delete puts a focused knob back to its default
    Given the form is on screen
    When I tab to "Cutoff"
    And I press End
    And I press Delete
    Then the Cutoff is 1000

  Scenario: Double-click a knob and type an exact value, with or without its unit
    Given the form is on screen
    When I double-click "Cutoff"
    And I type "2.5k"
    And I press Enter
    Then the Cutoff is 2500
    When I double-click "Cutoff"
    And I type "440 Hz"
    And I press Enter
    Then the Cutoff is 440

  Scenario: Escape abandons a typed value
    Given the form is on screen
    When I double-click "Cutoff"
    And I type "5000"
    Then I save the picture "knob-typing"
    When I press Escape
    Then the Cutoff is 1000

  Scenario: Typed values outside the range are clamped
    Given the form is on screen
    When I double-click "Cutoff"
    And I type "99999"
    And I press Enter
    Then the Cutoff is 20000

  Scenario: Ctrl+click resets a knob to its default
    Given the form is on screen
    When I tab to "Cutoff"
    And I press End
    And I ctrl-click "Cutoff"
    Then the Cutoff is 1000

  Scenario: Shift-drag adjusts a knob ten times more finely
    Given the form is on screen
    When I drag "Cutoff" up 18 points
    Then the Cutoff is 2998
    When I drag "Cutoff" up 18 points holding Shift
    Then the Cutoff is 3197.8

  # --- Scrolling -------------------------------------------------------------------------------

  Scenario: Tabbing to a row below the fold scrolls it into view
    Given the form is on screen
    And motion is reduced
    Then "Row 12" is outside the list's visible area
    When I tab to "Row 12"
    And I advance 2 frames
    Then "Row 12" is inside the list's visible area
    And I save the picture "row-12-revealed"

  Scenario: Page Down scrolls the list under the pointer by about a page
    Given the form is on screen
    And motion is reduced
    When I rest the pointer on the list
    And I press Page Down
    And I advance 1 frame
    Then the list has scrolled down between 30 and 120 points

  Scenario: The scrollbar thumb can be dragged
    Given the form is on screen
    And motion is reduced
    When I drag the list's scrollbar thumb down 30 points
    Then the list has scrolled down more than 60 points

  Scenario: A mouse wheel notch eases rather than jumping
    Given the form is on screen
    When I rest the pointer on the list
    And I scroll the wheel down 96 points
    Then the list has scrolled down between 1 and 95 points
    When I advance 30 frames
    Then the list has scrolled down between 95 and 97 points

  Scenario: With reduced motion the wheel jumps straight there
    Given the form is on screen
    And motion is reduced
    When I rest the pointer on the list
    And I scroll the wheel down 96 points
    Then the list has scrolled down between 95 and 97 points

  # --- Tooltips --------------------------------------------------------------------------------

  Scenario: A tooltip waits for the pointer to rest, then shows with its shortcut
    Given the form is on screen
    When I rest the pointer on "Play" for 5 frames
    Then no tooltip is shown
    When I rest the pointer on "Play" for 30 frames
    Then the tooltip "Play" is shown
    And I save the picture "tooltip-with-shortcut"

  Scenario: Moving to a neighbour while a tooltip is showing shows the next one straight away
    Given the form is on screen
    When I rest the pointer on "Play" for 40 frames
    And I rest the pointer on "Stop" for 1 frame
    Then the tooltip "Stop" is shown

  Scenario: A knob's tooltip explains its range, default and gestures
    Given the form is on screen
    When I rest the pointer on "Cutoff" for 40 frames
    Then the tooltip "Range 20 Hz to 20000 Hz" is shown
    And the tooltip "Ctrl+click to reset" is shown

  # --- Toasts ----------------------------------------------------------------------------------

  Scenario: A toast confirms, then goes away on its own
    Given the form is on screen
    When a "success" toast says "Saved" for 1 second
    And I advance 2 frames
    Then the toast "Saved" is on screen
    And nothing has keyboard focus
    And I save the picture "toast-saved"
    When I advance 70 frames
    Then the toast "Saved" is gone

  Scenario: A toast's action button reports back and closes it, without having taken focus
    Given the form is on screen
    When I press Tab
    And an "error" toast says "Could not save" with the action "Retry"
    And I advance 2 frames
    Then "Play" has keyboard focus
    When I click the toast button "Retry"
    Then the toast action for "Could not save" was reported
    And the toast "Could not save" is gone

  Scenario: Hovering a toast keeps it on screen
    Given the form is on screen
    When a "info" toast says "Exported" for 1 second
    And I rest the pointer on the toast "Exported" for 90 frames
    Then the toast "Exported" is on screen

  Scenario: A progress toast updates in place
    Given the form is on screen
    When a progress toast "Rendering" is at 0.25
    And I advance 2 frames
    And a progress toast "Rendering" is at 0.75
    And I advance 2 frames
    Then there is 1 toast on screen
    And I save the picture "toast-progress"
