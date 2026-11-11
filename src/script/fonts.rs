//! The fonts a script can name in `UI.drawText` (`fontFamily`). A browser build carries every
//! byte it may draw with, so this is a short list rather than Studio's full font library; an
//! unknown name falls back to Play.

use std::sync::OnceLock;

pub const FONT_NAMES: &[&str] = &["Play", "Bungee", "Vina Sans", "Exo"];

fn bytes(name: &str) -> &'static [u8] {
    match name {
        "Bungee" => include_bytes!("../fonts/bungee/Bungee-Regular.ttf"),
        "Vina Sans" => include_bytes!("../fonts/vinasans/VinaSans-Regular.ttf"),
        "Exo" => include_bytes!("../fonts/exo/Exo[wght].ttf"),
        _ => include_bytes!("../fonts/play/Play-Regular.ttf"),
    }
}

pub struct Fonts {
    pub fonts: Vec<fontdue::Font>,
}

impl Fonts {
    fn load() -> Self {
        let fonts = FONT_NAMES
            .iter()
            .map(|n| fontdue::Font::from_bytes(bytes(n), fontdue::FontSettings::default()).expect("embedded font parses"))
            .collect();
        Self { fonts }
    }

    pub fn get() -> &'static Fonts {
        static FONTS: OnceLock<Fonts> = OnceLock::new();
        FONTS.get_or_init(Fonts::load)
    }

    /// Index into `fonts` for a family name (case-insensitive), Play when unknown.
    pub fn index(name: &str) -> usize {
        FONT_NAMES.iter().position(|n| n.eq_ignore_ascii_case(name)).unwrap_or(0)
    }
}
