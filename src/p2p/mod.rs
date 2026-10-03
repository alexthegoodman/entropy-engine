//! P2P swarm content-distribution layer (docs/P2P_PROTOCOL_DESIGN.md).
//!
//! BitTorrent-inspired swarming with a curated catalog: content addressing, fixed-size
//! pieces, have/want exchange, rarest-first/sequential scheduling - but deliberately *not*
//! interoperable with BitTorrent, and gated behind a group code plus a signed room index.
//!
//! Phases 1-7 provide transport backends, content metadata, verified storage, bounded scheduling,
//! and member-signed publications with maintainer moderation and catalog enforcement.
//! A public tracker/client persist verified room records and expire signed discovery hints.
//! Schema-2 room records bootstrap over reliable channels. KCP is the primary backend;
//! QUIC remains available behind the same transport seam.

pub mod allow;
pub mod index;
pub mod meta;
pub mod pieces;
pub mod rendezvous;
pub mod scheduler;
pub mod session;
pub mod service;
pub mod transport;
pub mod tracker;
pub mod wire;
