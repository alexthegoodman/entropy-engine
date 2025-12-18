use nalgebra::{Isometry3, Matrix4, Point3, Vector3};
use wgpu::util::DeviceExt;
use rapier3d::prelude::{Collider, ColliderBuilder, RigidBody, RigidBodyBuilder, ColliderHandle, RigidBodyHandle, point};

use crate::core::{Transform_2::{Transform, matrix4_to_raw_array}, vertex::Vertex};

#[derive(Clone, Copy, PartialEq)]
pub enum RoofType {
    Flat,
    Peaked,
    Hip,
}

pub struct HouseConfig {
    pub wall_thickness: f32,
    pub story_height: f32,
    pub room_grid: Vec<Vec<Vec<bool>>>,
    pub room_unit_size: (f32, f32),
    pub window_width: f32,
    pub window_height: f32,
    pub windows_per_wall: u32,
    pub door_width: f32,
    pub door_height: f32,
    pub ground_floor_doors: bool,
    pub roof_type: RoofType,
    pub roof_height: f32,
    pub roof_overhang: f32,
    pub destruction_level: f32,
}

impl HouseConfig {
    pub fn get_room_unit_size(&self) -> (f32, f32) {
        self.room_unit_size
    }

    pub fn get_grid_dimensions(&self) -> (usize, usize, usize) {
        let x = if self.room_grid.is_empty() { 0 } else { self.room_grid.len() };
        let y = if x == 0 { 0 } else { self.room_grid[0].len() };
        let z = if y == 0 { 0 } else { self.room_grid[0][0].len() };
        (x, y, z)
    }

    pub fn has_room(&self, x: usize, y: usize, z: usize) -> bool {
        if x >= self.room_grid.len() { return false; }
        if y >= self.room_grid[x].len() { return false; }
        if z >= self.room_grid[x][y].len() { return false; }
        self.room_grid[x][y][z]
    }
}

impl Default for HouseConfig {
    fn default() -> Self {
        let room_grid = vec![
            vec![vec![true, true], vec![true, true], vec![true, true]],
            vec![vec![true, true], vec![true, true], vec![true, true]],
        ];

        Self {
            wall_thickness: 0.25,
            story_height: 8.0,
            room_unit_size: (12.0, 12.0),
            room_grid,
            window_width: 2.5,
            window_height: 3.0,
            windows_per_wall: 2,
            door_width: 3.0,
            door_height: 4.2,
            ground_floor_doors: true,
            roof_type: RoofType::Peaked,
            roof_height: 4.0,
            roof_overhang: 0.5,
            destruction_level: 0.0,
        }
    }
}

impl Clone for HouseConfig {
    fn clone(&self) -> Self {
        Self {
            wall_thickness: self.wall_thickness,
            story_height: self.story_height,
            room_grid: self.room_grid.clone(),
            room_unit_size: self.room_unit_size.clone(),
            window_width: self.window_width,
            window_height: self.window_height,
            windows_per_wall: self.windows_per_wall,
            door_width: self.door_width,
            door_height: self.door_height,
            ground_floor_doors: self.ground_floor_doors,
            roof_type: self.roof_type,
            roof_height: self.roof_height,
            roof_overhang: self.roof_overhang,
            destruction_level: self.destruction_level,
        }
    }
}

pub struct Mesh {
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub bind_group: wgpu::BindGroup,
    pub collider: Collider,
    pub collider_handle: Option<ColliderHandle>,
    pub rigid_body: RigidBody,
    pub rigid_body_handle: Option<RigidBodyHandle>,
}

pub struct House {
    pub id: String,
    pub meshes: Vec<Mesh>,
    pub config: HouseConfig,
}

