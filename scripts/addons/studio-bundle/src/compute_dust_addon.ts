import { createNoise3D, createNoise4D } from "simplex-noise";
import type { ScopedAPI } from "./addon";

// ============================================================================
// COMPUTE-BASED VOLUMETRIC DUST - Works with Current API
// ============================================================================
// This version uses compute shaders to render particles directly to a texture
// which is then composited over the scene - bypassing the need for instancing!
// ============================================================================

const addonInfo = {
  name: "ComputeDust",
  version: "1.0.0",
  description: "GPU-accelerated dust particles using compute shaders",
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
  
  // Rendering
  renderWidth: number;
  renderHeight: number;
}

class ComputeDustSystem {
  private api: ScopedAPI;
  private config: DustConfig;
  
  private noise3D = createNoise3D();
  
  // GPU resources
  private particleBufferId: string | null = null;
  private noiseTexId: string | null = null;
  private outputTexId: string | null = null;
  
  // Compute pipelines
  private updatePipelineId: string | null = null;
  private renderPipelineId: string | null = null;
  
  // Display mesh
  private compositePipelineId: string | null = null;
  
  private time: number = 0;
  
  constructor(api: ScopedAPI) {
    this.api = api;
    
    this.config = {
      particleCount: 8192, // Good for compute (power of 2)
      particleSize: 0.75,
      particleBrightness: 1.2,
      turbulenceStrength: 1.5,
      windSpeed: [0.5, -0.2, 0.3],
      gravity: -0.3,
      bounds: 80,
      
      renderWidth: 1920,
      renderHeight: 1080,
    };
  }
  
  init() {
    println("✨ Initializing Compute Dust System...");
    
    // Create 3D noise texture (using 2D slices as workaround)
    this.createNoiseTexture();
    
    // Create particle storage buffer
    this.createParticleBuffer();
    
    // Create output texture for rendered particles
    this.createOutputTexture();
    
    // Create compute pipelines
    this.createUpdatePipeline();
    this.createRenderPipeline();
    
    // Create composite pipeline (overlays particles on scene)
    this.createCompositePipeline();
    
    println("✨ Compute dust system ready!");
  }
  
  createNoiseTexture() {
    // Create tiling 3D noise in a 2D texture
    // We'll stack slices vertically
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
          
          // Multi-octave 3D noise
          let value = 0;
          value += this.noise3D(nx * 4, ny * 4, z * 4) * 0.5;
          value += this.noise3D(nx * 8, ny * 8, z * 8) * 0.25;
          value += this.noise3D(nx * 16, ny * 16, z * 16) * 0.125;
          
          value = (value + 1) * 0.5; // Normalize
          
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
    // Particle struct: position(3) + velocity(3) + brightness(1) + phase(1) = 8 floats = 32 bytes
    const particleSize = 8 * 4; // 8 floats * 4 bytes
    const bufferSize = this.config.particleCount * particleSize;
    
    this.particleBufferId = this.api.Buffer.create({
      size: bufferSize,
      usage: "Storage"
    });
    
    // Initialize particles on CPU, upload to GPU
    const initialData = new Float32Array(this.config.particleCount * 8);
    const bounds = this.config.bounds;
    
    for (let i = 0; i < this.config.particleCount; i++) {
      const offset = i * 8;
      
      // Position
      initialData[offset + 0] = (Math.random() - 0.5) * bounds;
      initialData[offset + 1] = Math.random() * 30;
      initialData[offset + 2] = (Math.random() - 0.5) * bounds;
      
      // Velocity
      initialData[offset + 3] = (Math.random() - 0.5) * 0.5;
      initialData[offset + 4] = (Math.random() - 0.5) * 0.2;
      initialData[offset + 5] = (Math.random() - 0.5) * 0.5;
      
      // Brightness
      initialData[offset + 6] = 0.5 + Math.random() * 0.5;
      
      // Phase
      initialData[offset + 7] = Math.random() * Math.PI * 2;
    }
    
    this.api.Buffer.write(this.particleBufferId, new Uint8Array(initialData.buffer));
  }
  
