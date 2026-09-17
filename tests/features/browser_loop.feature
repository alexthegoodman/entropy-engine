Feature: Scriptless browser loop

  Scenario: Follow a link and return through history
    Given the browser has loaded "https://example.com"
    When the browser follows "https://www.iana.org/domains/example"
    Then the current URL is "https://www.iana.org/domains/example"
    When the browser goes back
    Then the current URL is "https://example.com"
    When the browser goes forward
    Then the current URL is "https://www.iana.org/domains/example"

  Scenario: Bookmark the current page
    Given the browser has loaded "https://example.com"
    When the browser bookmarks the current page
    Then "https://example.com" is a bookmark

  Scenario: A failed navigation becomes visible state
    Given the browser has loaded "https://example.com"
    When the browser fetch fails for "https://invalid.example.test"
    Then the browser shows a fetch error
