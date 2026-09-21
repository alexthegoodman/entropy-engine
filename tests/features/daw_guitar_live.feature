Feature: The running DAW opens a real audio input from its Guitar Input panel

  The real compiled DAW is launched against a clean data folder. The panel asks the engine to open
  the machine's default input through the real op path (JS to Rust, cpal, WASAPI), reads its status
  back, and stops it. No guitar is assumed: this checks the plumbing in the real app, that the
  device opens, the callback runs, and stopping is clean. Playing a note from a real guitar is a
  by-hand check.

  Scenario: Open the panel, start the default input, and stop it again
    Given the real DAW is running in test mode
    When I advance 30 frames
    And I click "toggle_guitar"
    And I advance 10 frames
    Then I see the label "Status: stopped"
    And I capture "guitar-01-panel-stopped"

    When I click "guitar_refresh"
    And I advance 5 frames
    And I click "guitar_toggle"
    And I advance 10 frames
    And I wait 1500 milliseconds
    And I advance 10 frames
    Then I see the label "Status: listening"
    And I capture "guitar-02-listening"

    When I click "guitar_mode_fast"
    And I advance 5 frames
    And I click "guitar_cal_room"
    And I wait 1000 milliseconds
    And I advance 10 frames
    Then I see the label "Status: listening"
    And I capture "guitar-03-calibrating"

    When I click "guitar_toggle"
    And I advance 10 frames
    Then I see the label "Status: stopped"
    And I capture "guitar-04-stopped-again"
