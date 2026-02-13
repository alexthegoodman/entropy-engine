use wgpu::{self, Device, RenderPipeline, ShaderModuleDescriptor, ShaderSource};
use crate::deno::addon_engine::PipelineConfig;
use crate::core::vertex::{Vertex, ModelVertex}; 

// Add GBuffer format constants at the top or pass them in
pub const GBUFFER_FORMATS: [wgpu::TextureFormat; 4] = [
    wgpu::TextureFormat::Rgba16Float,  // Position/Albedo
    wgpu::TextureFormat::Rgba16Float,  // Normals
    wgpu::TextureFormat::Rgba8Unorm,   // Material properties
    wgpu::TextureFormat::Rgba8Unorm,   // Additional data
];

pub fn create_addon_pipeline(
    device: &Device,
    config: &PipelineConfig,
    bind_group_layouts: &[&wgpu::BindGroupLayout],
    formats: &[wgpu::TextureFormat],
    depth_format: Option<wgpu::TextureFormat>,
) -> RenderPipeline {
    let vertex_shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(&format!("{} Vertex Shader", config.name)),
        source: ShaderSource::Wgsl(config.vertex_shader.as_deref().unwrap_or("
            struct VertexInput {
                @location(0) position: vec3<f32>,
                @location(1) normal: vec3<f32>,
                @location(2) tex_coords: vec2<f32>,
                @location(3) color: vec4<f32>,
            };
            struct CameraUniform {
                view_proj: mat4x4<f32>,
                view: mat4x4<f32>,
                proj: mat4x4<f32>,
            };
            @group(0) @binding(0)
            var<uniform> camera: CameraUniform;

            struct ModelUniform {
                model_matrix: mat4x4<f32>,
            };
            @group(1) @binding(0)
            var<uniform> model: ModelUniform;

            struct VertexOutput {
                @builtin(position) clip_position: vec4<f32>,
                @location(0) color: vec4<f32>,
                @location(1) world_position: vec3<f32>,
                @location(2) world_normal: vec3<f32>,
            };
            @vertex
            fn vs_main(input: VertexInput) -> VertexOutput {
                var out: VertexOutput;
                let world_pos = model.model_matrix * vec4<f32>(input.position, 1.0);
                out.clip_position = camera.view_proj * world_pos;
                out.world_position = world_pos.xyz;
                out.world_normal = (model.model_matrix * vec4<f32>(input.normal, 0.0)).xyz;
                out.color = input.color;
                return out;
            }
        ").into()),
    });

    // Update default fragment shader to output to appropriate number of targets
    let mut frag_shader_source = if formats.len() > 1 {
        "
            struct FragmentOutput {
                @location(0) color0: vec4<f32>,
                @location(1) color1: vec4<f32>,
                @location(2) color2: vec4<f32>,
                @location(3) color3: vec4<f32>,
            }
            @fragment
            fn fs_main(@location(0) color: vec4<f32>, @location(1) world_pos: vec3<f32>, @location(2) world_normal: vec3<f32>) -> FragmentOutput {
                var output: FragmentOutput;
                output.color0 = vec4<f32>(world_pos, 1.0);
                output.color1 = vec4<f32>(normalize(world_normal), 1.0);
                output.color2 = color;
                output.color3 = vec4<f32>(0.0, 0.0, 0.0, 1.0);
                return output;
            }
        ".to_string()
    } else {
        "
            @fragment
            fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                return color;
            }
        ".to_string()
    };

    if let Some(custom_frag) = &config.fragment_shader {
        frag_shader_source = custom_frag.clone();
    }

    let fragment_shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(&format!("{} Fragment Shader", config.name)),
        source: ShaderSource::Wgsl(frag_shader_source.into()),
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(&format!("{} Pipeline Layout", config.name)),
        bind_group_layouts,
        push_constant_ranges: &[],
    });

    // TODO: Parse blend state from config
    // let blend_state = Some(wgpu::BlendState {
    //     color: wgpu::BlendComponent::REPLACE,
    //     alpha: wgpu::BlendComponent::REPLACE,
    // });

    let blend_state = Some(wgpu::BlendState {
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
    });

    // Create targets for all attachments
    let targets: Vec<_> = formats.iter().map(|&format| {
        Some(wgpu::ColorTargetState {
            format,
            blend: blend_state,
            write_mask: wgpu::ColorWrites::ALL,
        })
    }).collect();

    // println!("Creating pipeline completely: {:?} {:?}", config.name, config.pbr);

    // In your pipeline creation code, add blend state:
// let color_target = wgpu::ColorTargetState {
//     format: wgpu::TextureFormat::Bgra8UnormSrgb, // or whatever your surface format is
//     blend: Some(wgpu::BlendState {
//         color: wgpu::BlendComponent {
//             src_factor: wgpu::BlendFactor::SrcAlpha,
//             dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
//             operation: wgpu::BlendOperation::Add,
//         },
//         alpha: wgpu::BlendComponent {
//             src_factor: wgpu::BlendFactor::One,
//             dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
//             operation: wgpu::BlendOperation::Add,
//         },
//     }),
//     write_mask: wgpu::ColorWrites::ALL,
// };

    let mut vertex_buffers = wgpu::VertexState {
        module: &vertex_shader,
        entry_point: Some("vs_main"), // Standard entry point
        buffers: if config.layout.as_deref() == Some("skinned") {
            &[ModelVertex::desc()]
        } else {
            &[Vertex::desc()]
        },
        compilation_options: wgpu::PipelineCompilationOptions::default(),
    };

    if config.form == Some("composite".to_string()) {
        vertex_buffers = wgpu::VertexState {
            module: &vertex_shader,
            entry_point: Some("vs_main"), // Standard entry point
            buffers: &[], // Standard vertex layout
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        };
    }

    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&config.name),
        layout: Some(&pipeline_layout),
        vertex: vertex_buffers,
        fragment: Some(wgpu::FragmentState {
            module: &fragment_shader,
            entry_point: Some("fs_main"),
            targets: &targets,
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: Some(wgpu::Face::Back), // Default to backface culling
            polygon_mode: wgpu::PolygonMode::Fill,
            unclipped_depth: false,
            conservative: false,
        },
        depth_stencil: depth_format.map(|format| wgpu::DepthStencilState {
            format,
            depth_write_enabled: true,
            depth_compare: wgpu::CompareFunction::Less,
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        }),
        multisample: wgpu::MultisampleState {
            count: 1,
            mask: !0,
            alpha_to_coverage_enabled: false,
        },
        multiview: None,
        cache: None,
    })
}
