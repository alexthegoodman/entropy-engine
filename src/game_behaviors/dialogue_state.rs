use uuid::Uuid;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct DialogueOption {
    pub text: String,
    pub next_node: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DialogueState {
    pub is_open: bool,
    pub current_text: String,
    pub options: Vec<DialogueOption>,
    pub npc_name: String,
    pub current_node: String,
    pub current_npc_id: String,
    pub selected_option_index: usize,
    #[serde(skip)]
    pub ui_ids: Vec<Uuid>,
    #[serde(skip)]
    pub ui_dirty: bool,
}
