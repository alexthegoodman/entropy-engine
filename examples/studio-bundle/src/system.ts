// *** Entropy Addon Class System ***
// Standardized architecture for high-performance addons

import type {
  AddonMetadata, BindingConfig, Position, ScopedAPI, ToolDefinition,
  ButtonConfig, ColorInputConfig, SliderConfig, NumericInputConfig,
  DropdownConfig, CheckboxConfig, CodeEditorConfig, MiniMapConfig,
  PianoRollConfig, SnarlConfig, LabelConfig, TabConfig
} from "./addon";

// Global addon registry
class AddonRegistry {
  private addons: Map<string, EntropyAddon<any>> = new Map();
  private tools: Map<string, ToolRegistration> = new Map();
  private components: Map<string, ComponentRegistration> = new Map();
  private visuals: Map<string, string> = new Map(); // visualName -> meshId
  private visualProviders: Map<string, VisualProvider> = new Map();
  
  register(addon: EntropyAddon<any>) {
    this.addons.set(addon.name, addon);
    return addon;
  }
  
  getAddon(name: string): EntropyAddon<any> | undefined {
    return this.addons.get(name);
  }
  
  registerTool(addonName: string, tool: ToolRegistration) {
    const key = `${addonName}.${tool.name}`;
    this.tools.set(key, tool);
  }
  
  getAllTools(): Map<string, ToolRegistration> {
    return this.tools;
  }
  
  registerComponent(addonName: string, component: ComponentRegistration) {
    const key = `${addonName}.${component.id}`;
    this.components.set(key, component);
  }

  getComponentsForAddon(addonName: string): ComponentRegistration[] {
    return Array.from(this.components.values()).filter(c => c.addonName === addonName);
  }

  registerVisual(name: string, provider: string | VisualProvider) {
    if (typeof provider === "string") {
        this.visuals.set(name, provider);
    } else {
        this.visualProviders.set(name, provider);
    }
  }

  getVisual(name: string): string | undefined {
    return this.visuals.get(name);
  }

  getVisualProvider(name: string): VisualProvider | undefined {
    return this.visualProviders.get(name);
  }
}

// share vertex data to recreate mesh many times (better for small meshes)
export interface VisualProvider {
    meshId?: string;
    pipelineId: string;
    // onAnimate?: (entityId: string, animName: string) => void;
    // onSpawn?: (entityId: string, position: [number, number, number]) => void;
    vertexData: number[]; 
    indexData: number[]; 
    bindings?: BindingConfig[] 
}

const AddonContext = new AddonRegistry();
(globalThis as any).__ENTROPY_ADDONS__ = AddonContext;

interface ToolRegistration {
  name: string;
  description: string;
  parameters: any;
  handler: (params: any) => any;
}

interface ComponentRegistration {
  id: string;
  addonName: string;
  name: string;
  defaultParams: any;
  renderer?: (id: string, params: any) => void;
  editor?: (windowId: string) => void;
  textureGenerator?: (id: string, params: any, res: number) => any;
}

class ToolBuilder {
  private tool: Partial<ToolRegistration> = {};
  constructor(private addonName: string, name: string) { this.tool.name = name; }
  description(desc: string): this { this.tool.description = desc; return this; }
  parameters(schema: any): this { this.tool.parameters = schema; return this; }
  handler(fn: (params: any) => any): this { this.tool.handler = fn; return this; }
  register(): void {
    AddonContext.registerTool(this.addonName, this.tool as ToolRegistration);
  }
}

class ComponentBuilder {
  private component: Partial<ComponentRegistration> = {};
  constructor(private addonName: string, id: string) { 
    this.component.id = id; 
    this.component.addonName = addonName;
  }
  name(displayName: string): this { this.component.name = displayName; return this; }
  defaultParams(params: any): this { this.component.defaultParams = params; return this; }
  renderer(fn: (id: string, params: any) => void): this { this.component.renderer = fn; return this; }
  editor(fn: (windowId: string) => void): this { this.component.editor = fn; return this; }
  textureGenerator(fn: (id: string, params: any, res: number) => any): this { this.component.textureGenerator = fn; return this; }
  register(): void {
    AddonContext.registerComponent(this.addonName, this.component as ComponentRegistration);
  }
}

