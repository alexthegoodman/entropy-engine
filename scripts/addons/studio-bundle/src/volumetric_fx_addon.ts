import { createNoise3D, createNoise4D } from "simplex-noise";
import type { ScopedAPI } from "./addon";

// ============================================================================
// VOLUMETRIC FX - AAA Quality Dust Motes & Atmospheric Fog
// ============================================================================

interface VolumetricConfig {
  // Fog parameters
  fogDensity: number;
  fogColor: [number, number, number];
  fogStart: number;
  fogEnd: number;
  
  // Dust/particle parameters
  dustEnabled: boolean;
  dustDensity: number;
  dustSize: number;
  dustBrightness: number;
  dustSpeed: number;
  
  // Light scattering
  sunScatterStrength: number;
  mieScattering: number;
  rayleighScattering: number;
  
  // Quality settings
  raymarchSteps: number;
  particleCount: number;
}

class VolumetricFX {
  private api: ScopedAPI;
  private config: VolumetricConfig;
  
  private noise3D = createNoise3D();
  private noise4D = createNoise4D();
  
  // Pipeline IDs
  private dustPipelineId: string | null = null;
  private fogPipelineId: string | null = null;
  
  // Texture/Buffer IDs
  private noiseTextureId: string | null = null;
  private dustPositionBufferId: string | null = null;
  private dustVelocityBufferId: string | null = null;
  
  // UI
  private tabId: string | null = null;
  
  // Animation
  private time: number = 0;
  private dustParticles: DustParticle[] = [];
  
  constructor(api: ScopedAPI) {
    this.api = api;
    
    // Default configuration - AAA quality settings
    this.config = {
      fogDensity: 0.415,
      fogColor: [0.7, 0.75, 0.8],
      fogStart: 10.0,
      fogEnd: 200.0,
      
      dustEnabled: true,
      dustDensity: 2000,
      dustSize: 0.08,
      dustBrightness: 1.5,
      dustSpeed: 0.3,
      
      sunScatterStrength: 0.8,
      mieScattering: 0.2,
      rayleighScattering: 0.1,
      
      raymarchSteps: 64,
      particleCount: 5000,
    };
  }
  
  init() {
    println("🌫️ Initializing Volumetric FX...");
    
    // Load saved configuration
    // const saved = this.api.IO.load();
    // if (saved) {
    //   this.config = { ...this.config, ...saved };
    // }
    
    // Create 3D noise texture for volumetric density
    // NOTE: Would benefit from op_texture_create_3d for true 3D lookup
    this.createNoiseTexture();
    
    // Create fog rendering pipeline
    this.createFogPipeline();
    
    // Create dust particle system
    if (this.config.dustEnabled) {
      this.createDustSystem();
    }
    
    // Create UI
    this.createUI();
    
    println("✨ Volumetric FX initialized!");
  }
  
