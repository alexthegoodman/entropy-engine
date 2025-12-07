// // src/procedural_grass/grass.wgsl

// struct Camera {
//     view_proj: mat4x4<f32>,
// };
// @group(0) @binding(0)
// var<uniform> camera: Camera;

// struct GrassUniforms {
//     time: f32,
//     player_pos: vec4<f32>,  // Use w component as padding, or for height
// }
// @group(1) @binding(0)
// var<uniform> uniforms: GrassUniforms;

// struct VertexInput {
//     @location(0) position: vec3<f32>,
//     @location(1) tex_coords: vec2<f32>,
//     @location(2) normal: vec3<f32>,
//     @location(3) color: vec4<f32>,
// };

// struct InstanceInput {
//     @location(5) model_matrix_0: vec4<f32>,
//     @location(6) model_matrix_1: vec4<f32>,
//     @location(7) model_matrix_2: vec4<f32>,
//     @location(8) model_matrix_3: vec4<f32>,
// };

// struct VertexOutput {
//     @builtin(position) clip_position: vec4<f32>,
//     @location(0) color: vec4<f32>,
// };

// // 2D Simplex noise function (public domain)
// fn mod289_v2(x: vec2<f32>) -> vec2<f32> {
//     return x - floor(x * (1.0 / 289.0)) * 289.0;
// }
// fn mod289_v3(x: vec3<f32>) -> vec3<f32> {
//     return x - floor(x * (1.0 / 289.0)) * 289.0;
// }
// fn permute(x: vec3<f32>) -> vec3<f32> {
//     return mod289_v3(((x * 34.0) + 1.0) * x);
// }
// fn snoise(v: vec2<f32>) -> f32 {
//     let C = vec2<f32>(0.211324865405187, 0.366025403784439);
//     let i = floor(v + dot(v, C.yy));
//     let x0 = v - i + dot(i, C.xx);
//     let i1 = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), x0.x > x0.y);
//     let x1 = x0.xy - i1 + C.xx;
//     let x2 = x0.xy - 1.0 + 2.0 * C.xx;
//     let i_ = mod289_v2(i);
//     let p = permute(permute(i_.y + vec3<f32>(0.0, i1.y, 1.0)) + i_.x + vec3<f32>(0.0, i1.x, 1.0));
//     var m = max(0.5 - vec3<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3<f32>(0.0));
//     m = m * m;
//     m = m * m;
//     // let x = 2.0 * fract(p * C.www) - 1.0;
//     let x = 2.0 * fract(p * C.xxx) - 1.0;
//     let h = abs(x) - 0.5;
//     let ox = floor(x + 0.5);
//     let a0 = x - ox;
//     m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
//     let g = vec3<f32>(a0.x * x0.x + h.x * x0.y, a0.yz * x1.xy + h.yz * x1.yx);
//     return 130.0 * dot(m, g);
// }


// @vertex
// fn vs_main(
//     model: VertexInput,
//     instance: InstanceInput,
// ) -> VertexOutput {
//     let model_matrix = mat4x4<f32>(
//         instance.model_matrix_0,
//         instance.model_matrix_1,
//         instance.model_matrix_2,
//         instance.model_matrix_3,
//     );

//     let world_pos = model_matrix * vec4<f32>(model.position, 1.0);

//     // -- Wind Sway --
//     let wind_strength = 0.05;
//     // let wind_speed = 2.0;
//     let wind_speed = 0.2;
//     let wind_scale = 0.5;
//     let noise_coord = world_pos.xz * wind_scale + uniforms.time * wind_speed;
//     let wind_noise = snoise(noise_coord);
//     let wind_displacement = vec3<f32>(wind_noise, 0.0, wind_noise) * wind_strength;
    
//     // Apply sway only to the top part of the grass blade
//     let sway_factor = smoothstep(0.5, 1.0, model.position.y);
//     let final_wind_disp = wind_displacement * sway_factor;

//     // -- Player Interaction --
//     let interaction_radius = 3.0;
//     let instance_pos = model_matrix[3].xyz;
//     let dist_to_player = distance(instance_pos, uniforms.player_pos.xyz);
//     var interaction_disp = vec3<f32>(0.0);

