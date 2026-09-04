//! Font registry — two text faces (proportional/monospace) plus two icon-fallback faces,
//! matching `FontId::family`.
//!
//! The proportional face reuses an already-embedded engine font (Figtree). No embedded
//! monospace font exists anywhere in the engine's 60-font set (`src/renderer_text/fonts.rs`),
//! so this loads a system font at runtime instead of shipping a new binary asset — the whole
//! editor UI is already Windows-only (`#[cfg(target_os = "windows")]` on `src/startup.rs`),
//! so this is not a new platform limitation. Prefers Cascadia Mono (Microsoft's modern
//! terminal/code font), falling back to Consolas, then Courier New, then (if the machine has
//! none of those) the proportional face itself so the app never fails to start over a font.
//!
//! Neither text face has emoji/symbol glyph coverage, so every 👓🎮➕-style icon used across
//! the UI used to rasterize as Figtree's `.notdef` box ("tofu"). Two more system faces are
//! loaded as icon fallbacks — Segoe UI Emoji (covers the astral-plane pictographs: 🎮🎬💬🎵
//! etc.) and Segoe UI Symbol (covers BMP symbols Segoe UI Emoji is missing, e.g. ⏵) — probed
//! empirically with `src/bin/font_probe.rs` (not part of the app) to confirm `fontdue`'s plain
//! outline rasterizer produces usable monochrome glyphs from Segoe UI Emoji despite it being a
//! COLR/CPAL color font (fontdue only reads the base `glyf` outline, which Windows keeps as a
//! meaningful monochrome fallback shape, not an empty placeholder). `text_layout::shape_text`
//! is what actually falls back per-character; this registry just hands it the four faces.
//! Both are ~1-12MB system files read at runtime, not embedded.

use crate::entropy_gui::geometry::FontFamily;

pub struct FontRegistry {
    proportional: fontdue::Font,
    monospace: fontdue::Font,
    emoji: Option<fontdue::Font>,
    symbol: Option<fontdue::Font>,
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

        let emoji = Self::load_system_font(&["C:/Windows/Fonts/seguiemj.ttf"]);
        let symbol = Self::load_system_font(&["C:/Windows/Fonts/seguisym.ttf"]);

        Self { proportional, monospace, emoji, symbol }
    }

    #[cfg(target_os = "windows")]
    fn load_system_monospace() -> Option<fontdue::Font> {
        Self::load_system_font(&[
            "C:/Windows/Fonts/CascadiaMono.ttf",
            "C:/Windows/Fonts/consola.ttf",
            "C:/Windows/Fonts/cour.ttf",
        ])
    }

    #[cfg(not(target_os = "windows"))]
    fn load_system_monospace() -> Option<fontdue::Font> {
        None
    }

    fn load_system_font(candidates: &[&str]) -> Option<fontdue::Font> {
        for path in candidates {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(font) = fontdue::Font::from_bytes(bytes.as_slice(), fontdue::FontSettings::default()) {
                    return Some(font);
                }
            }
        }
        None
    }

    pub fn font_for(&self, family: FontFamily) -> &fontdue::Font {
        match family {
            FontFamily::Proportional => &self.proportional,
            FontFamily::Monospace => &self.monospace,
        }
    }

    /// The face to try, in order, for a single character: the requested text face first, then
    /// the emoji face, then the symbol face. Faces that failed to load are simply skipped
    /// (`font_for` covers slot 0 unconditionally since text faces always load or panic).
    pub fn icon_fallbacks(&self) -> [Option<&fontdue::Font>; 2] {
        [self.emoji.as_ref(), self.symbol.as_ref()]
    }

    /// Resolves the actual face `ch` should render with for the requested `family`: the
    /// family's own face if it has a real glyph for `ch`, else the first icon fallback that
    /// does, else the family's own face again (an unavoidable `.notdef` box).
    pub fn resolve_for_char(&self, family: FontFamily, ch: char) -> (&fontdue::Font, u8) {
        let primary = self.font_for(family);
        if primary.lookup_glyph_index(ch) != 0 {
            return (primary, 0);
        }
        for (i, fallback) in self.icon_fallbacks().into_iter().enumerate() {
            if let Some(font) = fallback {
                if font.lookup_glyph_index(ch) != 0 {
                    return (font, i as u8 + 1);
                }
            }
        }
        (primary, 0)
    }

    /// The 3-face set `text_layout::shape_text` shapes against: index 0 is whichever text face
    /// `family` requested, 1 is the emoji fallback, 2 is the symbol fallback. A missing
    /// fallback face is represented by re-using slot 0 (harmless: `resolve_for_char` only ever
    /// returns that slot index when the face actually loaded and has the glyph).
    pub fn shaping_set(&self, family: FontFamily) -> [&fontdue::Font; 3] {
        let primary = self.font_for(family);
        [primary, self.emoji.as_ref().unwrap_or(primary), self.symbol.as_ref().unwrap_or(primary)]
    }
}

impl Default for FontRegistry {
    fn default() -> Self {
        Self::new()
    }
}