// ---------------------------------------------------------------------------
// Bound UI builder.
//
// Entropy.UI.Widget.x(windowId, config) makes every call site repeat the
// window/tab id, and slider/dropdown hand back a raw string that every
// caller has to parseFloat/parseInt itself. This wraps a single windowId
// once (via EntropyAddon.tab()) and does the numeric parsing internally, so
// new addon code doesn't have to. The raw Entropy.UI.Widget API is
// untouched - existing addons that call it directly keep working exactly
// as before.
// ---------------------------------------------------------------------------
export interface BoundUI {
  readonly id: string;
  label(config: LabelConfig | string): void;
  button(config: ButtonConfig): void;
  colorInput(config: ColorInputConfig): void;
  slider(config: Omit<SliderConfig, "onChange"> & { onChange?: (value: number) => void }): void;
  numericInput(config: Omit<NumericInputConfig, "onChange"> & { onChange?: (value: number) => void }): void;
  dropdown(config: Omit<DropdownConfig, "onChange"> & { onChange?: (index: number) => void }): void;
  checkbox(config: CheckboxConfig): void;
  codeEditor(config: CodeEditorConfig): void;
  miniMap(config: MiniMapConfig): void;
  pianoRoll(config: PianoRollConfig): void;
  snarl(config: SnarlConfig): void;
  collapsingHeader(title: string, render: (ui: BoundUI) => void): void;
  horizontal(render: (ui: BoundUI) => void): void;
  separator(): void;
}

function createBoundUI(windowId: string): BoundUI {
  const W = Entropy.UI.Widget;
  return {
    id: windowId,
    label: (config) => W.label(windowId, config as any),
    button: (config) => W.button(windowId, config),
    colorInput: (config) => W.colorInput(windowId, config),
    slider: (config) => W.slider(windowId, {
      ...config,
      onChange: config.onChange ? (v: string) => config.onChange!(parseFloat(v)) : undefined
    }),
    numericInput: (config) => W.numericInput(windowId, {
      ...config,
      onChange: config.onChange ? (v: string) => config.onChange!(parseFloat(v)) : undefined
    }),
    dropdown: (config) => W.dropdown(windowId, {
      ...config,
      onChange: config.onChange ? (idx: string) => config.onChange!(parseInt(idx, 10)) : undefined
    }),
    checkbox: (config) => W.checkbox(windowId, config),
    codeEditor: (config) => W.codeEditor(windowId, config),
    miniMap: (config) => W.miniMap(windowId, config),
    pianoRoll: (config) => W.pianoRoll(windowId, config),
    snarl: (config) => W.snarl(windowId, config),
    collapsingHeader: (title, render) => W.collapsingHeader(windowId, title, () => render(createBoundUI(windowId))),
    horizontal: (render) => W.horizontal(windowId, () => render(createBoundUI(windowId))),
    separator: () => W.separator(windowId),
  };
}

