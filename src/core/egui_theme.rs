use crate::egui;
use crate::egui::{Color32, Context, FontId, Stroke, Visuals, style::{Widgets, WidgetVisuals, Selection}};

/// "Ember" — warm near-black surfaces with a honeyed gold accent, generous corner rounding,
/// and roomier spacing, chasing a cinematic-studio look (deep vignette-dark panels, amber
/// highlights on sliders/toggles/active tabs). Supersedes "Slate" (neutral warm-black,
/// restrained teal accent, tighter 6px rounding) — see the migration plan for that and the
/// third mocked-up direction, Nocturne (navy/cornflower).
pub fn setup_custom_theme(ctx: &Context) {
    let mut style = ctx.style().clone();

    let bg = Color32::from_rgb(0x0F, 0x0E, 0x0D);
    let surface = Color32::from_rgb(0x18, 0x15, 0x12);
    let surface_2 = Color32::from_rgb(0x24, 0x1F, 0x19);
    let border = Color32::from_rgb(0x30, 0x2A, 0x22);
    let text_color = Color32::from_rgb(0xF2, 0xEE, 0xE7);
    let accent = Color32::from_rgb(0xDD, 0xA3, 0x3D);

    style.visuals = Visuals {
        dark_mode: true,
        override_text_color: Some(text_color),
        widgets: Widgets {
            noninteractive: WidgetVisuals {
                bg_fill: bg,
                weak_bg_fill: bg,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: egui::CornerRadius::same(10),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
            inactive: WidgetVisuals {
                bg_fill: surface,
                weak_bg_fill: surface,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: egui::CornerRadius::same(10),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
            hovered: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: egui::CornerRadius::same(10),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            active: WidgetVisuals {
                bg_fill: accent.linear_multiply(0.92),
                weak_bg_fill: accent.linear_multiply(0.18),
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: egui::CornerRadius::same(10),
                fg_stroke: Stroke::new(1.0, Color32::from_rgb(0x1A, 0x14, 0x0A)),
                expansion: 0.5,
            },
            open: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: egui::CornerRadius::same(10),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
        },
        selection: Selection {
            bg_fill: accent.linear_multiply(0.35),
            stroke: Stroke::new(1.0, accent),
        },
        window_corner_radius: egui::CornerRadius::same(12),
        window_shadow: egui::epaint::Shadow {
            color: Color32::from_black_alpha(120),
            ..Default::default()
        },
        window_fill: surface,
        panel_fill: bg,
        ..Visuals::dark()
    };

    style.spacing.item_spacing = egui::vec2(10.0, 12.0);
    style.spacing.window_margin = egui::Margin::same(16);
    style.spacing.button_padding = egui::vec2(14.0, 8.0);
    style.spacing.indent = 18.0;
    // Default interact_size (24x22) reads as cramped for a "beautiful, uncluttered" feel —
    // give every button/toggle a comfier minimum footprint app-wide from one place.
    style.spacing.interact_size = egui::vec2(34.0, 30.0);

    ctx.set_style(style);
}
