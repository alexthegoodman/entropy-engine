use nalgebra::{Vector3, UnitQuaternion, Quaternion, Matrix4, Matrix3};

use crate::{art_assets::Model::{AnimationChannel, AnimationValues, Model, Node}, model_components::{Collectable::Collectable, PlayerCharacter::PlayerCharacter}};
use crate::core::AnimationState::AnimationState;
use crate::model_components::NPC::NPC;

fn attach_weapon_to_bone(
    models: &mut [Model],
    collectables: &mut [Collectable],
    player_model_index: usize,
    weapon_model_id: &str,
    bone_name: &str,
    queue: &wgpu::Queue,
) {
    // Find the bone index in the player model
    let bone_index = models[player_model_index]
        .nodes
        .iter()
        .position(|node| node.name == bone_name);

    if let Some(bone_index) = bone_index {
        // Get the bone's global transform (which is local to the model)
        let bone_local_transform = models[player_model_index].nodes[bone_index].global_transform;

        // Get the player model's world transform from its first mesh
        let player_model_transform = if let Some(player_mesh) = models[player_model_index].meshes.get(0) {
            player_mesh.transform.update_transform() // This gets the matrix
        } else {
            nalgebra::Matrix4::identity()
        };

        let final_transform = player_model_transform * bone_local_transform;

        // Decompose the final transform matrix
        let translation = final_transform.column(3).xyz();

        let col0 = final_transform.column(0).xyz();
        let col1 = final_transform.column(1).xyz();
        let col2 = final_transform.column(2).xyz();

        let scale_x = col0.magnitude();
        let scale_y = col1.magnitude();
        let scale_z = col2.magnitude();
        let scale = nalgebra::Vector3::new(scale_x, scale_y, scale_z);

        let inv_scale_x = if scale_x == 0.0 { 0.0 } else { 1.0 / scale_x };
        let inv_scale_y = if scale_y == 0.0 { 0.0 } else { 1.0 / scale_y };
        let inv_scale_z = if scale_z == 0.0 { 0.0 } else { 1.0 / scale_z };

        let rotation_matrix = nalgebra::Matrix3::from_columns(&[
            col0 * inv_scale_x,
            col1 * inv_scale_y,
            col2 * inv_scale_z,
        ]);
        let rotation = nalgebra::UnitQuaternion::from_matrix(&rotation_matrix);

        // Find the weapon model and update its transform
        if let Some(weapon_collectable) = collectables
            .iter_mut()
            .find(|model| model.id == weapon_model_id)
        {
            if let Some(weapon_model) = models
                .iter_mut()
                .find(|model| model.id == weapon_collectable.model_id)
            {
                for mesh in &mut weapon_model.meshes {
                    mesh.transform.position = translation.into();
                    mesh.transform.rotation = rotation;
                    mesh.transform.scale = scale.into();
                    // println!("Update mesh uniform {:?} {:?} {:?}", weapon_model.id, weapon_model.hide_from_world, mesh.transform.position);
                    mesh.transform.update_uniform_buffer(queue);
                }
            }
        }
    }
}

pub fn update_animations(
    // models: &mut [&mut Model],
    // animation_states: &mut [&mut AnimationState],
    models: &mut [Model],
    npcs: &mut [NPC],
    collectables: &mut [Collectable],
    player_character: &mut Option<PlayerCharacter>,
    pairs: &[(usize, usize)],
    delta_time: f32,
    queue: &wgpu::Queue,
) {
    for &(model_idx, npc_idx) in pairs {
        let model = &mut models[model_idx];
        let anim_state = &mut npcs[npc_idx].animation_state;
        
        if !anim_state.is_playing {
            continue;
        }

        // DEBUG: Print which animation is playing
        // if model.animations.len() > anim_state.animation_index {
        //     println!("Playing animation: {} (index {})", 
        //              model.animations[anim_state.animation_index].name,
        //              anim_state.animation_index);
        // }

        process_animation(model, anim_state, delta_time, queue);
    }

    // if let Some(player) = player_character {
    //     if let Some(player_model_id) = &player.model_id {
    //         if let Some(player_model_index) = models.iter().position(|m| &m.id == player_model_id) {
    //             if let Some(weapon_id) = &player.default_weapon_id {
    //                 // Find the component for the weapon
    //                 // This is a bit of a stretch, assuming the weapon component ID is the model ID
    //                 attach_weapon_to_bone(models, collectables, player_model_index, weapon_id, "LowerArm.r", queue);
    //             }
    //         }
    //     }
    // }
    // Process player animation
    if let Some(player) = player_character.as_mut() {
        if let Some(player_model_id) = &player.model_id {
            if let Some(player_model_index) = models.iter().position(|m| &m.id == player_model_id) {
                let model = &mut models[player_model_index];
                let anim_state = &mut player.animation_state;
                
                if anim_state.is_playing {
                    // Same animation processing as NPCs
                    process_animation(model, anim_state, delta_time, queue);
                }

                // Handle weapon attachment
                if let Some(weapon_id) = &player.default_weapon_id {
                    attach_weapon_to_bone(models, collectables, player_model_index, weapon_id, "LowerArm.r", queue);
                }
            }
        }
    }
}

