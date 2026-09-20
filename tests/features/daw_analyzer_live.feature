Feature: The running DAW shows real audio on its analyzer

  The real compiled DAW is launched against a clean data folder and plays through the machine's
  real output device. Every "record the analysis" step reads the audio engine's own analysis taps
  (peak and RMS, the strongest frequency, brightness) at that moment, so the assertions are about
  the audio itself, not about pixels; the screenshots are the visual record of the same moments.

  Scenario: Silence, then the starter song, then silence again
    Given the real DAW is running in test mode
    When I advance 40 frames
    Then I capture "analyzer-01-idle"
    And I record the analysis "idle-master" of "master"

    When I send the widget event "TRACKS_SEEK|arrangement|22500"
    And I advance 4 frames
    And I start measuring "song-drums" of "trk-drums"
    And I start measuring "song-master-peak" of "master"
    And I click "transport_toggle"
    And I wait 1800 milliseconds
    And I advance 5 frames
    Then I capture "analyzer-02-song-master"
    And I record the analysis "song-master" of "master"
    And I record the measurement "song-drums"
    And I record the measurement "song-master-peak"

    When I set "analyzer_source" to "1"
    And I advance 30 frames
    Then I capture "analyzer-03-song-drums"

    When I click "transport_toggle"
    And I wait 2500 milliseconds
    And I advance 5 frames
    Then I capture "analyzer-04-stopped"
    And I record the analysis "stopped-master" of "master"

  Scenario: One note on one track has the pitch of its row
    When I set "analyzer_source" to "3"
    And I click "select_track_2"
    And I advance 8 frames
    And I click "preview_row_0"
    And I wait 200 milliseconds
    And I advance 3 frames
    Then I capture "analyzer-05-lead-c4"
    And I record the analysis "lead-c4-track" of "trk-lead"
    And I record the analysis "lead-c4-master" of "master"

    When I wait 900 milliseconds
    And I click "select_track_1"
    And I advance 8 frames
    And I click "preview_row_0"
    And I wait 200 milliseconds
    And I advance 3 frames
    Then I capture "analyzer-06-bass-c2"
    And I record the analysis "bass-c2-track" of "trk-bass"
