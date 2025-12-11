use std::collections::HashMap;

use fontdue::{
    layout::{
        CoordinateSystem, GlyphPosition, GlyphRasterConfig, Layout, LayoutSettings, TextStyle,
    },
    Font,
};
use nalgebra::{Matrix4, Vector3};
use uuid::Uuid;
use wgpu::{BindGroup, Buffer, Device, Queue};
// use allsorts::binary::read::ReadScope;
// use allsorts::font::read_cmap_subtable;
use serde::Deserialize;
use serde::Serialize;
use std::str::FromStr;
use std::sync::Arc;
use wgpu::util::DeviceExt;

use crate::core::{SimpleCamera::SimpleCamera as Camera, Transform_2::{Transform, matrix4_to_raw_array}};
use crate::core::{
    // camera::Camera3D as Camera,
    editor::{Point, WindowSize},
    vertex::Vertex,
};
use crate::core::{editor::rgb_to_wgpu, transform::create_empty_group_transform};
use crate::core::editor::wgpu_to_human;
use crate::{
    core::editor::{CANVAS_HORIZ_OFFSET, CANVAS_VERT_OFFSET},
    shape_primitives::polygon::{Polygon, SavedPoint, Stroke},
};

pub struct AtlasGlyph {
    pub uv_rect: [f32; 4], // x, y, width, height in UV coordinates
    pub metrics: [f32; 4], // width, height, xmin, ymin in pixels
}

#[derive(Clone)]
pub struct TextRendererConfig {
    pub id: Uuid,
    pub name: String,
    pub text: String,
    pub font_family: String,
    pub font_size: i32,
    pub dimensions: (f32, f32),
    pub position: Point,
    pub layer: i32,
    pub color: [i32; 4],
    pub background_fill: [i32; 4],
}

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedTextRendererConfig {
    pub id: String,
    pub name: String,
    pub text: String,
    pub font_family: String,
    pub font_size: i32,
    pub dimensions: (i32, i32),
    // position is determined by the keyframes, but initial position is not
    pub position: SavedPoint,
    pub layer: i32,
    pub color: [i32; 4],
    pub background_fill: Option<[i32; 4]>,
}

pub struct TextRenderer {
    pub id: Uuid,
    pub current_sequence_id: Uuid,
    pub intialized: bool,
    pub name: String,
    pub text: String,
    pub font: Font,
    pub font_family: String,
    pub transform: Transform,
    pub bind_group: BindGroup,
    pub vertex_buffer: Buffer,
    pub index_buffer: Buffer,
    pub dimensions: (f32, f32), // (width, height) in pixels
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub atlas_texture: wgpu::Texture,
    pub atlas_size: (u32, u32),
    pub next_atlas_position: (u32, u32),
    pub current_row_height: u32,
    // pub glyph_cache: HashMap<String, AtlasGlyph>,
    pub glyph_cache: HashMap<GlyphRasterConfig, AtlasGlyph>,
    pub hidden: bool,
    pub layer: i32,
    pub color: [i32; 4],
    pub font_size: i32,
    pub group_bind_group: BindGroup,
    pub background_polygon: Polygon,
}

