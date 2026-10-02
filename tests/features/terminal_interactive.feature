Feature: Interactive TUI programs run on the terminal's pseudo-terminal
  As a developer in Entropy Engine
  I want interactive tools like Claude Code and Codex to run inside the terminal
  So that I can drive them with forward slash commands without leaving the app

  Scenario: Claude Code trusts the folder, answers /help and quits on /exit
    Given the interactive program "claude" is installed
    When I start it in a new terminal session
    Then it should be running within 20000 ms
    And it should render output within 20000 ms
    When I trust the folder
    Then it should still be running after 8000 ms
    When I type "/help"
    Then it should still be running after 5000 ms
    When I type "/exit"
    Then it should exit within 20000 ms

  Scenario: Codex starts, renders, answers /help and quits on /exit
    Given the interactive program "codex" is installed
    When I start it in a new terminal session
    Then it should be running within 20000 ms
    And it should render output within 20000 ms
    When I type "/help"
    Then it should still be running after 5000 ms
    When I type "/exit"
    Then it should exit within 20000 ms
