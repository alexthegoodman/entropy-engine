use std::sync::Arc;

use cgmath::{Matrix4, Vector2};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;
use wgpu::util::DeviceExt;

use crate::core::SimpleCamera::SimpleCamera as Camera;
use crate::{
    core::editor::{BoundingBox, Point, Shape, WindowSize},
    core::transform::{
        create_empty_group_transform, matrix4_to_raw_array, Transform as SnTransform,
    },
    core::vertex::Vertex,
};
use crate::{
    core::editor::{CANVAS_HORIZ_OFFSET, CANVAS_VERT_OFFSET},
};

pub const INTERNAL_LAYER_SPACE: i32 = 10;

impl Shape for Polygon {
    fn bounding_box(&self) -> BoundingBox {
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;

        for point in &self.points {
            min_x = min_x.min(point.x);
            min_y = min_y.min(point.y);
            max_x = max_x.max(point.x);
            max_y = max_y.max(point.y);
        }

        BoundingBox {
            min: Point { x: min_x, y: min_y },
            max: Point { x: max_x, y: max_y },
        }
    }

    fn contains_point(&self, point: &Point, camera: &Camera) -> bool {
        let local_point = self.to_local_space(*point, camera);

        // Implement point-in-polygon test using the ray casting algorithm
        let mut inside = false;
        let mut j = self.points.len() - 1;
        for i in 0..self.points.len() {
            let pi = &self.points[i];
            let pj = &self.points[j];

            if ((pi.y > local_point.y) != (pj.y > local_point.y))
                && (local_point.x < (pj.x - pi.x) * (local_point.y - pi.y) / (pj.y - pi.y) + pi.x)
            {
                inside = !inside;
            }
            j = i;
        }

        inside
    }

    fn contains_point_with_tolerance(&self, point: &Point, camera: &Camera, tolerance_percent: f32) -> bool {
        // For polygon detection with tolerance, we expand the polygon bounds
        let local_point = self.to_local_space(*point, camera);
        
        // Calculate bounding box expansion based on tolerance
        let bbox = self.bounding_box();
        let width = bbox.max.x - bbox.min.x;
        let height = bbox.max.y - bbox.min.y;
        let avg_dimension = (width + height) / 2.0;
        let tolerance_expansion = avg_dimension * (tolerance_percent / 100.0);
        
        // Create expanded points for tolerance detection
        let mut expanded_points = Vec::new();
        for point in &self.points {
            // Expand each point outward from the center
            let center_x = (bbox.min.x + bbox.max.x) / 2.0;
            let center_y = (bbox.min.y + bbox.max.y) / 2.0;
            
            let dx = point.x - center_x;
            let dy = point.y - center_y;
            let distance = (dx * dx + dy * dy).sqrt();
            
            if distance > 0.0 {
                let expansion_factor = (distance + tolerance_expansion) / distance;
                expanded_points.push(Point {
                    x: center_x + dx * expansion_factor,
                    y: center_y + dy * expansion_factor,
                });
            } else {
                expanded_points.push(*point);
            }
        }
        
        // Implement point-in-polygon test on expanded polygon
        let mut inside = false;
        let mut j = expanded_points.len() - 1;
        for i in 0..expanded_points.len() {
            let pi = &expanded_points[i];
            let pj = &expanded_points[j];

            if ((pi.y > local_point.y) != (pj.y > local_point.y))
                && (local_point.x < (pj.x - pi.x) * (local_point.y - pi.y) / (pj.y - pi.y) + pi.x)
            {
                inside = !inside;
            }
            j = i;
        }

        inside
    }
}

use lyon_tessellation::{
    geom::CubicBezierSegment, math::Point as LyonPoint, path::Path as LyonPath, BuffersBuilder,
    FillOptions, FillTessellator, FillVertex, StrokeOptions, StrokeTessellator, StrokeVertex,
    VertexBuffers,
};

