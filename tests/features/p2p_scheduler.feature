Feature: Bounded P2P piece scheduling
  Scenario: Bulk downloads fetch the rarest available piece first
    Given a swarm with complementary piece maps
    When I schedule a bulk download
    Then piece 3 is requested first

  Scenario: A swarm completes without duplicate requests
    Given a swarm with complementary piece maps
    When I download all pieces from the swarm
    Then every piece is fetched once and the download is complete

  Scenario: Request caps apply globally and per peer
    Given a swarm with complementary piece maps
    When I fill the request pipeline
    Then the pipeline stays within both caps

  Scenario: Seek cancels the old window and requests the new one
    Given a swarm with complementary piece maps
    When I seek from piece 0 to piece 4
    Then the old requests are cancelled and pieces 4 and 5 are requested

  Scenario: Overlapping seek preserves useful requests
    Given a swarm with complementary piece maps
    When I move the window forward by one piece
    Then the overlapping request stays active

  Scenario: Sequential playback advances through the whole content
    Given a swarm with complementary piece maps
    When I download successive playback windows
    Then every piece is fetched once and the download is complete

  Scenario: A timed out request switches source
    Given a swarm with complementary piece maps
    When a request for piece 0 times out
    Then the retry uses another peer and a late response is ignored

  Scenario: Peer loss releases requests
    Given a swarm with complementary piece maps
    When a peer disconnects with a pending request
    Then another peer supplies that piece

  Scenario: Invalid and unavailable indices are never requested
    Given a peer advertises invalid and unavailable pieces
    When I schedule a bulk download
    Then only the valid available piece is requested
