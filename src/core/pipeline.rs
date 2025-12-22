use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::{
    core::{Grid::{Grid, GridConfig}, RendererState::RendererState, SimpleCamera::SimpleCamera as Camera, Texture::pack_pbr_textures, camera::{self, CameraBinding}, editor::{
        Editor, PointLight, Viewport, WindowSize, WindowSizeShader
    }, gpu_resources::{self, GpuResources}, vertex::Vertex}, handlers::{EntropySize}, heightfield_landscapes::Landscape::{PBRMaterialType, PBRTextureKind}, helpers::{landscapes::{read_landscape_heightmap_as_texture, read_texture_bytes}, saved_data::{ComponentKind, LandscapeTextureKinds, LevelData, PBRTextureData, ProceduralSkyConfig, SavedState}, timelines::SavedTimelineStateConfig, utilities}, procedural_trees::trees::DrawTrees, vector_animations::animations::Sequence, video_export::frame_buffer::FrameCaptureBuffer, water_plane::water::DrawWater
};
use crate::core::Texture::Texture;
use crate::core::shadow_pipeline::ShadowPipelineData;
use crate::core::ui_pipeline::UiPipeline;
use std::{fs, sync::{Arc, Mutex}};
// use cgmath::{Point3, Vector3};
use nalgebra::{Isometry3, Point3, Translation3, UnitQuaternion, Vector3};
use transform_gizmo::math::{DMat4, DVec3, DVec4};
use uuid::Uuid;
use pollster; // For pollster::block_on
use transform_gizmo::math::Vec4Swizzles;

#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;
use wgpu::{Limits, RenderPipeline, util::DeviceExt};
use bytemuck::{Pod, Zeroable}; // For procedural sky uniform

#[cfg(target_os = "windows")]
use winit::window::Window;

#[cfg(target_os = "windows")]
use egui;

#[cfg(target_os = "windows")]
use crate::startup::Gui;

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

use crate::shape_primitives::Cube::Cube;
use crate::helpers::load_project::load_project;
use crate::rhai_engine::{ComponentChanges, RhaiEngine};

// use super::chat::Chat;

// Procedural Sky Uniform struct (Rust mirror of WGSL)
#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct ProceduralSkyUniform {
    horizon_color: [f32; 3],
    _padding0: f32, // Pad to 16 bytes for alignment
    zenith_color: [f32; 3],
    _padding1: f32,
    sun_direction: [f32; 3],
    _padding2: f32,
    sun_color: [f32; 3],
    _padding3: f32,
    sun_intensity: f32,
    _padding4: [f32; 3], // Pad to 16 bytes
}

impl Default for ProceduralSkyUniform {
    fn default() -> Self {
        Self {
            horizon_color: [0.7, 0.8, 1.0], // Light blue
            _padding0: 0.0,
            zenith_color: [0.2, 0.3, 0.6], // Darker blue
            _padding1: 0.0,
            sun_direction: [0.0, 1.0, 0.0], // Directly overhead
            _padding2: 0.0,
            sun_color: [1.0, 0.9, 0.7],    // Warm yellow
            _padding3: 0.0,
            sun_intensity: 5.0,
            _padding4: [0.0; 3],
        }
    }
}

pub struct ExportPipeline {
    // pub device: Option<wgpu::Device>,
    // pub queue: Option<wgpu::Queue>,
    pub gpu_resources: Option<Arc<GpuResources>>,
    pub camera: Option<Camera>,
    pub camera_binding: Option<CameraBinding>,
    pub geometry_pipeline: Option<RenderPipeline>,
    pub lighting_pipeline: Option<RenderPipeline>,
    pub procedural_sky_pipeline: Option<RenderPipeline>, // New field for procedural sky
    pub procedural_sky_bind_group: Option<wgpu::BindGroup>, // New field for procedural sky bind group
    pub procedural_sky_uniform_buffer: Option<wgpu::Buffer>, // New field for procedural sky uniform buffer
    pub texture: Option<Arc<wgpu::Texture>>,
    pub view: Option<Arc<wgpu::TextureView>>,
    pub depth_view: Option<wgpu::TextureView>,
    pub window_size_bind_group: Option<wgpu::BindGroup>,
    pub export_editor: Option<Editor>,
    pub frame_buffer: Option<FrameCaptureBuffer>,
    // pub chat: Chat,
    new_project_name: String,
    projects: Vec<String>,

    start_time: Instant,

    // G-Buffer textures
    pub g_buffer_position_texture: Option<wgpu::Texture>,
    pub g_buffer_position_view: Option<wgpu::TextureView>,
    pub g_buffer_normal_texture: Option<wgpu::Texture>,
    pub g_buffer_normal_view: Option<wgpu::TextureView>,
    pub g_buffer_albedo_texture: Option<wgpu::Texture>,
    pub g_buffer_albedo_view: Option<wgpu::TextureView>,
    pub g_buffer_pbr_material_texture: Option<wgpu::Texture>,
    pub g_buffer_pbr_material_view: Option<wgpu::TextureView>,
    pub g_buffer_sampler: Option<wgpu::Sampler>,
    pub shadow_pipeline_data: Option<ShadowPipelineData>,
    pub ui_pipeline: Option<UiPipeline>,

    // G-Buffer bind group
    pub g_buffer_bind_group_layout: Option<wgpu::BindGroupLayout>,
    pub g_buffer_bind_group: Option<wgpu::BindGroup>,
    pub lighting_bind_group: Option<wgpu::BindGroup>,
    pub directional_light_buffer: Option<wgpu::Buffer>,
    pub point_lights_buffer: Option<wgpu::Buffer>,
    pub gizmo_pipeline: Option<RenderPipeline>,

    pub directional_light_position: [f32; 3],
    pub selected_component_id: Option<String>,
}

impl ExportPipeline {
    pub fn new() -> Self {
        ExportPipeline {
            // device: None,
            // queue: None,
            gpu_resources: None,
            camera: None,
            camera_binding: None,
            geometry_pipeline: None,
            lighting_pipeline: None,
            texture: None,
            view: None,
            depth_view: None,
            window_size_bind_group: None,
            export_editor: None,
            frame_buffer: None,
            // chat: Chat::new(),
            new_project_name: String::new(),
            projects: Vec::new(),
            
            start_time: Instant::now(),

            g_buffer_position_texture: None,
            g_buffer_position_view: None,
            g_buffer_normal_texture: None,
            g_buffer_normal_view: None,
            g_buffer_albedo_texture: None,
            g_buffer_albedo_view: None,
            g_buffer_pbr_material_texture: None,
            g_buffer_pbr_material_view: None,
            g_buffer_bind_group_layout: None,
            g_buffer_bind_group: None,
            lighting_bind_group: None,
            directional_light_buffer: None,
            point_lights_buffer: None,
            g_buffer_sampler: None,
            shadow_pipeline_data: None,
            ui_pipeline: None,
            gizmo_pipeline: None,
            procedural_sky_pipeline: None,
            procedural_sky_bind_group: None,
            procedural_sky_uniform_buffer: None,
            directional_light_position: [2.0, 2.0, 2.0],
            selected_component_id: None,
        }
    }

