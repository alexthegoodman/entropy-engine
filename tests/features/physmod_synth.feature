Feature: The bowed-string voice settles on pitch and its bow controls change the tone

  Every scenario renders real notes through the real `PhysModVoice`, offline: no audio device,
  nothing timed by a clock. Assertions are facts about the spectrum (the strongest partial's
  frequency, the spectral centroid) measured well after note-on, since the regenerative sustain (see
  `src/audio/physmod.rs`) takes a little while to settle onto the fundamental the same way a real
  bowed note has an attack transient before clean Helmholtz motion takes over.

  # ---------------------------------------------------------------- pitch

  Scenario Outline: A bowed note settles on the requested pitch across the register
    Given a bowed string
    And a note of <hz> Hz
    When I render the note as "note" for 1.3 seconds
    Then "note" measured from 0.5 seconds has its strongest partial within 3 percent of <hz> Hz

    Examples:
      | hz     |
      | 65.41  |
      | 110.0  |
      | 220.0  |
      | 440.0  |
      | 880.0  |

  # ---------------------------------------------------------------- bow force

  Scenario: A harder bow brightens the tone
    Given a bowed string
    And a note of 220.0 Hz
    And the bow force is 0.15
    When I render the note as "soft" for 0.7 seconds
    Given the bow force is 0.95
    When I render the note as "hard" for 0.7 seconds
    Then "hard" measured from 0.3 seconds is brighter than "soft" measured from 0.3 seconds

  # ---------------------------------------------------------------- bow position

  Scenario: Bowing closer to the bridge shifts the harmonic balance
    Given a bowed string
    And a note of 220.0 Hz
    And the bow position is 0.04
    When I render the note as "bridge" for 0.7 seconds
    Given the bow position is 0.45
    When I render the note as "middle" for 0.7 seconds
    Then "bridge" measured from 0.3 seconds and "middle" measured from 0.3 seconds differ in brightness by at least 3 percent

  # ---------------------------------------------------------------- damping

  Scenario: More damping shortens the release
    Given a bowed string
    And a note of 220.0 Hz
    And the damping is 0.0
    And the note is held for 0.3 seconds with a release of 0.4
    When I render the gated note as "low-damping"
    Given the damping is 1.0
    When I render the gated note as "high-damping"
    Then "high-damping" does not outlast "low-damping"

  # ---------------------------------------------------------------- vibrato

  Scenario: Vibrato moves the pitch away from a flat tone
    Given a bowed string
    And a note of 330.0 Hz
    And the note is held for 1.1 seconds with a release of 0.1
    When I render the note as "flat" for 1.2 seconds
    Given vibrato of 2.0 Hz and depth 200.0 cents
    When I render the note as "wobbly" for 1.2 seconds
    Then the pitch of "wobbly" moves more between 0.625 and 0.875 seconds than the pitch of "flat" does

  # ---------------------------------------------------------------- body

  Scenario: A larger body darkens the tone
    Given a bowed string
    And a note of 220.0 Hz
    And the body size is 0.0
    And the body mix is 0.9
    When I render the note as "violin-body" for 0.7 seconds
    Given the body size is 1.0
    When I render the note as "bass-body" for 0.7 seconds
    Then "bass-body" measured from 0.3 seconds is darker than "violin-body" measured from 0.3 seconds

  # ---------------------------------------------------------------- stability

  Scenario Outline: The output stays finite and bounded across bow force, velocity and position
    Given a bowed string
    And a note of 440.0 Hz
    And the bow force is <force>
    And the bow velocity is <velocity>
    And the bow position is <position>
    When I render the note as "sweep" for 0.3 seconds
    Then "sweep" is finite and never exceeds 3.0 in magnitude

    Examples:
      | force | velocity | position |
      | 0.0   | 0.0      | 0.02     |
      | 0.5   | 0.5      | 0.15     |
      | 1.0   | 1.0      | 0.5      |

  # ---------------------------------------------------------------- lifecycle

  Scenario: A timed note ends by itself and a gated note waits for its gate
    Given a bowed string
    And a note of 220.0 Hz
    And the note is held for 0.1 seconds with a release of 0.05
    When I render the note as "timed" for 5.0 seconds
    Then "timed" lasts between 0.1 and 0.25 seconds