//     if (dist_to_player < interaction_radius) {
//         let push_dir = normalize(instance_pos - uniforms.player_pos.xyz);
//         // let push_strength = (1.0 - (dist_to_player / interaction_radius)) * 0.5;
//         let push_strength = (1.0 - (dist_to_player / interaction_radius)) * 1.5;
//         interaction_disp = push_dir * push_strength * sway_factor;
//     }

//     let final_pos = world_pos + vec4<f32>(final_wind_disp + interaction_disp, 0.0);

//     var out: VertexOutput;
//     out.clip_position = camera.view_proj * final_pos;
//     out.color = model.color;
//     return out;
// }

// @fragment
// fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
//     return vec4<f32>(0.2, 0.8, 0.3, 1.0); // A nice green color for grass
// }

// src/procedural_grass/grass.wgsl

struct Camera {
    view_proj: mat4x4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct GrassUniforms {
    time: f32,
    grid_size: f32,
    render_distance: f32,
    wind_strength: f32,
    player_pos: vec4<f32>,
    wind_speed: f32,
    blade_height: f32,
    blade_width: f32,
    brownian_strength: f32,
    blade_density: f32, // NEW
}
@group(1) @binding(0)
var<uniform> uniforms: GrassUniforms;

// Landscape texture array and sampler for height/normal sampling
@group(2) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(2) @binding(1)
var landscape_sampler: sampler;

// Which layer in the texture array contains height data
// Based on your LandscapeTextureKinds enum:
// 0: Primary, 1: PrimaryMask, 2: Rockmap, 3: RockmapMask, 4: Soil, 5: SoilMask
const HEIGHTMAP_LAYER: i32 = 0; // Change this to whichever layer has your height data

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
    @location(0) position: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) normal: vec3<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) height_factor: f32,
    @location(2) blade_id: f32,
};

// ===== LANDSCAPE SAMPLING =====

// Sample height from landscape texture array
fn sample_landscape_height(world_pos: vec2<f32>) -> f32 {
    // return -5.0;

    // Your terrain dimensions from Rust code:
    // square_size = 1024.0 * 4.0 = 4096.0
    // square_height = 150.0 * 4.0 = 600.0
    let landscape_size = 4096.0; // Match your square_size
    let max_height = 600.0; // Match your square_height
    
    // World coordinates are centered, so normalize to 0-1 UV space
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    
    // Clamp UV to valid range to avoid sampling outside texture
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
    // Use textureSampleLevel for vertex shader (explicit LOD = 0)
    // let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, HEIGHTMAP_LAYER, 0.0);
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    
    // Your heightmap is normalized (0-1), so scale to actual height
    // The R channel contains the normalized height value
    return (height_sample.r * max_height) - 500.0; // hardcoded landscape offset from generic properties!
}

// Calculate terrain normal by sampling nearby heights
fn sample_landscape_normal(world_pos: vec2<f32>) -> vec3<f32> {
    let offset = 2.0; // Sample distance - adjust based on terrain detail
    
    let h_center = sample_landscape_height(world_pos);
    let h_right = sample_landscape_height(world_pos + vec2<f32>(offset, 0.0));
    let h_up = sample_landscape_height(world_pos + vec2<f32>(0.0, offset));
    
    // Calculate tangent vectors
    let tangent_x = vec3<f32>(offset, h_right - h_center, 0.0);
    let tangent_z = vec3<f32>(0.0, h_up - h_center, offset);
    
    // Cross product gives us the normal
    return normalize(cross(tangent_z, tangent_x));
}

// ===== NOISE FUNCTIONS =====

// Hash function for pseudo-random numbers
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

