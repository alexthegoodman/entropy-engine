# Entropy P2P network design

Latest Docs:

- https://docs.rs/rustp2p/latest/rustp2p/
- https://docs.rs/rustp2p-quic/latest/rustp2p_quic/

## Status (2026-10-02)

Phase 1 (evaluation spike) and phase 2 (content model) are done. `src/p2p/` now holds the
`P2pTransport` trait seam (`transport.rs`), both candidate backends (`transport/rustp2p.rs`,
`transport/quic.rs`), and the content model (`meta.rs`). The spike runs as
`cargo run --bin p2p_spike`; the content-model tests run as `cargo test --lib p2p::meta`.

**Decision: KCP (`rustp2p`) is the first backend.** QUIC (`rustp2p-quic`) stays in-tree as a
fallback. Both remain behind the `P2pTransport` trait, so the call stays reversible. See the
"Phase-1 spike findings" note under section 13 for the evidence.

Next up: phase 3 (local piece store), then phase 4 (two-process localhost session).

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
   "joining our network" means knowing the code. This replaces heavy per-peer identity: there is
   deliberately *no* per-peer keypair, no curator-issued identity, and no PKI in the first release.
   The user has flagged full authentication as "probably a step too far"; a shared group code plus
   PSK encryption (`Algorithm::AesGcm(password)`) is the lightweight stand-in.

2. **Curated catalog + content hashing.** Every shared item has a content id,
   `SHA-256(canonical(info_document))`, and every piece is `SHA-256`-verified against that document
   (section 4). The set of content ids that may circulate is the **room index** (the catalog, section
   6): peers only announce, request, or serve content ids they learned from that signed index. Adding
   or removing content is a curation act, not a network act.

3. **Enforcement at the socket.** `rustp2p` exposes a `DataInterceptor` trait whose `pre_handle`
   returns `true` to drop an incoming packet before delivery. We install an interceptor that drops
   any packet that is not for a known, catalog-listed content id (or is not group-valid). This is a
   single choke point that makes "what is allowed on the network" a real, enforced rule rather than
   a convention peers could ignore.

Consequence: publish and curate are the same operation. There is no untrusted upload path in the
first release; content enters a room's index through the room maintainer's tooling, which produces
the info document, signs the index entry, and seeds the content. Replicating that signed index is
something every member does; authoring it is not.

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

1. **Durable index (append-only, signed).** Each entry is `{ content_id, title, description, media
   metadata }` - the "p2p link" is just the content id, nothing more. A room has a maintainer key
   that signs entries; peers replicate and seed the signed log, they do not author it (this keeps
   "anyone can add themselves" from becoming "anyone can inject"). Deletion is a tombstone entry,
   not a removal, so re-served stale copies cannot resurrect dead content. **The index never stores
   peer endpoints** - addresses rot under NAT/roaming. Who holds a content id is a live question,
   answered by the layer below, never persisted.

2. **Live availability (rendezvous).** A short-TTL table of "peer P announced it seeds content C".
   Fed by heartbeats and announces and expiring on silence, this is where "no seeders" becomes
   visible: when liveness probes for C come up empty, the room marks C unavailable, and only then
   may it tombstone C from the index. A room self-manages here, not in the durable layer.

### The always-on node is tiny

Cold start still needs at least one reachable address (you cannot discover peers without knowing any
peer first). So we keep one small always-on node, but its job is deliberately minimal because this
is a free product and its cost must stay low. It touches only metadata, never file bytes, so its
bandwidth scales with the number of peers announcing, not the volume of content.

Three endpoints, nothing else:

| Endpoint | Job |
| --- | --- |
| `get_index(room)` | Serve the current signed room index to new/rejoining members (read-only). |
| `put_announce(room, content_id, proof)` | Accept "I seed C" into the short-TTL live table (write). |
| `get_peers(room, content_id)` | Rendezvous: return who holds C right now. |

The index is small (titles + descriptions + hashes, ~1 KB/item) and announces are a few hundred
bytes, so the whole node stays inside a free tier until real scale. Two ways to run it:

- **Edge/serverless (preferred for a free product):** Cloudflare Workers free tier + R2 (zero egress)
  for the durable index, Workers KV or Durable Objects for the live TTL table. Zero fixed cost, no
  VPS to patch. This is the "publicly available database table" from the earlier discussion.
- **One cheap VPS:** a single process with SQLite. The engine already carries `tiny_http` (the MCP
  server uses it) and `reqwest`, so a `tracker` binary is nearly free to write.

