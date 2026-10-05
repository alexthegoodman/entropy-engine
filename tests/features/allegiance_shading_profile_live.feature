Feature: Allegiance GPU shading isolation
  Scenario: Disable one drawing or shading feature and restore it
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_new" with {"spawn":"london","party":"Dawn Front","leader":"Ada Marlow","lat":51.5033,"lon":-0.1196,"seed":7}
    And I call the tool "allegiance_settle" with {"timeoutMs":300000}
    And I call the tool "allegiance_config" with {"fixedStep":null,"weather":{"cloudCover":0.35,"windSpeed":3,"windHeading":0},"dayClock":60}
    And I advance 120 frames
    And I call the tool "allegiance_config" with {"profileFreeze":true}
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":21}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"sky","profileExperiment":22}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":23}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"cloudShadows","profileExperiment":24}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":25}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"skyClouds","profileExperiment":26}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":27}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"materials","profileExperiment":28}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":29}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"atmosphere","profileExperiment":30}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":31}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"stars","profileExperiment":32}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":33}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileFreeze":false,"profileExperiment":0}
