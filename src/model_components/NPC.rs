use std::sync::MutexGuard;

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use nalgebra::{Isometry3, Point3, Vector3};
use rapier3d::{
    control::{CharacterAutostep, KinematicCharacterController}, parry::shape::Capsule, prelude::{
        ActiveCollisionTypes, Collider, ColliderBuilder, ColliderHandle, ColliderSet, QueryFilter, RigidBody, RigidBodyBuilder, RigidBodyHandle, RigidBodySet, TypedShape
    }
};
use uuid::Uuid;
use rapier3d::prelude::{QueryPipeline, Shape};

use crate::helpers::saved_data::{AttackStats, CharacterStats};
use crate::{
    game_behaviors::{
        melee::{MeleeCombatBehavior},
        ranged::{RangedCombatBehavior},
        wander::WanderBehavior,
        inventory::Inventory,
    },
    art_assets::Model::Model,
    core::AnimationState::AnimationState,
};
use crate::core::Transform_2::Transform;

pub enum NPCBehavior {
    Melee(MeleeCombatBehavior),
    Ranged(RangedCombatBehavior),
    Wander(WanderBehavior)
}

impl NPCBehavior {
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
        match self {
            NPCBehavior::Melee(behavior) => behavior.update(
                rigid_body_set,
                collider_set,
                query_pipeline,
                entity_handle,
                target_handle,
                collider,
                transform,
                current_stamina,
                dt,
            ).map(|damage| (damage, None)),
            NPCBehavior::Ranged(behavior) => behavior.update(
                rigid_body_set,
                collider_set,
                query_pipeline,
                entity_handle,
                target_handle,
                collider,
                transform,
                current_stamina,
                dt,
            ),
            NPCBehavior::Wander(behavior) => {
                behavior.update(rigid_body_set, collider_set, query_pipeline, entity_handle, collider, transform, dt);
                None
            },
        }
    }

    pub fn handle_incoming_damage(&mut self, damage: f32, stats: &mut CharacterStats) {
        match self {
            NPCBehavior::Melee(behavior) => behavior.handle_incoming_damage(damage, stats),
            NPCBehavior::Ranged(behavior) => behavior.handle_incoming_damage(damage, stats),
            NPCBehavior::Wander(behavior) => return,
        }
    }

    pub fn get_animation_name(&self) -> &str {
        match self {
            NPCBehavior::Melee(behavior) => behavior.get_animation_name(),
            NPCBehavior::Ranged(behavior) => behavior.get_animation_name(),
            NPCBehavior::Wander(behavior) => behavior.get_animation_name(),
        }
    }
}

pub struct NPC {
    pub id: String,
    pub model_id: String,
    pub rigid_body_handle: RigidBodyHandle,
    pub test_behavior: NPCBehavior,
    pub animation_state: AnimationState,
    pub stats: CharacterStats,
    pub inventory: Inventory,
    pub is_talking: bool,
}

impl NPC {
    pub fn new(component_id: String, model_id: String, rigid_body_handle: RigidBodyHandle) -> Self {
        let wander = WanderBehavior::new(50.0, 100.0);

        let test_behavior = NPCBehavior::Wander(wander);
        
        // let attack_stats = AttackStats {
        //     damage: 15.0,
        //     range: 3.0,
        //     cooldown: 0.2,
        //     wind_up_time: 0.1,
        //     recovery_time: 0.1,
        // };

        // // let melee_combat = MeleeCombatBehavior::new(
        // //     200.0, // chase_speed
        // //     50.0,  // detection_radius
        // //     attack_stats,
        // //     75.0, // evade_speed
        // //     0.7,  // block_chance
        // // );

        // // let test_behavior = NPCBehavior::Melee(melee_combat);

        // let melee_combat = RangedCombatBehavior::new(
        //     200.0, // chase_speed
        //     50.0,  // detection_radius
        //     attack_stats,
        //     75.0, // evade_speed
        //     0.7,  // block_chance
        // );

        // let test_behavior = NPCBehavior::Ranged(melee_combat);

        NPC {
            id: component_id,
            model_id,
            rigid_body_handle,
            test_behavior,
            animation_state: AnimationState::new(0),
            stats: CharacterStats {
                health: 100.0,
                stamina: 100.0,
            },
            inventory: Inventory::new(),
            is_talking: false,
        }
    }
}