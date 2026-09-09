use nalgebra::{Isometry3, Matrix4, Point3, UnitQuaternion, Vector3};
use rapier3d::math::Point as RapierPoint;
use rapier3d::prelude::*;
use uuid::Uuid;

use crate::handlers::EntropyPosition;

use super::RendererState;
use super::super::{
    Rays::{cast_ray_at_components, create_ray_from_mouse},
    SimpleCamera::SimpleCamera,
};

#[cfg(target_os = "windows")]
use std::time::Instant;

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

impl RendererState {
    pub fn set_mouse_position(&mut self, new_position: EntropyPosition) {
        self.last_mouse_position = self.current_mouse_position;
        self.current_mouse_position = Some(new_position);
        self.last_known_mouse_position = Some(new_position);
        self.last_mouse_position_time = Instant::now();
    }

    pub fn set_mouse_delta(&mut self, delta: (f64, f64)) {
        self.last_mouse_delta = (delta.0 as f32, delta.1 as f32);
    }

    // Usage in your main update/render loop:
    pub fn update_rays(
        &mut self,
        mouse_pos: (f32, f32),
        camera: &SimpleCamera,
        screen_width: u32,
        screen_height: u32,
    ) -> Ray {
        // Create ray from mouse position
        let ray = create_ray_from_mouse(mouse_pos, camera, screen_width, screen_height);

        // Cast ray and check for intersection
        if let Some((collider_handle, toi)) = cast_ray_at_components(
            &ray,
            &self.query_pipeline,
            &self.rigid_body_set,
            &self.collider_set,
        ) {
            // Get the collider
            let collider = &self.collider_set[collider_handle];

            // Get intersection point in world space
            let intersection_point = ray.point_at(toi);

            let component_id = Uuid::from_u128(collider.user_data);

            self.ray_intersecting = true;
            self.ray_intersection = Some(intersection_point);
            self.ray_component_id = Some(component_id);
        } else {
            self.ray_intersecting = false;
            // keep stale data for sticky translation
        }

        ray
    }
}
