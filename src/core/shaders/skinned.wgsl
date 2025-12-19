// skinned.wgsl

struct CameraUniform {
    view_proj: mat4x4<f32>,
    position: vec4<f32>,
}
@group(0) @binding(0) var<uniform> camera: CameraUniform;

struct MeshUniforms {
    transform: mat4x4<f32>,
}
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

struct SkinUniforms {
    joints: array<mat4x4<f32>, 256>, // Max 256 joints
}
@group(2) @binding(0) var<uniform> skin: SkinUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
    @location(4) joint_indices: vec4<u32>,
    @location(5) joint_weights: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec4<f32>,
    @location(1) world_normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var skin_matrix = mat4x4<f32>(
        0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0,
        0.0, 0.0, 0.0, 0.0
    );

    for (var i = 0u; i < 4u; i = i + 1u) {
        let joint_index = in.joint_indices[i];
        let joint_weight = in.joint_weights[i];
        if (joint_weight > 0.0) {
            skin_matrix = skin_matrix + joint_weight * skin.joints[joint_index];
        }
    }

    let skinned_position = skin_matrix * vec4(in.position, 1.0);
    let world_position = mesh.transform * skinned_position;
    
    var out: VertexOutput;
    out.clip_position = camera.view_proj * world_position;
    out.world_position = world_position;
    out.world_normal = (mesh.transform * vec4(in.normal, 0.0)).xyz; // transform normal as well
    out.tex_coords = in.tex_coords;
    out.color = in.color;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // For now, just output the vertex color
    return in.color;
}