    pub async fn initialize(
        &mut self,
        
        #[cfg(target_os = "windows")]
        window: Option<&Window>,

        #[cfg(target_arch = "wasm32")]
        canvas: Option<HtmlCanvasElement>,

        window_size: WindowSize,
        sequences: Vec<Sequence>,
        video_current_sequence_timeline: SavedTimelineStateConfig,
        video_width: u32,
        video_height: u32,
        project_id: String,
        game_mode: bool
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

        #[cfg(target_arch = "wasm32")]
        let window = if let Some(canvas) = canvas {
            Some(wgpu::SurfaceTarget::Canvas(canvas))
        } else {
            None
        };

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
                    // required_features: wgpu::Features::FLOAT32_FILTERABLE,
                    required_limits: Limits {
                        // max_bind_groups: 5, // bad for wasm :(
                        ..Default::default()
                    },
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

        // Create G-buffer textures and views
        let gbuffer_position_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer Position Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_position_view = gbuffer_position_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gbuffer_normal_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer Normal Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_normal_view = gbuffer_normal_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gbuffer_albedo_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer Albedo Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_albedo_view = gbuffer_albedo_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let gbuffer_pbr_material_texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("G-Buffer PBR Material Texture"),
            size: wgpu::Extent3d {
                width: video_width,
                height: video_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let gbuffer_pbr_material_view = gbuffer_pbr_material_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let g_buffer_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("G-Buffer Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::FilterMode::Nearest,
            ..Default::default()
        });

        let g_buffer_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("G-Buffer Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: false },
                            view_dimension: wgpu::TextureViewDimension::D2,
                            multisampled: false,
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 4,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::NonFiltering),
                        count: None,
                    },
                ],
            });

        let g_buffer_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("G-Buffer Bind Group"),
            layout: &g_buffer_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_position_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_normal_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_albedo_view),
                },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&gbuffer_pbr_material_view),
                },
                wgpu::BindGroupEntry {
                    binding: 4,
                    resource: wgpu::BindingResource::Sampler(&g_buffer_sampler),
                },
            ],
        });

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
                    // Normal map texture array
                    wgpu::BindGroupLayoutEntry {
                        binding: 4,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
                        },
                        count: None,
                    },
                    // PBR params texture array
                    wgpu::BindGroupLayoutEntry {
                        binding: 5,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2Array,
                            multisampled: false,
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
                    visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
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

        let regular_texture_render_mode_buffer =
            device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Regular Texture Render Mode Buffer"),
                    contents: bytemuck::cast_slice(&[2i32]), // Default to text mode
                    usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                });

        let regular_texture_render_mode_buffer = Arc::new(regular_texture_render_mode_buffer);

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

        // let shader_module_frag_primary =
        //     device.create_shader_module(wgpu::ShaderModuleDescriptor {
        //         label: Some("Stunts Engine Export Frag Shader"),
        //         // source: wgpu::ShaderSource::Wgsl(include_str!("shaders/frag_primary.wgsl").into()), // stunts
        //         source: wgpu::ShaderSource::Wgsl(include_str!("shaders/primary_fragment.wgsl").into()), // midpoint
        //     });

        let shader_module_frag_gbuffer =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("G-Buffer Frag Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/gbuffer_fragment.wgsl").into()),
            });

        // let swapchain_capabilities = gpu_resources
        //     .surface
        //     .get_capabilities(&gpu_resources.adapter);
        // let swapchain_format = swapchain_capabilities.formats[0]; // Choosing the first available format
        // let swapchain_format = wgpu::TextureFormat::Rgba8UnormSrgb; // hardcode for now - may be able to change from the floem requirement
        let swapchain_format = wgpu::TextureFormat::Rgba8Unorm;
        // let swapchain_format = wgpu::TextureFormat::Rgba8Unorm;

        // Configure the render pipeline
        // let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        //     label: Some("Entropy Engine Render Pipeline"),
        //     layout: Some(&pipeline_layout),
        //     multiview: None,
        //     cache: None,
        //     vertex: wgpu::VertexState {
        //         module: &shader_module_vert_primary,
        //         entry_point: Some("vs_main"), // name of the entry point in your vertex shader
        //         buffers: &[Vertex::desc()], // Make sure your Vertex::desc() matches your vertex structure
        //         compilation_options: wgpu::PipelineCompilationOptions::default(),
        //     },
        //     fragment: Some(wgpu::FragmentState {
        //         module: &shader_module_frag_primary,
        //         entry_point: Some("fs_main"), // name of the entry point in your fragment shader
        //         targets: &[Some(wgpu::ColorTargetState {
        //             format: swapchain_format,
        //             // blend: Some(wgpu::BlendState::REPLACE),
        //             blend: Some(wgpu::BlendState {
        //                 color: wgpu::BlendComponent {
        //                     src_factor: wgpu::BlendFactor::SrcAlpha,
        //                     dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        //                     operation: wgpu::BlendOperation::Add,
        //                 },
        //                 alpha: wgpu::BlendComponent {
        //                     src_factor: wgpu::BlendFactor::One,
        //                     dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
        //                     operation: wgpu::BlendOperation::Add,
        //                 },
        //             }),
        //             write_mask: wgpu::ColorWrites::ALL,
        //         })],
        //         compilation_options: wgpu::PipelineCompilationOptions::default(),
        //     }),
        //     // primitive: wgpu::PrimitiveState::default(),
        //     // depth_stencil: None,
        //     // multisample: wgpu::MultisampleState::default(),
        //     primitive: wgpu::PrimitiveState {
        //         conservative: false,
        //         topology: wgpu::PrimitiveTopology::TriangleList, // how vertices are assembled into geometric primitives
        //         // strip_index_format: Some(wgpu::IndexFormat::Uint32),
        //         strip_index_format: None,
        //         front_face: wgpu::FrontFace::Ccw, // Counter-clockwise is considered the front face
        //         // none cull_mode
        //         cull_mode: None,
        //         polygon_mode: wgpu::PolygonMode::Fill,
        //         // Other properties such as conservative rasterization can be set here
        //         unclipped_depth: false,
        //     },
        //     depth_stencil: Some(depth_stencil_state.clone()), // Optional, only if you are using depth testing
        //     multisample: wgpu::MultisampleState {
        //         // count: 4, // effect performance
        //         count: 1,
        //         mask: !0,
        //         alpha_to_coverage_enabled: false,
        //     },
        // });

        let directional_light_position = [-2.0, 2.0, 2.0];

        let shadow_pipeline_data = ShadowPipelineData::new(
            &device,
            &queue,
            &model_bind_group_layout,
            video_width,
            video_height,
            directional_light_position
        );

        let ui_pipeline = UiPipeline::new(
            &device,
            &camera_binding.bind_group_layout,
            &model_bind_group_layout,
            &window_size_bind_group_layout,
            &group_bind_group_layout,
            swapchain_format,
        );

        let geometry_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Entropy Engine Geometry Pipeline"),
            layout: Some(&pipeline_layout),
            multiview: None,
            cache: None,
            vertex: wgpu::VertexState {
                module: &shader_module_vert_primary,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_frag_gbuffer,
                entry_point: Some("fs_main"),
                targets: &[
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba16Float,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                    Some(wgpu::ColorTargetState {
                        format: wgpu::TextureFormat::Rgba8Unorm,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    }),
                ],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                conservative: false,
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
            },
            depth_stencil: Some(depth_stencil_state),
            multisample: wgpu::MultisampleState {
                count: 1,
                mask: !0,
                alpha_to_coverage_enabled: false,
            },
        });

        // Directional Light
        #[repr(C)]
        #[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
        struct DirectionalLightUniform {
            position: [f32; 3],
            _padding: u32,
            color: [f32; 3],
            _padding2: u32,
        }

        let directional_light_uniform = DirectionalLightUniform {
            position: directional_light_position,
            // position: [-0.5, -1.0, -0.3], // since this is the direction in the shader
            _padding: 0,
            color: [0.5, 0.5, 0.5],
            _padding2: 0,
        };

        let directional_light_buffer = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Directional Light VB"),
                contents: bytemuck::cast_slice(&[directional_light_uniform]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }
        );

        // Point Lights
        let point_lights_uniform = crate::core::editor::PointLightsUniform {
            point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS],
            num_point_lights: 0,
            _padding: [0; 3],
        };

        let point_lights_buffer = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Point Lights VB"),
                contents: bytemuck::cast_slice(&[point_lights_uniform]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }
        );

        let lighting_bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                // Shadow map texture
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Depth,
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                // Shadow map sampler
                wgpu::BindGroupLayoutEntry {
                    binding: 3,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison),
                    count: None,
                },
            ],
            label: Some("Lighting Bind Group Layout"),
        });

        let lighting_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &lighting_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: directional_light_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: point_lights_buffer.as_entire_binding(),
                },
                // Shadow map texture view
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&shadow_pipeline_data.shadow_view),
                },
                // Shadow map sampler
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::Sampler(&shadow_pipeline_data.shadow_sampler),
                },
            ],
            label: Some("Lighting Bind Group"),
        });

        let lighting_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Lighting Pipeline Layout"),
            bind_group_layouts: &[
                &lighting_bind_group_layout, // group(0)
                &g_buffer_bind_group_layout,
                // &window_size_bind_group_layout,
                 &camera_binding.bind_group_layout,
                &shadow_pipeline_data.shadow_bind_group_layout, // group(3)
                // &camera_binding.bind_group_layout
            ],
            push_constant_ranges: &[],
        });

        let shader_module_lighting =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Lighting Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/lighting.wgsl").into()),
            });

        let lighting_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Lighting Pipeline"),
            layout: Some(&lighting_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_lighting,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_lighting,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
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

        let shader_module_gizmo_vert =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Gizmo Vert Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/gizmo_vertex.wgsl").into()),
            });

        let shader_module_gizmo_frag =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Gizmo Frag Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/gizmo_fragment.wgsl").into()),
            });

        let gizmo_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Gizmo Pipeline Layout"),
            bind_group_layouts: &[
                &window_size_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let gizmo_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Gizmo Pipeline"),
            layout: Some(&gizmo_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_gizmo_vert,
                entry_point: Some("vs_main"),
                buffers: &[
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![0 => Float32x2],
                    },
                    wgpu::VertexBufferLayout {
                        array_stride: std::mem::size_of::<[f32; 4]>() as wgpu::BufferAddress,
                        step_mode: wgpu::VertexStepMode::Vertex,
                        attributes: &wgpu::vertex_attr_array![1 => Float32x4],
                    },
                ],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_gizmo_frag,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // --- Procedural Sky Setup ---
        let procedural_sky_config_from_level = export_editor
            .saved_state
            .as_ref()
            .and_then(|state| state.levels.as_ref())
            .and_then(|levels| levels.get(0)) // Assuming we always work with the first level
            .and_then(|level| level.procedural_sky.clone())
            .unwrap_or_default(); // Get from saved_data, or use defaults

        let procedural_sky_uniform_data = ProceduralSkyUniform {
            horizon_color: procedural_sky_config_from_level.horizon_color,
            zenith_color: procedural_sky_config_from_level.zenith_color,
            sun_direction: procedural_sky_config_from_level.sun_direction,
            sun_color: procedural_sky_config_from_level.sun_color,
            sun_intensity: procedural_sky_config_from_level.sun_intensity,
            ..Default::default()
        };

        let procedural_sky_uniform_buffer = device.create_buffer_init(
            &wgpu::util::BufferInitDescriptor {
                label: Some("Procedural Sky Uniform Buffer"),
                contents: bytemuck::cast_slice(&[procedural_sky_uniform_data]),
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            }
        );

        let procedural_sky_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Procedural Sky Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(std::num::NonZeroU64::new(std::mem::size_of::<camera::CameraUniform>() as u64).unwrap()),
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: Some(std::num::NonZeroU64::new(std::mem::size_of::<ProceduralSkyUniform>() as u64).unwrap()),
                        },
                        count: None,
                    },
                ],
            });
        
        let procedural_sky_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Procedural Sky Bind Group"),
            layout: &procedural_sky_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera_binding.buffer.as_entire_binding(), // Re-use camera_binding's buffer
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: procedural_sky_uniform_buffer.as_entire_binding(),
                },
            ],
        });

        let shader_module_sky =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Procedural Sky Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/sky.wgsl").into()),
            });

        let procedural_sky_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Procedural Sky Pipeline Layout"),
            bind_group_layouts: &[&procedural_sky_bind_group_layout],
            push_constant_ranges: &[],
        });

        let procedural_sky_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Procedural Sky Pipeline"),
            layout: Some(&procedural_sky_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_sky,
                entry_point: Some("vs_main"),
                buffers: &[], // No vertex buffers, generates full screen triangle from vertex_index
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_sky,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format, // Use the main swapchain format
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: Some(wgpu::Face::Back), // Cull back faces (since we're rendering from inside)
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            // IMPORTANT: For skybox, we need to pass depth test if depth is 1.0 (far plane) and disable depth write
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus, // Match the depth buffer format
                depth_write_enabled: false, // Don't write to depth buffer
                depth_compare: wgpu::CompareFunction::LessEqual, // Draw only where no geometry (depth is 1.0)
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        // --- End Procedural Sky Setup ---

        let skinned_pipeline = SkinnedPipeline::new(&device, &camera_binding.bind_group_layout, &model_bind_group_layout, swapchain_format, wgpu::TextureFormat::Depth24Plus);

        println!("Grid Restored!");

        let mut renderer_state = RendererState::new(
            &device, 
            &queue, 
            model_bind_group_layout.clone(), 
            group_bind_group_layout.clone(), 
            &camera,
            texture_render_mode_buffer.clone(),
            color_render_mode_buffer,
            regular_texture_render_mode_buffer,
            game_mode,
            skinned_pipeline
        );

        let mut grids = Vec::new();

        if !game_mode {
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
        }

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
        // #[cfg(target_os = "windows")]
        let now = Instant::now();
        
        // #[cfg(target_arch = "wasm32")]
        // let now = js_sys::Date::now() - self.start_time;
        
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
        

        self.gizmo_pipeline = Some(gizmo_pipeline);

        self.gpu_resources = export_editor.gpu_resources.clone();
        self.geometry_pipeline = Some(geometry_pipeline);
        self.lighting_pipeline = Some(lighting_pipeline);
        self.procedural_sky_pipeline = Some(procedural_sky_pipeline);
        self.procedural_sky_bind_group = Some(procedural_sky_bind_group);
        self.procedural_sky_uniform_buffer = Some(procedural_sky_uniform_buffer);
        self.texture = Some(texture);
        self.view = Some(view);
        self.depth_view = Some(depth_view);
        self.window_size_bind_group = Some(window_size_bind_group);
        self.export_editor = Some(export_editor);

        self.g_buffer_position_texture = Some(gbuffer_position_texture);
        self.g_buffer_position_view = Some(gbuffer_position_view);
        self.g_buffer_normal_texture = Some(gbuffer_normal_texture);
        self.g_buffer_normal_view = Some(gbuffer_normal_view);
        self.g_buffer_albedo_texture = Some(gbuffer_albedo_texture);
        self.g_buffer_albedo_view = Some(gbuffer_albedo_view);
        self.g_buffer_pbr_material_texture = Some(gbuffer_pbr_material_texture);
        self.g_buffer_pbr_material_view = Some(gbuffer_pbr_material_view);
        self.g_buffer_bind_group_layout = Some(g_buffer_bind_group_layout);
        self.g_buffer_bind_group = Some(g_buffer_bind_group);
        self.lighting_bind_group = Some(lighting_bind_group);
        self.directional_light_buffer = Some(directional_light_buffer);
        self.point_lights_buffer = Some(point_lights_buffer);
        self.g_buffer_sampler = Some(g_buffer_sampler);
        self.shadow_pipeline_data = Some(shadow_pipeline_data);
        self.ui_pipeline = Some(ui_pipeline);
        self.directional_light_position = directional_light_position;
    }

    pub fn resize(&mut self, new_size: EntropySize) {
        if new_size.width > 0 && new_size.height > 0 {
            let gpu_resources = self.gpu_resources.as_ref().unwrap();
            let device = &gpu_resources.device;
            let g_buffer_bind_group_layout = self.g_buffer_bind_group_layout.as_ref().unwrap();
            let g_buffer_sampler = self.g_buffer_sampler.as_ref().unwrap(); // Assuming sampler is at binding 3

            // Recreate depth texture
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

            // Recreate G-buffer textures and views
            let gbuffer_position_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer Position Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_position_view = gbuffer_position_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let gbuffer_normal_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer Normal Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_normal_view = gbuffer_normal_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let gbuffer_albedo_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer Albedo Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_albedo_view = gbuffer_albedo_texture.create_view(&wgpu::TextureViewDescriptor::default());

            let gbuffer_pbr_material_texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("G-Buffer PBR Material Texture"),
                size: wgpu::Extent3d {
                    width: new_size.width,
                    height: new_size.height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let gbuffer_pbr_material_view = gbuffer_pbr_material_texture.create_view(&wgpu::TextureViewDescriptor::default());

            // Recreate shadow pipeline data
            let shadow_pipeline_data = ShadowPipelineData::new(
                device,
                &gpu_resources.queue, // Use gpu_resources.queue
                self.export_editor.as_ref().unwrap().model_bind_group_layout.as_ref().unwrap(), // Pass model_bind_group_layout
                new_size.width,
                new_size.height,
                self.directional_light_position
            );

            // Recreate window size buffer and bind group
            let window_size_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::cast_slice(&[WindowSizeShader {
                    width: new_size.width as f32,
                    height: new_size.height as f32,
                }]),
                usage: wgpu::BufferUsages::UNIFORM,
            });
            let window_size_bind_group_layout =
                device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: None,
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
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

            // Recreate G-buffer bind group
            let new_g_buffer_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("G-Buffer Bind Group (Resized)"),
                layout: g_buffer_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_position_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_normal_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_albedo_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 3,
                        resource: wgpu::BindingResource::TextureView(&gbuffer_pbr_material_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 4,
                        // Need to get the sampler from the original bind group
                        resource: wgpu::BindingResource::Sampler(&g_buffer_sampler),
                    },
                ],
            });

            self.g_buffer_position_texture = Some(gbuffer_position_texture);
            self.g_buffer_position_view = Some(gbuffer_position_view);
            self.g_buffer_normal_texture = Some(gbuffer_normal_texture);
            self.g_buffer_normal_view = Some(gbuffer_normal_view);
            self.g_buffer_albedo_texture = Some(gbuffer_albedo_texture);
            self.g_buffer_albedo_view = Some(gbuffer_albedo_view);
            self.g_buffer_pbr_material_texture = Some(gbuffer_pbr_material_texture);
            self.g_buffer_pbr_material_view = Some(gbuffer_pbr_material_view);
            self.g_buffer_bind_group = Some(new_g_buffer_bind_group);
            self.shadow_pipeline_data = Some(shadow_pipeline_data); // Add this line
            self.window_size_bind_group = Some(window_size_bind_group);
    
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

    pub fn render_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64, game_mode: bool) {
        let editor = self.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get RendererState");
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
        // let render_pipeline = self
        //     .render_pipeline
        //     .as_ref()
        //     .expect("Couldn't get render pipeline");
        let geometry_pipeline = self
            .geometry_pipeline
            .as_ref()
            .expect("Couldn't get geometry pipeline");
        // let camera_binding = self
        //     .camera_binding
        //     .as_ref()
        //     .expect("Couldn't get camera binding");
        let camera = editor
            .camera
            .as_mut()
            .expect("Couldn't get camera");
        let camera_binding = editor
            .camera_binding
            .as_mut()
            .expect("Couldn't get camera binding");
        let window_size_bind_group = self
            .window_size_bind_group
            .as_ref()
            .expect("Couldn't get window size bind group");
        // let camera = self.camera.as_ref().expect("Couldn't get camera"); // careful, we have a camera on editor and on self
        let texture = self.texture.as_ref().expect("Couldn't get texture");
        

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            // Update procedural sky uniform buffer if config is present
            let current_procedural_sky_config = editor
                .saved_state
                .as_ref()
                .and_then(|state| state.levels.as_ref())
                .and_then(|levels| levels.get(0))
                .and_then(|level| level.procedural_sky.clone());

            if let Some(config) = current_procedural_sky_config {
                let procedural_sky_uniform_data = ProceduralSkyUniform {
                    horizon_color: config.horizon_color,
                    zenith_color: config.zenith_color,
                    sun_direction: config.sun_direction,
                    sun_color: config.sun_color,
                    sun_intensity: config.sun_intensity,
                    ..Default::default()
                };
                queue.write_buffer(
                    self.procedural_sky_uniform_buffer.as_ref().unwrap(),
                    0,
                    bytemuck::cast_slice(&[procedural_sky_uniform_data]),
                );
            }

            // Shadow Pass
            {
                let shadow_pipeline_data = self.shadow_pipeline_data.as_ref().unwrap();

                let mut shadow_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Shadow Pass"),
                    color_attachments: &[], // No color attachment, we only care about depth
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: &shadow_pipeline_data.shadow_view,
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0), // Clear to max depth
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                shadow_pipeline_data.render_shadow_pass(
                    &mut shadow_pass,
                    renderer_state,
                    queue,
                );
            }

            // update rapier collisions
            renderer_state.update_rapier();

            // perhaps counterproductive to avoid physics in the preview
            // but sometimes you dont want to mix physics when doing design (make this a setting)
            if game_mode {
                // step through physics each frame
                renderer_state.step_physics_pipeline(
                    &gpu_resources.device,
                    &gpu_resources.queue,
                    camera_binding,
                    camera
                );
            }

            // Execute Rhai component scripts
            let mut changes: Vec<ComponentChanges> = Vec::new();
            if let Some(saved_state) = editor.saved_state.as_ref() {
                if let Some(levels) = saved_state.levels.as_ref() {
                    if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                        for component in components.iter() {
                            if let Some(script_path) = &component.rhai_script_path {
                                if let Some(change) = editor.rhai_engine.execute_component_script(
                                    renderer_state,
                                    component,
                                    script_path,
                                    "on_update",
                                ) {
                                    changes.push(change);
                                }
                            }
                        }
                    }
                }
            }

            // Apply collected changes
            for change in changes {
                if let Some(model) = renderer_state.models.iter_mut().find(|m| m.id == change.component_id) {
                    if let Some(new_pos) = change.new_position {
                        let pos_array = [new_pos.x, new_pos.y, new_pos.z];
                        
                        // Update model's transform for rendering
                        for mesh in &mut model.meshes {
                            mesh.transform.update_position(pos_array);
                        }
                        
                        // Update rigidbody for physics
                        if let Some(rb_handle) = model.meshes[0].rigid_body_handle {
                            if let Some(rb) = renderer_state.rigid_body_set.get_mut(rb_handle) {
                                let new_isometry = nalgebra::Isometry3::translation(new_pos.x, new_pos.y, new_pos.z);
                                rb.set_position(new_isometry, true);
                            }
                        }
                    }
                }
            }

            let gbuffer_position_view = self.g_buffer_position_view.as_ref().unwrap();            let gbuffer_normal_view = self.g_buffer_normal_view.as_ref().unwrap();
            let gbuffer_albedo_view = self.g_buffer_albedo_view.as_ref().unwrap();
            let gbuffer_pbr_material_view = self.g_buffer_pbr_material_view.as_ref().unwrap();

            let clear_color = wgpu::Color::BLACK;

            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Geometry Pass"),
                color_attachments: &[
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_position_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_normal_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_albedo_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                    Some(wgpu::RenderPassColorAttachment {
                        view: gbuffer_pbr_material_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(clear_color),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None
                    }),
                ],
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

            render_pass.set_pipeline(&geometry_pipeline);

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

            // draw skybox sphere
            // if let sphere = &mut renderer_state.skybox {
            //     // sphere.transform.update_uniform_buffer(&queue);
            //     render_pass.set_bind_group(1, &sphere.bind_group, &[]);
            //     render_pass.set_bind_group(3, &sphere.group_bind_group, &[]);
            //     render_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
            //     render_pass.set_index_buffer(sphere.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            //     render_pass.draw_indexed(0..sphere.index_count as u32, 0, 0..1);
            // }

            // draw player character sphere (will use as a fallback when no model is available)
            // if let Some(player_character) = &mut renderer_state.player_character {
            //     if let Some(sphere) = &mut player_character.sphere {
            //         if let Some(rb_handle) = player_character.movement_rigid_body_handle {
            //             if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
            //                 let pos = rb.translation();
            //                 sphere.transform.update_position([pos.x, pos.y, pos.z]);
            //             }
            //         }

            //         sphere.transform.update_uniform_buffer(&queue);
            //         render_pass.set_bind_group(1, &sphere.bind_group, &[]);
            //         render_pass.set_bind_group(3, &sphere.group_bind_group, &[]);
            //         render_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
            //         render_pass.set_index_buffer(sphere.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            //         render_pass.draw_indexed(0..sphere.index_count as u32, 0, 0..1);
            //     }
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

            for model in &renderer_state.models {
                for mesh in &model.meshes {
                    // Conditional rendering based on skinning
                    if let Some(skin_bind_group) = &model.skin_bind_group {
                        // Use the skinned pipeline and bind its specific bind group
                        if let Some(pipeline_instance) = &renderer_state.skinned_pipeline {
                            render_pass.set_pipeline(&pipeline_instance.render_pipeline);
                            // Bind skin uniform at group 2 (as defined in skinned_pipeline.rs)
                            render_pass.set_bind_group(2, skin_bind_group, &[]);
                        } else {
                             // Fallback to geometry_pipeline if skinned_pipeline is None (should not happen if initialized correctly)
                            render_pass.set_pipeline(&geometry_pipeline);
                        }
                    } else {
                        // Use the regular geometry pipeline for non-skinned meshes
                        render_pass.set_pipeline(&geometry_pipeline);
                    }

                    // if model.hide_from_world {
                    //     println!("Render mesh uniform {:?}", mesh.transform.position);
                    // }

                    mesh.transform.update_uniform_buffer(&gpu_resources.queue);

                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]); // Camera
                    render_pass.set_bind_group(1, &mesh.bind_group, &[]); // Model transform + textures
                    // render_pass.set_bind_group(2, window_size_bind_group, &[]); // Window size is not needed for skinned shader
                    render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

                    // Need to use the regular vertex buffer with regular Vertex if using geometry pipeline
                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        mesh.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                }
            }

            for house in &renderer_state.procedural_houses {
                for mesh in &house.meshes {
                    render_pass.set_pipeline(&geometry_pipeline);
                    mesh.transform.update_uniform_buffer(&gpu_resources.queue);
                    render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                    // render_pass.set_bind_group(3, &mesh.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        mesh.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );

                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                }
            }

            for (poly_index, landscape) in renderer_state.landscapes.iter().enumerate() {
                // if !polygon.hidden {
                    render_pass.set_pipeline(&geometry_pipeline);
                    landscape
                        .transform
                        .update_uniform_buffer(&queue); // probably unnecessary
                    render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                    render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                    render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        landscape.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
                // }
            }

            // draw grass
            let time = self.start_time.elapsed().as_secs_f32();

            for grass in &renderer_state.grasses {
                if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                        let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                        let player_model = player_model.as_ref().expect("Couldn't find related model");
                        let model_mesh = player_model.meshes.get(0);
                        let model_mesh = model_mesh.as_ref().expect("Couldn't get first mesh");
                        grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
                    } else if let Some(sphere) = &player_character.sphere {
                        grass.update_uniforms(&queue, time as f32, Point3::new(sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z));
                    } else {
                        grass.update_uniforms(&queue, time as f32, camera.position);
                    }
                } else {
                    grass.update_uniforms(&queue, time as f32, camera.position);
                }

                render_pass.set_pipeline(&grass.render_pipeline);
                render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                render_pass.set_bind_group(1, &grass.uniform_bind_group, &[]);
                render_pass.set_bind_group(2, &grass.landscape_bind_group, &[]);
                render_pass.set_vertex_buffer(0, grass.blade.vertex_buffer.slice(..));
                render_pass.set_index_buffer(grass.blade.index_buffer.slice(..), wgpu::IndexFormat::Uint16);

                let grid_cells = ((grass.render_distance * 2.0) / grass.grid_size).ceil() as u32;
                let total_instances = grid_cells * grid_cells * grass.blade_density;

                render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
                render_pass.set_pipeline(&geometry_pipeline);
            }

            // draw trees
            for trees in &renderer_state.procedural_trees {
                trees.update_uniforms(&queue, time as f32);
                render_pass.draw_trees(
                    trees,
                    &camera_binding.bind_group,
                );
                render_pass.set_pipeline(&geometry_pipeline);
            }

            // draw water
            for water_plane in &mut renderer_state.water_planes {
                if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                        let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                        let player_model = player_model.as_ref().expect("Couldn't find related model");
                        let model_mesh = player_model.meshes.get(0);
                        let model_mesh = model_mesh.as_ref().expect("Couldn't get first mesh");
                        water_plane.update_uniforms(queue, time as f32, [model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z]);
                        render_pass.draw_water(water_plane, &camera_binding.bind_group, &water_plane.time_bind_group, &water_plane.landscape_bind_group, &water_plane.config_bind_group);
                    } else if let Some(sphere) = &player_character.sphere {
                        let player_pos = sphere.transform.position;
                        water_plane.update_uniforms(queue, time as f32, [player_pos.x, player_pos.y, player_pos.z]);
                        render_pass.draw_water(water_plane, &camera_binding.bind_group, &water_plane.time_bind_group, &water_plane.landscape_bind_group, &water_plane.config_bind_group);
                    }
                }
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

            // Render all terrain managers (for quadtree only)
            // for terrain_manager in &renderer_state.terrain_managers {
            //     terrain_manager.render(
            //         &mut render_pass,
            //         // &camera_binding.bind_group,
            //         &gpu_resources.queue,
            //     );
            // }

            // Drop the render pass before doing texture copies
            drop(render_pass);

            // obviously, no good reason to set this on every frame
            let mut point_lights_uniform_data = crate::core::editor::PointLightsUniform {
                point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS], // Initialize with zeros
                num_point_lights: renderer_state.point_lights.len() as u32,
                _padding: [0; 3],
            };

            for (i, pl) in renderer_state.point_lights.iter().enumerate() {
                // point_lights_uniform_data.point_lights[i] = *pl;
                 point_lights_uniform_data.point_lights[i] = [
                    pl.position[0], pl.position[1], pl.position[2],0.0,  // position + padding
                    pl.color[0], pl.color[1], pl.color[2],0.0, pl.intensity, pl.max_distance, // color + intensity
                     0.0, 0.0
                ];
            }
            
            // Update point lights buffer
            queue.write_buffer(
                self.point_lights_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(&[point_lights_uniform_data]),
            );

            // Lighting pass
            {
                let lighting_pipeline = self.lighting_pipeline.as_ref().unwrap();
                let lighting_bind_group = self.lighting_bind_group.as_ref().unwrap();
                let g_buffer_bind_group = self.g_buffer_bind_group.as_ref().unwrap();
                let shadow_pipeline_data = self.shadow_pipeline_data.as_ref().unwrap();
                let camera_binding = editor.camera_binding.as_ref().unwrap();
                let shadow_bind_group = &shadow_pipeline_data.shadow_bind_group;

                let mut lighting_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Lighting Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                lighting_pass.set_pipeline(lighting_pipeline);
                lighting_pass.set_bind_group(0, lighting_bind_group, &[]);
                lighting_pass.set_bind_group(1, g_buffer_bind_group, &[]);
                // lighting_pass.set_bind_group(2, window_size_bind_group, &[]);
                lighting_pass.set_bind_group(3, shadow_bind_group, &[]);
                // lighting_pass.set_bind_group(4, &camera_binding.bind_group, &[]);
                lighting_pass.set_bind_group(2, &camera_binding.bind_group, &[]);
                lighting_pass.draw(0..3, 0..1);
            }

            // Procedural Sky Render Pass
            {
                if let Some(procedural_sky_pipeline) = self.procedural_sky_pipeline.as_ref() {
                    if let Some(procedural_sky_bind_group) = self.procedural_sky_bind_group.as_ref() {
                        let mut sky_render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                            label: Some("Procedural Sky Pass"),
                            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                                view: &view,
                                resolve_target: None,
                                ops: wgpu::Operations {
                                    load: wgpu::LoadOp::Load, // Load existing color (from lighting pass)
                                    store: wgpu::StoreOp::Store,
                                },
                                depth_slice: None,
                            })],
                            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                                view: &depth_view, // Use the same depth view as geometry pass
                                depth_ops: Some(wgpu::Operations {
                                    load: wgpu::LoadOp::Load, // Load existing depth values
                                    store: wgpu::StoreOp::Store,
                                }),
                                stencil_ops: None,
                            }),
                            timestamp_writes: None,
                            occlusion_query_set: None,
                        });

                        sky_render_pass.set_pipeline(procedural_sky_pipeline);
                        sky_render_pass.set_bind_group(0, procedural_sky_bind_group, &[]);
                        sky_render_pass.draw(0..3, 0..1); // Draw the full-screen triangle
                    }
                }
            }

            
            renderer_state.gizmo.update_config(transform_gizmo::GizmoConfig {
                view_matrix: crate::core::SimpleCamera::to_row_major_f64(&camera.get_view()),
                projection_matrix: crate::core::SimpleCamera::to_row_major_f64(&camera.get_projection()),
                viewport: transform_gizmo::Rect {
                    min: (0.0, 0.0).into(),
                    max: (camera.viewport.window_size.width as f32, camera.viewport.window_size.height as f32).into(),
                },
                ..renderer_state.gizmo.config().clone()
            });


