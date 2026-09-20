Feature: The pad grid and the scrolling tree behave and look like what they are

  Each scenario drives the real widgets through a headless entropy_gui context, one frame at a time.
  Pointer input is built exactly as the window backend builds it (a hover frame, a press frame, a
  release frame), events are read back from the widget, and what is drawn is rasterized on the CPU
  (shapes and glyph-atlas text, 2x supersampled) so the assertions look at pixels. Pictures land in
  test-artifacts/pad-grid/.

  Scenario: Pads lay out in a grid, row by row, with the add tile after the last one
    Given a pad grid of 6 pads in 4 columns of 128 by 84 pixels with an add tile
    When a frame is drawn
    Then pad 2 is 136 pixels right of pad 1
    And pad 5 is directly below pad 1 by 92 pixels
    And pad 6 is 136 pixels right of pad 5
    And the add tile is 136 pixels right of pad 6
    And I save the picture "pad-grid-layout"

  Scenario: Clicking a pad selects it, right-clicking clears it, the add tile asks for another
    Given a pad grid of 3 pads in 4 columns of 128 by 84 pixels with an add tile
    When I click pad 2
    Then the events are "Clicked(pad-2)"
    When I right-click pad 3
    Then the events are "Cleared(pad-3)"
    When I click the add tile
    Then the events are "AddRequested"
    When I click between pad 1 and pad 2
    Then there are no events

  Scenario: A sample pad draws its waveform and dims the part outside the trim
    Given a pad grid with one blue sample pad whose waveform is full height and trim is 0.5 to 1
    When a frame is drawn
    Then the waveform is brighter in the played half than in the trimmed-off half
    And the trim edge is marked in white
    And I save the picture "pad-trim"

  Scenario: An untrimmed sample pad has no trim marks
    Given a pad grid with one blue sample pad whose waveform is full height and trim is 0 to 1
    When a frame is drawn
    Then the waveform is equally bright on both halves
    And no trim edge is marked

  Scenario: A missing sample is drawn red whatever the pad's own colour
    Given a pad grid with one blue sample pad whose waveform is full height and trim is 0 to 1
    And the pad's file is missing
    When a frame is drawn
    Then the pad's accent strip is red
    And I save the picture "pad-missing"

  Scenario: A pad's accent strip takes its own colour
    Given a pad grid with one blue sample pad whose waveform is full height and trim is 0 to 1
    When a frame is drawn
    Then the pad's accent strip is blue

  Scenario: A selected pad has a ring in its colour and an unselected one does not
    Given a pad grid with one blue sample pad whose waveform is full height and trim is 0 to 1
    When a frame is drawn
    Then the pad's left edge is not blue
    When the pad is selected
    And a frame is drawn
    Then the pad's left edge is blue
    And I save the picture "pad-selected"

  Scenario: A hit lights the pad up
    Given a pad grid with one blue sample pad whose waveform is full height and trim is 0 to 1
    When a frame is drawn
    And I remember how bright the pad is
    And the pad glows at full strength
    And a frame is drawn
    Then the pad is brighter than it was
    And I save the picture "pad-glow"

  Scenario: The three kinds of pad are told apart
    Given a pad grid with a synth pad, an empty pad, a sample pad and a missing pad
    When a frame is drawn
    Then the four pads are drawn differently from one another
    And I save the picture "pad-kinds"

  Scenario: A tree capped at a height scrolls inside it instead of growing
    Given a tree of 40 rows capped at 200 pixels
    When a frame is drawn
    Then the tree is 200 pixels tall
    When I click the top row of the tree
    Then the events are "Selected(r0)"
    When I turn the wheel by 66 pixels over the tree
    And I click the top row of the tree
    Then the events are "Selected(r3)"

  Scenario: A short tree capped at a large height is only as tall as its rows
    Given a tree of 3 rows capped at 200 pixels
    When a frame is drawn
    Then the tree is 66 pixels tall

  Scenario: The wheel over a scrolling tree scrolls the tree and not the page around it
    Given a page that scrolls, holding a tree of 40 rows capped at 200 pixels
    When a frame is drawn
    And a frame is drawn
    And I turn the wheel by 66 pixels over the tree
    And I turn the wheel by 66 pixels over the tree
    Then the page has not moved
    And the tree has scrolled

  Scenario: The wheel beside the tree still scrolls the page
    Given a page that scrolls, holding a tree of 40 rows capped at 200 pixels
    When a frame is drawn
    And a frame is drawn
    And I turn the wheel by 66 pixels over the page below the tree
    Then the page has moved

  Scenario: A tree row shows its icon and its detail text
    Given a tree of 3 rows with icons and details
    When a frame is drawn
    Then the tree has lit pixels at both ends of its rows
    And I save the picture "tree-icon-detail"
