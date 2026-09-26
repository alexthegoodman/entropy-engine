//! `crate::audio` as the engine's models expect to find it: the brass, the bowed strings and the
//! drum kit, straight from the engine's `src/audio`, unmodified.

pub mod analysis {
    pub const ENGINE_SAMPLE_RATE: u32 = 44_100;
}

#[path = "../../../../../src/audio/physmod/mod.rs"]
pub mod physmod;
#[path = "../../../../../src/audio/brass/mod.rs"]
pub mod brass;
#[path = "../../../../../src/audio/matter/mod.rs"]
pub mod matter;
