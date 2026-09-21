Feature: The DAW's guitar input, the parts that need no device
  The panel's logic (saved preferences, turning a recorded take into a pattern, the readouts) is a
  plain module, tested here as it ships. The engine behind it is tested in guitar_engine.feature and
  guitar_live.feature.

  Scenario: A take becomes a pattern rooted on its lowest note
    Given a take at 120 BPM with 4 steps per beat: "E3 0.0-0.5, G3 0.5-1.0, B3 1.0-1.5"
    When the take is turned into a pattern
    Then the pattern is rooted on note 52 with 8 rows
    And the pattern has these cells: "0:0:4, 3:4:4, 7:8:4"
    And the pattern is 16 steps long

  Scenario: A note lands on the step it was played on, not the one after
    Given a take at 120 BPM with 4 steps per beat: "A3 1.0-1.2"
    When the take is turned into a pattern
    Then the pattern has these cells: "0:8:2"

  Scenario: A note is trimmed where the next one starts
    Given a take at 120 BPM with 4 steps per beat: "E3 0.0-1.0, G3 0.25-0.5"
    When the take is turned into a pattern
    Then the pattern has these cells: "0:0:2, 3:2:2"

  Scenario: A long take is a whole number of bars
    Given a take at 120 BPM with 4 steps per beat: "E3 0.0-0.4, E3 2.5-3.2"
    When the take is turned into a pattern
    Then the pattern is 32 steps long

  Scenario: Bend data is counted but not stored
    Given a take at 120 BPM with 4 steps per beat: "E3 0.0-0.4 with 12 bend points"
    When the take is turned into a pattern
    Then the pattern has 12 bend points that the note cells cannot hold

  Scenario: An empty take is not a pattern
    Given a take at 120 BPM with 4 steps per beat: ""
    When the take is turned into a pattern
    Then there is no pattern

  Scenario: Saved preferences from an older or hand-edited file still open
    Given saved guitar preferences '{"mode":"accurate","bendRange":99,"channel":-3,"futureField":true,"waveform":"nope"}'
    When the preferences are read
    Then the mode is accurate and the bend range is 12 and the channel is 0
    And the waveform is the default

  Scenario: A device that is not plugged in is remembered
    Given saved guitar preferences '{"device":"USB Guitar Link","host":"ASIO"}'
    When the preferences are read
    Then the device is "USB Guitar Link" on "ASIO"

  Scenario: A signal that stays quiet is flagged after a few notes
    Given notes played at these peak levels in dBFS: "-36 -34 -38 -35"
    Then the input is reported as too quiet

  Scenario: A normal signal is not flagged
    Given notes played at these peak levels in dBFS: "-36 -18 -20 -22"
    Then the input is not reported as too quiet

  Scenario: The diagnostics name every reading the spec lists
    Given a reading of A3 sharp by 12 cents at 220 Hz with the bend at 9000 on a 2 semitone range
    When the diagnostics are formatted
    Then the readout mentions "A3", "+12 cents", "220.0 Hz", "velocity", "overruns" and "frames"
