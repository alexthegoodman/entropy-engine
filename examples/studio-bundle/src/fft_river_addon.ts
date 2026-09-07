// ============================================================================
// FFT RIVER WATER - Landscape-Aware Dynamic Water
// Samples terrain to place realistic water bodies in natural locations
// ============================================================================

// ===== COMPUTE SHADERS (from FFT Ocean) =====

const SPECTRUM_INIT_SHADER = `
struct SpectrumParams {
    resolution: f32,
    ocean_size: f32,
    wind_speed: f32,
    wind_direction_x: f32,
    wind_direction_y: f32,
    amplitude: f32,
    gravity: f32,
    padding: f32,
}

@group(0) @binding(0)
var output_h0: texture_storage_2d<rgba16float, write>;

@group(0) @binding(1)
var<uniform> params: SpectrumParams;

fn hash(p: vec2<f32>) -> f32 {
    let p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.13);
    let p3_dot = dot(p3, vec3<f32>(p3.y + 3.333, p3.z + 3.333, p3.x + 3.333));
    return fract((p.x + p.y) * p3_dot);
}

fn gaussian_random(uv: vec2<f32>) -> vec2<f32> {
    let u1 = hash(uv);
    let u2 = hash(uv + vec2<f32>(127.1, 311.7));
    let r = sqrt(-2.0 * log(u1 + 0.0001));
    let theta = 6.28318530718 * u2;
    return vec2<f32>(r * cos(theta), r * sin(theta));
}

fn phillips_spectrum(k: vec2<f32>) -> f32 {
    let k_length = length(k);
    if (k_length < 0.0001) {
        return 0.0;
    }
    
    let L = (params.wind_speed * params.wind_speed) / params.gravity;
    let k_length2 = k_length * k_length;
    let k_length4 = k_length2 * k_length2;
    
    let wind_dir = normalize(vec2<f32>(params.wind_direction_x, params.wind_direction_y));
    let k_normalized = k / k_length;
    let k_dot_w = dot(k_normalized, wind_dir);
    let k_dot_w2 = k_dot_w * k_dot_w;
    
    let damping = 0.001;
    let l2 = L * L * damping * damping;
    
    let phillips = params.amplitude * 
                   exp(-1.0 / (k_length2 * L * L)) / k_length4 *
                   k_dot_w2 *
                   exp(-k_length2 * l2);
    
    return phillips;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let n = vec2<f32>(f32(id.x) - f32(N) * 0.5, f32(id.y) - f32(N) * 0.5);
    let k = (2.0 * 3.14159265359 * n) / params.ocean_size;
    let ph = phillips_spectrum(k);
    let uv = vec2<f32>(f32(id.x), f32(id.y)) / f32(N);
    let xi = gaussian_random(uv);
    let h0 = xi * sqrt(ph * 0.5);
    textureStore(output_h0, vec2<i32>(id.xy), vec4<f32>(h0.x, h0.y, -h0.x, -h0.y));
}
`;

const SPECTRUM_UPDATE_SHADER = `
struct TimeParams {
    time: f32,
    resolution: f32,
    ocean_size: f32,
    gravity: f32,
    choppiness: f32,
    padding1: f32,
    padding2: f32,
    padding3: f32,
}

@group(0) @binding(0)
var input_h0: texture_2d<f32>;

@group(0) @binding(1)
var output_ht: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var<uniform> params: TimeParams;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let n = vec2<f32>(f32(id.x) - f32(N) * 0.5, f32(id.y) - f32(N) * 0.5);
    let k = (2.0 * 3.14159265359 * n) / params.ocean_size;
    let k_length = length(k);
    let omega = sqrt(params.gravity * k_length);
    
    let h0_k = textureLoad(input_h0, vec2<i32>(id.xy), 0);
    let h0_k_val = vec2<f32>(h0_k.x, h0_k.y);
    let h0_minus_k_conj = vec2<f32>(h0_k.z, h0_k.w);
    
    let omega_t = omega * params.time;
    let exp_iwt = vec2<f32>(cos(omega_t), sin(omega_t));
    let exp_minus_iwt = vec2<f32>(cos(omega_t), -sin(omega_t));
    let ht = cmul(h0_k_val, exp_iwt) + cmul(h0_minus_k_conj, exp_minus_iwt);
    
    var dx = vec2<f32>(0.0);
    var dz = vec2<f32>(0.0);
    
    if (k_length > 0.0001) {
        let k_norm = k / k_length;
        dx = vec2<f32>(ht.y, -ht.x) * k_norm.x * params.choppiness;
        dz = vec2<f32>(ht.y, -ht.x) * k_norm.y * params.choppiness;
    }
    
    textureStore(output_ht, vec2<i32>(id.xy), vec4<f32>(ht.x, ht.y, dx.x, dz.x));
}
`;

const FFT_HORIZONTAL_SHADER = `
struct FFTParams {
    resolution: f32,
    stage: f32,
    direction: f32,
    pingpong: f32,
}

@group(0) @binding(0)
var input_tex: texture_2d<f32>;

@group(0) @binding(1)
var output_tex: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var<uniform> params: FFTParams;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let stage = u32(params.stage);
    let butterflySpan = 1u << stage;
    let butterflyWing = butterflySpan >> 1u;
    
    let x = id.x;
    let y = id.y;
    
    let topWing = (x / butterflySpan) * butterflySpan + (x % butterflyWing);
    let bottomWing = topWing + butterflyWing;
    
    var x1: u32;
    var x2: u32;
    
    if (stage == 0u) {
        x1 = bitReverse(topWing) >> (32u - u32(log2(f32(N))));
        x2 = bitReverse(bottomWing) >> (32u - u32(log2(f32(N))));
    } else {
        x1 = topWing;
        x2 = bottomWing;
    }
    
    let p = textureLoad(input_tex, vec2<i32>(i32(x1), i32(y)), 0);
    let q = textureLoad(input_tex, vec2<i32>(i32(x2), i32(y)), 0);
    
    let k = f32(x % butterflySpan);
    let angle = -6.28318530718 * k / f32(butterflySpan * 2u);
    let twiddle = vec2<f32>(cos(angle), sin(angle));
    
    let h_val = vec2<f32>(p.x, p.y);
    let d_val = vec2<f32>(p.z, p.w);
    let q_h = vec2<f32>(q.x, q.y);
    let q_d = vec2<f32>(q.z, q.w);
    
    let h_result = h_val + cmul(twiddle, q_h);
    let d_result = d_val + cmul(twiddle, q_d);
    
    textureStore(output_tex, vec2<i32>(id.xy), vec4<f32>(h_result, d_result));
}

fn bitReverse(x: u32) -> u32 {
    var result = x;
    result = ((result & 0xAAAAAAAAu) >> 1u) | ((result & 0x55555555u) << 1u);
    result = ((result & 0xCCCCCCCCu) >> 2u) | ((result & 0x33333333u) << 2u);
    result = ((result & 0xF0F0F0F0u) >> 4u) | ((result & 0x0F0F0F0Fu) << 4u);
    result = ((result & 0xFF00FF00u) >> 8u) | ((result & 0x00FF00FFu) << 8u);
    result = (result >> 16u) | (result << 16u);
    return result;
}
`;

