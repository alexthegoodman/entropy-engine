//! Public metadata discovery. Peer hints never establish routes or prove possession of bytes.
use std::net::SocketAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};

use super::index::{MAX_INDEX_BYTES, PublicKey, RoomId, RoomIndex, SigningKey};
use super::wire::ContentId;

pub const ANNOUNCE_TTL_SECS: u64 = 90;
pub const MAX_HINTS: usize = 64;
pub const MAX_ANNOUNCE_BYTES: usize = 2048;

pub fn hex(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn parse_hex(s: &str) -> Result<[u8; 32]> {
    ensure!(s.len() == 64 && s.is_ascii(), "expected 64 hex digits");
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)?;
    }
    Ok(bytes)
}
pub fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// A signed claim by a local discovery key, independent of publication/transport identity.
/// The socket must use the HTTP source IP. Its port is an unverified transport hint.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Announcement {
    pub room: RoomId,
    pub content: ContentId,
    pub peer: String,
    pub address: SocketAddr,
    pub issued_at: u64,
    pub key: PublicKey,
    pub signature: Vec<u8>,
}
impl Announcement {
    pub fn sign(
        key: &SigningKey,
        room: RoomId,
        content: ContentId,
        peer: String,
        address: SocketAddr,
        issued_at: u64,
    ) -> Self {
        let mut claim = Self {
            room,
            content,
            peer,
            address,
            issued_at,
            key: key.public_key(),
            signature: Vec::new(),
        };
        claim.signature = key.sign_bytes(&claim.signing_bytes());
        claim
    }
    fn signing_bytes(&self) -> Vec<u8> {
        rmp_serde::to_vec(&(
            "entropy-p2p-announce-v1",
            self.room,
            self.content,
            &self.peer,
            self.address.to_string(),
            self.issued_at,
            self.key,
        ))
        .expect("claim serializes")
    }
    pub(crate) fn verify(&self, now: u64) -> Result<u64> {
        ensure!(
            !self.peer.is_empty()
                && self.peer.len() <= 128
                && self.peer.bytes().all(|b| b.is_ascii_graphic()),
            "invalid peer id"
        );
        ensure!(
            self.address.port() != 0
                && !self.address.ip().is_unspecified()
                && !self.address.ip().is_multicast(),
            "invalid socket hint"
        );
        let expiry = self
            .issued_at
            .checked_add(ANNOUNCE_TTL_SECS)
            .context("invalid time")?;
        ensure!(
            self.issued_at <= now.saturating_add(5) && expiry > now,
            "stale or future announcement"
        );
        ensure!(self.signature.len() == 64, "invalid signature length");
        UnparsedPublicKey::new(&ED25519, self.key)
            .verify(&self.signing_bytes(), &self.signature)
            .map_err(|_| anyhow::anyhow!("bad announcement signature"))?;
        Ok((expiry - now).min(ANNOUNCE_TTL_SECS))
    }
}

/// Async client with pinned room trust, no redirects and bounded response bodies.
#[derive(Clone)]
pub struct RendezvousClient {
    http: reqwest::Client,
    base: url::Url,
    room: RoomId,
    maintainer: PublicKey,
}
impl RendezvousClient {
    pub fn new(base: &str, room: RoomId, maintainer: PublicKey) -> Result<Self> {
        let base = url::Url::parse(base)?;
        ensure!(
            matches!(base.scheme(), "http" | "https")
                && base.host_str().is_some()
                && base.username().is_empty()
                && base.password().is_none()
                && base.path() == "/"
                && base.query().is_none()
                && base.fragment().is_none(),
            "tracker URL must be an HTTP(S) origin without credentials"
        );
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self {
            http,
            base,
            room,
            maintainer,
        })
    }
    fn endpoint(&self, operation: &str, content: Option<ContentId>) -> Result<url::Url> {
        let mut url = self
            .base
            .join(&format!("v1/rooms/{}/{}", hex(&self.room), operation))?;
        if let Some(content) = content {
            url.set_path(&format!("{}/{}", url.path(), hex(&content)));
        }
        Ok(url)
    }
    async fn body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
        ensure!(
            response.status().is_success(),
            "tracker returned HTTP {}",
            response.status()
        );
        ensure!(
            response.content_length().is_none_or(|n| n <= limit as u64),
            "oversized tracker response"
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                chunk.len() <= limit - bytes.len(),
                "oversized tracker response"
            );
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn get_index(&self) -> Result<RoomIndex> {
        let bytes = Self::body(
            self.http.get(self.endpoint("index", None)?).send().await?,
            MAX_INDEX_BYTES,
        )
        .await?;
        Ok(RoomIndex::from_bytes(self.room, self.maintainer, &bytes)?)
    }
    /// Sends a canonical snapshot batch; the tracker unions it with its durable index.
    pub async fn put_records(&self, batch: &RoomIndex) -> Result<()> {
        ensure!(
            batch.room() == self.room && batch.maintainer() == self.maintainer,
            "wrong room trust"
        );
        Self::body(
            self.http
                .put(self.endpoint("records", None)?)
                .header("Content-Type", "application/msgpack")
                .body(batch.to_bytes())
                .send()
                .await?,
            1024,
        )
        .await?;
        Ok(())
    }
    pub async fn put_announce(&self, claim: &Announcement) -> Result<()> {
        ensure!(claim.room == self.room, "wrong room");
        claim.verify(unix_seconds())?;
        let bytes = serde_json::to_vec(claim)?;
        ensure!(bytes.len() <= MAX_ANNOUNCE_BYTES, "oversized announcement");
        Self::body(
            self.http
                .put(self.endpoint("announce", None)?)
                .header("Content-Type", "application/json")
                .body(bytes)
                .send()
                .await?,
            1024,
        )
        .await?;
        Ok(())
    }
    pub async fn get_peers(&self, content: ContentId) -> Result<Vec<Announcement>> {
        let bytes = Self::body(
            self.http
                .get(self.endpoint("peers", Some(content))?)
                .send()
                .await?,
            2 + MAX_HINTS * (MAX_ANNOUNCE_BYTES + 1),
        )
        .await?;
        let hints: Vec<Announcement> = serde_json::from_slice(&bytes)?;
        ensure!(hints.len() <= MAX_HINTS, "too many peer hints");
        for hint in &hints {
            ensure!(
                hint.room == self.room && hint.content == content,
                "wrong hint scope"
            );
            hint.verify(unix_seconds())?;
        }
        Ok(hints)
    }
}
