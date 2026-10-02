//! `TerminalView` - a real terminal display widget. It draws a `TerminalScreen` (a grid of
//! styled runs produced by the `vt100` parser in `terminal_ops`) in the engine's monospace face
//! (Cascadia Mono / Consolas / DejaVu Sans Mono), so interactive TUI programs like Claude Code or
//! Codex render correctly with colour and cursor positioning.

use serde::{Deserialize, Serialize};

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, CornerRadius, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;

/// One run of same-styled characters on a terminal row. Consecutive cells with the same
/// foreground/background and attributes are merged into a single run when the screen is read.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRun {
    pub text: String,
    /// `None` means the terminal theme's default foreground.
    pub fg: Option<[u8; 3]>,
    /// `None` means the terminal theme's default background.
    pub bg: Option<[u8; 3]>,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub reverse: bool,
}

impl TerminalRun {
    pub fn plain(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            fg: None,
            bg: None,
            bold: false,
            italic: false,
            underline: false,
            reverse: false,
        }
    }
}

/// The rendered terminal state as a grid of runs (the visible screen).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScreen {
    pub rows: u16,
    pub cols: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub lines: Vec<Vec<TerminalRun>>,
}

impl TerminalScreen {
    pub fn empty(rows: u16, cols: u16) -> Self {
        Self {
            rows,
            cols,
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: false,
            lines: vec![Vec::new(); rows as usize],
        }
    }
}

#[derive(Clone, Debug)]
pub struct TerminalTheme {
    pub bg_color: Color32,
    pub border_color: Color32,
    pub cursor_color: Color32,
    pub default_fg: Color32,
    pub scrollbar_thumb: Color32,
}

impl Default for TerminalTheme {
    fn default() -> Self {
        Self::neon()
    }
}

impl TerminalTheme {
    pub fn neon() -> Self {
        Self {
            bg_color: Color32::from_rgb(12, 16, 24),
            border_color: Color32::from_rgba_unmultiplied(0, 230, 200, 45),
            cursor_color: Color32::from_rgb(0, 240, 200),
            default_fg: Color32::from_rgb(220, 226, 240),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(0, 240, 200, 110),
        }
    }

    pub fn obsidian() -> Self {
        Self {
            bg_color: Color32::from_rgb(18, 19, 23),
            border_color: Color32::from_rgba_unmultiplied(255, 255, 255, 25),
            cursor_color: Color32::from_rgb(130, 220, 110),
            default_fg: Color32::from_rgb(215, 220, 225),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(255, 255, 255, 60),
        }
    }

    pub fn violet() -> Self {
        Self {
            bg_color: Color32::from_rgb(18, 14, 28),
            border_color: Color32::from_rgba_unmultiplied(190, 130, 255, 45),
            cursor_color: Color32::from_rgb(210, 140, 255),
            default_fg: Color32::from_rgb(230, 225, 245),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(200, 140, 255, 100),
        }
    }

    pub fn amber() -> Self {
        Self {
            bg_color: Color32::from_rgb(20, 16, 10),
            border_color: Color32::from_rgba_unmultiplied(255, 180, 50, 45),
            cursor_color: Color32::from_rgb(255, 190, 40),
            default_fg: Color32::from_rgb(255, 215, 150),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(255, 190, 50, 100),
        }
    }

    pub fn from_name(name: &str) -> Self {
        match name.to_ascii_lowercase().as_str() {
            "obsidian" | "dark" => Self::obsidian(),
            "violet" | "purple" => Self::violet(),
            "amber" | "retro" => Self::amber(),
            _ => Self::neon(),
        }
    }
}

pub struct TerminalView<'a> {
    id: &'a str,
    screen: &'a TerminalScreen,
    font_size: f32,
    is_running: bool,
    theme: TerminalTheme,
    height: Option<f32>,
    auto_scroll: bool,
}

impl<'a> TerminalView<'a> {
    pub fn new(id: &'a str, screen: &'a TerminalScreen) -> Self {
        Self {
            id,
            screen,
            font_size: 13.5,
            is_running: false,
            theme: TerminalTheme::neon(),
            height: None,
            auto_scroll: true,
        }
    }

    pub fn font_size(mut self, size: f32) -> Self {
        self.font_size = size.clamp(9.0, 28.0);
        self
    }

    pub fn is_running(mut self, running: bool) -> Self {
        self.is_running = running;
        self
    }

    pub fn theme(mut self, theme: TerminalTheme) -> Self {
        self.theme = theme;
        self
    }

    pub fn height(mut self, h: f32) -> Self {
        self.height = Some(h);
        self
    }

    pub fn auto_scroll(mut self, auto: bool) -> Self {
        self.auto_scroll = auto;
        self
    }

