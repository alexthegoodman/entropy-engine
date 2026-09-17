@live-ui
Feature: Real HTML browser checkpoints

  This feature is the actual source of BrowserBddDriver's live-tier action sequence
  (src/startup.rs parses this file with the `gherkin` crate at startup, when
  ENTROPY_BROWSER_BDD_RESULT is set) - not documentation of it. Editing a step here
  changes what the live run against the real windowed app does.
  #
  # Recognized step shapes (see browser_bdd_action_from_step in src/startup.rs):
  #   I click "<control-id>"
  #   I set "<control-id>" to "<value>"
  #   I follow the HTML link through "<canvas-control-id>" to "<url>"
  #   I advance <N> frames
  #   I capture "<name>"
  # Any step text that doesn't match one of those shapes fails the run immediately -
  # there is no silent no-op fallback for a typo.

  Scenario: Load example.com
    Given the real browser demo is running in test mode
    When I click "browser-mode-webpage"
    And I advance 2 frames
    And I set "browser-url" to "https://example.com"
    And I advance 1 frames
    And I click "browser-go"
    # Entropy.Net's fetch is polled once per rendered frame, not awaited - a real DNS
    # lookup and TLS handshake to example.com routinely takes longer than a handful of
    # frames at this machine's render rate, so this waits for a real settle rather than
    # risking a screenshot of the transient "Fetching..." state.
    And I advance 120 frames
    Then I capture "loading-example"

  Scenario: Follow a link and use history
    When I advance 3 frames
    And I follow the HTML link through "browser-page" to "https://www.iana.org/domains/example"
    And I advance 120 frames
    And I click "browser-back"
    And I advance 2 frames
    And I click "browser-forward"
    And I advance 3 frames
    Then I capture "history"

  Scenario: Bookmark a page
    When I advance 3 frames
    And I click "browser-bookmark"
    And I advance 3 frames
    Then I capture "bookmark"

  Scenario: Failed navigation is visible
    When I advance 3 frames
    And I set "browser-url" to "https://invalid.example.test"
    And I advance 1 frames
    And I click "browser-go"
    And I advance 120 frames
    Then I capture "error"
