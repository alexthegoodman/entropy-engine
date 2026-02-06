import { createNoise3D, createNoise4D } from "simplex-noise";
import type { ScopedAPI } from "./addon";

const addonInfo = {
  name: "ComputeDust",
  version: "1.0.0",
  description: "GPU-accelerated dust particles using compute shaders + instanced rendering",
  author: ["Entropy Team"],
  capabilities: {
    graphics: true,
    ui: true
  }
};

interface DustConfig {
  particleCount: number;
  particleSize: number;
  particleBrightness: number;
  turbulenceStrength: number;
  windSpeed: [number, number, number];
  gravity: number;
  bounds: number;
}

class ComputeDustSystem {
  private api: ScopedAPI;
  private config: DustConfig;
  
  private noise3D = createNoise3D();
  
  // GPU resources
  private particleBufferId: string | null = null;
  private noiseTexId: string | null = null;
  
  // Compute pipeline (just for updates now)
  private updatePipelineId: string | null = null;
  
  // Rendering resources
  private dustPipelineId: string | null = null;
  private dustMeshId: string = "dust_particles";
  
  private time: number = 0;
  
  constructor(api: ScopedAPI) {
    this.api = api;
    
    this.config = {
      particleCount: 4096,
      particleSize: 10.00,
      particleBrightness: 1.5,
      turbulenceStrength: 1.5,
      windSpeed: [0.5, -0.2, 0.3],
      gravity: -0.3,
      bounds: 4096,
    };
  }
  
  init() {
    println("✨ Initializing Compute Dust System...");
    
    this.createNoiseTexture();
    this.createParticleBuffer();
    this.createUpdatePipeline();
    this.createRenderPipeline();
    this.createBillboardMesh();
    
    println("✨ Compute dust system ready!");
  }

  createNoiseTexture() {
    // Same as before - 3D noise texture
    const sliceSize = 128;
    const numSlices = 16;
    const width = sliceSize;
    const height = sliceSize * numSlices;
    
    const data = new Uint8Array(width * height * 4);
    
    for (let slice = 0; slice < numSlices; slice++) {
      const z = slice / numSlices;
      
      for (let y = 0; y < sliceSize; y++) {
        for (let x = 0; x < sliceSize; x++) {
          const nx = x / sliceSize;
          const ny = y / sliceSize;
          
          let value = 0;
          value += this.noise3D(nx * 4, ny * 4, z * 4) * 0.5;
          value += this.noise3D(nx * 8, ny * 8, z * 8) * 0.25;
          value += this.noise3D(nx * 16, ny * 16, z * 16) * 0.125;
          
          value = (value + 1) * 0.5;
          
          const idx = ((slice * sliceSize + y) * width + x) * 4;
          const byte = Math.floor(value * 255);
          data[idx] = byte;
          data[idx + 1] = byte;
          data[idx + 2] = byte;
          data[idx + 3] = 255;
        }
      }
    }
    
    this.noiseTexId = this.api.Texture.create(width, height, data);
  }
  
  createParticleBuffer() {
    // Same particle buffer structure
    const particleSize = 8 * 4;
    const bufferSize = this.config.particleCount * particleSize;
    
    this.particleBufferId = this.api.Buffer.create({
      size: bufferSize,
      usage: "Storage"
    });
    
    const initialData = new Float32Array(this.config.particleCount * 8);
    const bounds = this.config.bounds;
    
    for (let i = 0; i < this.config.particleCount; i++) {
      const offset = i * 8;
      
      initialData[offset + 0] = (Math.random() - 0.5) * bounds;
      initialData[offset + 1] = Math.random() * 30;
      initialData[offset + 2] = (Math.random() - 0.5) * bounds;
      
      initialData[offset + 3] = (Math.random() - 0.5) * 0.5;
      initialData[offset + 4] = (Math.random() - 0.5) * 0.2;
      initialData[offset + 5] = (Math.random() - 0.5) * 0.5;
      
      initialData[offset + 6] = 0.5 + Math.random() * 0.5;
      initialData[offset + 7] = Math.random() * Math.PI * 2;
    }
    
    this.api.Buffer.write(this.particleBufferId, new Uint8Array(initialData.buffer));
  }
  
