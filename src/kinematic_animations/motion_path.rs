// use glam::{Quat, Vec3};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

/// Example usage:
/// ```rust
/// let leg_motion = SkeletonMotionPath {
///     id: "walk_right_leg".to_string(),
///     target: SkeletonTarget {
///         skeleton_id: "98c9bb55-91de-472a-8279-5f86391c4993".to_string(),
///         part_id: "right_leg".to_string(),
///         ik_chain_id: Some("right_leg_ik".to_string()),
///         joint_id: None,
///     },
///     constraints: MotionConstraints {
///         rotation_limits: [[-45.0, -120.0, -45.0], [120.0, 45.0, 45.0]],
///         preserve_volume: true,
///         max_stretch: 1.0,
///     },
///     // ... other fields ...
/// };
/// ```
///

/// Categories of motion paths
// #[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
// pub enum PathCategory {
//     Locomotion,
//     Action,
//     Cinematic,
//     Reaction,
//     Custom(String),
// }

/// Types of easing functions available for interpolation
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub enum EasingType {
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

/// Settings for blending between different motion paths
#[serde_with::serde_as]
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct BlendSettings {
    /// Blend curve type
    pub blend_curve: EasingType,
}

/// Identifies which part of the skeleton this motion affects
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct SkeletonTarget {
    /// ID of the skeleton this motion is for
    pub skeleton_id: String,
    /// ID of the specific part within the skeleton
    pub part_id: Option<String>,
    /// Optional Kinematic chain ID if this motion controls an Kinematic target
    pub k_chain_id: Option<String>,
    /// Optional joint ID if this motion controls a specific joint
    pub joint_id: Option<String>,
}

/// Motion constraints based on skeleton definition
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct MotionConstraints {
    /// Rotation limits [min, max] for each axis
    pub rotation_limits: [[f32; 3]; 2],
    /// Whether to preserve volume during motion
    pub preserve_volume: bool,
    /// Maximum allowed stretch factor
    pub max_stretch: f32,
}

/// Extended keyframe with skeleton-specific properties
#[serde_with::serde_as]
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct SkeletonKeyframe {
    /// Identifier for associated various keyframe structures
    pub id: String,
    /// Time offset from the start of the animation
    #[serde_as(as = "serde_with::DurationSecondsWithFrac<String>")]
    pub time: Duration,
    /// Optional easing function identifier
    pub easing: Option<EasingType>,
    /// If this keyframe is editing in IK mode
    /// Alert AI to set ONLY IK Settings OR FK Settings
    pub ik_settings: Option<KeyframeIKSettings>,
    /// If this keyframe is editing in FK mode
    pub fk_settings: Option<KeyframeFKSettings>,
    /// Whether this keyframe requires foot contact
    pub foot_contact: bool,
}

#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct KeyframeIKSettings {
    pub start_joint_position: [f32; 3],
    pub pole_vector_position: [f32; 3],
    pub end_joint_position: [f32; 3],
}

#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct KeyframeFKSettings {
    // may upgrade to hashmap later if doing 3+ joints per chain
    pub start_joint_rotation: [f32; 4],
    pub pole_vector_rotation: [f32; 4],
    pub end_joint_rotation: [f32; 4],
}

/// Complete motion path for skeleton animation
#[serde_with::serde_as]
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct SkeletonMotionPath {
    /// Unique identifier for this path
    pub id: String,
    /// Target skeleton part and optional Kinematic/joint targets
    pub target: SkeletonTarget,
    /// Motion constraints derived from skeleton
    pub constraints: MotionConstraints,
    /// Ordered list of skeleton-specific keyframes
    pub keyframes: Vec<SkeletonKeyframe>,
    /// Total duration of the path
    #[serde_as(as = "serde_with::DurationSecondsWithFrac<String>")]
    pub duration: Duration,
    /// Whether this path loops
    pub is_looping: bool,
    /// Blending settings for transitions
    pub blend_settings: BlendSettings,
    /// Kinematic (IK/FK) solver settings if using either
    pub k_settings: Option<KinematicSolverSettings>,
}

/// Settings for IK solving during motion
#[derive(PartialEq, Serialize, Deserialize, Clone, Debug)]
pub struct KinematicSolverSettings {
    /// Whether to allow stretching
    pub allow_stretch: bool,
    /// Whether to maintain foot contact
    pub foot_contact: bool,
    /// Default FK/IK blend value
    pub default_k_blend: f32,
}

use crate::animations::render_skeleton::SkeletonRenderPart;
use nalgebra::{Point3, Quaternion, UnitQuaternion, Vector3};
use std::time::Instant;
use uuid::Uuid;

