// *** Proposed Addon Class System ***
// Is it reasonable? Is it forward-looking? Does it simplify the DX of addons?

import type { AddonMetadata, Position, ScopedAPI } from "./addon";

// Global addon registry (managed by engine)
class AddonRegistry {
  private addons: Map<string, EntropyAddon> = new Map();
  private tools: Map<string, ToolRegistration> = new Map();
  private components: Map<string, ComponentRegistration> = new Map();
  
  register(addon: EntropyAddon) {
    this.addons.set(addon.name, addon);
    return addon;
  }
  
  getAddon(name: string): EntropyAddon | undefined {
    return this.addons.get(name);
  }
  
  getAllAddons(): EntropyAddon[] {
    return Array.from(this.addons.values());
  }
  
  registerTool(addonName: string, tool: ToolRegistration) {
    const key = `${addonName}.${tool.name}`;
    this.tools.set(key, tool);
  }
  
  getTool(addonName: string, toolName: string): ToolRegistration | undefined {
    return this.tools.get(`${addonName}.${toolName}`);
  }
  
  getAllTools(): Map<string, ToolRegistration> {
    return this.tools;
  }
  
  registerComponent(addonName: string, component: ComponentRegistration) {
    const key = `${addonName}.${component.id}`;
    this.components.set(key, component);
  }
  
  getComponent(addonName: string, componentId: string): ComponentRegistration | undefined {
    return this.components.get(`${addonName}.${componentId}`);
  }
}

// Global singleton
const AddonContext = new AddonRegistry();

// Make it globally accessible
(globalThis as any).__ENTROPY_ADDONS__ = AddonContext;

interface ToolRegistration {
  name: string;
  description: string;
  parameters: any;
  handler: (params: any) => any;
}

interface ComponentRegistration {
  id: string;
  name: string;
  defaultParams: any;
  renderer?: (id: string, params: any) => void;
  editor?: (windowId: string) => void;
  textureGenerator?: (id: string, params: any, res: number) => any;
}

// Builder for tool registration
class ToolBuilder {
  private tool: Partial<ToolRegistration> = {};
  
  constructor(private addonName: string, name: string) {
    this.tool.name = name;
  }
  
  description(desc: string): this {
    this.tool.description = desc;
    return this;
  }
  
  parameters(schema: any): this {
    this.tool.parameters = schema;
    return this;
  }
  
  handler(fn: (params: any) => any): this {
    this.tool.handler = fn;
    return this;
  }
  
  register(): void {
    if (!this.tool.name || !this.tool.handler) {
      throw new Error("Tool must have name and handler");
    }
    
    AddonContext.registerTool(this.addonName, this.tool as ToolRegistration);
  }
}

// Builder for component registration
class ComponentBuilder {
  private component: Partial<ComponentRegistration> = {};
  
  constructor(private addonName: string, id: string) {
    this.component.id = id;
  }
  
  name(displayName: string): this {
    this.component.name = displayName;
    return this;
  }
  
  defaultParams(params: any): this {
    this.component.defaultParams = params;
    return this;
  }
  
  renderer(fn: (id: string, params: any) => void): this {
    this.component.renderer = fn;
    return this;
  }
  
  editor(fn: (windowId: string) => void): this {
    this.component.editor = fn;
    return this;
  }
  
  textureGenerator(fn: (id: string, params: any, res: number) => any): this {
    this.component.textureGenerator = fn;
    return this;
  }
  
  register(): void {
    if (!this.component.id || !this.component.name) {
      throw new Error("Component must have id and name");
    }
    
    AddonContext.registerComponent(this.addonName, this.component as ComponentRegistration);
  }
}

// Base addon class with builder access
export abstract class EntropyAddon {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  
  protected api!: ScopedAPI;
  private _state: Map<string, any> = new Map();
  
  constructor(metadata: AddonMetadata) {
    this.name = metadata.name;
    this.version = metadata.version || "1.0.0";
    this.description = metadata.description || "";
  }
  
  // State management (per-addon)
  protected setState(key: string, value: any): void {
    this._state.set(key, value);
  }
  