The node is public, so it is rate-limited and content-agnostic: it serves a signed index it did not
author and a TTL'd peer table it does not trust.

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
  encryption (AES-GCM or ChaCha20-Poly1305) protects traffic with a PSK. There is no per-peer PKI
  in the first release - the group code and PSK are the trust root, and the `DataInterceptor` is the
  enforcement point.
- **Verification everywhere.** Every piece is SHA-256 checked against the info document before it
  is trusted or re-shared.
- **Socket-level filtering.** The `DataInterceptor` drops packets not for a catalog-listed content
  id. This is defense in depth on top of the catalog, and also rejects unsolicited/garbage traffic.
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
- The "browser" is also the entry point for curation: the room maintainer's tooling publishes here.

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
| `index.rs` | The room's durable index: append-only signed entries, merge, tombstones, maintainer-signature verification. |
| `allow.rs` | The allowlist policy derived from the room index (which content ids may circulate); transport-agnostic. |
| `pieces.rs` | On-disk piece store, bitmap, SHA-256 verification, promote-to-seed. |
| `scheduler.rs` | Rarest-first and sequential-ahead scheduling, in-flight caps, cancellation, seek reprioritization. |
| `transport.rs` | The `P2pTransport` trait: peer addressing, datagram send/recv, reliable stream open, peer events, relay-route detection. The stable seam all upper layers code against. |
| `transport/rustp2p.rs` | KCP backend: `rustp2p` `Builder`/`EndPoint` construction (group code, PSK, initial peers), the `DataInterceptor` that consults `allow.rs`, and adaptation of datagrams + KCP streams onto `P2pTransport`. Candidate for the first backend. |
| `transport/quic.rs` | QUIC backend wrapping `rustp2p-quic` (`quinn` streams + encrypted datagrams over `rustp2p-core` NAT traversal); reports `LinkMode` (direct/relay) for the no-relay rule. Candidate for the first backend. |
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
3. **Local piece store.** Split/verify/assemble a file, resume from a partial bitmap, promote to
   seed. Tests: corrupt piece rejected, resume exact, idempotent.
4. **Two-process localhost session.** Two peers, one seeded, one downloads over loopback with no
   NAT. Tests: full transfer, out-of-order pieces, duplicate/retried requests, disconnect/reconnect.
   A localhost pair is the same shape as the DAW collab doc's two-process test.
5. **Scheduler.** Rarest-first vs sequential-ahead correctness on a small synthetic swarm. Tests:
   completes, no piece fetched twice from the same peer, seek reprioritizes.
6. **Room index and interceptor.** Signed append-only index + `DataInterceptor` drops non-index
   traffic; group code isolates two rooms. Tests: unknown content id dropped, wrong group code
   cannot join, only indexed ids reach the piece store, tombstone prevents resurrection.
7. **Minimal rendezvous node.** `get_index` / `put_announce` / `get_peers` over a short-TTL live
   table. Verify only maintainer-signed entries enter the index, no bytes or secrets touch the node,
   and liveness expires "no seeder" entries.
8. **NAT traversal and no-relay enforcement.** Two physical machines behind NAT connect via hole
   punching; assert piece data never traverses a relayed route (via `RecvMetadata`/`LinkMode` relay
   info) and measure first-play and seek latency on real Wi-Fi/LAN before claiming anything.
9. **P2P forum addon (first product surface).** Room join, post/compose, index replication,
   availability display ("no seeders"), and moderation via the maintainer key. Live BDD with two
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
- **Trust model.** Group code + PSK + maintainer-signed room index + content hashing (no per-peer
  identity), as the user suggested ("authentication is a step too far"). Decide whether any
  additional signature on the info document is worth adding now or later.
- **Canonical encoding.** *(Decided 2026-10-02)* MessagePack (`rmp-serde`), with sorted keys (a
  `serde_json::Map`, i.e. a `BTreeMap`, serialized to MessagePack) so the encoding is deterministic;
  `None` fields are omitted and the `pieces` field is a base64 string (no binary/array ambiguity).
  This locks the content id forever; the golden bytes/hash are frozen in `meta.rs` tests.
- **Piece length** default (256 KiB vs 1 MiB) and whether it is per-content.
- **Rendezvous node hosting.** Confirm the serverless-first choice (Workers + R2 + KV/Durable
  Objects) vs a single VPS; who runs it, and the rate limits for a public, content-agnostic node.
- **Room index write authority.** Confirm the maintainer-key model: one key per room signs index
  entries, and everyone else only replicates. Decide how the maintainer key is rotated or shared,
  and whether rooms ever allow multi-maintainer signing.
- **Forum-first MVP.** Confirm the forum addon ships before the file browser/media player as the
  first surface that exercises discovery with real users.
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