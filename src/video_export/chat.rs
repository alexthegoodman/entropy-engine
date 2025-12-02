use imgui::{Condition, Ui};

pub struct Chat {
    pub chat_history: Vec<String>,
    // pub input_text: imgui::ImString,
    pub input_text: String,
}

impl Chat {
    pub fn new() -> Self {
        Chat {
            chat_history: Vec::new(),
            // input_text: imgui::ImString::with_capacity(256),
            input_text: "".to_string(),
        }
    }

    pub fn render(&mut self, ui: &Ui) {
        ui.window("Chat")
            .size([500.0, 400.0], Condition::FirstUseEver)
            .build(|| {
                // Display chat history in a scrollable child window
                let chat_height = ui.content_region_avail()[1] - 30.0; // leave space for input
                ui.child_window("History")
                    .size([0.0, chat_height])
                    .border(true)
                    .build(|| {
                        for message in &self.chat_history {
                            ui.text_wrapped(message);
                        }
                    });

                // Input text field
                if ui.input_text("##Input", &mut self.input_text)
                    .enter_returns_true(true)
                    .build()
                {
                    // This block is executed when Enter is pressed
                    if !self.input_text.is_empty() {
                        let message = self.input_text.to_owned();
                        self.chat_history.push(format!("You: {}", message));
                        // Simple echo for now
                        self.chat_history.push(format!("Bot: {}", message));
                        self.input_text.clear();
                    }
                }

                ui.same_line();

                // Send button
                if ui.button("Send") {
                    println!("Try send...");
                    if !self.input_text.is_empty() {
                        let message = self.input_text.to_owned();
                        self.chat_history.push(format!("You: {}", message));
                        // Simple echo for now
                        self.chat_history.push(format!("Bot: {}", message));
                        self.input_text.clear();

                        println!("Chat history length {:?}", self.chat_history.len());
                    }
                }
            });
    }
}
