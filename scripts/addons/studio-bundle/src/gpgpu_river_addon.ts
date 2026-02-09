// ============================================================================
// GPGPU RIVER - REAL-TIME LAGRANGIAN FLUID SIMULATION
// High-performance particle-based water that flows over terrain
// ============================================================================

// ============================================================================
// DEBUG SHADERS - Drop-in replacements for diagnosing rendering issues
// Use the same bindings as the original shaders
// ============================================================================

// ===== DEBUG WATER RENDER VERTEX SHADER =====
// Simplified version - same bindings as original
const DEBUG_WATER_VERTEX = `
struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
    age: f32,
    id: f32,
    padding: vec2<f32>,
}

@group(3) @binding(0)
var<storage, read> particles: array<Particle>;

struct SimParams {
    dt: f32,
    gravity: f32,
    friction: f32,
    respawn_age: f32,
    source_pos: vec2<f32>,
    source_radius: f32,
    landscape_size: f32,
    landscape_height: f32,
    landscape_y_offset: f32,
    time: f32,
    speed_multiplier: f32,
    padding: f32,
}
@group(3) @binding(1)
var<uniform> params: SimParams;

struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

@group(2) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(2) @binding(1)
var landscape_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
    @builtin(instance_index) instance_index: u32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) particle_id: f32,
    @location(3) particle_pos: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    let p = particles[in.instance_index];
    
    // DEBUG: Fixed height above origin, ignore terrain
    let world_center = vec3<f32>(p.pos.x, 50.0, p.pos.y);
    
    // DEBUG: Large, simple billboards (no rotation, no velocity stretching)
    var local_pos = in.position * 5.0;
    let world_pos = world_center + local_pos;
    
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.world_pos = world_pos;
    out.uv = in.tex_coords;
    out.particle_id = f32(in.instance_index);
    out.particle_pos = p.pos;
    
    return out;
}
`;

// ===== DEBUG WATER RENDER FRAGMENT SHADER =====
const DEBUG_WATER_FRAGMENT = `
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) particle_id: f32,
    @location(3) particle_pos: vec2<f32>,
};

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    // DEBUG: Bright, easy-to-see colors cycling by particle ID
    let color_cycle = fract(in.particle_id / 1000.0);
    var color = vec3<f32>(1.0, 0.0, 0.0); // Bright red
    
    if (color_cycle > 0.33) {
        color = vec3<f32>(0.0, 1.0, 0.0); // Bright green
    }
    if (color_cycle > 0.66) {
        color = vec3<f32>(0.0, 0.5, 1.0); // Bright cyan
    }
    
    // DEBUG: Fully opaque (no alpha issues)
    var out: GbufferOutput;
    out.position = vec4<f32>(in.world_pos, 1.0);
    out.normal = vec4<f32>(0.0, 1.0, 0.0, 1.0);
    out.albedo = vec4<f32>(color, 1.0); // Full alpha
    out.pbr_material = vec4<f32>(0.0, 1.0, 0.0, 1.0); // Rough, non-metallic
    
    return out;
}
`;

// ===== DEBUG COMPUTE SHADER =====
// Simplified simulation - same bindings as original
const DEBUG_COMPUTE = `
struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
    age: f32,
    id: f32,
    padding: vec2<f32>,
}

@group(0) @binding(0)
var<storage, read_write> particles: array<Particle>;

struct SimParams {
    dt: f32,
    gravity: f32,
    friction: f32,
    respawn_age: f32,
    source_pos: vec2<f32>,
    source_radius: f32,
    landscape_size: f32,
    landscape_height: f32,
    landscape_y_offset: f32,
    time: f32,
    speed_multiplier: f32,
    padding: f32,
}

@group(1) @binding(0)
var<uniform> params: SimParams;

@group(2) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(2) @binding(1)
var landscape_sampler: sampler;

fn hash21(p: f32) -> vec2<f32> {
	var p3 = fract(vec3<f32>(p) * vec3<f32>(0.1031, 0.1030, 0.0973));
	p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= arrayLength(&particles)) { return; }

    var p = particles[idx];
    
    // DEBUG: Simple constant velocity movement
    p.age += params.dt;
    
    if (p.age > params.respawn_age) {
        // Respawn at source
        let rng = hash21(p.id + params.time);
        let angle = rng.x * 6.28318;
        let radius = sqrt(rng.y) * params.source_radius;
        p.pos = params.source_pos + vec2<f32>(cos(angle), sin(angle)) * radius;
        p.vel = vec2<f32>(20.0, 0.0); // Constant velocity
        p.age = 0.0;
    } else {
        // DEBUG: Just move in +X direction, ignore terrain
        p.pos += vec2<f32>(20.0, 0.0) * params.dt * params.speed_multiplier;
        p.vel = vec2<f32>(20.0, 0.0);
    }

    particles[idx] = p;
}
`;

