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
  
  var onManualRiverMaskUpdate: (() => void) | undefined;
  var manualRiverMaskId: string | undefined;
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
  author?: string[];
  capabilities?: {
    graphics?: boolean;
    ui?: boolean;
  }
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
  width: number; // this is actually resoluion (x)
  height: number; // actually resolution (z)
  heights?: number[] | null; // raw, unscaled heights (y)
  noiseId?: string | null;
  position?: Position;
  pipelineId?: string | null;
  renderRole?: string | null;
  size: number; // this is the real width and height (x/z)
  scale: number; // scale (y)
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

export interface VisualProvider {
    meshId?: string;
    pipelineId: string;
    // onAnimate?: (entityId: string, animName: string) => void;
    // onSpawn?: (entityId: string, position: [number, number, number]) => void;
    vertexData: number[]; 
    indexData: number[]; 
    bindings?: BindingConfig[] 
}

export interface PhysicsConfig {
  bodyType: "dynamic" | "fixed" | "kinematic";
  colliderShape: "trimesh" | "hull" | "cuboid" | "capsule" | "ball";
  mass?: number;
  friction?: number;
  restitution?: number;
}

export interface AttackStats {
  damage: number;
  range: number;
  cooldown: number;
  windUpTime: number;
  recoveryTime: number;
}

