Feature: Long-lived P2P forum room

  Scenario: Independent publishing, restart, re-seeding and durable moderation
    Given four isolated forum profiles and a metadata tracker
    When members A and B publish with the maintainer offline
    Then member C sees both signed publications
    When C downloads both posts and A and B leave
    Then a fresh reader downloads both bodies from C
    When C restarts and publishes again
    Then its author key survives and its sequence increases
    When the maintainer removes a publication and a stale member returns
    Then every connected reader keeps that publication hidden

  Scenario: An unavailable post keeps its metadata without downloading a body
    Given four isolated forum profiles and a metadata tracker
    When an offline author publishes metadata without a seeder
    Then C lists the post as having no seeders and no cached body

  Scenario: A banned author's publish command reports failure
    Given four isolated forum profiles and a metadata tracker
    When members A and B publish with the maintainer offline
    Then member C sees both signed publications
    When the maintainer bans A and A tries to publish again
    Then A receives a publication error and no new post appears

  Scenario: Tracker outage and profile isolation
    Given four isolated forum profiles and a metadata tracker
    When the tracker stops and a member publishes
    Then configured peers replicate and download without the tracker
    When the tracker returns
    Then pending publications reach its durable snapshot
    Then a second service cannot share the author's profile

  Scenario: Tracker discovery supplies a reader with no bootstrap peers
    Given four isolated forum profiles and a metadata tracker
    When members A and B publish with the maintainer offline
    Then member C sees both signed publications
    When a reader joins with an empty bootstrap list
    Then it discovers sources and downloads both verified bodies

  Scenario: Policy closure preserves caches and withdrawal propagates
    Given four isolated forum profiles and a metadata tracker
    When members A and B publish with the maintainer offline
    Then member C sees both signed publications
    When C downloads both posts and A and B leave
    When the maintainer closes the room and C restarts
    Then member publications are hidden
    When the maintainer reopens the room
    Then C's verified cached posts are visible and seeded again
    When member A withdraws its publication
    Then every connected reader keeps that publication hidden
