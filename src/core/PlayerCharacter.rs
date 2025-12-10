use std::sync::MutexGuard;

use nalgebra::{Isometry3, Point3, Vector3};
use rapier3d::{
    control::{CharacterAutostep, KinematicCharacterController}, parry::shape::Capsule, prelude::{
        ActiveCollisionTypes, Collider, ColliderBuilder, ColliderHandle, ColliderSet, QueryFilter, RigidBody, RigidBodyBuilder, RigidBodyHandle, RigidBodySet, TypedShape
    }
};
use uuid::Uuid;
use rapier3d::prelude::Shape;

use crate::{
    game_behaviors::{
        melee::{AttackStats, MeleeCombatBehavior},
        wander::WanderBehavior,
    },
    art_assets::Model::Model,
};

use super::{RendererState::RendererState, SimpleCamera::SimpleCamera};

pub struct NPC {
    pub id: Uuid,
    pub model_id: String,
    pub test_behavior: MeleeCombatBehavior,
}

impl NPC {
    pub fn new(model_id: String) -> Self {
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
            test_behavior: melee_combat,
        }
    }
}

use crate::shape_primitives::Sphere::Sphere;
pub struct PlayerCharacter {
    pub id: Uuid,
    // Transform components
    // position: Vec3,
    // rotation: Quat,
    // camera_height: f32,
    // camera: SimpleCamera, // always the one camera
    pub model: Option<Model>,
    pub sphere: Option<Sphere>,

    // Physics components
    pub character_controller: KinematicCharacterController,
    // pub movement_collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
    // pub movement_rigid_body: RigidBody,
    pub movement_rigid_body_handle: Option<RigidBodyHandle>,
    // hit_collider: Collider,
    pub movement_shape: Collider,

    // Movement properties
    pub movement_speed: f32,
    pub mouse_sensitivity: f32,
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

        // let movement_collider = ColliderBuilder::capsule_y(0.5, 1.0)
        //     .friction(0.0)
        //     .restitution(0.0)
        //     .density(1.0) // Add density to give it mass
        //     .user_data(id.as_u128())
        //     .active_collision_types(ActiveCollisionTypes::all()) // Make sure ALL collision types are enabled
        //     .build();

        // let dynamic_body = RigidBodyBuilder::dynamic()
        //     .additional_mass(70.0) // Explicitly set mass (e.g., 70kg for a person)
        //     .linear_damping(0.1)
        //     // .ccd_enabled(true)
        //     .user_data(id.as_u128())
        //     .build();

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
        // player_character.movement_rigid_body_handle = Some(rigid_body_handle);

        // now associate rigidbody with collider
        let collider_handle = collider_set.insert_with_parent(
            movement_collider,
            rigid_body_handle,
            rigid_body_set,
        );
        // player_character.collider_handle = Some(collider_handle);

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
            // movement_collider,
            // collider_handle: None,
            collider_handle: Some(collider_handle),
            // movement_rigid_body: dynamic_body,
            // movement_rigid_body_handle: None,
            movement_rigid_body_handle: Some(rigid_body_handle),
            movement_shape,
            // hit_collider: Collider::convex_hull(&player_model_verts).unwrap(), // this is on the optional Model
            movement_speed: 50.0,
            mouse_sensitivity: 0.003,
        }
    }

    pub fn update_rotation(dx: f32, dy: f32, camera: &mut SimpleCamera) {
        // the movement_collider and thus characte controller needn't rotate, only the Model's hit collider
        // let camera = get_camera();
        let sensitivity = 0.005;

        let dx = -dx * sensitivity;
        let dy = dy * sensitivity;

        camera.rotate(dx, dy);

        // camera.update(); // should be called in render loop or here?
    }
}
