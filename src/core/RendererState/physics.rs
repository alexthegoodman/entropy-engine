use nalgebra::{Isometry3, Point3, UnitQuaternion, Vector3};
use rapier3d::prelude::*;
use uuid::Uuid;

use crate::core::Transform_2::matrix4_to_raw_array;
use crate::core::camera::CameraBinding;
use crate::game_behaviors::stateful::BehaviorState;
use crate::helpers::saved_data::VisualType;
use crate::shape_primitives::Sphere::Sphere;
use crate::{
    core::Texture::Texture,
    helpers::saved_data::{ComponentData, ComponentKind},
};
use std::collections::HashMap;
use std::str::FromStr;

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

#[cfg(target_arch = "wasm32")]
use std::time::Duration;

use crate::model_components::PlayerCharacter::MovementState;
use crate::shape_primitives::Cube::Cube;

use super::RendererState;
use super::DebugRay;
use super::super::SimpleCamera::SimpleCamera;

impl RendererState {
    pub fn alert_nearby_npcs(&mut self, position: Vector3<f32>, radius: f32) {
        let mut alerted_count = 0;
        for npc in &mut self.npcs {
            if npc.is_dead { continue; }

            if let Some(rb) = self.rigid_body_set.get(*npc.rigid_body_handle.as_ref().expect("Couldnt get handle")) {
                let npc_pos = rb.translation();
                let npc_pos = Vector3::new(npc_pos.x, npc_pos.y, npc_pos.z);

                let dist = (npc_pos - position).magnitude();

                if dist <= radius {
                    // Alert the NPC
                    if let crate::model_components::NPC::NPCBehavior::Stateful(behavior) = &mut npc.test_behavior {
                        // If it was wandering, make it aggressive
                        if let crate::game_behaviors::stateful::BehaviorState::Wander = behavior.current_state {
                             // Force state change to combat if aggressiveness allows
                             if behavior.config.aggressiveness > 0.1 {
                                 match behavior.config.combat_type {
                                     crate::game_behaviors::stateful::CombatType::Melee => {
                                         if behavior.melee_behavior.is_some() {
                                             behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Melee;
                                             alerted_count += 1;
                                         }
                                     },
                                     crate::game_behaviors::stateful::CombatType::Ranged => {
                                         if behavior.ranged_behavior.is_some() {
                                             behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Ranged;
                                             alerted_count += 1;
                                         }
                                     }
                                 }
                             }
                        }
                    }
                }
            }
        }
        if alerted_count > 0 {
            println!("Swarm Alert: {} NPCs alerted!", alerted_count);
        }
    }

    pub fn is_player_grounded(
        &self,
        player_handle: RigidBodyHandle,
    ) -> bool {
        const GROUND_CHECK_DISTANCE: f32 = 10.0; // Small distance to check below the player

        // Get player position
        let player_rb = match self.rigid_body_set.get(player_handle) {
            Some(rb) => rb,
            None => return false,
        };

        let player_pos = player_rb.translation();

        // Create a ray from the player's position downward
        let ray_origin = point![player_pos.x, player_pos.y, player_pos.z];
        let ray_direction = vector![0.0, -1.0, 0.0];

        // Create the ray
        let ray = Ray::new(ray_origin, ray_direction);

        let rigidbody_set = &self.rigid_body_set;
        let collider_set = &self.collider_set;
        let query_pipeline = &self.query_pipeline;

        // Perform the raycast
        if let Some((handle, intersection)) = query_pipeline.cast_ray(
            rigidbody_set,
            collider_set,
            &ray,
            GROUND_CHECK_DISTANCE,
            true,
            QueryFilter::default().exclude_rigid_body(player_handle),
        ) {
            // Ray hit something, player is grounded
            return true;
        }

        // No hit, player is not grounded
        false
    }

