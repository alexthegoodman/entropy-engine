use image::DynamicImage;
use nalgebra::{Isometry3, Matrix4, Point3, Translation3, UnitQuaternion, Vector3};
use nalgebra_glm::Vec3;
use rapier3d::prelude::*;
use rapier3d::prelude::{Collider, ColliderBuilder, RigidBody, RigidBodyBuilder};
use std::collections::{HashMap, HashSet};
use std::num::NonZeroU32;
use std::str::FromStr;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Instant;
use util::BufferInitDescriptor;
use uuid::Uuid;
use wgpu::util::DeviceExt;
use wgpu::*;

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Texture::Texture;
use crate::core::Transform_2::{matrix4_to_raw_array, Transform};
use crate::core::vertex::Vertex;
use crate::helpers::landscapes::{get_landscape_pixels, LandscapePixelData};
use crate::helpers::saved_data::LandscapeTextureKinds;
use crate::heightfield_landscapes::LandscapeLOD::{MAX_LOD_LEVELS, calculate_normals, sample_height_world};
use crate::physics::core::{Heightfield, Vec3 as PhysVec3};

use super::LandscapeLOD::{
    create_debug_collision_mesh, distance_squared, get_camera_distance_from_bound_center_rel,
    ColliderMessage, Rect,
};

#[derive(Debug)]
pub struct TerrainMesh {
    pub mesh_id: String,
    pub vertex_buffer: Buffer,
    pub index_buffer: Buffer,
    pub index_count: u32,
    pub collider: Option<Collider>,
    // pub rigid_body: Option<RigidBody>,
    // pub terrain_heightfield: Option<Heightfield>,
    pub depth: u32,
}

// Create a struct to track vertex info for indexing
#[derive(Clone, Debug)]
struct VertexInfo {
    vertex: Vertex,
    is_edge: bool,
    edge_index: Option<usize>, // Position along the edge if it's an edge vertex
    grid_pos: (i32, i32),      // Position in the overall grid
}

// Represents a node in our quadtree
#[derive(Debug)]
pub struct QuadNode {
    pub bounds: Rect,
    pub depth: u32,
    pub children: Option<Box<[QuadNode; 4]>>,
    pub mesh: Option<TerrainMesh>,
    pub debug_mesh: Option<TerrainMesh>,
    pub rigid_body_handle: Option<RigidBodyHandle>,
    pub collider_handle: Option<ColliderHandle>,
    // Track if this node's LOD state has changed
    pub lod_dirty: bool,
}

impl QuadNode {
    pub fn new(
        parent_bounds: Rect,
        bounds: Rect,
        // height_data: &[f32],
        landscape_data: &LandscapePixelData,
        resolution: u32,
        device: &Device,
        terrain_position: [f32; 3],
        landscape_component_id: String,
        collider_sender: Sender<ColliderMessage>,
        corner: &str,
        camera: &mut SimpleCamera
    ) -> Self {
        let depth = 0;
        Self {
            bounds: bounds.clone(),
            depth,
            children: None,
            mesh: Some(Self::create_mesh(
                &parent_bounds.clone(),
                &bounds.clone(),
                // height_data,
                landscape_data,
                resolution,
                device,
                terrain_position,
                landscape_component_id,
                depth,
                collider_sender,
                corner,
                camera
            )),
            debug_mesh: None,
            rigid_body_handle: None,
            collider_handle: None,
            lod_dirty: true, // Start as dirty to ensure initial physics setup
        }
    }

    fn cleanup_physics(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
        island_manager: &mut IslandManager,
        impulse_joint_set: &mut ImpulseJointSet,
        multibody_joint_set: &mut MultibodyJointSet,
    ) {
        // println!("clean up physics!");
        // Remove collider first
        if let Some(handle) = self.collider_handle.take() {
            collider_set.remove(handle, island_manager, rigid_body_set, true);
        }

        // Then remove rigid body
        if let Some(handle) = self.rigid_body_handle.take() {
            rigid_body_set.remove(
                handle,
                island_manager,
                collider_set,
                impulse_joint_set,
                multibody_joint_set,
                true,
            );
        }

        // Recursively cleanup children
        if let Some(ref mut children) = self.children {
            for child in children.iter_mut() {
                child.cleanup_physics(
                    rigid_body_set,
                    collider_set,
                    island_manager,
                    impulse_joint_set,
                    multibody_joint_set,
                );
            }
        }
    }

    fn add_physics_components(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
        device: &wgpu::Device,
    ) {
        // Only add physics for chunks at deeper levels (e.g., more detailed)
        // let min_physics_depth = 2; // Tune this value
        // if self.depth >= min_physics_depth {
        if let Some(ref mut mesh) = self.mesh {
            // Get rigid body
            // if let Some(rigid_body) = mesh.rigid_body.take() {
            // if let Some(ref rigid_body) = mesh.rigid_body {
            //     let rigid_body_handle = rigid_body_set.insert(rigid_body.clone()); // TODO: CANNOT have clones!!
            //     self.rigid_body_handle = Some(rigid_body_handle);
            //     // Create and attach collider if we have one
            //     // if let Some(collider) = mesh.collider.take() {
            //     if let Some(ref collider) = mesh.collider {
            //         // if let Some(debug_mesh) = create_debug_collision_mesh(&collider, device) {
            //         //     self.debug_mesh = Some(debug_mesh);
            //         // }

            //         let collider_handle = collider_set.insert_with_parent(
            //             collider.clone(),
            //             rigid_body_handle,
            //             rigid_body_set,
            //         );
            //         self.collider_handle = Some(collider_handle);
            //     }
            // }
        }
        // }

        // Recursively add physics components to children
        if let Some(ref mut children) = self.children {
            for child in children.iter_mut() {
                child.add_physics_components(rigid_body_set, collider_set, device);
            }
        }
    }

