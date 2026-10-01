Feature: Terminal Addon and TerminalView Widget
  As a developer or non-technical user in Entropy Engine
  I want a real interactive terminal with one-click conveniences and modern fonts
  So that I can run commands, connect AI agents via MCP, and read output comfortably

  Scenario: Built-in commands navigate directories and clear screen
    Given a new terminal session "test-sess-1"
    When I execute terminal command "pwd"
    Then the session should have 2 lines
    And line 2 text should contain the current working directory
    When I execute terminal command "clear"
    Then the session output should be empty

  Scenario: Real OS process execution and stdout streaming
    Given a new terminal session "test-sess-2"
    When I execute terminal command "echo Hello Entropy Terminal"
    Then the command should start a background process
    And after waiting up to 5000 ms the process should finish with exit code 0
    And the session output should contain "Hello Entropy Terminal"

  Scenario: Process termination kills running background task
    Given a new terminal session "test-sess-3"
    When I execute long running command "powershell -Command Start-Sleep -Seconds 10"
    Then the session is currently running
    When I terminate the running process
    Then the process should be stopped within 2000 ms
    And the session output should contain "terminated"

  Scenario: TerminalView widget renders with custom catalog fonts
    Given a terminal view with 5 output lines
    When I render the terminal view with font "Quicksand" and size 14
    Then the widget allocates space and renders draw commands
    When I render the terminal view with font "Lexend" and theme "Obsidian"
    Then the widget renders with non-zero draw commands

  Scenario: Terminal font catalog provides canonical names
    Given the terminal font catalog
    Then it contains at least 50 fonts
    And it contains "Quicksand"
    And it contains "Figtree"
    And it contains "Lexend"
