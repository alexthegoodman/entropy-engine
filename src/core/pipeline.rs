use crate::core::egui_sidebar::{PipelineTabViewer, Tab, UiContext};
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
use crate::deno::script_engine::{ComponentChanges, DenoEngine};
use crate::game_ui::dialogue_ui;
use crate::game_ui::quest_ui;
use crate::game_ui::hud::{Crosshair, AmmoDisplay};
use crate::procedural_particles::particle_system::{ParticleSystem, ParticleUniforms};

// use super::chat::Chat;

// Procedural Sky Uniform struct (Rust mirror of WGSL)
#[repr(C)]
#[derive(Debug, Copy, Clone, Pod, Zeroable)]
pub struct ProceduralSkyUniform {
    horizon_color: [f32; 4],
    // _padding0: f32, // Pad to 16 bytes for alignment
    zenith_color: [f32; 4],
    // _padding1: f32,
    sun_direction: [f32; 4],
    // _padding2: f32,
    sun_color: [f32; 3],
    // _padding3: f32,
    sun_intensity: f32,
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
    pub game_dock_state: DockState<Tab>,
    pub sophia_dock_state: DockState<Tab>,
    pub stunts_dock_state: DockState<Tab>,
    // pub video_timeline_dock_state: DockState<Tab>,
    pub central_chat_dock_state: DockState<Tab>,
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
    new_project_name: String,
    projects: Vec<(String, String)>,
    pub command_bar_input: String,
    pub command_bar_project_id: Option<String>,

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

    pub vector_motion: Motion,
}