  protected getState<T = any>(key: string): T | undefined {
    return this._state.get(key);
  }
  
  protected hasState(key: string): boolean {
    return this._state.has(key);
  }
  
  protected clearState(): void {
    this._state.clear();
  }
  
  // Builder pattern for tools
  protected tool(name: string): ToolBuilder {
    return new ToolBuilder(this.name, name);
  }
  
  // Builder pattern for components
  protected component(id: string): ComponentBuilder {
    return new ComponentBuilder(this.name, id);
  }
  
  // Access to other addons via context
  protected getAddon(name: string): EntropyAddon | undefined {
    return AddonContext.getAddon(name);
  }
  
  // Lifecycle hooks (optional, override as needed)
  protected onInit?(): void;
  protected onAllAddonsInitialized?(): void;
  protected onUpdate?(time: number, pos: Position, dir: Position): void;
  protected onCleanup?(): void;
  protected onProjectChanged?(projectId: string): void;
  protected onAllProjectsLoaded?(projectId: string): void;
  
  // Main registration method
  register() {
    // Register with global context
    AddonContext.register(this);
    
    // Register with Entropy engine
    this.api = Entropy.Addon.register({
      name: this.name,
      version: this.version,
      description: this.description
    });
    
    // Call setup method where addon registers tools/components
    this.setup();
    
    // Auto-register lifecycle hooks
    if (this.onInit) this.api.onInit(() => this.onInit!());
    if (this.onAllAddonsInitialized) {
      this.api.onAllAddonsInitialized(() => this.onAllAddonsInitialized!());
    }
    if (this.onUpdate) {
      this.api.onUpdate((t, p, d) => this.onUpdate!(t, p, d));
    }
    if (this.onCleanup) {
      this.api.onCleanup(() => {
        this.onCleanup!();
        this.clearState();
      });
    }
    if (this.onProjectChanged) {
      this.api.onProjectChanged((id) => this.onProjectChanged!(id));
    }
    if (this.onAllProjectsLoaded) {
      this.api.onAllProjectsLoaded((id) => this.onAllProjectsLoaded!(id));
    }
    
    // Wire up registered tools with Entropy
    this._registerTools();
    
    // Wire up registered components with Composer
    this._registerComponents();
    
    return this;
  }
  
  // Abstract method - addon must implement this to register tools/components
  protected abstract setup(): void;
  
  private _registerTools() {
    const tools = Array.from(AddonContext.getAllTools().entries())
      .filter(([key]) => key.startsWith(`${this.name}.`));
    
    tools.forEach(([_, tool]) => {
      this.api.registerTool(
        {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        },
        tool.handler
      );
    });
  }
  
  private _registerComponents() {
    // Register with Composer
    // ... (similar to tools)
  }
  
  // Convenience accessors
  get Model() { return this.api.Model; }
  get Landscape() { return this.api.Landscape; }
  get Noise() { return this.api.Noise; }
  get Texture() { return this.api.Texture; }
  get Audio() { return this.api.Audio; }
  get Particles() { return this.api.Particles; }
  get UI() { return this.api.UI; }
  get Lighting() { return this.api.Lighting; }
  get IO() { return this.api.IO; }
  get Scripts() { return this.api.Scripts; }
  get Buffer() { return this.api.Buffer; }
  get Compute() { return this.api.Compute; }
  get Collectable() { return this.api.Collectable; }
  get Quest() { return this.api.Quest; }
  get Inventory() { return this.api.Inventory; }
  get GameState() { return this.api.GameState; }
}

// *** Example Addon using this system ***

// class WaterAddon extends EntropyAddon {
//   constructor() {
//     super({
//       name: "water",
//       version: "2.0.0",
//       description: "FFT-based procedural water"
//     });
//   }
  
//   // Setup method - explicitly register everything
//   setup() {
//     // Register tools with builder pattern
//     this.tool("createWaterPlane")
//       .description("Creates an FFT-simulated water plane")
//       .parameters({
//         position: { type: "array", description: "XYZ position" },
//         size: { type: "number", description: "Size of the water plane" },
//         waveHeight: { type: "number", description: "Maximum wave height" }
//       })
//       .handler((params) => this.createWaterPlane(params))
//       .register();
    
