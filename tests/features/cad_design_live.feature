Feature: Contour Design in the real window
  Contour Design opens on the Skiff, a sample with nothing mirrored. Features keep their
  parameters, so the model can be reshaped at any point in its history and inspected as solid
  metal, as light, with zebra stripes or by curvature. A new design is drawn with the real
  pointer: a closed spline, raised into a body that leans, twists and bulges, lofted to a second
  profile on a tipped plane, deformed over part of its length and mirrored unevenly. Screenshots
  of the composed frame (3D viewport and panels) are kept for visual verification.

  Background:
    Given the real Contour Design app is running in test mode

  Scenario: The sample opens
    When I advance 30 frames
    Then I see the label "HISTORY"
    And I see the label "Hull"
    And I see the label "NOMINAL"
    And I capture "01-skiff"
    And I call the tool "cad_state"

  Scenario: Reshaping a feature deep in the history
    When I call the tool "cad_select" with {"id": "r1"}
    And I call the tool "cad_update" with {"id": "r1", "values": {"lobes": 9, "lobeDepth": 0.12, "squash": 0.8}}
    And I call the tool "cad_update" with {"id": "s3", "values": {"plane": {"tiltY": -14, "offset": 70}}}
    And I call the tool "cad_view" with {"yaw": 150, "pitch": 24}
    And I advance 8 frames
    Then I capture "02-reshaped"
    And I call the tool "cad_state"

  Scenario: Looking at the surfaces
    When I call the tool "cad_view" with {"mode": "holo", "yaw": 140, "pitch": 30}
    And I advance 8 frames
    Then I capture "03-holo"
    When I call the tool "cad_view" with {"mode": "zebra", "yaw": -40, "pitch": 35}
    And I advance 6 frames
    Then I capture "04-zebra"
    When I click "cad-view-mode"
    And I call the tool "cad_view" with {"mode": "curvature"}
    And I advance 6 frames
    Then I capture "05-curvature"
    And I call the tool "cad_view" with {"mode": "solid"}

  Scenario: A curve under its curvature comb
    When I call the tool "cad_edit_sketch" with {"id": "s3", "tool": "select", "select": ["e1"], "comb": true}
    And I advance 8 frames
    Then I see the label "SPLINE"
    And I capture "06-sketch-with-comb"
    When I click "cad-finish-sketch"
    And I advance 3 frames

  Scenario: Drawing a closed spline with the pointer
    When I call the tool "cad_new" with {"sample": "empty"}
    And I advance 4 frames
    And I click "cad-sketch-top"
    And I advance 8 frames
    And I send pointer "down" at "620" "420"
    And I send pointer "up" at "620" "420"
    And I send pointer "move" at "800" "330"
    And I advance 2 frames
    And I send pointer "down" at "800" "330"
    And I send pointer "up" at "800" "330"
    And I send pointer "move" at "960" "470"
    And I advance 2 frames
    And I send pointer "down" at "960" "470"
    And I send pointer "up" at "960" "470"
    And I send pointer "move" at "820" "640"
    And I advance 2 frames
    And I send pointer "down" at "820" "640"
    And I send pointer "up" at "820" "640"
    And I send pointer "move" at "700" "560"
    And I advance 2 frames
    Then I capture "07-drawing"
    When I send pointer "move" at "612" "427"
    And I advance 2 frames
    And I send pointer "down" at "612" "427"
    And I send pointer "up" at "612" "427"
    And I advance 4 frames
    Then I capture "08-closed-profile"
    And I call the tool "cad_state"

  Scenario: Raising it unevenly
    When I click "cad-finish-sketch"
    And I advance 3 frames
    And I click "cad-extrude"
    And I advance 6 frames
    Then I see the label "EXTRUDE · x1"
    When I call the tool "cad_update" with {"id": "x1", "values": {"forward": {"distance": 60, "twist": 50, "scale": [0.5, 0.8], "shift": [18, 0], "bulge": 0.3}, "backward": {"distance": 12, "scale": [0.8, 0.8]}}}
    And I call the tool "cad_view" with {"yaw": 30, "pitch": 25}
    And I advance 6 frames
    Then I capture "09-extruded"
    And I call the tool "cad_state"

  Scenario: Loft to a second profile on a tipped plane, then deform and mirror
    When I call the tool "cad_sketch" with {"name": "Crown", "plane": {"base": "top", "offset": 120, "tiltX": 22, "tiltY": -10}, "shapes": [{"type": "ellipse", "center": [20, 0], "rx": 26, "ry": 12, "rotation": 30}]}
    And I call the tool "cad_remove" with {"id": "x1"}
    And I click "cad-loft"
    And I advance 6 frames
    And I call the tool "cad_state"
    And I click "cad-twist"
    And I call the tool "cad_update" with {"id": "d1", "values": {"angle": 80, "from": 0.4, "to": 1, "smooth": true}}
    And I click "cad-mirror"
    And I call the tool "cad_update" with {"id": "m1", "values": {"plane": {"base": "side", "offset": -70}, "scale": [1, 0.7, 1.3]}}
    And I call the tool "cad_view" with {"yaw": 25, "pitch": 20}
    And I advance 8 frames
    Then I capture "10-loft-twist-mirror"
    And I call the tool "cad_state"

  Scenario: Undo, redo and export
    When I call the tool "cad_undo"
    And I call the tool "cad_undo" with {"redo": true}
    And I call the tool "cad_export" with {"format": "stl", "path": "test-artifacts/cad-design-live.stl"}
    And I call the tool "cad_export" with {"format": "obj", "path": "test-artifacts/cad-design-live.obj"}
    And I call the tool "cad_document"
    And I advance 2 frames
