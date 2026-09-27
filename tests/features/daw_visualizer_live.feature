Feature: The running DAW hides its analyzer and turns a song into a music video

  The real compiled DAW is launched against a clean data folder. The Analyzer can be put away and
  brought back from the transport bar; the Music Video window previews every visualizer style live
  while the song plays, and exports the song to an MP4 with its audio. The export's save dialog is
  answered by ENTROPY_MUSIC_VIDEO_OUTPUT; tests/daw_visualizer_live.rs checks the file it writes.

  Scenario: Hide and show the analyzer
    Given the real DAW is running in test mode
    When I advance 40 frames
    Then I capture "visualizer-01-analyzer-shown"
    When I click "toggle_analyzer"
    And I advance 10 frames
    Then I capture "visualizer-02-analyzer-hidden"
    When I click "toggle_analyzer"
    And I advance 10 frames
    Then I capture "visualizer-03-analyzer-back"

  Scenario: Every style moves with the song
    When I click "toggle_analyzer"
    And I click "toggle_visualizer"
    And I advance 10 frames
    And I set "music_video_title" to "Starter Song"
    And I set "music_video_artist" to "Entropy DAW"
    And I click "transport_toggle"
    And I wait 1500 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-04-bars"
    When I set "music_video_style" to "1"
    And I wait 700 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-05-radial"
    When I set "music_video_style" to "2"
    And I wait 700 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-06-wave"
    When I set "music_video_style" to "3"
    And I wait 700 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-07-starfield"
    When I set "music_video_style" to "4"
    And I wait 700 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-08-rings"
    When I set "music_video_style" to "5"
    And I set "music_video_theme" to "1"
    And I wait 700 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-09-horizon-synthwave"
    When I click "transport_toggle"
    And I advance 5 frames

  Scenario: Export the song to an MP4 with its audio
    When I set "arr_bars" to "4"
    And I set "music_video_size" to "4"
    And I set "music_video_style" to "1"
    And I advance 5 frames
    And I click "music_video_export"
    And I wait 1500 milliseconds
    And I advance 3 frames
    Then I capture "visualizer-10-exporting"
    When I wait 25000 milliseconds
    And I advance 5 frames
    Then I capture "visualizer-11-exported"
