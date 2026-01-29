use wgpu::{self, Device, RenderPipeline, ShaderModuleDescriptor, ShaderSource};
use crate::deno::addon_engine::PipelineConfig;
use crate::core::vertex::Vertex; // Assuming standard vertex for now

pub fn create_addon_pipeline(
    device: &Device,
    config: &PipelineConfig,
    bind_group_layouts: &[&wgpu::BindGroupLayout],
    format: wgpu::TextureFormat, // Output format (e.g. Surface or GBuffer)
    depth_format: Option<wgpu::TextureFormat>,
) -> RenderPipeline {
    let vertex_shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(&format!("{} Vertex Shader", config.name)),
        source: ShaderSource::Wgsl(config.vertex_shader.as_str().into()),
    });

    let fragment_shader = device.create_shader_module(ShaderModuleDescriptor {
        label: Some(&format!("{} Fragment Shader", config.name)),
        source: ShaderSource::Wgsl(config.fragment_shader.as_str().into()),
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

    // For now, assuming G-Buffer output format if multiple targets are needed, 
    // or just using the passed format for a single target.
    // If the addon renders to the main pass, it might need to match G-Buffer.
    // Let's assume for this initial implementation it renders to a forward pass or overlay.
    
    let targets = [Some(wgpu::ColorTargetState {
        format,
        blend: blend_state,
        write_mask: wgpu::ColorWrites::ALL,
    })];

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
