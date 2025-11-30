// use std::sync::Arc;

// use nalgebra::{Matrix4, Vector3};
// use transform_gizmo::{
//     config::TransformPivotPoint,
//     math::{Pos2, Transform as GizmoTransform},
//     mint::RowMatrix4,
//     EnumSet, Gizmo, GizmoConfig, GizmoInteraction, GizmoMode, GizmoOrientation, GizmoVisuals, Rect,
// };
// use wgpu::util::DeviceExt;

// use crate::{
//     handlers::Vertex,
//     helpers::{saved_data::ComponentData, utilities::nalgebra_to_gizmo_matrix},
// };

// use super::{
//     RendererState::{MouseState, WindowSize},
//     SimpleCamera::SimpleCamera,
//     Transform::{matrix4_to_raw_array, Transform},
// };

// pub struct TestTransformGizmo {
//     pub gizmo: Gizmo,
//     pub bind_group: wgpu::BindGroup,
//     pub texture_bind_group: wgpu::BindGroup,
// }

// impl TestTransformGizmo {
//     pub fn new(
//         device: &wgpu::Device,
//         camera: &SimpleCamera,
//         window_size: WindowSize,
//         bind_group_layout: Arc<wgpu::BindGroupLayout>,
//         color_render_mode_buffer: Arc<wgpu::Buffer>,
//         texture_bind_group_layout: Arc<wgpu::BindGroupLayout>,
//     ) -> Self {
//         // let viewport = transform_gizmo::Rect {
//         //     min: [0.0, 0.0].into(),
//         //     max: [window_size.width as f32, window_size.height as f32].into(),
//         // };
//         let viewport = Rect {
//             min: Pos2::new(0.0, 0.0),
//             max: Pos2::new(window_size.width as f32, window_size.height as f32),
//         };

//         let view_matrix = camera.get_view();
//         let proj_matrix = camera.get_projection();

//         let view_matrix = nalgebra_to_gizmo_matrix(view_matrix);
//         let proj_matrix = nalgebra_to_gizmo_matrix(proj_matrix);

//         println!("matrix {:?} {:?}", view_matrix, proj_matrix);

//         let mut gizmo = Gizmo::default();

//         let config = GizmoConfig {
//             view_matrix: view_matrix,       // Will be updated with camera
//             projection_matrix: proj_matrix, // Will be updated with camera
//             viewport,
//             modes: GizmoMode::all(), // Enable all gizmo modes
//             mode_override: Some(GizmoMode::RotateX),
//             orientation: GizmoOrientation::Local,
//             pivot_point: TransformPivotPoint::MedianPoint,
//             snapping: false,
//             snap_angle: 15.0,
//             snap_distance: 1.0,
//             snap_scale: 0.1,
//             visuals: GizmoVisuals::default(),
//             pixels_per_point: 1.0,
//         };

//         gizmo.update_config(config);

//         // let gizmo = Gizmo::new(config);

//         // Create a default empty texture and sampler
//         let default_texture = device.create_texture(&wgpu::TextureDescriptor {
//             label: Some("Default Empty Texture"),
//             size: wgpu::Extent3d {
//                 width: 1,
//                 height: 1,
//                 depth_or_array_layers: 1,
//             },
//             mip_level_count: 1,
//             sample_count: 1,
//             dimension: wgpu::TextureDimension::D2,
//             format: wgpu::TextureFormat::Rgba8UnormSrgb,
//             usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
//             view_formats: &[],
//         });

//         let default_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
//             address_mode_u: wgpu::AddressMode::ClampToEdge,
//             address_mode_v: wgpu::AddressMode::ClampToEdge,
//             address_mode_w: wgpu::AddressMode::ClampToEdge,
//             mag_filter: wgpu::FilterMode::Linear,
//             min_filter: wgpu::FilterMode::Linear,
//             mipmap_filter: wgpu::FilterMode::Nearest,
//             ..Default::default()
//         });

//         let default_texture_view = default_texture.create_view(&wgpu::TextureViewDescriptor {
//             dimension: Some(wgpu::TextureViewDimension::D2Array),
//             ..Default::default()
//         });

//         let empty_buffer = Matrix4::<f32>::identity();
//         let raw_matrix = matrix4_to_raw_array(&empty_buffer);

