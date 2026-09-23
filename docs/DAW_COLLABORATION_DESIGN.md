# DAW collaboration design

Status: investigation and implementation proposal, 2026-09-22. No collaboration code has been built or tested.

## Scope and recommendation

Start with shared editing of tracks, patterns, notes, clips, mixer settings, and transport state. Each participant renders audio locally. Use a host-authoritative session with an ordered command log and periodic project snapshots. On the same LAN or Wi-Fi network, discover the host with DNS-SD/mDNS and connect directly. Also allow an invite address when multicast discovery fails. The LAN host serves the project snapshot and required asset files directly to joining peers.

There are two complete connection approaches: (1) direct LAN/Wi-Fi, where the host runs both the live session and file transfer; (2) a user-owned Cloud API plus CDN/object store, where the API provides the live session and the CDN/object store delivers files. Both use the same project command and asset-manifest formats, but LAN does not depend on a cloud service. A CDN by itself cannot replace a bidirectional, low-latency session service.

## Existing integration points

- `examples/studio-bundle/src/apps/daw_synth_addon.ts` owns `project: DAWProject`, changes it in UI callbacks and MCP tool handlers, and persists the entire object through `addon.IO.save(project)` or a 250 ms debounce. A second writer cannot safely edit the same JSON file.
- `examples/studio-bundle/src/apps/daw_arrangement.ts` contains pure clip/pattern/time functions that can become command validators and reducers. Notes are identified only by row, step, length, velocity; add stable note IDs or define note-cell identity explicitly.
- `src/deno/addon_ops.rs` writes an addon JSON file synchronously. Session snapshots need a new persistence path with atomic replace and schema/version metadata; do not use concurrent writes to the existing DAW.json.
- `daw_rack.ts` saves absolute sample paths. Wavetable table data and VST3 state are base64 in the project; VST3 also saves a local plugin path. These need portable asset references or compatibility rules before another computer can reproduce a project.
- The transport uses `Date.now()` and fires elapsed steps in `onFrame`, skipping backlogs above 32 steps. It is not an audio-clock scheduler and cannot promise sample-aligned multi-machine playback.
- The existing MCP HTTP server binds `127.0.0.1` and exposes AI tools. It is not a LAN collaboration server and should remain separate.

## Proposed modules

| Module | Responsibility |
| --- | --- |
| `daw_collab_model.ts` | Versioned command types, validation, pure reducers, deterministic serialization, migration. |
| `daw_collab_client.ts` | Pending commands, optimistic UI, acknowledgements, rollback/rebase, reconnect and presence. |
| `src/collab/` | Native session host/client, WebSocket messages, mDNS discovery, authentication, persistence, direct LAN asset transfer. Network I/O stays off the UI and audio threads. |
| `Entropy.Collab` in `addon_setup.js` and `addon.d.ts` | Start/join/leave, poll events, submit commands, request assets and observe status. The DAW drains bounded events in its existing update callback. |
| `daw_assets.ts` | Manifest of content hashes, media type, length, local cache path and optional remote locator. Resolve samples before playback or export. |

## Wire protocol

Use a versioned JSON envelope first; binary transfer is separate. Each command has `{sessionId, clientId, opId, baseRevision, kind, payload}`. The host checks authorization and invariants, assigns a monotonically increasing `revision`, appends the command to a log, applies it once, and broadcasts the authoritative result. `opId` makes retries idempotent. The join response includes protocol/schema versions, a snapshot at revision `R`, its hash, asset manifest, and commands after `R`. Reject incompatible versions explicitly.

Commands should be domain operations, for example `note.upsert`, `note.delete`, `clip.move`, `clip.resize`, `track.add`, `track.patch`, `pattern.add`, and `tempo.set`. Coalesce drag and knob updates to a limited rate, then send the final value on pointer release. Do not broadcast whole project JSON for every movement. Although we haven't decided whether or not to keep selection, panel visibility, analyzer view, and cursor position local, and just broadcast ephemeral presence separately?

For concurrent writes, serialize through the host. Independent object edits merge. Two edits to one property resolve in host order, with the losing client visibly corrected. Validate clip non-overlap and track/pattern references on the host using the arrangement model. A destructive delete wins over later edits to the deleted object, which are rejected. This is simpler and more predictable for this schema than introducing a general CRDT in the first release. Preserve local command history for reconnect and undo; an undo submits a new inverse command with the current revision, rather than rewinding the shared log.

The host persists periodic snapshots and the command log using atomic writes. On reconnect, a client sends its last applied revision and pending `opId`s; the host replays missing accepted commands or sends a fresh snapshot. A disconnected client can keep a local fork, but it must not silently overwrite the session when reconnecting. Expose `Syncing`, `Live`, `Offline changes`, and `Conflict` states.