pub fn get_polygon_data(
    window_size: &WindowSize,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    bind_group_layout: &wgpu::BindGroupLayout,
    camera: &Camera,
    points: Vec<Point>,
    dimensions: (f32, f32),
    position: Point,
    rotation: f32,
    border_radius: f32,
    fill: [f32; 4],
    stroke: Stroke,
    // base_layer: f32,
    transform_layer: i32,
) -> (
    Vec<Vertex>,
    Vec<u32>,
    wgpu::Buffer,
    wgpu::Buffer,
    wgpu::BindGroup,
    SnTransform,
) {
    // println!("Get polygon data: {:?}", fill);

    let mut geometry: VertexBuffers<Vertex, u32> = VertexBuffers::new();
    let mut fill_tessellator = FillTessellator::new();
    let mut stroke_tessellator = StrokeTessellator::new();

    let path = create_rounded_polygon_path(points, dimensions, border_radius);

    // Fill the polygon
    fill_tessellator
        .tessellate_path(
            &path,
            &FillOptions::default(),
            &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| {
                // let x = ((vertex.position().x) / window_size.width as f32) * 2.0 - 1.0;
                // let y = 1.0 - ((vertex.position().y) / window_size.height as f32) * 2.0;
                let x = vertex.position().x;
                let y = vertex.position().y;

                // Vertex::new(x, y, get_z_layer(base_layer + 2.0), fill)
                Vertex::new(x, y, 0.0, fill)
            }),
        )
        .unwrap();

    // Stroke the polygon (optional, for a border effect)
    if stroke.thickness > 0.0 {
        stroke_tessellator
            .tessellate_path(
                &path,
                &StrokeOptions::default().with_line_width(stroke.thickness),
                &mut BuffersBuilder::new(&mut geometry, |vertex: StrokeVertex| {
                    // let x = ((vertex.position().x) / window_size.width as f32) * 2.0 - 1.0;
                    // let y = 1.0 - ((vertex.position().y) / window_size.height as f32) * 2.0;
                    let x = vertex.position().x;
                    let y = vertex.position().y;

                    // Vertex::new(x, y, get_z_layer(base_layer + 3.0), stroke.fill)
                    Vertex::new(x, y, 0.0 + 0.001, stroke.fill)
                    // Black border
                }),
            )
            .unwrap();
    }

    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Vertex Buffer"),
        contents: bytemuck::cast_slice(&geometry.vertices),
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    });

    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Index Buffer"),
        contents: bytemuck::cast_slice(&geometry.indices),
        usage: wgpu::BufferUsages::INDEX,
    });

    let empty_buffer = Matrix4::<f32>::identity();
    let raw_matrix = matrix4_to_raw_array(&empty_buffer);

    let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Cube Uniform Buffer"),
        contents: bytemuck::cast_slice(&raw_matrix),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    // // TODO: create empty / filler texture_view and sampler as texture not in use for polygon

    // let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
    //     layout: &bind_group_layout,
    //     entries: &[
    //         wgpu::BindGroupEntry {
    //             binding: 0,
    //             resource: uniform_buffer.as_entire_binding(),
    //         },
    //         wgpu::BindGroupEntry {
    //             binding: 1,
    //             resource: wgpu::BindingResource::TextureView(&texture_view),
    //         },
    //         wgpu::BindGroupEntry {
    //             binding: 2,
    //             resource: wgpu::BindingResource::Sampler(&sampler),
    //         },
    //     ],
    //     label: None,
    // });

    // Create a 1x1 white texture as a default
    let texture_size = wgpu::Extent3d {
        width: 1,
        height: 1,
        depth_or_array_layers: 1,
    };

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Default White Texture"),
        size: texture_size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    // Create white pixel data
    let white_pixel: [u8; 4] = [255, 255, 255, 255];

    // Copy white pixel data to texture
    queue.write_texture(
        wgpu::ImageCopyTexture {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &white_pixel,
        wgpu::ImageDataLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: None,
        },
        texture_size,
    );

    let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

    // Create default sampler
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Nearest,
        min_filter: wgpu::FilterMode::Nearest,
        mipmap_filter: wgpu::FilterMode::Nearest,
        ..Default::default()
    });

    // Now create your bind group with these defaults
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        layout: &bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(&texture_view),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: wgpu::BindingResource::Sampler(&sampler),
            },
        ],
        label: None,
    });

    let mut transform = SnTransform::new(
        Vector2::new(position.x, position.y),
        rotation,
        Vector2::new(1.0, 1.0),
        uniform_buffer,
        window_size,
    );

    // -10.0 to provide 10 spots for internal items on top of objects
    // transform.layer = transform_layer as f32 - 0 as f32; // important?
    transform.layer = transform_layer as f32;
    transform.update_uniform_buffer(&queue, &WindowSize { width: camera.viewport.window_size.width, height: camera.viewport.window_size.height });

    (
        geometry.vertices,
        geometry.indices,
        vertex_buffer,
        index_buffer,
        bind_group,
        transform,
    )
}