    pub fn step_physics_pipeline(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, camera_binding: &mut CameraBinding, camera: &mut SimpleCamera) {
        // Cleanup debug rays
        self.debug_rays.retain(|ray| ray.expires_at > Instant::now());

        // Calculate delta time
        let now = Instant::now();
        let dt = if let Some(last_time) = self.last_frame_time {
            (now - last_time).as_secs_f32()
        } else {
            0.0
        };

        #[cfg(target_os = "windows")]
        let near_future = self.last_mouse_position_time.checked_add(Duration::from_millis(100));

        #[cfg(target_os = "windows")]
        if let Some(future) = near_future {
            if future < now {
                self.last_mouse_position = None;
                self.current_mouse_position =  None;
            }
        }

        #[cfg(target_arch = "wasm32")]
        let near_future = self.last_mouse_position_time.elapsed().as_secs_f64();

        #[cfg(target_arch = "wasm32")]
        if near_future < js_sys::Date::now() {
            self.last_mouse_position = None;
            self.current_mouse_position =  None;
        }

        self.last_frame_time = Some(now);

        self.update_terrain_managers(device, dt, camera);

        // Update player state (stamina, eye height, etc.)
        self.update_player_state(dt);

        let step_time = Instant::now();

        // Step the physics pipeline
        let physics_hooks = ();
        let event_handler = ();

        self.physics_pipeline.step(
            &self.gravity,
            &self.integration_parameters,
            &mut self.island_manager,
            &mut self.broad_phase,
            &mut self.narrow_phase,
            &mut self.rigid_body_set,
            &mut self.collider_set,
            &mut self.impulse_joint_set,
            &mut self.multibody_joint_set,
            &mut self.ccd_solver,
            Some(&mut self.query_pipeline),
            &physics_hooks,
            &event_handler,
        );

        let step_duration = step_time.elapsed();

        let physics_update_time = Instant::now();

        // Collect all the necessary data first
        let physics_updates: Vec<(Uuid, nalgebra::Vector3<f32>, (f32, f32, f32))> = self
            .rigid_body_set
            .iter()
            .map(|(_, rigid_body)| {
                let physics_position = rigid_body.position();
                let position = physics_position.translation.vector;
                let rotation = physics_position.rotation;
                let euler = rotation.euler_angles();
                let component_id = Uuid::from_u128(rigid_body.user_data);
                (component_id, position, euler)
            })
            .collect();

        // Map squad leaders positions
        let mut squad_leaders: HashMap<String, Point3<f32>> = HashMap::new();
        for npc in &self.npcs {
            if npc.is_dead { continue; }
            if let Some(squad_id) = &npc.squad_id {
                // First living NPC in squad becomes the leader for this frame if not already set
                if !squad_leaders.contains_key(squad_id) {
                    if let Some(rb) = self.rigid_body_set.get(*npc.rigid_body_handle.as_ref().expect("Couldn't get rigidbody handle")) {
                        let pos = rb.translation();
                        squad_leaders.insert(squad_id.clone(), Point3::new(pos.x, pos.y, pos.z));
                    }
                }
            }
        }

        let physics_update_duration = physics_update_time.elapsed();

        let physics_update_time = Instant::now();

        // Update camera position if needed
        if self.game_mode {
            if let Some(player_character) = &self.player_character {
                if let Some(rb_handle) = player_character.movement_rigid_body_handle {
                    if let Some(rb) = self.rigid_body_set.get(rb_handle) {
                        if self.game_settings.third_person {
                            // third-person / 3rd person camera
                            let pos = rb.translation(); // nalgebra::Vector3<f32>

                            // --- Mouse Input and Angle Update ---
                            let delta = if let (Some(current), Some(last)) = (
                                self.current_mouse_position,
                                self.last_mouse_position
                            ) {
                                let mouse_sensitivity: f32 = 0.005;

                                // Calculate difference (delta) in screen coordinates
                                let delta_x = current.x - last.x;
                                let delta_y = current.y - last.y;

                                (delta_x, delta_y)
                            } else if let del = self.last_mouse_delta {
                                del
                            } else {
                                (0.0, 0.0)
                            };

                            let mouse_sensitivity: f32 = 0.005;

                            let delta_x = delta.0;
                            let delta_y = delta.1;

                            self.camera_yaw += (delta_x as f32) * mouse_sensitivity;

                            self.camera_pitch += (delta_y as f32) * mouse_sensitivity;

                            self.camera_pitch = self.camera_pitch.clamp(-1.55, 1.55);

                            // --- Apply Recoil ---
                            let applied_pitch = self.camera_pitch + player_character.recoil_offset.y.to_radians();
                            let applied_yaw = self.camera_yaw + player_character.recoil_offset.x.to_radians();

                            // --- Camera Variables ---
                            let radius: f32 = 25.0; // The fixed distance from the player

                            // --- Calculate New Camera Position using Spherical Coordinates ---
                            let horizontal_distance = radius * applied_pitch.cos();

                            let x_offset = horizontal_distance * applied_yaw.sin();
                            let y_offset = radius * applied_pitch.sin();
                            let z_offset = horizontal_distance * applied_yaw.cos();

                            let comfort_elevation = 2.0;
                            let camera_pos = Point3::new(
                                pos.x + x_offset,
                                pos.y + y_offset + comfort_elevation,
                                pos.z - z_offset // Subtract for Z-axis typically pointing forward/into the screen
                            );
                            camera.position = camera_pos;

                            // Set direction to look back at the player's center
                            let direction = (pos - camera_pos.coords).normalize();
                            camera.direction = direction;

                            camera.update();
                            camera_binding.update_3d(&queue, &camera);

                        } else {
                            // first / 1st person camera with lookaround
                            let pos = rb.translation();

                            // --- Mouse Input and Angle Update ---
                            let delta = if let (Some(current), Some(last)) = (
                                self.current_mouse_position,
                                self.last_mouse_position
                            ) {
                                let mouse_sensitivity: f32 = 0.005;

                                let delta_x = current.x - last.x;
                                let delta_y = current.y - last.y;

                                (delta_x, delta_y)
                            } else if let del = self.last_mouse_delta {
                                del
                            } else {
                                (0.0, 0.0)
                            };

                            let mouse_sensitivity: f32 = 0.005;

                            let delta_x = delta.0;
                            let delta_y = delta.1;

                            self.camera_yaw += (delta_x as f32) * mouse_sensitivity;

                            self.camera_pitch -= (delta_y as f32) * mouse_sensitivity;

                            self.camera_pitch = self.camera_pitch.clamp(-1.55, 1.55);

                            // --- Apply Recoil ---
                            let applied_pitch = self.camera_pitch + player_character.recoil_offset.y.to_radians();
                            let applied_yaw = self.camera_yaw + player_character.recoil_offset.x.to_radians();

                            // --- Calculate look direction from yaw and pitch ---
                            let direction = Vector3::new(
                                applied_yaw.cos() * applied_pitch.cos(),
                                applied_pitch.sin(),
                                applied_yaw.sin() * applied_pitch.cos()
                            ).normalize();

                            // --- Position camera at player's eye level ---
                            let eye_height = player_character.current_eye_height;
                            let bob_offset = player_character.camera_bob_amount;

                            let camera_pos = Point3::new(
                                pos.x,
                                pos.y + eye_height + bob_offset,
                                pos.z
                            );
                            camera.position = camera_pos;

                            camera.direction = direction;

                            camera.update();
                            camera_binding.update_3d(&queue, &camera);
                        }
                    }
                }
            }
        }

        // Now process all updates without borrowing rigid_body_set
        let mut alert_positions = Vec::new();
        for (component_id, position, euler) in physics_updates {
            let component_id_str = component_id.to_string();

                if let Some(meshes) = self.addon_meshes.get_mut("Game Composer") {
                    if let Some(character) = &mut self.player_character {
                    if let Some(model_id) = character.model_id.clone() { // character.model_id is the component id of the PlayerCharacter

                        if let Some(instance_model_data) = meshes
                            .iter_mut()
                            .find(|m| m.id == model_id.to_string())
                        {
                                        // Update is_moving based on velocity
                                        if let Some(rb_handle) = character.movement_rigid_body_handle {
                                            if let Some(rb) = self.rigid_body_set.get(rb_handle) {
                                                let velocity = rb.linvel();
                                                let horizontal_speed = (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
                                                character.is_moving = horizontal_speed > 0.1;
                                            }
                                        }

                                            instance_model_data.transform
                                                .update_position([position.x, position.y, position.z]);

                                            if self.game_mode && !self.game_settings.third_person {
                                                // In first-person mode, the player model should face the camera direction.
                                                instance_model_data.transform.update_rotation([0.0, -self.camera_yaw, 0.0]);
                                            } else {
                                                // update rotation based on direction of travel instead
                                            }
                                    }




                                }
                            }

                            if let Some(instance_model_data) = meshes
                                        .iter_mut()
                                        .find(|m| m.id == component_id.to_string())
                                    {
                                        if let Some(instance_npc_data) = self
                                            .npcs
                                            .iter_mut()
                                            .find(|m| m.model_id == component_id.to_string())
                                        {
                                            if (instance_model_data.transform.initial_position.is_none()) {
                                                instance_model_data.transform.initial_position = Some(Vector3::from([position.x, position.y, position.z]));
                                            }

                                            instance_model_data.transform
                                                .update_position([position.x, position.y, position.z]);
                                        }
                                    }

                }


            if let Some(models) = self
                .addon_models.get_mut("Game Composer") {



            // Update models
            if let Some(instance_model_data) = models
                .iter_mut()
                .find(|m| m.id == component_id.to_string())
            {
                if let Some(character) = &mut self.player_character {
                    if let Some(model_id) = character.model_id.clone() { // character.model_id is the component id of the PlayerCharacter
                        if model_id == component_id.to_string() {
                            // Update is_moving based on velocity
                            if let Some(rb_handle) = character.movement_rigid_body_handle {
                                if let Some(rb) = self.rigid_body_set.get(rb_handle) {
                                    let velocity = rb.linvel();
                                    let horizontal_speed = (velocity.x * velocity.x + velocity.z * velocity.z).sqrt();
                                    character.is_moving = horizontal_speed > 0.1;
                                }
                            }

                            instance_model_data.meshes.iter_mut().for_each(|mesh| {
                                mesh.transform
                                    .update_position([position.x, position.y, position.z]);

                                if self.game_mode && !self.game_settings.third_person {
                                    // In first-person mode, the player model should face the camera direction.
                                    mesh.transform.update_rotation([0.0, -self.camera_yaw, 0.0]);
                                } else {
                                    // update rotation based on direction of travel instead
                                }
                            });
                        }
                    }
                }

                // Handle NPC updates
                if let Some(instance_npc_data) = self
                    .npcs
                    .iter_mut()
                    .find(|m| m.model_id == component_id.to_string())
                {
                    instance_model_data.meshes.iter_mut().for_each(|mesh| {
                        if (mesh.transform.initial_position.is_none()) {
                            mesh.transform.initial_position = Some(Vector3::from([position.x, position.y, position.z]));
                        }

                        mesh.transform
                            .update_position([position.x, position.y, position.z]);
                    });

                    if let Some(player_character) = &mut self.player_character {
                        if let Some(first_mesh) = instance_model_data.meshes.get_mut(0) {

                            // Debug Spheres Logic
                            if self.display_debug_spheres {
                                if let Some(debug_sphere) = &instance_npc_data.debug_sphere {}
                                let mut radius = 0.0;
                                let mut debug_moving = false;
                                let mut color = [0.0, 1.0, 0.0]; // Default Green
                                let debug_sphere_position = if let Some(debug_sphere) = &instance_npc_data.debug_sphere {
                                    debug_sphere.transform.position
                                } else {
                                    Vector3::identity()
                                };

                                let distance_to_player = nalgebra::distance(&Point3::from(position), &Point3::from(debug_sphere_position));

                                match &instance_npc_data.test_behavior {
                                    crate::model_components::NPC::NPCBehavior::Wander(w) => radius = w.radius,
                                    crate::model_components::NPC::NPCBehavior::Melee(m) => {
                                        debug_moving = true;
                                        radius = m.chase.detection_radius;
                                        if distance_to_player <= radius {
                                            color = [1.0, 0.0, 0.0]; // Red
                                        } else {
                                            color = [1.0, 1.0, 0.0]; // Yellow
                                        }
                                    },
                                    crate::model_components::NPC::NPCBehavior::Ranged(r) => {
                                        debug_moving = true;
                                        radius = r.chase.detection_radius;
                                        if distance_to_player <= radius {
                                            color = [1.0, 0.0, 0.0]; // Red
                                        } else {
                                            color = [1.0, 1.0, 0.0]; // Yellow
                                        }
                                    },
                                    crate::model_components::NPC::NPCBehavior::Stateful(r) => {
                                        debug_moving = true;

                                        if let Some(melee) = &r.melee_behavior {
                                            radius = melee.chase.detection_radius
                                        }

                                        if let Some(ranged) = &r.ranged_behavior {
                                            radius = ranged.chase.detection_radius
                                        }

                                        if r.config.aggressiveness <= 0.1 {
                                            color = [0.0, 1.0, 0.0]; // Green (Friendly)
                                        } else {
                                            match r.current_state {
                                                BehaviorState::Wander => {
                                                    color = [0.0, 1.0, 0.0]; // Green
                                                },
                                                BehaviorState::Melee | BehaviorState::Ranged => {
                                                    if distance_to_player <= radius {
                                                        color = [1.0, 0.0, 0.0]; // Red (Should be engaging)
                                                    } else {
                                                        color = [1.0, 1.0, 0.0]; // Yellow (Dangerous but far)
                                                    }
                                                }
                                                _ => {
                                                    color = [0.0, 1.0, 0.0]; // Green
                                                }
                                            }
                                        }
                                    },
                                }

                                if radius > 0.0 {
                                    if instance_npc_data.debug_sphere.is_none() {

                                        println!("ADD DEBUG SPHERE");

                                        // Create sphere
                                        instance_npc_data.debug_sphere = Some(Sphere::new_wireframe(
                                            device,
                                            queue,
                                            &self.model_bind_group_layout,
                                            &self.group_bind_group_layout,
                                            &self.texture_render_mode_buffer,
                                            camera,
                                            1.0, // Unit sphere
                                            16,
                                            16,
                                            color,
                                            debug_moving
                                        ));

                                        if let Some(sphere) = &mut instance_npc_data.debug_sphere {
                                            if let Some(pos) = first_mesh.transform.initial_position {
                                                println!("Setting sphere pos {:?}", pos);
                                                sphere.transform.update_position([pos.x, pos.y, pos.z]);
                                            }
                                        }
                                    }

                                    if let Some(sphere) = &mut instance_npc_data.debug_sphere {
                                        sphere.transform.update_scale([radius, radius, radius]);

                                        if debug_moving {
                                            sphere.transform.update_position([position.x, position.y, position.z]);
                                        }

                                        // Update color
                                        sphere.update_color(queue, 1.0, 16, 16, color);
                                    }
                                }
                            }

                            // Check for death
                            if instance_npc_data.stats.health <= 0.0 && !instance_npc_data.is_dead {
                                instance_npc_data.is_dead = true;
                                println!("NPC {:?} has died!", instance_npc_data.id);
                            }

                            if instance_npc_data.is_dead && !instance_npc_data.on_death_dropped {
                                // Drop inventory items
                                let npc_pos = Vector3::new(position.x, position.y, position.z);

                                // Transfer all items from NPC inventory to pending drops
                                let items_to_drop: Vec<_> = instance_npc_data.inventory.items.drain(..).collect();
                                for item in items_to_drop {
                                    self.pending_loot_drops.push((npc_pos, item));
                                }

                                if let Some(weapon) = instance_npc_data.inventory.equipped_weapon.take() {
                                    self.pending_loot_drops.push((npc_pos, weapon));
                                }
                                if let Some(armor) = instance_npc_data.inventory.equipped_armor.take() {
                                    self.pending_loot_drops.push((npc_pos, armor));
                                }

                                instance_npc_data.on_death_dropped = true;
                                println!("NPC {:?} dropped loot at {:?}", instance_npc_data.id, npc_pos);
                            }

                            // Stealth and Suspicion Logic
                            if !instance_npc_data.is_dead {
                                if let crate::model_components::NPC::NPCBehavior::Stateful(behavior) = &mut instance_npc_data.test_behavior {
                                    if let crate::game_behaviors::stateful::BehaviorState::Wander = behavior.current_state {
                                        let player_handle = player_character.movement_rigid_body_handle.expect("No player handle");
                                        let player_rb = self.rigid_body_set.get(player_handle).expect("No player rb");
                                        let player_translation = player_rb.translation();
                                        let player_translation = Vector3::new(player_translation.x, player_translation.y, player_translation.z);

                                        let npc_pos = position; // current NPC position from physics (Vector3)
                                        let dist = nalgebra::distance(&Point3::from(npc_pos), &Point3::from(player_translation));

                                        if dist <= behavior.config.detection_radius {
                                            // Check Line of Sight
                                            let ray_dir = (player_translation - npc_pos).normalize();
                                            let ray = Ray::new(Point3::from(npc_pos + ray_dir * 1.0), ray_dir);

                                            let mut filter = QueryFilter::default().exclude_rigid_body(first_mesh.rigid_body_handle.unwrap());

                                            let mut has_los = false;
                                            if let Some((handle, toi)) = self.query_pipeline.cast_ray(
                                                &self.rigid_body_set,
                                                &self.collider_set,
                                                &ray,
                                                dist,
                                                true,
                                                filter
                                            ) {
                                                if let Some(collider) = self.collider_set.get(handle) {
                                                    if collider.parent() == Some(player_handle) {
                                                        has_los = true;
                                                    }
                                                }
                                            }

                                            if has_los {
                                                // Increase suspicion based on distance (closer = faster)
                                                let suspicion_gain = (1.0 - (dist / behavior.config.detection_radius)) * dt * 2.0;
                                                instance_npc_data.suspicion = (instance_npc_data.suspicion + suspicion_gain).min(1.0);

                                                if instance_npc_data.suspicion >= 1.0 {
                                                    // Spotted!
                                                    match behavior.config.combat_type {
                                                        crate::game_behaviors::stateful::CombatType::Melee => {
                                                            if behavior.melee_behavior.is_some() {
                                                                behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Melee;
                                                                alert_positions.push((npc_pos, 30.0));
                                                            }
                                                        },
                                                        crate::game_behaviors::stateful::CombatType::Ranged => {
                                                            if behavior.ranged_behavior.is_some() {
                                                                behavior.current_state = crate::game_behaviors::stateful::BehaviorState::Ranged;
                                                                alert_positions.push((npc_pos, 30.0));
                                                            }
                                                        }
                                                    }
                                                }
                                            } else {
                                                // Decay suspicion if out of sight
                                                instance_npc_data.suspicion = (instance_npc_data.suspicion - dt * 0.5).max(0.0);
                                            }
                                        } else {
                                             // Decay suspicion if out of range
                                             instance_npc_data.suspicion = (instance_npc_data.suspicion - dt * 0.2).max(0.0);
                                        }
                                    } else {
                                        // In combat, suspicion is effectively 1.0
                                        instance_npc_data.suspicion = 1.0;
                                    }
                                }
                            }

                            if !instance_npc_data.is_talking && !instance_npc_data.is_dead {
                                let squad_leader_pos = if let Some(squad_id) = &instance_npc_data.squad_id {
                                    squad_leaders.get(squad_id).map(|pos| *pos)
                                } else {
                                    None
                                };

                                // Don't follow yourself if you are the current leader in the map
                                let squad_leader_pos = if let Some(leader_pos) = squad_leader_pos {
                                    if nalgebra::distance(&Point3::from(position), &leader_pos) < 0.1 {
                                        None
                                    } else {
                                        Some(leader_pos)
                                    }
                                } else {
                                    None
                                };

                                let (result, just_spotted) = if instance_npc_data.behavior_id.is_none() {
                                    instance_npc_data.test_behavior.update(
                                        &mut self.rigid_body_set,
                                        &self.collider_set,
                                        &self.query_pipeline,
                                        first_mesh
                                            .rigid_body_handle
                                            .expect("Couldn't get rigid body handle"),
                                        player_character
                                            .movement_rigid_body_handle
                                            .expect("Couldn't get rigid body handle"),
                                        &first_mesh.rapier_collider,
                                        &mut first_mesh.transform,
                                        instance_npc_data.stats.stamina, // Use NPC's actual stamina
                                        dt,
                                        instance_npc_data.forward_axis,
                                        squad_leader_pos,
                                    )
                                } else {
                                    (None, false)
                                };

                                if just_spotted {
                                    let npc_pos = Vector3::new(position.x, position.y, position.z);
                                    // Alert nearby NPCs within 30 units
                                    alert_positions.push((npc_pos, 30.0));
                                }

                                if let Some((damage, debug_line)) = result {
                                    if damage > 0.0 {
                                        player_character.handle_incoming_damage(damage);
                                    }

                                    if self.game_settings.show_hitscan_line {
                                        if let Some((start, end)) = debug_line {
                                            let mut debug_cube = Cube::new(
                                                &device,
                                                &queue,
                                                &self.model_bind_group_layout,
                                                &self.group_bind_group_layout,
                                                &self.texture_render_mode_buffer,
                                                camera,
                                            );

                                            let dir = (end - start).normalize();
                                            let length = nalgebra::distance(&start, &end);

                                            debug_cube.transform.update_position([start.x, start.y, start.z]);
                                            debug_cube.transform.update_scale([0.02, 0.02, length]);

                                            let rotation = UnitQuaternion::rotation_between(&Vector3::z(), &dir).unwrap_or_default();
                                            debug_cube.transform.update_rotation_quat([
                                                rotation.coords.x,
                                                rotation.coords.y,
                                                rotation.coords.z,
                                                rotation.coords.w,
                                            ]);

                                            debug_cube.transform.update_uniform_buffer(&queue);

                                            self.debug_rays.push(DebugRay {
                                                cube: debug_cube,
                                                expires_at: Instant::now() + Duration::from_millis(500),
                                            });
                                        }
                                    }
                                }
                            }

                            let desired_animation_name = if instance_npc_data.is_dead {
                                Some("Death".to_string())
                            } else if instance_npc_data.behavior_id.is_none() {
                                Some(instance_npc_data.test_behavior.get_animation_name().to_string())
                            } else {
                                None
                            };

                            // Find the animation index in the model
                            if let Some(anim_name) = desired_animation_name {
                                if let Some(animation_index) = instance_model_data.animations.iter()
                                        .position(|anim| anim.name.to_lowercase().contains(&anim_name.to_lowercase())) {
                                    // If the animation is not already playing, switch to it
                                    if instance_npc_data.animation_state.animation_index != animation_index {
                                        instance_npc_data.animation_state.animation_index = animation_index;
                                        instance_npc_data.animation_state.current_time = 0.0; // Reset time
                                    }
                                }
                            }

                            // Update debug spheres with suspicion color
                            if let Some(sphere) = &mut instance_npc_data.debug_sphere {
                                let color = if instance_npc_data.is_dead {
                                    [0.2, 0.2, 0.2] // Grey for dead
                                } else {
                                    // Interpolate Green -> Yellow -> Red
                                    if instance_npc_data.suspicion < 0.5 {
                                        let t = instance_npc_data.suspicion * 2.0;
                                        [t, 1.0, 0.0] // Green to Yellow
                                    } else {
                                        let t = (instance_npc_data.suspicion - 0.5) * 2.0;
                                        [1.0, 1.0 - t, 0.0] // Yellow to Red
                                    }
                                };
                                sphere.update_color(queue, 1.0, 16, 16, color);
                            }
                        }
                    }
                }
            }

            }
        }

        // Process deferred alerts
        for (alert_pos, radius) in alert_positions {
            self.alert_nearby_npcs(alert_pos, radius);
        }

        if let Some(models) = self
                .addon_models.get_mut("Game Composer") {

            let mut matching_pairs: Vec<(usize, usize)> = Vec::new();
            for (model_idx, model) in models.iter().enumerate() {
                if let Some(npc_idx) = self.npcs.iter().position(|n| n.model_id == model.id) {
                    matching_pairs.push((model_idx, npc_idx));
                }
            }

            // Pass the whole collections and indices to the animation system
            crate::core::animation_system::update_animations(
                models,
                &mut self.npcs,
                &mut self.collectables,
                &mut self.player_character,
                &matching_pairs,
                dt,
                queue,
            );
        }
    }

    pub fn update_rapier(&mut self) {
        self.query_pipeline.update(&self.collider_set);
    }

    pub fn add_arrow_colliders(&mut self) {
        // self.translation_gizmo.arrows.iter_mut().for_each(|arrow| {
        //     println!("adding arrow collider");
        //     let collider_handle = self.collider_set.insert(arrow.rapier_collider.clone());
        //     arrow.collider_handle = Some(collider_handle);
        // });
    }

    pub fn update_arrow_collider_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        // self.translation_gizmo.arrows.iter().for_each(|arrow| {
        //     // Create translation vector based on the arrow's axis
        //     let translation = match arrow.axis {
        //         0 => vector![position[0], position[1], position[2]], // X axis
        //         1 => vector![position[0], position[1], position[2]], // Y axis
        //         _ => vector![position[0], position[1], position[2]], // Z axis
        //     };

        //     let isometry =
        //         nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

        //     if let Some(collider) = self
        //         .collider_set
        //         .get_mut(arrow.collider_handle.expect("Couldn't get collider handle"))
        //     {
        //         collider.set_position(isometry);
        //         // println!(
        //         //     "Updated collider for axis {}: pos={:?}",
        //         //     arrow.axis, translation
        //         // );
        //     }
        // });
    }