impl House {
    pub fn new(
        id: &str,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        config: &HouseConfig,
        isometry: Isometry3<f32>,
    ) -> Self {
        let mut vertices = Vec::new();
        let mut indices = Vec::new();

        let (room_width, room_depth) = config.get_room_unit_size();
        let (grid_x, grid_y, grid_z) = config.get_grid_dimensions();

        // Replace your existing triple-nested loop in House::new with this block:
        for x in 0..grid_x {
            for y in 0..grid_y {
                for z in 0..grid_z {
                    if !config.has_room(x, y, z) { continue; }

                    // 1. Calculate world-space offsets for this specific room "cell"
                    let x_offset = x as f32 * room_width;
                    let y_offset = y as f32 * config.story_height;
                    let z_offset = z as f32 * room_depth;

                    // 2. FIXED VERTICAL ALIGNMENT
                    // Level Y ceiling and Level Y+1 floor now meet exactly at y_offset
                    let floor_y = y_offset;
                    let ceiling_y = y_offset + config.story_height;
                    let thickness = config.wall_thickness;

                    // --- FLOORS & CEILINGS ---
                    // Floor: Always generated
                    generate_cuboid(&mut vertices, &mut indices,
                        Point3::new(x_offset, floor_y, z_offset),
                        Point3::new(x_offset + room_width, floor_y + thickness, z_offset + room_depth));

                    // Ceiling: Generated if it's the top level or if there's no room directly above
                    if y == grid_y - 1 || !config.has_room(x, y + 1, z) {
                        generate_cuboid(&mut vertices, &mut indices,
                            Point3::new(x_offset, ceiling_y - thickness, z_offset),
                            Point3::new(x_offset + room_width, ceiling_y, z_offset + room_depth));
                    }

                    // --- ADVANCED WALL LOGIC ---
                    // We define the 4 directions to check for neighbors
                    let wall_checks = [
                        (x as i32 + 1, y as i32, z as i32, WallOrientation::LeftRight, true),  // Right
                        (x as i32 - 1, y as i32, z as i32, WallOrientation::LeftRight, false), // Left
                        (x as i32, y as i32, z as i32 + 1, WallOrientation::FrontBack, true),  // Front
                        (x as i32, y as i32, z as i32 - 1, WallOrientation::FrontBack, false), // Back
                    ];

                    for (nx, ny, nz, orient, is_pos_side) in wall_checks {
                        // let has_neighbor = if nx < 0 || ny < 0 || nz < 0 { false } 
                        //                 else { config.has_room(nx as usize, ny as usize, nz as usize) };

                        let is_ground_floor = if ny == 0 { true } else { false };

                        let has_neighbor =
                                nx >= 0 && nx < grid_x as i32 &&
                                ny >= 0 && ny < grid_y as i32 &&
                                nz >= 0 && nz < grid_z as i32 &&
                                config.has_room(nx as usize, ny as usize, nz as usize);


                        // 3. CALCULATE WALL BOUNDS (Centering on grid lines to fix gaps)
                        let wall_min: Point3<f32>;
                        let wall_max: Point3<f32>;

                        match orient {
                            WallOrientation::FrontBack => {
                                let z_pos = if is_pos_side { z_offset + room_depth } else { z_offset };
                                wall_min = Point3::new(x_offset, y_offset, z_pos - (thickness / 2.0));
                                wall_max = Point3::new(x_offset + room_width, y_offset + config.story_height, z_pos + (thickness / 2.0));
                            }
                            WallOrientation::LeftRight => {
                                let x_pos = if is_pos_side { x_offset + room_width } else { x_offset };
                                wall_min = Point3::new(x_pos - (thickness / 2.0), y_offset, z_offset);
                                wall_max = Point3::new(x_pos + (thickness / 2.0), y_offset + config.story_height, z_offset + room_depth);
                            }
                        }

                        // 4. CHOOSE WALL VARIABILITY
                        if !has_neighbor {
                            // EXTERIOR WALL: Always generated with windows/exterior doors
                            // generate_wall_with_openings(&mut vertices, &mut indices, wall_min, wall_max, 
                            //     config, y == 0, orient, WallType::Exterior);

                            let exterior_chance = (x * 19 + y * 11 + z * 5) % 10;

                            if is_ground_floor && (orient == WallOrientation::FrontBack) && exterior_chance < 2 {
                                // Front/Back Door on ground floor
                                generate_wall_with_openings(&mut vertices, &mut indices, wall_min, wall_max, 
                                    config, true, orient, WallType::Exterior);
                            } else if exterior_chance < 6 {
                                // Window wall
                                generate_wall_with_openings(&mut vertices, &mut indices, wall_min, wall_max, 
                                    config, false, orient, WallType::Exterior);
                            } else {
                                // Solid exterior wall (This seals the gaps!)
                                generate_cuboid(&mut vertices, &mut indices, wall_min, wall_max);
                            }

                        } else if is_pos_side {
                        // } else {
                            // INTERIOR BOUNDARY: Only generated once per room pair (positive side only)
                            // Deterministic "Randomness" based on position
                            let chance = (x * 13 + y * 7 + z * 3) % 10; 
                            
                            if chance < 2 {
                                // 20% Chance: No wall at all (Large open-concept space)
                            } else if chance < 6 {
                                // 40% Chance: Interior Wall with a Doorway
                                generate_wall_with_openings(&mut vertices, &mut indices, wall_min, wall_max, 
                                    config, false, orient, WallType::InteriorDoorway);
                            } else {
                                // 40% Chance: Solid Interior Wall
                                generate_cuboid(&mut vertices, &mut indices, wall_min, wall_max);
                            }
                        }
                    }
                }
            }
        }

        generate_roof(&mut vertices, &mut indices, config, grid_x, grid_y, grid_z, room_width, room_depth);

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("House Vertex Buffer: {}", id)),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some(&format!("House Index Buffer: {}", id)),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let (default_sampler, default_albedo_view, default_normal_view, default_pbr_params_view) = 
            create_default_textures_and_sampler(device, queue);

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Model GLB Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let color_render_mode_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Color Render Mode Buffer"),
            contents: bytemuck::cast_slice(&[0i32]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: uniform_buffer.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&default_albedo_view) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&default_sampler) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &color_render_mode_buffer, offset: 0, size: None }) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&default_normal_view) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(&default_pbr_params_view) },
            ],
            label: Some("House Bind Group"),
        });

        let euler = isometry.rotation.euler_angles();
        let transform = Transform::new(
            Vector3::new(isometry.translation.x, isometry.translation.y, isometry.translation.z),
            Vector3::new(euler.0, euler.1, euler.2),
            Vector3::new(1.0, 1.0, 1.0),
            uniform_buffer,
        );

        let rapier_points: Vec<Point3<f32>> = vertices.iter()
            .map(|v| Point3::new(v.position[0], v.position[1], v.position[2])).collect();
        let rapier_indices: Vec<[u32; 3]> = indices.chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]]).collect();

        let collider = ColliderBuilder::trimesh(rapier_points, rapier_indices)
            .friction(0.7).restitution(0.0).build();
        let rigid_body = RigidBodyBuilder::fixed().position(isometry).build();

        let mesh = Mesh {
            transform, vertex_buffer, index_buffer,
            index_count: indices.len() as u32,
            bind_group, collider, collider_handle: None,
            rigid_body, rigid_body_handle: None,
        };

        Self { id: id.to_string(), meshes: vec![mesh], config: config.clone() }
    }
}

