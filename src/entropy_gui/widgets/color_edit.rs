use crate::entropy_gui::response::Response;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::widgets_color_picker::ColorPicker;

impl Ui {
    pub fn color_edit_button_rgba_unmultiplied(&mut self, rgba: &mut [f32; 4]) -> Response {
        let id = self.next_auto_id("color_edit");
        ColorPicker::new(id).show(self, rgba)
    }
    pub fn color_edit_button_rgba_premultiplied(&mut self, rgba: &mut [f32; 4]) -> Response {
        self.color_edit_button_rgba_unmultiplied(rgba)
    }
}
