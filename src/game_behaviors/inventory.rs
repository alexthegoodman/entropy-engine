use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{helpers::saved_data::CollectableType, model_components::Collectable::Collectable};

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Inventory {
    pub items: Vec<String>,
    pub equipped_weapon: Option<String>,
    pub equipped_armor: Option<String>,
}

impl Inventory {
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            equipped_weapon: None,
            equipped_armor: None,
        }
    }

    pub fn add_item(&mut self, item_id: String) {
        self.items.push(item_id);
    }

    pub fn equip_weapon(&mut self, item_id_to_equip: String, all_collectables: &Vec<Collectable>) {
        if let Some(item_index) = self.items.iter().position(|id| *id == item_id_to_equip) {
            if let Some(collectable) = all_collectables.iter().find(|c| c.id == item_id_to_equip) {
                if CollectableType::MeleeWeapon == collectable.collectable_type || CollectableType::RangedWeapon == collectable.collectable_type {
                    // Unequip current weapon if any
                    if let Some(equipped_id) = self.equipped_weapon.take() {
                        self.items.push(equipped_id);
                    }
                    self.equipped_weapon = Some(self.items.remove(item_index));
                }
            }
        }
    }

    pub fn equip_armor(&mut self, item_id_to_equip: String, all_collectables: &Vec<Collectable>) {
        if let Some(item_index) = self.items.iter().position(|id| *id == item_id_to_equip) {
            if let Some(collectable) = all_collectables.iter().find(|c| c.id == item_id_to_equip) {
                if CollectableType::MeleeWeapon == collectable.collectable_type || CollectableType::RangedWeapon == collectable.collectable_type {
                    // Unequip current armor if any
                    if let Some(equipped_id) = self.equipped_armor.take() {
                        self.items.push(equipped_id);
                    }
                    self.equipped_armor = Some(self.items.remove(item_index));
                }
            }
        }
    }
}
