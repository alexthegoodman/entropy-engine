struct ParticleUniforms {
    position: vec3<f32>, // Emitter position
    time: f32,
    
    // Emitter properties
    emission_rate: f32,
    life_time: f32,
    radius: f32,
    
    // Particle physics
    gravity: vec3<f32>,
    initial_speed_min: f32,
    initial_speed_max: f32,
    
    // Visuals
    start_color: vec4<f32>,
    end_color: vec4<f32>,
    size: f32,
    
    // Burst mode: 0 = continuous, 1 = burst
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
    @location(0) color: vec4<f32>,
    @location(1) uv: vec2<f32>,
}

// Pseudo-random function
fn hash(n: u32) -> f32 {
    var x = f32(n);
    return fract(sin(x) * 43758.5453123);
}

fn hash3(n: u32) -> vec3<f32> {
    return vec3<f32>(hash(n), hash(n + 1u), hash(n + 2u));
}

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
};

@vertex
fn vs_main(
    in: VertexInput
) -> VertexOutput {
    // Generate quad UVs from vertex index
    var local_uv = vec2<f32>(0.0);
    let v_idx = in.vertex_index % 6u;
    if (v_idx == 0u) { local_uv = vec2(0.0, 1.0); }
    else if (v_idx == 1u) { local_uv = vec2(1.0, 1.0); }
    else if (v_idx == 2u) { local_uv = vec2(0.0, 0.0); }
    else if (v_idx == 3u) { local_uv = vec2(1.0, 1.0); }
    else if (v_idx == 4u) { local_uv = vec2(1.0, 0.0); }
    else if (v_idx == 5u) { local_uv = vec2(0.0, 0.0); }

    // Particle ID and Randomness
    let seed = in.instance_index;
    let rnd = hash3(seed);
    
    // Time logic
    var t = uniforms.time + rnd.x * uniforms.life_time;
    if (uniforms.mode < 0.5) {
        // Continuous loop
        t = t % uniforms.life_time;
    }
    
    // Initial Position - box distribution
    let pos_offset = (rnd - 0.5) * 2.0 * uniforms.radius;
    let start_pos = uniforms.position + pos_offset;

    // Initial Velocity
    let dir = normalize(rnd - 0.5);
    let speed = mix(uniforms.initial_speed_min, uniforms.initial_speed_max, rnd.z);
    let velocity = dir * speed;

    // Physics: pos = p0 + v*t + 0.5*a*t*t
    let pos = start_pos + velocity * t + 0.5 * uniforms.gravity * t * t;

    // Prepare output
    var out: VertexOutput;
    out.uv = local_uv;
    
    // Calculate normalized lifetime
    let norm_life = t / uniforms.life_time;

    // Check if particle should be visible (for burst mode)
    if (uniforms.mode >= 0.5 && norm_life > 1.0) {
        out.clip_position = vec4<f32>(0.0, 0.0, -100.0, 1.0);
        out.color = vec4<f32>(0.0);
        return out;
    }

    // Fade in/out
    let alpha = sin(3.14159 * clamp(norm_life, 0.0, 1.0));
    let size = uniforms.size * alpha;

    // Simple Y-up aligned billboard
    let to_cam = normalize(camera.position - pos);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_cam));
    let up = cross(to_cam, right);

    // Build billboard quad
    let local_corner = local_uv * 2.0 - 1.0;
    let world_pos = pos 
        + (local_corner.x * size * 0.5) * right 
        + (local_corner.y * size * 0.5) * up;

    // out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.clip_position = camera.view_proj * vec4<f32>(uniforms.position, 1.0);
    out.color = mix(uniforms.start_color, uniforms.end_color, norm_life);
    out.color.a = out.color.a * alpha;

    out.color = vec4<f32>(1.0, 0.0, 0.0, 1.0);

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Simple circle particle
    let dist = distance(in.uv, vec2<f32>(0.5, 0.5));
    if (dist > 0.5) {
        discard;
    }
    
    // Soft edge
    let alpha = smoothstep(0.5, 0.3, dist);
    
    return in.color * alpha;
}
