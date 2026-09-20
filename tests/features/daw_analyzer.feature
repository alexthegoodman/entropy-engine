Feature: The DAW shows what it is playing

  The production addon runs against a stand-in Entropy that records every widget it declares and
  answers Audio.analyze with whatever the scenario says the engine hears. This tier checks what
  the addon asks for; tests/features/audio_widgets.feature checks how the widgets draw it, and
  tests/features/daw_analyzer_live.feature checks it against real audio.

  Scenario: The analyzer starts on the whole mix
    Given the DAW is open with its starter song
    Then the spectrum, the oscilloscope and the meter are all reading "master"
    And the spectrum is not tinted with a track colour

  Scenario: Choosing a track points every analyzer at that track and takes its colour
    Given the DAW is open with its starter song
    When I choose option 2 of "analyzer_source"
    Then the spectrum, the oscilloscope and the meter are all reading "trk-bass"
    And the spectrum is tinted with the colour of "Bass"
    And the oscilloscope is tinted with the colour of "Bass"

  Scenario: The scope can be a stereo trace, a mono trace or a goniometer
    Given the DAW is open with its starter song
    Then the oscilloscope is in stereo mode
    When I choose option 1 of "analyzer_scope_mode"
    Then the oscilloscope is in mono mode
    When I choose option 2 of "analyzer_scope_mode"
    Then the oscilloscope is in xy mode
    And the oscilloscope is zoomed in

  Scenario: The analyzer is a window of its own
    Given the DAW is open with its starter song
    Then the analyzer lives in a window of its own, not in the tab

  Scenario: Analyzer choices reach the widgets
    Given the DAW is open with its starter song
    When I choose option 3 of "analyzer_fft"
    And I choose option 1 of "analyzer_style"
    And I untick "Trigger"
    Then the spectrum uses an FFT of 8192 in the "bars" style
    And the stereo oscilloscope has its trigger off

  Scenario: Deleting the track being listened to falls back to the master
    Given the DAW is open with its starter song
    When I choose option 2 of "analyzer_source"
    And I call the tool "daw_delete_track" with {"trackId":"trk-bass"}
    And I advance 100 milliseconds
    Then the spectrum, the oscilloscope and the meter are all reading "master"

  Scenario: The mixer has a meter on every strip and a master strip
    Given the DAW is open with its starter song
    Then there are meters for "master", "trk-drums", "trk-bass", "trk-lead" and "trk-pad"

  Scenario: The readout describes what the engine hears
    Given the DAW is open with its starter song
    And the engine hears a peak of -12.3 dBFS and RMS of -20.1 dBFS at 261.6 Hz with brightness 1400 Hz on "master"
    When I advance 100 milliseconds
    Then I see a label containing "Peak -12.3 dBFS"
    And I see a label containing "Strongest 261.6 Hz (C4)"
    And I see a label containing "Brightness 1400 Hz"

  Scenario: The readout says so when there is silence
    Given the DAW is open with its starter song
    And the engine hears silence on "master"
    When I advance 100 milliseconds
    Then I see the label "Silent."

  Scenario: The AI can listen to the mix
    Given the DAW is open with its starter song
    And the engine hears a peak of -9.0 dBFS and RMS of -14.0 dBFS at 65.4 Hz with brightness 300 Hz on "trk-bass"
    And the engine hears a peak of -12.3 dBFS and RMS of -20.1 dBFS at 261.6 Hz with brightness 1400 Hz on "master"
    When I call the tool "daw_analyze_mix" with {}
    Then the tool result says the master's strongest note is "C4"
    And the tool result lists 4 tracks
    And the tool result says "Bass" has its strongest frequency at 65.4 Hz

  Scenario: Which source you listen to is not part of the song
    Given the DAW is open with its starter song
    When I choose option 2 of "analyzer_source"
    And I choose option 3 of "analyzer_fft"
    And I advance 600 milliseconds
    Then the saved project does not mention the analyzer
