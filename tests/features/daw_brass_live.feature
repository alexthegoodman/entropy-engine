Feature: The running DAW plays its brass instrument

  The real DAW renders the brass editor and plays through the track's audio bus.
  Widget events use the same strings emitted by the brass keyboard and playing map.

  Scenario: Open the brass editor and play and release a keyboard note
    Given the real DAW is running in test mode
    When I advance 40 frames
    And I call the tool "daw_set_track_params" with {"trackId":"trk-lead","waveform":"brass"}
    And I click "select_track_2"
    And I click "toggle_brass"
    And I advance 45 frames
    Then I capture "brass-01-open"

    When I send the widget event "BRASS_KEY_DOWN|br_trk-lead|58|0.9"
    And I wait 600 milliseconds
    And I advance 3 frames
    Then I record the analysis "key-bb3" of "trk-lead"
    And I capture "brass-02-key-held"

    When I send the widget event "BRASS_KEY_UP|br_trk-lead|58"
    And I wait 1500 milliseconds
    And I advance 3 frames
    Then I record the analysis "after-release" of "trk-lead"

  Scenario: A held note responds to the player's controls
    When I click "br_latch"
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "latched-section" of "trk-lead"
    And I capture "brass-03-latched"

    When I click "br_style_blazing"
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "latched-blazing" of "trk-lead"
    And I capture "brass-04-blazing"

    When I send the widget event "BRASS_PLAY_DRAG|br_trk-lead|0.3|-0.2"
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "playing-map" of "trk-lead"
    And I capture "brass-05-playing-map"

    When I click "br_latch"
    And I wait 1200 milliseconds

  Scenario: Instrument and mute selections reach the player
    When I call the tool "daw_brass" with {"trackId":"trk-lead","action":"instrument","instrument":"trumpet"}
    And I call the tool "daw_brass" with {"trackId":"trk-lead","action":"hear","note":70}
    And I call the tool "daw_brass" with {"trackId":"trk-lead","action":"params","params":{"mute":"cup"}}
    And I call the tool "daw_brass" with {"trackId":"trk-lead","action":"hear","note":70}
    And I advance 30 frames
    Then I capture "brass-06-trumpet-cup"

  Scenario: The song plays the brass track
    When I send the widget event "TRACKS_SEEK|arrangement|10000"
    And I advance 4 frames
    And I start measuring "song-lead" of "trk-lead"
    And I click "transport_toggle"
    And I wait 2600 milliseconds
    And I advance 5 frames
    Then I record the measurement "song-lead"
    And I capture "brass-07-song"

    When I click "transport_toggle"
    And I wait 300 milliseconds
