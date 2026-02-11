use crate::core::egui_sidebar::{PipelineTabViewer, Tab, UiContext};
use crate::core::render_addon_frame::render_addon_frame;
use crate::core::render_egui::render_egui;
use crate::core::render_frame::render_frame;
use crate::core::skinned_pipeline::SkinnedPipeline;
use crate::core::chat::{Chat, ChatMessage, ChatSession, ToolCall};
use crate::game_behaviors::stateful::{BehaviorConfig, CombatType};
use crate::handlers::{handle_add_collectable, handle_add_npc, handle_add_water_plane};
use crate::helpers::landscapes::generate_landscape_data;
use crate::helpers::saved_data::{self, AttackStats, CollectableProperties, CollectableType, LightProperties, NPCProperties, AppExperience};
use crate::procedural_heightmaps::heightmap_generation::{FalloffType, FeatureType, HeightmapGenerator, TerrainFeature};
#[cfg(target_os = "windows")]
use crate::startup::Gui;
use crate::vector_animations::motion::Motion;
use crate::water_plane::config::WaterConfig;
use crate::{
    core::{Grid::{Grid, GridConfig}, RendererState::RendererState, SimpleCamera::SimpleCamera as Camera, Texture::pack_pbr_textures, camera::{self, CameraBinding}, editor::{
        Editor, PointLight, Viewport, WindowSize, WindowSizeShader
    }, gpu_resources::{self, GpuResources}, vertex::Vertex}, handlers::{EntropySize, handle_add_model}, heightfield_landscapes::Landscape::{PBRMaterialType, PBRTextureKind}, helpers::{landscapes::{read_landscape_heightmap_as_texture, read_texture_bytes}, saved_data::{ComponentData, GenericProperties, ComponentKind, LandscapeTextureKinds, LevelData, PBRTextureData, ProceduralSkyConfig, SavedState}, timelines::SavedTimelineStateConfig, utilities}, procedural_trees::trees::DrawTrees, vector_animations::animations::{Sequence, ObjectType}, video_export::frame_buffer::FrameCaptureBuffer, water_plane::water::DrawWater
};
use crate::core::Texture::Texture;
use crate::core::shadow_pipeline::ShadowPipelineData;
use crate::core::ui_pipeline::UiPipeline;
use crate::core::HealthBar::HealthBar;
use crate::core::editor::Point;
use std::{collections::HashMap, fs, sync::{Arc, Mutex}};
use egui::StrokeKind;
// use cgmath::{Point3, Vector3};
use nalgebra::{Isometry3, Point3, Translation3, UnitQuaternion, Vector3};
use transform_gizmo::{EnumSet, GizmoMode};
use transform_gizmo::math::{DMat4, DVec3, DVec4};
use uuid::Uuid;
use pollster; // For pollster::block_on
use transform_gizmo::math::Vec4Swizzles;
use serde::{Deserialize, Serialize};
use serde_json;

#[cfg(target_arch = "wasm32")]
use web_sys::HtmlCanvasElement;
use wgpu::{Limits, RenderPipeline, util::DeviceExt};
use bytemuck::{Pod, Zeroable}; // For procedural sky uniform

#[cfg(target_os = "windows")]
use winit::window::Window;

#[cfg(target_os = "windows")]
use egui;
use egui_dock::{DockArea, DockState, NodeIndex, Style, TabViewer};

#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_arch = "wasm32")]
use wasm_timer::Instant;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Workspace {
    GameEngine,
    Sophia,
    Stunts,
    CentralChat,
    Addon(String),
}

use crate::shape_primitives::Cube::Cube;
use crate::shape_primitives::Sphere::Sphere;
// use crate::helpers::load_project::load_project;
// use crate::deno::script_engine::{ComponentChanges, DenoEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::game_ui::hud::{Crosshair, AmmoDisplay};
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};

// use super::chat::Chat;

// Procedural Sky Uniform struct (Rust mirror of WGSL)
#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct ProceduralSkyUniform {
    pub horizon_color: [f32; 4],
    // _padding0: f32, // Pad to 16 bytes for alignment
    pub zenith_color: [f32; 4],
    // _padding1: f32,
    pub sun_direction: [f32; 4],
    // _padding2: f32,
    pub sun_color: [f32; 3],
    // _padding3: f32,
    pub sun_intensity: f32,
    // _padding4: [f32; 3], // Pad to 16 bytes
}