const FFT_VERTICAL_SHADER = `
struct FFTParams {
    resolution: f32,
    stage: f32,
    direction: f32,
    pingpong: f32,
}

@group(0) @binding(0)
var input_tex: texture_2d<f32>;

@group(0) @binding(1)
var output_tex: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var<uniform> params: FFTParams;

fn cmul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let stage = u32(params.stage);
    let butterflySpan = 1u << stage;
    let butterflyWing = butterflySpan >> 1u;
    
    let x = id.x;
    let y = id.y;
    
    let topWing = (y / butterflySpan) * butterflySpan + (y % butterflyWing);
    let bottomWing = topWing + butterflyWing;
    
    var y1: u32;
    var y2: u32;
    
    if (stage == 0u) {
        y1 = bitReverse(topWing) >> (32u - u32(log2(f32(N))));
        y2 = bitReverse(bottomWing) >> (32u - u32(log2(f32(N))));
    } else {
        y1 = topWing;
        y2 = bottomWing;
    }
    
    let p = textureLoad(input_tex, vec2<i32>(i32(x), i32(y1)), 0);
    let q = textureLoad(input_tex, vec2<i32>(i32(x), i32(y2)), 0);
    
    let k = f32(y % butterflySpan);
    let angle = -6.28318530718 * k / f32(butterflySpan * 2u);
    let twiddle = vec2<f32>(cos(angle), sin(angle));
    
    let h_val = vec2<f32>(p.x, p.y);
    let d_val = vec2<f32>(p.z, p.w);
    let q_h = vec2<f32>(q.x, q.y);
    let q_d = vec2<f32>(q.z, q.w);
    
    let h_result = h_val + cmul(twiddle, q_h);
    let d_result = d_val + cmul(twiddle, q_d);
    
    textureStore(output_tex, vec2<i32>(id.xy), vec4<f32>(h_result, d_result));
}

fn bitReverse(x: u32) -> u32 {
    var result = x;
    result = ((result & 0xAAAAAAAAu) >> 1u) | ((result & 0x55555555u) << 1u);
    result = ((result & 0xCCCCCCCCu) >> 2u) | ((result & 0x33333333u) << 2u);
    result = ((result & 0xF0F0F0F0u) >> 4u) | ((result & 0x0F0F0F0Fu) << 4u);
    result = ((result & 0xFF00FF00u) >> 8u) | ((result & 0x00FF00FFu) << 8u);
    result = (result >> 16u) | (result << 16u);
    return result;
}
`;

// ===== FLOW ACCUMULATION SHADER =====
// Detects natural river paths by simulating water flow downhill

const FLOW_ACCUMULATION_SHADER = `
// This shader traces water flow across the terrain to find river paths
// Each pixel accumulates flow from uphill neighbors

struct FlowParams {
    landscape_size: f32,
    max_height: f32,
    landscape_y_offset: f32,
    resolution: f32,
    min_flow_threshold: f32,  // Minimum accumulation to show as river
    use_manual_rivers: f32,   // 1.0 if using manual drawing
    padding2: f32,
    padding3: f32,
}

@group(0) @binding(0)
var landscape_texture: texture_2d<f32>;

@group(0) @binding(1)
var landscape_sampler: sampler;

@group(0) @binding(2)
var output_flow: texture_storage_2d<rgba16float, write>;

@group(0) @binding(3)
var<uniform> params: FlowParams;

@group(0) @binding(4)
var manual_river_texture: texture_2d<f32>;

fn sample_height(uv: vec2<f32>) -> f32 {
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    return (height_sample.r * params.max_height) + params.landscape_y_offset;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    
    // Current pixel's UV
    let pixel_size = 1.0 / f32(N);
    let uv = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5) * pixel_size;
    
    let center_height = sample_height(uv);
    
    // Check 8 neighboring pixels
    var flow_accumulation = 1.0; // Start with 1 (the pixel itself)

    // Manual drawing influence
    let manual_mask = textureLoad(manual_river_texture, vec2<i32>(id.xy), 0).r;
    
    if (params.use_manual_rivers > 0.5) {
        flow_accumulation = manual_mask * 50.0; // Significant flow where drawn
    }
    
    // Offsets for 8-connected neighbors
    let offsets = array<vec2<f32>, 8>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0,  0.0),                        vec2<f32>(1.0,  0.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>(0.0,  1.0), vec2<f32>(1.0,  1.0)
    );
    
    // For each neighbor, check if water would flow FROM neighbor TO center
    for (var i = 0; i < 8; i++) {
        let neighbor_uv = uv + offsets[i] * pixel_size;
        let neighbor_height = sample_height(neighbor_uv);
        
        // Water flows downhill - if neighbor is higher, it contributes flow
        if (neighbor_height > center_height) {
            let height_diff = neighbor_height - center_height;
            let flow_contribution = height_diff * 0.1; // Weight by slope
            
            // If manual mode is on, we still want to accumulate flow from neighbors 
            // if they are also part of the manual path or just generally downhill
            flow_accumulation += flow_contribution;
        }
    }
    
    // Calculate slope (how steep is this location)
    let right_height = sample_height(uv + vec2<f32>(pixel_size, 0.0));
    let up_height = sample_height(uv + vec2<f32>(0.0, pixel_size));
    let slope = length(vec2<f32>(right_height - center_height, up_height - center_height));
    
    // Store: (flow_accumulation, slope, height, 1.0)
    textureStore(output_flow, vec2<i32>(id.xy), vec4<f32>(flow_accumulation, slope, center_height, 1.0));
}
`;

// ===== MULTI-PASS FLOW PROPAGATION SHADER =====
// Iteratively propagates flow downstream for more accurate river detection

const FLOW_PROPAGATION_SHADER = `
struct FlowParams {
    landscape_size: f32,
    max_height: f32,
    landscape_y_offset: f32,
    resolution: f32,
    iteration: f32,
    total_iterations: f32,
    padding1: f32,
    padding2: f32,
}

@group(0) @binding(0)
var landscape_texture: texture_2d<f32>;

@group(0) @binding(1)
var input_flow: texture_2d<f32>;

@group(0) @binding(2)
var output_flow: texture_storage_2d<rgba16float, write>;

@group(0) @binding(3)
var<uniform> params: FlowParams;

fn sample_height(uv: vec2<f32>) -> f32 {
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let height_sample = textureSampleLevel(landscape_texture, texture_sampler, clamped_uv, 0.0);
    return (height_sample.r * params.max_height) + params.landscape_y_offset;
}

@group(0) @binding(4)
var texture_sampler: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let pixel_size = 1.0 / f32(N);
    let uv = vec2<f32>(f32(id.x) + 0.5, f32(id.y) + 0.5) * pixel_size;
    
    // Read current flow data
    let current_flow = textureLoad(input_flow, vec2<i32>(id.xy), 0);
    var accumulated_flow = current_flow.x;
    let center_height = sample_height(uv);
    
    // 8-connected neighbors
    let offsets = array<vec2<f32>, 8>(
        vec2<f32>(-1.0, -1.0), vec2<f32>(0.0, -1.0), vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0,  0.0),                        vec2<f32>(1.0,  0.0),
        vec2<f32>(-1.0,  1.0), vec2<f32>(0.0,  1.0), vec2<f32>(1.0,  1.0)
    );
    
    let diagonal_dist = 1.414;
    let distances = array<f32, 8>(
        diagonal_dist, 1.0, diagonal_dist,
        1.0,                1.0,
        diagonal_dist, 1.0, diagonal_dist
    );
    
    // Propagate flow from uphill neighbors
    for (var i = 0; i < 8; i++) {
        let neighbor_pixel = vec2<i32>(id.xy) + vec2<i32>(i32(offsets[i].x), i32(offsets[i].y));
        
        // Bounds check
        if (neighbor_pixel.x >= 0 && neighbor_pixel.x < i32(N) && 
            neighbor_pixel.y >= 0 && neighbor_pixel.y < i32(N)) {
            
            let neighbor_uv = uv + offsets[i] * pixel_size;
            let neighbor_height = sample_height(neighbor_uv);
            let neighbor_flow_data = textureLoad(input_flow, neighbor_pixel, 0);
            let neighbor_flow = neighbor_flow_data.x;
            
            // If neighbor is higher, it contributes its accumulated flow
            if (neighbor_height > center_height + 0.1) {
                let slope = (neighbor_height - center_height) / distances[i];
                let flow_fraction = slope / (slope + 0.1); // More flow on steeper slopes
                accumulated_flow += neighbor_flow * flow_fraction * 0.5;
            }
        }
    }
    
    // Calculate slope
    let right_height = sample_height(uv + vec2<f32>(pixel_size, 0.0));
    let up_height = sample_height(uv + vec2<f32>(0.0, pixel_size));
    let slope = length(vec2<f32>(right_height - center_height, up_height - center_height));
    
    textureStore(output_flow, vec2<i32>(id.xy), vec4<f32>(accumulated_flow, slope, center_height, 1.0));
}
`;

