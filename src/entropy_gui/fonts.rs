//! Font registry - two text faces (proportional/monospace), two system icon-fallback faces and
//! three embedded Phosphor icon faces, matching `FontId::family`.
//!
//! The proportional face reuses an already-embedded engine font (Figtree). No embedded
//! monospace font exists anywhere in the engine's 60-font set (`src/renderer_text/fonts.rs`),
//! so this loads a system font at runtime instead of shipping a new binary asset. On Windows it
//! prefers Cascadia Mono (Microsoft's modern terminal/code font), falling back to Consolas, then
//! Courier New; on Linux DejaVu/Noto/Liberation Mono; then (if the machine has none of those)
//! the proportional face itself so the app never fails to start over a font.
//!
//! Neither text face has emoji/symbol glyph coverage, so every 👓🎮➕-style icon used across
//! the UI used to rasterize as Figtree's `.notdef` box ("tofu"). Two more system faces are
//! loaded as icon fallbacks — Segoe UI Emoji (covers the astral-plane pictographs: 🎮🎬💬🎵
//! etc.) and Segoe UI Symbol (covers BMP symbols Segoe UI Emoji is missing, e.g. ⏵) — probed
//! empirically with `src/bin/font_probe.rs` (not part of the app) to confirm `fontdue`'s plain
//! outline rasterizer produces usable monochrome glyphs from Segoe UI Emoji despite it being a
//! COLR/CPAL color font (fontdue only reads the base `glyf` outline, which Windows keeps as a
//! meaningful monochrome fallback shape, not an empty placeholder). `text_layout::shape_text`
//! is what actually falls back per-character; this registry just hands it the faces.
//! Both are ~1-12MB system files read at runtime, not embedded.

use crate::entropy_gui::geometry::FontFamily;
use crate::entropy_gui::icons::{self, IconStyle};
use crate::entropy_gui::text_layout::FaceSet;
use crate::renderer_text::fonts::FontManager;
use std::collections::HashMap;