impl Default for ProceduralSkyUniform {
    fn default() -> Self {
        Self {
            horizon_color: [0.7, 0.8, 1.0, 1.0], // Light blue
            // _padding0: 0.0,
            zenith_color: [0.2, 0.3, 0.6, 1.0], // Darker blue
            // _padding1: 0.0,
            sun_direction: [0.0, 1.0, 0.0, 1.0], // Directly overhead
            // _padding2: 0.0,
            sun_color: [1.0, 0.9, 0.7],    // Warm yellow
            // _padding3: 0.0,
            sun_intensity: 5.0,
            // _padding4: [0.0; 3],
        }
    }
}

// Directional Light Uniform struct (Rust mirror of WGSL)
#[repr(C)]
#[derive(Debug, Copy, Clone, bytemuck::Pod, bytemuck::Zeroable)]
pub struct DirectionalLightUniform {
    pub position: [f32; 3],
    pub _padding: u32,
    pub color: [f32; 3],
    pub _padding2: u32,
}

pub struct EntropyPipeline {
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
    pub debug_sphere_pipeline: Option<RenderPipeline>,
    pub texture: Option<Arc<wgpu::Texture>>,
    pub view: Option<Arc<wgpu::TextureView>>,
    pub depth_view: Option<wgpu::TextureView>,
    // pub game_dock_state: DockState<Tab>,
    // pub sophia_dock_state: DockState<Tab>,
    // pub stunts_dock_state: DockState<Tab>,
    // // pub video_timeline_dock_state: DockState<Tab>,
    // pub central_chat_dock_state: DockState<Tab>,
    pub addon_dock_state: DockState<Tab>,
    pub addon_dock_states: HashMap<String, DockState<Tab>>,
    pub video_timeline_ui: crate::core::video_timeline_ui::VideoTimeline,
    pub video_total_duration_ms: i32,
    pub current_workspace: Workspace,
    pub show_central_chat_overlay: bool,
    pub show_addon_manager: bool,
    pub window_size_bind_group: Option<wgpu::BindGroup>,
    pub export_editor: Option<Editor>,
    pub frame_buffer: Option<FrameCaptureBuffer>,
    pub chat: Chat,
    pub new_project_name: String,
    pub projects: Vec<(String, String)>,
    pub command_bar_input: String,
    pub command_bar_project_id: Option<String>,

    pub start_time: Instant,

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

    pub vector_motion: Motion,
}

