// ===== UNIFORMS & BINDINGS =====
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct Time {
    time: f32,
};
@group(1) @binding(0)
var<uniform> u_time: Time;

@group(2) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(2) @binding(1)
var landscape_sampler: sampler;

struct WaterConfig {
    shallow_color: vec4<f32>,
    medium_color: vec4<f32>,
    deep_color: vec4<f32>,
    player_pos: vec4<f32>,
    ripple_amplitude_multiplier: f32,
    ripple_freq: f32,
    ripple_speed: f32,
    shoreline_foam_range: f32,
    crest_foam_min: f32,
    crest_foam_max: f32,
    sparkle_intensity: f32,
    sparkle_threshold: f32,
    subsurface_multiplier: f32,
    fresnel_power: f32,
    fresnel_multiplier: f32,
    
    // Wave 1 parameters
    wave1_amplitude: f32,
    wave1_frequency: f32,
    wave1_speed: f32,
    wave1_steepness: f32,
    wave1_direction: vec2<f32>,
    
    // Wave 2 parameters
    wave2_amplitude: f32,
    wave2_frequency: f32,
    wave2_speed: f32,
    wave2_steepness: f32,
    wave2_direction: vec2<f32>,
    
    // Wave 3 parameters
    wave3_amplitude: f32,
    wave3_frequency: f32,
    wave3_speed: f32,
    wave3_steepness: f32,
    wave3_direction: vec2<f32>,
}
@group(3) @binding(0)
var<uniform> water_config: WaterConfig;


// ===== STRUCTS =====
struct VertexInput {
    @location(0) position: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) wave_velocity: vec2<f32>,
    @location(3) tangent: vec3<f32>,
    @location(4) bitangent: vec3<f32>,
};

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}


// ===== LANDSCAPE SAMPLING =====
fn sample_landscape_height(world_pos: vec2<f32>) -> f32 {
    let landscape_size = 4096.0;
    let max_height = 600.0;
    
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    return (height_sample.r * max_height) - 400.0;
}

// ===== IMPROVED NOISE FUNCTIONS =====
fn hash(p: vec2<f32>) -> f32 {
    let p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.13);
    let p3_dot = dot(p3, vec3<f32>(p3.y + 3.333, p3.z + 3.333, p3.x + 3.333));
    return fract((p3.x + p3.y) * p3_dot);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    
    return mix(
        mix(hash(i + vec2<f32>(0.0, 0.0)), hash(i + vec2<f32>(1.0, 0.0)), u.x),
        mix(hash(i + vec2<f32>(0.0, 1.0)), hash(i + vec2<f32>(1.0, 1.0)), u.x),
        u.y
    );
}

// Derivative noise for proper normal calculation
fn noise_derivative(p: vec2<f32>) -> vec3<f32> {
    let eps = 0.01;
    let center = noise(p);
    let dx = (noise(p + vec2<f32>(eps, 0.0)) - center) / eps;
    let dy = (noise(p + vec2<f32>(0.0, eps)) - center) / eps;
    return vec3<f32>(dx, dy, center);
}

