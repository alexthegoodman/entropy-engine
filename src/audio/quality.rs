//! How much of a modelled instrument runs: the quality tiers of `docs/PHYS_MOD_FIDELITY.md`
//! (Part A1).
//!
//! Each tier is a set of concrete model parameters (modes, wire groups, how far a cymbal's
//! nonlinear coupling reaches...), chosen per instrument where the instrument is built - never a
//! vague "quality" slider inside the physics. The tests pin `Render`; `Draft` must stay within a
//! stated distance of it (see the tier tests next to each instrument). `Live` is what a track
//! plays in real time by default, and today it is `Render` wherever `Render` fits in real time:
//! the tiers separate once the fidelity work raises `Render` beyond what plays live.
//!
//! An export (a bounce, a frozen track) always renders at `Render`, whatever the track plays live.

/// A quality tier.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Quality {
    /// The cheapest version that still sounds like the instrument: for slow machines, or many
    /// instruments at once. Within a stated distance of `Render`.
    Draft,
    /// What plays in real time by default.
    #[default]
    Live,
    /// The best version there is. Exports always use it.
    Render,
}

impl Quality {
    pub const ALL: [Quality; 3] = [Quality::Draft, Quality::Live, Quality::Render];

    pub fn name(self) -> &'static str {
        match self {
            Quality::Draft => "draft",
            Quality::Live => "live",
            Quality::Render => "render",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|q| q.name() == name.trim().to_ascii_lowercase())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip() {
        for q in Quality::ALL {
            assert_eq!(Quality::from_name(q.name()), Some(q));
        }
        assert_eq!(Quality::from_name(" Draft "), Some(Quality::Draft));
        assert_eq!(Quality::from_name("best"), None);
        assert_eq!(Quality::default(), Quality::Live);
    }
}
