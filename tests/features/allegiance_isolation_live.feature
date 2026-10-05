Feature: Allegiance single-subsystem performance isolation
  Scenario: Paired disable and restore measurements on a settled London street
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I call the tool "allegiance_config" with {"fixedStep": null, "weather": {"cloudCover": 0.35, "windSpeed": 3, "windHeading": 0}, "dayClock": 60}
    And I advance 120 frames
    # 1: baseline; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileExperiment":1, "profileFreeze":true}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 2: no shadows; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"shadows":false,"profileExperiment":2}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 3: baseline restored; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"shadows":true,"profileExperiment":3}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 4: no people; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"people","profileExperiment":4}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 5: baseline restored; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":5}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 6: no scatter; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"scatter","profileExperiment":6}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 7: baseline restored; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":7}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 8: no street simulation; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"street","profileExperiment":8}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 9: baseline restored; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":9}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 10: no terrain streaming; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"terrainStream","profileExperiment":10}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 11: baseline restored; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":11}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 12: no house updates; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"houses","profileExperiment":12}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 13: baseline restored; each restore undoes only the preceding disable.
    When I call the tool "allegiance_config" with {"profileDisable":"none","profileExperiment":13}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 14: clouds disabled, same geometry and cast shadows.
    When I call the tool "allegiance_config" with {"weather":{"cloudCover":0,"windSpeed":3,"windHeading":0},"profileExperiment":14}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    # 15: restore clouds.
    When I call the tool "allegiance_config" with {"weather":{"cloudCover":0.35,"windSpeed":3,"windHeading":0},"profileExperiment":15}
    And I advance 120 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_config" with {"profileFreeze":false,"profileExperiment":0}