  createUpdatePipeline() {
    const shader = `
      struct Particle {
        position: vec3<f32>,
        velocity: vec3<f32>,
        brightness: f32,
        phase: f32,
      }
      
      struct Params {
        deltaTime: f32,
        time: f32,
        turbulenceStrength: f32,
        gravity: f32,
        windSpeed: vec3<f32>,
        bounds: f32,
      }
      
      @group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
      @group(0) @binding(1) var<uniform> params: Params;
      @group(0) @binding(2) var noiseTex: texture_2d<f32>;
      
      fn sampleNoise3D(pos: vec3<f32>) -> vec3<f32> {
        let sliceSize = 128.0;
        let numSlices = 16.0;
        
        let zScaled = fract(pos.z * 0.1) * numSlices;
        let slice0 = floor(zScaled);
        let slice1 = (slice0 + 1.0) % numSlices;
        let blend = fract(zScaled);
        
        let uv = fract(pos.xy * 0.1);
        
        let coord0 = vec2<i32>(
          i32(uv.x * sliceSize),
          i32((slice0 + uv.y) * sliceSize)
        );
        let coord1 = vec2<i32>(
          i32(uv.x * sliceSize),
          i32((slice1 + uv.y) * sliceSize)
        );
        
        let noise0 = textureLoad(noiseTex, coord0, 0).rgb;
        let noise1 = textureLoad(noiseTex, coord1, 0).rgb;
        
        return mix(noise0, noise1, blend) * 2.0 - 1.0;
      }
      
      @compute @workgroup_size(256)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let idx = id.x;
        if (idx >= arrayLength(&particles)) {
          return;
        }
        
        var particle = particles[idx];
        
        // Turbulence from 3D noise
        let noisePos = particle.position + vec3<f32>(params.time * 0.3, 0.0, 0.0);
        let turbulence = sampleNoise3D(noisePos);
        
        // Apply forces
        particle.velocity += turbulence * params.turbulenceStrength * params.deltaTime;
        particle.velocity += params.windSpeed * params.deltaTime;
        particle.velocity.y += params.gravity * params.deltaTime;
        
        // Drag
        particle.velocity *= 0.98;
        
        // Update position
        particle.position += particle.velocity * params.deltaTime;
        
        // Static world bounds with bouncing
        let bounds = params.bounds;
        if (particle.position.x < -bounds || particle.position.x > bounds) {
          particle.velocity.x *= -0.8;
          particle.position.x = clamp(particle.position.x, -bounds, bounds);
        }
        if (particle.position.z < -bounds || particle.position.z > bounds) {
          particle.velocity.z *= -0.8;
          particle.position.z = clamp(particle.position.z, -bounds, bounds);
        }
        if (particle.position.y < 0.0 || particle.position.y > 30.0) {
          particle.velocity.y *= -0.8;
          particle.position.y = clamp(particle.position.y, 0.0, 30.0);
        }
        
        // Flicker brightness
        particle.brightness = 0.5 + 0.5 * sin(params.time * 2.0 + particle.phase);
        
        particles[idx] = particle;
      }
    `;
    
    this.updatePipelineId = this.api.Compute.createPipeline({
      name: "dust_update",
      shaderSource: shader,
      bindGroups: [{
        entries: [
          { binding: 0, visibility: ["Compute"], resourceType: "Storage" },
          { binding: 1, visibility: ["Compute"], resourceType: "Uniform" },
          { binding: 2, visibility: ["Compute"], resourceType: "TextureNonFilterable" },
        ]
      }]
    });
  }
  
