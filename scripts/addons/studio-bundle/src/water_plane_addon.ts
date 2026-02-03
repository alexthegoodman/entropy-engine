const WATER_SHADER = `
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
    
    ripple_foam_params: vec4<f32>,    // x: amp, y: freq, z: speed, w: foam_range
    foam_sparkle_params: vec4<f32>,   // x: crest_min, y: crest_max, z: sparkle_int, w: sparkle_thresh
    lighting_params: vec4<f32>,       // x: subsurface, y: fresnel_pow, z: fresnel_mult, w: reflection_int
    
    wave1_params: vec4<f32>,          // x: amp, y: freq, z: speed, w: steep
    wave1_dir: vec4<f32>,             // x,y: direction, z,w: padding
    
    wave2_params: vec4<f32>,          // x: amp, y: freq, z: speed, w: steep
    wave2_dir: vec4<f32>,             // x,y: direction, z,w: padding
    
    wave3_params: vec4<f32>,          // x: amp, y: freq, z: speed, w: steep
    wave3_dir: vec4<f32>,             // x,y: direction, z,w: padding

    landscape_params: vec4<f32>,      // x: height, y: size, z: y_offset, w: padding
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
    let landscape_size = water_config.landscape_params.y;
    let max_height = water_config.landscape_params.x;
    let y_offset = water_config.landscape_params.z;
    
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    return (height_sample.r * max_height) + y_offset;
}

// ===== NOISE FUNCTIONS =====
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

fn noise_derivative(p: vec2<f32>) -> vec3<f32> {
    let eps = 0.01;
    let center = noise(p);
    let dx = (noise(p + vec2<f32>(eps, 0.0)) - center) / eps;
    let dy = (noise(p + vec2<f32>(0.0, eps)) - center) / eps;
    return vec3<f32>(dx, dy, center);
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

    let dir1 = normalize(water_config.wave1_dir.xy);
    let dir2 = normalize(water_config.wave2_dir.xy);
    let dir3 = normalize(water_config.wave3_dir.xy);

    let wave1 = gerstner_wave(pos.xz, dir1, water_config.wave1_params.w, water_config.wave1_params.x, water_config.wave1_params.y, water_config.wave1_params.z);
    let wave2 = gerstner_wave(pos.xz, dir2, water_config.wave2_params.w, water_config.wave2_params.x, water_config.wave2_params.y, water_config.wave2_params.z);
    let wave3 = gerstner_wave(pos.xz, dir3, water_config.wave3_params.w, water_config.wave3_params.x, water_config.wave3_params.y, water_config.wave3_params.z);
    
    pos += wave1 + wave2 + wave3;

    velocity += gerstner_wave_velocity(pos.xz, dir1, water_config.wave1_params.x, water_config.wave1_params.y, water_config.wave1_params.z);
    velocity += gerstner_wave_velocity(pos.xz, dir2, water_config.wave2_params.x, water_config.wave2_params.y, water_config.wave2_params.z);
    velocity += gerstner_wave_velocity(pos.xz, dir3, water_config.wave3_params.x, water_config.wave3_params.y, water_config.wave3_params.z);

    let n_wave1 = gerstner_wave_normal(pos.xz, dir1, water_config.wave1_params.w, water_config.wave1_params.x, water_config.wave1_params.y, water_config.wave1_params.z);
    let n_wave2 = gerstner_wave_normal(pos.xz, dir2, water_config.wave2_params.w, water_config.wave2_params.x, water_config.wave2_params.y, water_config.wave2_params.z);
    let n_wave3 = gerstner_wave_normal(pos.xz, dir3, water_config.wave3_params.w, water_config.wave3_params.x, water_config.wave3_params.y, water_config.wave3_params.z);
    
    normal.x = -(n_wave1.x + n_wave2.x + n_wave3.x);
    normal.z = -(n_wave1.z + n_wave2.z + n_wave3.z);
    normal.y = 1.0 - (n_wave1.y + n_wave2.y + n_wave3.y);
    normal = normalize(normal);

    let tangent = normalize(vec3<f32>(1.0, normal.x, 0.0));
    let bitangent = normalize(cross(normal, tangent));

    let dist_to_player = distance(pos.xz, water_config.player_pos.xz);
    if (dist_to_player < 10.0) {
        let ripple_amplitude = water_config.ripple_foam_params.x * (1.0 - dist_to_player / 10.0);
        let ripple_offset = ripple_amplitude * sin(dist_to_player * water_config.ripple_foam_params.y - u_time.time * water_config.ripple_foam_params.z);
        pos.y += ripple_offset;
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
    
    let terrain_height = sample_landscape_height(in.world_position.xz);
    let water_depth = max(in.world_position.y - terrain_height, 0.0);
    
    // Detailed normals
    let detail_coord1 = in.world_position.xz * 0.5 + in.wave_velocity * u_time.time * 0.3;
    let detail_deriv1 = fbm_derivative(detail_coord1, 3);
    let detail_coord2 = in.world_position.xz * 1.5 - vec2<f32>(u_time.time * 0.2, u_time.time * 0.15);
    let detail_deriv2 = fbm_derivative(detail_coord2, 3);
    
    var detail_normal = vec3<f32>(0.0, 1.0, 0.0);
    detail_normal.x = detail_deriv1.x * 0.4 + detail_deriv2.x * 0.3;
    detail_normal.z = detail_deriv1.y * 0.4 + detail_deriv2.y * 0.3;
    detail_normal = normalize(detail_normal);
    
    let tangent = normalize(in.tangent);
    let bitangent = normalize(in.bitangent);
    let detail_world_normal = normalize(detail_normal.x * tangent + detail_normal.y * normal + detail_normal.z * bitangent);
    
    let detail_strength = mix(0.1, 0.4, smoothstep(5.0, 0.0, water_depth));
    normal = normalize(mix(normal, detail_world_normal, detail_strength));
    
    // Fresnel
    let ndotv = max(dot(normal, view_dir), 0.0);
    let fresnel = pow(1.0 - ndotv, water_config.lighting_params.y);
    
    // Depth Colors
    var water_color: vec3<f32>;
    if (water_depth < 2.0) {
        water_color = mix(water_config.shallow_color.xyz, water_config.medium_color.xyz, water_depth / 2.0);
    } else if (water_depth < 10.0) {
        water_color = mix(water_config.medium_color.xyz, water_config.deep_color.xyz, (water_depth - 2.0) / 8.0);
    } else {
        water_color = water_config.deep_color.xyz;
    }
    
    let sky_reflection = vec3<f32>(0.6, 0.8, 1.0);
    var final_color = mix(water_color, sky_reflection, fresnel * water_config.lighting_params.z);
    
    // Specular & Sparkle
    let sun_dir = normalize(vec3<f32>(0.3, 0.8, 0.5));
    let reflect_dir = reflect(-sun_dir, normal);
    let spec = pow(max(dot(view_dir, reflect_dir), 0.0), 200.0);
    
    let sparkle_noise = noise(in.world_position.xz * 40.0 + u_time.time * 2.0);
    let sparkle = step(water_config.foam_sparkle_params.w, sparkle_noise) * pow(max(dot(view_dir, reflect_dir), 0.0), 400.0);
    
    final_color += vec3<f32>(1.0, 1.0, 0.9) * (spec * 0.5 + sparkle * water_config.foam_sparkle_params.z);
    
    // Foam
    let shoreline_foam = smoothstep(water_config.ripple_foam_params.w, 0.0, water_depth);
    let wave_steepness = length(vec2<f32>(normal.x, normal.z));
    let crest_foam = smoothstep(water_config.foam_sparkle_params.x, water_config.foam_sparkle_params.y, wave_steepness);
    
    let foam_pattern = noise(in.world_position.xz * 20.0 + u_time.time);
    let foam = max(shoreline_foam, crest_foam) * step(0.5, foam_pattern);
    final_color = mix(final_color, vec3<f32>(0.9, 0.95, 1.0), foam * 0.7);
    
    // Subsurface
    let subsurface = smoothstep(4.0, 0.0, water_depth) * max(dot(normal, sun_dir), 0.0);
    final_color += water_config.shallow_color.xyz * subsurface * water_config.lighting_params.x;

    output.position = vec4<f32>(in.world_position, 1.0);
    output.normal = vec4<f32>(normal, 1.0);
    output.albedo = vec4<f32>(final_color, 0.85);
    output.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0);
    return output;
}
`;