use super::{
    render_skeleton::{calculate_bone_end_position, BoneSegment},
    skeleton::PartConnection,
};

/// Tracks the playback state of an animation
pub struct AnimationPlayback {
    /// Identifier to associate RendererState with animations
    pub id: String,
    /// Current time position in the animation
    pub current_time: Duration,
    /// When playback started
    pub start_time: Instant,
    /// Whether animation is currently playing
    pub is_playing: bool,
    /// Current motion paths being played
    pub active_motion_paths: Vec<SkeletonMotionPath>,
    /// Playback speed multiplier
    pub speed_multiplier: f32,
}

impl AnimationPlayback {
    pub fn new(motion_paths: Vec<SkeletonMotionPath>) -> Self {
        let id = Uuid::new_v4();

        Self {
            id: id.to_string(),
            current_time: Duration::from_secs(0),
            start_time: Instant::now(),
            is_playing: true, // for now playing if in the RendererState vector
            active_motion_paths: motion_paths,
            speed_multiplier: 1.0,
        }
    }

    pub fn play(&mut self) {
        self.is_playing = true;
        self.start_time = Instant::now();
    }

    pub fn pause(&mut self) {
        self.is_playing = false;
    }

    pub fn reset(&mut self) {
        self.current_time = Duration::from_secs(0);
        self.start_time = Instant::now();
    }

    pub fn update(&mut self, skeleton_parts: &mut Vec<SkeletonRenderPart>, queue: &wgpu::Queue) {
        if !self.is_playing {
            return;
        }

        // Update current time
        let elapsed = Instant::now().duration_since(self.start_time);
        let raw_time = elapsed.as_secs_f32() * self.speed_multiplier;
        let duration = self.active_motion_paths[0].duration.as_secs_f32();

        // Handle looping
        self.current_time = if self.active_motion_paths[0].is_looping {
            Duration::from_secs_f32(raw_time % duration)
        } else {
            Duration::from_secs_f32((raw_time).min(duration))
        };

        // Calculate current joint positions and rotations
        let mut joint_transforms = HashMap::new();

        for motion_path in &self.active_motion_paths {
            if let Some(part_id) = motion_path.target.part_id.clone() {
                let part_data = skeleton_parts
                    .iter()
                    .find(|sp| sp.skeleton_part_id == part_id)
                    .expect("Couldn't find target part");

                let transforms = self.evaluate_motion_path(motion_path, part_data);
                joint_transforms.extend(transforms);
            }
        }

        // println!("joint_transforms {:?}", joint_transforms);

        // Update SkeletonRenderPart's BoneSegment's Transforms
        for part in skeleton_parts {
            for bone_segment in &mut part.bones {
                // Try to get start and end positions
                if let (Some(start), Some(end)) = (
                    joint_transforms
                        .get(&bone_segment.start_joint_id)
                        .map(|(pos, _)| *pos),
                    joint_transforms
                        .get(&bone_segment.end_joint_id)
                        .map(|(pos, _)| *pos),
                ) {
                    // if let Some(attach_point) = &bone_segment.attach_point {
                    bone_segment.update_from_joint_positions(
                        start,
                        end,
                        part.attachment_transform.clone(),
                    );
                    bone_segment.transform.update_uniform_buffer(&queue);
                    bone_segment.joint_sphere.transform.position = start.coords;
                    bone_segment
                        .joint_sphere
                        .transform
                        .update_uniform_buffer(queue);
                    // }
                } else {
                    // Log which joints weren't found for debugging
                    // if !joint_transforms.contains_key(&bone_segment.start_joint_id) {
                    //     println!(
                    //         "Warning: Start joint '{}' not found in transforms",
                    //         bone_segment.start_joint_id
                    //     );
                    // }
                    // if !joint_transforms.contains_key(&bone_segment.end_joint_id) {
                    //     println!(
                    //         "Warning: End joint '{}' not found in transforms",
                    //         bone_segment.end_joint_id
                    //     );
                    // }
                    // Could potentially use last known good positions or rest pose here
                    // bone_segment.reset_to_rest_pose();
                }
            }
        }
    }

