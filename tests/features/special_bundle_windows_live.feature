Feature: Floating windows follow the selected taskbar app
  The special bundle keeps each app's floating windows open while another app is selected.

  Scenario: DAW and Mesha windows appear only in their own views
    Given the real DAW is running in test mode
    When I advance 30 frames
    Then I see the label "Analyzer"
    And I do not see the label "Library"

    When I send the widget event "TAB_SELECT|guitar-tabs"
    And I advance 3 frames
    Then I do not see the label "Analyzer"
    And I do not see the label "Library"
    And I capture "01-guitar-tabs"

    When I send the widget event "TAB_SELECT|Mesha"
    And I advance 3 frames
    Then I see the label "Library"
    And I see the label "Properties"
    And I do not see the label "Analyzer"
    And I capture "02-mesha"

    When I send the widget event "TAB_SELECT|CC Manager"
    And I advance 3 frames
    Then I do not see the label "Library"
    And I do not see the label "Analyzer"
    And I capture "03-cc-manager"

    When I send the widget event "TAB_SELECT|DAW"
    And I advance 3 frames
    Then I see the label "Analyzer"
    And I do not see the label "Library"
    And I capture "04-daw-restored"

    When I send the widget event "TAB_SELECT|Mesha"
    And I advance 3 frames
    Then I see the label "Library"
    And I capture "05-mesha-restored"
