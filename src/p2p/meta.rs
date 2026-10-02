//! Info document schema, canonical MessagePack encoding, and content-id derivation
//! (docs/P2P_PROTOCOL_DESIGN.md section 4.1).
//!
//! The content id is `SHA-256(canonical(info_document))`, so the canonical encoding is
//! frozen: it is the whole contract. We serialize a `serde_json::Map` (a `BTreeMap`, hence
//! sorted keys) to MessagePack, which is deterministic because every field is either a
//! non-negative integer, a string, or a nested sorted map, and `None` fields are omitted
//! entirely. `rmp-serde` was chosen because `rustp2p` already carries it and it matches the
//! wire framing in section 4.2; the `pieces` field is a base64 string, so there are no
//! binary/array ambiguities in the canonical bytes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The one schema version this build understands. The content id depends on it.
pub const SCHEMA_VERSION: u32 = 1;
pub const HASH_LEN: usize = 32;
pub const DEFAULT_PIECE_LENGTH: u32 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetaError {
    UnsupportedSchema { found: u32 },
    InvalidPieceLength,
    EmptyName,
    PiecesNotMultipleOfHash { len: usize },
    Decode(String),
}

impl std::fmt::Display for MetaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MetaError::UnsupportedSchema { found } => {
                write!(f, "unsupported info document schema {found} (expected {SCHEMA_VERSION})")
            }
            MetaError::InvalidPieceLength => write!(f, "pieceLength must be > 0"),
            MetaError::EmptyName => write!(f, "info document name must not be empty"),
            MetaError::PiecesNotMultipleOfHash { len } => {
                write!(f, "pieces decodes to {len} bytes, not a multiple of {HASH_LEN}")
            }
            MetaError::Decode(e) => write!(f, "info document decode failed: {e}"),
        }
    }
}

impl std::error::Error for MetaError {}

/// Optional media hints for the browser/player. Never part of integrity; never required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
    #[serde(rename = "durationMs", skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// The canonicalized, versioned info document. Field names in the canonical form are
/// camelCase (matching section 4.1), so serde renames are used for the `mediaType` /
/// `pieceLength` / `durationMs` keys.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InfoDocument {
    pub schema: u32,
    pub name: String,
    #[serde(rename = "mediaType", skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    pub length: u64,
    #[serde(rename = "pieceLength")]
    pub piece_length: u32,
    /// Base64 of the concatenated 32-byte SHA-256 of each piece, in order.
    pub pieces: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<MediaInfo>,
    pub created: i64,
}

impl InfoDocument {
    /// Builds an info document from raw bytes, hashing each piece as it goes.
    pub fn for_bytes(
        name: impl Into<String>,
        media_type: Option<String>,
        data: &[u8],
        piece_length: u32,
        created: i64,
    ) -> Self {
        let hashes = piece_hashes(data, piece_length);
        Self {
            schema: SCHEMA_VERSION,
            name: name.into(),
            media_type,
            length: data.len() as u64,
            piece_length,
            pieces: encode_pieces(&hashes),
            media: None,
            created,
        }
    }

    /// The canonical form as a sorted map. `None` fields are omitted; nested `media` is a
    /// sorted map too.
    fn canonical(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("schema".into(), Value::from(self.schema));
        m.insert("name".into(), Value::from(self.name.clone()));
        if let Some(t) = &self.media_type {
            m.insert("mediaType".into(), Value::from(t.clone()));
        }
        m.insert("length".into(), Value::from(self.length));
        m.insert("pieceLength".into(), Value::from(self.piece_length));
        m.insert("pieces".into(), Value::from(self.pieces.clone()));
        if let Some(media) = &self.media {
            let mut mm = serde_json::Map::new();
            if let Some(c) = &media.codec {
                mm.insert("codec".into(), Value::from(c.clone()));
            }
            if let Some(d) = media.duration_ms {
                mm.insert("durationMs".into(), Value::from(d));
            }
            if let Some(w) = media.width {
                mm.insert("width".into(), Value::from(w));
            }
            if let Some(h) = media.height {
                mm.insert("height".into(), Value::from(h));
            }
            m.insert("media".into(), Value::Object(mm));
        }
        m.insert("created".into(), Value::from(self.created));
        Value::Object(m)
    }

    /// Canonical MessagePack bytes. This exact byte string is what the content id hashes.
    pub fn to_canonical(&self) -> Vec<u8> {
        rmp_serde::to_vec(&self.canonical()).expect("info document canonicalizes to messagepack")
    }

    /// The stable handle peers use in all have/want/request messages.
    pub fn content_id(&self) -> [u8; HASH_LEN] {
        Sha256::digest(self.to_canonical()).into()
    }

    /// The content id as a lowercase hex string (for logs and the room index).
    pub fn content_id_hex(&self) -> String {
        hex_string(&self.content_id())
    }

    /// Parses and validates canonical bytes, rejecting unknown schema versions.
    pub fn from_canonical(bytes: &[u8]) -> Result<Self, MetaError> {
        let doc: InfoDocument = rmp_serde::from_slice(bytes).map_err(|e| MetaError::Decode(e.to_string()))?;
        doc.validate()?;
        Ok(doc)
    }

    /// Structural validation independent of serialization: schema, piece length, name.
    pub fn validate(&self) -> Result<(), MetaError> {
        if self.schema != SCHEMA_VERSION {
            return Err(MetaError::UnsupportedSchema { found: self.schema });
        }
        if self.piece_length == 0 {
            return Err(MetaError::InvalidPieceLength);
        }
        if self.name.is_empty() {
            return Err(MetaError::EmptyName);
        }
        // `pieces` must decode to a whole number of hashes.
        let _ = self.decode_pieces()?;
        Ok(())
    }

