Feature: The running DAW plays its drum kit

  The real DAW renders the kit and plays it through the track's audio bus.
  Widget events use the same strings emitted by the kit view's heads and pads.

  Scenario: Make a track a kit, open it and strike it
    Given the real DAW is running in test mode
    When I advance 40 frames
    And I call the tool "daw_set_track_params" with {"trackId":"trk-lead","waveform":"matter"}
    And I click "select_track_2"
    And I click "toggle_matter"
    And I wait 3000 milliseconds
    And I advance 45 frames
    Then I capture "kit-01-open"

    When I send the widget event "MATTER_PAD|mt_trk-lead|snare|0.9"
    And I wait 120 milliseconds
    And I advance 3 frames
    Then I record the analysis "pad-snare" of "trk-lead"
    And I capture "kit-02-snare"

    When I send the widget event "MATTER_STRIKE|mt_trk-lead|floor-tom|0.8000|0.3000|0.900"
    And I wait 120 milliseconds
    And I advance 3 frames
    Then I record the analysis "click-floor-tom" of "trk-lead"
    And I capture "kit-03-floor-tom"

  Scenario: Physics View and the AI tool
    When I click "mt_physics"
    And I send the widget event "MATTER_PAD|mt_trk-lead|crash|1.000"
    And I wait 200 milliseconds
    And I advance 5 frames
    Then I capture "kit-04-physics"

    When I call the tool "daw_matter" with {"trackId":"trk-lead","action":"preset","preset":"rock"}
    And I call the tool "daw_matter" with {"trackId":"trk-lead","action":"hear","row":1,"velocity":0.9}
    And I wait 3000 milliseconds
    And I advance 10 frames
    And I call the tool "daw_matter" with {"trackId":"trk-lead","action":"strike","row":4,"velocity":1}
    And I wait 120 milliseconds
    And I advance 3 frames
    Then I record the analysis "tool-strike" of "trk-lead"
    And I capture "kit-05-rock"

  Scenario: The song plays the kit
    When I send the widget event "TRACKS_SEEK|arrangement|10000"
    And I advance 4 frames
    And I start measuring "song-lead" of "trk-lead"
    And I click "transport_toggle"
    And I wait 2600 milliseconds
    And I advance 5 frames
    Then I record the measurement "song-lead"
    And I capture "kit-06-song"

    When I click "transport_toggle"
    And I wait 300 milliseconds
