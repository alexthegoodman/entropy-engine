use nalgebra::{Point3, Vector3};
use nalgebra_glm::Vec3;
use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::time::Instant;

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::helpers::saved_data::{AttackStats, CharacterStats};
use crate::game_behaviors::{
    melee::MeleeCombatBehavior,
    ranged::RangedCombatBehavior,
    wander::WanderBehavior,
};

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, Default, Debug)]
pub enum CombatType {
    #[default]
    Melee,
    Ranged,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize, Default, Debug)]
pub struct BehaviorConfig {
    pub aggressiveness: f32, // 0.0 to 1.0
    pub combat_type: CombatType,
    pub wander_radius: f32,
    pub wander_speed: f32,
    pub detection_radius: f32,
    pub melee_stats: Option<AttackStats>,
    pub ranged_stats: Option<AttackStats>,
}

pub enum BehaviorState {
    Wander,
    Melee,
    Ranged,
}

pub struct StatefulBehavior {
    pub config: BehaviorConfig,
    pub current_state: BehaviorState,
    pub wander_behavior: WanderBehavior,
    pub melee_behavior: Option<MeleeCombatBehavior>,
    pub ranged_behavior: Option<RangedCombatBehavior>,
    pub last_state_change: Instant,
}

impl StatefulBehavior {
    pub fn new(config: BehaviorConfig) -> Self {
        let wander_behavior = WanderBehavior::new(config.wander_radius, config.wander_speed);
        
        let melee_behavior = if let Some(stats) = config.melee_stats {
            Some(MeleeCombatBehavior::new(
                config.wander_speed * 1.5, // Chase speed usually faster than wander
                config.detection_radius,
                stats,
                config.wander_speed, // Evade speed
                0.5, // Block chance
            ))
        } else {
            None
        };

        let ranged_behavior = if let Some(stats) = config.ranged_stats {
            Some(RangedCombatBehavior::new(
                config.wander_speed * 1.5,
                config.detection_radius,
                stats,
                config.wander_speed,
                0.5,
            ))
        } else {
            None
        };

        StatefulBehavior {
            config: config.clone(),
            current_state: BehaviorState::Wander,
            wander_behavior,
            melee_behavior,
            ranged_behavior,
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
        forward_axis: Vector3<f32>,
    ) -> Option<(f32, Option<(Point3<f32>, Point3<f32>)>)> {
        let target_pos = if let Some(rb) = rigid_body_set.get(target_handle) {
            rb.translation().clone()
        } else {
            return None;
        };
        
        let distance_to_target = transform.position.metric_distance(&Vec3::new(
            target_pos.x,
            target_pos.y,
            target_pos.z,
        ));

        // State transitions
        match self.current_state {
            BehaviorState::Wander => {
                // Check if we should switch to combat
                if distance_to_target <= self.config.detection_radius && self.config.aggressiveness > 0.1 {
                    // Switch based on combat type preference
                    match self.config.combat_type {
                        CombatType::Melee => {
                            if self.melee_behavior.is_some() {
                                self.current_state = BehaviorState::Melee;
                                self.last_state_change = Instant::now();
                                // println!("StatefulBehavior: Switching to Melee");
                            }
                        },
                        CombatType::Ranged => {
                            if self.ranged_behavior.is_some() {
                                self.current_state = BehaviorState::Ranged;
                                self.last_state_change = Instant::now();
                                // println!("StatefulBehavior: Switching to Ranged");
                            }
                        }
                    }
                }
            },
            BehaviorState::Melee | BehaviorState::Ranged => {
                // Check if we should give up and wander
                // If target is very far (e.g. 2x detection radius), go back to wander
                if distance_to_target > self.config.detection_radius * 2.0 {
                    self.current_state = BehaviorState::Wander;
                    self.last_state_change = Instant::now();
                     // println!("StatefulBehavior: Target lost, switching to Wander");
                }
            }
        }

        // Execute current behavior
        match self.current_state {
            BehaviorState::Wander => {
                self.wander_behavior.update(
                    rigid_body_set,
                    collider_set,
                    query_pipeline,
                    entity_handle,
                    collider,
                    transform,
                    dt,
                    forward_axis,
                );
                None
            },
            BehaviorState::Melee => {
                if let Some(behavior) = &mut self.melee_behavior {
                    behavior.update(
                        rigid_body_set,
                        collider_set,
                        query_pipeline,
                        entity_handle,
                        target_handle,
                        collider,
                        transform,
                        current_stamina,
                        dt,
                        forward_axis,
                    ).map(|d| (d, None))
                } else {
                    // Fallback to wander if melee behavior missing
                    self.wander_behavior.update(
                        rigid_body_set,
                        collider_set,
                        query_pipeline,
                        entity_handle,
                        collider,
                        transform,
                        dt,
                        forward_axis,
                    );
                    None
                }
            },
            BehaviorState::Ranged => {
                if let Some(behavior) = &mut self.ranged_behavior {
                     behavior.update(
                        rigid_body_set,
                        collider_set,
                        query_pipeline,
                        entity_handle,
                        target_handle,
                        collider,
                        transform,
                        current_stamina,
                        dt,
                        forward_axis,
                    )
                } else {
                     self.wander_behavior.update(
                        rigid_body_set,
                        collider_set,
                        query_pipeline,
                        entity_handle,
                        collider,
                        transform,
                        dt,
                        forward_axis,
                    );
                    None
                }
            },
        }
    }

    pub fn handle_incoming_damage(&mut self, damage: f32, stats: &mut CharacterStats) {
        // If attacked, become aggressive/alert even if previously wandering
        if let BehaviorState::Wander = self.current_state {
             match self.config.combat_type {
                CombatType::Melee => {
                    if self.melee_behavior.is_some() {
                        self.current_state = BehaviorState::Melee;
                    }
                },
                CombatType::Ranged => {
                    if self.ranged_behavior.is_some() {
                        self.current_state = BehaviorState::Ranged;
                    }
                }
            }
        }

        match self.current_state {
            BehaviorState::Melee => {
                if let Some(behavior) = &mut self.melee_behavior {
                    behavior.handle_incoming_damage(damage, stats);
                }
            },
            BehaviorState::Ranged => {
                if let Some(behavior) = &mut self.ranged_behavior {
                    behavior.handle_incoming_damage(damage, stats);
                }
            },
            BehaviorState::Wander => {
                // Just take damage if we couldn't switch or still in wander
                stats.health -= damage;
                if stats.health < 0.0 { stats.health = 0.0; }
            }
        }
    }

    pub fn get_animation_name(&self) -> &str {
        match self.current_state {
            BehaviorState::Wander => self.wander_behavior.get_animation_name(),
            BehaviorState::Melee => {
                if let Some(behavior) = &self.melee_behavior {
                    behavior.get_animation_name()
                } else {
                    "Idle"
                }
            },
            BehaviorState::Ranged => {
                if let Some(behavior) = &self.ranged_behavior {
                    behavior.get_animation_name()
                } else {
                    "Idle"
                }
            },
        }
    }
}