    pub fn update_player_character_position(&mut self, translation: Vector3<f32>, delta_time: f32, camera: &mut SimpleCamera) {
        if let Some(player_character) = &mut self.player_character {
            // Collision filter (typically you want to collide with everything except other characters)
            let filter = QueryFilter::default()
                .exclude_rigid_body(
                    player_character
                        .movement_rigid_body_handle
                        .expect("Couldn't get rigid body handle"),
                )
                .exclude_collider(
                    player_character
                        .collider_handle
                        .expect("Couldn't get collider handle"),
                )
                .exclude_sensors(); // Typically don't collide with trigger volumes

            // Current character position
            let character_pos = Isometry3::translation(
                camera.position.x,
                camera.position.y - 0.9, // Offset by half height to put camera at top
                camera.position.z,
            );

            let effective_character_movement = player_character.character_controller.move_shape(
                delta_time,
                &self.rigid_body_set,
                &self.collider_set,
                &self.query_pipeline,
                player_character.movement_shape.shape(),
                &character_pos,
                translation,
                filter,
                |collision| {
                },
            );

            camera.position = Point3::new(
                camera.position.x + translation.x,
                camera.position.y - 0.9 + translation.y,
                camera.position.z + translation.z,
            );
        }
    }

    pub fn update_player_collider_position(
        &mut self,
        position: [f32; 3],
    ) {
        if let Some(player_character) = &mut self.player_character {

            // Create translation vector based on the arrow's axis
            let translation = vector![position[0], position[1], position[2]];

            let isometry =
                nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

            if let Some(collider) = self.collider_set.get_mut(
                player_character
                    .collider_handle
                    .expect("Couldn't get mesh collider handle"),
            ) {
                collider.set_position(isometry);
            }
        }
    }