use lyon_tessellation::math::point;
use lyon_tessellation::math::Vector;

fn create_rounded_polygon_path(
    normalized_points: Vec<Point>,
    dimensions: (f32, f32),
    border_radius: f32,
) -> LyonPath {
    let mut builder = LyonPath::builder();
    let n = normalized_points.len();

    // Scale border radius to match dimensions
    let scaled_radius = border_radius / dimensions.0.min(dimensions.1);

    // Calculate half dimensions for centering
    let half_width = dimensions.0 / 2.0;
    let half_height = dimensions.1 / 2.0;

    for i in 0..n {
        let p0 = normalized_points[(i + n - 1) % n];
        let p1 = normalized_points[i];
        let p2 = normalized_points[(i + 1) % n];

        let v1 = Vector::new(p1.x - p0.x, p1.y - p0.y);
        let v2 = Vector::new(p2.x - p1.x, p2.y - p1.y);

        let len1 = (v1.x * v1.x + v1.y * v1.y).sqrt();
        let len2 = (v2.x * v2.x + v2.y * v2.y).sqrt();

        let radius = scaled_radius.min(len1 / 2.0).min(len2 / 2.0);

        let offset1 = Vector::new(v1.x / len1 * radius, v1.y / len1 * radius);
        let offset2 = Vector::new(v2.x / len2 * radius, v2.y / len2 * radius);

        // let p1_scaled = LyonPoint::new(p1.x * dimensions.0, p1.y * dimensions.1);

        // Scale and center the point
        let p1_scaled = LyonPoint::new(
            (p1.x * dimensions.0) - half_width,
            (p1.y * dimensions.1) - half_height,
        );

        let corner_start = point(
            p1_scaled.x - offset1.x * dimensions.0,
            p1_scaled.y - offset1.y * dimensions.1,
        );
        let corner_end = point(
            p1_scaled.x + offset2.x * dimensions.0,
            p1_scaled.y + offset2.y * dimensions.1,
        );

        if i == 0 {
            builder.begin(corner_start);
        }

        let control1 = p1_scaled;
        let control2 = p1_scaled;

        let bezier = CubicBezierSegment {
            from: corner_start,
            ctrl1: control1,
            ctrl2: control2,
            to: corner_end,
        };

        builder.cubic_bezier_to(bezier.ctrl1, bezier.ctrl2, bezier.to);
    }

    builder.close();
    builder.build()
}

use cgmath::SquareMatrix;

impl Polygon {
    pub fn new(
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &Camera,
        points: Vec<Point>,
        dimensions: (f32, f32),
        position: Point,
        rotation: f32,
        border_radius: f32,
        fill: [f32; 4],
        stroke: Stroke,
        // base_layer: f32,
        transform_layer: i32,
        name: String,
        id: Uuid,
        current_sequence_id: Uuid,
    ) -> Self {
        // let id = Uuid::new_v4();
        // let transform = SnTransform::new(position);
        // let default_stroke = Stroke {
        //     thickness: 2.0,
        //     fill: rgb_to_wgpu(0, 0, 0, 1.0),
        // };

        let position = Point {
            x: CANVAS_HORIZ_OFFSET + position.x,
            y: CANVAS_VERT_OFFSET + position.y,
        };

        // println!("new poly {:?}", transform_layer);

        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_polygon_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                points.clone(),
                dimensions,
                position,
                rotation,
                border_radius,
                fill,
                stroke,
                // base_layer,
                transform_layer,
            );

        // println!("new layer {:?}", transform.layer);

