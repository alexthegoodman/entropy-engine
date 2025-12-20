use nalgebra::{vector, ComplexField, Vector3};
use nalgebra_glm::Vec3;
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::model_components::{PlayerCharacter::PlayerCharacter, NPC::Stats, NPC::NPC};

use super::chase::ChaseBehavior;

pub struct DefenseBehavior {
    pub block_chance: f32,
    pub block_cooldown: f32,
    pub stamina_cost: f32,
    last_block: Instant,
}

impl DefenseBehavior {
    pub fn new(block_chance: f32) -> Self {
        Self {
            block_chance,
            block_cooldown: 0.5,
            stamina_cost: 10.0,
            last_block: Instant::now(),
        }
    }

    pub fn try_block(&mut self, incoming_damage: f32, current_stamina: f32) -> (f32, f32) {
        // Returns (damage_taken, stamina_used)
        if self.last_block.elapsed().as_secs_f32() < self.block_cooldown
            || current_stamina < self.stamina_cost
        {
            return (incoming_damage, 0.0);
        }

        let mut rng = rand::thread_rng();
        if rng.r#gen::<f32>() <= self.block_chance {
            self.last_block = Instant::now();
            (0.0, self.stamina_cost) // Successful block
        } else {
            (incoming_damage, 0.0) // Failed block
        }
    }
}
