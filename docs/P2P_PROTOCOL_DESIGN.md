# Entropy P2P network design

Latest Docs:

- https://docs.rs/rustp2p/latest/rustp2p/
- https://docs.rs/rustp2p-quic/latest/rustp2p_quic/

## Status (2026-10-02)

Phases 1 (evaluation spike), 2 (content model), 3 (local piece store), 4 (two-process localhost
session), 5 (scheduler), and 6 (room index and enforcement) are done. `src/p2p/` now holds the
`P2pTransport` trait seam (`transport.rs`), both candidate backends
(`transport/rustp2p.rs`, `transport/quic.rs`), the
content model (`meta.rs`), the piece store (`pieces.rs`), the wire protocol (`wire.rs`), the
seed/download session (`session.rs`), the pure piece scheduler (`scheduler.rs`), the signed room
index (`index.rs`), and catalog policy/transport filtering (`allow.rs`). The spike
runs as `cargo run --bin p2p_spike`; the content-model, piece-store, wire, and session unit tests
run as `cargo test --lib p2p`; the two-process session runs as
`cargo test --test p2p_session` (it spawns two `p2p_peer` binaries as the "fake peer nodes").

**Decision: KCP (`rustp2p`) is the first backend.** QUIC (`rustp2p-quic`) stays in-tree as a
fallback. Both remain behind the `P2pTransport` trait, so the call stays reversible. See the
"Phase-1 spike findings" note under section 13 for the evidence.

Phase 6 has been revised for ordinary member publishing (see below). Next up: phase 7
(minimal rendezvous node), followed by the long-lived service and phase-9 forum.

### Phase-6 member publishing and moderation (revised 2026-10-02)

`index.rs` implements room-pinned Ed25519 records using `ring` 0.17.14. Members supply the
trusted 32-byte room id and maintainer public key to `RoomIndex::new`/`from_bytes`; an incoming
snapshot cannot choose either trust value. Every author can generate a local `SigningKey`
(`Member` and `Maintainer` are role aliases) using `generate_pkcs8`/`from_pkcs8`. There are no
accounts, curator-issued author keys, or author certificates. Fixture seeds are synthetic.

- Entries are schema 2, with author public key and nonzero author-scoped sequence. Any author can
  publish a post, video or file with content id, title, description, media hints and optional parent
  publication id. No maintainer needs to be online. Publication identity is the SHA-256 of the
  canonical signing bytes, distinct from payload content identity; no peer addresses are stored.
- Authors can `Withdraw` their own publication. The pinned maintainer alone can `Remove` a
  publication, `Tombstone` a content id, `BanAuthor`, or `SetPolicy { member_publishing }`.
  Withdrawals are keyed by author and target id, so a stranger's withdrawal cannot hide a post.
  Removes, content blocks and bans are permanent, including when delivered before their targets.
  Removing one publication permits the same payload through another visible publication;
  a content tombstone blocks every publication of that payload, including future republications.
- Rooms default to open member publishing. The highest-sequence maintainer policy determines
  whether all member publications are visible/transferable; closing a room suppresses existing
  member publications too, reopening restores eligible ones. Maintainer publications remain
  eligible. Conflicting policies at the highest sequence resolve to closed. Bans cannot prevent
  someone creating another key; signatures authenticate keys, not real people or room membership.
- Signing bytes are the MessagePack tuple `(domain, schema, room, author, sequence, action)`, with
  domain `entropy-p2p-room-entry-v2` and an action represented by recursively sorted named maps. Optional
  media hints retain field names so omitting one cannot alias another. Entry ids are SHA-256 of
  these bytes; signatures cover them with Ed25519.
- Snapshots use named MessagePack fields (`schema`, `room`, `entries`), with entries in record-id
  order. The snapshot content id hashes the complete canonical snapshot, including signatures.
  Loading validates every signature and rejects alternate encodings/trailing bytes.
- Merge validates the whole batch before changing state. Invalid signatures, rooms or moderation
  authority reject the batch atomically. Duplicates are idempotent. Different authors may use the
  same sequence; conflicting records at one author/sequence are both retained and publications
  at that pair hidden, giving deterministic union even when peers first saw different conflicts.
  Signed moderation/withdrawals remain effective at conflicting sequences. Missing sequences,
  unknown parents/targets and out-of-order delivery are supported; targets do not authorize payloads.
  If identical signing bytes have different valid signatures, their stored representation uses
  the lexicographically smallest signature so snapshots also converge.
- Bounds: 4 MiB snapshots, 4,096 records, 256-byte titles, 4,096-byte descriptions and 128-byte codec
  labels. Both reliable transport adapters reject frames above 16 MiB before payload allocation.
- `Allowlist` holds the verified index, merges snapshots atomically and notifies sessions of changes.
  `CatalogTransport` checks decoded traffic on both inbound/outbound message planes, including
  info-document content ids. Wire protocol 2 adds room-pinned `GetRoomRecords` and reliable-only
  `RoomRecords` bootstrap alongside `Hello`. Received snapshots validate and merge before payload
  traffic is permitted; outbound snapshots validate without modifying local policy. No asset
  bytes are fetched automatically. KCP's raw interceptor separately filters configured source peers.
- `Session::new(transport, allowlist)` requires a policy. Unlisted downloads/serves fail before opening
  a piece store; writes and promotion hold a policy read lock. A live tombstone wakes and stops
  transfers, aborts pending seed tasks, and applies to existing channels and prepared send futures.
  Bytes already sent cannot be recalled; stored bytes remain local, and removed content is not served.
