@live-ui
Feature: The app launcher's glass home screen, live

  This file is the actual source of the launcher's live-tier action sequence: src/startup.rs
  parses it with the `gherkin` crate at startup when ENTROPY_LAUNCHER_BDD_RESULT is set, so
  editing a step here changes what the real windowed run does. Step shapes are the same ones
  every other live feature uses (browser_bdd_action_from_step in src/startup.rs); anything it
  does not recognize fails the run rather than being skipped.

  Scenario: The home screen comes up over the drifting backdrop
    Given the real app launcher is running in test mode
    # The RSS fetch hits the real https://indie-machine.com/rss.xml and is polled once per
    # rendered frame; it may still fail here if this machine has no network access (a sandboxed
    # CI runner, for instance), so this waits long enough for the panel to settle on either the
    # real posts or the honest "couldn't reach" line before anything is captured.
    When I advance 150 frames
    Then I see the label "Installed"
    And I see the label "DAW"
    And I see the label "Latest posts"
    And I capture "launcher-01-home"

  Scenario: The blurred backdrop keeps up with the scene
    # Nothing is clicked here on purpose: the only thing that changes between this capture and
    # the one above is the drifting camera, so any difference inside a glass panel's own rect has
    # to have come through the glass.
    When I advance 150 frames
    Then I capture "launcher-02-drifted"

  Scenario: Discover installs another app
    When I click "show_discover"
    And I advance 3 frames
    Then I see the label "Discover"
    And I see the label "Stylus Drawing"
    And I capture "launcher-03-discover"
    When I click "install-stylus-drawing"
    And I advance 3 frames
    And I click "show_home"
    And I advance 3 frames
    Then I see the label "Installed"
    And I see the label "Stylus Drawing"
    And I capture "launcher-04-installed"

  Scenario: Opening an installed app starts a real process
    # The status line carries the child's pid, which is not knowable from here - the harness
    # asserts on the pid the launcher persisted instead, and kills that process afterwards.
    When I click "launch-theme-gallery"
    And I advance 30 frames
    Then I capture "launcher-05-launched"