impl EntropyPipeline {
    pub fn new() -> Self {
        let mut dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects]);
        let surface = dock_state.main_surface_mut();
        let [_, _] = surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Components, Tab::AssetLibrary]);
        let [_, _] = surface.split_below(NodeIndex::root(), 0.7, vec![Tab::Properties, Tab::Chat]);

        let game_dock_state = dock_state.clone();
        
        let mut sophia_dock_state = DockState::new(vec![Tab::Writing, Tab::Projects]);
        let sophia_surface = sophia_dock_state.main_surface_mut();
        sophia_surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Chat, Tab::Research, Tab::Publish, Tab::Grammar, Tab::Manage, Tab::Citations]);

        // let stunts_dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects, Tab::Properties, Tab::Chat, Tab::AssetLibrary]);
        // let video_timeline_dock_state = DockState::new(vec![Tab::VideoTimeline]);

        let mut stunts_dock_state = DockState::new(vec![Tab::Viewport, Tab::Projects]);
        let surface2 = stunts_dock_state.main_surface_mut();
        let [_, _] = surface2.split_right(NodeIndex::root(), 0.7, vec![Tab::Animations, Tab::Properties, Tab::Chat]);
        let [_, _] = surface2.split_below(NodeIndex::root(), 0.7, vec![Tab::VideoTimeline]);

        let central_chat_dock_state = DockState::new(vec![Tab::Chat]);

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
            game_dock_state,
            sophia_dock_state,
            stunts_dock_state,
            // video_timeline_dock_state,
            central_chat_dock_state,
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
        project_id: String,
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
                        max_bind_groups: 6, // bad for wasm :(
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

        let scattered_model_pipeline = crate::core::scattered_model_pipeline::ScatteredModelPipeline::new(
            &device,
            &camera_binding.bind_group_layout,
            &model_bind_group_layout,
            &window_size_bind_group_layout,
            &group_bind_group_layout,
            wgpu::TextureFormat::Depth24Plus,
        );

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
            skinned_pipeline,
            scattered_model_pipeline,
        );

        if game_mode {
            export_editor.health_bar = Some(HealthBar::new(
                &device,
                &queue,
                &ui_model_bind_group_layout,
                &group_bind_group_layout,
                &camera,
                &WindowSize { width: video_width, height: video_height },
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
                &WindowSize { width: video_width, height: video_height },
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
                &WindowSize { width: video_width, height: video_height },
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
                &WindowSize { width: video_width, height: video_height },
                font_bytes,
            ));
        }

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
        let editor = self.export_editor.as_mut().expect("Couldn't get editor");
        let renderer_state = editor.renderer_state.as_mut().expect("Couldn't get RendererState");
        
        // Process pending loot drops
        if !renderer_state.pending_loot_drops.is_empty() {
            let loot_drops: Vec<_> = renderer_state.pending_loot_drops.drain(..).collect();
            let gpu_resources = self.gpu_resources.as_ref().expect("Couldn't get gpu resources");
            let project_id = editor.project_id.clone();
            let camera = editor.camera.as_ref().expect("Couldn't get camera").clone();

            for (pos, item) in loot_drops {
                let mut item_comp = item.clone();
                // Ensure unique ID for the world instance
                item_comp.id = Uuid::new_v4().to_string();
                
                let isometry = Isometry3::translation(pos.x, pos.y, pos.z);
                let scale = Vector3::new(
                    item.generic_properties.scale[0],
                    item.generic_properties.scale[1],
                    item.generic_properties.scale[2]
                );

                // Find related stat
                let dummy_stat = crate::helpers::saved_data::StatData::default();
                let stat_id = item.collectable_properties.as_ref().and_then(|p| p.stat_id.clone());
                let related_stat = if let Some(sid) = stat_id {
                    editor.world_state.as_ref()
                        .and_then(|s| s.stats.as_ref())
                        .and_then(|stats| stats.iter().find(|s| s.id == sid))
                        .unwrap_or(&dummy_stat)
                } else {
                    &dummy_stat
                };

                pollster::block_on(crate::handlers::handle_add_collectable(
                    renderer_state,
                    &gpu_resources.device,
                    &gpu_resources.queue,
                    project_id.clone(),
                    item.asset_id.clone(),
                    item_comp.id.clone(),
                    item.asset_id.clone(), // filename assumed to be asset_id for now if not specified? 
                    // Actually handle_add_collectable uses modelFilename. 
                    // Let's assume asset_id is the filename if modelFilename not in ComponentData
                    // item.asset_id.clone(),
                    isometry,
                    scale,
                    &camera,
                    item.collectable_properties.as_ref().expect("No collectable properties"),
                    related_stat,
                    false, // hide_in_world
                    item.script_state.clone()
                ));
            }
        }

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

        // if let Some(rect) = viewport_rect {
        //     camera.aspect_ratio = rect[2] / rect[3];
        //     camera.viewport.width = rect[2];
        //     camera.viewport.height = rect[3];
        //     camera.viewport.window_size.width = rect[2] as u32;
        //     camera.viewport.window_size.height = rect[3] as u32;
        //     camera.update();
        //     camera_binding.update_3d(queue, camera);
        // }

        let window_size_bind_group = self
            .window_size_bind_group
            .as_ref()
            .expect("Couldn't get window size bind group");
        // let camera = self.camera.as_ref().expect("Couldn't get camera"); // careful, we have a camera on editor and on self
        let texture = self.texture.as_ref().expect("Couldn't get texture");
        
        // Sync player health to UI
        if let Some(player) = &mut renderer_state.player_character {
            if let Some(health_bar) = &mut editor.health_bar {
                health_bar.update_health(queue, player.stats.health);
            }

            // Update Aim
            player.update_aim(0.016);
            let target_fov = camera.base_fovy * (1.0 - (player.aim_factor * 0.4)); // 40% zoom
            camera.fovy = target_fov;
            // camera.update_view_projection_matrix(); // Called in step_physics_pipeline or later? 
            // Better call it here to be safe, but update() is called in step_physics_pipeline?
            // step_physics_pipeline calls camera.update()
            
            // Update Ammo UI
            if let Some(ammo_display) = &mut editor.ammo_display {
                 let mut ammo = None;
                 let mut max = None;
                 if let Some(weapon) = &player.inventory.equipped_weapon {
                     if let Some(props) = &weapon.collectable_properties {
                         ammo = props.ammo;
                         max = props.max_ammo;
                     }
                 }
                 
                 ammo_display.update(device, queue, ammo, max);
            }

            if let Some(mini_map) = &mut editor.mini_map {
                if let Some(rb_handle) = player.movement_rigid_body_handle {
                     if let Some(rb) = renderer_state.rigid_body_set.get(rb_handle) {
                        let position = rb.translation();
                        let yaw = renderer_state.camera_yaw;
                        let landscape_center = Vector3::new(0.0, 0.0, 0.0);
                        let landscape_size = 4096.0; // Matches grid size for now

                        mini_map.update_all(queue, *position, yaw, landscape_center, landscape_size, &renderer_state.npcs, &renderer_state.collectables, &renderer_state.rigid_body_set, camera);
                     }
                }
            }

            // Handle Firing
            if player.is_firing {
                let mut fire_type = saved_data::FireType::Manual;
                if let Some(weapon) = &player.inventory.equipped_weapon {
                    if let Some(props) = &weapon.collectable_properties {
                        if let Some(ft) = &props.fire_type {
                            fire_type = ft.clone();
                        }
                    }
                }

                let mut should_attack = false;
                match fire_type {
                    saved_data::FireType::Automatic => {
                        should_attack = true;
                    }
                    saved_data::FireType::SemiAutomatic | saved_data::FireType::Manual => {
                        if !player.has_fired_this_press {
                            should_attack = true;
                            player.has_fired_this_press = true;
                        }
                    }
                }

                if should_attack {
                    let (attacked_npc_id, debug_line) = player.attack(
                        &renderer_state.rigid_body_set,
                        &renderer_state.collider_set,
                        &mut renderer_state.query_pipeline,
                        &mut renderer_state.npcs,
                        camera,
                    );
                    
                    if let Some(id) = attacked_npc_id {
                        editor.current_enemy_target = Some(id.clone());
                        println!("Updated enemy target: {:?}", id);

                        // Alert nearby NPCs when one is hit
                        if let Some(npc) = renderer_state.npcs.iter().find(|n| n.id == id) {
                            if let Some(rb) = renderer_state.rigid_body_set.get(npc.rigid_body_handle) {
                                let alert_pos = rb.translation();
                                let alert_pos = Vector3::new(alert_pos.x, alert_pos.y, alert_pos.z);

                                renderer_state.alert_nearby_npcs(alert_pos, 40.0); // Slightly larger radius for being hit
                            }
                        }
                    }

                    // Execute Rhai on_attack scripts for the player
                    let mut script_changes = Vec::new();
                    if let Some(world_state) = &editor.world_state {
                        if let Some(levels) = &world_state.levels {
                            if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                                for component in components.iter() {
                                    if component.kind == Some(ComponentKind::PlayerCharacter) {
                                        if let Some(script_path) = &component.js_script_path {
                                            if let Some(change) = editor.deno_engine.execute_component_script(
                                                renderer_state,
                                                component,
                                                script_path,
                                                "on_attack",
                                            ) {
                                                script_changes.push(change);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Handle particle spawns from on_attack
                    for change in script_changes {
                        if let Some(spawns) = change.particle_spawns {
                            let gpu_resources = editor.gpu_resources.as_ref().expect("GPU resources missing");
                            for spawn in spawns {
                                if let Some((start, end)) = debug_line {
                                    let uniforms = ParticleUniforms {
                                        position: [spawn.position.x, spawn.position.y, spawn.position.z, 0.0],
                                        time: 0.0,
                                        emission_rate: spawn.emission_rate,
                                        life_time: spawn.life_time,
                                        radius: spawn.radius,
                                        gravity: [spawn.gravity.x, spawn.gravity.y, spawn.gravity.z, 0.0],
                                        initial_speed_min: spawn.initial_speed_min,
                                        initial_speed_max: spawn.initial_speed_max,
                                        start_color: spawn.start_color,
                                        end_color: spawn.end_color,
                                        size: spawn.size,
                                        mode: spawn.mode,
                                        target_position: [end.x, end.y, end.z, 0.0],
                                        _pad2: [0.0; 4],
                                    };
                                    
                                    let system = ParticleSystem::new(
                                        &gpu_resources.device,
                                        &camera_binding.bind_group_layout,
                                        uniforms,
                                        500,
                                        wgpu::TextureFormat::Rgba8Unorm,
                                    );
                                    
                                    renderer_state.particle_systems.push(system);
                                }
                            }
                        }
                    }

                    // Handle debug hitscan line
                    if renderer_state.game_settings.show_hitscan_line {
                        if let Some((start, end)) = debug_line {
                            let gpu_resources = editor.gpu_resources.as_ref().expect("GPU resources missing");
                            let mut debug_cube = Cube::new(
                                &gpu_resources.device,
                                &gpu_resources.queue,
                                &renderer_state.model_bind_group_layout,
                                &renderer_state.group_bind_group_layout,
                                &renderer_state.texture_render_mode_buffer,
                                camera,
                            );

                            let dir = (end - start).normalize();
                            let offset_start = start + dir * 0.5;
                            let length = nalgebra::distance(&offset_start, &end);
                            
                            if length > 0.0 && (end - start).dot(&dir) > 0.5 {
                                let scale = 0.02;
                                let rotation = UnitQuaternion::rotation_between(&Vector3::z(), &dir).unwrap_or_default();
                                let center_offset = rotation * Vector3::new(scale * 0.5, scale * 0.5, 0.0);
                                let draw_pos = offset_start - center_offset;

                                debug_cube.transform.update_position([draw_pos.x, draw_pos.y, draw_pos.z]);
                                debug_cube.transform.update_scale([scale, scale, length]);
                                debug_cube.transform.update_rotation_quat([
                                    rotation.coords.x,
                                    rotation.coords.y,
                                    rotation.coords.z,
                                    rotation.coords.w,
                                ]);
                                
                                debug_cube.transform.update_uniform_buffer(&gpu_resources.queue);
                                
                                renderer_state.debug_rays.push(crate::core::RendererState::DebugRay {
                                    cube: debug_cube,
                                    expires_at: Instant::now() + Duration::from_millis(500),
                                });
                            }
                        }
                    }
                }
            } else {
                player.has_fired_this_press = false;
            }
        }

        // Sync enemy health to UI
        if let Some(target_id) = &editor.current_enemy_target {
            if let Some(npc) = renderer_state.npcs.iter().find(|n| &n.id == target_id) {
                 if let Some(health_bar) = &mut editor.enemy_health_bar {
                    health_bar.update_health(queue, npc.stats.health);
                }
            }
        }

        // editor.addon_engine.update(renderer_state, camera);

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            // Update procedural sky uniform buffer if config is present
            let current_procedural_sky_config = editor
                .world_state
                .as_ref()
                .and_then(|state| state.levels.as_ref())
                .and_then(|levels| levels.get(0))
                .and_then(|level| level.procedural_sky.clone());

            if let Some(config) = current_procedural_sky_config {
                let horizon_color = config.horizon_color;
                let zenith_color = config.zenith_color;
                let sun_direction = config.sun_direction;

                let procedural_sky_uniform_data = ProceduralSkyUniform {
                    horizon_color: [horizon_color[0], horizon_color[1], horizon_color[2], 1.0],
                    zenith_color: [zenith_color[0], zenith_color[1], zenith_color[2], 1.0],
                    sun_direction: [sun_direction[0], sun_direction[1], sun_direction[2], 1.0],
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

            // Execute JS component scripts
            let mut changes: Vec<ComponentChanges> = Vec::new();
            if let Some(world_state) = editor.world_state.as_ref() {
                if let Some(levels) = world_state.levels.as_ref() {
                    if let Some(components) = levels.get(0).and_then(|l| l.components.as_ref()) {
                        for component in components.iter() {
                            if let Some(script_path) = &component.js_script_path {
                                if let Some(change) = editor.deno_engine.execute_component_script(
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

            let time = self.start_time.elapsed().as_secs_f32();
            if !renderer_state.particle_systems.is_empty() {
                renderer_state.particle_systems.retain_mut(|system| system.update(queue, time));
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

            if let Some(rect) = viewport_rect {
                // render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            render_pass.set_pipeline(&geometry_pipeline);

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

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

            // draw spheres
            for sphere in &renderer_state.spheres {
                sphere.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &sphere.bind_group, &[]);
                render_pass.set_bind_group(3, &sphere.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    sphere.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..sphere.index_count as u32, 0, 0..1);
            }

            // draw debug rays
            for debug_ray in &renderer_state.debug_rays {
                // println!("display debug line");
                debug_ray.cube.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &debug_ray.cube.bind_group, &[]);
                render_pass.set_bind_group(3, &debug_ray.cube.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, debug_ray.cube.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    debug_ray.cube.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..debug_ray.cube.index_count as u32, 0, 0..1);
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
                    mesh.transform.update_uniform_buffer(&gpu_resources.queue);

                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]); // Camera
                    render_pass.set_bind_group(1, &mesh.bind_group, &[]); // Model transform + textures
                    // render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

                    // Need to use the regular vertex buffer with regular Vertex if using geometry pipeline
                    render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                    render_pass.set_index_buffer(
                        mesh.index_buffer.slice(..),
                        wgpu::IndexFormat::Uint32,
                    );
                    render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..1);
                }
            }

            // Render Scattered Models
            if let Some(pipeline) = &renderer_state.scattered_model_pipeline {
                render_pass.set_pipeline(&pipeline.render_pipeline);
                
                // Calculate player position for uniforms
                let player_pos = if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                            renderer_state.models.iter().find(|m| m.id == model_id.clone())
                            .and_then(|m| m.meshes.get(0))
                            .map(|mesh| [mesh.transform.position.x, mesh.transform.position.y, mesh.transform.position.z])
                            .unwrap_or([camera.position.x, camera.position.y, camera.position.z])
                    } else if let Some(sphere) = &player_character.sphere {
                            [sphere.transform.position.x, sphere.transform.position.y, sphere.transform.position.z]
                    } else {
                        [camera.position.x, camera.position.y, camera.position.z]
                    }
                } else {
                    [camera.position.x, camera.position.y, camera.position.z]
                };

                for scattered_model in &mut renderer_state.scattered_models {
                    if scattered_model.instance_count == 0 {
                        continue;
                    }
                    
                    scattered_model.update_uniforms(&queue, player_pos);

                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    render_pass.set_bind_group(2, window_size_bind_group, &[]); // Window size
                    render_pass.set_bind_group(4, &scattered_model.uniform_bind_group, &[]);
                    render_pass.set_bind_group(5, &scattered_model.landscape_bind_group, &[]);

                    for mesh in &scattered_model.model.meshes {
                        // We need the model bind group for textures, but the transform in it is ignored by shader 
                        // (except maybe for global model transform if we added it, but here instances drive position)
                        render_pass.set_bind_group(1, &mesh.bind_group, &[]);
                        render_pass.set_bind_group(3, &mesh.group_bind_group, &[]); // Group transform (if any)

                        render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                        // No instance buffer needed - procedural generation
                        render_pass.set_index_buffer(
                            mesh.index_buffer.slice(..),
                            wgpu::IndexFormat::Uint32,
                        );
                        
                        render_pass.draw_indexed(0..mesh.index_count as u32, 0, 0..scattered_model.instance_count);
                    }
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

            for grass in &mut renderer_state.grasses {
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

                let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
                let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

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

            if !renderer_state.particle_systems.is_empty() {                
                for system in &renderer_state.particle_systems {
                    // println!("isntance count {:?}", system.instance_count);
                    render_pass.set_pipeline(&system.render_pipeline);
                    render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    render_pass.set_bind_group(1, &system.uniform_bind_group, &[]);
                    render_pass.draw(0..6, 0..system.instance_count);
                }
            }

            // Drop the render pass before doing texture copies
            drop(render_pass);

            // obviously, no good reason to set this on every frame
            let mut collected_lights = if self.current_workspace == Workspace::GameEngine {
                renderer_state.point_lights.clone()
            } else {
                Vec::new()
            };

            for (addon_name, lights) in &renderer_state.addon_point_lights {
                if let Workspace::Addon(active_name) = &self.current_workspace {
                    if addon_name == active_name || addon_name == "Global" {
                        collected_lights.extend(lights.clone());
                    }
                } else if addon_name == "Global" {
                    collected_lights.extend(lights.clone());
                }
            }

            let mut point_lights_uniform_data = crate::core::editor::PointLightsUniform {
                point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS], // Initialize with zeros
                num_point_lights: collected_lights.len().min(crate::core::editor::MAX_POINT_LIGHTS) as u32,
                _padding: [0; 3],
            };

            for (i, pl) in collected_lights.iter().take(crate::core::editor::MAX_POINT_LIGHTS).enumerate() {
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
                // let camera_binding = editor.camera_binding.as_ref().unwrap();
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

                if let Some(rect) = viewport_rect {
                    // lighting_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                    lighting_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                }

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

                        if let Some(rect) = viewport_rect {
                            // sky_render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                            sky_render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                        }

                        sky_render_pass.set_pipeline(procedural_sky_pipeline);
                        sky_render_pass.set_bind_group(0, procedural_sky_bind_group, &[]);
                        sky_render_pass.draw(0..3, 0..1); // Draw the full-screen triangle
                    }
                }
            }

            {
                if let Some(pipeline) = &self.debug_sphere_pipeline {
                    let mut debug_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Debug Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None
                        })],
                        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                            view: depth_view,
                            depth_ops: Some(wgpu::Operations {
                                load: wgpu::LoadOp::Load,
                                store: wgpu::StoreOp::Store,
                            }),
                            stencil_ops: None,
                        }),
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    if let Some(rect) = viewport_rect {
                        // debug_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                        debug_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                    }

                    debug_pass.set_pipeline(pipeline);
                    debug_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                    
                    for npc in &renderer_state.npcs {
                        if let Some(sphere) = &npc.debug_sphere {
                            sphere.transform.update_uniform_buffer(queue);
                            debug_pass.set_bind_group(1, &sphere.bind_group, &[]);
                            debug_pass.set_vertex_buffer(0, sphere.vertex_buffer.slice(..));
                            debug_pass.set_index_buffer(sphere.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
                            debug_pass.draw_indexed(0..sphere.index_count, 0, 0..1);
                        }
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
                modes: GizmoMode::all_translate(),
                ..renderer_state.gizmo.config().clone()
            });

            // println!("gizmo {:?}", renderer_state.gizmo.config().clone());

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

                if let Some(rect) = viewport_rect {
                    // gizmo_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                    gizmo_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                }

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

                    if let Some(rect) = viewport_rect {
                        // ui_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                        ui_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                    }

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

            // Update Dialogue UI
            dialogue_ui::update_dialogue_ui(editor, device, queue);
            quest_ui::update_quest_ui(editor, device, queue);

            let command_buffer = encoder.finish();
            queue.submit(std::iter::once(command_buffer));
        }
    }

    pub fn render_addon_frame(&mut self, target_view: Option<&wgpu::TextureView>, current_time: f64, viewport_rect: Option<[f32; 4]>) {
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

        // if let Some(rect) = viewport_rect {
        //     camera.aspect_ratio = rect[2] / rect[3];
        //     camera.viewport.width = rect[2];
        //     camera.viewport.height = rect[3];
        //     camera.viewport.window_size.width = rect[2] as u32;
        //     camera.viewport.window_size.height = rect[3] as u32;
        //     camera.update();
        //     camera_binding.update_3d(queue, camera);
        // }

        let window_size_bind_group = self
            .window_size_bind_group
            .as_ref()
            .expect("Couldn't get window size bind group");
        // let camera = self.camera.as_ref().expect("Couldn't get camera"); // careful, we have a camera on editor and on self
        let texture = self.texture.as_ref().expect("Couldn't get texture");

        let time = self.start_time.elapsed().as_secs_f32();
        
        editor.addon_engine.update(renderer_state, camera);

        // Update procedural sky and directional light from addon or world state
        let mut current_procedural_sky_config = editor
            .world_state
            .as_ref()
            .and_then(|state| state.levels.as_ref())
            .and_then(|levels| levels.get(0))
            .and_then(|level| level.procedural_sky.clone());

        // Check if addon has a pending sun config override
        if let Some(addon_config) = editor.addon_engine.runtime.op_state().borrow().try_borrow::<crate::deno::addon_engine::AddonContext>().and_then(|ctx| ctx.pending_sun_config.clone()) {
            current_procedural_sky_config = Some(ProceduralSkyConfig { 
                horizon_color: addon_config.horizon_color, 
                zenith_color: addon_config.zenith_color, 
                sun_direction: addon_config.sun_direction, 
                sun_color: addon_config.sun_color,
                sun_intensity: addon_config.sun_intensity 
            });
        }

        if let Some(config) = current_procedural_sky_config {
            let horizon_color = config.horizon_color;
            let zenith_color = config.zenith_color;
            let sun_direction = config.sun_direction;

            let procedural_sky_uniform_data = ProceduralSkyUniform {
                horizon_color: [horizon_color[0], horizon_color[1], horizon_color[2], 1.0],
                zenith_color: [zenith_color[0], zenith_color[1], zenith_color[2], 1.0],
                sun_direction: [sun_direction[0], sun_direction[1], sun_direction[2], 1.0],
                sun_color: config.sun_color,
                sun_intensity: config.sun_intensity,
                ..Default::default()
            };
            queue.write_buffer(
                self.procedural_sky_uniform_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(&[procedural_sky_uniform_data]),
            );

            // Also update the directional light for PBR rendering
            if let Some(dir_light_buffer) = &self.directional_light_buffer {
                let dir_light_uniform = DirectionalLightUniform {
                    position: sun_direction,
                    _padding: 0,
                    color: [
                        config.sun_color[0] * config.sun_intensity,
                        config.sun_color[1] * config.sun_intensity,
                        config.sun_color[2] * config.sun_intensity,
                    ],
                    _padding2: 0,
                };
                queue.write_buffer(
                    dir_light_buffer,
                    0,
                    bytemuck::cast_slice(&[dir_light_uniform]),
                );
            }
        }

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        
        let mut pbr_cubes = Vec::new();
        let mut non_pbr_cubes = Vec::new();
        let mut pbr_landscapes = Vec::new();
        let mut non_pbr_landscapes = Vec::new();
        let mut pbr_grasses = Vec::new();
        let mut non_pbr_grasses = Vec::new();
        let mut pbr_meshes = Vec::new();
        let mut non_pbr_meshes = Vec::new();

        {
            let mut op_state = editor.addon_engine.runtime.op_state();
            let op_state = op_state.borrow();
            if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                for (addon_name, cubes) in &renderer_state.addon_cubes {
                    if let Workspace::Addon(active_name) = &self.current_workspace {
                        if addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for cube in cubes {
                        let mut is_pbr = true;
                        if let Some(pid) = &cube.pipeline_id {
                            if pid != "default" {
                                if let Some(config) = ctx.pipeline_configs.get(pid) {
                                    is_pbr = config.pbr.unwrap_or(true);
                                }
                            }
                        }
                        
                        if is_pbr {
                            pbr_cubes.push(cube);
                        } else {
                            non_pbr_cubes.push(cube);
                        }
                    }
                }

                for (addon_name, landscapes) in &renderer_state.addon_landscapes {
                    if let Workspace::Addon(active_name) = &self.current_workspace {
                        if addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for landscape in landscapes {
                        let mut is_pbr = true;
                        if let Some(pid) = &landscape.pipeline_id {
                            if pid != "default" {
                                if let Some(config) = ctx.pipeline_configs.get(pid) {
                                    is_pbr = config.pbr.unwrap_or(true);
                                }
                            }
                        }

                        if is_pbr {
                            pbr_landscapes.push(landscape);
                        } else {
                            non_pbr_landscapes.push(landscape);
                        }
                    }
                }

                for (addon_name, meshes) in &renderer_state.addon_meshes {
                    if let Workspace::Addon(active_name) = &self.current_workspace {
                        if addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for mesh in meshes {
                        let mut is_pbr = true;
                        if let Some(config) = ctx.pipeline_configs.get(&mesh.pipeline_id) {
                            is_pbr = config.pbr.unwrap_or(true);
                        }
                        
                        if is_pbr {
                            pbr_meshes.push(mesh);
                        } else {
                            non_pbr_meshes.push(mesh);
                        }
                    }
                }

                for (addon_name, grasses) in &mut renderer_state.addon_grasses {
                    if let Workspace::Addon(active_name) = &self.current_workspace {
                        if addon_name != active_name && addon_name != "Global" {
                            continue;
                        }
                    } else if addon_name != "Global" {
                        continue;
                    }

                    for grass in grasses {
                        let mut is_pbr = true;
                        // Note: Grass currently doesn't have a pipeline_id field on the Rust struct, 
                        // but it has a render_pipeline. We should check the config it was created with if possible.
                        // For now, let's assume hair particles are PBR if they output to G-buffer.
                        // All hair particles in our system are currently set up to output to G-buffer.
                        
                        if is_pbr {
                            pbr_grasses.push(grass);
                        } else {
                            non_pbr_grasses.push(grass);
                        }
                    }
                }
            }
        }

        // 1. Geometry Pass for PBR objects
        if !pbr_cubes.is_empty() || !pbr_landscapes.is_empty() || !pbr_grasses.is_empty() || !pbr_meshes.is_empty() {
            let gbuffer_position_view = self.g_buffer_position_view.as_ref().unwrap();            
            let gbuffer_normal_view = self.g_buffer_normal_view.as_ref().unwrap();
            let gbuffer_albedo_view = self.g_buffer_albedo_view.as_ref().unwrap();
            let gbuffer_pbr_material_view = self.g_buffer_pbr_material_view.as_ref().unwrap();

            let clear_color = wgpu::Color::BLACK;

            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon PBR Geometry Pass"),
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
                    view: &depth_view,
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
                // render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            for cube in &pbr_cubes {
                let mut pipeline_set = false;
                if let Some(pid) = &cube.pipeline_id {
                    if pid != "default" {
                        let mut op_state = editor.addon_engine.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                            if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                render_pass.set_pipeline(custom_pipeline);
                                pipeline_set = true;
                            }
                        }
                    }
                }

                if !pipeline_set {
                    render_pass.set_pipeline(&geometry_pipeline);
                }

                cube.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &cube.bind_group, &[]);
                render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    cube.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
            }

            for landscape in &pbr_landscapes {
                let mut pipeline_set = false;
                if let Some(pid) = &landscape.pipeline_id {
                    if pid != "default" {
                        let mut op_state = editor.addon_engine.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                            if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                render_pass.set_pipeline(custom_pipeline);
                                pipeline_set = true;
                            }
                        }
                    }
                }

                if !pipeline_set {
                    render_pass.set_pipeline(&geometry_pipeline);
                }

                landscape.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    landscape.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
            }

            for mesh in &pbr_meshes {
                render_pass.set_pipeline(&mesh.pipeline);
                
                // Bind groups
                // Note: Standard layout puts Camera at 0. CustomMesh bind_groups are extras.
                // But if the pipeline was created via generic layout, maybe it expects Camera at 0?
                // Yes, generic layout starts with Camera at 0.
                // So we set Camera (0) and then custom groups (1..).
                render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                
                for (i, bind_group) in mesh.bind_groups.iter().enumerate() {
                    render_pass.set_bind_group((i + 1) as u32, bind_group, &[]);
                }

                mesh.transform.update_uniform_buffer(&queue); // Assuming CustomMesh has transform with uniform buffer logic?
                // Wait, CustomMesh transform uses Transform_2::Transform which has update_uniform_buffer?
                // Let's check Transform_2.
                // Yes, if it is Transform_2.
                // But I should check if I imported Transform_2 in CustomMesh. I did.
                // And does it have a bind group? CustomMesh doesn't expose a separate transform bind group.
                // It likely bakes the transform into a uniform buffer that might be part of "Uniform" binding?
                // In my generic implementation in `addon_engine`, I didn't bake the transform automatically into bindings.
                // The user has to provide it?
                // Or does CustomMesh hold a transform buffer?
                // In `CustomMesh::new`, I created a `Transform`.
                // But I didn't put its buffer into `bind_groups` automatically.
                // If the shader needs Model matrix, it needs to be in a bind group.
                // The default pipeline created by `create_addon_pipeline` expects:
                // Group 0: Camera
                // Group 1: ModelUniform (model_matrix, normal_matrix)
                // BUT, my `op_pipeline_create` for EXTRA bind groups starts appending extras after Group 0?
                // No, `op_pipeline_create` logic:
                // `layouts = vec![camera]`
                // then appends extras.
                // So Group 1 is first extra.
                // BUT `create_addon_pipeline` default vertex shader uses:
                // Group 0: Camera
                // Group 1: Model
                // This conflict!
                // If I use default vertex shader, I need Group 1 to be Model.
                // If I use custom vertex shader (like Water), I can define my own groups.
                // My Water shader uses Group 1 for Time. It doesn't use Model matrix (it uses position in vertex shader directly or uniform).
                // So for Water, it's fine.
                // But for generic mesh?
                // If I want standard Model transform support, I should ensure Group 1 is Model if using default shader.
                // But `op_pipeline_create` doesn't enforce this if `extra_bind_groups` are used.
                // It just appends extras.
                
                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..mesh.num_indices, 0, 0..1);
            }

            for grass in &mut pbr_grasses {
                // Update uniforms based on camera/player position
                // Similar to how it's done in render_frame
                if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                        let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                        if let Some(player_model) = player_model {
                            let model_mesh = player_model.meshes.get(0);
                            if let Some(model_mesh) = model_mesh {
                                grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
                            } else {
                                grass.update_uniforms(&queue, time as f32, camera.position);
                            }
                        } else {
                            grass.update_uniforms(&queue, time as f32, camera.position);
                        }
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

                let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
                let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

                render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
            }
            drop(render_pass);

            // Update point lights buffer for addons
            let mut collected_lights = if self.current_workspace == Workspace::GameEngine {
                renderer_state.point_lights.clone()
            } else {
                Vec::new()
            };

            for (addon_name, lights) in &renderer_state.addon_point_lights {
                if let Workspace::Addon(active_name) = &self.current_workspace {
                    if addon_name == active_name || addon_name == "Global" {
                        collected_lights.extend(lights.clone());
                    }
                } else if addon_name == "Global" {
                    collected_lights.extend(lights.clone());
                }
            }

            let mut point_lights_uniform_data = crate::core::editor::PointLightsUniform {
                point_lights: [[0.0; 12]; crate::core::editor::MAX_POINT_LIGHTS],
                num_point_lights: collected_lights.len().min(crate::core::editor::MAX_POINT_LIGHTS) as u32,
                _padding: [0; 3],
            };

            for (i, pl) in collected_lights.iter().take(crate::core::editor::MAX_POINT_LIGHTS).enumerate() {
                 point_lights_uniform_data.point_lights[i] = [
                    pl.position[0], pl.position[1], pl.position[2], 0.0,
                    pl.color[0], pl.color[1], pl.color[2], 0.0,
                    pl.intensity, pl.max_distance, 0.0, 0.0
                ];
            }
            
            queue.write_buffer(
                self.point_lights_buffer.as_ref().unwrap(),
                0,
                bytemuck::cast_slice(&[point_lights_uniform_data]),
            );

            // 1.5 Procedural Sky Pass
            {
                let mut sky_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Addon Procedural Sky Pass"),
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

                if let Some(rect) = viewport_rect {
                    sky_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
                }

                sky_pass.set_pipeline(self.procedural_sky_pipeline.as_ref().unwrap());
                sky_pass.set_bind_group(0, self.procedural_sky_bind_group.as_ref().unwrap(), &[]);
                sky_pass.draw(0..3, 0..1);
            }

            // 2. Lighting Pass for PBR objects
            let mut custom_lighting_pid = None;
            let mut extra_lighting_bind_groups = Vec::new();
            
            {
                let mut op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                    // Find if any used pipeline has a custom lighting pipeline
                    for cube in &pbr_cubes {
                        if let Some(pid) = &cube.pipeline_id {
                            if ctx.lighting_pipelines.contains_key(pid) {
                                custom_lighting_pid = Some(pid.clone());
                                if let Some(bgs) = ctx.lighting_bind_groups.get(pid) {
                                    extra_lighting_bind_groups = bgs.clone();
                                }
                                break;
                            }
                        }
                    }
                }
            }

            let lighting_bind_group = self.lighting_bind_group.as_ref().unwrap();
            let g_buffer_bind_group = self.g_buffer_bind_group.as_ref().unwrap();
            let shadow_pipeline_data = self.shadow_pipeline_data.as_ref().unwrap();
            let shadow_bind_group = &shadow_pipeline_data.shadow_bind_group;

            let mut lighting_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon Lighting Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        // load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.85, g: 0.05, b: 0.05, a: 1.0 }),
                            load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Some(rect) = viewport_rect {
                // lighting_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                lighting_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            if let Some(pid) = &custom_lighting_pid {
                let mut op_state = editor.addon_engine.runtime.op_state();
                let op_state = op_state.borrow();
                if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                    if let Some(lp) = ctx.lighting_pipelines.get(pid) {
                        lighting_pass.set_pipeline(lp);
                    }
                }
            } else {
                lighting_pass.set_pipeline(self.lighting_pipeline.as_ref().unwrap());
            }

            lighting_pass.set_bind_group(0, lighting_bind_group, &[]);
            lighting_pass.set_bind_group(1, g_buffer_bind_group, &[]);
            lighting_pass.set_bind_group(2, &camera_binding.bind_group, &[]);
            lighting_pass.set_bind_group(3, shadow_bind_group, &[]);

            // Set extra bind groups for custom lighting
            for (i, bg) in extra_lighting_bind_groups.iter().enumerate() {
                lighting_pass.set_bind_group((i + 4) as u32, bg, &[]);
            }

            lighting_pass.draw(0..3, 0..1);
            drop(lighting_pass);
        }

        // 3. Pass for non-PBR objects
        if !non_pbr_cubes.is_empty() || !non_pbr_landscapes.is_empty() || !non_pbr_grasses.is_empty() || !non_pbr_meshes.is_empty() {
            let has_pbr = !pbr_cubes.is_empty() || !pbr_landscapes.is_empty();
            let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Addon non-PBR Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // load: if !has_pbr { wgpu::LoadOp::Clear(wgpu::Color::BLACK) } else { wgpu::LoadOp::Load },
                        load: wgpu::LoadOp::Load,
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &depth_view,
                    depth_ops: Some(wgpu::Operations {
                        load: if !has_pbr { wgpu::LoadOp::Clear(1.0) } else { wgpu::LoadOp::Load },
                        store: wgpu::StoreOp::Store,
                    }),
                    stencil_ops: None,
                }),
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if let Some(rect) = viewport_rect {
                // render_pass.set_viewport(rect[0], rect[1], rect[2], rect[3], 0.0, 1.0);
                render_pass.set_scissor_rect(rect[0] as u32, rect[1] as u32, rect[2] as u32, rect[3] as u32);
            }

            render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
            render_pass.set_bind_group(2, window_size_bind_group, &[]);

            for cube in non_pbr_cubes {
                let mut pipeline_set = false;
                if let Some(pid) = &cube.pipeline_id {
                    if pid != "default" {
                        let mut op_state = editor.addon_engine.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                            if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                render_pass.set_pipeline(custom_pipeline);
                                pipeline_set = true;
                            }
                        }
                    }
                }

                if !pipeline_set {
                    // Non-PBR with default pipeline is not ideal as geometry_pipeline expects G-buffer targets
                    // But we'll use it if nothing else is set
                    render_pass.set_pipeline(&geometry_pipeline);
                }

                cube.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &cube.bind_group, &[]);
                render_pass.set_bind_group(3, &cube.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, cube.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    cube.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..cube.index_count as u32, 0, 0..1);
            }

            for landscape in non_pbr_landscapes {
                let mut pipeline_set = false;
                if let Some(pid) = &landscape.pipeline_id {
                    if pid != "default" {
                        let mut op_state = editor.addon_engine.runtime.op_state();
                        let op_state = op_state.borrow();
                        if let Some(ctx) = op_state.try_borrow::<crate::deno::addon_engine::AddonContext>() {
                            if let Some(custom_pipeline) = ctx.pipelines.get(pid) {
                                render_pass.set_pipeline(custom_pipeline);
                                pipeline_set = true;
                            }
                        }
                    }
                }

                if !pipeline_set {
                    render_pass.set_pipeline(&geometry_pipeline);
                }

                landscape.transform.update_uniform_buffer(&queue);
                render_pass.set_bind_group(1, &landscape.bind_group, &[]);
                render_pass.set_bind_group(3, &landscape.group_bind_group, &[]);
                render_pass.set_vertex_buffer(0, landscape.vertex_buffer.slice(..));
                render_pass.set_index_buffer(
                    landscape.index_buffer.slice(..),
                    wgpu::IndexFormat::Uint32,
                );
                render_pass.draw_indexed(0..landscape.index_count as u32, 0, 0..1);
            }

            for mesh in &non_pbr_meshes {
                render_pass.set_pipeline(&mesh.pipeline);
                render_pass.set_bind_group(0, &camera_binding.bind_group, &[]);
                for (i, bind_group) in mesh.bind_groups.iter().enumerate() {
                    render_pass.set_bind_group((i + 1) as u32, bind_group, &[]);
                }
                
                render_pass.set_vertex_buffer(0, mesh.vertex_buffer.slice(..));
                render_pass.set_index_buffer(mesh.index_buffer.slice(..), wgpu::IndexFormat::Uint32);
                render_pass.draw_indexed(0..mesh.num_indices, 0, 0..1);
            }

            for grass in &mut non_pbr_grasses {
                // Update uniforms
                if let Some(player_character) = &renderer_state.player_character {
                    if let Some(model_id) = &player_character.model_id {
                        let player_model = renderer_state.models.iter().find(|m| m.id == model_id.clone());
                        if let Some(player_model) = player_model {
                            let model_mesh = player_model.meshes.get(0);
                            if let Some(model_mesh) = model_mesh {
                                grass.update_uniforms(&queue, time as f32, Point3::new(model_mesh.transform.position.x, model_mesh.transform.position.y, model_mesh.transform.position.z));
                            } else {
                                grass.update_uniforms(&queue, time as f32, camera.position);
                            }
                        } else {
                            grass.update_uniforms(&queue, time as f32, camera.position);
                        }
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

                let grid_cells = ((grass.config.render_distance * 2.0) / grass.config.grid_size).ceil() as u32;
                let total_instances = grid_cells * grid_cells * grass.config.blade_density as u32;

                render_pass.draw_indexed(0..grass.blade.index_count, 0, 0..total_instances);
            }
            drop(render_pass);
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

                    // println!("viewport_rect {:?}", rect);

                    // if let Some(camera) = &mut editor.camera {
                    //     camera.aspect_ratio = rect[2] / rect[3];
                    //     camera.viewport.width = rect[2];
                    //     camera.viewport.height = rect[3];
                    //     camera.viewport.window_size.width = rect[2] as u32;
                    //     camera.viewport.window_size.height = rect[3] as u32;
                    //     camera.update();
                    //     if let Some(camera_binding) = &mut editor.camera_binding {
                    //         camera_binding.update_3d(queue, camera);
                    //     }
                    // }
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
                editor.writing_webview_bounds = None;
                editor.viewport_tab_rect = None;
                editor.is_viewport_visible = false;
            }

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

        if is_viewport_visible || game_mode {
            if self.current_workspace == Workspace::GameEngine {
                self.render_frame(Some(&view), 0.0, game_mode, viewport_rect);
            } else if self.current_workspace == Workspace::Stunts {
                let current_time_s = self.export_editor.as_ref()
                    .map(|e| e.video_current_time_ms as f64 / 1000.0)
                    .unwrap_or(0.0);
                self.render_stunts_frame(Some(&view), current_time_s, false, viewport_rect);
            } else if self.current_workspace == Workspace::Sophia || self.current_workspace == Workspace::CentralChat {
                // // ... (rest of the code)
                // let mut encoder = gpu_resources.device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                //     label: Some("Clear Encoder"),
                // });
                // {
                //     let _rpass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                //         label: Some("Clear Pass"),
                //         color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                //             view: &view,
                //             resolve_target: None,
                //             ops: wgpu::Operations {
                //                 load: wgpu::LoadOp::Clear(wgpu::Color { r: 0.05, g: 0.05, b: 0.05, a: 1.0 }),
                //                 store: wgpu::StoreOp::Store,
                //             },
                //             depth_slice: None,
                //         })],
                //         depth_stencil_attachment: None,
                //         timestamp_writes: None,
                //         occlusion_query_set: None,
                //     });
                // }
                // gpu_resources.queue.submit(Some(encoder.finish()));
            } else { // Addons
                self.render_addon_frame(Some(&view), 0.0, viewport_rect);
            }
        }

        output.present();
    }
    


    fn ui(&mut self, ctx: &egui::Context) {
        // egui::TopBottomPanel::top("command_bar").show(ctx, |ui| {
        //     ui.horizontal_centered(|ui| {
        //          // Check if we need to load projects
        //          if self.projects.is_empty() {
        //              if let Ok(registry) = utilities::load_project_registry() {
        //                  for project in registry.projects {
        //                      self.projects.push((project.project_name, project.project_id));
        //                  }
        //              }
        //          }

        //          let mut selected_text = "All Projects".to_string();
        //          if let Some(id) = &self.command_bar_project_id {
        //              if let Some((name, _)) = self.projects.iter().find(|(_, pid)| pid == id) {
        //                  selected_text = name.clone();
        //              }
        //          }

        //          egui::ComboBox::from_id_source("command_bar_project_combo")
        //             .selected_text(selected_text)
        //             .show_ui(ui, |ui| {
        //                 ui.selectable_value(&mut self.command_bar_project_id, None, "All Projects");
        //                 for (name, id) in &self.projects {
        //                      ui.selectable_value(&mut self.command_bar_project_id, Some(id.clone()), name);
        //                 }
        //             });

        //          let response = ui.add_sized(
        //              ui.available_size(),
        //              egui::TextEdit::multiline(&mut self.command_bar_input).desired_rows(2).hint_text("Enter AI command (Ctrl+K to focus)...")
        //          );
                 
        //          if ctx.input_mut(|i| i.consume_key(egui::Modifiers::CTRL, egui::Key::K)) {
        //              response.request_focus();
        //          }

        //          if response.lost_focus() && ctx.input(|i| i.key_pressed(egui::Key::Enter)) {
        //              if !self.command_bar_input.trim().is_empty() {
        //                  let content = self.command_bar_input.clone();
        //                  self.command_bar_input.clear();
                         
        //                  self.chat.is_loading = true;
                         
        //                  let client = self.chat.client.clone();
        //                  let api_url = self.chat.api_url.clone();
                         
        //                  // Determine project ID
        //                  let project_id_to_use = self.command_bar_project_id.clone()
        //                      .or_else(|| self.export_editor.as_ref().and_then(|e| e.world_state.as_ref()).and_then(|ws| ws.id.clone()));
                        
        //                 // TODO: need to load the correct state depending on either the chosen project, or, if All Projects is chosen, then it needs to
        //                 // use an AI endpoint to decide which project is relevant to the AI command, then here we use that info to finally send the relevant state
        //                 // probably easiest to just freshly load the relevant project's state direct from file once it is chosen / determined
        //                  let mut world_state_cl = None;
        //                  if let Some(editor) = self.export_editor.as_ref() {
        //                      if let Some(ws) = &editor.world_state {
        //                          world_state_cl = Some(ws.clone());
        //                      }
        //                  }
                         
        //                  let current_session = self.chat.current_session.clone();
        //                  let (tx, rx) = std::sync::mpsc::channel();
        //                  self.chat.rx = Some(rx);

        //                  // Add user message to chat immediately for UI feedback
        //                  self.chat.messages.push(ChatMessage {
        //                      id: Uuid::new_v4().to_string(),
        //                      role: "user".to_string(),
        //                      content: Some(content.clone()),
        //                      tool_call_id: None,
        //                      tool_calls: None,
        //                  });

        //                  std::thread::spawn(move || {
        //                      let rt = tokio::runtime::Runtime::new().unwrap();
        //                      rt.block_on(async {
        //                          let mut session_id = None;
                                 
        //                          if let Some(s) = current_session {
        //                              session_id = Some(s.id);
        //                          } else if let Some(pid) = project_id_to_use {
        //                              // Create session
        //                              let url = format!("{}/api/sessions", api_url);
        //                              let body = serde_json::json!({ "projectId": pid });
        //                              if let Ok(res) = client.post(&url).json(&body).send().await {
        //                                  if let Ok(session) = res.json::<ChatSession>().await {
        //                                      session_id = Some(session.id);
        //                                  }
        //                              }
        //                          }

        //                          if let Some(sid) = session_id {
        //                              let url = format!("{}/api/sessions/{}/messages", api_url, sid);
        //                              let body = serde_json::json!({
        //                                  "role": "user",
        //                                  "content": content,
        //                                  "world_state": world_state_cl
        //                              });
                                     
        //                              let res = client.post(&url).json(&body).send().await;
        //                              if let Ok(resp) = res {
        //                                  if let Ok(msg) = resp.json::<ChatMessage>().await {
        //                                      let _ = tx.send(msg);
        //                                  }
        //                              }
        //                          }
        //                      });
        //                  });
        //              }
        //          }
        //     });
        // });

        let mut context = UiContext {
            export_editor: &mut self.export_editor,
            new_project_name: &mut self.new_project_name,
            projects: &mut self.projects,
            selected_component_id: &mut self.selected_component_id,
            chat: &mut self.chat,
            video_timeline_ui: &mut self.video_timeline_ui,
            gpu_resources: &self.gpu_resources,
            current_app: match &self.current_workspace {
                Workspace::GameEngine => AppExperience::OpenWorldStudio,
                Workspace::Sophia => AppExperience::Sophia,
                Workspace::Stunts => AppExperience::Stunts,
                Workspace::CentralChat => AppExperience::OpenWorldStudio,
                Workspace::Addon(_) => AppExperience::OpenWorldStudio, // Default for addons
            },
        };

        let mut viewer = PipelineTabViewer { context };

        egui::SidePanel::left("activity_bar")
            .resizable(false)
            .default_width(48.0)
            .show(ctx, |ui| {
                ui.vertical_centered(|ui| {
                    ui.add_space(6.0);
                    if ui.selectable_label(self.current_workspace == Workspace::GameEngine, "🎮").on_hover_text("Open World Studio (Games)").clicked() {
                        self.current_workspace = Workspace::GameEngine;
                    }
                    ui.add_space(6.0);
                    if ui.selectable_label(self.current_workspace == Workspace::Sophia, "⚡").on_hover_text("Sophia (Writing)").clicked() {
                        self.current_workspace = Workspace::Sophia;
                    }
                    ui.add_space(6.0);
                    if ui.selectable_label(self.current_workspace == Workspace::Stunts, "🎬").on_hover_text("Stunts (Videos)").clicked() {
                        self.current_workspace = Workspace::Stunts;
                    }
                    ui.add_space(6.0);
                    if ui.selectable_label(self.current_workspace == Workspace::CentralChat, "💬").on_hover_text("Central Chat Workspace").clicked() {
                        self.current_workspace = Workspace::CentralChat;
                    }

                    // Render Addon Workspaces
                    if let Some(editor) = &mut viewer.context.export_editor {
                        let addons = editor.addon_engine.get_registered_addons();
                        for addon in addons {
                            // Only show if it has UI/workspace capability (assume yes for now or check metadata)
                            // We use the first letter of the name as the icon for now
                            let icon = addon.name.chars().next().unwrap_or('?').to_string();
                            let is_active = if let Workspace::Addon(name) = &self.current_workspace {
                                name == &addon.name
                            } else {
                                false
                            };
                            
                            ui.add_space(6.0);
                            if ui.selectable_label(is_active, icon).on_hover_text(&addon.name).clicked() {
                                self.current_workspace = Workspace::Addon(addon.name.clone());
                            }
                        }
                    }

                    ui.add_space(6.0);
                    if ui.selectable_label(self.show_addon_manager, "➕").on_hover_text("Manage Addons").clicked() {
                        self.show_addon_manager = !self.show_addon_manager;
                    }

                    // ui.add_space(24.0);
                    // ui.separator();
                    // ui.add_space(6.0);
                    
                    // if ui.selectable_label(self.show_central_chat_overlay, "⚡").on_hover_text("Toggle Central Chat Overlay").clicked() {
                    //     self.show_central_chat_overlay = !self.show_central_chat_overlay;
                    // }
                });
            });

        if self.show_addon_manager {
            egui::Window::new("Entropy Addons")
                .default_size([400.0, 500.0])
                .open(&mut self.show_addon_manager)
                .show(ctx, |ui| {
                    ui.heading("Manage Addons");
                    ui.separator();
                    
                    if ui.button("Load Addon Bundle").clicked() {
                         if let Some(path) = rfd::FileDialog::new()
                            .add_filter("JavaScript", &["js", "mjs", "bundle"])
                            .pick_file() {
                            
                            if let Some(editor) = &mut viewer.context.export_editor {
                                println!("Loading addon from: {:?}", path);
                                let res = pollster::block_on(editor.addon_engine.load_addon(&path));
                                match res {
                                    Ok(_) => println!("Addon loaded successfully"),
                                    Err(e) => println!("Failed to load addon: {}", e),
                                }
                            }
                        }
                    }

                    ui.separator();
                    ui.label("Registered Addons:");
                    
                    if let Some(editor) = &mut viewer.context.export_editor {
                        let addons = editor.addon_engine.get_registered_addons();
                        if addons.is_empty() {
                            ui.label("No addons registered.");
                        } else {
                            for addon in addons {
                                ui.group(|ui| {
                                    ui.strong(&addon.name);
                                    ui.label(format!("Version: {}", addon.version));
                                    ui.label(&addon.description);
                                    ui.label(format!("Author: {}", addon.author.join(", ")));
                                });
                            }
                        }
                    }
                });
        }

        if self.show_central_chat_overlay {
            egui::Window::new("Central Chat")
                .default_size([400.0, 600.0])
                .open(&mut self.show_central_chat_overlay)
                .show(ctx, |ui| {
                    DockArea::new(&mut self.central_chat_dock_state)
                        .style(Style::from_egui(ctx.style().as_ref()))
                        .show_inside(ui, &mut viewer);
                });
        }

        if self.current_workspace == Workspace::Sophia {
            if let Some(editor) = &mut viewer.context.export_editor {
                let quiet_mode = editor.sophia_app_state.quiet_mode;

                if quiet_mode {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        viewer.ui(ui, &mut Tab::Writing);
                    });
                } else {
                    egui::CentralPanel::default().show(ctx, |ui| {
                        DockArea::new(&mut self.sophia_dock_state)
                            .style(Style::from_egui(ctx.style().as_ref()))
                            .show_inside(ui, &mut viewer);
                    });
                }
            }
        } else {
            // if self.current_workspace == Workspace::Stunts {
            //     egui::TopBottomPanel::bottom("video_timeline_panel")
            //         .resizable(true)
            //         .default_height(300.0)
            //         .show(ctx, |ui| {
            //             DockArea::new(&mut self.video_timeline_dock_state)
            //                 .style(Style::from_egui(ctx.style().as_ref()))
            //                 .show_inside(ui, &mut viewer);
            //         });
            // }

            

            // egui::SidePanel::right("dock_sidebar")
            //     .resizable(true)
            //     .default_width(sidebar_width)
            //     .width_range(sidebar_width..=(sidebar_width + 400.0))
            //     .show(ctx, |ui| {
            //         DockArea::new(active_dock_state)
            //             .style(Style::from_egui(ctx.style().as_ref()))
            //             .show_inside(ui, &mut viewer);
            //     });

             // if let Some(editor) = &mut viewer.context.export_editor {

                egui::CentralPanel::default()
                    // .frame(egui::Frame::none())
                    .show(ctx, |ui| {
                    
                    if let Some(editor) = &mut viewer.context.export_editor {
                        let new_tabs = editor.addon_engine.consume_new_tabs();
                        for (tab_id, title, addon_name) in new_tabs {
                            let dock_state = self.addon_dock_states.entry(addon_name.clone()).or_insert_with(|| {
                                let mut ds = DockState::new(vec![Tab::Viewport, Tab::Projects, Tab::Chat]);
                                let surface = ds.main_surface_mut();
                                // surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Chat]);
                                ds
                            });
                            let surface = dock_state.main_surface_mut();
                            // surface.push_to_first_leaf(Tab::AddonTab { id: tab_id, label: title });
                            surface.split_right(NodeIndex::root(), 0.7, vec![Tab::AddonTab { id: tab_id, label: title }]);
                        }
                    }

                    // if let Some(editor) = &mut viewer.context.export_editor {
                    //     let new_tabs = editor.addon_engine.consume_new_tabs();
                        
                    //     // First loop: collect tabs into a vector
                    //     let mut tabs_to_insert = Vec::new();
                    //     for (tab_id, title, addon_name) in new_tabs {
                    //         tabs_to_insert.push((tab_id, title, addon_name));
                    //     }
                        
                    //     // Second loop: insert tabs alongside Chat
                    //     for (tab_id, title, addon_name) in tabs_to_insert {
                    //         let dock_state = self.addon_dock_states.entry(addon_name.clone()).or_insert_with(|| {
                    //             let mut ds = DockState::new(vec![Tab::Viewport, Tab::Projects]);
                    //             let surface = ds.main_surface_mut();
                    //             surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Chat]);
                    //             ds
                    //         });
                            
                    //         let surface = dock_state.main_surface_mut();
                    //         // Find the node containing Chat
                    //         let chat_node = surface.iter().find_map(|(idx, node)| {
                    //             node.tabs().and_then(|tabs| {
                    //                 tabs.iter().any(|t| matches!(t, Tab::Chat)).then_some(idx)
                    //             })
                    //         });
                            
                    //         if let Some(node_idx) = chat_node {
                    //             // Set focus to the Chat node and push there
                    //             surface.set_focused_node(node_idx);
                    //             surface.push_to_focused_leaf(Tab::AddonTab { id: tab_id, label: title });
                    //         } else {
                    //             // Fallback if Chat tab not found
                    //             surface.push_to_first_leaf(Tab::AddonTab { id: tab_id, label: title });
                    //         }
                    //     }
                    // }

                    let active_dock_state = match &self.current_workspace {
                        Workspace::GameEngine => &mut self.game_dock_state,
                        Workspace::Sophia => &mut self.sophia_dock_state,
                        Workspace::Stunts => &mut self.stunts_dock_state,
                        Workspace::CentralChat => &mut self.central_chat_dock_state,
                        Workspace::Addon(name) => {
                            self.addon_dock_states.entry(name.clone()).or_insert_with(|| {
                                let mut ds = DockState::new(vec![Tab::Viewport, Tab::Projects]);
                                let surface = ds.main_surface_mut();
                                surface.split_right(NodeIndex::root(), 0.7, vec![Tab::Chat]);
                                ds
                            })
                        },
                    };

                    let sidebar_width = match self.current_workspace {
                        Workspace::GameEngine => 400.0,
                        Workspace::CentralChat => 800.0,
                        Workspace::Sophia => 800.0,
                        Workspace::Stunts => 400.0,
                        _ => 400.0
                    };

                    DockArea::new(active_dock_state)
                        .style(Style::from_egui(ctx.style().as_ref()))
                        .show_inside(ui, &mut viewer);

                    if let Some(editor) = &mut viewer.context.export_editor {
                        editor.addon_engine.render_ui(ctx);
                    }

                    // Draw selection highlight for Stunts objects
                    if let Some(editor) = &viewer.context.export_editor {
                        if let Some(selected) = &editor.selected_object {
                            let mut rect_pos = None;
                            let mut rect_size = None;

                            match selected.object_type {
                                ObjectType::Polygon => {
                                    if let Some(poly) = editor.stunts_polygons.iter().find(|p| p.id == selected.object_id) {
                                        rect_pos = Some(poly.transform.position);
                                        rect_size = Some(poly.dimensions);
                                    }
                                }
                                ObjectType::TextItem => {
                                    if let Some(text) = editor.stunts_textboxes.iter().find(|t| t.id == selected.object_id) {
                                        rect_pos = Some(text.transform.position);
                                        rect_size = Some(text.dimensions);
                                    }
                                }
                                ObjectType::ImageItem => {
                                    if let Some(img) = editor.stunts_images.iter().find(|i| i.id == selected.object_id.to_string()) {
                                        rect_pos = Some(img.transform.position);
                                        rect_size = Some((img.transform.scale.x, img.transform.scale.y));
                                    }
                                }
                                ObjectType::VideoItem => {
                                    if let Some(vid) = editor.stunts_videos.iter().find(|v| v.id == selected.object_id.to_string()) {
                                        rect_pos = Some(vid.transform.position);
                                        rect_size = Some((vid.transform.scale.x, vid.transform.scale.y));
                                    }
                                }
                            }

                            if let (Some(pos), Some(size)) = (rect_pos, rect_size) {
                                let screen_rect = egui::Rect::from_center_size(
                                    egui::pos2(pos.x, pos.y),
                                    egui::vec2(size.0, size.1)
                                );
                                
                                let painter = ui.painter();
                                painter.rect_stroke(
                                    screen_rect.expand(2.0),
                                    2.0,
                                    egui::Stroke::new(2.0, egui::Color32::from_rgb(255, 165, 0)), // Orange selection box
                                    StrokeKind::Middle
                                );

                                // Draw tiny handles at corners
                                let handle_color = egui::Color32::WHITE;
                                let handle_size = 6.0;
                                for corner in &[screen_rect.left_top(), screen_rect.right_top(), screen_rect.left_bottom(), screen_rect.right_bottom()] {
                                    painter.rect_filled(
                                        egui::Rect::from_center_size(*corner, egui::vec2(handle_size, handle_size)),
                                        1.0,
                                        handle_color
                                    );
                                }
                            }
                        }
                    }
                });

            // }
        }
    }
}
