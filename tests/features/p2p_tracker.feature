Feature: Public metadata rendezvous with pinned trust and volatile availability

  Scenario: Independent publishing
    Given a local tracker with one member publication
    When two independent members publish with the maintainer offline
    Then the tracker preserves the required behavior

  Scenario: Idempotent metadata
    Given a local tracker with one member publication
    When the same signed records arrive twice
    Then the tracker preserves the required behavior

  Scenario: Atomic verification
    Given a local tracker with one member publication
    When invalid and unauthorized record batches arrive
    Then the tracker preserves the required behavior

  Scenario: Discovery hints
    Given a local tracker with one member publication
    When a signed peer announces eligible content
    Then the tracker preserves the required behavior

  Scenario: Offline seeder
    Given a local tracker with one member publication
    When the last seeder lease expires and is replayed
    Then the tracker preserves the required behavior

  Scenario: Replay protection
    Given a local tracker with one member publication
    When a replay attempts to refresh the existing lease
    Then the tracker preserves the required behavior

  Scenario: Live moderation
    Given a local tracker with one member publication
    When moderation arrives after a live announcement
    Then the tracker preserves the required behavior

  Scenario: Durable restart
    Given a local tracker with one member publication
    When the tracker restarts after a live announcement
    Then the tracker preserves the required behavior

  Scenario: Pinned startup and client trust
    Given a local tracker with one member publication
    When foreign room pins and corrupted persisted records are supplied
    Then the tracker preserves the required behavior

  Scenario: Untrusted announcements
    Given a local tracker with one member publication
    When unlisted forged stale and foreign-address announcements arrive
    Then the tracker preserves the required behavior

  Scenario: Request rate limit
    Given a local tracker with one member publication
    When one source exceeds the request rate limit
    Then the tracker preserves the required behavior

  Scenario: Bounded live table
    Given a local tracker with one member publication
    When peer hints reach their per-content capacity
    Then the tracker preserves the required behavior

  Scenario: Metadata only and bounded uploads
    Given a local tracker with one member publication
    When oversized bodies and payload endpoints are requested
    Then the tracker preserves the required behavior

  Scenario: Persistence failure is atomic
    Given a local tracker with one member publication
    When a persistence write fails before commit
    Then the tracker preserves the required behavior

  Scenario: Concurrent durable union
    Given a local tracker with one member publication
    When concurrent publishers merge into one durable index
    Then the tracker preserves the required behavior

  Scenario: Strict bounded framing
    Given a local tracker with one member publication
    When malformed HTTP framing and missing lengths arrive
    Then the tracker preserves the required behavior

  Scenario: Client distrusts tracker
    Given a local tracker with one member publication
    When the client receives an oversized or forged tracker response
    Then the tracker preserves the required behavior

  Scenario: Shutdown owns incomplete connections
    Given a local tracker with one member publication
    When the tracker shuts down with an incomplete request
    Then the tracker preserves the required behavior