// DEBUG:
// let gizmo_draw_data = renderer_state.gizmo.draw();
// if !gizmo_draw_data.vertices.is_empty() {
    
// // let player_world_pos = DVec3::new(0.0, 0.0, 0.0); // or get from your transform

// // Manually calculate what screen position (0,0,0) should be at
// let viewx = DMat4::from(renderer_state.gizmo.config().view_matrix);
// let proj = DMat4::from(renderer_state.gizmo.config().projection_matrix);
// let vp = proj * viewx;

// // Project to clip space
// let clip = vp * DVec4::new(0.0, 0.0, 0.0, 1.0);
// let ndc = clip.xyz() / clip.w;

// // Convert to screen space (matching transform-gizmo's logic)
// let viewport = renderer_state.gizmo.config().viewport;
// let screen_x = (ndc.x + 1.0) * 0.5 * viewport.width() as f64;
// let screen_y = (1.0 - ndc.y) * 0.5 * viewport.height() as f64;

// println!("=== GIZMO POSITION DEBUG ===");
// println!("Player world position: (0, 0, 0)");
// println!("View matrix first row: {:?}", [viewx.x_axis.x, viewx.x_axis.y, viewx.x_axis.z, viewx.x_axis.w]);
// println!("Projection matrix first row: {:?}", [proj.x_axis.x, proj.x_axis.y, proj.x_axis.z, proj.x_axis.w]);
// println!("Clip space: {:?}", clip);
// println!("NDC: {:?}", ndc);
// println!("Screen position: ({:.1}, {:.1})", screen_x, screen_y);
// println!("Viewport: min=({:.1}, {:.1}), max=({:.1}, {:.1})", 
//     viewport.min.x, viewport.min.y, viewport.max.x, viewport.max.y);

