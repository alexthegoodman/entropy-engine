Feature: The wavetable voice is in tune, band-limited and does what its settings say

  Every scenario renders real notes through the real `WavetableVoice`, offline: no audio device,
  nothing timed by a clock. The render is analysed with a windowed FFT and the assertions are facts
  about the spectrum (where the strongest partial is, how much energy is not on a harmonic, how
  bright the note is), so a wrong interpolation, a missing band limit or a swapped setting fails a
  number, not a listening test.

  # ---------------------------------------------------------------- pitch

  Scenario Outline: A note is in tune across the keyboard
    Given a wavetable of 32 "saw" frames
    And the note rests at position 1.0
    And a note of <hz> Hz
    When I render the note as "note"
    Then "note" has its strongest partial within 4 cents of <hz> Hz

    Examples:
      | hz     |
      | 65.41  |
      | 110.0  |
      | 261.63 |
      | 659.26 |
      | 1567.98 |
      | 3951.07 |

  # ---------------------------------------------------------------- aliasing

  Scenario Outline: A bright table at a high pitch does not alias
    Given a wavetable of 32 "saw" frames
    And the note rests at position 1.0
    And a note of <hz> Hz
    When I render the note as "note"
    Then the sound in "note" that is not on a harmonic of <hz> Hz is at least 55 dB below the sound that is

    Examples:
      | hz     |
      | 880.0  |
      | 1760.0 |
      | 3520.0 |
      | 7040.0 |

  Scenario: Without a band limit the same note would alias badly
    Given a wavetable of 32 "saw" frames
    And the note rests at position 1.0
    And a note of 3520.0 Hz
    When I render the note as "note" with the band limit ignored
    Then the sound in "note" that is not on a harmonic of 3520.0 Hz is less than 40 dB below the sound that is

  # ---------------------------------------------------------------- what the table contains

  Scenario: The first frame of the saw table is a pure sine
    Given a wavetable of 32 "saw" frames
    And the note rests at position 0.0
    And a note of 440.0 Hz
    When I render the note as "note"
    Then the sound in "note" that is not on a harmonic of 440.0 Hz is at least 70 dB below the sound that is
    And the harmonic 2 of "note" at 440.0 Hz is at least 60 dB below its first

  Scenario: The square table has odd harmonics only, falling as one over the number
    Given a wavetable of 32 "square" frames
    And the note rests at position 1.0
    And a note of 220.0 Hz
    When I render the note as "note"
    Then the harmonic 2 of "note" at 220.0 Hz is at least 35 dB below its first
    And the harmonic 3 of "note" at 220.0 Hz is between 8.0 and 11.0 dB below its first
    And the harmonic 5 of "note" at 220.0 Hz is between 12.5 and 15.5 dB below its first

  Scenario: The saw table gets brighter across its frames
    Given a wavetable of 32 "saw" frames
    And a note of 220.0 Hz
    When I render the note at positions 0.0, 0.25, 0.5, 0.75 and 1.0
    Then each render is brighter than the one before

  # ---------------------------------------------------------------- the settings

  Scenario: A sweep starts bright and settles to the rest position
    Given a wavetable of 32 "saw" frames
    And the note rests at position 0.0
    And the note sweeps 1.0 over 0.25 seconds
    And a note of 220.0 Hz
    When I render the note as "note"
    Then the first 0.1 seconds of "note" are brighter than the last 0.2 seconds

  Scenario: An LFO makes the brightness move and no LFO keeps it still
    Given a wavetable of 32 "saw" frames
    And the note rests at position 0.5
    And a note of 220.0 Hz
    When I render the note as "still"
    And the note has an LFO of 3.0 Hz and depth 1.0
    And I render the note as "moving"
    Then the brightness of "moving" varies at least 5 times more than that of "still"

  Scenario: Unison widens the note and detuning it spreads the peak
    Given a wavetable of 32 "saw" frames
    And the note rests at position 1.0
    And a note of 440.0 Hz
    When I render the note as "one"
    And the note has 5 unison voices detuned 30.0 cents with spread 0.0
    And I render the note as "five"
    Then the strongest partial of "five" is wider than that of "one"

  Scenario: Stereo spread puts different sound in the two ears
    Given a wavetable of 32 "saw" frames
    And the note rests at position 1.0
    And a note of 440.0 Hz
    And the note has 5 unison voices detuned 12.0 cents with spread 0.0
    When I render the note as "centred"
    And the note has 5 unison voices detuned 12.0 cents with spread 1.0
    And I render the note as "wide"
    Then the two channels of "centred" are identical
    And the two channels of "wide" are not

  Scenario: Velocity scales loudness
    Given a wavetable of 32 "saw" frames
    And a note of 220.0 Hz
    And the note has velocity 1.0
    When I render the note as "loud"
    And the note has velocity 0.3
    And I render the note as "soft"
    Then "loud" is louder than "soft" by between 6 and 12 dB

  Scenario: The filter takes the top off
    Given a wavetable of 32 "saw" frames
    And the note rests at position 1.0
    And a note of 220.0 Hz
    When I render the note as "open"
    And the note has a filter cutoff of 700.0 Hz
    And I render the note as "closed"
    Then "closed" has at least 20 dB less energy above 3000 Hz than "open"

  Scenario: A timed note ends by itself after its release
    Given a wavetable of 32 "saw" frames
    And a note of 220.0 Hz
    And the note is held for 0.3 seconds with a release of 0.1
    When I render the note as "note"
    Then "note" lasts between 0.38 and 0.44 seconds
    And "note" is silent at its last sample

  # ---------------------------------------------------------------- sculpting is sound

  Scenario: Sculpting a spike into the table brightens the note, and undo restores it exactly
    Given a wavetable of 32 "sine" frames
    And the note rests at position 0.5
    And a note of 220.0 Hz
    When I render the note as "before"
    And I sculpt a narrow spike into frames 15 and 16
    And I render the note as "after"
    Then "after" is brighter than "before"
    When I undo the sculpting
    And I render the note as "restored"
    Then "restored" is sample for sample the same as "before"

  Scenario: Saving a table and loading it back sounds the same
    Given a wavetable of 32 "vowels" frames
    And the note rests at position 0.5
    And a note of 130.0 Hz
    When I render the note as "original"
    And the table is saved and loaded into a fresh table
    And I render the note as "loaded"
    Then "loaded" is within 60 dB of "original" sample for sample

  Scenario: Notes on tables of different frame counts play in tune
    Given a wavetable of 8 "saw" frames
    And the note rests at position 1.0
    And a note of 330.0 Hz
    When I render the note as "note"
    Then "note" has its strongest partial within 4 cents of 330.0 Hz

  # ---------------------------------------------------------------- exporting

  Scenario: An offline bounce places each wavetable note where it was scheduled
    Given a wavetable of 32 "saw" frames registered as "bounce-test"
    When I bounce two notes to a WAV file, one at 0.5 seconds and one at 1.25 seconds
    Then the WAV is silent before 0.5 seconds
    And the WAV is audible from 0.5 seconds
    And the WAV is silent between the two notes
    And the WAV is audible from 1.25 seconds
    And the first note in the WAV is at 220.0 Hz and the second at 330.0 Hz