    pub fn split(
        &mut self,
        // height_data: &[f32],
        landscape_data: &LandscapePixelData,
        max_depth: u32,
        device: &Device,
        terrain_position: [f32; 3],
        landscape_component_id: String,
        collider_sender: Sender<ColliderMessage>,
        camera: &mut SimpleCamera
    ) {
        if self.depth + 1 >= max_depth {
            // plus 1 to account for next depth
            return;
        }

        let half_width = self.bounds.width / 2.0;
        let half_height = self.bounds.height / 2.0;

        // Create four child nodes
        let children = Box::new([
            // Top-left
            QuadNode {
                bounds: Rect {
                    x: self.bounds.x,
                    z: self.bounds.z,
                    width: half_width,
                    height: half_height,
                },
                depth: self.depth + 1,
                children: None,
                mesh: Some(Self::create_mesh(
                    &self.bounds,
                    &Rect {
                        x: self.bounds.x,
                        z: self.bounds.z,
                        width: half_width,
                        height: half_height,
                    },
                    // height_data,
                    landscape_data,
                    16,
                    device,
                    terrain_position,
                    landscape_component_id.clone(),
                    self.depth + 1,
                    collider_sender.clone(),
                    "top_left",
                    camera
                )),
                debug_mesh: None,
                // terrain_position: self.terrain_position,
                // landscape_component_id: self.landscape_component_id,
                rigid_body_handle: None,
                collider_handle: None,
                lod_dirty: true,
            },
            // Top-right
            QuadNode {
                bounds: Rect {
                    x: self.bounds.x + half_width,
                    z: self.bounds.z,
                    width: half_width,
                    height: half_height,
                },
                depth: self.depth + 1,
                children: None,
                mesh: Some(Self::create_mesh(
                    &self.bounds,
                    &Rect {
                        x: self.bounds.x + half_width,
                        z: self.bounds.z,
                        width: half_width,
                        height: half_height,
                    },
                    // height_data,
                    landscape_data,
                    16,
                    device,
                    terrain_position,
                    landscape_component_id.clone(),
                    self.depth + 1,
                    collider_sender.clone(),
                    "top_right",
                    camera
                )),
                debug_mesh: None,
                // terrain_position: self.terrain_position,
                // landscape_component_id: self.landscape_component_id,
                rigid_body_handle: None,
                collider_handle: None,
                lod_dirty: true,
            },
            // Bottom-left
            QuadNode {
                bounds: Rect {
                    x: self.bounds.x,
                    z: self.bounds.z + half_height,
                    width: half_width,
                    height: half_height,
                },
                depth: self.depth + 1,
                children: None,
                mesh: Some(Self::create_mesh(
                    &self.bounds,
                    &Rect {
                        x: self.bounds.x,
                        z: self.bounds.z + half_height,
                        width: half_width,
                        height: half_height,
                    },
                    // height_data,
                    landscape_data,
                    16,
                    device,
                    terrain_position,
                    landscape_component_id.clone(),
                    self.depth + 1,
                    collider_sender.clone(),
                    "bottom_left",
                    camera
                )),
                debug_mesh: None,
                // terrain_position: self.terrain_position,
                // landscape_component_id: self.landscape_component_id,
                rigid_body_handle: None,
                collider_handle: None,
                lod_dirty: true,
            },
            // Bottom-right
            QuadNode {
                bounds: Rect {
                    x: self.bounds.x + half_width,
                    z: self.bounds.z + half_height,
                    width: half_width,
                    height: half_height,
                },
                depth: self.depth + 1,
                children: None,
                mesh: Some(Self::create_mesh(
                    &self.bounds,
                    &Rect {
                        x: self.bounds.x + half_width,
                        z: self.bounds.z + half_height,
                        width: half_width,
                        height: half_height,
                    },
                    // height_data,
                    landscape_data,
                    16,
                    device,
                    terrain_position,
                    landscape_component_id.clone(),
                    self.depth + 1,
                    collider_sender.clone(),
                    "bottom_right",
                    camera
                )),
                debug_mesh: None,
                // terrain_position: self.terrain_position,
                // landscape_component_id: self.landscape_component_id,
                rigid_body_handle: None,
                collider_handle: None,
                lod_dirty: true,
            },
        ]);

        self.children = Some(children);
    }

