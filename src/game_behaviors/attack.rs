use nalgebra::{vector, ComplexField, Vector3};
use nalgebra_glm::Vec3;
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::core::PlayerCharacter::Stats;

use super::chase::ChaseBehavior;

// Basic attack configuration
#[derive(Clone)]
pub struct AttackStats {
    pub damage: f32,
    pub range: f32,
    pub cooldown: f32,
    pub wind_up_time: f32,
    pub recovery_time: f32,
}

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

