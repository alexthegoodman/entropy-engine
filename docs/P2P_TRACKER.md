# Local P2P tracker

Phase 7 is a public metadata service for one locally configured room. The room ID and maintainer
public key come from trusted operator configuration. The tracker has no author private key, group
code, transport PSK, file store, payload endpoint or outbound peer connections.

```bash
cargo run --bin tracker -- --room-id <64 hex digits> --maintainer-key <64 hex digits> --index ./tracker/room.msgpack --bind 127.0.0.1:47110
cargo test -j 1 --offline --test p2p_tracker_bdd --test p2p_session
```

Default bind is `127.0.0.1:47110`; port zero selects a free local port and prints `TRACKER_READY`.
Ctrl+C stops accepting connections and drains active requests. One process must own each snapshot
path. Preserve both public pins across restarts; the maintainer pin is not embedded in the room
snapshot. Wrong-room, corrupt, noncanonical or unauthorized stored records fail startup. An empty
or member-only snapshot cannot attest which maintainer key is correct: that trust stays external.

The local server uses a narrow HTTP/1.1 interface with explicit Content-Length uploads and one
request per connection. Chunked uploads, Expect, duplicate lengths and oversized headers fail.
It serves plain HTTP. Internet hosting, HTTPS termination and deployment configuration are later
work. Source identity uses the TCP connection IP; forwarded headers are ignored. A reverse proxy
would therefore need an explicit source-IP design before use. Local clients can use loopback
addresses; ordinary Internet peers must use their observed external IP and a candidate transport
port. HTTP cannot discover a NAT mapping or punch a transport route.

## HTTP API

All IDs in URL paths are 64 lowercase hexadecimal digits. Requests only address the configured
room; callers cannot add rooms or select trust keys. Unknown rooms/operations return 404.

| Rust client method | HTTP path | Body / response |
| --- | --- | --- |
| `get_index()` | `GET /v1/rooms/{room}/index` | Canonical schema-2 MessagePack snapshot, `application/msgpack`. |
| `put_records(&batch)` | `PUT /v1/rooms/{room}/records` | Canonical schema-2 snapshot batch, `application/msgpack`; union is verified atomically under pinned authority. |
| `put_announce(&claim)` | `PUT /v1/rooms/{room}/announce` | Signed announcement JSON, `application/json`; content must currently be eligible. |
| `get_peers(content)` | `GET /v1/rooms/{room}/peers/{content}` | JSON array of signed, unexpired connection hints; unknown/removed content returns `[]`. |

Successful writes return `{}`. Invalid metadata/claims return 400, ineligible announcement content
403, missing upload length 411, oversized bodies 413, wrong content type 415, rate/table limits
429 and oversized headers 431. Persistence failure returns 500. Writes verify before touching disk,
write and sync a sibling `.pending` file, then replace the committed snapshot before acknowledging.
Startup loads only the committed snapshot; an interrupted pending write cannot replace it.
Duplicate snapshots do not rewrite disk. Live availability is never persisted.

## Client example

```rust
use entropy_engine::p2p::{
    index::SigningKey,
    rendezvous::{Announcement, RendezvousClient, unix_seconds},
};

// `room`, `maintainer_public_key`, `publication_batch`, and `content_id` are locally
// pinned/verified values. `discovery_key` is local PKCS#8, never sent to the tracker.
async fn example(room: [u8;32], maintainer_public_key: [u8;32],
    publication_batch: entropy_engine::p2p::index::RoomIndex, content_id: [u8;32],
    discovery_key: Vec<u8>) -> anyhow::Result<()> {
    let client = RendezvousClient::new("http://127.0.0.1:47110", room, maintainer_public_key)?;
    client.put_records(&publication_batch).await?;
    let verified_index = client.get_index().await?;
    if verified_index.contains(&content_id) {
        let key = SigningKey::from_pkcs8(&discovery_key)?;
        let claim = Announcement::sign(
            &key, room, content_id, "10.0.0.1".into(),
            "127.0.0.1:19201".parse()?, unix_seconds(),
        );
        client.put_announce(&claim).await?;
        let hints = client.get_peers(content_id).await?;
        // Validate hints through peer sessions; supply explicit local transport bootstrap addresses.
}
    Ok(())
}
```

No account or maintainer approval is required for eligible member records. A discovery signature
proves control of a signing key, not ownership of a transport peer ID or possession of content.
The proof covers the MessagePack tuple `(entropy-p2p-announce-v1, room, content, peer, socket-string,
issued_at, public-key)`. JSON contains those fields plus a 64-byte Ed25519 signature. Socket strings
use Rust `SocketAddr` formatting. Each `(content, discovery-key)` has at most one live hint.
Transport identity and publishing/discovery keys are separate; all returned peer IDs/ports remain
untrusted hints. The tracker never contacts those sockets to test them.

Claims use Unix seconds and expire at `issued_at + 90`; at most five seconds of future clock skew
is accepted, with a maximum 90-second local monotonic lease. Replaying an existing claim does not
extend its lease or change its endpoint. Heartbeats require a later signed timestamp; a returning
seeder announces again without republishing. Use reasonably synchronized clocks. Peers should
refresh around every 30 seconds; automatic heartbeats belong to the long-lived service.

Moderation, bans, withdrawals, author conflicts and publishing policy all use the existing index
eligibility rules. Newly ineligible hints are pruned at commit and before every lookup. Reopening
a policy does not revive a pruned hint: its seeder must send a fresh announce. Expiry and restart
remove availability only, never publications or moderation.

## Bounds and acceptance

- Index: existing 4 MiB / 4,096-record limits, including merged unions.
- Announcement: 2,048 bytes; printable ASCII peer ID up to 128 bytes; nonzero socket port.
- Live table: 4,096 total claims, 64 per content, 128 per observed source IP.
- Rate table: 4,096 IP buckets; 120 accepted connections per IP per fixed 60-second window,
  including reads and invalid requests. New IPs fail closed when the bucket table is full.
- Connections: 32 active tasks; remaining connections wait in the OS listen backlog. Headers
  are limited to 8 KiB. Reads and response writes each have a ten-second deadline.
- Disk/verification work runs on the blocking pool, serialized under the room lock, with at most
  32 workers. It completes during graceful shutdown; request timeouts never detach commit workers.
- Client: ten-second request timeout, no redirects, incremental response size checks and signature/
  scope checks. Snapshot responses are verified before being returned to callers.

`tests/features/p2p_tracker.feature` exercises the real HTTP server/client with synthetic keys.
`tests/p2p_session.rs::three_process_tracker_discovery_and_direct_transfer` starts the actual
tracker executable and two `p2p_peer` processes. The test harness uploads a signed seed claim,
fetches/verifies the index and supplies the discovered explicit loopback address to the leecher;
then checks file bytes and the tracker's metadata-only persisted snapshot. This establishes local
HTTP discovery plus direct loopback transfer. Physical NAT traversal, direct-only enforcement on
arbitrary Internet routes, production load, hosting cost and deployment have not been measured.

Public signatures and these bounds do not solve spam or Sybil identities. The existing room
capacity/moderation-reserve follow-up still applies. Persistent author keys/sequences, metadata
synchronization and heartbeat scheduling remain long-lived service work before the forum addon.