    pub fn update_lod(
        &mut self,
        camera_pos: [f32; 3],
        // height_data: &[f32],
        landscape_data: &LandscapePixelData,
        lod_distances: &Vec<f32>,
        max_depth: u32,
        device: &Device,
        terrain_position: [f32; 3],
        landscape_component_id: String,
        collider_sender: Sender<ColliderMessage>,
        camera: &mut SimpleCamera
    ) -> bool {
        if self.depth + 1 >= max_depth {
            return false;
        }

        let should_split = should_split(
            camera_pos,
            lod_distances,
            terrain_position,
            self.bounds.clone(),
            self.depth,
            camera
        );

        // println!("should_split {:?} {:?}", self.depth, should_split);

        let had_children = self.children.is_some();
        let mut state_changed = false;

        if should_split {
            // Create children if we don't have them
            if !had_children {
                self.split(
                    // height_data,
                    landscape_data,
                    max_depth,
                    device,
                    terrain_position,
                    landscape_component_id.clone(),
                    collider_sender.clone(),
                    camera
                );
                state_changed = true;
            }
            // Find the closest child and only split that one
            if let Some(ref mut children) = self.children {
                // Calculate distances to each child's center
                let mut closest_idx = 0;
                let mut min_distance = f32::MAX;

                // TODO: split all children if should_split is true?

                // for (idx, child) in children.iter().enumerate() {
                //     let child_center = [
                //         terrain_position[0] + child.bounds.x + child.bounds.width / 2.0,
                //         terrain_position[1],
                //         terrain_position[2] + child.bounds.z + child.bounds.height / 2.0,
                //     ];
                //     let dist = distance_squared(camera_pos, child_center);
                //     if dist < min_distance {
                //         min_distance = dist;
                //         closest_idx = idx;
                //     }
                // }

                // // Only update the closest child
                // if children[closest_idx].update_lod(
                //     camera_pos,
                //     height_data,
                //     lod_distances,
                //     max_depth,
                //     device,
                //     terrain_position,
                //     landscape_component_id.clone(),
                //     collider_sender.clone(),
                // ) {
                //     state_changed = true;
                // }

                // // Merge other children if they have subdivisions
                // for (idx, child) in children.iter_mut().enumerate() {
                //     if idx != closest_idx && child.children.is_some() {
                //         child.children = None;
                //         state_changed = true;
                //     }
                // }

                for child in children.iter_mut() {
                    if child.update_lod(
                        camera_pos,
                        // height_data,
                        landscape_data,
                        lod_distances,
                        max_depth,
                        device,
                        terrain_position,
                        landscape_component_id.clone(),
                        collider_sender.clone(),
                        camera
                    ) {
                        state_changed = true;
                    }
                }

                // TODO: merge old unused children?
            }
        } else if had_children {
            self.children = None;
            state_changed = true;
        }

        state_changed
    }

    pub fn update_physics_if_needed(
        &mut self,
        rigid_body_set: &mut RigidBodySet,
        collider_set: &mut ColliderSet,
        island_manager: &mut IslandManager,
        impulse_joint_set: &mut ImpulseJointSet,
        multibody_joint_set: &mut MultibodyJointSet,
        device: &wgpu::Device,
        transform_position: [f32; 3],
        camera: &mut SimpleCamera
    ) -> bool {
        let if_needed_time = Instant::now();

        // Returns true if any physics were updated
        if !self.lod_dirty {
            // Recursively check children
            if let Some(ref mut children) = self.children {
                return children.iter_mut().any(|child| {
                    child.update_physics_if_needed(
                        rigid_body_set,
                        collider_set,
                        island_manager,
                        impulse_joint_set,
                        multibody_joint_set,
                        device,
                        transform_position,
                        camera
                    )
                });
            }
            return false;
        }

        let closest_dist =
            get_camera_distance_from_bound_center_rel(self.bounds.clone(), transform_position, camera)
                .sqrt();

        // TODO: set to reasonable amount
        // clean up on mini?
        // if (closest_dist < PHYSICS_DISTANCE) {
        //     println!("closest_dist on physics {:?}", closest_dist);
        //     // Clean up existing physics components for this node
        //     self.cleanup_physics(
        //         rigid_body_set,
        //         collider_set,
        //         island_manager,
        //         impulse_joint_set,
        //         multibody_joint_set,
        //     );

        //     // Add new physics components if needed
        //     if self.children.is_none() {
        //         // Only leaf nodes get physics components
        //         // this merely adds them to sets, does not create them
        //         self.add_physics_components(rigid_body_set, collider_set, device);
        //     }
        // }

        // Recursively update children's physics
        if let Some(ref mut children) = self.children {
            for child in children.iter_mut() {
                child.update_physics_if_needed(
                    rigid_body_set,
                    collider_set,
                    island_manager,
                    impulse_joint_set,
                    multibody_joint_set,
                    device,
                    transform_position,
                    camera
                );
            }
        }

        let if_needed_duration = if_needed_time.elapsed();
        // println!("  if_needed_duration: {:?}", if_needed_duration);

        self.lod_dirty = false;
        true
    }