  createOutputTexture() {
    // RGBA16Float for HDR particles
    this.outputTexId = this.api.Texture.createStorage(
      this.config.renderWidth,
      this.config.renderHeight,
      "Rgba16Float"
    );
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
      
      // Sample 3D noise from 2D texture with slices (using textureLoad for compute)
      fn sampleNoise3D(pos: vec3<f32>) -> vec3<f32> {
        let sliceSize = 128.0;
        let numSlices = 16.0;
        
        // Determine which slice and blend
        let zScaled = fract(pos.z * 0.1) * numSlices;
        let slice0 = floor(zScaled);
        let slice1 = (slice0 + 1.0) % numSlices;
        let blend = fract(zScaled);
        
        // UV for each slice (convert to integer coordinates)
        let uv = fract(pos.xy * 0.1);
        let texSize = vec2<i32>(i32(sliceSize), i32(sliceSize * numSlices));
        
        let coord0 = vec2<i32>(
          i32(uv.x * sliceSize),
          i32((slice0 + uv.y) * sliceSize)
        );
        let coord1 = vec2<i32>(
          i32(uv.x * sliceSize),
          i32((slice1 + uv.y) * sliceSize)
        );
        
        // Use textureLoad instead of textureSample (compute shaders can't sample)
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
        
        // Boundary wrapping
        let bounds = params.bounds;
        if (particle.position.x < -bounds) { particle.position.x += bounds * 2.0; }
        if (particle.position.x > bounds) { particle.position.x -= bounds * 2.0; }
        if (particle.position.z < -bounds) { particle.position.z += bounds * 2.0; }
        if (particle.position.z > bounds) { particle.position.z -= bounds * 2.0; }
        if (particle.position.y < 0.0) { particle.position.y += 30.0; }
        if (particle.position.y > 30.0) { particle.position.y -= 30.0; }
        
        // Flicker brightness
        particle.brightness = 0.5 + 0.5 * sin(params.time * 2.0 + particle.phase);
        
        particles[idx] = particle;
      }
    `;

//     const shader = `
//     struct Particle {
//   position: vec3<f32>,
//   velocity: vec3<f32>,
//   brightness: f32,
//   phase: f32,
// }

// struct Params {
//   deltaTime: f32,
//   time: f32,
//   turbulenceStrength: f32,
//   gravity: f32,
//   windSpeed: vec3<f32>,
//   bounds: f32,
// }

// @group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
// @group(0) @binding(1) var<uniform> params: Params;
// @group(0) @binding(2) var noiseTex: texture_2d<f32>;  // Unused in basic version

// @compute @workgroup_size(256)
// fn main(@builtin(global_invocation_id) id: vec3<u32>) {
//   let idx = id.x;
//   if (idx >= arrayLength(&particles)) {
//     return;
//   }
  
//   var particle = particles[idx];
  
//   // // Apply basic forces (no turbulence)
//   // particle.velocity += params.windSpeed * params.deltaTime;
//   // particle.velocity.y += params.gravity * params.deltaTime;
  
//   // // Simple drag
//   // particle.velocity *= 0.98;
  
//   // // Update position
//   // particle.position += particle.velocity * params.deltaTime;
  
//   // Basic boundary wrapping
//   // let bounds = params.bounds;
//   // if (particle.position.x < -bounds) { particle.position.x += bounds * 2.0; }
//   // if (particle.position.x > bounds) { particle.position.x -= bounds * 2.0; }
//   // if (particle.position.z < -bounds) { particle.position.z += bounds * 2.0; }
//   // if (particle.position.z > bounds) { particle.position.z -= bounds * 2.0; }
//   // if (particle.position.y < 0.0) { particle.position.y += 30.0; }
//   // if (particle.position.y > 30.0) { particle.position.y -= 30.0; }
  
//   // Simple constant brightness (no flicker)
//   particle.brightness = 1.0;
  
//   particles[idx] = particle;
// }
//     `;
    
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
    // This compute shader renders particles directly to a texture!
    // const shader = `
    //   struct Particle {
    //     position: vec3<f32>,
    //     velocity: vec3<f32>,
    //     brightness: f32,
    //     phase: f32,
    //   }
      
    //   struct Params {
    //     cameraPos: vec3<f32>,
    //     cameraDir: vec3<f32>,
    //     particleSize: f32,
    //     particleBrightness: f32,
    //     viewWidth: f32,
    //     viewHeight: f32,
    //   }
      
    //   @group(0) @binding(0) var<storage, read> particles: array<Particle>;
    //   @group(0) @binding(1) var<uniform> params: Params;
    //   @group(0) @binding(2) var outputTex: texture_storage_2d<rgba16float, write>;
      
    //   // Project 3D point to screen space
    //   fn projectToScreen(worldPos: vec3<f32>) -> vec2<f32> {
    //     let viewPos = worldPos - params.cameraPos;
        
    //     // Simple perspective projection
    //     let forward = normalize(params.cameraDir);
    //     let right = normalize(cross(forward, vec3<f32>(0.0, 1.0, 0.0)));
    //     let up = cross(right, forward);
        
    //     let x = dot(viewPos, right);
    //     let y = dot(viewPos, up);
    //     let z = dot(viewPos, forward);
        
    //     // if (z <= 0.1) {
    //     //   return vec2<f32>(-9999.0, -9999.0); // Behind camera
    //     // }
        
    //     let fov = 1.2;
    //     let aspect = params.viewWidth / params.viewHeight;
        
    //     let screenX = (x / z) / (fov * aspect) * 0.5 + 0.5;
    //     let screenY = (y / z) / fov * 0.5 + 0.5;
        
    //     return vec2<f32>(screenX * params.viewWidth, (1.0 - screenY) * params.viewHeight);
    //   }
      
    //   // Soft circle falloff
    //   fn particleIntensity(dist: f32, size: f32) -> f32 {
    //     return exp(-dist * dist / (size * size));
    //   }
      
    //   @compute @workgroup_size(256)
    //   fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    //     let idx = id.x;
    //     if (idx >= arrayLength(&particles)) {
    //       return;
    //     }
        
    //     let particle = particles[idx];
        
    //     // Project to screen
    //     let screenPos = projectToScreen(particle.position);
        
    //     // Check if on screen
    //     // if (screenPos.x < 0.0 || screenPos.x >= params.viewWidth ||
    //     //     screenPos.y < 0.0 || screenPos.y >= params.viewHeight) {
    //     //   return;
    //     // }
        
    //     // Distance from camera (for size variation)
    //     let dist = length(particle.position - params.cameraPos);
    //     let sizeScale = 1.0 / max(dist * 0.1, 1.0);
    //     let particleRadius = params.particleSize * sizeScale * 100.0; // Pixels
        
    //     // Rasterize particle as soft circle
    //     let centerX = i32(screenPos.x);
    //     let centerY = i32(screenPos.y);
    //     let radius = i32(ceil(particleRadius * 2.0));
        
    //     for (var dy = -radius; dy <= radius; dy++) {
    //       for (var dx = -radius; dx <= radius; dx++) {
    //         let px = centerX + dx;
    //         let py = centerY + dy;
            
    //         if (px < 0 || px >= i32(params.viewWidth) ||
    //             py < 0 || py >= i32(params.viewHeight)) {
    //           continue;
    //         }
            
    //         let pixelDist = sqrt(f32(dx * dx + dy * dy));
    //         let intensity = particleIntensity(pixelDist, particleRadius);
            
    //         if (intensity > 0.01) {
    //           // Dust color (warm white)
    //           let color = vec3<f32>(1.0, 0.98, 0.95);
    //           let finalColor = color * particle.brightness * params.particleBrightness * intensity;
              
    //           // Atomic add would be ideal, but we'll use simple write
    //           // In practice, with many particles, this creates a nice accumulated glow
    //           textureStore(outputTex, vec2<i32>(px, py), vec4<f32>(finalColor, intensity));
    //         }
    //       }
    //     }
    //   }
    // `;

    const shader = `
    struct Particle {
  position: vec3<f32>,
  velocity: vec3<f32>,
  brightness: f32,
  phase: f32,
}

struct Params {
  cameraPos: vec3<f32>,
  cameraDir: vec3<f32>,
  particleSize: f32,
  particleBrightness: f32,
  viewWidth: f32,
  viewHeight: f32,
}

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var outputTex: texture_storage_2d<rgba16float, write>;

fn projectToScreen(worldPos: vec3<f32>) -> vec2<f32> {
  let viewPos = worldPos - params.cameraPos;
  let forward = normalize(params.cameraDir);
  let right = normalize(cross(forward, vec3<f32>(0.0, 1.0, 0.0)));
  let up = cross(right, forward);
  let x = dot(viewPos, right);
  let y = dot(viewPos, up);
  let z = dot(viewPos, forward);
  // if (z <= 0.1) {
  //   return vec2<f32>(-9999.0, -9999.0);
  // }
  let fov = 1.2;
  let aspect = params.viewWidth / params.viewHeight;
  let screenX = (x / z) / (fov * aspect) * 0.5 + 0.5;
  let screenY = (y / z) / fov * 0.5 + 0.5;
  return vec2<f32>(screenX * params.viewWidth, (1.0 - screenY) * params.viewHeight);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let idx = id.x;
  if (idx >= arrayLength(&particles)) {
    return;
  }
  let particle = particles[idx];
  let screenPos = projectToScreen(particle.position);
  // if (screenPos.x < 0.0 || screenPos.x >= params.viewWidth ||
  //     screenPos.y < 0.0 || screenPos.y >= params.viewHeight) {
  //   return;
  // }
  let px = i32(screenPos.x);
  let py = i32(screenPos.y);
  let color = vec3<f32>(1.0, 0.98, 0.95);
  let finalColor = color * particle.brightness * params.particleBrightness;
  textureStore(outputTex, vec2<i32>(px, py), vec4<f32>(finalColor, 1.0));
}
    `;
    
    this.renderPipelineId = this.api.Compute.createPipeline({
      name: "dust_render",
      shaderSource: shader,
      bindGroups: [{
        entries: [
          { binding: 0, visibility: ["Compute"], resourceType: "StorageReadOnly" },
          { binding: 1, visibility: ["Compute"], resourceType: "Uniform" },
          { binding: 2, visibility: ["Compute"], resourceType: "StorageTextureRgba16" },
        ]
      }]
    });
  }
  