fn hash33(p3: vec3<f32>) -> vec3<f32> {
    var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

// 2D Simplex noise
fn mod289_v2(x: vec2<f32>) -> vec2<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn mod289_v3(x: vec3<f32>) -> vec3<f32> {
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

fn permute(x: vec3<f32>) -> vec3<f32> {
    return mod289_v3(((x * 34.0) + 1.0) * x);
}

fn snoise(v: vec2<f32>) -> f32 {
    let C = vec2<f32>(0.211324865405187, 0.366025403784439);
    let i = floor(v + dot(v, C.yy));
    let x0 = v - i + dot(i, C.xx);
    let i1 = select(vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), x0.x > x0.y);
    let x1 = x0.xy - i1 + C.xx;
    let x2 = x0.xy - 1.0 + 2.0 * C.xx;
    let i_ = mod289_v2(i);
    let p = permute(permute(i_.y + vec3<f32>(0.0, i1.y, 1.0)) + i_.x + vec3<f32>(0.0, i1.x, 1.0));
    var m = max(0.5 - vec3<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2)), vec3<f32>(0.0));
    m = m * m;
    m = m * m;
    let x = 2.0 * fract(p * C.xxx) - 1.0;
    let h = abs(x) - 0.5;
    let ox = floor(x + 0.5);
    let a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    let g = vec3<f32>(a0.x * x0.x + h.x * x0.y, a0.yz * x1.xy + h.yz * x1.yx);
    return 130.0 * dot(m, g);
}