fn create_default_textures_and_sampler(
    device: &wgpu::Device, queue: &wgpu::Queue,
) -> (wgpu::Sampler, wgpu::TextureView, wgpu::TextureView, wgpu::TextureView) {
    let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        address_mode_w: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::FilterMode::Linear,
        ..Default::default()
    });

    let default_albedo_texture = device.create_texture_with_data(queue, &wgpu::TextureDescriptor {
        label: Some("Default Albedo Texture"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8UnormSrgb,
        usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, wgpu::util::TextureDataOrder::LayerMajor, &[255, 255, 255, 255]);
    let default_albedo_view = default_albedo_texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default()
    });

    let default_normal_texture = device.create_texture_with_data(queue, &wgpu::TextureDescriptor {
        label: Some("Default Normal Texture"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, wgpu::util::TextureDataOrder::LayerMajor, &[128, 128, 255, 255]);
    let default_normal_view = default_normal_texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default()
    });

    let default_pbr_params_texture = device.create_texture_with_data(queue, &wgpu::TextureDescriptor {
        label: Some("Default PBR Params Texture"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }, wgpu::util::TextureDataOrder::LayerMajor, &[0, 255, 255, 255]);
    let default_pbr_params_view = default_pbr_params_texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default()
    });

    (default_sampler, default_albedo_view, default_normal_view, default_pbr_params_view)
}