- `p2p_peer` requires a signed index file, pinned room id and public key through `--room-index`,
  `--room-id`, and `--curator-key`. The localhost fixtures pass public material to each process;
  the private signing seed remains in the test fixture code.

Schema-1 room snapshots and wire protocol 1 are deliberately rejected rather than reinterpreted.
The schema-1 info document, payload content ids and piece hashes are unchanged. Existing synthetic
room fixtures are regenerated. The model and transport bootstrap are ready for the forthcoming
service; automatic exchange responses, author key/sequence persistence and index disk persistence
belong to that service. Sequence allocation must survive restarts; reusing a sequence hides
conflicting publications. Author keys must stay local and outside replicated snapshots.

The 4,096-record / 4 MiB limits remain by agreement. Later incremental exchange can address
records by stable id without changing their signing format. Full snapshots still fail atomically
when a union exceeds either limit (including new moderation), so production growth needs bounded
paging, capacity for moderation and safe checkpoints retaining revocations. This is deferred,
not solved by deleting old records or raising the cap alone.

Service integration follow-up: the existing transport adapters spawn receive/accept tasks with
endpoint clones and use unbounded inbound queues. Their lifecycle and queue backpressure must be
owned by the long-lived service before addon integration; the board tracks this separately.

### Phase-5 scheduler behavior

`scheduler.rs` is pure single-content logic: the caller supplies a verified local piece map,
peer availability, monotonic elapsed time, and the scheduling intent. Rarest-first counts the
currently known holders of each missing piece; equal rarity uses piece-index order for repeatable
tests. Sequential-ahead requests only `[playhead, playhead + lookahead)`, clipped to the content.
A ready window waits for a playhead update; it does not start fetching unrelated pieces.

- Defaults: four outstanding requests per peer, sixteen total, three-second request expiry.
- Each piece has one outstanding owner. Verified and resumed pieces are never requested again.
  Lost, failed, or cancelled requests can be retried; a different holder is preferred when available.
- Seek cancels requests outside the new window and preserves overlapping ones. Unsolicited pieces
  and responses without a current request from that peer are ignored before touching the store.
- `Session::download` uses rarest-first against one configured peer. `download_swarm` accepts a
  peer list, intent, limits, and an optional Tokio watch receiver for live seek/window updates.
  The caller switches to rarest-first to finish a whole file after streaming, or advances the window.
- Sessions probe availability with `Hello` every 250 ms; seeds reply with `Bitfield` using packed
  LSB-first bits, exactly `ceil(piece_count / 8)` bytes. `Have` updates availability incrementally.
  These small snapshots currently use datagrams, consistent with `wire.rs`; large-content snapshot
  framing over a reliable channel remains necessary before scaling beyond datagram-sized maps.
- Piece receivers run concurrently with a bounded task count so a stalled stream does not block
  seek or retry processing. Serving deduplicates active requests, applies fixed caps, and aborts
  pending send tasks on `Cancel`. Completion still requires full verification and promotion.

Acceptance coverage: `cargo test -j 1 --test p2p_scheduler_bdd` drives a small synthetic swarm;
`cargo test -j 1 --test p2p_swarm` exercises the real session and piece store over a fake transport
(complementary holders, resume, corrupt bytes, and wire-level seek cancellation). The existing
`cargo test -j 1 --test p2p_session` remains the real KCP localhost startup/reconnect regression.

### Phase-4 findings (recorded so we know what the session actually taught us)

The two-process session (`tests/p2p_session.rs`) passes all three startup shapes - seed-first,
leecher-first, and a seeder that dies mid-transfer and restarts. Two things matter for the design:

1. **Route establishment is not the problem.** When a peer receives a `Want`, rustp2p's `handle()`
   calls `route_table.add_route_if_absent(src_id, Route::from_default_rt(route_key, metric))`, so
   the reverse route is learned from the inbound datagram and shared with the send path. Both
   startup orders work, and the seeder restarts cleanly because the leecher's retry cadence
   re-establishes the route. The design's `RouteKey`/`send_to_route` plumbing is therefore *not*
   required for the Phase-4 loopback session; it stays a later tool for the no-relay enforcement
   point (section 6/8).

2. **KCP piece-streams are NOT encrypted, even with `Algorithm::AesGcm` set.** rustp2p 0.4.1 only
   encrypts `MessageData` frames (`send_packet_to_route`/`try_send_packet_to_route` guard on
   `is_user_data()`), never `KcpData` frames. With encryption enabled the receiver rejects every
   piece stream with "inconsistent encryption status", so the session test runs with the PSK
   disabled. Piece integrity still holds end-to-end via the SHA-256 piece hashes, but the
   transport-encryption half of the section-2 control model does not cover the piece plane on KCP.
   Options: fix/upstream the crate, carry pieces over the (encrypted) datagram plane, or lean on
   the QUIC backend (always TLS-encrypted) if transport secrecy of pieces becomes a hard
   requirement. This is a decision for a later phase, not a blocker for phase 5.

Also recorded: the KCP stream's `flush()` is async and its `poll_flush` is a no-op, so a seeder must
hold each piece stream open briefly after `send` (a short grace period) or the stream is torn down
before the handshake + ACK complete.

## 1. Scope and intent

Add a BitTorrent-inspired, swarming content-distribution layer to Entropy Engine, with three
first-party surfaces, shipped in this order:

- a **P2P forum** (the MVP) - rooms of text posts, the first thing to exercise discovery and
  replication with real users;