    pub fn render<'a>(
        &'a self,
        render_pass: &mut RenderPass<'a>,
        model_bind_group: &'a BindGroup,
        group_bind_group: &'a BindGroup,
        // landscape_bind_group: &'a BindGroup,
        // texture_bind_group: &'a BindGroup,
    ) {
        // Skip depth 0 (root node)
        // if self.depth == 0 || self.depth == 1 || self.depth == 2 || self.depth ==  {
        //     // Only render children if they exist
        //     if let Some(ref children) = self.children {
        //         for child in children.iter() {
        //             child.render(
        //                 render_pass,
        //                 camera_bind_group,
        //                 landscape_bind_group,
        //                 texture_bind_group,
        //             );
        //         }
        //     }
        //     return;
        // }

        // Rest of the render logic for non-root nodes
        if let Some(ref children) = self.children {
            for child in children.iter() {
                child.render(
                    render_pass,
                    model_bind_group,
                    group_bind_group
                    // camera_bind_group,
                    // landscape_bind_group,
                    // texture_bind_group,
                );
            }
            return;
        }

        if let Some(ref mesh) = self.mesh {
            render_pass.set_bind_group(1, model_bind_group, &[]);
            render_pass.set_bind_group(3, group_bind_group, &[]);

            render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
            render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);

            render_pass.draw_indexed(0..mesh.index_count, 0, 0..1);
        }

        if let Some(ref debug_mesh) = self.debug_mesh {
            render_pass.set_bind_group(1, model_bind_group, &[]);
            render_pass.set_bind_group(3, group_bind_group, &[]);

            render_pass.set_vertex_buffer(0, debug_mesh.vertex_buffer.slice(..));
            render_pass
                .set_index_buffer(debug_mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);

            render_pass.draw_indexed(0..debug_mesh.index_count, 0, 0..1);
        }
    }
}

impl QuadNode {
    // Maybe something like this for resolution calculation
    pub fn get_resolution_for_depth(depth: u32) -> u32 {
        // medium range?
        // match depth {
        //     0 => 16,
        //     1 => 16,
        //     2 => 16,
        //     3 => 32,
        //     4 => 32,
        //     5 => 32,
        //     6 => 64,
        //     7 => 64,
        //     8 => 64,
        //     _ => 16,
        // }
        // optimized range?
        match depth {
            0 => 4,
            1 => 4,
            2 => 8,
            3 => 16,
            4 => 16,
            5 => 32,
            6 => 32,
            7 => 32,
            8 => 32,
            _ => 16,
        }
    }

