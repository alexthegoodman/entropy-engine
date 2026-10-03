Feature: Curated P2P rooms
  Scenario: Signed logs merge deterministically and survive reload
    Given a room with a pinned maintainer key
    When I merge signed publications in different orders and reload them
    Then the catalog and snapshot identities agree

  Scenario: Forged batches change no catalog state
    Given a room with a pinned maintainer key
    When I merge a valid publication followed by a forged entry
    Then the entire batch is rejected

  Scenario: Optional media fields retain their meaning under signatures
    Given a room with a pinned maintainer key
    When I publish and reload items with different optional media hints
    Then the hints round-trip and cannot reuse each other's signatures

  Scenario: Signatures cannot be replayed in another room or under another key
    Given a room with a pinned maintainer key
    When I replay a signed entry with different trust settings
    Then both replays are rejected

  Scenario: A maintainer sequence cannot describe two different events
    Given a room with a pinned maintainer key
    When I merge conflicting signed events at the same sequence
    Then the conflicting batch changes no catalog state

  Scenario: Tombstones prevent stale and later publication from resurrecting content
    Given a room with a pinned maintainer key
    When a tombstone arrives before stale and newer publications
    Then the content stays removed after merge and reload

  Scenario: Snapshots reject trailing data and unsupported schemas
    Given a room with a pinned maintainer key
    When I load malformed or unsupported snapshots
    Then all malformed snapshots are rejected

  Scenario: Oversized metadata and envelopes are rejected
    Given a room with a pinned maintainer key
    When I supply oversized catalog metadata or wire envelopes
    Then the size limits reject them

  Scenario: Unknown downloads and seeds cannot create a piece store
    Given a room with a pinned maintainer key
    When I attempt to download and serve an unlisted item
    Then neither operation creates files or sends requests

  Scenario: Only indexed pieces reach storage
    Given a room with a pinned maintainer key
    When a peer sends an unlisted piece before an indexed piece
    Then only the indexed content is verified and promoted

  Scenario: Both outbound message planes enforce the catalog
    Given a room with a pinned maintainer key
    When I send unlisted controls metadata and pieces
    Then the transport rejects all unlisted messages

  Scenario: A live tombstone stops an active download
    Given a room with a pinned maintainer key
    When I tombstone a stalled active download
    Then the download stops without promoting the file

  Scenario: Revocation applies to pending sends and existing channels
    Given a room with a pinned maintainer key
    When I revoke content after preparing a send and opening channels
    Then no prepared message can bypass the tombstone

  Scenario: A live tombstone stops serving stored pieces
    Given a room with a pinned maintainer key
    When I tombstone an active seeder
    Then the seeder stops and rejects further traffic

  Scenario: Encrypted KCP controls are filtered after decryption
    Given two KCP peers in the same room
    When the sender announces an unknown content id
    Then the receiver sees only catalog-listed controls

  Scenario: Wrong group codes cannot exchange application traffic
    Given two KCP peers in the same room
    When a peer with the wrong group code tries to join
    Then the foreign peer delivers no traffic

  Scenario: The socket interceptor rejects an unlisted peer in the same group
    Given two KCP peers in the same room
    When a peer outside the socket allowlist sends traffic
    Then the foreign peer delivers no traffic
