Feature: Guitar input playing the DAW's instruments, on the real audio output
  A synthetic guitar recording is fed to a real GuitarSession through the same pipeline function the
  input device's callback calls, in 128 sample buffers at real-time pace. The notes it finds are
  played by the built-in voice on a track of the real AudioEngine, out of the real output device, and
  the tests read the sound back from that track's tap and measure its pitch.

  What this does NOT cover: the physical capture device and its driver. Those are checked by hand
  with a guitar plugged in (see the "Live checks" section of GUITAR_TO_MIDI.md).

  Background:
    Given the real audio engine with a track "lead"
    And a guitar session fed from a recording

  Scenario Outline: A picked note sounds at the right pitch
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to <note> is picked at -14 dBFS
    And the string is muted after 0.9 seconds
    When the recording is played up to 0.7 seconds
    Then "lead" is sounding at <note> within 12 cents
    When the recording is played to the end
    Then "lead" is silent

    Examples:
      | note |
      | E2   |
      | A2   |
      | D3   |
      | E4   |
      | E5   |

  Scenario: A bend of the string bends the sound
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to A3 is picked at -14 dBFS
    And its pitch is bent up 200 cents over 300 ms after 0.3 seconds
    When the recording is played up to 1.3 seconds
    Then "lead" is sounding at 246.9 Hz within 15 cents

  Scenario: Vibrato is heard as vibrato and not as separate notes
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to A3 is picked at -14 dBFS
    And its pitch has vibrato of 50 cents at 6 Hz after 0.3 seconds
    When the recording is played up to 1.5 seconds
    And the recording is played to the end
    Then the guitar found exactly 1 note
    And the router delivered every event the engine emitted

  Scenario: Stopping the session silences a note that is still ringing
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to A3 is picked at -14 dBFS
    When the recording is played up to 0.7 seconds
    And the session is stopped
    Then "lead" is silent

  Scenario: Losing the input device mid-note releases the note
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to A3 is picked at -14 dBFS
    When the recording is played up to 0.7 seconds
    And the input device is lost
    Then "lead" is silent
    And the diagnostics report the device as lost

  Scenario: A take is recorded with pick times compensated for detection latency
    Given the guitar plays the "sine" voice on "lead"
    And recording is armed
    # Each string is damped before the next is picked, as a player does. The engine is monophonic.
    And a string tuned to E3 is picked at -14 dBFS at 0.5 seconds
    And the string is muted after 0.6 seconds
    And a string tuned to A3 is picked at -14 dBFS at 1.5 seconds
    And the string is muted after 0.5 seconds
    And a string tuned to D4 is picked at -14 dBFS at 2.5 seconds
    And its pitch has vibrato of 40 cents at 6 Hz after 0.2 seconds
    And the string is muted after 0.7 seconds
    When the recording is played to the end
    Then the take holds these notes: "E3 A3 D4"
    And each recorded note starts within 8 ms of its pick
    And the D4 note carries bend data

  Scenario: Changing the responsiveness mode while playing takes effect
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to E4 is picked at -14 dBFS
    And the mode is changed to "accurate" while playing
    When the recording is played to the end
    Then the guitar found exactly 1 note
    And the last note came at least 11 ms after its pick

  Scenario: The audio thread keeps well inside its time budget
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to E2 is picked at -14 dBFS
    And a string tuned to A3 is picked at -14 dBFS at 1.0 seconds
    When the recording is played to the end
    Then no callback ran longer than the audio it covered
    And no note event was dropped

  Scenario Outline: The guitar plays a hosted VST3 instrument
    Given a track "synth" hosting the "<plugin>" plugin
    And the guitar plays "synth" on MIDI channel 1
    And a string tuned to A3 is picked at -14 dBFS
    When the recording is played up to 0.8 seconds
    Then "synth" is audible
    And "synth" is sounding at A3 within 30 cents

    Examples:
      | plugin |
      | Vital  |
      | Massive |

  Scenario: A bend of the string reaches a hosted VST3 instrument as pitch bend
    Given a track "synth" hosting the "Vital" plugin
    And the guitar plays "synth" on MIDI channel 1
    And a string tuned to A3 is picked at -14 dBFS
    And its pitch is bent up 200 cents over 300 ms after 0.4 seconds
    When the recording is played up to 1.4 seconds
    Then "synth" is sounding at 246.9 Hz within 40 cents

  Scenario: How long from a pick to sound in the track
    Given the guitar plays the "sine" voice on "lead"
    When 8 picks of E4 are played in real time
    Then the sound reaches the track within 90 ms of the pick at the median

  # A gate below the room's noise floor never lets a decayed note end. Calibration fixes that.
  Scenario: In a loud room a decayed note hangs on until the gate is calibrated
    Given the guitar plays the "sine" voice on "lead"
    And 6 seconds of room noise: hum at -38 dBFS and hiss at -44 dBFS
    And a string tuned to A3 is picked at -14 dBFS at 2 seconds
    And the string decays with a time constant of 0.5 seconds
    When the recording is played to the end
    Then the guitar found exactly 1 note
    And a note is still held

  Scenario: In a loud room a decayed note ends once the gate is calibrated
    Given the guitar plays the "sine" voice on "lead"
    And 6 seconds of room noise: hum at -38 dBFS and hiss at -44 dBFS
    And a string tuned to A3 is picked at -14 dBFS at 2 seconds
    And the string decays with a time constant of 0.5 seconds
    When calibration listens to the room for 1 seconds
    And the calibration is applied
    And the recording is played to the end
    Then the guitar found exactly 1 note
    And no note is held
    And the gate sits above -38 dBFS

  Scenario: Calibrating on soft and hard notes sets the velocity range
    Given the guitar plays the "sine" voice on "lead"
    And a string tuned to E3 is picked at -34 dBFS at 0.3 seconds
    And the string is muted after 0.5 seconds
    And a string tuned to A3 is picked at -22 dBFS at 1.3 seconds
    And the string is muted after 0.5 seconds
    And a string tuned to D4 is picked at -8 dBFS at 2.3 seconds
    And the string is muted after 0.5 seconds
    When calibration listens to playing for 3.2 seconds
    And the calibration is applied
    Then the velocity range runs from below -35 dBFS to above -18 dBFS
