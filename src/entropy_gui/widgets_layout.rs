//! Page-structure containers for app-shaped addons (the DAW first): a fixed-height `Bar` with
//! left / centre / right zones (a header, a toolbar, a status bar), a `Split` that fills the rest
//! of the window with a main area beside a fixed-width side panel (an inspector), a `Card` that
//! boxes a group of controls on a filled background, and `Segmented`, a row of mutually exclusive
//! buttons that replaces a dropdown with two to five options.
//!
//! Everything here is single-pass like the rest of `entropy_gui`. A bar's centre and right zones
//! need to know how wide their content is before placing it; they use the width measured on the
//! previous frame (kept in `Memory` under the bar's id), so the first frame after a zone's content
//! changes width may sit a few points off and settles on the next.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, FontId, Layout, Rect};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::Sense;
use crate::entropy_gui::ui::{interact, Ui};

/// Which part of a `Bar` a child `Ui` lays out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BarZone {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug)]
pub struct BarStyle {
    pub height: f32,
    pub fill: Color32,
    /// A hairline along the bottom edge (a header) - or the top edge when `border_top` is set
    /// (a status bar).
    pub border: Option<Color32>,
    pub border_top: bool,
    pub padding_x: f32,
    pub gap: f32,
}

impl Default for BarStyle {
    fn default() -> Self {
        Self { height: 40.0, fill: Color32::TRANSPARENT, border: None, border_top: false, padding_x: 10.0, gap: 6.0 }
    }
}

/// A full-width, fixed-height strip. `Bar::begin` claims the rect and paints the background;
/// `zone_ui` hands out a child `Ui` per zone and `end_zone` records how wide it came out.
pub struct Bar {
    id: Id,
    rect: Rect,
    style: BarStyle,
    left_used: f32,
}

impl Bar {
    pub fn begin(ui: &mut Ui, id_salt: impl std::hash::Hash, style: BarStyle) -> Bar {
        let id = Id::new("layout_bar").with(id_salt);
        let avail_w = ui.available_width();
        let width = if avail_w > 20_000.0 { ui.clip_rect.width().max(1.0) } else { avail_w.max(1.0) };
        let (rect, _) = ui.allocate_exact_size(vec2(width, style.height), Sense::hover());
        butt_against_next(ui);
        let painter = ui.painter();
        if style.fill.a() > 0 {
            painter.rect_filled(rect, 0u8, style.fill);
        }
        if let Some(border) = style.border {
            let y = if style.border_top { rect.min.y } else { rect.max.y - 1.0 };
            painter.rect_filled(Rect::from_min_size(pos2(rect.min.x, y), vec2(rect.width(), 1.0)), 0u8, border);
        }
        Bar { id, rect, style, left_used: 0.0 }
    }

    pub fn rect(&self) -> Rect {
        self.rect
    }

    fn inner(&self) -> Rect {
        Rect::from_min_max(pos2(self.rect.min.x + self.style.padding_x, self.rect.min.y), pos2(self.rect.max.x - self.style.padding_x, self.rect.max.y))
    }

    fn last_width(&self, ui: &Ui, zone: BarZone) -> f32 {
        ui.ctx().memory(|m| m.get_scalar(self.id.with(zone))).unwrap_or(0.0)
    }

    /// A left-to-right, vertically centred child `Ui` for `zone`. Left starts at the bar's left
    /// padding; right ends at its right padding; centre is centred on the bar, pushed right if it
    /// would overlap the left zone.
    pub fn zone_ui(&self, ui: &Ui, zone: BarZone) -> Ui {
        let inner = self.inner();
        let right_w = self.last_width(ui, BarZone::Right);
        let x = match zone {
            BarZone::Left => inner.min.x,
            BarZone::Center => {
                let w = self.last_width(ui, zone);
                (inner.center().x - w * 0.5).max(inner.min.x + self.left_used + self.style.gap * 2.0)
            }
            BarZone::Right => {
                let w = right_w;
                (inner.max.x - w).max(inner.min.x)
            }
        };
        let max_x = match zone {
            BarZone::Left | BarZone::Center => {
                if right_w > 0.0 {
                    (inner.max.x - right_w - self.style.gap).max(x + 1.0)
                } else {
                    inner.max.x.max(x + 1.0)
                }
            }
            BarZone::Right => inner.max.x.max(x + 1.0),
        };
        let rect = Rect::from_min_max(pos2(x, inner.min.y), pos2(max_x, inner.max.y));
        let mut child = ui.child_ui_at(rect, Layout::left_to_right(Align::Center), (self.id, zone));
        child.clip_rect = ui.clip_rect.intersect(rect);
        child
    }

