Feature: A wavetable is terrain you sculpt with a mouse or a pen

  Each scenario drives the real entropy_gui::WavetableView through a headless context, one frame
  at a time, against a real audio::wavetable::Wavetable. Pointer input is built the way the window
  backend builds it (a hover frame, a press frame, held frames, a release frame; a pen adds
  pressure, tilt, the side button and the eraser end). Where a gesture is aimed at a cell of the
  table, the widget's own projector says which pixel that is. What is drawn is rasterized on the
  CPU, so the look assertions are facts about pixels. Pictures land in test-artifacts/wavetable-view/.

  # ---------------------------------------------------------------- looking

  Scenario: The terrain draws every frame as a ridge, teal at the front to pink at the back
    Given a wavetable of 32 "sine" frames
    And frame 16 is selected
    When a frame is drawn
    Then the terrain is not blank
    And the ridge of frame 0 is teal at its crest
    And the ridge of frame 31 is pink at its crest
    And I save the picture "terrain-sine"

  Scenario: A ridge hides what is behind it, like a solid
    Given a wavetable of 32 "sine" frames
    And frame 0 has a tall hump at phase 0.5
    When a frame is drawn
    Then I save the picture "terrain-hump"
    And the pixels under the crest of frame 0 at phase 0.5 show no ridge from behind it
    And the same pixels away from the hump do show ridges

  Scenario: The selected frame stands out from its neighbours
    Given a wavetable of 32 "vowels" frames
    And frame 12 is selected
    When a frame is drawn
    Then I save the picture "terrain-vowels-selected"
    And the ridge of frame 12 is brighter than the ridge of frame 11 where each dips lowest

  Scenario: A sounding note lights the ridge it is reading
    Given a wavetable of 32 "saw" frames
    And a note is sounding at position 0.5
    When a frame is drawn
    Then there is amber near the crest of the ridge at position 0.5
    And I save the picture "terrain-live"
    When the note ends
    And a frame is drawn
    Then there is no amber near the crest of the ridge at position 0.5

  Scenario: The cycle strip and the harmonics show the selected frame
    Given a wavetable of 32 "saw" frames
    And frame 31 is selected
    When a frame is drawn
    Then the strongest harmonic bar is the first
    And the cycle strip shows a wave that crosses zero
    And I save the picture "cycle-and-harmonics"

  # ---------------------------------------------------------------- mouse

  Scenario: A mouse stroke raises the terrain under the pointer and nowhere else
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And I take a snapshot of the table
    When I press on frame 12 phase 0.1
    And I hold for 20 frames
    And I release
    Then the height at frame 12 phase 0.1 has risen by at least 0.25
    And only frames 6 to 18 have changed
    And the events are "StrokeBegan,FrameSelected(12),StrokeEnded,Edited"
    And I save the picture "terrain-raised"

  Scenario: Lower digs and Smooth takes the top off a spike
    Given a wavetable of 32 "sine" frames
    And the tool is "lower"
    When I press on frame 16 phase 0.1
    And I hold for 20 frames
    And I release
    Then the height at frame 16 phase 0.1 has fallen by at least 0.25
    Given a wavetable of 32 "sine" frames
    And frame 16 has a narrow spike at phase 0.5
    And the tool is "smooth"
    And I remember the height at frame 16 phase 0.5 as "spike"
    When I press on frame 16 phase 0.5
    And I hold for 40 frames
    And I release
    Then the height at frame 16 phase 0.5 has fallen by at least 0.1 since "spike"

  Scenario: Level pulls what it touches toward the height where the stroke began
    Given a wavetable of 32 "sine" frames
    And the tool is "level"
    And the brush strength is 1.0
    And I take a snapshot of the table
    When I press on frame 16 phase 0.1
    And I drag to frame 16 phase 0.25 over 40 frames
    And I release
    Then the height at frame 16 phase 0.25 has fallen by at least 0.12

  Scenario: Shift turns Raise into Lower for a mouse
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And shift is held
    When I press on frame 16 phase 0.1
    And I hold for 20 frames
    And I release
    Then the height at frame 16 phase 0.1 has fallen by at least 0.25

  Scenario: Dragging paints a ridge along the path
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And the brush radius is 0.14
    When I press on frame 8 phase 0.55
    And I drag to frame 22 phase 0.55 over 40 frames
    And I release
    Then the height at frame 15 phase 0.55 has risen by at least 0.1

  Scenario: One stroke is one undo step
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And I take a snapshot of the table
    When I press on frame 12 phase 0.1
    And I drag to frame 14 phase 0.2 over 10 frames
    And I release
    Then the table has changed
    When I click the "Undo" button
    Then the table is as it was in the snapshot
    When I click the "Redo" button
    Then the table has changed

  Scenario: The buttons at the top pick the tool without sculpting
    Given a wavetable of 32 "sine" frames
    And I take a snapshot of the table
    When I click the "Smooth" button
    Then the events are "ToolSelected(smooth)"
    And the table is as it was in the snapshot

  Scenario: The right mouse button orbits and never sculpts
    Given a wavetable of 32 "sine" frames
    And I take a snapshot of the table
    When I press the right button on frame 12 phase 0.5
    And I drag to frame 4 phase 0.9 over 20 frames
    And I release
    Then the camera has turned
    And the table is as it was in the snapshot

  Scenario: The camera cannot be dragged under the floor or over the top
    Given a wavetable of 32 "sine" frames
    When I press the right button on frame 12 phase 0.5
    And I drag the pointer 900 pixels down over 30 frames
    Then the camera pitch is within its limits
    When I drag the pointer 2000 pixels up over 30 frames
    Then the camera pitch is within its limits

  Scenario: The Orbit tool turns the camera with the left button
    Given a wavetable of 32 "sine" frames
    And the tool is "orbit"
    And I take a snapshot of the table
    When I press on frame 12 phase 0.5
    And I drag the pointer 120 pixels right over 15 frames
    And I release
    Then the camera has turned
    And the table is as it was in the snapshot

  Scenario: The wheel zooms
    Given a wavetable of 32 "sine" frames
    When I scroll the wheel up over the terrain
    Then the camera has zoomed in

  Scenario: A press on a frame rail picks the frame
    Given a wavetable of 32 "sine" frames
    When I press the frame rail at the top
    And I release
    Then the events are "FrameSelected(31)"

  # ---------------------------------------------------------------- pen

  Scenario: A pen presses with its own pressure, a mouse with a fixed one
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And a pen pressing at 1.0 pressure
    And I take a snapshot of the table
    When I press on frame 12 phase 0.1
    And I hold for 12 frames
    And I release
    Then I remember how far the height at frame 12 phase 0.1 has risen as "hard"
    Given a wavetable of 32 "sine" frames
    And a pen pressing at 0.25 pressure
    And I take a snapshot of the table
    When I press on frame 12 phase 0.1
    And I hold for 12 frames
    And I release
    Then I remember how far the height at frame 12 phase 0.1 has risen as "soft"
    And "hard" is more than twice "soft"

  Scenario: A pen leaning to the right draws a longer dab along the phase axis
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And a pen pressing at 1.0 pressure leaning 50 degrees right
    And I take a snapshot of the table
    When I press on frame 16 phase 0.1
    And I hold for 12 frames
    Then I save the picture "terrain-pen-tilt"
    When I release
    Then I remember how far the height at frame 16 phase 0.16 has risen as "along"
    And I remember how far the height at frame 18 phase 0.1 has risen as "across"
    And "along" is more than "across"
    Given a wavetable of 32 "sine" frames
    And a pen pressing at 1.0 pressure and standing upright
    And I take a snapshot of the table
    When I press on frame 16 phase 0.1
    And I hold for 12 frames
    Then I save the picture "terrain-pen-upright"
    When I release
    Then I remember how far the height at frame 18 phase 0.1 has risen as "upright across"
    And "upright across" is more than "across"

  Scenario: The eraser end of a pen lowers where the pen tip would raise
    Given a wavetable of 32 "sine" frames
    And the tool is "raise"
    And a pen pressing at 0.8 pressure with its eraser end down
    When I press on frame 16 phase 0.1
    And I hold for 20 frames
    And I release
    Then the height at frame 16 phase 0.1 has fallen by at least 0.15

  Scenario: The pen's side button orbits, so a stylus never needs a keyboard
    Given a wavetable of 32 "sine" frames
    And a pen pressing at 0.8 pressure with its side button held
    And I take a snapshot of the table
    When I press on frame 12 phase 0.5
    And I drag the pointer 100 pixels right over 15 frames
    And I release
    Then the camera has turned
    And the table is as it was in the snapshot

  # ---------------------------------------------------------------- the cycle strip

  Scenario: Dragging across the cycle strip draws the selected frame
    Given a wavetable of 32 "sine" frames
    And frame 9 is selected
    And I take a snapshot of the table
    When I press the cycle strip at phase 0.2 value 0.6
    And I drag the cycle strip to phase 0.6 value -0.6 over 12 frames
    And I release
    Then frame 9 at phase 0.3 reads about 0.3
    And frame 9 at phase 0.4 reads about 0.0
    And frame 9 at phase 0.5 reads about -0.3
    And only frames 9 to 9 have changed
    And the events are "Edited"
    When I click the "Undo" button
    Then the table is as it was in the snapshot
    And I save the picture "cycle-drawn"

  # ---------------------------------------------------------------- the keys

  Scenario: A key plays on press and stops on release, harder toward the bottom of the key
    Given a wavetable of 32 "sine" frames
    When I press key 60 near the top
    Then the events are "KeyDown(60)"
    And the key velocity is below 0.5
    When I release
    Then the events are "KeyDown(60),KeyUp(60)"
    When I clear the events
    And I press key 60 near the bottom
    Then the key velocity is above 0.9
    When I release

  Scenario: Sliding across keys hands the note from one to the next
    Given a wavetable of 32 "sine" frames
    When I press key 60 near the bottom
    And I slide to key 62
    And I release
    Then the events are "KeyDown(60),KeyUp(60),KeyDown(62),KeyUp(62)"

  Scenario: A pen plays a key with its pressure
    Given a wavetable of 32 "sine" frames
    And a pen pressing at 0.4 pressure
    When I press key 64 near the top
    Then the key velocity is between 0.35 and 0.45
    When I release

  Scenario: A held note lights its key
    Given a wavetable of 32 "sine" frames
    And key 60 is held
    When a frame is drawn
    Then key 60 is lit
    And key 62 is not lit
    And I save the picture "keys-held"

  Scenario: A press on the terrain never plays a key and a press on a key never sculpts
    Given a wavetable of 32 "sine" frames
    And I take a snapshot of the table
    When I press key 60 near the bottom
    And I hold for 10 frames
    And I release
    Then the table is as it was in the snapshot