export interface ScopedAPI {
  onInit: (callback: InitCallback) => void;
  onAllAddonsInitialized: (callback: InitCallback) => void;
  onUpdate: (callback: UpdateCallback) => void;
  onUpdatePlus: (addonName: string, callback: UpdateCallback) => void;
  onCleanup: (callback: CleanupCallback) => void;
  onProjectChanged: (callback: ProjectChangedCallback) => void;
  onAllProjectsLoaded: (callback: ProjectChangedCallback) => void;
  getAddon: (name: string) => any;
  getVisual: (name: string) => string | undefined;
  getVisualProvider: (name: string) => VisualProvider | undefined;
  registerVisual: (name: string, provider: string | VisualProvider) => void;
  setVisibility: (visible: boolean) => void;
  registerTool: (definition: ToolDefinition, callback: any) => void;
  Model: {
      load: (config: {
          path: string;
          id?: string;
          visualType?: "customMesh" | "standard" | string;
          visualName?: string;
          modelId?: string;
          position?: number[];
          rotation?: number[];
          scale?: number[];
          pipelineId?: string;
          renderRole?: string;
          physics?: PhysicsConfig;
          player?: {
              modelId?: string;
              defaultWeaponId?: string;
          };
          isNpc?: boolean; // for those JS-side game logic scenarios
          npc?: { // for those Rust-side game logic scenarios
              modelId: string;
              behavior: {
                  aggressiveness: number;
                  combatType: "Melee" | "Ranged";
                  wanderRadius: number;
                  wanderSpeed: number;
                  detectionRadius: number;
                  meleeStats?: AttackStats;
                  rangedStats?: AttackStats;
              };
              squadId?: string;
          };
          behaviorId?: string;
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
          bindings?: BindingConfig[];
          behaviorId?: string;
          isNpc?: boolean;
          player?: {
              modelId?: string;
              defaultWeaponId?: string;
          };
      }) => void;
      clearMeshes: () => void;
      clearMesh: (meshId: string) => void;
      setBoneTransform: (config: {
          modelId: string;
          boneName: string;
          position?: [number, number, number];
          rotation?: [number, number, number, number]; // [x, y, z, w]
          scale?: [number, number, number];
      }) => void;
  };
  Visual: {
      load: (config: {
          id?: string;
          visualName: string;
          meshId: string;
          position?: number[];
          rotation?: number[];
          scale?: number[];
          pipelineId?: string;
          renderRole?: string;
          physics?: PhysicsConfig;
          player?: {
              modelId?: string;
              defaultWeaponId?: string;
          };
          isNpc?: boolean;
          npc?: {
              modelId: string;
              behavior: {
                  aggressiveness: number;
                  combatType: "Melee" | "Ranged";
                  wanderRadius: number;
                  wanderSpeed: number;
                  detectionRadius: number;
                  meleeStats?: AttackStats;
                  rangedStats?: AttackStats;
              };
              squadId?: string;
          };
          behaviorId?: string;
      }) => void;
  };
  Landscape: {
    create: (config: LandscapeConfig) => void;
    updateTexture: (textureId: string, kind: LandscapeTextureKind) => void;
    updatePbrTexture: (textureId: string, kind: PBRTextureKind, materialType: PBRMaterialType) => void;
    updateTexturePlus: (addonName:string, textureId: string, kind: LandscapeTextureKind) => void;
    updatePbrTexturePlus: (addonName: string, textureId: string, kind: PBRTextureKind, materialType: PBRMaterialType) => void;
    getHeightAt: (x: number, z: number) => number;
  };
  Landscape3D: {
    create: (config: {
      id?: string | null;
      vertices: number[];
      indices: number[];
      position?: [number, number, number];
      pipelineId?: string | null;
      renderRole?: string | null;
    }) => void;
  };
  Noise: {
    create: (config: NoiseConfig) => string;
  };
  Collectable: {
    create: (config: {
      position: [number, number, number];
      modelPath: string;
      type: "health" | "ammo" | "quest_item" | "currency";
      value?: number;
      questId?: string;
      onCollect?: (playerId: string) => void;
    }) => string;
    remove: (id: string) => void;
  };
  Quest: {
    create: (id: string, config: { title: string; objectives: string[] }) => void;
    updateObjective: (questId: string, index: number, completed: boolean) => void;
    getStatus: (questId: string) => any;
  };
  Inventory: {
    addItem: (playerId: string, itemId: string, quantity: number) => void;
    removeItem: (playerId: string, itemId: string, quantity: number) => void;
    hasItem: (playerId: string, itemId: string) => boolean;
  };
  GameState: {
    save: (key: string, data: any) => void;
    load: (key: string) => any;
  };
  Texture: {
    create: (width: number, height: number, data: Uint8Array | number[]) => string;
    createStorage: (width: number, height: number, format?: string) => string;
    createEx: (config: TextureConfig, data?: Uint8Array | number[] | null) => string;
    update: (textureId: string, data: Uint8Array | number[] | Float32Array) => void;
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
    drawRect: (config: UIRectConfig) => void;
    drawText: (config: UITextConfig) => void;
    clear: () => void;
    selectDialogueOption: (index: number) => void;
    Widget: {
      label: (windowId: string, config: LabelConfig) => void;
      button: (windowId: string, config: ButtonConfig) => void;
      colorInput: (windowId: string, config: ColorInputConfig) => void;
      slider: (windowId: string, config: SliderConfig) => void;
      numericInput: (windowId: string, config: NumericInputConfig) => void;
      dropdown: (windowId: string, config: DropdownConfig) => void;
      checkbox: (windowId: string, config: CheckboxConfig) => void;
      codeEditor: (windowId: string, config: CodeEditorConfig) => void;
      miniMap: (windowId: string, config: MiniMapConfig) => void;
      snarl: (windowId: string, config: SnarlConfig) => void;
      horizontal: (windowId: string, render: (windowId: string) => void) => void;
      separator: (windowId: string) => void;
    };
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
  Scripts: {
    list: () => Promise<string[]>;
    read: (filename: string) => Promise<string>;
    write: (filename: string, content: string) => Promise<void>;
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

export interface GlobalLandscapeSettings {
  size: number; // x/z
  height: number; // y
  yOffset: number; // y
}

export interface GlobalSettings {
  landscapeSettings: GlobalLandscapeSettings
}

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

export interface UIRectConfig {
  position?: [number, number];
  size?: [number, number];
  color?: [number, number, number, number];
  strokeThickness?: number;
  strokeColor?: [number, number, number, number];
  layer?: number;
}

export interface UITextConfig {
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  position?: [number, number];
  dimensions?: [number, number];
  color?: [number, number, number, number];
  backgroundFill?: [number, number, number, number];
  layer?: number;
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
  layout?: "hair" | "mesh" | "skinned";
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

export interface CheckboxConfig {
    label: string;
    value: boolean;
    onChange?: (value: boolean) => void;
}

export interface BehaviorPin {
    id: string;
    name: string;
    pinType: string;
}

export interface BehaviorNode {
    id: string;
    name: string;
    nodeType: string;
    position: [number, number];
    inputs: BehaviorPin[];
    outputs: BehaviorPin[];
    properties: any;
}

export interface BehaviorConnection {
    fromNode: string;
    fromPin: string;
    toNode: string;
    toPin: string;
}

export interface BehaviorGraph {
    nodes: BehaviorNode[];
    connections: BehaviorConnection[];
}

export interface SnarlConfig {
    id?: string;
    graph: BehaviorGraph;
    onConnect?: (params: string[]) => void;
    onDisconnect?: (params: string[]) => void;
    onNodeMoved?: (nodeId: string, position: [number, number]) => void;
}

export interface MiniMapMarker {
    position: [number, number]; // [x, y] in 0-1 range
    color?: [number, number, number, number];
    label?: string;
}

export interface MiniMapPolyline {
    points: [number, number][]; // Array of [x, y] coordinates in 0-1 range
    color?: [number, number, number, number];
    width?: number;
}

export interface MiniMapConfig {
    id?: string;
    landscapeId?: string;
    brushSize?: number;
    markers?: MiniMapMarker[];
    polylines?: MiniMapPolyline[];
    onDraw?: (x: number, y: number, brushSize: number) => void;
    onHover?: (x: number, y: number, brushSize: number) => void;
    onClick?: (x: number, y: number, brushSize: number) => void;
}

export interface CodeEditorConfig {
    label: string;
    content: string;
    language: string;
    onChange?: (content: string) => void;
}

export interface GizmoConfig {
  position: [number, number, number];
  mode: "translate" | "rotate" | "scale";
  space?: "world" | "local";
  onTransform?: (delta: [number, number, number]) => void;
  onComplete?: () => void;
}

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
}

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  vertexStride: number;
}

// Main Entropy API
export interface Entity {
  id: string;
  name: string;
  position: [number, number, number];
  health: number;
  stamina: number;
  isDead: boolean;
}

export interface BehaviorSystem {
  spawn_particles: (pos: [number, number, number], color: [number, number, number, number], gravity: [number, number, number]) => void;
  vec3: (x: number, y: number, z: number) => { x: number, y: number, z: number };
}

export interface DialogueSystem {
  show: (text: string) => void;
  add_option: (text: string, next_node: string) => void;
  start_quest: (id: string) => void;
  close: () => void;
  get_node: () => string;
}

export interface EntropyAPI {
  Addon: {
    register: (metadata: AddonMetadata) => ScopedAPI;
    onCleanup: (callback: CleanupCallback) => void;
    setVisibility: (addonName: string, visible: boolean) => void;
  };
  // Register Behaviors with reusable IDs, then set those IDs on Models, if desired
  Behavior: {
    register: (id: string, hooks: {
      onUpdate?: (entity: Entity, system: BehaviorSystem, state: any) => any;
      onInteract?: (entity: Entity, dialogue: DialogueSystem) => void;
      onAttack?: (entity: Entity, system: BehaviorSystem, state: any) => any;
    }) => void;
  };
  Entity: {
            applyImpulse: (id: string, impulse: [number, number, number]) => void;
            setVelocity: (id: string, impulse: [number, number, number]) => void;
            setXZVelocity: (id: string, velocity: [number, number]) => void;
            setRotation: (id: string, velocity: [number, number, number]) => void;
            playAnimation: (id: string, animName: string) => void;    setStats: (id: string, stats: { health: number, stamina: number }) => void;
  };
  UI: {
    createWindow: (config: WindowConfig) => string;
    createTab: (config: TabConfig) => string;
    miniMap: (windowId: string, config: MiniMapConfig) => void;
    drawRect: (config: UIRectConfig) => void;
    drawText: (config: UITextConfig) => void;
    clear: () => void;
    Widget: {
      label: (windowId: string, config: LabelConfig) => void;
      button: (windowId: string, config: ButtonConfig) => void;
      colorInput: (windowId: string, config: ColorInputConfig) => void;
      slider: (windowId: string, config: SliderConfig) => void;
      numericInput: (windowId: string, config: NumericInputConfig) => void;
      dropdown: (windowId: string, config: DropdownConfig) => void;
      checkbox: (windowId: string, config: CheckboxConfig) => void;
      codeEditor: (windowId: string, config: CodeEditorConfig) => void;
      miniMap: (windowId: string, config: MiniMapConfig) => void;
      snarl: (windowId: string, config: SnarlConfig) => void;
      horizontal: (windowId: string, render: (windowId: string) => void) => void;
      separator: (windowId: string) => void;
    };
  };
  Composer?: {
    clearMesh: (meshId: string) => void;
      registerEditor: (addonName: string, renderFn: (windowId: string, overrideKey: string) => void) => void;
      getEditor: (addonName: string) => ((windowId: string, overrideKey: string) => void) | undefined;
      registerRenderer: (addonName: string, renderFn: (id: string, params: any) => void) => void;
      getRenderer: (addonName: string) => ((id: string, params: any) => void) | undefined;
      registerGame: (gameName: string, renderFn: (id: string, params: any) => void) => void;
      getGame: (gameName: string) => ((id: string, params: any) => void) | undefined;
      registerTextureGenerator: (addonName: string, generatorFn: (id: string, params: any, res: number) => { diffId: string, norId: string, armId: string }) => void;
      getTextureGenerator: (addonName: string) => ((id: string, params: any, res: number) => { diffId: string, norId: string, armId: string }) | undefined;
      registerComponent: (addonName: string, componentId: string, name: string, params: any) => void;
      getComponents: (addonName: string) => Record<string, { id: string, name: string, params: any }>;
      setRolePipeline: (role: string, pipelineId: string) => void;
      initCallbacks: {
        [key: string]: () => void
      }
      enableGameComposerOverride: () => void,
      disableGameComposerOverride: () => void,
      enableOverride: (addonName: string) => void,
      disableOverride: () => void,
      setGlobalSettings: (settings: GlobalSettings) => void,
      getGlobalSettings: () => GlobalSettings,
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
  Landscape3D: {
    create: (config: {
      id?: string | null;
      vertices: number[];
      indices: number[];
      position?: [number, number, number];
      pipelineId?: string | null;
      renderRole?: string | null;
    }) => void;
  };
  Noise: {
    create: (config: NoiseConfig) => string;
  };
  Texture: {
    create: (width: number, height: number, data: Uint8Array | number[]) => string;
    createStorage: (width: number, height: number, format?: string) => string;
    createEx: (config: TextureConfig, data?: Uint8Array | number[] | null) => string;
    update: (textureId: string, data: Uint8Array | number[] | Float32Array) => void;
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
  onGameStarted: (callback: () => void) => void;
  onGameStopped: (callback: () => void) => void;
  _dispatchGameStarted: () => void;
  _dispatchGameStopped: () => void;
  _process_events: (eventIds: string[]) => void;
  setGameMode: (enabled: boolean) => void;
  Window: {
    getSize: () => [number, number];
  };
  Humanoid: {
    create: () => any; // Returns ProceduralHumanoid instance
  };
  Camera: {
    getTransform: () => [[number, number, number], [number, number, number]];
    screenToWorldRay: (screenX: number, screenY: number) => Ray;
  };
  Gizmo: {
    show: (config: GizmoConfig) => string;
    hide: (gizmoId: string) => void;
    updatePosition: (gizmoId: string, position: [number, number, number]) => void;
    getState: (gizmoId: string) => { isActive: boolean; mode: string; position: [number, number, number] } | null;
  };
  Input: {
    onMouseDown: (callback: (button: number, x: number, y: number) => void) => void;
    onMouseMove: (callback: (x: number, y: number) => void) => void;
    onMouseUp: (callback: (button: number) => void) => void;
    onKeyDown: (callback: (key: string, ctrl: boolean, shift: boolean, alt: boolean) => void) => void;
    onKeyUp: (callback: (key: string) => void) => void;
    onGamepadButton: (callback: (button: string, pressed: boolean) => void) => void;
    onGamepadAxis: (callback: (leftStick: [number, number], rightStick: [number, number]) => void) => void;
    isKeyPressed: (key: string) => boolean;
    isCtrlPressed: () => boolean;
    isShiftPressed: () => boolean;
    isAltPressed: () => boolean;
  };
  Selection: {
    setMode: (mode: "vertex" | "edge" | "face" | "object") => void;
    getSelected: (meshId: string) => { vertices: number[]; edges: [number, number][]; faces: number[][]; objectId: string | null };
    raycast: (screenX: number, screenY: number) => any;
    highlightElements: (meshId: string, config: any) => void;
    clear: () => void;
  };
  Mesh: {
    getData: (meshId: string) => MeshData | null;
    updateVertices: (meshId: string, vertexIndices: number[], newPositions: number[]) => void;
    appendGeometry: (meshId: string, vertices: number[], indices: number[]) => void;
    removeGeometry: (meshId: string, faceIndices: number[]) => void;
    getVertexWorldPosition: (meshId: string, vertexIndex: number) => [number, number, number];
    recalculateNormals: (meshId: string) => void;
  };
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
