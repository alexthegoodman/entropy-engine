Feature: Guitar to MIDI, replayed offline
  A recording goes through the same engine the live input uses, in 128 sample buffers at 48 kHz.
  The strings are synthetic (src/guitar/testsig.rs generates them), so
  every pitch, pick time and mute is known exactly. That proves the engine does what it claims on
  signals it can be checked against. It says nothing about a real guitar; that is what the live
  session with an actual instrument is for.

  Background:
    Given the default settings

  Scenario Outline: A picked note becomes one Note On at the right pitch
    Given a string tuned to <note> is picked at -14 dBFS
    When the recording is replayed
    Then exactly 1 Note On is emitted
    And the first Note On is for <note>
    And the first Note On comes within <ms> ms of the pick
    And the event stream is well formed

    # Bounds are the measured Balanced-mode worst case for the register plus a small margin, not the
    # spec's starting targets. See GUITAR_TO_MIDI.md section 5.1 for where they differ.
    Examples:
      | note | ms |
      | E2   | 36 |
      | A2   | 28 |
      | D3   | 22 |
      | G3   | 18 |
      | B3   | 16 |
      | E4   | 12 |
      | E5   | 12 |
      | E6   | 12 |

  Scenario: A note that starts in the very first samples of the stream is still a pick
    Given a string tuned to E4 is picked at -14 dBFS at 0 seconds
    When the recording is replayed
    Then exactly 1 Note On is emitted
    And the first Note On is for E4

  Scenario: A note held while it decays naturally is one Note On and one Note Off
    Given a string tuned to A2 is picked at -14 dBFS
    And the string decays with a time constant of 0.7 seconds
    When the recording is replayed for 6 seconds
    Then exactly 1 Note On is emitted
    And exactly 1 Note Off is emitted
    And the Note Off comes before the recording ends
    And the event stream is well formed

  Scenario: Muting the string releases the note promptly
    Given a string tuned to D3 is picked at -14 dBFS
    And the string is muted after 0.8 seconds
    When the recording is replayed for 2 seconds
    Then exactly 1 Note Off is emitted
    And the Note Off comes within 90 ms of the mute

  Scenario: Picking the same note again is a new Off and On pair
    Given a string tuned to G3 is picked at -14 dBFS
    And the string decays with a time constant of 0.3 seconds
    And a string tuned to G3 is picked at -14 dBFS at 0.7 seconds
    When the recording is replayed for 1.6 seconds
    Then the notes played are "G3 G3"
    And exactly 1 Note Off is emitted before the last Note On
    And the event stream is well formed

  # A known limit, written down as a scenario so it cannot change unnoticed. An onset is a rise of about
  # 6 dB over the level just before it; a second pick that adds less than that to a string still
  # ringing at nearly the same level is not heard as a pick. Phase 2 (legato) is where this is revisited.
  Scenario: A re-pick only slightly louder than the ringing string is not heard
    Given a string tuned to G3 is picked at -14 dBFS
    And a string tuned to G3 is picked at -14 dBFS at 0.7 seconds
    When the recording is replayed for 1.6 seconds
    Then the notes played are "G3"

  Scenario Outline: Quick repeated notes are told apart
    Given <count> notes picked <gap> ms apart: "<notes>"
    When the recording is replayed
    Then the notes played are "<notes>"
    And the event stream is well formed

    Examples: Balanced, 100 ms apart, mid and high strings
      | count | gap | notes                     |
      | 8     | 100 | E4 G4 B3 D4 E4 G3 B3 D4   |

  Scenario: Fast mode keeps up with notes 75 ms apart
    Given the fast mode
    And 8 notes picked 75 ms apart: "E4 G4 B4 D5 E4 G4 B4 D5"
    When the recording is replayed
    Then the notes played are "E4 G4 B4 D5 E4 G4 B4 D5"

  Scenario: Vibrato moves the bend and never the note
    Given a string tuned to A3 is picked at -14 dBFS
    And its pitch has vibrato of 50 cents at 6 Hz after 0.3 seconds
    When the recording is replayed for 2.5 seconds
    Then exactly 1 Note On is emitted
    And the bend follows the pitch within 10 cents at the median
    And no more than 200 bend messages per second are sent

  Scenario: A whole tone bend rises smoothly and settles
    Given the pitch bend range is 2 semitones
    And a string tuned to A3 is picked at -14 dBFS
    And its pitch is bent up 200 cents over 400 ms after 0.3 seconds
    When the recording is replayed for 2 seconds
    Then exactly 1 Note On is emitted
    And the bend values never fall while the string rises
    And the last bend is within 10 cents of 200 cents

  Scenario: A wider bend range reads the same bend as a smaller value
    Given the pitch bend range is 12 semitones
    And a string tuned to A3 is picked at -14 dBFS
    And its pitch is bent up 200 cents over 400 ms after 0.3 seconds
    When the recording is replayed for 2 seconds
    Then exactly 1 Note On is emitted
    And the last bend is within 10 cents of 200 cents

  Scenario: A slide past the bend range starts a new note with the bend centered first
    Given a string tuned to A2 is picked at -14 dBFS
    And it slides up 5 semitones over 300 ms after 0.4 seconds
    When the recording is replayed for 2 seconds
    Then the first Note On is for A2
    And the bend is centered before the second Note On
    And the pitch sounding at the end is D3 within 20 cents
    And the event stream is well formed

  Scenario: Room noise and handling noise play no notes
    Given 60 seconds of room noise: hum at -52 dBFS and hiss at -60 dBFS
    And 20 handling thumps at -22 dBFS
    When the recording is replayed
    Then no note is emitted

  # The engine never plays a note from noise, calibrated or not (noise has no stable pitch). What a gate
  # below the room's noise floor does is leave a decayed note hanging: the level never falls under the
  # close threshold, so the release never starts. Calibration puts the gate above the room.
  Scenario: In a loud room a decayed note hangs on until the gate is calibrated
    Given 6 seconds of room noise: hum at -38 dBFS and hiss at -44 dBFS
    And a string tuned to A3 is picked at -14 dBFS at 2 seconds
    And the string decays with a time constant of 0.5 seconds
    When the recording is replayed
    Then exactly 1 Note On is emitted
    And the only Note Off is the stop at the end

  Scenario: In a loud room a decayed note ends once the gate is calibrated
    Given 6 seconds of room noise: hum at -38 dBFS and hiss at -44 dBFS
    And a string tuned to A3 is picked at -14 dBFS at 2 seconds
    And the string decays with a time constant of 0.5 seconds
    When the gate is calibrated on 2 seconds of that room
    And the recording is replayed
    Then exactly 1 Note On is emitted
    And the Note Off comes before the recording ends

  Scenario: Stopping releases a sounding note and centers the bend
    Given a string tuned to A3 is picked at -14 dBFS
    And its pitch is bent up 120 cents over 300 ms after 0.3 seconds
    When the engine is stopped 1.2 seconds in
    Then exactly 1 Note On is emitted
    And exactly 1 Note Off is emitted
    And the event stream is well formed

  Scenario Outline: Harder picks are louder
    Given a string tuned to A3 is picked at <level> dBFS
    When the recording is replayed
    Then the first Note On has a velocity of at least <min> and at most <max>

    Examples:
      | level | min | max |
      | -34   | 1   | 45  |
      | -25   | 40  | 100 |
      | -10   | 100 | 127 |

  Scenario: A very soft pick is under the default gate and plays nothing
    Given a string tuned to A3 is picked at -44 dBFS
    When the recording is replayed
    Then no note is emitted

  Scenario Outline: A wrong octave is not reported when the fundamental is weak
    Given a string tuned to <note> is picked at -14 dBFS
    And its fundamental is weak and its odd partials are weaker
    When the recording is replayed
    Then the first Note On is for <note>

    Examples:
      | note |
      | E2   |
      | A2   |
      | D3   |
      | B3   |

  Scenario Outline: A low string with a weak fundamental is not re-triggered by its own ripple
    Given a string tuned to <note> is picked at -14 dBFS
    And its fundamental is only 0.3 of normal
    And its partials start at phase seed <seed>
    When the recording is replayed for 2 seconds
    Then exactly 1 Note On is emitted
    And the first Note On is for <note>

    # Over a window shorter than one period the level of such a string swings by more than an onset,
    # so a level measured over 8 ms saw a new pick every few cycles. The window is 15 ms. Which
    # phases trigger it depends on how the partials line up, hence the seeds.
    Examples:
      | note | seed |
      | E2   | 2    |
      | F2   | 2    |
      | A2   | 1    |

  Scenario: A fret hand slap while a note rings does not play it again
    Given a string tuned to E4 is picked at -14 dBFS
    And a 15 ms slap at -4 dBFS at 0.6 seconds
    When the recording is replayed for 1.5 seconds
    Then exactly 1 Note On is emitted
    And exactly 1 Note Off is emitted

  Scenario: A pitched note in a noisy room is still found
    Given 5 seconds of room noise: hum at -52 dBFS and hiss at -60 dBFS
    And a string tuned to E4 is picked at -14 dBFS at 2 seconds
    And 3 handling thumps at -20 dBFS
    When the recording is replayed
    Then the first Note On is for E4
