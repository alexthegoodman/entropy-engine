//! A room's durable, maintainer-signed log. Trust (room id and public key) is supplied externally,
//! never learned from an incoming snapshot. Merge is an atomic, verified set union. Tombstones
//! permanently remove a content id regardless of arrival order or later publication sequences.

use std::collections::{BTreeMap, BTreeSet};

use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::meta::MediaInfo;
use super::wire::ContentId;

pub type RoomId = [u8; 32];
pub type PublicKey = [u8; 32];
pub const INDEX_SCHEMA: u32 = 1;
pub const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 4096;
const DOMAIN: &str = "entropy-p2p-room-entry";

fn sort_maps(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            map.sort_keys();
            for value in map.values_mut() {
                sort_maps(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                sort_maps(value);
            }
        }
        _ => {}
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogItem {
    pub content: ContentId,
    pub title: String,
    pub description: String,
    pub media: Option<MediaInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Action {
    Publish(CatalogItem),
    Tombstone { content: ContentId },
}

impl Action {
    pub fn content(&self) -> ContentId {
        match self {
            Self::Publish(item) => item.content,
            Self::Tombstone { content } => *content,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub schema: u32,
    pub room: RoomId,
    /// Unique monotonic sequence assigned by the single maintainer, starting at one.
    pub sequence: u64,
    pub action: Action,
}

impl Entry {
    /// Schema 1 freezes this MessagePack tuple with a named-map action. Optional media fields
    /// retain their names, so omitted hints cannot alias different fields in a positional array.
    /// Domain, schema and room are signed so entries cannot be replayed across protocols/rooms.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let mut action = serde_json::to_value(&self.action).expect("action serializes");
        sort_maps(&mut action);
        rmp_serde::to_vec(&(DOMAIN, self.schema, self.room, self.sequence, action))
            .expect("entry serializes")
    }
    pub fn id(&self) -> [u8; 32] {
        Sha256::digest(self.signing_bytes()).into()
    }

    fn validate(&self) -> Result<(), IndexError> {
        if self.schema != INDEX_SCHEMA || self.sequence == 0 {
            return Err(IndexError::InvalidEntry);
        }
        if let Action::Publish(item) = &self.action {
            if item.title.is_empty()
                || item.title.len() > 256
                || item.description.len() > 4096
                || item
                    .media
                    .as_ref()
                    .and_then(|m| m.codec.as_ref())
                    .is_some_and(|s| s.len() > 128)
            {
                return Err(IndexError::InvalidEntry);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedEntry {
    pub entry: Entry,
    pub signature: Vec<u8>,
}

/// Only the maintainer holds this key. Members need its public key alone.
pub struct Maintainer(Ed25519KeyPair);
impl Maintainer {
    pub fn generate_pkcs8() -> Result<Vec<u8>, IndexError> {
        Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .map(|d| d.as_ref().to_vec())
            .map_err(|_| IndexError::InvalidKey)
    }
    pub fn from_pkcs8(bytes: &[u8]) -> Result<Self, IndexError> {
        Ed25519KeyPair::from_pkcs8(bytes)
            .map(Self)
            .map_err(|_| IndexError::InvalidKey)
    }
    /// Deterministic key import, also useful for synthetic test fixtures. Use random PKCS#8 for
    /// new real keys, and never distribute the seed or PKCS#8 to room members.
    pub fn from_seed(seed: &[u8; 32]) -> Result<Self, IndexError> {
        Ed25519KeyPair::from_seed_unchecked(seed)
            .map(Self)
            .map_err(|_| IndexError::InvalidKey)
    }
    pub fn public_key(&self) -> PublicKey {
        self.0.public_key().as_ref().try_into().unwrap()
    }
    pub fn sign(
        &self,
        room: RoomId,
        sequence: u64,
        action: Action,
    ) -> Result<SignedEntry, IndexError> {
        let entry = Entry {
            schema: INDEX_SCHEMA,
            room,
            sequence,
            action,
        };
        entry.validate()?;
        let signature = self.0.sign(&entry.signing_bytes()).as_ref().to_vec();
        Ok(SignedEntry { entry, signature })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IndexError {
    InvalidKey,
    InvalidEntry,
    WrongRoom,
    BadSignature,
    SequenceConflict(u64),
    TooLarge,
    Decode(String),
    NonCanonical,
}
impl std::fmt::Display for IndexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "room index: {self:?}")
    }
}
impl std::error::Error for IndexError {}

#[derive(Clone)]
pub struct RoomIndex {
    room: RoomId,
    maintainer: PublicKey,
    entries: BTreeMap<u64, SignedEntry>,
    live: BTreeMap<ContentId, CatalogItem>,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    schema: u32,
    room: RoomId,
    entries: Vec<SignedEntry>,
}

impl RoomIndex {
    pub fn new(room: RoomId, maintainer: PublicKey) -> Self {
        Self {
            room,
            maintainer,
            entries: BTreeMap::new(),
            live: BTreeMap::new(),
        }
    }
    pub fn room(&self) -> RoomId {
        self.room
    }
    pub fn entries(&self) -> impl Iterator<Item = &SignedEntry> {
        self.entries.values()
    }
    pub fn items(&self) -> impl Iterator<Item = &CatalogItem> {
        self.live.values()
    }
    pub fn contains(&self, content: &ContentId) -> bool {
        self.live.contains_key(content)
    }

    /// All records, including duplicates, must validate. A bad batch changes no local state.
    /// Conflicting signed records at the same sequence are rejected, never resolved by arrival.
    pub fn merge(
        &mut self,
        entries: impl IntoIterator<Item = SignedEntry>,
    ) -> Result<usize, IndexError> {
        let mut merged = self.entries.clone();
        let before = merged.len();
        for record in entries {
            record.entry.validate()?;
            if record.entry.room != self.room {
                return Err(IndexError::WrongRoom);
            }
            if record.signature.len() != 64
                || UnparsedPublicKey::new(&ED25519, self.maintainer)
                    .verify(&record.entry.signing_bytes(), &record.signature)
                    .is_err()
            {
                return Err(IndexError::BadSignature);
            }
            let sequence = record.entry.sequence;
            if let Some(existing) = merged.get(&sequence) {
                if existing != &record {
                    return Err(IndexError::SequenceConflict(sequence));
                }
            } else {
                merged.insert(sequence, record);
                if merged.len() > MAX_ENTRIES {
                    return Err(IndexError::TooLarge);
                }
            }
        }
        let snapshot = Snapshot {
            schema: INDEX_SCHEMA,
            room: self.room,
            entries: merged.values().cloned().collect(),
        };
        if rmp_serde::to_vec_named(&snapshot)
            .expect("snapshot serializes")
            .len()
            > MAX_INDEX_BYTES
        {
            return Err(IndexError::TooLarge);
        }
        let tombstones: BTreeSet<_> = merged
            .values()
            .filter_map(|r| {
                if let Action::Tombstone { content } = r.entry.action {
                    Some(content)
                } else {
                    None
                }
            })
            .collect();
        let mut live = BTreeMap::new();
        for r in merged.values() {
            if let Action::Publish(item) = &r.entry.action {
                if !tombstones.contains(&item.content) {
                    live.insert(item.content, item.clone());
                }
            }
        }
        let added = merged.len() - before;
        self.entries = merged;
        self.live = live;
        Ok(added)
    }

    /// Canonical snapshot: named schema/room/entries, entries sorted by sequence. No peer
    /// addresses or private keys are serialized. The snapshot id changes with any log change.
    pub fn to_bytes(&self) -> Vec<u8> {
        rmp_serde::to_vec_named(&Snapshot {
            schema: INDEX_SCHEMA,
            room: self.room,
            entries: self.entries.values().cloned().collect(),
        })
        .expect("snapshot serializes")
    }
    pub fn content_id(&self) -> ContentId {
        Sha256::digest(self.to_bytes()).into()
    }
    pub fn from_bytes(
        room: RoomId,
        maintainer: PublicKey,
        bytes: &[u8],
    ) -> Result<Self, IndexError> {
        if bytes.len() > MAX_INDEX_BYTES {
            return Err(IndexError::TooLarge);
        }
        let snapshot: Snapshot =
            rmp_serde::from_slice(bytes).map_err(|e| IndexError::Decode(e.to_string()))?;
        if snapshot.schema != INDEX_SCHEMA {
            return Err(IndexError::InvalidEntry);
        }
        if snapshot.room != room {
            return Err(IndexError::WrongRoom);
        }
        if snapshot.entries.len() > MAX_ENTRIES {
            return Err(IndexError::TooLarge);
        }
        let mut index = Self::new(room, maintainer);
        index.merge(snapshot.entries)?;
        if index.to_bytes() != bytes {
            return Err(IndexError::NonCanonical);
        }
        Ok(index)
    }
    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, IndexError> {
        let remote = Self::from_bytes(self.room, self.maintainer, bytes)?;
        self.merge(remote.entries.into_values())
    }
}
