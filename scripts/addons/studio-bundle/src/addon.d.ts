// Type definitions for Entropy API

declare global {
  var lastPBRDesignerTextures: {
    [key: string]: {
    diffId: string;
    norId: string;
    armId: string;
    params: any;
  }} | undefined;
  
  var onPBRDesignerUpdate: (() => void) | undefined;
}

export interface Vec3 {
  0: number;
  1: number;
  2: number;
  length: 3;
}

export type Position = Vec3 | [number, number, number];
export type Scale = Vec3 | [number, number, number];

// Addon Types
export interface AddonMetadata {
  name: string;
  version?: string;
  description?: string;
  [key: string]: unknown;
}

export type BindingResource = 
  | { type: "Uniform"; value: { data: number[] } }
  | { type: "Texture"; value: {id: string} }
  | { type: "TextureNonFilterable"; value: {id: string} }
  | { type: "Sampler" }
  | { type: "Time" }
  | { type: "Buffer"; value: {id: string} }
  | { type: "Storage"; value: {id: string} }
  | { type: "StorageTexture"; value: {id: string} }
  | { type: "StorageTextureRgba16"; value: {id: string} };

export interface BindingConfig {
  group: number;
  binding: number;
  resource: BindingResource;
}

export interface CubeParameters {
  position?: Position;
  scale?: Scale;
}

export interface ProceduralModelConfig {
  type: "cube";
  parameters?: CubeParameters;
  pipelineId?: string | null;
  renderRole?: string | null;
}

export interface LandscapeConfig {
  id?: string | null;
  width: number;
  height: number;
  heights?: number[] | null;
  noiseId?: string | null;
  position?: Position;
  pipelineId?: string | null;
  renderRole?: string | null;
}

export type LandscapeTextureKind = 
  | "Primary" 
  | "PrimaryMask" 
  | "Rockmap" 
  | "RockmapMask" 
  | "Soil" 
  | "SoilMask";

export type PBRTextureKind = 
  | "Normal" 
  | "AORoughnessMetallic";

export type PBRMaterialType = 
  | "Primary" 
  | "Rockmap" 
  | "Soil";

export type NoiseType = "fbm" | string;
export type NoiseSource = "perlin" | string;

export interface NoiseConfig {
  type?: NoiseType;
  source?: NoiseSource;
  seed?: number;
  octaves?: number;
  frequency?: number;
  persistence?: number;
  lacunarity?: number;
}

export interface PointLightConfig {
  position?: Position;
  color?: [number, number, number];
  intensity?: number;
  maxDistance?: number;
}

export interface ProceduralSkyConfig {
  horizonColor?: [number, number, number];
  zenithColor?: [number, number, number];
  sunDirection?: [number, number, number];
  sunColor?: [number, number, number];
  sunIntensity?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
}

