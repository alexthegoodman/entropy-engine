# P2P forum

The forum is the Phase-9 product surface. Its room worker owns networking, local storage,
author signing, tracker synchronization and verified post transfers. The render thread only
queues commands and polls a coalesced snapshot. Physical NAT and no-relay validation remains
Phase 8; these instructions exercise Windows loopback.

## Try a local room

Run from `entropy-engine/`:

```powershell
deno bundle examples/studio-bundle/src/apps/p2p_forum_addon.ts --output examples/studio-bundle/dist/p2p_forum.js
cargo run --bin p2p_room_setup -- test-artifacts/forum-demo
```

The setup command creates Alice, Bob, reader and maintainer profiles, plus an empty tracker
snapshot. It prints the tracker command with the random room and maintainer public pins.
Run that command in a separate terminal. The tracker stores signed metadata, never post bodies
or private keys. In two more terminals:

```powershell
$env:ENTROPY_P2P_DATA = 'test-artifacts/forum-demo/alice'
cargo run --bin example -- p2p-forum
```

```powershell
$env:ENTROPY_P2P_DATA = 'test-artifacts/forum-demo/bob'
cargo run --bin example -- p2p-forum
```

Click **Join room** in both windows. Publish a title and body in each; click the other member's
post to download it. Completed downloads automatically re-seed while the app is joined.
Start the reader profile, download both posts, then close Alice and Bob and reopen one to
download from the reader. The maintainer profile can remain offline throughout publishing.
Start it later to remove publications, ban authors or close/reopen member publishing.
Authors can withdraw their own posts. Replies reference a signed parent publication.

Use a different profile for each simultaneous window. Setup refuses an existing destination;
choose another folder for a new demo. Fixed demo UDP ports are 47201-47204 and tracker port is
47110. Custom rooms accept trusted room/maintainer pins, group code, local node ID/port and an
optional HTTP(S) tracker. Peers JSON can be empty: verified tracker hints supply bounded KCP
bootstrap candidates. Explicit peer ID/socket pairs take precedence over hints. A configured
peer permits room exchange and downloads during a tracker outage. For non-loopback experiments,
set the advertised socket to the address the tracker sees; this does not establish NAT routes.

## Reusable API

`Entropy.P2P` is available globally and through the scoped addon API:

```typescript
Entropy.P2P.start({ room, maintainer, nodeId, port, groupCode, tracker, peers: [] });
Entropy.P2P.command({ action: "publish", title: "Hello", body: "A signed post", parent: null });
Entropy.P2P.command({ action: "fetch", publication: publicationId });
const updated = Entropy.P2P.poll(); // null when unchanged
Entropy.P2P.stop();               // signals shutdown without blocking the frame
```

Commands also include `withdraw`, `remove`, `ban`, `block`, `policy` and `sync`. Startup, command
acceptance and errors are asynchronous: `queued` means admitted to the bounded command queue,
not committed to disk or replicated. Poll reports running/author/maintainer/publishing state,
tracker status, visible posts, cached bodies and availability. Rust callers use
`p2p::service::P2pService`; CLI/tests can call `join` to wait for shutdown. The frame-side
`p2p_client.ts` wrapper caches snapshots. One runtime owns one joined room.

Profiles keep `author.pk8`, `discovery.pk8`, a restart-safe `sequence`, pinned identity and
verified `room.msgpack` under `p2p-room/`. An exclusive OS lock prevents concurrent reuse.
Sequence reservation precedes signing; a crash can leave a harmless gap. Corrupt keys,
sequence rollback, invalid snapshots and changed profile trust/node pins fail startup.
Back up the profile together. A maintainer imports its PKCS#8 key as `author.pk8` while the
profile is stopped; the demo creates this file only in the maintainer profile.

## Scope and bounds

- UTF-8 text posts are 1-16 KiB, one SHA-256-verified piece each; titles are 1-256 bytes.
  Bodies are fetched on request. Signed descriptions contain no body bytes. Downloaded text
  is verified again on restart before serving. Metadata arrival never downloads assets.
- Catalog visibility and transfer authorization use the same verified room index, including
  withdrawals, bans, content tombstones, policy closure and conflicting author sequences.
  Cached disk bytes survive moderation; removed content is hidden and not served. Reopening
  policy restores eligible verified caches, including after restart.
- Queues: 32 commands, 64 adapter events, 16 active channel/sync/send tasks, 64 peer candidates;
  coalesced latest UI state. KCP's upstream receive queue is locally patched to 64 messages.
  Incoming frames retain the existing 16 MiB cap and five-second service channel deadline.
- Tracker polls every five seconds, refreshing up to four seeder hints and querying two
  contents per cycle. Hints expire normally; large rooms with more than 64 actively seeded
  posts need batched announcements before all seeds can maintain a 90-second lease.
- Index limits remain 4,096 records / 4 MiB. Large assets, streaming windows and large bitfields
  remain the existing `Session`/scheduler path and later product work. The forum adapter
  deliberately accepts only its bounded single-piece text format.
- KCP pieces retain the previously documented encryption limitation. Deployment, physical NAT,
  direct-only payload enforcement and production load are unverified. QUIC is a fallback;
  its adapter has bounded events and explicit `shutdown`, while upstream queue auditing remains
  necessary before integrating it into the service.

Acceptance features are `tests/features/p2p_service.feature` and
`tests/features/p2p_forum_live.feature`. The live driver runs two actual native windows with
separate profiles, invokes the UI's handlers, verifies rendered labels and saves screenshots.

```powershell
cargo test -j 1 --offline --test p2p_service_bdd --test p2p_forum_live
cargo test -j 1 --offline --lib p2p
cargo test -j 1 --offline --test p2p_tracker_bdd --test p2p_room_bdd --test p2p_scheduler_bdd --test p2p_swarm --test p2p_session
```
