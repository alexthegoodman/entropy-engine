use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use reqwest::Client;
use uuid::Uuid;
use crate::helpers::saved_data::SavedState;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(rename = "savedData")]
    pub saved_data: Option<SavedState>,
    #[serde(default)]
    pub sessions: Vec<ChatSession>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatSession {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub r#type: String,
    pub function: ToolCallFunction,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

pub struct Chat {
    pub messages: Vec<ChatMessage>,
    pub current_input: String,
    pub current_session: Option<ChatSession>,
    pub client: Client,
    pub api_url: String,
    pub is_open: bool,
    pub is_loading: bool,
    pub rx: Option<std::sync::mpsc::Receiver<ChatMessage>>,
}

impl Chat {
    pub fn new() -> Self {
        Self {
            messages: Vec::new(),
            current_input: String::new(),
            current_session: None,
            client: Client::new(),
            api_url: "http://localhost:3000".to_string(), // Default, logic to change this later
            is_open: true,
            is_loading: false,
            rx: None,
        }
    }

    pub fn toggle(&mut self) {
        self.is_open = !self.is_open;
    }
}
