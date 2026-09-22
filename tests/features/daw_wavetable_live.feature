Feature: The running DAW sculpts a wavetable and plays it

  The real compiled DAW is launched against a clean data folder and plays through the machine's real
  output device. The widget events are the exact strings the real terrain widget pushes for a key
  pressed on its keyboard; the buttons are the real ones; the tool calls go through the same
  `call_tool` the MCP server uses. Every "record the analysis" step reads the audio engine's own taps
  on the track's bus, so what is asserted is the audio itself. The "hear" results are the engine
  playing a note offline through the same voice and reading it back. Screenshots are the real
  renderer's, of the real window.

  Scenario: Make the lead a wavetable synth, open the editor and play a key
    Given the real DAW is running in test mode
    When I advance 40 frames
    And I call the tool "daw_set_track_params" with {"trackId":"trk-lead","waveform":"wavetable"}
    And I click "select_track_2"
    And I click "toggle_wavetable"
    And I advance 45 frames
    Then I capture "wavetable-01-open"

    When I send the widget event "WAVETABLE_KEY_DOWN|wt_trk-lead|60|0.9"
    And I wait 350 milliseconds
    And I advance 3 frames
    Then I record the analysis "key-c4" of "trk-lead"
    And I capture "wavetable-02-key-held"

    When I send the widget event "WAVETABLE_KEY_UP|wt_trk-lead|60"
    And I wait 1200 milliseconds
    And I advance 3 frames
    Then I record the analysis "after-release" of "trk-lead"

  Scenario: A latched note moves through the table when the position moves
    When I click "wt_latch"
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"params","params":{"position":0.05}}
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "latched-low" of "trk-lead"
    And I capture "wavetable-03-latched"

    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"params","params":{"position":0.95}}
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "latched-high" of "trk-lead"
    And I capture "wavetable-04-latched-high"

    When I click "wt_latch"
    And I wait 1200 milliseconds

  Scenario: Sculpting the table changes what a note sounds like
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"preset","preset":"sine"}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":57,"position":0.5}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"sculpt","stamps":[{"tool":"raise","frame":15,"phase":0.5,"radius":0.05,"amount":3},{"tool":"raise","frame":16,"phase":0.5,"radius":0.05,"amount":3}]}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":57,"position":0.5}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"info","frame":15}
    And I advance 30 frames
    Then I capture "wavetable-05-sculpted"

  Scenario: The vowels table moves through formants as the position rises
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"preset","preset":"vowels"}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":48,"position":0.0}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":48,"position":0.5}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":48,"position":1.0}
    And I advance 30 frames
    Then I capture "wavetable-06-vowels"

  Scenario: The song plays the wavetable through the same bus
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"preset","preset":"terrain"}
    And I send the widget event "TRACKS_SEEK|arrangement|10000"
    And I advance 4 frames
    And I start measuring "song-lead" of "trk-lead"
    And I click "transport_toggle"
    And I wait 2600 milliseconds
    And I advance 5 frames
    Then I record the measurement "song-lead"
    And I capture "wavetable-07-song"

    When I click "transport_toggle"
    And I wait 300 milliseconds

  Scenario: An instrument preset sets the table, the motion and the track's own filter/envelope
    When I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"instrument","instrumentPreset":"modulated_bass"}
    And I call the tool "daw_wavetable" with {"trackId":"trk-lead","action":"hear","note":36,"position":0.28}
    And I advance 30 frames
    Then I capture "wavetable-08-instrument-preset"
