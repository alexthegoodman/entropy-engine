# Entropy P2P network design

Status: design proposal, not implemented. Nothing in this document has been built or tested yet.

## 1. Scope and intent

Add a BitTorrent-inspired, swarming content-distribution layer to Entropy Engine, built on QUIC,
with two first-party surfaces:

- a **P2P file browser** that lists, previews, downloads, and re-serves shared content;
- a **P2P media player** that streams video/audio from peers while it plays, with seeking.

The name and shape of the protocol borrow from BitTorrent (content addressing, fixed-size pieces,
piece hashes, have/want exchange, rarest-first and sequential piece scheduling), but it is
deliberately *not* BitTorrent and does not interoperate with it. The reason for rebuilding instead
of using the real protocol is control: we want to decide what may enter and circulate on our
network, which the open BitTorrent/DHT/magnet system is designed *not* to let a single party do.

QUIC is the transport because it gives us multiplexed streams and unreliable datagrams over one
connection, mandatory TLS 1.3, connection migration, and 0-RTT resume - all of which map directly
onto the parts of BitTorrent we want (many concurrent piece requests on one socket, cheap
presence/gossip messages, and encrypted, authenticated links) without BitTorrent's TCP-per-peer
connection sprawl or unencrypted legacy.

## 2. The control model (the reason this is not BitTorrent)

Three independent gates keep the network curated. Each can be relaxed independently later, but the
first release enforces all three.

