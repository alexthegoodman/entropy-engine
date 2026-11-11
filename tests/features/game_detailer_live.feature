Feature: The Game World Detailer in the real window
  The Detailer opens a world from the Game World Planner's own library in 3D. With an empty
  library it makes the sample world (the Shattered Isles with its capital and village laid out,
  woods and fields painted, a guard and a pack of creatures) through its own button. Mesha models
  are evaluated in the worker and drawn instanced; the ground, its building pads and road beds,
  scatter from the painted woods. Then editing: a house is selected and moved (it moves in the
  plan), every inn becomes another Mesha object, a house is varied, a prop is placed, the view is
  saved as a site, the world is walked in Preview World (third and first person), and the whole
  level is exported as a zip. Screenshots of every step are kept
  for visual verification. Frames are slow under software rendering, so waits are in time: the
  worker builds models whatever the frame rate.

  Background:
    Given the real Game World Detailer is running in test mode

  Scenario: An empty library offers a sample world, which opens on the capital
    When I advance 8 frames
    Then I see the label "No world open"
    When I click "gd-sample"
    And I advance 4 frames
    And I call the tool "game_detailer_state"
    And I wait 45000 milliseconds
    And I advance 6 frames
    Then I capture "01-capital"
    And I call the tool "game_detailer_state"

  Scenario: Up close, from another side, and in the woods
    When I call the tool "game_detailer_view" with {"distanceM": 70, "yawDeg": 160, "pitchDeg": 22}
    And I wait 15000 milliseconds
    And I advance 6 frames
    Then I capture "02-street-level"
    When I call the tool "game_detailer_view" with {"offsetM": [-1150, 250], "distanceM": 90, "yawDeg": 60, "pitchDeg": 18}
    And I wait 40000 milliseconds
    And I advance 6 frames
    Then I capture "03-woods"
    And I call the tool "game_detailer_state"

  Scenario: Select a house and move it: the plan changes
    When I call the tool "game_detailer_view" with {"nearest": {"source": "structure", "kind": "house"}, "distanceM": 60, "yawDeg": 30, "pitchDeg": 30}
    And I call the tool "game_detailer_select" with {"nearest": {"source": "structure", "kind": "house"}}
    And I advance 6 frames
    Then I capture "04-house-selected"
    When I call the tool "game_detailer_move" with {"dxM": 12, "dzM": -4, "yawDeg": 25}
    And I advance 6 frames
    Then I capture "05-house-moved"
    And I call the tool "game_detailer_state"
    And I call the tool "game_detailer_save"

  Scenario: Every inn another model, a house varied, a prop, a site
    When I call the tool "game_detailer_set_model" with {"nearest": {"source": "structure", "kind": "inn"}, "scope": "kind", "objectId": "architecture.arcane_emporium"}
    And I call the tool "game_detailer_vary" with {"nearest": {"source": "structure", "kind": "house"}, "amount": 0.7, "seed": 4}
    And I call the tool "game_detailer_add_prop" with {"objectId": "street.barrel", "scale": 1.2}
    And I call the tool "game_detailer_site" with {"name": "Capital square"}
    And I call the tool "game_detailer_view" with {"lighting": "warm"}
    And I wait 30000 milliseconds
    And I advance 6 frames
    Then I capture "06-detailed-warm"
    And I call the tool "game_detailer_items" with {"radiusKm": 0.05, "source": "prop"}
    And I call the tool "game_detailer_state"

  Scenario: Preview World: walk the capital in third and first person
    When I click "gd-preview"
    And I advance 4 frames
    And I call the tool "game_detailer_preview" with {"action": "state"}
    And I call the tool "game_detailer_preview" with {"walk": {"forward": 1, "seconds": 5}}
    And I wait 7000 milliseconds
    And I advance 6 frames
    Then I capture "07-preview-third-person"
    And I call the tool "game_detailer_preview" with {"action": "state"}
    When I call the tool "game_detailer_preview" with {"view": "first", "lookPitchDeg": -4}
    And I wait 3000 milliseconds
    And I advance 6 frames
    Then I capture "08-preview-first-person"
    When I call the tool "game_detailer_preview" with {"action": "stop"}
    And I advance 2 frames

  Scenario: Export the level
    When I call the tool "game_detailer_export" with {"path": "test-artifacts/game-detailer-live/level.zip"}
    And I advance 2 frames
    And I call the tool "game_detailer_save"
