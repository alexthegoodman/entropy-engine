use wgpu::{self, Device, RenderPipeline, ShaderModuleDescriptor, ShaderSource};
use crate::deno::addon_engine::PipelineConfig;
use crate::core::vertex::Vertex; // Assuming standard vertex for now

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
    formats: [wgpu::TextureFormat; 4], // Changed to slice to support multiple
    depth_format: Option<wgpu::TextureFormat>,
) -> RenderPipeline {
    let vertex_shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(&format!("{} Vertex Shader", config.name)),
        source: ShaderSource::Wgsl(config.vertex_shader.as_deref().unwrap_or("
            struct VertexInput {
                @location(0) position: vec3<f32>,
                @location(3) color: vec4<f32>,
            };
            struct VertexOutput {
                @builtin(position) clip_position: vec4<f32>,
                @location(0) color: vec4<f32>,
            };
            @vertex
            fn vs_main(model: VertexInput) -> VertexOutput {
                var out: VertexOutput;
                out.clip_position = vec4<f32>(model.position, 1.0);
                out.color = model.color;
                return out;
            }
        ").into()),
    });

    // Update default fragment shader to output to all GBuffer targets
    let fragment_shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(&format!("{} Fragment Shader", config.name)),
        source: ShaderSource::Wgsl(config.fragment_shader.as_deref().unwrap_or("
            struct FragmentOutput {
                @location(0) color0: vec4<f32>,
                @location(1) color1: vec4<f32>,
                @location(2) color2: vec4<f32>,
                @location(3) color3: vec4<f32>,
            }
            @fragment
            fn fs_main(@location(0) color: vec4<f32>) -> FragmentOutput {
                var output: FragmentOutput;
                output.color0 = color;
                output.color1 = vec4<f32>(0.0, 0.0, 1.0, 1.0); // Default normal
                output.color2 = vec4<f32>(0.0, 0.0, 0.0, 1.0);
                output.color3 = vec4<f32>(0.0, 0.0, 0.0, 1.0);
                return output;
            }
        ").into()),
    });

    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some(&format!("{} Pipeline Layout", config.name)),
        bind_group_layouts,
        push_constant_ranges: &[],
    });

    // TODO: Parse blend state from config
    let blend_state = Some(wgpu::BlendState {
        color: wgpu::BlendComponent::REPLACE,
        alpha: wgpu::BlendComponent::REPLACE,
    });

    // Create targets for all GBuffer attachments
    let targets: Vec<_> = formats.iter().map(|&format| {
        Some(wgpu::ColorTargetState {
            format,
            blend: blend_state,
            write_mask: wgpu::ColorWrites::ALL,
        })
    }).collect();

    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(&config.name),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState {
            module: &vertex_shader,
            entry_point: Some("vs_main"), // Standard entry point
            buffers: &[Vertex::desc()], // Standard vertex layout
            compilation_options: wgpu::PipelineCompilationOptions::default(),
        },
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
