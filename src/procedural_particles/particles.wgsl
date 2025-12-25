// struct ParticleUniforms {
//     position: vec3<f32>,
//     time: f32,
    
//     emission_rate: f32,
//     life_time: f32,
//     radius: f32,
    
//     gravity: vec3<f32>,
//     initial_speed_min: f32,
//     initial_speed_max: f32,
    
//     start_color: vec4<f32>,
//     end_color: vec4<f32>,
//     size: f32,
    
//     mode: f32, 
// }

// @group(0) @binding(0) var<uniform> camera: CameraUniform;
// @group(1) @binding(0) var<uniform> uniforms: ParticleUniforms;

// struct CameraUniform {
//     view_proj: mat4x4<f32>,
//     position: vec3<f32>,
// }

// struct VertexOutput {
//     @builtin(position) clip_position: vec4<f32>,
//     @location(0) world_pos: vec3<f32>,
//     @location(1) color: vec4<f32>,
//     @location(2) uv: vec2<f32>,
//     @location(3) normal: vec3<f32>,
// }

// struct VertexInput {
//     @builtin(vertex_index) vertex_index: u32,
//     @builtin(instance_index) instance_index: u32,
// };

// // Hash function for pseudo-random numbers
// fn hash(n: u32) -> f32 {
//     let x = (n << 13u) ^ n;
//     let y = (x * (x * x * 15731u + 789221u) + 1376312589u);
//     return f32(y & 0x7fffffffu) / f32(0x7fffffff);
// }

// fn hash3(n: u32) -> vec3<f32> {
//     return vec3<f32>(
//         hash(n),
//         hash(n + 1u),
//         hash(n + 2u)
//     );
// }

// @vertex
// fn vs_main(input: VertexInput) -> VertexOutput {
//     var out: VertexOutput;
    
//     let particle_id = input.instance_index;
//     let vertex_id = input.vertex_index;
    
//     // Determine particle timing based on mode
//     var seed_offset = 0.0;
//     if (uniforms.mode > 0.5) {
//         // Burst mode: all particles start at same time
//         seed_offset = 0.0;
//     } else {
//         // Continuous mode: stagger particles
//         seed_offset = f32(particle_id) * 0.1;
//     }
    
//     // Calculate particle age
//     let particle_time = uniforms.time - seed_offset;
//     let age = particle_time % uniforms.life_time;
//     let life_progress = age / uniforms.life_time;
    
//     // Early exit for particles that haven't spawned yet
//     if (particle_time < 0.0 || life_progress > 1.0) {
//         out.clip_position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
//         out.world_pos = vec3<f32>(0.0);
//         out.color = vec4<f32>(0.0);
//         out.uv = vec2<f32>(0.0);
//         out.normal = vec3<f32>(0.0, 1.0, 0.0);
//         return out;
//     }
    
//     // Generate random values for this particle
//     let rand = hash3(particle_id * 3u);
//     let rand2 = hash3(particle_id * 3u + 100u);
    
//     // Spawn particles in a circle HIGH ABOVE the emitter
//     let spawn_height = 15.0 + rand.z * 10.0; // 15-25 units above
//     let angle = rand.x * 6.28318530718;
//     let dist = sqrt(rand.y) * uniforms.radius;
    
//     let spawn_pos = uniforms.position + vec3<f32>(
//         cos(angle) * dist,
//         spawn_height, // High above
//         sin(angle) * dist
//     );
    
//     // Initial velocity - mostly downward with some spread
//     let speed = mix(uniforms.initial_speed_min, uniforms.initial_speed_max, rand2.x);
//     let spread = (rand2.yz - 0.5) * 0.3; // Slight horizontal spread
//     let initial_vel = vec3<f32>(
//         spread.x * speed,
//         -speed * 2.0, // Strong downward velocity
//         spread.y * speed
//     );
    
//     // Physics: apply gravity over time
//     let velocity = initial_vel + uniforms.gravity * age;
//     let pos = spawn_pos + velocity * age;
    
//     // Add turbulence/flickering motion
//     let flicker_freq = 8.0;
//     let flicker = vec3<f32>(
//         sin(uniforms.time * flicker_freq + f32(particle_id) * 2.0) * 0.3,
//         cos(uniforms.time * flicker_freq * 1.3 + f32(particle_id) * 3.0) * 0.2,
//         sin(uniforms.time * flicker_freq * 0.8 + f32(particle_id) * 1.5) * 0.3
//     ) * (1.0 - life_progress * 0.5);
    
//     let particle_pos = pos + flicker;
    