    pub fn update_model_collider_position(
        &mut self,
        position: [f32; 3],
    ) {
        self.models.iter().for_each(|model| {
            model.meshes.iter().for_each(|mesh| {
                // Create translation vector based on the arrow's axis
                let translation = vector![position[0], position[1], position[2]];

                let isometry =
                    nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

                if let Some(collider) = self.collider_set.get_mut(
                    mesh.collider_handle
                        .expect("Couldn't get mesh collider handle"),
                ) {
                    collider.set_position(isometry);
                }
            });
        });
    }

    pub fn update_player_state(&mut self, delta_time: f32) {
        if let Some(player_character) = &mut self.player_character {
            // Regenerate stamina if not sprinting
            if player_character.movement_state != MovementState::Sprinting {
                if player_character.stats.stamina < 100.0 {
                    player_character.stats.stamina += 5.0 * delta_time;
                }
            }

            // Interpolate Eye Height (Smooth Crouch)
            let lerp_speed = 10.0;
            player_character.current_eye_height = player_character.current_eye_height + (player_character.target_eye_height - player_character.current_eye_height) * lerp_speed * delta_time;
        }
    }

    pub fn apply_player_movement(&mut self, direction: Vector3<f32>, delta_time: f32) {
        if let Some(player_character) = &mut self.player_character {
            let mut current_position = None;
            let mut current_velocity = None;

            if let Some(rigidbody) = self.rigid_body_set.get_mut(
                player_character
                    .movement_rigid_body_handle
                    .expect("Couldn't get mesh rigidbody handle"),
            ) {
                current_position = Some(*rigidbody.translation());
                current_velocity = Some(*rigidbody.linvel());
            }

            let current_position = current_position.expect("Couldn't get position");
            let current_velocity = current_velocity.expect("Couldn't get velocity");

            // Collision filter
            let filter = QueryFilter::default()
                .exclude_rigid_body(
                    player_character
                        .movement_rigid_body_handle
                        .expect("Couldn't get rigid body handle"),
                )
                .exclude_collider(
                    player_character
                        .collider_handle
                        .expect("Couldn't get collider handle"),
                )
                .exclude_sensors();

            // --- Movement Logic ---
            let mut movement_speed = player_character.movement_config.walk_speed;

            // Handle Stamina for Sprinting
            if player_character.movement_state == MovementState::Sprinting {
                 if player_character.stats.stamina > 0.0 {
                     movement_speed = player_character.movement_config.sprint_speed;
                     player_character.stats.stamina -= 10.0 * delta_time; // Drain stamina
                 } else {
                     // Out of stamina, force walk
                     player_character.movement_state = MovementState::Walking;
                     movement_speed = player_character.movement_config.walk_speed;
                 }
            }

            match player_character.movement_state {
                MovementState::Crouching => movement_speed = player_character.movement_config.crouch_speed,
                MovementState::Prone => movement_speed = player_character.movement_config.prone_speed,
                _ => {}
            }

            player_character.movement_speed = movement_speed; // Update stored speed

            // --- Camera Bob ---
            // Bobbing only when moving and grounded
            if player_character.is_grounded && direction.magnitude() > 0.0 {
                 let bob_speed = if player_character.movement_state == MovementState::Sprinting { 15.0 } else { 10.0 };
                 player_character.camera_bob_timer += bob_speed * delta_time;
                 let bob_height = if player_character.movement_state == MovementState::Sprinting { 0.15 } else { 0.08 };
                 player_character.camera_bob_amount = (player_character.camera_bob_timer.sin()) * bob_height;
            } else {
                 // Decay bob when stopped
                 player_character.camera_bob_amount = player_character.camera_bob_amount * 0.9;
                 player_character.camera_bob_timer = 0.0;
            }

            // Target Eye Height
             let standing_height = 3.5;
             match player_character.movement_state {
                MovementState::Crouching => player_character.target_eye_height = standing_height * 0.6,
                MovementState::Prone => player_character.target_eye_height = standing_height * 0.2,
                _ => player_character.target_eye_height = standing_height,
            }

            // IMPORTANT: This should be a movement DELTA, not absolute position
            let desired_translation = vector![
                direction.x * movement_speed * delta_time,
                current_velocity.y * delta_time, // Preserve gravity
                direction.z * movement_speed * delta_time
            ];

            // Create the character position (Isometry)
            let character_pos = Isometry3::translation(
                current_position.x,
                current_position.y,
                current_position.z,
            );

            let effective_character_movement = player_character.character_controller.move_shape(
                delta_time,
                &self.rigid_body_set,
                &self.collider_set,
                &self.query_pipeline,
                player_character.movement_shape.shape(),
                &character_pos,
                desired_translation,
                filter,
                |_collision| {},
            );

            // Store grounded state for jump logic
            player_character.is_grounded = effective_character_movement.grounded;

            if let Some(rigidbody) = self.rigid_body_set.get_mut(
                player_character
                    .movement_rigid_body_handle
                    .expect("Couldn't get mesh rigidbody handle"),
            ) {
                // effective_character_movement.translation is a DELTA, so add it to current position
                let new_position = current_position + effective_character_movement.translation;
                rigidbody.set_translation(new_position, true);
            }
        }
    }

