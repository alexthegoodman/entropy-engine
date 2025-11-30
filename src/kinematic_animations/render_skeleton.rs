use std::{collections::HashMap, sync::Arc};

use nalgebra::{
    Matrix4, Point3, Quaternion, Rotation, Rotation3, Unit, UnitQuaternion, UnitVector3, Vector3,
};
use wgpu::util::DeviceExt;

use crate::{
    animations::motion_path::create_attachment_transform,
    core::Transform::{matrix4_to_raw_array, Transform},
    handlers::Vertex,
    shapes::Sphere::Sphere,
};

use super::{
    motion_path::AttachmentTransform,
    skeleton::{AttachPoint, Joint, KinematicChain, PartConnection, SkeletonPart},
};

// NOTE: these vertices extend across just 1 unit of space
// Vertices for a pyramid pointing along -Y axis
const VERTICES: &[Vertex] = &[
    // Base vertices (at y=0)
    Vertex {
        position: [-0.5, 0.0, -0.5],
        normal: [-0.5, 0.5, -0.5],
        tex_coords: [0.0, 0.0],
        color: [1.0, 0.0, 1.0],
    },
    Vertex {
        position: [0.5, 0.0, -0.5],
        normal: [0.5, 0.5, -0.5],
        tex_coords: [1.0, 0.0],
        color: [1.0, 0.0, 0.0],
    },
    Vertex {
        position: [0.5, 0.0, 0.5],
        normal: [0.5, 0.5, 0.5],
        tex_coords: [1.0, 1.0],
        color: [1.0, 1.0, 0.0],
    },
    Vertex {
        position: [-0.5, 0.0, 0.5],
        normal: [-0.5, 0.5, 0.5],
        tex_coords: [0.0, 1.0],
        color: [1.0, 0.0, 0.0],
    },
    // Tip vertex (at y=-1 instead of y=1)
    Vertex {
        position: [0.0, -1.0, 0.0],
        normal: [0.0, -1.0, 0.0],
        tex_coords: [0.5, 0.5],
        color: [1.0, 1.0, 0.0],
    },
];

// Indices for a pyramid (reversed winding order for correct face culling)
const INDICES: &[u16] = &[
    // Base
    0, 2, 1, 0, 3, 2, // Sides
    0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4,
];

// #[derive(Clone)]
pub struct BoneSegment {
    pub start_joint_id: String,
    pub end_joint_id: String,
    pub transform: Transform,

    // WGPU Buffers and binding information
    /// Vertex buffer containing the base pyramid shape
    pub vertex_buffer: wgpu::Buffer,
    /// Index buffer for the pyramid geometry
    pub index_buffer: wgpu::Buffer,
    /// Number of indices in the base pyramid shape
    pub num_indices: u32,
    /// Bind group for this skeleton part's resources
    pub bind_group: wgpu::BindGroup,

    pub length: f32,
    pub color: [f32; 4],

    pub joint_sphere: Sphere,

    pub is_end_effector: bool,

    // make dynamic?
    pub joints: Vec<Joint>, // always just two
    pub k_chain: Option<KinematicChain>,
    pub attach_point: Option<AttachPoint>,
}