    /// Evaluates a motion path at the current time
    fn evaluate_motion_path(
        &self,
        motion_path: &SkeletonMotionPath,
        part_data: &SkeletonRenderPart,
    ) -> HashMap<String, (Point3<f32>, UnitQuaternion<f32>)> {
        let mut transforms = HashMap::new();
        let current_time = self.current_time.as_secs_f32();

        // Find the surrounding keyframes
        let mut prev_keyframe = &motion_path.keyframes[0];
        let mut next_keyframe = &motion_path.keyframes[0];

        for window in motion_path.keyframes.windows(2) {
            let frame1 = &window[0];
            let frame2 = &window[1];

            let time1 = frame1.time.as_secs_f32();
            let time2 = frame2.time.as_secs_f32();

            if current_time >= time1 && current_time <= time2 {
                prev_keyframe = frame1;
                next_keyframe = frame2;
                break;
            }
        }

        // Calculate interpolation factor
        let start_time = prev_keyframe.time.as_secs_f32();
        let end_time = next_keyframe.time.as_secs_f32();
        let mut t = (current_time - start_time) / (end_time - start_time);

        // Apply easing if specified
        if let Some(easing) = &prev_keyframe.easing {
            t = match easing {
                EasingType::Linear => t,
                EasingType::EaseIn => t * t,
                EasingType::EaseOut => t * (2.0 - t),
                EasingType::EaseInOut => {
                    if t < 0.5 {
                        2.0 * t * t
                    } else {
                        -1.0 + (4.0 - 2.0 * t) * t
                    }
                }
            };
        }

        if let (Some(prev_ik), Some(next_ik)) =
            (&prev_keyframe.ik_settings, &next_keyframe.ik_settings)
        {
            if let Some(k_chain_id) = &motion_path.target.k_chain_id {
                let chain_bones = collect_chain_bones(part_data, k_chain_id);

                if chain_bones.is_empty() {
                    println!("Warning: No bones found for kinematic chain {}", k_chain_id);
                    return transforms;
                }

                match chain_bones.as_slice() {
                    [first, second] => {
                        if let Some(attach_point) = &first.attach_point {
                            // Convert attach point array to Vector3
                            let attach_offset = Vector3::new(
                                attach_point.local_position[0],
                                attach_point.local_position[1],
                                attach_point.local_position[2],
                            );

                            let transform_offset = part_data.attachment_transform.position.coords;

                            // First, add attach_offset to the input positions before interpolation
                            let prev_start = [
                                prev_ik.start_joint_position[0]
                                    + attach_offset.x
                                    + transform_offset.x,
                                prev_ik.start_joint_position[1]
                                    + attach_offset.y
                                    + transform_offset.y,
                                prev_ik.start_joint_position[2]
                                    + attach_offset.z
                                    + transform_offset.z,
                            ];

                            let prev_pole = [
                                prev_ik.pole_vector_position[0]
                                    + attach_offset.x
                                    + transform_offset.x,
                                prev_ik.pole_vector_position[1]
                                    + attach_offset.y
                                    + transform_offset.y,
                                prev_ik.pole_vector_position[2]
                                    + attach_offset.z
                                    + transform_offset.z,
                            ];

                            let prev_end = [
                                prev_ik.end_joint_position[0]
                                    + attach_offset.x
                                    + transform_offset.x,
                                prev_ik.end_joint_position[1]
                                    + attach_offset.y
                                    + transform_offset.y,
                                prev_ik.end_joint_position[2]
                                    + attach_offset.z
                                    + transform_offset.z,
                            ];

                            let next_start = [
                                next_ik.start_joint_position[0]
                                    + attach_offset.x
                                    + transform_offset.x,
                                next_ik.start_joint_position[1]
                                    + attach_offset.y
                                    + transform_offset.y,
                                next_ik.start_joint_position[2]
                                    + attach_offset.z
                                    + transform_offset.z,
                            ];

                            let next_pole = [
                                next_ik.pole_vector_position[0]
                                    + attach_offset.x
                                    + transform_offset.x,
                                next_ik.pole_vector_position[1]
                                    + attach_offset.y
                                    + transform_offset.y,
                                next_ik.pole_vector_position[2]
                                    + attach_offset.z
                                    + transform_offset.z,
                            ];

                            let next_end = [
                                next_ik.end_joint_position[0]
                                    + attach_offset.x
                                    + transform_offset.x,
                                next_ik.end_joint_position[1]
                                    + attach_offset.y
                                    + transform_offset.y,
                                next_ik.end_joint_position[2]
                                    + attach_offset.z
                                    + transform_offset.z,
                            ];

                            // Now interpolate the offset-adjusted positions
                            let start_pos = Point3::from(lerp_vector3(&prev_start, &next_start, t));

                            let pole_pos = Point3::from(lerp_vector3(&prev_pole, &next_pole, t));

                            let end_pos = Point3::from(lerp_vector3(&prev_end, &next_end, t));

                            // Calculate rotations based on offset-adjusted positions
                            let start_to_pole = (pole_pos - start_pos).normalize();
                            let pole_to_end = (end_pos - pole_pos).normalize();

                            let default_up = Vector3::new(0.0, 1.0, 0.0);
                            let start_rotation =
                                UnitQuaternion::rotation_between(&default_up, &start_to_pole)
                                    .unwrap_or(UnitQuaternion::identity());
                            let pole_rotation =
                                UnitQuaternion::rotation_between(&default_up, &pole_to_end)
                                    .unwrap_or(UnitQuaternion::identity());
                            let end_rotation = pole_rotation;

                            // Store transforms with already-offset positions
                            transforms
                                .insert(first.start_joint_id.clone(), (start_pos, start_rotation));
                            transforms
                                .insert(first.end_joint_id.clone(), (pole_pos, pole_rotation));
                            transforms
                                .insert(second.start_joint_id.clone(), (pole_pos, pole_rotation));
                            transforms.insert(second.end_joint_id.clone(), (end_pos, end_rotation));

                            // After main chain is processed, handle the first connected chain
                            if let Some(last_bone) = chain_bones.last() {
                                let end_joint_id = &last_bone.end_joint_id;

                                // Find the first connected chain
                                if let Some(first_connected_bone) =
                                    part_data.bones.iter().find(|bone| {
                                        bone.k_chain.is_some()
                                            && bone.start_joint_id == *end_joint_id
                                    })
                                {
                                    // Transform the first connected chain using the final rotation
                                    let first_chain_transforms = transform_chain(
                                        first_connected_bone,
                                        end_pos,
                                        end_rotation,
                                        part_data,
                                    );

                                    // println!("add first chain");

                                    transforms.extend(first_chain_transforms.clone());

                                    // // Start recursive process for subsequent chains
                                    // if let Some(chain) = &first_connected_bone.k_chain {
                                    //     // println!("begin recursive");
                                    //     transforms.extend(evaluate_chain_recursive(
                                    //         part_data,
                                    //         &chain.id,
                                    //         &first_chain_transforms,
                                    //         0,
                                    //         10,
                                    //     ));
                                    // }
                                }
                            }
                        } else {
                            println!(
                                "Warning: No attach point found for first bone in chain {}",
                                k_chain_id
                            );
                        }
                    }
                    _ => {
                        println!(
                            "Warning: Expected exactly 2 bones in chain {}, found {}",
                            k_chain_id,
                            chain_bones.len()
                        );
                    }
                }

                // // Calculate end position and rotation for the main chain
                // let end_pos = Point3::from(lerp_vector3(
                //     &prev_ik.end_joint_position,
                //     &next_ik.end_joint_position,
                //     t,
                // ));

                // let pole_pos = Point3::from(lerp_vector3(
                //     &prev_ik.pole_vector_position,
                //     &next_ik.pole_vector_position,
                //     t,
                // ));

                // // Calculate the final rotation based on the direction to the end
                // let pole_to_end = (end_pos - pole_pos).normalize();
                // let default_up = Vector3::new(0.0, 1.0, 0.0);
                // let end_rot = UnitQuaternion::rotation_between(&default_up, &pole_to_end)
                //     .unwrap_or(UnitQuaternion::identity());
            }
        } else if let (Some(prev_fk), Some(next_fk)) =
            (&prev_keyframe.fk_settings, &next_keyframe.fk_settings)
        {
            if let Some(k_chain_id) = &motion_path.target.k_chain_id {
                let chain_bones = collect_chain_bones(part_data, k_chain_id);

                if chain_bones.is_empty() {
                    println!("Warning: No bones found for FK chain {}", k_chain_id);
                    return transforms;
                }

                // Interpolate rotations
                let start_rotation = interpolate_quaternion(
                    &prev_fk.start_joint_rotation,
                    &next_fk.start_joint_rotation,
                    t,
                );

                let pole_rotation = interpolate_quaternion(
                    &prev_fk.pole_vector_rotation,
                    &next_fk.pole_vector_rotation,
                    t,
                );

                let end_rotation = interpolate_quaternion(
                    &prev_fk.end_joint_rotation,
                    &next_fk.end_joint_rotation,
                    t,
                );

                // Get base position from attachment transform
                let base_position = part_data.attachment_transform.position;

                match chain_bones.as_slice() {
                    [first, second] => {
                        let mut current_pos = base_position;
                        let mut accumulated_rotation = start_rotation;

                        // First bone
                        transforms
                            .insert(first.start_joint_id.clone(), (current_pos, start_rotation));

                        // Calculate first bone end position (pole position)
                        let middle_offset =
                            accumulated_rotation * Vector3::new(0.0, -first.length, 0.0);
                        current_pos = Point3::from(current_pos.coords + middle_offset);
                        accumulated_rotation = accumulated_rotation * pole_rotation;

                        // Store pole position for both end of first bone and start of second
                        transforms.insert(
                            first.end_joint_id.clone(),
                            (current_pos, accumulated_rotation),
                        );
                        transforms.insert(
                            second.start_joint_id.clone(),
                            (current_pos, accumulated_rotation),
                        );

                        // Calculate second bone end position
                        let end_offset =
                            accumulated_rotation * Vector3::new(0.0, -second.length, 0.0);
                        current_pos = Point3::from(current_pos.coords + end_offset);
                        accumulated_rotation = accumulated_rotation * end_rotation;

                        // Store final position and rotation
                        transforms.insert(
                            second.end_joint_id.clone(),
                            (current_pos, accumulated_rotation),
                        );
                    }
                    _ => {
                        println!(
                            "Warning: Expected exactly 2 bones in FK chain {}, found {}",
                            k_chain_id,
                            chain_bones.len()
                        );
                    }
                }
            }
        }

        // println!("---^^^---Transforms: {:?}", transforms);

        transforms
    }
}