const DISPLACEMENT_SHADER = `
struct OutputParams {
    resolution: f32,
    ocean_size: f32,
    choppiness: f32,
    padding: f32,
}

@group(0) @binding(0)
var input_fft: texture_2d<f32>;

@group(0) @binding(1)
var output_displacement: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var output_derivatives: texture_storage_2d<rgba16float, write>;

@group(0) @binding(3)
var<uniform> params: OutputParams;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let fft_data = textureLoad(input_fft, vec2<i32>(id.xy), 0);
    
    let normalized = fft_data / f32(N);
    let height = normalized.x;
    let choppy_x = normalized.z;
    let choppy_z = normalized.w;
    
    let sign_correction = select(1.0, -1.0, ((id.x + id.y) % 2u) == 1u);
    
    let displacement = vec3<f32>(
        choppy_x * sign_correction * params.choppiness,
        height * sign_correction,
        choppy_z * sign_correction * params.choppiness
    );
    
    let x_next = (id.x + 1u) % N;
    let x_prev = select(id.x - 1u, N - 1u, id.x == 0u);
    let y_next = (id.y + 1u) % N;
    let y_prev = select(id.y - 1u, N - 1u, id.y == 0u);
    
    let h_right = textureLoad(input_fft, vec2<i32>(i32(x_next), i32(id.y)), 0).x;
    let h_left = textureLoad(input_fft, vec2<i32>(i32(x_prev), i32(id.y)), 0).x;
    let h_top = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_next)), 0).x;
    let h_bottom = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_prev)), 0).x;
    
    let texel_size = params.ocean_size / f32(N);
    let dhdx = (h_right - h_left) / (2.0 * texel_size);
    let dhdz = (h_top - h_bottom) / (2.0 * texel_size);
    
    let dx_right = textureLoad(input_fft, vec2<i32>(i32(x_next), i32(id.y)), 0).z;
    let dx_left = textureLoad(input_fft, vec2<i32>(i32(x_prev), i32(id.y)), 0).z;
    let dz_top = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_next)), 0).w;
    let dz_bottom = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_prev)), 0).w;
    
    let dDx_dx = (dx_right - dx_left) / (2.0 * texel_size);
    let dDz_dz = (dz_top - dz_bottom) / (2.0 * texel_size);
    let jacobian = (1.0 + dDx_dx) * (1.0 + dDz_dz);
    
    textureStore(output_displacement, vec2<i32>(id.xy), vec4<f32>(displacement, jacobian));
    
    let foam = clamp(-jacobian + 1.0, 0.0, 1.0);
    textureStore(output_derivatives, vec2<i32>(id.xy), vec4<f32>(dhdx, dhdz, foam, 0.0));
}
`;

// ===== WATER RENDERING SHADER WITH TERRAIN SAMPLING =====

const RIVER_WATER_SHADER = `
// Sample terrain height
fn sample_landscape_height(world_pos: vec2<f32>) -> f32 {
    let landscape_size = 4096.0;
    let max_height = 600.0;
    let landscape_y_offset = -550.0 + 2.0;
    
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    
    return (height_sample.r * max_height) + landscape_y_offset;
}

// Sample flow accumulation to determine if this is a river
fn sample_flow_accumulation(world_pos: vec2<f32>) -> vec4<f32> {
    let landscape_size = 4096.0;
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    return textureSampleLevel(flow_texture, flow_sampler, clamped_uv, 0.0);
}

// Sample terrain normal for flow direction
fn sample_landscape_normal(world_pos: vec2<f32>) -> vec3<f32> {
    let offset = 2.0;
    let h_center = sample_landscape_height(world_pos);
    let h_right = sample_landscape_height(world_pos + vec2<f32>(offset, 0.0));
    let h_up = sample_landscape_height(world_pos + vec2<f32>(0.0, offset));
    
    let tangent_x = vec3<f32>(offset, h_right - h_center, 0.0);
    let tangent_z = vec3<f32>(0.0, h_up - h_center, offset);
    
    return normalize(cross(tangent_z, tangent_x));
}

struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct Time {
    time: f32,
};
@group(2) @binding(0)
var<uniform> u_time: Time;

@group(3) @binding(0)
var displacement_texture: texture_2d<f32>;
@group(3) @binding(1)
var derivatives_texture: texture_2d<f32>;
@group(3) @binding(2)
var ocean_sampler: sampler;

@group(4) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(4) @binding(1)
var landscape_sampler: sampler;

@group(5) @binding(0)
var flow_texture: texture_2d<f32>;
@group(5) @binding(1)
var flow_sampler: sampler;

struct WaterConfig {
    shallow_color: vec4<f32>,
    medium_color: vec4<f32>,
    deep_color: vec4<f32>,
    ocean_size: vec4<f32>,
    lighting_params: vec4<f32>,
    foam_params: vec4<f32>,
    river_params: vec4<f32>,  // x: min_flow_threshold, y: water_depth, z: edge_softness, w: river_width_scale
}
@group(6) @binding(0)
var<uniform> water_config: WaterConfig;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) terrain_height: f32,
    @location(4) flow_amount: f32,
    @location(5) terrain_slope: f32,
    @location(6) river_distance: f32,
};

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    // Sample terrain and flow data
    let terrain_height = sample_landscape_height(in.position.xz);
    let terrain_normal = sample_landscape_normal(in.position.xz);
    let flow_data = sample_flow_accumulation(in.position.xz);
    
    let flow_accumulation = flow_data.x;
    let terrain_slope = flow_data.y;
    
    // River parameters
    let min_flow_threshold = water_config.river_params.x;
    let water_depth = water_config.river_params.y;
    let edge_softness = water_config.river_params.z;
    let river_width_scale = water_config.river_params.w;
    
    // Only show water where flow accumulation is high enough (actual river paths)
    let is_river = step(min_flow_threshold, flow_accumulation);
    
    // Calculate river width based on flow accumulation (more flow = wider river)
    let river_width = sqrt(flow_accumulation) * river_width_scale;
    
    // Distance from river centerline (0 = center, increases toward edges)
    // For now, we'll use a simple calculation based on flow gradient
    let river_distance = max(0.0, 1.0 - (flow_accumulation / (min_flow_threshold + 10.0)));
    
    // UV coordinates for displacement lookup
    let ocean_size = water_config.ocean_size.x;
    let uv = (in.position.xz + ocean_size * 0.5) / ocean_size;
    
    // Sample FFT displacement
    let disp_data = textureSampleLevel(displacement_texture, ocean_sampler, uv, 0.0);
    let displacement = disp_data.xyz;
    
    // Scale waves based on flow and distance from edge
    let flow_factor = smoothstep(min_flow_threshold, min_flow_threshold * 2.0, flow_accumulation);
    let edge_factor = smoothstep(0.8, 0.3, river_distance);
    let scaled_displacement = displacement * flow_factor * edge_factor;
    
    // RIVER LOGIC: Water surface follows terrain with offset
    var water_surface_y = terrain_height + water_depth;
    
    // Apply FFT wave displacement
    water_surface_y += scaled_displacement.y * 0.5;
    
    // Apply horizontal displacement (choppy waves)
    var world_pos = vec3<f32>(
        in.position.x + scaled_displacement.x,
        water_surface_y,
        in.position.z + scaled_displacement.z
    );

    // var world_pos = in.position;
    
    // Hide water if not in river path
    world_pos.y = mix(-10000.0, world_pos.y, is_river);
    
    // Compute water normal from FFT derivatives + terrain slope
    let deriv_data = textureSampleLevel(derivatives_texture, ocean_sampler, uv, 0.0);
    let dhdx = deriv_data.x;
    let dhdz = deriv_data.y;
    
    // Blend water normal with terrain normal for natural flow
    let water_normal = normalize(vec3<f32>(-dhdx, 1.0, -dhdz));
    let blended_normal = normalize(mix(water_normal, terrain_normal, 0.3));
    
    out.world_position = world_pos;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.normal = blended_normal;
    out.uv = uv;
    out.terrain_height = terrain_height;
    out.flow_amount = flow_accumulation;
    out.terrain_slope = terrain_slope;
    out.river_distance = river_distance;
    
    return out;
}

fn get_rainbow_color(height: f32) -> vec3<f32> {
    // 1. Define your height range (adjust these to your world scale!)
    let min_h = 0.0;
    let max_h = 600.0; 
    let h = clamp((height - min_h) / (max_h - min_h), 0.0, 1.0);

    // 2. Explicit color buckets
    // Blue -> Cyan -> Green -> Yellow -> Red
    if (h < 0.25) {
        return mix(vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 1.0), h / 0.25);
    } else if (h < 0.5) {
        return mix(vec3<f32>(0.0, 1.0, 1.0), vec3<f32>(0.0, 1.0, 0.0), (h - 0.25) / 0.25);
    } else if (h < 0.75) {
        return mix(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 1.0, 0.0), (h - 0.5) / 0.25);
    } else {
        return mix(vec3<f32>(1.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), (h - 0.75) / 0.25);
    }
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;
    
    // Soft edge fading based on distance from river center
    let edge_softness = water_config.river_params.z;
    let edge_alpha = smoothstep(1.0, 0.5, in.river_distance);
    
    if (edge_alpha < 0.01) {
        discard;
    }
    
    let view_dir = normalize(camera.view_pos.xyz - in.world_position);
    let normal = normalize(in.normal);
    
    // Sample foam
    let deriv_data = textureSample(derivatives_texture, ocean_sampler, in.uv);
    let foam = deriv_data.z;
    
    // Fresnel effect
    let ndotv = max(dot(normal, view_dir), 0.0);
    let fresnel = pow(1.0 - ndotv, water_config.lighting_params.x);
    
    // Color based on flow amount (faster/deeper rivers are darker)
    var water_color = water_config.shallow_color.xyz;
    
    let flow_depth_factor = log2(in.flow_amount + 1.0) * 0.2;
    water_color = mix(
        water_config.shallow_color.xyz,
        water_config.medium_color.xyz,
        clamp(flow_depth_factor, 0.0, 1.0)
    );
    
    // Sky reflection
    let sky_color = vec3<f32>(0.6, 0.8, 1.0);
    var final_color = mix(water_color, sky_color, fresnel * water_config.lighting_params.y);
    
    // Specular highlight
    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, normal);
    let spec = pow(max(dot(view_dir, reflect_dir), 0.0), water_config.lighting_params.z);
    final_color += vec3<f32>(1.0, 1.0, 0.95) * spec * water_config.lighting_params.w;
    
    // Foam - enhanced on slopes (rapids) and high flow
    let slope_foam = in.terrain_slope * 2.0;
    let flow_foam = log2(in.flow_amount + 1.0) * 0.1;
    let total_foam = foam + slope_foam + flow_foam;
    
    let foam_intensity = smoothstep(
        water_config.foam_params.x,
        water_config.foam_params.x + 0.2,
        total_foam
    );
    final_color = mix(final_color, vec3<f32>(0.95, 0.95, 1.0), foam_intensity * water_config.foam_params.y);
    
    // Extra foam at river edges
    let edge_foam = smoothstep(0.5, 0.9, in.river_distance);
    final_color = mix(final_color, vec3<f32>(1.0, 1.0, 1.0), edge_foam * 0.2);
    
    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.85 * edge_alpha);
    // output.albedo = vec4<f32>(0.0, clamp(in.terrain_height / 500.0, 0.0, 1.0), 0.0, 1.0);

    // // Test: Let's bypass other lighting/shadows to see pure color
    // let heatmap = get_rainbow_color(in.terrain_height);

    // output.albedo = vec4<f32>(heatmap, 1.0);

    output.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0);
    
    return output;
}
`;

