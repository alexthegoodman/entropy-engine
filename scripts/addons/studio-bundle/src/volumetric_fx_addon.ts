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

  // New: Cube bounds for confined rendering
  cubePosition: [number, number, number];
  cubeSize: [number, number, number];
}

class VolumetricFX {
  private api: ScopedAPI;
  public config: VolumetricConfig; // changed to public for tool access
  
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

  particleBufferId: string = "";
  storageBufferId: string = "";

  particleStride: number = 0;
  particleData: Float32Array | null = null;

  public savedComponents: { id: string, name: string, config: VolumetricConfig }[] = [];
  public activeComponentId: string | null = null;
  
  constructor(api: ScopedAPI) {
    this.api = api;
    
    // Default configuration - AAA quality settings
    this.config = {
      fogDensity: 0.002,
      fogColor: [0.7, 0.75, 0.8],
      fogStart: 150.0,
      fogEnd: 200.0,
      
      dustEnabled: false, // later
      dustDensity: 2000,
      dustSize: 0.08,
      dustBrightness: 1.5,
      dustSpeed: 0.3,
      
      sunScatterStrength: 0.8,
      mieScattering: 0.2,
      rayleighScattering: 0.1,
      
      raymarchSteps: 64,
      particleCount: 5000,

      // Default cube (matches original approximate bounds)
      cubePosition: [0, 25, 0],
      cubeSize: [500, 500, 500],
    };
  }
  