// ===== USAGE INSTRUCTIONS =====
/*

STEP 1: Test if rendering is working at all
---------------------------------------------
Replace your WATER_RENDER_SHADER vertex function with DEBUG_WATER_VERTEX
Replace your fragment shader with DEBUG_WATER_FRAGMENT

Result: You should see bright red/green/cyan particles at Y=50, all moving in +X direction

If you SEE particles:
  ✅ Rendering pipeline works
  ❌ Problem is in original shader logic (terrain height, size scaling, alpha, velocity rotation)
  
If you DON'T see particles:
  ❌ Problem is with mesh creation, bindings, or pipeline setup


STEP 2: If rendering works, test compute shader
------------------------------------------------
Replace your SIMULATION_SHADER with DEBUG_COMPUTE

Result: Particles should move in straight lines at constant speed

If particles move correctly:
  ✅ Compute pipeline works
  ❌ Problem is in original compute logic (terrain sampling, gradient calculation, bounds)
  
If particles don't move or behave oddly:
  ❌ Problem is with compute dispatch or buffer bindings


DEBUGGING TIPS:
---------------
1. Start with just the render shaders (Step 1)
2. Check particle count in UI - make it smaller (1000-5000) for easier debugging
3. Position camera at [0, 100, 0] looking down to see particles
4. If you see NOTHING with debug shaders, check:
   - Is the mesh being created? (check console logs)
   - Is renderRole "Water" being called in your render pass?
   - Are buffers actually populated? (log buffer sizes)
   - Is instance count correct?

*/

// ===== COMPUTE SHADERS =====

const SIMULATION_SHADER = `
struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
    age: f32,
    id: f32,
    padding: vec2<f32>,
}

@group(0) @binding(0)
var<storage, read_write> particles: array<Particle>;

struct SimParams {
    dt: f32,
    gravity: f32,
    friction: f32,
    respawn_age: f32,
    source_pos: vec2<f32>,
    source_radius: f32,
    landscape_size: f32,
    landscape_height: f32,
    landscape_y_offset: f32,
    time: f32,
    speed_multiplier: f32,
    padding: f32,
}

@group(1) @binding(0)
var<uniform> params: SimParams;

@group(2) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(2) @binding(1)
var landscape_sampler: sampler;

fn hash21(p: f32) -> vec2<f32> {
	var p3 = fract(vec3<f32>(p) * vec3<f32>(0.1031, 0.1030, 0.0973));
	p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

fn get_height(pos: vec2<f32>) -> f32 {
    let uv = (pos + params.landscape_size * 0.5) / params.landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    return (sample.r * params.landscape_height) + params.landscape_y_offset;
}

fn get_gradient(pos: vec2<f32>) -> vec2<f32> {
    let eps = 2.0;
    let h_c = get_height(pos);
    let h_r = get_height(pos + vec2<f32>(eps, 0.0));
    let h_u = get_height(pos + vec2<f32>(0.0, eps));
    return vec2<f32>(h_r - h_c, h_u - h_c) / eps;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if (idx >= arrayLength(&particles)) { return; }

    var p = particles[idx];
    
    // Increment age
    p.age += params.dt;
    
    // Bounds check
    let out_of_bounds = abs(p.pos.x) > params.landscape_size * 0.5 || abs(p.pos.y) > params.landscape_size * 0.5;

    // Respawn logic
    if (p.age > params.respawn_age || out_of_bounds) {
        let rng = hash21(p.id + params.time);
        let angle = rng.x * 6.28318;
        let radius = sqrt(rng.y) * params.source_radius;
        p.pos = params.source_pos + vec2<f32>(cos(angle), sin(angle)) * radius;
        p.vel = vec2<f32>(0.0, 0.0);
        p.age = 0.0;
    } else {
        // Physics update
        let grad = get_gradient(p.pos);
        
        // Acceleration = gravity pulling downhill + some turbulence
        let turbulence_phase = params.time * 0.5 + p.id * 0.1;
        let turbulence = vec2<f32>(
            sin(turbulence_phase + p.pos.y * 0.1),
            cos(turbulence_phase + p.pos.x * 0.1)
        );
        let accel = -grad * params.gravity + turbulence * 2.0;
        
        // Update velocity with friction
        p.vel += accel * params.dt * params.speed_multiplier;
        p.vel *= (1.0 - params.friction * params.dt);
        
        // Cap velocity
        let speed = length(p.vel);
        if (speed > 50.0) {
            p.vel = (p.vel / speed) * 50.0;
        }
        
        // Update position
        p.pos += p.vel * params.dt;
    }

    particles[idx] = p;
}
`;

