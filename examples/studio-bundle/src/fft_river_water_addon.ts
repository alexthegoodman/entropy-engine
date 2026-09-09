// ============================================================================
// FFT RIVER WATER (standalone) - a narrow, meandering channel carved into a
// procedural landscape, water field driven by the same GPU FFT pipeline as
// fft_water_addon.ts's ocean but with the initial spectrum switched from
// Phillips to JONSWAP (fetch-limited seas - a river channel is about as
// fetch-limited as it gets) and a UV-scroll advection hack layered on top so
// the wave pattern visibly travels downstream.
//
// This is a fresh, standalone file - NOT a modification of fft_water_addon.ts,
// fft_river_addon.ts, or gpgpu_river_addon.ts. Those two river files are
// separate, unverified experiments and are left untouched.
//
// Landscape heightfield: uses createNoise2D (simplex-noise) seeded through
// Alea, the same combination flexnoise_v2.ts's FlexNoise terrain addon uses,
// instead of the flat single-slope bank ramp this file started with. The
// channel carve (flat floor out to CHANNEL_HALF_WIDTH, then a ramp across
// BANK_WIDTH) is kept exactly as before so the water channel is unaffected -
// only what the ramp blends *into* changed, from a flat plateau to fbm noise.
// ============================================================================

import { createNoise2D } from 'simplex-noise';
import Alea from 'alea';

// ===== COMPUTE SHADERS (spectrum init/update, FFT, displacement - adapted from fft_water_addon.ts) =====

