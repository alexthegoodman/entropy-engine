Feature: A track's reverb and EQ are one 3D picture you can play with

  Each scenario drives the real entropy_gui::ReverbEqView through a headless context, one frame at
  a time. Pointer input is built the way the window backend builds it (a hover frame, a press
  frame, held frames, a release frame). Gestures are aimed at the widget's own node positions and
  plot mapping, not at guessed pixels. What is drawn is rasterized on the CPU, so the look
  assertions are facts about pixels. Pictures land in test-artifacts/reverb-eq-view/.

  # ---------------------------------------------------------------- looking

  Scenario: The room, its reflections and the reverb's tail are drawn
    Given a reverb of 18 m, 2.4 s, damping 0.4 and mix 0.5
    And band 3 is a bell at 400 Hz with +6 dB
    When a frame is drawn
    Then the space is not blank
    And the EQ plot is not blank
    And there is neon violet in the space
    And I save the picture "decay"

  Scenario: The EQ runs the whole way down the tail
    Given a reverb of 14 m, 3 s, damping 0.2 and mix 0.8
    And band 4 is a bell at 2500 Hz with -18 dB and Q 0.6
    When a frame is drawn
    Then I save the picture "decay-notched"

  Scenario: With the mix at zero the tail is still shown, as a ghost
    Given a reverb of 22 m, 4 s, damping 0.6 and mix 0
    When a frame is drawn
    Then the space is not blank
    And I save the picture "decay-ghost"

  Scenario: The live view shows what the track is playing
    Given a reverb of 12 m, 1.5 s, damping 0.5 and mix 0.3
    And the track is playing a tone at 440 Hz
    And the view is "live"
    When 45 frames are drawn
    Then the space is not blank
    And I save the picture "live"

  # ---------------------------------------------------------------- playing

  Scenario: Dragging a bell's node moves its frequency and gain
    Given a reverb of 18 m, 2 s, damping 0.5 and mix 0.3
    When I drag band 3's node to 1000 Hz and +9 dB
    Then band 3 was changed to about 1000 Hz and +9 dB
    And band 3 was selected
    And the last event is EditEnded
    And I save the picture "dragged"

  Scenario: A cut's node only moves sideways
    Given band 1 is on
    When I drag band 1's node to 200 Hz and +12 dB
    Then band 1 was changed to about 200 Hz and +0 dB

  Scenario: Right-clicking a node switches it off and on
    When I right-click band 5's node
    Then band 5 was switched off
    And the last event is EditEnded

  Scenario: The wheel over a node widens or narrows it
    When I turn the wheel by 100 over band 4's node
    Then band 4's Q went up

  Scenario: A chip selects its band without aiming at the node
    When I click chip 6
    Then band 6 was selected

  Scenario: The view buttons switch between the decay and what is playing
    When I click the "Live" button
    Then the view "live" was chosen

  Scenario: Dragging the space orbits the camera
    When I drag across the space
    Then the camera turned
    And no band was changed