export interface ScopedAPI {
  onInit: (callback: InitCallback) => void;
  onAllAddonsInitialized: (callback: InitCallback) => void;
  onUpdate: (callback: UpdateCallback) => void;
  onUpdatePlus: (addonName: string, callback: UpdateCallback) => void;
  onCleanup: (callback: CleanupCallback) => void;
  onProjectChanged: (callback: ProjectChangedCallback) => void;
  setVisibility: (visible: boolean) => void;
  registerTool: (definition: ToolDefinition, callback: any) => void;
  Model: {
      load: (config: {
          path: string;
          id?: string;
          position?: number[];
          rotation?: number[];
          scale?: number[];
          pipelineId?: string;
          renderRole?: string;
      }) => void;
      createProcedural: (config: { type: string; parameters?: any; pipelineId?: string; renderRole?: string }) => void;
      createMesh: (config: { 
          id?: string | null;
          position: number[];
          rotation?: number[];
          scale?: number[];
          vertexData: number[]; 
          indexData: number[]; 
          pipelineId: string; 
          renderRole?: string;
          instanceCount?: number;
          bindings?: BindingConfig[] 
      }) => void;
      clearMeshes: () => void;
      clearMesh: (meshId: string) => void;
  };
  Landscape: {
    create: (config: LandscapeConfig) => void;
    updateTexture: (textureId: string, kind: LandscapeTextureKind) => void;
    updatePbrTexture: (textureId: string, kind: PBRTextureKind, materialType: PBRMaterialType) => void;
    updateTexturePlus: (addonName:string, textureId: string, kind: LandscapeTextureKind) => void;
    updatePbrTexturePlus: (addonName: string, textureId: string, kind: PBRTextureKind, materialType: PBRMaterialType) => void;
  };
  Noise: {
    create: (config: NoiseConfig) => string;
  };
  Texture: {
    create: (width: number, height: number, data: Uint8Array | number[]) => string;
    createStorage: (width: number, height: number, format?: string) => string;
    createEx: (config: TextureConfig, data?: Uint8Array | number[] | null) => string;
    load: (filename: string) => string;
  };
  Audio: {
    playSynth: (config: SynthConfig) => void;
    playTestTone: () => void;
  };
  Particles: {
    createHair: (config: {
      id?: string | null;
      gridSize?: number;
      renderDistance?: number;
      windStrength?: number;
      windSpeed?: number;
      bladeHeight?: number;
      bladeWidth?: number;
      brownianStrength?: number;
      bladeDensity?: number;
      landscapeSize?: number;
      landscapeHeight?: number;
      landscapeYOffset?: number;
      baseColor?: [number, number, number, number];
      tipColor?: [number, number, number, number];
      pipelineId?: string | null;
      renderRole?: string | null;
      bindings?: BindingConfig[];
    }) => void;
  };
  UI: {
    createTab: (config: TabConfig) => string;
  };
  Lighting: {
    createPointLight: (config: PointLightConfig) => void;
    updateSun: (config: ProceduralSkyConfig) => void;
  };
  IO: {
    save: (data: any) => void;
    saveImage: (filename: string, width: number, height: number, data: number[] | Uint8Array) => void;
    listModels: () => Promise<string[]>;
    pickAndImportModel: () => Promise<string>;
    load: () => any;
  };
  Buffer: {
    create: (config: { size: number; usage?: BufferUsage }) => string;
    write: (bufferId: string, data: Uint8Array | Float32Array | Int32Array | number[], offset?: number) => void;
  };
  Compute: {
    createPipeline: (config: ComputePipelineConfig) => string;
    dispatch: (config: ComputeDispatchConfig) => void;
  };
}

export type BufferUsage = "Uniform" | "Storage" | "Vertex" | "Index";

export interface TextureConfig {
  width: number;
  height: number;
  format: string;
  usage: string[];
}

export interface ComputePipelineConfig {
  name?: string;
  shaderSource: string;
  bindGroups?: {
    entries: BindingEntry[];
  }[];
}

export interface ComputeDispatchConfig {
  pipelineId: string;
  groups?: [number, number, number];
  bindings?: BindingConfig[];
}

export type InitCallback = () => void | void;
export type UpdateCallback = (time: number, pos: [number, number, number], dir: [number, number, number]) => void | void;
export type CleanupCallback = () => void | void;
export type ProjectChangedCallback = (newProjectId: string) => void | void;

// UI Types
export interface WindowConfig {
  title?: string;
  width?: number;
  height?: number;
  onRender?: () => void;
  [key: string]: unknown;
}

export interface TabConfig {
  title?: string;
  onRender?: () => void;
  [key: string]: unknown;
}

export interface LabelConfig {
  text: string;
  bold?: boolean;
}

export interface ColorInputConfig {
    label: string;
    color: number[];
    onChange?: (color: number[]) => void;
}

export interface SliderConfig {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange?: (value: string) => void;
}

export interface NumericInputConfig {
    label: string;
    value: number;
    onChange?: (value: string) => void;
}

export interface SynthConfig {
  freq: number;
  waveform?: "sine" | "square" | "saw" | "noise";
  duration?: number;
  cutoff?: number;
  gain?: number;
}

export interface ButtonConfig {
  text: string;
  onClick?: () => void;
}

export interface BindingEntry {
  binding: number;
  visibility: ("Compute" | "Vertex" | "Fragment")[];
  resourceType: "Uniform" | "Time" | "Texture" | "TextureNonFilterable" | "Sampler" | "Storage" | "StorageReadOnly" | "StorageTexture" | "StorageTextureRgba16" | "DepthTexture";
}