const SPECTRUM_INIT_SHADER = `
struct SpectrumParams {
    resolution: f32,
    field_size: f32,
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
    return fract((p3.x + p3.y) * p3_dot);
}

fn gaussian_random(uv: vec2<f32>) -> vec2<f32> {
    let u1 = hash(uv);
    let u2 = hash(uv + vec2<f32>(127.1, 311.7));
    let r = sqrt(-2.0 * log(u1 + 0.0001));
    let theta = 6.28318530718 * u2;
    return vec2<f32>(r * cos(theta), r * sin(theta));
}

// Phillips spectrum - kept for reference/comparison, not used by main() below.
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
    return params.amplitude * exp(-1.0 / (k_length2 * L * L)) / k_length4 * k_dot_w2 * exp(-k_length2 * l2);
}

// JONSWAP spectrum - models fetch-limited seas with a pronounced dominant frequency peak.
// A river channel has essentially zero fetch (the wind can only act on it across the
// channel width, not for kilometers like open ocean), so the sharp, narrow-fetch peak
// this spectrum was built for is a better physical fit here than open-ocean Phillips.
fn jonswap_spectrum(wave_vector: vec2<f32>) -> f32 {
    let wave_number = length(wave_vector);
    if (wave_number < 0.0001) {
        return 0.0;
    }

    let omega_p = 0.87 * params.gravity / params.wind_speed;
    let peak_wave_number = (omega_p * omega_p) / params.gravity;

    let alpha = 0.0081;
    let beta  = 1.25;
    let pm_shape = (alpha / (wave_number * wave_number * wave_number * wave_number))
                 * exp(-beta * pow(peak_wave_number / wave_number, 2.0));

    let gamma         = 5.3;
    let sigma         = select(0.09, 0.07, wave_number <= peak_wave_number);
    let peak_exponent = exp(
        -pow(sqrt(wave_number / peak_wave_number) - 1.0, 2.0)
        / (2.0 * sigma * sigma)
    );
    let peak_enhancement = pow(gamma, peak_exponent);

    let wind_dir    = normalize(vec2<f32>(params.wind_direction_x, params.wind_direction_y));
    let k_dir       = wave_vector / wave_number;
    let directional = max(0.0, dot(k_dir, wind_dir));
    let spreading   = directional * directional;

    let capillary_cutoff = 0.001;
    let damping = exp(-wave_number * wave_number * capillary_cutoff * capillary_cutoff);

    return params.amplitude * pm_shape * peak_enhancement * spreading * damping;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let N = u32(params.resolution);
    let n = vec2<f32>(f32(id.x) - f32(N) * 0.5, f32(id.y) - f32(N) * 0.5);
    let k = (2.0 * 3.14159265359 * n) / params.field_size;

    let ph = jonswap_spectrum(k);

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
    field_size: f32,
    gravity: f32,
    choppiness: f32,
    padding1: f32,
    padding2: f32,
    padding3: f32,
}

@group(0) @binding(0)
var initial_spectrum_h0: texture_2d<f32>;

@group(0) @binding(1)
var output_animated_spectrum: texture_storage_2d<rgba16float, write>;

@group(0) @binding(2)
var<uniform> params: TimeParams;

fn complex_multiply(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let grid_size = u32(params.resolution);
    let grid_offset = vec2<f32>(
        f32(global_id.x) - f32(grid_size) * 0.5,
        f32(global_id.y) - f32(grid_size) * 0.5
    );
    let wave_vector = (2.0 * 3.14159265359 * grid_offset) / params.field_size;
    let wave_number = length(wave_vector);
    let angular_frequency = sqrt(params.gravity * wave_number);

    let packed_initial_spectrum = textureLoad(initial_spectrum_h0, vec2<i32>(global_id.xy), 0);
    let h0_k            = vec2<f32>(packed_initial_spectrum.x, packed_initial_spectrum.y);
    let h0_minus_k_conj = vec2<f32>(packed_initial_spectrum.z, packed_initial_spectrum.w);

    let phase_angle     = angular_frequency * params.time;
    let phasor_forward  = vec2<f32>( cos(phase_angle), sin(phase_angle));
    let phasor_backward = vec2<f32>( cos(phase_angle), -sin(phase_angle));

    let animated_height_spectrum = complex_multiply(h0_k, phasor_forward)
                                 + complex_multiply(h0_minus_k_conj, phasor_backward);

    var displacement_x = vec2<f32>(0.0);
    var displacement_z = vec2<f32>(0.0);

    if (wave_number > 0.0001) {
        let wave_direction = wave_vector / wave_number;
        let height_rotated_by_neg_i = vec2<f32>(animated_height_spectrum.y, -animated_height_spectrum.x);
        displacement_x = height_rotated_by_neg_i * wave_direction.x * params.choppiness;
        displacement_z = height_rotated_by_neg_i * wave_direction.y * params.choppiness;
    }

    textureStore(
        output_animated_spectrum,
        vec2<i32>(global_id.xy),
        vec4<f32>(animated_height_spectrum.x, animated_height_spectrum.y, displacement_x.x, displacement_z.x)
    );
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

fn cadd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> { return a + b; }

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

    let h_result = cadd(h_val, cmul(twiddle, q_h));
    let d_result = cadd(d_val, cmul(twiddle, q_d));

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
    field_size: f32,
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

    let displacement = vec3<f32>(choppy_x * sign_correction, height * sign_correction, choppy_z * sign_correction);

    let x_next = (id.x + 1u) % N;
    let x_prev = select(id.x - 1u, N - 1u, id.x == 0u);
    let y_next = (id.y + 1u) % N;
    let y_prev = select(id.y - 1u, N - 1u, id.y == 0u);

    let h_right = textureLoad(input_fft, vec2<i32>(i32(x_next), i32(id.y)), 0).x;
    let h_left  = textureLoad(input_fft, vec2<i32>(i32(x_prev), i32(id.y)), 0).x;
    let h_top   = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_next)), 0).x;
    let h_bottom = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_prev)), 0).x;

    let texel_size = params.field_size / f32(N);
    let dhdx = (h_right - h_left) / (2.0 * texel_size);
    let dhdz = (h_top - h_bottom) / (2.0 * texel_size);

    let dx_right = textureLoad(input_fft, vec2<i32>(i32(x_next), i32(id.y)), 0).z;
    let dx_left  = textureLoad(input_fft, vec2<i32>(i32(x_prev), i32(id.y)), 0).z;
    let dz_top   = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_next)), 0).w;
    let dz_bottom = textureLoad(input_fft, vec2<i32>(i32(id.x), i32(y_prev)), 0).w;

    let dDx_dx = (dx_right - dx_left) / (2.0 * texel_size);
    let dDz_dz = (dz_top - dz_bottom) / (2.0 * texel_size);
    let jacobian = (1.0 + dDx_dx) * (1.0 + dDz_dz);

    textureStore(output_displacement, vec2<i32>(id.xy), vec4<f32>(displacement, jacobian));

    let foam = clamp(-jacobian + 1.0, 0.0, 1.0);
    textureStore(output_derivatives, vec2<i32>(id.xy), vec4<f32>(dhdx, dhdz, foam, 0.0));
}
`;

