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

use crate::core::SimpleCamera::SimpleCamera;
use crate::helpers::saved_data::{AttackStats, CharacterStats};
use crate::model_components::NPC::{NPC};
use crate::{
    game_behaviors::{
        melee::{MeleeCombatBehavior},
        wander::WanderBehavior,
        inventory::Inventory,
    },
    art_assets::Model::Model,
    core::AnimationState::AnimationState,
};

use crate::shape_primitives::Sphere::Sphere;

pub struct PlayerCharacter {
    pub id: Uuid,
    pub model: Option<Model>,
    pub sphere: Option<Sphere>,

    // Physics components
    pub character_controller: KinematicCharacterController,
    pub collider_handle: Option<ColliderHandle>,
    pub movement_rigid_body_handle: Option<RigidBodyHandle>,
    pub movement_shape: Collider,

    // Movement properties
    pub movement_speed: f32,
    pub mouse_sensitivity: f32,

    pub stats: CharacterStats,
    pub attack_stats: AttackStats,
    pub attack_timer: Instant,
    pub is_defending: bool,
    pub inventory: Inventory,
}

impl PlayerCharacter {
    pub fn new(
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        camera: &SimpleCamera,
    ) -> Self {
        let id = Uuid::new_v4();

        let movement_collider = ColliderBuilder::capsule_y(0.5, 1.0)
            .friction(0.7) // Add significant friction (was 0.0)
            .restitution(0.0)
            .density(1.0)
            .user_data(id.as_u128())
            .active_collision_types(ActiveCollisionTypes::all())
            .build();

        let movement_shape = movement_collider.clone();

        let dynamic_body = RigidBodyBuilder::dynamic()
            .additional_mass(70.0)
            .linear_damping(0.4) // Increase damping (was 0.1)
            .angular_damping(0.9) // Add angular damping to prevent excessive rotation
            .ccd_enabled(true) // Enable Continuous Collision Detection for fast movement
            .lock_rotations() // Prevent character from tipping over
            .user_data(id.as_u128())
            .build();

        let rigid_body_handle = rigid_body_set.insert(dynamic_body);

        // now associate rigidbody with collider
        let collider_handle = collider_set.insert_with_parent(
            movement_collider,
            rigid_body_handle,
            rigid_body_set,
        );

        let sphere = Sphere::new(
            device,
            queue,
            model_bind_group_layout,
            group_bind_group_layout,
            texture_render_mode_buffer,
            camera,
            1.0,
            32,
            16,
            [1.0, 1.0, 1.0]
        );

        Self {
            id,
            model: None,
            sphere: Some(sphere),
            character_controller: KinematicCharacterController {
                autostep: Some(CharacterAutostep {
                    max_height: rapier3d::control::CharacterLength::Relative((40.0)), // helps with jagged terrain?
                    min_width: rapier3d::control::CharacterLength::Relative((2.0)),
                    include_dynamic_bodies: true,
                }),
                slide: true,
                ..KinematicCharacterController::default()
            },
            collider_handle: Some(collider_handle),
            movement_rigid_body_handle: Some(rigid_body_handle),
            movement_shape,
            movement_speed: 50.0,
            mouse_sensitivity: 0.003,
            stats: CharacterStats {
                health: 100.0,
                stamina: 100.0,
            },
            attack_stats: AttackStats {
                damage: 25.0,
                range: 3.0,
                cooldown: 0.5,
                wind_up_time: 0.1,
                recovery_time: 0.2,
            },
            attack_timer: Instant::now(),
            is_defending: false,
            inventory: Inventory::new(),
        }
    }

    pub fn update_rotation(dx: f32, dy: f32, camera: &mut SimpleCamera) {
        // the movement_collider and thus characte controller needn't rotate, only the Model's hit collider
        let sensitivity = 0.005;

        let dx = -dx * sensitivity;
        let dy = dy * sensitivity;

        camera.rotate(dx, dy);
    }

    pub fn attack(
        &mut self,
        rigid_body_set: &RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        npcs: &mut Vec<NPC>,
    ) {
        if self.attack_timer.elapsed().as_secs_f32() < self.attack_stats.cooldown {
            return; // Attack is on cooldown
        }

        // Reset the attack timer
        self.attack_timer = Instant::now();

        // Simplified targeting: Find the closest NPC within attack range
        let player_pos = if let Some(rb_handle) = self.movement_rigid_body_handle {
            if let Some(rb) = rigid_body_set.get(rb_handle) {
                rb.translation().xyz()
            } else {
                return;
            }
        } else {
            return;
        };

        let mut closest_npc_index: Option<usize> = None;
        let mut min_distance = self.attack_stats.range;

        for (i, npc) in npcs.iter().enumerate() {
            if let Some(npc_rb) = rigid_body_set.get(npc.rigid_body_handle) {
                let npc_pos = npc_rb.translation().xyz();
                let distance = nalgebra::distance(&player_pos.into(), &npc_pos.into());

                if distance <= min_distance {
                    min_distance = distance;
                    closest_npc_index = Some(i);
                }
            }
        }

        if let Some(index) = closest_npc_index {
            // Apply damage to the targeted NPC
            let npc = &mut npcs[index];
            npc.test_behavior
                .handle_incoming_damage(self.attack_stats.damage, &mut npc.stats);
        }

        println!("Player attacked!"); // Debug print
    }

    pub fn defend(&mut self) {
        self.is_defending = true;
        println!("Player is now defending!");
    }

    pub fn handle_incoming_damage(&mut self, damage: f32) {
        let actual_damage = if self.is_defending {
            println!("Player defended! Damage reduced.");
            damage * 0.5 // Reduce damage by 50% if defending
        } else {
            damage
        };

        self.stats.health -= actual_damage;
        if self.stats.health < 0.0 {
            self.stats.health = 0.0;
        }
        self.is_defending = false; // Reset defending state after taking damage

        println!(
            "Player Character - Health: {:.2}, Stamina: {:.2}",
            self.stats.health, self.stats.stamina
        );
    }
}