fn generate_cuboid(vertices: &mut Vec<Vertex>, indices: &mut Vec<u32>, min: Point3<f32>, max: Point3<f32>) {
    let color = random_building_color();

    let corners = [
        Point3::new(min.x, min.y, min.z), Point3::new(max.x, min.y, min.z),
        Point3::new(max.x, min.y, max.z), Point3::new(min.x, min.y, max.z),
        Point3::new(min.x, max.y, min.z), Point3::new(max.x, max.y, min.z),
        Point3::new(max.x, max.y, max.z), Point3::new(min.x, max.y, max.z),
    ];

    let normals = [
        [0.0, 0.0, -1.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0],
        [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0],
    ];
    
    let faces = [
        (corners[4], corners[5], corners[1], corners[0], normals[0]),
        (corners[7], corners[3], corners[2], corners[6], normals[1]),
        (corners[6], corners[2], corners[1], corners[5], normals[2]),
        (corners[7], corners[4], corners[0], corners[3], normals[3]),
        (corners[7], corners[6], corners[5], corners[4], normals[4]),
        (corners[3], corners[0], corners[1], corners[2], normals[5]),
    ];

    for (p1, p2, p3, p4, normal) in &faces {
        let base_idx = vertices.len() as u32;
        vertices.extend_from_slice(&[
            Vertex { position: [p1.x, p1.y, p1.z], normal: *normal, tex_coords: [0.0, 0.0], color },
            Vertex { position: [p2.x, p2.y, p2.z], normal: *normal, tex_coords: [1.0, 0.0], color },
            Vertex { position: [p3.x, p3.y, p3.z], normal: *normal, tex_coords: [1.0, 1.0], color },
            Vertex { position: [p4.x, p4.y, p4.z], normal: *normal, tex_coords: [0.0, 1.0], color },
        ]);
        indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2, base_idx, base_idx + 2, base_idx + 3]);
    }
}

use rand::Rng;

fn random_building_color() -> [f32; 4] {
    let mut rng = rand::thread_rng();

    if rng.gen_bool(0.5) {
        // Muted brown (brick / wood / dirt)
        let r = rng.gen_range(0.45..0.65);
        let g = rng.gen_range(0.35..0.50);
        let b = rng.gen_range(0.25..0.40);
        [r, g, b, 1.0]
    } else {
        // Light grey (concrete / stone)
        let v = rng.gen_range(0.65..0.85);
        [v, v, v, 1.0]
    }
}


#[derive(Clone, Copy, PartialEq)]
enum WallOrientation { FrontBack, LeftRight }

#[derive(PartialEq)]
pub enum WallType {
    Exterior,
    InteriorDoorway,
}

fn generate_wall_with_openings(
    vertices: &mut Vec<Vertex>, indices: &mut Vec<u32>,
    min: Point3<f32>, max: Point3<f32>,
    config: &HouseConfig, 
    is_ground_floor: bool, // Used to decide between Door vs Window
    orientation: WallOrientation,
    wall_type: WallType,
) {
    let wall_height = max.y - min.y;
    let mid_x = (min.x + max.x) / 2.0;
    let mid_z = (min.z + max.z) / 2.0;

    // 1. Define Opening Dimensions
    let (open_w, open_h, bottom_y) = match wall_type {
        WallType::Exterior => {
            if is_ground_floor {
                // It's a Front/Back Door
                (config.door_width, config.door_height, min.y)
            } else {
                // It's a Window
                let win_bot = min.y + (wall_height * 0.3); // Starts 30% up the wall
                (config.window_width, config.window_height, win_bot)
            }
        }
        WallType::InteriorDoorway => {
            // Interior doors are usually a bit smaller/simpler
            (config.door_width * 0.9, config.door_height * 0.9, min.y)
        },
    };

    // 2. Generate the "Header" (The solid part above the door/window)
    let opening_top = bottom_y + open_h;
    generate_cuboid(vertices, indices, 
        Point3::new(min.x, opening_top, min.z), 
        Point3::new(max.x, max.y, max.z));

    // 3. Generate the "Bottom Filler" (Only for windows)
    if bottom_y > min.y {
        generate_cuboid(vertices, indices, 
            min, 
            Point3::new(max.x, bottom_y, max.z));
    }

    // 4. Generate the "Sides" (The pillars to the left and right of the opening)
    match orientation {
        WallOrientation::FrontBack => {
            let left_edge = mid_x - (open_w / 2.0);
            let right_edge = mid_x + (open_w / 2.0);

            // Left Pillar
            generate_cuboid(vertices, indices, 
                Point3::new(min.x, bottom_y, min.z), 
                Point3::new(left_edge, opening_top, max.z));
            // Right Pillar
            generate_cuboid(vertices, indices, 
                Point3::new(right_edge, bottom_y, min.z), 
                Point3::new(max.x, opening_top, max.z));
        },
        WallOrientation::LeftRight => {
            let front_edge = mid_z - (open_w / 2.0);
            let back_edge = mid_z + (open_w / 2.0);

            // Front Pillar
            generate_cuboid(vertices, indices, 
                Point3::new(min.x, bottom_y, min.z), 
                Point3::new(max.x, opening_top, front_edge));
            // Back Pillar
            generate_cuboid(vertices, indices, 
                Point3::new(min.x, bottom_y, back_edge), 
                Point3::new(max.x, opening_top, max.z));
        }
    }
}