    /// Number of pieces `length` bytes split at `piece_length` produces.
    pub fn piece_count(&self) -> u32 {
        piece_count(self.length, self.piece_length)
    }

    /// Decodes and returns the per-piece hashes in order.
    pub fn decode_pieces(&self) -> Result<Vec<[u8; HASH_LEN]>, MetaError> {
        decode_pieces(&self.pieces)
    }
}

/// `ceil(length / piece_length)`. Zero-length content has zero pieces.
pub fn piece_count(length: u64, piece_length: u32) -> u32 {
    if length == 0 {
        return 0;
    }
    let pl = piece_length as u64;
    ((length + pl - 1) / pl) as u32
}

/// SHA-256 of each `piece_length`-sized chunk (the last may be short).
pub fn piece_hashes(data: &[u8], piece_length: u32) -> Vec<[u8; HASH_LEN]> {
    data.chunks(piece_length as usize)
        .map(|c| {
            let d = Sha256::digest(c);
            let mut h = [0u8; HASH_LEN];
            h.copy_from_slice(&d);
            h
        })
        .collect()
}

/// Base64 of the concatenated hashes (the wire `pieces` field).
pub fn encode_pieces(hashes: &[[u8; HASH_LEN]]) -> String {
    use base64::Engine;
    let mut raw = Vec::with_capacity(hashes.len() * HASH_LEN);
    for h in hashes {
        raw.extend_from_slice(h);
    }
    base64::engine::general_purpose::STANDARD.encode(&raw)
}

/// Inverse of `encode_pieces`, rejecting lengths that are not a whole number of hashes.
pub fn decode_pieces(s: &str) -> Result<Vec<[u8; HASH_LEN]>, MetaError> {
    use base64::Engine;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| MetaError::Decode(e.to_string()))?;
    if raw.len() % HASH_LEN != 0 {
        return Err(MetaError::PiecesNotMultipleOfHash { len: raw.len() });
    }
    Ok(raw
        .chunks_exact(HASH_LEN)
        .map(|c| {
            let mut h = [0u8; HASH_LEN];
            h.copy_from_slice(c);
            h
        })
        .collect())
}

fn hex_string(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> InfoDocument {
        InfoDocument::for_bytes(
            "some-release.mp4",
            Some("video/mp4".into()),
            &[0xAB; 1_000_000],
            DEFAULT_PIECE_LENGTH,
            1_770_000_000,
        )
    }

    #[test]
    fn deterministic_id_and_canonical() {
        let a = sample();
        let b = sample();
        assert_eq!(a, b);
        assert_eq!(a.to_canonical(), b.to_canonical());
        assert_eq!(a.content_id(), b.content_id());

        // The canonical bytes must be frozen; this golden string is the contract.
        let canonical_hex = hex_string(&a.to_canonical());
        assert_eq!(
            canonical_hex,
            "87a6736368656d6101a46e616d65b0736f6d652d72656c656173652e6d7034a96d6564696154797065a9766964656f2f6d7034a66c656e677468ce000f4240ab70696563654c656e677468ce00040000a6706965636573d9ac787161474365667076316d4b66684b6f4a6a4e3730493870494176497733384d5472346d74392f49784c3747706f594a352b6d2f5759702b4571676d4d3376516a796b6743386a446677784f7669613333386a457673616d68676e6e3662395a696e34537143597a653943504b53414c794d4e2f4445362b4a726666794d532b50375450384d742b5a715567537142614f33727147702b50716e7a41585a6344677939467a57685a4473553da763726561746564ce69800e80"
        );
        // And the content id must match too.
        assert_eq!(
            a.content_id_hex(),
            "6aa353d7b0fc26115e680bb9aefe00de05fd0afa1ea6d4fdf66dd1f5c7a6ffcb"
        );
    }

    #[test]
    fn version_rejection() {
        let mut doc = sample();
        doc.schema = 2;
        assert!(matches!(
            doc.validate(),
            Err(MetaError::UnsupportedSchema { found: 2 })
        ));

        let bytes = doc.to_canonical();
        assert!(matches!(
            InfoDocument::from_canonical(&bytes),
            Err(MetaError::UnsupportedSchema { found: 2 })
        ));
    }

    #[test]
    fn roundtrip() {
        let doc = sample();
        let bytes = doc.to_canonical();
        let back = InfoDocument::from_canonical(&bytes).unwrap();
        assert_eq!(doc, back);
    }

    #[test]
    fn piece_count_boundaries() {
        assert_eq!(piece_count(0, 262_144), 0);
        assert_eq!(piece_count(1, 262_144), 1);
        assert_eq!(piece_count(262_144, 262_144), 1);
        assert_eq!(piece_count(262_145, 262_144), 2);
        assert_eq!(piece_count(1_000_000, 262_144), 4);
    }

    #[test]
    fn piece_hashes_roundtrip() {
        let data = [0xAB; 1_000_000];
        let hashes = piece_hashes(&data, DEFAULT_PIECE_LENGTH);
        assert_eq!(hashes.len(), 4);
        let encoded = encode_pieces(&hashes);
        let decoded = decode_pieces(&encoded).unwrap();
        assert_eq!(hashes, decoded);
    }
}
