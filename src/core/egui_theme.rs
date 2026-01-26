use egui::{Color32, Context, FontId, Stroke, Visuals, style::{Widgets, WidgetVisuals, Selection}};

pub fn setup_custom_theme(ctx: &Context) {
    let mut style = (*ctx.style()).clone();

    // Define accent colors
    let accent_color = Color32::from_rgb(100, 149, 237); // Cornflower Blue
    let background_color = Color32::from_rgb(26, 27, 38); // Deep Dark Blue-Grey
    let surface_color = Color32::from_rgb(36, 40, 59); // Slightly lighter surface
    let text_color = Color32::from_rgb(192, 202, 245); // Soft white/blue text

    style.visuals = Visuals {
        dark_mode: true,
        override_text_color: Some(text_color),
        widgets: Widgets {
            noninteractive: WidgetVisuals {
                bg_fill: background_color,
                weak_bg_fill: background_color,
                bg_stroke: Stroke::new(1.0, Color32::from_gray(40)),
                corner_radius: egui::CornerRadius::same(4),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
            inactive: WidgetVisuals {
                bg_fill: surface_color,
                weak_bg_fill: surface_color,
                bg_stroke: Stroke::new(1.0, Color32::from_gray(60)),
                corner_radius: egui::CornerRadius::same(4),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
            hovered: WidgetVisuals {
                bg_fill: Color32::from_rgb(47, 51, 73),
                weak_bg_fill: Color32::from_rgb(47, 51, 73),
                bg_stroke: Stroke::new(1.0, accent_color),
                corner_radius: egui::CornerRadius::same(4),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 1.0,
            },
            active: WidgetVisuals {
                bg_fill: Color32::from_rgb(65, 72, 104),
                weak_bg_fill: Color32::from_rgb(65, 72, 104),
                bg_stroke: Stroke::new(1.0, accent_color),
                corner_radius: egui::CornerRadius::same(4),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 1.0,
            },
            open: WidgetVisuals {
                bg_fill: surface_color,
                weak_bg_fill: surface_color,
                bg_stroke: Stroke::new(1.0, Color32::from_gray(60)),
                corner_radius: egui::CornerRadius::same(4),
                fg_stroke: Stroke::new(1.0, text_color),
                expansion: 0.0,
            },
        },
        selection: Selection {
            bg_fill: accent_color.linear_multiply(0.5),
            stroke: Stroke::new(1.0, accent_color),
        },
        // window_rounding: egui::Rounding::same(8.0),
        window_corner_radius: egui::CornerRadius::same(8),
        window_shadow: egui::epaint::Shadow {
            // extrusion: 12.0,
            color: Color32::from_black_alpha(80),
            ..Default::default()
        },
        window_fill: background_color,
        panel_fill: background_color,
        ..Visuals::dark()
    };

    // Increase spacing for a cleaner look
    style.spacing.item_spacing = egui::vec2(10.0, 10.0);
    style.spacing.window_margin = egui::Margin::same(12);
    style.spacing.button_padding = egui::vec2(8.0, 4.0);
    style.spacing.indent = 20.0;

    ctx.set_style(style);

    // Optional: Setup fonts if you want to be even more specific
    // let mut fonts = egui::FontDefinitions::default();
    // ctx.set_fonts(fonts);
}