// ===== ADDON CODE =====

interface RiverPoint {
    x: number;
    y: number;
}

interface RiverStroke {
    points: RiverPoint[];
    brushSize: number;
    isErase: boolean;
    direction: "Forward" | "Backward";
}

interface RiverWaterParams {
    resolution: number;
    waterSize: number;
    windSpeed: number;
    windDirection: [number, number];
    amplitude: number;
    choppiness: number;
    gravity: number;
    
    // Visual params
    shallowColor: [number, number, number, number];
    mediumColor: [number, number, number, number];
    deepColor: [number, number, number, number];
    
    // Flow-based river params
    minFlowThreshold: number;  // Minimum flow accumulation to show as river
    waterDepth: number;        // How thick the water layer is
    edgeSoftness: number;      // How gradually river edges fade
    riverWidthScale: number;   // How much flow affects river width
    flowIterations: number;    // Number of flow propagation passes
    
    fresnelPower: number;
    fresnelMult: number;
    specularPower: number;
    specularIntensity: number;
    
    foamThreshold: number;
    foamIntensity: number;

    useManualRivers: boolean;
    brushSize: number;
    brushDirection: "Forward" | "Backward";
    strokes: RiverStroke[];
}

const addonInfo = {
    name: "FFT River Water",
    version: "1.1.0",
    description: "Terrain-aware FFT water with path-based manual drawing",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        graphics: true,
        ui: true
    }
}

const addon = Entropy.Addon.register(addonInfo);

let riverParams: RiverWaterParams = {
    resolution: 256,
    waterSize: 4096.0,
    windSpeed: 1.5,
    windDirection: [1.0, 0.3],
    amplitude: 0.003,
    choppiness: 0.08,
    gravity: 9.81,
    
    shallowColor: [0.4, 0.7, 0.8, 1.0],
    mediumColor: [0.1, 0.4, 0.6, 1.0],
    deepColor: [0.05, 0.2, 0.4, 1.0],
    
    minFlowThreshold: 5.0,    // Minimum flow to show river (tune this!)
    waterDepth: 2.0,          // Thickness of water layer
    edgeSoftness: 0.5,        // River edge fade
    riverWidthScale: 0.5,     // Flow → width multiplier
    flowIterations: 8,        // More = better flow detection
    
    fresnelPower: 3.0,
    fresnelMult: 0.7,
    specularPower: 200.0,
    specularIntensity: 0.5,
    
    foamThreshold: 0.85,
    foamIntensity: 0.4,

    useManualRivers: true,
    brushSize: 5.0,
    brushDirection: "Forward",
    strokes: []
};

let addonState: {
    currentParams: RiverWaterParams,
    savedComponents: { id: string, name: string, params: RiverWaterParams }[],
    activeComponentId: string | null,
    eraseMode: boolean,
    manualRiverMaskRaw?: Uint8Array,
    indicatorPos: [number, number, number] | null
} = {
    currentParams: { ...riverParams },
    savedComponents: [],
    activeComponentId: Entropy.generateUUID(),
    eraseMode: false,
    manualRiverMaskRaw: new Uint8Array(512 * 512).fill(0),
    indicatorPos: null
};

function updateIndicatorMesh() {
    if (!addonState.indicatorPos) {
        addon.Model.clearMesh("river_brush_indicator");
        return;
    }

    const radius = addonState.currentParams.brushSize * (4096.0 / 100.0) / 2.0;
    const segments = 32;
    const vertices: number[] = [];
    const indices: number[] = [];

    // Simple circle on XZ plane
    vertices.push(0, 0, 0,  0, 1, 0,  0.5, 0.5,  0, 0.5, 1, 1); // Center
    for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        vertices.push(x, 0, z,  0, 1, 0,  0.5, 0.5,  0, 0.5, 1, 1);
        if (i > 0) {
            indices.push(0, i, i + 1);
        }
    }

    addon.Model.createMesh({
        id: "river_brush_indicator",
        position: [addonState.indicatorPos[0], addonState.indicatorPos[1] + 2.0, addonState.indicatorPos[2]],
        vertexData: vertices,
        indexData: indices,
        pipelineId: "default", // Use a basic pipeline
        renderRole: "General"
    });
}

