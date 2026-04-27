use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::helpers::saved_data::{CharacterStats, ComponentData};
// use crate::game_behaviors::inventory::Inventory;

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct NpcSessionState {
    pub health: f32,
    pub is_dead: bool,
    pub position: [f32; 3],
    // pub inventory: Inventory,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct SessionState {
    pub session_id: String,
    pub last_saved: String,
    pub current_level_id: String,
    
    // Player State
    pub player_stats: CharacterStats,
    // pub player_inventory: Inventory,
    pub player_position: [f32; 3],
    pub player_rotation: [f32; 3],

    // World State
    pub npc_states: HashMap<String, NpcSessionState>, // Component ID -> State
    pub dropped_items: Vec<ComponentData>, // Items currently on the ground
    
    // Quests/Story State
    pub flags: HashMap<String, bool>,
}

impl SessionState {
    pub fn new(session_id: String, level_id: String) -> Self {
        Self {
            session_id,
            current_level_id: level_id,
            player_stats: CharacterStats {
                health: 100.0,
                stamina: 100.0,
            },
            ..Default::default()
        }
    }
}
