use std::sync::Arc;

use nalgebra::{Matrix4, Vector3};
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use uuid::Uuid;
use wgpu::util::DeviceExt;

use lyon_tessellation::{
    math::Point as LyonPoint, path::Path as LyonPath, BuffersBuilder,
    FillOptions, FillTessellator, FillVertex, StrokeOptions, StrokeTessellator, StrokeVertex,
    VertexBuffers,
};

use crate::core::SimpleCamera::SimpleCamera;
use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use crate::core::editor::{BoundingBox, CANVAS_HORIZ_OFFSET, CANVAS_VERT_OFFSET, Point, Shape, WindowSize};
use crate::core::transform::create_empty_group_transform;
use crate::core::vertex::Vertex;
use crate::shape_primitives::polygon::Stroke;

pub const ARROW_HEAD_SIZE: f32 = 24.0;
pub const ARROW_SHAFT_THICKNESS: f32 = 8.0;

impl Shape for MotionArrow {
    fn bounding_box(&self) -> BoundingBox {
        let min_x = self.start.x.min(self.end.x) - ARROW_HEAD_SIZE / 2.0;
        let min_y = self.start.y.min(self.end.y) - ARROW_HEAD_SIZE / 2.0;
        let max_x = self.start.x.max(self.end.x) + ARROW_HEAD_SIZE / 2.0;
        let max_y = self.start.y.max(self.end.y) + ARROW_HEAD_SIZE / 2.0;

        BoundingBox {
            min: Point { x: min_x, y: min_y },
            max: Point { x: max_x, y: max_y },
        }
    }

    fn contains_point(&self, point: &Point, camera: &SimpleCamera) -> bool {
        // Simple distance-based collision for arrows
        let distance_to_start = ((point.x - self.start.x).powi(2) + (point.y - self.start.y).powi(2)).sqrt();
        let distance_to_end = ((point.x - self.end.x).powi(2) + (point.y - self.end.y).powi(2)).sqrt();
        let arrow_length = ((self.end.x - self.start.x).powi(2) + (self.end.y - self.start.y).powi(2)).sqrt();
        
        // Check if point is close to the arrow line
        distance_to_start + distance_to_end <= arrow_length + ARROW_SHAFT_THICKNESS * 2.0
    }

    fn contains_point_with_tolerance(&self, point: &Point, camera: &SimpleCamera, tolerance_percent: f32) -> bool {
        // Enhanced detection for motion arrows with configurable tolerance
        let distance_to_start = ((point.x - self.start.x).powi(2) + (point.y - self.start.y).powi(2)).sqrt();
        let distance_to_end = ((point.x - self.end.x).powi(2) + (point.y - self.end.y).powi(2)).sqrt();
        let arrow_length = ((self.end.x - self.start.x).powi(2) + (self.end.y - self.start.y).powi(2)).sqrt();
        
        // Apply tolerance multiplier to the detection area
        let base_tolerance = ARROW_SHAFT_THICKNESS * 2.0;
        let enhanced_tolerance = base_tolerance * (1.0 + tolerance_percent / 100.0);
        
        // Check if point is close to the arrow line
        distance_to_start + distance_to_end <= arrow_length + enhanced_tolerance
    }
}

