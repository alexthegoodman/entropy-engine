Feature: The real Media Player runs its playlist and transport in a live window

  Scenario: The bundled sample opens with captions and can pause and seek
    Given the real media player is running in test mode
    When I advance 15 frames
    Then I see the label "public/yumondesktop.mp4  (1/4)"
    And I see the label "Entropy Media Player"
    And I capture "media-initial"
    When I click "play_btn"
    And I advance 3 frames
    And I set "seek_slider" to "5000"
    And I advance 3 frames
    Then I see the label "Sample video playback"
    And I capture "media-seek-caption"
    When I click "captions_btn"
    And I advance 3 frames
    Then I do not see the label "Sample video playback"
    When I click "captions_btn"
    And I advance 3 frames
    Then I see the label "Sample video playback"

  Scenario: Speed and volume controls update the running player
    When I set "volume_slider" to "0.35"
    And I set "speed_picker" to "5"
    And I advance 3 frames
    And I capture "media-controls"

  Scenario: Playlist navigation opens another real MP4 and returns to the first
    When I click "next_btn"
    And I advance 12 frames
    Then I see the label "public/grok-imagine-video.mp4  (2/4)"
    And I capture "media-next"
    When I wait 500 milliseconds
    And I capture "media-speed-clock"
    When I click "previous_btn"
    And I advance 12 frames
    Then I see the label "public/yumondesktop.mp4  (1/4)"
    And I capture "media-previous"
    When I set "playlist_picker" to "2"
    And I advance 12 frames
    Then I see the label "public/replicate-prediction-video.mp4  (3/4)"
    And I capture "media-picked"
    When I set "playlist_picker" to "0"
    And I advance 12 frames
    Then I see the label "public/yumondesktop.mp4  (1/4)"

  Scenario: Fullscreen changes the real OS window and can be exited
    When I click "fullscreen_btn"
    And I advance 6 frames
    And I capture "media-fullscreen"
    When I click "fullscreen_btn"
    And I advance 6 frames
    And I capture "media-windowed"

  Scenario: An entered MP4 can be added and removed without losing playback
    When I set "media_path" to "./public/yumondesktop.mp4"
    And I advance 2 frames
    And I click "add_media_btn"
    And I advance 12 frames
    Then I see the label "./public/yumondesktop.mp4  (5/5)"
    And I capture "media-added"
    When I click "remove_btn"
    And I advance 12 frames
    Then I see the label "public/video_export_demo.mp4  (4/4)"
    And I capture "media-removed"
