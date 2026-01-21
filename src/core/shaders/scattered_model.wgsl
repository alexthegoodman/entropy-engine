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

struct ScatteredModelConfig {
    player_pos: vec4<f32>,
    radius: f32,
    density: f32,
    seed: f32,
    grid_size: f32,
    landscape_size: f32,
    landscape_height: f32,
    landscape_y_offset: f32,
};

@group(0) @binding(0) var<uniform> camera_uniforms: CameraUniforms;
@group(1) @binding(0) var<uniform> model_uniforms: ModelUniforms; 
@group(2) @binding(0) var<uniform> window_size: WindowSize;
@group(3) @binding(0) var<uniform> group_uniforms: GroupUniforms;
@group(4) @binding(0) var<uniform> config: ScatteredModelConfig;
@group(5) @binding(0) var landscape_texture: texture_2d<f32>;
@group(5) @binding(1) var landscape_sampler: sampler;

struct VertexInput {
    @builtin(instance_index) instance_index: u32,
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) normal: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) world_pos: vec3<f32>,
    @location(4) variation: f32,
};

// ===== HELPER FUNCTIONS =====

fn hash13(p3: vec3<f32>) -> f32 {
    var p = fract(p3 * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}

fn hash23(p3: vec3<f32>) -> vec2<f32> {
    var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.xx + p.yz) * p.zy);
}

fn sample_landscape_height(world_pos: vec2<f32>) -> f32 {
    let landscape_size = config.landscape_size;
    let max_height = config.landscape_height;
    let landscape_y_offset = config.landscape_y_offset;
    
    // World coordinates to UV
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    let avg_model_height = 2.0 / 2.0;
    return (height_sample.r * max_height) + landscape_y_offset + avg_model_height;
}

fn q_mul_v(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    let q_vec = q.yzw;
    let q_sca = q.x;
    let t = 2.0 * cross(q_vec, v);
    return v + q_sca * t + cross(q_vec, t);
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Calculate grid
    let grid_cells = u32(ceil(config.radius * 2.0 / config.grid_size));
    // Estimate instances per cell based on density (this logic must match CPU side logic for total instance count)
    // CPU: instances_per_cell = (settings.density * grid_size * grid_size) as u32;
    let instances_per_cell = u32(config.density * 100.0);
    
    // Avoid division by zero
    let safe_instances_per_cell = max(instances_per_cell, 1u);
    let safe_grid_cells = max(grid_cells, 1u);

    // Decode instance index
    let cell_index = input.instance_index / safe_instances_per_cell;
    let cell_x = cell_index % safe_grid_cells;
    let cell_z = cell_index / safe_grid_cells;
    let instance_in_cell = input.instance_index % safe_instances_per_cell;
    
    // Determine world cell position relative to player
    // We want the grid to move with the player in steps of grid_size
    let player_cell_x = floor(config.player_pos.x / config.grid_size);
    let player_cell_z = floor(config.player_pos.z / config.grid_size);
    
    // Offset by half grid_cells to center around player
    let world_cell_x = player_cell_x + f32(cell_x) - f32(safe_grid_cells) / 2.0;
    let world_cell_z = player_cell_z + f32(cell_z) - f32(safe_grid_cells) / 2.0;
    
    // Generate random position
    let seed = vec3<f32>(world_cell_x, world_cell_z, f32(instance_in_cell) + config.seed);
    let random_offset = hash23(seed);
    
    let instance_x = world_cell_x * config.grid_size + random_offset.x * config.grid_size;
    let instance_z = world_cell_z * config.grid_size + random_offset.y * config.grid_size;
    
    // Sample landscape
    let instance_y = sample_landscape_height(vec2<f32>(instance_x, instance_z));
    let instance_pos = vec3<f32>(instance_x, instance_y, instance_z);
    
    // Distance culling
    if (distance(instance_pos.xz, config.player_pos.xz) > config.radius) {
        // Move vertex out of clip space
        output.position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return output;
    }
    
    // Random rotation (Y axis)
    let rot_y = hash13(seed * 1.23) * 6.28318;
    // Quaternion: w, x, y, z
    let half_angle = rot_y * 0.5;
    let q = vec4<f32>(cos(half_angle), 0.0, sin(half_angle), 0.0);
    
    // Random scale
    let scale = 0.8 + hash13(seed * 4.56) * 0.4;
    
    // Apply transforms
    let scaled_pos = input.position * scale;
    let rotated_pos = q_mul_v(q, scaled_pos);
    let world_pos = rotated_pos + instance_pos;
    
    output.position = camera_uniforms.view_projection * vec4<f32>(world_pos, 1.0);
    output.world_pos = world_pos;
    output.color = input.color;
    output.normal = q_mul_v(q, input.normal);
    output.tex_coords = input.tex_coords;
    output.variation = hash13(seed * 7.89);
    
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
    // Use rotated vertex normal
    output.normal = vec4<f32>(normalize(in.normal), 1.0);
    
    // 4. PBR Material
    let pbr_params = textureSample(t_pbr_params, s_diffuse, in.tex_coords, 0);
    output.pbr_material = vec4<f32>(pbr_params.rgb, 1.0);
    
    return output;
}
