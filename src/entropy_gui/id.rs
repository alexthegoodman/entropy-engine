//! Widget identity.
//!
//! Deliberately a hashed `u64`, not a `uuid::Uuid` (the engine's dominant identity
//! convention elsewhere). Widget ids must be a deterministic function of a label/path
//! so the *same logical widget* gets the *same id* across frames (so `Memory` lookups
//! like scroll offset / open-state / drag-state persist correctly) — a randomly
//! generated id would silently break all persistent widget state every frame.
//! Ids live only in RAM for the process lifetime; never serialize one to disk.

use std::hash::{Hash, Hasher};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Id(u64);

impl Id {
    pub fn new(source: impl Hash) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        0xE7_u64.hash(&mut hasher); // fixed seed so Id::new("") != a bare zero hash
        source.hash(&mut hasher);
        Id(hasher.finish())
    }

    pub fn with(&self, child: impl Hash) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.0.hash(&mut hasher);
        child.hash(&mut hasher);
        Id(hasher.finish())
    }

    pub fn value(&self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for Id {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Id({:x})", self.0)
    }
}

/// A `HashMap<Id, T>` alias used throughout for widget/window/dock persistent state.
pub type IdMap<T> = std::collections::HashMap<Id, T>;
