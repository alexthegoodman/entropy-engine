Feature: Allegiance - a political conquest game on QuadPlanet's full-scale Earth
  Played with ENTROPY_ALLEGIANCE_BDD_RESULT (tests/allegiance_live.rs): the title over Earth from
  orbit, founding a party, the loading screen while London streams in (terrain, OpenStreetMap
  streets, Mesha houses), then the street: pedestrians on A* paths, a speech, a squad of soldiers.

  Scenario: Title and setup
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I advance 20 frames
    Then I capture "01-title"
    When I call the tool "allegiance_ui" with {"mode": "setup", "setupSpawn": "london", "party": "Dawn Front", "leader": "Ada Marlow"}
    And I advance 3 frames
    Then I capture "02-setup"

  Scenario: Loading London
    When I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I advance 10 frames
    Then I call the tool "allegiance_state"
    And I capture "03-loading"
    When I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "04-street"
