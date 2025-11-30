use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use nalgebra::{vector, ComplexField, Vector3};
use nalgebra_glm::Vec3;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

use crate::core::Transform_2::Transform;

pub struct ChaseBehavior {
    // Configuration
    pub speed: f32,            // Movement speed
    pub detection_radius: f32, // How far to detect target
    pub min_distance: f32,     // Minimum distance to maintain from target
    pub max_slope: f32,        // Maximum traversable slope angle
    pub prediction_time: f32,  // Time to predict target's future position

    // Internal state
    target_handle: Option<RigidBodyHandle>,
    last_update: Instant,
}

impl ChaseBehavior {
    pub fn new(speed: f32, detection_radius: f32) -> Self {
        ChaseBehavior {
            speed,
            detection_radius,
            min_distance: 1.0,
            max_slope: 45.0,
            prediction_time: 0.5,
            target_handle: None,
            last_update: Instant::now(),
        }
    }

    pub fn set_target(&mut self, target: RigidBodyHandle) {
        self.target_handle = Some(target);
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        rigid_body_handle: RigidBodyHandle,
        target_handle: RigidBodyHandle,
        collider: &Collider,
        transform: &mut Transform,
        dt: f32,
    ) {
        let current_pos = transform.position;

        // Get target position and velocity
        let (target_pos, target_vel) = if let Some(target_body) = rigid_body_set.get(target_handle)
        {
            let pos = Vec3::new(
                target_body.translation().x,
                target_body.translation().y,
                target_body.translation().z,
            );
            let vel = target_body.linvel();
            (pos, vel)
        } else {
            return; // Target no longer exists
        };

        // Predict future position based on target's velocity
        let predicted_pos = target_pos
            + Vec3::new(
                target_vel.x * self.prediction_time,
                target_vel.y * self.prediction_time,
                target_vel.z * self.prediction_time,
            );

        // Calculate direction to predicted position
        let direction = (predicted_pos - current_pos).normalize();

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
                &rigid_body_set,
                &collider_set,
                &shape_pos,
                &shape_vel,
                shape,
                options,
                QueryFilter::default()
                    .exclude_rigid_body(rigid_body_handle)
                    .exclude_rigid_body(target_handle),
            )
            .is_some();

        if obstacle_detected {
            // Implement obstacle avoidance here if needed
            return;
        }

        // Calculate distance to target
        let distance = current_pos.metric_distance(&target_pos);

        // Only move if we're outside the minimum distance
        if distance > self.min_distance {
            let speed_factor = if distance > self.detection_radius {
                0.0 // Stop if target is too far
            } else {
                1.0 // Full speed within detection radius
            };

            // Apply movement
            if let Some(rigid_body) = rigid_body_set.get_mut(rigid_body_handle) {
                let movement = direction * self.speed * speed_factor * dt;
                let mut linvel = rigid_body.linvel().clone();
                linvel.x = movement.x;
                linvel.z = movement.z;
                rigid_body.set_linvel(linvel, true);
            }
        }
    }
}