fn evaluate_chain_recursive(
    part_data: &SkeletonRenderPart,
    current_chain_id: &str,
    parent_transforms: &HashMap<String, (Point3<f32>, UnitQuaternion<f32>)>,
    depth: u32,
    max_depth: u32,
) -> HashMap<String, (Point3<f32>, UnitQuaternion<f32>)> {
    let mut all_transforms = HashMap::new();

    // Guard against excessive recursion
    if depth >= max_depth {
        println!(
            "Warning: Max recursion depth reached for chain {}",
            current_chain_id
        );
        return all_transforms;
    }

    // Find all bones in the current chain
    let current_chain_bones: Vec<&BoneSegment> = part_data
        .bones
        .iter()
        .filter(|bone| {
            bone.k_chain
                .as_ref()
                .map_or(false, |chain| chain.id == current_chain_id)
        })
        .collect();

    // If we found our chain bones, look for connecting chains
    if let Some(last_bone) = current_chain_bones.last() {
        let end_joint_id = &last_bone.end_joint_id;

        // Find all chains that connect to this chain's end joint
        for bone in &part_data.bones {
            if let Some(chain) = &bone.k_chain {
                if bone.start_joint_id == *end_joint_id {
                    // This is a connecting chain
                    if let Some((parent_pos, parent_rot)) = parent_transforms.get(end_joint_id) {
                        println!("Start transform...");
                        // Transform the connecting chain's positions based on parent
                        let mut chain_transforms =
                            transform_chain(bone, *parent_pos, *parent_rot, part_data);

                        // Recursively handle chains that connect to this one
                        let connected_transforms = evaluate_chain_recursive(
                            part_data,
                            &chain.id,
                            &chain_transforms,
                            depth + 1,
                            max_depth,
                        );

                        // Combine all transforms
                        chain_transforms.extend(connected_transforms);
                        all_transforms.extend(chain_transforms);
                    }
                }
            }
        }
    }

    all_transforms
}

