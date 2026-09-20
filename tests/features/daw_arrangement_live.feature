Feature: The running DAW arranges a song on sixteen channels

  Scenario: Open the starter song, set the tempo, arrange on an empty channel, vary a pattern, and play it
    Given the real DAW is running in test mode
    When I advance 40 frames
    Then I see the label "Bar 1  Beat 1   0:00.0"
    And I capture "arrangement-01-starter"

    When I set "bpm_input" to "128"
    And I advance 10 frames
    Then I capture "arrangement-02-tempo"

    When I send the widget event "TRACKS_CLIP_CREATE|arrangement|empty:8|3750|3750"
    And I advance 10 frames
    Then I capture "arrangement-03-new-channel"

    When I send the widget event "TRACKS_CLIP_SELECTED|arrangement|trk-bass|clip-bass-2"
    And I advance 4 frames
    And I click "pattern_duplicate"
    And I advance 4 frames
    And I send the widget event "PIANOROLL_DOWN|daw_pianoroll_trk-bass|4,6"
    And I send the widget event "PIANOROLL_UP|daw_pianoroll_trk-bass|4,6"
    And I send the widget event "PIANOROLL_DOWN|daw_pianoroll_trk-bass|6,10"
    And I send the widget event "PIANOROLL_UP|daw_pianoroll_trk-bass|6,10"
    And I advance 10 frames
    Then I capture "arrangement-04-variation"

    When I send the widget event "TRACKS_TRACK_MUTE|arrangement|trk-pad"
    And I send the widget event "TRACKS_TRACK_SOLO|arrangement|trk-lead"
    And I advance 10 frames
    Then I capture "arrangement-05-mute-solo"

    When I send the widget event "TRACKS_TRACK_SOLO|arrangement|trk-lead"
    And I send the widget event "TRACKS_SEEK|arrangement|22500"
    And I advance 4 frames
    And I click "transport_toggle"
    And I wait 1500 milliseconds
    And I advance 5 frames
    Then I capture "arrangement-06-playing"

    When I click "transport_toggle"
    And I wait 600 milliseconds
    And I advance 5 frames
    Then I capture "arrangement-07-stopped"