// ===== WATER RENDER SHADER =====
// Same structure as fft_water_addon.ts's WATER_RENDER_SHADER, with one addition:
// flow_params in WaterConfig drives a UV-scroll advection so the wave pattern visibly
// travels downstream. This works cleanly (no seams) because an FFT-generated height
// field is periodic by construction - `fract()` on the scrolled UV just wraps into the
// next tile of the same seamless field, unlike scrolling a normal photographed texture.
// It is NOT a real flow/advection solve (no momentum, no interaction with the channel
// banks) - it is a texture-space trick layered on top of a stationary wave spectrum.

const WATER_RENDER_SHADER = `
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
var water_sampler: sampler;

struct WaterConfig {
    shallow_color: vec4<f32>,
    medium_color: vec4<f32>,
    deep_color: vec4<f32>,
    field_size_and_height: vec4<f32>, // x: fft field size, y: water world-Y offset
    lighting_params: vec4<f32>,       // x: fresnel_pow, y: fresnel_mult, z: spec_pow, w: spec_int
    flow_params: vec4<f32>,           // x: flow_dir_x (uv/sec), y: flow_dir_z (uv/sec), z,w: padding
}
@group(4) @binding(0)
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

    let field_size = water_config.field_size_and_height.x;
    let base_uv = (in.position.xz + field_size * 0.5) / field_size;
    let flow_uv = fract(base_uv + water_config.flow_params.xy * u_time.time);

    let disp_data = textureSampleLevel(displacement_texture, water_sampler, flow_uv, 0.0);
    let displacement = disp_data.xyz;

    var world_pos = in.position + displacement;
    world_pos.y += water_config.field_size_and_height.y;

    let deriv_data = textureSampleLevel(derivatives_texture, water_sampler, flow_uv, 0.0);
    let dhdx = deriv_data.x;
    let dhdz = deriv_data.y;
    let normal = normalize(vec3<f32>(-dhdx, 1.0, -dhdz));

    out.world_position = world_pos;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.normal = normal;
    out.uv = flow_uv;

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;

    let view_dir = normalize(camera.view_pos.xyz - in.world_position);
    let ndotv = max(dot(normalize(in.normal), view_dir), 0.0);
    let fresnel = pow(1.0 - ndotv, water_config.lighting_params.x);

    let water_depth = 4.0;
    var water_color: vec3<f32>;
    if (water_depth < 2.0) {
        water_color = mix(water_config.shallow_color.xyz, water_config.medium_color.xyz, water_depth / 2.0);
    } else {
        water_color = mix(water_config.medium_color.xyz, water_config.deep_color.xyz, clamp((water_depth - 2.0) / 8.0, 0.0, 1.0));
    }

    let sky_color = vec3<f32>(0.6, 0.8, 1.0);
    var final_color = mix(water_color, sky_color, fresnel * water_config.lighting_params.y);

    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, normalize(in.normal));
    let spec = pow(max(dot(view_dir, reflect_dir), 0.0), water_config.lighting_params.z);
    final_color += vec3<f32>(1.0, 1.0, 0.95) * spec * water_config.lighting_params.w;

    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal   = vec4<f32>(in.normal, 1.0);
    output.albedo   = vec4<f32>(final_color, 0.85);
    output.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0);

    return output;
}
`;

// ===== TYPESCRIPT ADDON =====

const addonInfo = {
    name: "FFT River",
    version: "1.0.0",
    description: "Standalone GPU-accelerated FFT river: JONSWAP wave spectrum confined to a carved terrain channel, with UV-scroll flow advection.",
    author: ["Entropy Team", "Claude"],
    capabilities: { audio: false, ui: false }
};

const addon = Entropy.AddonAtom.register(addonInfo);

