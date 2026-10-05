Feature: Allegiance cached cloud cost and visual continuity
  Scenario: Compare procedural clouds, cached clouds and clear sky on identical geometry
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_new" with {"spawn":"london","party":"Dawn Front","leader":"Ada Marlow","lat":51.5033,"lon":-0.1196,"seed":7}
    And I call the tool "allegiance_settle" with {"timeoutMs":300000}
    And I call the tool "allegiance_config" with {"fixedStep":null,"profileFreeze":true,"weather":{"cloudCover":0.35,"windSpeed":3,"windHeading":0},"dayClock":60}
    And I advance 120 frames
    When I call the tool "allegiance_config" with {"profileCloudCache":false,"profileExperiment":51}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    And I capture "cloud-reference"
    When I call the tool "allegiance_config" with {"profileCloudCache":true,"profileExperiment":52}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    And I capture "cloud-cached"
    When I call the tool "allegiance_config" with {"weather":{"cloudCover":0,"windSpeed":3,"windHeading":0},"profileExperiment":53}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"weather":{"cloudCover":0.35,"windSpeed":3,"windHeading":0},"profileExperiment":54}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileCloudCache":false,"profileExperiment":55}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileCloudCache":true,"profileExperiment":56}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"weather":{"cloudCover":0,"windSpeed":3,"windHeading":0},"profileExperiment":57}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"weather":{"cloudCover":0.35,"windSpeed":3,"windHeading":0},"profileExperiment":58}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    # Confirm the optimized path during normal simulation as well.
    When I call the tool "allegiance_config" with {"profileFreeze":false,"profileExperiment":59}
    And I advance 180 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileExperiment":0}