//     // Billboard quad vertices
//     let quad_verts = array<vec2<f32>, 6>(
//         vec2<f32>(-1.0, -1.0),
//         vec2<f32>(1.0, -1.0),
//         vec2<f32>(1.0, 1.0),
//         vec2<f32>(-1.0, -1.0),
//         vec2<f32>(1.0, 1.0),
//         vec2<f32>(-1.0, 1.0)
//     );
    
//     let quad_pos = quad_verts[vertex_id];
//     out.uv = quad_pos * 0.5 + 0.5;
    
//     // Size variation: start larger, shrink as it falls
//     let size_variation = 0.7 + rand2.z * 0.6;
//     let size_over_life = mix(1.2, 0.3, life_progress);
//     let particle_size = uniforms.size * size_variation * size_over_life;
    
//     // Billboard to face camera
//     let to_camera = normalize(camera.position - particle_pos);
//     let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_camera));
//     let up = cross(to_camera, right);
    
//     let world_pos2 = particle_pos + (right * quad_pos.x + up * quad_pos.y) * particle_size;
    
//     // NOTE: this portion may seem odd, but without it, I see nothing!
//     let x = f32(vertex_id == 1u || vertex_id == 2u);
//     let y = f32(vertex_id >= 2u);
//     // then just add it to the other values
//     let world_pos = vec3<f32>((world_pos2.x) + (x * 2.0 - 1.0), (world_pos2.y) + (y * 2.0 - 1.0), world_pos2.z);

//     out.world_pos = world_pos;
//     out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    
//     // Fire color variation: orange to yellow to red, fading at end
//     let fire_variation = hash(particle_id + 50u);
//     var base_color: vec4<f32>;
    
//     if (fire_variation < 0.33) {
//         // Bright orange-yellow
//         base_color = vec4<f32>(1.0, 0.8, 0.2, 1.0);
//     } else if (fire_variation < 0.66) {
//         // Deep orange
//         base_color = vec4<f32>(1.0, 0.5, 0.1, 1.0);
//     } else {
//         // Red-orange
//         base_color = vec4<f32>(1.0, 0.3, 0.1, 1.0);
//     }
    
//     // Fade in quickly, fade out gradually
//     let fade_in = min(life_progress * 5.0, 1.0);
//     let fade_out = 1.0 - pow(life_progress, 2.0);
//     let alpha = fade_in * fade_out;
    
//     // Add intensity flicker
//     let intensity = 0.8 + 0.2 * sin(uniforms.time * 10.0 + f32(particle_id));
    
//     out.color = base_color * intensity;
//     out.color.a = alpha;
    
//     // Normal faces camera for billboards
//     out.normal = to_camera;
    
//     return out;
// }

// struct GbufferOutput {
//     @location(0) position: vec4<f32>,
//     @location(1) normal: vec4<f32>,
//     @location(2) albedo: vec4<f32>,
//     @location(3) pbr_material: vec4<f32>,
// }

// @fragment
// fn fs_main(in: VertexOutput) -> GbufferOutput {
//     // Circular particle shape with soft edges
//     let center = vec2<f32>(0.5, 0.5);
//     let dist = length(in.uv - center);
    
//     // Soft circular gradient
//     let circle = 1.0 - smoothstep(0.2, 0.5, dist);
    
//     // Hot center
//     let core = 1.0 - smoothstep(0.0, 0.2, dist);
    
//     // Mix in bright center
//     let mixed_rgb = mix(in.color.rgb, vec3<f32>(1.0, 1.0, 0.9), core * 0.5);
//     let final_alpha = in.color.a * circle;
    
//     // Discard fully transparent pixels
//     if (final_alpha < 0.01) {
//         discard;
//     }
    
//     var output: GbufferOutput;
//     output.position = vec4<f32>(in.world_pos, 1.0);
//     output.normal = vec4<f32>(normalize(in.normal), 1.0);
//     output.albedo = vec4<f32>(mixed_rgb, final_alpha);
    
//     // Fire is emissive, so set metallic=0, roughness=0.2 (slightly glossy), and use alpha for blending
//     output.pbr_material = vec4<f32>(0.0, 0.2, 1.0, final_alpha);
    
