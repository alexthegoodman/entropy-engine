use nalgebra::{ComplexField, Point3, Vector3, vector};
use nalgebra_glm::Vec3;
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::helpers::saved_data::{AttackStats, CharacterStats};
use crate::model_components::{PlayerCharacter::PlayerCharacter, NPC::NPC};
use crate::game_behaviors::attack::{RangedAttackBehavior};
use crate::game_behaviors::defense::DefenseBehavior;
use crate::game_behaviors::evade::EvadeBehavior;

use super::chase::ChaseBehavior;

// High-level behavior that combines the others
pub struct RangedCombatBehavior {
    pub chase: ChaseBehavior,
    pub attack: RangedAttackBehavior,
    pub evade: EvadeBehavior,
    pub defense: DefenseBehavior,
    state_machine: CombatState,
    last_state_change: Instant,
}

#[derive(PartialEq)]
enum CombatState {
    Chasing,
    Attacking,
    Evading,
    Defending,
}

impl RangedCombatBehavior {
    pub fn new(
        chase_speed: f32,
        detection_radius: f32,
        attack_stats: AttackStats,
        evade_speed: f32,
        block_chance: f32,
    ) -> Self {
        Self {
            chase: ChaseBehavior::new(chase_speed, detection_radius),
            attack: RangedAttackBehavior::new(attack_stats),
            evade: EvadeBehavior::new(evade_speed, 3.0),
            defense: DefenseBehavior::new(block_chance),
            state_machine: CombatState::Chasing,
            last_state_change: Instant::now(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        entity_handle: RigidBodyHandle,
        target_handle: RigidBodyHandle,
        collider: &Collider,
        transform: &mut Transform,
        current_stamina: f32,
        dt: f32,
    ) -> Option<(f32, Option<(Point3<f32>, Point3<f32>)>)> {
        // Returns (damage, debug_line)
        let min_state_duration = 5.0; // Shorter state duration for ranged
        let state_duration = self.last_state_change.elapsed().as_secs_f32();

        // State machine logic
        match self.state_machine {
            CombatState::Chasing => {
                // Ranged units should chase until they are within range, then attack.
                // If they are too close, they might want to evade/back up, but for now simple chase.
                
                self.chase.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    target_handle,
                    collider,
                    transform,
                    dt,
                );

                // Transition to attacking if in range
                // Check more frequently than melee
                if state_duration >= 2.0 { 
                    let target_pos = rigid_body_set.get(target_handle)?.translation();
                    let distance = transform.position.metric_distance(&Vec3::new(
                        target_pos.x,
                        target_pos.y,
                        target_pos.z,
                    ));

                    if distance <= self.attack.stats.range {
                        self.state_machine = CombatState::Attacking;
                        self.last_state_change = Instant::now();
                    }
                }
                None
            }
            CombatState::Attacking => {
                let result = self.attack.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    target_handle,
                    transform,
                );

                // For ranged, we want to keep attacking as long as we have line of sight and range.
                // But for simple behavior, we can switch states occasionally.
                if state_duration >= min_state_duration {
                    let target_pos = rigid_body_set.get(target_handle)?.translation();
                    let distance = transform.position.metric_distance(&Vec3::new(
                        target_pos.x,
                        target_pos.y,
                        target_pos.z,
                    ));

                    // If target got too close, evade
                    if distance < self.attack.stats.range * 0.3 {
                        self.state_machine = CombatState::Evading;
                        self.last_state_change = Instant::now();
                    } else if distance > self.attack.stats.range {
                        // If target is out of range, chase
                        self.state_machine = CombatState::Chasing;
                        self.last_state_change = Instant::now();
                    }
                }
                result
            }
            CombatState::Evading => {
                let is_evading = self.evade.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    target_handle,
                    transform,
                    dt,
                );

                // Transition back to attacking (or chasing) if evade complete
                if state_duration >= min_state_duration && !is_evading {
                    self.state_machine = CombatState::Attacking; // Try to attack after evading
                    self.last_state_change = Instant::now();
                }
                None
            }
            CombatState::Defending => {
                // Transition back to attacking after defense
                if state_duration >= min_state_duration {
                    self.state_machine = CombatState::Attacking;
                    self.last_state_change = Instant::now();
                }
                None
            }
        }
    }

    // Called when receiving damage
    pub fn handle_incoming_damage(&mut self, damage: f32, stats: &mut CharacterStats) {
        // Ranged units might prefer to evade rather than defend/block?
        // For now, keep it same as melee
        self.state_machine = CombatState::Defending;
        self.last_state_change = Instant::now();
        let (damage_taken, stamina_used) = self.defense.try_block(damage, stats.stamina);

        stats.health -= damage_taken;
        stats.stamina -= stamina_used;

        if stats.health < 0.0 {
            stats.health = 0.0;
        }
        if stats.stamina < 0.0 {
            stats.stamina = 0.0;
        }

        println!(
            "NPC Health: {:.2}, Stamina: {:.2}",
            stats.health, stats.stamina
        );
    }

    pub fn get_animation_name(&self) -> &str {
        match self.state_machine {
            CombatState::Chasing => "Walking",
            CombatState::Attacking => "Shoot", // Or "Attack"
            CombatState::Evading => "Evade",
            CombatState::Defending => "Defend",
        }
    }
}