function generateGrid(size: number, resolution: number) {
    const vertices = [];
    const indices = [];
    const halfSize = size / 2;
    for (let row = 0; row <= resolution; row++) {
        for (let col = 0; col <= resolution; col++) {
            const x = -halfSize + (col / resolution) * size;
            const z = -halfSize + (row / resolution) * size;
            vertices.push(x, 0, z);
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
    return { vertices, indices };
}

let waterParams: any = {
    shallowColor: [0.2, 0.85, 0.95, 1.0],
    mediumColor: [0.0, 0.55, 0.75, 1.0],
    deepColor: [0.0, 0.25, 0.45, 1.0],
    waterY: -300.0,
    
    rippleAmp: 1.5,
    rippleFreq: 0.25,
    rippleSpeed: 3.0,
    shorelineFoamRange: 2.5,
    
    crestFoamMin: 0.45,
    crestFoamMax: 0.75,
    sparkleIntensity: 1.5,
    sparkleThreshold: 0.8,
    
    subsurfaceMult: 0.35,
    fresnelPower: 2.5,
    fresnelMult: 0.6,
    
    wave1: { amp: 1.5, freq: 0.08, speed: 0.8, steep: 0.3, dir: [1.0, 0.5] },
    wave2: { amp: 1.2, freq: 0.09, speed: 1.2, steep: 0.3, dir: [-0.7, 1.0] },
    wave3: { amp: 0.8, freq: 0.12, speed: 1.5, steep: 0.25, dir: [0.8, -0.6] },
    
    landscapeHeight: 100.0,
    landscapeSize: 4096.0,
    landscapeYOffset: 0.0,
    
    gridResolution: 256,
    gridSize: 4096.0,
    pipelineId: null
};

function updateWater() {
    const configData = [
        ...waterParams.shallowColor,
        ...waterParams.mediumColor,
        ...waterParams.deepColor,
        0, 0, 0, 0, // player_pos placeholder
        
        waterParams.rippleAmp, waterParams.rippleFreq, waterParams.rippleSpeed, waterParams.shorelineFoamRange,
        waterParams.crestFoamMin, waterParams.crestFoamMax, waterParams.sparkleIntensity, waterParams.sparkleThreshold,
        waterParams.subsurfaceMult, waterParams.fresnelPower, waterParams.fresnelMult, 0.0,
        
        waterParams.wave1.amp, waterParams.wave1.freq, waterParams.wave1.speed, waterParams.wave1.steep,
        ...waterParams.wave1.dir, 0, 0,
        
        waterParams.wave2.amp, waterParams.wave2.freq, waterParams.wave2.speed, waterParams.wave2.steep,
        ...waterParams.wave2.dir, 0, 0,
        
        waterParams.wave3.amp, waterParams.wave3.freq, waterParams.wave3.speed, waterParams.wave3.steep,
        ...waterParams.wave3.dir, 0, 0,
        
        waterParams.landscapeHeight, waterParams.landscapeSize, waterParams.landscapeYOffset, 0.0
    ];

    const grid = generateGrid(waterParams.gridSize, waterParams.gridResolution);

    addon.Model.clearMeshes();
    addon.Model.createMesh({
        pipelineId: waterParams.pipelineId,
        renderRole: "Water",
        position: [0, waterParams.waterY, 0],
        vertexData: grid.vertices,
        indexData: grid.indices,
        bindings: [
            { group: 1, binding: 0, resource: { type: "Time" } },
            { group: 2, binding: 0, resource: { type: "Texture", value: { id: "Landscape" } } },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
            { group: 3, binding: 0, resource: { type: "Uniform", value: { data: configData } } }
        ]
    } as any);
}

const addon = Entropy.Addon.register({
    name: "Advanced Water Plane",
    version: "2.0.0",
    description: "Highly customizable procedural water with presets",
    author: ["Entropy Team"],
    capabilities: { graphics: true, ui: true }
});

addon.onInit(async () => {
    const pipelineId = Entropy.Pipeline.create({
        name: "AdvancedWaterPipeline",
        vertexShader: WATER_SHADER,
        fragmentShader: WATER_SHADER,
        pbr: true,
        extraBindGroups: [
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Time" }] },
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" }, { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" }] },
            { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }] }
        ]
    });

    waterParams.pipelineId = pipelineId;
    updateWater();

    const renderWaterUI = (tab: string) => {
        Entropy.UI.Widget.label(tab, { text: "🌊 Water Plane Settings", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "💾 Save Settings",
            onClick: () => addon.IO.save(waterParams)
        });

        Entropy.UI.Widget.label(tab, { text: "🎨 Color & Depth", bold: true });
        Entropy.UI.Widget.colorInput(tab, { label: "Shallow Color", color: waterParams.shallowColor, onChange: (c: number[]) => { waterParams.shallowColor = c; updateWater(); } });
        Entropy.UI.Widget.colorInput(tab, { label: "Medium Color", color: waterParams.mediumColor, onChange: (c: number[]) => { waterParams.mediumColor = c; updateWater(); } });
        Entropy.UI.Widget.colorInput(tab, { label: "Deep Color", color: waterParams.deepColor, onChange: (c: number[]) => { waterParams.deepColor = c; updateWater(); } });
        Entropy.UI.Widget.slider(tab, { label: "Water Y Height", value: waterParams.waterY, min: -1000, max: 1000, onChange: (v: string) => { waterParams.waterY = parseFloat(v); updateWater(); } });

        Entropy.UI.Widget.label(tab, { text: "🌊 Wave Parameters", bold: true });
        Entropy.UI.Widget.slider(tab, { label: "Wave 1 Amp", value: waterParams.wave1.amp, min: 0, max: 10, onChange: (v: string) => { waterParams.wave1.amp = parseFloat(v); updateWater(); } });
        Entropy.UI.Widget.slider(tab, { label: "Wave 1 Freq", value: waterParams.wave1.freq, min: 0, max: 0.5, onChange: (v: string) => { waterParams.wave1.freq = parseFloat(v); updateWater(); } });
        
        Entropy.UI.Widget.label(tab, { text: "✨ Effects & Foam", bold: true });
        Entropy.UI.Widget.slider(tab, { label: "Sparkle Intensity", value: waterParams.sparkleIntensity, min: 0, max: 5, onChange: (v: string) => { waterParams.sparkleIntensity = parseFloat(v); updateWater(); } });
        Entropy.UI.Widget.slider(tab, { label: "Foam Range", value: waterParams.shorelineFoamRange, min: 0, max: 10, onChange: (v: string) => { waterParams.shorelineFoamRange = parseFloat(v); updateWater(); } });

        Entropy.UI.Widget.label(tab, { text: "🎭 Presets", bold: true });
        Entropy.UI.Widget.button(tab, { text: "🏝️ Tropical Lagoon", onClick: () => {
            waterParams.shallowColor = [0.1, 0.9, 0.8, 1.0];
            waterParams.mediumColor = [0.0, 0.4, 0.6, 1.0];
            waterParams.wave1.amp = 0.5;
            waterParams.sparkleIntensity = 2.0;
            updateWater();
        }});
        Entropy.UI.Widget.button(tab, { text: "⛈️ Stormy Ocean", onClick: () => {
            waterParams.shallowColor = [0.2, 0.25, 0.3, 1.0];
            waterParams.mediumColor = [0.1, 0.15, 0.2, 1.0];
            waterParams.wave1.amp = 4.0;
            waterParams.wave1.speed = 2.0;
            updateWater();
        }});
    };

    if (Entropy.Composer) Entropy.Composer.registerEditor("Water Plane", renderWaterUI);

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            waterParams = { ...waterParams, ...data };
            updateWater();
        }
    });

    // Try initial load
    const savedData = addon.IO.load();
    if (savedData) {
        waterParams = { ...waterParams, ...savedData };
        updateWater();
    }

    const tab = addon.UI.createTab({ title: "Water", onRender: () => renderWaterUI(tab) });
});