// Icon-fallback faces per platform. Linux has no single stock equivalent of Segoe UI Emoji whose
// outlines fontdue can rasterize (Noto Color Emoji is bitmap-only), so it tries the monochrome
// emoji/symbol fonts distros commonly ship, then DejaVu Sans, whose BMP symbol coverage handles
// the arrows/checks/crosses the widgets draw.
#[cfg(target_os = "windows")]
const EMOJI_FONT_CANDIDATES: &[&str] = &["C:/Windows/Fonts/seguiemj.ttf"];
#[cfg(target_os = "windows")]
const SYMBOL_FONT_CANDIDATES: &[&str] = &["C:/Windows/Fonts/seguisym.ttf"];
#[cfg(not(target_os = "windows"))]
const EMOJI_FONT_CANDIDATES: &[&str] = &[
    "/usr/share/fonts/truetype/noto/NotoEmoji-Regular.ttf",
    "/usr/share/fonts/truetype/ancient-scripts/Symbola_hint.ttf",
    "/usr/share/fonts/TTF/Symbola.ttf",
];
#[cfg(not(target_os = "windows"))]
const SYMBOL_FONT_CANDIDATES: &[&str] = &[
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

pub struct FontRegistry {
    proportional: fontdue::Font,
    monospace: fontdue::Font,
    emoji: Option<fontdue::Font>,
    symbol: Option<fontdue::Font>,
    /// Phosphor Regular, Bold and Fill, indexed by `IconStyle::index`. Embedded, so they always
    /// load (unlike the two system faces). Icons are private-use characters, see `icons.rs`.
    phosphor: [fontdue::Font; 3],
    /// The engine's full ~60-font catalog (`src/renderer_text/fonts.rs`, already embedded via
    /// `include_bytes!` for the old 3D-scene text renderer) - reused here so `DocEditor`'s font
    /// picker has real choices instead of just proportional/monospace. Only raw bytes are
    /// duplicated at startup (a `FontManager` owns its own `Vec<u8>` per font); the expensive
    /// part, fontdue parsing, only happens lazily in `named_font_cache` for fonts a document
    /// actually uses.
    catalog: FontManager,
    named_font_cache: HashMap<String, fontdue::Font>,
}

const PROPORTIONAL_BYTES: &[u8] = include_bytes!("../fonts/figtree/Figtree[wght].ttf");
const PHOSPHOR_BYTES: [&[u8]; 3] = [
    include_bytes!("../fonts/phosphor/Phosphor.ttf"),
    include_bytes!("../fonts/phosphor/Phosphor-Bold.ttf"),
    include_bytes!("../fonts/phosphor/Phosphor-Fill.ttf"),
];

impl FontRegistry {
    pub fn new() -> Self {
        let proportional = fontdue::Font::from_bytes(PROPORTIONAL_BYTES, fontdue::FontSettings::default())
            .expect("failed to parse embedded UI font (Figtree)");

        let monospace = Self::load_system_monospace().unwrap_or_else(|| {
            fontdue::Font::from_bytes(PROPORTIONAL_BYTES, fontdue::FontSettings::default())
                .expect("failed to parse embedded UI font (Figtree) as monospace fallback")
        });

        let emoji = Self::load_system_font(EMOJI_FONT_CANDIDATES);
        let symbol = Self::load_system_font(SYMBOL_FONT_CANDIDATES);

        let phosphor = PHOSPHOR_BYTES.map(|bytes| {
            fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()).expect("failed to parse embedded Phosphor icon font")
        });

        Self { proportional, monospace, emoji, symbol, phosphor, catalog: FontManager::new(), named_font_cache: HashMap::new() }
    }

    /// Every font name `DocEditor`'s font picker can offer, in catalog order.
    pub fn catalog_font_names(&self) -> Vec<String> {
        self.catalog.get_available_font_names()
    }

    /// Parses and caches the named catalog font on first use; a no-op after that. Silently
    /// does nothing for an unknown name or a file fontdue can't parse - callers fall back to
    /// the proportional face via `get_named`/`resolve_named_or_fallback` returning `None`.
    pub fn ensure_named(&mut self, name: &str) {
        if self.named_font_cache.contains_key(name) {
            return;
        }
        if let Some(bytes) = self.catalog.get_font_by_name(name) {
            if let Ok(font) = fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()) {
                self.named_font_cache.insert(name.to_string(), font);
            }
        }
    }

    pub fn get_named(&self, name: &str) -> Option<&fontdue::Font> {
        self.named_font_cache.get(name)
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
        Self::load_system_font(&[
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/noto/NotoSansMono-Regular.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
            "/System/Library/Fonts/Menlo.ttc",
        ])
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

    /// The Phosphor face for one icon weight.
    pub fn phosphor(&self, style: IconStyle) -> &fontdue::Font {
        &self.phosphor[style.index()]
    }

    /// Resolves the actual face `ch` should render with for the requested `family`: a Phosphor
    /// icon character gets its weight's face, else the family's own face if it has a real glyph
    /// for `ch`, else the first icon fallback that does, else the family's own face again (an
    /// unavoidable `.notdef` box).
    pub fn resolve_for_char(&self, family: FontFamily, ch: char) -> (&fontdue::Font, u8) {
        if let Some((style, font_char)) = icons::decode(ch) {
            let font = self.phosphor(style);
            if font.lookup_glyph_index(font_char) != 0 {
                return (font, 3 + style.index() as u8);
            }
        }
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

    /// The face set `text_layout::shape_text` shapes against: index 0 is whichever text face
    /// `family` requested, 1 is the emoji fallback, 2 is the symbol fallback, 3 to 5 are
    /// Phosphor Regular, Bold and Fill. A missing system fallback is represented by re-using slot
    /// 0 (harmless: `resolve_for_char` only ever returns that slot index when the face actually
    /// loaded and has the glyph).
    pub fn shaping_set(&self, family: FontFamily) -> FaceSet<'_> {
        let primary = self.font_for(family);
        [
            primary,
            self.emoji.as_ref().unwrap_or(primary),
            self.symbol.as_ref().unwrap_or(primary),
            &self.phosphor[0],
            &self.phosphor[1],
            &self.phosphor[2],
        ]
    }
}

impl Default for FontRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entropy_gui::text_layout::{shape_text, FIRST_ICON_FACE};

    #[test]
    fn every_table_icon_exists_in_every_weight() {
        let fonts = FontRegistry::new();
        for style in IconStyle::ALL {
            let face = fonts.phosphor(style);
            for name in icons::names() {
                let cp = char::from_u32(icons::codepoint(name).unwrap()).unwrap();
                assert_ne!(face.lookup_glyph_index(cp), 0, "{name} is missing from {style:?}");
            }
        }
    }

    #[test]
    fn an_icon_goes_to_its_weights_face_and_text_stays_on_the_text_face() {
        let fonts = FontRegistry::new();
        for style in IconStyle::ALL {
            let ch = icons::glyph("play", style).unwrap();
            let (_, idx) = fonts.resolve_for_char(FontFamily::Proportional, ch);
            assert_eq!(idx as usize, FIRST_ICON_FACE + style.index());
        }
        assert_eq!(fonts.resolve_for_char(FontFamily::Proportional, 'a').1, 0);
        // The registry and the shaper agree: shape a label and read back each glyph's face.
        let play = icons::glyph("play", IconStyle::Fill).unwrap();
        let shaped = shape_text(fonts.shaping_set(FontFamily::Proportional), 14.0, None, &format!("{play} Play"));
        let faces: Vec<u8> = shaped.glyphs.iter().map(|g| g.font_index).collect();
        assert_eq!(faces, vec![(FIRST_ICON_FACE + 2) as u8, 0, 0, 0, 0, 0]);
    }

}
