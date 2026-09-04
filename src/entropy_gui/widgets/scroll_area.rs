use crate::entropy_gui::geometry::{pos2, vec2, Align, Layout, Rect};
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{InnerResponse, Ui};

pub struct ScrollArea {
    vertical: bool,
    horizontal: bool,
}

impl ScrollArea {
    pub fn vertical() -> Self {
        Self { vertical: true, horizontal: false }
    }
    pub fn horizontal() -> Self {
        Self { vertical: false, horizontal: true }
    }
    pub fn both() -> Self {
        Self { vertical: true, horizontal: true }
    }

    pub fn show<R>(self, ui: &mut Ui, add_contents: impl FnOnce(&mut Ui) -> R) -> InnerResponse<R> {
        let id = ui.next_auto_id("scroll_area");
        let region = ui.available_rect_before_wrap();
        let mut offset = ui.ctx().memory(|m| m.get_scroll(id));

        let hovered = ui.input(|i| i.pointer.pos).map_or(false, |p| region.contains(p));
        if hovered {
            let delta = ui.input(|i| i.scroll_delta);
            if self.vertical {
                offset.y -= delta.y;
            }
            if self.horizontal {
                offset.x -= delta.x;
            }
        }

        const HUGE: f32 = 100_000.0;
        let content_max_rect = Rect::from_min_size(
            pos2(region.min.x - offset.x, region.min.y - offset.y),
            vec2(if self.horizontal { HUGE } else { region.width() }, if self.vertical { HUGE } else { region.height() }),
        );
        let clip = ui.clip_rect.intersect(region);
        let mut child = Ui::new(ui.ctx().clone(), id.with("content"), content_max_rect, Layout::top_down(Align::Min), clip, ui.draw_target);
        let inner = add_contents(&mut child);
        let content_size = child.min_rect().size();

        offset.x = offset.x.clamp(0.0, (content_size.x - region.width()).max(0.0));
        offset.y = offset.y.clamp(0.0, (content_size.y - region.height()).max(0.0));
        ui.ctx().memory_mut(|m| m.set_scroll(id, offset));

        if self.vertical && content_size.y > region.height() {
            let bar_w = 4.0;
            let track = Rect::from_min_size(pos2(region.max.x - bar_w - 2.0, region.min.y), vec2(bar_w, region.height()));
            let ratio = (region.height() / content_size.y).clamp(0.02, 1.0);
            let thumb_h = track.height() * ratio;
            let range = (content_size.y - region.height()).max(1.0);
            let thumb_y = track.min.y + (track.height() - thumb_h) * (offset.y / range);
            let thumb = Rect::from_min_size(pos2(track.min.x, thumb_y), vec2(bar_w, thumb_h));
            ui.painter().rect_filled(thumb, 2u8, ui.visuals().widgets.inactive.bg_stroke.color);
        }

        ui.advance_after_child(Rect::from_min_size(region.min, region.size()));
        let resp_id = ui.next_auto_id("scroll_area_resp");
        InnerResponse { inner, response: ui.interact(region, resp_id, Sense::hover()) }
    }
}