        // -10.0 to provide 10 spots for internal items on top of objects
        // let transform_layer = transform_layer - 0;

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, window_size);

        Polygon {
            id,
            current_sequence_id,
            source_polygon_id: None,
            source_keyframe_id: None,
            source_path_id: None,
            name,
            points,
            old_points: None,
            dimensions,
            transform,
            border_radius,
            fill,
            stroke,
            vertices,
            indices,
            vertex_buffer,
            index_buffer,
            bind_group,
            hidden: false,
            layer: transform_layer,
            group_bind_group: tmp_group_bind_group,
            active_group_position: [0, 0],
        }
    }

    pub fn update_opacity(&mut self, queue: &wgpu::Queue, opacity: f32) {
        let new_color = [self.fill[0], self.fill[1], self.fill[2], opacity];

        self.vertices.iter_mut().for_each(|v| {
            v.color = new_color;
        });

        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&self.vertices));
    }

    pub fn update_layer(&mut self, layer_index: i32) {
        // -10.0 to provide 10 spots for internal items on top of objects
        // let layer_index = layer_index - 0;
        self.layer = layer_index;
        self.transform.layer = layer_index as f32;
    }

    pub fn update_group_position(&mut self, position: [i32; 2]) {
        self.active_group_position = position;
    }

    // pub fn to_local_space(&self, world_point: Point, camera: &Camera) -> Point {
    //     // update for centering
    //     let untranslated = Point {
    //         x: (world_point.x - self.transform.position.x) + (self.dimensions.0 / 2.0),
    //         y: (world_point.y - self.transform.position.y) + (self.dimensions.1 / 2.0),
    //     };

    //     let local_point = Point {
    //         x: untranslated.x / (self.dimensions.0),
    //         y: untranslated.y / (self.dimensions.1),
    //     };

    //     // println!("local_point {:?} {:?}", self.name, local_point);

    //     local_point
    // }

    pub fn to_local_space(&self, world_point: Point, camera: &Camera) -> Point {
        // First untranslate the point relative to polygon's position
        let untranslated = Point {
            x: world_point.x - self.transform.position.x - self.active_group_position[0] as f32,
            y: world_point.y - self.transform.position.y - self.active_group_position[1] as f32,
        };

        // Apply inverse rotation
        let rotation_rad = -self.transform.rotation; // Negative for inverse rotation
        let rotated = Point {
            x: untranslated.x * rotation_rad.cos() - untranslated.y * rotation_rad.sin(),
            y: untranslated.x * rotation_rad.sin() + untranslated.y * rotation_rad.cos(),
        };

        // Center the point and scale to normalized coordinates
        let local_point = Point {
            x: (rotated.x + (self.dimensions.0 / 2.0)) / self.dimensions.0,
            y: (rotated.y + (self.dimensions.1 / 2.0)) / self.dimensions.1,
        };

        local_point
    }

    pub fn update_data_from_dimensions(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        dimensions: (f32, f32),
        camera: &Camera,
    ) {
        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_polygon_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                self.points.clone(),
                dimensions,
                Point {
                    x: self.transform.position.x,
                    y: self.transform.position.y,
                },
                self.transform.rotation,
                self.border_radius,
                self.fill,
                self.stroke,
                // 0.0,
                // self.layer + INTERNAL_LAYER_SPACE,
                self.layer
            );

        self.dimensions = dimensions;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn update_data_from_position(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        bind_group_layout: &wgpu::BindGroupLayout,
        position: Point,
        camera: &Camera,
    ) {
        self.transform
            .update_position([position.x, position.y], &WindowSize { width: camera.viewport.window_size.width, height: camera.viewport.window_size.height });
    }

    pub fn update_data_from_border_radius(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        border_radius: f32,
        camera: &Camera,
    ) {
        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_polygon_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                self.points.clone(),
                self.dimensions,
                Point {
                    x: self.transform.position.x,
                    y: self.transform.position.y,
                },
                self.transform.rotation,
                border_radius,
                self.fill,
                self.stroke,
                // 0.0,
                // self.layer + INTERNAL_LAYER_SPACE,
                self.layer
            );



        self.border_radius = border_radius;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn update_data_from_stroke(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        stroke: Stroke,
        camera: &Camera,
    ) {
        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_polygon_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                self.points.clone(),
                self.dimensions,
                Point {
                    x: self.transform.position.x,
                    y: self.transform.position.y,
                },
                self.transform.rotation,
                self.border_radius,
                self.fill,
                stroke,
                // 0.0,
                // self.layer + INTERNAL_LAYER_SPACE,
                self.layer
            );

        self.stroke = stroke;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn update_data_from_fill(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        fill: [f32; 4],
        camera: &Camera,
    ) {
        println!("Update polygon fill {:?} {:?}", self.id, fill);

        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_polygon_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                self.points.clone(),
                self.dimensions,
                Point {
                    x: self.transform.position.x,
                    y: self.transform.position.y,
                },
                self.transform.rotation,
                self.border_radius,
                fill,
                self.stroke,
                // 0.0,
                // self.layer + INTERNAL_LAYER_SPACE,
                self.layer
            );

        self.fill = fill;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn world_bounding_box(&self) -> BoundingBox {
        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = f32::MIN;
        let mut max_y = f32::MIN;

        for point in &self.points {
            let world_x = point.x * self.dimensions.0 + self.transform.position.x;
            let world_y = point.y * self.dimensions.1 + self.transform.position.y;
            min_x = min_x.min(world_x);
            min_y = min_y.min(world_y);
            max_x = max_x.max(world_x);
            max_y = max_y.max(world_y);
        }

        BoundingBox {
            min: Point { x: min_x, y: min_y },
            max: Point { x: max_x, y: max_y },
        }
    }

    pub fn to_config(&self) -> PolygonConfig {
        PolygonConfig {
            id: self.id,
            name: self.name.clone(),
            points: self.points.clone(),
            fill: self.fill,
            dimensions: self.dimensions,
            position: Point {
                x: self.transform.position.x - CANVAS_HORIZ_OFFSET,
                y: self.transform.position.y - CANVAS_VERT_OFFSET,
            },
            border_radius: self.border_radius,
            stroke: self.stroke,
            layer: self.layer,
        }
    }

    pub fn from_config(
        config: &PolygonConfig,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &Camera,
        selected_sequence_id: String,
    ) -> Polygon {
        Polygon::new(
            window_size,
            device,
            queue,
            model_bind_group_layout,
            group_bind_group_layout,
            camera,
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 1.0, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
                Point { x: 0.0, y: 1.0 },
            ],
            (config.dimensions.0, config.dimensions.1), // width = length of segment, height = thickness
            config.position,
            0.0,
            config.border_radius,
            // [0.5, 0.8, 1.0, 1.0], // light blue with some transparency
            config.fill,
            config.stroke,
            // -2.0,
            config.layer,
            config.name.clone(),
            config.id,
            Uuid::from_str(&selected_sequence_id).expect("Couldn't convert string to uuid"),
        )
    }
}

