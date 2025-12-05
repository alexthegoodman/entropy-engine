use crate::{
   core::{Grid::{Grid, GridConfig}, RendererState::RendererState, SimpleCamera::SimpleCamera as Camera, camera::CameraBinding, editor::{
        Editor, Viewport, WindowSize, WindowSizeShader,
    }, gpu_resources::GpuResources, vertex::Vertex}, handlers::{handle_add_landscape, handle_add_landscape_texture}, helpers::{saved_data::{ComponentKind, LandscapeTextureKinds, LevelData, SavedState}, timelines::SavedTimelineStateConfig, utilities}, startup::Gui, vector_animations::animations::Sequence
};
use std::{fs, sync::{Arc, Mutex}, time::Instant};
use egui;
// use cgmath::{Point3, Vector3};
use nalgebra::{Point3, Vector3};
use uuid::Uuid;
use wgpu::{util::DeviceExt, RenderPipeline};
use winit::window::Window;
use crate::shape_primitives::Cube::Cube;

use super::frame_buffer::FrameCaptureBuffer;
// use super::chat::Chat;

pub struct ExportPipeline {
    // pub device: Option<wgpu::Device>,
    // pub queue: Option<wgpu::Queue>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub camera: Option<Camera>,
    pub camera_binding: Option<CameraBinding>,
    pub render_pipeline: Option<RenderPipeline>,
    pub texture: Option<Arc<wgpu::Texture>>,
    pub view: Option<Arc<wgpu::TextureView>>,
    pub depth_view: Option<wgpu::TextureView>,
    pub window_size_bind_group: Option<wgpu::BindGroup>,
    pub export_editor: Option<Editor>,
    pub frame_buffer: Option<FrameCaptureBuffer>,
    // pub chat: Chat,
    new_project_name: String,
    projects: Vec<String>,
}

impl ExportPipeline {
    pub fn new() -> Self {
        ExportPipeline {
            // device: None,
            // queue: None,
            gpu_resources: None,
            camera: None,
            camera_binding: None,
            render_pipeline: None,
            texture: None,
            view: None,
            depth_view: None,
            window_size_bind_group: None,
            export_editor: None,
            frame_buffer: None,
            // chat: Chat::new(),
            new_project_name: String::new(),
            projects: Vec::new(),
        }
    }