fn transform_chain(
    connecting_bone: &BoneSegment,
    parent_pos: Point3<f32>,
    parent_rot: UnitQuaternion<f32>,
    part_data: &SkeletonRenderPart,
) -> HashMap<String, (Point3<f32>, UnitQuaternion<f32>)> {
    let mut chain_transforms = HashMap::new();

    if let Some(attach_point) = &connecting_bone.attach_point {
        // Get local offset from attach point
        let local_offset = Vector3::new(
            attach_point.local_position[0],
            attach_point.local_position[1],
            attach_point.local_position[2],
        );

        // Transform local offset by parent rotation
        // let world_offset = parent_rot * local_offset;
        let world_offset = local_offset;

        // Set chain base position relative to parent
        let chain_base_pos = parent_pos + world_offset;

        // Store transform for the connecting joint
        chain_transforms.insert(
            connecting_bone.start_joint_id.clone(),
            (chain_base_pos, parent_rot),
        );

        if let Some(chain) = &connecting_bone.k_chain {
            let chain_bones: Vec<&BoneSegment> = part_data
                .bones
                .iter()
                .filter(|bone| bone.k_chain.as_ref().map_or(false, |c| c.id == chain.id))
                .collect();

            // Transform each bone in the chain relative to the base position
            for bone in chain_bones {
                if let (Some(start_joint), Some(end_joint)) =
                    (bone.joints.get(0), bone.joints.get(1))
                {
                    if let (Some(start_ik), Some(end_ik)) = (
                        start_joint.ik_settings.as_ref(),
                        end_joint.ik_settings.as_ref(),
                    ) {
                        // println!("Got all settings!");
                        // Convert positions to Vector3 for transformation
                        let local_start = Vector3::new(
                            start_ik.position[0],
                            start_ik.position[1],
                            start_ik.position[2],
                        );
                        let local_end = Vector3::new(
                            end_ik.position[0],
                            end_ik.position[1],
                            end_ik.position[2],
                        );

                        // Transform the positions to world space using parent transform
                        // let world_start = chain_base_pos + (parent_rot * local_start);
                        // let world_end = chain_base_pos + (parent_rot * local_end);
                        let world_start = chain_base_pos + (local_start);
                        let world_end = chain_base_pos + (local_end);

                        // Calculate rotation from transformed positions
                        let bone_vector = world_end - world_start;
                        let default_up = Vector3::new(0.0, 1.0, 0.0);
                        let bone_rotation =
                            UnitQuaternion::rotation_between(&default_up, &bone_vector.normalize())
                                .unwrap_or(UnitQuaternion::identity());

                        // Combine parent rotation with local rotation
                        let final_rotation = parent_rot * bone_rotation;

                        // Store transforms for both joints
                        chain_transforms.insert(
                            bone.start_joint_id.clone(),
                            (Point3::from(world_start), final_rotation),
                        );
                        chain_transforms.insert(
                            bone.end_joint_id.clone(),
                            (Point3::from(world_end), final_rotation),
                        );
                    }
                }
            }
        }
    }

    chain_transforms
}

