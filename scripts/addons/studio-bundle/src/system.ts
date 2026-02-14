// *** Entropy Addon Class System ***
// Standardized architecture for high-performance addons

import type { AddonMetadata, Position, ScopedAPI } from "./addon";

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

export interface VisualProvider {
    meshId: string;
    pipelindId?: string;
    onAnimate?: (entityId: string, animName: string) => void;
    onSpawn?: (entityId: string, position: [number, number, number]) => void;
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

  // API Proxies
  get Model() { return this.api.Model; }
  get Visual() { return this.api.Visual; }
  get Landscape() { return this.api.Landscape; }
  get Noise() { return this.api.Noise; }
  get Texture() { return this.api.Texture; }
  get UI() { return this.api.UI; }
  get Lighting() { return this.api.Lighting; }
  get IO() { return this.api.IO; }
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

    get currentParams(): TParams {
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
