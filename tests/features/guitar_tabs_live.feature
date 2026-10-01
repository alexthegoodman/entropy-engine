Feature: The real Guitar Tabs app reads a tab, shows it for review, and grades playing it

  Runs against the real compiled `guitar-tabs` example and the real bundled dist/guitar_tabs.js
  (tests/guitar_tabs_live.rs). There is no guitar in a test run, so notes are played the way a
  player without one plays them: by clicking the neck, injected here as the exact event the
  fretboard widget emits ("FRETBOARD_PICK|tabs_neck|<string>|<fret>", string 0 the lowest). A click
  goes through the same grading path as a note Guitar-to-MIDI hears. The app's own MCP tools load
  a tab and report its state, so the test can check what the app believes, not just what it drew.

  Scenario: Given the real Guitar Tabs app is running in test mode
    Given the real Guitar Tabs app is running in test mode

  Scenario: The first example is read on the paste view
    When I set "tabs_example" to "0"
    And I advance 3 frames
    And I capture "tabs-paste"

  Scenario: The review sheet lists the steps, and the neck previews the selected one
    When I click "tabs_to_review"
    And I advance 2 frames
    And I click "SHEET_CELL_SELECTED|tabs_sheet|4|3"
    And I advance 3 frames
    And I capture "tabs-review"

  Scenario: At your own pace, right notes advance the cursor and a wrong one is counted
    When I click "tabs_to_practice"
    And I advance 3 frames
    And I set "tabs_guitar_sensitivity" to "0.75"
    And I set "tabs_guitar_gate" to "-35"
    And I advance 2 frames
    And I send the widget event "FRETBOARD_PICK|tabs_neck|5|0"
    And I advance 2 frames
    And I send the widget event "FRETBOARD_PICK|tabs_neck|5|0"
    And I advance 2 frames
    And I send the widget event "FRETBOARD_PICK|tabs_neck|5|2"
    And I advance 2 frames
    And I send the widget event "FRETBOARD_PICK|tabs_neck|5|1"
    And I advance 3 frames
    And I capture "tabs-practice-own-pace"
    And I call the tool "tabs_state"

  Scenario: A chord tab loaded by the tool is heard in chord mode, and a strummed chord advances
    When I call the tool "tabs_load" with {"text": "Chord check\nTempo: 80\ne|0-------3-------|\nB|1-------0-------|\nG|0-------0-------|\nD|2-------0-------|\nA|3-------2-------|\nE|x-------3-------|\n"}
    And I advance 2 frames
    And I click "tabs_to_practice"
    And I advance 2 frames
    And I send the widget event "FRETBOARD_PICK|tabs_neck|1|3"
    And I send the widget event "FRETBOARD_PICK|tabs_neck|2|2"
    And I send the widget event "FRETBOARD_PICK|tabs_neck|3|0"
    And I send the widget event "FRETBOARD_PICK|tabs_neck|4|1"
    And I advance 2 frames
    And I capture "tabs-practice-chord"
    And I call the tool "tabs_state"

  Scenario: In real time the count-in runs and the highway scrolls
    When I set "tabs_mode" to "1"
    And I advance 2 frames
    And I click "tabs_play"
    And I wait 1200 milliseconds
    And I capture "tabs-realtime-count-in"
    And I wait 2600 milliseconds
    And I capture "tabs-realtime-playing"
    And I call the tool "tabs_state"
