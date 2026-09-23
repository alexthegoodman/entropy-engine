Feature: The running DAW bows a physically modeled string and plays it

  The real compiled DAW is launched against a clean data folder and plays through the machine's real
  output device. The widget events are the exact strings the real bowed-string widget pushes; the
  buttons are the real ones; the tool calls go through the same `call_tool` the MCP server uses.
  Every "record the analysis" step reads the audio engine's own taps on the track's bus, so what is
  asserted is the audio itself. The "hear" results are the engine playing a note offline through the
  same voice and reading it back. Screenshots are the real renderer's, of the real window.

  Scenario: Make the lead a bowed string, open the editor and play a key
    Given the real DAW is running in test mode
    When I advance 40 frames
    And I call the tool "daw_set_track_params" with {"trackId":"trk-lead","waveform":"physmod"}
    And I click "select_track_2"
    And I click "toggle_physmod"
    And I advance 45 frames
    Then I capture "physmod-01-open"

    When I send the widget event "PHYSMOD_KEY_DOWN|pm_trk-lead|60|0.9"
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "key-c4" of "trk-lead"
    And I capture "physmod-02-key-held"

    When I send the widget event "PHYSMOD_KEY_UP|pm_trk-lead|60"
    And I wait 1200 milliseconds
    And I advance 3 frames
    Then I record the analysis "after-release" of "trk-lead"

  Scenario: A latched note brightens as the bow force rises
    When I click "pm_latch"
    And I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"params","params":{"bowForce":0.1}}
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "latched-soft" of "trk-lead"
    And I capture "physmod-03-latched"

    When I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"params","params":{"bowForce":0.95}}
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "latched-hard" of "trk-lead"
    And I capture "physmod-04-latched-hard"

    When I click "pm_latch"
    And I wait 1200 milliseconds

  Scenario: Dragging the bow in the view moves the same held note
    When I click "pm_latch"
    And I wait 300 milliseconds
    And I send the widget event "PHYSMOD_BOW_DRAG|pm_trk-lead|0.04|0.9"
    And I wait 500 milliseconds
    And I advance 3 frames
    Then I record the analysis "bow-dragged" of "trk-lead"
    And I capture "physmod-05-bow-drag"

    When I click "pm_latch"
    And I wait 1200 milliseconds

  Scenario: Switching instrument changes the register a note is heard at
    When I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"instrument","instrument":"violin"}
    And I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"hear","note":57}
    And I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"instrument","instrument":"cello"}
    And I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"hear","note":57}
    And I advance 30 frames
    Then I capture "physmod-06-instruments"

  Scenario: The song plays the bowed string through the same bus
    When I call the tool "daw_physmod" with {"trackId":"trk-lead","action":"instrument","instrument":"violin"}
    And I send the widget event "TRACKS_SEEK|arrangement|10000"
    And I advance 4 frames
    And I start measuring "song-lead" of "trk-lead"
    And I click "transport_toggle"
    And I wait 2600 milliseconds
    And I advance 5 frames
    Then I record the measurement "song-lead"
    And I capture "physmod-07-song"

    When I click "transport_toggle"
    And I wait 300 milliseconds
