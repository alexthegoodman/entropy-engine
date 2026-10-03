//! Wire protocol: the versioned envelope and message set peers speak (docs/P2P_PROTOCOL_DESIGN.md
//! section 4.2 / 4.3).
//!
//! Every message is a single `Envelope` serialized with `rmp-serde` (MessagePack), matching the
//! canonical-encoding choice made for the info document. The envelope carries a `protocol` version
//! so a future incompatible change can be rejected explicitly, and an `Msg` discriminant with the
//! per-message payload. Control messages (`Hello`, `Have`, `Bitfield`, `Want`, `Cancel`, `Done`)
//! travel over the best-effort datagram plane; `GetInfo`/`Info` and `Piece` travel over a reliable
//! channel (the `piece` bytes are the only message with a meaningful body size, and they must not
//! be re-split or reordered).
//!
//! This module is transport-agnostic: it knows nothing about KCP, QUIC, or any backend. The
//! framing decision - one envelope per datagram, one envelope per reliable-channel message - is
//! left to the transport adapters, which already expose exactly those two shapes
//! (`send_datagram` and the message-oriented `ReliableChannel`).

use serde::{Deserialize, Serialize};

use super::meta::HASH_LEN;

/// The one wire-protocol version this build understands.
pub const PROTOCOL_VERSION: u32 = 1;

/// A content id: `SHA-256(canonical(info_document))`. The stable handle peers use everywhere.
pub type ContentId = [u8; HASH_LEN];

#[derive(Debug)]
pub enum WireError {
    UnsupportedProtocol { found: u32 },
    Decode(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::UnsupportedProtocol { found } => {
                write!(f, "unsupported wire protocol {found} (expected {PROTOCOL_VERSION})")
            }
            WireError::Decode(e) => write!(f, "wire message decode failed: {e}"),
        }
    }
}

impl std::error::Error for WireError {}

/// The full initial message set (section 4.3). The session in this phase uses the `Want`/`Piece`/
/// `Done` subset; the rest are defined and round-trip-tested here so later phases (room index,
/// scheduler) do not have to re-invent the vocabulary.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum Msg {
    /// Protocol version, supported schemas, group membership. First message on a connection.
    Hello { version: u32 },
    /// Request the info document for a content id (reliable channel, request).
    GetInfo { content: ContentId },
    /// Response carrying the canonical info document bytes.
    Info { document: Vec<u8> },
    /// "I hold piece N of content C" (coalesced).
    Have { content: ContentId, index: u32 },
    /// Full piece map on connect (batched `have`).
    Bitfield { content: ContentId, bitmap: Vec<u8> },
    /// "Send me piece N of content C" (informed by the scheduler).
    Want { content: ContentId, index: u32 },
    /// Stop a pending piece request.
    Cancel { content: ContentId, index: u32 },
    /// Completion signal, for seed accounting.
    Done { content: ContentId },
    /// Piece bytes + content id + index (reliable channel, response to `want`).
    Piece {
        content: ContentId,
        index: u32,
        data: Vec<u8>,
    },
}

/// The versioned envelope: `{ protocol, msg }`. Every datagram and every reliable-channel message
/// is one of these.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Envelope {
    pub protocol: u32,
    pub msg: Msg,
}

impl Envelope {
    pub fn new(msg: Msg) -> Self {
        Self {
            protocol: PROTOCOL_VERSION,
            msg,
        }
    }

    /// Serializes to the exact bytes that go on the wire.
    pub fn encode(&self) -> Vec<u8> {
        rmp_serde::to_vec(self).expect("wire envelope serializes to messagepack")
    }

    /// Parses and validates, rejecting unknown protocol versions.
    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        let env: Envelope =
            rmp_serde::from_slice(bytes).map_err(|e| WireError::Decode(e.to_string()))?;
        if env.protocol != PROTOCOL_VERSION {
            return Err(WireError::UnsupportedProtocol { found: env.protocol });
        }
        Ok(env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cid() -> ContentId {
        [0xAB; HASH_LEN]
    }

    #[test]
    fn roundtrip_every_message() {
        let messages = vec![
            Msg::Hello { version: PROTOCOL_VERSION },
            Msg::GetInfo { content: cid() },
            Msg::Info {
                document: b"\x87a schema".to_vec(),
            },
            Msg::Have {
                content: cid(),
                index: 3,
            },
            Msg::Bitfield {
                content: cid(),
                bitmap: vec![0b1010_0101, 0b1111_0000],
            },
            Msg::Want {
                content: cid(),
                index: 7,
            },
            Msg::Cancel {
                content: cid(),
                index: 7,
            },
            Msg::Done { content: cid() },
            Msg::Piece {
                content: cid(),
                index: 2,
                data: (0u8..=255).collect(),
            },
        ];

        for msg in messages {
            let env = Envelope::new(msg.clone());
            let bytes = env.encode();
            let back = Envelope::decode(&bytes).unwrap();
            assert_eq!(back.msg, msg, "message did not round-trip");
        }
    }

    #[test]
    fn protocol_version_is_checked() {
        let env = Envelope::new(Msg::Done { content: cid() });
        let mut bytes = env.encode();
        // Scribble over the protocol field: it is the first key/value in the map, so decode the
        // struct, bump it, and re-encode is the robust way to test rejection.
        let mut tampered: Envelope = rmp_serde::from_slice(&bytes).unwrap();
        tampered.protocol = 999;
        bytes = rmp_serde::to_vec(&tampered).unwrap();

        assert!(matches!(
            Envelope::decode(&bytes),
            Err(WireError::UnsupportedProtocol { found: 999 })
        ));
    }

    #[test]
    fn piece_payload_is_binary_efficient() {
        // A `Piece` whose body is 64 KiB must not be hex/base64-expanded by the encoding; MessagePack
        // carries `Vec<u8>` as a raw bin. The exact byte size is not the contract, but it must stay
        // within a small multiple of the payload.
        let data = vec![0x5Au8; 64 * 1024];
        let env = Envelope::new(Msg::Piece {
            content: cid(),
            index: 0,
            data,
        });
        let bytes = env.encode();
        assert!(bytes.len() <= 64 * 1024 + 128, "piece payload bloated to {} bytes", bytes.len());
    }
}
