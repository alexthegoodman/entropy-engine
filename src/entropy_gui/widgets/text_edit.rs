//! `text_edit_singleline`/`text_edit_multiline` — a functional v1: click-to-focus, typed
//! character insertion, backspace/delete/arrow-nav/home/end, Enter for newline (multiline),
//! a blinking caret. Deliberately NOT yet implemented: precise click-to-place-cursor (a click
//! always focuses and moves the caret to the end of the text), drag-to-select, and real IME
//! composition — those are a documented follow-up (see the plan's "text-edit" risk note).

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align2, StrokeKind};
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::style::DEFAULT_FONT_SIZE;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::FontId;

fn prev_char_boundary(s: &str, i: usize) -> usize {
    if i == 0 {
        return 0;
    }
    let mut j = i - 1;
    while j > 0 && !s.is_char_boundary(j) {
        j -= 1;
    }
    j
}
fn next_char_boundary(s: &str, i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    let mut j = i + 1;
    while j < s.len() && !s.is_char_boundary(j) {
        j += 1;
    }
    j
}
fn last_line(s: &str) -> &str {
    s.rsplit('\n').next().unwrap_or(s)
}

fn text_edit_impl(ui: &mut Ui, text: &mut String, multiline: bool) -> Response {
    let id = ui.next_auto_id("text_edit");
    let font = FontId::proportional(DEFAULT_FONT_SIZE);
    let padding = vec2(6.0, 4.0);
    let width = ui.available_width().max(60.0);
    let height = if multiline { ui.available_size().y.max(60.0) } else { ui.style().spacing.interact_size.y };
    let (rect, response) = ui.allocate_response(vec2(width, height), Sense::click());

    let mut state = ui.ctx().memory(|m| m.get_text_edit(id));
    if response.clicked() {
        ui.ctx().memory_mut(|m| m.focused = Some(id));
        state.cursor = text.len();
        state.selection_anchor = None;
        state.blink_on = true;
        state.blink_timer = 0.0;
    }
    let is_focused = ui.ctx().memory(|m| m.focused) == Some(id);

    let mut changed = false;
    if is_focused {
        let (typed, key_events) = ui.input(|i| (i.text_input.clone(), i.key_events.clone()));
        if !typed.is_empty() {
            state.cursor = state.cursor.min(text.len());
            text.insert_str(state.cursor, &typed);
            state.cursor += typed.len();
            changed = true;
        }
        for ev in key_events {
            if !ev.pressed {
                continue;
            }
            match ev.key {
                Key::Backspace => {
                    if state.cursor > 0 {
                        let prev = prev_char_boundary(text, state.cursor);
                        text.replace_range(prev..state.cursor, "");
                        state.cursor = prev;
                        changed = true;
                    }
                }
                Key::Delete => {
                    if state.cursor < text.len() {
                        let next = next_char_boundary(text, state.cursor);
                        text.replace_range(state.cursor..next, "");
                        changed = true;
                    }
                }
                Key::ArrowLeft => state.cursor = prev_char_boundary(text, state.cursor),
                Key::ArrowRight => state.cursor = next_char_boundary(text, state.cursor),
                Key::Home => state.cursor = 0,
                Key::End => state.cursor = text.len(),
                Key::Enter => {
                    if multiline {
                        text.insert(state.cursor, '\n');
                        state.cursor += 1;
                        changed = true;
                    }
                }
                _ => {}
            }
        }
    }

    let visuals = ui.interactive_visuals(response.hovered(), is_focused);
    let painter = ui.painter();
    painter.rect_filled(rect, visuals.corner_radius, visuals.bg_fill);
    let border = if is_focused { ui.visuals().selection.stroke } else { visuals.bg_stroke };
    painter.rect_stroke(rect, visuals.corner_radius, border, StrokeKind::Middle);

    let text_color = ui.visuals().override_text_color.unwrap_or(Color32::from_gray(220));
    let clipped = painter.with_clip_rect(rect.shrink2(vec2(2.0, 2.0)));
    let line_h = font.size + 4.0;
    if multiline {
        for (i, line) in text.split('\n').enumerate() {
            clipped.text(pos2(rect.min.x + padding.x, rect.min.y + padding.y + i as f32 * line_h), Align2::LEFT_TOP, line, font, text_color);
        }
    } else {
        clipped.text(pos2(rect.min.x + padding.x, rect.center().y), Align2::LEFT_CENTER, text.as_str(), font, text_color);
    }

    if is_focused {
        state.blink_timer += ui.input(|i| i.dt);
        if state.blink_timer > 0.53 {
            state.blink_timer = 0.0;
            state.blink_on = !state.blink_on;
        }
        if state.blink_on {
            let cursor = state.cursor.min(text.len());
            let before_cursor = &text[..cursor];
            let caret_x = rect.min.x + padding.x + Painter::measure_text(ui.ctx(), font, last_line(before_cursor)).x;
            let caret_y0 = if multiline {
                rect.min.y + padding.y + (before_cursor.matches('\n').count() as f32) * line_h
            } else {
                rect.center().y - font.size / 2.0
            };
            clipped.line_segment([pos2(caret_x, caret_y0), pos2(caret_x, caret_y0 + font.size)], Stroke::new(1.5, text_color));
        }
    }

    ui.ctx().memory_mut(|m| m.set_text_edit(id, state));

    let mut response = response;
    if changed {
        response.mark_changed();
    }
    response
}

impl Ui {
    pub fn text_edit_singleline(&mut self, text: &mut String) -> Response {
        text_edit_impl(self, text, false)
    }
    pub fn text_edit_multiline(&mut self, text: &mut String) -> Response {
        text_edit_impl(self, text, true)
    }
}
