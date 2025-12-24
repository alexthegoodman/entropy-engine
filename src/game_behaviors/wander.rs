use std::{
    sync::{Arc, Mutex, MutexGuard},
};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use nalgebra::{vector, ComplexField, Vector3};
use nalgebra_glm::{Quat, Vec3};
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};
use uuid::Uuid;

use crate::core::{RendererState::RendererState, Transform_2::Transform};

pub struct WanderBehavior {
    // Configuration
    pub radius: f32,       // How far to wander from current position
    pub jitter: f32,       // Random variation in movement
    pub speed: f32,        // Movement speed
    pub min_distance: f32, // Minimum distance from obstacles
    pub max_slope: f32,    // Maximum traversable slope angle

    // Internal state
    target_position: Vector3<f32>,
    last_update: Instant,
}

impl WanderBehavior {
    pub fn new(radius: f32, speed: f32) -> Self {
        WanderBehavior {
            radius,
            speed,
            jitter: 0.5,
            min_distance: 1.0,
            max_slope: 45.0,
            target_position: Vec3::identity(),
            last_update: Instant::now(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        rigid_body_handle: RigidBodyHandle,
        collider: &Collider,
        transform: &mut Transform,
        dt: f32,
    ) {
        // First, collect all the data we need
        let current_pos = transform.position;
        let need_new_target = self.last_update.elapsed().as_secs_f32() > 8.0
            || current_pos.metric_distance(&self.target_position) < 0.5;

        // Calculate movement direction
        let direction = (self.target_position - current_pos).normalize();

        // Forward obstacle detection using shape cast
        let shape = collider.shape().clone();
        let shape_pos = Isometry::new(
            vector![current_pos.x, current_pos.y, current_pos.z],
            vector![0.0, 0.0, 0.0],
        );
        let shape_vel = vector![
            direction.x * self.min_distance,
            direction.y * self.min_distance,
            direction.z * self.min_distance
        ];

        let options = ShapeCastOptions {
            max_time_of_impact: 1.0,
            target_distance: 0.0,
            stop_at_penetration: false,
            compute_impact_geometry_on_penetration: true,
        };

        let obstacle_detected = query_pipeline
            .cast_shape(
                &rigid_body_set, // immutable borrow here is fine
                &collider_set,
                &shape_pos,
                &shape_vel,
                shape,
                options,
                QueryFilter::default().exclude_rigid_body(rigid_body_handle),
            )
            .is_some();

        // Now handle the logic and updates
        if need_new_target || obstacle_detected {
            self.choose_new_target(rigid_body_set, collider_set, query_pipeline, current_pos);
            self.last_update = Instant::now();

            // If we hit an obstacle, return early
            if obstacle_detected {
                println!("obstacle detected");
                return;
            }

            // Recalculate direction with new target
            let direction = (self.target_position - current_pos).normalize();
            let movement = direction * self.speed * dt;

            // Apply the movement
            if let Some(rigid_body) = rigid_body_set.get_mut(rigid_body_handle) {
                // println!("apply movement");
                let mut linvel = rigid_body.linvel().clone();
                linvel.x = movement.x;
                linvel.z = movement.z;
                rigid_body.set_linvel(linvel, true);
            }
        } else {
            // No new target needed, just apply movement

            let movement = direction * self.speed * dt;
            if let Some(rigid_body) = rigid_body_set.get_mut(rigid_body_handle) {
                // println!("no new target needed, apply movement");
                let mut linvel = rigid_body.linvel().clone();
                linvel.x = movement.x;
                linvel.z = movement.z;
                rigid_body.set_linvel(linvel, true);
            }
        }
    }

    fn choose_new_target(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        physics: &QueryPipeline,
        current_pos: Vec3,
    ) {
        let mut rng = rand::thread_rng();

        for _ in 0..10 {
            let angle = rng.gen_range(0.0..std::f32::consts::TAU);
            let distance = rng.gen_range(0.0..self.radius);

            let offset = Vec3::new(angle.cos() * distance, 0.0, angle.sin() * distance);

            let potential_target = current_pos + offset;

            // Ground detection
            let ground_shape = Cuboid::new(vector![0.1, 0.1, 0.1]);
            let ground_pos = Isometry::new(
                vector![
                    potential_target.x,
                    potential_target.y + 5.0,
                    potential_target.z
                ],
                vector![0.0, 0.0, 0.0],
            );
            let ground_vel = vector![0.0, -10.0, 0.0];

            let ground_options = ShapeCastOptions {
                max_time_of_impact: 10.0,
                target_distance: 0.0,
                stop_at_penetration: false,
                compute_impact_geometry_on_penetration: true,
            };

            if let Some((_, hit)) = physics.cast_shape(
                &rigid_body_set,
                &collider_set,
                &ground_pos,
                &ground_vel,
                &ground_shape,
                ground_options,
                QueryFilter::default(),
            ) {
                let ground_height = ground_pos.translation.y - (hit.time_of_impact * ground_vel.y);
                let ground_pos = Vec3::new(potential_target.x, ground_height, potential_target.z);

                // Validate position with a shape cast
                let check_shape = Ball::new(0.5);
                let check_pos = Isometry::new(
                    vector![ground_pos.x, ground_pos.y + 1.0, ground_pos.z],
                    vector![0.0, 0.0, 0.0],
                );

                // Cast slightly downward to ensure we're grounded
                let check_vel = vector![0.0, -0.1, 0.0];

                let check_options = ShapeCastOptions {
                    max_time_of_impact: 1.0,
                    target_distance: 0.0,
                    stop_at_penetration: true,
                    compute_impact_geometry_on_penetration: false,
                };

                if physics
                    .cast_shape(
                        &rigid_body_set,
                        &collider_set,
                        &check_pos,
                        &check_vel,
                        &check_shape,
                        check_options,
                        QueryFilter::default(),
                    )
                    .is_none()
                {
                    self.target_position = ground_pos;
                    return;
                }
            }
        }

        self.target_position = current_pos;
    }

    pub fn get_animation_name(&self) -> &str {
        return "Walking"
    }
}