impl EntropyPipeline {
    pub fn new() -> Self {
        // let mut dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects]);
        // let surface = dock_state.main_surface_mut();
        // let [_, _] = surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Components, Tab::AssetLibrary]);
        // let [_, _] = surface.split_below(NodeIndex::root(), 0.7, vec![Tab::Properties, Tab::Chat]);

        // let game_dock_state = dock_state.clone();
        
        // let mut sophia_dock_state = DockState::new(vec![Tab::Writing, Tab::Projects]);
        // let sophia_surface = sophia_dock_state.main_surface_mut();
        // sophia_surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Chat, Tab::Research, Tab::Publish, Tab::Grammar, Tab::Manage, Tab::Citations]);

        // // let stunts_dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects, Tab::Properties, Tab::Chat, Tab::AssetLibrary]);
        // // let video_timeline_dock_state = DockState::new(vec![Tab::VideoTimeline]);

        // let mut stunts_dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects]);
        // let surface2 = stunts_dock_state.main_surface_mut();
        // let [_, _] = surface2.split_right(NodeIndex::root(), 0.7, vec![Tab::Animations, Tab::Properties, Tab::Chat]);
        // let [_, _] = surface2.split_below(NodeIndex::root(), 0.7, vec![Tab::VideoTimeline]);

        // let central_chat_dock_state = DockState::new(vec![Tab::Chat]);

        // let addon_dock_state = DockState::new(vec![Tab::Viewport, Tab::Addons]);

        let mut addon_dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects]);
        let surface3 = addon_dock_state.main_surface_mut();
        let [_, _] = surface3.split_right(NodeIndex::root(), 0.7, vec![Tab::Chat]);

        EntropyPipeline {
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
            // game_dock_state,
            // sophia_dock_state,
            // stunts_dock_state,
            // // video_timeline_dock_state,
            // central_chat_dock_state,
            addon_dock_state,
            addon_dock_states: HashMap::new(),
            video_timeline_ui: crate::core::video_timeline_ui::VideoTimeline::new(),
            video_total_duration_ms: 0,
            current_workspace: Workspace::GameEngine,
            show_central_chat_overlay: false,
            show_addon_manager: false,
            window_size_bind_group: None,
            export_editor: None,
            frame_buffer: None,
            chat: Chat::new(),
            new_project_name: String::new(),
            projects: Vec::new(),
            command_bar_input: String::new(),
            command_bar_project_id: None,
            
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
            debug_sphere_pipeline: None,
            directional_light_position: [2.0, 2.0, 2.0],
            selected_component_id: None,

            vector_motion: Motion::new()
        }
    }

    pub async fn initialize(
        &mut self,
        
        #[cfg(target_os = "windows")]
        window: Option<&Window>,

        #[cfg(target_arch = "wasm32")]
        canvas: Option<HtmlCanvasElement>,

        window_size: WindowSize,
        video_total_duration_ms: i32,
        video_width: u32,
        video_height: u32,
        project_id: Option<String>,
        game_mode: bool,
        is_playing: bool,
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
                        max_bind_groups: 8, // bad for wasm :(
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
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    // Render mode
                    wgpu::BindGroupLayoutEntry {
                        binding: 3,
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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
                        visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
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

        let ui_model_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                entries: &[
                    // Uniform buffer binding
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
                    // Texture binding (D2)
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                            view_dimension: wgpu::TextureViewDimension::D2,
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
                ],
                label: Some("UI Model Bind Group Layout"),
            });

        let ui_model_bind_group_layout = Arc::new(ui_model_bind_group_layout);

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

        let window_size_bind_group_layout = Arc::new(window_size_bind_group_layout);

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
            &ui_model_bind_group_layout,
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
            .world_state
            .as_ref()
            .and_then(|state| state.levels.as_ref())
            .and_then(|levels| levels.get(0)) // Assuming we always work with the first level
            .and_then(|level| level.procedural_sky.clone())
            .unwrap_or_default(); // Get from saved_data, or use defaults

        let horizon_color = procedural_sky_config_from_level.horizon_color;
        let zenith_color = procedural_sky_config_from_level.zenith_color;
        let sun_direction = procedural_sky_config_from_level.sun_direction;

        let procedural_sky_uniform_data = ProceduralSkyUniform {
            horizon_color: [horizon_color[0], horizon_color[1], horizon_color[2], 1.0],
            zenith_color: [zenith_color[0], zenith_color[1], zenith_color[2], 1.0],
            sun_direction: [sun_direction[0], sun_direction[1], sun_direction[2], 1.0],
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

        let shader_module_debug_sphere =
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some("Debug Sphere Shader"),
                source: wgpu::ShaderSource::Wgsl(include_str!("shaders/debug_sphere.wgsl").into()),
            });

        let debug_sphere_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("Debug Sphere Pipeline Layout"),
            bind_group_layouts: &[
                &camera_binding.bind_group_layout,
                &model_bind_group_layout,
            ],
            push_constant_ranges: &[],
        });

        let debug_sphere_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Debug Sphere Pipeline"),
            layout: Some(&debug_sphere_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader_module_debug_sphere,
                entry_point: Some("vs_main"),
                buffers: &[Vertex::desc()],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader_module_debug_sphere,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: swapchain_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::LineList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: wgpu::TextureFormat::Depth24Plus,
                depth_write_enabled: false,
                depth_compare: wgpu::CompareFunction::LessEqual,
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
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

        // let scattered_model_pipeline = crate::core::scattered_model_pipeline::ScatteredModelPipeline::new(
        //     &device,
        //     &camera_binding.bind_group_layout,
        //     &model_bind_group_layout,
        //     &window_size_bind_group_layout,
        //     &group_bind_group_layout,
        //     wgpu::TextureFormat::Depth24Plus,
        // );

        // println!("Grid Restored!");

        let mut renderer_state = RendererState::new(
            &device, 
            &queue, 
            model_bind_group_layout.clone(), 
            group_bind_group_layout.clone(), 
            ui_model_bind_group_layout.clone(),
            &camera,
            texture_render_mode_buffer.clone(),
            color_render_mode_buffer,
            regular_texture_render_mode_buffer,
            game_mode,
            skinned_pipeline,
            // scattered_model_pipeline,
        );

        // if game_mode {
            export_editor.health_bar = Some(HealthBar::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &camera.viewport.window_size,
                Point { x: 150.0, y: 50.0 }, // Top-left area
                200.0,
                30.0,
                100.0,
            ));

            export_editor.enemy_health_bar = Some(HealthBar::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &camera.viewport.window_size,
                Point { x: video_width as f32 - 150.0, y: 50.0 }, // Top-right area
                200.0,
                30.0,
                100.0,
            ));

            export_editor.crosshair = Some(Crosshair::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &camera.viewport.window_size,
            ));

            // Load Basic font for AmmoDisplay
            let font_bytes = export_editor.font_manager.get_font_by_name("Basic")
                .unwrap_or_else(|| &export_editor.font_manager.font_data[0].1);

            export_editor.ammo_display = Some(AmmoDisplay::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &camera.viewport.window_size,
                font_bytes,
            ));
        // }

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
        if let Some(rs) = &mut export_editor.renderer_state {
            rs.gpu_resources = Some(gpu_resources.clone());
        }
        
        export_editor.addon_engine.set_resources(
            gpu_resources.clone(),
            vec![
                camera_binding.bind_group_layout.clone(), // 0
                model_bind_group_layout.clone(), // 1
                window_size_bind_group_layout.clone(), // 2
                group_bind_group_layout.clone(), // 3
            ],
            vec![
                Arc::new(lighting_bind_group_layout.clone()), // 0
                Arc::new(g_buffer_bind_group_layout.clone()), // 1
                camera_binding.bind_group_layout.clone(), // 2
                Arc::new(shadow_pipeline_data.shadow_bind_group_layout.clone()), // 3
            ],
            swapchain_format,
        );

        // let gpu_resources = export_editor
        //     .gpu_resources
        //     .as_ref()
        //     .expect("Couldn't get gpu resources");

        println!("EntropyPipeline initialized!");
        
        // begin playback
        export_editor.camera = Some(camera);

        // #[cfg(target_os = "windows")]
        let now = Instant::now();
        
        // #[cfg(target_arch = "wasm32")]
        // let now = js_sys::Date::now() - self.start_time;
        
        export_editor.video_start_playing_time = Some(now.clone());

        export_editor.video_total_duration_ms = video_total_duration_ms;

        export_editor.video_is_playing = is_playing;

        // also set motion path playing
        export_editor.start_playing_time = Some(now);
        export_editor.is_playing = is_playing;
        export_editor.ui_model_bind_group_layout = Some(ui_model_bind_group_layout);
        

        export_editor.camera_binding = Some(camera_binding);

        export_editor.addon_engine.load_default_bundle();

        // self.device = Some(device);
        // self.queue = Some(queue);
        

        self.gizmo_pipeline = Some(gizmo_pipeline);

        self.gpu_resources = export_editor.gpu_resources.clone();
        self.geometry_pipeline = Some(geometry_pipeline);
        self.lighting_pipeline = Some(lighting_pipeline);
        self.procedural_sky_pipeline = Some(procedural_sky_pipeline);
        self.procedural_sky_bind_group = Some(procedural_sky_bind_group);
        self.procedural_sky_uniform_buffer = Some(procedural_sky_uniform_buffer);
        self.debug_sphere_pipeline = Some(debug_sphere_pipeline);
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
                // if editor.viewport_tab_rect.is_none() {
                    if let Some(camera) = editor.camera.as_mut() {
                        // camera.aspect = new_size.width as f32 / new_size.height as f32;
                        camera.aspect_ratio = new_size.width as f32 / new_size.height as f32;
                        camera.viewport.width = new_size.width as f32;
                        camera.viewport.height = new_size.height as f32;
                        camera.viewport.window_size.width = new_size.width;
                        camera.viewport.window_size.height = new_size.height;
                    }
                // }
            }

            // resize ui elements
            let editor = self.export_editor.as_mut().expect("Couldn't get editor");
            let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get editor");
            // if editor.viewport_tab_rect.is_none() {
                let window_size = WindowSize { width: new_size.width, height: new_size.height };

                if let Some(enemy_health_bar) = &mut editor.enemy_health_bar {
                    enemy_health_bar.bar.transform.update_position([new_size.width as f32 - 150.0, 50.0, 0.0]);
                    enemy_health_bar.background.transform.update_position([new_size.width as f32 - 150.0, 50.0, 0.0]);
                }

                if let Some(crosshair) = &mut editor.crosshair {
                    crosshair.resize(&gpu_resources.queue, &window_size);
                }

                if let Some(ammo_display) = &mut editor.ammo_display {
                    ammo_display.resize(&gpu_resources.queue, &window_size);
                }

                if let Some(mini_map) = &mut editor.mini_map {
                    mini_map.resize(&gpu_resources.queue, &window_size);
                }
            // }
        }
    }

    pub fn render_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64, game_mode: bool, viewport_rect: Option<[f32; 4]>) {
        render_frame(self, target_view, current_time, game_mode, viewport_rect);
    }

    pub fn render_addon_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64, viewport_rect: Option<[f32; 4]>) {
        render_addon_frame(self, target_view, current_time, viewport_rect);
    }

    pub fn render_stunts_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64, is_exporting: bool, viewport_rect: Option<[f32; 4]>) {
        let editor = self.export_editor.as_mut().expect("Couldn't get editor");

        let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get GPU Resources").clone();
        let device = &gpu_resources.device;
        let queue = &gpu_resources.queue;

        // Update video frames and animations if playing
        if editor.video_is_playing {
            self.vector_motion.step_motion_path_animations(editor, Some(current_time));
        }

        if let Some(view) = target_view {
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Stunts Render Encoder"),
            });

            {
                let mut rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Stunts Render Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            // load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.85, g: 0.05, b: 0.05, a: 1.0 }),
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                        view: self.depth_view.as_ref().expect("No depth view"),
                        depth_ops: Some(wgpu::Operations {
                            load: wgpu::LoadOp::Clear(1.0),
                            store: wgpu::StoreOp::Store,
                        }),
                        stencil_ops: None,
                    }),
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                if let Some(rect) = viewport_rect {
                    // rpass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                    rpass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                }
                
                if let Some(ui_pipeline) = &self.ui_pipeline {
                    let camera_binding = editor.camera_binding.as_ref().expect("No camera binding");
                    let window_size_bind_group = self.window_size_bind_group.as_ref().expect("No window size bind group");

                    ui_pipeline.render_stunts(
                        &mut rpass,
                        editor,
                        &camera_binding.bind_group,
                        window_size_bind_group,
                        queue,
                        editor.video_current_time_ms,
                    );
                }
            }

            let command_buffer = encoder.finish();
            queue.submit(std::iter::once(command_buffer));
        }
    }

    #[cfg(target_arch = "wasm32")]
    pub fn render_display_frame(&mut self, game_mode: bool) {}

    #[cfg(target_os = "windows")]
    pub fn render_display_frame(&mut self, gui: &mut Gui, window: &Window, game_mode: bool) {
        let now = std::time::Instant::now();
        if let Some(editor) = &mut self.export_editor {
            let delta = if let Some(last) = editor.last_frame_time {
                now.duration_since(last).as_millis() as i32
            } else {
                0
            };
            editor.last_frame_time = Some(now);

            if editor.video_is_playing {
                editor.video_current_time_ms += delta;
                if editor.video_current_time_ms > editor.video_total_duration_ms {
                    editor.video_current_time_ms = 0; // Loop or stop
                }
            }
        }

        let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get GPU Resources").clone();
    
        let output = gpu_resources.surface.as_ref().unwrap()
            .get_current_texture()
            .expect("Failed to get current swap chain texture");
    
        let view = output.texture.create_view(&wgpu::TextureViewDescriptor::default());

        // let scale_factor = window.scale_factor() as f32;
        // let scale_factor = gui.ctx.pixels_per_point();
        // println!("pixels_per_point {:?}", scale_factor);
        let scale_factor = 1.0;
        
        if !game_mode {
            let mut encoder = gpu_resources.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("egui encoder"),
            });
            
            if let Some(editor) = &mut self.export_editor {
                editor.wry_webview_bounds = None;
                editor.viewport_tab_rect = None;
                editor.is_viewport_visible = false;
            }

            let raw_input = gui.state.take_egui_input(&window);
            let egui_ctx = gui.ctx.clone();
            let full_output = egui_ctx.run(raw_input, |ctx| {
                self.ui(gui);
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

        let viewport_rect = if let Some(editor) = &self.export_editor {
            editor.viewport_tab_rect.map(|r| [
                r[0] * scale_factor,
                r[1] * scale_factor,
                r[2] * scale_factor,
                r[3] * scale_factor,
            ])
        } else {
            None
        };

        let is_viewport_visible = self.export_editor.as_ref().map(|e| e.is_viewport_visible).unwrap_or(true);
        let current_time = self.start_time.elapsed().as_secs_f64();

        if is_viewport_visible || game_mode {
            if self.current_workspace == Workspace::GameEngine {
                self.render_frame(Some(&view), current_time, game_mode, viewport_rect);
            } else if self.current_workspace == Workspace::Stunts {
                let current_time_s = self.export_editor.as_ref()
                    .map(|e| e.video_current_time_ms as f64 / 1000.0)
                    .unwrap_or(0.0);
                self.render_stunts_frame(Some(&view), current_time_s, false, viewport_rect);
            } else if self.current_workspace == Workspace::Sophia || self.current_workspace == Workspace::CentralChat {
                // render nothing
            } else { // Addons
                self.render_addon_frame(Some(&view), current_time, viewport_rect);
            }
        }

        output.present();
    }
    
    fn ui(&mut self, gui: &mut Gui) {
        render_egui(self, gui);
    }
}
