Feature: Allegiance - a political conquest game on QuadPlanet's full-scale Earth
  Played with ENTROPY_ALLEGIANCE_BDD_RESULT (tests/allegiance_live.rs): the title over Earth from
  orbit, founding a party, the loading screen while London streams in (terrain, OpenStreetMap
  streets, Mesha houses), then the street: pedestrians on A* paths, a speech, talking to and
  recruiting a passer-by, the command console, a street battle, and the end of the campaign.

  Scenario: Title and setup
    Given the real Allegiance game is running in test mode
    When I call the tool "allegiance_config" with {"fixedStep": 0.033}
    And I call the tool "allegiance_settle" with {"timeoutMs": 60000}
    And I advance 10 frames
    Then I capture "01-title"
    When I call the tool "allegiance_ui" with {"mode": "setup", "setupSpawn": "london", "party": "Dawn Front", "leader": "Ada Marlow"}
    And I advance 3 frames
    Then I capture "02-setup"

  Scenario: Loading London
    When I call the tool "allegiance_new" with {"spawn": "london", "party": "Dawn Front", "leader": "Ada Marlow", "lat": 51.5033, "lon": -0.1196, "seed": 7}
    And I advance 2 frames
    Then I call the tool "allegiance_state"
    And I capture "03-loading"
    When I call the tool "allegiance_settle" with {"timeoutMs": 300000}
    And I advance 20 frames
    Then I call the tool "allegiance_state"
    And I capture "04-street"

  Scenario: Walking the street
    When I hold the key "w" for 45 frames
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    When I call the tool "allegiance_act" with {"action": "view", "distance": 9, "pitch": -0.35}
    And I advance 3 frames
    Then I capture "05-street-wide"

  Scenario: A speech
    When I call the tool "allegiance_speech" with {"action": "start"}
    And I advance 150 frames
    Then I call the tool "allegiance_state"
    And I capture "06-speech-cards"
    When I call the tool "allegiance_speech" with {"action": "choose"}
    And I advance 8 frames
    Then I capture "07-speech-deliver"
    When I call the tool "allegiance_speech" with {"action": "deliver"}
    And I advance 4 frames
    Then I capture "08-speech-react"
    When I call the tool "allegiance_speech" with {"action": "auto", "grade": "perfect"}
    And I advance 30 frames
    Then I call the tool "allegiance_state"
    And I capture "09-speech-result"
    When I call the tool "allegiance_speech" with {"action": "close"}
    And I advance 5 frames
    Then I call the tool "allegiance_state"

  Scenario: Talking to a passer-by
    When I call the tool "allegiance_act" with {"action": "approach"}
    And I call the tool "allegiance_act" with {"action": "view", "distance": 3.2, "pitch": -0.15}
    And I call the tool "allegiance_act" with {"action": "talk"}
    And I advance 5 frames
    Then I call the tool "allegiance_state"
    And I capture "10-dialogue"
    When I call the tool "allegiance_act" with {"action": "persuade"}
    And I call the tool "allegiance_act" with {"action": "recruit"}
    And I advance 3 frames
    Then I call the tool "allegiance_state"
    And I capture "11-dialogue-after"
    When I call the tool "allegiance_act" with {"action": "leave"}
    And I call the tool "allegiance_act" with {"action": "pamphlet"}

  Scenario: The command console
    When I call the tool "allegiance_act" with {"action": "funds", "amount": 60000}
    And I call the tool "allegiance_act" with {"action": "days", "days": 6}
    And I call the tool "allegiance_act" with {"action": "organize"}
    And I call the tool "allegiance_ui" with {"mode": "console", "tab": "overview"}
    And I advance 3 frames
    Then I capture "12-console-overview"
    When I call the tool "allegiance_ui" with {"tab": "organization", "member": 1}
    And I advance 3 frames
    Then I capture "13-console-organization"
    When I call the tool "allegiance_ui" with {"tab": "territory", "region": "london"}
    And I advance 3 frames
    Then I capture "14-console-territory"
    When I call the tool "allegiance_ui" with {"tab": "armory"}
    And I call the tool "allegiance_click" with {"id": "buy-rifle"}
    And I advance 3 frames
    Then I capture "15-console-armory"
    When I call the tool "allegiance_ui" with {"tab": "skills"}
    And I advance 3 frames
    Then I capture "16-console-skills"
    When I call the tool "allegiance_ui" with {"mode": "play"}

  Scenario: A street battle
    When I call the tool "allegiance_act" with {"action": "followers", "count": 2}
    And I advance 30 frames
    And I call the tool "allegiance_act" with {"action": "squad", "count": 4}
    And I advance 150 frames
    And I call the tool "allegiance_act" with {"action": "face-enemy"}
    And I call the tool "allegiance_act" with {"action": "view", "distance": 5, "pitch": -0.05}
    And I call the tool "allegiance_act" with {"action": "shoot"}
    And I advance 1 frame
    Then I call the tool "allegiance_state"
    And I capture "17-battle"
    When I call the tool "allegiance_act" with {"action": "view", "firstPerson": true, "pitch": 0}
    And I call the tool "allegiance_act" with {"action": "face-enemy"}
    And I call the tool "allegiance_act" with {"action": "shoot"}
    And I advance 1 frame
    Then I capture "18-first-person"
    When I call the tool "allegiance_act" with {"action": "view", "firstPerson": false}

  Scenario: Taking the planet
    When I call the tool "allegiance_act" with {"action": "govern", "amount": 0.8}
    And I advance 3 frames
    Then I call the tool "allegiance_state"
    And I capture "19-victory"