function getManualRiverMask(): Uint8Array {
    if (!addonState.manualRiverMaskRaw) {
        addonState.manualRiverMaskRaw = new Uint8Array(512 * 512).fill(0);
    }
    return addonState.manualRiverMaskRaw;
}

/**
 * Rasterizes all stored strokes into the manualRiverMaskRaw Uint8Array
 */
function rasterizeStrokes() {
    const res = 512;
    const mask = getManualRiverMask();
    mask.fill(0); // Reset

    for (const stroke of addonState.currentParams.strokes) {
        const val = stroke.isErase ? 0 : 255;
        const radius = stroke.brushSize * (res / 100.0);
        
        for (const pt of stroke.points) {
            const centerX = pt.x * res;
            const centerY = pt.y * res;
            
            for (let iy = Math.max(0, Math.floor(centerY - radius)); iy < Math.min(res, Math.ceil(centerY + radius)); iy++) {
                for (let ix = Math.max(0, Math.floor(centerX - radius)); ix < Math.min(res, Math.ceil(centerX + radius)); ix++) {
                    const dx = ix - centerX;
                    const dy = iy - centerY;
                    if (dx * dx + dy * dy <= radius * radius) {
                        mask[iy * res + ix] = val;
                    }
                }
            }
        }
    }

    // Update GPU texture
    let manualMaskId = (globalThis as any).manualRiverMaskId;
    const rgbaData = new Uint8Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
        const mVal = mask[i];
        rgbaData[i * 4] = mVal;
        rgbaData[i * 4 + 1] = mVal;
        rgbaData[i * 4 + 2] = mVal;
        rgbaData[i * 4 + 3] = 255;
    }
    
    if (manualMaskId) {
        addon.Texture.update(manualMaskId, rgbaData);
    } else {
        manualMaskId = addon.Texture.create(res, res, rgbaData);
        (globalThis as any).manualRiverMaskId = manualMaskId;
    }
    
    if (addonState.currentParams.useManualRivers) {
        computeFlowAccumulation();
    }
}

let lastDrawTime = 0;

function updateManualRiverMask(x: number, y: number, brushSize: number) {
    const now = Date.now();
    
    // Heuristic: If it's been more than 250ms since the last point, it's a new stroke
    if (now - lastDrawTime > 250) {
        addonState.currentParams.strokes.push({
            points: [],
            brushSize: brushSize,
            isErase: addonState.eraseMode,
            direction: addonState.currentParams.brushDirection
        });
    }
    
    lastDrawTime = now;
    const currentStroke = addonState.currentParams.strokes[addonState.currentParams.strokes.length - 1];
    
    // Avoid duplicate points
    const lastPoint = currentStroke.points[currentStroke.points.length - 1];
    if (!lastPoint || Math.abs(lastPoint.x - x) > 0.001 || Math.abs(lastPoint.y - y) > 0.001) {
        currentStroke.points.push({ x, y });
        rasterizeStrokes();
    }
}

// Helper for Base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes;
}

let initializer: any = [];
let projectInitialized = false;

let pipelineIds = {
    flowAccumulation: null as string | null,
    flowPropagation: null as string | null,
    spectrumInit: null as string | null,
    spectrumUpdate: null as string | null,
    fftHorizontal: null as string | null,
    fftVertical: null as string | null,
    displacement: null as string | null,
    waterRender: null as string | null,
};

let textures = {
    flowMap: [null, null] as (string | null)[], // Pingpong for flow iterations
    h0: null as string | null,
    ht: null as string | null,
    pingpong: [null, null] as (string | null)[],
    displacement: null as string | null,
    derivatives: null as string | null,
};

