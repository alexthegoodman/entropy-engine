# P2P forum

The forum is the Phase-9 product surface. Its room worker owns networking, local storage,
author signing, tracker synchronization and verified post transfers. The render thread only
queues commands and polls a coalesced snapshot. Physical NAT and no-relay validation remains
Phase 8; these instructions exercise Windows loopback.

## Validation paused after host memory exhaustion (2026-10-03)

Do not launch these recipes or resume builds/tests until the resource precautions are reviewed.
The final rebuild overlapped the two-window native acceptance run and reported
`rustc-LLVM ERROR: out of memory` / `Allocation failed`; the host crashed. This establishes
compiler memory exhaustion, but not the cause of the host crash itself. No complete live result
or final regression result was produced. Earlier service acceptance passed two scenarios;
an earlier all-targets compile check passed. The latest changes remain unbuilt/unvalidated.

The native live test is now ignored by default, requires explicit `ENTROPY_P2P_LIVE_OPT_IN`,
and waits for the first window's room initialization before launching the second. These guards
are source changes only; existing binaries do not contain them. Before resuming, separate
compilation from execution, review Windows commit/pagefile headroom, consider reduced debug
information, and start with one GUI window plus a headless peer. Do not queue competing Cargo
invocations. Further resource guards and startup measurements need review first.

## Resource precautions for future runs (execution remains paused)

Use `--jobs 1` (equivalent to `-j 1`) on every Cargo build/test/run command for this
workflow. Run only one Cargo invocation at a time, and wait for it to exit before starting
another command. Stop native windows and headless peers before compiling. Finish compilation
before starting any peers or GUI windows; launch already-built executables during the demo.
Do not run the native live test alongside another test suite or compiler.

`--jobs 1` limits Cargo compilation concurrency within one invocation. It does not serialize
separate Cargo invocations, limit a single compiler's memory, restrict runtime worker threads,
or reduce the two windows deliberately created by the live test. It cannot guarantee that
compilation fits the machine's memory budget.