  createCompositePipeline() {
    // Fullscreen quad that composites particle texture over scene
    const vertexShader = `
      struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      }
      
      @vertex
      fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
        var output: VertexOutput;
        let x = f32((vertexIndex & 1u) << 2u) - 1.0;
        let y = f32((vertexIndex & 2u) << 1u) - 1.0;
        output.position = vec4<f32>(x, y, 0.0, 1.0);
        output.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5);
        return output;
      }
    `;
    
    const fragmentShader = `
      @group(1) @binding(0) var particleTex: texture_2d<f32>;
      @group(1) @binding(1) var particleSampler: sampler;
      
      @fragment
      fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
        let particle = textureSample(particleTex, particleSampler, uv);
        
        // Alpha blend - blend state handles the rest
        return vec4<f32>(particle.rgb, particle.a);
      }
    `;
    
    this.compositePipelineId = Entropy.Pipeline.create({
      name: "dust_composite",
      vertexShader,
      fragmentShader,
      layout: "TriangleList",
      form: "composite",
      extraBindGroups: [{
        entries: [
          { binding: 0, visibility: ["Fragment"], resourceType: "Texture" },
          { binding: 1, visibility: ["Fragment"], resourceType: "Sampler" },
        ]
      }]
    });

    api.Model.createProcedural({
        type: "cube",
        pipelineId: "default",
        parameters: {
            position: [-2.0, 5.0, 0.0],
            scale: [1.0, 1.0, 1.0]
        }
    });
    
    // Register for composite rendering
    if (this.outputTexId && this.compositePipelineId) {
      Entropy.Composite.register("dust_composite", this.outputTexId!, this.compositePipelineId);
      Entropy.println("🔄 Dust Composite Registered");
    }
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
    
    // Render particles to texture
    if (this.renderPipelineId && this.outputTexId) {
      const renderParams = new Float32Array([
        ...cameraPos,
        0, // padding
        ...cameraDir,
        0, // padding
        this.config.particleSize,
        this.config.particleBrightness,
        this.config.renderWidth,
        this.config.renderHeight,
      ]);
      
      this.api.Compute.dispatch({
        pipelineId: this.renderPipelineId,
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
            resource: { type: "Uniform", value: { data: Array.from(renderParams) } }
          },
          {
            group: 0,
            binding: 2,
            resource: { type: "StorageTextureRgba16", value: { id: this.outputTexId } }
          },
        ]
      });
    }
  }
  
  cleanup() {
    println("✨ Cleaning up compute dust system...");
  }
}

// ============================================================================
// ADDON REGISTRATION
// ============================================================================

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