addon.onInit(async () => {
    Entropy.println("🌊 FFT River Water: Initializing...");
    
    // Create flow accumulation pipelines
    pipelineIds.flowAccumulation = Entropy.Pipeline.createCompute({
        name: "FlowAccumulation",
        shaderSource: FLOW_ACCUMULATION_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "Texture" },
                { binding: 1, visibility: ["Compute"], resourceType: "Sampler" },
                { binding: 2, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 3, visibility: ["Compute"], resourceType: "Uniform" },
                { binding: 4, visibility: ["Compute"], resourceType: "Texture" },
            ]
        }]
    });
    
    pipelineIds.flowPropagation = Entropy.Pipeline.createCompute({
        name: "FlowPropagation",
        shaderSource: FLOW_PROPAGATION_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "Texture" },
                { binding: 1, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 2, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 3, visibility: ["Compute"], resourceType: "Uniform" },
                { binding: 4, visibility: ["Compute"], resourceType: "Sampler" },
            ]
        }]
    });
    
    // Create compute pipelines
    pipelineIds.spectrumInit = Entropy.Pipeline.createCompute({
        name: "RiverSpectrumInit",
        shaderSource: SPECTRUM_INIT_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 1, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.spectrumUpdate = Entropy.Pipeline.createCompute({
        name: "RiverSpectrumUpdate",
        shaderSource: SPECTRUM_UPDATE_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.fftHorizontal = Entropy.Pipeline.createCompute({
        name: "RiverFFT_H",
        shaderSource: FFT_HORIZONTAL_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.fftVertical = Entropy.Pipeline.createCompute({
        name: "RiverFFT_V",
        shaderSource: FFT_VERTICAL_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    pipelineIds.displacement = Entropy.Pipeline.createCompute({
        name: "RiverDisplacement",
        shaderSource: DISPLACEMENT_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
                { binding: 1, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 2, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 3, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });
    
    // Create water render pipeline with flow texture binding
    pipelineIds.waterRender = Entropy.Pipeline.create({
        name: "River_Water_Render",
        layout: "mesh",
        vertexShader: RIVER_WATER_SHADER,
        fragmentShader: RIVER_WATER_SHADER,
        pbr: true,
        extraBindGroups: [
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Time" }] },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 2, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" },
                ]
            },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" },
                ]
            },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" },
                ]
            },
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }] }
        ]
    });
    
    // Initialize resources
    initializeResources();
    
    // Compute flow paths
    // Entropy.println("🌊 Computing river flow paths...");
    // computeFlowAccumulation();
    
    // Entropy.println("🌊 Generating spectrum noise pattern...");
    // generateInitialSpectrum();
    // createWaterMesh("river_water_preview", addonState.currentParams);
    
    // Lighting
    addon.Lighting.createPointLight({
        position: [0.0, 50.0, 0.0],
        color: [0.9, 0.95, 1.0],
        intensity: 10.0,
        maxDistance: 500.0
    });
    
    setupUI();

    (globalThis as any).onManualRiverMaskUpdate = (x: number, y: number, brushSize: number) => {
        if (addonState.currentParams.useManualRivers) {
            updateManualRiverMask(x, y, brushSize);
            
            // Also update indicator position during drawing
            const landscapeSize = 4096.0;
            const worldX = (x - 0.5) * landscapeSize;
            const worldZ = (y - 0.5) * landscapeSize;
            addonState.indicatorPos = [worldX, -550.0, worldZ]; // Approximate height
            updateIndicatorMesh();
        }
    };

    (globalThis as any).onManualRiverMaskHover = (x: number, y: number, brushSize: number) => {
        if (addonState.currentParams.useManualRivers) {
            const landscapeSize = 4096.0;
            const worldX = (x - 0.5) * landscapeSize;
            const worldZ = (y - 0.5) * landscapeSize;
            addonState.indicatorPos = [worldX, -550.0, worldZ];
            updateIndicatorMesh();
        } else {
            addonState.indicatorPos = null;
            updateIndicatorMesh();
        }
    };

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderUI);
        
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer(addonInfo.name, (id: string, params: RiverWaterParams) => {
                // if (projectInitialized) {
                    

                // NOTE: major hack, need better timing for when binding to landscapes!
                    initializer = [true, id, params];
                // } else {
                //     Entropy.println("🌊 Waiting to compute flow...");
                // }
            });
        }
    }
    
    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            addonState = { ...addonState, ...data };
            
            // Restore manual mask from paths
            rasterizeStrokes();

            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }

            // Entropy.println("🌊 Computing river flow paths (first frame)...");
            // computeFlowAccumulation();

            // Entropy.println("🌊 Generating spectrum noise pattern...");
            // generateInitialSpectrum();

            // createWaterMesh("river_water_preview", addonState.currentParams);

            // initialized = true;
        }
    });

    addon.onUpdatePlus("Game Composer", (time) => {
        if (initializer[0]) {
            Entropy.println("🌊 Computing river flow paths (first frame)...");
            computeFlowAccumulation();

            Entropy.println("🌊 Generating spectrum noise pattern...");
            generateInitialSpectrum();

            // For the composer, we might want to respect the instance position
            // The current shader assumes y=oceanHeight, but we should probably add world pos
            createWaterMesh(initializer[1], initializer[2]);

            initializer = [false, false, false];
            projectInitialized = true;
        }
        if (projectInitialized) {
            (globalThis as any).__entropy_current_addon_context_override = "Game Composer";
            updateWater(time);
            (globalThis as any).__entropy_current_addon_context_override = null;
        }
    });
    
    // addon.onUpdate((time) => {
    //     if (initialized) {
    //         updateWater(time);
    //     }
    // });

    // if (Entropy.Composer) {
    //     Entropy.Composer.initCallbacks["FlexNoise Terrain"] = () => {
    //         projectInitialized = true;
    //     };
    // }
    
    Entropy.println("✅ FFT River Water initialized!");

    // --- Tools Registration ---

    addon.registerTool({
        name: "update_river_parameters",
        description: "Update the terrain-aware river simulation parameters.",
        parameters: {
            type: "object",
            properties: {
                minFlowThreshold: { type: "number", description: "Minimum flow to form a river (1 to 50). Lower = more tributaries." },
                waterDepth: { type: "number", description: "Thickness of the water layer (0.5 to 10)." },
                windSpeed: { type: "number", description: "Speed of wind over the river." },
                choppiness: { type: "number", description: "How rough the river surface is." },
                riverWidthScale: { type: "number", description: "Scaling factor for river width." }
            }
        }
    }, (args: any) => {
        Entropy.println("Updating River parameters via tool: " + JSON.stringify(args));
        let changed = false;
        let flowChanged = false;
        let spectrumChanged = false;

        if (typeof args.minFlowThreshold !== "undefined") { addonState.currentParams.minFlowThreshold = args.minFlowThreshold; changed = true; flowChanged = true; }
        if (typeof args.waterDepth !== "undefined") { addonState.currentParams.waterDepth = args.waterDepth; changed = true; }
        if (typeof args.windSpeed !== "undefined") { addonState.currentParams.windSpeed = args.windSpeed; changed = true; spectrumChanged = true; }
        if (typeof args.choppiness !== "undefined") { addonState.currentParams.choppiness = args.choppiness; changed = true; }
        if (typeof args.riverWidthScale !== "undefined") { addonState.currentParams.riverWidthScale = args.riverWidthScale; changed = true; }

        if (changed) {
            if (flowChanged) computeFlowAccumulation();
            if (spectrumChanged) generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
            return { success: true, currentParams: addonState.currentParams };
        }
        return { success: false, error: "No parameters provided." };
    });

    addon.registerTool({
        name: "set_river_preset",
        description: "Apply a predefined river style (e.g., Mountain Streams, Major Rivers).",
        parameters: {
            type: "object",
            properties: {
                preset: { 
                    type: "string", 
                    enum: ["mountain", "major", "gentle", "rapids"],
                    description: "The name of the preset."
                }
            },
            required: ["preset"]
        }
    }, (args: any) => {
        Entropy.println("Setting river preset via tool: " + args.preset);
        if (args.preset === "mountain") {
            addonState.currentParams.minFlowThreshold = 3.0;
            addonState.currentParams.waterDepth = 1.2;
            addonState.currentParams.riverWidthScale = 0.3;
        } else if (args.preset === "major") {
            addonState.currentParams.minFlowThreshold = 8.0;
            addonState.currentParams.waterDepth = 3.0;
            addonState.currentParams.riverWidthScale = 0.8;
        } else if (args.preset === "gentle") {
            addonState.currentParams.minFlowThreshold = 2.0;
            addonState.currentParams.waterDepth = 0.8;
            addonState.currentParams.riverWidthScale = 0.4;
        } else if (args.preset === "rapids") {
            addonState.currentParams.minFlowThreshold = 5.0;
            addonState.currentParams.windSpeed = 3.0;
            addonState.currentParams.choppiness = 0.25;
        } else {
            return { success: false, error: "Unknown preset." };
        }
        
        computeFlowAccumulation();
        generateInitialSpectrum();
        createWaterMesh("river_water_preview", addonState.currentParams);
        return { success: true, preset: args.preset };
    });

    addon.registerTool({
        name: "save_river_component",
        description: "Save the current river settings as a reusable component for the Game Composer.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for this river configuration (e.g., 'Winding Brook')." }
            },
            required: ["name"]
        }
    }, (args: any) => {
        const id = Entropy.generateUUID();
        const params = JSON.parse(JSON.stringify(addonState.currentParams));
        
        addonState.savedComponents.push({ id, name: args.name, params });
        
        if (Entropy.Composer) {
            Entropy.Composer.registerComponent(addonInfo.name, id, args.name, params);
        }
        
        return { success: true, id: id, name: args.name, addonName: addonInfo.name };
    });
});

function initializeResources() {
    const N = addonState.currentParams.resolution;
    
    // Flow map textures (for river path detection)
    textures.flowMap[0] = Entropy.Texture.createStorage(512, 512, "Rgba16Float");
    textures.flowMap[1] = Entropy.Texture.createStorage(512, 512, "Rgba16Float");
    
    // FFT textures
    textures.h0 = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.ht = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[0] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[1] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.displacement = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.derivatives = Entropy.Texture.createStorage(N, N, "Rgba16Float");
}

function computeFlowAccumulation() {
    if (!pipelineIds.flowAccumulation || !pipelineIds.flowPropagation) return;
    
    const flowRes = 512;
    const workgroups = Math.ceil(flowRes / 8);

    // Get manual river mask from global interop
    let manualMaskId = (globalThis as any).manualRiverMaskId;
    if (!manualMaskId) {
        // Create an empty one if not exists
        const empty = new Uint8Array(512 * 512 * 4).fill(0);
        manualMaskId = addon.Texture.create(512, 512, empty);
        (globalThis as any).manualRiverMaskId = manualMaskId;
    }
    
    const flowParams = new Float32Array([
        4096.0, // landscape_size
        600.0,  // max_height
        -550.0 + 2.0, // landscape_y_offset
        flowRes,
        addonState.currentParams.minFlowThreshold,
        addonState.currentParams.useManualRivers ? 1.0 : 0.0,
        0, 0
    ]);
    
    // Initial flow accumulation pass
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.flowAccumulation,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "Texture", value: { id: "Landscape" } } },
            { group: 0, binding: 1, resource: { type: "Sampler" } },
            { group: 0, binding: 2, resource: { type: "StorageTextureRgba16", value: { id: textures.flowMap[0]! } } },
            { group: 0, binding: 3, resource: { type: "Uniform", value: { data: Array.from(flowParams) } } },
            { group: 0, binding: 4, resource: { type: "Texture", value: { id: manualMaskId } } },
        ]
    });
    
    // Iterative flow propagation
    let pingpong = 0;
    for (let i = 0; i < addonState.currentParams.flowIterations; i++) {
        const input = textures.flowMap[pingpong];
        const output = textures.flowMap[1 - pingpong];
        
        flowParams[4] = i; // iteration
        flowParams[5] = addonState.currentParams.flowIterations; // total_iterations
        
        Entropy.Compute.dispatch({
            pipelineId: pipelineIds.flowPropagation,
            groups: [workgroups, workgroups, 1],
            bindings: [
                { group: 0, binding: 0, resource: { type: "Texture", value: { id: "Landscape" } } },
                { group: 0, binding: 1, resource: { type: "TextureNonFilterable", value: { id: input! } } },
                { group: 0, binding: 2, resource: { type: "StorageTextureRgba16", value: { id: output! } } },
                { group: 0, binding: 3, resource: { type: "Uniform", value: { data: Array.from(flowParams) } } },
                { group: 0, binding: 4, resource: { type: "Sampler" } },
            ]
        });
        
        pingpong = 1 - pingpong;
    }
    
    Entropy.println(`✅ Flow computation complete (${addonState.currentParams.flowIterations} iterations)`);
}

