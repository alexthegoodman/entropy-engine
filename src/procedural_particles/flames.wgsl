struct ParticleUniforms {
    position: vec3<f32>,
    time: f32,
    
    emission_rate: f32,
    life_time: f32,
    radius: f32,
    
    gravity: vec3<f32>,
    initial_speed_min: f32,
    initial_speed_max: f32,
    
    start_color: vec4<f32>,
    end_color: vec4<f32>,
    size: f32,
    
    mode: f32, 
}

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(1) @binding(0) var<uniform> uniforms: ParticleUniforms;

struct CameraUniform {
    view_proj: mat4x4<f32>,
    position: vec3<f32>,
}

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) normal: vec3<f32>,
    @location(4) particle_seed: f32,
    @location(5) life_progress: f32,
}

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
};

// Hash function for pseudo-random numbers
fn hash(n: u32) -> f32 {
    let x = (n << 13u) ^ n;
    let y = (x * (x * x * 15731u + 789221u) + 1376312589u);
    return f32(y & 0x7fffffffu) / f32(0x7fffffff);
}

fn hash3(n: u32) -> vec3<f32> {
    return vec3<f32>(
        hash(n),
        hash(n + 1u),
        hash(n + 2u)
    );
}

// 2D noise function for flame distortion
fn noise2d(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    
    let a = hash(u32(i.x) + u32(i.y) * 57u);
    let b = hash(u32(i.x + 1.0) + u32(i.y) * 57u);
    let c = hash(u32(i.x) + u32(i.y + 1.0) * 57u);
    let d = hash(u32(i.x + 1.0) + u32(i.y + 1.0) * 57u);
    
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fractional Brownian Motion for turbulence
fn fbm(p: vec2<f32>) -> f32 {
    var value = 0.0;
    var amplitude = 0.5;
    var frequency = 1.0;
    var pos = p;
    
    for (var i = 0; i < 5; i++) {
        value += amplitude * noise2d(pos * frequency);
        frequency *= 2.0;
        amplitude *= 0.5;
    }
    
    return value;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    let particle_id = input.instance_index;
    let vertex_id = input.vertex_index;
    
    // Determine particle timing based on mode
    var seed_offset = 0.0;
    if (uniforms.mode > 0.5) {
        seed_offset = 0.0;
    } else {
        seed_offset = f32(particle_id) * 0.15;
    }
    
    // Calculate particle age
    let particle_time = uniforms.time - seed_offset;
    let age = particle_time % uniforms.life_time;
    let life_progress = age / uniforms.life_time;
    
    // Early exit for particles that haven't spawned yet
    if (particle_time < 0.0 || life_progress > 1.0) {
        out.clip_position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
        out.world_pos = vec3<f32>(0.0);
        out.color = vec4<f32>(0.0);
        out.uv = vec2<f32>(0.0);
        out.normal = vec3<f32>(0.0, 1.0, 0.0);
        out.particle_seed = 0.0;
        out.life_progress = 0.0;
        return out;
    }
    
    // Generate random values for this particle
    let rand = hash3(particle_id * 3u);
    let rand2 = hash3(particle_id * 3u + 100u);
    
    // Spawn particles in a circle high above
    let spawn_height = 15.0 + rand.z * 10.0;
    let angle = rand.x * 6.28318530718;
    let dist = sqrt(rand.y) * uniforms.radius;
    
    let spawn_pos = uniforms.position + vec3<f32>(
        cos(angle) * dist,
        spawn_height,
        sin(angle) * dist
    );
    
    // Initial velocity - mostly downward with turbulent motion
    let speed = mix(uniforms.initial_speed_min, uniforms.initial_speed_max, rand2.x);
    let spread = (rand2.yz - 0.5) * 0.4;
    let initial_vel = vec3<f32>(
        spread.x * speed,
        -speed * 1.5,
        spread.y * speed
    );
    
    // Physics: apply gravity over time
    let velocity = initial_vel + uniforms.gravity * age;
    let pos = spawn_pos + velocity * age;
    
    // Add complex turbulence
    let turb_freq = 3.0;
    let turb_time = uniforms.time * 0.5 + f32(particle_id);
    let turbulence = vec3<f32>(
        sin(turb_time * turb_freq) * cos(turb_time * turb_freq * 1.3),
        cos(turb_time * turb_freq * 0.8) * 0.5,
        cos(turb_time * turb_freq) * sin(turb_time * turb_freq * 1.7)
    ) * (0.8 + 0.4 * rand2.z) * (1.0 - life_progress * 0.3);
    
    let particle_pos = pos + turbulence;
    
    // Use vertex_id to create quad corners
    let x = f32(vertex_id == 1u || vertex_id == 2u);
    let y = f32(vertex_id >= 2u);
    let quad_offset = vec2<f32>(x * 2.0 - 1.0, y * 2.0 - 1.0);
    
    // Billboard to face camera
    let to_camera = normalize(camera.position - particle_pos);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_camera));
    let up = cross(to_camera, right);
    
    // Size: flames grow then shrink as they fade
    let size_curve = sin(life_progress * 3.14159) * 1.2; // Peak in middle
    let size_variation = 0.8 + rand2.z * 0.4;
    let base_size = max(uniforms.size, 0.1);
    let final_size = base_size * size_variation * size_curve * 2.0; // Make flames bigger
    
    // Stretch flames vertically (taller than wide)
    let flame_aspect = vec2<f32>(1.0, 1.8);
    let world_pos = particle_pos + (right * quad_offset.x * flame_aspect.x + up * quad_offset.y * flame_aspect.y) * final_size;

    out.world_pos = world_pos;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.uv = vec2<f32>(x, y);
    out.normal = to_camera;
    out.particle_seed = rand.x;
    out.life_progress = life_progress;
    
    // Pass base color for mixing in fragment shader
    out.color = vec4<f32>(1.0, 0.5, 0.1, 1.0);
    
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
    // Center UV coordinates (-0.5 to 0.5)
    let uv = in.uv - 0.5;
    
    // Animate flame distortion
    let time_scale = uniforms.time * 2.0 + in.particle_seed * 10.0;
    
    // Create flame shape with noise distortion
    let noise_coord = vec2<f32>(uv.x * 3.0, uv.y * 2.0 - time_scale);
    let distortion = fbm(noise_coord) * 0.3;
    
    // Distorted UV for flame shape
    let distorted_uv = vec2<f32>(uv.x + distortion, uv.y);
    
    // Create flame shape: wide at bottom, narrow at top
    let height = uv.y + 0.5; // 0 at bottom, 1 at top
    let flame_width = mix(0.4, 0.1, height); // Wider at bottom
    
    // Distance from center line with distortion
    let flame_dist = abs(distorted_uv.x) / flame_width;
    
    // Vertical gradient (flames taper upward)
    let vertical_gradient = 1.0 - smoothstep(0.0, 1.0, height);
    
    // Create flame mask
    let flame_mask = (1.0 - smoothstep(0.0, 1.0, flame_dist)) * vertical_gradient;
    
    // Add turbulent detail
    let detail_coord = vec2<f32>(uv.x * 8.0, uv.y * 6.0 - time_scale * 3.0);
    let detail = fbm(detail_coord) * 0.5 + 0.5;
    let flame_intensity = flame_mask * detail;
    
    // Create layered flame colors
    let white_core = smoothstep(0.7, 1.0, flame_intensity); // Hot white center
    let yellow = smoothstep(0.5, 0.8, flame_intensity); // Yellow
    let orange = smoothstep(0.3, 0.6, flame_intensity); // Orange
    let red = smoothstep(0.1, 0.4, flame_intensity); // Red edges
    
    // Mix colors from hot to cool
    var flame_color = vec3<f32>(0.0);
    flame_color = mix(flame_color, vec3<f32>(0.5, 0.0, 0.0), red); // Dark red
    flame_color = mix(flame_color, vec3<f32>(1.0, 0.2, 0.0), orange); // Bright orange
    flame_color = mix(flame_color, vec3<f32>(1.0, 0.8, 0.1), yellow); // Yellow
    flame_color = mix(flame_color, vec3<f32>(1.0, 1.0, 0.95), white_core); // White hot
    
    // Fade based on life
    let life_fade = 1.0 - pow(in.life_progress, 1.5);
    let alpha = flame_intensity * life_fade;
    
    // Add flicker
    let flicker = 0.9 + 0.1 * sin(uniforms.time * 15.0 + in.particle_seed * 20.0);
    flame_color *= flicker;
    
    if (alpha < 0.01) {
        discard;
    }
    
    var output: GbufferOutput;
    output.position = vec4<f32>(in.world_pos, 1.0);
    output.normal = vec4<f32>(normalize(in.normal), 1.0);
    output.albedo = vec4<f32>(flame_color, alpha);
    output.pbr_material = vec4<f32>(0.0, 0.1, 1.0, alpha);
    
    return output;
}