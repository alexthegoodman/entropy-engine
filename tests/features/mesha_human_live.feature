Feature: People in Mesha, in the real window
  A person from the library: an anatomical body and face, clothes cut to fit and draped by cloth
  physics, and styled hair settled by strand physics. In the viewport the hair and clothes keep
  simulating: turning the figure swings them, and a breeze keeps them moving. Screenshots of the
  composed frame are kept for visual verification.

  Background:
    Given the real Mesha app is running in test mode

  Scenario: A person joins the scene
    When I call the tool "mesha_remove"
    And I call the tool "mesha_add" with {"objectId": "people.human", "preset": "Weekend", "position": [0, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 6}
    And I advance 6 frames
    Then I capture "human-01-weekend"
    And I call the tool "mesha_state"

  Scenario: The face up close
    When I call the tool "mesha_view" with {"yaw": 12, "pitch": 10, "zoom": 6.5, "focus": 0.93}
    And I advance 4 frames
    Then I capture "human-02-face"
    When I call the tool "mesha_view" with {"yaw": 55, "pitch": 10, "zoom": 6.5, "focus": 0.93}
    And I advance 4 frames
    Then I capture "human-03-face-three-quarter"
    When I call the tool "mesha_view" with {"yaw": 160, "pitch": 10, "zoom": 3, "focus": 0.82}
    And I advance 4 frames
    Then I capture "human-04-hair-from-behind"

  Scenario: Turning the figure swings the hair and clothes
    When I call the tool "mesha_view" with {"yaw": 20, "pitch": 6, "zoom": 1.4, "focus": 0.7}
    And I advance 30 frames
    And I call the tool "mesha_place" with {"rotationY": 50}
    And I advance 3 frames
    Then I capture "human-05-swinging"
    When I advance 120 frames
    Then I capture "human-06-settled"

  Scenario: Restyled and redressed
    When I call the tool "mesha_set" with {"values": {"hairStyle": "bob", "bangs": 0.8, "hairColor": "hair.black", "top": "sweater", "topFinish": "fabric.knitBurgundy", "bottom": "skirt", "bottomLength": 0.5, "flare": 0.7, "bottomFinish": "fabric.charcoal", "shoes": "boots", "shoeFinish": "leather.black", "eyeColor": "iris.green", "skin": "skin.olive"}}
    And I call the tool "mesha_place" with {"rotationY": 0}
    And I call the tool "mesha_view" with {"yaw": 25, "pitch": 6}
    And I advance 8 frames
    Then I capture "human-07-restyled"

  Scenario: In the wind
    When I call the tool "mesha_add" with {"objectId": "people.human", "preset": "Windy ponytail", "position": [1.4, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 6}
    And I advance 20 frames
    Then I capture "human-08-wind-a"
    When I advance 15 frames
    Then I capture "human-09-wind-b"

  Scenario: A gallery of people
    When I call the tool "mesha_add" with {"objectId": "people.human", "preset": "Office", "position": [-1.4, 0, 0]}
    And I call the tool "mesha_add" with {"objectId": "people.human", "preset": "Summer dress", "position": [2.8, 0, 0]}
    And I call the tool "mesha_add" with {"objectId": "people.human", "preset": "Grandfather", "position": [-2.8, 0, 0]}
    And I call the tool "mesha_add" with {"objectId": "people.human", "preset": "Afro, waving", "position": [4.2, 0, 0]}
    And I call the tool "mesha_view" with {"all": true, "yaw": 15, "pitch": 8}
    And I advance 10 frames
    Then I capture "human-10-gallery"
    When I call the tool "mesha_view" with {"yaw": 15, "pitch": 10, "zoom": 5, "focus": 0.73}
    And I advance 4 frames
    Then I capture "human-11-afro-face"
    And I call the tool "mesha_state"

  Scenario: Export
    When I call the tool "mesha_export" with {"path": "test-artifacts/mesha-human-export.glb"}
    And I call the tool "mesha_state"