function generateInitialSpectrum() {
    if (!pipelineIds.spectrumInit || !textures.h0) return;
    
    const params = new Float32Array([
        addonState.currentParams.resolution,
        addonState.currentParams.waterSize,
        addonState.currentParams.windSpeed,
        addonState.currentParams.windDirection[0],
        addonState.currentParams.windDirection[1],
        addonState.currentParams.amplitude,
        addonState.currentParams.gravity,
        0.0,
    ]);
    
    const N = addonState.currentParams.resolution;
    const workgroups = Math.ceil(N / 8);
    
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.spectrumInit,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "StorageTextureRgba16", value: { id: textures.h0! } } },
            { group: 0, binding: 1, resource: { type: "Uniform", value: { data: Array.from(params) } } },
        ]
    });
}

function updateWater(time: number) {
    if (!pipelineIds.spectrumUpdate || !textures.h0 || !textures.ht) return;

    const N = addonState.currentParams.resolution;
    const workgroups = Math.ceil(N / 8);
    const logN = Math.log2(N);

    // Update Spectrum
    const timeParams = new Float32Array([
        time, N, addonState.currentParams.waterSize, addonState.currentParams.gravity,
        addonState.currentParams.choppiness, 0, 0, 0
    ]);

    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.spectrumUpdate,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: textures.h0! } } },
            { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: textures.ht! } } },
            { group: 0, binding: 2, resource: { type: "Uniform", value: { data: Array.from(timeParams) } } },
        ]
    });

    // FFT passes
    let pingpong = 0;
    for (let i = 0; i < logN; i++) {
        const input = i === 0 ? textures.ht : textures.pingpong[pingpong];
        const output = textures.pingpong[1 - pingpong];
        Entropy.Compute.dispatch({
            pipelineId: pipelineIds.fftHorizontal!,
            groups: [workgroups, workgroups, 1],
            bindings: [
                { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: input! } } },
                { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: output! } } },
                { group: 0, binding: 2, resource: { type: "Uniform", value: { data: [N, i, 0, 0] } } },
            ]
        });
        pingpong = 1 - pingpong;
    }

    for (let i = 0; i < logN; i++) {
        const input = textures.pingpong[pingpong];
        const output = textures.pingpong[1 - pingpong];
        Entropy.Compute.dispatch({
            pipelineId: pipelineIds.fftVertical!,
            groups: [workgroups, workgroups, 1],
            bindings: [
                { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: input! } } },
                { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: output! } } },
                { group: 0, binding: 2, resource: { type: "Uniform", value: { data: [N, i, 0, 0] } } },
            ]
        });
        pingpong = 1 - pingpong;
    }

    // Displacement
    const outputParams = new Float32Array([N, addonState.currentParams.waterSize, addonState.currentParams.choppiness, 0]);
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.displacement!,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: textures.pingpong[pingpong]! } } },
            { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: textures.displacement! } } },
            { group: 0, binding: 2, resource: { type: "StorageTextureRgba16", value: { id: textures.derivatives! } } },
            { group: 0, binding: 3, resource: { type: "Uniform", value: { data: Array.from(outputParams) } } },
        ]
    });
}

function createWaterMesh(id: string, params: RiverWaterParams & { _transform?: { position: [number, number, number], scale: [number, number, number] } }) {
    if (!pipelineIds.waterRender) return;
    
    const gridSize = params.waterSize;
    const resolution = 128;
    
    const vertices: number[] = [];
    const indices: number[] = [];
    const halfSize = gridSize / 2;
    
    for (let row = 0; row <= resolution; row++) {
        for (let col = 0; col <= resolution; col++) {
            const x = -halfSize + (col / resolution) * gridSize;
            const z = -halfSize + (row / resolution) * gridSize;
            
            vertices.push(x, 0, z);
            vertices.push(0, 1, 0);
            vertices.push(col / resolution, row / resolution);
            vertices.push(1, 1, 1, 1);
        }
    }
    
    for (let row = 0; row < resolution; row++) {
        for (let col = 0; col < resolution; col++) {
            const topLeft = row * (resolution + 1) + col;
            const topRight = topLeft + 1;
            const bottomLeft = (row + 1) * (resolution + 1) + col;
            const bottomRight = bottomLeft + 1;
            
            indices.push(topLeft, bottomLeft, topRight);
            indices.push(topRight, bottomLeft, bottomRight);
        }
    }
    
    const waterConfig = [
        ...params.shallowColor,
        ...params.mediumColor,
        ...params.deepColor,
        params.waterSize, 0, 0, 0,
        params.fresnelPower, params.fresnelMult, params.specularPower, params.specularIntensity,
        params.foamThreshold, params.foamIntensity, 0, 0,
        params.minFlowThreshold, params.waterDepth, params.edgeSoftness, params.riverWidthScale,
    ];

    const pos = params._transform?.position || [0, 0, 0];
    
    // Determine which flow map to use (result of last iteration)
    const flowMapIndex = addonState.currentParams.flowIterations % 2;
    
    addon.Model.clearMesh(id);
    addon.Model.createMesh({
        id: id,
        position: pos,
        vertexData: vertices,
        indexData: indices,
        pipelineId: pipelineIds.waterRender,
        renderRole: "Water",
        bindings: [
            { group: 2, binding: 0, resource: { type: "Time" } },
            { group: 3, binding: 0, resource: { type: "Texture", value: { id: textures.displacement! } } },
            { group: 3, binding: 1, resource: { type: "Texture", value: { id: textures.derivatives! } } },
            { group: 3, binding: 2, resource: { type: "Sampler" } },
            { group: 4, binding: 0, resource: { type: "Texture", value: { id: "Landscape" } } },
            { group: 4, binding: 1, resource: { type: "Sampler" } },
            { group: 5, binding: 0, resource: { type: "Texture", value: { id: textures.flowMap[flowMapIndex]! } } },
            { group: 5, binding: 1, resource: { type: "Sampler" } },
            { group: 6, binding: 0, resource: { type: "Uniform", value: { data: waterConfig } } },
        ]
    });
    
    Entropy.println(`River water mesh created: ${id}`);
}

function setupUI() {
    const tab = addon.UI.createTab({
        title: "River Water",
        onRender: () => renderUI(tab)
    });
}

let newComponentName = "New Water Component";