// ===== RENDERING SHADERS =====

const WATER_RENDER_SHADER = `
struct Particle {
    pos: vec2<f32>,
    vel: vec2<f32>,
    age: f32,
    id: f32,
    padding: vec2<f32>,
}

@group(3) @binding(0)
var<storage, read> particles: array<Particle>;

struct SimParams {
    dt: f32,
    gravity: f32,
    friction: f32,
    respawn_age: f32,
    source_pos: vec2<f32>,
    source_radius: f32,
    landscape_size: f32,
    landscape_height: f32,
    landscape_y_offset: f32,
    time: f32,
    speed_multiplier: f32,
    padding: f32,
}
@group(3) @binding(1)
var<uniform> params: SimParams;

struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

@group(2) @binding(0)
var landscape_texture: texture_2d<f32>;
@group(2) @binding(1)
var landscape_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
    @builtin(instance_index) instance_index: u32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) age_factor: f32,
    @location(3) velocity: f32,
};

fn get_height(pos: vec2<f32>) -> f32 {
    let uv = (pos + params.landscape_size * 0.5) / params.landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    let sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    return (sample.r * params.landscape_height) + params.landscape_y_offset;
}

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    let p = particles[in.instance_index];
    
    // Particle size based on age (fade in/out)
    let age_factor = 1.0 - (p.age / params.respawn_age);
    let fade_in = smoothstep(0.0, 0.1, p.age / params.respawn_age);
    let size_scale = fade_in * age_factor * 1.5;
    
    // Determine world position
    let terrain_h = get_height(p.pos);
    let world_center = vec3<f32>(p.pos.x, terrain_h + 0.5, p.pos.y);
    
    // Stretch particle based on velocity
    let vel_len = length(p.vel);
    let vel_dir = select(vec2<f32>(1.0, 0.0), p.vel / (vel_len + 0.001), vel_len > 0.001);
    
    var local_pos = in.position;
    local_pos.x *= 0.5 * size_scale;
    local_pos.z *= (0.5 + min(vel_len * 0.1, 2.0)) * size_scale;
    
    // Rotate to align with velocity
    let rotated_pos = vec3<f32>(
        local_pos.x * vel_dir.y + local_pos.z * vel_dir.x,
        local_pos.y,
        local_pos.x * -vel_dir.x + local_pos.z * vel_dir.y
    );
    
    let world_pos = world_center + rotated_pos;
    
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(world_pos, 1.0);
    out.world_pos = world_pos;
    out.uv = in.tex_coords;
    out.age_factor = age_factor;
    out.velocity = vel_len;
    
    return out;
}
`;

// ===== ADDON TYPES =====

interface RiverParams {
    particleCount: number;
    sourcePos: [number, number];
    sourceRadius: number;
    respawnAge: number;
    gravity: number;
    friction: number;
    speedMultiplier: number;
    
    landscapeSize: number;
    landscapeHeight: number;
    landscapeYOffset: number;
}

