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
    renderPatternToWav: (events: NoteEvent[], suggestedName?: string, sampleEvents?: SampleEvent[], wavetableEvents?: WavetableNoteConfig[], physModEvents?: PhysModNoteConfig[], vst3Events?: Vst3RenderTrackConfig[], trackBuses?: TrackBusRenderConfig[], brassEvents?: BrassNoteConfig[], matterEvents?: MatterHitConfig[]) => RenderPatternWavResult;
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
    /** Plays one timed wavetable note on a track's bus (see `Wavetable`). The note reads the table
     * as it is at every sample, so sculpting the table changes a note that is already sounding. */
    playWavetableOnTrack: (trackId: string, config: WavetableNoteConfig) => WavetableOk;
    /** Starts a wavetable note that sounds until `wavetableNoteOff(voice)`. */
    wavetableNoteOn: (trackId: string, config: WavetableNoteConfig) => WavetableOk & { voice?: number };
    wavetableNoteOff: (voice: number) => void;
    /** Moves a held wavetable note through its table (0..1 across the frames) while it sounds. */
    wavetableSetPosition: (voice: number, position: number) => void;
    /** Plays one timed bowed-string note on a track's bus (see `PhysMod`). */
    playPhysModOnTrack: (trackId: string, config: PhysModNoteConfig) => PhysModOk;
    /** Starts a bowed-string note that sounds until `physModNoteOff(voice)`. */
    physModNoteOn: (trackId: string, config: PhysModNoteConfig) => PhysModOk & { voice?: number };
    physModNoteOff: (voice: number) => void;
    /** Moves a held bowed-string note's bow while it sounds. */
    physModSetBow: (voice: number, which: "force" | "velocity" | "position" | "vibratoDepth", value: number) => void;
    /** Plays one timed brass note on a track's bus (see `Brass`). Notes on one track are played by
     *  one player: a note that starts before the last one ends slurs into it. */
    playBrassOnTrack: (trackId: string, config: BrassNoteConfig) => BrassOk;
    /** Starts a brass note that sounds until `brassNoteOff(voice)`. */
    brassNoteOn: (trackId: string, config: BrassNoteConfig) => BrassOk & { voice?: number };
    brassNoteOff: (voice: number) => void;
    /** Moves a held brass note: breath (0..1), lip tension (-1..1), vibrato depth or bend (cents). */
    brassSetControl: (voice: number, which: "breath" | "lipTension" | "vibratoDepth" | "bend", value: number) => void;
    /** Builds (off the audio thread) or checks the track's drum kit (see `Matter`). Hits sent while a
     *  kit is first being built are dropped, so prepare it ahead of playing. Cheap every frame. */
    prepareMatter: (trackId: string, config: MatterHitConfig) => MatterOk & { status?: MatterStatus };
    /** Strikes a piece of the track's kit now. `played` is false while the kit is being built. */
    playMatterOnTrack: (trackId: string, config: MatterHitConfig) => MatterOk & { played?: boolean };
    /** Holds a tool on a piece of the track's kit live (a drag): send it every frame; pressure 0
     *  lifts it. */
    holdMatterOnTrack: (trackId: string, config: MatterHoldConfig) => MatterOk & { played?: boolean };
    /** Stops the track's kit. */
    removeMatter: (trackId: string, kitId?: string) => void;
    /** Reads a source back without drawing anything: `"master"` (the whole mix) or a track id.
     * Peak and RMS are dBFS over the last `fftSize` frames (default 4096, -120 = silence);
     * `peakHz`/`peakDb` are the strongest frequency above 20 Hz and its level; `centroidHz` is the
     * spectral centroid. `framesWritten` proves the audio thread is running. Returns null when
     * the source does not exist. The analyzer widgets are drawn from the same taps. */
    analyze: (source?: string, fftSize?: number) => AudioAnalysis | null;
    /** Decodes a sample file (or finds it in memory) and describes it. Only the first 12 seconds
     * of a file are decoded (`truncated` says so). Call it when a sample is assigned so the first
     * hit does not wait on the decode. wav, flac, mp3, ogg and m4a are supported. */
    loadSample: (path: string, bins?: number) => SampleInfo;
    /** A drum-rack hit: plays `path` on a track bus (see `ensureTrackBus`). */
    playSampleOnTrack: (trackId: string, path: string, config?: SampleParams) => SampleResult;
    /** Auditions a file through the shared preview bus, cutting off the previous audition. The bus
     * is `"sample-preview"` for `analyze`. */
    previewSample: (path: string, config?: SampleParams) => SampleResult;
    stopPreview: () => void;
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
    /** Pump, Gate, Grit, Space or Fader (see `CharacterEffectConfig`). Inline: the output
     * replaces the signal, so put these after delay/reverb in a bus's `effectIds`. */
    createCharacter: (config: CharacterEffectConfig) => string;
    setCharacterParams: (effectId: string, config: CharacterEffectConfig) => void;
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
  Wavetable: WavetableAPI;
  PhysMod: PhysModAPI;
  Brass: BrassAPI;
  Matter: MatterAPI;
  Icons: IconsAPI;
  System: SystemAPI;
  Guitar: GuitarAPI;
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
      knob: (windowId: string, config: KnobConfig) => void;
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
      /** A spreadsheet grid: lettered column headers, numbered rows, one selected cell with
       * arrow-key/Tab/Enter navigation, and an optional colored border per cell. No inline
       * editing - drive a cell's content through your own textInput bound to `selected`. */
      sheetGrid: (windowId: string, config: SheetGridConfig) => void;
      /** A Figma/VS Code-style outliner: real indented rows, a native disclosure triangle,
       * and a full-row selection highlight - see `TreeNodeConfig`'s own doc comment for how
       * to hand it hierarchy. */
      treeView: (windowId: string, config: TreeViewConfig) => void;
      /** A non-fullscreen tab strip inside a window (unlike `Entropy.UI.createTab`, which owns the
       * whole work area). You own which tab is selected: pass it as `selected`, update it in
       * `onSelect`, and draw only that tab's widgets after the bar. */
      tabBar: (windowId: string, config: TabBarConfig) => void;
      /** A drum-machine pad bank: rounded pads with a waveform thumbnail, colour accent, selection
       * ring and a glow the caller drives. See `PadGridConfig`. */
      padGrid: (windowId: string, config: PadGridConfig) => void;
      /** A wavetable as sculptable terrain, with a cycle strip, harmonics and a keyboard. */
      wavetable: (windowId: string, config: WavetableViewConfig) => void;
      /** A physically modeled bowed string, drawn the same neon-terrain way as `wavetable`. */
      physModString: (windowId: string, config: PhysModViewConfig) => void;
      /** A physically modeled brass instrument, drawn from its bore in the same neon style. */
      brass: (windowId: string, config: BrassViewConfig) => void;
      /** A physically modeled drum kit, drawn from the modes it rings with in the same neon style. */
      matter: (windowId: string, config: MatterViewConfig) => void;
      /** A triggered oscilloscope over `source` (`"master"` or a track id). */
      oscilloscope: (windowId: string, config: OscilloscopeConfig) => void;
      /** A log-frequency spectrum analyzer over `source`, with peak hold and a hover readout. */
      spectrum: (windowId: string, config: SpectrumConfig) => void;
      /** A stereo peak/RMS meter with peak hold and a click-to-clear clip latch. */
      levelMeter: (windowId: string, config: LevelMeterConfig) => void;
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
    setSpeed: (handle: string, speed: number) => void;
    readSubtitles: (path: string) => string;
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
      dataset: "xor" | "and" | "two_moons";
      epochs?: number;
      lr?: number;
      /** Seeds Burn initialization and built-in dataset generation for reproducible runs. */
      seed?: number;
    }) => void;
    poll: (id: string) => Array<{ epoch: number; totalEpochs: number; loss: number; done: boolean; accuracy?: number }>;
    trainArchitecture: (id: string, config: {
      graph: { name: string; nodes: Array<{ id: string; kind: string; position: [number, number]; config: Record<string, number | string> }>; links: Array<{ from: string; output: string; to: string; input: string }> };
      task: "npc" | "pet" | "mini_pic"; epochs?: number; lr?: number; seed?: number;
    }) => void;
    pollArchitecture: (id: string) => Array<{ epoch: number; totalEpochs: number; loss: number; done: boolean; accuracy?: number; error?: string }>;
  };
  IO: {
    /** Persists this addon's JSON state. Pass `{ pretty: true }` for a human-maintained file. */
    save: (data: any, options?: { pretty?: boolean }) => void;
    saveImage: (filename: string, width: number, height: number, data: number[] | Uint8Array) => void;
    listModels: () => Promise<string[]>;
    pickAndImportModel: () => Promise<string>;
    /** The user's Music folder, or null if the OS has none. Also allows `listDir` under it. */
    musicDir: () => string | null;
    /** A native folder dialog; the chosen folder becomes readable by `listDir`. Null if cancelled. */
    pickSampleFolder: () => string | null;
    /** Folders first, then audio files, directly inside `path`. Read-only, and refused outside the
     * Music folder and folders chosen with `pickSampleFolder`. */
    listDir: (path: string) => ListDirResult;
    load: () => any;
    /** This addon's own document store, `<dataDir>/<addon name>/...` - for an app that keeps many
     * files (the DAW's song library and version history), where `save`/`load` give it only one.
     * Paths are relative and made of `[A-Za-z0-9_.-]` segments separated by `/` (no leading dots,
     * no `..`); anything else throws. Writes are atomic: a crash mid-write leaves the previous file.
     * Every call throws when the app has no data folder (`EntropyApp::with_data_dir`). */
    store: AddonStore;
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
export interface AddonStoreEntry {
  name: string;
  isDir: boolean;
  /** Bytes; 0 for a folder. */
  size: number;
  /** Last modification, ms since the Unix epoch. */
  modifiedMs: number;
}

export interface AddonStore {
  /** The file's text, or null if there is no such file. */
  read: (path: string) => string | null;
  /** Creates or atomically replaces the file, creating missing folders. */
  write: (path: string, text: string) => void;
  /** Folders first, then files, directly inside `path` ("" for the top). A missing folder is empty. */
  list: (path?: string) => AddonStoreEntry[];
  /** Removes a file, or a folder and everything in it. True if anything was there. */
  remove: (path: string) => boolean;
}

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
  // Paint a blurred copy of the frame behind this window instead of the theme's opaque window
  // fill. Only has a backdrop to sample when the host app opted into the blur pass with
  // `EntropyApp::with_glass_blur(true)` (see src/bin/example.rs's "app-launcher").
  glass?: boolean;
  // `false` strips the title bar, outer border stroke, resize handle and close button, leaving
  // only the rounded background - a plain floating card for a home-screen-style panel. It also
  // stops dragging (there is no title bar left to grab), so pair it with a fixed/centered
  // `default_pos` (or leave x/y unset to center). Default `true`.
  decorations?: boolean;
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
  // Overrides the default 14px label font - e.g. a big icon glyph on a launcher tile.
  fontSize?: number;
  // Multiplies the drawn text's alpha, 0-1 (default 1). For a caller-driven fade animation -
  // there is no engine-side tweening, so re-supply a new value every frame.
  alpha?: number;
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
    // Stable widget id across re-renders, same convention as ButtonConfig.id - falls back to
    // deriving one from `label` when omitted. Already read at runtime (src/deno/addon_setup.js's
    // Widget.colorInput: `config?.id`) but never declared here before.
    id?: string;
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

/** A rotary drag-to-adjust control - the circular counterpart to `slider`. Drag vertically (up
 *  raises the value, down lowers it); there is no fixed track to click a position on, so unlike
 *  `slider` a click alone does not move it. Label and value are drawn on the knob itself. */
export interface KnobConfig {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange?: (value: string) => void;
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
  /** See `PlayNoteOnTrackConfig`. */
  filterEnv?: number;
  filterDecay?: number;
  drive?: number;
  /** Routes the note through a `TrackBusRenderConfig` of this name. */
  track?: string;
}

export interface RenderPatternWavResult {
  success: boolean;
  /** Absolute path of the written WAV file, if `success`. */
  path?: string;
  /** Rendered file duration in seconds (includes any delay/reverb tail past the last note). */
  durationSeconds: number;
  /** Set when `success` is false - e.g. the user cancelled the save dialog. */
  error?: string;
  /** One message per VST3 track that could not be rendered (bad path, state that would not
   * load) - the rest of the export still succeeds without it. */
  vst3Warnings: string[];
}

/** One scheduled note for a VST3 track in an offline render - see `Audio.renderPatternToWav`. */
export interface Vst3RenderNoteConfig {
  /** Seconds from the start of the render. */
  startTime: number;
  /** Seconds until the note-off. */
  duration: number;
  /** 0-127. */
  note: number;
  /** 0-127, default 100. */
  velocity?: number;
  /** 0-15, default 0. */
  channel?: number;
}

/** A VST3-hosted track's notes for an offline render - see `Audio.renderPatternToWav`. Rendered
 * through its own fresh, temporary plugin instance, separate from whatever the same plugin has
 * loaded live on the track's bus. */
export interface Vst3RenderTrackConfig {
  /** A `.vst3` path, as returned by `Vst3.scan` or stored on the track's instrument. */
  path: string;
  /** Routes the rendered plugin through a `TrackBusRenderConfig` of this name. */
  track?: string;
  /** Base64 from `Vst3.saveState`/`Vst3.pollState`; omit to render the plugin's default patch. */
  state?: string | null;
  notes: Vst3RenderNoteConfig[];
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

/** One audio input device, from `Guitar.listInputs`. */
interface GuitarInputDevice {
  host: string;
  name: string;
  channels: number;
  defaultSampleRate: number;
  isDefault: boolean;
}

/** Settings that can change while the guitar input is running. Anything left out keeps its value. */
interface GuitarSettings {
  /** How much latency to trade for stability. */
  mode?: "fast" | "balanced" | "accurate";
  /** 0..1, 0.5 neutral. Higher accepts less certain pitches and smaller picks. */
  sensitivity?: number;
  /** dBFS of the 15 ms RMS. The gate opens above `gateOpenDb` and closes below `gateCloseDb`. */
  gateOpenDb?: number;
  gateCloseDb?: number;
  /** Pitch-bend range in semitones each way, 1-12. A VST3 instrument must be set to the same range. */
  bendRange?: number;
  /** A4 in Hz. */
  referencePitch?: number;
  inputGainDb?: number;
  onsetDb?: number;
  velocityFloorDb?: number;
  velocityCeilDb?: number;
  velocityGamma?: number;
}

/** "wavetable" plays a table (see `Wavetable`) that can be sculpted while it sounds. */
type GuitarWaveform = "sine" | "triangle" | "saw" | "square" | "wavetable";

interface GuitarStartConfig extends GuitarSettings {
  /** Host name from `listInputs` (WASAPI by default on Windows; ASIO with the `asio` cargo feature). */
  host?: string;
  device?: string;
  /** Zero-based input channel to read as the guitar. */
  channel?: number;
  /** Default 48000. The driver may run at another rate; see `opened.notes`. */
  sampleRate?: number;
  /** Default 128. The driver may not honor it; see `opened.bufferFrames` and `opened.notes`. */
  bufferFrames?: number;
  /** Play the built-in voice on this track's bus (the bus must exist). */
  trackId?: string;
  waveform?: GuitarWaveform;
  /** The sound of the "wavetable" voice: a note config as for `Audio.wavetableNoteOn`, whose `table` is
   * the table to read. Pitch and velocity come from the string. */
  wavetable?: WavetableNoteConfig;
  /** Play the VST3 instrument hosted on this track, on MIDI channel `vst3Channel` (0-15). */
  vst3Track?: string;
  vst3Channel?: number;
}

interface GuitarOpened {
  host: string;
  device: string;
  sampleRate: number;
  channels: number;
  /** null when the driver chose its own buffer size. */
  bufferFrames: number | null;
  sampleFormat: string;
  /** Anything asked for that the driver would not do, and what it did instead. */
  notes: string[];
}

interface GuitarDiagnostics {
  levelDb: number;
  /** Input peak since the previous status call. */
  inputPeakDb: number;
  /** Latched when the input reached -1 dBFS. */
  clipped: boolean;
  freqHz: number;
  confidence: number;
  /** MIDI note number while a note sounds. */
  note: number | null;
  /** Cents from the note's center, or from the nearest note when none sounds. */
  cents: number;
  state: "silent" | "attack" | "playing" | "release";
  velocity: number;
  /** 14-bit, 8192 is center. */
  bend: number;
  /** Pick to Note On inside the engine for the last note. The device's own buffers are extra. */
  pipelineLatencyMs: number;
  /** One input buffer. */
  bufferMs: number;
  bufferFrames: number;
  sampleRate: number;
  callbacks: number;
  /** Callbacks whose work took longer than the audio they covered. */
  overruns: number;
  /** Errors the audio backend reported, xruns among them. */
  streamErrors: number;
  maxCallbackUs: number;
  meanCallbackUs: number;
  droppedBends: number;
  /** Note events that did not fit the queue. Should stay 0. */
  droppedEvents: number;
  notes: number;
  noiseRejects: number;
  octaveRejects: number;
  octaveCorrections: number;
  slides: number;
  repicks: number;
}

interface GuitarStatus {
  running: boolean;
  deviceLost?: boolean;
  opened?: GuitarOpened;
  recording?: boolean;
  /** Set when the driver's real callback size differs from what was asked for (WASAPI shared mode runs
   * on its own 10 ms period whatever the request says). */
  bufferNote?: string | null;
  calibration?: { state: string; busy: boolean; finished: "room" | "playing" | "failed" | null };
  settings?: Required<Pick<GuitarSettings, "mode" | "sensitivity" | "gateOpenDb" | "gateCloseDb" | "bendRange" | "referencePitch" | "inputGainDb" | "velocityFloorDb" | "velocityCeilDb">>;
  diagnostics?: GuitarDiagnostics;
}

/** One note of a recorded take. Times are seconds from `record("start")` and already corrected for
 * detection latency; `bends` are `[seconds, cents from the note]`. */
interface GuitarRecordedNote {
  note: number;
  velocity: number;
  startS: number;
  endS: number;
  bends: [number, number][];
}

/** Guitar-to-MIDI: a real-time monophonic pitch tracker on an audio input (see GUITAR_TO_MIDI.md).
 * Notes play the built-in voice on a track and/or a hosted VST3 instrument. Calls report failure as
 * `{ ok: false, error }` rather than throwing. */
interface GuitarAPI {
  listInputs: () => { devices: GuitarInputDevice[]; hosts: string[] };
  start: (config?: GuitarStartConfig) => { ok: boolean; error?: string; opened?: GuitarOpened };
  stop: () => { ok: boolean };
  set: (settings: GuitarSettings) => { ok: boolean; error?: string };
  /** An empty `trackId` or `vst3Track` switches that output off. Pointing at a wavetable voice again
   * (after the table's settings change) starts a fresh voice; the table itself is always read live. */
  target: (target: { trackId?: string; waveform?: GuitarWaveform; wavetable?: WavetableNoteConfig; vst3Track?: string; vst3Channel?: number }) => { ok: boolean; error?: string };
  /** Moves the wavetable voice through its table (0..1), a sounding note included. */
  setPosition: (position: number) => void;
  status: () => GuitarStatus;
  /** `playing = false` listens to the room (default 3 s) and sets the gate; `playing = true` listens to
   * soft and hard notes (default 5 s) and sets the velocity range. */
  calibrate: (playing: boolean, seconds?: number) => { ok: boolean; error?: string };
  record: (action: "start" | "stop") => { ok: boolean; error?: string; notes?: GuitarRecordedNote[] };
  releaseAll: () => { ok: boolean };
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
  /** Built-in oscillators only: octaves above `cutoff` the filter opens at the note's start. 0 = static. */
  filterEnv?: number;
  /** Time constant (s) of the filter envelope's fall back to `cutoff`. Default 0.2. */
  filterDecay?: number;
  /** tanh drive after the filter, 1 (clean, default) and up. */
  drive?: number;
}

/** A character effect for a track bus - see `AudioEffect.createCharacter`.
 * - `pump`: beat-synced ducking; `amount` is depth and length of the duck.
 * - `gate`: rhythmic chopping; `amount` is depth, `pattern` 0 = eighths, 1 = sixteenths, 2 = syncopated.
 * - `grit`: saturation turning into bit/sample-rate reduction, loudness-compensated.
 * - `space`: close and dry (0) to distant and washed out (1).
 * - `fader`: a declicked gain that moves to `amount` (a hard cut is amount 0). */
export interface CharacterEffectConfig {
  kind: "pump" | "gate" | "grit" | "space" | "fader";
  amount: number;
  pattern?: number;
  /** Tempo for pump and gate. Default 120. */
  bpm?: number;
  /** Puts pump/gate's bar clock at this many beats into the bar (0..4). Omit to leave it running. */
  beat?: number | null;
}

/** A track bus in an offline render (`Audio.renderPatternToWav`'s last argument): every event
 * whose `track` is this one is summed, run through `effects`, scaled by `gain` (apply the track's
 * gain here rather than folding it into each event) and silenced over `silences` (seconds). */
export interface TrackBusRenderConfig {
  track: string;
  gain?: number;
  effects?: CharacterEffectConfig[];
  silences?: [number, number][];
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

/** One cell of a `Widget.sheetGrid` - only cells with content or a border need an entry; the
 * grid's own `options.rows`/`options.cols` set its shape. */
export interface SheetCellConfig {
  row: number;
  col: number;
  text: string;
  /** Right-aligned like a number; left-aligned otherwise. */
  numeric?: boolean;
  /** [r, g, b, a] in 0-1 - an outline drawn around the whole cell, for marking which data
   * belongs to which axis of a chart or otherwise grouping cells visually. */
  border?: [number, number, number, number];
  /** Draws `text` in an error color instead of the normal one (a failed formula). */
  error?: boolean;
}

export interface SheetGridOptions {
  rows?: number;
  cols?: number;
  colWidth?: number;
  rowHeight?: number;
  /** Caps the grid at this height and scrolls the rows inside it; the column header row stays
   * fixed above the scroll region. Omit to size the grid to fit every row. */
  maxHeight?: number;
}

export interface SheetGridConfig {
  id?: string;
  cells?: SheetCellConfig[];
  selected?: { row: number; col: number };
  /** The cell currently being edited and its live draft text - see `onEditStarted`/
   * `onEditChanged` below. Pass the same cell your own formula bar is targeting if the user is
   * typing there instead of in the grid directly, so Enter/Tab/Escape and click-away-commits
   * behave the same regardless of which field the user actually typed into. */
  editing?: { row: number; col: number; value: string };
  options?: SheetGridOptions;
  /** Fired on a cell click, or on arrow-key/Tab/Enter navigation while a cell is already
   * selected. Use it both for selection and to re-target your own formula bar. */
  onCellSelected?: (row: number, col: number) => void;
  /** Fired on Delete/Backspace while a cell is selected and not being edited - clear its content. */
  onCellClear?: (row: number, col: number) => void;
  /** A double-click, or typing while a cell is selected and no other field has focus, asks to
   * start an edit session. `initial` is "" for a double-click (edit the existing content - load
   * it into `editing.value` yourself) or the just-typed character(s) for type-to-replace. */
  onEditStarted?: (row: number, col: number, initial: string) => void;
  /** The in-progress edit's text changed (typed into the grid's own inline box) - update
   * whatever draft state you pass back as `editing.value`. */
  onEditChanged?: (row: number, col: number, text: string) => void;
  /** Enter, Tab, or clicking a different cell while editing - write your current draft into the
   * cell and clear `editing`. */
  onEditCommitted?: (row: number, col: number) => void;
  /** Escape while editing - discard the draft and clear `editing`; the cell is untouched. */
  onEditCancelled?: (row: number, col: number) => void;
  /** A row header's context menu asked for a new row inserted at this index (existing rows at
   * and after it should shift down by one). */
  onInsertRow?: (row: number) => void;
  onDeleteRow?: (row: number) => void;
  /** A column header's context menu asked for a new column inserted at this index (existing
   * columns at and after it should shift right by one). */
  onInsertColumn?: (col: number) => void;
  onDeleteColumn?: (col: number) => void;
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
  /** A short glyph drawn before the label (a folder or file marker). */
  icon?: string;
  /** Dim right-aligned text on the row, such as a count or a duration. */
  detail?: string;
}

export interface TabBarConfig {
  /** Stable id for scripted/BDD control; defaults to one derived from draw order. */
  id?: string;
  tabs: { id: string; label: string }[];
  /** The id of the selected tab. */
  selected: string;
  /** Fired with the new tab's id when a tab other than the selected one is clicked. */
  onSelect?: (id: string) => void;
}

export interface TreeViewConfig {
  id?: string;
  nodes?: TreeNodeConfig[];
  /** Caps the tree at this many points and scrolls the rows inside it. Omit for a tree exactly as
   * tall as its rows. */
  maxHeight?: number;
  /** A fixed width in points instead of filling the row. */
  width?: number;
  /** Fired when a row's label is clicked. */
  onSelect?: (id: string) => void;
  /** Fired when a row's disclosure triangle is clicked. Apply this to whatever expanded-set
   * you own; the widget keeps no collapsed-state memory of its own between frames. */
  onToggleExpand?: (id: string) => void;
  /** Fired when a row's checkbox is clicked, carrying its new (post-click) value. */
  onMark?: (id: string, value: boolean) => void;
}

/** How one sample hit plays. */
export interface SampleParams {
  /** Linear gain, default 1. */
  gain?: number;
  /** Pitch shift in semitones by playback rate (it changes the length too), -24..24, default 0. */
  semitones?: number;
  /** Start and end of the played part as fractions of the decoded sample, default 0 and 1. */
  start?: number;
  end?: number;
  /** Seconds to play before fading out. Omit to play the whole trimmed region (a one-shot). */
  hold?: number;
}

export interface SampleResult {
  ok: boolean;
  error?: string | null;
}

/** What `Audio.loadSample` returns. */
export interface SampleInfo {
  ok: boolean;
  error?: string | null;
  /** Length of what was decoded. */
  seconds: number;
  /** Length of the whole file, when the decoder knows it. */
  fullSeconds?: number | null;
  /** The file was longer than 12 seconds and only its start was decoded. */
  truncated: boolean;
  sourceRate: number;
  channels: number;
  /** Loudest sample, linear. */
  peak: number;
  /** Peak envelope scaled to 0..1, for a thumbnail. */
  waveform: number[];
}

/** One sample hit in an offline render - see `Audio.renderPatternToWav`. */
export interface SampleEvent extends SampleParams {
  /** Seconds from the start of the render. */
  startTime: number;
  path: string;
  /** Routes the hit through a `TrackBusRenderConfig` of this name. */
  track?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  /** Audio files directly inside (folders only). */
  audioCount: number;
  /** Sub-folders directly inside (folders only). */
  dirCount: number;
}

export interface ListDirResult {
  ok: boolean;
  error?: string | null;
  entries: DirEntry[];
}

/** One pad of `Widget.padGrid`. */
export interface PadConfig {
  /** Unique within the grid. */
  id: string;
  label: string;
  /** The second line, usually the file name. */
  sublabel?: string;
  /** A small tag in the top-right corner, such as the MIDI note the pad answers to. */
  hint?: string;
  /** [r, g, b, a] in 0..1. */
  color?: [number, number, number, number];
  /** "empty" (default): a faint +. "synth": a built-in voice. "sample": draws `waveform`.
   * "missing": an assigned file that is gone, in a warning tint. */
  kind?: "empty" | "synth" | "sample" | "missing";
  /** Peak envelope, 0..1 per bin. */
  waveform?: number[];
  /** [start, end] as fractions of the waveform: the part outside is dimmed. */
  trim?: [number, number];
  selected?: boolean;
  /** 0..1, how lit the pad is right now. The caller decays it; the widget keeps no time. */
  glow?: number;
}

export interface PadGridConfig {
  id?: string;
  pads: PadConfig[];
  columns?: number;
  padWidth?: number;
  padHeight?: number;
  /** Draw a "+ Add pad" tile after the last pad. */
  addTile?: boolean;
  /** A pad was clicked: select it, play it, or put whatever is armed on it. */
  onPadClick?: (padId: string) => void;
  /** A pad was right-clicked: take its sound off. */
  onPadClear?: (padId: string) => void;
  onAdd?: () => void;
}

export interface WavetableViewConfig {
  id?: string;
  /** The table to show and edit (`Wavetable.ensure` makes it; it is created if missing). */
  table: string;
  /** "raise" (default), "lower", "smooth", "level" or "orbit". You own this; `onTool` says when the user picks another. */
  tool?: string;
  /** Brush radius in world units, 0.04 to 0.6. */
  radius?: number;
  /** 0..1. */
  strength?: number;
  /** The selected frame, 0-based. You own this; `onFrame` says when the user picks another. */
  frame?: number;
  height?: number;
  width?: number;
  /** Show the on-screen keyboard. Default true. */
  keyboard?: boolean;
  /** MIDI note of the keyboard's first key (a C). Default 48. */
  firstKey?: number;
  octaves?: number;
  /** Notes to draw as held, beyond the one the pointer is pressing. */
  held?: number[];
  /** A stroke ended, or undo/redo ran: the table changed for good, so save it now. */
  onEdit?: () => void;
  onStrokeStart?: () => void;
  onStrokeEnd?: () => void;
  onFrame?: (frame: number) => void;
  onTool?: (tool: string) => void;
  onKeyDown?: (midi: number, velocity: number) => void;
  onKeyUp?: (midi: number) => void;
}

export interface WavetableOk { ok: boolean; error?: string }

export interface WavetableInfo extends WavetableOk {
  id?: string;
  frames?: number;
  tableSize?: number;
  revision?: number;
  version?: number;
  canUndo?: boolean;
  canRedo?: boolean;
  /** Where the sounding note is reading (0..1 across the frames) and how loud it is; null when silent. */
  activity?: { position: number; energy: number } | null;
  activeVoices?: number;
}

export interface WavetableStamp {
  tool: "raise" | "lower" | "smooth" | "level";
  /** Fractional frame, 0-based. */
  frame: number;
  /** Cycles, 0..1 (wraps around the cycle edge). */
  phase: number;
  /** World units; default 0.16. */
  radius?: number;
  /** 1 is round; more stretches the dab along `angle`. */
  aspect?: number;
  angle?: number;
  /** 0.3 is a firm dab; 1 or more saturates. */
  amount?: number;
  /** The height `level` pulls toward, -1..1. */
  target?: number;
}

/** A wavetable note. Anything left out takes its default. */
export interface WavetableNoteConfig {
  table: string;
  freq?: number;
  velocity?: number;
  gain?: number;
  /** Where in the table the note rests, 0..1 across the frames. */
  position?: number;
  lfoRate?: number;
  /** How far the LFO sweeps the position, as a fraction of the table. */
  lfoDepth?: number;
  /** Added to the position at note-on, falling away over `sweepTime` seconds. */
  sweep?: number;
  sweepTime?: number;
  velToPosition?: number;
  /** 1 to 7 voices. */
  unison?: number;
  detuneCents?: number;
  spread?: number;
  cutoff?: number;
  resonance?: number;
  attack?: number;
  decay?: number;
  sustain?: number;
  release?: number;
  /** Seconds to hold before releasing (timed notes). */
  duration?: number;
  /** Offline renders only: seconds from the start. */
  startTime?: number;
}

import type { IconName } from "./icon_names";
export type { IconName };

export type IconStyle = "regular" | "bold" | "fill";

/** Phosphor icons as characters. Put the string in any label: `W.button(h, { text: Icons.label("play", "Play") })`,
 * or `text: Icons.get("play")` for an icon-only button. Each weight is drawn by the same widgets with no
 * extra option. An unknown name logs once and returns "". */
/** Starting another Entropy example app as its own OS process. The only program it can ever run is
 * this same executable, with one of Entropy's `LAUNCHABLE_EXAMPLES` names as its only argument. */
export interface SystemAPI {
  /** Starts `name` as a new process and returns its pid. Throws if `name` is not a launchable
   * example. The pid is the only handle - nothing here can poll, wait on or close the child. */
  launchExample: (name: string) => number;
}

export interface IconsAPI {
  /** The character that draws `name` (default style "regular"). Known limit: "bold" and "fill" take space but draw blank in the real window, so use "regular". */
  get: (name: IconName, style?: IconStyle) => string;
  /** "<icon> <text>" */
  label: (name: IconName, text: string, style?: IconStyle) => string;
  has: (name: string) => boolean;
  /** Every icon name, sorted. */
  names: () => string[];
}

export interface WavetableAPI {
  /** Creates the table if missing (a stack of sines); `preset` replaces its contents. */
  ensure: (id: string, options?: { preset?: string; frames?: number }) => WavetableInfo;
  presets: string[];
  remove: (id: string) => boolean;
  info: (id: string) => WavetableInfo;
  /** "normalize", "smooth", "invert", "reverse", "flip_frames", "randomize", "undo", "redo". */
  op: (id: string, name: string, arg?: number) => WavetableInfo;
  /** Brush dabs as one undo step: the same brush the editor uses. */
  stamp: (id: string, stamps: WavetableStamp[]) => WavetableInfo & { touchedFrames?: [number, number] | null };
  setFrame: (id: string, frame: number, samples: number[]) => WavetableInfo;
  exportData: (id: string) => string | null;
  importData: (id: string, data: string) => WavetableInfo;
  harmonics: (id: string, frame?: number, count?: number) => WavetableOk & { frame?: number; harmonics?: number[]; peak?: number; rms?: number };
  /** Plays a note offline and reads it back; no audio device involved. */
  analyzeNote: (config: WavetableNoteConfig, seconds?: number) => WavetableOk & { seconds?: number; peakDb?: number; rmsDb?: number; peakHz?: number; centroidHz?: number };
}

export interface BrassViewConfig {
  id?: string;
  /** The player in the brass registry (`Entropy.Brass`) to show and drive. */
  instrument: string;
  height?: number;
  width?: number;
  /** Breath (0..1) and lip tension (-1..1), shown on the playing map before a note sounds. */
  breath?: number;
  lipTension?: number;
  /** Show the Physics View overlays: the pressure wave and standing wave along the bore, the
   * resonance ladder, the playing map (draggable) and one period of mouthpiece pressure and lips. */
  physicsView?: boolean;
  exaggeration?: number;
  keyboard?: boolean;
  /** MIDI note of the keyboard's first key. Default 40 (E2). */
  firstKey?: number;
  octaves?: number;
  held?: number[];
  onKeyDown?: (midi: number, velocity: number) => void;
  onKeyUp?: (midi: number) => void;
  /** The slide was dragged: the slide position (1 = closed .. 7) asked for. */
  onSlideDrag?: (position: number) => void;
  /** A drag in the playing map: breath (0..1) and lip tension (-1..1). */
  onPlayDrag?: (breath: number, lipTension: number) => void;
  onPhysicsView?: (on: boolean) => void;
}

export interface PhysModViewConfig {
  id?: string;
  /** The instrument in the bowed-string registry (`Entropy.PhysMod`) to show and drive - there is
   * nothing to create ahead of time, unlike a wavetable's table. */
  instrument: string;
  height?: number;
  width?: number;
  /** The bow's current position (0.02..0.5) and force (0..1), so a knob and the widget agree on
   * where the bow is even before a note has published anything. You own these; `onBowDrag` says
   * when the user drags the bow to somewhere else. */
  bowPosition?: number;
  bowForce?: number;
  /** Instrument size (0 violin .. 1 bass, beyond is the laboratory); scales the drawn body. */
  bodySize?: number;
  /** Which string to put the bow on before anything has sounded (after that the view follows the
   * engine's own choice of string). */
  activeString?: number;
  /** Show the Physics View overlays: standing-wave envelopes and nodes, the travelling Helmholtz
   * corner, the playable-window (Schelleng) diagram - draggable, like the bow - and body mode levels. */
  physicsView?: boolean;
  /** Extra visual exaggeration of string motion, 1 = default. */
  exaggeration?: number;
  /** Show the on-screen keyboard. Default true. */
  keyboard?: boolean;
  /** MIDI note of the keyboard's first key (a C). Default 48. */
  firstKey?: number;
  octaves?: number;
  /** Notes to draw as held, beyond the one the pointer is pressing. */
  held?: number[];
  /** A drag inside the bowing zone moved the bow: `position` is already in the 0.02..0.5 range
   * `PhysModNoteConfig.bowPosition` expects. */
  onBowDrag?: (position: number, force: number) => void;
  onKeyDown?: (midi: number, velocity: number) => void;
  onKeyUp?: (midi: number) => void;
  /** The PHYSICS chip in the view was clicked. */
  onPhysicsView?: (on: boolean) => void;
}

export interface PhysModOk { ok: boolean; error?: string }

/** What the bow is doing to a string: clean Helmholtz motion, surface sound (too little force for
 * the bow position), raucous (too much), or nothing (bow off). */
export type PhysModRegime = "helmholtz" | "surfaceSound" | "raucous" | "free";

export interface PhysModStringInfo {
  openHz: number;
  /** The pitch the finger is stopping. */
  hz: number;
  /** Finger position as a fraction of the open string from the nut (0 = open). */
  finger: number;
  bowPosition: number;
  level: number;
  bowForceN: number;
  bowSpeed: number;
  /** The playable window for the current bow speed and position, newtons. */
  forceMinN: number;
  forceMaxN: number;
  stickFraction: number;
  slipsPerPeriod: number;
  regime: PhysModRegime;
  sympathetic: boolean;
  playing: boolean;
}

export interface PhysModInfo extends PhysModOk {
  id?: string;
  activeVoices?: number;
  /** The bow's current state and how loud the voices on this instrument are; null when silent. */
  activity?: { bowPosition: number; bowForce: number; bowVelocity: number; energy: number } | null;
  activeString?: number | null;
  strings?: PhysModStringInfo[];
  /** The body's coupled modes: frequency and how hard each is ringing. */
  bodyModes?: { hz: number; level: number }[];
}

export interface PhysModNoteAnalysis extends PhysModOk {
  seconds?: number;
  peakDb?: number;
  rmsDb?: number;
  /** Same as pitchHz (kept for callers of the first version). */
  peakHz?: number;
  pitchHz?: number;
  /** Measured pitch against the requested one, cents. */
  centsOff?: number;
  centroidHz?: number;
  /** Harmonics 1..16 relative to the strongest, dB. */
  harmonicsDb?: number[];
  string?: number;
  regime?: PhysModRegime | null;
  slipsPerPeriod?: number;
  stickFraction?: number;
  /** Seconds until the stroke settled into Helmholtz motion; null if it never did. */
  attackSeconds?: number | null;
}

/** A bowed-string note. Anything left out takes its default. */
export interface PhysModNoteConfig {
  instrument: string;
  freq?: number;
  velocity?: number;
  gain?: number;
  /** 0..1, logarithmic bow force (0.5 a normal force). Too little for the bow position gives airy
   * "surface sound", too much a raucous crunch - Schelleng's playable window, from the friction
   * physics. */
  bowForce?: number;
  /** 0..1, logarithmic bow speed (0.5 is ~0.15 m/s). */
  bowVelocity?: number;
  /** 0.02..0.5, fraction of the vibrating length from the bridge. Near the bridge is brighter and
   * needs more force; toward the fingerboard is soft. */
  bowPosition?: number;
  articulation?: "arco" | "pizzicato" | "colLegno";
  /** 0..1, how cleanly a stroke starts. */
  attackSkill?: number;
  vibratoRate?: number;
  /** Cents. */
  vibratoDepth?: number;
  /** Seconds before vibrato fades in. */
  vibratoDelay?: number;
  /** Seconds for a slurred note's finger to slide. */
  slide?: number;
  /** 0..1, extra damping on the strings (a left-hand mute). */
  damping?: number;
  /** 0..1, string material: dark gut to bright steel. */
  brightness?: number;
  /** 0..1, how freely a released note rings on. */
  ring?: number;
  /** Open-string pitches, low to high (up to 4). Omitted: a violin. */
  strings?: number[];
  /** Unbowed strings ringing in sympathy (up to 6). */
  sympathetic?: number[];
  /** 0..1 each: string weight, bending stiffness, rosin grip, bow-hair grit. */
  stringMass?: number;
  stiffness?: number;
  rosin?: number;
  bowNoise?: number;
  /** Instrument size: 0 violin, 0.13 viola, 0.72 cello, 1 bass; -1..2.5 allowed. */
  bodySize?: number;
  /** 0..1, how much of the body's radiated sound versus the bare string. */
  bodyMix?: number;
  /** 0..1, body mode Q. */
  bodyResonance?: number;
  /** 0..1, bridge coupling (0.35 normal): sympathetic ringing, and wolf notes when high. */
  coupling?: number;
  /** Picks the body's high-frequency modes (a different maker). */
  bodySeed?: number;
  attack?: number;
  release?: number;
  /** Seconds to hold before releasing (timed notes). */
  duration?: number;
  /** Offline renders only: seconds from the start. */
  startTime?: number;
}

export interface BrassOk { ok: boolean; error?: string }

export type BrassInstrumentName = "trombone" | "trumpet" | "horn" | "tuba";
export type BrassMute = "open" | "straight" | "cup" | "harmon";
export type BrassArticulation = "tongued" | "legato" | "glissando";

/** A physically modeled brass note (see `Entropy.Brass`). Anything left out keeps its default. */
export interface BrassNoteConfig {
  trackId?: string;
  /** The player id a widget reads; defaults to `trackId`. */
  instrumentId?: string;
  /** A `BrassInstrumentName` ("trombone", "trumpet", "horn", "tuba"); an unknown name plays the
   *  trombone. */
  instrument?: string;
  freq?: number;
  /** 0..1, MIDI velocity read as dynamics (moves the breath around `breath`). */
  velocity?: number;
  gain?: number;
  /** 0..1: mouth pressure, log from 0.5 kPa to 16 kPa; 0.5 is a comfortable mezzo. Past a few kPa
   *  the wave in the bore steepens and the tone turns brassy. */
  breath?: number;
  /** -1..1: lips looser (falls to the partial below) or tighter (pops to the one above). */
  lipTension?: number;
  /** 0..1: rest opening of the lips; small is focused, large airy. */
  aperture?: number;
  vibratoRate?: number;
  /** Cents (slide vibrato on the trombone). */
  vibratoDepth?: number;
  vibratoDelay?: number;
  /** Seconds for the tongue to release: a few ms is "ta", tens of ms "da". */
  attack?: number;
  release?: number;
  duration?: number;
  articulation?: BrassArticulation;
  /** 0..1: at 1 notes speak at once; lower, slower blooms and cracked high notes. */
  attackSkill?: number;
  breathNoise?: number;
  /** Seconds for the slide to travel to a new position. */
  slideTime?: number;
  /** 0..4: the air's nonlinearity (1 is real air; 0 removes brassiness). */
  brassiness?: number;
  /** A mute in the bell: it narrows the bell (moving the resonances, as a real mute does) and its
   *  body colours the sound. */
  mute?: BrassMute;
  /** 0..1: how far the player's hand is in the bell; 1 stops it (the horn's stopped note, a
   *  semitone up and brassy). Omitted, the instrument's usual hand (the horn's is in the bell). */
  hand?: number;
  /** 0 (the bell pointing away from the listener) .. 1 (straight at them): pointed at the listener
   *  the tone is brighter. Omitted, the instrument's usual way (the horn's faces away). */
  bellFacing?: number;
  /** Offline events only: seconds from the start of the render. */
  startTime?: number;
}

export interface BrassResonance { partial: number; hz: number; impedance: number }

export interface BrassInfo extends BrassOk {
  id?: string;
  instrument?: BrassInstrumentName;
  activeVoices?: number;
  playing?: boolean;
  partial?: number;
  /** Slide position, 1 (closed) to 7. */
  position?: number;
  slideExtension?: number;
  mouthPressurePa?: number;
  breath?: number;
  lipTension?: number;
  lipHz?: number;
  lipOpeningMm?: number;
  targetHz?: number;
  resonanceHz?: number;
  soundingHz?: number;
  waveSteepness?: number;
  mouthpieceLevelPa?: number;
  /** Valves held down (1-based), and the double horn's thumb valve (the F side). */
  valves?: number[];
  fSide?: boolean;
  mute?: BrassMute;
  hand?: number;
  bellFacing?: number;
  resonances?: BrassResonance[];
}

export interface BrassNoteAnalysis extends BrassOk {
  seconds?: number;
  peakDb?: number;
  rmsDb?: number;
  pitchHz?: number;
  centsOff?: number;
  centroidHz?: number;
  harmonicsDb?: number[];
  partial?: number;
  position?: number;
  valves?: number[];
  fSide?: boolean;
  mouthPressurePa?: number;
  mouthpieceLevelPa?: number;
  waveSteepness?: number;
  attackSeconds?: number | null;
}

export interface MatterOk { ok: boolean; error?: string }

export type MatterPiece = "kick" | "snare" | "rack-tom" | "floor-tom" | "crash" | "ride" | "splash";
export type MatterStriker = "stick" | "shoulder" | "felt" | "plastic" | "mallet" | "hard-mallet" | "yarn";
export type MatterStatus = "ready" | "building" | "rebuilding";

/** A drum kit as it is built: tunings and the settings that change the drums themselves. A change
 *  builds a new kit (the old one plays meanwhile). Anything left out keeps its default. */
export interface MatterKitConfig {
  /** Batter-head fundamentals, Hz (defaults 55, 220, 140, 82). */
  kick?: number;
  snare?: number;
  rackTom?: number;
  floorTom?: number;
  /** 0: an open kick; 1: a pillow against the batter. */
  kickMuffling?: number;
  snares?: boolean;
  /** How hard the strainer presses the snare wires, N (0.15 usual; looser buzzes longer). */
  snareTension?: number;
  /** Whether the pieces hear each other through the air (a tom sets the snare buzzing). */
  sympathetic?: boolean;
  /** The snare set up for brushes: its head carries every mode pair, so a swirl anywhere round it
   *  is heard as it goes (costs about half as much again to run). */
  brushes?: boolean;
}

/** What rubs in a stroke. */
export type MatterTool = "brush" | "finger" | "wet-finger" | "rubber" | "rod" | "stick-tip";

/** One hit on a kit (see `Entropy.Matter`). */
export interface MatterHitConfig {
  trackId?: string;
  /** Names the kit a widget reads. Defaults to `trackId`. */
  kitId?: string;
  kit?: MatterKitConfig;
  /** Each piece's level in the kit's mix, by piece (1 as it radiates). */
  mix?: Partial<Record<MatterPiece, number>>;
  piece?: MatterPiece;
  /** Speed of the stick at impact, m/s (a ghost note ~0.5, a loud backbeat 4-6). */
  speed?: number;
  /** 0 the centre, 1 the edge; `angle` around the head, radians. */
  position?: number;
  angle?: number;
  /** Omitted, what usually plays the piece. */
  striker?: MatterStriker;
  /** Offline events only: seconds from the start of the render. */
  startTime?: number;
  /** A stroke instead of a strike (not on the kick): `speed` is then the hand's speed (m/s). */
  stroke?: "sweep" | "swirl";
  /** How hard the tool presses, N (a brush ~0.5-1.5). */
  pressure?: number;
  /** How long the stroke lasts, s. */
  duration?: number;
  /** Omitted, a brush. */
  tool?: MatterTool;
}

/** A tool held on a piece live. */
export interface MatterHoldConfig {
  trackId?: string;
  kitId?: string;
  kit?: MatterKitConfig;
  piece?: MatterPiece;
  /** Where on the face, in fractions of its radius from the centre. */
  x?: number;
  y?: number;
  /** N; 0 lifts it. */
  pressure?: number;
}

export interface MatterPieceInfo {
  piece: MatterPiece;
  awake: boolean;
  energyJ: number;
  level: number;
  strikes: number;
  position: number;
  speedIn: number;
  speedOut: number;
  contactMs: number;
  peakForceN: number;
  mix: number;
  glideCents?: number;
  nonlinear?: boolean;
  wiresLifted?: number;
  wireLandings?: number;
  /** Strokes so far, whether a tool is on it now, and while it is: the hand's speed and pressure,
   *  the contact's normal and friction forces. */
  rubs?: number;
  rubbing?: boolean;
  rubSpeed?: number;
  rubPressureN?: number;
  rubNormalN?: number;
  rubFrictionN?: number;
  /** Share of the stroke's touching time the tips were stuck, and releases from stuck so far. */
  stickFraction?: number;
  releases?: number;
}

export interface MatterInfo extends MatterOk {
  id?: string;
  activeKits?: number;
  workers?: number;
  focus?: MatterPiece;
  kit?: Required<MatterKitConfig>;
  pieces?: MatterPieceInfo[];
}

export interface MatterHitAnalysis extends MatterOk {
  piece?: MatterPiece;
  striker?: MatterStriker | "custom";
  speed?: number;
  position?: number;
  seconds?: number;
  peakDb?: number;
  rmsDb?: number;
  centroidHz?: number;
  /** The crack: the share of the attack's energy above 4 kHz, dB. */
  above4kDb?: number;
  strongestHz?: number;
  /** Seconds to fall 40 dB below the peak. */
  decaySeconds?: number;
  contactMs?: number;
  peakForceN?: number;
  reboundSpeed?: number;
  glideCents?: number;
  wireLandings?: number;
}

export interface MatterStrokeAnalysis extends MatterOk {
  piece?: MatterPiece | "glass" | "steel-sheet";
  stroke?: "sweep" | "swirl";
  tool?: MatterTool | "custom";
  speed?: number;
  pressureN?: number;
  duration?: number;
  seconds?: number;
  peakDb?: number;
  rmsDb?: number;
  centroidHz?: number;
  above4kDb?: number;
  /** Spectral flatness 200 Hz-8 kHz: near 0 dB for noise-like sliding, far below for a squeak. */
  flatnessDb?: number;
  /** Share of the touching time the tips were stuck, and stick-to-slip releases per second. */
  stickFraction?: number;
  releasesPerSecond?: number;
  landings?: number;
}

export interface MatterAPI {
  info: (id: string) => MatterInfo;
  remove: (id: string) => boolean;
  /** Strikes one piece offline, alone (no audio device), and measures it. */
  analyzeHit: (config: MatterHitConfig, seconds?: number) => MatterHitAnalysis;
  /** Rubs one piece - or a pane of "glass" or a "steel-sheet" - offline, alone, and measures it. */
  analyzeStroke: (config: Omit<MatterHitConfig, "piece"> & { piece?: MatterPiece | "glass" | "steel-sheet"; stroke: "sweep" | "swirl" }, seconds?: number) => MatterStrokeAnalysis;
}

export interface MatterViewConfig {
  id?: string;
  /** The kit in the matter registry (`Entropy.Matter`) to show. */
  kit: string;
  height?: number;
  width?: number;
  /** Show the row of pads. Default true. */
  pads?: boolean;
  /** Show the Physics View overlays: the struck piece's modes, its contact force, the energy in
   *  each piece. */
  physicsView?: boolean;
  exaggeration?: number;
  /** A line shown over the kit (a kit being built, say). */
  status?: string;
  /** A head or cymbal was clicked: strike it there. */
  onStrike?: (piece: MatterPiece, position: number, angle: number, velocity: number) => void;
  onPad?: (piece: MatterPiece, velocity: number) => void;
  onPhysicsView?: (on: boolean) => void;
  /** A shift-drag on a head or cymbal: a tool held there (x, y in fractions of its radius), every
   *  frame of the drag, then once with pressure 0 when it is let go. */
  onRub?: (piece: MatterPiece, x: number, y: number, pressure: number) => void;
}

export interface BrassAPI {
  info: (id: string) => BrassInfo;
  remove: (id: string) => boolean;
  /** Plays one note offline (no audio device) and reads it back. */
  analyzeNote: (config: BrassNoteConfig, seconds?: number) => BrassNoteAnalysis;
}

export interface PhysModAPI {
  info: (id: string) => PhysModInfo;
  remove: (id: string) => boolean;
  /** The most recently played string's current shape (finger to bridge), for a custom drawing. */
  shape: (id: string) => PhysModOk & { version?: number; points?: number[] };
  /** Plays a note offline and reads it back - pitch, level, spectrum and what the bow did; no
   * audio device involved. */
  analyzeNote: (config: PhysModNoteConfig, seconds?: number) => PhysModNoteAnalysis;
}

/** What `Audio.analyze` returns. */
export interface AudioAnalysis {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  peakHz: number;
  peakDb: number;
  centroidHz: number;
  framesWritten: number;
  windowFrames: number;
}

/** Config for `Widget.oscilloscope`. The audio behind `source` is read Rust-side when the widget
 * is drawn, so no samples ever cross into JS. */
export interface OscilloscopeConfig {
  id?: string;
  /** `"master"` (default) or a track id. */
  source?: string;
  /** `"mono"` (default: the mid signal), `"stereo"` (left and right overlaid), or `"xy"` (a
   * goniometer: mono is a vertical line, out-of-phase is horizontal). */
  mode?: "mono" | "stereo" | "xy";
  height?: number;
  /** Time across the screen, 5-90 ms (default 23). */
  windowMs?: number;
  /** Lock each frame to a rising crossing so a steady tone holds still (default true). */
  trigger?: boolean;
  triggerLevel?: number;
  /** [r, g, b, a] in 0..1. */
  color?: [number, number, number, number];
  /** Seconds of afterglow (default 0.12); 0 turns it off. */
  persistence?: number;
  /** Vertical zoom: 1 puts full scale at the graticule edge. */
  gain?: number;
  /** Fixed width in points; omit to fill the row (set it to put widgets side by side). */
  width?: number;
}

/** Config for `Widget.spectrum`. */
export interface SpectrumConfig {
  id?: string;
  source?: string;
  /** 1024, 2048, 4096 (default) or 8192. Larger resolves the bass better and reacts slower. */
  fftSize?: number;
  style?: "filled" | "bars";
  height?: number;
  minDb?: number;
  maxDb?: number;
  minHz?: number;
  maxHz?: number;
  /** For `style: "bars"`, log bands per octave (default 3). */
  bandsPerOctave?: number;
  peakHold?: boolean;
  /** Display tilt about 1 kHz; 4.5 makes pink noise look flat, 0 (default) is honest. */
  tiltDbPerOctave?: number;
  /** How fast a falling level drops on screen, dB per second (default 48). */
  fallDbPerS?: number;
  color?: [number, number, number, number];
  /** Fixed width in points; omit to fill the row. */
  width?: number;
}

/** Config for `Widget.levelMeter`. */
export interface LevelMeterConfig {
  id?: string;
  source?: string;
  width?: number;
  height?: number;
  /** Draw dB tick labels beside the bars. */
  showScale?: boolean;
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
  // Overrides the default 14px button font - e.g. a big icon glyph on a launcher tile.
  fontSize?: number;
  // Multiplies the drawn color's alpha, 0-1 (default 1). For a caller-driven fade animation -
  // there is no engine-side tweening, so re-supply a new value every frame.
  alpha?: number;
  // `false` draws no background fill or border while idle, only a subtle highlight on
  // hover/press - an icon-tile look instead of a bordered dialog button. Default `true`.
  frame?: boolean;
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
    /** Canvas height in points. Omit to fill the height left in the window. */
    height?: number;
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
      knob: (windowId: string, config: KnobConfig) => void;
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
      /** A spreadsheet grid: lettered column headers, numbered rows, one selected cell with
       * arrow-key/Tab/Enter navigation, and an optional colored border per cell. No inline
       * editing - drive a cell's content through your own textInput bound to `selected`. */
      sheetGrid: (windowId: string, config: SheetGridConfig) => void;
      /** A Figma/VS Code-style outliner: real indented rows, a native disclosure triangle,
       * and a full-row selection highlight - see `TreeNodeConfig`'s own doc comment for how
       * to hand it hierarchy. */
      treeView: (windowId: string, config: TreeViewConfig) => void;
      /** A non-fullscreen tab strip inside a window (unlike `Entropy.UI.createTab`, which owns the
       * whole work area). You own which tab is selected: pass it as `selected`, update it in
       * `onSelect`, and draw only that tab's widgets after the bar. */
      tabBar: (windowId: string, config: TabBarConfig) => void;
      /** A drum-machine pad bank: rounded pads with a waveform thumbnail, colour accent, selection
       * ring and a glow the caller drives. See `PadGridConfig`. */
      padGrid: (windowId: string, config: PadGridConfig) => void;
      /** A wavetable as sculptable terrain, with a cycle strip, harmonics and a keyboard. */
      wavetable: (windowId: string, config: WavetableViewConfig) => void;
      /** A physically modeled bowed string, drawn the same neon-terrain way as `wavetable`. */
      physModString: (windowId: string, config: PhysModViewConfig) => void;
      /** A physically modeled brass instrument, drawn from its bore in the same neon style. */
      brass: (windowId: string, config: BrassViewConfig) => void;
      /** A physically modeled drum kit, drawn from the modes it rings with in the same neon style. */
      matter: (windowId: string, config: MatterViewConfig) => void;
      /** A triggered oscilloscope over `source` (`"master"` or a track id). */
      oscilloscope: (windowId: string, config: OscilloscopeConfig) => void;
      /** A log-frequency spectrum analyzer over `source`, with peak hold and a hover readout. */
      spectrum: (windowId: string, config: SpectrumConfig) => void;
      /** A stereo peak/RMS meter with peak hold and a click-to-clear clip latch. */
      levelMeter: (windowId: string, config: LevelMeterConfig) => void;
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
    setSpeed: (handle: string, speed: number) => void;
    readSubtitles: (path: string) => string;
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
      dataset: "xor" | "and" | "two_moons";
      epochs?: number;
      lr?: number;
      seed?: number;
    }) => void;
    poll: (id: string) => Array<{ epoch: number; totalEpochs: number; loss: number; done: boolean; accuracy?: number }>;
    trainArchitecture: (id: string, config: {
      graph: { name: string; nodes: Array<{ id: string; kind: string; position: [number, number]; config: Record<string, number | string> }>; links: Array<{ from: string; output: string; to: string; input: string }> };
      task: "npc" | "pet" | "mini_pic"; epochs?: number; lr?: number; seed?: number;
    }) => void;
    pollArchitecture: (id: string) => Array<{ epoch: number; totalEpochs: number; loss: number; done: boolean; accuracy?: number; error?: string }>;
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
    renderPatternToWav: (events: NoteEvent[], suggestedName?: string, sampleEvents?: SampleEvent[], wavetableEvents?: WavetableNoteConfig[], physModEvents?: PhysModNoteConfig[], vst3Events?: Vst3RenderTrackConfig[], trackBuses?: TrackBusRenderConfig[], brassEvents?: BrassNoteConfig[], matterEvents?: MatterHitConfig[]) => RenderPatternWavResult;
    /** Creates (on first call for a given `trackId`) or updates a persistent per-track mixing
     * bus: gain/mute/solo apply continuously and in real time, including to notes already
     * ringing - not just to future `playNoteOnTrack` calls. */
    ensureTrackBus: (trackId: string, config: TrackBusConfig) => void;
    /** Tears down a track's bus (and stops its sound) - call when a track is deleted. */
    removeTrackBus: (trackId: string) => void;
    /** Triggers one note on an already-created track bus (see `ensureTrackBus`). */
    playNoteOnTrack: (trackId: string, config: PlayNoteOnTrackConfig) => void;
    /** Plays one timed wavetable note on a track's bus (see `Wavetable`). The note reads the table
     * as it is at every sample, so sculpting the table changes a note that is already sounding. */
    playWavetableOnTrack: (trackId: string, config: WavetableNoteConfig) => WavetableOk;
    /** Starts a wavetable note that sounds until `wavetableNoteOff(voice)`. */
    wavetableNoteOn: (trackId: string, config: WavetableNoteConfig) => WavetableOk & { voice?: number };
    wavetableNoteOff: (voice: number) => void;
    /** Moves a held wavetable note through its table (0..1 across the frames) while it sounds. */
    wavetableSetPosition: (voice: number, position: number) => void;
    /** Plays one timed bowed-string note on a track's bus (see `PhysMod`). */
    playPhysModOnTrack: (trackId: string, config: PhysModNoteConfig) => PhysModOk;
    /** Starts a bowed-string note that sounds until `physModNoteOff(voice)`. */
    physModNoteOn: (trackId: string, config: PhysModNoteConfig) => PhysModOk & { voice?: number };
    physModNoteOff: (voice: number) => void;
    /** Moves a held bowed-string note's bow while it sounds. */
    physModSetBow: (voice: number, which: "force" | "velocity" | "position" | "vibratoDepth", value: number) => void;
    /** Plays one timed brass note on a track's bus (see `Brass`). Notes on one track are played by
     *  one player: a note that starts before the last one ends slurs into it. */
    playBrassOnTrack: (trackId: string, config: BrassNoteConfig) => BrassOk;
    /** Starts a brass note that sounds until `brassNoteOff(voice)`. */
    brassNoteOn: (trackId: string, config: BrassNoteConfig) => BrassOk & { voice?: number };
    brassNoteOff: (voice: number) => void;
    /** Moves a held brass note: breath (0..1), lip tension (-1..1), vibrato depth or bend (cents). */
    brassSetControl: (voice: number, which: "breath" | "lipTension" | "vibratoDepth" | "bend", value: number) => void;
    /** Builds (off the audio thread) or checks the track's drum kit (see `Matter`). Hits sent while a
     *  kit is first being built are dropped, so prepare it ahead of playing. Cheap every frame. */
    prepareMatter: (trackId: string, config: MatterHitConfig) => MatterOk & { status?: MatterStatus };
    /** Strikes a piece of the track's kit now. `played` is false while the kit is being built. */
    playMatterOnTrack: (trackId: string, config: MatterHitConfig) => MatterOk & { played?: boolean };
    /** Holds a tool on a piece of the track's kit live (a drag): send it every frame; pressure 0
     *  lifts it. */
    holdMatterOnTrack: (trackId: string, config: MatterHoldConfig) => MatterOk & { played?: boolean };
    /** Stops the track's kit. */
    removeMatter: (trackId: string, kitId?: string) => void;
    /** Reads a source back without drawing anything: `"master"` (the whole mix) or a track id.
     * Peak and RMS are dBFS over the last `fftSize` frames (default 4096, -120 = silence);
     * `peakHz`/`peakDb` are the strongest frequency above 20 Hz and its level; `centroidHz` is the
     * spectral centroid. `framesWritten` proves the audio thread is running. Returns null when
     * the source does not exist. The analyzer widgets are drawn from the same taps. */
    analyze: (source?: string, fftSize?: number) => AudioAnalysis | null;
    /** Decodes a sample file (or finds it in memory) and describes it. Only the first 12 seconds
     * of a file are decoded (`truncated` says so). Call it when a sample is assigned so the first
     * hit does not wait on the decode. wav, flac, mp3, ogg and m4a are supported. */
    loadSample: (path: string, bins?: number) => SampleInfo;
    /** A drum-rack hit: plays `path` on a track bus (see `ensureTrackBus`). */
    playSampleOnTrack: (trackId: string, path: string, config?: SampleParams) => SampleResult;
    /** Auditions a file through the shared preview bus, cutting off the previous audition. The bus
     * is `"sample-preview"` for `analyze`. */
    previewSample: (path: string, config?: SampleParams) => SampleResult;
    stopPreview: () => void;
  };
  /** A shared, reusable effect registry - see the scoped `Entropy.Addon.register()` API's
   * `AudioEffect` for the full doc comment (identical surface, top-level here). */
  AudioEffect: {
    createDelay: (config?: DelayEffectConfig) => string;
    createReverb: (config?: ReverbEffectConfig) => string;
    /** Pump, Gate, Grit, Space or Fader (see `CharacterEffectConfig`). Inline: the output
     * replaces the signal, so put these after delay/reverb in a bus's `effectIds`. */
    createCharacter: (config: CharacterEffectConfig) => string;
    setCharacterParams: (effectId: string, config: CharacterEffectConfig) => void;
    setDelayParams: (effectId: string, config: DelayEffectConfig) => void;
    setReverbParams: (effectId: string, config: ReverbEffectConfig) => void;
    destroy: (effectId: string) => void;
  };
  Vst3: Vst3API;
  Wavetable: WavetableAPI;
  PhysMod: PhysModAPI;
  Brass: BrassAPI;
  Matter: MatterAPI;
  Icons: IconsAPI;
  System: SystemAPI;
  Guitar: GuitarAPI;
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
    setFullscreen: (enabled: boolean) => void;
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
