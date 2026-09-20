Feature: The running DAW plays samples from a folder on its drum pads

  The real compiled DAW is launched against a clean data folder and a generated "Music" folder
  (ENTROPY_MUSIC_DIR): Drum Kit holds a 300 Hz kick, a 900 Hz snare and a 4000 Hz hat, Album holds a
  14 second file. Every "record the analysis" step reads the audio engine's own analysis taps at
  that moment, so what is asserted is the audio itself - the frequency each pad actually plays -
  and the screenshots are the visual record of the same moments. The widget events are the exact
  strings the real tree and pad grid push when a row or a pad is clicked.

  Scenario: Browse, audition, put three samples on the kit, and hear them in the song
    Given the real DAW is running in test mode
    When I advance 60 frames
    Then I capture "rack-01-browser"

    When I send the widget event "TREEVIEW_SELECTED|sample_tree|{music}\Drum Kit"
    And I advance 5 frames
    Then I capture "rack-02-folder-open"

    When I send the widget event "TREEVIEW_SELECTED|sample_tree|{music}\Drum Kit\kick_a.wav"
    And I wait 250 milliseconds
    And I advance 3 frames
    Then I record the analysis "audition-kick" of "sample-preview"
    And I capture "rack-03-armed"

    When I wait 800 milliseconds
    And I send the widget event "PADGRID_CLICKED|rack_pads_trk-drums|0"
    And I wait 150 milliseconds
    And I advance 3 frames
    Then I record the analysis "kick-pad" of "trk-drums"
    And I capture "rack-04-kick-placed"

    When I wait 700 milliseconds
    And I send the widget event "TREEVIEW_SELECTED|sample_tree|{music}\Drum Kit\snare_b.wav"
    And I wait 700 milliseconds
    And I send the widget event "PADGRID_CLICKED|rack_pads_trk-drums|1"
    And I wait 150 milliseconds
    And I advance 3 frames
    Then I record the analysis "snare-pad" of "trk-drums"

    When I wait 700 milliseconds
    And I send the widget event "TREEVIEW_SELECTED|sample_tree|{music}\Drum Kit\hat_c.wav"
    And I wait 500 milliseconds
    And I send the widget event "PADGRID_CLICKED|rack_pads_trk-drums|2"
    And I wait 50 milliseconds
    And I advance 2 frames
    Then I record the analysis "hat-pad" of "trk-drums"
    And I capture "rack-05-kit-of-samples"

    When I wait 500 milliseconds
    And I send the widget event "TRACKS_SEEK|arrangement|0"
    And I advance 4 frames
    And I start measuring "song-drums" of "trk-drums"
    And I click "transport_toggle"
    And I wait 1000 milliseconds
    Then I record the analysis "song-a" of "trk-drums"
    And I capture "rack-06-playing"

    When I wait 170 milliseconds
    Then I record the analysis "song-b" of "trk-drums"

    When I wait 170 milliseconds
    Then I record the analysis "song-c" of "trk-drums"

    When I wait 1200 milliseconds
    And I record the measurement "song-drums"
    And I click "transport_toggle"
    And I wait 800 milliseconds

    When I send the widget event "PADGRID_ADD|rack_pads_trk-drums"
    And I send the widget event "TREEVIEW_SELECTED|sample_tree|{music}\Album"
    And I send the widget event "TREEVIEW_SELECTED|sample_tree|{music}\Album\whole_song.wav"
    And I wait 300 milliseconds
    And I send the widget event "PADGRID_CLICKED|rack_pads_trk-drums|5"
    And I advance 30 frames
    Then I capture "rack-07-long-file-on-a-new-pad"