export abstract class EntropyAddon<TState = any> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string[];
  readonly capabilities: any;
  
  protected api!: ScopedAPI;
  protected state!: TState;
  
  constructor(metadata: AddonMetadata) {
    this.name = metadata.name;
    this.version = metadata.version || "1.0.0";
    this.description = metadata.description || "";
    this.author = metadata.author || [];
    this.capabilities = metadata.capabilities || {};
  }
  
  protected tool(name: string): ToolBuilder { return new ToolBuilder(this.name, name); }
  /** Direct equivalent of ScopedAPI.registerTool(definition, handler), for addons that don't need the tool() fluent builder. */
  protected registerTool(definition: ToolDefinition, handler: (params: any) => any) { this.api.registerTool(definition, handler); }
  protected component(id: string): ComponentBuilder { return new ComponentBuilder(this.name, id); }
  public getAddon(name: string): EntropyAddon<any> | undefined { return AddonContext.getAddon(name); }
  public registerVisual(name: string, provider: string | VisualProvider) { AddonContext.registerVisual(name, provider); }
  public getVisual(name: string): string | undefined { return AddonContext.getVisual(name); }
  public getVisualProvider(name: string): VisualProvider | undefined { return AddonContext.getVisualProvider(name); }
  
  protected onInit?(): void;
  protected onUpdate?(time: number, pos: Position, dir: Position): void;
  protected onCleanup?(): void;
  protected onProjectChanged?(projectId: string): void;

  register() {
    AddonContext.register(this);
    this.api = Entropy.Addon.register({ name: this.name, version: this.version, description: this.description, author: this.author, capabilities: this.capabilities });
    
    this.setup();

    if (this.onInit) this.api.onInit(() => this.onInit!());
    if (this.onUpdate) this.api.onUpdate((t, p, d) => this.onUpdate!(t, p, d));
    if (this.onCleanup) this.api.onCleanup(() => this.onCleanup!());
    if (this.onProjectChanged) this.api.onProjectChanged((id) => this.onProjectChanged!(id));
    
    this._registerTools();
    this._registerComponents();
    return this;
  }

  registerAtom() {
    AddonContext.register(this);
    this.api = Entropy.AddonAtom.register({ name: this.name, version: this.version, description: this.description, author: this.author, capabilities: this.capabilities });
    
    this.setup();

    if (this.onInit) this.api.onInit(() => this.onInit!());
    if (this.onUpdate) this.api.onUpdate((t, p, d) => this.onUpdate!(t, p, d));
    if (this.onCleanup) this.api.onCleanup(() => this.onCleanup!());
    if (this.onProjectChanged) this.api.onProjectChanged((id) => this.onProjectChanged!(id));
    
    this._registerTools();
    this._registerComponents();
    return this;
  }
  
  protected abstract setup(): void;
  
  private _registerTools() {
    const tools = Array.from(AddonContext.getAllTools().entries()).filter(([key]) => key.startsWith(`${this.name}.`));
    tools.forEach(([_, tool]) => this.api.registerTool({ name: tool.name, description: tool.description, parameters: tool.parameters }, tool.handler));
  }
  
  private _registerComponents() {
    if (!Entropy.Composer) return;
    const comps = AddonContext.getComponentsForAddon(this.name);
    comps.forEach(c => {
      if (c.editor) Entropy.Composer!.registerEditor(c.id, c.editor);
      if (c.renderer) Entropy.Composer!.registerRenderer(c.id, c.renderer);
      if (c.textureGenerator) Entropy.Composer!.registerTextureGenerator(c.id, c.textureGenerator);
    });
  }

  // API Proxies - the full ScopedAPI surface, so subclasses never need to
  // fall back to this.api.X just because a namespace was missing here.
  get Model() { return this.api.Model; }
  get AlphaModel() { return this.api.AlphaModel; }
  get Visual() { return this.api.Visual; }
  get Landscape() { return this.api.Landscape; }
  get Quadscape() { return this.api.Quadscape; }
  get Landscape3D() { return this.api.Landscape3D; }
  get Collectable() { return this.api.Collectable; }
  get Quest() { return this.api.Quest; }
  get Inventory() { return this.api.Inventory; }
  get GameState() { return this.api.GameState; }
  get Particles() { return this.api.Particles; }
  get Noise() { return this.api.Noise; }
  get Texture() { return this.api.Texture; }
  get UI() { return this.api.UI; }
  get Lighting() { return this.api.Lighting; }
  get Audio() { return this.api.Audio; }
  get IO() { return this.api.IO; }
  get Scripts() { return this.api.Scripts; }
  get Buffer() { return this.api.Buffer; }
  get Compute() { return this.api.Compute; }
  get Yumon() { return this.api.Yumon; }

  /**
   * Runs fn() with the Composer context override set to `name`, and always
   * clears it afterwards - even if fn() throws. Replaces the manual
   * enable*Override()/disable*Override() pairs addons used to write by
   * hand, which leaked the override (misattributing every subsequent
   * addon-scoped call engine-wide) if the wrapped code threw.
   */
  protected withAddonContext<T>(name: string, fn: () => T): T {
    Entropy.Composer?.enableOverride(name);
    try {
      return fn();
    } finally {
      Entropy.Composer?.disableOverride();
    }
  }

  /** Shorthand for withAddonContext("Game Composer", fn) - the override game addons use so their spawns are attributed to the Game Composer bucket. */
  protected asGameComposer<T>(fn: () => T): T {
    return this.withAddonContext("Game Composer", fn);
  }

  /**
   * Like this.UI.createTab(), but onRender receives a BoundUI already bound
   * to this tab's id - so widget calls read as ui.button(...) instead of
   * Entropy.UI.Widget.button(tabId, ...), and slider/dropdown callbacks
   * receive parsed numbers instead of raw strings.
   */
  protected tab(config: Omit<TabConfig, "onRender"> & { onRender: (ui: BoundUI) => void }): string {
    let tabId: string;
    tabId = this.api.UI.createTab({
      ...config,
      onRender: () => config.onRender(createBoundUI(tabId))
    });
    return tabId;
  }
}

/**
 * Specialized class for addons that manage a collection of saved components.
 * Standardizes the 'savedComponents' and 'activeComponentId' pattern.
 */