//     this.tool("adjustWaves")
//       .description("Adjust water wave parameters")
//       .parameters({
//         height: { type: "number" },
//         frequency: { type: "number" },
//         speed: { type: "number" }
//       })
//       .handler((params) => this.adjustWaveParams(params))
//       .register();
    
//     // Register components with builder pattern
//     this.component("water_plane")
//       .name("Water Plane")
//       .defaultParams({
//         size: 100,
//         waveHeight: 1.0,
//         color: [0.1, 0.3, 0.5, 0.8],
//         flowSpeed: 0.5
//       })
//       .renderer((id, params) => this.renderWater(id, params))
//       .editor((windowId) => this.renderWaterEditor(windowId))
//       .textureGenerator((id, params, res) => this.generateWaterTextures(id, params, res))
//       .register();
//   }
  
//   // Lifecycle hook
//   onInit() {
//     println("Water addon initializing...");
    
//     // Store state
//     this.setState("wavePipeline", Entropy.Pipeline.create({
//       name: "fft_water",
//       vertexShader: `...`,
//       fragmentShader: `...`
//     }));
    
//     this.setState("activeWaterPlanes", []);
//   }
  
//   onUpdate(time, pos, dir) {
//     const planes = this.getState("activeWaterPlanes") || [];
//     // Update wave simulation for each plane
//     planes.forEach(plane => this.updateWaveFFT(plane, time));
//   }
  
//   onCleanup() {
//     println("Water addon cleaning up...");
//     // State automatically cleared by base class
//   }
  
//   // Tool implementations
//   private createWaterPlane(params) {
//     const { position = [0, 0, 0], size = 100, waveHeight = 1.0 } = params;
    
//     const pipelineId = this.getState("wavePipeline");
    
//     this.Model.createProcedural({
//       type: "plane",
//       parameters: { position, size },
//       pipelineId
//     });
    
//     // Track state
//     const planes = this.getState("activeWaterPlanes") || [];
//     planes.push({ position, size, waveHeight, id: Entropy.generateUUID() });
//     this.setState("activeWaterPlanes", planes);
    
//     return { success: true, message: "Water plane created" };
//   }
  
//   private adjustWaveParams(params) {
//     this.setState("waveParams", params);
//     return { success: true };
//   }
  
//   // Component implementations
//   private renderWater(id, params) {
//     const pipelineId = this.getState("wavePipeline");
    
//     this.Model.createProcedural({
//       type: "plane",
//       parameters: {
//         position: params.position,
//         size: params.size
//       },
//       pipelineId
//     });
//   }
  
//   private renderWaterEditor(windowId) {
//     const currentParams = this.getState("waveParams") || { height: 1.0, frequency: 1.0 };
    
//     Entropy.UI.Widget.slider(windowId, {
//       label: "Wave Height",
//       value: currentParams.height,
//       min: 0,
//       max: 5,
//       onChange: (val) => {
//         currentParams.height = parseFloat(val);
//         this.setState("waveParams", currentParams);
//       }
//     });
    
//     Entropy.UI.Widget.slider(windowId, {
//       label: "Wave Frequency",
//       value: currentParams.frequency,
//       min: 0.1,
//       max: 3.0,
//       onChange: (val) => {
//         currentParams.frequency = parseFloat(val);
//         this.setState("waveParams", currentParams);
//       }
//     });
//   }
  
//   private generateWaterTextures(id, params, resolution) {
//     // Generate procedural water textures
//     return {
//       diffId: "water_diff_" + id,
//       norId: "water_nor_" + id,
//       armId: "water_arm_" + id
//     };
//   }
  
//   // Can access other addons!
//   private createWaterWithLighting() {
//     const lightingAddon = this.getAddon("lighting");
//     if (lightingAddon) {
//       // Access lighting addon state/methods
//     }
//   }
// }

// // Register the addon
// new WaterAddon().register();