    /// Records the zone's measured width for next frame's placement.
    pub fn end_zone(&mut self, ui: &Ui, zone: BarZone, child: &Ui) {
        let used = child.min_rect();
        let width = if used.width().is_finite() { used.width().max(0.0) } else { 0.0 };
        if zone == BarZone::Left {
            self.left_used = width;
        }
        let key = self.id.with(zone);
        let before = ui.ctx().memory(|m| m.get_scalar(key));
        if before.map_or(true, |b| (b - width).abs() > 0.5) {
            ui.ctx().memory_mut(|m| m.set_scalar(key, width));
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SplitStyle {
    /// Width of the side panel; 0 (or `side_open == false`) gives the whole width to the main area.
    pub side_width: f32,
    pub side_open: bool,
    /// Height left free under the split for whatever comes after it (a status bar).
    pub reserve_bottom: f32,
    pub min_height: f32,
    pub main_fill: Color32,
    pub side_fill: Color32,
    pub divider: Color32,
}

impl Default for SplitStyle {
    fn default() -> Self {
        Self {
            side_width: 320.0,
            side_open: true,
            reserve_bottom: 0.0,
            min_height: 200.0,
            main_fill: Color32::TRANSPARENT,
            side_fill: Color32::TRANSPARENT,
            divider: Color32::from_gray(45),
        }
    }
}

/// The rest of the window, split into a main area and a fixed-width side panel on the right.
pub struct Split {
    pub rect: Rect,
    pub main: Rect,
    pub side: Option<Rect>,
}

impl Split {
    pub fn begin(ui: &mut Ui, style: SplitStyle) -> Split {
        let avail = ui.available_rect_before_wrap();
        let height = (avail.height() - style.reserve_bottom).max(style.min_height);
        // Inside a scroll area the available height is unbounded; fall back to the minimum.
        let height = if height > 20_000.0 { style.min_height } else { height };
        let width = if avail.width() > 20_000.0 { ui.clip_rect.width().max(1.0) } else { avail.width().max(1.0) };
        let (rect, _) = ui.allocate_exact_size(vec2(width, height), Sense::hover());
        butt_against_next(ui);
        let side_w = if style.side_open { style.side_width.clamp(0.0, rect.width() * 0.6) } else { 0.0 };
        let main = Rect::from_min_max(rect.min, pos2(rect.max.x - side_w, rect.max.y));
        let side = (side_w > 0.0).then(|| Rect::from_min_max(pos2(rect.max.x - side_w, rect.min.y), rect.max));
        let painter = ui.painter();
        if style.main_fill.a() > 0 {
            painter.rect_filled(main, 0u8, style.main_fill);
        }
        if let Some(side) = side {
            if style.side_fill.a() > 0 {
                painter.rect_filled(side, 0u8, style.side_fill);
            }
            painter.rect_filled(Rect::from_min_size(side.min, vec2(1.0, side.height())), 0u8, style.divider);
        }
        Split { rect, main, side }
    }

    /// A top-down child `Ui` over `pane` (inset by `padding`), clipped to it.
    pub fn pane_ui(ui: &Ui, pane: Rect, padding: f32, id_salt: impl std::hash::Hash) -> Ui {
        let inner = Rect::from_min_max(pos2(pane.min.x + padding, pane.min.y + padding), pos2(pane.max.x - padding, pane.max.y - padding));
        let mut child = ui.child_ui_at(inner, Layout::top_down(Align::Min), id_salt);
        child.clip_rect = ui.clip_rect.intersect(pane);
        child
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CardStyle {
    pub fill: Color32,
    pub stroke: Stroke,
    pub radius: u8,
    pub padding: f32,
    /// A fixed outer width (a channel strip); `None` spans a column or wraps a row's content.
    pub width: Option<f32>,
}

impl Default for CardStyle {
    fn default() -> Self {
        Self { fill: Color32::from_rgb(23, 26, 36), stroke: Stroke::new(1.0, Color32::from_rgb(35, 40, 54)), radius: 10, padding: 10.0, width: None }
    }
}

/// Page-structure pieces stack flush: take back the item spacing a top-down `Ui` adds after them,
/// so a header, the split under it and a status bar meet without a strip of background between.
fn butt_against_next(ui: &mut Ui) {
    if ui.layout_direction() == crate::entropy_gui::geometry::Direction::TopDown {
        let gap = ui.style().spacing.item_spacing.y;
        ui.add_space(-gap);
    }
}

/// A boxed group: content laid out top-down on a filled, rounded background that is painted
/// underneath the content once its size is known.
pub fn card<R>(ui: &mut Ui, id_salt: impl std::hash::Hash, style: CardStyle, add_contents: impl FnOnce(&mut Ui) -> R) -> R {
    let painter = ui.painter();
    let mark = painter.mark();
    let mut region = ui.available_rect_before_wrap();
    if let Some(w) = style.width {
        region.max.x = region.min.x + w.max(style.padding * 2.0 + 1.0);
    }
    let in_row = ui.layout_direction() != crate::entropy_gui::geometry::Direction::TopDown && style.width.is_none();
    let inner_rect = Rect::from_min_max(pos2(region.min.x + style.padding, region.min.y + style.padding), pos2(region.max.x - style.padding, region.max.y.max(region.min.y + 1.0)));
    let mut child = ui.child_ui_at(inner_rect, Layout::top_down(Align::Min), id_salt);
    // A row's region is one widget tall; the card grows past it, so clip to the parent instead.
    child.clip_rect = ui.clip_rect;
    let inner = add_contents(&mut child);
    let used = child.min_rect();
    // In a column a card spans the full width; in a row it wraps its content's width.
    let right = if in_row { used.max.x + style.padding } else { region.max.x };
    let rect = Rect::from_min_max(region.min, pos2(right.max(region.min.x + style.padding * 2.0), used.max.y.max(region.min.y) + style.padding));
    painter.rect_behind(mark, rect, style.radius, style.fill, style.stroke);
    ui.advance_after_child(rect);
    inner
}

/// A row of mutually exclusive options. Returns the index clicked this frame, if it differs from
/// `selected`. Left/Right arrows move the choice while it has keyboard focus.
pub struct Segmented {
    id: Id,
    compact: bool,
}

impl Segmented {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("segmented").with(id_salt), compact: false }
    }

    pub fn compact(mut self, compact: bool) -> Self {
        self.compact = compact;
        self
    }

    pub fn show(self, ui: &mut Ui, options: &[String], selected: usize, accent: Option<Color32>) -> Option<usize> {
        let ctx = ui.ctx().clone();
        let font = FontId::proportional(if self.compact { 11.5 } else { 12.0 });
        let pad_x = if self.compact { 7.0 } else { 9.0 };
        let seg_h = if self.compact { 20.0 } else { 22.0 };
        let inset = 2.0;
        let widths: Vec<f32> = options.iter().map(|o| Painter::measure_text(&ctx, font, o).x.ceil() + pad_x * 2.0).collect();
        let total = widths.iter().sum::<f32>() + inset * 2.0 + (options.len().saturating_sub(1)) as f32 * 2.0;
        let (rect, _) = ui.allocate_exact_size(vec2(total, seg_h + inset * 2.0), Sense::hover());
        let painter = ui.painter();
        painter.rect_filled(rect, 7u8, Color32::from_rgb(13, 15, 20));
        painter.rect_stroke(rect, 7u8, Stroke::new(1.0, Color32::from_rgb(35, 40, 54)), crate::entropy_gui::geometry::StrokeKind::Middle);
        let mut picked = None;
        let mut x = rect.min.x + inset;
        let now = ctx.time();
        for (i, (label, w)) in options.iter().zip(&widths).enumerate() {
            let r = Rect::from_min_size(pos2(x, rect.min.y + inset), vec2(*w, seg_h));
            let mut resp = interact(&ctx, r, self.id.with(i), Sense::click());
            let on = i == selected;
            if on && ui.focus(&mut resp) {
                if ctx.consume_key(Key::ArrowRight) && i + 1 < options.len() {
                    picked = Some(i + 1);
                } else if ctx.consume_key(Key::ArrowLeft) && i > 0 {
                    picked = Some(i - 1);
                }
            }
            if on {
                // The chosen segment eases in: brightest the moment it is picked.
                let key = self.id.with(("since", i));
                let since = ctx.memory(|m| m.get_scalar(key)).unwrap_or(now - 1.0);
                let t = ((now - since) / 0.18).clamp(0.0, 1.0);
                let fill = match accent {
                    Some(a) => a.linear_multiply(0.30 + 0.10 * (1.0 - t)),
                    None => Color32::from_rgb(42, 48, 64).lerp(Color32::from_rgb(58, 66, 88), 1.0 - t),
                };
                painter.rect_filled(r, 5u8, fill);
            } else if resp.hovered() {
                painter.rect_filled(r, 5u8, Color32::from_rgb(28, 32, 43));
            }
            let color = if on { Color32::WHITE } else if resp.hovered() { Color32::from_rgb(230, 234, 242) } else { Color32::from_rgb(144, 152, 174) };
            painter.text(r.center(), Align2::CENTER_CENTER, label, font, color);
            if resp.clicked() && !on {
                picked = Some(i);
            }
            x += w + 2.0;
        }
        if let Some(p) = picked {
            ctx.memory_mut(|m| m.set_scalar(self.id.with(("since", p)), now));
        }
        picked
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entropy_gui::context::{Context, RawInput};
    use crate::entropy_gui::geometry::{pos2, vec2, Layout, Rect};
    use crate::entropy_gui::id::Id;
    use crate::entropy_gui::painter::DrawTarget;

    #[test]
    fn test_bar_and_split_bounded_in_unbounded_scroll_area() {
        let ctx = Context::default();
        ctx.run(RawInput::default(), |ctx| {
            // Simulate a child Ui inside ScrollArea::both() where width is 100,000 but clip_rect is 600
            let huge_rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(100_000.0, 100_000.0));
            let clip = Rect::from_min_size(pos2(0.0, 0.0), vec2(600.0, 800.0));
            let mut ui = Ui::new(ctx.clone(), Id::new("scroll_content"), huge_rect, Layout::top_down(Align::Min), clip, DrawTarget::Main);

            assert!(ui.available_width() > 20_000.0);

            let bar = Bar::begin(&mut ui, "test_bar", BarStyle::default());
            assert_eq!(bar.rect().width(), 600.0, "Bar must clamp to clip_rect when available_width > 20,000");

            let split = Split::begin(&mut ui, SplitStyle::default());
            assert_eq!(split.rect.width(), 600.0, "Split must clamp to clip_rect when available_width > 20,000");
        });
    }

    #[test]
    fn test_bar_zone_ui_clips_overlapping_center_and_right() {
        let ctx = Context::default();
        ctx.run(RawInput::default(), |ctx| {
            let rect = Rect::from_min_size(pos2(0.0, 0.0), vec2(300.0, 40.0));
            let clip = rect;
            let mut ui = Ui::new(ctx.clone(), Id::new("narrow_bar_ui"), rect, Layout::top_down(Align::Min), clip, DrawTarget::Main);

            let bar = Bar::begin(&mut ui, "narrow_bar", BarStyle { height: 40.0, padding_x: 10.0, gap: 6.0, ..Default::default() });

            // Simulate Right zone measuring 100px width
            ctx.memory_mut(|m| m.set_scalar(bar.id.with(BarZone::Right), 100.0));

            let center_ui = bar.zone_ui(&ui, BarZone::Center);
            let right_ui = bar.zone_ui(&ui, BarZone::Right);

            // Right zone starts at 300 - 10 (pad) - 100 = 190. Max x is 290.
            assert_eq!(right_ui.max_rect().min.x, 190.0);

            // Center zone must be capped so it does not exceed right_ui.min.x - gap (190 - 6 = 184)
            assert!(center_ui.max_rect().max.x <= 184.0, "Center zone max_x ({}) must be <= 184 to avoid overlapping Right zone", center_ui.max_rect().max.x);
        });
    }
}

