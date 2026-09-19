use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, Layout, Rect};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::{InnerResponse, Ui};
use crate::entropy_gui::FontId;

pub struct CollapsingHeader {
    title: String,
    id: Option<Id>,
    default_open: bool,
}

impl CollapsingHeader {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            id: None,
            default_open: false,
        }
    }
    pub fn id_source(mut self, salt: impl std::hash::Hash) -> Self {
        self.id = Some(Id::new(salt));
        self
    }
    pub fn default_open(mut self, open: bool) -> Self {
        self.default_open = open;
        self
    }

    pub fn show<R>(
        self,
        ui: &mut Ui,
        add_contents: impl FnOnce(&mut Ui) -> R,
    ) -> InnerResponse<Option<R>> {
        let id = self.id.unwrap_or_else(|| Id::new(&self.title));
        let default_open = self.default_open;

        let font = FontId::proportional(DEFAULT_FONT_SIZE);
        let h = ui.style().spacing.interact_size.y;
        let (header_rect, header_resp) =
            ui.allocate_exact_size(vec2(ui.available_width(), h), Sense::click());
        if header_resp.clicked() {
            ui.ctx().memory_mut(|m| m.toggle_open(id, default_open));
        }
        let is_open = ui.ctx().memory(|m| m.get_open(id, default_open));

        // An expanded header is open state, not pressed state. In particular, themes are free
        // to use a dark foreground for a pressed control on an accent fill; using that color
        // for every expanded header made pinned-open titles nearly invisible.
        let ui_visuals = ui.visuals();
        let visuals = header_visuals(&ui_visuals, header_resp.hovered(), is_open);
        let painter = ui.painter();
        if header_resp.hovered() {
            painter.rect_filled(header_rect, visuals.corner_radius, visuals.bg_fill);
        }
        let arrow = if is_open { "\u{25BE}" } else { "\u{25B8}" };
        painter.text(
            pos2(header_rect.min.x + 4.0, header_rect.center().y),
            Align2::LEFT_CENTER,
            arrow,
            font,
            visuals.fg_stroke.color,
        );
        painter.text(
            pos2(header_rect.min.x + 20.0, header_rect.center().y),
            Align2::LEFT_CENTER,
            &self.title,
            font,
            visuals.fg_stroke.color,
        );

        let inner = if is_open {
            let indent = ui.style().spacing.indent;
            let max_rect = ui.max_rect();
            let region = Rect::from_min_max(
                pos2(max_rect.min.x + indent, header_rect.max.y),
                max_rect.max,
            );
            let clip = ui.clip_rect.intersect(region);
            let mut child = Ui::new(
                ui.ctx().clone(),
                id,
                region,
                Layout::top_down(Align::Min),
                clip,
                ui.draw_target,
            );
            let r = add_contents(&mut child);
            let used = child.min_rect();
            ui.advance_after_child(used);
            Some(r)
        } else {
            None
        };

        InnerResponse {
            inner,
            response: header_resp,
        }
    }
}

fn header_visuals(
    visuals: &crate::entropy_gui::style::Visuals,
    hovered: bool,
    is_open: bool,
) -> crate::entropy_gui::style::WidgetVisuals {
    if hovered {
        visuals.widgets.hovered
    } else if is_open {
        visuals.widgets.open
    } else {
        visuals.widgets.inactive
    }
}

#[cfg(test)]
mod tests {
    use super::header_visuals;
    use crate::entropy_gui::style::{style_from_theme, ThemeDescriptor};

    #[test]
    fn pinned_open_header_uses_open_visuals_instead_of_pressed_visuals() {
        let visuals = style_from_theme(&ThemeDescriptor::default()).visuals;

        assert_eq!(header_visuals(&visuals, false, true), visuals.widgets.open);
        assert_ne!(
            header_visuals(&visuals, false, true),
            visuals.widgets.active
        );
    }
}

impl Ui {
    pub fn collapsing<R>(
        &mut self,
        title: impl Into<String>,
        add_contents: impl FnOnce(&mut Ui) -> R,
    ) -> InnerResponse<Option<R>> {
        CollapsingHeader::new(title).show(self, add_contents)
    }
}