//     println!("First gizmo vertex: ({:.1}, {:.1})", 
//         gizmo_draw_data.vertices[0][0], 
//         gizmo_draw_data.vertices[0][1]);
    
//     // Calculate center of all vertices to see where gizmo thinks it is
//     let mut sum_x = 0.0;
//     let mut sum_y = 0.0;
//     for v in &gizmo_draw_data.vertices {
//         sum_x += v[0];
//         sum_y += v[1];
//     }
//     let center_x = sum_x / gizmo_draw_data.vertices.len() as f32;
//     let center_y = sum_y / gizmo_draw_data.vertices.len() as f32;
//     println!("Gizmo vertex center: ({:.1}, {:.1})", center_x, center_y);
//     println!("===========================");
// }


            let gizmo_draw_data = renderer_state.gizmo.draw();
            if !game_mode && !gizmo_draw_data.vertices.is_empty() {
                // DEBUG: Print first few vertices and viewport info
                // println!("=== GIZMO DEBUG ===");
                // println!("Viewport: {:?}", renderer_state.gizmo.config().viewport);
                // println!("Window size: {}x{}", camera.viewport.window_size.width, camera.viewport.window_size.height);
                // println!("Vertex count: {}", gizmo_draw_data.vertices.len());
                // println!("First 5 vertices:");
                // for (i, v) in gizmo_draw_data.vertices.iter().take(5).enumerate() {
                //     println!("  [{}]: ({}, {})", i, v[0], v[1]);
                // }
                // println!("Index count: {}", gizmo_draw_data.indices.len());
                // println!("==================");

                // println!("Rendering gizmo");
                let gizmo_vertex_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Gizmo Vertex Buffer"),
                        contents: bytemuck::cast_slice(&gizmo_draw_data.vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    });

                let gizmo_color_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Gizmo Color Buffer"),
                        contents: bytemuck::cast_slice(&gizmo_draw_data.colors),
                        usage: wgpu::BufferUsages::VERTEX,
                    });

                let gizmo_index_buffer =
                    device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Gizmo Index Buffer"),
                        contents: bytemuck::cast_slice(&gizmo_draw_data.indices),
                        usage: wgpu::BufferUsages::INDEX,
                    });

                let mut gizmo_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Gizmo Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                gizmo_pass.set_pipeline(self.gizmo_pipeline.as_ref().unwrap());
                gizmo_pass.set_bind_group(0, window_size_bind_group, &[]);
                gizmo_pass.set_vertex_buffer(0, gizmo_vertex_buffer.slice(..));
                gizmo_pass.set_vertex_buffer(1, gizmo_color_buffer.slice(..));
                gizmo_pass.set_index_buffer(gizmo_index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                gizmo_pass.draw_indexed(0..gizmo_draw_data.indices.len() as u32, 0, 0..1);
            }

            // UI Render Pass
            {
                if let Some(ui_pipeline) = self.ui_pipeline.as_ref() {
                    let camera_binding = editor.camera_binding.as_ref().unwrap();
                    let window_size_bind_group = self
                        .window_size_bind_group
                        .as_ref()
                        .expect("Couldn't get window size bind group");

                    let mut ui_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("UI Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                            view: &depth_view,
                            depth_ops: Some(wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            }),
                            stencil_ops: None,
                        }),
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    ui_pipeline.render(
                        &mut ui_pass,
                        editor,
                        &camera_binding.bind_group,
                        window_size_bind_group,
                        queue,
                    );
                }
            }

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

    #[cfg(target_arch = "wasm32")]
    pub fn render_display_frame(&mut self, game_mode: bool) {}

    #[cfg(target_os = "windows")]
    pub fn render_display_frame(&mut self, gui: &mut Gui, window: &Window, game_mode: bool) {
        let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get GPU Resources").clone();
    
        let output = gpu_resources.surface.as_ref().unwrap()
            .get_current_texture()
            .expect("Failed to get current swap chain texture");
    
        let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());
    
        self.render_frame(Some(&view), 0.0, game_mode);
    
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
    
    #[cfg(target_os = "windows")]
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

                        // load_project(editor, project_id); // await needed?
                        pollster::block_on(load_project(editor, project_id));
                        // editor.rhai_engine.load_global_scripts(&editor.saved_state.as_ref().unwrap().global_rhai_scripts);
                    }
                }
            });
        }
    
        // scene controls
        // NOTE: not currently in use
        // egui::Window::new("Controls").show(ctx, |ui| {
        //     ui.label("Manage Scene");
    
        //     if ui.button("Add Cube").clicked() {
        //         // let editor = self.export_editor.as_mut().unwrap();
        //         let gpu_resources = self.gpu_resources.as_ref().unwrap();
        //         let device = &gpu_resources.device;
        //         let queue = &gpu_resources.queue;
        //         let model_bind_group_layout = editor.model_bind_group_layout.as_ref().unwrap();
        //         let group_bind_group_layout = editor.group_bind_group_layout.as_ref().unwrap();
        //         let camera = editor.camera.as_ref().expect("Couldn't get camera");
        //         let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
        //         let texture_render_mode_buffer = renderer_state.texture_render_mode_buffer.clone();
    
        //         let new_cube = Cube::new(device, queue, model_bind_group_layout, group_bind_group_layout, &texture_render_mode_buffer, camera);
        //         renderer_state.cubes.push(new_cube);
    
        //         println!("Cube added {:?}", renderer_state.cubes.len());
        //     }

        //     if ui.button("Add Trees").clicked() {
        //         // let editor = self.export_editor.as_mut().unwrap();
        //         let gpu_resources = self.gpu_resources.as_ref().unwrap();
        //         let device = &gpu_resources.device;
        //         let queue = &gpu_resources.queue;
        //         let camera_binding = editor.camera_binding.as_ref().unwrap();
        //         let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
    
        //         handle_add_trees(renderer_state, device, &queue, &camera_binding.bind_group_layout);
    
        //         println!("Trees added");
        //     }
    
        //     if ui.button("Add Landscape").clicked() {
        //         // let editor = self.export_editor.as_mut().unwrap();
        //         let gpu_resources = self.gpu_resources.as_ref().unwrap();
        //         let device = &gpu_resources.device;
        //         let queue = &gpu_resources.queue;
        //         let model_bind_group_layout = editor.model_bind_group_layout.as_ref().unwrap();
        //         let group_bind_group_layout = editor.group_bind_group_layout.as_ref().unwrap();
        //         let camera = editor.camera.as_mut().expect("Couldn't get camera");
        //         let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get renderer state");
    
        //         let mock_project_id = Uuid::new_v4().to_string();
                
        //         // handle_add_landscape(
        //         //     renderer_state, 
        //         //     device, 
        //         //     queue, 
        //         //     mock_project_id, 
        //         //     landscapeAssetId, 
        //         //     landscapeComponentId, 
        //         //     landscapeFilename, 
        //         //     [0.0, 0.0, 0.0], 
        //         //     camera
        //         // );
    
        //         // println!("Landscape added {:?}", editor.cubes.len());
        //     }
        // });
    
        // egui::Window::new("Asset Library").show(ctx, |ui| {
        //     // TODO: need to display textures and models (assets) available in the saved_data library
        // });

        egui::Window::new("Components").show(ctx, |ui| {
            if let Some(saved_state) = &mut editor.saved_state {
                if let Some(levels) = &mut saved_state.levels.clone() {
                    if let Some(components) = &mut levels[0].components {
                        for component in components {
                            ui.horizontal(|ui| {
                                ui.label(&component.generic_properties.name);
                                if ui.button("Select").clicked() {
                                    self.selected_component_id = Some(component.id.clone());

                                    // let mut new_cam_pos = None;
                                    // let component_pos = component.generic_properties.position;
                                    // new_cam_pos = Some(Point3::new(component_pos[0], component_pos[1] + 2.0, component_pos[2] - 5.0));

                                    // if let Some(pos) = new_cam_pos {
                                    //     if let Some(camera) = &mut editor.camera {
                                    //         camera.position = pos;
                                    //         let component_pos = component.generic_properties.position;
                                    //         let target = Point3::new(component_pos[0], component_pos[1], component_pos[2]);
                                    //         camera.direction = (target - camera.position).normalize();
                                    //         let cam_bind = editor.camera_binding.as_mut().expect("Couldn't get cam bind");
                                    //         let gpu = editor.gpu_resources.as_ref().expect("Couldn't get cam bind");
                                    //         cam_bind.update_3d(&gpu.queue, camera);
                                    //     }
                                    // }
                                }
                            });
                        }
                    }
                }
            }
        });
    
        if let Some(selected_component_id) = &self.selected_component_id {
            
            egui::Window::new("Properties").show(ctx, |ui| {
                if let Some(saved_state) = &mut editor.saved_state {
                    let project_id = saved_state.id.as_ref().expect("Couldn't get project id");
                    if let Some(levels) = &mut saved_state.levels {
                        if let Some(components) = &mut levels[0].components {
                            let light_components: Vec<_> = components.clone();
                            let light_components: Vec<_> = light_components.iter().filter(|c| matches!(c.kind, Some(ComponentKind::PointLight))).collect();
                            if let Some(component) = components.iter_mut().find(|c| &c.id == selected_component_id) {
                                match component.kind {
                                    Some(ComponentKind::Model) => {
                                        ui.label("Position");
                                        if ui.horizontal(|ui| {
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.position[0]).speed(0.1)).changed() ||
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.position[1]).speed(0.1)).changed() ||
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.position[2]).speed(0.1)).changed()
                                        }).inner {
                                            if let Some(renderer_state) = &mut editor.renderer_state {
                                                if let Some(model) = renderer_state.models.iter_mut().find(|m| &m.id == selected_component_id) {
                                                    for mesh in &mut model.meshes {
                                                        mesh.transform.update_position(component.generic_properties.position);
                                                    }
                                                }
                                            }
                                            utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                        }

                                        ui.label("Rotation");
                                        if ui.horizontal(|ui| {
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[0]).speed(0.1)).changed() ||
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[1]).speed(0.1)).changed() ||
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.rotation[2]).speed(0.1)).changed()
                                        }).inner {
                                            if let Some(renderer_state) = &mut editor.renderer_state {
                                                if let Some(model) = renderer_state.models.iter_mut().find(|m| &m.id == selected_component_id) {
                                                    for mesh in &mut model.meshes {
                                                        mesh.transform.update_rotation([component.generic_properties.rotation[0].to_radians(), component.generic_properties.rotation[1].to_radians(), component.generic_properties.rotation[2].to_radians()]);
                                                    }
                                                }
                                            }
                                            utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                        }
                                    },
                                    Some(ComponentKind::PointLight) => {
                                        // let components = components.clone();

                                        ui.label("Position");
                                        if ui.horizontal(|ui| {
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.position[0]).speed(0.1)).changed() ||
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.position[1]).speed(0.1)).changed() ||
                                            ui.add(egui::DragValue::new(&mut component.generic_properties.position[2]).speed(0.1)).changed()
                                        }).inner {
                                            if let Some(renderer_state) = &mut editor.renderer_state {
                                                
                                                if let Some(index) = light_components.iter().position(|c| &c.id == selected_component_id) {
                                                    if let Some(light) = renderer_state.point_lights.get_mut(index) {
                                                        light.position = component.generic_properties.position;
                                                    }
                                                }
                                            }
                                            utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                        }

                                        if let Some(light_props) = &mut component.light_properties {
                                            ui.label("Intensity");
                                            if ui.add(egui::DragValue::new(&mut light_props.intensity).speed(0.1)).changed() {
                                                if let Some(renderer_state) = &mut editor.renderer_state {
                                                    if let Some(index) = light_components.iter().position(|c| &c.id == selected_component_id) {
                                                        if let Some(light) = renderer_state.point_lights.get_mut(index) {
                                                            light.intensity = light_props.intensity;
                                                        }
                                                    }
                                                }
                                                utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                            }

                                            // ui.label("Color");
                                            // if ui.color_edit_button_rgba_premultiplied(&mut light_props.color).changed() {
                                            //     if let Some(renderer_state) = &mut editor.renderer_state {
                                            //         if let Some(index) = light_components.iter().position(|c| &c.id == selected_component_id) {
                                            //             if let Some(light) = renderer_state.point_lights.get_mut(index) {
                                            //                 light.color = [light_props.color[0], light_props.color[1], light_props.color[2]];
                                            //             }
                                            //         }
                                            //     }
                                            //     utilities::update_project_state_component(&project_id, component).expect("Failed to update project state");
                                            // }
                                        }
                                    },
                                    _ => {
                                        ui.label("This component type is not editable.");
                                    }
                                }
                            }
                        }
                    }
                }
            });

            
        }

        // self.chat.render(ctx);
    }
}
