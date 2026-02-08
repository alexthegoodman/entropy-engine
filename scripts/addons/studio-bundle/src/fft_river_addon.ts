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
    let landscape_y_offset = -400.0 + 8.0;
    
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    
    return (height_sample.r * max_height) + landscape_y_offset;
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

struct WaterConfig {
    shallow_color: vec4<f32>,
    medium_color: vec4<f32>,
    deep_color: vec4<f32>,
    ocean_size: vec4<f32>,
    lighting_params: vec4<f32>,
    foam_params: vec4<f32>,
    water_level: vec4<f32>,  // x: base level, y: depth threshold, z: edge softness
}
@group(5) @binding(0)
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
    @location(4) water_depth: f32,
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
    
    // Sample terrain height at this position
    let terrain_height = sample_landscape_height(in.position.xz);
    
    // Calculate water depth (how far above terrain)
    let water_base = water_config.water_level.x;
    let depth_threshold = water_config.water_level.y;
    
    // Only show water where terrain is below threshold
    let raw_depth = water_base - terrain_height;
    let water_depth = max(0.0, raw_depth);
    
    // UV coordinates for displacement lookup
    let ocean_size = water_config.ocean_size.x;
    let uv = (in.position.xz + ocean_size * 0.5) / ocean_size;
    
    // Sample displacement - scale by depth for natural effect
    let disp_data = textureSampleLevel(displacement_texture, ocean_sampler, uv, 0.0);
    let displacement = disp_data.xyz;
    
    // Scale wave displacement by water depth (calmer in shallow areas)
    let depth_factor = smoothstep(0.0, depth_threshold, water_depth);
    let scaled_displacement = displacement * depth_factor;
    
    // Apply displacement
    var world_pos = in.position + scaled_displacement;
    world_pos.y = water_base + scaled_displacement.y * 0.5; // Water surface at base level

    // var world_pos = in.position;
    
    // Compute normal from derivatives
    let deriv_data = textureSampleLevel(derivatives_texture, ocean_sampler, uv, 0.0);
    let dhdx = deriv_data.x;
    let dhdz = deriv_data.y;
    let normal = normalize(vec3<f32>(-dhdx, 1.0, -dhdz));
    
    out.world_position = world_pos;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.normal = normal;
    out.uv = uv;
    out.terrain_height = terrain_height;
    out.water_depth = water_depth;
    
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;
    
    // Discard pixels where water is too shallow (creates natural edges)
    let edge_softness = water_config.water_level.z;
    let depth_alpha = smoothstep(0.0, edge_softness, in.water_depth);
    
    // if (depth_alpha < 0.01) {
    //     discard;
    // }
    
    let view_dir = normalize(camera.view_pos.xyz - in.world_position);
    let normal = normalize(in.normal);
    
    // Sample foam
    let deriv_data = textureSample(derivatives_texture, ocean_sampler, in.uv);
    let foam = deriv_data.z;
    
    // Fresnel effect
    let ndotv = max(dot(normal, view_dir), 0.0);
    let fresnel = pow(1.0 - ndotv, water_config.lighting_params.x);
    
    // Depth-based coloring
    var water_color: vec3<f32>;
    if (in.water_depth < 2.0) {
        water_color = mix(
            water_config.shallow_color.xyz,
            water_config.medium_color.xyz,
            in.water_depth / 2.0
        );
    } else {
        water_color = mix(
            water_config.medium_color.xyz,
            water_config.deep_color.xyz,
            clamp((in.water_depth - 2.0) / 8.0, 0.0, 1.0)
        );
    }
    
    // Sky reflection
    let sky_color = vec3<f32>(0.6, 0.8, 1.0);
    var final_color = mix(water_color, sky_color, fresnel * water_config.lighting_params.y);
    
    // Specular highlight
    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, normal);
    let spec = pow(max(dot(view_dir, reflect_dir), 0.0), water_config.lighting_params.z);
    final_color += vec3<f32>(1.0, 1.0, 0.95) * spec * water_config.lighting_params.w;
    
    // Foam - more prominent in shallow areas
    let foam_intensity = smoothstep(
        water_config.foam_params.x,
        water_config.foam_params.x + 0.2,
        foam
    ) * (1.0 + (1.0 / max(in.water_depth, 0.5)));
    final_color = mix(final_color, vec3<f32>(0.95, 0.95, 1.0), foam_intensity * water_config.foam_params.y);
    
    // Edge foam in very shallow areas
    let edge_foam = smoothstep(0.0, 0.5, 0.5 - in.water_depth);
    final_color = mix(final_color, vec3<f32>(1.0, 1.0, 1.0), edge_foam * 0.3);
    
    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.85 * depth_alpha);
    output.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0);
    
    return output;
}
`;

// ===== ADDON CODE =====

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
    waterLevel: number;
    depthThreshold: number;
    edgeSoftness: number;
    
    fresnelPower: number;
    fresnelMult: number;
    specularPower: number;
    specularIntensity: number;
    
    foamThreshold: number;
    foamIntensity: number;
}

const addonInfo = {
    name: "FFT River Water",
    version: "1.0.0",
    description: "Terrain-aware FFT water that naturally flows in low-lying areas",
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
    amplitude: 0.005,
    choppiness: 0.08,
    gravity: 9.81,
    
    shallowColor: [0.4, 0.7, 0.8, 1.0],
    mediumColor: [0.1, 0.4, 0.6, 1.0],
    deepColor: [0.05, 0.2, 0.4, 1.0],
    waterLevel: -100.0,  // Adjust based on your terrain
    depthThreshold: 10.0,
    edgeSoftness: 2.0,
    
    fresnelPower: 3.0,
    fresnelMult: 0.7,
    specularPower: 200.0,
    specularIntensity: 0.5,
    
    foamThreshold: 0.85,
    foamIntensity: 0.4,
};

let addonState: {
    currentParams: RiverWaterParams,
    savedComponents: { id: string, name: string, params: RiverWaterParams }[],
    activeComponentId: string | null
} = {
    currentParams: { ...riverParams },
    savedComponents: [],
    activeComponentId: Entropy.generateUUID()
};

let pipelineIds = {
    spectrumInit: null as string | null,
    spectrumUpdate: null as string | null,
    fftHorizontal: null as string | null,
    fftVertical: null as string | null,
    displacement: null as string | null,
    waterRender: null as string | null,
};

let textures = {
    h0: null as string | null,
    ht: null as string | null,
    pingpong: [null, null] as (string | null)[],
    displacement: null as string | null,
    derivatives: null as string | null,
};

addon.onInit(async () => {
    Entropy.println("🌊 FFT River Water: Initializing...");
    
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
    
    // Create water render pipeline with landscape binding
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
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }] }
        ]
    });
    
    // Initialize resources
    initializeResources();
    generateInitialSpectrum();
    // createWaterMesh("river_water_preview", addonState.currentParams);
    
    // Lighting
    addon.Lighting.createPointLight({
        position: [0.0, 50.0, 0.0],
        color: [0.9, 0.95, 1.0],
        intensity: 10.0,
        maxDistance: 500.0
    });
    
    setupUI();

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderUI);
        
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer(addonInfo.name, (id: string, params: RiverWaterParams) => {
                // For the composer, we might want to respect the instance position
                // The current shader assumes y=oceanHeight, but we should probably add world pos
                createWaterMesh(id, params);
            });
        }
    }
    
    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            addonState = { ...addonState, ...data };
            if (Entropy.Composer) {
                addonState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });

    addon.onUpdatePlus("Game Composer", (time) => {
        (globalThis as any).__entropy_current_addon_context_override = "Game Composer";
        updateWater(time);
        (globalThis as any).__entropy_current_addon_context_override = null;
    });

    addon.onUpdate((time) => {
        updateWater(time);
    });
    
    Entropy.println("✅ FFT River Water initialized!");
});

function initializeResources() {
    const N = addonState.currentParams.resolution;
    textures.h0 = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.ht = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[0] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[1] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.displacement = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.derivatives = Entropy.Texture.createStorage(N, N, "Rgba16Float");
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
        params.waterLevel, params.depthThreshold, params.edgeSoftness, 0,
    ];

    const pos = params._transform?.position || [0, 0, 0];
    
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
            { group: 5, binding: 0, resource: { type: "Uniform", value: { data: waterConfig } } },
        ]
    });
    
    Entropy.println(`River water mesh created: ${id} pos: ` + JSON.stringify(pos));
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
    Entropy.UI.Widget.label(tab, { text: "🌊 FFT River Water", bold: true });

    Entropy.UI.Widget.button(tab, { text: "💾 Save All to Project", onClick: () => {
        addon.IO.save(addonState);
        if (Entropy.Composer) {
            addonState.savedComponents.forEach(comp => { Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params); });
        }
    }});

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

    Entropy.UI.Widget.label(tab, { text: "💧 Water Level Control", bold: true });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Water Level (Height)",
        value: addonState.currentParams.waterLevel,
        min: -600,
        max: -300,
        onChange: (v) => {
            addonState.currentParams.waterLevel = parseFloat(v);
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Depth Threshold",
        value: addonState.currentParams.depthThreshold,
        min: 1,
        max: 50,
        onChange: (v) => {
            addonState.currentParams.depthThreshold = parseFloat(v);
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Edge Softness",
        value: addonState.currentParams.edgeSoftness,
        min: 0.1,
        max: 10,
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
        text: "🏞️ Mountain Stream",
        onClick: () => {
            addonState.currentParams.windSpeed = 1.0;
            addonState.currentParams.amplitude = 0.003;
            addonState.currentParams.choppiness = 0.15;
            addonState.currentParams.shallowColor = [0.5, 0.75, 0.85, 1.0];
            addonState.currentParams.deepColor = [0.1, 0.3, 0.5, 1.0];
            addonState.currentParams.foamIntensity = 0.6;
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🌊 Calm Lake",
        onClick: () => {
            addonState.currentParams.windSpeed = 0.5;
            addonState.currentParams.amplitude = 0.001;
            addonState.currentParams.choppiness = 0.03;
            addonState.currentParams.shallowColor = [0.3, 0.6, 0.7, 1.0];
            addonState.currentParams.deepColor = [0.05, 0.15, 0.3, 1.0];
            addonState.currentParams.foamIntensity = 0.2;
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "💎 Crystal Clear",
        onClick: () => {
            addonState.currentParams.windSpeed = 0.3;
            addonState.currentParams.amplitude = 0.002;
            addonState.currentParams.choppiness = 0.05;
            addonState.currentParams.shallowColor = [0.6, 0.85, 0.95, 0.7];
            addonState.currentParams.deepColor = [0.2, 0.5, 0.7, 0.8];
            addonState.currentParams.foamIntensity = 0.1;
            generateInitialSpectrum();
            createWaterMesh("river_water_preview", addonState.currentParams);
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🔄 Regenerate Spectrum",
        onClick: () => generateInitialSpectrum()
    });
}