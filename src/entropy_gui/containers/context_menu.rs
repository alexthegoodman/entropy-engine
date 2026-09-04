//! `Response::context_menu` — a deliberately simplified single-level right-click popup:
//! an inline overlay drawn late (on top of everything), dismissed by a primary click outside
//! its region or by the caller invoking `ui.close_menu()` on an item. Not a full layered
//! `Area`/popup subsystem — sufficient for every real call site in this app (all single-level,
//! no nested submenus; see `src/core/video_timeline_ui.rs`'s two usages).

use crate::entropy_gui::context::Context;
use crate::entropy_gui::geometry::{vec2, Align, Layout, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::{DrawTarget, Painter};
use crate::entropy_gui::ui::Ui;

const MENU_SIZE: (f32, f32) = (190.0, 220.0);

pub fn context_menu(ctx: &Context, id: Id, anchor_rect: Rect, just_secondary_clicked: bool, add_contents: impl FnOnce(&mut Ui)) {
    if just_secondary_clicked {
        let pos = ctx.input(|i| i.pointer.pos).unwrap_or(anchor_rect.left_bottom());
        ctx.memory_mut(|m| {
            m.popup_open = Some(id);
            m.popup_pos = pos;
        });
        // Opens next frame: this avoids the same click that opened the menu also being
        // read as an outside-click that immediately closes it.
        return;
    }

    if ctx.memory(|m| m.popup_open) != Some(id) {
        return;
    }

    let popup_pos = ctx.memory(|m| m.popup_pos);
    let region = Rect::from_min_size(popup_pos, vec2(MENU_SIZE.0, MENU_SIZE.1));

    let press_pos = ctx.input(|i| if i.pointer.primary_pressed { i.pointer.pos } else { None });
    if let Some(p) = press_pos {
        if !region.contains(p) {
            ctx.memory_mut(|m| m.popup_open = None);
            return;
        }
    }

    let style = ctx.style();
    let bg = Painter::new(ctx.clone(), Rect::everything(), DrawTarget::Overlay);
    bg.rect_filled(region, style.visuals.window_corner_radius, style.visuals.window_fill);
    bg.rect_stroke(region, style.visuals.window_corner_radius, style.visuals.window_stroke, StrokeKind::Middle);

    let mut ui = Ui::new(ctx.clone(), id.with("context_menu"), region.shrink(4.0), Layout::top_down(Align::Min), region, DrawTarget::Overlay);
    add_contents(&mut ui);
}
