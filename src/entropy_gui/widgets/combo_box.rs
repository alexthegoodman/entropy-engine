use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, Layout, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

pub struct ComboBox {
    id: Id,
    label: Option<String>,
    selected_text: String,
}

impl ComboBox {
    pub fn from_label(label: impl Into<String>) -> Self {
        let label = label.into();
        Self { id: Id::new(&label), label: Some(label), selected_text: String::new() }
    }
    pub fn from_id_source(id_source: impl std::hash::Hash) -> Self {
        Self { id: Id::new(id_source), label: None, selected_text: String::new() }
    }
    pub fn selected_text(mut self, t: impl Into<String>) -> Self {
        self.selected_text = t.into();
        self
    }

    pub fn show_ui(self, ui: &mut Ui, add_contents: impl FnOnce(&mut Ui)) -> Response {
        let ComboBox { id, label, selected_text } = self;
        if let Some(l) = &label {
            ui.label(l.as_str());
        }

        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let padding = ui.style().spacing.button_padding;
        let text_size = Painter::measure_text(ui.ctx(), font, &selected_text);
        let size = vec2((text_size.x + padding.x * 2.0 + 18.0).max(70.0), text_size.y + padding.y * 2.0).max(ui.style().spacing.interact_size);
        let (rect, response) = ui.allocate_response(size, Sense::click());

        let is_open_before = ui.ctx().memory(|m| m.get_open(id, false));
        let visuals = ui.interactive_visuals(response.hovered(), is_open_before);
        let painter = ui.painter();
        painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill);
        painter.rect_stroke(rect, visuals.corner_radius, visuals.bg_stroke, StrokeKind::Middle);
        painter.text(pos2(rect.min.x + padding.x, rect.center().y), Align2::LEFT_CENTER, &selected_text, font, visuals.fg_stroke.color);
        painter.text(pos2(rect.max.x - 14.0, rect.center().y), Align2::LEFT_CENTER, "\u{25BE}", font, visuals.fg_stroke.color);

        if response.clicked() {
            ui.ctx().memory_mut(|m| m.toggle_open(id, false));
        }

        let is_open = ui.ctx().memory(|m| m.get_open(id, false));
        if is_open {
            let popup_rect = Rect::from_min_size(pos2(rect.min.x, rect.max.y + 2.0), vec2(rect.width().max(150.0), 180.0));
            let style = ui.style();
            let bg = Painter::new(ui.ctx().clone(), Rect::everything(), DrawTarget::Overlay);
            bg.rect_filled(popup_rect, style.visuals.window_corner_radius, style.visuals.window_fill);
            bg.rect_stroke(popup_rect, style.visuals.window_corner_radius, style.visuals.window_stroke, StrokeKind::Middle);

            let mut popup_ui = Ui::new(ui.ctx().clone(), id.with("combo_popup"), popup_rect.shrink(4.0), Layout::top_down(Align::Min), popup_rect, DrawTarget::Overlay);
            add_contents(&mut popup_ui);

            // Any primary press outside the toggle button — including an item click inside the
            // popup, i.e. a selection was just made — closes the popup starting next frame.
            let press_pos = ui.input(|i| if i.pointer.primary_pressed { i.pointer.pos } else { None });
            if let Some(p) = press_pos {
                if !rect.contains(p) {
                    ui.ctx().memory_mut(|m| m.set_open(id, false));
                }
            }
        }

        response
    }
}