// ----- Channel geometry (shared by the landscape heightmap and the water ribbon mesh) -----
const FIELD_SIZE = 800.0;        // world size of both the landscape and the FFT field (must match)
const LANDSCAPE_RES = 256;       // heightmap grid resolution
const LANDSCAPE_SCALE = 40.0;    // vertical scale (world units) applied to normalized heights
const LANDSCAPE_BASE_Y = -20.0;  // world Y of the landscape's lowest point (the channel floor)
const CHANNEL_HALF_WIDTH = 18.0; // half-width of the flat channel floor, world units
const BANK_WIDTH = 30.0;         // distance over which the bank ramps up from floor into the noise terrain
const MEANDER_AMPLITUDE = 45.0;  // how far the channel wanders left/right, world units
const MEANDER_WAVELENGTH = 260.0; // world-Z distance per full meander cycle
const WATER_DEPTH = 4.0;         // water surface sits this far above the channel floor
const WATER_Y = LANDSCAPE_BASE_Y + WATER_DEPTH;

// ----- Terrain noise (fbm via simplex-noise's createNoise2D, seeded through Alea) -----
const TERRAIN_SEED = 1337;
const TERRAIN_FREQUENCY = 0.006;
const TERRAIN_OCTAVES = 5;
const TERRAIN_PERSISTENCE = 0.5;
const TERRAIN_LACUNARITY = 2.0;

function channelCenterX(worldZ: number): number {
    return MEANDER_AMPLITUDE * Math.sin((2 * Math.PI * (worldZ + FIELD_SIZE / 2)) / MEANDER_WAVELENGTH);
}

function fbm2D(noise2D: (x: number, y: number) => number, x: number, y: number, octaves: number, frequency: number, persistence: number, lacunarity: number): number {
    let total = 0;
    let amplitude = 1;
    let maxValue = 0;
    let freq = frequency;

    for (let i = 0; i < octaves; i++) {
        total += noise2D(x * freq, y * freq) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        freq *= lacunarity;
    }

    return total / maxValue; // [-1, 1]
}

function buildChannelHeights(): number[] {
    const prng = Alea(TERRAIN_SEED);
    const noise2D = createNoise2D(prng);

    const heights = new Array(LANDSCAPE_RES * LANDSCAPE_RES);
    for (let row = 0; row < LANDSCAPE_RES; row++) {
        const worldZ = (row / LANDSCAPE_RES) * FIELD_SIZE - FIELD_SIZE / 2;
        const cx = channelCenterX(worldZ);
        for (let col = 0; col < LANDSCAPE_RES; col++) {
            const worldX = (col / LANDSCAPE_RES) * FIELD_SIZE - FIELD_SIZE / 2;
            const d = Math.abs(worldX - cx);

            let h: number;
            if (d <= CHANNEL_HALF_WIDTH) {
                // Flat channel floor - unchanged from the original carve, this is what
                // keeps the water channel a clean, flat bed for the FFT ribbon to sit in.
                h = 0.0;
            } else {
                const terrainHeight = (fbm2D(noise2D, worldX, worldZ, TERRAIN_OCTAVES, TERRAIN_FREQUENCY, TERRAIN_PERSISTENCE, TERRAIN_LACUNARITY) + 1) / 2;
                const bankT = Math.min(1.0, (d - CHANNEL_HALF_WIDTH) / BANK_WIDTH);
                // Ramp from the flat bank edge (0) into the noise-driven terrain (bankT=1
                // at BANK_WIDTH and beyond), so the banks blend smoothly into rolling
                // terrain instead of a flat plateau at height 1.
                h = bankT * terrainHeight;
            }
            heights[row * LANDSCAPE_RES + col] = h;
        }
    }
    return heights;
}

// ----- Landscape PBR texture -----
// A simple procedural ground texture (grass/dirt diffuse + bump normal + flat
// AO/roughness/metallic), generated and applied the same way
// pbr_texture_designer_addon.ts's generateTextures()/generatePBRTextures() do
// (Texture.create per map, then Landscape.updateTexture/updatePbrTexture) but
// without that addon's pattern-library/Composer machinery - this river addon
// just needs one static ground look, not an editable material.
const PBR_TEXTURE_RES = 256;