For Rust's standard test harness, also pass `-- --test-threads=1` to run test functions
sequentially. Cucumber targets use `harness = false`: do not pass libtest flags to them.
The service BDD already sets `max_concurrent_scenarios(1)` in its runner; other Cucumber
runners need their own scenario-concurrency settings. See the official
[Cargo test reference](https://doc.rust-lang.org/cargo/commands/cargo-test.html).

Before a future rebuild, consider session-scoped reduced debug information:

```powershell
$env:CARGO_PROFILE_DEV_DEBUG = '1'
$env:CARGO_PROFILE_TEST_DEBUG = '1'
```

Level 1 keeps line tables; level 0 removes debug information if further reduction is needed.
Changing these settings can rebuild dependencies, so set them before compilation and keep them
consistent throughout the session. These are proposed settings, not applied project defaults.
See [Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html#debug).
Review Windows committed memory versus its commit limit and available RAM before any run.
Start with one GUI plus a headless peer before returning to the two-window acceptance test.

## Quick start: fake forum demo

One example launches into a ready room: on first run it seeds a signed room with a handful of fake
posts and a few fake peer nodes, so no `p2p_room_setup`, no tracker process, no second window and no
environment variables are needed. From `entropy-engine/`:

```powershell
deno bundle examples/studio-bundle/src/apps/p2p_forum_addon.ts --output examples/studio-bundle/dist/p2p_forum.js
cargo build --jobs 1 --bin example
.\target\debug\example.exe p2p-forum
```

The `deno bundle` line is only needed after editing the addon; the committed `dist/p2p_forum.js`
already carries the auto-join. The demo folder (`../p2p-forum-data`) is seeded once, the first time
the example runs with the default data directory. `seed_forum` (`src/p2p/demo.rs`) writes a signed
`room.msgpack`, the post bodies into the local piece store, and a `p2p-forum.json` config listing
three fake peer nodes. The addon reads that config on init and joins immediately.

What the fake data is:

- The fake peer nodes are loopback sockets that are never running; they exist only so the room and
  its member list look populated.
- The posts are signed by throwaway author keys (`SigningKey::from_seed`) whose private keys are not
  kept. Their bodies are written straight into the piece store, so every post appears already seeded.
- The tracker is unset, so the header shows "Tracker offline"; local publishing and the seeded
  content still work without it.
- Your own profile is real: posts you publish are signed and persisted under `p2p-room/`, and survive
  restarts. **Leave room** returns to the manual join form.

To reset the demo, close the window and delete `../p2p-forum-data`; the next launch reseeds a fresh
room.

## Transitioning away from the fake demo

The fake scenario is scaffolding, not product. Once a real tracker and genuine peers are available,
drop the auto-seed and drive the forum from real rooms. Planned steps:

1. Gate the auto-seed behind an explicit opt-in flag (e.g. `ENTROPY_P2P_DEMO`) instead of "default
   data dir is unset and unseeded", so a real profile is never silently created.
2. Restore the manual join form as the primary path and keep `p2p_room_setup` for provisioning real
   isolated profiles (Alice, Bob, reader, maintainer).
3. Run the real tracker (`src/bin/tracker.rs`) for the room and let configured peers bootstrap from
   verified tracker hints instead of the fake loopback peer list.
4. Delete `seed_forum` (and its `demo_posts`) once the real flow is the default demo path; the
   acceptance tests already exercise the genuine multi-node path.

The real, non-fake run is the multi-node setup below (unchanged from the previous reference, still
paused):

```powershell
deno bundle examples/studio-bundle/src/apps/p2p_forum_addon.ts --output examples/studio-bundle/dist/p2p_forum.js
cargo build --jobs 1 --bin p2p_room_setup --bin tracker --bin example
# Wait for successful completion before launching anything.
.\target\debug\p2p_room_setup.exe test-artifacts/forum-demo
```

The setup command creates Alice, Bob, reader and maintainer profiles, plus an empty tracker
snapshot. It prints the tracker command with the random room and maintainer public pins.
Use its printed arguments with the prebuilt `.\target\debug\tracker.exe` in a separate terminal. The tracker stores signed metadata, never post bodies
or private keys. In two more terminals:

```powershell
$env:ENTROPY_P2P_DATA = 'test-artifacts/forum-demo/alice'
.\target\debug\example.exe p2p-forum
```

```powershell
$env:ENTROPY_P2P_DATA = 'test-artifacts/forum-demo/bob'
.\target\debug\example.exe p2p-forum
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
# Run each command to completion before starting the next; keep native windows closed.
# Cucumber runner: scenarios are serialized in the service runner.
cargo test --jobs 1 --offline --test p2p_service_bdd
cargo test --jobs 1 --offline --lib p2p -- --test-threads=1
# Cucumber targets have their own runners, rather than libtest.
cargo test --jobs 1 --offline --test p2p_tracker_bdd --test p2p_room_bdd --test p2p_scheduler_bdd
cargo test --jobs 1 --offline --test p2p_swarm --test p2p_session -- --test-threads=1
```

The native acceptance test is a separate, explicitly opted-in stage. After the pause is lifted
and headroom is reviewed, compile it with all windows closed:

```powershell
cargo test --jobs 1 --offline --test p2p_forum_live --no-run
```

Wait for successful completion. Copy the exact test executable path printed by Cargo, then run
that executable directly in a separate execution stage. This avoids a rebuild during GUI startup:

```powershell
# Replace <hash> with the path from the successful compilation above.
$liveTestExe = '.\target\debug\deps\p2p_forum_live-<hash>.exe'
$env:ENTROPY_P2P_LIVE_OPT_IN = '1'
try {
    & $liveTestExe --ignored --test-threads=1
} finally {
    Remove-Item Env:ENTROPY_P2P_LIVE_OPT_IN -ErrorAction SilentlyContinue
}
```

The test still owns two native windows; `--test-threads=1` does not change that. Its source now
staggers their startup and cleans up child processes. Rebuild is required before those guards
exist in the executable. None of these commands have been executed since the pause.
