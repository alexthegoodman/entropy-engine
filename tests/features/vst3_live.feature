Feature: The DAW hosts real VST3 instruments in the running app

  Scenario: Put Vital, Massive and Maschine on tracks, play them, and open their own editors
    Given the real DAW is running in test mode
    When I advance 30 frames
    And I click "vst3_scan"
    And I advance 20 frames
    Then I capture "daw-scanned"

    When I click "select_track_1"
    And I advance 4 frames
    And I click "vst3_use_vital"
    And I advance 30 frames
    And I click "vst3_open_editor"
    And I advance 60 frames
    And I wait 1500 milliseconds
    Then I capture the plugin editor "vital-editor"
    When I click "preview_row_0"
    And I wait 250 milliseconds
    And I advance 10 frames
    Then I capture "daw-vital-playing"
    When I wait 800 milliseconds
    And I click "vst3_close_editor"
    And I advance 30 frames

    When I click "add_synth_track"
    And I advance 8 frames
    And I click "vst3_use_massive"
    And I advance 30 frames
    And I click "vst3_open_editor"
    And I advance 60 frames
    And I wait 1500 milliseconds
    Then I capture the plugin editor "massive-editor"
    When I click "preview_row_0"
    And I wait 250 milliseconds
    And I advance 10 frames
    Then I capture "daw-massive-playing"
    When I wait 800 milliseconds
    And I click "vst3_close_editor"
    And I advance 30 frames

    When I click "select_track_0"
    And I advance 4 frames
    And I click "vst3_use_maschine_3"
    And I advance 30 frames
    And I click "vst3_open_editor"
    And I advance 60 frames
    And I wait 2500 milliseconds
    Then I capture the plugin editor "maschine-editor"
    When I click "preview_row_0"
    And I wait 400 milliseconds
    And I click "vst3_close_editor"
    And I advance 30 frames

    When I click "transport_toggle"
    And I wait 2500 milliseconds
    And I advance 10 frames
    Then I capture "daw-transport-playing"
    When I click "transport_toggle"
    And I advance 30 frames
    Then I capture "daw-final"
