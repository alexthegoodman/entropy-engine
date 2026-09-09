use crate::core::Texture::Texture;
use crate::helpers::saved_data::LandscapeTextureKinds;

use super::RendererState;
use super::super::SimpleCamera::SimpleCamera;

impl RendererState {
    pub fn update_terrain_managers(&mut self, device: &wgpu::Device, dt: f32, camera: &mut SimpleCamera) {
        // if self.terrain_managers.len() > 0 {
        //     // let camera = get_camera();
        //     let terrain_manager = self
        //         .terrain_managers
        //         .get_mut(0)
        //         .expect("Couldn't get first terrain manager");

        //     // keep for debugging:
        //     // if let Some(rb_handle) = self.player_character.movement_rigid_body_handle {
        //     //     if let Some(rb) = self.rigid_body_set.get(rb_handle) {
        //     //         let character_pos = rb.position();

        //     //         // let camera = get_camera();
        //     //         // let character_pos = camera.position;

        //     //         // Cast slightly above character's feet
        //     //         let ray_start = character_pos * Point3::new(0.0, 0.1, 0.0);
        //     //         let ray_dir = Vector3::new(0.0, -1.0, 0.0);

        //     //         let collider_handle = find_first_collider_handle(&terrain_manager.root);

        //     //         println!(
        //     //             "Check collider handle {:?} {:?}",
        //     //             character_pos,
        //     //             collider_handle.is_some()
        //     //         );

        //     //         if let Some(handle) = collider_handle {
        //     //             // Use QueryPipeline for ray casting
        //     //             let hit = self.query_pipeline.cast_ray(
        //     //                 &self.rigid_body_set,
        //     //                 &self.collider_set,
        //     //                 &Ray::new(ray_start, ray_dir),
        //     //                 f32::MAX,
        //     //                 true,
        //     //                 QueryFilter::default().exclude_rigid_body(rb_handle), // Exclude the character's own collider
        //     //             );

        //     //             if let Some((_, intersection)) = hit {
        //     //                 let hit_point: nalgebra::OPoint<f32, nalgebra::Const<3>> =
        //     //                     ray_start + ray_dir * intersection;
        //     //                 println!("Ground intersection at: {:?}", hit_point);
        //     //                 println!("Character position: {:?}", character_pos);
        //     //                 println!("Distance to ground: {:?}", intersection);
        //     //             } else {
        //     //                 println!("no intersect!");
        //     //             }
        //     //         }
        //     //     }
        //     // }

        //     terrain_manager.update(
        //         [camera.position.x, camera.position.y, camera.position.z],
        //         device,
        //         &mut self.rigid_body_set,
        //         &mut self.collider_set,
        //         &mut self.island_manager,
        //         &mut self.impulse_joint_set,
        //         &mut self.multibody_joint_set, // terrain_manager.terrain_position,
        //         // terrain_manager.id.clone(),
        //         dt,
        //         // &mut self.query_pipeline,
        //         camera,
        //         self.game_mode
        //     );
        // }
    }

    pub fn update_landscape_texture(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        landscape_id: String,
        kind: LandscapeTextureKinds,
        texture: Texture,
        maskKind: LandscapeTextureKinds,
        mask: Texture,
    ) {
        // w/o quadtree
        if let Some(landscape) = self
            .landscapes
            .iter_mut()
            .find(|l| l.id == landscape_id)
        {
            println!("Updating landscape texture...");
            landscape.update_texture(
                device,
                queue,
                &self.model_bind_group_layout,
                &self.texture_render_mode_buffer,
                &self.color_render_mode_buffer,
                kind,
                &texture,
            );
            landscape.update_texture(
                device,
                queue,
                &self.model_bind_group_layout,
                &self.texture_render_mode_buffer,
                &self.color_render_mode_buffer,
                maskKind,
                &mask,
            );
        }

        // for quadtree
        // if let Some(terrain_manager) = self
        //     .terrain_managers
        //     .iter_mut()
        //     .find(|l| l.id == landscape_id)
        // {
        //     println!("Updating landscape texture...");
        //     terrain_manager.update_texture(
        //         device,
        //         queue,
        //         &self.model_bind_group_layout,
        //         &self.texture_render_mode_buffer,
        //         &self.color_render_mode_buffer,
        //         kind,
        //         &texture,
        //     );
        //     terrain_manager.update_texture(
        //         device,
        //         queue,
        //         &self.model_bind_group_layout,
        //         &self.texture_render_mode_buffer,
        //         &self.color_render_mode_buffer,
        //         maskKind,
        //         &mask,
        //     );
        // }
    }
}