export interface PipelineConfig {
  name: string;
  pbr?: boolean;
  vertexShader?: string;
  fragmentShader?: string;
  layout?: "hair" | "mesh";
  lightingShader?: string;
  extraBindGroups?: {
    entries: BindingEntry[]
  }[];
  lightingBindings?: any[];
  form?: "composite" | "default";
  // [key: string]: unknown;
}

export interface DropdownConfig {
    label: string;
    options: string[];
    selectedIndex: number;
    onChange?: (index: string) => void;
}

// Main Entropy API
export interface EntropyAPI {
  Addon: {
    register: (metadata: AddonMetadata) => ScopedAPI;
    onCleanup: (callback: CleanupCallback) => void;
    setVisibility: (addonName: string, visible: boolean) => void;
  };
  UI: {
    createWindow: (config: WindowConfig) => string;
    createTab: (config: TabConfig) => string;
    Widget: {
      label: (windowId: string, config: LabelConfig) => void;
      button: (windowId: string, config: ButtonConfig) => void;
      colorInput: (windowId: string, config: ColorInputConfig) => void;
      slider: (windowId: string, config: SliderConfig) => void;
      numericInput: (windowId: string, config: NumericInputConfig) => void;
      dropdown: (windowId: string, config: DropdownConfig) => void;
    };
  };
  Composer?: {
      registerEditor: (addonName: string, renderFn: (windowId: string) => void) => void;
      getEditor: (addonName: string) => ((windowId: string) => void) | undefined;
      registerRenderer: (addonName: string, renderFn: (id: string, params: any) => void) => void;
      getRenderer: (addonName: string) => ((id: string, params: any) => void) | undefined;
      registerComponent: (addonName: string, componentId: string, name: string, params: any) => void;
      getComponents: (addonName: string) => Record<string, { name: string, params: any }>;
      setRolePipeline: (role: string, pipelineId: string) => void;
      initCallbacks: {
        [key: string]: () => void
      }
  };
  Composite: {
    register: (nameId: string, outputTexId: string, compositePipelineId: string, bindings?: BindingConfig[]) => void;
  },
  Pipeline: {
    create: (config: PipelineConfig) => string;
    createCompute: (config: ComputePipelineConfig) => string;
  };
  Compute: {
    dispatch: (config: ComputeDispatchConfig) => void;
  };
  Buffer: {
    create: (config: { size: number; usage?: BufferUsage }) => string;
    write: (bufferId: string, data: Uint8Array | Float32Array | Int32Array | number[], offset?: number) => void;
  };
  Landscape: {
    create: (config: LandscapeConfig) => string;
  };
  Noise: {
    create: (config: NoiseConfig) => string;
  };
  Texture: {
    create: (width: number, height: number, data: Uint8Array | number[]) => string;
    createStorage: (width: number, height: number, format?: string) => string;
    createEx: (config: TextureConfig, data?: Uint8Array | number[] | null) => string;
    load: (filename: string) => string;
  };
  Particles: {
    createHair: (config: {
      id?: string | null;
      gridSize?: number;
      renderDistance?: number;
      windStrength?: number;
      windSpeed?: number;
      bladeHeight?: number;
      bladeWidth?: number;
      brownianStrength?: number;
      bladeDensity?: number;
      landscapeSize?: number;
      landscapeHeight?: number;
      landscapeYOffset?: number;
      baseColor?: [number, number, number, number];
      tipColor?: [number, number, number, number];
      pipelineId?: string | null;
      renderRole?: string | null;
      bindings?: BindingConfig[];
    }) => string;
  };
  Lighting: {
    createPointLight: (config: any) => void;
    updateSun: (config: ProceduralSkyConfig) => void;
  };
  Audio: {
    playSynth: (config: SynthConfig) => void;
    playTestTone: () => void;
  };
  println: (msg: unknown) => void;
  generateUUID: () => string;
  _process_events: (eventIds: string[]) => void;
}

// Global declarations
declare global {
  const Entropy: EntropyAPI;
  const println: (msg: unknown) => void;
  
  interface Window {
    Entropy: EntropyAPI;
    println: (msg: unknown) => void;
    _entropy_event_listeners?: Record<string, () => void>;
  }

  var _entropy_event_listeners: Record<string, () => void> | undefined;
}

export {};
