// use std::collections::HashMap;

// use cgmath::Vector2;
// use cosmic_text::{Buffer, Canvas, Color, FontSystem, Metrics, Shaping};
// use uuid::Uuid;
// use wgpu::util::DeviceExt;

// use crate::{editor::WindowSize, transform::Transform, vertex::Vertex};

// pub struct TextInstance {
//     buffer: Buffer,
//     transform: Transform,
//     content: String,
//     needs_update: bool,
// }

// impl TextInstance {
//     pub fn new(
//         font_system: &mut FontSystem,
//         content: String,
//         position: Vector2<f32>,
//         rotation: f32,
//         scale: Vector2<f32>,
//         uniform_buffer: wgpu::Buffer,
//         window_size: WindowSize,
//     ) -> Self {
//         let metrics = Metrics::new(14.0, 20.0);
//         let mut buffer = Buffer::new(font_system, metrics);
//         buffer.set_text(font_system, &content, Shaping::Advanced);
//         buffer.shape_until_scroll(font_system);

//         Self {
//             buffer,
//             transform: Transform::new(position, rotation, scale, uniform_buffer, &window_size),
//             content,
//             needs_update: false,
//         }
//     }

//     pub fn update_content(&mut self, font_system: &mut FontSystem, new_content: String) {
//         self.content = new_content;
//         self.buffer
//             .set_text(font_system, &self.content, Shaping::Advanced);
//         self.buffer.shape_until_scroll(font_system);
//         self.needs_update = true;
//     }

//     // pub fn update_transform(&mut self, position: Vector2<f32>, rotation: f32, scale: Vector2<f32>) {
//     //     self.transform.update_position(position);
//     //     self.transform.update_rotation(rotation);
//     //     self.transform.update_scale(scale);
//     //     self.needs_update = true;
//     // }
// }

// #[derive(Debug)]
// pub struct TextSystem {
//     font_system: FontSystem,
//     canvas: Canvas,
//     texture: wgpu::Texture,
//     // bind_group: wgpu::BindGroup,
//     // pipeline: wgpu::RenderPipeline,
//     vertex_buffer: wgpu::Buffer,
//     index_buffer: wgpu::Buffer,
//     instances: HashMap<Uuid, TextInstance>,
// }

// impl TextSystem {
//     pub fn new(
//         device: &wgpu::Device,
//         config: &wgpu::SurfaceConfiguration,
//         bind_group_layout: &wgpu::BindGroupLayout,
//     ) -> Self {
//         // Initialize FontSystem
//         let mut font_system = FontSystem::new();

//         // Create buffer with default metrics
//         let metrics = Metrics::new(14.0, 20.0);
//         let mut buffer = Buffer::new(&mut font_system, metrics);

//         // Create canvas for rendering
//         let canvas = Canvas::new(device.features());

//         // Create texture for the text
//         let texture_size = wgpu::Extent3d {
//             width: 1024,
//             height: 1024,
//             depth_or_array_layers: 1,
//         };

//         let texture = device.create_texture(&wgpu::TextureDescriptor {
//             label: Some("Text Texture"),
//             size: texture_size,
//             mip_level_count: 1,
//             sample_count: 1,
//             dimension: wgpu::TextureDimension::D2,
//             format: wgpu::TextureFormat::Rgba8UnormSrgb,
//             usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
//             view_formats: &[],
//         });

//         // Create the bind group for the texture
//         let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
//         let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
//             address_mode_u: wgpu::AddressMode::ClampToEdge,
//             address_mode_v: wgpu::AddressMode::ClampToEdge,
//             address_mode_w: wgpu::AddressMode::ClampToEdge,
//             mag_filter: wgpu::FilterMode::Linear,
//             min_filter: wgpu::FilterMode::Linear,
//             mipmap_filter: wgpu::FilterMode::Linear,
//             ..Default::default()
//         });

//         // let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
//         //     label: Some("Text Bind Group"),
//         //     layout: bind_group_layout,
//         //     entries: &[
//         //         wgpu::BindGroupEntry {
//         //             binding: 0,
//         //             resource: wgpu::BindingResource::TextureView(&texture_view),
//         //         },
//         //         wgpu::BindGroupEntry {
//         //             binding: 1,
//         //             resource: wgpu::BindingResource::Sampler(&sampler),
//         //         },
//         //     ],
//         // });

//         // Create vertex and index buffers
//         let vertices = [
//             Vertex {
//                 position: [-0.5, 0.5, 0.0],
//                 tex_coords: [0.0, 0.0],
//                 color: [1.0, 1.0, 1.0, 1.0],
//             },
//             Vertex {
//                 position: [0.5, 0.5, 0.0],
//                 tex_coords: [1.0, 0.0],
//                 color: [1.0, 1.0, 1.0, 1.0],
//             },
//             Vertex {
//                 position: [0.5, -0.5, 0.0],
//                 tex_coords: [1.0, 1.0],
//                 color: [1.0, 1.0, 1.0, 1.0],
//             },
//             Vertex {
//                 position: [-0.5, -0.5, 0.0],
//                 tex_coords: [0.0, 1.0],
//                 color: [1.0, 1.0, 1.0, 1.0],
//             },
//         ];
//         let indices: &[u16] = &[0, 1, 2, 0, 2, 3];