fn collect_chain_bones<'a>(
    part_data: &'a SkeletonRenderPart,
    k_chain_id: &str,
) -> Vec<&'a BoneSegment> {
    // Collect all bones that belong to this kinematic chain
    part_data
        .bones
        .iter()
        .filter(|bone| {
            bone.k_chain
                .as_ref()
                .map(|chain| chain.id == k_chain_id)
                .unwrap_or(false)
        })
        .collect()
}

// Helper function to linearly interpolate between two [f32; 3] arrays
fn lerp_vector3(start: &[f32; 3], end: &[f32; 3], t: f32) -> Vector3<f32> {
    Vector3::new(
        start[0] + (end[0] - start[0]) * t,
        start[1] + (end[1] - start[1]) * t,
        start[2] + (end[2] - start[2]) * t,
    )
}

// Helper function to interpolate between two quaternions represented as [f32; 4]
fn interpolate_quaternion(start: &[f32; 4], end: &[f32; 4], t: f32) -> UnitQuaternion<f32> {
    let q1 =
        UnitQuaternion::from_quaternion(Quaternion::new(start[3], start[0], start[1], start[2]));
    let q2 = UnitQuaternion::from_quaternion(Quaternion::new(end[3], end[0], end[1], end[2]));

    // Use spherical linear interpolation for smooth rotation
    q1.slerp(&q2, t)
}

// Define a transform type for handling part attachment transforms
#[derive(Clone, Debug)]
pub struct AttachmentTransform {
    pub position: Point3<f32>,
    pub rotation: UnitQuaternion<f32>,
    pub scale: Vector3<f32>,
}

impl AttachmentTransform {
    pub fn new(position: Point3<f32>, rotation: UnitQuaternion<f32>, scale: Vector3<f32>) -> Self {
        // Validate rotation
        let rotation = if !rotation.as_vector().iter().all(|x| x.is_finite()) {
            println!("Warning: Invalid rotation in attachment transform, using identity");
            UnitQuaternion::identity()
        } else {
            rotation
        };

        Self {
            position,
            rotation,
            scale,
        }
    }

    pub fn transform_point(&self, point: &Point3<f32>) -> Point3<f32> {
        let scaled = point.coords.component_mul(&self.scale);
        let rotated = self.rotation * scaled;
        Point3::from(rotated + self.position.coords)
    }

    pub fn inverse_transform_point(&self, point: &Point3<f32>) -> Point3<f32> {
        let translated = point - self.position.coords;
        let unrotated = self.rotation.inverse() * translated;
        // Point3::from(unrotated.component_div(&self.scale))
        Point3::from(unrotated.coords.component_div(&self.scale))
    }
}