//     return output;
// }

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

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    
    let particle_id = input.instance_index;
    let vertex_id = input.vertex_index;
    
    // Determine particle timing based on mode
    var seed_offset = 0.0;
    if (uniforms.mode > 0.5) {
        // Burst mode: all particles start at same time
        seed_offset = 0.0;
    } else {
        // Continuous mode: stagger particles
        seed_offset = f32(particle_id) * 0.1;
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
        return out;
    }
    
    // Generate random values for this particle
    let rand = hash3(particle_id * 3u);
    let rand2 = hash3(particle_id * 3u + 100u);
    
    // Spawn particles in a circle HIGH ABOVE the emitter
    let spawn_height = 15.0 + rand.z * 10.0; // 15-25 units above
    let angle = rand.x * 6.28318530718;
    let dist = sqrt(rand.y) * uniforms.radius;
    
    let spawn_pos = uniforms.position + vec3<f32>(
        cos(angle) * dist,
        spawn_height, // High above
        sin(angle) * dist
    );
    
    // Initial velocity - mostly downward with some spread
    let speed = mix(uniforms.initial_speed_min, uniforms.initial_speed_max, rand2.x);
    let spread = (rand2.yz - 0.5) * 0.3; // Slight horizontal spread
    let initial_vel = vec3<f32>(
        spread.x * speed,
        -speed * 2.0, // Strong downward velocity
        spread.y * speed
    );
    
    // Physics: apply gravity over time
    let velocity = initial_vel + uniforms.gravity * age;
    let pos = spawn_pos + velocity * age;
    
    // Add turbulence/flickering motion
    let flicker_freq = 8.0;
    let flicker = vec3<f32>(
        sin(uniforms.time * flicker_freq + f32(particle_id) * 2.0) * 0.3,
        cos(uniforms.time * flicker_freq * 1.3 + f32(particle_id) * 3.0) * 0.2,
        sin(uniforms.time * flicker_freq * 0.8 + f32(particle_id) * 1.5) * 0.3
    ) * (1.0 - life_progress * 0.5);
    
    let particle_pos = pos + flicker;
    
    // Billboard quad vertices
    let quad_verts = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, 1.0)
    );
    
    let quad_pos = quad_verts[vertex_id];
    out.uv = quad_pos * 0.5 + 0.5;
    
    // Size variation: start larger, shrink as it falls
    // let size_variation = 0.7 + rand2.z * 0.6;
    // let size_over_life = mix(1.2, 0.3, life_progress);
    // let particle_size = uniforms.size * size_variation * size_over_life;

    // Size variation: start larger, shrink as it falls
    let size_variation = 0.7 + rand2.z * 0.6; // 0.7 to 1.3
    let size_over_life = mix(1.2, 0.3, life_progress); // 1.2 to 0.3
    let new_size = uniforms.size * size_variation * size_over_life;
    
    // Safety check: if size is too small, make it visible
    let particle_size = max(new_size, 0.1);
    
    // Billboard to face camera
    let to_camera = normalize(camera.position - particle_pos);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), to_camera));
    let up = cross(to_camera, right);
    
    let world_pos = particle_pos + (right * quad_pos.x + up * quad_pos.y) * particle_size;
    out.world_pos = world_pos;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    
    // Fire color variation: orange to yellow to red, fading at end
    let fire_variation = hash(particle_id + 50u);
    var base_color: vec4<f32>;
    
    if (fire_variation < 0.33) {
        // Bright orange-yellow
        base_color = vec4<f32>(1.0, 0.8, 0.2, 1.0);
    } else if (fire_variation < 0.66) {
        // Deep orange
        base_color = vec4<f32>(1.0, 0.5, 0.1, 1.0);
    } else {
        // Red-orange
        base_color = vec4<f32>(1.0, 0.3, 0.1, 1.0);
    }
    
    // Fade in quickly, fade out gradually
    let fade_in = min(life_progress * 5.0, 1.0);
    let fade_out = 1.0 - pow(life_progress, 2.0);
    let alpha = fade_in * fade_out;
    
    // Add intensity flicker
    let intensity = 0.8 + 0.2 * sin(uniforms.time * 10.0 + f32(particle_id));
    
    out.color = base_color * intensity;
    out.color.a = alpha;
    
    // Normal faces camera for billboards
    out.normal = to_camera;
    
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
    // Circular particle shape with soft edges
    let center = vec2<f32>(0.5, 0.5);
    let dist = length(in.uv - center);
    
    // Soft circular gradient
    let circle = 1.0 - smoothstep(0.2, 0.5, dist);
    
    // Hot center
    let core = 1.0 - smoothstep(0.0, 0.2, dist);
    
    // Mix in bright center
    let mixed_rgb = mix(in.color.rgb, vec3<f32>(1.0, 1.0, 0.9), core * 0.5);
    let final_alpha = in.color.a * circle;
    
    // Discard fully transparent pixels
    if (final_alpha < 0.01) {
        discard;
    }
    
    var output: GbufferOutput;
    output.position = vec4<f32>(in.world_pos, 1.0);
    output.normal = vec4<f32>(normalize(in.normal), 1.0);
    output.albedo = vec4<f32>(mixed_rgb, final_alpha);
    
    // Fire is emissive, so set metallic=0, roughness=0.2 (slightly glossy), and use alpha for blending
    output.pbr_material = vec4<f32>(0.0, 0.2, 1.0, final_alpha);
    
    return output;
}