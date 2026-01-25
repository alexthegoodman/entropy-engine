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
        stateful::{StatefulBehavior, BehaviorConfig, CombatType},
    },
    art_assets::Model::Model,
    core::AnimationState::AnimationState,
};
use crate::core::Transform_2::Transform;
use crate::shape_primitives::Sphere::Sphere;

pub enum NPCBehavior {
    Melee(MeleeCombatBehavior),
    Ranged(RangedCombatBehavior),
    Wander(WanderBehavior),
    Stateful(StatefulBehavior),
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
        forward_axis: Vector3<f32>,
        squad_leader_pos: Option<Point3<f32>>,
    ) -> (Option<(f32, Option<(Point3<f32>, Point3<f32>)>)>, bool) {
        match self {
            NPCBehavior::Melee(behavior) => (behavior.update(
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
            ).map(|damage| (damage, None)), false),
            NPCBehavior::Ranged(behavior) => (behavior.update(
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
            ), false),
            NPCBehavior::Wander(behavior) => {
                behavior.update(rigid_body_set, collider_set, query_pipeline, entity_handle, collider, transform, dt, forward_axis);
                (None, false)
            },
            NPCBehavior::Stateful(behavior) => behavior.update(
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
                squad_leader_pos,
            ),
        }
    }

    pub fn handle_incoming_damage(&mut self, damage: f32, stats: &mut CharacterStats) {
        match self {
            NPCBehavior::Melee(behavior) => behavior.handle_incoming_damage(damage, stats),
            NPCBehavior::Ranged(behavior) => behavior.handle_incoming_damage(damage, stats),
            NPCBehavior::Wander(behavior) => return,
            NPCBehavior::Stateful(behavior) => behavior.handle_incoming_damage(damage, stats),
        }
    }

    pub fn get_animation_name(&self) -> &str {
        match self {
            NPCBehavior::Melee(behavior) => behavior.get_animation_name(),
            NPCBehavior::Ranged(behavior) => behavior.get_animation_name(),
            NPCBehavior::Wander(behavior) => behavior.get_animation_name(),
            NPCBehavior::Stateful(behavior) => behavior.get_animation_name(),
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
    pub is_dead: bool,
    pub on_death_dropped: bool,
    pub suspicion: f32, // 0.0 to 1.0
    pub squad_id: Option<String>,
    pub is_squad_leader: bool,
    pub forward_axis: Vector3<f32>,
    pub debug_sphere: Option<Sphere>,
}

impl NPC {
    pub fn new(component_id: String, model_id: String, rigid_body_handle: RigidBodyHandle, behavior_config: BehaviorConfig, squad_id: Option<String>) -> Self {
        // Default to a Stateful behavior
        let stateful_behavior = StatefulBehavior::new(behavior_config);
        let test_behavior = NPCBehavior::Stateful(stateful_behavior);
        
        // TODO: add a customizable ScriptedBehavior which ties into the Rhai scripting more

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
            is_dead: false,
            on_death_dropped: false,
            suspicion: 0.0,
            squad_id,
            is_squad_leader: false,
            // forward_axis: Vector3::z(),
            forward_axis: Vector3::x(),
            debug_sphere: None,
        }
    }
}