// Everything a user can customize about a music video, as one serde struct shared by the live
// preview widget (`Widget.musicVisualizer`) and the export (`Entropy.Video.exportMusicVideo`), so
// the preview is always drawn from exactly what the export will use.
use serde::{Deserialize, Serialize};

/// The collection of looks. Each is drawn by `scenes::Visualizer` from the same `AudioFeatures`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum VisualStyle {
    /// A row of rounded spectrum bars with falling peak caps and a floor reflection.
    #[default]
    Bars,
    /// The spectrum wrapped around a circle that breathes with the bass.
    Radial,
    /// An oscilloscope line with fading echoes of the last few frames.
    Wave,
    /// A starfield flying at the viewer, faster with the level, bursting on the beat.
    Particles,
    /// Rings expanding from the centre, one per detected beat, round a spinning polygon.
    Rings,
    /// Layered spectrum hills under a pulsing sun, mirrored in a floor.
    Horizon,
}

impl VisualStyle {
    pub const ALL: [VisualStyle; 6] = [
        VisualStyle::Bars,
        VisualStyle::Radial,
        VisualStyle::Wave,
        VisualStyle::Particles,
        VisualStyle::Rings,
        VisualStyle::Horizon,
    ];

    /// The serde name ("bars", "radial", ...).
    pub fn id(self) -> &'static str {
        match self {
            VisualStyle::Bars => "bars",
            VisualStyle::Radial => "radial",
            VisualStyle::Wave => "wave",
            VisualStyle::Particles => "particles",
            VisualStyle::Rings => "rings",
            VisualStyle::Horizon => "horizon",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            VisualStyle::Bars => "Spectrum Bars",
            VisualStyle::Radial => "Radial Pulse",
            VisualStyle::Wave => "Waveform",
            VisualStyle::Particles => "Starfield",
            VisualStyle::Rings => "Beat Rings",
            VisualStyle::Horizon => "Horizon",
        }
    }
}

pub const MIN_DIMENSION: u32 = 64;
pub const MAX_WIDTH: u32 = 3840;
pub const MAX_HEIGHT: u32 = 3840;
pub const FPS_CHOICES: [u32; 3] = [24, 30, 60];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VisualizerSettings {
    pub style: VisualStyle,
    /// Output size in pixels. Kept even (H.264 4:2:0 needs it) by `sanitized`.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// [r, g, b, a] in 0..1, like every other colour the addon API takes.
    pub primary: [f32; 4],
    pub secondary: [f32; 4],
    /// Background gradient, top to bottom.
    pub background: [f32; 4],
    pub background_bottom: [f32; 4],
    /// How hard the visuals react: a gain on everything the audio drives. 1 is neutral.
    pub sensitivity: f32,
    /// 0 is twitchy, 1 is syrupy: how slowly levels fall back after a hit.
    pub smoothing: f32,
    /// Bars (and radial spokes) across the spectrum.
    pub bar_count: u32,
    /// Bars and radial: symmetric about the centre. Wave: a second, inverted trace.
    pub mirror: bool,
    /// Bloom around everything the audio draws, 0 (off) ..1.
    pub glow: f32,
    /// Drawn bottom-left over the visuals; empty strings draw nothing.
    pub title: String,
    pub artist: String,
    /// A name from the engine's font catalog (see `docEditorFontNames`); unknown names use Figtree.
    pub font: String,
    /// A thin song-position bar along the bottom edge.
    pub show_progress: bool,
    /// Optional picture behind everything, scaled to cover the frame.
    pub background_image: Option<String>,
    /// How much the background image is darkened so the visuals stay readable, 0..1.
    pub background_dim: f32,
    /// Seeds the starfield, so a re-export draws the same stars.
    pub seed: u32,
}