function applyLandscapePBR(): void {
    const prng = Alea(TERRAIN_SEED + 1); // distinct stream from the heightfield noise
    const noise2D = createNoise2D(prng);

    const res = PBR_TEXTURE_RES;
    const diffData = new Uint8Array(res * res * 4);
    const norData = new Uint8Array(res * res * 4);
    const armData = new Uint8Array(res * res * 4);

    const dirtColor = [0.34, 0.26, 0.17];
    const grassColor = [0.22, 0.38, 0.14];

    // Height field sampled at texel resolution, reused both for the diffuse
    // grass/dirt blend and (via finite differences) the normal map's bump.
    const heightAt = (x: number, y: number) => fbm2D(noise2D, x, y, 4, 0.06, 0.5, 2.0);
    const heightMap = new Float32Array(res * res);
    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            heightMap[y * res + x] = heightAt(x, y);
        }
    }

    for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
            const idx = (y * res + x) * 4;
            const h = heightMap[y * res + x]; // [-1, 1]

            // Blend dirt -> grass with the same noise field driving the bump,
            // so patchier/rockier ground reads visually lower and duller.
            const grassT = Math.max(0, Math.min(1, h * 0.5 + 0.55));
            diffData[idx]     = Math.round((dirtColor[0] + (grassColor[0] - dirtColor[0]) * grassT) * 255);
            diffData[idx + 1] = Math.round((dirtColor[1] + (grassColor[1] - dirtColor[1]) * grassT) * 255);
            diffData[idx + 2] = Math.round((dirtColor[2] + (grassColor[2] - dirtColor[2]) * grassT) * 255);
            diffData[idx + 3] = 255;

            const hL = heightMap[y * res + Math.max(0, x - 1)];
            const hR = heightMap[y * res + Math.min(res - 1, x + 1)];
            const hU = heightMap[Math.max(0, y - 1) * res + x];
            const hD = heightMap[Math.min(res - 1, y + 1) * res + x];
            const normalStrength = 1.5;
            const nx = (hL - hR) * normalStrength;
            const ny = (hU - hD) * normalStrength;
            const nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            norData[idx]     = Math.round((nx / len * 0.5 + 0.5) * 255);
            norData[idx + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
            norData[idx + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
            norData[idx + 3] = 255;

            // AO/Roughness/Metallic: mild AO in low spots, uniformly rough, non-metal.
            armData[idx]     = Math.round(200 + grassT * 55); // AO
            armData[idx + 1] = Math.round(230);                // roughness
            armData[idx + 2] = 0;                               // metallic
            armData[idx + 3] = 255;
        }
    }

    const diffId = Entropy.Texture.create(res, res, diffData);
    const norId = Entropy.Texture.create(res, res, norData);
    const armId = Entropy.Texture.create(res, res, armData);

    Entropy.Landscape.updateTexture(diffId, "Primary");
    Entropy.Landscape.updatePbrTexture(norId, "Normal", "Primary");
    Entropy.Landscape.updatePbrTexture(armId, "AORoughnessMetallic", "Primary");
}

interface RiverParams {
    resolution: number;
    windSpeed: number;
    windDirection: [number, number];
    amplitude: number;
    choppiness: number;
    gravity: number;
    flowSpeed: number; // UV units per second along +Z
    shallowColor: [number, number, number, number];
    mediumColor: [number, number, number, number];
    deepColor: [number, number, number, number];
    fresnelPower: number;
    fresnelMult: number;
    specularPower: number;
    specularIntensity: number;
}

