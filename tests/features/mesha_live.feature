Feature: Mesha in the real window
  Mesha opens on a procedural office chair. Variation explores sensible designs while locked
  controls stay put, the library adds more objects that compose into a scene, switching the base
  swaps wheels for legs, and the scene exports as ordinary GLB geometry. Screenshots of the
  composed frame (3D viewport and panels) are kept for visual verification.

  Background:
    Given the real Mesha app is running in test mode

  Scenario: The first object
    When I advance 30 frames
    Then I see the label "Add object"
    And I see the label "Scene"
    And I capture "01-office-chair"

  Scenario: Variation keeps what is locked
    When I call the tool "mesha_lock" with {"keys": ["seatHeight", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 3}
    And I advance 6 frames
    Then I capture "02-variation"
    When I click "mesha-vary"
    And I advance 6 frames
    Then I capture "03-variation-from-the-button"
    And I call the tool "mesha_state"

  Scenario: Four legs instead of wheels
    When I call the tool "mesha_set" with {"values": {"base": "legs", "legStyle": "tapered", "baseFinish": "wood.walnut", "headrest": false, "backHeight": 0.45}}
    And I advance 6 frames
    Then I capture "04-four-legs"
    And I call the tool "mesha_describe" with {"objectId": "furniture.office_chair"}

  Scenario: Composing a scene
    When I call the tool "mesha_add" with {"objectId": "furniture.table", "preset": "Bistro round", "position": [1.1, 0, 0]}
    And I call the tool "mesha_add" with {"objectId": "household.bottle", "preset": "Bordeaux", "position": [1.05, 0.74, 0.08]}
    And I call the tool "mesha_add" with {"objectId": "nature.rock", "preset": "River stones", "position": [-0.9, 0, 0.6]}
    And I call the tool "mesha_view" with {"all": true, "yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "05-scene"
    When I call the tool "mesha_view" with {"lighting": "warm"}
    And I advance 4 frames
    Then I capture "06-warm-evening"

  Scenario: Undo and export
    When I call the tool "mesha_undo"
    And I call the tool "mesha_undo" with {"redo": true}
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-live-export.glb"}
    And I call the tool "mesha_state"

  Scenario: Window count 4 to 6 on a composed facade
    When I call the tool "mesha_add" with {"objectId": "architecture.facade", "values": {"windowCount": 4}, "position": [0, 0, -4]}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 12}
    And I advance 8 frames
    Then I capture "07-facade-four-windows"
    When I call the tool "mesha_set" with {"values": {"windowCount": 6}}
    And I call the tool "mesha_view" with {"yaw": 20, "pitch": 12}
    And I advance 8 frames
    Then I capture "08-facade-six-windows"

  Scenario: A sculptural lamp can be customized and varied with its finishes locked
    When I call the tool "mesha_add" with {"objectId": "household.table_lamp", "preset": "Stoneware linen", "position": [5, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18, "lighting": "studio"}
    And I advance 8 frames
    Then I capture "09-lamp-stoneware"
    When I call the tool "mesha_set" with {"values": {"height": 0.34, "shadeRadius": 0.16, "shadeShape": "dome", "shadeShare": 0.32, "baseShape": "column", "baseWidth": 0.4, "baseShare": 0.9, "shadeFinish": "paint.sage", "baseFinish": "paint.sage", "rim": false}}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "10-lamp-mushroom"
    When I call the tool "mesha_lock" with {"keys": ["height", "group:materials"], "locked": true}
    And I call the tool "mesha_vary" with {"amount": 0.8, "seed": 12}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 18}
    And I advance 8 frames
    Then I capture "11-lamp-variation"
    When I call the tool "mesha_add" with {"objectId": "household.table_lamp", "preset": "Walnut reading", "position": [7, 0, 0]}
    And I call the tool "mesha_view" with {"yaw": 30, "pitch": 28}
    And I advance 8 frames
    Then I capture "12-lamp-walnut"
    And I call the tool "mesha_export" with {"path": "test-artifacts/mesha-lamps-export.glb"}
