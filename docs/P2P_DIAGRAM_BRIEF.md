# Entropy P2P diagram brief

This describes the revised target architecture as of 2026-10-02. Phases 1-7, including
member publishing, moderation and local tracker/client, exist in Rust. Persistent service and
product UI are still planned. Real NAT traversal and direct-only enforcement remain to be verified.

## Diagram-ready prompt

Create a wide architecture diagram titled "Entropy P2P: member publishing, direct content sharing".
Use solid boxes for implemented components, dashed boxes for planned components, and muted boxes
for later features. Use distinct arrow colors for signed metadata, discovery/control, and payload
pieces. Label arrows clearly and include a legend. Show the following:

**Three Entropy peers**, A, B and C, each containing a local content store and the same P2P stack.
A and B are ordinary members who can independently publish posts, videos or files. C discovers,
downloads, verifies and optionally re-seeds their content. Members do not need the maintainer
online or prior approval to publish in an open room. Signing identities are distinct from
transport peer IDs.

Inside an expanded peer show these layers:

- Planned TypeScript surfaces: forum first, then file browser and media player/media channel.
- Planned non-blocking `Entropy.P2P` start/command/poll bridge and background `P2pService`.
  Network and disk work stay off the UI/audio threads. Task ownership, bounded queues,
  multi-content dispatch and automatic key/sequence/index persistence belong here.
- Implemented room catalog policy and transfer sessions: gate requests, serving and storage
  on currently eligible content; cancel transfers when eligibility disappears.
- Implemented piece scheduler: rarest-first for complete downloads; sequential-ahead and
  seek cancellation for future streaming.
- Implemented versioned MessagePack wire protocol and `P2pTransport` abstraction.
- Implemented transport backends: KCP/rustp2p is primary; QUIC is the fallback.
  Show LAN/mDNS as an optional future backend.
- Implemented local piece store: content-addressed info documents, SHA-256 piece checks,
  resumable bitmap, verified writes and promotion of a completed file for seeding.

Show a **replicated room record set** beside the peers. Each room has an externally pinned room
ID and maintainer public key. Each author has a locally generated Ed25519 signing key, without
an account or login. Publications contain author key/sequence, kind, title/description, payload
content ID, media hints and optional parent publication ID for replies. Publication IDs are
distinct from payload content IDs. Valid records merge deterministically; author sequence
conflicts are retained and their publications hidden. The current limit is 4,096 records / 4 MiB.

Show a separate **room maintainer** actor whose private key stays on their device. Members can
withdraw their own publications. The maintainer alone can remove a publication, block a payload
content ID, ban an author key, or change member-publishing policy. Durable removal records defeat
stale replicas. Removing one post does not block the same payload through another eligible post;
a content block does. Bans apply to keys, not real-world identities. Replicated state derives the
catalog of content permitted to circulate.

Above the peers show an **implemented local Rust tracker**, run locally first and later on a
DigitalOcean droplet. It contains two separate stores: durable verified public room records,
and expiring peer/seeder announcements. Label its four API operations: `get_index`, `put_records`,
`put_announce`, `get_peers`. The tracker verifies member signatures and pinned maintainer
authority, and applies bounds and rate limits. It never holds private signing keys, group secrets
or asset payloads. Its peer lists are untrusted connection hints, not proof of seeding.

Draw signed metadata arrows among peers and between peers and tracker. Reliable `RoomRecords`
messages let a peer validate and merge metadata before payload authorization. Discovery arrows
connect peers to the tracker for index updates, announcements and lookup. HTTP discovery does
not itself establish transport routes or perform NAT punching; the transport backend must
establish the connection using discovered hints/bootstrap coordination.

Draw thick payload-piece arrows **directly between A, B and C**, never through the tracker.
Label the direct-only/no-payload-relay rule as required, with enforcement and physical NAT
verification pending. Label current tested connectivity "localhost/loopback". Group code and
optional PSK belong to peer transport configuration. Do not label KCP piece streams encrypted:
the current backend has a documented piece-encryption limitation. SHA-256 integrity verification
is implemented; QUIC offers the encrypted transport alternative.

Add a small availability note: "No recent seeder announcements = unavailable, not deleted".
Peers retain durable metadata when seeders disappear. Known peers with replicated state can
continue sharing during tracker outages; cold start still needs a reachable bootstrap address.
Offline peers cannot learn moderation changes until synchronization resumes.

For the later media player, show a muted path from verified pieces to a temporary spool file
and the existing audio/video decoder, with buffering, sequential lookahead and seek cancellation.
This is planned playback integration, not an already verified progressive decoder path.

Add a roadmap footer: "Implemented locally: phases 1-7. Next: persistent service, then forum.
Later: deployment, physical NAT verification, file browser, media player, incremental room synchronization."

## End-to-end story

1. Join with trusted room configuration; verify replicated records before deriving catalog permissions.
2. A member prepares content locally, hashes its info document and pieces, signs a publication and
   shares metadata. They seed the payload under explicit hosting consent.
3. Another member learns the publication, discovers candidate seeders, establishes a peer connection,
   obtains the matching info document and requests pieces. Each piece is verified before storage.
4. Completed content can be re-seeded, so the original publisher is no longer the only source.
5. Author withdrawals and maintainer moderation replicate through the same record system;
   eligible content and active transfers update immediately when those records are merged.

See [P2P_PROTOCOL_DESIGN.md](P2P_PROTOCOL_DESIGN.md) for the protocol and remaining work.
