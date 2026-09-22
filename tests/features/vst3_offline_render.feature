Feature: Rendering VST3-hosted tracks into WAV export

  A VST3 instrument (e.g. Massive) has no per-note fundsp graph the way a built-in voice does, so
  it cannot be additively mixed the same way - see `vst3::render_offline_track`'s doc comment. These
  scenarios drive the offline render entirely through `render_events_full_to_wav`, the same function
  the DAW's "Export to WAV" button calls, with real installed plugins and no audio device.

  Scenario: A single VST3 note bounces to a WAV file at its scheduled time
    Given a VST3 render track for the plugin "Vital"
    And its note at 0.5 seconds plays MIDI note 60 for 0.4 seconds
    When I bounce the VST3 tracks to a WAV file
    Then the export has no vst3 warnings
    And the WAV is silent before 0.5 seconds
    And the WAV is audible from 0.5 seconds

  Scenario: Two notes on one track bounce at their own times, silent in between
    Given a VST3 render track for the plugin "Vital"
    And its note at 0.2 seconds plays MIDI note 60 for 0.3 seconds
    And its note at 1.2 seconds plays MIDI note 64 for 0.3 seconds
    When I bounce the VST3 tracks to a WAV file
    Then the WAV is silent before 0.2 seconds
    And the WAV is audible from 0.2 seconds
    And the WAV is silent between 0.7 and 1.1 seconds
    And the WAV is audible from 1.2 seconds

  Scenario: Two different plugins on two tracks are both heard in the same bounce
    Given a VST3 render track for the plugin "Vital"
    And its note at 0.2 seconds plays MIDI note 60 for 0.4 seconds
    And a VST3 render track for the plugin "Massive"
    And its note at 0.9 seconds plays MIDI note 60 for 0.4 seconds
    When I bounce the VST3 tracks to a WAV file
    Then the WAV is audible from 0.2 seconds
    And the WAV is audible from 0.9 seconds

  Scenario: The render carries a tail past the last note-off, but does not run forever
    Given a VST3 render track for the plugin "Vital"
    And its note at 0.1 seconds plays MIDI note 60 for 0.2 seconds
    When I bounce the VST3 tracks to a WAV file
    Then the render lasts between 0.3 and 3.4 seconds

  Scenario: A track whose plugin file does not exist is left out, with a warning, not a failed export
    Given a VST3 render track for the plugin "Vital"
    And its note at 0.2 seconds plays MIDI note 60 for 0.4 seconds
    And a VST3 render track for the missing plugin "no-such-plugin.vst3"
    And its note at 0.2 seconds plays MIDI note 60 for 0.4 seconds
    When I bounce the VST3 tracks to a WAV file
    Then the export has 1 vst3 warning
    And a vst3 warning mentions "no-such-plugin.vst3"
    And the WAV is audible from 0.2 seconds
