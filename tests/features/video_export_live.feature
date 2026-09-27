Feature: The real video export demo renders its live scene to an MP4

  Scenario: Exporting the orbiting cube writes a 3 second clip without freezing the window
    Given the real video export demo is running in test mode
    When I advance 10 frames
    Then I see the label "Video Export Demo"
    And I see the label "Idle"
    And I capture "export-idle"
    When I click "export_btn"
    And I advance 3 frames
    Then I see the label "Exporting 3s @ 30fps..."
    And I capture "export-running"
    When I advance 110 frames
    Then I see the label "Exported 90 frames to public/video_export_demo.mp4"
    And I do not see the label "Exporting 3s @ 30fps..."
    And I capture "export-done"
