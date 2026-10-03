//! Pure, single-content piece scheduler. The caller supplies monotonic time and marks a piece
//! complete only after hash verification. There is one outstanding owner per missing piece;
//! retries are permitted after failure/timeout, never for a verified piece.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use super::transport::PeerId;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleMode {
    RarestFirst,
    /// The window is [playhead, playhead + lookahead), clipped to the content length.
    SequentialAhead {
        playhead: u32,
        lookahead: u32,
    },
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub per_peer: usize,
    pub total: usize,
    pub request_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            per_peer: 4,
            total: 16,
            request_timeout: Duration::from_secs(3),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub peer: PeerId,
    pub index: u32,
}

#[derive(Default, Debug)]
pub struct Plan {
    pub cancel: Vec<Request>,
    pub want: Vec<Request>,
}

pub struct Scheduler {
    have: Vec<bool>,
    peers: BTreeMap<PeerId, BTreeSet<u32>>,
    active: BTreeMap<u32, (PeerId, Duration)>,
    // Prefer another source on retry when one exists.
    previous: BTreeMap<u32, PeerId>,
    mode: ScheduleMode,
    limits: Limits,
}

impl Scheduler {
    pub fn new(have: Vec<bool>, mode: ScheduleMode, limits: Limits) -> Self {
        Self {
            have,
            mode,
            limits,
            peers: BTreeMap::new(),
            active: BTreeMap::new(),
            previous: BTreeMap::new(),
        }
    }

    /// Replace a peer's availability snapshot. Invalid indices are ignored.
    pub fn set_peer(&mut self, peer: PeerId, pieces: impl IntoIterator<Item = u32>) {
        let count = self.have.len();
        self.peers.insert(
            peer,
            pieces
                .into_iter()
                .filter(|&i| (i as usize) < count)
                .collect(),
        );
    }

    pub fn peer_have(&mut self, peer: PeerId, index: u32) {
        if (index as usize) < self.have.len() {
            self.peers.entry(peer).or_default().insert(index);
        }
    }

    pub fn remove_peer(&mut self, peer: &PeerId) {
        self.peers.remove(peer);
        self.active.retain(|_, (p, _)| p != peer);
    }

    fn in_window(&self, index: u32) -> bool {
        match self.mode {
            ScheduleMode::RarestFirst => true,
            ScheduleMode::SequentialAhead {
                playhead,
                lookahead,
            } => index >= playhead && index < playhead.saturating_add(lookahead),
        }
    }

    /// Cancel outstanding requests outside the new window. Overlapping requests stay active.
    pub fn set_mode(&mut self, mode: ScheduleMode) -> Vec<Request> {
        self.mode = mode;
        let cancel: Vec<_> = self
            .active
            .iter()
            .filter(|(i, _)| !self.in_window(**i))
            .map(|(&index, (peer, _))| Request {
                peer: peer.clone(),
                index,
            })
            .collect();
        for r in &cancel {
            self.active.remove(&r.index);
        }
        cancel
    }

    pub fn is_requested(&self, peer: &PeerId, index: u32) -> bool {
        self.active.get(&index).is_some_and(|(p, _)| p == peer)
    }

    pub fn failed(&mut self, peer: &PeerId, index: u32) {
        if self.is_requested(peer, index) {
            self.active.remove(&index);
        }
    }

    pub fn verified(&mut self, peer: &PeerId, index: u32) -> bool {
        if !self.is_requested(peer, index) {
            return false;
        }
        self.active.remove(&index);
        self.previous.remove(&index);
        self.have[index as usize] = true;
        true
    }

    pub fn complete(&self) -> bool {
        self.have.iter().all(|h| *h)
    }

    pub fn window_ready(&self) -> bool {
        self.have
            .iter()
            .enumerate()
            .all(|(i, h)| *h || !self.in_window(i as u32))
    }

    pub fn poll(&mut self, now: Duration) -> Plan {
        let mut plan = Plan::default();
        self.active.retain(|&index, (peer, deadline)| {
            if now < *deadline {
                return true;
            }
            plan.cancel.push(Request {
                peer: peer.clone(),
                index,
            });
            false
        });
        let mut candidates: Vec<_> = self
            .have
            .iter()
            .enumerate()
            .filter(|(i, h)| {
                !**h && !self.active.contains_key(&(*i as u32)) && self.in_window(*i as u32)
            })
            .filter_map(|(i, _)| {
                let index = i as u32;
                let rarity = self
                    .peers
                    .values()
                    .filter(|pieces| pieces.contains(&index))
                    .count();
                (rarity > 0).then_some((index, rarity))
            })
            .collect();
        match self.mode {
            ScheduleMode::RarestFirst => candidates.sort_by_key(|&(i, rarity)| (rarity, i)),
            ScheduleMode::SequentialAhead { .. } => candidates.sort_by_key(|&(i, _)| i),
        }
        for (index, _) in candidates {
            if self.active.len() >= self.limits.total {
                break;
            }
            let peer = self
                .peers
                .iter()
                .filter(|(peer, pieces)| {
                    pieces.contains(&index)
                        && self.active.values().filter(|(p, _)| p == *peer).count()
                            < self.limits.per_peer
                })
                .min_by_key(|(peer, _)| {
                    (
                        self.previous.get(&index) == Some(*peer),
                        self.active.values().filter(|(p, _)| p == *peer).count(),
                        (*peer).clone(),
                    )
                })
                .map(|(peer, _)| peer.clone());
            if let Some(peer) = peer {
                self.active.insert(
                    index,
                    (
                        peer.clone(),
                        now.saturating_add(self.limits.request_timeout),
                    ),
                );
                self.previous.insert(index, peer.clone());
                plan.want.push(Request { peer, index });
            }
        }
        plan
    }
}
