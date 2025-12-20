use std::sync::MutexGuard;
use std::time::{Duration, Instant};

use nalgebra::{Isometry3, Point3, Vector3};
use rapier3d::{
    control::{CharacterAutostep, KinematicCharacterController}, parry::shape::Capsule, prelude::{
        ActiveCollisionTypes, Collider, ColliderBuilder, ColliderHandle, ColliderSet, QueryFilter, RigidBody, RigidBodyBuilder, RigidBodyHandle, RigidBodySet, TypedShape
    }
};
use uuid::Uuid;
use rapier3d::prelude::{QueryPipeline, Shape};

use crate::{
    game_behaviors::{
        melee::{MeleeCombatBehavior},
        attack::AttackStats,
        wander::WanderBehavior,
    },
    art_assets::Model::Model,
    core::AnimationState::AnimationState,
};

pub struct Stats {
    pub health: f32,
    pub stamina: f32,
}

pub struct NPC {
    pub id: Uuid,
    pub model_id: String,
    pub rigid_body_handle: RigidBodyHandle,
    pub test_behavior: MeleeCombatBehavior,
    pub animation_state: AnimationState,
    pub stats: Stats,
}

impl NPC {
    pub fn new(model_id: String, rigid_body_handle: RigidBodyHandle) -> Self {
        // let wander = WanderBehavior::new(50.0, 100.0);
        let attack_stats = AttackStats {
            damage: 10.0,
            range: 2.0,
            cooldown: 1.0,
            wind_up_time: 0.3,
            recovery_time: 0.5,
        };

        let melee_combat = MeleeCombatBehavior::new(
            100.0, // chase_speed
            50.0,  // detection_radius
            attack_stats,
            50.0, // evade_speed
            0.7,  // block_chance
        );

        NPC {
            id: Uuid::new_v4(),
            model_id,
            rigid_body_handle,
            test_behavior: melee_combat,
            animation_state: AnimationState::new(0),
            stats: Stats {
                health: 100.0,
                stamina: 100.0,
            },
        }
    }
}