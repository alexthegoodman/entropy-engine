use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum QuestStatus {
    NotStarted,
    InProgress,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuestStep {
    pub id: String,
    pub description: String,
    pub is_completed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Quest {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: QuestStatus,
    pub steps: Vec<QuestStep>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct QuestState {
    pub quests: HashMap<String, Quest>,
    pub active_quest_id: Option<String>, // Tracking the currently "tracked" quest
    pub is_open: bool, // For UI visibility
}

impl QuestState {
    pub fn new() -> Self {
        let mut quests = HashMap::new();
        
        // Add a test quest
        let test_quest = Quest {
            id: "storm_quest".to_string(),
            title: "Investigate the Storm".to_string(),
            description: "The winds are restless. Find out why.".to_string(),
            status: QuestStatus::NotStarted,
            steps: vec![
                QuestStep {
                    id: "talk_to_elder".to_string(),
                    description: "Talk to the Elder on the hill.".to_string(),
                    is_completed: false,
                },
                QuestStep {
                    id: "find_source".to_string(),
                    description: "Locate the source of the storm.".to_string(),
                    is_completed: false,
                },
            ],
        };
        quests.insert(test_quest.id.clone(), test_quest);

        Self {
            quests,
            active_quest_id: None,
            is_open: false,
        }
    }

    pub fn add_quest(&mut self, quest: Quest) {
        self.quests.insert(quest.id.clone(), quest);
    }

    pub fn start_quest(&mut self, quest_id: &str) {
        if let Some(quest) = self.quests.get_mut(quest_id) {
            if quest.status == QuestStatus::NotStarted {
                 quest.status = QuestStatus::InProgress;
            }
            // Auto-track the started quest
            self.active_quest_id = Some(quest_id.to_string());
        }
    }
    
    pub fn complete_step(&mut self, quest_id: &str, step_id: &str) {
        if let Some(quest) = self.quests.get_mut(quest_id) {
            if let Some(step) = quest.steps.iter_mut().find(|s| s.id == step_id) {
                step.is_completed = true;
                
                // Check if all steps are completed
                 if quest.steps.iter().all(|s| s.is_completed) {
                    quest.status = QuestStatus::Completed;
                }
            }
        }
    }

    pub fn get_quest_status(&self, quest_id: &str) -> QuestStatus {
        if let Some(quest) = self.quests.get(quest_id) {
            quest.status.clone()
        } else {
            QuestStatus::NotStarted
        }
    }
}