impl TextRenderer {
    pub fn new(
        device: &Device,
        queue: &Queue,
        bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        font_data: &[u8],
        window_size: &WindowSize,
        text: String,
        text_config: TextRendererConfig,
        id: Uuid,
        current_sequence_id: Uuid,
        camera: &Camera,
    ) -> Self {
        // Load and initialize the font
        // TODO: inefficient to load this font per text item
        let font = Font::from_bytes(font_data, fontdue::FontSettings::default())
            .expect("Failed to load font");

        // Create texture atlas
        let atlas_size = (4096, 4096);
        let atlas_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Glyph Atlas Texture"),
            size: wgpu::Extent3d {
                width: atlas_size.0,
                height: atlas_size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            // view_formats: &[wgpu::TextureFormat::R8Unorm],
            view_formats: &[wgpu::TextureFormat::Rgba8Unorm],
            dimension: wgpu::TextureDimension::D2,
            // format: wgpu::TextureFormat::R8Unorm,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        });

        // Initialize empty vertex and index buffers
        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Text Vertex Buffer"),
            // size: 4096, // Initial size, can be adjusted
            size: 65536, // 64KB, better for large amount of text
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Text Index Buffer"),
            // size: 4096, // Initial size, can be adjusted
            size: 65536, // 64KB, better for large amount of text
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Text Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let texture_view = atlas_texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create sampler with appropriate filtering
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

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

        let mut transform = Transform::new(
            Vector3::new(text_config.position.x, text_config.position.y, 0.0),
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(1.0, 1.0, 1.0),
            uniform_buffer,
        );

        // -10.0 to provide 10 spots for internal items on top of objects
        // transform.layer = text_config.layer as f32 - 0 as f32;
        transform.update_uniform_buffer(&queue);

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, window_size);

        let mut background_polygon = Polygon::new(
            &window_size,
            &device,
            &queue,
            bind_group_layout,
            group_bind_group_layout,
            &camera,
            // TODO: restoring triangles or non rectangles?
            vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 1.0, y: 0.0 },
                Point { x: 1.0, y: 1.0 },
                Point { x: 0.0, y: 1.0 },
            ],
            (
                text_config.dimensions.0 as f32,
                text_config.dimensions.1 as f32,
            ),
            Point {
                // x: random_number_800 as f32,
                // y: random_number_450 as f32,
                x: text_config.position.x as f32 - CANVAS_HORIZ_OFFSET,
                y: text_config.position.y as f32 - CANVAS_VERT_OFFSET,
            },
            // TODO: restore rotation?
            (0.0, 0.0, 0.0),
            0.0 as f32,
            rgb_to_wgpu(
                text_config.background_fill[0] as u8,
                text_config.background_fill[1] as u8,
                text_config.background_fill[2] as u8,
                text_config.background_fill[3] as f32,
            ),
            Stroke {
                thickness: 0.0 as f32,
                fill: [0.0 as f32, 0.0 as f32, 0.0 as f32, 0.0 as f32],
            },
            // -2.0,
            (text_config.layer.clone() as f32 - 1.0) as i32,
            text_config.name.clone(),
            text_config.id,
            current_sequence_id.clone(),
        );

        background_polygon.hidden = false;

        Self {
            id,
            current_sequence_id,
            intialized: false,
            name: "New Text Item".to_string(),
            text,
            font,
            font_family: text_config.font_family.clone(),
            transform,
            vertex_buffer,
            index_buffer,
            vertices: Vec::new(),
            indices: Vec::new(),
            dimensions: (text_config.dimensions.0, text_config.dimensions.1),
            bind_group,
            atlas_texture,
            atlas_size,
            next_atlas_position: (0, 0),
            current_row_height: 0,
            glyph_cache: HashMap::new(),
            hidden: false,
            layer: text_config.layer - 0,
            color: text_config.color,
            font_size: text_config.font_size,
            group_bind_group: tmp_group_bind_group,
            background_polygon,
        }
    }

    pub fn update_layer(&mut self, layer_index: i32) {
        // -10.0 to provide 10 spots for internal items on top of objects
        let layer_index = layer_index - 0;
        self.layer = layer_index;
        // self.transform.layer = layer_index as f32;
        // self.background_polygon.layer = layer_index - 1;
        // self.background_polygon.transform.layer = (layer_index - 1) as f32;
    }

    fn add_glyph_to_atlas(
        &mut self,
        device: &Device,
        queue: &Queue,
        raster_config: GlyphRasterConfig,
    ) -> AtlasGlyph {
        // println!(
        //     "Adding glyph... Atlas Position: {:?}",
        //     self.next_atlas_position
        // );

        // let (metrics, bitmap) = self.font.rasterize(c, self.font_size as f32);
        let (metrics, bitmap) = self.font.rasterize_config(raster_config);

        // more efficient way than this could involve shader, perhaps a mode as uniform buffer
        let mut rgba_data = Vec::with_capacity(bitmap.len() * 4);
        for &alpha in bitmap.iter() {
            rgba_data.extend_from_slice(&[255, 255, 255, alpha]);
        }

        // Check if we need to move to the next row
        if self.next_atlas_position.0 + metrics.width as u32 > self.atlas_size.0 {
            self.next_atlas_position.0 = 0;
            self.next_atlas_position.1 += self.current_row_height;
            self.current_row_height = 0;
        }

        // Update current row height if this glyph is taller
        self.current_row_height = self.current_row_height.max(metrics.height as u32);

        // Calculate UV coordinates
        let uv_rect = [
            self.next_atlas_position.0 as f32 / self.atlas_size.0 as f32,
            self.next_atlas_position.1 as f32 / self.atlas_size.1 as f32,
            metrics.width as f32 / self.atlas_size.0 as f32,
            metrics.height as f32 / self.atlas_size.1 as f32,
        ];

        // println!("Writing texture...");

        // Write glyph bitmap to atlas
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas_texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: self.next_atlas_position.0,
                    y: self.next_atlas_position.1,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            // &bitmap,
            &rgba_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(metrics.width as u32 * 4), // *4 for rgba
                rows_per_image: Some(metrics.height as u32),
            },
            wgpu::Extent3d {
                width: metrics.width as u32,
                height: metrics.height as u32,
                depth_or_array_layers: 1,
            },
        );

        // Update atlas position for next glyph
        self.next_atlas_position.0 += metrics.width as u32;

        AtlasGlyph {
            uv_rect,
            metrics: [
                metrics.width as f32,
                metrics.height as f32,
                metrics.xmin as f32,
                metrics.ymin as f32,
            ],
        }
    }

    pub fn update(&mut self, device: &Device, queue: &Queue, text: String, dimensions: (f32, f32)) {
        self.dimensions = dimensions;
        self.update_text(device, queue, text);

        self.intialized = true;
    }

    pub fn update_text(&mut self, device: &Device, queue: &Queue, text: String) {
        self.text = text;
        self.render_text(device, queue);
    }

    pub fn update_font_family(&mut self, font_data: &[u8]) {
        let font = Font::from_bytes(font_data, fontdue::FontSettings::default())
            .expect("Failed to load font");

        self.font = font;
        self.glyph_cache = HashMap::new();
    }

    pub fn render_text<'a>(&'a mut self, device: &Device, queue: &Queue) {
        let mut vertices = Vec::new();
        let mut indices: Vec<u32> = Vec::new();

        let text = self.text.clone();

        // Create a layout instance
        let mut layout = Layout::new(CoordinateSystem::PositiveYDown);

        // Configure layout settings
        let layout_settings = LayoutSettings {
            max_width: Some(self.dimensions.0), // Set a maximum width for text wrapping
            ..LayoutSettings::default()
        };
        layout.reset(&layout_settings);

        // Append text to the layout
        let font = &self.font; // Assuming `self.font` is your `fontdue::Font` instance
        let style = TextStyle {
            text: &text,
            font_index: 0, // Use the first font in the list
            px: self.font_size as f32,
            user_data: (),
        };
        layout.append(&[font], &style);

        // Get the laid out glyphs
        let glyphs = layout.glyphs();

        // Calculate the total width and height of the text
        // TODO: more accurate to just use dimensions instead?
        let total_width = glyphs
            .iter()
            .fold(0.0, |max_width: f32, glyph: &GlyphPosition| {
                max_width.max(glyph.x + glyph.width as f32)
            });
        let total_height = layout.height();

        // Calculate the starting x and y positions to center the text
        let start_x = -total_width / 2.0;
        let start_y = -total_height / 2.0;

        for glyph in glyphs {
            let key: GlyphRasterConfig = glyph.key; // hashable key

            // Ensure the glyph is in the atlas
            if !self.glyph_cache.contains_key(&key) {
                let atlas_glyph = self.add_glyph_to_atlas(device, queue, glyph.key);
                self.glyph_cache.insert(key.clone(), atlas_glyph);
            }

            let atlas_glyph = self.glyph_cache.get(&key).unwrap();

            let base_vertex = vertices.len() as u32;

            // Calculate vertex positions using the glyph's position and metrics
            let x0 = start_x + glyph.x;
            let x1 = x0 + atlas_glyph.metrics[0];
            let y0 = start_y + glyph.y;
            let y1 = y0 + atlas_glyph.metrics[1];

            // UV coordinates from atlas
            let u0 = atlas_glyph.uv_rect[0];
            let u1 = u0 + atlas_glyph.uv_rect[2];
            let v0 = atlas_glyph.uv_rect[1];
            let v1 = v0 + atlas_glyph.uv_rect[3];

            // let z = get_z_layer(1.0);
            let z = 0.0;

            let active_color = rgb_to_wgpu(
                self.color[0] as u8,
                self.color[1] as u8,
                self.color[2] as u8,
                255.0,
            );

            vertices.extend_from_slice(&[
                Vertex {
                    position: [x0, y0, z],
                    normal: [0.0, 0.0, 0.0],
                    tex_coords: [u0, v0],
                    color: active_color,
                },
                Vertex {
                    position: [x1, y0, z],
                    normal: [0.0, 0.0, 0.0],
                    tex_coords: [u1, v0],
                    color: active_color,
                },
                Vertex {
                    position: [x1, y1, z],
                    normal: [0.0, 0.0, 0.0],
                    tex_coords: [u1, v1],
                    color: active_color,
                },
                Vertex {
                    position: [x0, y1, z],
                    normal: [0.0, 0.0, 0.0],
                    tex_coords: [u0, v1],
                    color: active_color,
                },
            ]);

            indices.extend_from_slice(&[
                base_vertex,
                base_vertex + 1,
                base_vertex + 2,
                base_vertex,
                base_vertex + 2,
                base_vertex + 3,
            ]);
        }

        // Update buffers and draw
        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&vertices));
        queue.write_buffer(&self.index_buffer, 0, bytemuck::cast_slice(&indices));

        self.vertices = vertices;
        self.indices = indices;
    }

    // pub fn update_color(&mut self, color: [u8; 3]) {
    //     let active_color = rgb_to_wgpu(
    //         self.color[0] as u8,
    //         self.color[1] as u8,
    //         self.color[2] as u8,
    //         1.0,
    //     );
    // }

    pub fn update_opacity(&mut self, queue: &wgpu::Queue, opacity: f32) {
        self.background_polygon.update_opacity(queue, opacity);

        let new_color = rgb_to_wgpu(
            self.color[0] as u8,
            self.color[1] as u8,
            self.color[2] as u8,
            opacity * 255.0,
        );

        self.vertices.iter_mut().for_each(|v| {
            v.color = new_color;
        });

        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&self.vertices));
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
        self.background_polygon.update_data_from_dimensions(
            window_size,
            device,
            queue,
            bind_group_layout,
            dimensions,
            camera,
        );

        self.dimensions = dimensions;

        // rerender text to assure wrapping
        self.render_text(device, queue);
    }

    pub fn contains_point(&self, point: &Point, camera: &Camera) -> bool {
        // let local_point = self.to_local_space(*point, camera);
        let untranslated = Point {
            x: point.x - (self.transform.position.x),
            y: point.y - self.transform.position.y,
        };

        // Get the bounds of the rectangle based on dimensions
        // Since dimensions are (width, height), the rectangle extends from (0,0) to (width, height)
        let (width, height) = self.dimensions;

        // Check if the point is within -0.5 to 0.5 range
        untranslated.x >= -0.5 * self.dimensions.0 as f32
            && untranslated.x <= 0.5 * self.dimensions.0 as f32
            && untranslated.y >= -0.5 * self.dimensions.1 as f32
            && untranslated.y <= 0.5 * self.dimensions.1 as f32
    }

    pub fn contains_point_with_tolerance(&self, point: &Point, camera: &Camera, tolerance_percent: f32) -> bool {
        let untranslated = Point {
            x: point.x - (self.transform.position.x),
            y: point.y - self.transform.position.y,
        };

        // Apply tolerance expansion to the detection area
        let tolerance_multiplier = 1.0 + (tolerance_percent / 100.0);
        let enhanced_width = self.dimensions.0 * tolerance_multiplier;
        let enhanced_height = self.dimensions.1 * tolerance_multiplier;

        // Check if the point is within the enhanced bounds
        untranslated.x >= -0.5 * enhanced_width as f32
            && untranslated.x <= 0.5 * enhanced_width as f32
            && untranslated.y >= -0.5 * enhanced_height as f32
            && untranslated.y <= 0.5 * enhanced_height as f32
    }

    pub fn to_local_space(&self, world_point: Point, camera: &Camera) -> Point {
        let untranslated = Point {
            x: world_point.x - (self.transform.position.x),
            y: world_point.y - self.transform.position.y,
        };

        let local_point = Point {
            x: untranslated.x / (self.dimensions.0),
            y: untranslated.y / (self.dimensions.1),
        };

        // println!("local_point {:?} {:?}", self.name, local_point);

        local_point
    }

    pub fn to_config(&self) -> TextRendererConfig {
        TextRendererConfig {
            id: self.id.clone(),
            name: self.name.clone(),
            text: self.text.clone(),
            font_family: self.font_family.clone(),
            dimensions: self.dimensions,
            position: Point {
                x: self.transform.position.x - CANVAS_HORIZ_OFFSET,
                y: self.transform.position.y - CANVAS_VERT_OFFSET,
            },
            layer: self.layer,
            color: self.color,
            font_size: self.font_size,
            background_fill: [
                wgpu_to_human(self.background_polygon.fill[0]) as i32,
                wgpu_to_human(self.background_polygon.fill[1]) as i32,
                wgpu_to_human(self.background_polygon.fill[2]) as i32,
                wgpu_to_human(self.background_polygon.fill[3]) as i32,
            ],
        }
    }

    pub fn from_config(
        config: &TextRendererConfig,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        model_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        camera: &Camera,
        selected_sequence_id: String,
        font_data: &[u8],
    ) -> TextRenderer {
        TextRenderer::new(
            &device,
            &queue,
            model_bind_group_layout,
            group_bind_group_layout,
            // self.font_manager
            //     .get_font_by_name(&config.font_family)
            //     .expect("Couldn't get font family"),
            font_data,
            &window_size,
            config.text.clone(),
            config.clone(),
            config.id,
            Uuid::from_str(&selected_sequence_id).expect("Couldn't convert string to uuid"),
            camera,
        )
    }
}
