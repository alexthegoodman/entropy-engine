Feature: No-code gameplay is an explicit reversible Play session
  Scenario: Create and wire logic in the editor, then save and play it
    Given a canvas surface is ready
    When I draw a stroke
    And I remember the artwork
    And I add a startup message without code
    Then gameplay has not started
    When I click "game_play"
    Then my authored message is shown
    When I click "game_play"
    Then the artwork matches exactly
    When I click "load_scene"
    And I click "game_play"
    Then my authored message is shown

  Scenario: All example behavior comes from the saved graph
    Given a canvas surface is ready
    When I open the playable example
    Then gameplay has not started
    When I click "mode_move"
    And I click the character face
    Then gameplay has not started
    When I click "game_play"
    Then the welcome message is shown
    When I click the character face
    Then the wave changes the geometry
    And the delayed reply is shown
    When I click the character face
    Then the completed wave does not restart
    When I click "game_play"
    Then the scene and graph are unchanged
    When I click "load_scene"
    And I click "game_play"
    Then the welcome message is shown
    When I click the character face
    And I click "game_play"
    Then pending actions were cancelled

  Scenario: Disconnecting the wire removes the example interaction
    Given a canvas surface is ready
    When I open the playable example
    And I disconnect the wave
    And I click "game_play"
    And I click the character face
    Then the disconnected click does nothing
    When I click "game_play"
    And I reconnect the wave
    And I attempt a graph loop
    And I click "game_play"
    And I click the character face
    Then the wave changes the geometry
    And the delayed reply is shown

  Scenario: Graph edits undo cleanly and incomplete targets prevent Play
    Given a canvas surface is ready
    When I open the playable example
    And I disconnect the wave
    And I click "undo"
    Then the graph has five wires
    When I select the click node
    And I name "logic_target" "0"
    And I click "game_play"
    Then Play requests a surface target
    When I click "undo"
    And I click "game_play"
    Then the welcome message is shown
