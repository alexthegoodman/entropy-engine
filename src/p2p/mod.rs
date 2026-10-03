//! P2P swarm content-distribution layer (docs/P2P_PROTOCOL_DESIGN.md).
//!
//! BitTorrent-inspired swarming with a curated catalog: content addressing, fixed-size
//! pieces, have/want exchange, rarest-first/sequential scheduling - but deliberately *not*
//! interoperable with BitTorrent, and gated behind a group code plus a signed room index.
//!
//! Phases 1-5 provide transport backends, content metadata, verified storage, sessions,
//! and bounded rarest-first/sequential-ahead scheduling. KCP is the primary backend;
//! QUIC remains available behind the same transport seam.

pub mod meta;
pub mod pieces;
pub mod scheduler;
pub mod session;
pub mod transport;
pub mod wire;
