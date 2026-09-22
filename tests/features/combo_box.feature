Feature: A dropdown's popup scrolls instead of spilling past its own panel

  entropy_gui::widgets::ComboBox backs both an internal editor dropdown and the addon-facing
  Widget.dropdown (see addon_engine.rs's UiWidget::Dropdown, which draws through this exact type).
  Each scenario drives it through a headless context. Pictures land in test-artifacts/combo-box/.

  Scenario: A short list fits inside the popup with no scrolling
    Given a dropdown with 3 items
    When I open the dropdown
    Then item 2 is inside the popup
    When I click item 2
    Then item 2 was clicked

  Scenario: A long list starts with its later rows outside the popup's own panel
    Given a dropdown with 30 items
    When I open the dropdown
    Then item 20 is outside the popup
    And I save the picture "combo-long-unscrolled"

  Scenario: Scrolling all the way down reaches the last row and it can be clicked
    Given a dropdown with 30 items
    When I open the dropdown
    And I scroll the popup by 100000 points
    Then item 29 is inside the popup
    And I save the picture "combo-long-scrolled"
    When I click item 29
    Then item 29 was clicked