// Function to create the attachment transform from your PartConnection data
pub fn create_attachment_transform(connection: &PartConnection) -> AttachmentTransform {
    if let Some(transform_offset) = &connection.transform_offset {
        // Create quaternion from offset, ensuring it's valid (in case AI generation is innacurate)
        let rotation = if transform_offset.rotation.iter().all(|&x| x == 0.0) {
            // If all zeros, use identity quaternion instead
            UnitQuaternion::identity()
        } else {
            // Otherwise normalize the quaternion
            let quat = Quaternion::new(
                transform_offset.rotation[3], // w component
                transform_offset.rotation[0], // x component
                transform_offset.rotation[1], // y component
                transform_offset.rotation[2], // z component
            );
            UnitQuaternion::from_quaternion(quat.normalize())
        };

        AttachmentTransform::new(
            Point3::from(transform_offset.position),
            rotation,
            Vector3::from(transform_offset.scale),
        )
    } else {
        // Default transform if none specified
        AttachmentTransform::new(
            Point3::origin(),
            UnitQuaternion::identity(),
            Vector3::new(1.0, 1.0, 1.0),
        )
    }
}

// Generate test motion path data
// pub fn create_test_motion_paths() -> Vec<MotionPath> {
//     vec![
//         // Jump animation path
//         MotionPath {
//             id: "jump_basic".to_string(),
//             keyframes: vec![
//                 // Starting pose
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.0),
//                     position: [0.0, 0.0, 0.0],
//                     rotation: [0.0, 0.0, 0.0, 1.0], // Identity quaternion
//                     velocity: [0.0, 0.0, 0.0],
//                     easing: Some(EasingType::EaseOut),
//                     metadata: KeyframeMetadata { flags: 0 },
//                 },
//                 // Crouch preparation
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.15),
//                     position: [0.0, -0.2, 0.0],
//                     rotation: [0.05, 0.0, 0.0, 0.9987], // Slight forward tilt
//                     velocity: [0.0, -1.0, 0.0],
//                     easing: Some(EasingType::EaseIn),
//                     metadata: KeyframeMetadata { flags: 1 }, // Preparation flag
//                 },
//                 // Jump initiation
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.3),
//                     position: [0.0, 0.5, 0.0],
//                     rotation: [-0.05, 0.0, 0.0, 0.9987], // Slight backward tilt
//                     velocity: [0.0, 4.0, 0.0],
//                     easing: Some(EasingType::EaseOut),
//                     metadata: KeyframeMetadata { flags: 2 }, // Jump start flag
//                 },
//                 // Peak of jump
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.6),
//                     position: [0.0, 1.2, 0.0],
//                     rotation: [0.0, 0.0, 0.0, 1.0],
//                     velocity: [0.0, 0.0, 0.0],
//                     easing: Some(EasingType::EaseInOut),
//                     metadata: KeyframeMetadata { flags: 4 }, // Peak flag
//                 },
//                 // Landing preparation
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.9),
//                     position: [0.0, 0.3, 0.0],
//                     rotation: [0.05, 0.0, 0.0, 0.9987],
//                     velocity: [0.0, -3.0, 0.0],
//                     easing: Some(EasingType::EaseIn),
//                     metadata: KeyframeMetadata { flags: 8 }, // Landing prep flag
//                 },
//                 // Landing impact
//                 Keyframe {
//                     time: Duration::from_secs_f64(1.0),
//                     position: [0.0, 0.0, 0.0],
//                     rotation: [0.1, 0.0, 0.0, 0.9950],
//                     velocity: [0.0, -2.0, 0.0],
//                     easing: Some(EasingType::EaseOut),
//                     metadata: KeyframeMetadata { flags: 16 }, // Landing impact flag
//                 },
//             ],
//             duration: Duration::from_secs_f64(1.0),
//             metadata: PathMetadata {
//                 category: PathCategory::Action,
//                 priority: 2,
//             },
//             is_looping: false,
//             blend_settings: BlendSettings {
//                 min_blend_time: Duration::from_secs_f64(0.1),
//                 max_blend_time: Duration::from_secs_f64(0.3),
//                 blend_curve: EasingType::EaseInOut,
//                 blend_mask: BlendMask {
//                     blend_position: true,
//                     blend_rotation: true,
//                     blend_velocity: true,
//                     preserve_events: true,
//                 },
//             },
//         },
//         // Walk cycle animation
//         MotionPath {
//             id: "walk_cycle".to_string(),
//             keyframes: vec![
//                 // Start of cycle
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.0),
//                     position: [0.0, 0.0, 0.0],
//                     rotation: [0.0, 0.0, 0.0, 1.0],
//                     velocity: [1.0, 0.0, 0.0],
//                     easing: Some(EasingType::Linear),
//                     metadata: KeyframeMetadata { flags: 1 },
//                 },
//                 // Mid step up
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.2),
//                     position: [0.2, 0.1, 0.0],
//                     rotation: [0.0, 0.0, 0.02, 0.9998],
//                     velocity: [1.0, 0.2, 0.0],
//                     easing: Some(EasingType::EaseInOut),
//                     metadata: KeyframeMetadata { flags: 2 },
//                 },
//                 // Full step
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.4),
//                     position: [0.4, 0.0, 0.0],
//                     rotation: [0.0, 0.0, -0.02, 0.9998],
//                     velocity: [1.0, 0.0, 0.0],
//                     easing: Some(EasingType::EaseInOut),
//                     metadata: KeyframeMetadata { flags: 4 },
//                 },
//                 // Mid step up (opposite)
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.6),
//                     position: [0.6, 0.1, 0.0],
//                     rotation: [0.0, 0.0, 0.02, 0.9998],
//                     velocity: [1.0, 0.2, 0.0],
//                     easing: Some(EasingType::EaseInOut),
//                     metadata: KeyframeMetadata { flags: 2 },
//                 },
//                 // Cycle complete
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.8),
//                     position: [0.8, 0.0, 0.0],
//                     rotation: [0.0, 0.0, 0.0, 1.0],
//                     velocity: [1.0, 0.0, 0.0],
//                     easing: Some(EasingType::Linear),
//                     metadata: KeyframeMetadata { flags: 1 },
//                 },
//             ],
//             duration: Duration::from_secs_f64(0.8),
//             metadata: PathMetadata {
//                 category: PathCategory::Locomotion,
//                 priority: 1,
//             },
//             is_looping: true,
//             blend_settings: BlendSettings {
//                 min_blend_time: Duration::from_secs_f64(0.2),
//                 max_blend_time: Duration::from_secs_f64(0.4),
//                 blend_curve: EasingType::EaseInOut,
//                 blend_mask: BlendMask {
//                     blend_position: true,
//                     blend_rotation: true,
//                     blend_velocity: true,
//                     preserve_events: false,
//                 },
//             },
//         },
//         // Attack animation
//         MotionPath {
//             id: "attack_swing".to_string(),
//             keyframes: vec![
//                 // Wind up
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.0),
//                     position: [0.0, 0.0, 0.0],
//                     rotation: [0.0, -0.2, 0.0, 0.9798], // Turned slightly right
//                     velocity: [0.0, 0.0, 0.0],
//                     easing: Some(EasingType::EaseIn),
//                     metadata: KeyframeMetadata { flags: 1 },
//                 },
//                 // Attack start
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.15),
//                     position: [0.1, 0.0, 0.1],
//                     rotation: [0.0, -0.3827, 0.0, 0.9239], // 45 degrees right
//                     velocity: [1.0, 0.0, 1.0],
//                     easing: Some(EasingType::Linear),
//                     metadata: KeyframeMetadata { flags: 2 },
//                 },
//                 // Strike
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.3),
//                     position: [0.2, 0.0, -0.1],
//                     rotation: [0.0, 0.3827, 0.0, 0.9239], // 45 degrees left
//                     velocity: [2.0, 0.0, -3.0],
//                     easing: Some(EasingType::EaseOut),
//                     metadata: KeyframeMetadata { flags: 4 },
//                 },
//                 // Follow through
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.45),
//                     position: [0.1, 0.0, -0.2],
//                     rotation: [0.0, 0.2, 0.0, 0.9798],
//                     velocity: [0.5, 0.0, -1.0],
//                     easing: Some(EasingType::EaseInOut),
//                     metadata: KeyframeMetadata { flags: 8 },
//                 },
//                 // Return to neutral
//                 Keyframe {
//                     time: Duration::from_secs_f64(0.6),
//                     position: [0.0, 0.0, 0.0],
//                     rotation: [0.0, 0.0, 0.0, 1.0],
//                     velocity: [0.0, 0.0, 0.0],
//                     easing: Some(EasingType::EaseIn),
//                     metadata: KeyframeMetadata { flags: 16 },
//                 },
//             ],
//             duration: Duration::from_secs_f64(0.6),
//             metadata: PathMetadata {
//                 category: PathCategory::Action,
//                 priority: 3,
//             },
//             is_looping: false,
//             blend_settings: BlendSettings {
//                 min_blend_time: Duration::from_secs_f64(0.1),
//                 max_blend_time: Duration::from_secs_f64(0.2),
//                 blend_curve: EasingType::EaseIn,
//                 blend_mask: BlendMask {
//                     blend_position: true,
//                     blend_rotation: true,
//                     blend_velocity: true,
//                     preserve_events: true,
//                 },
//             },
//         },
//     ]
// }
