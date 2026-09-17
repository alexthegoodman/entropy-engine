@live-ui
Feature: Real HTML browser checkpoints

  Scenario: Load example.com
    Given the real browser demo is running in test mode
    When I set "browser-url" to "https://example.com"
    And I click "browser-go"
    And I advance 3 frames
    Then I capture "loading-example"

  Scenario: Follow a link and use history
    When I follow the HTML link through "browser-page"
    And I click "browser-back"
    And I click "browser-forward"
    Then I capture "history"

  Scenario: Bookmark a page
    When I click "browser-bookmark"
    Then I capture "bookmark"

  Scenario: Failed navigation is visible
    When I set "browser-url" to "https://invalid.example.test"
    And I click "browser-go"
    Then I capture "error"
