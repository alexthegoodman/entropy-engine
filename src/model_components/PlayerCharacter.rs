use std::str::FromStr;
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
use rapier3d::prelude::{QueryPipeline, Shape, Ray};

use crate::core::{AnimationState::AnimationState, SimpleCamera::SimpleCamera};
use crate::helpers::saved_data::{AttackStats, CharacterStats, CollectableType};
use crate::model_components::NPC::{NPC};
use crate::{
    game_behaviors::{
        melee::{MeleeCombatBehavior},
        wander::WanderBehavior,
        inventory::Inventory,
    },
    art_assets::Model::Model,
};

use crate::shape_primitives::Sphere::Sphere;

pub struct PlayerCharacter {
    pub id: String,
    pub model_id: Option<String>,
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

    pub default_weapon_id: Option<String>,

    pub animation_state: AnimationState,
    pub is_moving: bool,
}

impl PlayerCharacter {
    pub fn new(
        id: String,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &wgpu::BindGroupLayout,
        texture_render_mode_buffer: &wgpu::Buffer,
        camera: &SimpleCamera,
        isometry: Isometry3<f32>,
        scale: Vector3<f32>,
        default_weapon_id: Option<String>
    ) -> Self {
        // let id = Uuid::new_v4();
        let uuid = Uuid::from_str(&id);
        let uuid = uuid.as_ref().expect("Couldn't convert uuid");

        let movement_collider = ColliderBuilder::capsule_y(0.5, 1.0)
            .friction(0.7) // Add significant friction (was 0.0)
            .restitution(0.0)
            .density(1.0)
            .user_data(uuid.as_u128())
            .active_collision_types(ActiveCollisionTypes::all())
            .build();

        let movement_shape = movement_collider.clone();

        let dynamic_body = RigidBodyBuilder::dynamic()
            .additional_mass(70.0)
            .linear_damping(0.4) // Increase damping (was 0.1)
            .angular_damping(0.9) // Add angular damping to prevent excessive rotation
            .ccd_enabled(true) // Enable Continuous Collision Detection for fast movement
            .lock_rotations() // Prevent character from tipping over
            .user_data(uuid.as_u128())
            .position(isometry)
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
            model_id: None,
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
            default_weapon_id,
            animation_state: AnimationState::new(0),
            is_moving: false,
        }
    }

    pub fn get_animation_name(&self) -> &str {
        if self.attack_timer.elapsed().as_secs_f32()
            < (self.attack_stats.wind_up_time + self.attack_stats.recovery_time)
        {
            "Attack"
        } else if self.is_defending {
            "Defend"
        } else if self.is_moving {
            "Walking"
        } else {
            "Idle"
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
        camera: &SimpleCamera,
    ) -> (Option<Uuid>, Option<(Point3<f32>, Point3<f32>)>) {
        if self.attack_timer.elapsed().as_secs_f32() < self.attack_stats.cooldown {
            return (None, None); // Attack is on cooldown
        }

        // Reset the attack timer
        self.attack_timer = Instant::now();

        // Get player position
        let player_pos = if let Some(rb_handle) = self.movement_rigid_body_handle {
            if let Some(rb) = rigid_body_set.get(rb_handle) {
                rb.translation().xyz()
            } else {
                return (None, None);
            }
        } else {
            return (None, None);
        };

        // Determine attack type based on equipped weapon
        let is_ranged = match &self.inventory.equipped_weapon_type {
            Some(CollectableType::RangedWeapon) => true,
            _ => false,
        };

        if is_ranged {
            // Ranged Attack (Raycast)
            // Use camera direction as the attack direction
            let dir = camera.direction.normalize();
            
            // Start ray slightly in front of the player/camera to avoid hitting self
            // Or use an exclude filter
            // Using camera position might be better for "crosshair" aiming, but player model might be offset.
            // For 3rd person, usually we raycast from camera through crosshair.
            // Let's use camera position + direction.
            let origin = camera.position; 
            
            let ray = Ray::new(
                Point3::new(origin.x, origin.y, origin.z),
                Vector3::new(dir.x, dir.y, dir.z),
            );

            let max_toi = 1000.0; // Long range for guns
            let solid = true;
            // Exclude player collider if possible. 
            // We can exclude the player's rigid body.
            let mut filter = QueryFilter::default();
            if let Some(rb_handle) = self.movement_rigid_body_handle {
                filter = filter.exclude_rigid_body(rb_handle);
            }

            let mut hit_point = origin + dir * max_toi;
            let mut hit_id = None;

            if let Some((handle, toi)) = query_pipeline.cast_ray(
                rigid_body_set,
                collider_set,
                &ray,
                max_toi,
                solid,
                filter
            ) {
                hit_point = origin + dir * toi;

                // Check if we hit an NPC
                if let Some(collider) = collider_set.get(handle) {
                    if let Some(parent_handle) = collider.parent() {
                         // Find which NPC has this rigid body handle
                         if let Some(npc) = npcs.iter_mut().find(|n| n.rigid_body_handle == parent_handle) {
                             npc.test_behavior.handle_incoming_damage(self.attack_stats.damage, &mut npc.stats);
                             println!("Player shot NPC!");
                             hit_id = Some(npc.id);
                         }
                    }
                }
            }
            
            if hit_id.is_none() {
                println!("Player shot air!");
            }

            return (hit_id, Some((origin, hit_point)));

        } else {
            // Melee Attack (Distance check)
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
                
                println!("Player attacked!"); // Debug print
                return (Some(npc.id), None);
            }

            println!("Player attacked air!"); // Debug print
            (None, None)
        }
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
