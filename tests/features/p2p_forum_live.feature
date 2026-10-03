Feature: Two real P2P forum windows exchange member posts
  Scenario: The maintainer is offline while members publish and read each other
    Given the real P2P forum is running in test mode
    When I call the tool "p2p_forum" with {"action":"join","config":{forum_config}}
    And I wait 3000 milliseconds
    And I set "forum_title" to "{forum_title}"
    And I set "forum_body" to "{forum_body}"
    And I click "forum_publish"
    And I wait 12000 milliseconds
    And I call the tool "p2p_forum" with {"action":"fetchTitle","title":"{forum_other_title}"}
    And I wait 12000 milliseconds
    Then I see the label "{forum_other_body}"
    And I capture "forum-{forum_role}"
    And I call the tool "p2p_forum" with {"action":"state"}
    And I wait 3000 milliseconds