impl Default for VisualizerSettings {
    fn default() -> Self {
        Self {
            style: VisualStyle::Bars,
            width: 1280,
            height: 720,
            fps: 30,
            primary: [0.36, 0.95, 0.77, 1.0],
            secondary: [1.0, 0.46, 0.38, 1.0],
            background: [0.04, 0.05, 0.09, 1.0],
            background_bottom: [0.09, 0.05, 0.14, 1.0],
            sensitivity: 1.0,
            smoothing: 0.5,
            bar_count: 48,
            mirror: false,
            glow: 0.6,
            title: String::new(),
            artist: String::new(),
            font: "Figtree".to_string(),
            show_progress: true,
            background_image: None,
            background_dim: 0.45,
            seed: 7,
        }
    }
}

fn clamp_color(c: [f32; 4]) -> [f32; 4] {
    c.map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 })
}

fn clamp_finite(v: f32, lo: f32, hi: f32, fallback: f32) -> f32 {
    if v.is_finite() { v.clamp(lo, hi) } else { fallback }
}

impl VisualizerSettings {
    /// A copy that is safe to render and encode: sizes even and in range, fps one of
    /// `FPS_CHOICES` (nearest), every number finite and clamped.
    pub fn sanitized(&self) -> Self {
        let d = Self::default();
        let even = |v: u32, max: u32| (v.clamp(MIN_DIMENSION, max)) & !1;
        let fps = *FPS_CHOICES.iter().min_by_key(|f| (**f as i64 - self.fps as i64).abs()).expect("non-empty");
        Self {
            style: self.style,
            width: even(self.width, MAX_WIDTH),
            height: even(self.height, MAX_HEIGHT),
            fps,
            primary: clamp_color(self.primary),
            secondary: clamp_color(self.secondary),
            background: clamp_color(self.background),
            background_bottom: clamp_color(self.background_bottom),
            sensitivity: clamp_finite(self.sensitivity, 0.1, 4.0, d.sensitivity),
            smoothing: clamp_finite(self.smoothing, 0.0, 1.0, d.smoothing),
            bar_count: self.bar_count.clamp(8, 128),
            mirror: self.mirror,
            glow: clamp_finite(self.glow, 0.0, 1.0, d.glow),
            title: self.title.chars().take(120).collect(),
            artist: self.artist.chars().take(120).collect(),
            font: if self.font.trim().is_empty() { d.font } else { self.font.clone() },
            show_progress: self.show_progress,
            background_image: self.background_image.clone().filter(|p| !p.trim().is_empty()),
            background_dim: clamp_finite(self.background_dim, 0.0, 1.0, d.background_dim),
            seed: self.seed,
        }
    }

    /// The same look at another size (the live preview draws small), everything else kept.
    pub fn at_size(&self, width: u32, height: u32) -> Self {
        let mut s = self.clone();
        s.width = width;
        s.height = height;
        s.sanitized()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitized_keeps_sizes_even_and_in_range() {
        let s = VisualizerSettings { width: 1921, height: 7, fps: 50, bar_count: 1000, glow: f32::NAN, ..Default::default() }.sanitized();
        assert_eq!(s.width, 1920);
        assert_eq!(s.height, MIN_DIMENSION);
        assert_eq!(s.fps, 60);
        assert_eq!(s.bar_count, 128);
        assert_eq!(s.glow, VisualizerSettings::default().glow);
    }

    #[test]
    fn deserializes_partial_camel_case_json() {
        let s: VisualizerSettings = serde_json::from_str(r#"{"style":"radial","barCount":24,"showProgress":false}"#).unwrap();
        assert_eq!(s.style, VisualStyle::Radial);
        assert_eq!(s.bar_count, 24);
        assert!(!s.show_progress);
        assert_eq!(s.width, 1280);
    }

    #[test]
    fn style_ids_round_trip_through_serde() {
        for style in VisualStyle::ALL {
            let json = serde_json::to_string(&style).unwrap();
            assert_eq!(json, format!("\"{}\"", style.id()));
        }
    }
}