fn generate_roof(
    vertices: &mut Vec<Vertex>, indices: &mut Vec<u32>,
    config: &HouseConfig, grid_x: usize, grid_y: usize, grid_z: usize,
    room_width: f32, room_depth: f32,
) {
    let (room_w, room_d) = config.get_room_unit_size();
    let total_width = grid_x as f32 * room_w;
    let total_depth = grid_z as f32 * room_d;
    let roof_base_y = grid_y as f32 * config.story_height;
    let overhang = config.roof_overhang;
    let min_x = -overhang;
    let max_x = total_width + overhang;
    let min_z = -overhang;
    let max_z = total_depth + overhang;

    match config.roof_type {
        RoofType::Flat => {
            generate_cuboid(vertices, indices,
                Point3::new(min_x, roof_base_y, min_z),
                Point3::new(max_x, roof_base_y + config.wall_thickness, max_z));
        }
        RoofType::Peaked => {
            let peak_x = total_width / 2.0;
            let peak_z = total_depth / 2.0;
            let peak_y = roof_base_y + config.roof_height;

            let base_idx = vertices.len() as u32;
            vertices.extend_from_slice(&[
                Vertex { position: [min_x, roof_base_y, min_z], normal: [0.0, 0.707, -0.707], tex_coords: [0.0, 0.0], color: [0.8, 0.4, 0.2, 1.0] },
                Vertex { position: [max_x, roof_base_y, min_z], normal: [0.0, 0.707, -0.707], tex_coords: [1.0, 0.0], color: [0.8, 0.4, 0.2, 1.0] },
                Vertex { position: [peak_x, peak_y, peak_z], normal: [0.0, 0.707, -0.707], tex_coords: [0.5, 0.5], color: [0.8, 0.4, 0.2, 1.0] },
            ]);
            indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);

            let base_idx = vertices.len() as u32;
            vertices.extend_from_slice(&[
                Vertex { position: [max_x, roof_base_y, max_z], normal: [0.0, 0.707, 0.707], tex_coords: [1.0, 1.0], color: [0.7, 0.35, 0.15, 1.0] },
                Vertex { position: [min_x, roof_base_y, max_z], normal: [0.0, 0.707, 0.707], tex_coords: [0.0, 1.0], color: [0.7, 0.35, 0.15, 1.0] },
                Vertex { position: [peak_x, peak_y, peak_z], normal: [0.0, 0.707, 0.707], tex_coords: [0.5, 0.5], color: [0.7, 0.35, 0.15, 1.0] },
            ]);
            indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);

            let base_idx = vertices.len() as u32;
            vertices.extend_from_slice(&[
                Vertex { position: [min_x, roof_base_y, max_z], normal: [-0.707, 0.707, 0.0], tex_coords: [0.0, 1.0], color: [0.75, 0.37, 0.17, 1.0] },
                Vertex { position: [min_x, roof_base_y, min_z], normal: [-0.707, 0.707, 0.0], tex_coords: [0.0, 0.0], color: [0.75, 0.37, 0.17, 1.0] },
                Vertex { position: [peak_x, peak_y, peak_z], normal: [-0.707, 0.707, 0.0], tex_coords: [0.5, 0.5], color: [0.75, 0.37, 0.17, 1.0] },
            ]);
            indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);

            let base_idx = vertices.len() as u32;
            vertices.extend_from_slice(&[
                Vertex { position: [max_x, roof_base_y, min_z], normal: [0.707, 0.707, 0.0], tex_coords: [1.0, 0.0], color: [0.75, 0.37, 0.17, 1.0] },
                Vertex { position: [max_x, roof_base_y, max_z], normal: [0.707, 0.707, 0.0], tex_coords: [1.0, 1.0], color: [0.75, 0.37, 0.17, 1.0] },
                Vertex { position: [peak_x, peak_y, peak_z], normal: [0.707, 0.707, 0.0], tex_coords: [0.5, 0.5], color: [0.75, 0.37, 0.17, 1.0] },
            ]);
            indices.extend_from_slice(&[base_idx, base_idx + 1, base_idx + 2]);
        }
        RoofType::Hip => {}
    }
}