const initialParams: RiverParams = {
    particleCount: 50000,
    sourcePos: [0, 0],
    sourceRadius: 15.0,
    respawnAge: 20.0,
    gravity: 25.0,
    friction: 1.2,
    speedMultiplier: 2.5,
    
    landscapeSize: 4096.0,
    landscapeHeight: 600.0,
    landscapeYOffset: 2.0,
};

const addonInfo = {
    name: "GPGPU River Simulation",
    version: "1.1.0",
    description: "Real-time particle-based river fluid simulation",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

let riverState: {
    currentParams: RiverParams,
    savedComponents: { id: string, name: string, params: RiverParams }[],
    activeComponentId: string | null
} = {
    currentParams: { ...initialParams },
    savedComponents: [],
    activeComponentId: Entropy.generateUUID()
};

let newComponentName = "New River Component";

let pipelineIds = {
    simulation: null as string | null,
    rendering: null as string | null,
};

let resources = {
    particleBuffer: null as string | null,
    paramsBuffer: null as string | null,
};

addon.onInit(async () => {
    Entropy.println("🌊 GPGPU River: Initializing...");

    // 1. Create Compute Pipeline
    pipelineIds.simulation = Entropy.Pipeline.createCompute({
        name: "RiverSimulation",
        shaderSource: SIMULATION_SHADER,
        // shaderSource: DEBUG_COMPUTE,
        bindGroups: [
            { entries: [{ binding: 0, visibility: ["Compute"], resourceType: "Storage" }] },
            { entries: [{ binding: 0, visibility: ["Compute"], resourceType: "Uniform" }] },
            { entries: [
                { binding: 0, visibility: ["Compute"], resourceType: "Texture" },
                { binding: 1, visibility: ["Compute"], resourceType: "Sampler" }
            ]}
        ]
    });

    // 2. Create Render Pipeline (PBR for full lighting integration)
    pipelineIds.rendering = Entropy.Pipeline.create({
        name: "RiverRendering",
        layout: "mesh",
        pbr: true, 
        vertexShader: WATER_RENDER_SHADER,
        // vertexShader: DEBUG_WATER_VERTEX,
        fragmentShader: `
            struct VertexOutput {
                @builtin(position) clip_position: vec4<f32>,
                @location(0) world_pos: vec3<f32>,
                @location(1) uv: vec2<f32>,
                @location(2) age_factor: f32,
                @location(3) velocity: f32,
            };

            struct GbufferOutput {
                @location(0) position: vec4<f32>,
                @location(1) normal: vec4<f32>,
                @location(2) albedo: vec4<f32>,
                @location(3) pbr_material: vec4<f32>,
            }

            @fragment
            fn fs_main(in: VertexOutput) -> GbufferOutput {
                let dist = length(in.uv - 0.5);
                if (dist > 0.5) { discard; }
                
                let shallow_blue = vec3<f32>(0.2, 0.7, 1.0);
                let deep_blue = vec3<f32>(0.05, 0.2, 0.5);
                let foam_white = vec3<f32>(1.0, 1.0, 1.0);
                
                let vel_factor = smoothstep(5.0, 40.0, in.velocity);
                var color = mix(deep_blue, shallow_blue, vel_factor);
                color = mix(color, foam_white, smoothstep(25.0, 50.0, in.velocity));
                
                let alpha = (1.0 - smoothstep(0.3, 0.5, dist)) * in.age_factor * 0.6;
                
                var out: GbufferOutput;
                out.position = vec4<f32>(in.world_pos, 1.0);
                out.normal = vec4<f32>(0.0, 1.0, 0.0, 1.0); 
                out.albedo = vec4<f32>(color, alpha);
                out.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0); 
                
                return out;
            }
        `,
        // fragmentShader: DEBUG_WATER_FRAGMENT,
        extraBindGroups: [
            { entries: [
                { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" }
            ]},
            { entries: [
                { binding: 0, visibility: ["Vertex"], resourceType: "StorageReadOnly" },
                { binding: 1, visibility: ["Vertex"], resourceType: "Uniform" }
            ]}
        ]
    });

    // 3. Initialize Buffers
    initResources();

    // 4. Register with Composer
    if (Entropy.Composer) {
        Entropy.Composer.registerEditor(addonInfo.name, renderUI);
        Entropy.Composer.registerRenderer(addonInfo.name, (id, params) => {
            // Update params from composer
            riverState.currentParams = { ...riverState.currentParams, ...params };
            updateBuffers();
            createRiverMesh(id);
            Entropy.println(`✅ [GPGPU River] river instance '${id}' created!`);
        });
    }

    // 5. Project Loading
    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            riverState = { ...riverState, ...data };
            if (Entropy.Composer) {
                riverState.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params);
                });
            }
        }
    });

    // 6. Update Loop
    addon.onUpdatePlus("Game Composer", (time) => {
        Entropy.Composer?.enableGameComposerOverride();
        runSimulation(time);
        Entropy.Composer?.disableGameComposerOverride();
    });

    setupUI();

    Entropy.println("✅ [GPGPU River] initialized!");
});

