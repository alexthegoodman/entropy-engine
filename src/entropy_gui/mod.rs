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
pub mod icon_table;
pub mod icons;
pub mod id;
pub mod memory;
pub mod painter;
pub mod response;
pub mod shape;
pub mod style;
pub mod text_layout;
pub mod ui;
pub mod widgets;
pub mod widgets_analysis;
pub mod widgets_code_editor;
pub mod widgets_color_picker;
pub mod widgets_doc_editor;
pub mod widgets_kanban;
pub mod widgets_brass;
pub mod widgets_physmod;
pub mod widgets_keyframe_timeline;
pub mod widgets_node_graph;
pub mod widgets_pads;
pub mod widgets_sheet;
pub mod widgets_tabs;
pub mod widgets_tracks;
pub mod widgets_tree;
pub mod widgets_wavetable;

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
pub use style::{Selection, Style, ThemeDescriptor, Visuals, WidgetVisuals, Widgets, slate_style, style_from_theme};
pub use ui::{InnerResponse, Ui};
pub use context::InputState;
pub use widgets::{Button, CollapsingHeader, ComboBox, DragValue, Knob, ScrollArea, Slider};
pub use widgets_analysis::{LevelMeter, MeterOptions, MeterReading, MeterResponse, Oscilloscope, ScopeMode, ScopeOptions, ScopeResponse, SpectrumHover, SpectrumOptions, SpectrumResponse, SpectrumStyle, SpectrumView};
pub use widgets_color_picker::ColorPicker;
pub use widgets_doc_editor::{DocEditor, DocEditorCommand, DocEditorResponse, DocEditorState, PageConfig, PageEntry, PageLayout};
pub use widgets_kanban::{KanbanBoard, KanbanCard, KanbanColumn, KanbanEvent, KanbanResponse};
pub use widgets_keyframe_timeline::{Keyframe, KeyframeRow, KeyframeTimeline, KeyframeTimelineEvent, KeyframeTimelineResponse};
pub use widgets_node_graph::{GraphLink, GraphNode, GraphPin, NodeGraphEditor, NodeGraphEvent, NodeGraphResponse};
pub use widgets_pads::{Pad, PadEvent, PadGrid, PadGridOptions, PadGridResponse, PadKind};
pub use widgets_sheet::{col_letters, SheetCell, SheetEdit, SheetEvent, SheetGrid, SheetGridOptions, SheetResponse};
pub use widgets_tabs::{layout_tabs, Tab, TabBar, TabBarEvent, TabBarResponse, TabSlot};
pub use widgets_tracks::{MiniNote, Track, TrackClip, TrackView, TrackViewEvent, TrackViewOptions, TrackViewResponse};
pub use widgets_tree::{TreeEvent, TreeNode, TreeResponse, TreeView};
pub use widgets_wavetable::{Camera as WavetableCamera, ViewTool, WavetableEvent, WavetableOptions, WavetableResponse, WavetableView};
pub use widgets_brass::{BrassView, BrassViewEvent, BrassViewOptions, BrassViewResponse, Camera as BrassCamera};
pub use widgets_physmod::{Camera as PhysModCamera, PhysModEvent, PhysModOptions, PhysModResponse, PhysModView};

/// Rich-text is a thin `String` wrapper in this simplified kit — enough to support
/// `.strong()`/`.italics()`/`.color()` chaining, and converts into a plain label like egui's
/// `WidgetText` does.
#[derive(Clone, Debug)]
pub struct RichText {
    pub text: String,
    pub strong: bool,
    pub italics: bool,
    pub color: Option<Color32>,
    /// Overrides the widget's default font size (e.g. a big Phosphor glyph on an icon-only
    /// launcher tile). `None` keeps whatever the drawing widget would otherwise use.
    pub font_size: Option<f32>,
    /// Multiplies the drawn color's alpha - `1.0` is fully opaque. Lets a caller fade a label or
    /// button in/out frame by frame (its own animation timer drives this every frame; there is no
    /// engine-side tweening) without needing a whole separate "ghost" draw path.
    pub alpha: f32,
}

impl RichText {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into(), strong: false, italics: false, color: None, font_size: None, alpha: 1.0 }
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
    pub fn font_size(mut self, size: f32) -> Self {
        self.font_size = Some(size);
        self
    }
    pub fn alpha(mut self, a: f32) -> Self {
        self.alpha = a.clamp(0.0, 1.0);
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
