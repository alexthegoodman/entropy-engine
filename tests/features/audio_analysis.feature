Feature: The audio engine can be listened to without touching the signal

  Every scenario runs the real AudioEngine on the real output device: notes are played through
  the same track buses the DAW uses, and the analysis taps are read the way the oscilloscope,
  spectrum and meter widgets read them. Tones are sines with a sustain of 1, gain 0.5 and the
  engine's centred pan, which puts each channel at 0.5 x 0.7071 = 0.354, or -9.03 dBFS.

  Scenario: A tone on a track is heard by the track's tap and by the master
    Given the real audio engine
    And a track "lead" at full gain
    When I play a 440 Hz sine on "lead" for 1000 ms
    And I let the audio run for 400 ms
    Then the "lead" spectrum peaks within 3 Hz of 440 Hz
    And the "master" spectrum peaks within 3 Hz of 440 Hz
    And the "master" spectrum peak reads -9.0 dBFS within 0.7 dB

  Scenario: Two tracks are separate in their own taps and summed in the master
    Given the real audio engine
    And a track "bass" at full gain
    And a track "lead" at full gain
    When I play a 220 Hz sine on "bass" for 1500 ms
    And I play a 1760 Hz sine on "lead" for 1500 ms
    And I let the audio run for 500 ms
    Then the "bass" spectrum peaks within 3 Hz of 220 Hz
    And the "lead" spectrum peaks within 3 Hz of 1760 Hz
    And the "master" spectrum has energy at 220 Hz and at 1760 Hz

  Scenario: A muted track is silent to its own tap
    Given the real audio engine
    And a track "lead" at full gain
    When I play a 440 Hz sine on "lead" for 1500 ms
    And I let the audio run for 300 ms
    And I mute "lead"
    And I let the audio run for 300 ms
    Then the "lead" tap is silent
    And the "master" tap is silent

  Scenario: Removing a track stops its sound and its tap
    Given the real audio engine
    And a track "lead" at full gain
    When I play a 440 Hz sine on "lead" for 3000 ms
    And I let the audio run for 300 ms
    And I remove the track "lead"
    And I let the audio run for 300 ms
    Then "lead" is no longer a source
    And the "master" tap is silent

  Scenario: A peak between two reads is not lost
    Given the real audio engine
    And a track "drums" at full gain
    When a meter reads "drums" for the first time
    And I play a 60 ms full-scale kick on "drums"
    And I let the audio run for 150 ms
    Then a fixed 20 ms trailing window on "drums" has missed it
    And the meter's next read of "drums" shows a peak above -12 dBFS

  Scenario: Two meters on one source do not steal each other's peaks
    Given the real audio engine
    And a track "drums" at full gain
    When meter "a" and meter "b" both read "drums" for the first time
    And I play a 60 ms full-scale kick on "drums"
    And I let the audio run for 150 ms
    Then meter "a" reads a peak above -12 dBFS on "drums"
    And meter "b" reads a peak above -12 dBFS on "drums"
