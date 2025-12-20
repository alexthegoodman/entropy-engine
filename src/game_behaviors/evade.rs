use nalgebra::{vector, ComplexField, Vector3};
use nalgebra_glm::Vec3;
use rand::Rng;
use rapier3d::{parry::query::ShapeCastOptions, prelude::*};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::core::Transform_2::Transform;
use crate::model_components::{PlayerCharacter::PlayerCharacter, NPC::NPC};

use super::chase::ChaseBehavior;

pub struct EvadeBehavior {
    pub speed: f32,
    pub evade_distance: f32,
    pub cooldown: f32,
    last_evade: Instant,
    // rng: rand::rngs::ThreadRng,
}

impl EvadeBehavior {
    pub fn new(speed: f32, evade_distance: f32) -> Self {
        Self {
            speed,
            evade_distance,
            cooldown: 1.0,
            last_evade: Instant::now(),
            // rng: rand::thread_rng(),
        }
    }

    pub fn update(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &ColliderSet,
        query_pipeline: &QueryPipeline,
        evader_handle: RigidBodyHandle,
        threat_handle: RigidBodyHandle,
        transform: &Transform,
        dt: f32,
    ) -> bool {
        // Returns true if currently evading
        if self.last_evade.elapsed().as_secs_f32() < self.cooldown {
            return false;
        }

        let mut rng = rand::thread_rng();

        let current_pos = transform.position;

        // Get threat position
        let threat_pos = if let Some(threat_body) = rigid_body_set.get(threat_handle) {
            Vec3::new(
                threat_body.translation().x,
                threat_body.translation().y,
                threat_body.translation().z,
            )
        } else {
            return false;
        };

        // Calculate evade direction (perpendicular to threat direction)
        let to_threat = threat_pos - current_pos;
        let angle = rng.gen_bool(0.5); // Randomly choose left or right
        let evade_direction = if angle {
            Vec3::new(-to_threat.z, 0.0, to_threat.x).normalize()
        } else {
            Vec3::new(to_threat.z, 0.0, -to_threat.x).normalize()
        };

        // Check if evade path is clear
        let ball = ColliderBuilder::ball(0.5).build();
        let shape = ball.shape().clone();
        let shape_pos = Isometry::new(
            vector![current_pos.x, current_pos.y, current_pos.z],
            vector![0.0, 0.0, 0.0],
        );
        let shape_vel = vector![
            evade_direction.x * self.evade_distance,
            0.0,
            evade_direction.z * self.evade_distance
        ];

        let obstacle_detected = query_pipeline
            .cast_shape(
                &rigid_body_set,
                &collider_set,
                &shape_pos,
                &shape_vel,
                shape,
                ShapeCastOptions::default(),
                QueryFilter::default().exclude_rigid_body(evader_handle),
            )
            .is_some();

        if !obstacle_detected {
            // Apply evade movement
            if let Some(rigid_body) = rigid_body_set.get_mut(evader_handle) {
                let movement = evade_direction * self.speed * dt;
                let mut linvel = rigid_body.linvel().clone();
                linvel.x = movement.x;
                linvel.z = movement.z;
                rigid_body.set_linvel(linvel, true);
                self.last_evade = Instant::now();
                return true;
            }
        }

        false
    }
}

