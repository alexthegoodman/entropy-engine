Feature: The app launcher's install list and feed

  @fast
  Scenario: Installing an app puts it on the home grid
    Given the launcher has installed "daw"
    When the launcher installs "stylus-drawing"
    Then "stylus-drawing" is installed
    And the home grid has 2 apps

  @fast
  Scenario: Installing the same app twice does not duplicate it
    Given the launcher has installed "daw"
    When the launcher installs "daw"
    Then the home grid has 1 apps

  @fast
  Scenario: Removing an app takes it off the home grid and back into Discover
    Given the launcher has installed "daw"
    When the launcher removes "daw"
    Then "daw" is not installed
    And the home grid has 0 apps
    And "daw" is offered in Discover

  @fast
  Scenario: Discover only offers what is not installed
    Given the launcher has installed "daw"
    Then "daw" is not offered in Discover

  @fast
  Scenario: The feed panel keeps only the latest two posts
    Given the feed has 5 posts
    When the launcher reads the feed
    Then the feed panel shows 2 posts
    And the first feed post is "Post 1"

  @fast
  Scenario: A feed with one post shows one post
    Given the feed has 1 posts
    When the launcher reads the feed
    Then the feed panel shows 1 posts

  @fast
  Scenario: An unknown example name is refused before anything is launched
    When the launcher tries to launch "notepad"
    Then the launch is refused

  @fast
  Scenario: An example on the allow-list is accepted
    When the launcher tries to launch "theme-gallery"
    Then the launch is allowed