  createNoiseTexture() {
    // Create a 2D texture that we'll sample with 3D coordinates
    // This is a workaround - ideal would be a true 3D texture
    const size = 256;
    const data = new Uint8Array(size * size * 4);
    
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        
        // Multi-octave noise for organic density
        const nx = x / size;
        const ny = y / size;
        
        let value = 0;
        value += this.noise3D(nx * 4, ny * 4, 0) * 0.5;
        value += this.noise3D(nx * 8, ny * 8, 0.5) * 0.25;
        value += this.noise3D(nx * 16, ny * 16, 1.0) * 0.125;
        
        // Normalize to 0-1
        value = (value + 1) * 0.5;
        
        const byte = Math.floor(value * 255);
        data[idx] = byte;
        data[idx + 1] = byte;
        data[idx + 2] = byte;
        data[idx + 3] = 255;
      }
    }
    
    this.noiseTextureId = this.api.Texture.create(size, size, data);
  }
  
  createFogPipeline() {
    // Volumetric fog with raymarching and light scattering
    const vertexShader = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
        @location(1) viewRay: vec3<f32>,
      }
      
      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var output: VertexOutput;
        
        // Fullscreen triangle
        let x = f32((vertexIndex & 1u) << 2u) - 1.0;
        let y = f32((vertexIndex & 2u) << 1u) - 1.0;
        
        output.position = vec4<f32>(x, y, 0.0, 1.0);
        output.uv = vec2<f32>(x, -y) * 0.5 + 0.5;
        
        // Compute view ray for raymarching
        // NOTE: Would benefit from view matrix uniform
        let aspectRatio = 1.778; // 16:9
        let fov = 1.2;
        output.viewRay = normalize(vec3<f32>(
          (x * aspectRatio) * fov,
          y * fov,
          -1.0
        ));
        
        return output;
      }
    `;
    
    const fragmentShader = `
      struct Uniforms {
        fogDensity: f32,
        fogStart: f32,
        fogEnd: f32,
        sunScatterStrength: f32,
        mieScattering: f32,
        rayleighScattering: f32,
        raymarchSteps: f32,
        time: f32,
        fogColor: vec3<f32>,
        sunDirection: vec3<f32>,
      }
      
      @group(1) @binding(0) var<uniform> uniforms: Uniforms;
      @group(1) @binding(1) var noiseTex: texture_2d<f32>;
      @group(1) @binding(2) var noiseSampler: sampler;
      
      // Sample 3D noise from 2D texture
      fn sampleNoise3D(pos: vec3<f32>) -> f32 {
        // Use z as animation offset
        let uv = pos.xy * 0.1 + vec2<f32>(uniforms.time * 0.01, 0.0);
        let sample1 = textureSample(noiseTex, noiseSampler, uv).r;
        let sample2 = textureSample(noiseTex, noiseSampler, uv + vec2<f32>(0.5, 0.5)).r;
        
        // Blend based on z
        return mix(sample1, sample2, fract(pos.z * 0.1));
      }
      
      // Mie scattering phase function
      fn miePhase(cosTheta: f32, g: f32) -> f32 {
        let g2 = g * g;
        let num = (1.0 - g2);
        let denom = pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
        return (3.0 * (1.0 - g2)) / (8.0 * 3.14159265359 * (2.0 + g2)) * num / denom;
      }
      
      // Rayleigh scattering phase function
      fn rayleighPhase(cosTheta: f32) -> f32 {
        return 0.75 * (1.0 + cosTheta * cosTheta);
      }
      
      // Volumetric fog density
      fn getFogDensity(worldPos: vec3<f32>) -> f32 {
        let noise = sampleNoise3D(worldPos + vec3<f32>(uniforms.time * 0.5, 0.0, 0.0));
        
        // Height-based density falloff
        let heightFalloff = exp(-worldPos.y * 0.05);
        
        return uniforms.fogDensity * noise * heightFalloff;
      }
      
      // Raymarch through volume
      fn raymarchFog(rayOrigin: vec3<f32>, rayDir: vec3<f32>, maxDist: f32) -> vec4<f32> {
        let stepSize = maxDist / uniforms.raymarchSteps;
        var transmittance = 1.0;
        var scatteredLight = vec3<f32>(0.0);
        
        let sunDir = normalize(uniforms.sunDirection);
        let cosTheta = dot(rayDir, sunDir);
        
        // Phase functions
        let miePhaseValue = miePhase(cosTheta, uniforms.mieScattering);
        let rayleighPhaseValue = rayleighPhase(cosTheta);
        
        for (var i = 0.0; i < uniforms.raymarchSteps; i += 1.0) {
          let t = i * stepSize;
          let samplePos = rayOrigin + rayDir * t;
          
          // Distance-based early exit
          if (t > uniforms.fogEnd) {
            break;
          }
          
          // Get density at this point
          let density = getFogDensity(samplePos);
          
          if (density > 0.001) {
            // Beer-Lambert law
            let sampleTransmittance = exp(-density * stepSize);
            
            // In-scattering (light scattering into view direction)
            let scattering = density * (
              miePhaseValue * uniforms.sunScatterStrength +
              rayleighPhaseValue * 0.3
            );
            
            // Accumulate light
            scatteredLight += uniforms.fogColor * scattering * transmittance * stepSize;
            
            // Update transmittance
            transmittance *= sampleTransmittance;
            
            // Early exit if fog is opaque
            if (transmittance < 0.01) {
              break;
            }
          }
        }
        
        return vec4<f32>(scatteredLight, 1.0 - transmittance);
      }
      
      @fragment
      fn fs_main(
        @location(0) uv: vec2<f32>,
        @location(1) viewRay: vec3<f32>
      ) -> @location(0) vec4<f32> {
        // NOTE: Would benefit from camera position uniform
        let rayOrigin = vec3<f32>(0.0, 2.0, 0.0);
        let rayDir = normalize(viewRay);
        
        // NOTE: Would benefit from depth buffer to get proper max distance
        let maxDist = uniforms.fogEnd;
        
        let fog = raymarchFog(rayOrigin, rayDir, maxDist);
        
        return fog;
      }
    `;
    
    this.fogPipelineId = Entropy.Pipeline.create({
      name: "volumetric_fog",
      vertexShader,
      fragmentShader,
      extraBindGroups: [{
        entries: [
          { binding: 0, visibility: ["Fragment"], resourceType: "Uniform" },
          { binding: 1, visibility: ["Fragment"], resourceType: "Texture" },
          { binding: 2, visibility: ["Fragment"], resourceType: "Sampler" },
        ]
      }]
    });

    // activate rendering (a bit of a bug)
    api.Model.createProcedural({
        type: "cube",
        pipelineId: "default",
        parameters: {
            position: [-2.0, 5.0, 0.0],
            scale: [1.0, 1.0, 1.0]
        }
    });
  }
  
  createDustSystem() {
    // Initialize dust particles
    this.initializeDustParticles();
    
    // Create dust rendering pipeline with billboarding
    const vertexShader = `
      struct Uniforms {
        viewProjection: mat4x4<f32>,
        cameraRight: vec3<f32>,
        cameraUp: vec3<f32>,
        dustSize: f32,
        time: f32,
      }
      
      struct ParticleData {
        position: vec3<f32>,
        brightness: f32,
      }
      
      @group(1) @binding(0) var<uniform> uniforms: Uniforms;
      @group(1) @binding(1) var<storage, read> particles: array<ParticleData>;
      
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
        @location(1) brightness: f32,
      }
      
      @vertex
      fn vs_main(
        @builtin(vertex_index) vertexIndex: u32,
        @builtin(instance_index) instanceIndex: u32
      ) -> VertexOutput {
        var output: VertexOutput;
        
        let particle = particles[instanceIndex];
        
        // Billboard quad vertices
        let vertices = array<vec2<f32>, 6>(
          vec2<f32>(-1.0, -1.0),
          vec2<f32>( 1.0, -1.0),
          vec2<f32>( 1.0,  1.0),
          vec2<f32>(-1.0, -1.0),
          vec2<f32>( 1.0,  1.0),
          vec2<f32>(-1.0,  1.0)
        );
        
        let uvs = array<vec2<f32>, 6>(
          vec2<f32>(0.0, 0.0),
          vec2<f32>(1.0, 0.0),
          vec2<f32>(1.0, 1.0),
          vec2<f32>(0.0, 0.0),
          vec2<f32>(1.0, 1.0),
          vec2<f32>(0.0, 1.0)
        );
        
        let corner = vertices[vertexIndex];
        output.uv = uvs[vertexIndex];
        
        // Billboard - face camera
        let worldPos = particle.position + 
          uniforms.cameraRight * corner.x * uniforms.dustSize +
          uniforms.cameraUp * corner.y * uniforms.dustSize;
        
        // NOTE: Would benefit from proper view/projection matrix uniforms
        output.position = vec4<f32>(worldPos, 1.0);
        output.brightness = particle.brightness;
        
        return output;
      }
    `;
    
    const fragmentShader = `
      struct Uniforms {
        dustBrightness: f32,
      }
      
      @group(1) @binding(0) var<uniform> uniforms: Uniforms;
      
      @fragment
      fn fs_main(
        @location(0) uv: vec2<f32>,
        @location(1) brightness: f32
      ) -> @location(0) vec4<f32> {
        // Soft circular particle
        let center = vec2<f32>(0.5);
        let dist = length(uv - center) * 2.0;
        
        // Soft falloff
        let alpha = smoothstep(1.0, 0.2, dist);
        
        // Subtle color variation
        let color = vec3<f32>(1.0, 0.98, 0.95);
        
        return vec4<f32>(color * brightness * uniforms.dustBrightness, alpha);
      }
    `;
    
    // NOTE: This is a placeholder - would need proper instanced rendering support
    this.dustPipelineId = Entropy.Pipeline.create({
      name: "dust_particles",
      vertexShader,
      fragmentShader,
      extraBindGroups: [{
        entries: [
          { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
          { binding: 1, visibility: ["Vertex"], resourceType: "StorageReadOnly" },
        ]
      }]
    });
  }
  
  initializeDustParticles() {
    const count = this.config.particleCount;
    const bounds = 100; // Particle spawn bounds
    
    this.dustParticles = [];
    
    for (let i = 0; i < count; i++) {
      this.dustParticles.push({
        position: [
          (Math.random() - 0.5) * bounds,
          Math.random() * 50,
          (Math.random() - 0.5) * bounds,
        ],
        velocity: [
          (Math.random() - 0.5) * 0.2,
          (Math.random() - 0.5) * 0.1,
          (Math.random() - 0.5) * 0.2,
        ],
        brightness: 0.5 + Math.random() * 0.5,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
  
  update(time: number, cameraPos: [number, number, number]) {
    this.time = time;
    
    // Update dust particles
    if (this.config.dustEnabled && this.dustParticles.length > 0) {
      const dt = 0.016; // ~60fps
      
      for (let i = 0; i < this.dustParticles.length; i++) {
        const p = this.dustParticles[i];
        
        // Turbulent motion using 4D noise (xyz + time)
        const noiseX = this.noise4D(
          p.position[0] * 0.1,
          p.position[1] * 0.1,
          p.position[2] * 0.1,
          time * 0.1 + p.phase
        );
        const noiseY = this.noise4D(
          p.position[0] * 0.1 + 100,
          p.position[1] * 0.1,
          p.position[2] * 0.1,
          time * 0.1 + p.phase
        );
        const noiseZ = this.noise4D(
          p.position[0] * 0.1 + 200,
          p.position[1] * 0.1,
          p.position[2] * 0.1,
          time * 0.1 + p.phase
        );
        
        // Apply turbulence
        p.velocity[0] += noiseX * this.config.dustSpeed * dt;
        p.velocity[1] += noiseY * this.config.dustSpeed * dt * 0.5;
        p.velocity[2] += noiseZ * this.config.dustSpeed * dt;
        
        // Gravity and drag
        p.velocity[1] -= 0.05 * dt;
        p.velocity[0] *= 0.99;
        p.velocity[1] *= 0.99;
        p.velocity[2] *= 0.99;
        
        // Update position
        p.position[0] += p.velocity[0];
        p.position[1] += p.velocity[1];
        p.position[2] += p.velocity[2];
        
        // Wrap particles
        const bounds = 100;
        if (p.position[0] < -bounds) p.position[0] = bounds;
        if (p.position[0] > bounds) p.position[0] = -bounds;
        if (p.position[2] < -bounds) p.position[2] = bounds;
        if (p.position[2] > bounds) p.position[2] = -bounds;
        if (p.position[1] < 0) p.position[1] = 50;
        if (p.position[1] > 50) p.position[1] = 0;
        
        // Flicker brightness
        p.brightness = 0.5 + 0.5 * Math.sin(time * 2 + p.phase);
      }
    }
    
    // NOTE: Would update GPU buffers here with particle data
    // this.updateDustBuffers();
  }
  
  createUI() {
    this.tabId = this.api.UI.createTab({
      title: "🌫️ Volumetric FX",
      onRender: () => this.renderUI(),
    });
  }
  
  renderUI() {
    if (!this.tabId) return;
    
    Entropy.UI.Widget.label(this.tabId, { text: "FOG SETTINGS", bold: true });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Fog Density",
      value: this.config.fogDensity * 1000,
      min: 0,
      max: 50,
      onChange: (val) => {
        this.config.fogDensity = parseFloat(val) / 1000;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Fog Start",
      value: this.config.fogStart,
      min: 0,
      max: 100,
      onChange: (val) => {
        this.config.fogStart = parseFloat(val);
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Fog End",
      value: this.config.fogEnd,
      min: 50,
      max: 500,
      onChange: (val) => {
        this.config.fogEnd = parseFloat(val);
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.colorInput(this.tabId, {
      label: "Fog Color",
      color: [...this.config.fogColor, 1.0],
      onChange: (color) => {
        this.config.fogColor = [color[0], color[1], color[2]];
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.label(this.tabId, { text: "" });
    Entropy.UI.Widget.label(this.tabId, { text: "DUST PARTICLES", bold: true });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Dust Density",
      value: this.config.dustDensity,
      min: 0,
      max: 5000,
      onChange: (val) => {
        this.config.dustDensity = parseFloat(val);
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Dust Size",
      value: this.config.dustSize * 100,
      min: 1,
      max: 20,
      onChange: (val) => {
        this.config.dustSize = parseFloat(val) / 100;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Dust Brightness",
      value: this.config.dustBrightness * 100,
      min: 10,
      max: 300,
      onChange: (val) => {
        this.config.dustBrightness = parseFloat(val) / 100;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Dust Speed",
      value: this.config.dustSpeed * 100,
      min: 0,
      max: 200,
      onChange: (val) => {
        this.config.dustSpeed = parseFloat(val) / 100;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.label(this.tabId, { text: "" });
    Entropy.UI.Widget.label(this.tabId, { text: "LIGHT SCATTERING", bold: true });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Sun Scatter Strength",
      value: this.config.sunScatterStrength * 100,
      min: 0,
      max: 200,
      onChange: (val) => {
        this.config.sunScatterStrength = parseFloat(val) / 100;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Mie Scattering",
      value: this.config.mieScattering * 100,
      min: 0,
      max: 100,
      onChange: (val) => {
        this.config.mieScattering = parseFloat(val) / 100;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Rayleigh Scattering",
      value: this.config.rayleighScattering * 100,
      min: 0,
      max: 100,
      onChange: (val) => {
        this.config.rayleighScattering = parseFloat(val) / 100;
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.label(this.tabId, { text: "" });
    Entropy.UI.Widget.label(this.tabId, { text: "QUALITY", bold: true });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Raymarch Steps",
      value: this.config.raymarchSteps,
      min: 16,
      max: 128,
      onChange: (val) => {
        this.config.raymarchSteps = parseFloat(val);
        this.saveConfig();
      }
    });
  }
  
  saveConfig() {
    this.api.IO.save(this.config);
  }
  
  cleanup() {
    println("🌫️ Cleaning up Volumetric FX...");
  }
}

// Particle type
interface DustParticle {
  position: [number, number, number];
  velocity: [number, number, number];
  brightness: number;
  phase: number;
}

// ============================================================================
// ADDON REGISTRATION
// ============================================================================

const api = Entropy.Addon.register({
    name: "VolumetricFX",
    version: "1.0.0",
    description: "AAA-quality volumetric fog and dust particles with light scattering",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

const fx = new VolumetricFX(api);

api.onInit(() => {
  fx.init();
});

api.onUpdate((time, pos, dir) => {
  fx.update(time, pos);
});

api.onCleanup(() => {
  fx.cleanup();
});