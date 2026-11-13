Feature: Parallax occlusion mapping on the Material Lab's wall
  Played with ENTROPY_MATERIALLAB_BDD_RESULT (tests/material_lab_live.rs). Each pose is captured
  with both halves of the wall in one mode (classic: what Allegiance shipped with; refined; full:
  refined plus self-shadow and depth; ultra: a slow reference). The test scores classic and
  refined against ultra, for fieldstone at three poses and for every material at one. A third
  scenario checks that depth writing makes a pole piercing the wall interleave with the relief.
  Captures land beside the result.

  Scenario: Fieldstone up close, straight on, slanted and nearly edge on
    Given the real Material Lab is running in test mode
    When I call the tool "lab_config" with {"material": "fieldstone", "sunAzimuth": 55, "sunElevation": 35, "left": "classic", "right": "classic"}
    And I call the tool "lab_view" with {"distance": 0.6, "yaw": 0, "pitch": 0, "x": 0, "y": 1.4, "fov": 60}
    And I call the tool "lab_config" with {"left": "classic", "right": "classic"}
    And I advance 4 frames
    Then I capture "straight-classic"
    And I call the tool "lab_config" with {"left": "refined", "right": "refined"}
    And I advance 4 frames
    Then I capture "straight-refined"
    And I call the tool "lab_config" with {"left": "full", "right": "full"}
    And I advance 4 frames
    Then I capture "straight-full"
    And I call the tool "lab_config" with {"left": "ultra", "right": "ultra"}
    And I advance 4 frames
    Then I capture "straight-ultra"
    And I call the tool "lab_view" with {"distance": 0.6, "yaw": 55, "pitch": 5, "x": 0, "y": 1.4, "fov": 60}
    And I call the tool "lab_config" with {"left": "classic", "right": "classic"}
    And I advance 4 frames
    Then I capture "slant-classic"
    And I call the tool "lab_config" with {"left": "refined", "right": "refined"}
    And I advance 4 frames
    Then I capture "slant-refined"
    And I call the tool "lab_config" with {"left": "full", "right": "full"}
    And I advance 4 frames
    Then I capture "slant-full"
    And I call the tool "lab_config" with {"left": "ultra", "right": "ultra"}
    And I advance 4 frames
    Then I capture "slant-ultra"
    And I call the tool "lab_view" with {"distance": 0.35, "yaw": 70, "pitch": 10, "x": 0, "y": 1.4, "fov": 60}
    And I call the tool "lab_config" with {"left": "classic", "right": "classic"}
    And I advance 4 frames
    Then I capture "grazing-classic"
    And I call the tool "lab_config" with {"left": "refined", "right": "refined"}
    And I advance 4 frames
    Then I capture "grazing-refined"
    And I call the tool "lab_config" with {"left": "full", "right": "full"}
    And I advance 4 frames
    Then I capture "grazing-full"
    And I call the tool "lab_config" with {"left": "ultra", "right": "ultra"}
    And I advance 4 frames
    Then I capture "grazing-ultra"

  Scenario: Every material at a slant
    Given the real Material Lab is running in test mode
    When I call the tool "lab_view" with {"distance": 0.6, "yaw": 55, "pitch": 5, "x": 0, "y": 1.4, "fov": 60}
    And I call the tool "lab_config" with {"material": "fieldstone", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-fieldstone-classic"
    And I call the tool "lab_config" with {"material": "fieldstone", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-fieldstone-refined"
    And I call the tool "lab_config" with {"material": "fieldstone", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-fieldstone-ultra"
    And I call the tool "lab_config" with {"material": "brick-red", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-brick-red-classic"
    And I call the tool "lab_config" with {"material": "brick-red", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-brick-red-refined"
    And I call the tool "lab_config" with {"material": "brick-red", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-brick-red-ultra"
    And I call the tool "lab_config" with {"material": "sandstone-blocks", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-sandstone-blocks-classic"
    And I call the tool "lab_config" with {"material": "sandstone-blocks", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-sandstone-blocks-refined"
    And I call the tool "lab_config" with {"material": "sandstone-blocks", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-sandstone-blocks-ultra"
    And I call the tool "lab_config" with {"material": "concrete", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-concrete-classic"
    And I call the tool "lab_config" with {"material": "concrete", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-concrete-refined"
    And I call the tool "lab_config" with {"material": "concrete", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-concrete-ultra"
    And I call the tool "lab_config" with {"material": "granite", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-granite-classic"
    And I call the tool "lab_config" with {"material": "granite", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-granite-refined"
    And I call the tool "lab_config" with {"material": "granite", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-granite-ultra"
    And I call the tool "lab_config" with {"material": "stucco", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-stucco-classic"
    And I call the tool "lab_config" with {"material": "stucco", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-stucco-refined"
    And I call the tool "lab_config" with {"material": "stucco", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-stucco-ultra"
    And I call the tool "lab_config" with {"material": "roof-clay", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-roof-clay-classic"
    And I call the tool "lab_config" with {"material": "roof-clay", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-roof-clay-refined"
    And I call the tool "lab_config" with {"material": "roof-clay", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-roof-clay-ultra"
    And I call the tool "lab_config" with {"material": "roof-cedar", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-roof-cedar-classic"
    And I call the tool "lab_config" with {"material": "roof-cedar", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-roof-cedar-refined"
    And I call the tool "lab_config" with {"material": "roof-cedar", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-roof-cedar-ultra"
    And I call the tool "lab_config" with {"material": "metal-corrugated", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-metal-corrugated-classic"
    And I call the tool "lab_config" with {"material": "metal-corrugated", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-metal-corrugated-refined"
    And I call the tool "lab_config" with {"material": "metal-corrugated", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-metal-corrugated-ultra"
    And I call the tool "lab_config" with {"material": "wood-oak", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-wood-oak-classic"
    And I call the tool "lab_config" with {"material": "wood-oak", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-wood-oak-refined"
    And I call the tool "lab_config" with {"material": "wood-oak", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-wood-oak-ultra"
    And I call the tool "lab_config" with {"material": "asphalt", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-asphalt-classic"
    And I call the tool "lab_config" with {"material": "asphalt", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-asphalt-refined"
    And I call the tool "lab_config" with {"material": "asphalt", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-asphalt-ultra"
    And I call the tool "lab_config" with {"material": "soil", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-soil-classic"
    And I call the tool "lab_config" with {"material": "soil", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-soil-refined"
    And I call the tool "lab_config" with {"material": "soil", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-soil-ultra"
    And I call the tool "lab_config" with {"material": "snow", "left": "classic", "right": "classic"}
    And I advance 3 frames
    Then I capture "mat-snow-classic"
    And I call the tool "lab_config" with {"material": "snow", "left": "refined", "right": "refined"}
    And I advance 3 frames
    Then I capture "mat-snow-refined"
    And I call the tool "lab_config" with {"material": "snow", "left": "ultra", "right": "ultra"}
    And I advance 3 frames
    Then I capture "mat-snow-ultra"

  Scenario: A pole through the wall sinks into the relief only with depth written
    Given the real Material Lab is running in test mode
    When I call the tool "lab_config" with {"material": "fieldstone", "sunAzimuth": 55, "sunElevation": 35, "pole": true, "left": "full", "right": "full", "leftOptions": {"depthWrite": false}, "rightOptions": {"depthWrite": false}}
    And I call the tool "lab_view" with {"distance": 0.7, "yaw": 40, "pitch": 5, "x": 0.4, "y": 1.4, "fov": 60}
    And I advance 4 frames
    Then I capture "pole-flat"
    When I call the tool "lab_config" with {"rightOptions": {"depthWrite": true}}
    And I advance 4 frames
    Then I capture "pole-depth"
