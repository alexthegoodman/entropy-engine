/* ============================================================
   Particle Flame Shader (Vertex + Fragment)
   ============================================================ */

struct ParticleUniforms {
    position: vec4<f32>,
    target_position: vec4<f32>,
    gravity: vec4<f32>,
    start_color: vec4<f32>,
    end_color: vec4<f32>,

    time: f32,
    emission_rate: f32,
    life_time: f32,
    radius: f32,
    
    initial_speed_min: f32,
    initial_speed_max: f32,
    size: f32,
    mode: f32,
};

struct CameraUniform {
    view_proj: mat4x4<f32>,
    position: vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniform;
@group(1) @binding(0) var<uniform> uniforms: ParticleUniforms;

struct VertexInput {
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) color: vec4<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) normal: vec3<f32>,
    @location(4) particle_seed: f32,
    @location(5) life_progress: f32,
};

/* ============================================================
   Utility Functions
   ============================================================ */

fn hash(n: f32) -> f32 {
    return fract(sin(n) * 43758.5453123);
}

fn hash2(n: f32) -> vec2<f32> {
    return vec2<f32>(hash(n), hash(n + 17.0));
}

fn remap01(x: f32) -> f32 {
    return clamp(x, 0.0, 1.0);
}

// Hash function for pseudo-random numbers
fn hashu(n: u32) -> f32 {
    let x = (n << 13u) ^ n;
    let y = (x * (x * x * 15731u + 789221u) + 1376312589u);
    return f32(y & 0x7fffffffu) / f32(0x7fffffff);
}

// 2D noise function for flame distortion
fn noise2d(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    
    let a = hashu(u32(i.x) + u32(i.y) * 57u);
    let b = hashu(u32(i.x + 1.0) + u32(i.y) * 57u);
    let c = hashu(u32(i.x) + u32(i.y + 1.0) * 57u);
    let d = hashu(u32(i.x + 1.0) + u32(i.y + 1.0) * 57u);
    
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

/* ============================================================
   Quad Geometry (Billboard)
   ============================================================ */

fn quad_vertex(i: u32) -> vec2<f32> {
    let verts = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0),

        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
    );
    return verts[i];
}

fn quad_uv(i: u32) -> vec2<f32> {
    let uvs = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(1.0, 0.0),

        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 0.0),
    );
    return uvs[i];
}

/* ============================================================
   Vertex Shader
   ============================================================ */

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;

    let seed = f32(input.instance_index);
    let rand = hash2(seed);

    /* --- Lifetime --- */
    // let particle_time =
    //     uniforms.time + rand.x * uniforms.life_time;

    // let life = fract(particle_time / uniforms.life_time);
    // let life_progress = 1.0 - life;

    /* --- Lifetime --- */
    let birth_offset = rand.x * uniforms.life_time;
    let particle_age = uniforms.time - birth_offset;
    let life = fract(particle_age / uniforms.life_time);
    let life_progress = 1.0 - life;

    // /* --- Spawn Position --- */
    // let angle = rand.y * 6.2831853;
    // let radial_offset =
    //     vec3<f32>(cos(angle), 0.0, sin(angle)) * uniforms.radius;

    // let spawn_pos = uniforms.position + radial_offset;

    // /* --- Velocity --- */
    // let speed =
    //     mix(uniforms.initial_speed_min,
    //         uniforms.initial_speed_max,
    //         hash(seed + 3.0));

    // let velocity = vec3<f32>(0.0, 1.0, 0.0) * speed;

    // /* --- Motion --- */
    // let t = life * uniforms.life_time;
    // let world_pos =
    //     spawn_pos +
    //     velocity * t +
    //     0.5 * uniforms.gravity * t * t;

    /* --- Spawn Position --- */
    // Small random offset for variation
    let tiny_offset = vec3<f32>(
        (rand.x - 0.5) * uniforms.radius,
        (rand.y - 0.5) * uniforms.radius,
        (hash(seed + 5.0) - 0.5) * uniforms.radius
    );
    let spawn_pos = uniforms.position.xyz + tiny_offset;

    /* --- Velocity towards target --- */
    let direction = normalize(uniforms.target_position.xyz - uniforms.position.xyz);

    let speed =
        mix(uniforms.initial_speed_min,
            uniforms.initial_speed_max,
            hash(seed + 3.0));

    // Velocity goes towards target with some randomness
    let velocity = direction * speed;

    /* --- Motion --- */
    let t = life * uniforms.life_time;
    let world_pos =
        spawn_pos +
        velocity * t +
        0.5 * uniforms.gravity.xyz * t * t;

    // let world_pos = spawn_pos;

    /* --- Camera Billboard --- */
    // let right = normalize(
    //     vec3<f32>(
    //         camera.view_proj[0][0],
    //         camera.view_proj[1][0],
    //         camera.view_proj[2][0]
    //     )
    // );

    // let up = normalize(
    //     vec3<f32>(
    //         camera.view_proj[0][1],
    //         camera.view_proj[1][1],
    //         camera.view_proj[2][1]
    //     )
    // );

    // let quad = quad_vertex(input.vertex_index);
    // let size =
    //     uniforms.size *
    //     mix(1.0, 0.3, life) *
    //     (0.7 + rand.x * 0.6);

    // let billboard_pos =
    //     world_pos +
    //     (right * quad.x + up * quad.y) * size;

    /* --- Camera Billboard --- */
    let to_camera = normalize(camera.position - world_pos);

    // Right vector (perpendicular to view direction and world up)
    let world_up = vec3<f32>(0.0, 1.0, 0.0);
    let right = normalize(cross(world_up, to_camera));

    // // Up vector (perpendicular to view direction and right)
    let up = normalize(cross(to_camera, right));

    // Hardcoded: Right is X-axis, Up is Y-axis
    // let right = vec3<f32>(1.0, 0.0, 0.0);
    // let up    = vec3<f32>(0.0, 1.0, 0.0);

    let quad = quad_vertex(input.vertex_index);
    // let size =
    //     uniforms.size *
    //     mix(1.0, 0.3, life) *
    //     (0.7 + rand.x * 0.6);
    let size = 0.2;

    let billboard_pos =
        world_pos +
        (right * quad.x + up * quad.y) * size;

    /* --- Output --- */
    out.clip_position =
        camera.view_proj * vec4<f32>(billboard_pos, 1.0);

    out.world_pos = billboard_pos;
    out.uv = quad_uv(input.vertex_index);
    out.normal = normalize(camera.position - billboard_pos);
    out.particle_seed = seed;
    out.life_progress = life_progress;

    /* --- Color over life --- */
    let color =
        mix(uniforms.end_color,
            uniforms.start_color,
            life_progress);

    out.color = color;

    return out;
}