    pub fn create_mesh(
        parent_bounds: &Rect,
        bounds: &Rect,
        // height_data: &[f32],
        landscape_data: &LandscapePixelData,
        edge_resolution: u32,
        device: &Device,
        terrain_position: [f32; 3],
        landscape_component_id: String,
        depth: u32,
        collider_sender: Sender<ColliderMessage>,
        corner: &str,
        camera: &mut SimpleCamera
    ) -> TerrainMesh {
        let height_data = &landscape_data.raw_heights;
        let mesh_time = Instant::now();

        let mesh_id = Uuid::new_v4().to_string();

        // println!("terrain_position {:?}", terrain_position);

        let calc_res = Self::get_resolution_for_depth(depth);

        // Create a matrix to store heights for Rapier
        // add 3 to account for overlap heights for crack healing?
        // let mut height_matrix =
        //     nalgebra::DMatrix::zeros(calc_res as usize + 3, calc_res as usize + 3);
        let mut height_matrix = nalgebra::DMatrix::zeros(calc_res as usize, calc_res as usize);
        let terrain_width = (height_data.len() as f32).sqrt() as f32;
        let terrain_half_width = terrain_width / 2.0;

        // println!("terrain_width {:?} {:?}", height_data.len(), terrain_width);

        // let camera = get_camera();
        // println!("create mesh, cam pos: {:?}", camera.position);

        let mut rapier_vertices = Vec::new();

        // Generate vertices with edge tracking
        let mut edge_vertex_info: Vec<VertexInfo> = Vec::new();
        let mut interior_vertex_info: Vec<VertexInfo> = Vec::new();

        let sample_distance = bounds.width / edge_resolution as f32; // Distance between samples
                                                                     // let sample_distance = 10.0;
                                                                     // let sample_distance = 0.1;
                                                                     // println!("sample_distance {:?}", sample_distance);
        let mut potential_overlaps = Vec::new();

        // Sample points just outside our bounds to heal LOD cracks
        // Left and right of our quad
        for i in 0..edge_resolution {
            let normalized_z = i as f32 / edge_resolution as f32;
            let z = bounds.z + (normalized_z * bounds.height);

            // Sample point to the left of our quad
            let left_x = bounds.x - sample_distance;
            let left_height = sample_height_world(left_x, z, height_data);

            // println!("test sample height {:?} {:?} {:?}", left_x, z, left_height);

            potential_overlaps.push(VertexInfo {
                vertex: Vertex {
                    position: [left_x, left_height, z],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [
                        (left_x + terrain_width / 2.0) / terrain_width,
                        (z + terrain_width / 2.0) / terrain_width,
                    ],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: None,
                grid_pos: (-1, i as i32), // Clearly "left of grid"
            });

            // Sample point to the right of our quad
            let right_x = bounds.x + bounds.width + sample_distance;
            let right_height = sample_height_world(right_x, z, height_data);
            potential_overlaps.push(VertexInfo {
                vertex: Vertex {
                    position: [right_x, right_height, z],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [
                        (right_x + terrain_width / 2.0) / terrain_width,
                        (z + terrain_width / 2.0) / terrain_width,
                    ],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: None,
                grid_pos: (calc_res as i32 + 1, i as i32), // One beyond right edge
            });
        }

        // Above and below our quad
        for i in 0..edge_resolution {
            let normalized_x = i as f32 / edge_resolution as f32;
            let x = bounds.x + (normalized_x * bounds.width);

            // Sample point below our quad
            let bottom_z = bounds.z - sample_distance;
            let bottom_height = sample_height_world(x, bottom_z, height_data);
            potential_overlaps.push(VertexInfo {
                vertex: Vertex {
                    position: [x, bottom_height, bottom_z],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [
                        (x + terrain_width / 2.0) / terrain_width,
                        (bottom_z + terrain_width / 2.0) / terrain_width,
                    ],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: None,
                grid_pos: (i as i32, -1), // Clearly "below grid"
            });

            // Sample point above our quad
            let top_z = bounds.z + bounds.height + sample_distance;
            let top_height = sample_height_world(x, top_z, height_data);
            potential_overlaps.push(VertexInfo {
                vertex: Vertex {
                    position: [x, top_height, top_z],
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [
                        (x + terrain_width / 2.0) / terrain_width,
                        (top_z + terrain_width / 2.0) / terrain_width,
                    ],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: None,
                grid_pos: (i as i32, calc_res as i32 + 1), // One beyond top edge
            });
        }

        // Handle edges first - we'll do this exactly once per edge
        // Left edge
        for i in 0..edge_resolution {
            let normalized_z = i as f32 / (edge_resolution) as f32;

            let height = sample_height_world(
                bounds.x,
                bounds.z + (normalized_z * bounds.height),
                height_data,
            );
            let world_pos = [bounds.x, height, bounds.z + (normalized_z * bounds.height)];

            let tex_x = (world_pos[0] + terrain_width / 2.0) / terrain_width;
            let tex_z = (world_pos[2] + terrain_width / 2.0) / terrain_width;
            let scaled_pos = (i * (calc_res - 1)) / (edge_resolution - 1);

            // Update height matrix for edge position
            // height_matrix[(0, i as usize)] = height + (terrain_position[1] / 2.0);
            // height_matrix[(0, i as usize)] = height;

            edge_vertex_info.push(VertexInfo {
                vertex: Vertex {
                    position: world_pos,
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [tex_x, tex_z],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: Some(i as usize),
                grid_pos: (0, scaled_pos as i32),
            });

            rapier_vertices.push(Point3::new(world_pos[0], world_pos[1], world_pos[2]));
        }

        // Right edge
        for i in 0..edge_resolution {
            let normalized_z = i as f32 / (edge_resolution) as f32;

            let height = sample_height_world(
                bounds.x + bounds.width,
                bounds.z + (normalized_z * bounds.height),
                height_data,
            );
            let world_pos = [
                bounds.x + bounds.width,
                height,
                bounds.z + (normalized_z * bounds.height),
            ];
            let tex_x = (world_pos[0] + terrain_width / 2.0) / terrain_width;
            let tex_z = (world_pos[2] + terrain_width / 2.0) / terrain_width;
            let scaled_pos = (i * (calc_res - 1)) / (edge_resolution - 1);

            // Update height matrix for edge position
            // height_matrix[(calc_res - 1, i as usize)] = height + (terrain_position[1] / 2.0);
            // height_matrix[(calc_res as usize - 1, i as usize)] = height;

            edge_vertex_info.push(VertexInfo {
                vertex: Vertex {
                    position: world_pos,
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [tex_x, tex_z],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: Some(i as usize),
                grid_pos: (calc_res as i32, scaled_pos as i32),
            });

            rapier_vertices.push(Point3::new(world_pos[0], world_pos[1], world_pos[2]));
        }

        // Top edge
        for i in 0..edge_resolution {
            let normalized_x = i as f32 / (edge_resolution) as f32;

            let world_pos = [
                bounds.x + (normalized_x * bounds.width),
                sample_height_world(
                    bounds.x + (normalized_x * bounds.width),
                    bounds.z,
                    height_data,
                ),
                bounds.z,
            ];

            let tex_x = (world_pos[0] + terrain_width / 2.0) / terrain_width;
            let tex_z = (world_pos[2] + terrain_width / 2.0) / terrain_width;
            let scaled_pos = (i * (calc_res - 1)) / (edge_resolution - 1);

            edge_vertex_info.push(VertexInfo {
                vertex: Vertex {
                    position: world_pos,
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [tex_x, tex_z],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: Some(i as usize),
                grid_pos: (scaled_pos as i32, 0),
            });

            rapier_vertices.push(Point3::new(world_pos[0], world_pos[1], world_pos[2]));
        }

        // Bottom edge
        for i in 0..edge_resolution {
            let normalized_x = i as f32 / (edge_resolution) as f32;

            let world_pos = [
                bounds.x + (normalized_x * bounds.width),
                sample_height_world(
                    bounds.x + (normalized_x * bounds.width),
                    bounds.z + bounds.height,
                    height_data,
                ),
                bounds.z + bounds.height,
            ];

            let tex_x = (world_pos[0] + terrain_width / 2.0) / terrain_width;
            let tex_z = (world_pos[2] + terrain_width / 2.0) / terrain_width;
            let scaled_pos = (i * (calc_res - 1)) / (edge_resolution - 1);

            edge_vertex_info.push(VertexInfo {
                vertex: Vertex {
                    position: world_pos,
                    normal: [0.0, 1.0, 0.0],
                    tex_coords: [tex_x, tex_z],
                    color: [1.0, 0.0, 0.0, 1.0],
                },
                is_edge: true,
                edge_index: Some(i as usize),
                grid_pos: (scaled_pos as i32, calc_res as i32),
            });

            rapier_vertices.push(Point3::new(world_pos[0], world_pos[1], world_pos[2]));
        }

        let mut min_height = f32::MAX;
        let mut max_height = f32::MIN;

        // Now handle interior vertices
        for z in -1..=calc_res as i32 {
            for x in -1..=calc_res as i32 {
                let normalized_x = x as f32 / (calc_res) as f32;
                let normalized_z = z as f32 / (calc_res) as f32;
                let height = sample_height_world(
                    bounds.x + (normalized_x * bounds.width),
                    bounds.z + (normalized_z * bounds.height),
                    height_data,
                );
                let world_pos = [
                    bounds.x + (normalized_x * bounds.width),
                    height,
                    bounds.z + (normalized_z * bounds.height),
                ];
                let tex_x = (world_pos[0] + terrain_width / 2.0) / terrain_width;
                let tex_z = (world_pos[2] + terrain_width / 2.0) / terrain_width;

                if (z >= 0 && x >= 0 && z < calc_res as i32 && x < calc_res as i32) {
                    height_matrix[(z as usize, x as usize)] = height; //  +/- (terrain_position[1] / 2.0)
                }

                min_height = min_height.min(height);
                max_height = max_height.max(height);

                interior_vertex_info.push(VertexInfo {
                    vertex: Vertex {
                        position: world_pos,
                        normal: [0.0, 1.0, 0.0],
                        tex_coords: [tex_x, tex_z],
                        color: [1.0, 0.0, 0.0, 1.0],
                    },
                    is_edge: false,
                    edge_index: None,
                    grid_pos: (x as i32, z as i32),
                });

                rapier_vertices.push(Point3::new(world_pos[0], world_pos[1], world_pos[2]));
            }
        }

        let height_diff = max_height - min_height;
        let height_scale = height_diff / 600.0;

        let overlap_distance = 0.5;
        let proximity_threshold = 10.0; // Adjust based on your vertex spacing

        let mut extended_edge_vertex_info: Vec<VertexInfo> = Vec::new();

        // First add all original edge vertices
        for current in &edge_vertex_info {
            extended_edge_vertex_info.push(current.clone());

            // Find nearby sample points
            let nearby_samples: Vec<&VertexInfo> = potential_overlaps
                .iter()
                .filter(|sample| {
                    let current_pos = Vec3::new(
                        current.vertex.position[0],
                        current.vertex.position[1],
                        current.vertex.position[2],
                    );
                    let sample_pos = Vec3::new(
                        sample.vertex.position[0],
                        sample.vertex.position[1],
                        sample.vertex.position[2],
                    );

                    current_pos.metric_distance(&sample_pos) < proximity_threshold
                })
                .collect();

            // Create overlap vertices for each nearby sample
            for sample in nearby_samples {
                let overlap_vertex = VertexInfo {
                    vertex: Vertex {
                        position: [
                            current.vertex.position[0] * (1.0 - overlap_distance)
                                + sample.vertex.position[0] * overlap_distance,
                            current.vertex.position[1] * (1.0 - overlap_distance)
                                + sample.vertex.position[1] * overlap_distance,
                            current.vertex.position[2] * (1.0 - overlap_distance)
                                + sample.vertex.position[2] * overlap_distance,
                        ],
                        normal: current.vertex.normal, // Keep original normal for now
                        tex_coords: current.vertex.tex_coords, // Keep original tex_coords
                        color: current.vertex.color,
                    },
                    is_edge: true,
                    edge_index: sample.edge_index,
                    grid_pos: sample.grid_pos,
                };

                extended_edge_vertex_info.push(overlap_vertex);
            }
        }

        let extended_length = extended_edge_vertex_info.len();

        let mut merged_vertex_info: Vec<VertexInfo> = Vec::new();
        let mut used_grid_positions: HashSet<(i32, i32)> = HashSet::new();

        // Add extended vertices if their grid position isn't taken
        for vertex in &extended_edge_vertex_info {
            if !used_grid_positions.contains(&vertex.grid_pos) {
                used_grid_positions.insert(vertex.grid_pos);
                merged_vertex_info.push(vertex.clone());

                // Update height matrix with overlap vertices
                // if vertex.grid_pos.0 + 1 >= 0
                //     && vertex.grid_pos.1 + 1 >= 0
                //     && vertex.grid_pos.0 + 1 < calc_res as i32 + 3
                //     && vertex.grid_pos.1 + 1 < calc_res as i32 + 3
                // {
                //     height_matrix[(
                //         vertex.grid_pos.1 as usize + 1,
                //         vertex.grid_pos.0 as usize + 1,
                //     )] = vertex.vertex.position[1];
                //     println!(
                //         "Updated height matrix at ({}, {}) with height {}",
                //         vertex.grid_pos.0, vertex.grid_pos.1, vertex.vertex.position[1]
                //     );
                // } else {
                //     println!(
                //         "Couldn't update height matrix at ({}, {}) with height {}",
                //         vertex.grid_pos.0, vertex.grid_pos.1, vertex.vertex.position[1]
                //     );
                // }
            }
        }

        // Add interior vertices if their grid position isn't taken
        for vertex in &interior_vertex_info {
            if !used_grid_positions.contains(&vertex.grid_pos) {
                used_grid_positions.insert(vertex.grid_pos);
                merged_vertex_info.push(vertex.clone());
            }
        }

        // for i in 0..3 {
        //     println!(
        //         "Landscape vertex tex_coords {:?} {:?}",
        //         i,
        //         merged_vertex_info
        //             .get(i)
        //             .expect("Couldn't get vertex")
        //             .vertex
        //             .tex_coords
        //     );
        // }

        let vertices: Vec<Vertex> = merged_vertex_info
            .iter_mut()
            .map(|info| info.vertex.clone())
            .collect();

        // println!("vertices length {:?}", vertices.len());

        let vertex_lookup: HashMap<(i32, i32), usize> = merged_vertex_info
            .iter()
            .enumerate()
            .map(|(index, info)| (info.grid_pos, index))
            .collect();

        // // Fast vertex lookup
        let mut indices = Vec::new();

        // Single loop for all indices since grid positions are now normalized to calc_res
        for z in -1..=calc_res as i32 {
            for x in -1..=calc_res as i32 {
                let x = x as i32;
                let z = z as i32;

                // Try to get all four vertices needed for this quad
                if let (
                    Some(&top_left),
                    Some(&top_right),
                    Some(&bottom_left),
                    Some(&bottom_right),
                ) = (
                    vertex_lookup.get(&(x, z)),
                    vertex_lookup.get(&(x + 1, z)),
                    vertex_lookup.get(&(x, z + 1)),
                    vertex_lookup.get(&(x + 1, z + 1)),
                ) {
                    // Only add indices if we found all four vertices
                    indices.extend_from_slice(&[
                        top_left as u32,
                        bottom_left as u32,
                        top_right as u32,
                        top_right as u32,
                        bottom_left as u32,
                        bottom_right as u32,
                    ]);
                }
                // else {
                //     println!("warning: missing vertex position");
                // }
            }
        }

        let mut cloned_vertices = &mut vertices.clone();

        calculate_normals(cloned_vertices, &indices);

        // Create vertex buffer
        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Terrain Vertex Buffer"),
            contents: bytemuck::cast_slice(&cloned_vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        // Create index buffer
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Terrain Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let sender = collider_sender.clone();
        let rapier_vertices = rapier_vertices.clone();

        // let new_rapier_vertices = cloned_vertices
        //     .iter()
        //     .map(|v| Point3::new(v.position[0], v.position[1], v.position[2]))
        //     .collect();

        let indices_clone = indices.clone();
        let chunk_id = mesh_id.clone();
        let heights = height_matrix.clone();

        // let height_proportion = max_height / landscape_data.max_height;

        // println!(
        //     "max heights: {:?} {:?} proportion: {:?}",
        //     max_height, landscape_data.max_height, height_proportion
        // );

        let scaling_adjustment = 10.0;

        let scaling: nalgebra::Matrix<
            f32,
            nalgebra::Const<3>,
            nalgebra::Const<1>,
            nalgebra::ArrayStorage<f32, 3, 1>,
        > = vector![
            bounds.width as f32 + scaling_adjustment,
            // height_proportion, // Height scale // values are 1-to-1, although i wonder if using the shared max height is helpful
            1.0,
            bounds.height as f32 + scaling_adjustment
        ];

        // // for heightfield
        // let isometry = match corner {
        //     // already accounts for bounds.width and height
        //     "top_left" => Isometry3::translation(bounds.x, 0.0, bounds.z),
        //     "top_right" => Isometry3::translation(bounds.x, 0.0, bounds.z),
        //     "bottom_left" => Isometry3::translation(bounds.x, 0.0, bounds.z),
        //     "bottom_right" => Isometry3::translation(bounds.x, 0.0, bounds.z),
        //     _ => Isometry3::translation(
        //         terrain_position[0],
        //         0.0,
        //         terrain_position[2],
        //     ),
        // };

        // let isometry = Isometry3::translation(bounds.x, 0.0, bounds.z);

        // Create a rotation (e.g., 90 degrees around Y-axis)
        let rot = UnitQuaternion::from_euler_angles(0.0, 0.0, 0.0);
        // Create a translation
        let trans = Translation3::new(bounds.x + (bounds.width / 2.0), 0.0, bounds.z + (bounds.height / 2.0));
        // let trans = Translation3::new(bounds.x, 0.0, bounds.z);
        // let trans = Translation3::new(-bounds.x, 0.0, -bounds.z);
        // Combine into an Isometry
        // isometry can be nothing when using trimesh as that already accounts for world pos
        let isometry = Isometry3::from_parts(trans, rot);

        println!("bounds dimensions {:?} {:?}", bounds.width, bounds.height);

        // // Suggested corrected code:
        // let max_x = bounds.x + bounds.width;
        // let max_z = bounds.z + bounds.height;

        // let isometry = match corner {
        //     // (min_x, 0.0, min_z)
        //     "top_left" => Isometry3::translation(bounds.x, 0.0, bounds.z),

        //     // (max_x, 0.0, min_z)  -> Assumes Z increases downwards on the screen (common in 3D-Z-up systems)
        //     "top_right" => Isometry3::translation(max_x, 0.0, bounds.z),

        //     // (min_x, 0.0, max_z)
        //     "bottom_left" => Isometry3::translation(bounds.x, 0.0, max_z),

        //     // (max_x, 0.0, max_z)
        //     "bottom_right" => Isometry3::translation(max_x, 0.0, max_z),

        //     _ => Isometry3::translation(
        //         terrain_position[0],
        //         0.0,
        //         terrain_position[2],
        //     ),
        // };

        // for trimesh
        // let isometry = match corner {
        //     // bounds.x and bounds.z already adjusted for width and height when creating QuadNode
        //     "top_left" => Isometry3::translation(0.0, -450.0, 0.0), // why ~500? map specific? max_height is about 600
        //     "top_right" => Isometry3::translation(0.0, -450.0, 0.0),
        //     "bottom_left" => Isometry3::translation(0.0, -450.0, 0.0),
        //     "bottom_right" => Isometry3::translation(0.0, -450.0, 0.0),
        //     _ => Isometry3::translation(
        //         terrain_position[0],
        //         terrain_position[1],
        //         terrain_position[2],
        //     ),
        // };

        // only create colliders for nearest children to prevent overlap
        // let mut terrain_heightfield = None;
        if (depth == (MAX_LOD_LEVELS as u32) - 1) {

            // println!("Max depth position {:?}", isometry);

            // Spawn the heavy computation in a separate thread
            // std::thread::spawn(move || {
            //     // let collider = ColliderBuilder::trimesh(
            //     //     new_rapier_vertices,
            //     //     indices_clone
            //     //         .chunks(3)
            //     //         .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            //     //         .collect::<Vec<[u32; 3]>>(),
            //     // )
            //     // .friction(0.9)
            //     // .restitution(0.1)
            //     // .solver_groups(InteractionGroups::all()) // Make sure collision groups are set
            //     // .active_collision_types(ActiveCollisionTypes::all()) // Enable all collision types
            //     // .user_data(Uuid::from_str(&chunk_id).unwrap().as_u128())
            //     // .build();

            //     let collider = ColliderBuilder::heightfield(heights.clone(), scaling)
            //         .friction(0.9)
            //         .restitution(0.1)
            //         .solver_groups(InteractionGroups::all()) // Make sure collision groups are set
            //         .active_collision_types(ActiveCollisionTypes::all())
            //         // .position(Isometry3::translation(0.0, 0.0, 0.0)) // Enable all collision types
            //         .user_data(
            //             Uuid::from_str(&chunk_id) // chunk_id is mesh_id
            //                 .expect("Couldn't extract uuid")
            //                 .as_u128(),
            //         )
            //         .build();

            //     // Send the completed collider back
            //     sender.send((chunk_id, collider)).unwrap();
            // });

            let bounds = bounds.clone();

            std::thread::spawn(move || {
                let terrain_heightfield = Heightfield::from_heights(calc_res as usize, calc_res as usize, heights.data.as_vec().clone(), bounds.width / calc_res as f32, bounds.height / calc_res as f32)
                    .with_offset(PhysVec3::new(bounds.x, 0.0, bounds.z));

                // Send the completed collider back
                sender.send((chunk_id, terrain_heightfield)).unwrap();
            });
            
        } else {
            // println!("no collider {:?}", depth);
        }

        // let rigid_time = Instant::now();

        // let ground_rigid_body = RigidBodyBuilder::fixed()
        //     .position(isometry)
        //     // .position(Isometry3::translation(0.0, 0.0, 0.0)) // world_pos used for rapier_vertices, so trimesh needs no isometry
        //     .user_data(
        //         Uuid::from_str(&mesh_id)
        //             .expect("Couldn't extract uuid")
        //             .as_u128(),
        //     )
        //     .sleeping(false)
        //     .build();

        // let rigid_duration = rigid_time.elapsed();

        TerrainMesh {
            mesh_id,
            vertex_buffer,
            index_buffer,
            index_count: indices.clone().len() as u32,
            collider: None,
            // rigid_body: Some(ground_rigid_body),
            // terrain_heightfield,
            depth,
        }
    }
}

pub fn should_split(
    camera_pos: [f32; 3],
    lod_distances: &Vec<f32>,
    transform_position: [f32; 3],
    bounds: Rect,
    depth: u32,
    camera: &mut SimpleCamera
) -> bool {
    // let closest_dist = get_camera_distance_from_bounds(self.bounds.clone(), transform_position);
    let closest_dist =
        get_camera_distance_from_bound_center_rel(bounds.clone(), transform_position, camera);

    // // Calculate node size (diagonal)
    // let node_size = (bounds.width * bounds.width + bounds.height * bounds.height).sqrt();

    // // Calculate view-dependent error metric
    // // Split if we're close to any part of the node relative to its size
    // let error_threshold = node_size * 0.5; // Adjust this factor to control split aggressiveness
    // let should_split = closest_dist < (lod_distances[depth as usize] * error_threshold).powi(2);

    // println!(
    //     "Depth: {}, Node size: {:.2}, Closest dist: {:.2}, Threshold: {:.2}, Split: {}",
    //     self.depth,
    //     node_size,
    //     closest_dist.sqrt(),
    //     lod_distances[self.depth as usize] * error_threshold,
    //     should_split
    // );

    let should_split = closest_dist < lod_distances[depth as usize];

    should_split
}