    pub fn apply_jump_impulse(&mut self) {
        if let Some(player_character) = &mut self.player_character {
            // Use the grounded state from character controller
            if player_character.is_grounded {
                if let Some(rigidbody) = self.rigid_body_set.get_mut(
                    player_character
                        .movement_rigid_body_handle
                        .expect("Couldn't get mesh rigidbody handle"),
                ) {
                    println!("Jump!");
                    let jump_force = 8.0;

                    // for kinematic character
                    let mut current_velocity = rigidbody.linvel().clone();

                    // Set the upward velocity
                    current_velocity.y = jump_force;
                    rigidbody.set_linvel(current_velocity, true)
                }
            }
        }
    }

    pub fn update_player_rigidbody_position(
        &mut self,
        position: [f32; 3],
    ) {
        if let Some(player_character) = &mut self.player_character {

            // Create translation vector based on the arrow's axis
            let translation = vector![position[0], position[1], position[2]];

            let isometry =
                nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

            if let Some(rigidbody) = self.rigid_body_set.get_mut(
                player_character
                    .movement_rigid_body_handle
                    .expect("Couldn't get mesh rigidbody handle"),
            ) {
                rigidbody.set_position(isometry, true);
            }
        }
    }

    pub fn update_model_rigidbody_position(
        &mut self,
        position: [f32; 3],
    ) {
        self.models.iter().for_each(|model| {
            model.meshes.iter().for_each(|mesh| {
                // Create translation vector based on the arrow's axis
                let translation = vector![position[0], position[1], position[2]];

                let isometry =
                    nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

                if let Some(rigidbody) = self.rigid_body_set.get_mut(
                    mesh.rigid_body_handle
                        .expect("Couldn't get mesh collider handle"),
                ) {
                    rigidbody.set_position(isometry, true);
                }
            });
        });
    }

