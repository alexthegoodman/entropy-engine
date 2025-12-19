use nalgebra::{Vector3, UnitQuaternion, Quaternion, Matrix4};

use crate::art_assets::Model::{AnimationChannel, AnimationValues, Model, Node};
use crate::core::AnimationState::AnimationState;
use crate::core::PlayerCharacter::NPC;

pub fn update_animations(
    // models: &mut [&mut Model],
    // animation_states: &mut [&mut AnimationState],
    models: &mut [Model],
    npcs: &mut [NPC],
    pairs: &[(usize, usize)],
    delta_time: f32,
    queue: &wgpu::Queue,
) {
    // for (model, anim_state) in models.iter_mut().zip(animation_states.iter_mut()) {
    for &(model_idx, npc_idx) in pairs {
        let model = &mut models[model_idx];
        let anim_state = &mut npcs[npc_idx].animation_state;
        
        if !anim_state.is_playing {
            continue;
        }

        anim_state.update(delta_time);

        if model.animations.is_empty() {
            continue;
        }

        let animation = &model.animations[anim_state.animation_index];
        let time = anim_state.current_time % animation.channels.get(0).and_then(|c| c.sampler.times.last()).unwrap_or(&1.0);

        for channel in &animation.channels {
            let node = &mut model.nodes[channel.target_node];

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

        for node in &model.nodes {
            let raw_matrix = crate::core::Transform_2::matrix4_to_raw_array(&node.global_transform.transpose());
            queue.write_buffer(&node.transform.uniform_buffer, 0, bytemuck::cast_slice(&raw_matrix));
        }
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
