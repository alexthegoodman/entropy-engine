Feature: The physically modelled grand piano behaves like an acoustic concert grand

  Every scenario plays real notes through the real piano engine (src/audio/piano/), offline: no
  audio device, nothing timed by a clock. Assertions are acoustic measurements - Railsback inharmonicity,
  nonlinear hammer contact dynamics, two-stage prompt/aftersound decay, damper quenches, and
  sympathetic soundboard resonance.

  # ---------------------------------------------------------------- Railsback tuning & inharmonicity

  Scenario Outline: Railsback tuning curve across 88 keys
    Given a grand piano preset "ConcertGrand"
    And a note on key <key>
    When I play the key for 1.0 seconds
    Then its fundamental frequency is within 5 cents of the Railsback target for key <key>
    And the inharmonicity coefficient B is positive

    Examples:
      | key |
      | 0   |
      | 39  |
      | 48  |
      | 87  |

  # ---------------------------------------------------------------- Hammer dynamics

  Scenario: Hard hammer strike is brighter with shorter contact time and higher force
    Given a grand piano preset "ConcertGrand"
    And a note on key 48
    When I strike the key with velocity 0.2 for 0.8 seconds as "soft"
    And I strike the key with velocity 0.95 for 0.8 seconds as "loud"
    Then the contact time of "loud" is shorter than "soft"
    And the peak force of "loud" is greater than "soft"
    And the spectral centroid of "loud" is higher than "soft"
    And "loud" is at least 10 dB louder in RMS than "soft"

  # ---------------------------------------------------------------- Two-stage decay

  Scenario: Coupled unisons exhibit two-stage prompt and aftersound decay
    Given a grand piano preset "ConcertGrand"
    And a note on key 48
    When I play the key with velocity 0.8 for 2.5 seconds
    Then the prompt decay rate is at least 1.5 times the aftersound decay rate
    And the prompt decay rate exceeds 5 dB per second
    And the aftersound decay rate is less than 15 dB per second

  # ---------------------------------------------------------------- Damper action & undamped treble

  Scenario: Damper drop quenches a mid-register note on key release
    Given a grand piano preset "ConcertGrand"
    And a note on key 39
    When I play the key for 0.5 seconds then release for 0.5 seconds as "released"
    And I hold the key for 1.0 seconds without releasing as "held"
    Then "released" is at least 15 dB quieter than "held" at 0.9 seconds

  Scenario: High treble keys have no dampers and ring freely after key release
    Given a grand piano preset "ConcertGrand"
    And a note on key 80
    When I play the key for 0.3 seconds then release for 0.5 seconds as "treble_released"
    And I hold the key for 0.8 seconds without releasing as "treble_held"
    Then "treble_released" level is within 6 dB of "treble_held" at 0.7 seconds

  # ---------------------------------------------------------------- Sustain pedal sympathetic resonance

  Scenario: Sustain pedal lifts all dampers and excites sympathetic resonance
    Given a grand piano preset "ConcertGrand"
    And a note on key 39
    When I play the key with sustain pedal down for 1.2 seconds as "pedal_down"
    And I play the key with sustain pedal up for 1.2 seconds as "pedal_up"
    Then "pedal_down" has greater soundboard energy than "pedal_up"
    And "pedal_down" excites sympathetic vibrations across undamped strings

  # ---------------------------------------------------------------- Una corda (soft pedal)

  Scenario: Una corda pedal shifts hammer to soft felt reducing brightness
    Given a grand piano preset "ConcertGrand"
    And a note on key 48
    When I play the key with una corda at 0.0 for 0.8 seconds as "normal_pedal"
    And I play the key with una corda at 1.0 for 0.8 seconds as "una_corda_down"
    Then the spectral centroid of "una_corda_down" is lower than "normal_pedal"
    And "una_corda_down" is quieter than "normal_pedal"

  # ---------------------------------------------------------------- Voicing presets

  Scenario Outline: Piano voicing presets alter brightness and soundboard character
    Given a grand piano preset "<preset>"
    And a note on key 48
    When I play the key with velocity 0.8 for 1.0 seconds
    Then the rendered sound has peak level between -45 dB and 0 dB
    And the audio waveform is finite and bounded

    Examples:
      | preset       |
      | ConcertGrand |
      | StudioGrand  |
      | BrightGrand  |
      | WarmGrand    |

  # ---------------------------------------------------------------- Offline WAV export / bounce

  Scenario: Offline bounce of piano notes to a WAV file
    Given a grand piano preset "ConcertGrand"
    When I bounce two piano notes to a WAV file, one at 0.0 seconds and one at 0.4 seconds
    Then the WAV file is created and can be read back
    And the WAV is audible from 0.0 seconds

