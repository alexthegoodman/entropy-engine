Feature: A procedural scene in the real Mesha window
  The Library's Scenes section builds "The Road to the Dome": a whole post-apocalyptic level of
  editable library objects ending at a five-storey Rust Dome. With nothing selected, the Properties
  panel shows the scene's own controls; changing them rebuilds the level in place, keeping a piece
  edited by hand. Screenshots of each mood are kept for visual verification.

  Background:
    Given the real Mesha app is running in test mode

  Scenario: Build the scene from the library
    When I advance 20 frames
    Then I see the label "Scenes"
    And I see the label "The Road to the Dome"
    When I click "mesha-build-scene.road_to_the_dome"
    And I advance 30 frames
    Then I capture "01-ashen-overview"
    And I call the tool "mesha_state"

  Scenario: Another angle, closer
    When I call the tool "mesha_view" with {"all": true, "yaw": 160, "pitch": 14, "zoom": 1.8}
    And I advance 10 frames
    Then I capture "02-from-behind-the-dome"
    When I call the tool "mesha_view" with {"all": true, "yaw": 20, "pitch": 10, "zoom": 2.2}
    And I advance 10 frames
    Then I capture "03-down-the-road"

  Scenario: Moods
    When I call the tool "mesha_scene" with {"values": {"mood": "toxic", "decay": 0.85}}
    And I advance 30 frames
    Then I capture "04-toxic-haze"
    When I call the tool "mesha_scene" with {"values": {"mood": "night", "beacon": "red", "litWindows": 0.25}}
    And I advance 30 frames
    Then I capture "05-dead-of-night"

  Scenario: A taller dome, a hand edit kept
    When I call the tool "mesha_scene" with {"values": {"mood": "ashen", "domeStoreys": 7, "decay": 0.6}}
    And I advance 30 frames
    Then I capture "06-seven-storeys"
    And I call the tool "mesha_state"
    And I call the tool "mesha_scenes"
