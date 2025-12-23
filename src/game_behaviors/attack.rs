use nalgebra::{ComplexField, Point3, Vector3, vector};
use nalgebra_glm::Vec3;
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::helpers::saved_data::AttackStats;
use crate::model_components::{PlayerCharacter::PlayerCharacter, NPC::NPC};

use super::chase::ChaseBehavior;

// Basic attack configuration

// Reusable attack state tracking
#[derive(PartialEq)]
enum AttackState {
    Ready,
    WindingUp(Instant),
    Attacking(Instant),
    Recovering(Instant),
}

pub struct MeleeAttackBehavior {
    pub stats: AttackStats,
    state: AttackState,
    last_attack: Instant,
}

impl MeleeAttackBehavior {
    pub fn new(stats: AttackStats) -> Self {
        Self {
            stats,
            state: AttackState::Ready,
            last_attack: Instant::now(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        attacker_handle: RigidBodyHandle,
        target_handle: RigidBodyHandle,
        transform: &Transform,
    ) -> Option<f32> {
        // Returns damage dealt if attack lands
        let current_pos = transform.position;

        // Get target position
        let target_pos = if let Some(target_body) = rigid_body_set.get(target_handle) {
            Vec3::new(
                target_body.translation().x,
                target_body.translation().y,
                target_body.translation().z,
            )
        } else {
            return None;
        };

        // Check if target is in range
        let distance = current_pos.metric_distance(&target_pos);
        if distance > self.stats.range {
            return None;
        }

        match self.state {
            AttackState::Ready => {
                if self.last_attack.elapsed().as_secs_f32() >= self.stats.cooldown {
                    self.state = AttackState::WindingUp(Instant::now());
                }
                None
            }
            AttackState::WindingUp(start_time) => {
                if start_time.elapsed().as_secs_f32() >= self.stats.wind_up_time {
                    self.state = AttackState::Attacking(Instant::now());
                }
                None
            }
            AttackState::Attacking(start_time) => {
                if start_time.elapsed().as_secs_f32() >= 0.1 {
                    // Attack frame
                    self.state = AttackState::Recovering(Instant::now());
                    self.last_attack = Instant::now();
                    Some(self.stats.damage)
                } else {
                    None
                }
            }
            AttackState::Recovering(start_time) => {
                if start_time.elapsed().as_secs_f32() >= self.stats.recovery_time {
                    self.state = AttackState::Ready;
                }
                None
            }
        }
    }
}

pub struct RangedAttackBehavior {
    pub stats: AttackStats,
    state: AttackState,
    last_attack: Instant,
}

impl RangedAttackBehavior {
    pub fn new(stats: AttackStats) -> Self {
        Self {
            stats,
            state: AttackState::Ready,
            last_attack: Instant::now(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        attacker_handle: RigidBodyHandle,
        target_handle: RigidBodyHandle,
        transform: &Transform,
    ) -> Option<(f32, Option<(Point3<f32>, Point3<f32>)>)> {
        // Returns (damage, debug_line)
        let current_pos = transform.position;

        // Get target position for distance check (optimization)
        let target_pos = if let Some(target_body) = rigid_body_set.get(target_handle) {
            Vec3::new(
                target_body.translation().x,
                target_body.translation().y,
                target_body.translation().z,
            )
        } else {
            return None;
        };

        // Check if target is in range
        let distance = current_pos.metric_distance(&target_pos);
        if distance > self.stats.range {
            return None;
        }

        match self.state {
            AttackState::Ready => {
                if self.last_attack.elapsed().as_secs_f32() >= self.stats.cooldown {
                    self.state = AttackState::WindingUp(Instant::now());
                }
                None
            }
            AttackState::WindingUp(start_time) => {
                if start_time.elapsed().as_secs_f32() >= self.stats.wind_up_time {
                    self.state = AttackState::Attacking(Instant::now());
                }
                None
            }
            AttackState::Attacking(start_time) => {
                if start_time.elapsed().as_secs_f32() >= 0.1 {
                    // Attack frame - Perform Raycast
                    self.state = AttackState::Recovering(Instant::now());
                    self.last_attack = Instant::now();

                    // Calculate direction to target
                    let dir = (target_pos - current_pos).normalize();
                    let origin = Point3::new(current_pos.x, current_pos.y, current_pos.z);
                    let ray = Ray::new(
                        origin,
                        Vector3::new(dir.x, dir.y, dir.z),
                    );

                    let max_toi = self.stats.range;
                    let solid = true;
                    // Exclude the attacker from the raycast
                    let filter = QueryFilter::default().exclude_rigid_body(attacker_handle);

                    let mut hit_point = origin + Vector3::new(dir.x, dir.y, dir.z) * max_toi;
                    let mut damage = 0.0;

                    if let Some((handle, toi)) = query_pipeline.cast_ray(
                        rigid_body_set,
                        collider_set,
                        &ray,
                        max_toi,
                        solid,
                        filter
                    ) {
                        hit_point = origin + Vector3::new(dir.x, dir.y, dir.z) * toi;
                        // Check if we hit the target
                         if let Some(collider) = collider_set.get(handle) {
                             if let Some(parent_handle) = collider.parent() {
                                 if parent_handle == target_handle {
                                      damage = self.stats.damage;
                                 }
                             }
                         }
                    }
                    
                    Some((damage, Some((origin, hit_point))))
                } else {
                    None
                }
            }
            AttackState::Recovering(start_time) => {
                if start_time.elapsed().as_secs_f32() >= self.stats.recovery_time {
                    self.state = AttackState::Ready;
                }
                None
            }
        }
    }
}