export abstract class ComponentAddon<TParams = any> extends EntropyAddon<{
    savedComponents: { id: string, name: string, params: TParams }[],
    activeComponentId: string
}> {
    protected abstract defaultParams: TParams;

    constructor(metadata: AddonMetadata) {
        super(metadata);
    }

    // get currentParams(): TParams {
    //     const found = this.state.savedComponents.find(c => c.id === this.state.activeComponentId);
    //     return found ? found.params : this.state.savedComponents[0].params;
    // }

    get currentParams(): TParams {
      if (this.state.savedComponents.length === 0) {
          return {} as TParams; // or return a default params object
      }
      
      const found = this.state.savedComponents.find(c => c.id === this.state.activeComponentId);
      return found ? found.params : this.state.savedComponents[0].params;
    }

    protected initComponentState(defaultName: string = "Default") {
        this.state = {
            savedComponents: [{ 
                id: Entropy.generateUUID(), 
                name: defaultName, 
                params: JSON.parse(JSON.stringify(this.defaultParams)) 
            }],
            activeComponentId: ""
        };
        this.state.activeComponentId = this.state.savedComponents[0].id;
    }

    protected saveToProject() {
        this.api.IO.save(this.state);
        if (Entropy.Composer) {
            this.state.savedComponents.forEach(comp => {
                Entropy.Composer!.registerComponent(this.name, comp.id, comp.name, comp.params);
            });
        }
    }

    protected loadFromProject() {
        const data = this.api.IO.load();
        if (data) {
            if (data.savedComponents) this.state.savedComponents = data.savedComponents;
            if (data.activeComponentId) this.state.activeComponentId = data.activeComponentId;

            if (Entropy.Composer) {
              data.savedComponents.forEach((comp: any) => {
                  Entropy.Composer!.registerComponent(this.name, comp.id, comp.name, comp.params);
              });
            }

            return true;
        }
        return false;
    }

    protected renderComponentUI(windowId: string, onParamsChange: () => void) {
        Entropy.UI.Widget.label(windowId, { text: "📦 Components", bold: true });
        
        const activeComp = this.state.savedComponents.find(c => c.id === this.state.activeComponentId);
        if (activeComp) {
            Entropy.UI.Widget.button(windowId, {
                text: `💾 Update "${activeComp.name}"`,
                onClick: () => {
                    this.saveToProject();
                    Entropy.println(`Updated component: ${activeComp.name}`);
                }
            });
        }

        Entropy.UI.Widget.button(windowId, {
            text: "➕ Save Current as New Component",
            onClick: () => {
                const id = Entropy.generateUUID();
                const name = `New ${this.name} ${this.state.savedComponents.length + 1}`;
                this.state.savedComponents.push({
                    id,
                    name,
                    params: JSON.parse(JSON.stringify(this.currentParams))
                });
                this.state.activeComponentId = id;
                if (Entropy.Composer) {
                    Entropy.Composer.registerComponent(this.name, id, name, this.currentParams);
                }
                this.saveToProject();
                Entropy.println(`Saved new component: ${name}`);
            }
        });

        this.state.savedComponents.forEach(comp => {
            Entropy.UI.Widget.button(windowId, {
                text: `📂 Load: ${comp.name}`,
                onClick: () => {
                    this.state.activeComponentId = comp.id;
                    onParamsChange();
                }
            });
        });
        Entropy.UI.Widget.separator(windowId);
    }
}

export interface InstanceField<T> {
    key: string & keyof T;
    label: string;
    type: "vec3" | "number" | "select" | "checkbox" | "text";
    min?: number;
    max?: number;
    options?: string[]; // for "select"
}

/**
 * Specialized class for addons that manage a collection of independently
 * placed, simultaneously-rendered instances (e.g. Model Viewer's loaded
 * models, Light Hive's spawned lights) - as opposed to ComponentAddon's
 * single active recipe with named presets.
 *
 * Subclasses implement createInstance/renderInstance once; this class
 * handles persistence (IO.save/load + onProjectChanged), Composer
 * integration (registerRenderer + registerInstance, so Game Composer can
 * both re-render and list placed instances), and generates the "pick which
 * instance is active" list plus a per-field property inspector from a
 * declared `fields` schema instead of hand-written widget calls.
 */
