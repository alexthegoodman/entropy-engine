use std::fs;
use std::path::PathBuf;
use crate::egui;

pub struct ScriptEditor {
    pub path: PathBuf,
    pub content: String,
    pub language: String,
    pub is_dirty: bool,
}

impl ScriptEditor {
    pub fn new(path: PathBuf) -> Self {
        let content = fs::read_to_string(&path).unwrap_or_default();
        let language = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("javascript")
            .to_string();

        Self {
            path,
            content,
            language,
            is_dirty: false,
        }
    }

    pub fn show(&mut self, ui: &mut egui::Ui) {
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                ui.label(format!("Editing: {:?}", self.path));
                if self.is_dirty {
                    ui.label(egui::RichText::new("(Modified)").color(egui::Color32::YELLOW));
                }
                if ui.button("Save").clicked() {
                    self.save();
                }
            });

            ui.separator();

            // Plain multiline edit + line-number gutter, no syntax highlighting yet — see
            // src/entropy_gui/widgets_code_editor.rs for why (this replaces egui_code_editor).
            let response = crate::entropy_gui::widgets_code_editor::code_editor(ui, &mut self.content);

            if response.changed() {
                self.is_dirty = true;
            }
        });
    }

    pub fn save(&mut self) {
        if let Err(e) = fs::write(&self.path, &self.content) {
            println!("Failed to save script: {}", e);
        } else {
            self.is_dirty = false;
            println!("Script saved: {:?}", self.path);
        }
    }
}
