// src/procedural_trees/trees.wgsl

struct Camera {
    view_proj: mat4x4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct TreeUniforms {
    time: f32,
}
@group(1) @binding(0)
var<uniform> uniforms: TreeUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) color: vec4<f32>,
};

struct InstanceInput {
    @location(5) position: vec3<f32>,
    @location(6) scale: f32,
    @location(7) rotation: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) color: vec4<f32>,
};

fn rotation_matrix(axis: vec3<f32>, angle: f32) -> mat3x3<f32> {
    let s = sin(angle);
    let c = cos(angle);
    let oc = 1.0 - c;
    
    return mat3x3<f32>(
        oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,
        oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,
        oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c
    );
}

@vertex
fn vs_main(
    model: VertexInput,
    instance: InstanceInput,
) -> VertexOutput {
    var out: VertexOutput;

    let rot_x = rotation_matrix(vec3<f32>(1.0, 0.0, 0.0), instance.rotation.x);
    let rot_y = rotation_matrix(vec3<f32>(0.0, 1.0, 0.0), instance.rotation.y);
    let rot_z = rotation_matrix(vec3<f32>(0.0, 0.0, 1.0), instance.rotation.z);
    let rotation = rot_z * rot_y * rot_x;

    let world_pos = instance.position + rotation * (model.position * instance.scale);
    let world_normal = rotation * model.normal;

    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.world_pos = world_pos;
    out.normal = world_normal;
    out.color = model.color;
    return out;
}

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;
    output.position = vec4<f32>(in.world_pos, 1.0);
    output.normal = vec4<f32>(normalize(in.normal), 1.0);
    output.albedo = in.color;
    output.pbr_material = vec4<f32>(0.0, 0.9, 1.0, 1.0); // Metallic=0, Roughness=0.9, AO=1.0

    return output;
}
