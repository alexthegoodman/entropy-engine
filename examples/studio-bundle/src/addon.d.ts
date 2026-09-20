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
  /** Set internally by AddonAtom.register(); addons should not set this directly. */
  isAtom?: boolean;
  /** Groups this addon under a labeled section in the side launcher. Defaults to "Game Creation" when omitted. */
  category?: "Game Creation" | "Audio Creation" | string;
  capabilities?: {
    graphics?: boolean;
    ui?: boolean;
    /** Set to false to give this addon's tab the full work area instead of splitting it with the 3D viewport (e.g. non-visual tools like the DAW). Defaults to true. */
    needsViewport?: boolean;
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
  onAction: (callback: ActionCallback) => void;
  onCleanup: (callback: CleanupCallback) => void;
  onProjectChanged: (callback: ProjectChangedCallback) => void;
  onAllProjectsLoaded: (callback: ProjectChangedCallback) => void;
  getAddon: (name: string) => any;
  getVisual: (name: string) => string | undefined;
  getVisualProvider: (name: string) => VisualProvider | undefined;
  registerVisual: (name: string, provider: string | VisualProvider) => void;
  setVisibility: (visible: boolean) => void;
  registerTool: (definition: ToolDefinition, callback: any) => void;
  AlphaModel: {
    load: (config: {
      id?: string;
      path: string;
      position?: number[];
      rotation?: number[];
      scale?: number[];
    }) => void;
  },
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
          yumonId?: string;
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
          yumonId?: string;
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
          meshId?: string;
          modelPath?: string;
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
          yumonId?: string;
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
  Quadscape: {
    create: (config: LandscapeConfig) => void;
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
    playNote: (config: NoteConfig) => void;
    playTestTone: () => void;
    /** Renders `events` offline to a WAV file (opens a native save dialog), no live playback. */
    renderPatternToWav: (events: NoteEvent[], suggestedName?: string) => RenderPatternWavResult;
    /** Creates (on first call for a given `trackId`) or updates a persistent per-track mixing
     * bus: gain/mute/solo apply continuously and in real time, including to notes already
     * ringing - not just to future `playNoteOnTrack` calls. Call this any time a track's own
     * params change (mirroring how the DAW addon calls it from its own `persist()`). */
    ensureTrackBus: (trackId: string, config: TrackBusConfig) => void;
    /** Tears down a track's bus (and stops its sound) - call when a track is deleted. */
    removeTrackBus: (trackId: string) => void;
    /** Triggers one note on an already-created track bus (see `ensureTrackBus`). The bus's own
     * `effectIds` chain handles FX now, so there are no delay/reverb fields here. */
    playNoteOnTrack: (trackId: string, config: PlayNoteOnTrackConfig) => void;
  };
  /** A shared, reusable effect registry - create an effect once, then attach it to one or more
   * track buses by id via `Audio.ensureTrackBus`'s `effectIds`, instead of baking delay/reverb
   * fields into every note/track config. Effects are bus-only (not attachable to a single
   * one-shot `Audio.playNote` call): a stateful streaming effect like a delay line or reverb
   * needs one already-summed signal to process correctly, which is exactly what a mixing bus
   * provides and an individual note doesn't. */
  AudioEffect: {
    createDelay: (config?: DelayEffectConfig) => string;
    createReverb: (config?: ReverbEffectConfig) => string;
    /** Time/feedback/mix all update live, no rebuild. */
    setDelayParams: (effectId: string, config: DelayEffectConfig) => void;
    /** `mix` updates live; changing `roomSize`/`time`/`damping` rebuilds the effect's internal
     * reverb node in place (see `ReverbEffectConfig.mix`'s doc comment). */
    setReverbParams: (effectId: string, config: ReverbEffectConfig) => void;
    /** Removes the effect from the registry. Any track bus still referencing this id by name
     * simply drops it from its chain on its next `ensureTrackBus` call. */
    destroy: (effectId: string) => void;
  };
  Vst3: Vst3API;
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
    setTheme: (theme: ThemeConfig) => void;
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
      pianoRoll: (windowId: string, config: PianoRollConfig) => void;
      keyframeTimeline: (windowId: string, config: KeyframeTimelineConfig) => void;
      tracks: (windowId: string, config: TracksConfig) => void;
      kanban: (windowId: string, config: KanbanConfig) => void;
      /** A Figma/VS Code-style outliner: real indented rows, a native disclosure triangle,
       * and a full-row selection highlight - see `TreeNodeConfig`'s own doc comment for how
       * to hand it hierarchy. */
      treeView: (windowId: string, config: TreeViewConfig) => void;
      /** `id` gives this header a stable id (otherwise it falls back to a frame-counter-derived
       * one - fine for a header nothing else needs to target, fragile for one a script wants to
       * open by name). `defaultOpen` only takes effect the first time this id is ever rendered
       * in a session; the real state afterward is click-driven, same as any other section. */
      collapsingHeader: (windowId: string, title: string, render: (windowId: string) => void, id?: string, defaultOpen?: boolean) => void;
      horizontal: (windowId: string, render: (windowId: string) => void) => void;
      /** A vertical stack, same shape as `horizontal` - mainly useful inside a `horizontal` row
       * so each cell can hold several stacked widgets (a "column"). */
      vertical: (windowId: string, render: (windowId: string) => void) => void;
      /** Like `vertical`, but draws a visible frame/border around its contents - use for a
       * "channel strip" or boxed section instead of an unbroken flat stack of widgets. */
      group: (windowId: string, render: (windowId: string) => void) => void;
      separator: (windowId: string) => void;
      hyperlink: (windowId: string, config: HyperlinkConfig) => void;
      textInput: (windowId: string, config: TextInputConfig) => void;
      docEditor: (windowId: string, config: DocEditorConfig) => void;
      /** Toggles bold on the current selection (single-paragraph only), or flips the active
       * format for whatever gets typed next if there's no selection. */
      docEditorToggleBold: (id: string) => void;
      docEditorToggleItalic: (id: string) => void;
      /** `family` must be a name from `docEditorFontNames()`; an unknown name silently falls
       * back to the document's default proportional face. */
      docEditorSetFontFamily: (id: string, family: string) => void;
      docEditorSetFontSize: (id: string, size: number) => void;
      /** [r, g, b, a] in 0-1, same convention as `Widget.colorInput`. */
      docEditorSetColor: (id: string, color: [number, number, number, number]) => void;
      /** Off = one continuous, unbounded page (still wrapped/margined at the page width) rather
       * than discrete page breaks. */
      docEditorSetPaginated: (id: string, paginated: boolean) => void;
      docEditorLoadSample: (id: string, count?: number) => void;
      /** Every font family name the engine's ~60-font catalog offers, for a toolbar's font
       * dropdown. Static; cheap to call once (e.g. from `addon.onInit`). */
      docEditorFontNames: () => string[];
      /** Parses `html` + any `<style>`/inline CSS (see src/deno/html_layout.rs) and lays it out
       * with taffy - real Block/Flex box layout, but no text wrapping and only a basic,
       * specificity-free cascade (see html_layout.rs's doc comment for the full "basics" list).
       * Re-parses every call, so pass the same string each frame rather than mutating it.
       * `options.baseUrl` resolves relative `<img src>`/`<a href>` for a real fetched page;
       * `options.width` sets the layout viewport width (default 760px). */
      html: (windowId: string, html: string, options?: { baseUrl?: string; width?: number }) => void;
    };
  };
  /** One blocking text fetch (see op_http_get_text's doc comment in addon_ops.rs) - meant for
   * pulling down a real webpage's HTML to feed into `UI.Widget.html`. Call once, e.g. from
   * `addon.onInit`, and cache the result; calling it from a render callback stalls that frame. */
  Net: {
    /** Starts a raw text fetch without blocking the current frame. Poll the returned id with
     * `pollText`; fetched text is never executed. */
    fetchText: (url: string) => string;
    /** Returns `{ done: false }` while the request is in flight. A completed result is consumed
     * by this call, so retain its text or error rather than polling the id again. */
    pollText: (id: string) => { done: boolean; text?: string; error?: string };
    /** Releases this addon's bookkeeping for a pending text fetch. */
    cancelText: (id: string) => void;
    getText: (url: string) => string;
  };
  Lighting: {
    createPointLight: (config: PointLightConfig) => void;
    updateSun: (config: ProceduralSkyConfig) => void;
  };
  // Windows/Media-Foundation only - see src/media_player/mod.rs (playback) and
  // src/video_export/exporter.rs (export). Not previously declared here even though
  // media_player_addon.ts has called it since that addon shipped - `deno bundle` doesn't
  // type-check, so the gap went unnoticed until this was added alongside Entropy.Video.export.
  Video: {
    open: (path: string) => { handle: string; durationMs: number; width: number; height: number; frameRate: number };
    bindTexture: (handle: string, textureId: string) => void;
    play: (handle: string) => void;
    pause: (handle: string) => void;
    seek: (handle: string, ms: number) => void;
    setVolume: (handle: string, volume: number) => void;
    close: (handle: string) => void;
    poll: (handle: string) => { currentTimeMs: number; playing: boolean };
    /** Renders the calling addon's current scene offscreen for `durationMs` at `fps` and muxes
     * it to an H.264 MP4 at `outputPath` (resolution is pinned to the current window size, not
     * configurable yet - see start_export's doc comment). Returns immediately; the export itself
     * advances one captured frame per real render frame from then on (see step_export) rather
     * than blocking - the window and this addon's own onUpdatePlus keep running normally while
     * pollExport() is polled for a result. */
    export: (config: { outputPath: string; fps: number; durationMs: number }) => void;
    pollExport: () => { outputPath: string; frameCount: number; elapsedMs: number; error?: string } | null;
  };
  /** Compiles a visual node graph (Input -> Dense... -> Loss) into a real Burn MLP and trains it
   * on a background thread against a small built-in synthetic dataset - see `crate::ml_graph`
   * and `ml_graph_demo_addon.ts`. No branching: the graph must be a single chain from the one
   * Input node to the one Loss node, walked via `links`, or `trainGraph` throws synchronously. */
  ML: {
    trainGraph: (id: string, config: {
      nodes: Array<
        | { kind: "Input"; id: string; size: number }
        | { kind: "Dense"; id: string; units: number; activation: "relu" | "tanh" | "sigmoid" | "linear" }
        | { kind: "Loss"; id: string }
      >;
      links: Array<{ from: string; to: string }>;
      dataset: "xor" | "two_moons";
      epochs?: number;
      lr?: number;
    }) => void;
    poll: (id: string) => Array<{ epoch: number; totalEpochs: number; loss: number; done: boolean; accuracy?: number }>;
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
  Yumon: {
    create: (name: string) => void;
    tick: (name: string) => {
        pos: number;
        battery: number;
        health: number;
        stamina: number;
        boredom: number;
        storage: number;
        lastAction: string;
    } | null;
    sleep: (name: string) => void;
    brain: {
        create: (id: string, archetype: string) => void;
        observe: (id: string, world: number[], self: number[], action: number, rotation: number, reward: number) => void;
        infer: (id: string) => { actionIdx: number; actionName: string; rotationDelta: number };
        testInfer: (arch: string, context: any) => { actionIdx: number; actionName: string; absoluteRotation: number };
        sleep: (id: string, epochs: number) => void;
        save: (id: string) => void;
        load: (archetype: string) => void;
        getState: (id: string) => YumonBrainState;
        augment: (id: string) => void;
        };
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
export type ActionCallback = (data: { entityId: string, action: number, origin: [number, number, number], direction: [number, number, number], absoluteRotation: number }) => void;
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
  // Starting top-left position in screen pixels. Both must be set together or neither is used
  // (unset centers the window on screen, the previous and still-default behavior). Only affects
  // the first frame - after that the window remembers wherever the user last dragged it to.
  x?: number;
  y?: number;
  resizable?: boolean;
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

// Every field is optional - only name the colors/knobs you want to change, the rest fall back
// to the "Slate" default theme (see `style_from_theme` in src/entropy_gui/style.rs). Colors are
// [r, g, b, a] in 0..1, same convention as ColorInputConfig.
export interface ThemeConfig {
    background?: [number, number, number, number];
    surface?: [number, number, number, number];
    surfaceHover?: [number, number, number, number];
    border?: [number, number, number, number];
    text?: [number, number, number, number];
    accent?: [number, number, number, number];
    cornerRadius?: number;
    windowCornerRadius?: number;
    itemSpacing?: number;
    buttonPadding?: [number, number];
}

export interface SliderConfig {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange?: (value: string) => void;
    // See ButtonConfig.id - same "already read at runtime, never declared" gap.
    id?: string;
}

export interface NumericInputConfig {
    label: string;
    value: number;
    onChange?: (value: string) => void;
    /** Stable id for scripted/BDD control; defaults to one derived from the label and draw order. */
    id?: string;
}

export interface SynthConfig {
  freq: number;
  waveform?: "sine" | "square" | "saw" | "noise";
  duration?: number;
  cutoff?: number;
  gain?: number;
}

export type SynthWaveform = "sine" | "square" | "saw" | "triangle" | "noise";
export type DrumVoice = "kick" | "snare" | "hihat" | "clap" | "tom";

export interface NoteConfig {
  freq: number;
  waveform?: SynthWaveform | DrumVoice | string;
  duration?: number;
  cutoff?: number;
  resonance?: number;
  gain?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  /** Echo delay time in seconds. Omit or 0 for no delay. */
  delayTime?: number;
  /** Feedback gain fed back into the delay line each repeat, 0..0.95. */
  delayFeedback?: number;
  /** Wet/dry mix of the delayed signal, 0 (off, default)..1. */
  delayMix?: number;
  /** fundsp reverb room size in meters, clamped to 10..30. Default 10. */
  reverbRoomSize?: number;
  /** Reverberation time in seconds to -60dB. Default 1.0. */
  reverbTime?: number;
  /** Damping filter amount, 0..1. Default 0.5. */
  reverbDamping?: number;
  /** Wet/dry mix of the reverberated signal, 0 (off, default)..1. */
  reverbMix?: number;
}

/** One pre-scheduled note in an offline pattern render - see `Audio.renderPatternToWav`. */
export interface NoteEvent extends NoteConfig {
  /** When this note starts, in seconds from the start of the rendered pattern. */
  startTime: number;
}

export interface RenderPatternWavResult {
  success: boolean;
  /** Absolute path of the written WAV file, if `success`. */
  path?: string;
  /** Rendered file duration in seconds (includes any delay/reverb tail past the last note). */
  durationSeconds: number;
  /** Set when `success` is false - e.g. the user cancelled the save dialog. */
  error?: string;
}

export interface DelayEffectConfig {
  /** Echo delay time in seconds, 0..2. Default 0.3. */
  time?: number;
  /** Feedback gain fed back into the delay line each repeat, 0..0.95. Default 0.35. */
  feedback?: number;
  /** Wet/dry mix of the delayed signal, 0 (off, default)..1. Live-adjustable with no rebuild. */
  mix?: number;
}

export interface ReverbEffectConfig {
  /** Room size in meters, clamped to 10..30. Default 10. */
  roomSize?: number;
  /** Reverberation time in seconds to -60dB. Default 1.2. */
  time?: number;
  /** Damping filter amount, 0..1. Default 0.5. */
  damping?: number;
  /** Wet/dry mix of the reverberated signal, 0 (off, default)..1. Live-adjustable; changing
   * `roomSize`/`time`/`damping` rebuilds the effect's internal reverb node in place. */
  mix?: number;
}

/** One installed VST3 plugin, from `Vst3.scan`. */
interface Vst3PluginInfo {
  name: string;
  vendor: string;
  /** e.g. "Instrument|Synth" or "Fx|Analyzer". */
  category: string;
  path: string;
  isInstrument: boolean;
  hasGui: boolean;
  hasMidiInput: boolean;
  /** True for plugins like MIDI Guitar 3 that emit MIDI; hosting those is not supported yet. */
  hasMidiOutput: boolean;
  audioInputs: number;
  audioOutputs: number;
}

interface Vst3Ok { ok: boolean; error?: string }

interface Vst3LoadResult extends Vst3Ok {
  name?: string;
  vendor?: string;
  hasEditor?: boolean;
  parameterCount?: number;
  /** How long the plugin took to initialise (the calling frame is blocked for this long). */
  loadMs?: number;
}

interface Vst3ParameterView {
  id: number;
  name: string;
  /** Normalized 0..1. */
  value: number;
  /** The plugin's own display string for the value, e.g. "-6.02dB". */
  display: string;
  stepCount: number;
}

interface Vst3Stats {
  trackId: string;
  plugin: string;
  blocks: number;
  /** Blocks rendered as silence because the main thread held the plugin lock. */
  skippedBlocks: number;
  notesSent: number;
  lifetimePeak: number;
  editorOpen: boolean;
}

/** Hosts real VST3 plugins as a track's instrument. A track's bus must exist first
 * (`Audio.ensureTrackBus`); the plugin's audio then joins that bus, so its gain/mute/solo and
 * effect chain apply. Calls report failure as `{ ok: false, error }` rather than throwing. */
interface Vst3API {
  /** Installed plugins from the standard VST3 folders. Cached for the session; `refresh` rescans. */
  scan: (refresh?: boolean) => { plugins: Vst3PluginInfo[]; skipped: string[] };
  /** `state` is base64 from an earlier `saveState`/`pollState`; omit for the default patch. */
  load: (trackId: string, config: { path: string; state?: string | null }) => Vst3LoadResult;
  unload: (trackId: string) => void;
  /** `channel` is 0-15, `duration` is seconds until the note-off. A note lands on the next 11.6ms block. */
  noteOn: (trackId: string, config: { note: number; velocity?: number; duration?: number; channel?: number }) => Vst3Ok;
  allNotesOff: (trackId: string) => void;
  openEditor: (trackId: string) => Vst3Ok;
  closeEditor: (trackId: string) => void;
  /** Base64 state captured when the editor closed or parameter edits settled; null if nothing new. */
  pollState: (trackId: string) => string | null;
  /** Base64 state taken right now. */
  saveState: (trackId: string) => string | null;
  findParameters: (trackId: string, query?: string, limit?: number) => Vst3Ok & { parameters?: Vst3ParameterView[] };
  /** `value` is normalized 0..1. Some plugins smooth the change over several blocks. */
  setParameter: (trackId: string, id: number, value: number) => Vst3Ok;
  /** Linear peak rendered since the previous call (for a level meter), or null with no instrument. */
  takePeak: (trackId: string) => number | null;
  stats: () => Vst3Stats[];
}

/** Config for `Audio.ensureTrackBus` - creates a track's persistent mixing bus on first call,
 * updates its gain/mute/solo/effect chain on every call after that. */
export interface TrackBusConfig {
  /** 0..1, applied continuously (including to notes already ringing), unlike a note's own gain. */
  gain?: number;
  /** Silences this track's output immediately, even mid-note - unlike the old per-note
   * architecture, mute isn't just "don't trigger new notes." */
  muted?: boolean;
  solo?: boolean;
  /** Effect ids from `AudioEffect.createDelay`/`createReverb`, chained in order - each stage's
   * wet signal is added onto what came before it (insert-style), then the next effect in the
   * list sees that combined signal. */
  effectIds?: string[];
}

/** Config for `Audio.playNoteOnTrack` - like `NoteConfig` but with no delay/reverb fields: FX
 * now lives on the track's bus (see `TrackBusConfig.effectIds`), shared by every note on it. */
export interface PlayNoteOnTrackConfig {
  freq: number;
  waveform?: SynthWaveform | DrumVoice | string;
  duration?: number;
  cutoff?: number;
  resonance?: number;
  gain?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
}

export interface PianoRollCell {
  row: number;
  step: number;
  length: number;
  velocity: number;
}

export interface PianoRollConfig {
  id?: string;
  rows?: number;
  steps?: number;
  stepsPerBeat?: number;
  rowLabels?: string[];
  cells?: PianoRollCell[];
  playhead?: number; // 0-1 fraction across the pattern, or negative to hide
  onNoteDown?: (row: number, step: number) => void;
  onNoteDrag?: (row: number, step: number) => void;
  onNoteUp?: (row: number, step: number) => void;
}

export interface KeyframeConfig {
  id: string;
  timeMs: number;
}

export interface KeyframeRowConfig {
  id: string;
  label: string;
  keyframes: KeyframeConfig[];
}

export interface KeyframeTimelineConfig {
  id?: string;
  durationMs?: number;
  playheadMs?: number;
  rows?: KeyframeRowConfig[];
  selected?: { row: string; keyframe: string };
  onSeek?: (timeMs: number) => void;
  onKeyframeMoved?: (row: string, keyframe: string, timeMs: number) => void;
  onKeyframeSelected?: (row: string, keyframe: string) => void;
  onKeyframeAdd?: (row: string, timeMs: number) => void;
  onKeyframeDelete?: (row: string, keyframe: string) => void;
  onRowClicked?: (row: string) => void;
  onBackgroundClicked?: () => void;
}

export interface TrackClipConfig {
  id: string;
  label: string;
  startMs: number;
  durationMs: number;
  /// [r, g, b, a] in 0-1, same convention as `Widget.colorInput`.
  color?: [number, number, number, number];
  /// Normalized (0-1) amplitude peaks - an addon-computed waveform for an audio clip.
  /// Omitted for a video or other non-audio clip.
  peaks?: number[];
  /// Length of one repeat of the clip's content, in ms. `notes` tile at this period.
  loopMs?: number;
  /// Miniature note preview: `[start, len, y]` triples, each 0-1 within one loop.
  notes?: [number, number, number][];
}

export interface TrackConfig {
  id: string;
  label: string;
  clips: TrackClipConfig[];
  /// Dimmer second header line, e.g. an instrument name.
  sublabel?: string;
  /// [r, g, b, a] in 0-1 - the header's accent strip.
  color?: [number, number, number, number];
  muted?: boolean;
  solo?: boolean;
  /// Draw mute/solo pills in the header (see `onTrackMute`/`onTrackSolo`).
  controls?: boolean;
  /// An unused lane shown so the arrangement always has room: dimmed, no pills.
  placeholder?: boolean;
}

export interface TracksOptions {
  laneHeight?: number;
  labelWidth?: number;
  /// Grid that move / trim / draw snap to, in ms. 0 or omitted disables snapping.
  snapMs?: number;
  /// > 0 switches the ruler and gridlines from seconds to bars and beats.
  barMs?: number;
  beatMs?: number;
  /// Zoom so the whole `durationMs` fits the first time the view appears.
  fitOnOpen?: boolean;
  /// Only zoom on Ctrl+wheel, leaving a plain wheel for a surrounding scroll panel.
  zoomNeedsCtrl?: boolean;
  /// Dragging empty lane space draws a new clip (see `onClipCreate`).
  allowDraw?: boolean;
  activeTrack?: string;
  laneNumbers?: boolean;
  minClipMs?: number;
  followPlayhead?: boolean;
  /// Width in px to leave free on the right (e.g. for a scroll panel's scrollbar).
  rightGutter?: number;
}

export interface TracksConfig {
  id?: string;
  durationMs?: number;
  playheadMs?: number;
  tracks?: TrackConfig[];
  selected?: { track: string; clip: string };
  options?: TracksOptions;
  onSeek?: (timeMs: number) => void;
  onClipMoved?: (track: string, clip: string, startMs: number) => void;
  onClipResized?: (track: string, clip: string, startMs: number, durationMs: number) => void;
  onClipSelected?: (track: string, clip: string) => void;
  onClipDelete?: (track: string, clip: string) => void;
  onClipDuplicate?: (track: string, clip: string) => void;
  /// A drag on empty lane space finished (needs `options.allowDraw`); already snapped.
  onClipCreate?: (track: string, startMs: number, durationMs: number) => void;
  onTrackClicked?: (track: string) => void;
  onTrackMute?: (track: string) => void;
  onTrackSolo?: (track: string) => void;
  onBackgroundClicked?: () => void;
}

export interface KanbanCardConfig {
  id: string;
  title: string;
  description?: string;
  /** [r, g, b, a] in 0-1, same convention as `Widget.colorInput`. Used for the card's left
   * accent bar. Defaults to a neutral blue if omitted. */
  color?: [number, number, number, number];
  tags?: string[];
}

export interface KanbanColumnConfig {
  id: string;
  title: string;
  cards: KanbanCardConfig[];
}

export interface KanbanConfig {
  id?: string;
  columns?: KanbanColumnConfig[];
  selected?: { column: string; card: string };
  /** Fired when a card is dropped - `toColumn` may equal `fromColumn` (reordering within one
   * column). Apply this to your own data; the widget never mutates it for you. */
  onCardMoved?: (card: string, fromColumn: string, toColumn: string, toIndex: number) => void;
  /** Fired on a plain click, or when a drag starts (indistinguishable from a click until
   * release) - use it to track which card is selected. */
  onCardSelected?: (column: string, card: string) => void;
  /** Fired from a card's right-click "Delete Card" menu item, or Delete/Backspace when
   * `selected` names a card. */
  onCardDelete?: (column: string, card: string) => void;
  /** Fired when a column header's "+" button is clicked. */
  onAddCard?: (column: string) => void;
  onColumnClicked?: (column: string) => void;
  onBackgroundClicked?: () => void;
}

/** One row of a `Widget.treeView` - already depth-computed; the widget does not derive
 * hierarchy from parent ids, so a collapsed subtree is just omitted from `nodes` entirely. */
export interface TreeNodeConfig {
  /** Unique within this tree. */
  id: string;
  label: string;
  /** 0 for a root row; each level of nesting to draw adds 1. */
  depth: number;
  /** Draws a disclosure triangle when true. Leave false/omitted for a leaf row, and for a
   * group row with nothing currently in it - a triangle that toggles nothing is worse than no
   * triangle at all. */
  hasChildren?: boolean;
  expanded?: boolean;
  /** Omit to hide this row's checkbox entirely; set true/false to show it at that state (used
   * for "mark several rows, then act on all of them" flows). */
  marked?: boolean;
  selected?: boolean;
}

export interface TreeViewConfig {
  id?: string;
  nodes?: TreeNodeConfig[];
  /** Fired when a row's label is clicked. */
  onSelect?: (id: string) => void;
  /** Fired when a row's disclosure triangle is clicked. Apply this to whatever expanded-set
   * you own; the widget keeps no collapsed-state memory of its own between frames. */
  onToggleExpand?: (id: string) => void;
  /** Fired when a row's checkbox is clicked, carrying its new (post-click) value. */
  onMark?: (id: string, value: boolean) => void;
}

export interface DocEditorConfig {
  id?: string;
  /** Page size/margin in px (96 = 1" at 96 DPI). Defaults to US Letter, 1" margins. */
  pageWidth?: number;
  pageHeight?: number;
  margin?: number;
  /** Fires every frame with the document's current word/char/page counts and active format
   * (what bold/italic/font/size/color the next typed character would use, or - with a
   * selection - what toggling would flip). The document content itself never crosses into JS -
   * it lives Rust-side, keyed by this widget's id (see `entropy_gui::widgets_doc_editor`'s
   * module docs for why). This widget draws only the page canvas - build your own toolbar out
   * of ordinary widgets and drive it with the `docEditor*` functions below. */
  onStats?: (stats: {
    words: number;
    chars: number;
    pages: number;
    paginated: boolean;
    bold: boolean;
    italic: boolean;
    fontFamily: string;
    fontSize: number;
    /** [r, g, b, a] in 0-1, same convention as `Widget.colorInput`. */
    color: [number, number, number, number];
  }) => void;
}

export interface ButtonConfig {
  text: string;
  onClick?: () => void;
  // Stable widget id across re-renders (an immediate-mode onRender re-declares every widget
  // every frame) - falls back to deriving one from `text` when omitted. Already read at runtime
  // (src/deno/addon_setup.js's Widget.button: `config?.id`) but never declared here before.
  id?: string;
}

export interface HyperlinkConfig {
  text: string;
  url: string;
  id?: string;
}

export interface TextInputConfig {
  label?: string;
  value?: string;
  onChange?: (value: string) => void;
  id?: string;
  /// Fixed field width in px. Omitted, the field fills the rest of its row. Setting it also keys
  /// the field's keyboard focus by `id` rather than by draw order.
  width?: number;
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
    id?: string;
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
    selectedNode?: string;
    nodes: BehaviorNode[];
    connections: BehaviorConnection[];
}

export interface SnarlConfig {
    onNodeSelected?: (nodeId: string) => void;
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
  /** [x, y, z, w] quaternion seeding the gizmo's drawn orientation. Default: identity. Only
   * meaningful when `mode` includes rotate handles. */
  rotation?: [number, number, number, number];
  mode: "translate" | "rotate" | "scale" | "translate_rotate";
  space?: "world" | "local";
  onTransform?: (delta: [number, number, number]) => void;
  /** Fires with the gizmo's new ABSOLUTE orientation (not a delta) as an [x, y, z, w]
   * quaternion, whenever a rotate handle changes it. Only fires for `mode`s that include
   * rotate handles ("rotate" / "translate_rotate"). */
  onRotate?: (rotation: [number, number, number, number]) => void;
  onComplete?: () => void;
}

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
}

export interface ControlsOptions {
  /** Modifier that must be held for a drag to move the camera. Default "shift". */
  trigger?: "shift" | "ctrl" | "alt" | "always";
  /** Mouse button (0 left/1 right/2 middle) that starts the drag. Default 0. */
  button?: number;
  /** "orbit" only: second button that dollies distance on vertical drag. Default 2. */
  zoomButton?: number;
  rotateSpeed?: number;
  panSpeed?: number;
  zoomSpeed?: number;
  /** Radians. Defaults to roughly +-85 degrees. */
  minPitch?: number;
  maxPitch?: number;
  invertY?: boolean;
  /** Flip horizontal drag direction ("orbit"'s yaw only). Default false. */
  invertX?: boolean;
  /** World-space point to orbit/pan around. Defaults to the camera's current look-at target. */
  target?: [number, number, number];
}

export interface MeshData {
  vertices: Float32Array;
  indices: Uint32Array;
  vertexStride: number;
}

export interface YumonBrainState {
    archetype: string;
    trainingMode: string;
    state: string;
    totalMoments: number;
    lastReward: number;
    lastLoss: number | null;
    lastAction: string;
    lastRotation: number;
    sleepCount: number;
    isTraining: boolean;
    trainingEpoch: number;
    totalTrainingEpochs: number;
    trainingLoss: number;
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
  AddonAtom: {
    register: (metadata: AddonMetadata) => ScopedAPI;
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
    setWindowVisible: (id: string, visible: boolean) => void;
    createTab: (config: TabConfig) => string;
    miniMap: (windowId: string, config: MiniMapConfig) => void;
    drawRect: (config: UIRectConfig) => void;
    drawText: (config: UITextConfig) => void;
    clear: () => void;
    setTheme: (theme: ThemeConfig) => void;
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
      pianoRoll: (windowId: string, config: PianoRollConfig) => void;
      keyframeTimeline: (windowId: string, config: KeyframeTimelineConfig) => void;
      tracks: (windowId: string, config: TracksConfig) => void;
      kanban: (windowId: string, config: KanbanConfig) => void;
      /** A Figma/VS Code-style outliner: real indented rows, a native disclosure triangle,
       * and a full-row selection highlight - see `TreeNodeConfig`'s own doc comment for how
       * to hand it hierarchy. */
      treeView: (windowId: string, config: TreeViewConfig) => void;
      /** `id` gives this header a stable id (otherwise it falls back to a frame-counter-derived
       * one - fine for a header nothing else needs to target, fragile for one a script wants to
       * open by name). `defaultOpen` only takes effect the first time this id is ever rendered
       * in a session; the real state afterward is click-driven, same as any other section. */
      collapsingHeader: (windowId: string, title: string, render: (windowId: string) => void, id?: string, defaultOpen?: boolean) => void;
      horizontal: (windowId: string, render: (windowId: string) => void) => void;
      /** A vertical stack, same shape as `horizontal` - mainly useful inside a `horizontal` row
       * so each cell can hold several stacked widgets (a "column"). */
      vertical: (windowId: string, render: (windowId: string) => void) => void;
      /** Like `vertical`, but draws a visible frame/border around its contents - use for a
       * "channel strip" or boxed section instead of an unbroken flat stack of widgets. */
      group: (windowId: string, render: (windowId: string) => void) => void;
      separator: (windowId: string) => void;
      hyperlink: (windowId: string, config: HyperlinkConfig) => void;
      textInput: (windowId: string, config: TextInputConfig) => void;
      docEditor: (windowId: string, config: DocEditorConfig) => void;
      /** Toggles bold on the current selection (single-paragraph only), or flips the active
       * format for whatever gets typed next if there's no selection. */
      docEditorToggleBold: (id: string) => void;
      docEditorToggleItalic: (id: string) => void;
      /** `family` must be a name from `docEditorFontNames()`; an unknown name silently falls
       * back to the document's default proportional face. */
      docEditorSetFontFamily: (id: string, family: string) => void;
      docEditorSetFontSize: (id: string, size: number) => void;
      /** [r, g, b, a] in 0-1, same convention as `Widget.colorInput`. */
      docEditorSetColor: (id: string, color: [number, number, number, number]) => void;
      /** Off = one continuous, unbounded page (still wrapped/margined at the page width) rather
       * than discrete page breaks. */
      docEditorSetPaginated: (id: string, paginated: boolean) => void;
      docEditorLoadSample: (id: string, count?: number) => void;
      /** Every font family name the engine's ~60-font catalog offers, for a toolbar's font
       * dropdown. Static; cheap to call once (e.g. from `addon.onInit`). */
      docEditorFontNames: () => string[];
      /** Parses `html` + any `<style>`/inline CSS (see src/deno/html_layout.rs) and lays it out
       * with taffy - real Block/Flex box layout, but no text wrapping and only a basic,
       * specificity-free cascade (see html_layout.rs's doc comment for the full "basics" list).
       * Re-parses every call, so pass the same string each frame rather than mutating it.
       * `options.baseUrl` resolves relative `<img src>`/`<a href>` for a real fetched page;
       * `options.width` sets the layout viewport width (default 760px). */
      html: (windowId: string, html: string, options?: { baseUrl?: string; width?: number }) => void;
    };
  };
  /** One blocking text fetch (see op_http_get_text's doc comment in addon_ops.rs) - meant for
   * pulling down a real webpage's HTML to feed into `UI.Widget.html`. Call once, e.g. from
   * `addon.onInit`, and cache the result; calling it from a render callback stalls that frame. */
  Net: {
    /** Starts a raw text fetch without blocking the current frame. Poll the returned id with
     * `pollText`; fetched text is never executed. */
    fetchText: (url: string) => string;
    /** Returns `{ done: false }` while the request is in flight. A completed result is consumed
     * by this call, so retain its text or error rather than polling the id again. */
    pollText: (id: string) => { done: boolean; text?: string; error?: string };
    /** Releases this addon's bookkeeping for a pending text fetch. */
    cancelText: (id: string) => void;
    getText: (url: string) => string;
  };
  Composer?: {
    editors: { [key: string]: any };
    getNPCs: () => { id: string; type: string; position: [number, number, number] }[];
    updateNPCPosition: (entityId: string, position: [number, number, number]) => void;
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
      registerInstance: (addonName: string, componentId: string, instanceId: string, defaults: any) => void;
      getInstances: () => Record<string, { addonName: string, componentId: string, defaults: any }>;
      registerAction: (addonName: string, actionName: string, fn: (...args: any[]) => any) => void;
      getAction: (addonName: string, actionName: string) => ((...args: any[]) => any) | undefined;
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
  Video: {
    open: (path: string) => { handle: string; durationMs: number; width: number; height: number; frameRate: number };
    bindTexture: (handle: string, textureId: string) => void;
    play: (handle: string) => void;
    pause: (handle: string) => void;
    seek: (handle: string, ms: number) => void;
    setVolume: (handle: string, volume: number) => void;
    close: (handle: string) => void;
    poll: (handle: string) => { currentTimeMs: number; playing: boolean };
    /** Renders the calling addon's current scene offscreen for `durationMs` at `fps` and muxes
     * it to an H.264 MP4 at `outputPath` (resolution is pinned to the current window size, not
     * configurable yet - see start_export's doc comment). Returns immediately; the export itself
     * advances one captured frame per real render frame from then on (see step_export) rather
     * than blocking - the window and this addon's own onUpdatePlus keep running normally while
     * pollExport() is polled for a result. */
    export: (config: { outputPath: string; fps: number; durationMs: number }) => void;
    pollExport: () => { outputPath: string; frameCount: number; elapsedMs: number; error?: string } | null;
  };
  ML: {
    trainGraph: (id: string, config: {
      nodes: Array<
        | { kind: "Input"; id: string; size: number }
        | { kind: "Dense"; id: string; units: number; activation: "relu" | "tanh" | "sigmoid" | "linear" }
        | { kind: "Loss"; id: string }
      >;
      links: Array<{ from: string; to: string }>;
      dataset: "xor" | "two_moons";
      epochs?: number;
      lr?: number;
    }) => void;
    poll: (id: string) => Array<{ epoch: number; totalEpochs: number; loss: number; done: boolean; accuracy?: number }>;
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
  Model: {
    // Loads a .glb - `path` resolves as `<dir>/path`, where `<dir>` is whatever directory
    // EntropyApp::with_art_assets_dir(dir) set on the Rust side (required; otherwise the pending
    // load is silently dropped, no error). `id`, if given, must be UUID-parseable (e.g.
    // Entropy.generateUUID()) - a human-readable id panics.
    load: (config: {
        id?: string | null;
        path: string;
        visualType?: string | null;
        position?: number[];
        rotation?: number[];
        scale?: number[];
        pipelineId?: string | null;
        renderRole?: string | null;
        physics?: PhysicsConfig | null;
        player?: { modelId?: string; defaultWeaponId?: string } | null;
        npc?: object | null;
        behaviorId?: string | null;
        yumonId?: string | null;
        isNpc?: boolean | null;
    }) => void;
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
        yumonId?: string;
        isNpc?: boolean;
        player?: {
            modelId?: string;
            defaultWeaponId?: string;
        };
    }) => void;
    clearMesh: (meshId: string) => void;
    /** Opens a native Save As dialog and writes a self-contained .glb (each mesh's texture
     * PNG-encoded and embedded, no external file references) from already-world-space mesh
     * data supplied directly - doesn't touch the engine's own mesh registry, so it works for
     * meshes that were never `createMesh`'d as live scene entities too. Returns the chosen
     * path, or `path: null`/`error` set if the dialog was cancelled or writing failed. */
    exportGlb: (meshes: Array<{
        name: string;
        positions: number[]; // flat x,y,z, world-space
        normals: number[]; // flat x,y,z
        uvs: number[]; // flat u,v
        indices: number[];
        textureRgba: Uint8Array;
        textureWidth: number;
        textureHeight: number;
    }>, suggestedName?: string) => { success: boolean; path: string | null; error: string | null };
  };
  Landscape: {
    create: (config: LandscapeConfig) => string;
    updateTexture: (textureId: string, kind: LandscapeTextureKind) => void;
    updatePbrTexture: (textureId: string, kind: PBRTextureKind, materialType: PBRMaterialType) => void;
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
    // `id` is required - createPointLight upserts by id, so re-supplying the same one (e.g. on
    // every slider onChange in a live editor) updates that light in place instead of leaking a
    // new one every call. See removePointLight to despawn one.
    createPointLight: (config: {
      id: string;
      position?: [number, number, number];
      color?: [number, number, number];
      intensity?: number;
      maxDistance?: number;
      falloffExponent?: number; // exponent in pow(distance / maxDistance, x); default 2.0 (quadratic)
      specularStrength?: number; // multiplies this light's specular contribution; default 1.0
    }) => void;
    removePointLight: (id: string) => void;
    updateSun: (config: ProceduralSkyConfig) => void;
    // Replaces the deferred lighting pass's point-light shading function with this WGSL source -
    // it must define `fn point_light_contribution(...)` with the exact signature documented
    // between ENTROPY_CUSTOM_POINT_LIGHT_BEGIN/END in src/core/shaders/lighting.wgsl. Recompiled
    // behind a wgpu validation error scope, so an invalid shader is rejected (logged, previous
    // pipeline keeps running) instead of crashing the app. Call with "" (or omit) to reset to
    // the built-in shading.
    setPointLightShader: (wgslSource?: string) => void;
    // Any field left unset keeps its current value - only pass what you're changing. Directional
    // light only; point lights don't cast shadows.
    configureShadows: (config: {
      mapSize?: number; // shadow map resolution (square), e.g. 256/512/1024/2048
      bias?: number; // depth bias constant
      slopeScale?: number; // depth bias slope scale
      halfExtent?: number; // orthographic frustum half-width/height covered by the shadow map
    }) => void;
  };
  Audio: {
    playSynth: (config: SynthConfig) => void;
    playNote: (config: NoteConfig) => void;
    playTestTone: () => void;
    /** Renders `events` offline to a WAV file (opens a native save dialog), no live playback. */
    renderPatternToWav: (events: NoteEvent[], suggestedName?: string) => RenderPatternWavResult;
    /** Creates (on first call for a given `trackId`) or updates a persistent per-track mixing
     * bus: gain/mute/solo apply continuously and in real time, including to notes already
     * ringing - not just to future `playNoteOnTrack` calls. */
    ensureTrackBus: (trackId: string, config: TrackBusConfig) => void;
    /** Tears down a track's bus (and stops its sound) - call when a track is deleted. */
    removeTrackBus: (trackId: string) => void;
    /** Triggers one note on an already-created track bus (see `ensureTrackBus`). */
    playNoteOnTrack: (trackId: string, config: PlayNoteOnTrackConfig) => void;
  };
  /** A shared, reusable effect registry - see the scoped `Entropy.Addon.register()` API's
   * `AudioEffect` for the full doc comment (identical surface, top-level here). */
  AudioEffect: {
    createDelay: (config?: DelayEffectConfig) => string;
    createReverb: (config?: ReverbEffectConfig) => string;
    setDelayParams: (effectId: string, config: DelayEffectConfig) => void;
    setReverbParams: (effectId: string, config: ReverbEffectConfig) => void;
    destroy: (effectId: string) => void;
  };
  Vst3: Vst3API;
  println: (msg: unknown) => void;
  generateUUID: () => string;
  onGameStarted: (callback: (gameName: string) => void) => void;
  onGameStopped: (callback: (gameName: string) => void) => void;
  _dispatchGameStarted: (gameName: string) => void;
  _dispatchGameStopped: (gameName: string) => void;
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
    setTransform: (position?: [number, number, number], target?: [number, number, number]) => void;
    // Switches the render camera between perspective (default) and a true orthographic
    // projection centered on the camera's position - constant apparent sprite size
    // regardless of screen position, unlike perspective. `viewHeight` is the world-space
    // height of the visible area (width derives from window aspect ratio); omit to keep
    // the current value (10 world units by default). screenToWorldRay already accounts
    // for whichever projection is active.
    setOrthographic: (enabled: boolean, viewHeight?: number) => void;
    screenToWorldRay: (screenX: number, screenY: number) => Ray;
  };
  /**
   * Ready-made camera control schemes built on top of Camera + Input, so a
   * scene can opt into e.g. shift-drag-to-orbit with one call instead of
   * hand-wiring Input.onMouseDown/onMouseMove/onMouseUp + isShiftPressed()
   * and spherical-coordinate math itself in every addon.
   */
  Controls: {
    enable: (format: "orbit" | "pan" | "none", options?: ControlsOptions) => void;
    disable: () => void;
    isEnabled: () => boolean;
    getFormat: () => "orbit" | "pan" | null;
  };
  Gizmo: {
    show: (config: GizmoConfig) => string;
    hide: (gizmoId: string) => void;
    updatePosition: (gizmoId: string, position: [number, number, number]) => void;
    updateRotation: (gizmoId: string, rotation: [number, number, number, number]) => void;
    getState: (gizmoId: string) => { isActive: boolean; mode: string; position: [number, number, number] } | null;
  };
  /**
   * Each on* registers an additional listener rather than replacing a prior
   * one - Entropy.Controls and an addon's own input handling can both
   * register onMouseMove, for example, without either clobbering the other.
   * Every on* returns an unsubscribe function.
   */
  Input: {
    onMouseDown: (callback: (button: number, x: number, y: number) => void) => () => void;
    onMouseMove: (callback: (x: number, y: number) => void) => () => void;
    onMouseUp: (callback: (button: number) => void) => () => void;
    /** A real mouse scroll wheel and a drawing tablet's physical zoom wheel/dial both arrive
     * here identically. deltaY > 0 is "wheel up"/scroll away from the user. */
    onMouseWheel: (callback: (deltaX: number, deltaY: number) => void) => () => void;
    onKeyDown: (callback: (key: string, ctrl: boolean, shift: boolean, alt: boolean) => void) => () => void;
    onKeyUp: (callback: (key: string) => void) => () => void;
    onGamepadButton: (callback: (button: string, pressed: boolean) => void) => () => void;
    onGamepadAxis: (callback: (leftStick: [number, number], rightStick: [number, number]) => void) => () => void;
    // Pen/stylus input (Windows only, PT_PEN pointers - see src/stylus.rs). pressure is 0..1.
    // tiltX/tiltY are degrees (0 = perpendicular to the tablet, +-90 = flat against it), or null
    // if this pen's driver doesn't report that axis. Never fires for mouse or finger-touch input.
    onStylusDown: (callback: (e: { x: number; y: number; pressure: number; tiltX: number | null; tiltY: number | null }) => void) => () => void;
    onStylusMove: (callback: (e: { x: number; y: number; pressure: number; tiltX: number | null; tiltY: number | null }) => void) => () => void;
    onStylusUp: (callback: (e: { x: number; y: number }) => void) => () => void;
    isKeyPressed: (key: string) => boolean;
    isCtrlPressed: () => boolean;
    isShiftPressed: () => boolean;
    isAltPressed: () => boolean;
    // True if the pointer is currently over any Entropy.UI window/widget. Check this before
    // treating a click as a world/game interaction (e.g. click-to-select in a level editor) -
    // without it, a click on a UI button also fires as a click on whatever's in the game world
    // underneath that same screen position, since UI and game input aren't otherwise exclusive.
    isPointerOverUI: () => boolean;
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