1. **Signed content.** Every shared item is described by a canonical, canonicalized metadata blob
   (an "info document", the analogue of BitTorrent's info-dict). Its content id is
   `SHA-256(info_document)`. Only items whose info document verifies against a trusted curator key
   (or a configured key ring) may be announced, requested, or served. A peer that receives a
   request or announcement for an unsigned/unknown id ignores it. This is the primary lever: adding
   or removing content is a curation act, not a network act.

2. **Peer membership.** Joining the swarm requires a signed peer identity (Ed25519) issued by the
   same curator, or an invite secret that derives one. Peers authenticate each other on connect and
   refuse unknown identities. Random internet nodes cannot simply point at the tracker and join.

3. **Curated discovery.** Discovery goes through a small, explicit bootstrap/tracker list (see
   section 6), never an open DHT crawl. There is no way to enumerate the network from the outside;
   you can only learn about content you are already allowed to see. A DHT may come later, but only
   as an optimization gated by the same signed catalog, not as an open index.

Consequence: "publish" and "curate" are the same operation. There is no untrusted upload path in
the first release; content enters the catalog through the curator's own tooling, which produces the
info document, signs it, seeds it, and distributes it to the tracker.

## 3. Architecture constraints in Entropy

The engine's shape forces a specific split, and the plan follows the pattern the codebase already
uses for MCP (`src/mcp/mod.rs`) and the DAW collaboration proposal (`docs/DAW_COLLABORATION_DESIGN.md`).

- The addon runtime is a `deno_core` V8 isolate (`JsRuntime` in `src/deno/addon_engine.rs`). It is
  **not** `Send`/`Sync` and is driven synchronously from the render thread. Network and disk I/O
  must never block that thread.
- A Tokio runtime already exists (`#[tokio::main]` in `src/bin/example.rs` and `editor.rs`), and
  `tokio` is already a `full` dependency.
- The established bridge pattern is a background thread/task that sends messages over an
  `mpsc` channel, drained once per frame in `Editor::about_to_wait` (`src/startup.rs`), exactly how
  `mcp_rx` is drained today.

Therefore the P2P layer is a **Rust-side, async "network service"** that owns all sockets and piece
storage and exposes a small, non-blocking, poll-based surface to addons:

- Deno ops are "start" and "poll" shaped (like `Net.fetchText`/`pollText`, `Vst3.scan`/`scanPoll`,
  `Video.export`/`pollExport`). Nothing blocks the frame.
- The network service runs its own tokio tasks for connections, piece transfer, and disk writes.
- Progress/events flow back to the addon as a bounded event queue, drained from `onUpdate`.

This mirrors the DAW collaboration document's rule: network I/O stays off the UI and audio threads.

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
  the content id depends on it. `serde_json` with a hand-rolled canonicalizer, or a binary encoding
  (`bincode`, already in the tree), are both candidates; the exact choice is a decision to make
  before any content ships, because ids are only as stable as the encoding.
- The signed envelope wraps the info document with a curator signature:

```jsonc
{ "info": "<info document>", "curator": "<key id>", "signature": "base64(Ed25519 over canonical info bytes)" }
```

A **content id** is `SHA-256(canonical(info_document))`. This is the stable handle peers use in all
have/want/request messages. Piece hashes are flat in the first release; a Merkle tree is a later
option if we want per-piece streaming verification of huge files without shipping the full list up
front (the list is tiny - 32 bytes per 256 KiB, ~17 KiB per GiB - so flat is fine for now).

### 4.2 Transport framing

One QUIC connection per peer, two channels:

- **Bidirectional streams**: reliable, ordered. One stream per piece request carries the request
  header and the piece bytes, then closes. A few control streams (handshake, metadata fetch,
  request/response for the info document) are opened on demand.
- **Unreliable datagrams**: presence, `HAVE` gossip, bitfield deltas, and piece-request cancellation.
  These are best-effort and re-derivable; losing one costs a redundant request, not correctness.

Messages are length-prefixed and version-tagged. The envelope is `{ protocol, message, payload }`,
where `payload` is either compact JSON or, for binary-heavy messages, a fixed binary layout. The
info document and piece data are binary; control messages are JSON for debuggability.

### 4.3 Message set (initial)

| Message | Channel | Direction | Purpose |
| --- | --- | --- | --- |
| `hello` | stream | both | peer id, protocol version, supported schemas, curator key ids |
| `get_info` / `info` | stream | req/resp | fetch an info document + signature by content id |
| `have` | datagram | both | "I hold piece N of content C" (coalesced) |
| `bitfield` | stream | both | full piece map on connect (batched `have`) |
| `want` | datagram | both | "send me pieces X..Y of content C" (informed by scheduler) |
| `piece` | stream | resp | piece bytes + content id + index |
| `cancel` | datagram | both | stop a pending piece request |
| `have_all` / `done` | both | both | completion signals, for seed accounting |

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
- Serving is read-only over the curated catalog: a peer serves pieces only for content ids whose
  info document it holds and whose signature verifies. It never serves arbitrary filesystem paths
  (the same rule the DAW collaboration doc states: a peer cannot name another machine's path).

## 6. Discovery and NAT

- **Tracker.** A small HTTP/JSON tracker (or a QUIC-based tracker) holds, per content id, a set of
  recent peer endpoints, like a private BitTorrent tracker. The curator controls what it lists, so
  listing something is also a curation act. This is the simplest correct starting point and it
  reinforces the control model. It can be the same tiny_http approach already used for MCP, or a
  separate small service.
- **Bootstrap list.** Peers ship with a configured, explicit list of tracker/bootstrap endpoints;
  there is no open crawl. Manual "join by address/code" is kept for the same reasons the DAW
  collaboration doc keeps it (VLANs, multicast-blocked routers, firewalls).
- **NAT traversal is the hard, honest part.** QUIC alone does not punch a hole between two
  NATed peers. However, we will not rely on a relay or proxy server at all. If necessary, we can keep
  one database table in the cloud for tracking uploads, but it will be publicly available so we need to manage what is put in.
  The idea of doing authentication is probably a step too far, but definitely a CDN or transferring large assets over relay is forbidden.
  We can discuss this though and do what is necessary, so long as we don't transfer or store large files over the proxy / relay.

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

- **Identity and transport.** Ed25519 peer identities; QUIC with TLS 1.3. Certificates are either
  self-signed and pinned by peer id (libp2p-QUIC style) or issued by the curator. Curator-issued is
  cleaner for the control story and is the recommendation.
- **Verification everywhere.** Every piece is SHA-256 checked against a signature-verified info
  document before it is trusted or re-shared.
- **Rate and size limits.** Cap per-connection streams, in-flight piece requests, message sizes,
  and the number of concurrent pieces; enforce backpressure so a slow disk or player never
  unboundedly buffers.
- **Penalties.** Peers that send bad hashes, oversized pieces, or protocol-invalid messages are
  disconnected and, on repeat, temporarily banned by the tracker (a "trust score" the curator can
  act on).
- **No arbitrary fetch.** The network service only writes to `p2p/<content_id>/` and only for
  signature-verified content. It does not expose a generic "fetch this URL/this path" primitive.
- **Consent.** Hosting/uploading (serving pieces, running a relay, opening a listening socket) is
  opt-in and surfaced in the UI before the socket opens - same stance as the DAW collaboration doc.

## 9. The P2P file browser

A new addon, `p2p_file_browser_addon.ts`, following the existing media player's structure
(`apps/media_player_addon.ts`):

- Lists the catalog from the tracker + local store: name, size, type, media metadata, seed/peer
  count, local availability.
- Actions per item: **download** (rarest-first to completion, then seed), **play** (stream via the
  player, section 10), **open folder**, and **seed/stop seeding** for local files.
- Shows per-item progress: pieces fetched, verified, remaining, per-peer contribution, and transfer
  rate. Reuses the `Widget.treeView` / `Widget.card` / `Widget.progress`-style primitives already
  in `entropy_gui`.
- The "browser" is also the entry point for curation: the curator's tooling publishes here.

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
| `meta.rs` | Info document schema, canonical serialization, signing/verification, content id derivation. |
| `identity.rs` | Peer keypairs, curator keys, certificate handling, connect-time authentication. |
| `pieces.rs` | On-disk piece store, bitmap, SHA-256 verification, promote-to-seed. |
| `scheduler.rs` | Rarest-first and sequential-ahead scheduling, in-flight caps, cancellation, seek reprioritization. |
| `transport.rs` | QUIC endpoint (`quinn`), stream + datagram framing, connection management, backpressure. |
| `tracker.rs` | Tracker client (announce/peers); the tracker itself can be a separate small service. |

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

## 12. Dependencies

- `quinn` 0.11 and `rustls` 0.23 are **already in the lock file** (transitively via the existing
  HTTP stack), so adding QUIC is effectively free from a dependency-resolution standpoint.
- `rcgen` for self-signed cert generation (small, new), or reuse an existing TLS identity if
  curator-issued certs are chosen instead.
- `sha2` (already transitive) and `ed25519-dalek` (new) for hashing and signatures; `bincode`
  (already transitive) as the canonical binary encoding candidate.

## 13. Delivery sequence and acceptance checks

Phased, each phase gated on the one before it, in the BDD style the repo already uses
(`tests/*_bdd.rs`, `tests/*.feature`).

1. **Content model.** Info document, canonical encoding, signing, content ids. Tests: deterministic
   ids, signature rejection, version rejection.
2. **Local piece store.** Split/verify/assemble a file, resume from a partial bitmap, promote to
   seed. Tests: corrupt piece rejected, resume exact, idempotent.
3. **Two-process localhost session.** Two peers, one seeded, one downloads via QUIC over loopback.
   Tests: full transfer, out-of-order pieces, duplicate/retried requests, disconnect/reconnect.
   A localhost pair is the same shape as the DAW collab doc's two-process test.
4. **Scheduler.** Rarest-first vs sequential-ahead correctness on a small synthetic swarm. Tests:
   completes, no piece fetched twice from the same peer, seek reprioritizes.
5. **Trackers and membership.** Curated tracker, signed peer identities, join by code. Tests:
   unknown peer refused, unsigned content ignored, tracker lists only curated items.
6. **P2P file browser addon.** Catalog, download, seed, progress. Live BDD with two windows.
7. **P2P media player addon.** Stream + seek + rebuffer. Live BDD against a seeded local file and
   a second peer. This is where the spool-then-play choice is exercised end to end.
8. **Relay fallback and NAT.** Relay for NATed peers; measure first-play latency and seek latency on
   a real Wi-Fi/LAN before claiming anything.
9. **Byte-source decoder (optional).** Remove the disk copy; benchmark memory and start latency.

## 14. Decisions to discuss

- **Curator model:** single key vs a key ring vs a quorum; how content is proposed and approved.
- **Canonical encoding:** canonical JSON vs binary (`bincode`/CBOR); locks the content id forever.
- **Piece length** default (256 KiB vs 1 MiB) and whether it is per-content.
- **Tracker:** reuse tiny_http style service vs a standalone process; who runs it in production.
- **Certificates:** curator-issued vs self-signed-pinned-by-peer-id.
- **Relay vs hole punching** in the first release (recommend relay first; it is more work but
  predictable, and hole punching can follow).
- **Streaming decode:** confirm spool-to-temp-file first, defer the custom byte-source.
- **Seeding policy:** does the browser auto-seed completed downloads by default, and with what
  upload caps.