//         let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("TranslationGizmo Uniform Buffer"),
//             contents: bytemuck::cast_slice(&raw_matrix),
//             usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
//         });

//         let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
//             layout: &bind_group_layout,
//             entries: &[wgpu::BindGroupEntry {
//                 binding: 0,
//                 resource: uniform_buffer.as_entire_binding(),
//             }],
//             label: None,
//         });

//         // Handle the texture bind group conditionally
//         let texture_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
//             layout: &texture_bind_group_layout,
//             entries: &[
//                 wgpu::BindGroupEntry {
//                     binding: 0,
//                     resource: wgpu::BindingResource::TextureView(&default_texture_view),
//                 },
//                 wgpu::BindGroupEntry {
//                     binding: 1,
//                     resource: wgpu::BindingResource::Sampler(&default_sampler),
//                 },
//                 wgpu::BindGroupEntry {
//                     binding: 2,
//                     resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
//                         buffer: &color_render_mode_buffer,
//                         offset: 0,
//                         size: None,
//                     }),
//                 },
//             ],
//             label: None,
//         });

//         TestTransformGizmo {
//             gizmo,
//             bind_group,
//             texture_bind_group,
//         }
//     }

//     // use this function for render loop
//     pub fn draw_gizmo(
//         &mut self,
//         device: &wgpu::Device,
//         window_size: WindowSize,
//     ) -> (Vec<Vertex>, Vec<u32>, wgpu::Buffer, wgpu::Buffer) {
//         let draw_data = self.gizmo.draw();

//         // println!("vertices pre: {:?}", draw_data.vertices);

//         let mut vertices = Vec::new();

//         // Convert each vertex and color into your Vertex format
//         for i in 0..draw_data.vertices.len() {
//             // // Convert screen coordinates to NDC (-1 to 1 range)
//             // let x_ndc = (2.0 * draw_data.vertices[i][0] / window_size.width as f32) - 1.0;
//             // let y_ndc = 1.0 - (2.0 * draw_data.vertices[i][1] / window_size.height as f32); // Flip Y
//             // Convert to clip space if needed
//             let x_clip = (2.0 * draw_data.vertices[i][0] / window_size.width as f32) - 1.0;
//             let y_clip = -((2.0 * draw_data.vertices[i][1] / window_size.height as f32) - 1.0); // Note the - for Y flip

//             vertices.push(Vertex {
//                 position: [x_clip, y_clip, 0.5],
//                 normal: [0.0, 0.0, 1.0], // Default normal?
//                 tex_coords: [0.0, 0.0],  // Default UV coordinates
//                 color: [
//                     draw_data.colors[i][0],
//                     draw_data.colors[i][1],
//                     draw_data.colors[i][2],
//                 ],
//             });
//         }

//         // println!("vertices post: {:?}", vertices);

//         let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//             label: Some("TranslationGizmo Vertex Buffer"),
//             contents: bytemuck::cast_slice(&vertices),
//             usage: wgpu::BufferUsages::VERTEX,
//         });

//         let index_buffer: wgpu::Buffer =
//             device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
//                 label: Some("TranslationGizmo Index Buffer"),
//                 contents: bytemuck::cast_slice(&draw_data.indices),
//                 usage: wgpu::BufferUsages::INDEX,
//             });

//         // Return both vertices and indices
//         (vertices, draw_data.indices, vertex_buffer, index_buffer)
//     }

//     // call this when dragging
//     pub fn update_transform(
//         &mut self,
//         camera: &SimpleCamera,
//         selected_object: &ComponentData,
//         mouse_state: MouseState,
//     ) -> Option<[[f32; 3]; 3]> {
//         let view_matrix = camera.get_view();
//         let proj_matrix = camera.get_projection();

//         // Update gizmo config with new camera matrices
//         let mut config = self.gizmo.config().clone();
//         config.view_matrix = nalgebra_to_gizmo_matrix(view_matrix);
//         config.projection_matrix = nalgebra_to_gizmo_matrix(proj_matrix);
//         self.gizmo.update_config(config);

//         // Convert our transforms to gizmo transforms
//         let mut gizmo_transforms = Vec::new();
//         gizmo_transforms.push(self.saved_to_gizmo_transform(
//             selected_object.generic_properties.position,
//             selected_object.generic_properties.rotation,
//             selected_object.generic_properties.scale,
//         ));