function renderUI(tab: string) {
    Entropy.Addon.setVisibility(addonInfo.name, true);
    Entropy.UI.Widget.label(tab, { text: "🌊 FFT River System", bold: true });
    
    Entropy.UI.Widget.button(tab, { text: "💾 Save All to Project", onClick: () => {
        addon.IO.save(addonState);
        if (Entropy.Composer) {
            addonState.savedComponents.forEach(comp => { Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params); });
        }
    }});

    Entropy.UI.Widget.button(tab, {
        text: "↩️ Undo Last Stroke",
        onClick: () => {
            if (addonState.currentParams.strokes.length > 0) {
                addonState.currentParams.strokes.pop();
                rasterizeStrokes();
            }
        }
    });

    Entropy.UI.Widget.button(tab, {
        text: "🗑️ Clear All Rivers",
        onClick: () => {
            addonState.currentParams.strokes = [];
            rasterizeStrokes();
        }
    });

    Entropy.UI.Widget.label(tab, { text: "📦 Components", bold: true });
    Entropy.UI.Widget.button(tab, { text: "➕ Save Current as Component", onClick: () => {
        const id = Entropy.generateUUID();
        addonState.savedComponents.push({ id, name: newComponentName, params: JSON.parse(JSON.stringify(addonState.currentParams)) });
        if (Entropy.Composer) { Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, addonState.currentParams); }
    }});
    
    addonState.savedComponents.forEach(comp => {
        Entropy.UI.Widget.button(tab, { text: `📂 Load & Render: ${comp.name}`, onClick: () => {
            addonState.currentParams = JSON.parse(JSON.stringify(comp.params));
            addonState.activeComponentId = comp.id;
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }});
    });
    
    Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

    
    Entropy.UI.Widget.label(tab, { text: "Rivers follow natural flow paths down terrain" });

    Entropy.UI.Widget.label(tab, { text: "💧 Flow Detection", bold: true });

    Entropy.UI.Widget.button(tab, {
        text: addonState.currentParams.useManualRivers ? "✏️ Mode: Manual (Drawn on MiniMap)" : "🤖 Mode: Automatic (Flow Accumulation)",
        onClick: () => {
            addonState.currentParams.useManualRivers = !addonState.currentParams.useManualRivers;
            computeFlowAccumulation();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });

    Entropy.UI.Widget.button(tab, {
        text: addonState.eraseMode ? "🧽 Mode: Erasing" : "🖌️ Mode: Drawing",
        onClick: () => {
            addonState.eraseMode = !addonState.eraseMode;
        }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "River Brush Size",
        value: addonState.currentParams.brushSize,
        min: 1,
        max: 50,
        onChange: (v) => {
            addonState.currentParams.brushSize = parseFloat(v);
        }
    });

    const directions = ["Forward", "Backward"];
    Entropy.UI.Widget.dropdown(tab, {
        label: "Brush Direction",
        options: directions,
        selectedIndex: directions.indexOf(addonState.currentParams.brushDirection),
        onChange: (idx) => {
            addonState.currentParams.brushDirection = directions[parseInt(idx)] as "Forward" | "Backward";
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Min Flow Threshold",
        value: addonState.currentParams.minFlowThreshold,
        min: 1,
        max: 50,
        onChange: (v) => {
            addonState.currentParams.minFlowThreshold = parseFloat(v);
            computeFlowAccumulation();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Flow Iterations (Quality)",
        value: addonState.currentParams.flowIterations,
        min: 1,
        max: 20,
        onChange: (v) => {
            addonState.currentParams.flowIterations = Math.floor(parseFloat(v));
            computeFlowAccumulation();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🔄 Recompute Flow Paths",
        onClick: () => {
            Entropy.println("Recomputing river flow paths...");
            computeFlowAccumulation();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });

    Entropy.UI.Widget.label(tab, { text: "🌊 River Appearance", bold: true });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Water Depth",
        value: addonState.currentParams.waterDepth,
        min: 0.5,
        max: 10,
        onChange: (v) => {
            addonState.currentParams.waterDepth = parseFloat(v);
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "River Width Scale",
        value: addonState.currentParams.riverWidthScale,
        min: 0.1,
        max: 2.0,
        onChange: (v) => {
            addonState.currentParams.riverWidthScale = parseFloat(v);
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Edge Softness",
        value: addonState.currentParams.edgeSoftness,
        min: 0.1,
        max: 2.0,
        onChange: (v) => {
            addonState.currentParams.edgeSoftness = parseFloat(v);
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });

    Entropy.UI.Widget.label(tab, { text: "🌊 Wave Parameters", bold: true });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Wind Speed",
        value: addonState.currentParams.windSpeed,
        min: 0,
        max: 20,
        onChange: (v) => {
            addonState.currentParams.windSpeed = parseFloat(v);
            generateInitialSpectrum();
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Choppiness",
        value: addonState.currentParams.choppiness,
        min: 0,
        max: 1,
        onChange: (v) => {
            addonState.currentParams.choppiness = parseFloat(v);
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Wave Amplitude",
        value: addonState.currentParams.amplitude,
        min: 0,
        max: 0.05,
        onChange: (v) => {
            addonState.currentParams.amplitude = parseFloat(v);
            generateInitialSpectrum();
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Foam Intensity",
        value: addonState.currentParams.foamIntensity,
        min: 0,
        max: 1.5,
        onChange: (v) => {
            addonState.currentParams.foamIntensity = parseFloat(v);
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });

    Entropy.UI.Widget.label(tab, { text: "🎨 Colors", bold: true });
    
    Entropy.UI.Widget.colorInput(tab, {
        label: "Shallow Water",
        color: addonState.currentParams.shallowColor,
        onChange: (c) => {
            addonState.currentParams.shallowColor = c as [number, number, number, number];
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.colorInput(tab, {
        label: "Deep Water",
        color: addonState.currentParams.deepColor,
        onChange: (c) => {
            addonState.currentParams.deepColor = c as [number, number, number, number];
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });

    Entropy.UI.Widget.label(tab, { text: "✨ Presets", bold: true });
    
    Entropy.UI.Widget.button(tab, {
        text: "🏔️ Mountain Streams",
        onClick: () => {
            addonState.currentParams.minFlowThreshold = 3.0;
            addonState.currentParams.windSpeed = 0.8;
            addonState.currentParams.amplitude = 0.002;
            addonState.currentParams.choppiness = 0.12;
            addonState.currentParams.waterDepth = 1.2;
            addonState.currentParams.riverWidthScale = 0.3;
            addonState.currentParams.shallowColor = [0.5, 0.75, 0.85, 1.0];
            addonState.currentParams.deepColor = [0.1, 0.3, 0.5, 1.0];
            addonState.currentParams.foamIntensity = 0.8;
            addonState.currentParams.flowIterations = 10;
            computeFlowAccumulation();
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🏞️ Major Rivers",
        onClick: () => {
            addonState.currentParams.minFlowThreshold = 8.0;
            addonState.currentParams.windSpeed = 1.2;
            addonState.currentParams.amplitude = 0.003;
            addonState.currentParams.choppiness = 0.08;
            addonState.currentParams.waterDepth = 3.0;
            addonState.currentParams.riverWidthScale = 0.8;
            addonState.currentParams.shallowColor = [0.3, 0.5, 0.6, 1.0];
            addonState.currentParams.deepColor = [0.05, 0.2, 0.35, 1.0];
            addonState.currentParams.foamIntensity = 0.5;
            addonState.currentParams.flowIterations = 12;
            computeFlowAccumulation();
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🌾 Gentle Creeks",
        onClick: () => {
            addonState.currentParams.minFlowThreshold = 2.0;
            addonState.currentParams.windSpeed = 0.5;
            addonState.currentParams.amplitude = 0.001;
            addonState.currentParams.choppiness = 0.05;
            addonState.currentParams.waterDepth = 0.8;
            addonState.currentParams.riverWidthScale = 0.4;
            addonState.currentParams.shallowColor = [0.4, 0.6, 0.65, 1.0];
            addonState.currentParams.deepColor = [0.15, 0.35, 0.45, 1.0];
            addonState.currentParams.foamIntensity = 0.3;
            addonState.currentParams.flowIterations = 8;
            computeFlowAccumulation();
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "⚡ Raging Rapids",
        onClick: () => {
            addonState.currentParams.minFlowThreshold = 5.0;
            addonState.currentParams.windSpeed = 3.0;
            addonState.currentParams.amplitude = 0.008;
            addonState.currentParams.choppiness = 0.25;
            addonState.currentParams.waterDepth = 2.5;
            addonState.currentParams.riverWidthScale = 0.6;
            addonState.currentParams.shallowColor = [0.7, 0.8, 0.85, 1.0];
            addonState.currentParams.deepColor = [0.2, 0.4, 0.55, 1.0];
            addonState.currentParams.foamIntensity = 1.2;
            addonState.currentParams.flowIterations = 10;
            computeFlowAccumulation();
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🌍 Show All Drainage",
        onClick: () => {
            addonState.currentParams.minFlowThreshold = 1.0;
            addonState.currentParams.waterDepth = 1.5;
            addonState.currentParams.riverWidthScale = 0.3;
            addonState.currentParams.flowIterations = 15;
            computeFlowAccumulation();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
}