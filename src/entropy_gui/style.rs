//! Style/Visuals — struct shapes mirror egui closely so `egui_theme.rs`-style setup code
//! only needs its content (color values), not its structure, touched.

use crate::entropy_gui::color::{Color32, Shadow, Stroke};
use crate::entropy_gui::geometry::{vec2, CornerRadius, Margin, Vec2};
use serde::Deserialize;

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

/// Addon-facing theme description (`Entropy.UI.setTheme` in the TS API, see
/// `src/deno/addon_ops.rs`'s `op_ui_set_theme`) — every field is an override on top of the
/// "Slate" default, so an addon only has to name the colors/knobs it actually wants to change.
/// Colors are `[r, g, b, a]` in 0..1, matching the convention `Entropy.UI.Widget.colorInput`
/// already uses on the JS side.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeDescriptor {
    pub background: Option<[f32; 4]>,
    pub surface: Option<[f32; 4]>,
    pub surface_hover: Option<[f32; 4]>,
    pub border: Option<[f32; 4]>,
    pub text: Option<[f32; 4]>,
    pub accent: Option<[f32; 4]>,
    pub corner_radius: Option<u8>,
    pub window_corner_radius: Option<u8>,
    pub item_spacing: Option<f32>,
    pub button_padding: Option<[f32; 2]>,
}

/// Builds a full `Style` from a `ThemeDescriptor`, filling in any field the addon didn't
/// specify with "Slate"'s own default value. This is what both `slate_style()` (an all-defaults
/// `ThemeDescriptor`) and a live `Entropy.UI.setTheme(...)` call go through.
pub fn style_from_theme(theme: &ThemeDescriptor) -> Style {
    let bg = theme.background.map(Color32::from_rgba_f32).unwrap_or(Color32::from_rgb(0x14, 0x14, 0x14));
    let surface = theme.surface.map(Color32::from_rgba_f32).unwrap_or(Color32::from_rgb(0x1B, 0x1B, 0x1B));
    let surface_2 = theme.surface_hover.map(Color32::from_rgba_f32).unwrap_or(Color32::from_rgb(0x22, 0x22, 0x22));
    let border = theme.border.map(Color32::from_rgba_f32).unwrap_or(Color32::from_rgb(0x2C, 0x2C, 0x2C));
    let text = theme.text.map(Color32::from_rgba_f32).unwrap_or(Color32::from_rgb(0xEC, 0xEC, 0xEC));
    let accent = theme.accent.map(Color32::from_rgba_f32).unwrap_or(Color32::from_rgb(0x3F, 0xD1, 0xC4));
    let corner_radius = CornerRadius::same(theme.corner_radius.unwrap_or(6));
    let window_corner_radius = CornerRadius::same(theme.window_corner_radius.unwrap_or(theme.corner_radius.unwrap_or(6)));
    let item_spacing = theme.item_spacing.unwrap_or(8.0);
    let button_padding = theme.button_padding.map(|p| vec2(p[0], p[1])).unwrap_or(vec2(9.0, 5.0));

    let mut style = Style::default();
    style.visuals = Visuals {
        dark_mode: true,
        override_text_color: Some(text),
        widgets: Widgets {
            noninteractive: WidgetVisuals {
                bg_fill: bg,
                weak_bg_fill: bg,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius,
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
            inactive: WidgetVisuals {
                bg_fill: surface,
                weak_bg_fill: surface,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius,
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
            hovered: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius,
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            active: WidgetVisuals {
                bg_fill: accent.linear_multiply(0.9),
                weak_bg_fill: accent.linear_multiply(0.16),
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius,
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            open: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius,
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
        },
        selection: Selection {
            bg_fill: accent.linear_multiply(0.35),
            stroke: Stroke::new(1.0, accent),
        },
        window_corner_radius,
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
        item_spacing: vec2(item_spacing, item_spacing),
        window_margin: Margin::same(12),
        button_padding,
        indent: 18.0,
        interact_size: vec2(24.0, 22.0),
        scroll_bar_width: 10.0,
    };
    style
}

/// Bakes in the "Slate" default theme: neutral warm-black surfaces, crisp hairline
/// borders, one restrained teal accent, compact spacing.
pub fn slate_style() -> Style {
    style_from_theme(&ThemeDescriptor::default())
}