// Helper function to calculate the distance from a point to a line segment
// fn point_to_line_segment_distance(point: Point, start: Point, end: Point) -> f32 {
//     let dx = end.x - start.x;
//     let dy = end.y - start.y;
//     let length_squared = dx * dx + dy * dy;

//     if length_squared == 0.0 {
//         return distance(point, start);
//     }

//     let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / length_squared;
//     let t = t.max(0.0).min(1.0);

//     let projection = Point {
//         x: start.x + t * dx,
//         y: start.y + t * dy,
//     };

//     distance(point, projection)
// }

pub struct Polygon {
    pub id: Uuid,
    pub current_sequence_id: Uuid,
    pub source_polygon_id: Option<Uuid>,
    pub source_keyframe_id: Option<Uuid>,
    pub source_path_id: Option<Uuid>,
    pub name: String,
    pub points: Vec<Point>,
    pub old_points: Option<Vec<Point>>,
    pub dimensions: (f32, f32), // (width, height) in pixels
    pub fill: [f32; 4],
    pub transform: SnTransform,
    pub border_radius: f32,
    pub stroke: Stroke,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    pub hidden: bool,
    pub layer: i32,
    pub group_bind_group: wgpu::BindGroup,
    pub active_group_position: [i32; 2],
}

#[derive(Clone, Copy, Debug)]
pub struct Stroke {
    pub thickness: f32,
    pub fill: [f32; 4],
}

// I don't like repeating all these fields,
// but using config as field of polygon requires cloning a lot!
#[derive(Clone)]
pub struct PolygonConfig {
    pub id: Uuid,
    pub name: String,
    pub points: Vec<Point>,
    pub fill: [f32; 4],
    pub dimensions: (f32, f32), // (width, height) in pixels
    pub position: Point,
    pub border_radius: f32,
    pub stroke: Stroke,
    pub layer: i32,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedStroke {
    pub thickness: i32,
    pub fill: [i32; 4],
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedPolygonConfig {
    pub id: String,
    pub name: String,
    // pub points: Vec<SavedPoint>,
    pub fill: [i32; 4],
    pub dimensions: (i32, i32), // (width, height) in pixels
    pub position: SavedPoint,   // this will signify the 3rd and 4th keyframe in generated keyframes
    pub border_radius: i32,
    pub stroke: SavedStroke,
    pub layer: i32,
}
