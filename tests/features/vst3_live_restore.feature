Feature: The DAW reopens a saved project with its plugins

  Scenario: Reopen the project the previous run saved
    Given the real DAW is running in test mode
    When I advance 60 frames
    And I send the widget event "TABBAR_SELECTED|daw_view|mixer"
    And I advance 4 frames
    And I click "select_track_1"
    And I advance 4 frames
    And I send the widget event "TABBAR_SELECTED|daw_view|arrange"
    And I advance 10 frames
    And I wait 500 milliseconds
    Then I capture "daw-restored-vital"
    When I click "vst3_open_editor"
    And I advance 60 frames
    And I wait 1500 milliseconds
    Then I capture the plugin editor "vital-editor-restored"
    When I click "preview_row_0"
    And I wait 600 milliseconds
    And I click "vst3_close_editor"
    And I advance 20 frames
