Feature: Terminal Addon and TerminalView Widget
  As a developer in Entropy Engine
  I want a real interactive terminal running commands on a pseudo-terminal
  So that I can run shell commands, round-trip stdin, and get coloured output

  Scenario: Built-in commands navigate directories and clear screen
    Given a new terminal session "test-sess-1"
    When I execute terminal command "pwd"
    Then the session output should contain the current working directory
    When I execute terminal command "clear"
    Then the session output should be empty

  Scenario: Real OS process execution and stdout streaming
    Given a new terminal session "test-sess-2"
    When I execute terminal command "echo Hello Entropy Terminal"
    Then the command should start a background process
    And after waiting up to 5000 ms the process should finish with exit code 0
    And the session output should contain "Hello Entropy Terminal"

  Scenario: Interactive stdin round-trips on the pseudo-terminal
    Given a new terminal session "test-sess-stdin"
    When I start an echo-back process
    Then the session is currently running
    When I type "hello" into the terminal
    Then the session output should contain "got:hello"
    When I terminate the running process
    Then the process should be stopped within 2000 ms

  Scenario: Process termination kills a running background task
    Given a new terminal session "test-sess-3"
    When I execute long running command "powershell -Command Start-Sleep -Seconds 10"
    Then the session is currently running
    When I terminate the running process
    Then the process should be stopped within 2000 ms

  Scenario: TerminalView widget renders a screen grid
    Given a terminal screen with 5 rows
    When I render the terminal view
    Then the widget allocates space and renders draw commands

  Scenario: ANSI colour is parsed into red and green cells
    Given a parser fed with red and green text
    Then the screen has red and green cells

  Scenario: Terminal font catalog provides canonical names
    Given the terminal font catalog
    Then it contains at least 50 fonts
    And it contains "Quicksand"
    And it contains "Figtree"

  Scenario: Raw key probe
    Given a new terminal session "probe"
    When I probe raw key delivery