//         let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("Text Vertex Buffer"),
//             contents: bytemuck::cast_slice(&vertices),
//             usage: wgpu::BufferUsages::VERTEX,
//         });

//         let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("Text Index Buffer"),
//             contents: bytemuck::cast_slice(indices),
//             usage: wgpu::BufferUsages::INDEX,
//         });

//         Self {
//             font_system,
//             canvas,
//             texture,
//             // bind_group,
//             // pipeline,
//             vertex_buffer,
//             index_buffer,
//             instances: HashMap::new(),
//         }
//     }

//     pub fn create_text_instance(
//         &mut self,
//         content: String,
//         position: Vector2<f32>,
//         rotation: f32,
//         scale: Vector2<f32>,
//         uniform_buffer: wgpu::Buffer,
//         window_size: WindowSize,
//     ) -> Uuid {
//         let id = Uuid::new_v4();
//         let instance = TextInstance::new(
//             &mut self.font_system,
//             content,
//             position,
//             rotation,
//             scale,
//             uniform_buffer,
//             window_size,
//         );
//         self.instances.insert(id, instance);
//         id
//     }

//     // pub fn update_instance(
//     //     &mut self,
//     //     id: Uuid,
//     //     content: Option<String>,
//     //     position: Option<Vector2<f32>>,
//     //     rotation: Option<f32>,
//     //     scale: Option<Vector2<f32>>,
//     // ) -> Result<(), String> {
//     //     if let Some(instance) = self.instances.get_mut(&id) {
//     //         if let Some(content) = content {
//     //             instance.update_content(&mut self.font_system, content);
//     //         }

//     //         if position.is_some() || rotation.is_some() || scale.is_some() {
//     //             let current_transform = &instance.transform;
//     //             instance.update_transform(
//     //                 position.unwrap_or_else(|| current_transform.position()),
//     //                 rotation.unwrap_or_else(|| current_transform.rotation()),
//     //                 scale.unwrap_or_else(|| current_transform.scale()),
//     //             );
//     //         }
//     //         Ok(())
//     //     } else {
//     //         Err("Text instance not found".to_string())
//     //     }
//     // }

//     pub fn remove_instance(&mut self, id: Uuid) -> Result<(), String> {
//         if self.instances.remove(&id).is_some() {
//             Ok(())
//         } else {
//             Err("Text instance not found".to_string())
//         }
//     }

//     pub fn update_font_texture(
//         &mut self,
//         device: &wgpu::Device,
//         queue: &wgpu::Queue,
//         view: &wgpu::TextureView,
//     ) {
//         // Clear canvas
//         self.canvas.clear(Color::TRANSPARENT);

//         // Draw all instances that need updating to the canvas
//         for instance in self.instances.values_mut().filter(|i| i.needs_update) {
//             instance
//                 .buffer
//                 .draw(&mut self.font_system, &mut self.canvas);
//             instance.needs_update = false;
//         }

//         // Update texture with canvas content
//         queue.write_texture(
//             wgpu::ImageCopyTexture {
//                 texture: &self.texture,
//                 mip_level: 0,
//                 origin: wgpu::Origin3d::ZERO,
//                 aspect: wgpu::TextureAspect::All,
//             },
//             self.canvas.data(),
//             wgpu::ImageDataLayout {
//                 offset: 0,
//                 bytes_per_row: Some(4 * self.canvas.width()),
//                 rows_per_image: Some(self.canvas.height()),
//             },
//             wgpu::Extent3d {
//                 width: self.canvas.width(),
//                 height: self.canvas.height(),
//                 depth_or_array_layers: 1,
//             },
//         );

//         // let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
//         //     label: Some("Text Render Encoder"),
//         // });

//         {
//             // let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
//             //     label: Some("Text Render Pass"),
//             //     color_attachments: &[Some(wgpu::RenderPassColorAttachment {
//             //         view,
//             //         resolve_target: None,
//             //         ops: wgpu::Operations {
//             //             load: wgpu::LoadOp::Load,
//             //             store: wgpu::StoreOp::Store,
//             //         },
//             //     })],
//             //     depth_stencil_attachment: None,
//             //     timestamp_writes: None,
//             //     occlusion_query_set: None,
//             // });

//             // render_pass.set_pipeline(&self.pipeline);
//             // render_pass.set_bind_group(0, &self.bind_group, &[]);
//             // render_pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
//             // render_pass.set_index_buffer(self.index_buffer.slice(..), wgpu::IndexFormat::Uint16);

//             // Render each text instance
//             // for instance in self.instances.values() {
//             //     instance.transform.bind(&mut render_pass);
//             //     render_pass.draw_indexed(0..6, 0, 0..1);
//             // }
//         }

//         // queue.submit(std::iter::once(encoder.finish()));
//     }
// }