//         // Create interaction state from mouse state
//         let interaction = GizmoInteraction {
//             cursor_pos: (
//                 mouse_state.last_mouse_x as f32,
//                 mouse_state.last_mouse_y as f32,
//             ),
//             drag_started: mouse_state.drag_started,
//             dragging: mouse_state.is_dragging,
//         };

//         // println!("Updating gizmo... {:?} {:?}", gizmo_transforms, interaction);

//         // Update gizmo and get new transforms if there are any changes
//         // let (_result, new_transforms) = self
//         //     .gizmo
//         //     .update(interaction, &gizmo_transforms)
//         //     .expect("Couldn't update gizmo");

//         if let Some((_result, new_transforms)) = self.gizmo.update(interaction, &gizmo_transforms) {
//             // Update our objects with new transforms
//             let new_transform = new_transforms.get(0).expect("Couldn't get transform");
//             let savable_transform = self.gizmo_to_saved_transform(new_transform);

//             // update rendererstate object outside of this function, also update saved_state (save it on mouse release)

//             Some(savable_transform)
//         } else {
//             println!("no active gizmo!");
//             None
//         }
//     }

//     fn saved_to_gizmo_transform(
//         &self,
//         position: [f32; 3],
//         rotation: [f32; 3],
//         scale: [f32; 3],
//     ) -> GizmoTransform {
//         GizmoTransform {
//             translation: [position[0] as f64, position[1] as f64, position[2] as f64].into(),
//             rotation: transform_gizmo::mint::Quaternion {
//                 v: [rotation[0] as f64, rotation[1] as f64, rotation[2] as f64].into(),
//                 s: 1.0,
//             },
//             scale: [scale[0] as f64, scale[1] as f64, scale[2] as f64].into(),
//         }
//     }

//     fn gizmo_to_saved_transform(&self, gizmo_transform: &GizmoTransform) -> [[f32; 3]; 3] {
//         // Apply GizmoTransform back to our Transform
//         let position = [
//             gizmo_transform.translation.x as f32,
//             gizmo_transform.translation.y as f32,
//             gizmo_transform.translation.z as f32,
//         ];

//         let rotation = [
//             gizmo_transform.rotation.v.x as f32,
//             gizmo_transform.rotation.v.y as f32,
//             gizmo_transform.rotation.v.z as f32,
//         ];

//         let scale = [
//             gizmo_transform.scale.x as f32,
//             gizmo_transform.scale.y as f32,
//             gizmo_transform.scale.z as f32,
//         ];

//         [position, rotation, scale]
//     }

//     fn convert_to_gizmo_transform(&self, transform: &Transform) -> GizmoTransform {
//         GizmoTransform {
//             translation: [
//                 transform.position.x as f64,
//                 transform.position.y as f64,
//                 transform.position.z as f64,
//             ]
//             .into(),
//             rotation: transform_gizmo::mint::Quaternion {
//                 v: [
//                     transform.rotation.x as f64,
//                     transform.rotation.y as f64,
//                     transform.rotation.z as f64,
//                 ]
//                 .into(),
//                 s: 1.0,
//             },
//             scale: [
//                 transform.scale.x as f64,
//                 transform.scale.y as f64,
//                 transform.scale.z as f64,
//             ]
//             .into(),
//         }
//     }

//     fn apply_gizmo_transform(&self, gizmo_transform: &GizmoTransform, transform: &mut Transform) {
//         // Apply GizmoTransform back to our Transform
//         transform.position = Vector3::new(
//             gizmo_transform.translation.x as f32,
//             gizmo_transform.translation.y as f32,
//             gizmo_transform.translation.z as f32,
//         );

//         transform.rotation = Vector3::new(
//             gizmo_transform.rotation.v.x as f32,
//             gizmo_transform.rotation.v.y as f32,
//             gizmo_transform.rotation.v.z as f32,
//         );

//         transform.scale = Vector3::new(
//             gizmo_transform.scale.x as f32,
//             gizmo_transform.scale.y as f32,
//             gizmo_transform.scale.z as f32,
//         );
//     }
// }