/* ============================================================
   Fragment Shader
   ============================================================ */

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(input: VertexOutput) -> GbufferOutput {
    let uv = input.uv * 2.0 - 1.0;
    let dist = length(uv);

    /* --- Soft Flame Shape --- */
    let flame =
        smoothstep(1.0, 0.3, dist) *
        smoothstep(0.0, 0.8, 1.0 - input.life_progress);

    /* --- Flicker --- */
    let flicker =
        0.8 +
        0.2 * sin(
            input.particle_seed * 12.0 +
            uniforms.time * 10.0
        );

    let alpha = flame * flicker * input.color.a;

    // let flame = smoothstep(1.0, 0.3, dist); // Just radial falloff, ignore lifetime
    // let alpha = flame * input.color.a;
    
    if (alpha < 0.01) {
        discard;
    }

    var output: GbufferOutput;
    
    output.position = vec4<f32>(input.world_pos, 1.0);
    output.normal = vec4<f32>(input.normal, 1.0);
    
    // Albedo = the emissive glow color
    output.albedo = vec4<f32>(input.color.rgb, alpha);
    
    // PBR material = metallic/roughness/emissive flag/etc
    // output.pbr_material = vec4<f32>(
    //     0.0,  // metallic = 0 (not metal)
    //     1.0,  // roughness = 1 (fully rough, no specular)
    //     10.0, // emissive intensity multiplier (or flag depending on your system)
    //     0.0
    // );
    output.pbr_material = vec4<f32>(0.0, 0.1, 1.0, alpha);
    
    return output;
}

// @fragment
// fn fs_main(in: VertexOutput) -> GbufferOutput {
//     // Center UV coordinates (-0.5 to 0.5)
//     let uv = in.uv - 0.5;
    
//     // Animate flame distortion
//     let time_scale = uniforms.time * 2.0 + in.particle_seed * 10.0;
    
//     // Create flame shape with noise distortion
//     let noise_coord = vec2<f32>(uv.x * 3.0, uv.y * 2.0 - time_scale);
//     let distortion = fbm(noise_coord) * 0.3;
    
//     // Distorted UV for flame shape
//     let distorted_uv = vec2<f32>(uv.x + distortion, uv.y);
    
//     // Create flame shape: wide at bottom, narrow at top
//     let height = uv.y + 0.5; // 0 at bottom, 1 at top
//     let flame_width = mix(0.4, 0.1, height); // Wider at bottom
    
//     // Distance from center line with distortion
//     let flame_dist = abs(distorted_uv.x) / flame_width;
    
//     // Vertical gradient (flames taper upward)
//     let vertical_gradient = 1.0 - smoothstep(0.0, 1.0, height);
    
//     // Create flame mask
//     let flame_mask = (1.0 - smoothstep(0.0, 1.0, flame_dist)) * vertical_gradient;
    
//     // Add turbulent detail
//     let detail_coord = vec2<f32>(uv.x * 8.0, uv.y * 6.0 - time_scale * 3.0);
//     let detail = fbm(detail_coord) * 0.5 + 0.5;
//     let flame_intensity = flame_mask * detail;
    
//     // Create layered flame colors
//     let white_core = smoothstep(0.7, 1.0, flame_intensity); // Hot white center
//     let yellow = smoothstep(0.5, 0.8, flame_intensity); // Yellow
//     let orange = smoothstep(0.3, 0.6, flame_intensity); // Orange
//     let red = smoothstep(0.1, 0.4, flame_intensity); // Red edges
    
//     // Mix colors from hot to cool
//     var flame_color = vec3<f32>(0.0);
//     flame_color = mix(flame_color, vec3<f32>(0.5, 0.0, 0.0), red); // Dark red
//     flame_color = mix(flame_color, vec3<f32>(1.0, 0.2, 0.0), orange); // Bright orange
//     flame_color = mix(flame_color, vec3<f32>(1.0, 0.8, 0.1), yellow); // Yellow
//     flame_color = mix(flame_color, vec3<f32>(1.0, 1.0, 0.95), white_core); // White hot
    
//     // Fade based on life
//     let life_fade = 1.0 - pow(in.life_progress, 1.5);
//     let alpha = flame_intensity * life_fade;
    
//     // Add flicker
//     let flicker = 0.9 + 0.1 * sin(uniforms.time * 15.0 + in.particle_seed * 20.0);
//     flame_color *= flicker;
    
//     if (alpha < 0.01) {
//         discard;
//     }
    
//     var output: GbufferOutput;
//     output.position = vec4<f32>(in.world_pos, 1.0);
//     output.normal = vec4<f32>(normalize(in.normal), 1.0);
//     output.albedo = vec4<f32>(flame_color, alpha);
//     output.pbr_material = vec4<f32>(0.0, 0.1, 1.0, alpha);
    
//     return output;
// }