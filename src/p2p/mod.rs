//! P2P swarm content-distribution layer (docs/P2P_PROTOCOL_DESIGN.md).
//!
//! BitTorrent-inspired swarming with a curated catalog: content addressing, fixed-size
//! pieces, have/want exchange, rarest-first/sequential scheduling - but deliberately *not*
//! interoperable with BitTorrent, and gated behind a group code plus a signed room index.
//!
//! This module is currently at the phase-1 evaluation-spike stage: `transport.rs` defines
//! the `P2pTransport` seam, and `transport/{rustp2p,quic}.rs` are the two candidate
//! backends being evaluated side by side. Only the chosen backend survives past the spike.

pub mod meta;
pub mod pieces;
pub mod session;
pub mod transport;
pub mod wire;
