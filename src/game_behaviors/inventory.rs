use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{helpers::saved_data::{CollectableType, ComponentData}, model_components::Collectable::Collectable};

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Inventory {
    pub items: Vec<ComponentData>,
    pub equipped_weapon: Option<ComponentData>,
    pub equipped_armor: Option<ComponentData>,
}

impl Inventory {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            equipped_weapon: None,
            equipped_armor: None,
        }
    }

    pub fn add_item(&mut self, item: &ComponentData) {
        self.items.push(item.clone());
    }

    pub fn equip_weapon(&mut self, item_to_equip: &ComponentData) {
        if let Some(item_index) = self.items.iter().position(|comp: &ComponentData| *comp.id == item_to_equip.id) {
            // Unequip current weapon if any
            if let Some(equipped_item) = self.equipped_weapon.take() {
                self.items.push(equipped_item);
            }
            self.equipped_weapon = Some(self.items.remove(item_index));
        }
    }

    pub fn equip_armor(&mut self, item_to_equip: &ComponentData) {
        if let Some(item_index) = self.items.iter().position(|comp: &ComponentData| *comp.id == item_to_equip.id) {
            // Unequip current armor if any
            if let Some(equipped_item) = self.equipped_armor.take() {
                self.items.push(equipped_item);
            }
            self.equipped_armor = Some(self.items.remove(item_index));
        }
    }
}