function initResources() {
    const count = riverState.currentParams.particleCount;
    
    // Create particle buffer (8 floats per particle for alignment: pos.x, pos.y, vel.x, vel.y, age, id, pad, pad)
    const initialData = new Float32Array(count * 8); 
    for (let i = 0; i < count; i++) {
        const rng = [Math.random(), Math.random()];
        const angle = rng[0] * 6.28318;
        const radius = Math.sqrt(rng[1]) * riverState.currentParams.sourceRadius;
        
        initialData[i * 8 + 0] = riverState.currentParams.sourcePos[0] + Math.cos(angle) * radius;
        initialData[i * 8 + 1] = riverState.currentParams.sourcePos[1] + Math.sin(angle) * radius;
        initialData[i * 8 + 4] = Math.random() * riverState.currentParams.respawnAge;
        initialData[i * 8 + 5] = i;
    }
    
    // Re-create buffer if size changed
    resources.particleBuffer = Entropy.Buffer.create({
        size: count * 8 * 4,
        usage: "Storage"
    });
    Entropy.Buffer.write(resources.particleBuffer!, initialData);

    // Uniform buffer for params
    if (!resources.paramsBuffer) {
        resources.paramsBuffer = Entropy.Buffer.create({
            size: 64,
            usage: "Uniform"
        });
    }
    updateBuffers();
}

function updateBuffers() {
    if (!resources.paramsBuffer) return;
    
    const data = new Float32Array([
        0.016, // dt
        riverState.currentParams.gravity,
        riverState.currentParams.friction,
        riverState.currentParams.respawnAge,
        riverState.currentParams.sourcePos[0],
        riverState.currentParams.sourcePos[1],
        riverState.currentParams.sourceRadius,
        riverState.currentParams.landscapeSize,
        riverState.currentParams.landscapeHeight,
        riverState.currentParams.landscapeYOffset,
        Date.now() / 1000,
        riverState.currentParams.speedMultiplier,
    ]);
    Entropy.Buffer.write(resources.paramsBuffer, data);
}

function runSimulation(time: number) {
    if (!pipelineIds.simulation || !resources.particleBuffer) return;

    try {
        updateBuffers();

        Entropy.Compute.dispatch({
            pipelineId: pipelineIds.simulation,
            groups: [Math.ceil(riverState.currentParams.particleCount / 64), 1, 1],
            bindings: [
                { group: 0, binding: 0, resource: { type: "Buffer", value: { id: resources.particleBuffer! } } },
                { group: 1, binding: 0, resource: { type: "Buffer", value: { id: resources.paramsBuffer! } } },
                { group: 2, binding: 0, resource: { type: "Texture", value: { id: "Landscape" } } },
                { group: 2, binding: 1, resource: { type: "Sampler" } }
            ]
        });
    } catch (e) {
        // Silently fail if landscape is not yet available
    }
}

