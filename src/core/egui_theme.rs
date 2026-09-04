use crate::egui;
use crate::egui::{Color32, Context, FontId, Stroke, Visuals, style::{Widgets, WidgetVisuals, Selection}};

/// "Slate" — neutral warm-black surfaces, crisp hairline borders, one restrained teal accent,
/// compact spacing. Picked by the user from three mocked-up directions when entropy_gui
/// replaced egui as this app's GUI kit; see the migration plan for the other two (Nocturne,
/// a refined version of this file's old navy/cornflower palette, and Ember, a denser warm
/// amber direction).
pub fn setup_custom_theme(ctx: &Context) {
    let mut style = ctx.style().clone();

    let bg = Color32::from_rgb(0x14, 0x14, 0x14);
    let surface = Color32::from_rgb(0x1B, 0x1B, 0x1B);
    let surface_2 = Color32::from_rgb(0x22, 0x22, 0x22);
    let border = Color32::from_rgb(0x2C, 0x2C, 0x2C);
    let text_color = Color32::from_rgb(0xEC, 0xEC, 0xEC);
    let accent = Color32::from_rgb(0x3F, 0xD1, 0xC4);

    style.visuals = Visuals {
        dark_mode: true,
        override_text_color: Some(text_color),
        widgets: Widgets {
            noninteractive: WidgetVisuals {
                bg_fill: bg,
                weak_bg_fill: bg,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: egui::CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
            inactive: WidgetVisuals {
                bg_fill: surface,
                weak_bg_fill: surface,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: egui::CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
            hovered: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: egui::CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            active: WidgetVisuals {
                bg_fill: accent.linear_multiply(0.9),
                weak_bg_fill: accent.linear_multiply(0.16),
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: egui::CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            open: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: egui::CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
        },
        selection: Selection {
            bg_fill: accent.linear_multiply(0.35),
            stroke: Stroke::new(1.0, accent),
        },
        window_corner_radius: egui::CornerRadius::same(6),
        window_shadow: egui::epaint::Shadow {
            color: Color32::from_black_alpha(100),
            ..Default::default()
        },
        window_fill: surface,
        panel_fill: bg,
        ..Visuals::dark()
    };

    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.window_margin = egui::Margin::same(12);
    style.spacing.button_padding = egui::vec2(9.0, 5.0);
    style.spacing.indent = 18.0;

    ctx.set_style(style);
}
