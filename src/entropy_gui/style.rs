//! Style/Visuals — struct shapes mirror egui closely so `egui_theme.rs`-style setup code
//! only needs its content (color values), not its structure, touched.

use crate::entropy_gui::color::{Color32, Shadow, Stroke};
use crate::entropy_gui::geometry::{vec2, CornerRadius, Margin, Vec2};

pub const DEFAULT_FONT_SIZE: f32 = 14.0;
pub const HEADING_FONT_SIZE: f32 = 18.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WidgetVisuals {
    pub bg_fill: Color32,
    pub weak_bg_fill: Color32,
    pub bg_stroke: Stroke,
    pub corner_radius: CornerRadius,
    pub fg_stroke: Stroke,
    pub expansion: f32,
}

impl Default for WidgetVisuals {
    fn default() -> Self {
        Self {
            bg_fill: Color32::from_gray(60),
            weak_bg_fill: Color32::from_gray(60),
            bg_stroke: Stroke::NONE,
            corner_radius: CornerRadius::same(4),
            fg_stroke: Stroke::new(1.0, Color32::from_gray(200)),
            expansion: 0.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Widgets {
    pub noninteractive: WidgetVisuals,
    pub inactive: WidgetVisuals,
    pub hovered: WidgetVisuals,
    pub active: WidgetVisuals,
    pub open: WidgetVisuals,
}

impl Default for Widgets {
    fn default() -> Self {
        Self {
            noninteractive: WidgetVisuals::default(),
            inactive: WidgetVisuals::default(),
            hovered: WidgetVisuals::default(),
            active: WidgetVisuals::default(),
            open: WidgetVisuals::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Selection {
    pub bg_fill: Color32,
    pub stroke: Stroke,
}

impl Default for Selection {
    fn default() -> Self {
        Self {
            bg_fill: Color32::from_rgb(90, 130, 230),
            stroke: Stroke::new(1.0, Color32::from_rgb(90, 130, 230)),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Visuals {
    pub dark_mode: bool,
    pub override_text_color: Option<Color32>,
    pub widgets: Widgets,
    pub selection: Selection,
    pub window_corner_radius: CornerRadius,
    pub window_shadow: Shadow,
    pub window_fill: Color32,
    pub window_stroke: Stroke,
    pub panel_fill: Color32,
    pub extreme_bg_color: Color32,
    pub hyperlink_color: Color32,
    pub warn_fg_color: Color32,
    pub error_fg_color: Color32,
}

impl Visuals {
    pub fn dark() -> Self {
        Self {
            dark_mode: true,
            override_text_color: None,
            widgets: Widgets::default(),
            selection: Selection::default(),
            window_corner_radius: CornerRadius::same(6),
            window_shadow: Shadow::default(),
            window_fill: Color32::from_gray(27),
            window_stroke: Stroke::new(1.0, Color32::from_gray(45)),
            panel_fill: Color32::from_gray(20),
            extreme_bg_color: Color32::from_gray(10),
            hyperlink_color: Color32::from_rgb(90, 170, 220),
            warn_fg_color: Color32::from_rgb(230, 180, 60),
            error_fg_color: Color32::from_rgb(230, 90, 90),
        }
    }
}

impl Default for Visuals {
    fn default() -> Self {
        Self::dark()
    }
}

impl Visuals {
    /// Method form matching real egui's `Visuals::window_fill()`/`window_stroke()` (which
    /// exist alongside the plain fields there too) — `visuals.window_fill` (no parens) still
    /// reads the field, `visuals.window_fill()` calls this.
    pub fn window_fill(&self) -> Color32 {
        self.window_fill
    }
    pub fn window_stroke(&self) -> Stroke {
        self.window_stroke
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Spacing {
    pub item_spacing: Vec2,
    pub window_margin: Margin,
    pub button_padding: Vec2,
    pub indent: f32,
    /// Minimum interactive widget size (click/drag target), egui's `interact_size`.
    pub interact_size: Vec2,
    pub scroll_bar_width: f32,
}

impl Default for Spacing {
    fn default() -> Self {
        Self {
            item_spacing: vec2(8.0, 8.0),
            window_margin: Margin::same(12),
            button_padding: vec2(8.0, 4.0),
            indent: 18.0,
            interact_size: vec2(24.0, 22.0),
            scroll_bar_width: 10.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Style {
    pub visuals: Visuals,
    pub spacing: Spacing,
}

impl Default for Style {
    fn default() -> Self {
        Self { visuals: Visuals::dark(), spacing: Spacing::default() }
    }
}

/// Lets `ctx.style().as_ref()` keep compiling at call sites written against real egui's
/// `Arc<egui::Style>` (whose `.as_ref()` unwraps the `Arc`) — here `ctx.style()` already
/// returns an owned `Style`, so this is just the identity borrow.
impl AsRef<Style> for Style {
    fn as_ref(&self) -> &Style {
        self
    }
}

/// Bakes in the "Slate" default theme: neutral warm-black surfaces, crisp hairline
/// borders, one restrained teal accent, compact spacing.
pub fn slate_style() -> Style {
    let bg = Color32::from_rgb(0x14, 0x14, 0x14);
    let surface = Color32::from_rgb(0x1B, 0x1B, 0x1B);
    let surface_2 = Color32::from_rgb(0x22, 0x22, 0x22);
    let border = Color32::from_rgb(0x2C, 0x2C, 0x2C);
    let text = Color32::from_rgb(0xEC, 0xEC, 0xEC);
    let accent = Color32::from_rgb(0x3F, 0xD1, 0xC4);

    let mut style = Style::default();
    style.visuals = Visuals {
        dark_mode: true,
        override_text_color: Some(text),
        widgets: Widgets {
            noninteractive: WidgetVisuals {
                bg_fill: bg,
                weak_bg_fill: bg,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
            inactive: WidgetVisuals {
                bg_fill: surface,
                weak_bg_fill: surface,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
            hovered: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            active: WidgetVisuals {
                bg_fill: accent.linear_multiply(0.9),
                weak_bg_fill: accent.linear_multiply(0.16),
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            open: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
        },
        selection: Selection {
            bg_fill: accent.linear_multiply(0.35),
            stroke: Stroke::new(1.0, accent),
        },
        window_corner_radius: CornerRadius::same(6),
        window_shadow: Shadow { color: Color32::from_black_alpha(100), offset: [0, 4], blur: 18, spread: 0 },
        window_fill: surface,
        window_stroke: Stroke::new(1.0, border),
        panel_fill: bg,
        extreme_bg_color: Color32::from_rgb(0x0E, 0x0E, 0x0E),
        hyperlink_color: accent,
        warn_fg_color: Color32::from_rgb(230, 180, 60),
        error_fg_color: Color32::from_rgb(230, 90, 90),
    };
    style.spacing = Spacing {
        item_spacing: vec2(8.0, 8.0),
        window_margin: Margin::same(12),
        button_padding: vec2(9.0, 5.0),
        indent: 18.0,
        interact_size: vec2(24.0, 22.0),
        scroll_bar_width: 10.0,
    };
    style
}
