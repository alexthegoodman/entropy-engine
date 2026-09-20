Feature: The TrackView arrangement widget turns real pointer input into edits

  The widget is driven frame by frame through a headless entropy_gui context, with the same
  pointer state the window backend produces. The timeline is 9 bars of 1000 ms across 900 px,
  so one pixel is 10 ms, and it snaps to a 250 ms beat.

  Background:
    Given a track view with 3 lanes, 9 bars of 1000 ms, snapping to 250 ms
    And lane 1 has a clip "a" from 1000 ms for 2000 ms
    And lane 1 has a clip "b" from 5000 ms for 1000 ms
    And the view has settled

  Scenario: Dragging a clip snaps its start to the beat
    When I drag clip "a" by 880 ms
    Then clip "a" was moved to start at 2000 ms
    And no clip was created

  Scenario: Holding Alt while dragging skips the grid
    When I hold Alt
    And I drag clip "a" by 880 ms
    Then clip "a" was moved to start at 1880 ms

  Scenario: A clip cannot be dragged before the start of the song
    When I drag clip "a" by -5000 ms
    Then clip "a" was moved to start at 0 ms

  Scenario: Trimming the right edge snaps the end
    When I drag the right edge of clip "a" by 880 ms
    Then clip "a" was resized to start at 1000 ms and last 3000 ms

  Scenario: Trimming the left edge snaps the start and keeps the end fixed
    When I drag the left edge of clip "a" by 880 ms
    Then clip "a" was resized to start at 2000 ms and last 1000 ms

  Scenario: A clip cannot be trimmed to nothing
    When I drag the left edge of clip "a" by 5000 ms
    Then clip "a" ends at 3000 ms and lasts at least 20 ms

  Scenario: Dragging on empty lane space draws a snapped clip
    When I drag from 1100 ms to 3100 ms on lane 2
    Then a clip was created on lane 2 from 1000 ms for 2000 ms
    And the lane 2 track was clicked

  Scenario: Drawing right to left makes the same clip
    When I drag from 3100 ms to 1100 ms on lane 2
    Then a clip was created on lane 2 from 1000 ms for 2000 ms

  Scenario: A plain click on an empty lane selects it without drawing
    When I click at 4000 ms on lane 2
    Then the lane 2 track was clicked
    And the background was clicked
    And no clip was created

  Scenario: Pressing a clip selects it and is not a click on the background
    When I click at 1500 ms on lane 1
    Then clip "a" was selected
    And the background was not clicked
    And no clip was created

  Scenario: Clicking or dragging the ruler seeks
    When I click the ruler at 4000 ms
    Then the playhead was sought to 4000 ms
    When I drag along the ruler from 4000 ms to 6000 ms
    Then the playhead was sought to 6000 ms

  Scenario: The mute and solo pills in a lane header are their own controls
    When I click the mute pill of lane 1
    Then lane 1 was muted
    And the lane 1 track was not clicked
    When I click the solo pill of lane 2
    Then lane 2 was soloed

  Scenario: Delete removes the selected clip only while the pointer is over the timeline
    Given clip "a" is selected
    When I press Delete with the pointer elsewhere
    Then no deletion was requested
    When I press Delete with the pointer over the timeline
    Then clip "a" was requested for deletion

  Scenario: The wheel only zooms with Ctrl held, so a surrounding panel can scroll
    When I scroll the wheel over the timeline
    Then the zoom is unchanged
    When I scroll the wheel over the timeline holding Ctrl
    Then the zoom changed

  Scenario: With snapping off a drag is free
    Given snapping is off
    When I drag clip "a" by 880 ms
    Then clip "a" was moved to start at 1880 ms

  Scenario: A tempo change keeps a bar the same width on screen
    When the bars become 500 ms long
    Then the zoom is 5 ms per pixel
    When the bars become 1000 ms long
    Then the zoom is 10 ms per pixel
