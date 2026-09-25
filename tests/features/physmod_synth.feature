Feature: The bowed-string instrument behaves like a bowed string

  Every scenario plays real notes through the real instrument (src/audio/physmod/), offline: no
  audio device, nothing timed by a clock. Assertions are measurements - pitch in cents, the bow's
  stick/slip statistics, levels, spectra - taken once the stroke has settled, the same way the model
  was developed without anyone listening to it.

  # ---------------------------------------------------------------- pitch

  Scenario Outline: A bowed note is in tune across the violin
    Given a violin
    And a note of <hz> Hz
    When I play the note for 0.8 seconds
    Then its pitch is within 6 cents of <hz> Hz

    Examples:
      | hz      |
      | 196.0   |
      | 261.63  |
      | 440.0   |
      | 587.33  |
      | 987.77  |
      | 1567.98 |

  Scenario: A cello's low C is in tune
    Given a cello
    And a note of 65.41 Hz
    When I play the note for 1.0 seconds
    Then its pitch is within 8 cents of 65.41 Hz

  # ---------------------------------------------------------------- the bow

  Scenario: A normal stroke is Helmholtz motion
    Given a violin
    And a note of 440.0 Hz
    And the bow position is 0.12
    When I play the note for 0.8 seconds
    Then the bow is in Helmholtz motion
    And the string sticks to the bow for about 88 percent of each period
    And the stroke settled within 0.2 seconds

  Scenario Outline: Schelleng's playable window
    Given a violin
    And a note of 293.66 Hz
    And the bow position is <position>
    And the bow force is <force>
    And the bow speed is <speed>
    When I play the note for 0.8 seconds
    Then the bow is in <regime>

    Examples:
      | position | force | speed | regime            |
      | 0.05     | 0.15  | 0.5   | surface sound     |
      | 0.05     | 0.75  | 0.5   | Helmholtz motion  |
      | 0.13     | 0.5   | 0.5   | Helmholtz motion  |
      | 0.13     | 1.0   | 0.3   | raucous motion    |

  Scenario: A faster bow is louder
    Given a violin
    And a note of 440.0 Hz
    And the bow speed is 0.35
    When I play the note as "slow" for 0.8 seconds
    Given the bow speed is 0.5653
    And the bow force is 0.6505
    When I play the note as "fast" for 0.8 seconds
    Then "fast" is between 3.5 and 8.5 dB louder than "slow"

  Scenario: Bowing near the bridge is brighter than near the fingerboard
    Given a violin
    And a note of 293.66 Hz
    And the body mix is 0.0
    And the bow position is 0.2
    And the bow force is 0.35
    When I play the note as "tasto" for 0.8 seconds
    Given the bow position is 0.05
    And the bow force is 0.8
    When I play the note as "ponticello" for 0.8 seconds
    Then "ponticello" is at least 15 percent brighter than "tasto"

  # ---------------------------------------------------------------- the instrument

  Scenario: The open G string rings in sympathy with a G, not with an F sharp
    Given a violin
    And a note of 392.0 Hz
    When I play the note for 1.0 seconds
    Then the open G string is ringing at least 4 times as strongly as it does for 370.0 Hz

  Scenario: On a strongly coupled cello a light bow stutters on the wolf, and a firm bow tames it
    Given a cello
    And the bridge coupling is 1.0
    And a note of 163.6 Hz
    And the bow force is 0.3
    When I play the note for 1.6 seconds
    Then the bow is not in Helmholtz motion
    Given the bow force is 0.5
    When I play the note for 1.6 seconds
    Then the bow is in Helmholtz motion

  Scenario: A larger body carries more low-frequency energy
    Given a violin
    And a note of 220.0 Hz
    And the body size is 0.0
    When I play the note as "violin-body" for 0.8 seconds
    Given the body size is 1.0
    When I play the note as "bass-body" for 0.8 seconds
    Then "bass-body" is darker than "violin-body"

  Scenario: A plucked note dies away
    Given a violin
    And a note of 392.0 Hz
    And the articulation is pizzicato
    When I render the note as "pizz" for 1.2 seconds
    Then "pizz" is at least 10 dB quieter at 0.9 seconds than at 0.05 seconds

  Scenario: Vibrato moves the pitch by its depth
    Given a violin
    And a note of 330.0 Hz
    And vibrato of 1.0 Hz and depth 50.0 cents starting at once
    When I render the note as "wobbly" for 2.0 seconds
    Then the pitch of "wobbly" differs between 1.25 and 1.75 seconds by about 100 cents

  # ---------------------------------------------------------------- robustness and lifecycle

  Scenario Outline: The output stays finite and bounded, even for impossible instruments
    Given a violin
    And a note of 220.0 Hz
    And the body size is <size>
    And the bow force is <force>
    And the bow speed is 1.0
    And the bridge coupling is <coupling>
    And the string stiffness is <stiffness>
    When I render the note as "lab" for 0.4 seconds
    Then "lab" is finite and never exceeds 4.0 in magnitude

    Examples:
      | size | force | coupling | stiffness |
      | -1.0 | 1.0   | 1.0      | 1.0       |
      | 0.0  | 0.0   | 0.35     | 0.0       |
      | 2.5  | 1.0   | 1.0      | 0.5       |

  Scenario: A timed note ends by itself and a gated note waits for its gate
    Given a violin
    And a note of 330.0 Hz
    And the note is held for 0.2 seconds with a release of 0.05
    When I render the note as "timed" for 10.0 seconds
    Then "timed" lasts between 0.2 and 1.5 seconds
    When I hold the gated note as "gated" for 1.0 seconds
    Then "gated" lasts between 1.0 and 2.5 seconds