// Brownian motion (fractional Brownian motion)
fn fbm(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    
    for (var i = 0; i < 4; i++) {
        value += amplitude * snoise(p * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    
    return value;
}

// ===== MAIN VERTEX SHADER =====

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // // Calculate grid cell from instance index
    // let grid_cells = u32(ceil(uniforms.render_distance * 2.0 / uniforms.grid_size));
    // let blades_per_cell = grid_cells * grid_cells;
    
    // let cell_x = (in.instance_index / blades_per_cell) % grid_cells;
    // let cell_z = (in.instance_index / blades_per_cell) / grid_cells;
    // let blade_in_cell = in.instance_index % blades_per_cell;

    // Calculate grid cell count
    let grid_cells = u32(ceil(uniforms.render_distance * 2.0 / uniforms.grid_size));

    // Number of blades per cell (from uniform)
    let blades_per_cell = u32(uniforms.blade_density);

    // total instances expected: grid_cells * grid_cells * blades_per_cell
    // decode instance_index -> (cell_x, cell_z, blade_in_cell)
    let cell_index = in.instance_index / blades_per_cell;
    let cell_x = cell_index % grid_cells;
    let cell_z = cell_index / grid_cells;
    let blade_in_cell = in.instance_index % blades_per_cell;
    
    // Calculate cell position relative to player
    let player_cell_x = floor(uniforms.player_pos.x / uniforms.grid_size);
    let player_cell_z = floor(uniforms.player_pos.z / uniforms.grid_size);
    
    let world_cell_x = player_cell_x + f32(cell_x) - f32(grid_cells) / 2.0;
    let world_cell_z = player_cell_z + f32(cell_z) - f32(grid_cells) / 2.0;
    
    // Generate pseudo-random position within cell
    let seed = vec3<f32>(world_cell_x, world_cell_z, f32(blade_in_cell));
    let random_offset = hash23(seed);
    
    let blade_x = world_cell_x * uniforms.grid_size + random_offset.x * uniforms.grid_size;
    let blade_z = world_cell_z * uniforms.grid_size + random_offset.y * uniforms.grid_size;
    
    // Sample landscape height at this position
    let blade_y = sample_landscape_height(vec2<f32>(blade_x, blade_z));
    
    // Get terrain normal for grass orientation
    let terrain_normal = sample_landscape_normal(vec2<f32>(blade_x, blade_z));
    
    let blade_pos = vec3<f32>(blade_x, blade_y, blade_z);
    
    // Distance culling - discard if too far from player
    let dist_to_player = distance(blade_pos.xz, uniforms.player_pos.xz);
    if (dist_to_player > uniforms.render_distance) {
        // Move off-screen
        out.clip_position = vec4<f32>(0.0, 0.0, 0.0, 0.0);
        return out;
    }
    
    // Random blade properties
    let blade_seed = hash13(seed);
    let blade_height_variation = 0.7 + blade_seed * 0.6; // 0.7 to 1.3
    let blade_rotation = hash13(seed * 7.31) * 6.28318; // Random rotation
    
    // Create rotation matrix to align with terrain normal
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let rotation_axis = cross(up, terrain_normal);
    let rotation_angle = acos(dot(up, terrain_normal));
    
    // Apply blade rotation around terrain normal
    let cos_r = cos(blade_rotation);
    let sin_r = sin(blade_rotation);
    
    // First rotate around Y for variety
    var rotated_x = in.position.x * cos_r - in.position.z * sin_r;
    var rotated_z = in.position.x * sin_r + in.position.z * cos_r;
    
    // Scale the blade
    var local_pos = vec3<f32>(
        rotated_x * uniforms.blade_width,
        in.position.y * uniforms.blade_height * blade_height_variation,
        rotated_z * uniforms.blade_width
    );
    
    // Align grass with terrain normal using Rodrigues' rotation formula
    if (length(rotation_axis) > 0.001) {
        let axis = normalize(rotation_axis);
        let cos_a = cos(rotation_angle);
        let sin_a = sin(rotation_angle);
        
        // Rodrigues' rotation formula
        local_pos = local_pos * cos_a + 
                    cross(axis, local_pos) * sin_a + 
                    axis * dot(axis, local_pos) * (1.0 - cos_a);
    };
    
    // Height factor for effects (0 at base, 1 at tip)
    let height_factor = in.position.y;
    
    // ===== WIND WITH BROWNIAN MOTION =====
    let wind_coord = blade_pos.xz * 0.1 + uniforms.time * uniforms.wind_speed * 0.1;
    let wind_fbm = fbm(wind_coord);
    
    // Multi-octave wind for more natural movement
    let wind_main = snoise(wind_coord * 0.5);
    let wind_detail = snoise(wind_coord * 2.0) * 0.3;
    let combined_wind = (wind_main + wind_detail + wind_fbm * 0.5) * uniforms.wind_strength;
    
    // Apply wind displacement with Brownian motion
    let wind_disp = vec3<f32>(
        combined_wind * cos(uniforms.time * 0.5 + blade_seed * 6.28),
        0.0,
        combined_wind * sin(uniforms.time * 0.5 + blade_seed * 6.28)
    );
    
    // ===== BROWNIAN FORCE (Natural random motion) =====
    let brownian_time = uniforms.time * 2.0 + blade_seed * 10.0;
    let brownian_x = snoise(vec2<f32>(brownian_time, blade_seed * 100.0)) * uniforms.brownian_strength;
    let brownian_z = snoise(vec2<f32>(brownian_time + 50.0, blade_seed * 100.0)) * uniforms.brownian_strength;
    let brownian_disp = vec3<f32>(brownian_x, 0.0, brownian_z);
    
    // ===== PLAYER INTERACTION =====
    let interaction_radius = 4.0;
    let dist_to_player_3d = distance(blade_pos, uniforms.player_pos.xyz);
    var interaction_disp = vec3<f32>(0.0);
    
    if (dist_to_player_3d < interaction_radius) {
        let push_dir = normalize(blade_pos - uniforms.player_pos.xyz);
        let push_strength = (1.0 - (dist_to_player_3d / interaction_radius)) * 2.0;
        interaction_disp = push_dir * push_strength;
    }
    
    // ===== COMBINE ALL FORCES =====
    // Apply all effects with height-based falloff (more effect at tip)
    let height_curve = height_factor * height_factor; // Quadratic for more natural bend
    let total_displacement = (wind_disp + brownian_disp + interaction_disp) * height_curve;
    
    // Final world position
    let world_position = blade_pos + local_pos + total_displacement;
    
    out.world_pos = world_position;
    out.clip_position = camera.view_proj * vec4<f32>(world_position, 1.0);
    out.height_factor = height_factor;
    out.blade_id = blade_seed;
    
    return out;
}

// ===== FRAGMENT SHADER =====

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Gradient from dark green at base to lighter green at tip
    let base_color = vec3<f32>(0.15, 0.4, 0.15);
    let tip_color = vec3<f32>(0.3, 0.7, 0.25);
    
    let grass_color = mix(base_color, tip_color, in.height_factor);
    
    // Add some variation per blade
    let color_variation = hash13(vec3<f32>(in.blade_id * 100.0, 0.0, 0.0)) * 0.1;
    let final_color = grass_color + color_variation;
    
    // Simple lighting based on height (ambient occlusion approximation)
    let ao = 0.7 + in.height_factor * 0.3;
    
    return vec4<f32>(final_color * ao, 1.0);
}