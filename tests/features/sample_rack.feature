Feature: The audio engine plays sample files on track buses

  Every scenario runs the real AudioEngine on the real output device. The samples are generated
  here as WAV files of known frequency and level (mono, 44.1 kHz, 16-bit, half of full scale unless
  a step says otherwise), so what the analysis taps hear can be checked against what was written to
  disk: a track's tap and the master must show the sample's own frequency, a pitch shift must move
  it by the right ratio, a trim must select the right part of the file. Nothing here judges how
  anything sounds.

  Scenario: A sample on a track is heard at its own frequency by the track's tap and the master
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    When I play "tone300.wav" on "drums"
    And I let the audio run for 400 ms
    Then the "drums" spectrum peaks within 4 Hz of 300 Hz
    And the "master" spectrum peaks within 4 Hz of 300 Hz
    And the "drums" spectrum peak reads -6.0 dBFS within 0.8 dB

  Scenario: A pad's gain scales the level
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    When I play "tone300.wav" on "drums" at gain 0.5
    And I let the audio run for 400 ms
    Then the "drums" spectrum peak reads -12.0 dBFS within 0.8 dB

  Scenario: Pitching up an octave doubles the frequency and a fifth down lowers it by the right ratio
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    When I play "tone300.wav" on "drums" pitched 12 semitones
    And I let the audio run for 400 ms
    Then the "drums" spectrum peaks within 6 Hz of 600 Hz
    When I remove the track "drums"
    And a track "drums" at full gain
    And I play "tone300.wav" on "drums" pitched -7 semitones
    And I let the audio run for 400 ms
    Then the "drums" spectrum peaks within 4 Hz of 200 Hz

  Scenario: A trim plays only the chosen part of the file
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "split.wav" that is 300 Hz for 500 ms and then 1200 Hz for 500 ms
    When I play "split.wav" on "drums" from 0.6 to 1
    And I let the audio run for 250 ms
    Then the "drums" spectrum peaks within 12 Hz of 1200 Hz
    When I remove the track "drums"
    And a track "drums" at full gain
    And I play "split.wav" on "drums" from 0 to 0.4
    And I let the audio run for 250 ms
    Then the "drums" spectrum peaks within 4 Hz of 300 Hz

  Scenario: A one-shot plays to its end and then stops by itself
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "blip.wav" that is a 500 Hz sine of 250 ms
    When I play "blip.wav" on "drums"
    And I let the audio run for 120 ms
    Then the "drums" spectrum peaks within 6 Hz of 500 Hz
    When I let the audio run for 700 ms
    Then the "drums" tap is silent

  Scenario: A gated hit stops when its hold runs out
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    When I play "tone300.wav" on "drums" gated to 100 ms
    And I let the audio run for 60 ms
    Then the "drums" tap is not silent
    When I let the audio run for 500 ms
    Then the "drums" tap is silent

  Scenario: Muting the track silences its samples and the master
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    When I play "tone300.wav" on "drums"
    And I let the audio run for 300 ms
    And I mute "drums"
    And I let the audio run for 300 ms
    Then the "drums" tap is silent
    And the "master" tap is silent

  Scenario: Two pads on one track sum, and each keeps its own frequency
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    And a generated sample "tone1200.wav" that is a 1200 Hz sine of 1500 ms
    When I play "tone300.wav" on "drums"
    And I play "tone1200.wav" on "drums"
    And I let the audio run for 400 ms
    Then the "drums" spectrum has energy at 300 Hz and at 1200 Hz

  Scenario: Auditioning a file is heard on the preview bus and the master, and the next audition cuts the first
    Given the real audio engine
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    And a generated sample "tone1200.wav" that is a 1200 Hz sine of 1500 ms
    When I audition "tone300.wav"
    And I let the audio run for 300 ms
    Then the "sample-preview" spectrum peaks within 4 Hz of 300 Hz
    And the "master" spectrum peaks within 4 Hz of 300 Hz
    When I audition "tone1200.wav"
    And I let the audio run for 300 ms
    Then the "sample-preview" spectrum peaks within 12 Hz of 1200 Hz
    And the "sample-preview" spectrum has no energy at 300 Hz
    When I stop the audition
    And I let the audio run for 200 ms
    Then the "sample-preview" tap is silent

  Scenario: A file that cannot be played is an error the caller can show, not silence or a crash
    Given the real audio engine
    And a track "drums" at full gain
    And a generated sample "tone300.wav" that is a 300 Hz sine of 1500 ms
    And a file "notes.txt" that is not audio
    And a file "broken.wav" that is not audio
    When I try to play "gone.wav" on "drums"
    Then it fails saying "could not read"
    When I try to play "notes.txt" on "drums"
    Then it fails saying "not a supported audio file"
    When I try to play "broken.wav" on "drums"
    Then it fails saying "could not decode"
    When I try to play "tone300.wav" on "no-such-track"
    Then it fails saying "has no bus"

  Scenario: A long file is decoded from its start only, and says so
    Given the real audio engine
    And a generated 220 Hz mono sample "long.wav" at 8000 Hz sample rate of 15000 ms
    When I load "long.wav"
    Then the sample is truncated at 12 seconds of a 15 second file
    And the sample was 8000 Hz mono

  Scenario: Loading describes the sample and its waveform is normalised
    Given the real audio engine
    And a generated 440 Hz mono sample "short.wav" at 22050 Hz sample rate of 500 ms
    When I load "short.wav"
    Then the sample is 0.5 seconds long within 0.01
    And its 32-bin waveform has a loudest bin of 1
    And its peak is 0.5 within 0.01

  Scenario: The offline export renders a sample where it was scheduled
    Given the real audio engine
    And a generated sample "blip.wav" that is a 500 Hz sine of 300 ms
    When I render "blip.wav" at 0.5 seconds to a WAV
    Then the rendered WAV is 0.8 seconds long within 0.02
    And the rendered WAV is silent before 0.45 seconds
    And the rendered WAV is audible after 0.5 seconds
    And the rendered WAV's loudest sample is 0.5 within 0.02

  Scenario: The offline export skips a missing sample instead of failing
    Given the real audio engine
    And a generated sample "blip.wav" that is a 500 Hz sine of 300 ms
    When I render "blip.wav" at 0.1 seconds and "vanished.wav" at 0.2 seconds to a WAV
    Then the rendered WAV is 0.4 seconds long within 0.02
