//! Synthetic signing fixture only. Peer processes receive the public key and signed index.
#![allow(dead_code)] // Each integration harness uses a different subset of these fixtures.
use entropy_engine::p2p::allow::Allowlist;
use entropy_engine::p2p::index::{
    Action, CatalogItem, Maintainer, Member, PublicationKind, RoomIndex,
};
use entropy_engine::p2p::meta::InfoDocument;

pub const ROOM: [u8; 32] = [9; 32];
pub fn maintainer() -> Maintainer {
    Maintainer::from_seed(&[7; 32]).unwrap()
}
pub fn publish(info: &InfoDocument, sequence: u64) -> entropy_engine::p2p::index::SignedEntry {
    Member::from_seed(&[6; 32])
        .unwrap()
        .sign(
            ROOM,
            sequence,
            Action::Publish(CatalogItem {
                content: info.content_id(),
                title: info.name.clone(),
                description: "Synthetic fixture".into(),
                media: info.media.clone(),
                kind: PublicationKind::File,
                parent: None,
            }),
        )
        .unwrap()
}
pub fn index(info: &InfoDocument) -> RoomIndex {
    let mut index = RoomIndex::new(ROOM, maintainer().public_key());
    index.merge([publish(info, 1)]).unwrap();
    index
}
pub fn allow(info: &InfoDocument) -> Allowlist {
    Allowlist::new(index(info))
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
