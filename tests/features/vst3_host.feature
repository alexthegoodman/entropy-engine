Feature: Hosting real VST3 instruments

  Scenario: The scan finds the installed plugins and tells instruments from effects
    When I scan the VST3 folders
    Then the scan lists "Vital" as an instrument
    And the scan lists "Massive" as an instrument
    And the scan lists "Maschine 3" as an instrument
    And the scan lists "MIDI Guitar 3" as an effect with MIDI output

  Scenario Outline: A synth turns a MIDI note into audio and lets it decay
    Given I load the VST3 plugin "<plugin>"
    When I play MIDI note 60 at velocity 100 for 0.5 seconds
    And I render 2 seconds of audio
    Then the audio peak is above 0.02
    And the peak of the last 0.25 seconds is below the peak of the first 0.5 seconds

    Examples:
      | plugin  |
      | Vital   |
      | Massive |

  Scenario Outline: A plugin parameter changes what comes out
    Given I load the VST3 plugin "<plugin>"
    When I play MIDI note 60 at velocity 100 for 0.5 seconds
    And I render 1 seconds of audio
    And I remember the peak as "default"
    And I set the parameter "<parameter>" to 0.2
    And I render 0.1 seconds of audio
    And I play MIDI note 60 at velocity 100 for 0.5 seconds
    And I render 1 seconds of audio
    Then the peak is below 0.6 times the remembered peak "default"

    Examples:
      | plugin  | parameter     |
      | Vital   | Volume        |
      | Massive | MASTER-VOLUME |

  Scenario Outline: A saved state brings a patch back in a fresh instance
    Given I load the VST3 plugin "<plugin>"
    When I set the parameter "<parameter>" to 0.2
    And I render 0.1 seconds of audio
    And I save the plugin state
    And I load the plugin again from that state
    Then the saved state is not empty
    And the parameter "<parameter>" reads 0.2

    Examples:
      | plugin  | parameter     |
      | Vital   | Volume        |
      | Massive | MASTER-VOLUME |

  Scenario: Maschine loads, reports an editor, and its state is saved
    Given I load the VST3 plugin "Maschine 3"
    When I play MIDI note 36 at velocity 110 for 0.25 seconds
    And I render 1 seconds of audio
    And I save the plugin state
    Then the plugin has an editor
    And the saved state is not empty

  Scenario: Unloading while the audio thread is pulling tears down on this thread
    Given I load the VST3 plugin "Vital"
    When I play MIDI note 60 at velocity 100 for 0.5 seconds
    And I unload the plugin while another thread pulls audio
    Then the unload completed cleanly

  Scenario Outline: Rendering is much faster than realtime
    Given I load the VST3 plugin "<plugin>"
    When I play MIDI note 60 at velocity 100 for 2 seconds
    And I render 10 seconds of audio
    Then rendering ran at least 20 times faster than realtime

    Examples:
      | plugin     |
      | Vital      |
      | Massive    |
      | Maschine 3 |