  init() {
    println("🌫️ Volumetric FX Initializing...");
    
    const loadData = () => {
        const saved = this.api.IO.load();
        if (saved) {
            this.savedComponents = saved.savedComponents || [];
            this.activeComponentId = saved.activeComponentId || null;
            if (saved.config) this.config = saved.config;

            if (Entropy.Composer) {
                this.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent("VolumetricFX", comp.id, comp.name, comp.config);
                });
            }
        }
    };

    this.api.onProjectChanged(() => {
        loadData();
    });
    
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
    // Volumetric fog with raymarching and light scattering, confined to a cube
    const vertexShader = `
      struct CameraUniform {
          view_proj: mat4x4<f32>,
          view_pos: vec4<f32>,
          window_size: vec4<f32>,
          inverse_view: mat4x4<f32>,
          inverse_projection: mat4x4<f32>,
      };
      @group(0) @binding(0)
      var<uniform> camera: CameraUniform;

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
      struct CameraUniform {
          view_proj: mat4x4<f32>,
          view_pos: vec4<f32>,
          window_size: vec4<f32>,
          inverse_view: mat4x4<f32>,
          inverse_projection: mat4x4<f32>,
      };
      @group(0) @binding(0)
      var<uniform> camera: CameraUniform;

      struct Uniforms {
        fogColor: vec4<f32>,
        sunDirection: vec4<f32>,
        cameraPos: vec4<f32>,  // New: Camera position
        cubeMin: vec4<f32>,    // New: Cube min bounds
        cubeMax: vec4<f32>,    // New: Cube max bounds

        fogDensity: f32,
        fogStart: f32,
        fogEnd: f32,
        sunScatterStrength: f32,
        mieScattering: f32,
        rayleighScattering: f32,
        raymarchSteps: f32,
        time: f32,
      }
      
      @group(1) @binding(0) var noiseTex: texture_2d<f32>;
      @group(1) @binding(1) var noiseSampler: sampler;
      @group(1) @binding(2) var depthTex: texture_depth_2d;
      @group(2) @binding(0) var<storage, read> uniforms: Uniforms;
      
      // Sample 3D noise from 2D texture
      fn sampleNoise3D(pos: vec3<f32>) -> f32 {
        // Use z as animation offset
        let uv = pos.xy * 0.1 + vec2<f32>(uniforms.time * 0.01, 0.0);
        let sample1 = textureSample(noiseTex, noiseSampler, uv).r;
        let sample2 = textureSample(noiseTex, noiseSampler, uv + vec2<f32>(0.5, 0.5)).r;
        
        // Blend based on z
        return mix(sample1, sample2, fract(pos.z * 0.1));
      }

      fn getLinearDepth(uv: vec2<f32>, depth: f32) -> f32 {
        let ndc = vec4<f32>(uv.x * 2.0 - 1.0, (1.0 - uv.y) * 2.0 - 1.0, depth, 1.0);
        let viewPos = camera.inverse_projection * ndc;
        return -(viewPos.z / viewPos.w);
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
        
        // Height-based density falloff (relative to world Y, adjust if needed)
        let heightFalloff = exp(-worldPos.y * 0.05);
        
        return uniforms.fogDensity * noise * heightFalloff;
      }

      fn isInsideAABB(pos: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> bool {
        return all(pos >= boxMin) && all(pos <= boxMax);
      }
      
      // Ray-AABB intersection
      fn rayAABBIntersect(origin: vec3<f32>, dir: vec3<f32>, boxMin: vec3<f32>, boxMax: vec3<f32>) -> vec2<f32> {
        let invDir = 1.0 / dir;
        let t1 = (boxMin - origin) * invDir;
        let t2 = (boxMax - origin) * invDir;
        let tMin = min(t1, t2);
        let tMax = max(t1, t2);
        let tNear = max(max(tMin.x, tMin.y), tMin.z);
        let tFar = min(min(tMax.x, tMax.y), tMax.z);
        return vec2<f32>(tNear, tFar);
      }
      
      // Raymarch through volume, confined to cube
      fn raymarchFog(rayOrigin: vec3<f32>, rayDir: vec3<f32>, sceneDepth: f32) -> vec4<f32> {
        // Compute ray-cube intersection
        let intersect = rayAABBIntersect(rayOrigin, rayDir, uniforms.cubeMin.xyz, uniforms.cubeMax.xyz);
        var tStart = max(intersect.x, 0.0);
        var tEnd = min(intersect.y, sceneDepth);
        
        if (tStart >= tEnd || tEnd < 0.0) {
          return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        
        // Clamp with fog start/end distances
        tStart = max(tStart, uniforms.fogStart);
        tEnd = min(tEnd, uniforms.fogEnd);
        
        if (tStart >= tEnd) {
          return vec4<f32>(0.0, 0.0, 0.0, 0.0);
        }
        
        let marchDist = tEnd - tStart;
        let stepSize = marchDist / uniforms.raymarchSteps;
        
        var transmittance = 1.0;
        var scatteredLight = vec3<f32>(0.0);
        
        let sunDir = normalize(uniforms.sunDirection.xyz);
        let cosTheta = dot(rayDir, sunDir);
        
        // Phase functions
        let miePhaseValue = miePhase(cosTheta, uniforms.mieScattering);
        let rayleighPhaseValue = rayleighPhase(cosTheta);
        
        for (var i = 0.0; i < uniforms.raymarchSteps; i += 1.0) {
          let t = tStart + i * stepSize;
          let samplePos = rayOrigin + rayDir * t;
          
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
            scatteredLight += uniforms.fogColor.xyz * scattering * transmittance * stepSize;
            
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
        let rayOrigin = uniforms.cameraPos;
        let rayDir = normalize(viewRay);
        
        let depth = textureSample(depthTex, noiseSampler, uv);
        let sceneDepth = getLinearDepth(uv, depth);
        
        let fog = raymarchFog(rayOrigin.xyz, rayDir, sceneDepth);

        return fog;
      }
    `;
    
    this.fogPipelineId = Entropy.Pipeline.create({
      name: "volumetric_fog",
      vertexShader,
      fragmentShader,
      form: "composite",
      extraBindGroups: [{
        entries: [
          { binding: 0, visibility: ["Fragment"], resourceType: "Storage" },
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

    // sets it up as `composite_pass.draw(0..3, 0..1);`
    const size = this.config.cubeSize[0];
    const halfSize = size / 2;
    const params = new Float32Array([
      ...this.config.fogColor, 0.0,
       ...[1.0, -0.2, 0.5, 0.0],
       ...[0.0,0.0,0.0, 0.0],
        -halfSize, -halfSize, -halfSize, 0.0,  // cubeMin (vec3)
        halfSize, halfSize, halfSize, 0.0,     // cubeMax (vec3)

        this.config.fogDensity,
        this.config.fogStart,
        this.config.fogEnd,
        this.config.sunScatterStrength,
        this.config.mieScattering,
        this.config.rayleighScattering,
        this.config.raymarchSteps,
       0.0, // time
    ]);

    const bufferSize = params.length * 4; // 8 floats * 4 bytes
    
    this.storageBufferId = this.api.Buffer.create({
      size: bufferSize,
      usage: "Storage"
    });

    this.api.Buffer.write(this.storageBufferId, params);

    Entropy.Composite.register(
      "volumetric_fog", 
      this.noiseTextureId!, 
      this.fogPipelineId,
      [
          { group: 2, binding: 0, resource: { type: "Storage", value: { id: this.storageBufferId } } },
      ]
    );
  }
  
  createDustSystem() {
    // Initialize dust particles
    this.initializeDustParticles();
    
    // Create dust rendering pipeline with billboarding
    const vertexShader = `
    struct CameraUniform {
          view_proj: mat4x4<f32>,
          view_pos: vec4<f32>,
          window_size: vec4<f32>,
          inverse_view: mat4x4<f32>,
          inverse_projection: mat4x4<f32>,
      };
      @group(0) @binding(0)
      var<uniform> camera: CameraUniform;

      struct ParticleData {
        position: vec3<f32>,   // xyz
        brightness: f32,

        velocity: vec3<f32>,   // xyz
        dustSize: f32,       // alignment (or phase, size, etc.)
      }
      
      @group(2) @binding(0) var<storage, read> particles: array<ParticleData>;
      
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

        let cameraRight = normalize(camera.inverse_view[0].xyz);
        let cameraUp    = normalize(camera.inverse_view[1].xyz);
        
        // Billboard - face camera
        let worldPos = particle.position + 
          cameraRight * corner.x * particle.dustSize +
          cameraUp * corner.y * particle.dustSize;
        
        // NOTE: Would benefit from proper view/projection matrix uniforms
        output.position = vec4<f32>(worldPos, 1.0);
        output.brightness = particle.brightness;
        
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
        let center = vec2<f32>(0.5);
        let dist = length(uv - center) * 2.0;
        
        // Soft falloff
        let alpha = smoothstep(1.0, 0.2, dist);
        
        // Subtle color variation
        let color = vec3<f32>(1.0, 0.98, 0.95);

        let dustBrightness = 0.7;
        
        return vec4<f32>(color * brightness * dustBrightness, alpha);
      }
    `;
    
    // NOTE: This is a placeholder - would need proper instanced rendering support
    this.dustPipelineId = Entropy.Pipeline.create({
      name: "dust_particles",
      vertexShader,
      fragmentShader,
      form: "composite",
      extraBindGroups: [{
        entries: [
          { binding: 0, visibility: ["Vertex"], resourceType: "StorageReadOnly" },
        ]
      }]
    });

    Entropy.Composite.register(
      "dust_particles", 
      this.noiseTextureId!, 
      this.dustPipelineId,
      [
          { group: 2, binding: 0, resource: { type: "Storage", value: { id: this.particleBufferId } } },
      ]
    );
  }
  
  initializeDustParticles() {
    const count = this.config.particleCount;
    
    const halfSize = [
      this.config.cubeSize[0] / 2,
      this.config.cubeSize[1] / 2,
      this.config.cubeSize[2] / 2,
    ];
    const min = [
      this.config.cubePosition[0] - halfSize[0],
      this.config.cubePosition[1] - halfSize[1],
      this.config.cubePosition[2] - halfSize[2],
    ];
    const max = [
      this.config.cubePosition[0] + halfSize[0],
      this.config.cubePosition[1] + halfSize[1],
      this.config.cubePosition[2] + halfSize[2],
    ];
    
    this.dustParticles = [];
    
    for (let i = 0; i < count; i++) {
      this.dustParticles.push({
        position: [
          min[0] + Math.random() * (max[0] - min[0]),
          min[1] + Math.random() * (max[1] - min[1]),
          min[2] + Math.random() * (max[2] - min[2]),
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

    const particleSize = 8 * 4; // 8 floats * 4 bytes
    const bufferSize = this.config.particleCount * particleSize;
    
    this.particleBufferId = this.api.Buffer.create({
      size: bufferSize,
      usage: "Storage"
    });

    this.particleStride = 8;
    this.particleData = new Float32Array(
      this.dustParticles.length * this.particleStride
    );
  }
  
  update(time: number, cameraPos: [number, number, number]) {
    this.time = time;

    const size = this.config.cubeSize[0];
    const halfSize = size / 2;
    const params = new Float32Array([
      ...this.config.fogColor, 0.0,
       ...[1.0, -0.2, 0.5, 0.0],
       ...[0.0,0.0,0.0, 0.0],
        -halfSize, -halfSize, -halfSize, 0.0,  // cubeMin (vec3)
        halfSize, halfSize, halfSize, 0.0,     // cubeMax (vec3)

        this.config.fogDensity,
        this.config.fogStart,
        this.config.fogEnd,
        this.config.sunScatterStrength,
        this.config.mieScattering,
        this.config.rayleighScattering,
        this.config.raymarchSteps,
       time,
    ]);

    this.api.Buffer.write(this.storageBufferId, params);
    
    // Update dust particles
    if (this.config.dustEnabled && this.particleData && this.dustParticles.length > 0) {
      const dt = 0.016; // ~60fps
      
      const halfSize = [
        this.config.cubeSize[0] / 2,
        this.config.cubeSize[1] / 2,
        this.config.cubeSize[2] / 2,
      ];
      const min = [
        this.config.cubePosition[0] - halfSize[0],
        this.config.cubePosition[1] - halfSize[1],
        this.config.cubePosition[2] - halfSize[2],
      ];
      const max = [
        this.config.cubePosition[0] + halfSize[0],
        this.config.cubePosition[1] + halfSize[1],
        this.config.cubePosition[2] + halfSize[2],
      ];
      
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
        
        // Wrap particles within cube
        if (p.position[0] < min[0]) p.position[0] = max[0];
        if (p.position[0] > max[0]) p.position[0] = min[0];
        if (p.position[1] < min[1]) p.position[1] = max[1];
        if (p.position[1] > max[1]) p.position[1] = min[1];
        if (p.position[2] < min[2]) p.position[2] = max[2];
        if (p.position[2] > max[2]) p.position[2] = min[2];
        
        // Flicker brightness
        p.brightness = 0.5 + 0.5 * Math.sin(time * 2 + p.phase);
      }

      let offset = 0;

      for (let i = 0; i < this.dustParticles.length; i++) {
        const p = this.dustParticles[i];

        // position
        this.particleData[offset++] = p.position[0];
        this.particleData[offset++] = p.position[1];
        this.particleData[offset++] = p.position[2];
        this.particleData[offset++] = p.brightness;

        // velocity
        this.particleData[offset++] = p.velocity[0];
        this.particleData[offset++] = p.velocity[1];
        this.particleData[offset++] = p.velocity[2];
        this.particleData[offset++] = this.config.dustSize; // or 0.0
      }

      this.api.Buffer.write(
        this.particleBufferId,
        this.particleData
      )
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
    
    Entropy.UI.Widget.label(this.tabId, { text: "🌫️ Volumetric FX Settings", bold: true });

    Entropy.UI.Widget.button(this.tabId, {
        text: "💾 Save All to Project",
        onClick: () => {
            this.api.IO.save({
                config: this.config,
                savedComponents: this.savedComponents,
                activeComponentId: this.activeComponentId
            });
            if (Entropy.Composer) {
                this.savedComponents.forEach(comp => {
                    Entropy.Composer!.registerComponent("VolumetricFX", comp.id, comp.name, comp.config);
                });
            }
        }
    });

    Entropy.UI.Widget.label(this.tabId, { text: "📦 Components", bold: true });
    Entropy.UI.Widget.button(this.tabId, {
        text: "➕ Save Current as Component",
        onClick: () => {
            const id = Entropy.generateUUID();
            const name = "New Atmosphere";
            this.savedComponents.push({ id, name, config: JSON.parse(JSON.stringify(this.config)) });
            if (Entropy.Composer) {
                Entropy.Composer!.registerComponent("VolumetricFX", id, name, this.config);
            }
        }
    });

    this.savedComponents.forEach(comp => {
        Entropy.UI.Widget.button(this.tabId!, {
            text: `📂 Load: ${comp.name}`,
            onClick: () => {
                this.config = JSON.parse(JSON.stringify(comp.config));
                this.activeComponentId = comp.id;
                this.saveConfig();
            }
        });
    });

    Entropy.UI.Widget.label(this.tabId, { text: "--------------------------------" });
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
    Entropy.UI.Widget.label(this.tabId, { text: "CUBE SETTINGS", bold: true });
    
    // Cube Position
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Cube Pos X",
      value: this.config.cubePosition[0],
      min: -200,
      max: 200,
      onChange: (val) => {
        this.config.cubePosition[0] = parseFloat(val);
        this.initializeDustParticles(); // Re-init particles if changed
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Cube Pos Y",
      value: this.config.cubePosition[1],
      min: -200,
      max: 200,
      onChange: (val) => {
        this.config.cubePosition[1] = parseFloat(val);
        this.initializeDustParticles();
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Cube Pos Z",
      value: this.config.cubePosition[2],
      min: -200,
      max: 200,
      onChange: (val) => {
        this.config.cubePosition[2] = parseFloat(val);
        this.initializeDustParticles();
        this.saveConfig();
      }
    });
    
    // Cube Size
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Cube Size X",
      value: this.config.cubeSize[0],
      min: 10,
      max: 500,
      onChange: (val) => {
        this.config.cubeSize[0] = parseFloat(val);
        this.initializeDustParticles();
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Cube Size Y",
      value: this.config.cubeSize[1],
      min: 10,
      max: 500,
      onChange: (val) => {
        this.config.cubeSize[1] = parseFloat(val);
        this.initializeDustParticles();
        this.saveConfig();
      }
    });
    
    Entropy.UI.Widget.slider(this.tabId, {
      label: "Cube Size Z",
      value: this.config.cubeSize[2],
      min: 10,
      max: 500,
      onChange: (val) => {
        this.config.cubeSize[2] = parseFloat(val);
        this.initializeDustParticles();
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
    // NOTE: should not autosave, only update buffers
    // this.api.IO.save(this.config);
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

// --- Tools Registration ---

api.registerTool({
    name: "update_volumetric_fog",
    description: "Update the volumetric fog parameters.",
    parameters: {
        type: "object",
        properties: {
            density: { type: "number", description: "Fog thickness (0 to 0.05)." },
            color: { type: "array", items: { type: "number" }, description: "RGB color of the fog." },
            start: { type: "number", description: "Fog start distance." },
            end: { type: "number", description: "Fog end distance." }
        }
    }
}, (args: any) => {
    Entropy.println("Updating Volumetric Fog via tool: " + JSON.stringify(args));
    let changed = false;
    const config = fx.config;

    if (typeof args.density !== "undefined") { config.fogDensity = args.density; changed = true; }
    if (args.color) { config.fogColor = [args.color[0], args.color[1], args.color[2]]; changed = true; }
    if (typeof args.start !== "undefined") { config.fogStart = args.start; changed = true; }
    if (typeof args.end !== "undefined") { config.fogEnd = args.end; changed = true; }

    if (changed) {
        fx.saveConfig();
        // Sync active component if exists
        if (fx.activeComponentId) {
            const comp = fx.savedComponents.find(c => c.id === fx.activeComponentId);
            if (comp) {
                comp.config = JSON.parse(JSON.stringify(config));
                if (Entropy.Composer) Entropy.Composer.registerComponent("VolumetricFX", comp.id, comp.name, comp.config);
            }
        }
        return { success: true, config };
    }
    return { success: false, error: "No parameters provided." };
});

api.registerTool({
    name: "update_volumetric_dust",
    description: "Update the volumetric dust particle parameters.",
    parameters: {
        type: "object",
        properties: {
            density: { type: "number", description: "Number of dust particles (0 to 5000)." },
            size: { type: "number", description: "Size of individual dust motes." },
            brightness: { type: "number", description: "Brightness of particles." },
            speed: { type: "number", description: "Movement speed of dust." }
        }
    }
}, (args: any) => {
    Entropy.println("Updating Volumetric Dust via tool: " + JSON.stringify(args));
    let changed = false;
    const config = fx.config;

    if (typeof args.density !== "undefined") { config.dustDensity = args.density; changed = true; }
    if (typeof args.size !== "undefined") { config.dustSize = args.size; changed = true; }
    if (typeof args.brightness !== "undefined") { config.dustBrightness = args.brightness; changed = true; }
    if (typeof args.speed !== "undefined") { config.dustSpeed = args.speed; changed = true; }

    if (changed) {
        fx.saveConfig();
        // Sync active component if exists
        if (fx.activeComponentId) {
            const comp = fx.savedComponents.find(c => c.id === fx.activeComponentId);
            if (comp) {
                comp.config = JSON.parse(JSON.stringify(config));
                if (Entropy.Composer) Entropy.Composer.registerComponent("VolumetricFX", comp.id, comp.name, comp.config);
            }
        }
        return { success: true, config };
    }
    return { success: false, error: "No parameters provided." };
});

api.registerTool({
    name: "save_volumetric_component",
    description: "Save current atmospheric volumetric settings as a reusable component for the Game Composer.",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "Name for this atmosphere (e.g., 'Spooky Mist')." }
        },
        required: ["name"]
    }
}, (args: any) => {
    const id = Entropy.generateUUID();
    const config = JSON.parse(JSON.stringify(fx.config));
    
    fx.savedComponents.push({ id, name: args.name, config });
    fx.activeComponentId = id;
    
    if (Entropy.Composer) {
        Entropy.Composer.registerComponent("VolumetricFX", id, args.name, config);
    }
    
    return { success: true, id, name: args.name, addonName: "VolumetricFX" };
});