    pub fn show(self, ui: &mut Ui) -> Response {
        let available = ui.available_rect_before_wrap();
        let target_h = self.height.unwrap_or_else(|| (available.height() - 8.0).max(160.0));
        let size = vec2(available.width(), target_h);

        let (rect, response) = ui.allocate_response(size, Sense::click_and_drag());
        let widget_id = Id::new(self.id).with("term_view");

        let font = FontId::monospace(self.font_size);
        let cell_w = Painter::measure_text(ui.ctx(), font, " ").x.max(4.0);
        let line_h = (self.font_size * 1.25).max(cell_w);

        let rows = self.screen.rows as usize;
        let content_h = (rows as f32 * line_h) + 24.0;
        let view_h = rect.height() - 16.0;
        let max_scroll = (content_h - view_h).max(0.0);

        // Scroll state from Memory, shared with the old line-based view.
        let (mut scroll_y, mut user_wants_autoscroll) = ui.ctx().memory(|m| {
            m.get_timeline_view(widget_id)
        });

        let (scroll_delta, is_hovered) = ui.input(|i| (i.scroll_delta.y, response.hovered));
        if is_hovered && scroll_delta.abs() > 0.0 {
            if scroll_delta > 0.0 {
                user_wants_autoscroll = 0.0;
            }
            scroll_y -= scroll_delta * 1.5;
        }

        if self.auto_scroll && (user_wants_autoscroll > 0.5 || scroll_y >= max_scroll - 15.0) {
            scroll_y = max_scroll;
            user_wants_autoscroll = 1.0;
        }

        scroll_y = scroll_y.clamp(0.0, max_scroll);
        ui.ctx().memory_mut(|m| {
            m.set_timeline_view(widget_id, scroll_y, user_wants_autoscroll);
        });

        let painter = ui.painter();

        painter.rect_filled(rect, CornerRadius::same(8), self.theme.bg_color);
        painter.rect_stroke(rect, CornerRadius::same(8), Stroke::new(1.0, self.theme.border_color), StrokeKind::Inside);

        let inner_rect = rect.shrink(10.0);
        let inner_painter = painter.with_clip_rect(inner_rect);

        if self.screen.lines.iter().all(|l| l.is_empty()) {
            let welcome = FontId::named("Quicksand", self.font_size + 1.0);
            inner_painter.text(pos2(inner_rect.min.x + 8.0, inner_rect.min.y + 14.0), Align2::LEFT_TOP, "Entropy Terminal - Ready", welcome, self.theme.cursor_color);
            inner_painter.text(
                pos2(inner_rect.min.x + 8.0, inner_rect.min.y + 36.0),
                Align2::LEFT_TOP,
                "Type a command below or click a quick action. Interactive programs like claude and codex run here.",
                FontId::named("Quicksand", self.font_size),
                Color32::from_gray(140),
            );
        } else {
            // Virtualized: only draw the rows currently in view.
            let start_row = ((scroll_y / line_h).floor() as usize).min(rows);
            let visible = ((view_h / line_h).ceil() as usize) + 2;
            let end_row = (start_row + visible).min(rows);

            let text_start_x = inner_rect.min.x + 4.0;

            for row in start_row..end_row {
                let line_y = inner_rect.min.y + (row as f32 * line_h) - scroll_y;
                if line_y + line_h < inner_rect.min.y || line_y > inner_rect.max.y {
                    continue;
                }

                let mut col: usize = 0;
                if let Some(runs) = self.screen.lines.get(row) {
                    for run in runs {
                        let run_w = run.text.chars().count() as f32 * cell_w;
                        let x = text_start_x + col as f32 * cell_w;

                        let mut fg = run.fg.map(|c| Color32::from_rgb(c[0], c[1], c[2])).unwrap_or(self.theme.default_fg);
                        let mut bg = run.bg.map(|c| Color32::from_rgb(c[0], c[1], c[2]));
                        if run.reverse {
                            let old_fg = fg;
                            fg = bg.unwrap_or(self.theme.bg_color);
                            bg = Some(old_fg);
                        }

                        if let Some(bg_color) = bg {
                            inner_painter.rect_filled(
                                Rect::from_min_size(pos2(x, line_y), vec2(run_w, line_h)),
                                CornerRadius(0),
                                bg_color,
                            );
                        }

                        if !run.text.is_empty() {
                            inner_painter.text(pos2(x, line_y), Align2::LEFT_TOP, &run.text, font, fg);
                        }

                        col += run.text.chars().count();
                    }
                }
            }
        }

        // Cursor (block) while a program is running and the cursor is visible.
        if self.is_running && self.screen.cursor_visible {
            let (crow, ccol) = (self.screen.cursor_row as usize, self.screen.cursor_col as usize);
            if crow < rows {
                let cx = inner_rect.min.x + 4.0 + ccol as f32 * cell_w;
                let cy = inner_rect.min.y + crow as f32 * line_h - scroll_y;
                if cy >= inner_rect.min.y && cy <= inner_rect.max.y {
                    painter.rect_filled(
                        Rect::from_min_size(pos2(cx, cy), vec2(cell_w, line_h)),
                        CornerRadius(0),
                        self.theme.cursor_color,
                    );
                }
            }
        }

        // Running status footer.
        if self.is_running {
            let footer_rect = Rect::from_min_max(pos2(rect.min.x + 8.0, rect.max.y - 24.0), pos2(rect.max.x - 8.0, rect.max.y - 4.0));
            painter.rect_filled(footer_rect, CornerRadius::same(4), Color32::from_rgba_unmultiplied(0, 0, 0, 180));
            let pulse_font = FontId::named("Quicksand", (self.font_size - 1.5).max(10.0));
            painter.text(pos2(footer_rect.min.x + 8.0, footer_rect.center().y), Align2::LEFT_CENTER, "● Running - type a command above and press Send", pulse_font, self.theme.cursor_color);
        }

        // Scrollbar.
        if max_scroll > 0.0 {
            let track_w = 4.0;
            let track_rect = Rect::from_min_max(
                pos2(rect.max.x - track_w - 4.0, rect.min.y + 8.0),
                pos2(rect.max.x - 4.0, rect.max.y - 8.0),
            );
            let track_h = track_rect.height();
            let thumb_h = (track_h * (view_h / content_h)).max(20.0);
            let thumb_y = track_rect.min.y + ((track_h - thumb_h) * (scroll_y / max_scroll));
            let thumb_rect = Rect::from_min_size(pos2(track_rect.min.x, thumb_y), vec2(track_w, thumb_h));

            painter.rect_filled(track_rect, CornerRadius::same(2), Color32::from_rgba_unmultiplied(255, 255, 255, 8));
            painter.rect_filled(thumb_rect, CornerRadius::same(2), self.theme.scrollbar_thumb);
        }

        response
    }
}
