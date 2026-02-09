use egui_code_editor::{CodeEditor, ColorTheme, Syntax};
use std::fs;
use std::path::PathBuf;
use egui;

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
        let syntax = if self.language == "javascript" || self.language == "js" {
            Syntax::lua()
        } else {
            Syntax::rust() // fallback
        };

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

            let response = CodeEditor::default()
                .id_source("script_editor")
                .with_syntax(syntax)
                .with_theme(ColorTheme::AYU_DARK)
                .with_numlines(true)
                .show(ui, &mut self.content);

            if response.response.changed() {
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