pub fn get_motion_arrow_data(
    window_size: &WindowSize,
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    bind_group_layout: &wgpu::BindGroupLayout,
    camera: &SimpleCamera,
    start: Point,
    end: Point,
    fill: [f32; 4],
    stroke: Stroke,
    transform_layer: i32,
) -> (
    Vec<Vertex>,
    Vec<u32>,
    wgpu::Buffer,
    wgpu::Buffer,
    wgpu::BindGroup,
    Transform,
) {
    let mut geometry: VertexBuffers<Vertex, u32> = VertexBuffers::new();
    let mut fill_tessellator = FillTessellator::new();
    let mut stroke_tessellator = StrokeTessellator::new();

    // Calculate arrow direction and angle
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let angle = dy.atan2(dx);
    let length = (dx * dx + dy * dy).sqrt();

    // Create arrow path (shaft + head)
    let path = create_arrow_path(start, end, angle, length);

    // Fill the arrow
    fill_tessellator
        .tessellate_path(
            &path,
            &FillOptions::default(),
            &mut BuffersBuilder::new(&mut geometry, |vertex: FillVertex| {
                let x = vertex.position().x;
                let y = vertex.position().y;
                Vertex::new(x, y, 0.0, fill)
            }),
        )
        .unwrap();

    // Stroke the arrow (optional, for a border effect)
    if stroke.thickness > 0.0 {
        stroke_tessellator
            .tessellate_path(
                &path,
                &StrokeOptions::default().with_line_width(stroke.thickness),
                &mut BuffersBuilder::new(&mut geometry, |vertex: StrokeVertex| {
                    let x = vertex.position().x;
                    let y = vertex.position().y;
                    Vertex::new(x, y, 0.001, stroke.fill)
                }),
            )
            .unwrap();
    }

    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Arrow Vertex Buffer"),
        contents: bytemuck::cast_slice(&geometry.vertices),
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
    });

    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Arrow Index Buffer"),
        contents: bytemuck::cast_slice(&geometry.indices),
        usage: wgpu::BufferUsages::INDEX,
    });

    let empty_buffer = Matrix4::<f32>::identity();
    let raw_matrix = matrix4_to_raw_array(&empty_buffer);

    let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("Arrow Uniform Buffer"),
        contents: bytemuck::cast_slice(&raw_matrix),
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
    });

    // Create a 1x1 white texture as default
    let texture_size = wgpu::Extent3d {
        width: 1,
        height: 1,
        depth_or_array_layers: 1,
    };

    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Arrow Default White Texture"),
        size: texture_size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });

    let white_pixel: [u8; 4] = [255, 255, 255, 255];

    queue.write_texture(
        wgpu::TexelCopyTextureInfoBase {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        &white_pixel,
        wgpu::TexelCopyBufferLayout {
            offset: 0,
            bytes_per_row: Some(4),
            rows_per_image: None,
        },
        texture_size,
    );

    let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        address_mode_u: wgpu::AddressMode::ClampToEdge,
        address_mode_v: wgpu::AddressMode::ClampToEdge,
        address_mode_w: wgpu::AddressMode::ClampToEdge,
        mag_filter: wgpu::FilterMode::Nearest,
        min_filter: wgpu::FilterMode::Nearest,
        mipmap_filter: wgpu::FilterMode::Nearest,
        ..Default::default()
    });

    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        layout: bind_group_layout,
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

    // Center position for transform
    let center = Point {
        x: (start.x + end.x) / 2.0,
        y: (start.y + end.y) / 2.0,
    };

    let mut transform = Transform::new(
        Vector3::new(0.0, 0.0, 0.0),
        // Vector2::new(center.x, center.y), // currently, the start and end pos are absolute values, so this transform offsets them
        Vector3::new(0.0, 0.0, 0.0), // No rotation since arrow direction is built into geometry
        Vector3::new(1.0, 1.0, 1.0),
        uniform_buffer,
    );

    // transform.layer = transform_layer as f32;
    transform.update_uniform_buffer(queue);

    (
        geometry.vertices,
        geometry.indices,
        vertex_buffer,
        index_buffer,
        bind_group,
        transform,
    )
}

fn create_arrow_path(start: Point, end: Point, angle: f32, length: f32) -> LyonPath {
    let mut builder = LyonPath::builder();

    // Calculate arrow head points
    let head_length = ARROW_HEAD_SIZE;
    let head_width = ARROW_HEAD_SIZE * 0.6;
    let shaft_thickness = ARROW_SHAFT_THICKNESS;

    // Arrow head tip is at the end point
    let tip = LyonPoint::new(end.x, end.y);
    
    // Calculate points for arrow head
    let head_back_x = end.x - head_length * angle.cos();
    let head_back_y = end.y - head_length * angle.sin();
    
    let perpendicular_angle = angle + std::f32::consts::PI / 2.0;
    let head_left = LyonPoint::new(
        head_back_x + (head_width / 2.0) * perpendicular_angle.cos(),
        head_back_y + (head_width / 2.0) * perpendicular_angle.sin(),
    );
    let head_right = LyonPoint::new(
        head_back_x - (head_width / 2.0) * perpendicular_angle.cos(),
        head_back_y - (head_width / 2.0) * perpendicular_angle.sin(),
    );

    // Calculate shaft points
    let shaft_start_left = LyonPoint::new(
        start.x + (shaft_thickness / 2.0) * perpendicular_angle.cos(),
        start.y + (shaft_thickness / 2.0) * perpendicular_angle.sin(),
    );
    let shaft_start_right = LyonPoint::new(
        start.x - (shaft_thickness / 2.0) * perpendicular_angle.cos(),
        start.y - (shaft_thickness / 2.0) * perpendicular_angle.sin(),
    );
    let shaft_end_left = LyonPoint::new(
        head_back_x + (shaft_thickness / 2.0) * perpendicular_angle.cos(),
        head_back_y + (shaft_thickness / 2.0) * perpendicular_angle.sin(),
    );
    let shaft_end_right = LyonPoint::new(
        head_back_x - (shaft_thickness / 2.0) * perpendicular_angle.cos(),
        head_back_y - (shaft_thickness / 2.0) * perpendicular_angle.sin(),
    );

    // Build the complete arrow path
    builder.begin(shaft_start_left);
    builder.line_to(shaft_end_left);
    builder.line_to(head_left);
    builder.line_to(tip);
    builder.line_to(head_right);
    builder.line_to(shaft_end_right);
    builder.line_to(shaft_start_right);
    builder.close();

    builder.build()
}

