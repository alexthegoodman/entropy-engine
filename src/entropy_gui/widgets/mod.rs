//! Standard widgets. Most are added as inherent `impl Ui` methods (spread across the files
//! in this module) so call sites keep the exact `ui.button(...)`/`ui.label(...)` shape egui
//! uses; a small `Widget` trait backs `ui.add(widget)` for the handful of builder-style
//! widgets (`Slider`, `DragValue`) the catalog constructs explicitly.

use crate::entropy_gui::response::Response;
use crate::entropy_gui::ui::Ui;

pub trait Widget {
    fn ui(self, ui: &mut Ui) -> Response;
}

impl Ui {
    pub fn add(&mut self, widget: impl Widget) -> Response {
        widget.ui(self)
    }
}

pub mod button;
pub mod checkbox;
pub mod collapsing_header;
pub mod color_edit;
pub mod combo_box;
pub mod drag_value;
pub mod hyperlink;
pub mod label;
pub mod scroll_area;
pub mod selectable;
pub mod separator;
pub mod slider;
pub mod text_edit;

pub use button::Button;
pub use collapsing_header::CollapsingHeader;
pub use combo_box::ComboBox;
pub use drag_value::DragValue;
pub use scroll_area::ScrollArea;
pub use slider::{Slider, SliderNumeric};
