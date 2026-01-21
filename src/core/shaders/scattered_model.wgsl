struct CameraUniforms {
    view_projection: mat4x4<f32>
};

struct ModelUniforms {
    model: mat4x4<f32>
};

struct GroupUniforms {
    group: mat4x4<f32>
};

struct WindowSize {
    width: f32,
    height: f32,
};

@group(0) @binding(0) var<uniform> camera_uniforms: CameraUniforms;
@group(1) @binding(0) var<uniform> model_uniforms: ModelUniforms; 
@group(2) @binding(0) var<uniform> window_size: WindowSize;
@group(3) @binding(0) var<uniform> group_uniforms: GroupUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct InstanceInput {
    @location(5) instance_pos: vec3<f32>,
    @location(6) instance_rot: vec4<f32>, // Quaternion
    @location(7) instance_scale: f32,
    @location(8) variation: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) world_pos: vec3<f32>,
    @location(4) variation: f32,
};

fn q_mul_v(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    let q_vec = q.yzw;
    let q_sca = q.x;
    let t = 2.0 * cross(q_vec, v);
    return v + q_sca * t + cross(q_vec, t);
}

@vertex
fn vs_main(input: VertexInput, instance: InstanceInput) -> VertexOutput {
    var output: VertexOutput;
    
    // Apply scale
    let scaled_pos = input.position * instance.instance_scale;
    
    // Apply rotation (quaternion)
    let q = vec4<f32>(instance.instance_rot.w, instance.instance_rot.x, instance.instance_rot.y, instance.instance_rot.z); 
    let rotated_pos = q_mul_v(q, scaled_pos);
    
    // Apply translation
    let world_pos = rotated_pos + instance.instance_pos;
    
    output.position = camera_uniforms.view_projection * vec4<f32>(world_pos, 1.0);
    output.world_pos = world_pos;
    output.color = input.color;
    
    // Rotate normal
    output.normal = q_mul_v(q, input.normal);
    
    output.tex_coords = input.tex_coords;
    output.variation = instance.variation;
    
    return output;
}

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@group(1) @binding(1) var t_diffuse: texture_2d_array<f32>;
@group(1) @binding(2) var s_diffuse: sampler;
@group(1) @binding(3) var<uniform> renderMode: i32;
@group(1) @binding(4) var t_normal: texture_2d_array<f32>;
@group(1) @binding(5) var t_pbr_params: texture_2d_array<f32>;

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;
    
    // 1. Albedo
    let tex_color = textureSample(t_diffuse, s_diffuse, in.tex_coords, 0); // Assuming layer 0
    let final_color = tex_color * in.color;
    
    if (final_color.a < 0.1) {
        discard;
    }
    
    output.albedo = final_color;
    
    // 2. Position
    output.position = vec4<f32>(in.world_pos, 1.0);
    
    // 3. Normal
    // Sample normal map if present (assuming layout matches gbuffer_fragment)
    let normal_map = textureSample(t_normal, s_diffuse, in.tex_coords, 0);
    let unpacked_normal = normalize(normal_map.rgb * 2.0 - 1.0);
    
    // For now, we are just outputting the unpacked normal or vertex normal.
    // Ideally we would do TBN here, but for scattered objects like grass/simple props,
    // vertex normals rotated by instance rotation (in VS) + normal map is a good start.
    // However, without TBN passed from VS, applying normal map correctly to rotated instance is hard.
    // So let's rely on the vertex normal passed from VS (which IS rotated) and mix it?
    // Or just output the vertex normal for now if we don't want to compute TBN.
    
    // Let's use the rotated vertex normal for now to ensure lighting matches rotation.
    output.normal = vec4<f32>(normalize(in.normal), 1.0);
    
    // 4. PBR Material
    let pbr_params = textureSample(t_pbr_params, s_diffuse, in.tex_coords, 0);
    output.pbr_material = vec4<f32>(pbr_params.rgb, 1.0);
    
    return output;
}