  createRenderPipeline() {
    const vertexShader = `
      struct Particle {
        position: vec3<f32>,
        velocity: vec3<f32>,
        brightness: f32,
        phase: f32,
      }
      
      struct Params {
        particleSize: f32,
        particleBrightness: f32,
      }
      
      @group(0) @binding(0) var<uniform> viewProj: mat4x4<f32>;
      @group(2) @binding(0) var<storage, read> particles: array<Particle>;
      @group(2) @binding(1) var<uniform> params: Params;
      
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
        @location(1) brightness: f32,
      }
      
      @vertex
      fn vs_main(
        @location(0) vertexPos: vec2<f32>,
        @builtin(instance_index) instanceIdx: u32
      ) -> VertexOutput {
        var output: VertexOutput;
        
        let particle = particles[instanceIdx];
        
        // Billboard in view space (always faces camera)
        let worldPos = particle.position;
        let viewPos = viewProj * vec4<f32>(worldPos, 1.0);
        
        // Offset in screen space to create quad
        let offset = vertexPos * params.particleSize;
        output.position = viewPos + vec4<f32>(offset, 0.0, 0.0);
        
        output.uv = vertexPos * 0.5 + 0.5;
        output.brightness = particle.brightness * params.particleBrightness;
        
        return output;
      }
    `;
    
    const fragmentShader = `
      @fragment
      fn fs_main(
        @location(0) uv: vec2<f32>,
        @location(1) brightness: f32
      ) -> @location(0) vec4<f32> {
        // Soft circular particle
        let dist = length(uv - 0.5) * 2.0;
        let alpha = exp(-dist * dist * 4.0);
        
        // Warm dust color
        let color = vec3<f32>(1.0, 0.98, 0.95);
        
        return vec4<f32>(color * brightness * alpha, alpha * 0.8);
      }
    `;
    
    this.dustPipelineId = Entropy.Pipeline.create({
      name: "dust_billboard",
      vertexShader,
      fragmentShader,
      layout: "mesh",
      extraBindGroups: [{
        entries: [
          { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Storage" },
          { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
        ]
      }]
    });
  }
  
  createBillboardMesh() {
    // Single quad for billboard (will be instanced)
    const vertices = new Float32Array([
      -1, -1,  // Bottom-left
       1, -1,  // Bottom-right
       1,  1,  // Top-right
      -1,  1,  // Top-left
    ]);
    
    const indices = new Uint32Array([
      0, 1, 2,
      0, 2, 3,
    ]);
    
    this.api.Model.createMesh({
      id: this.dustMeshId,
      position: [0, 0, 0],
      vertexData: Array.from(vertices),
      indexData: Array.from(indices),
      pipelineId: this.dustPipelineId!,
      instanceCount: this.config.particleCount,
      bindings: [
        {
          group: 2,
          binding: 0,
          resource: { type: "Storage", value: { id: this.particleBufferId! } }
        },
        {
          group: 2,
          binding: 1,
          resource: { 
            type: "Uniform", 
            value: { 
              data: [this.config.particleSize, this.config.particleBrightness] 
            } 
          }
        },
      ]
    });
  }
  
  update(time: number, cameraPos: [number, number, number], cameraDir: [number, number, number]) {
    this.time = time;
    const dt = 0.016;
    
    if (!this.updatePipelineId || !this.particleBufferId || !this.noiseTexId) return;
    
    // Update particles with compute shader
    const updateParams = new Float32Array([
      dt,
      time,
      this.config.turbulenceStrength,
      this.config.gravity,
      ...this.config.windSpeed,
      this.config.bounds,
    ]);
    
    this.api.Compute.dispatch({
      pipelineId: this.updatePipelineId,
      groups: [Math.ceil(this.config.particleCount / 256), 1, 1],
      bindings: [
        {
          group: 0,
          binding: 0,
          resource: { type: "Storage", value: { id: this.particleBufferId } }
        },
        {
          group: 0,
          binding: 1,
          resource: { type: "Uniform", value: { data: Array.from(updateParams) } }
        },
        {
          group: 0,
          binding: 2,
          resource: { type: "TextureNonFilterable", value: { id: this.noiseTexId } }
        },
      ]
    });
  }
  
  cleanup() {
    println("✨ Cleaning up compute dust system...");
    this.api.Model.clearMesh(this.dustMeshId);
  }
}

const api = Entropy.Addon.register(addonInfo);
const dust = new ComputeDustSystem(api);

api.onInit(() => {
  dust.init();
});

api.onUpdate((time, pos, dir) => {
  dust.update(time, pos, dir);
});

api.onCleanup(() => {
  dust.cleanup();
});