    pub fn update_landscape_collider_position(
        &mut self,
        //arrows: &[AxisArrow; 3],
        position: [f32; 3],
    ) {
        // self.terrain_managers.iter().for_each(|landscape| {
        //     // Create translation vector based on the arrow's axis
        //     let translation = vector![position[0], position[1], position[2]];

        //     let isometry =
        //         nalgebra::Isometry3::translation(translation.x, translation.y, translation.z);

        //     // if let Some(collider) = self.collider_set.get_mut(
        //     //     landscape
        //     //         .collider_handle
        //     //         .expect("Couldn't get landscape collider handle"),
        //     // ) {
        //     //     collider.set_position(isometry);
        //     // }
        // });
    }

    pub fn add_collider(&mut self, component_id: String, component_kind: ComponentKind, visual_type: Option<VisualType>) {
        match component_kind {
            ComponentKind::Landscape => {
                println!("Adding landscape collider");

                // should be added as part of terrain manager
                let landscape = self
                    .addon_landscapes
                    .iter_mut()
                    .find(|l| l.0 == "Game Composer");

                if let Some(landscape) = landscape {
                    let landscape = landscape.1.get_mut(0);

                    if let Some(landscape) = landscape {
                        let rigid_body_handle = self
                            .rigid_body_set
                            .insert(landscape.rapier_rigidbody.clone());
                        landscape.rigid_body_handle = Some(rigid_body_handle);

                        // now associate rigidbody with collider
                        let collider_handle = self.collider_set.insert_with_parent(
                            landscape.rapier_heightfield.clone(),
                            rigid_body_handle,
                            &mut self.rigid_body_set,
                        );
                        landscape.collider_handle = Some(collider_handle);
                    }
                }
            }
            ComponentKind::Landscape3D => {
                println!("Adding landscape3d collider");

                let mut found_landscape = None;
                for landscapes in self.addon_landscape3ds.values_mut() {
                    if let Some(landscape) = landscapes.iter_mut().find(|l| l.id == component_id) {
                        found_landscape = Some(landscape);
                        break;
                    }
                }

                if let Some(landscape) = found_landscape {
                    let rigid_body_handle = self
                        .rigid_body_set
                        .insert(landscape.rapier_rigidbody.clone());
                    landscape.rigid_body_handle = Some(rigid_body_handle);

                    let collider_handle = self.collider_set.insert_with_parent(
                        landscape.rapier_collider.clone(),
                        rigid_body_handle,
                        &mut self.rigid_body_set,
                    );
                    landscape.collider_handle = Some(collider_handle);
                }
            }
            ComponentKind::Model => {
                if let Some(models) = self.addon_models.get_mut("Game Composer") {
                    if let Some(renderer_model) = models.iter_mut().find(|m| m.id == component_id) {
                        renderer_model.meshes.iter_mut().for_each(|mesh| {
                            let rigid_body_handle =
                                self.rigid_body_set.insert(mesh.rapier_rigidbody.clone());
                            mesh.rigid_body_handle = Some(rigid_body_handle);

                            let collider_handle = self.collider_set.insert_with_parent(
                                mesh.rapier_collider.clone(),
                                rigid_body_handle,
                                &mut self.rigid_body_set,
                            );
                            mesh.collider_handle = Some(collider_handle);
                        });
                    }
                }
            },
            ComponentKind::Collectable => {
                if let Some(models) = self.addon_models.get_mut("Game Composer") {
                    if let Some(renderer_model) = models.iter_mut().find(|m| m.id == component_id) {
                        renderer_model.meshes.iter_mut().for_each(|mesh| {
                            let existing_iso = mesh.rapier_rigidbody.position().clone();

                            if let Ok(uuid) = Uuid::from_str(&component_id) {
                                let rapier_collider = ColliderBuilder::ball(0.5)
                                    .sensor(true)
                                    .friction(0.7)
                                    .restitution(0.0)
                                    .density(1.0)
                                    .user_data(uuid.as_u128())
                                    .build();

                                let dynamic_body = RigidBodyBuilder::fixed()
                                    .additional_mass(70.0)
                                    .linear_damping(0.1)
                                    .position(existing_iso)
                                    .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                                    .user_data(uuid.as_u128())
                                    .build();

                                mesh.rapier_collider = rapier_collider;
                                mesh.rapier_rigidbody = dynamic_body;

                                let rigid_body_handle =
                                    self.rigid_body_set.insert(mesh.rapier_rigidbody.clone());
                                mesh.rigid_body_handle = Some(rigid_body_handle);

                                let collider_handle = self.collider_set.insert_with_parent(
                                    mesh.rapier_collider.clone(),
                                    rigid_body_handle,
                                    &mut self.rigid_body_set,
                                );
                                mesh.collider_handle = Some(collider_handle);
                            }
                        });
                    }
                }
            },
            ComponentKind::NPC => {
                if visual_type == Some(VisualType::Model) {
                    if let Some(models) = self.addon_models.get_mut("Game Composer") {
                        if let Some(renderer_model) = models.iter_mut().find(|m| m.id == component_id) {
                            renderer_model.meshes.iter_mut().for_each(|mesh| {
                                let existing_iso = mesh.rapier_rigidbody.position().clone();

                                if let Ok(uuid) = Uuid::from_str(&component_id) {
                                    let rapier_collider = ColliderBuilder::capsule_y(1.0, 0.5)
                                        .friction(0.7)
                                        .restitution(0.0)
                                        .density(1.0)
                                        .user_data(uuid.as_u128())
                                        .build();

                                    let dynamic_body = RigidBodyBuilder::dynamic()
                                        .additional_mass(70.0)
                                        .linear_damping(0.1)
                                        .position(existing_iso)
                                        .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                                        .user_data(uuid.as_u128())
                                        .build();

                                    mesh.rapier_collider = rapier_collider;
                                    mesh.rapier_rigidbody = dynamic_body;

                                    let rigid_body_handle =
                                        self.rigid_body_set.insert(mesh.rapier_rigidbody.clone());
                                    mesh.rigid_body_handle = Some(rigid_body_handle);

                                    let collider_handle = self.collider_set.insert_with_parent(
                                        mesh.rapier_collider.clone(),
                                        rigid_body_handle,
                                        &mut self.rigid_body_set,
                                    );
                                    mesh.collider_handle = Some(collider_handle);
                                }
                            });
                        }
                    }
                }

                if visual_type == Some(VisualType::CustomMesh) {
                    // Try CustomMesh
                        if let Some(mesh) = self.npcs.iter_mut().find(|m| m.id == component_id) {
                            let transform = mesh.transform.as_ref().expect("Couldn't get transform");
                            let existion_pos = transform.position;

                            let existing_iso = Isometry3::translation(
                                existion_pos.x,
                                existion_pos.y,
                                existion_pos.z,
                            );

                            if let Ok(uuid) = Uuid::from_str(&component_id) {
                                let rapier_collider = ColliderBuilder::capsule_y(1.0, 0.5)
                                    .friction(0.7)
                                    .restitution(0.0)
                                    .density(1.0)
                                    .user_data(uuid.as_u128())
                                    .build();

                                let dynamic_body = RigidBodyBuilder::dynamic()
                                    .additional_mass(70.0)
                                    .linear_damping(0.1)
                                    .position(existing_iso)
                                    .locked_axes(LockedAxes::ROTATION_LOCKED_X | LockedAxes::ROTATION_LOCKED_Z)
                                    .user_data(uuid.as_u128())
                                    .build();

                                mesh.rapier_collider = Some(rapier_collider);
                                mesh.rapier_rigidbody = Some(dynamic_body);

                                let rigid_body_handle =
                                    self.rigid_body_set.insert(mesh.rapier_rigidbody.as_ref().expect("Couldn't get rigidbody").clone());
                                mesh.rigid_body_handle = Some(rigid_body_handle);

                                let collider_handle = self.collider_set.insert_with_parent(
                                    mesh.rapier_collider.as_ref().expect("Couldn't get collider").clone(),
                                    rigid_body_handle,
                                    &mut self.rigid_body_set,
                                );
                                mesh.collider_handle = Some(collider_handle);
                            }
                        }
                }
            }
,
            ComponentKind::PlayerCharacter => {
                // NOTE: PlayerCharacter already inserted into sets in PlayerCharacter.rs!
            },
            ComponentKind::PointLight => return,
            ComponentKind::WaterPlane => return,
            _ => return,
        }
    }
}
