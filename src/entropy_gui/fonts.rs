//! Font registry — two faces (proportional/monospace), matching `FontId::family`.
//!
//! The proportional face reuses an already-embedded engine font (Figtree). No embedded
//! monospace font exists anywhere in the engine's 60-font set (`src/renderer_text/fonts.rs`),
//! so this loads a system font at runtime instead of shipping a new binary asset — the whole
//! editor UI is already Windows-only (`#[cfg(target_os = "windows")]` on `src/startup.rs`),
//! so this is not a new platform limitation. Prefers Cascadia Mono (Microsoft's modern
//! terminal/code font), falling back to Consolas, then Courier New, then (if the machine has
//! none of those) the proportional face itself so the app never fails to start over a font.

use crate::entropy_gui::geometry::FontFamily;

pub struct FontRegistry {
    proportional: fontdue::Font,
    monospace: fontdue::Font,
}

const PROPORTIONAL_BYTES: &[u8] = include_bytes!("../fonts/figtree/Figtree[wght].ttf");

impl FontRegistry {
    pub fn new() -> Self {
        let proportional = fontdue::Font::from_bytes(PROPORTIONAL_BYTES, fontdue::FontSettings::default())
            .expect("failed to parse embedded UI font (Figtree)");

        let monospace = Self::load_system_monospace().unwrap_or_else(|| {
            fontdue::Font::from_bytes(PROPORTIONAL_BYTES, fontdue::FontSettings::default())
                .expect("failed to parse embedded UI font (Figtree) as monospace fallback")
        });

        Self { proportional, monospace }
    }

    #[cfg(target_os = "windows")]
    fn load_system_monospace() -> Option<fontdue::Font> {
        const CANDIDATES: &[&str] = &[
            "C:/Windows/Fonts/CascadiaMono.ttf",
            "C:/Windows/Fonts/consola.ttf",
            "C:/Windows/Fonts/cour.ttf",
        ];
        for path in CANDIDATES {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(font) = fontdue::Font::from_bytes(bytes.as_slice(), fontdue::FontSettings::default()) {
                    return Some(font);
                }
            }
        }
        None
    }

    #[cfg(not(target_os = "windows"))]
    fn load_system_monospace() -> Option<fontdue::Font> {
        None
    }

    pub fn font_for(&self, family: FontFamily) -> &fontdue::Font {
        match family {
            FontFamily::Proportional => &self.proportional,
            FontFamily::Monospace => &self.monospace,
        }
    }
}

impl Default for FontRegistry {
    fn default() -> Self {
        Self::new()
    }
}