let riverParams: RiverParams = {
    resolution: 256,
    windSpeed: 3.0,
    windDirection: [0.2, 1.0],
    amplitude: 0.05,
    choppiness: 0.25,
    gravity: 9.81,
    flowSpeed: 0.045,

    shallowColor: [0.25, 0.55, 0.5, 1.0],
    mediumColor: [0.1, 0.35, 0.4, 1.0],
    deepColor: [0.04, 0.18, 0.25, 1.0],

    fresnelPower: 3.0,
    fresnelMult: 0.7,
    specularPower: 200.0,
    specularIntensity: 0.6,
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

function initializeResources() {
    const N = riverParams.resolution;
    textures.h0 = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.ht = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[0] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.pingpong[1] = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.displacement = Entropy.Texture.createStorage(N, N, "Rgba16Float");
    textures.derivatives = Entropy.Texture.createStorage(N, N, "Rgba16Float");
}

function generateInitialSpectrum() {
    if (!pipelineIds.spectrumInit || !textures.h0) return;

    const params = [
        riverParams.resolution,
        FIELD_SIZE,
        riverParams.windSpeed,
        riverParams.windDirection[0],
        riverParams.windDirection[1],
        riverParams.amplitude,
        riverParams.gravity,
        0.0,
    ];

    const N = riverParams.resolution;
    const workgroups = Math.ceil(N / 8);

    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.spectrumInit,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "StorageTextureRgba16", value: { id: textures.h0! } } },
            { group: 0, binding: 1, resource: { type: "Uniform", value: { data: params } } },
        ]
    });
}

function updateRiver(time: number) {
    if (!pipelineIds.spectrumUpdate || !textures.h0 || !textures.ht) return;

    const N = riverParams.resolution;
    const workgroups = Math.ceil(N / 8);
    const logN = Math.log2(N);

    const timeParams = [time, N, FIELD_SIZE, riverParams.gravity, riverParams.choppiness, 0, 0, 0];

    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.spectrumUpdate,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: textures.h0! } } },
            { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: textures.ht! } } },
            { group: 0, binding: 2, resource: { type: "Uniform", value: { data: timeParams } } },
        ]
    });

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

    const outputParams = [N, FIELD_SIZE, riverParams.choppiness, 0];
    Entropy.Compute.dispatch({
        pipelineId: pipelineIds.displacement!,
        groups: [workgroups, workgroups, 1],
        bindings: [
            { group: 0, binding: 0, resource: { type: "TextureNonFilterable", value: { id: textures.pingpong[pingpong]! } } },
            { group: 0, binding: 1, resource: { type: "StorageTextureRgba16", value: { id: textures.displacement! } } },
            { group: 0, binding: 2, resource: { type: "StorageTextureRgba16", value: { id: textures.derivatives! } } },
            { group: 0, binding: 3, resource: { type: "Uniform", value: { data: outputParams } } },
        ]
    });
}

function createRiverMesh(id: string) {
    if (!pipelineIds.waterRender) return;

    const segments = 160;
    const waterHalfWidth = CHANNEL_HALF_WIDTH * 0.85; // stay inside the carved flat zone so banks show at the edges

    const vertices: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
        const worldZ = -FIELD_SIZE / 2 + (i / segments) * FIELD_SIZE;
        const cx = channelCenterX(worldZ);
        const xLeft = cx - waterHalfWidth;
        const xRight = cx + waterHalfWidth;
        const v = i / segments;

        vertices.push(xLeft, 0, worldZ,   0, 1, 0,   0, v,   1, 1, 1, 1);
        vertices.push(xRight, 0, worldZ,  0, 1, 0,   1, v,   1, 1, 1, 1);
    }

    for (let i = 0; i < segments; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        indices.push(a, c, b);
        indices.push(b, c, d);
    }

    const waterConfig = [
        ...riverParams.shallowColor,
        ...riverParams.mediumColor,
        ...riverParams.deepColor,
        FIELD_SIZE, WATER_Y, 0, 0,
        riverParams.fresnelPower, riverParams.fresnelMult, riverParams.specularPower, riverParams.specularIntensity,
        0.0, riverParams.flowSpeed, 0, 0,
    ];

    Entropy.Model.clearMesh(id);
    Entropy.Model.createMesh({
        id: id,
        position: [0, 0, 0],
        scale: [1, 1, 1],
        vertexData: vertices,
        indexData: indices,
        pipelineId: pipelineIds.waterRender,
        renderRole: "Water",
        bindings: [
            { group: 2, binding: 0, resource: { type: "Time" } },
            { group: 3, binding: 0, resource: { type: "Texture", value: { id: textures.displacement! } } },
            { group: 3, binding: 1, resource: { type: "Texture", value: { id: textures.derivatives! } } },
            { group: 3, binding: 2, resource: { type: "Sampler" } },
            { group: 4, binding: 0, resource: { type: "Uniform", value: { data: waterConfig } } },
        ]
    });

    Entropy.println(`Created river water mesh: ${id}`);
}

