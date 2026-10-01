Feature: Live 3D charts with Surface, Bar and Ribbon modes

  Each scenario drives the real entropy_gui::Chart3dView through a headless context,
  one frame at a time. Pointer input is built the way the window backend builds it
  (hover frames, press frames, drag frames, release frames). What is drawn is rasterized
  on the CPU, verifying pixels and interaction facts. Pictures land in test-artifacts/chart3d/.

  Scenario: The 3D chart renders Surface mode with ridges and backdrop
    Given a 3D chart with 3 series and 4 categories
    And the chart type is "Surface"
    When a frame is drawn
    Then the chart space is not blank
    And there is neon teal in the chart
    And I save the picture "chart3d-surface"

  Scenario: Switching to Bar mode draws 3D shaded columns
    Given a 3D chart with 3 series and 4 categories
    And the chart type is "Bar"
    When a frame is drawn
    Then the chart space is not blank
    And I save the picture "chart3d-bar"

  Scenario: Switching to Ribbon mode draws parallel 3D ribbons
    Given a 3D chart with 3 series and 4 categories
    And the chart type is "Ribbon"
    When a frame is drawn
    Then the chart space is not blank
    And I save the picture "chart3d-ribbon"

  Scenario: Dragging rotates the orbit camera
    Given a 3D chart with 3 series and 4 categories
    When I drag the pointer by 40 pixels horizontally and 20 pixels vertically
    Then the camera turned
    And I save the picture "chart3d-orbit"

  Scenario: Mouse wheel zooms the camera
    Given a 3D chart with 3 series and 4 categories
    When I scroll the wheel by 50 units
    Then the camera zoom increased

  Scenario: Clicking camera presets updates the camera angles
    Given a 3D chart with 3 series and 4 categories
    When I click the toolbar button "Top"
    Then the camera pitch is at maximum
    When I click the toolbar button "Front"
    Then the camera pitch is near the floor
    When I click the toolbar button "Reset"
    Then the camera is at default orientation

  Scenario: Clicking chart type pills changes chart mode and emits events
    Given a 3D chart with 3 series and 4 categories
    When I click the toolbar button "Bar"
    Then the chart type changed to "Bar"
    When I click the toolbar button "Ribbon"
    Then the chart type changed to "Ribbon"
    When I click the toolbar button "Surface"
    Then the chart type changed to "Surface"

  Scenario: Hovering over a data point reports series, category, and value
    Given a 3D chart with 3 series and 4 categories
    When I hover over series 0 category 1
    Then a hover tooltip is displayed with series "SaaS" and category "Q2"
    And the hover value is about 145
    And I save the picture "chart3d-hover"
