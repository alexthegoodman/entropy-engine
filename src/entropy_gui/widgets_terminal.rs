//! `TerminalView` - a high-performance terminal display widget with virtual scrolling,
//! custom non-monospace font rendering from the ~60-font catalog, color-coded lines,
//! command badges, timestamps, auto-scrolling, and interactive controls.

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::geometry::{pos2, vec2, Align2, CornerRadius, FontId, Rect, StrokeKind};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::Ui;

#[derive(Clone, Debug, PartialEq)]
pub enum TerminalLineKind {
    Command,
    Stdout,
    Stderr,
    System,
    Success,
    Error,
}

impl Default for TerminalLineKind {
    fn default() -> Self {
        Self::Stdout
    }
}

impl TerminalLineKind {
    pub fn from_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "command" | "input" | "cmd" => Self::Command,
            "stderr" | "warn" | "warning" => Self::Stderr,
            "system" | "info" => Self::System,
            "success" | "ok" => Self::Success,
            "error" | "err" | "fail" => Self::Error,
            _ => Self::Stdout,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TerminalLine {
    pub id: u64,
    pub kind: TerminalLineKind,
    pub text: String,
    pub timestamp: String,
}

impl TerminalLine {
    pub fn new(id: u64, kind: TerminalLineKind, text: impl Into<String>, timestamp: impl Into<String>) -> Self {
        Self {
            id,
            kind,
            text: text.into(),
            timestamp: timestamp.into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct TerminalTheme {
    pub bg_color: Color32,
    pub border_color: Color32,
    pub prompt_color: Color32,
    pub command_color: Color32,
    pub stdout_color: Color32,
    pub stderr_color: Color32,
    pub system_color: Color32,
    pub success_color: Color32,
    pub error_color: Color32,
    pub timestamp_color: Color32,
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
            prompt_color: Color32::from_rgb(0, 240, 200),
            command_color: Color32::from_rgb(255, 255, 255),
            stdout_color: Color32::from_rgb(220, 226, 240),
            stderr_color: Color32::from_rgb(255, 120, 130),
            system_color: Color32::from_rgb(90, 190, 255),
            success_color: Color32::from_rgb(80, 235, 130),
            error_color: Color32::from_rgb(255, 80, 95),
            timestamp_color: Color32::from_gray(105),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(0, 240, 200, 110),
        }
    }

    pub fn obsidian() -> Self {
        Self {
            bg_color: Color32::from_rgb(18, 19, 23),
            border_color: Color32::from_rgba_unmultiplied(255, 255, 255, 25),
            prompt_color: Color32::from_rgb(130, 220, 110),
            command_color: Color32::from_rgb(250, 250, 250),
            stdout_color: Color32::from_rgb(215, 220, 225),
            stderr_color: Color32::from_rgb(255, 140, 120),
            system_color: Color32::from_rgb(140, 175, 255),
            success_color: Color32::from_rgb(110, 230, 140),
            error_color: Color32::from_rgb(255, 100, 100),
            timestamp_color: Color32::from_gray(100),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(255, 255, 255, 60),
        }
    }

    pub fn violet() -> Self {
        Self {
            bg_color: Color32::from_rgb(18, 14, 28),
            border_color: Color32::from_rgba_unmultiplied(190, 130, 255, 45),
            prompt_color: Color32::from_rgb(210, 140, 255),
            command_color: Color32::from_rgb(255, 255, 255),
            stdout_color: Color32::from_rgb(230, 225, 245),
            stderr_color: Color32::from_rgb(255, 135, 160),
            system_color: Color32::from_rgb(160, 200, 255),
            success_color: Color32::from_rgb(120, 235, 180),
            error_color: Color32::from_rgb(255, 95, 125),
            timestamp_color: Color32::from_gray(115),
            scrollbar_thumb: Color32::from_rgba_unmultiplied(200, 140, 255, 100),
        }
    }

    pub fn amber() -> Self {
        Self {
            bg_color: Color32::from_rgb(20, 16, 10),
            border_color: Color32::from_rgba_unmultiplied(255, 180, 50, 45),
            prompt_color: Color32::from_rgb(255, 190, 40),
            command_color: Color32::from_rgb(255, 240, 200),
            stdout_color: Color32::from_rgb(255, 215, 150),
            stderr_color: Color32::from_rgb(255, 100, 70),
            system_color: Color32::from_rgb(255, 210, 100),
            success_color: Color32::from_rgb(160, 230, 100),
            error_color: Color32::from_rgb(255, 90, 60),
            timestamp_color: Color32::from_rgb(160, 130, 80),
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
    lines: &'a [TerminalLine],
    font_family: String,
    font_size: f32,
    is_running: bool,
    theme: TerminalTheme,
    height: Option<f32>,
    auto_scroll: bool,
}

impl<'a> TerminalView<'a> {
    pub fn new(id: &'a str, lines: &'a [TerminalLine]) -> Self {
        Self {
            id,
            lines,
            font_family: "Quicksand".to_string(),
            font_size: 13.5,
            is_running: false,
            theme: TerminalTheme::neon(),
            height: None,
            auto_scroll: true,
        }
    }

    pub fn font_family(mut self, family: impl Into<String>) -> Self {
        self.font_family = family.into();
        self
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

        // Line metrics in the selected font
        let font_id = FontId::named(&self.font_family, self.font_size);
        let timestamp_font = FontId::named(&self.font_family, (self.font_size - 2.5).max(9.0));
        let line_h = (self.font_size * 1.45).max(18.0);

        let total_lines = self.lines.len().max(1);
        let content_h = (total_lines as f32 * line_h) + 24.0;
        let view_h = rect.height() - 16.0;
        let max_scroll = (content_h - view_h).max(0.0);

        // Scroll state from Memory
        let (mut scroll_y, mut user_wants_autoscroll) = ui.ctx().memory(|m| {
            m.get_timeline_view(widget_id) // reuse (f32, f32) storage
        });

        // Mouse wheel scroll handling
        let (scroll_delta, is_hovered) = ui.input(|i| (i.scroll_delta.y, response.hovered));
        if is_hovered && scroll_delta.abs() > 0.0 {
            if scroll_delta > 0.0 {
                // User scrolled up: pause auto-scroll
                user_wants_autoscroll = 0.0;
            }
            scroll_y -= scroll_delta * 1.5;
        }

        // Auto-scroll logic: if enabled and engaged, snap to bottom on new output
        if self.auto_scroll && (user_wants_autoscroll > 0.5 || scroll_y >= max_scroll - 15.0) {
            scroll_y = max_scroll;
            user_wants_autoscroll = 1.0;
        }

        scroll_y = scroll_y.clamp(0.0, max_scroll);
        ui.ctx().memory_mut(|m| {
            m.set_timeline_view(widget_id, scroll_y, user_wants_autoscroll);
        });

        let painter = ui.painter();

        // Background container with rounded corners and subtle border
        painter.rect_filled(rect, CornerRadius::same(8), self.theme.bg_color);
        painter.rect_stroke(rect, CornerRadius::same(8), Stroke::new(1.0, self.theme.border_color), StrokeKind::Inside);

        // Inner drawing area with inset padding
        let inner_rect = rect.shrink(10.0);
        let inner_painter = painter.with_clip_rect(inner_rect);

        if self.lines.is_empty() {
            // Welcome empty state
            let welcome_font = FontId::named(&self.font_family, self.font_size + 1.0);
            let sub_font = FontId::named(&self.font_family, self.font_size);
            inner_painter.text(pos2(inner_rect.min.x + 8.0, inner_rect.min.y + 14.0), Align2::LEFT_TOP, "Entropy Terminal - Ready", welcome_font, self.theme.prompt_color);
            inner_painter.text(
                pos2(inner_rect.min.x + 8.0, inner_rect.min.y + 36.0),
                Align2::LEFT_TOP,
                "Type a command below or click a convenience button above (Connect MCP, Install CLI, etc.)",
                sub_font,
                Color32::from_gray(140),
            );
        } else {
            // Virtualized rendering: only render visible lines!
            let start_idx = ((scroll_y / line_h).floor() as usize).min(self.lines.len());
            let visible_count = ((view_h / line_h).ceil() as usize) + 2;
            let end_idx = (start_idx + visible_count).min(self.lines.len());

            let text_start_x = inner_rect.min.x + 4.0;
            let max_text_w = inner_rect.width() - 80.0;

            for idx in start_idx..end_idx {
                let line = &self.lines[idx];
                let line_y = inner_rect.min.y + (idx as f32 * line_h) - scroll_y;

                if line_y + line_h < inner_rect.min.y || line_y > inner_rect.max.y {
                    continue;
                }

                // Render line based on its kind
                match line.kind {
                    TerminalLineKind::Command => {
                        // Prompt symbol in glowing accent
                        inner_painter.text(pos2(text_start_x, line_y), Align2::LEFT_TOP, "❯", font_id, self.theme.prompt_color);
                        // Command text
                        inner_painter.text(pos2(text_start_x + 18.0, line_y), Align2::LEFT_TOP, &line.text, font_id, self.theme.command_color);
                        // Timestamp right aligned
                        if !line.timestamp.is_empty() {
                            inner_painter.text(pos2(inner_rect.max.x - 4.0, line_y + 2.0), Align2::RIGHT_TOP, &line.timestamp, timestamp_font, self.theme.timestamp_color);
                        }
                    }
                    TerminalLineKind::Stdout => {
                        inner_painter.text(pos2(text_start_x + 8.0, line_y), Align2::LEFT_TOP, &line.text, font_id, self.theme.stdout_color);
                    }
                    TerminalLineKind::Stderr => {
                        inner_painter.text(pos2(text_start_x + 8.0, line_y), Align2::LEFT_TOP, &line.text, font_id, self.theme.stderr_color);
                    }
                    TerminalLineKind::System => {
                        inner_painter.text(pos2(text_start_x, line_y), Align2::LEFT_TOP, "ℹ", font_id, self.theme.system_color);
                        inner_painter.text(pos2(text_start_x + 16.0, line_y), Align2::LEFT_TOP, &line.text, font_id, self.theme.system_color);
                    }
                    TerminalLineKind::Success => {
                        inner_painter.text(pos2(text_start_x, line_y), Align2::LEFT_TOP, "✓", font_id, self.theme.success_color);
                        inner_painter.text(pos2(text_start_x + 16.0, line_y), Align2::LEFT_TOP, &line.text, font_id, self.theme.success_color);
                        if !line.timestamp.is_empty() {
                            inner_painter.text(pos2(inner_rect.max.x - 4.0, line_y + 2.0), Align2::RIGHT_TOP, &line.timestamp, timestamp_font, self.theme.timestamp_color);
                        }
                    }
                    TerminalLineKind::Error => {
                        inner_painter.text(pos2(text_start_x, line_y), Align2::LEFT_TOP, "✗", font_id, self.theme.error_color);
                        inner_painter.text(pos2(text_start_x + 16.0, line_y), Align2::LEFT_TOP, &line.text, font_id, self.theme.error_color);
                        if !line.timestamp.is_empty() {
                            inner_painter.text(pos2(inner_rect.max.x - 4.0, line_y + 2.0), Align2::RIGHT_TOP, &line.timestamp, timestamp_font, self.theme.timestamp_color);
                        }
                    }
                }
            }
        }

        // Running process status footer
        if self.is_running {
            let footer_rect = Rect::from_min_max(pos2(rect.min.x + 8.0, rect.max.y - 24.0), pos2(rect.max.x - 8.0, rect.max.y - 4.0));
            painter.rect_filled(footer_rect, CornerRadius::same(4), Color32::from_rgba_unmultiplied(0, 0, 0, 180));
            let pulse_font = FontId::named(&self.font_family, (self.font_size - 1.5).max(10.0));
            painter.text(pos2(footer_rect.min.x + 8.0, footer_rect.center().y), Align2::LEFT_CENTER, "● Running command in background...", pulse_font, self.theme.prompt_color);
        }

        // Scrollbar
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
