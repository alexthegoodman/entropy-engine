Feature: Member publishing and moderated P2P rooms
  Scenario: Members publish posts and videos without the maintainer online
    Given a room with a pinned maintainer key
    When two members independently publish a post and a video
    Then member publishing and moderation invariants hold

  Scenario: Only the original author can withdraw a publication
    Given a room with a pinned maintainer key
    When a stranger withdraws another member's publication before its arrival
    Then member publishing and moderation invariants hold

  Scenario: Members cannot exercise maintainer authority
    Given a room with a pinned maintainer key
    When a member attempts each maintainer-only action
    Then member publishing and moderation invariants hold

  Scenario: Publication removal differs from blocking shared content
    Given a room with a pinned maintainer key
    When the maintainer removes one of two publications sharing a payload
    Then member publishing and moderation invariants hold

  Scenario: Author bans survive stale and future publications and reload
    Given a room with a pinned maintainer key
    When an author ban arrives before stale and future publications
    Then member publishing and moderation invariants hold

  Scenario: Room policy converges and conflicting policy fails closed
    Given a room with a pinned maintainer key
    When room publishing policy changes arrive out of order
    Then member publishing and moderation invariants hold

  Scenario: Signed metadata bootstraps payload permission without downloading content
    Given a room with a pinned maintainer key
    When a peer exchanges signed room metadata before any payload is listed
    Then member publishing and moderation invariants hold

  Scenario: The deferred record ceiling still rejects overflow atomically
    Given a room with a pinned maintainer key
    When a member fills the current record capacity
    Then member publishing and moderation invariants hold

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

  Scenario: Signatures cannot be replayed in another room or under another author key
    Given a room with a pinned maintainer key
    When I replay a signed entry with different trust settings
    Then both replays are rejected

  Scenario: Conflicting author sequences converge without arrival-order dependence
    Given a room with a pinned maintainer key
    When I merge conflicting signed events at the same sequence
    Then conflicting publications converge to hidden records

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

  Scenario: A member withdrawal stops an active download
    Given a room with a pinned maintainer key
    When I withdraw a stalled active download
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