impl BoneSegment {
    /// Creates a new bone segment between two joint positions
    pub fn new(
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        start_joint_id: String,
        end_joint_id: String,
        start_pos: Point3<f32>,
        end_pos: Point3<f32>,
        k_chain: Option<KinematicChain>,
        attach_point: Option<AttachPoint>,
        joints: Vec<Joint>,
        is_end_effector: bool,
    ) -> Self {
        // Calculate bone properties from joint positions
        let bone_vector = end_pos - start_pos;
        let length = bone_vector.magnitude();

        // Calculate rotation to align bone with direction vector
        let rotation = Self::calculate_local_bone_rotation(&bone_vector);

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("BoneSegment Vertex Buffer"),
            contents: bytemuck::cast_slice(VERTICES),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("BoneSegment Index Buffer"),
            contents: bytemuck::cast_slice(INDICES),
            usage: wgpu::BufferUsages::INDEX,
        });

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("BoneSegment Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: None,
        });

        // Create transform
        // Position is at start joint
        // Scale x and z are small to make thin bones, y is length
        // Rotation aligns bone with direction vector
        let mut transform = Transform::new(
            start_pos.coords, // position at start joint
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(0.05, length, 0.05), // scale to create bone shape
            uniform_buffer,
        );

        transform.rotation = rotation; // set with quat for accuracy

        let mut joint_sphere = Sphere::new(device, bind_group_layout, 0.05, 16, 16);
        joint_sphere.transform.position = start_pos.coords;

        Self {
            start_joint_id,
            end_joint_id,
            transform,
            length,
            color: [0.8, 0.8, 0.8, 1.0],
            vertex_buffer,
            index_buffer,
            num_indices: INDICES.len() as u32,
            bind_group,
            joint_sphere,
            k_chain,
            is_end_effector,
            attach_point,
            joints,
        }
    }

    // /// Updates the bone transform based on new joint positions
    // pub fn update_from_joint_positions(&mut self, start_pos: Point3<f32>, end_pos: Point3<f32>) {
    //     let bone_vector = end_pos - start_pos;
    //     let length = bone_vector.magnitude();

    //     let rotation = Self::calculate_local_bone_rotation(&bone_vector);

    //     // println!("joint rotation {:?}", rotation);

    //     self.transform.update_position(start_pos.coords.into());
    //     self.transform.rotation = rotation;
    //     self.transform.update_scale([0.1, length, 0.1]);
    //     self.length = length;
    // }
    /// Updates the bone transform based on new joint positions
    pub fn update_from_joint_positions(
        &mut self,
        start_pos: Point3<f32>,
        end_pos: Point3<f32>,
        attachment_transform: AttachmentTransform,
    ) {
        // no need for this double adjustment
        // if let Some(attach_point) = &self.attach_point {
        //     let transform_offset = attachment_transform.position.coords;

        //     // Convert attach point offset to Vector3
        //     let attach_offset = Vector3::new(
        //         attach_point.local_position[0] + transform_offset.x,
        //         attach_point.local_position[1] + transform_offset.y,
        //         attach_point.local_position[2] + transform_offset.z,
        //     );

        //     // Apply attach point offset to positions
        //     let adjusted_start = start_pos - attach_offset; // Subtract because we want position relative to attach point
        //     let adjusted_end = end_pos - attach_offset;

        //     let bone_vector = adjusted_end - adjusted_start;
        //     let length = bone_vector.magnitude();

        //     let rotation = Self::calculate_local_bone_rotation(&bone_vector);

        //     self.transform.update_position(adjusted_start.coords.into());
        //     self.transform.rotation = rotation;
        //     self.transform.update_scale([0.1, length, 0.1]);
        //     self.length = length;
        // } else {
        // Original behavior for bones without attach points
        let bone_vector = end_pos - start_pos;
        let length = bone_vector.magnitude();

        let rotation = Self::calculate_local_bone_rotation(&bone_vector);

        self.transform.update_position(start_pos.coords.into());
        self.transform.rotation = rotation;
        self.transform.update_scale([0.1, length, 0.1]);
        self.length = length;
        // }
    }

    // /// Calculates rotation to align bone with direction vector
    fn calculate_local_bone_rotation(bone_vector: &Vector3<f32>) -> Unit<Quaternion<f32>> {
        // Default bone direction
        let default_direction = Vector3::new(0.0, -1.0, 0.0);

        // If bone vector is zero or nearly zero, return no rotation
        if bone_vector.magnitude() < 1e-6 {
            return UnitQuaternion::identity();
        }

        // Get unit vector in bone direction
        let bone_direction = UnitVector3::new_normalize(*bone_vector);

        // Calculate rotation between default direction and bone direction
        let rotation = Rotation3::rotation_between(&default_direction, &bone_direction)
            .unwrap_or(Rotation3::identity());

        UnitQuaternion::from_rotation_matrix(&rotation)
    }
}

pub fn calculate_bone_end_position(
    start_pos: Point3<f32>,
    end_pos: Point3<f32>,
    merge_rotation: Option<UnitQuaternion<f32>>,
    length: f32,
) -> Point3<f32> {
    if let Some(merge_rot) = merge_rotation {
        let bone_vector = end_pos - start_pos;
        let direction = merge_rot * Vector3::new(0.0, length, 0.0);
        start_pos + direction
    } else {
        end_pos
    }
}

/// Complete render information for a skeleton part
pub struct SkeletonRenderPart {
    /// Reference to the skeleton part this renders
    pub skeleton_part_id: String,
    /// All bone segments in this part
    pub bones: Vec<BoneSegment>,
    // temp transforms for calculations, not buffers
    pub attachment_transform: AttachmentTransform,
    pub connection: Option<PartConnection>,
}