    pub async fn initialize(
        &mut self,
        window: Option<&Window>,
        window_size: WindowSize,
        sequences: Vec<Sequence>,
        video_current_sequence_timeline: SavedTimelineStateConfig,
        video_width: u32,
        video_height: u32,
        project_id: String,
    ) {
        let mut camera = Camera::new(
            Point3::new(0.0, 0.5, -5.0),
            Vector3::new(0.0, 0.0, -1.0),
            Vector3::new(0.0, 1.0, 0.0),
            45.0f32.to_radians(),
            0.1,
            100000.0,
            window_size.width as f32,
            window_size.height as f32
        );

        // Center camera on viewport center with appropriate zoom
        let center_x = video_width as f32 / 2.0;
        let center_y = video_height as f32 / 2.0;
        let zoom_level = 0.05; // Adjust as needed
        
        // camera.birds_eye_zoom_on_point(-0.48, -0.40, 1.25); 
        // camera.position = Vector3::new(-0.5, -0.5, 1.4);

        let viewport = Arc::new(Mutex::new(Viewport::new(
            // swap for video dimensions?
            // window_size.width as f32,
            // window_size.height as f32,
            video_width as f32,
            video_height as f32,
        )));

        // create a dedicated editor so it can be used in the async thread
        let mut export_editor = Editor::new(viewport, project_id.clone());

        // continue on with wgpu items
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            ..Default::default()
        });

        let mut surface: Option<Arc<wgpu::Surface<'static>>> = None;

        let adapter = if let Some(window) = window {
            // SAFETY: The surface must not outlive the window.
            let s = unsafe { instance.create_surface(window).unwrap() };
            // We can transmute the lifetime to static because the window lives for the duration
            // of the application, which is effectively a static lifetime.
            let s: wgpu::Surface<'static> = unsafe { std::mem::transmute(s) };
            let s = Arc::new(s);
            surface = Some(s.clone());
            instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::default(),
                    compatible_surface: Some(&s),
                    force_fallback_adapter: false,
                })
                .await
                .expect("Couldn't get gpu adapter")
        } else {
            instance
                .request_adapter(&wgpu::RequestAdapterOptions {
                    power_preference: wgpu::PowerPreference::default(),
                    compatible_surface: None, // no surface desired for export
                    force_fallback_adapter: false,
                })
                .await
                .expect("Couldn't get gpu adapter")
        };

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: None,
                    ..Default::default()
                },
                // None,
            )
            .await
            .expect("Couldn't get gpu device");

        let mut camera_binding = CameraBinding::new(&device);

        let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                // width: window_size.width.clone(),
                // height: window_size.height.clone(),
                width: video_width.clone(),
                height: video_height.clone(),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1, // used in a multisampled environment
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Depth24Plus,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            label: Some("Stunts Engine Export Depth Texture"),
            view_formats: &[],
        });

        let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let depth_stencil_state = wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth24Plus,
            depth_write_enabled: true,
            depth_compare: wgpu::CompareFunction::Less,
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };

        let model_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Existing uniform buffer binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                    // Texture binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            // view_dimension: wgpu::TextureViewDimension::D2,
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // Sampler binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    // Render mode
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
                label: Some("Stunts Engine Export Model Layout"),
            });

        let model_bind_group_layout = Arc::new(model_bind_group_layout);

        let group_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Existing uniform buffer binding
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
                label: Some("export group_bind_group_layout"),
            });

        let group_bind_group_layout = Arc::new(group_bind_group_layout);

        let window_size_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(&[WindowSizeShader {
                // swap for vidoe dimensions?
                // width: window_size.width as f32,
                // height: window_size.height as f32,
                width: video_width.clone() as f32,
                height: video_height.clone() as f32,
            }]),
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let window_size_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: None,
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let window_size_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &window_size_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: window_size_buffer.as_entire_binding(),
            }],
            label: None,
        });

        let color_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Color Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[0i32]), // Default to normal mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let color_render_mode_buffer = Arc::new(color_render_mode_buffer);

        let texture_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Texture Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[1i32]), // Default to text mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let texture_render_mode_buffer = Arc::new(texture_render_mode_buffer);

        // Define the layouts
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Stunts Engine Export Pipeline Layout"),
            bind_group_layouts: &[
                &camera_binding.bind_group_layout,
                &model_bind_group_layout,
                &window_size_bind_group_layout,
                &group_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        // Load the shaders
        let shader_module_vert_primary =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Stunts Engine Export Vert Shader"),
                // source: wgpu::ShaderSource::Wgsl(include_str!("shaders/vert_primary.wgsl").into()), // stunts
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/primary_vertex.wgsl").into()), // midpoint
            });

        let shader_module_frag_primary =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Stunts Engine Export Frag Shader"),
                // source: wgpu::ShaderSource::Wgsl(include_str!("shaders/frag_primary.wgsl").into()), // stunts
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/primary_fragment.wgsl").into()), // midpoint
            });

        // let swapchain_capabilities = gpu_resources
        //     .surface
        //     .get_capabilities(&gpu_resources.adapter);
        // let swapchain_format = swapchain_capabilities.formats[0]; // Choosing the first available format
        // let swapchain_format = wgpu::TextureFormat::Rgba8UnormSrgb; // hardcode for now - may be able to change from the floem requirement
        let swapchain_format = wgpu::TextureFormat::Rgba8Unorm;
        // let swapchain_format = wgpu::TextureFormat::Rgba8Unorm;

        // Configure the render pipeline
        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Entropy Engine Render Pipeline"),
            layout: Some(&pipeline_layout),
            multiview: None,
            cache: None,
            vertex: wgpu::VertexState {
                module: &shader_module_vert_primary,
                entry_point: Some("vs_main"), // name of the entry point in your vertex shader
                buffers: &[Vertex::desc()], // Make sure your Vertex::desc() matches your vertex structure
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_frag_primary,
                entry_point: Some("fs_main"), // name of the entry point in your fragment shader
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    // blend: Some(wgpu::BlendState::REPLACE),
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            // primitive: wgpu::PrimitiveState::default(),
            // depth_stencil: None,
            // multisample: wgpu::MultisampleState::default(),
            primitive: wgpu::PrimitiveState {
                conservative: false,
                topology: wgpu::PrimitiveTopology::TriangleList, // how vertices are assembled into geometric primitives
                // strip_index_format: Some(wgpu::IndexFormat::Uint32),
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw, // Counter-clockwise is considered the front face
                // none cull_mode
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                // Other properties such as conservative rasterization can be set here
                unclipped_depth: false,
            },
            depth_stencil: Some(depth_stencil_state), // Optional, only if you are using depth testing
            multisample: wgpu::MultisampleState {
                // count: 4, // effect performance
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
        });

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            size: wgpu::Extent3d {
                // width: window_size.width,
                // height: window_size.height,
                width: video_width.clone(),
                height: video_height.clone(),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            // sample_count: 4,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: swapchain_format,
            usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::RENDER_ATTACHMENT,
            label: Some("Export render texture"),
            view_formats: &[],
        });

        let texture = Arc::new(texture);

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let view = Arc::new(view);

        camera_binding.update_3d(&queue, &camera);

        println!("Grid Restored!");

        let mut renderer_state = RendererState::new(
            &device, 
            &queue, 
            model_bind_group_layout.clone(), 
            group_bind_group_layout.clone(), 
            &camera,
            texture_render_mode_buffer.clone(),
            color_render_mode_buffer,
        );

        let mut grids = Vec::new();
        grids.push(Grid::new(
            &device,
            &queue,
            &model_bind_group_layout,
            &group_bind_group_layout.clone(),
            &texture_render_mode_buffer.clone(),
            &camera,
            GridConfig {
                width: 200.0,
                depth: 200.0,
                spacing: 4.0,
                line_thickness: 0.1,
            },
        ));
        grids.push(Grid::new(
            &device,
            &queue,
            &model_bind_group_layout,
            &group_bind_group_layout,
            &texture_render_mode_buffer,
             &camera,
            GridConfig {
                width: 200.0,
                depth: 200.0,
                spacing: 1.0,
                line_thickness: 0.025,
            },
        ));

        renderer_state.grids = grids;

        export_editor.renderer_state = Some(renderer_state);

        let gpu_resources = if let Some(surface) = surface {
            GpuResources::with_surface(adapter, device, queue, surface)
        } else {
            GpuResources::new(adapter, device, queue)
        };

        let gpu_resources = Arc::new(gpu_resources);

        // set needed editor properties
        export_editor.model_bind_group_layout = Some(model_bind_group_layout.clone());
        export_editor.group_bind_group_layout = Some(group_bind_group_layout.clone());
        export_editor.gpu_resources = Some(gpu_resources.clone());

        // let gpu_resources = export_editor
        //     .gpu_resources
        //     .as_ref()
        //     .expect("Couldn't get gpu resources");

        println!("Pipeline initialized!");
        
        // begin playback
        export_editor.camera = Some(camera);

        // restore objects to the editor
        // sequences.iter().enumerate().for_each(|(i, s)| {
        //     export_editor.restore_sequence_objects(
        //         &s,
        //         // WindowSize {
        //         //     // width: window_size.width as u32,
        //         //     // height: window_size.height as u32,
        //         //     width: video_width.clone(),
        //         //     height: video_height.clone(),
        //         // },
        //         // &camera,
        //         if i == 0 { false } else { true },
        //         // &gpu_resources.device,
        //         // &gpu_resources.queue,
        //     );
        // });
        
        let now = std::time::Instant::now();
        export_editor.video_start_playing_time = Some(now.clone());

        export_editor.video_current_sequence_timeline = Some(video_current_sequence_timeline);
        export_editor.video_current_sequences_data = Some(sequences);

        export_editor.video_is_playing = true;

        // also set motion path playing
        export_editor.start_playing_time = Some(now);
        export_editor.is_playing = true;

        export_editor.camera_binding = Some(camera_binding);

        // self.device = Some(device);
        // self.queue = Some(queue);
        self.gpu_resources = export_editor.gpu_resources.clone();
        // self.camera = Some(camera);
        // self.camera_binding = Some(camera_binding);
        self.render_pipeline = Some(render_pipeline);
        self.texture = Some(texture);
        self.view = Some(view);
        self.depth_view = Some(depth_view);
        self.window_size_bind_group = Some(window_size_bind_group);
        self.export_editor = Some(export_editor);
    }

    pub fn resize(&mut self, new_size: winit::dpi::PhysicalSize<u32>) {
        if new_size.width > 0 && new_size.height > 0 {
            let gpu_resources = self.gpu_resources.as_ref().unwrap();
            let device = &gpu_resources.device;
    
            let depth_texture = device.create_texture(&wgpu::TextureDescriptor {
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Depth24Plus,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                label: Some("Stunts Engine Export Depth Texture"),
                view_formats: &[],
            });
    
            let depth_view = depth_texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.depth_view = Some(depth_view);
    
            if let Some(editor) = self.export_editor.as_mut() {
                if let Some(camera) = editor.camera.as_mut() {
                    // camera.aspect = new_size.width as f32 / new_size.height as f32;
                    camera.aspect_ratio = new_size.width as f32 / new_size.height as f32;
                    camera.viewport.width = new_size.width as f32;
                    camera.viewport.height = new_size.height as f32;
                    camera.viewport.window_size.width = new_size.width;
                    camera.viewport.window_size.height = new_size.height;
                }
            }
        }
    }

    pub fn render_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64) {
        let editor = self.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_ref().expect("Couldn't get RendererState");
        let gpu_resources = self
            .gpu_resources
            .as_ref()
            .expect("Couldn't get gpu resources");
        let device = &gpu_resources.device;
        let queue = &gpu_resources.queue;
        // let device = self.device.as_ref().expect("Couldn't get device");
        // let queue = self.queue.as_ref().expect("Couldn't get queue");
        let view = if let Some(target_view) = target_view {
            target_view
        } else {
            self.view.as_ref().expect("Couldn't get texture view")
        };
        let depth_view = self
            .depth_view
            .as_ref()
            .expect("Couldn't get depth texture view");
        let render_pipeline = self
            .render_pipeline
            .as_ref()
            .expect("Couldn't get render pipeline");
        // let camera_binding = self
        //     .camera_binding
        //     .as_ref()
        //     .expect("Couldn't get camera binding");
        let camera_binding = editor
            .camera_binding
            .as_ref()
            .expect("Couldn't get camera binding");
        let window_size_bind_group = self
            .window_size_bind_group
            .as_ref()
            .expect("Couldn't get window size bind group");
        // let camera = self.camera.as_ref().expect("Couldn't get camera"); // careful, we have a camera on editor and on self
        let texture = self.texture.as_ref().expect("Couldn't get texture");
        

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    // resolve_target: Some(&resolve_view), // not sure how to add without surface
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLUE),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None
                })],
                // depth_stencil_attachment: None,
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view, // This is the depth texture view
                    depth_ops: Some(wgpu::Operations {
                        load: wgpu::LoadOp::Clear(1.0), // Clear to max depth
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None, // Set this if using stencil
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            render_pass.set_pipeline(&render_pipeline);

            // actual rendering commands
            // editor.step_video_animations(&camera, Some(current_time));
            // editor.step_motion_path_animations(&camera, Some(current_time));

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            // // draw static (internal) polygons
            // for (poly_index, polygon) in editor.static_polygons.iter().enumerate() {
            //     polygon
            //         .transform
            //         .update_uniform_buffer(&queue, &camera.viewport.window_size);
            //     render_pass.set_bind_group(1, &polygon.bind_group, &[]);
            //     render_pass.set_bind_group(3, &polygon.group_bind_group, &[]);
            //     render_pass.set_vertex_buffer(0, polygon.vertex_buffer.slice(..));
            //     render_pass
            //         .set_index_buffer(polygon.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
            //     render_pass.draw_indexed(0..polygon.indices.len() as u32, 0, 0..1);
            // }

            // // draw cubes
            for (poly_index, cube) in renderer_state.cubes.iter().enumerate() {
                // if !polygon.hidden {
                    cube
                        .transform
                        .update_uniform_buffer(&queue);
                    render_pass.set_bind_group(1, &cube.bind_group, &[]);
                    render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        cube.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
                // }
            }

            for (poly_index, grid) in renderer_state.grids.iter().enumerate() {
                // if !polygon.hidden {
                    grid
                        .transform
                        .update_uniform_buffer(&queue);
                    render_pass.set_bind_group(1, &grid.bind_group, &[]);
                    render_pass.set_bind_group(3, &grid.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, grid.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        grid.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..grid.index_count as u32, 0, 0..1);
                // }
            }

            // // draw text items
            // for (text_index, text_item) in editor.text_items.iter().enumerate() {
            //     if !text_item.hidden {
            //         if !text_item.background_polygon.hidden {
            //             text_item
            //                 .background_polygon
            //                 .transform
            //                 .update_uniform_buffer(&gpu_resources.queue, &camera.viewport.window_size);

            //             render_pass.set_bind_group(
            //                 1,
            //                 &text_item.background_polygon.bind_group,
            //                 &[],
            //             );
            //             render_pass.set_bind_group(
            //                 3,
            //                 &text_item.background_polygon.group_bind_group,
            //                 &[],
            //             );
            //             render_pass.set_vertex_buffer(
            //                 0,
            //                 text_item.background_polygon.vertex_buffer.slice(..),
            //             );
            //             render_pass.set_index_buffer(
            //                 text_item.background_polygon.index_buffer.slice(..),
            //                 wgpu::IndexFormat::Uint32,
            //             );
            //             render_pass.draw_indexed(
            //                 0..text_item.background_polygon.indices.len() as u32,
            //                 0,
            //                 0..1,
            //             );
            //         }

            //         text_item
            //             .transform
            //             .update_uniform_buffer(&queue, &camera.viewport.window_size);
            //         render_pass.set_bind_group(1, &text_item.bind_group, &[]);
            //         render_pass.set_bind_group(3, &text_item.group_bind_group, &[]);
            //         render_pass.set_vertex_buffer(0, text_item.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(
            //             text_item.index_buffer.slice(..),
            //             wgpu::IndexFormat::Uint32,
            //         );
            //         render_pass.draw_indexed(0..text_item.indices.len() as u32, 0, 0..1);
            //     }
            // }

            // // draw image items
            // for (image_index, st_image) in editor.image_items.iter().enumerate() {
            //     if !st_image.hidden {
            //         st_image
            //             .transform
            //             .update_uniform_buffer(&queue, &camera.viewport.window_size);
            //         render_pass.set_bind_group(1, &st_image.bind_group, &[]);
            //         render_pass.set_bind_group(3, &st_image.group_bind_group, &[]);
            //         render_pass.set_vertex_buffer(0, st_image.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(
            //             st_image.index_buffer.slice(..),
            //             wgpu::IndexFormat::Uint32,
            //         );
            //         render_pass.draw_indexed(0..st_image.indices.len() as u32, 0, 0..1);
            //     }
            // }

            // // draw video items
            // for (video_index, st_video) in editor.video_items.iter().enumerate() {
            //     if !st_video.hidden {
            //         st_video
            //             .transform
            //             .update_uniform_buffer(&queue, &camera.viewport.window_size);
            //         render_pass.set_bind_group(1, &st_video.bind_group, &[]);
            //         render_pass.set_bind_group(3, &st_video.group_bind_group, &[]);
            //         render_pass.set_vertex_buffer(0, st_video.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(
            //             st_video.index_buffer.slice(..),
            //             wgpu::IndexFormat::Uint32,
            //         );
            //         render_pass.draw_indexed(0..st_video.indices.len() as u32, 0, 0..1);
            //     }
            // }

            // Render all terrain managers
            for terrain_manager in &renderer_state.terrain_managers {
                terrain_manager.render(
                    &mut render_pass,
                    // &camera_binding.bind_group,
                    &gpu_resources.queue,
                );
            }

            // Drop the render pass before doing texture copies
            drop(render_pass);

            if self.frame_buffer.is_some() {
                let frame_buffer = self
                    .frame_buffer
                    .as_ref()
                    .expect("Couldn't get frame buffer");
                frame_buffer.capture_frame(device, queue, texture, &mut encoder);
            }

            let command_buffer = encoder.finish();
            queue.submit(std::iter::once(command_buffer));
        }
    }

    pub fn render_display_frame(&mut self, gui: &mut Gui, window: &Window, game_mode: bool) {
        let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get GPU Resources").clone();
    
        let output = gpu_resources.surface.as_ref().unwrap()
            .get_current_texture()
            .expect("Failed to get current swap chain texture");
    
        let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());
    
        self.render_frame(Some(&view), 0.0);
    
        if !game_mode {
            let mut encoder = gpu_resources.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("egui encoder"),
            });
            
            let raw_input = gui.state.take_egui_input(&window);
            let full_output = gui.ctx.run(raw_input, |ctx| {
                self.ui(ctx);
            });
        
            gui.state.handle_platform_output(&window, full_output.platform_output);
        
            let tris = gui.ctx.tessellate(full_output.shapes, full_output.pixels_per_point);
            let screen_descriptor = egui_wgpu::ScreenDescriptor {
                size_in_pixels: [output.texture.width(), output.texture.height()],
                pixels_per_point: window.scale_factor() as f32,
            };
        
            for (id, image_delta) in &full_output.textures_delta.set {
                gui.renderer.update_texture(&gpu_resources.device, &gpu_resources.queue, *id, image_delta);
            }
            
            gui.renderer.update_buffers(&gpu_resources.device, &gpu_resources.queue, &mut encoder, &tris, &screen_descriptor);
        
            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("egui"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                gui.renderer.render(&mut rpass.forget_lifetime(), &tris, &screen_descriptor);
            }
        
            // drop(rpass);
        
            gpu_resources.queue.submit(Some(encoder.finish()));
        }

        output.present();
    }
    
    fn ui(&mut self, ctx: &egui::Context) {
        let editor = self.export_editor.as_mut().unwrap();
        if editor.saved_state.is_none() {
            egui::Window::new("Projects").show(ctx, |ui| {
                ui.label("Create New Project");
                ui.text_edit_singleline(&mut self.new_project_name);
                if ui.button("Create New Project").clicked() {
                    if !self.new_project_name.is_empty() {
                        match utilities::create_project_state(&self.new_project_name) {
                            Ok(new_state) => {
                                editor.saved_state = Some(new_state);
                            }
                            Err(e) => {
                                println!("Failed to create project: {}", e);
                            }
                        }
                    }
                }
    
                ui.separator();
                ui.label("Existing Projects");
    
                let projects_dir = utilities::get_projects_dir().unwrap();
                self.projects.clear();
                for entry in fs::read_dir(projects_dir).unwrap() {
                    let entry = entry.unwrap();
                    let path = entry.path();
                    if path.is_dir() {
                        self.projects
                            .push(path.file_name().unwrap().to_str().unwrap().to_string());
                    }
                }
    
                for project_id in &self.projects {
                    if ui.button(project_id).clicked() {
                        match utilities::load_project_state(project_id) {
                            Ok(loaded_state) => {
                                editor.saved_state = Some(loaded_state);
                                
                                // now load landscapes
                                if let Some(saved_state) = &editor.saved_state {
                                    if let Some(landscapes) = &saved_state.landscapes {
                                        if let Some(levels) = &saved_state.levels {
                                            let level = &levels[0]; // assume one level for now
                                            for landscape_data in landscapes {
                                                if let Some(components) = &level.components {
                                                    for component in components {
                                                        if let Some(ComponentKind::Landscape) = component.kind {
                                                            if component.asset_id == landscape_data.id {
                                                                if let Some(heightmap) = &landscape_data.heightmap {
                                                                    let renderer_state = editor.renderer_state.as_mut().unwrap();
                                                                    let camera = editor.camera.as_mut().unwrap();
                                                                    let gpu_resources = self.gpu_resources.as_ref().unwrap();
                                                                    
                                                                    handle_add_landscape(
                                                                        renderer_state,
                                                                        &gpu_resources.device,
                                                                        &gpu_resources.queue,
                                                                        project_id.clone(),
                                                                        landscape_data.id.clone(),
                                                                        component.id.clone(),
                                                                        heightmap.fileName.clone(),
                                                                        component.generic_properties.position,
                                                                        camera,
                                                                    );

                                                                    if let Some(textures) = &saved_state.textures {
                                                                        let landscape_properties = component.landscape_properties.as_ref().expect("Couldn't get landscape properties");

                                                                        if let Some(texture_id) = &landscape_properties.rockmap_texture_id {
                                                                            let rockmap_texture = textures.iter().find(|t| {
                                                                                if &t.id == texture_id {
                                                                                    true
                                                                                } else {
                                                                                    false
                                                                                }
                                                                            });
                                                                            
                                                                            if let Some(rock_texture) = rockmap_texture {
                                                                                if let Some(rock_mask) = &landscape_data.rockmap {
                                                                                    handle_add_landscape_texture(renderer_state, &gpu_resources.device,
                                                                                    &gpu_resources.queue, project_id.clone(), component.id.clone(), 
                                                                                    landscape_data.id.clone(), rock_texture.fileName.clone(), LandscapeTextureKinds::Rockmap, rock_mask.fileName.clone());
                                                                                }
                                                                            }
                                                                        }
                                                                        if let Some(texture_id) = &landscape_properties.soil_texture_id {
                                                                            let soil_texture = textures.iter().find(|t| {
                                                                                if &t.id == texture_id {
                                                                                    true
                                                                                } else {
                                                                                    false
                                                                                }
                                                                            });
                                                                            
                                                                            if let Some(soil_texture) = soil_texture {
                                                                                if let Some(soil_mask) = &landscape_data.soil {
                                                                                    handle_add_landscape_texture(renderer_state, &gpu_resources.device,
                                                                                    &gpu_resources.queue, project_id.clone(), component.id.clone(), 
                                                                                    landscape_data.id.clone(), soil_texture.fileName.clone(), LandscapeTextureKinds::Soil, soil_mask.fileName.clone());
                                                                                }
                                                                            }
                                                                        }
                                                                    }
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                println!("Failed to load project: {}", e);
                            }
                        }
                    }
                }
            });
        }
    
        // scene controls
        egui::Window::new("Controls").show(ctx, |ui| {
            ui.label("Manage Scene");
    
            if ui.button("Add Cube").clicked() {
                let editor = self.export_editor.as_mut().unwrap();
                let gpu_resources = self.gpu_resources.as_ref().unwrap();
                let device = &gpu_resources.device;
                let queue = &gpu_resources.queue;
                let model_bind_group_layout = editor.model_bind_group_layout.as_ref().unwrap();
                let group_bind_group_layout = editor.group_bind_group_layout.as_ref().unwrap();
                let camera = editor.camera.as_ref().expect("Couldn't get camera");
                let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
                let texture_render_mode_buffer = renderer_state.texture_render_mode_buffer.clone();
    
                let new_cube = Cube::new(device, queue, model_bind_group_layout, group_bind_group_layout, &texture_render_mode_buffer, camera);
                renderer_state.cubes.push(new_cube);
    
                println!("Cube added {:?}", renderer_state.cubes.len());
            }
    
            if ui.button("Add Landscape").clicked() {
                let editor = self.export_editor.as_mut().unwrap();
                let gpu_resources = self.gpu_resources.as_ref().unwrap();
                let device = &gpu_resources.device;
                let queue = &gpu_resources.queue;
                let model_bind_group_layout = editor.model_bind_group_layout.as_ref().unwrap();
                let group_bind_group_layout = editor.group_bind_group_layout.as_ref().unwrap();
                let camera = editor.camera.as_mut().expect("Couldn't get camera");
                let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
    
                let mock_project_id = Uuid::new_v4().to_string();
                
                // handle_add_landscape(
                //     renderer_state, 
                //     device, 
                //     queue, 
                //     mock_project_id, 
                //     landscapeAssetId, 
                //     landscapeComponentId, 
                //     landscapeFilename, 
                //     [0.0, 0.0, 0.0], 
                //     camera
                // );
    
                // println!("Landscape added {:?}", editor.cubes.len());
            }
        });
    
        egui::Window::new("Hello too").show(ctx, |ui| {
            // let fps = ui.io().framerate;
            // ui.label(format!("Frametime: {:?}", fps));
        });
    
        // self.chat.render(ctx);
    }
}