fn process_animation(model: &mut Model, anim_state: &mut AnimationState, delta_time: f32, queue: &wgpu::Queue) {
    anim_state.update(delta_time);

    if model.animations.is_empty() {
        return;
    }

    let animation = &model.animations[anim_state.animation_index];
    let time = anim_state.current_time % animation.channels.get(0)
        .and_then(|c| c.sampler.times.last())
        .unwrap_or(&1.0);

    for channel in &animation.channels {
        let node = &mut model.nodes[channel.target_node];
        let is_root = model.root_nodes.contains(&channel.target_node);
        
        if is_root && channel.target_property == "rotation" {
            continue;
        }

        // Find the two keyframes to interpolate between
        let (key1, key2) = find_keyframes(&channel.sampler.times, time);
        
        if key1 == key2 {
            // No interpolation needed, just set the value
            match &channel.sampler.values {
                AnimationValues::Translation(translations) => {
                    node.transform.position = Vector3::from(translations[key1]);
                }
                AnimationValues::Rotation(rotations) => {
                    let rot = rotations[key1];
                    node.transform.rotation = UnitQuaternion::from_quaternion(Quaternion::new(rot[3], rot[0], rot[1], rot[2]));
                }
                AnimationValues::Scale(scales) => {
                    node.transform.scale = Vector3::from(scales[key1]);
                }
            }
            continue;
        }

        let t = (time - channel.sampler.times[key1]) / (channel.sampler.times[key2] - channel.sampler.times[key1]);

        match &channel.sampler.values {
            AnimationValues::Translation(translations) => {
                let start = Vector3::from(translations[key1]);
                let end = Vector3::from(translations[key2]);
                let interpolated = start.lerp(&end, t);
                node.transform.position = interpolated;
            }
            AnimationValues::Rotation(rotations) => {
                let start_rot = rotations[key1];
                let end_rot = rotations[key2];
                let start = UnitQuaternion::from_quaternion(Quaternion::new(start_rot[3], start_rot[0], start_rot[1], start_rot[2]));
                let end = UnitQuaternion::from_quaternion(Quaternion::new(end_rot[3], end_rot[0], end_rot[1], end_rot[2]));
                let interpolated = start.slerp(&end, t);
                node.transform.rotation = interpolated;
            }
            AnimationValues::Scale(scales) => {
                let start = Vector3::from(scales[key1]);
                let end = Vector3::from(scales[key2]);
                let interpolated = start.lerp(&end, t);
                node.transform.scale = interpolated;
            }
        }
    }
    
    update_global_transforms(model);

    // Update skinning
    if let Some(joint_matrices_buffer) = model.joint_matrices_buffer.as_ref() {
        if let Some(skin) = model.skins.first() {
            let mut joint_transforms: Vec<[f32; 16]> = Vec::with_capacity(skin.joints.len());
            for (joint_node_index, inverse_bind_matrix) in skin.joints.iter().zip(skin.inverse_bind_matrices.iter()) {
                let joint_node = &model.nodes[*joint_node_index];
                let skinning_matrix = joint_node.global_transform * inverse_bind_matrix;
                joint_transforms.push(skinning_matrix.as_slice().try_into().unwrap());
            }
            queue.write_buffer(joint_matrices_buffer, 0, bytemuck::cast_slice(&joint_transforms));
        }
    }
    
    for node in &model.nodes {
        let raw_matrix = crate::core::Transform_2::matrix4_to_raw_array(&node.global_transform);
        queue.write_buffer(&node.transform.uniform_buffer, 0, bytemuck::cast_slice(&raw_matrix));
    }
}

fn update_global_transforms(model: &mut Model) {
    let root_nodes = model.root_nodes.clone();
    for node_index in root_nodes {
        update_node_transforms(&mut model.nodes, &Matrix4::identity(), node_index);
    }
}

fn update_node_transforms(
    nodes: &mut [Node],
    parent_transform: &Matrix4<f32>,
    node_index: usize,
) {
    let (global_transform, children) = {
        let node = &mut nodes[node_index];
        let local_transform = node.transform.update_transform();
        node.global_transform = parent_transform * local_transform;
        (node.global_transform, node.children.clone())
    };

    for child_index in children {
        update_node_transforms(nodes, &global_transform, child_index);
    }
}


fn find_keyframes(times: &[f32], time: f32) -> (usize, usize) {
    if times.is_empty() {
        return (0, 0);
    }
    if time <= times[0] {
        return (0, 0);
    }
    if time >= *times.last().unwrap() {
        let last_index = times.len() - 1;
        return (last_index, last_index);
    }

    // Binary search to find the current frame
    match times.binary_search_by(|probe| probe.partial_cmp(&time).unwrap()) {
        Ok(index) => (index, index),
        Err(index) => (index - 1, index),
    }
}