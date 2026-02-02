// Type definitions for Entropy API

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

export interface CubeParameters {
  position?: Position;
  scale?: Scale;
}

export interface ProceduralModelConfig {
  type: "cube";
  parameters?: CubeParameters;
  pipelineId?: string | null;
}

export interface LandscapeConfig {
  width: number;
  height: number;
  heights?: number[] | null;
  noiseId?: string | null;
  position?: Position;
  pipelineId?: string | null;
}

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

export interface ScopedAPI {
  Model: {
    createProcedural: (config: ProceduralModelConfig) => void;
    createMesh: (config: any) => void;
  };
  Landscape: {
    create: (config: LandscapeConfig) => void;
  };
  Noise: {
    create: (config: NoiseConfig) => string;
  };
  Audio: {
    playSynth: (config: SynthConfig) => void;
    playTestTone: () => void;
  };
  onInit: (callback: InitCallback) => void;
  Particles: {
    createHair: (config: any) => void;
  };
  UI: {
    createTab: (config: TabConfig) => string;
  };
  Lighting: {
    createPointLight: (config: PointLightConfig) => void;
    updateSun: (config: ProceduralSkyConfig) => void;
  };
}

export type InitCallback = () => void | void;
export type CleanupCallback = () => void | void;

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

export interface PipelineConfig {
  [key: string]: unknown;
}

// Main Entropy API
export interface EntropyAPI {
  Addon: {
    register: (metadata: AddonMetadata) => ScopedAPI;
    onCleanup: (callback: CleanupCallback) => void;
  };
  UI: {
    createWindow: (config: WindowConfig) => string;
    createTab: (config: TabConfig) => string;
    Widget: {
      label: (windowId: string, config: LabelConfig) => void;
      button: (windowId: string, config: ButtonConfig) => void;
      colorInput: (windowId: string, config: any) => void;
      slider: (windowId: string, config: any) => void;
      numericInput: (windowId: string, config: any) => void;
    };
  };
  Pipeline: {
    create: (config: PipelineConfig) => string;
  };
  Landscape: {
    create: (config: LandscapeConfig) => string;
  };
  Noise: {
    create: (config: NoiseConfig) => string;
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