## Discovery and transport

Advertise a session service such as `_entropy-daw._tcp.local` with a random session ID, protocol version and display name. mDNS is local-link discovery, so retain `Join by address/code` for guest Wi-Fi, VLANs, multicast-blocking routers and firewalls. The host binds only the selected private interface, and the UI asks the user to host before opening a listening socket. A LAN session uses one WebSocket for ordered commands, acknowledgements, presence and transport messages, plus HTTP or streamed binary endpoints for snapshots and assets. Do not route user traffic through the existing loopback MCP endpoint.

On join, the host sends the project snapshot and an asset manifest. The peer compares SHA-256 hashes against its local cache, requests only missing files from the host, transfers them in bounded chunks with resume support, and verifies each completed file before making it available to playback or export. The host serves only assets listed in this session's manifest; a peer never supplies an arbitrary host filesystem path. Asset transfer should run independently of command delivery, so a large sample download does not block note or mixer edits. Show per-asset progress and missing/unavailable status. With the built-in synth and drum voices, many projects need no external file transfer; sample pads and any other external media do.

Generate an unguessable invitation secret; authenticate at connect and use per-session editor/viewer roles. Rate-limit joins, cap message and asset sizes, validate every command and path, and avoid serving arbitrary local files. On untrusted Wi-Fi, offer TLS with a pinned host fingerprint; a plain `ws://` mode should be explicitly limited to trusted networks. A user-provided remote backend uses `wss://` and HTTPS.

## User-owned Cloud API and CDN approach

This is an alternative to direct LAN hosting, not a requirement for it. Expose two configuration slots for this approach:

1. **Cloud API**: `connect`, `send`, `receive`, `resume`, and authentication. A user-owned service relays the same versioned command protocol and host authority over `wss://` (or runs the authoritative session itself in a later mode).
2. **CDN/object store**: `has(hash)`, `put(hash, bytes)`, `get(hash)` and optional short-lived URL issuance. A user-owned store delivers the same content-addressed assets over HTTPS, including presigned upload/download URLs. Credentials stay in the native layer or OS credential store, never in project JSON or an invite.

The project manifest refers to assets by SHA-256 hash and metadata, not absolute machine paths or CDN URLs. Upload only assets actually used by the session, verify hashes after download, and cache locally. Sample pads resolve their hashes to local files for the existing audio loader. Wavetable blobs and VST3 patch state can use the same mechanism once size thresholds warrant it. A VST3 binary is not shared automatically: each peer must have a compatible local plugin, otherwise show the track as unavailable and optionally use a host-rendered stem in a later phase. The host must not expose paths from another user's disk. Make backend endpoint, auth method, namespace/bucket and retention policy user configurable, with a connection test in settings.

## Shared playback

Phase 1 shares play/stop/seek/tempo/mode as sequenced host commands; each participant hears their local engine. This gives a common musical position but not sample accuracy. For better sync, host transport messages should include a monotonic host timestamp, revision and future effective beat/bar. Clients estimate clock offset with repeated ping/round trips and schedule the transition ahead of time. The current frame-based `Date.now()` sequencer must move to an audio-clock or buffer lookahead scheduler before promising tight sync or recording aligned across machines. Treat live instrument monitoring and recorded audio capture as separate later features; streaming a mixed audio feed is a distinct low-latency media problem.

## Delivery sequence and acceptance checks

1. Extract DAW mutations into pure commands/reducers, add stable IDs and schema migration, and make UI and MCP edits use the same path. Test deterministic replay and rejection of invalid edits.
2. Build a two-process localhost session test: join from snapshot, edit on both peers, duplicate/reordered/retried messages, disconnect/reconnect, and host restart. Add live BDD coverage for two DAW windows.
3. Add LAN discovery, invite authentication and direct connection. Verify Windows firewall and multicast-blocked manual join on two physical machines, then check macOS/Linux separately.
4. Add content-addressed assets and portable sample resolution. Verify both peers can play and export the same project with different local filesystem layouts.
5. Add the user-owned Cloud API and CDN/object-store approach against a documented reference service. Test expired credentials, unavailable backend, checksum failure and interrupted upload; LAN sessions continue to work without that service.
6. Improve transport scheduling and measure inter-peer playhead and audio onset error on wired LAN and Wi-Fi before claiming tighter synchronization.

Open product decisions: whether a remote backend may be authoritative, whether offline edits auto-rebase or require review, whether the first release needs host migration, and whether synchronized monitoring/recording is in scope. Recommend a fixed host and explicit conflict review for the first release.