// Fractional Brownian Motion for multi-scale detail
fn fbm(p: vec2<f32>, octaves: i32) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    var coord = p;
    
    for (var i = 0; i < octaves; i++) {
        value += amplitude * noise(coord * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    
    return value;
}

fn fbm_derivative(p: vec2<f32>, octaves: i32) -> vec3<f32> {
    var value = vec3<f32>(0.0);
    var amplitude = 0.5;
    var frequency = 1.0;
    var coord = p;
    
    for (var i = 0; i < octaves; i++) {
        value += amplitude * noise_derivative(coord * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    
    return value;
}

// ===== GERSTNER WAVES =====
fn gerstner_wave(p: vec2<f32>, D: vec2<f32>, Q: f32, A: f32, w: f32, phi: f32) -> vec3<f32> {
    let dot_d_p = dot(D, p);
    let phase = w * dot_d_p + u_time.time * phi;
    let cos_val = cos(phase);
    let sin_val = sin(phase);
    
    let asymmetry = 0.3;
    let modified_sin = sin_val + asymmetry * sin(2.0 * phase);
    
    let x = Q * A * D.x * cos_val;
    let y = A * modified_sin;
    let z = Q * A * D.y * cos_val;
    
    return vec3<f32>(x, y, z);
}

fn gerstner_wave_normal(p: vec2<f32>, D: vec2<f32>, Q: f32, A: f32, w: f32, phi: f32) -> vec3<f32> {
    let dot_d_p = dot(D, p);
    let phase = w * dot_d_p + u_time.time * phi;
    let cos_val = cos(phase);

    let asymmetry = 0.3;
    let modified_cos = cos_val + asymmetry * 2.0 * cos(2.0 * phase);

    let wa = w * A;
    let x = D.x * wa * cos_val;
    let y = Q * wa * modified_cos;
    let z = D.y * wa * cos_val;

    return vec3<f32>(x, y, z);
}

fn gerstner_wave_velocity(p: vec2<f32>, D: vec2<f32>, A: f32, w: f32, phi: f32) -> vec2<f32> {
    let phase = w * dot(D, p) + u_time.time * phi;
    return D * A * w * phi * cos(phase);
}

// ===== VERTEX SHADER =====
@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    var pos = in.position;
    var normal = vec3<f32>(0.0, 1.0, 0.0);
    var velocity = vec2<f32>(0.0, 0.0);

    // Normalize wave directions from config
    let dir1 = normalize(water_config.wave1_direction);
    let dir2 = normalize(water_config.wave2_direction);
    let dir3 = normalize(water_config.wave3_direction);

    // Large Gerstner Waves (using configurable parameters)
    let wave1 = gerstner_wave(pos.xz, dir1, water_config.wave1_steepness, water_config.wave1_amplitude, water_config.wave1_frequency, water_config.wave1_speed);
    let wave2 = gerstner_wave(pos.xz, dir2, water_config.wave2_steepness, water_config.wave2_amplitude, water_config.wave2_frequency, water_config.wave2_speed);
    let wave3 = gerstner_wave(pos.xz, dir3, water_config.wave3_steepness, water_config.wave3_amplitude, water_config.wave3_frequency, water_config.wave3_speed);
    
    pos += wave1 + wave2 + wave3;

    velocity += gerstner_wave_velocity(pos.xz, dir1, water_config.wave1_amplitude, water_config.wave1_frequency, water_config.wave1_speed);
    velocity += gerstner_wave_velocity(pos.xz, dir2, water_config.wave2_amplitude, water_config.wave2_frequency, water_config.wave2_speed);
    velocity += gerstner_wave_velocity(pos.xz, dir3, water_config.wave3_amplitude, water_config.wave3_frequency, water_config.wave3_speed);

    // Calculate normals
    let n_wave1 = gerstner_wave_normal(pos.xz, dir1, water_config.wave1_steepness, water_config.wave1_amplitude, water_config.wave1_frequency, water_config.wave1_speed);
    let n_wave2 = gerstner_wave_normal(pos.xz, dir2, water_config.wave2_steepness, water_config.wave2_amplitude, water_config.wave2_frequency, water_config.wave2_speed);
    let n_wave3 = gerstner_wave_normal(pos.xz, dir3, water_config.wave3_steepness, water_config.wave3_amplitude, water_config.wave3_frequency, water_config.wave3_speed);
    
    normal.x = -(n_wave1.x + n_wave2.x + n_wave3.x);
    normal.z = -(n_wave1.z + n_wave2.z + n_wave3.z);
    normal.y = 1.0 - (n_wave1.y + n_wave2.y + n_wave3.y);
    normal = normalize(normal);

    // Calculate tangent and bitangent for normal mapping
    let tangent = normalize(vec3<f32>(1.0, normal.x, 0.0));
    let bitangent = normalize(cross(normal, tangent));

    // Player Interaction Ripples
    let dist_to_player = distance(pos.xz, water_config.player_pos.xz);
    if (dist_to_player < 10.0) {
        let ripple_amplitude = water_config.ripple_amplitude_multiplier * (1.0 - dist_to_player / 10.0);
        let ripple_offset = ripple_amplitude * sin(dist_to_player * water_config.ripple_freq - u_time.time * water_config.ripple_speed);
        pos.y += ripple_offset;
        
        let ripple_normal_strength = ripple_amplitude * water_config.ripple_freq * cos(dist_to_player * water_config.ripple_freq - u_time.time * water_config.ripple_speed);
        let dir_to_player = normalize(vec2<f32>(pos.x - water_config.player_pos.x, pos.z - water_config.player_pos.z));
        normal.x += dir_to_player.x * ripple_normal_strength * 0.5;
        normal.z += dir_to_player.y * ripple_normal_strength * 0.5;
        normal = normalize(normal);
    }

    out.world_position = pos;
    out.clip_position = camera.view_proj * vec4<f32>(pos, 1.0);
    out.normal = normal;
    out.wave_velocity = velocity;
    out.tangent = tangent;
    out.bitangent = bitangent;
    return out;
}

// ===== FRAGMENT SHADER =====
@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var output: GbufferOutput;

    let view_dir = normalize(camera.view_pos.xyz - in.world_position);
    var normal = normalize(in.normal);
    
    // Calculate water depth
    let terrain_height = sample_landscape_height(in.world_position.xz);
    let water_depth = max(in.world_position.y - terrain_height, 0.0);
    
    // ===== HIGH-FREQUENCY NORMAL DETAIL (replaces texture sampling) =====
    let detail_coord1 = in.world_position.xz * 0.5 + in.wave_velocity * u_time.time * 0.3;
    let detail_deriv1 = fbm_derivative(detail_coord1, 3);
    let detail_coord2 = in.world_position.xz * 1.5 - vec2<f32>(u_time.time * 0.2, u_time.time * 0.15);
    let detail_deriv2 = fbm_derivative(detail_coord2, 3);
    let detail_coord3 = in.world_position.xz * 4.0 + vec2<f32>(u_time.time * 0.1, -u_time.time * 0.12);
    let detail_deriv3 = fbm_derivative(detail_coord3, 2);
    
    var detail_normal = vec3<f32>(0.0, 1.0, 0.0);
    detail_normal.x = detail_deriv1.x * 0.4 + detail_deriv2.x * 0.3 + detail_deriv3.x * 0.2;
    detail_normal.z = detail_deriv1.y * 0.4 + detail_deriv2.y * 0.3 + detail_deriv3.y * 0.2;
    detail_normal = normalize(detail_normal);
    
    let tangent = normalize(in.tangent);
    let bitangent = normalize(in.bitangent);
    let detail_world_normal = normalize(
        detail_normal.x * tangent +
        detail_normal.y * normal +
        detail_normal.z * bitangent
    );
    
    let detail_strength = mix(0.3, 0.7, smoothstep(5.0, 1.0, water_depth));
    normal = normalize(mix(normal, detail_world_normal, detail_strength));
    
    // ===== LIGHTING & COLOR =====
    // Fresnel
    let ndotv = max(dot(normal, view_dir), 0.0);
    let fresnel = pow(1.0 - ndotv, water_config.fresnel_power);
    
    // Depth-based colors
    let shallow_color = water_config.shallow_color.xyz;
    let medium_color = water_config.medium_color.xyz;
    let deep_color = water_config.deep_color.xyz;
    let sky_reflection = vec3<f32>(0.6, 0.8, 1.0); // Keep sky reflection as a constant for now
    
    var water_color: vec3<f32>;
    if (water_depth < 2.0) {
        water_color = mix(shallow_color, medium_color, water_depth / 2.0);
    } else if (water_depth < 10.0) {
        water_color = mix(medium_color, deep_color, (water_depth - 2.0) / 8.0);
    } else {
        water_color = deep_color;
    }
    
    var final_color = mix(water_color, sky_reflection, fresnel * water_config.fresnel_multiplier);
    
    // Scattered sun specular
    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, normal);
    
    let spec_base = pow(max(dot(view_dir, reflect_dir), 0.0), 80.0);
    let spec_sharp = pow(max(dot(view_dir, reflect_dir), 0.0), 300.0);
    
    // High-frequency sparkles
    let sparkle_detail = pow(max(dot(view_dir, reflect_dir), 0.0), 600.0);
    let sparkle_noise = noise(in.world_position.xz * 30.0 + u_time.time * 3.0);
    let sparkle = step(water_config.sparkle_threshold, sparkle_noise) * sparkle_detail;
    
    final_color += vec3<f32>(1.0, 1.0, 0.95) * (spec_base * 0.4 + spec_sharp * 0.6 + sparkle * water_config.sparkle_intensity);
    
    // FOAM
    var foam_amount = 0.0;
    
    let shoreline_foam = smoothstep(water_config.shoreline_foam_range, 0.0, water_depth);
    let wave_steepness = length(vec2<f32>(normal.x, normal.z));
    let crest_foam = smoothstep(water_config.crest_foam_min, water_config.crest_foam_max, wave_steepness) * smoothstep(0.5, 2.0, in.world_position.y);
    let velocity_strength = length(in.wave_velocity);
    let velocity_foam = smoothstep(0.5, 1.5, velocity_strength);
    
    foam_amount = max(shoreline_foam, max(crest_foam * 0.7, velocity_foam * 0.5));
    
    // Multi-scale foam texture
    let foam_coord1 = in.world_position.xz * 12.0 + u_time.time * 0.5 + in.wave_velocity * 0.3;
    let foam_coord2 = in.world_position.xz * 24.0 - u_time.time * 0.4;
    let foam_coord3 = in.world_position.xz * 48.0 + u_time.time * 0.8;
    
    let foam_noise1 = noise(foam_coord1);
    let foam_noise2 = noise(foam_coord2);
    let foam_noise3 = noise(foam_coord3);
    
    let foam_pattern = foam_noise1 * 0.5 + foam_noise2 * 0.3 + foam_noise3 * 0.2;
    let foam_threshold = mix(0.55, 0.3, foam_amount);
    let foam_mask = smoothstep(foam_threshold - 0.15, foam_threshold + 0.15, foam_pattern);
    
    let foam_color = vec3<f32>(0.95, 0.98, 1.0);
    foam_amount = foam_amount * foam_mask;
    final_color = mix(final_color, foam_color, foam_amount * 0.85);
    
    // Subsurface scattering
    let subsurface = smoothstep(5.0, 0.0, water_depth) * max(dot(normalize(in.normal), sun_dir), 0.0);
    final_color += shallow_color * subsurface * water_config.subsurface_multiplier;
    
    let ambient = 0.3;
    final_color = max(final_color, water_color * ambient);

    // ===== FINAL OUTPUT =====
    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.85); // Use a fixed alpha for now
    output.pbr_material = vec4<f32>(0.0, 0.08, 1.0, 1.0); // Roughness, Metallic, Reflectance, (not used)
    return output;
}