//! `entropy_gui` — the in-house immediate-mode GUI kit that replaces `egui` (plus
//! `egui-wgpu`/`egui-winit`/`egui_dock`) as this app's editor UI foundation. Its public
//! surface mirrors egui's closely on purpose; see `src/lib.rs` for the compatibility
//! aliases (`egui`, `egui_wgpu`, `egui_winit`, `egui_dock`) that let the existing call
//! sites keep compiling with minimal changes.

pub mod atlas;
pub mod backend;
pub mod color;
pub mod containers;
pub mod context;
pub mod dock;
pub mod draw_list;
pub mod fonts;
pub mod geometry;
pub mod id;
pub mod memory;
pub mod painter;
pub mod response;
pub mod shape;
pub mod style;
pub mod text_layout;
pub mod ui;
pub mod widgets;
pub mod widgets_code_editor;
pub mod widgets_node_graph;

pub use color::{Color32, Shadow, Stroke};
pub use containers::context_menu::context_menu;
pub use containers::panel::{CentralPanel, Frame, SidePanel, TopBottomPanel};
pub use containers::window::Window;
pub use context::{
    Context, FullOutput, Key, KeyEvent, Modifiers, PlatformOutput, RawInput, TexturesDelta, ViewportId,
};
pub use draw_list::{DrawCommand, DrawTexture, TextureId};
pub use geometry::{
    pos2, vec2, Align, Align2, CornerRadius, CursorIcon, Direction, FontFamily, FontId, Layout, Margin, Pos2, Rect,
    StrokeKind, Vec2,
};
pub use id::{Id, IdMap};
pub use painter::Painter;
pub use response::{Response, Sense};
pub use shape::Shape;
pub use style::{Selection, Style, Visuals, WidgetVisuals, Widgets};
pub use ui::{InnerResponse, Ui};
pub use context::InputState;
pub use widgets::{Button, CollapsingHeader, ComboBox, DragValue, ScrollArea, Slider};

/// Rich-text is a thin `String` wrapper in this simplified kit — enough to support
/// `.strong()`/`.italics()`/`.color()` chaining, and converts into a plain label like egui's
/// `WidgetText` does.
#[derive(Clone, Debug)]
pub struct RichText {
    pub text: String,
    pub strong: bool,
    pub italics: bool,
    pub color: Option<Color32>,
}

impl RichText {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into(), strong: false, italics: false, color: None }
    }
    pub fn strong(mut self) -> Self {
        self.strong = true;
        self
    }
    pub fn italics(mut self) -> Self {
        self.italics = true;
        self
    }
    pub fn color(mut self, c: Color32) -> Self {
        self.color = Some(c);
        self
    }
}

impl From<&str> for RichText {
    fn from(s: &str) -> Self {
        RichText::new(s)
    }
}
impl From<String> for RichText {
    fn from(s: String) -> Self {
        RichText::new(s)
    }
}
impl From<&String> for RichText {
    fn from(s: &String) -> Self {
        RichText::new(s.clone())
    }
}

/// `WidgetText` — anything that can be used as a label. This app never uses egui's richer
/// per-span text runs, only plain strings and `RichText`.
#[derive(Clone, Debug)]
pub struct WidgetText(pub RichText);

impl From<&str> for WidgetText {
    fn from(s: &str) -> Self {
        WidgetText(RichText::new(s))
    }
}
impl From<String> for WidgetText {
    fn from(s: String) -> Self {
        WidgetText(RichText::new(s))
    }
}
impl From<&String> for WidgetText {
    fn from(s: &String) -> Self {
        WidgetText(RichText::new(s.clone()))
    }
}
impl From<RichText> for WidgetText {
    fn from(r: RichText) -> Self {
        WidgetText(r)
    }
}
impl From<&WidgetText> for WidgetText {
    fn from(w: &WidgetText) -> Self {
        w.clone()
    }
}

pub mod epaint {
    pub use crate::entropy_gui::color::Shadow;
}
