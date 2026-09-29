Feature: A playable grand piano in the real DAW
  Scenario: Keyboard, pedals, voicing and sequencer reach the real audio bus
    Given the real DAW is running in test mode
    When I advance 40 frames
    And I call the tool "daw_set_track_params" with {"trackId":"trk-lead","waveform":"piano"}
    And I send the widget event "TABBAR_SELECTED|daw_view|mixer"
    And I advance 2 frames
    And I click "select_track_2"
    And I advance 2 frames
    And I send the widget event "TABBAR_SELECTED|daw_view|arrange"
    And I set "instrument_windows" to "5"
    And I advance 40 frames
    Then I capture "piano-01-concert"
    When I send the widget event "PIANO_KEY_DOWN|piano_trk-lead|39|261.63|0.8"
    And I wait 180 milliseconds
    And I advance 2 frames
    Then I record the analysis "key-c4" of "trk-lead"
    And I capture "piano-02-playing"
    When I send the widget event "PIANO_KEY_UP|piano_trk-lead|39|261.63"
    And I wait 1100 milliseconds
    And I advance 2 frames
    Then I record the analysis "released" of "trk-lead"
    When I call the tool "daw_piano" with {"trackId":"trk-lead","action":"pedal","sustain":1}
    And I send the widget event "PIANO_KEY_DOWN|piano_trk-lead|39|261.63|0.8"
    And I wait 180 milliseconds
    And I send the widget event "PIANO_KEY_UP|piano_trk-lead|39|261.63"
    And I wait 700 milliseconds
    Then I record the analysis "pedal-ring" of "trk-lead"
    When I click "piano_physics"
    And I advance 3 frames
    Then I capture "piano-03-physics"
    When I call the tool "daw_piano" with {"trackId":"trk-lead","action":"pedal","sustain":0}
    And I wait 1200 milliseconds
    Then I record the analysis "pedal-released" of "trk-lead"
    When I call the tool "daw_piano" with {"trackId":"trk-lead","action":"preset","preset":"WarmGrand"}
    And I call the tool "daw_piano" with {"trackId":"trk-lead","action":"hear","note":60}
    And I call the tool "daw_piano" with {"trackId":"trk-lead","action":"preset","preset":"BrightGrand"}
    And I call the tool "daw_piano" with {"trackId":"trk-lead","action":"hear","note":60}
    And I advance 3 frames
    Then I capture "piano-04-bright"
    When I send the widget event "TRACKS_SEEK|arrangement|10000"
    And I advance 3 frames
    And I start measuring "song" of "trk-lead"
    And I click "transport_toggle"
    And I wait 2300 milliseconds
    And I advance 4 frames
    Then I record the measurement "song"
    And I capture "piano-05-song"
    When I click "transport_toggle"
    And I wait 1000 milliseconds