impl SkeletonRenderPart {
    pub fn new(part_id: String) -> Self {
        SkeletonRenderPart {
            skeleton_part_id: part_id,
            bones: Vec::new(),
            // joint_positions: HashMap::new(),
            attachment_transform: AttachmentTransform::new(
                Point3::origin(),
                UnitQuaternion::identity(),
                Vector3::new(1.0, 1.0, 1.0),
            ),
            connection: None,
        }
    }

    pub fn create_bone_segments(
        &mut self,
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        joints: Vec<Joint>,
        k_chains: Vec<KinematicChain>,
        attach_points: Vec<AttachPoint>,
        joint_positions: &HashMap<String, Point3<f32>>,
        position: [f32; 3],
        connection: Option<PartConnection>,
    ) {
        println!("create_bone_segments");
        let mut bones = Vec::new();

        // Create a map of joints to their K chains for quick lookup
        let mut joint_to_k_chain: HashMap<String, &KinematicChain> = HashMap::new();
        for chain in &k_chains {
            // Start from end joint and work backwards
            let mut current_joint_id = chain.end_joint.clone();

            while let Some(current_joint) = joints.iter().find(|j| j.id == current_joint_id) {
                // Add this joint to the chain
                joint_to_k_chain.insert(current_joint.id.clone(), chain);

                // If we've reached the start joint, we're done
                if current_joint.id == chain.start_joint {
                    break;
                }

                // Move to parent joint if there is one
                if let Some(parent_id) = &current_joint.parent_id {
                    current_joint_id = parent_id.clone();
                } else {
                    println!("Warning: Reached root joint before finding start joint of IK chain");
                    break;
                }
            }
        }

        // println!("joint_to_ik_chain {:?}", joint_to_k_chain);

        let joints_cloned = joints.clone();

        for joint in joints {
            if let Some(parent_id) = &joint.parent_id {
                if let (Some(start_pos), Some(end_pos)) = (
                    joint_positions.get(parent_id),
                    joint_positions.get(&joint.id),
                ) {
                    let adjusted_start = Point3::new(
                        position[0] + start_pos.x,
                        position[1] + start_pos.y,
                        position[2] + start_pos.z,
                    );
                    let adjusted_end = Point3::new(
                        position[0] + end_pos.x,
                        position[1] + end_pos.y,
                        position[2] + end_pos.z,
                    );

                    // Check if this bone is part of an IK chain
                    let k_chain = joint_to_k_chain.get(&joint.id).cloned();
                    let is_end_effector = k_chain
                        .map(|chain| chain.end_joint == joint.id)
                        .unwrap_or(false);

                    if let Some(ref connection) = connection {
                        let parent_attach_point = attach_points.iter().find(|ap| {
                            &ap.id
                                == connection
                                    .parent_attach_point
                                    .as_ref()
                                    .expect("Couldn't get attach point")
                        });
                        let child_attach_point = attach_points.iter().find(|ap| {
                            &ap.id
                                == connection
                                    .child_attach_point
                                    .as_ref()
                                    .expect("Couldn't get attach point")
                        });

                        println!(
                            "check it {:?} {:?} {:?} {:?}",
                            attach_points,
                            connection,
                            parent_attach_point.is_some(),
                            child_attach_point.is_some()
                        );

                        let parent_joint = joints_cloned
                            .iter()
                            .find(|j| &j.id == parent_id)
                            .expect("Couldn't find parent joint")
                            .clone();
                        let main_joint = joints_cloned
                            .iter()
                            .find(|j| j.id == joint.id)
                            .expect("Couldn't find joint")
                            .clone();
                        let mut joint_pair: Vec<Joint> = Vec::new();
                        joint_pair.push(parent_joint);
                        joint_pair.push(main_joint);

                        if let Some(child_attach_point) = child_attach_point {
                            println!("joint ik chain {:?} {:?}", joint.id, k_chain);

                            let bone = BoneSegment::new(
                                device,
                                bind_group_layout,
                                parent_id.clone(),
                                joint.id.clone(),
                                adjusted_start,
                                adjusted_end,
                                k_chain.cloned(),
                                Some(child_attach_point.clone()),
                                joint_pair,
                                is_end_effector,
                            );
                            bones.push(bone);
                        }
                    }
                }
            }
        }

        if connection.is_some() {
            self.attachment_transform =
                create_attachment_transform(&connection.expect("Couldn't get connection"));
        }

        self.bones = bones;
    }
}
