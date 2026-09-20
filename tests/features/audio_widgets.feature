Feature: The analyzer widgets draw what the signal actually is

  Each scenario drives the real widget through a headless entropy_gui context, frame by frame at
  60 fps, hands it synthesized signals, and reads the result back off the pixels: the draw list
  is rasterized on the CPU (shapes and glyph-atlas text, 2x supersampled), so nothing here needs
  a window or a GPU. Pictures are saved to test-artifacts/audio-widgets/.

  Scenario Outline: The spectrum draws a tone at its own frequency on a logarithmic axis
    Given a spectrum view 720 px wide
    When I show a <hz> Hz sine at -6 dBFS for 40 frames
    Then the tallest part of the curve is at <hz> Hz within 2 px
    And the curve peaks at -6 dBFS within 1 dB
    And I save the picture "spectrum-<hz>hz"

    Examples:
      | hz   |
      | 60   |
      | 440  |
      | 1000 |
      | 9000 |

  Scenario: Both ends of the axis are drawn at once
    Given a spectrum view 720 px wide
    When I show a 60 Hz sine and a 9000 Hz sine at -12 dBFS for 40 frames
    Then the curve has two separate peaks, at 60 Hz and at 9000 Hz, each within 3 px
    And I save the picture "spectrum-two-tones"

  Scenario: A level rises quickly, falls slowly, and leaves a peak marker behind
    Given a spectrum view 720 px wide
    When I show a 1000 Hz sine at -6 dBFS for 40 frames
    And I show silence for 6 frames
    Then the curve at 1000 Hz has fallen but is still above -40 dBFS
    And the peak marker at 1000 Hz is still at -6 dBFS within 4 dB
    And I save the picture "spectrum-release"

  Scenario: The peak marker falls once its hold time is over
    Given a spectrum view 720 px wide
    When I show a 1000 Hz sine at -6 dBFS for 40 frames
    And I show silence for 240 frames
    Then the peak marker at 1000 Hz is below -30 dBFS

  Scenario: Hovering reports the frequency, level and note under the pointer
    Given a spectrum view 720 px wide
    When I show a 440 Hz sine at -6 dBFS for 40 frames
    And I hover the pointer over 440 Hz
    Then the readout is within 1 percent of 440 Hz
    And the readout level is within 5 dB of -6 dBFS
    And the note under 440 Hz is "A4"
    And I save the picture "spectrum-hover"

  Scenario: The bar style groups the axis into thirds of an octave
    Given a spectrum view 720 px wide in bar style
    When I show a 1000 Hz sine at -6 dBFS for 40 frames
    Then exactly 1 of the 30 bars is tall
    And I save the picture "spectrum-bars"

  Scenario: A steady tone holds perfectly still on a triggered scope
    Given a scope 720 px wide with the trigger on
    When I show a 440 Hz sine at 12 different starting phases
    Then the trace has stayed within 0.75 px from frame to frame
    And the scope reports that it is triggered
    And I save the picture "scope-triggered"

  Scenario: Without the trigger the same tone crawls
    Given a scope 720 px wide with the trigger off
    When I show a 440 Hz sine at 12 different starting phases
    Then the trace has moved by more than 5 px between frames

  Scenario: A stereo scope draws identical channels as one trace in the source colour
    Given a scope 720 px wide in stereo mode with the trigger on
    When I show a 440 Hz sine at 3 different starting phases
    Then the trace is drawn in the accent colour and not the second channel colour

  Scenario: A stereo scope draws two traces when the channels differ
    Given a scope 720 px wide in stereo mode with the trigger on
    When I show a 440 Hz sine on the left and a 660 Hz sine on the right
    Then both channel colours are on screen
    And I save the picture "scope-stereo"

  Scenario: The scope reads the pitch of what it is showing
    Given a scope 720 px wide with the trigger on
    When I show a 441 Hz sine at 3 different starting phases
    Then the scope reports a frequency within 1.5 Hz of 441

  Scenario: The scope free-runs when nothing crosses the trigger level
    Given a scope 720 px wide with the trigger on
    When I show silence for 3 frames
    Then the scope reports that it is free-running

  Scenario: A wide window keeps a one-sample spike
    Given a scope 720 px wide with the trigger off and a window of 16384 frames
    When I show a click that is a single sample wide
    Then the spike is drawn at full height

  Scenario: A mono signal is a vertical line on the goniometer
    Given a goniometer 400 px wide
    When I show a 300 Hz sine identically in both channels
    Then every drawn point lies within 3 px of the vertical axis
    And the reported correlation is +1 within 0.02
    And I save the picture "goniometer-mono"

  Scenario: An out-of-phase signal is a horizontal line
    Given a goniometer 400 px wide
    When I show a 300 Hz sine with the right channel inverted
    Then every drawn point lies within 3 px of the horizontal axis
    And the reported correlation is -1 within 0.02

  Scenario: A left-only signal lies on the left diagonal
    Given a goniometer 400 px wide
    When I show a 300 Hz sine in the left channel only
    Then every drawn point lies within 3 px of the left diagonal
    And I save the picture "goniometer-left"

  Scenario: Reverb-like decorrelated channels fill the figure
    Given a goniometer 400 px wide
    When I show a 300 Hz sine in the left channel and a 470 Hz sine in the right
    Then the figure is wider than 40 px and taller than 40 px
    And the reported correlation is 0 within 0.2
    And I save the picture "goniometer-wide"

  Scenario: The meter fills to the peak level
    Given a level meter
    When the meter is told the left peak is -6 dBFS and the right peak is -18 dBFS for 60 frames
    Then the left bar reaches -6 dBFS within 2 px
    And the right bar reaches -18 dBFS within 2 px
    And I save the picture "meter-levels"

  Scenario: The meter falls at a fixed rate and holds a tick where the peak was
    Given a level meter
    When the meter is told the left peak is -6 dBFS for 60 frames
    And the meter is told silence for 30 frames
    Then the left bar has fallen below -14 dBFS
    And the left peak tick is still at -6 dBFS within 2 px

  Scenario: A clip is latched until the meter is clicked
    Given a level meter
    When the meter is told the left peak is 0 dBFS for 1 frame
    And the meter is told silence for 90 frames
    Then the left channel is latched as clipped
    And the right channel is not
    When I click the meter
    Then no channel is latched as clipped
    And I save the picture "meter-clip-cleared"
