Feature: 2D Matrix Heatmap with Multi-Colormap and Interactive Hover and Selection

  Each scenario drives the real entropy_gui::HeatmapView through a headless context,
  one frame at a time. Pointer input is built the way the window backend builds it
  (hover frames, press frames, click frames). What is drawn is rasterized on the CPU,
  verifying pixels and interaction facts. Pictures land in test-artifacts/heatmap/.

  Scenario: The heatmap renders a 2D grid matrix with cells and colorbar
    Given a heatmap with 4 rows and 5 columns of matrix data
    And row labels "Mon,Tue,Wed,Thu" and col labels "Q1,Q2,Q3,Q4,Q5"
    When a frame is drawn
    Then the heatmap space is not blank
    And the colorbar legend is rendered
    And I save the picture "heatmap-default-turbo"

  Scenario: Switching colormap to Magma changes cell colors
    Given a heatmap with 4 rows and 5 columns of matrix data
    And the heatmap colormap is "Magma"
    When a frame is drawn
    Then the heatmap space is not blank
    And I save the picture "heatmap-magma"

  Scenario: Switching colormap to Viridis and Phosphor
    Given a heatmap with 4 rows and 5 columns of matrix data
    And the heatmap colormap is "Viridis"
    When a frame is drawn
    Then the heatmap space is not blank
    And I save the picture "heatmap-viridis"
    When the heatmap colormap is set to "Phosphor"
    And a frame is drawn
    Then there is phosphor mint in the heatmap
    And I save the picture "heatmap-phosphor"

  Scenario: Switching colormap to Warm and Cool
    Given a heatmap with 4 rows and 5 columns of matrix data
    And the heatmap colormap is "Warm"
    When a frame is drawn
    Then the heatmap space is not blank
    And I save the picture "heatmap-warm"
    When the heatmap colormap is set to "Cool"
    And a frame is drawn
    Then the heatmap space is not blank
    And I save the picture "heatmap-cool"

  Scenario: Hovering over a cell displays tooltip and emits hover event
    Given a heatmap with 4 rows and 5 columns of matrix data
    And row labels "Mon,Tue,Wed,Thu" and col labels "Q1,Q2,Q3,Q4,Q5"
    When I hover over row 1 column 2
    Then a hover tooltip is displayed with row "Tue" and column "Q3"
    And a cell hover event was emitted for row 1 and column 2
    And I save the picture "heatmap-hover"

  Scenario: Clicking a cell selects it and emits cell clicked event
    Given a heatmap with 4 rows and 5 columns of matrix data
    When I click row 2 column 3
    Then a cell clicked event was emitted for row 2 and column 3
    And cell at row 2 column 3 is selected
    And I save the picture "heatmap-selected"

  Scenario: Clicking colormap toolbar pills switches the active colormap
    Given a heatmap with 4 rows and 5 columns of matrix data
    When I click the colormap pill "Viridis"
    Then the active colormap is "Viridis"
    And a colormap changed event was emitted for "Viridis"
    When I click the colormap pill "Magma"
    Then the active colormap is "Magma"
    And a colormap changed event was emitted for "Magma"

  Scenario: Explicit min and max value scaling clamps color mapping
    Given a heatmap with 4 rows and 5 columns of matrix data
    And the min value is 10.0 and max value is 50.0
    When a frame is drawn
    Then the heatmap space is not blank
    And I save the picture "heatmap-clamped"