function createRiverMesh(id: string) {
    if (!pipelineIds.rendering || !resources.particleBuffer) return;

    // A simple quad for each particle
    const vertices = [
        -1, 0, -1,  0, 1, 0,  0, 0,  1, 1, 1, 1,
         1, 0, -1,  0, 1, 0,  1, 0,  1, 1, 1, 1,
         1, 0,  1,  0, 1, 0,  1, 1,  1, 1, 1, 1,
        -1, 0,  1,  0, 1, 0,  0, 1,  1, 1, 1, 1,
    ];
    const indices = [0, 1, 2, 0, 2, 3];

    addon.Model.clearMesh(id);
    addon.Model.createMesh({
        id: id,
        position: [0, 0, 0],
        vertexData: vertices,
        indexData: indices,
        instanceCount: riverState.currentParams.particleCount,
        pipelineId: pipelineIds.rendering,
        renderRole: "Water",
        bindings: [
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: "Landscape" } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
            { group: 3, binding: 0, resource: { type: "Buffer", value: { id: resources.particleBuffer! } } },
            { group: 3, binding: 1, resource: { type: "Buffer", value: { id: resources.paramsBuffer! } } },
        ]
    });
}

function setupUI() {
    const tab = addon.UI.createTab({
        title: "GPGPU River",
        onRender: () => renderUI(tab)
    });
}

function renderUI(tab: string) {
    Entropy.UI.Widget.label(tab, { text: "🌊 GPGPU River Fluid Simulation", bold: true });

    Entropy.UI.Widget.button(tab, { text: "💾 Save All to Project", onClick: () => {
        addon.IO.save(riverState);
        if (Entropy.Composer) {
            riverState.savedComponents.forEach(comp => { Entropy.Composer!.registerComponent(addonInfo.name, comp.id, comp.name, comp.params); });
        }
        Entropy.println("✅ [GPGPU River] All state saved to project.");
    }});

    Entropy.UI.Widget.label(tab, { text: "📦 Components", bold: true });
    
    Entropy.UI.Widget.button(tab, { text: "➕ Save Current as Component", onClick: () => {
        const id = Entropy.generateUUID();
        riverState.savedComponents.push({ id, name: newComponentName, params: JSON.parse(JSON.stringify(riverState.currentParams)) });
        if (Entropy.Composer) { Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, riverState.currentParams); }
        Entropy.println(`✅ [GPGPU River] Saved component: ${newComponentName}`);
    }});
    
    riverState.savedComponents.forEach(comp => {
        Entropy.UI.Widget.button(tab, { text: `📂 Load & Render: ${comp.name}`, onClick: () => {
            riverState.currentParams = JSON.parse(JSON.stringify(comp.params));
            riverState.activeComponentId = comp.id;
            initResources();
            createRiverMesh("river_preview");
            Entropy.println(`✅ [GPGPU River] Loaded: ${comp.name}`);
        }});
    });

    Entropy.UI.Widget.label(tab, { text: "--------------------------------" });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Source X",
        value: riverState.currentParams.sourcePos[0],
        min: -2048,
        max: 2048,
        onChange: (v) => { riverState.currentParams.sourcePos[0] = parseFloat(v); updateBuffers(); }
    });
    
    Entropy.UI.Widget.slider(tab, {
        label: "Source Z",
        value: riverState.currentParams.sourcePos[1],
        min: -2048,
        max: 2048,
        onChange: (v) => { riverState.currentParams.sourcePos[1] = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Source Radius",
        value: riverState.currentParams.sourceRadius,
        min: 1,
        max: 100,
        onChange: (v) => { riverState.currentParams.sourceRadius = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Flow Speed",
        value: riverState.currentParams.speedMultiplier,
        min: 0.1,
        max: 10.0,
        onChange: (v) => { riverState.currentParams.speedMultiplier = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Friction",
        value: riverState.currentParams.friction,
        min: 0,
        max: 5,
        onChange: (v) => { riverState.currentParams.friction = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Landscape Y Offset",
        value: riverState.currentParams.landscapeYOffset,
        min: -1000,
        max: 1000,
        onChange: (v) => { riverState.currentParams.landscapeYOffset = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Particle Life",
        value: riverState.currentParams.respawnAge,
        min: 1,
        max: 60,
        onChange: (v) => { riverState.currentParams.respawnAge = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.slider(tab, {
        label: "Gravity",
        value: riverState.currentParams.gravity,
        min: 0,
        max: 50,
        onChange: (v) => { riverState.currentParams.gravity = parseFloat(v); updateBuffers(); }
    });

    Entropy.UI.Widget.button(tab, {
        text: "🔄 Reset Simulation",
        onClick: () => { initResources(); createRiverMesh("river_preview"); }
    });
}
