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

@vertex
fn vs_main(
    @builtin(vertex_index) in_vertex_index: u32,
    @builtin(instance_index) in_instance_index: u32
) -> VertexOutput {
    // Quad vertices (billboard)
    let uv = vec2<f32>(
        f32((in_vertex_index << 1u) & 2u),
        f32(in_vertex_index & 2u)
    );
    let corner = uv * 2.0 - 1.0; // -1 to 1

    // Particle ID and Randomness
    let seed = in_instance_index;
    let rnd = hash3(seed);
    
    // Time logic
    var t = uniforms.time + rnd.x * uniforms.life_time;
    if (uniforms.mode < 0.5) {
        // Continuous loop
        t = t % uniforms.life_time;
    } else {
        // One shot (clamp or discard in fragment)
        // For simplicity in vertex, let's just let it fly, fragment can discard if t > life
    }
    
    // Initial Position (Sphere or Disk distribution)
    let theta = rnd.y * 6.28318;
    let phi = rnd.z * 3.14159;
    let r = uniforms.radius * sqrt(rnd.x); // Distribution
    
    let offset = vec3<f32>(
        r * cos(theta),
        0.0,
        r * sin(theta)
    );
    // For "Rain/Fire from heavens", we might want a flat disk at Y
    // For now, let's assume emitter handles the "Source" area shape via specific logic
    // or just use a generic sphere/box offset.
    // Let's use a simple Box distribution for versatility if radius is used as extent
    let pos_offset = (rnd - 0.5) * 2.0 * uniforms.radius;

    var start_pos = uniforms.position + pos_offset;

    // Initial Velocity
    // For fire rain: down (-y)
    // For fire: up (+y)
    // We can use gravity uniform to control main direction
    // And initial speed for spread
    let dir = normalize(rnd - 0.5);
    let speed = mix(uniforms.initial_speed_min, uniforms.initial_speed_max, rnd.z);
    let velocity = dir * speed;

    // Physics
    // pos = p0 + v*t + 0.5*a*t*t
    let pos = start_pos + velocity * t + 0.5 * uniforms.gravity * t * t;

    // Billboard logic (face camera)
    let cam_right = vec3<f32>(camera.view_proj[0][0], camera.view_proj[1][0], camera.view_proj[2][0]);
    let cam_up = vec3<f32>(camera.view_proj[0][1], camera.view_proj[1][1], camera.view_proj[2][1]);
    
    // Just use camera position for simple billboard
    let to_cam = normalize(camera.position - pos);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_cam));
    let up = vec3<f32>(0.0, 1.0, 0.0);
    // Or true billboard:
    // let right = normalize(cross(to_cam, vec3<f32>(0.0, 1.0, 0.0)));
    // let up = normalize(cross(right, to_cam));
    
    // Scale size by life (fade in/out)
    let norm_life = t / uniforms.life_time;
    var size = uniforms.size;
    // Fade in/out curve: sin(pi * t)
    let alpha = sin(3.14159 * norm_life);
    size = size * alpha;

    // Apply quad offset
    // This is a simple view-aligned billboard approximation
    // Ideally we extract camera basis vectors
    
    // Let's use the View Matrix transpose approach or lookat
    // Simpler: just add offsets in view space? No, world space.
    // Assuming Y-up billboard for rain/fire usually works better than spherical for some things
    // but spherical is general purpose.
    
    // Using camera basis from view matrix (inverse view is camera transform)
    // Assuming simple camera uniform has view_proj.
    // We'll stick to a simple cross product for now.
    
    let billboard_pos = pos + (corner.x * uniforms.size * 0.5) * cam_right + (corner.y * uniforms.size * 0.5) * cam_up;

    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(billboard_pos, 1.0);
    out.uv = uv; // 0..2 range from the bitwise hack, wait.
    // The bitwise hack generates: (0,0), (2,0), (0,2). It's a large triangle covering the quad.
    // Standard UVs for quad:
    // 0: (0,0), 1: (0,1), 2: (1,1), 3: (1,1), 4: (1,0), 5: (0,0) usually.
    // Let's stick to the bitwise triangle which covers (0,0) to (1,1) in the range we care about?
    // Actually the bitwise trick `u32((in_vertex_index << 1) & 2), u32(in_vertex_index & 2)`
    // produces (0,0), (2,0), (0,2). 
    // This is for a full screen triangle.
    // For particles, we usually draw 6 vertices (2 triangles) or 4 with strip.
    // Let's assume we are drawing 6 vertices per instance.
    // indices: 0, 1, 2, 1, 3, 2 (Standard quad)
    // But if we use the vertex_index directly to gen coords without buffers:
    
    // Correct quad UV generation from index 0..6:
    // var pos = vec2<f32>(0.0);
    // if (in_vertex_index == 0u) { pos = vec2(0.0, 0.0); }
    // if (in_vertex_index == 1u) { pos = vec2(1.0, 0.0); }
    // if (in_vertex_index == 2u) { pos = vec2(0.0, 1.0); }
    // if (in_vertex_index == 3u) { pos = vec2(1.0, 0.0); }
    // if (in_vertex_index == 4u) { pos = vec2(1.0, 1.0); }
    // if (in_vertex_index == 5u) { pos = vec2(0.0, 1.0); }
    
    // Let's fix UVs in the main body
    var local_uv = vec2<f32>(0.0);
    var v_idx = in_vertex_index % 6u;
    if (v_idx == 0u) { local_uv = vec2(0.0, 1.0); }
    else if (v_idx == 1u) { local_uv = vec2(1.0, 1.0); }
    else if (v_idx == 2u) { local_uv = vec2(0.0, 0.0); }
    else if (v_idx == 3u) { local_uv = vec2(1.0, 1.0); }
    else if (v_idx == 4u) { local_uv = vec2(1.0, 0.0); }
    else if (v_idx == 5u) { local_uv = vec2(0.0, 0.0); }
    
    out.uv = local_uv;
    
    let local_corner = local_uv * 2.0 - 1.0;
    let world_pos = pos 
        + (local_corner.x * size * 0.5) * vec3<f32>(camera.view_proj[0][0], camera.view_proj[1][0], camera.view_proj[2][0]) // Camera Right
        - (local_corner.y * size * 0.5) * vec3<f32>(camera.view_proj[0][1], camera.view_proj[1][1], camera.view_proj[2][1]); // Camera Up (negated for Y-up?)

    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.color = mix(uniforms.start_color, uniforms.end_color, norm_life);
    out.color.a = out.color.a * alpha;

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
