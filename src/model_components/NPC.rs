use std::sync::MutexGuard;

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use rapier3d::{
    control::{CharacterAutostep, KinematicCharacterController}, parry::shape::Capsule, prelude::{
        ActiveCollisionTypes, Collider, ColliderBuilder, ColliderHandle, ColliderSet, QueryFilter, RigidBody, RigidBodyBuilder, RigidBodyHandle, RigidBodySet, TypedShape
    }
};
use uuid::Uuid;
use rapier3d::prelude::{QueryPipeline, Shape};
use wgpu::util::DeviceExt;

use crate::{core::Transform_2::matrix4_to_raw_array, deno::addon_engine::VisualConfig, helpers::saved_data::{AttackStats, CharacterStats, VisualType}};
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
    pub visual_type: VisualType,
    pub rigid_body_handle: Option<RigidBodyHandle>,
    pub test_behavior: NPCBehavior,
    pub animation_state: AnimationState,
    pub transform: Option<Transform>,
    pub joint_matrices_buffer: Option<wgpu::Buffer>,
    pub skin_bind_group: Option<wgpu::BindGroup>,
    pub model_bind_group: Option<wgpu::BindGroup>,
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
    pub behavior_id: Option<String>,

    pub rapier_collider: Option<Collider>,
    pub collider_handle: Option<ColliderHandle>,
    pub rapier_rigidbody: Option<RigidBody>,
}

impl NPC {
    pub fn new(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        component_id: String, 
        model_id: String, 
        visual_type: VisualType, 
        rigid_body_handle: Option<RigidBodyHandle>, 
        behavior_config: BehaviorConfig, 
        squad_id: Option<String>,
        visual_config: Option<VisualConfig>,
    ) -> Self {
        // Default to a Stateful behavior
        let stateful_behavior = StatefulBehavior::new(behavior_config);
        let test_behavior = NPCBehavior::Stateful(stateful_behavior);
        
        // TODO: add a customizable ScriptedBehavior which ties into the Rhai scripting more
        let mut transform = None;
        if let Some(config) = visual_config {
            let rotation = if let Some(rot) = config.rotation {
                Vector3::new(rot[0], rot[1], rot[2])
            } else {
                Vector3::zeros()
            };

            let empty_buffer = Matrix4::<f32>::identity();
            let raw_matrix = matrix4_to_raw_array(&empty_buffer);
            let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some(&format!("NPC {} Transform Buffer", component_id)),
                contents: bytemuck::cast_slice(&raw_matrix),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            });

            transform = Some(Transform::new(
                Vector3::new(config.position[0], config.position[1], config.position[2]),
                rotation,
                Vector3::new(1.0, 1.0, 1.0),
                uniform_buffer,
            ))
        }

        NPC {
            id: component_id,
            model_id,
            visual_type,
            rigid_body_handle,
            test_behavior,
            animation_state: AnimationState::new(0),
            transform,
            joint_matrices_buffer: None,
            skin_bind_group: None,
            model_bind_group: None,
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
            behavior_id: None,
            rapier_collider: None,
            collider_handle: None,
            rapier_rigidbody: None,
        }
    }
}