addon.onInit(async () => {
    Entropy.println("River: onInit started");

    pipelineIds.spectrumInit = Entropy.Pipeline.createCompute({
        name: "River_SpectrumInit",
        shaderSource: SPECTRUM_INIT_SHADER,
        bindGroups: [{
            entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
                { binding: 1, visibility: ["Compute"], resourceType: "Uniform" },
            ]
        }]
    });

    pipelineIds.spectrumUpdate = Entropy.Pipeline.createCompute({
        name: "River_SpectrumUpdate",
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
        name: "River_FFT_Horizontal",
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
        name: "River_FFT_Vertical",
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
        name: "River_Displacement",
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

    pipelineIds.waterRender = Entropy.Pipeline.create({
        name: "River_Water_Render",
        layout: "mesh",
        vertexShader: WATER_RENDER_SHADER,
        fragmentShader: WATER_RENDER_SHADER,
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
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }] },
        ]
    });

    Entropy.println("River: init resources");
    initializeResources();

    // Carve the channel into a landscape. Entropy.Landscape (top-level, not a
    // ComponentAddon's this.api.Landscape) tags this "Global" by default - see
    // globalContextualAPI in addon_setup.js - which is what makes it pass the
    // addon-name filter in render_addon_frame.rs/render_frame.rs outside Studio.
    Entropy.Landscape.create({
        id: Entropy.generateUUID(),
        width: LANDSCAPE_RES,
        height: LANDSCAPE_RES,
        heights: buildChannelHeights(),
        position: [0, LANDSCAPE_BASE_Y, 0],
        size: FIELD_SIZE,
        scale: LANDSCAPE_SCALE,
    });
    applyLandscapePBR();

    Entropy.println("River: spectrum + camera + lights");
    generateInitialSpectrum();

    Entropy.Camera.setTransform(
        [110, WATER_Y + 90, -260],
        [0, WATER_Y, -60]
    );

    // Shift + left-drag orbits the camera around the river; shift + right-drag
    // dollies in/out. One call - see Entropy.Controls in addon_setup.js for the
    // shared implementation every addon can opt into instead of hand-wiring
    // Input.onMouseDown/Move/Up + isShiftPressed() itself.
    Entropy.Controls.enable("orbit", { target: [0, WATER_Y, -60] });

    // The terrain uses the default PBR geometry pipeline, which (unlike the self-lit
    // WATER_RENDER_SHADER above) depends on the deferred lighting pass's ambient/sun term -
    // point lights alone left it essentially black beyond their falloff radius. updateSun
    // takes no addon-name argument at all (see addon_setup.js's Lighting.updateSun - it's a
    // pure global op), so there's no "Global" tagging question here.
    Entropy.Lighting.updateSun({
        sunDirection: [0.35, 0.8, 0.4],
        sunColor: [1.0, 0.95, 0.85],
        sunIntensity: 6.0,
        horizonColor: [0.6, 0.7, 0.75],
        zenithColor: [0.15, 0.25, 0.45],
    });

    // Entropy.Lighting (top-level), not addon.Lighting - same "Global" tagging reasoning
    // as fft_water_addon.ts.
    Entropy.Lighting.createPointLight({ position: [0, 60, -200], color: [1.0, 0.98, 0.9], intensity: 12.0, maxDistance: 500.0 });
    Entropy.Lighting.createPointLight({ position: [60, 50, 0], color: [1.0, 0.98, 0.9], intensity: 12.0, maxDistance: 500.0 });
    Entropy.Lighting.createPointLight({ position: [-60, 50, 150], color: [1.0, 0.98, 0.9], intensity: 12.0, maxDistance: 500.0 });

    createRiverMesh("fft_river_preview");

    // See fft_water_addon.ts's addon.onUpdate/onUpdatePlus("Global", ...) comment - outside
    // Studio, current_addon_name defaults to "Global", not this addon's own registered name.
    addon.onUpdate((time: number) => updateRiver(time));
    addon.onUpdatePlus("Global", (time: number) => updateRiver(time));

    Entropy.println("River initialized");
});