export abstract class InstanceAddon<T extends { id: string }> extends EntropyAddon<{
    instances: T[];
    activeInstanceId: string | null;
}> {
    /** Schema for the auto-generated inspector UI (see renderInspectorUI). Leave empty to skip it. */
    protected fields: InstanceField<T>[] = [];

    constructor(metadata: AddonMetadata) {
        super(metadata);
        this.state = { instances: [], activeInstanceId: null };
    }

    /** Construct a new instance (must include a unique `id`). Called by spawn(). */
    protected abstract createInstance(...args: any[]): T;
    /** Place/load/draw one instance into the world. Called for every instance on renderAll(), and by Game Composer via the registered renderer. */
    protected abstract renderInstance(instance: T): void;
    /** Display label for the instance list UI. Defaults to the instance id. */
    protected instanceLabel(instance: T): string { return instance.id; }

    get instances(): T[] { return this.state.instances; }
    get activeInstance(): T | undefined {
        return this.state.instances.find(i => i.id === this.state.activeInstanceId);
    }
    setActiveInstance(id: string | null) { this.state.activeInstanceId = id; }

    /** Opt-in: call once from setup() so Game Composer can re-render and list this addon's instances. */
    private composerIntegrationEnabled = false;

    protected registerAsComposerComponent() {
        if (!Entropy.Composer) return;
        this.composerIntegrationEnabled = true;
        Entropy.Composer.registerRenderer(this.name, (id, params) => {
            this.renderInstance({ ...(params as object), id } as T);
        });
        Entropy.Composer.registerAction(this.name, "spawn", (...args: any[]) => this.spawn(...args));
    }

    /** Re-renders every instance, then - only if registerAsComposerComponent() was called - announces each to Composer so it shows up in the scene hierarchy. */
    renderAll() {
        this.state.instances.forEach(i => this.renderInstance(i));

        if (this.composerIntegrationEnabled && Entropy.Composer) {
            this.state.instances.forEach(i => {
                Entropy.Composer!.registerInstance(this.name, this.name, i.id, i);
            });
        }
    }

    spawn(...args: any[]): T {
        const instance = this.createInstance(...args);
        this.state.instances.push(instance);
        this.state.activeInstanceId = instance.id;
        this.renderAll();
        this.saveToProject();
        return instance;
    }

    removeInstance(id: string) {
        this.state.instances = this.state.instances.filter(i => i.id !== id);
        if (this.state.activeInstanceId === id) this.state.activeInstanceId = null;
        this.renderAll();
        this.saveToProject();
    }

    saveToProject() {
        this.api.IO.save(this.state);
    }

    /**
     * Override to rename/reshape fields on data loaded from an older,
     * pre-InstanceAddon save format (different field names, etc.) before
     * it's applied - so migrating an addon to InstanceAddon doesn't lose
     * data already saved into existing projects under the old shape. No-op
     * by default.
     */
    protected migrateLegacyState(data: any): void {}

    /** Returns true if a saved project was found and loaded (and re-rendered). */
    loadFromProject(): boolean {
        const data = this.api.IO.load();
        if (data) {
            this.migrateLegacyState(data);
            this.state.instances = data.instances || [];
            this.state.activeInstanceId = data.activeInstanceId || null;
            this.renderAll();
            return true;
        }
        return false;
    }

    /** Renders an active-highlighted button per instance; clicking one makes it active. */
    renderListUI(ui: BoundUI) {
        this.state.instances.forEach(i => {
            ui.button({
                text: (i.id === this.state.activeInstanceId ? "🔵 " : "⚪ ") + this.instanceLabel(i),
                onClick: () => { this.state.activeInstanceId = i.id; }
            });
        });
    }

    /** Renders one widget per entry in `fields` for the active instance, wired to update + re-render + persist. */
    renderInspectorUI(ui: BoundUI) {
        const instance = this.activeInstance;
        if (!instance) return;

        const commit = () => { this.renderAll(); this.saveToProject(); };

        for (const field of this.fields) {
            const value: any = (instance as any)[field.key];
            switch (field.type) {
                case "vec3":
                    ["X", "Y", "Z"].forEach((axis, idx) => {
                        ui.slider({
                            label: `${field.label} ${axis}`,
                            value: value[idx],
                            min: field.min ?? -100,
                            max: field.max ?? 100,
                            onChange: (v) => { value[idx] = v; commit(); }
                        });
                    });
                    break;
                case "number":
                    ui.slider({
                        label: field.label,
                        value,
                        min: field.min ?? 0,
                        max: field.max ?? 100,
                        onChange: (v) => { (instance as any)[field.key] = v; commit(); }
                    });
                    break;
                case "select":
                    ui.dropdown({
                        label: field.label,
                        options: field.options || [],
                        selectedIndex: (field.options || []).indexOf(value),
                        onChange: (idx) => { (instance as any)[field.key] = (field.options || [])[idx]; commit(); }
                    });
                    break;
                case "checkbox":
                    ui.checkbox({
                        label: field.label,
                        value,
                        onChange: (v) => { (instance as any)[field.key] = v; commit(); }
                    });
                    break;
                case "text":
                    ui.label(`${field.label}: ${value}`);
                    break;
            }
        }
    }
}
