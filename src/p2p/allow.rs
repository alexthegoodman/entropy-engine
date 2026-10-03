//! Catalog policy and a transport decorator enforcing it after decoding/decryption. The raw
//! KCP interceptor sees peer metadata only; this layer sees content ids on both message planes.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use bytes::Bytes;

use super::index::{IndexError, RoomIndex};
use super::meta::InfoDocument;
use super::transport::{P2pTransport, PeerId, ReliableChannel, RouteMode, TransportEvent};
use super::wire::{ContentId, Envelope, Msg, PROTOCOL_VERSION};

#[derive(Clone)]
pub struct Allowlist {
    index: Arc<RwLock<RoomIndex>>,
    changed: tokio::sync::watch::Sender<u64>,
}

impl Allowlist {
    pub fn new(index: RoomIndex) -> Self {
        let (changed, _) = tokio::sync::watch::channel(0);
        Self {
            index: Arc::new(RwLock::new(index)),
            changed,
        }
    }
    pub fn contains(&self, content: &ContentId) -> bool {
        self.with_allowed(content, || ()).is_some()
    }
    /// Hold the policy read lock for an entire synchronous store operation. A tombstone merge
    /// cannot race a checked write/promotion. Poisoned locks fail closed.
    pub fn with_allowed<T>(&self, content: &ContentId, f: impl FnOnce() -> T) -> Option<T> {
        let index = self.index.read().ok()?;
        index.contains(content).then(f)
    }
    pub fn merge_bytes(&self, bytes: &[u8]) -> Result<usize, IndexError> {
        let added = self
            .index
            .write()
            .map_err(|_| IndexError::InvalidEntry)?
            .merge_bytes(bytes)?;
        if added > 0 {
            self.changed.send_modify(|n| *n = n.wrapping_add(1));
        }
        Ok(added)
    }
    pub fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changed.subscribe()
    }
    pub fn permits(&self, msg: &Msg) -> bool {
        match msg {
            Msg::Hello { version } => *version == PROTOCOL_VERSION,
            Msg::GetInfo { content }
            | Msg::Have { content, .. }
            | Msg::Bitfield { content, .. }
            | Msg::Want { content, .. }
            | Msg::Cancel { content, .. }
            | Msg::Done { content }
            | Msg::Piece { content, .. } => self.contains(content),
            Msg::Info { document } => InfoDocument::from_canonical(document).is_ok_and(|info| {
                info.to_canonical() == *document && self.contains(&info.content_id())
            }),
        }
    }
    fn permits_bytes(&self, bytes: &[u8]) -> bool {
        Envelope::decode(bytes).is_ok_and(|e| self.permits(&e.msg))
    }
}

fn denied() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "content is not in the room catalog",
    )
}

pub struct CatalogTransport {
    inner: Box<dyn P2pTransport>,
    allow: Allowlist,
}
impl CatalogTransport {
    pub fn new(inner: Box<dyn P2pTransport>, allow: Allowlist) -> Self {
        Self { inner, allow }
    }
}

struct CatalogChannel {
    inner: Box<dyn ReliableChannel>,
    allow: Allowlist,
}
impl ReliableChannel for CatalogChannel {
    fn send(&mut self, bytes: Bytes) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        Box::pin(async move {
            if !self.allow.permits_bytes(&bytes) {
                return Err(denied());
            }
            self.inner.send(bytes).await
        })
    }
    fn recv(&mut self) -> Pin<Box<dyn Future<Output = Option<io::Result<Bytes>>> + Send + '_>> {
        Box::pin(async move {
            match self.inner.recv().await {
                Some(Ok(bytes)) if self.allow.permits_bytes(&bytes) => Some(Ok(bytes)),
                Some(Ok(_)) => Some(Err(denied())),
                result => result,
            }
        })
    }
}

impl P2pTransport for CatalogTransport {
    fn local_id(&self) -> PeerId {
        self.inner.local_id()
    }
    fn route_mode(&self, peer: &PeerId) -> Option<RouteMode> {
        self.inner.route_mode(peer)
    }
    fn send_datagram(
        &self,
        peer: &PeerId,
        bytes: Bytes,
    ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let peer = peer.clone();
        Box::pin(async move {
            if !self.allow.permits_bytes(&bytes) {
                return Err(denied());
            }
            self.inner.send_datagram(&peer, bytes).await
        })
    }
    fn open_channel(
        &self,
        peer: &PeerId,
    ) -> Pin<Box<dyn Future<Output = io::Result<Box<dyn ReliableChannel>>> + Send + '_>> {
        let future = self.inner.open_channel(peer);
        Box::pin(async move {
            let inner = future.await?;
            Ok(Box::new(CatalogChannel {
                inner,
                allow: self.allow.clone(),
            }) as Box<dyn ReliableChannel>)
        })
    }
    fn next_event(&self) -> Pin<Box<dyn Future<Output = Option<TransportEvent>> + Send + '_>> {
        Box::pin(async move {
            loop {
                match self.inner.next_event().await? {
                    TransportEvent::Datagram(dg) => {
                        if self.allow.permits_bytes(&dg.payload) {
                            return Some(TransportEvent::Datagram(dg));
                        }
                    }
                    TransportEvent::IncomingChannel { peer, channel } => {
                        return Some(TransportEvent::IncomingChannel {
                            peer,
                            channel: Box::new(CatalogChannel {
                                inner: channel,
                                allow: self.allow.clone(),
                            }),
                        });
                    }
                    event => return Some(event),
                }
            }
        })
    }
}