impl MotionArrow {
    pub fn new(
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &SimpleCamera,
        start: Point,
        end: Point,
        fill: [f32; 4],
        stroke: Stroke,
        transform_layer: i32,
        name: String,
        id: Uuid,
        current_sequence_id: Uuid,
    ) -> Self {
        let adjusted_start = Point {
            x: CANVAS_HORIZ_OFFSET + start.x,
            y: CANVAS_VERT_OFFSET + start.y,
        };
        let adjusted_end = Point {
            x: CANVAS_HORIZ_OFFSET + end.x,
            y: CANVAS_VERT_OFFSET + end.y,
        };

        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_motion_arrow_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                adjusted_start,
                adjusted_end,
                fill,
                stroke,
                transform_layer,
            );

        let (tmp_group_bind_group, _) =
            create_empty_group_transform(device, group_bind_group_layout, window_size);

        MotionArrow {
            id,
            current_sequence_id,
            name,
            start: adjusted_start,
            end: adjusted_end,
            fill,
            stroke,
            transform,
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

    pub fn update_points(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        camera: &SimpleCamera,
        start: Point,
        end: Point,
    ) {
        let adjusted_start = Point {
            x: CANVAS_HORIZ_OFFSET + start.x,
            y: CANVAS_VERT_OFFSET + start.y,
        };
        let adjusted_end = Point {
            x: CANVAS_HORIZ_OFFSET + end.x,
            y: CANVAS_VERT_OFFSET + end.y,
        };

        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_motion_arrow_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                adjusted_start,
                adjusted_end,
                self.fill,
                self.stroke,
                self.layer,
            );

        self.start = adjusted_start;
        self.end = adjusted_end;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn update_opacity(&mut self, queue: &wgpu::Queue, opacity: f32) {
        let new_color = [self.fill[0], self.fill[1], self.fill[2], opacity];

        self.vertices.iter_mut().for_each(|v| {
            v.color = new_color;
        });

        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&self.vertices));
    }

    pub fn update_layer(&mut self, layer_index: i32) {
        self.layer = layer_index;
        // self.transform.layer = layer_index as f32;
    }

    pub fn update_group_position(&mut self, position: [i32; 2]) {
        self.active_group_position = position;
    }

    pub fn update_fill(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        camera: &SimpleCamera,
        fill: [f32; 4],
    ) {
        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_motion_arrow_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                self.start,
                self.end,
                fill,
                self.stroke,
                self.layer,
            );

        self.fill = fill;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn update_stroke(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        camera: &SimpleCamera,
        stroke: Stroke,
    ) {
        let (vertices, indices, vertex_buffer, index_buffer, bind_group, transform) =
            get_motion_arrow_data(
                window_size,
                device,
                queue,
                bind_group_layout,
                camera,
                self.start,
                self.end,
                self.fill,
                stroke,
                self.layer,
            );

        self.stroke = stroke;
        self.vertices = vertices;
        self.indices = indices;
        self.vertex_buffer = vertex_buffer;
        self.index_buffer = index_buffer;
        self.bind_group = bind_group;
        self.transform = transform;
    }

    pub fn to_config(&self) -> MotionArrowConfig {
        MotionArrowConfig {
            id: self.id,
            name: self.name.clone(),
            start: Point {
                x: self.start.x - CANVAS_HORIZ_OFFSET,
                y: self.start.y - CANVAS_VERT_OFFSET,
            },
            end: Point {
                x: self.end.x - CANVAS_HORIZ_OFFSET,
                y: self.end.y - CANVAS_VERT_OFFSET,
            },
            fill: self.fill,
            stroke: self.stroke,
            layer: self.layer,
        }
    }

    pub fn from_config(
        config: &MotionArrowConfig,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &SimpleCamera,
        selected_sequence_id: String,
    ) -> MotionArrow {
        MotionArrow::new(
            window_size,
            device,
            queue,
            model_bind_group_layout,
            group_bind_group_layout,
            camera,
            config.start,
            config.end,
            config.fill,
            config.stroke,
            config.layer,
            config.name.clone(),
            config.id,
            Uuid::from_str(&selected_sequence_id).expect("Couldn't convert string to uuid"),
        )
    }
}

pub struct MotionArrow {
    pub id: Uuid,
    pub current_sequence_id: Uuid,
    pub name: String,
    pub start: Point,
    pub end: Point,
    pub fill: [f32; 4],
    pub stroke: Stroke,
    pub transform: Transform,
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

#[derive(Clone)]
pub struct MotionArrowConfig {
    pub id: Uuid,
    pub name: String,
    pub start: Point,
    pub end: Point,
    pub fill: [f32; 4],
    pub stroke: Stroke,
    pub layer: i32,
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedMotionArrowConfig {
    pub id: String,
    pub name: String,
    pub start: SavedPoint,
    pub end: SavedPoint,
    pub fill: [i32; 4],
    pub stroke: SavedStroke,
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