# Entropy patch to rustp2p 0.4.1

Source is the published crates.io 0.4.1 package, with its Apache-2.0 license retained.
Only `src/lib.rs` changes: EndPoint's inbound user-datagram queue uses `flume::bounded(64)`
instead of `flume::unbounded()`. An adapter queue alone cannot bound the upstream backlog.
The existing async sender applies backpressure; service control messages already retry.
Wire format, transport identity, group isolation and KCP behavior are unchanged.

Remove this patch when the upstream crate exposes a bounded receive queue. Acceptance:
the P2P service, room, scheduler, swarm and real KCP process regression suites.