- a **P2P file browser** that lists, previews, downloads, and re-serves shared content;
- a **P2P media player** that streams video/audio from peers while it plays, with seeking.

The name and shape of the protocol borrow from BitTorrent (content addressing, fixed-size pieces,
piece hashes, have/want exchange, rarest-first and sequential piece scheduling), but it is
deliberately *not* BitTorrent and does not interoperate with it. The reason for rebuilding instead
of using the real protocol is control: we want to decide what may enter and circulate on our
network, which the open BitTorrent/DHT/magnet system is designed *not* to let a single party do.

Transport is handled by two crates from the same maintainers:

- [`rustp2p`](https://docs.rs/rustp2p/latest/rustp2p/) (0.4.1, Apache-2.0) - NAT traversal via
  UDP/TCP hole punching, a reliable KCP transport over UDP, optional AES-GCM/ChaCha20-Poly1305
  encryption, and group-code network isolation.
- [`rustp2p-quic`](https://docs.rs/rustp2p-quic/latest/rustp2p_quic/) (0.1.1, Apache-2.0) - a
  PeerId-based QUIC overlay: `quinn` streams and encrypted QUIC datagrams layered on
  `rustp2p-core`'s hole-punched transport and relay forwarding, with NAT introspection (`NatInfo`)
  and direct-vs-relay link reporting (`LinkMode`).

Together they give us the proven NAT traversal *and* the original "use QUIC" requirement without
hand-rolling either. Which crate is the first backend is an open decision (section 14); both sit
behind the same `P2pTransport` seam, so the choice is reversible.

## 2. The control model (the reason this is not BitTorrent)

Three mechanisms keep the network curated. Each can be tightened or loosened independently later.

1. **Network isolation via group code.** `rustp2p` segments the network by a shared `GroupCode`
   (a short shared secret). Peers without the code never form a swarm with peers that have it, so
   "joining our network" means knowing the code. Author keys are locally generated to sign
   publications and withdrawals; they are not transport peer IDs or curator-issued credentials.
   There is no account login or PKI. Group code plus optional PSK encryption remains the transport
   isolation mechanism, subject to the documented KCP piece-encryption limitation.

2. **Curated catalog + content hashing.** Every shared item has a content id,
   `SHA-256(canonical(info_document))`, and every piece is `SHA-256`-verified against that document
   (section 4). The set of content ids that may circulate is derived from the **room index**:
   verified member publications under pinned maintainer policy and moderation. Peers only announce,
   request or serve eligible content. Member publishing requires no maintainer approval.

3. **Enforcement at the transport and store boundary.** KCP's `DataInterceptor` sees plaintext
   peer metadata before decryption and keeps packets when `pre_handle` returns `true`. It rejects
   peers outside the configured socket allowlist; native group-code handling isolates rooms.
   `CatalogTransport` then decodes datagrams and reliable-channel messages and rejects unlisted
   content on both inbound and outbound paths. Sessions require this policy and hold its read
   lock during store writes and promotion. Content filtering happens after decryption, where the
   content id is visible. See the Phase-1 finding and the Phase-6 implementation notes.

Publishing and moderation are separate operations. A member produces the info document, signs a
publication, shares its metadata and seeds its payload. Peers validate publications before adding
their payloads to the derived catalog. Only the maintainer authors room-wide policy and moderation.
Metadata and payload sizes are bounded; valid author signatures alone do not prevent spam.

## 3. Architecture constraints in Entropy

The engine's shape forces a specific split, and the plan follows the pattern the codebase already
uses for MCP (`src/mcp/mod.rs`) and the DAW collaboration proposal (`docs/DAW_COLLABORATION_DESIGN.md`).

- The addon runtime is a `deno_core` V8 isolate (`JsRuntime` in `src/deno/addon_engine.rs`). It is
  **not** `Send`/`Sync` and is driven synchronously from the render thread. Network and disk I/O
  must never block that thread.
- A Tokio runtime already exists (`#[tokio::main]` in `src/bin/example.rs` and `editor.rs`), and
  `tokio` is already a `full` dependency.
- The established bridge pattern is a background thread/task that sends messages over an `mpsc`
  channel, drained once per frame in `Editor::about_to_wait` (`src/startup.rs`), exactly how
  `mcp_rx` is drained today.

`rustp2p`'s `EndPoint` is `Send + Sync` and async, so it fits this model directly: it lives on a
tokio task owned by a Rust-side "network service", and only a small, bounded event queue is handed
back to the addon. Therefore:

- Deno ops are "start" and "poll" shaped (like `Net.fetchText`/`pollText`, `Vst3.scan`/`scanPoll`,
  `Video.export`/`pollExport`). Nothing blocks the frame.
- The network service runs its own tokio tasks for the endpoint, piece transfer, and disk writes.
- Progress/events flow back to the addon as a bounded event queue, drained from `onUpdate`.

This mirrors the DAW collaboration document's rule: network I/O stays off the UI and audio threads.

### Transport abstraction

The transport sits behind a narrow seam, the `P2pTransport` trait, so the content, piece, scheduler,
and allowlist layers never know which backend is underneath. The trait exposes only what those
layers need: addressing a peer by a stable id, sending/receiving best-effort datagrams (control
messages), opening a reliable ordered bidirectional stream (piece data), and a small event surface
(peer connected/disconnected, and whether a received message arrived via a relayed route). The
initial release ships one primary backend, chosen in the phase-1 spike between `rustp2p` (KCP) and
`rustp2p-quic` (QUIC overlay); a LAN/mDNS backend is a future implementation of the *same* trait.
This is what lets us start with the maintainers' proven NAT-traversal stack today without marrying
it: if either crate under-delivers, we swap the backend, not the product.

## 4. Wire protocol

### 4.1 Content identity and the info document

An **info document** is a canonicalized, versioned structure:

```jsonc
{
  "schema": 1,
  "name": "some-release.mp4",
  "mediaType": "video/mp4",           // optional, for the browser/player
  "length": 142389248,                // total bytes
  "pieceLength": 262144,              // 256 KiB default
  "pieces": "base64(concat(SHA-256 of each piece))", // flat hash list, 32 bytes per piece
  "media": { "codec": "h264", "durationMs": 3728000, "width": 1920, "height": 1080 }, // optional hints
  "created": 1770000000
}
```

- Canonical serialization (sorted keys, no trailing data) must be defined and frozen in `schema 1`;
  the content id depends on it. `rustp2p` itself serializes with `rmp-serde` (MessagePack), so
  MessagePack is the natural candidate for the canonical encoding too; a hand-rolled canonical JSON
  is the alternative. The exact choice is a decision to make before any content ships, because ids
  are only as stable as the encoding.
- A **content id** is `SHA-256(canonical(info_document))`. This is the stable handle peers use in
  all have/want/request messages. Piece hashes are flat in the first release; a Merkle tree is a
  later option if we want per-piece streaming verification of huge files without shipping the full
  list up front (the list is tiny - 32 bytes per 256 KiB, ~17 KiB per GiB - so flat is fine for now).
- The info document itself can optionally carry a curator signature, but per the relaxed control
  model the *primary* integrity mechanism is the piece hashes plus "the id must be in the catalog";
  a signature is a cheap later addition, not a first-release requirement.

### 4.2 Transport framing

`rustp2p` gives us a datagram-oriented API (`send_to`/`recv_from` over a `NodeID`) plus an optional
reliable KCP stream layer (`rustp2p-reliable`). We use both:

- **Reliable KCP streams** for piece data and anything larger than one datagram: one logical stream
  per piece request carries the request header and the piece bytes. This is the analogue of the
  QUIC bidirectional stream in the original design.
- **Datagrams** (`send_to`/`recv_from`) for control messages: `have`, `want`, `cancel`, presence.
  These are small, best-effort, and re-derivable; losing one costs a redundant request, not
  correctness.

Messages are length-prefixed and version-tagged. The envelope is `{ protocol, message, payload }`,
serialized with `rmp-serde` (MessagePack), where `payload` is a compact binary or JSON-compatible
structure depending on the message. Piece bytes are raw after their fixed header.

### 4.3 Message set (initial)

| Message | Channel | Direction | Purpose |
| --- | --- | --- | --- |
| `hello` | stream | both | protocol version, supported schemas, group membership |
| `get_info` / `info` | stream | req/resp | fetch an info document by content id |
| `have` | datagram | both | "I hold piece N of content C" (coalesced) |
| `bitfield` | stream | both | full piece map on connect (batched `have`) |
| `want` | datagram | both | "send me pieces X..Y of content C" (informed by scheduler) |
| `piece` | stream | resp | piece bytes + content id + index |
| `cancel` | datagram | both | stop a pending piece request |
| `done` | datagram | both | completion signal, for seed accounting |

This is a deliberately small, BitTorrent-shaped vocabulary. The scheduler (section 7) is what turns
`have`/`want` into a usable download and stream.

## 5. Piece storage, verification, and serving

- Pieces land in a per-content directory under the engine's data dir (the analogue of
  `<data_dir>/p2p/<content_id>/`), one file per piece or one sparse whole-file with a bitmap. Whole
  file with a bitmap is simpler to hand to the media player; per-piece files are simpler to resume.
  Recommend whole-file + bitmap for media, since the player wants a single path.
- Every piece is SHA-256 verified against the info document *before* it is marked have and
  re-shareable. A hash mismatch is dropped and the peer is penalized (see 8).
- A completed and verified file can be atomically "promoted" to a seed position and listed by the
  browser.
- Serving is read-only over the curated catalog: a peer serves pieces only for content ids it holds
  and that are in the catalog. It never serves arbitrary filesystem paths (the same rule the DAW
  collaboration doc states: a peer cannot name another machine's path).

## 6. Discovery: rooms, index, and a minimal rendezvous node

NAT traversal is delegated to `rustp2p`, whose docs state UDP hole punching works with both cone
NAT and symmetric NAT, and TCP hole punching covers NAT1. Peers bootstrap from a configured initial
peer list and discover further peers through the swarm.

Discovery itself is scoped to **rooms**. A room is a `GroupCode` (the network-isolation secret from
section 2) plus a small, signed, content-addressed **index**. Members join a room by its code, store
only that room's index, and seed it to other members. This keeps the replicated state tiny and
bounded per room, and it is what makes the network self-managing: the index is a union of signed
entries that merge cleanly, and a room survives without any server as long as one member is online.

### The two layers: durable index vs live availability

Keep these separate. "What exists in the room" and "who has it right now" are different facts, and
distributed systems handle the second one badly.

1. **Durable index (append-only, signed).** Member publications carry content ids, metadata,
   author keys and optional parent references. The maintainer signs policy and moderation;
   members sign their own publications and withdrawals. Removal records remain in the union,
   so re-served stale copies cannot resurrect removed publications or blocked content. **The index never stores
   peer endpoints** - addresses rot under NAT/roaming. Who holds a content id is a live question,
   answered by the layer below, never persisted.

2. **Live availability (rendezvous).** A short-TTL table of "peer P announced it seeds content C".
   Fed by heartbeats and announces and expiring on silence, this is where "no seeders" becomes
   visible: expired announcements mark C unavailable, but never remove publications or produce
   tombstones automatically. An offline seeder can return without republishing.

### The always-on node is tiny

Cold start still needs at least one reachable address (you cannot discover peers without knowing any
peer first). So we keep one small always-on node, but its job is deliberately minimal because this
is a free product and its cost must stay low. It touches only metadata, never file bytes, so its
bandwidth scales with the number of peers announcing, not the volume of content.

Phase 7 adds bounded public-metadata ingestion alongside discovery:

| Endpoint | Job |
| --- | --- |
| `get_index(room)` | Serve the current signed room index to new/rejoining members (read-only). |
| `put_records(room, records)` | Verify and merge member publications/withdrawals and pinned maintainer policy/moderation. Never accept caller-selected room trust. |
| `put_announce(room, content_id, proof)` | Accept "I seed C" into the short-TTL live table (write). |
| `get_peers(room, content_id)` | Rendezvous: return who holds C right now. |

Start with a standalone Rust `tracker` binary and local fake peers, with durable index storage
and an in-memory expiring availability table. Deploy to a DigitalOcean droplet later. Keep hosting
cost claims provisional until the actual request rate, metadata volume and persistence are measured.
HTTP discovery supplies connection hints; it does not itself establish transport routes or replace
NAT punch coordination. Local fixtures start with explicit loopback connection addresses.

The node is public, rate-limited and content-agnostic: it serves signed records it did not author
and a TTL'd peer table it does not trust. An author signature is not proof of seeding; peer lists
are connection hints verified through peer sessions. Announcements must name eligible content.
Use a local Rust tracker binary first, then deploy to the planned DigitalOcean droplet. It stores
public room pins and metadata, never author private keys, group secrets or payload bytes.

### No relay/proxy for file data

A separate hard constraint: we do not rely on a relay, proxy, or CDN, and we never transfer or store
large assets through one. Piece data always flows over direct, hole-punched peer connections. The
KCP backend exposes `RouteKey`/`send_to_route` and `RecvMetadata` relay info; the QUIC backend
exposes `LinkMode`/`LinkInfo` (direct vs relayed). Either way the rule is the same: file bytes are
confined to direct routes, and piece data that arrived relayed is dropped. The rendezvous node is
announcements only, never a data path. This is a real verification task, not an assumption - see
phase 8.

## 7. Piece scheduling

Two schedulers, switched per content and per intent:

- **Rarest-first** for bulk downloads and seeding: fetch the pieces the swarm holds the fewest of,
  to maximize re-shareability. This is the classic BitTorrent default and the right default for the
  file browser's "download" action.
- **Sequential-ahead** for streaming media: fetch pieces in order, with a lookahead buffer ahead of
  the playhead, and reprioritize on seek (cancel the old window, request around the new position).
  This is what makes the media player start fast and seek without waiting for the whole file.

Both run against the same `have`/`want`/`piece` vocabulary; the scheduler is pure client-side logic.
There is deliberately no tit-for-tat choking in the first release - the network is curated and
trusted, so request pipelining and a fixed per-peer in-flight cap are enough. Choking/anti-leech
can be added later without changing the wire format.

## 8. Security and abuse controls

- **Isolation and transport.** A shared `GroupCode` isolates the swarm; `rustp2p` optional
  encryption (AES-GCM or ChaCha20-Poly1305) protects control traffic with a PSK, subject to the
  Phase-4 KCP piece-encryption limitation. Local author keys sign metadata without account login
  or PKI; the pinned maintainer key controls moderation. The group code and raw interceptor
  constrain transport participation, while decoded catalog policy constrains payload transfers.
- **Verification everywhere.** Every piece is SHA-256 checked against the info document before it
  is trusted or re-shared.
- **Filtering.** The KCP interceptor rejects unlisted source peers before decryption. The shared
  catalog transport rejects unknown/tombstoned content after decoding on both message planes;
  sessions additionally require current catalog membership before touching the piece store.
- **Rate and size limits.** Cap per-peer in-flight piece requests, message sizes, and the number of
  concurrent pieces; enforce backpressure so a slow disk or player never unboundedly buffers.
- **Penalties.** Peers that send bad hashes, oversized pieces, or protocol-invalid messages are
  disconnected and temporarily ignored. A formal ban list can be added later; the interceptor is
  where it would live.
- **No arbitrary fetch.** The network service only writes to `p2p/<content_id>/` and only for
  catalog-listed, hash-verified content. It does not expose a generic "fetch this URL/this path"
  primitive.
- **Consent.** Hosting/uploading (serving pieces, opening a listening socket) is opt-in and surfaced
  in the UI before the socket opens - same stance as the DAW collaboration doc.

## 9. The P2P file browser

A new addon, `p2p_file_browser_addon.ts`, following the existing media player's structure
(`apps/media_player_addon.ts`):

- Lists the room index (rendezvous + local store): name, size, type, media metadata, seed/peer
  count, local availability.
- Actions per item: **download** (rarest-first to completion, then seed), **play** (stream via the
  player, section 10), **open folder**, and **seed/stop seeding** for local files.
- Shows per-item progress: pieces fetched, verified, remaining, per-peer contribution, and transfer
  rate. Reuses the `Widget.treeView` / `Widget.card` / `Widget.progress`-style primitives already
  in `entropy_gui`.
- Members publish their own content here; maintainers receive separate moderation controls.

## 10. The P2P media player

A streaming player, `p2p_media_player_addon.ts`, that reuses the existing decode path
(`Entropy.Video` -> Media Foundation on Windows, OpenH264 + symphonia elsewhere) but sources bytes
from the swarm instead of a local file.

Two delivery options, in order of preference:

1. **Spool to temp file + progressive play (recommend first).** The scheduler fetches pieces
   sequentially ahead of the playhead into a temp file; the player opens the same temp file with
   `Entropy.Video.open` once enough leading bytes are present, and the file grows underneath it.
   This reuses the entire existing, tested decode path unchanged. The cost is a temporary copy on
   disk; for media that is being played it is a non-issue.
2. **Byte-source/streaming input to the decoder (later).** Teach Media Foundation/OpenH264 a
   pull-based source that reads from an in-memory ring buffer of verified pieces, eliminating the
   disk copy and enabling true "never fully on disk" playback. This is a real, self-contained
   effort on both backends and is deferred.

Playback behavior:

- Start once the first few pieces are verified and buffered; keep a configurable buffer ahead
  (e.g. 8-16 seconds of pieces).
- **Seek** cancels the current window and reprioritizes around the target; the player shows a
  buffering state until enough leading pieces land.
- **Stall handling:** if the buffer drains (peer leaves, network degrades), pause and show a
  rebuffering state; the scheduler switches to whichever peers still hold the missing pieces.
- Transport controls (seek, volume, speed, captions) mirror the existing media player; the only new
  surface is buffer/progress state fed from the network service.

## 11. Module breakdown

### Rust (`src/p2p/`)

| Module | Responsibility |
| --- | --- |
| `mod.rs` | The `P2pService` handle: owns the tokio task set, the event outbound channel, and the poll surface drained by `about_to_wait`. |
| `meta.rs` | Info document schema, canonical serialization (MessagePack), content id derivation. |
| `wire.rs` | The versioned `Envelope` and `Msg` set (hello/get_info/info/have/bitfield/want/cancel/done/piece), MessagePack-encoded; transport-agnostic. |
| `session.rs` | Single-content seed/serve and swarm download/resume over the catalog transport; bounded scheduling, live seek and catalog revocation. |
| `index.rs` | Member publications and withdrawals, maintainer policy/moderation, author-scoped conflict handling, verified union and canonical snapshots. |
| `allow.rs` | Shared index-derived policy, change notifications, store-operation guards, and `CatalogTransport` filtering both message planes. |
| `pieces.rs` | On-disk piece store, bitmap, SHA-256 verification, promote-to-seed. |
| `scheduler.rs` | Rarest-first and sequential-ahead scheduling, in-flight caps, cancellation, seek reprioritization. |
| `transport.rs` | The `P2pTransport` trait: peer addressing, datagram send/recv, reliable stream open, peer events, relay-route detection. The stable seam all upper layers code against. |
| `transport/rustp2p.rs` | KCP backend: `rustp2p` `Builder`/`EndPoint` construction (group code, PSK, initial peers), the `DataInterceptor` that consults `allow.rs`, and adaptation of datagrams + KCP streams onto `P2pTransport`. The first backend. |
| `transport/quic.rs` | QUIC backend wrapping `rustp2p-quic` (`quinn` streams + encrypted datagrams over `rustp2p-core` NAT traversal); reports `LinkMode` (direct/relay) for the no-relay rule. In-tree fallback. |
| `transport/lan.rs` | *Future* backend: mDNS/DNS-SD discovery + direct subnet transport, same trait. |
| `rendezvous.rs` | Client for the minimal always-on node: `get_index` / `put_announce` / `get_peers`, and the short-TTL live-availability table. |

`src/deno/p2p_ops.rs` adds the non-blocking ops (`op_p2p_start`, `op_p2p_stop`,
`op_p2p_add_content`, `op_p2p_remove_content`, `op_p2p_download`, `op_p2p_poll`, `op_p2p_stream`,
etc.), registered like the other ops in `addon_engine.rs`, and exposes `Entropy.P2P` in
`addon_setup.js` with types in `addon.d.ts`. The service follows the `mcp_rx` bridge pattern:
network tasks send events to a channel the render thread drains each frame.

### TypeScript addons (`examples/studio-bundle/src/apps/`)

| File | Responsibility |
| --- | --- |
| `p2p_client.ts` | Thin wrapper over `Entropy.P2P`: event queue, progress model, catalog cache. |
| `p2p_file_browser_addon.ts` | Catalog UI, download/seed actions, progress display. |
| `p2p_media_player_addon.ts` | Streaming playback UI, buffer/seek/stall states, delegating to `Entropy.Video`. |

Note: the best initial app experience for this is actually probably a messenger or forum, rather than files and media. Let's discuss before implementing.

## 12. Dependencies

- `rustp2p` 0.4.1 (Apache-2.0) pulls in, transitively: `tokio` ^1.42 (the engine pins 1.41, so a
  minor bump), `tokio-util`, `kcp`, `dashmap`, `flume`, `crossbeam-queue`, `rmp-serde`
  (MessagePack), `sha2` ^0.10, `futures`, `rand` ^0.9, and optionally `ring`/`openssl` for crypto.
  None of these conflict with what the engine already carries; `sha2`, `bytes`, and `futures` are
  already present.
- `rustp2p-reliable` for the KCP stream layer (piece data), if the base crate does not re-export it.
- `rustp2p-quic` 0.1.1 (Apache-2.0) pulls in `quinn` ^0.11 (already in the engine's lock file
  transitively), `rustls` ^0.23, `rcgen` ^0.13, `x25519-dalek` ^2, `prost` (protobuf), `sha2` ^0.10,
  and `rustp2p-core` ^0.1. It adds a protobuf build dependency (`prost-build` +
  `protoc-bin-vendored`), which lengthens builds and should be checked in the spike.
- Version-skew note: the KCP crate uses `rust-p2p-core` (hyphenated) while the QUIC crate uses
  `rustp2p-core` (no hyphen); the two trees are separate, and their compatibility must be verified
  in the spike.
- Both `rustp2p` and `rustp2p-quic` are contained inside their `transport/*` backends; nothing above
  the `P2pTransport` trait imports either. Keeping the trait seam is what makes choosing or swapping
  a backend cheap.

**Caveat to resolve before depending on it:** `rustp2p` is not new - 0.1.1 shipped in September 2024
and it has been in active development since (24 versions, ~20k downloads; 0.4.1 published
2026-02-09). It is still worth a short evaluation spike, though, because docs.rs scores it only
~47% documented, the maintainer set is small (`xmh0511` plus `vnt-dev`, both tied to the vnt P2P
project), and we must verify the hole-punching and interceptor/route APIs on our actual targets
before committing the architecture to it. The plan assumes that spike passes; if it does not, the
fallback is the original `quinn`-based QUIC transport with a small, hand-rolled hole-punch
rendezvous, which is more work.

`rustp2p-quic` is a separate, younger crate: 0.1.1 published 2026-08-11, single maintainer
(`xmh0511`), though much better documented than `rustp2p` (docs.rs scores it ~93%). It is the more
"modern" of the two (native `quinn` + QUIC datagrams) but also the less battle-tested. The phase-1
spike evaluates both side by side; either can be the first backend, and the `P2pTransport` seam is
what makes the call reversible.

## 13. Delivery sequence and acceptance checks

Phased, each phase gated on the one before it, in the BDD style the repo already uses
(`tests/*_bdd.rs`, `tests/*.feature`).

1. **Evaluation spike.** *(DONE)* Define the `P2pTransport` trait, then build both `rustp2p` (KCP) and
   `rustp2p-quic` (QUIC overlay) in-tree as candidate backends. Exercise `GroupCode`, encryption,
   the `DataInterceptor`, and the relay/direct-route controls (`RouteKey`/`RecvMetadata` for KCP,
   `LinkMode`/`LinkInfo` for QUIC) on Windows and Linux. Confirm hole punching claims, stream
   throughput, and that file-sized transfers stay on direct routes. Pick the first backend from the
   results. A pass proves the trait seam holds; a fail just replaces a backend, not the trait.
2. **Content model.** *(DONE)* Info document, canonical MessagePack encoding, content ids, piece hashing.
   Tests: deterministic ids, version rejection.
3. **Local piece store.** *(DONE)* Split/verify/assemble a file, resume from a partial bitmap, promote to
   seed. Tests: corrupt piece rejected, resume exact, idempotent.
4. **Two-process localhost session.** *(DONE)* Two peers, one seeded, one downloads over loopback with no
   NAT. Tests: full transfer, out-of-order pieces, duplicate/retried requests, disconnect/reconnect.
   A localhost pair is the same shape as the DAW collab doc's two-process test. `src/p2p/session.rs`
   + `src/bin/p2p_peer.rs` + `tests/p2p_session.rs` (three startup shapes: seed-first, leecher-first,
   reconnect). See the "Phase-4 findings" note under the Status section.
5. **Scheduler.** *(DONE)* Rarest-first vs sequential-ahead correctness on a small synthetic swarm.
   `tests/features/p2p_scheduler.feature` + `tests/p2p_scheduler_bdd.rs`: nine scenarios, 27 steps.
   `tests/p2p_swarm.rs`: three session/store integration tests. Verified completion, no duplicate
   fetches in a successful download, bounded requests, resumed pieces skipped, timeout/source
   failover, corruption recovery, peer loss, and seek cancellation/reprioritization. Retries after
   loss/failure/cancellation are deliberate; they are distinct from duplicate active requests.
6. **Room index and interceptor.** *(DONE; member-publishing revision implemented)* Signed append-only index + catalog filtering after decoding;
   `DataInterceptor` filters source metadata before decryption and group code isolates rooms.
   Tests: unknown content id dropped, wrong group code cannot join, only indexed ids reach the
   piece store, tombstone prevents resurrection. This corrects the original content-aware
   interceptor assumption using the Phase-1 spike finding.
   Original Phase-6 acceptance passed 17 scenarios / 51 steps. Revised acceptance adds independent
   member posts/videos, withdrawals, scoped removals, bans, policy, author conflict convergence and
   reliable metadata bootstrap; regressions retain guarded storage and live transfer revocation.
   Revised Windows/loopback validation: 26 room scenarios / 78 steps, 9 scheduler scenarios,
   3 synthetic swarm tests, 3 real KCP process tests, 15 P2P unit tests and
   `cargo check -j 1 --offline --all-targets` passed. No new physical NAT or media playback test.
7. **Minimal rendezvous node.** Rust tracker binary with `get_index` / `put_records` /
   `put_announce` / `get_peers` and a short-TTL live table. Verify member publications and pinned
   maintainer authority independently; no payload bytes or secrets touch the node. Expiry changes
   availability, never durable publications. Test locally with fake peers before deployment.
   Before Phase 9, add service task ownership/backpressure, multi-content event dispatch,
   persistent author keys/sequences and verified indexes, bootstrap responses and non-blocking ops.
8. **NAT traversal and no-relay enforcement.** Two physical machines behind NAT connect via hole
   punching; assert piece data never traverses a relayed route (via `RecvMetadata`/`LinkMode` relay
   info) and measure first-play and seek latency on real Wi-Fi/LAN before claiming anything. (we may delay this till after Phase 9 due to physical logistics)
9. **P2P forum addon (first product surface).** Room join, post/compose, index replication,
   availability display ("no seeders"), and moderation via the maintainer key. Members A and B
   must publish with the maintainer offline; C downloads and re-seeds, then later moderation
   propagates without stale snapshots resurrecting removed content. Live BDD with two
   windows. This is the MVP that ships before files or media and proves the discovery layer with
   real users.
10. **P2P file browser addon.** Room index, download, seed, progress. Live BDD with two windows.
11. **P2P media player addon.** Stream + seek + rebuffer. Live BDD against a seeded local file and
    a second peer. This is where the spool-then-play choice is exercised end to end.
12. **Byte-source decoder (optional).** Remove the disk copy; benchmark memory and start latency.

### Phase-1 spike findings (recorded so we know what the spike actually taught us)

The spike (`cargo run --bin p2p_spike`) passed all hard checks on loopback for both backends:
KCP datagram round-trip under group code + PSK + interceptor, wrong-group-code isolation, and
interceptor drop; QUIC bootstrap discovery, datagram round-trip, and a stream echo. Three things
matter for the design:

1. **`DataInterceptor` runs pre-decryption.** `rustp2p` invokes `pre_handle` on the raw frame
   before the PSK decrypt step, so the interceptor sees only plaintext frame metadata
   (`src_id`/`dest_id`/`group_code`/`ttl`/`protocol`), *not* the content id inside the encrypted
   payload. Section 2.3's "drop non-catalog content ids at the socket" therefore does not hold as
   written: content-id filtering must happen post-decrypt in the network service (after
   `recv_from`); the interceptor is only a peer/metadata choke point. Also note the crate treats a
   `pre_handle` return of `true` as *keep*, the opposite of its docs.rs comment.
2. **KCP has no wait-for-peer primitive.** The first `send_to` right after `start()` can fail with
   "node route not found" because route discovery is async; the network service must retry until
   the route is up (the spike does this in `send_until_received`).
3. **Feature asymmetry.** `GroupCode` and `DataInterceptor` are KCP-only. QUIC is always
   TLS-encrypted and uses `Identity`/`PeerId` plus a punch whitelist for trust, so section 2's
   control model maps cleanly onto KCP and awkwardly onto QUIC. This is the main reason KCP is
   the first backend; QUIC is retained as a fallback because `open_bi`/`accept_bi` + `link_mode`
   give a cleaner stream API if we later need it.

## 14. Decisions to discuss

- **Transport backend (decided: KCP first, QUIC kept).** *(Decided 2026-10-02)* Two candidate first
  backends from the same maintainers: `rustp2p` (KCP, battle-tested) and `rustp2p-quic` (QUIC
  overlay, more modern but younger), both behind the `P2pTransport` trait; LAN (mDNS) is a future
  backend. The phase-1 spike picked **KCP** (it natively implements the curated-control model:
  group code + PSK + interceptor); **QUIC stays in-tree as a fallback** because of the finding that
  its control model maps poorly onto section 2. The original "use QUIC" requirement is now
  satisfiable natively via `rustp2p-quic` if we switch.
- **Trust model (decided).** Group code + optional PSK, local author signing keys, pinned maintainer
  policy/moderation, and payload hashing. Open member publishing without accounts or prior approval.
- **Canonical encoding.** *(Decided 2026-10-02)* MessagePack (`rmp-serde`), with sorted keys (a
  `serde_json::Map`, i.e. a `BTreeMap`, serialized to MessagePack) so the encoding is deterministic;
  `None` fields are omitted and the `pieces` field is a base64 string (no binary/array ambiguity).
  This locks the content id forever; the golden bytes/hash are frozen in `meta.rs` tests.
- **Piece length** default (256 KiB vs 1 MiB) and whether it is per-content.
- **Rendezvous hosting (decided).** Local Rust tracker binary first; DigitalOcean droplet later.
  Public metadata without account authentication; bounded requests and rate limits are required.
- **Room index write authority (decided).** Members sign publications/withdrawals; the pinned
  maintainer signs room policy and moderation. Key rotation and multiple maintainers are deferred.
- **Forum-first MVP (decided).** Forum ships before file browser/media player. Both forum posts and
  media-channel videos use the same member-publication model.
- **Index scaling (deferred by agreement).** Keep 4,096 records and 4 MiB now. Future paging and
  moderation capacity must preserve stable record IDs and durable revocations.
- **Relayed control traffic.** Confirm the boundary: small control/signaling may use `rustp2p`'s
  relayed routes, but piece data must be direct-only. Decide the exact enforcement (drop vs
  re-route).
- **Streaming decode.** Confirm spool-to-temp-file first, defer the custom byte-source.
- **Seeding policy.** Does the browser auto-seed completed downloads by default, and with what
  upload caps. Does every room member seed the room index as a condition of joining, and what
  happens when a room's only seeder goes offline.
 

Note: the centralized server for tracking minimal things can just be a Rust server as a /bin/ file.
We will eventually deploy the Rust server to a DigitalOcean droplet. Let's avoid authentication if possible, just public data.
Note: we will likely want a way to test (both manually and via BDD) with fake peer nodes, so we can verify everything before deployment.
