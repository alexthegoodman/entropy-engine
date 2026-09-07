import { InstanceAddon } from "./system";

type CharacterKind = "None" | "Player" | "NPC";

interface NPCProps {
    aggressiveness: number;
    combatType: "Melee" | "Ranged";
    wanderRadius: number;
    wanderSpeed: number;
    detectionRadius: number;
}

interface ModelInstance {
    id: string;
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    kind: CharacterKind;
    npcProps?: NPCProps;
}

const NPC_MELEE_STATS = { damage: 10, range: 2.5, cooldown: 1.0, windUpTime: 0.3, recoveryTime: 0.3 };

class ModelViewerAddon extends InstanceAddon<ModelInstance> {
    private availableModels: string[] = [];

    constructor() {
        super({
            name: "Model Viewer",
            version: "1.3.0",
            description: "Load and view 3D models with physics support",
            author: ["Entropy Team"],
            capabilities: { ui: true }
        });
    }

    protected createInstance(path: string): ModelInstance {
        return {
            id: Entropy.generateUUID(),
            path,
            position: [0, 10, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
            kind: "None"
        };
    }

    protected instanceLabel(instance: ModelInstance): string {
        const idx = this.instances.indexOf(instance);
        const priorCount = this.instances.slice(0, idx).filter(other => other.path === instance.path).length;
        return instance.path + (priorCount > 0 ? ` (${priorCount + 1})` : "");
    }

    // Pre-InstanceAddon saves used field names "models"/"activeModelId".
    protected migrateLegacyState(data: any) {
        if (!data.instances && data.models) {
            data.instances = data.models;
            data.activeInstanceId = data.activeModelId ?? null;
        }
    }

    // Single source of truth for "kind -> Model.load config" - previously
    // duplicated across refreshModels(), the Composer renderer, and the
    // spawn_model tool handler.
    private buildLoadConfig(m: { id: string; path: string; position: number[]; rotation?: number[]; scale: number[]; kind: CharacterKind; npcProps?: NPCProps }): any {
        const loadConfig: any = {
            id: m.id,
            path: m.path,
            position: m.position,
            rotation: m.rotation || [0, 0, 0],
            scale: m.scale
        };

        if (m.kind === "Player") {
            loadConfig.player = { modelId: m.id };
        } else if (m.kind === "NPC" && m.npcProps) {
            loadConfig.npc = {
                modelId: m.id,
                behavior: { ...m.npcProps, meleeStats: NPC_MELEE_STATS }
            };
        }

        return loadConfig;
    }

    protected renderInstance(instance: ModelInstance) {
        this.Model.load(this.buildLoadConfig(instance));

        if (Entropy.Composer) {
            Entropy.Composer.registerComponent(this.name, instance.path, instance.path, {
                path: instance.path,
                kind: instance.kind,
                npcProps: instance.npcProps
            });

            // Announce this placed instance so it shows up in Game Composer's
            // Hierarchy even if it was never added via the "Add Component" button.
            Entropy.Composer.registerInstance(this.name, instance.path, instance.id, {
                position: instance.position,
                scale: instance.scale
            });
        }
    }

    renderAll() {
        // Model Viewer owns all meshes under its own addon name, so a full
        // rebuild starts by clearing what it previously loaded.
        this.Model.clearMeshes();
        super.renderAll();
    }

    private async updateAvailableModels() {
        if (this.IO.listModels) {
            this.availableModels = await this.IO.listModels();
        }
    }

    private async importModelFromDisk(): Promise<ModelInstance | null> {
        if (!this.IO.pickAndImportModel) return null;
        const fileName = await this.IO.pickAndImportModel();
        if (!fileName || fileName === "") return null;
        await this.updateAvailableModels();
        return this.spawn(fileName);
    }

    private async loadProjectData() {
        this.loadFromProject();
        await this.updateAvailableModels();
    }

    protected setup(): void {
        // Not using registerAsComposerComponent(): Game Composer calls this
        // addon's renderer with a differently-shaped params object
        // ({ path, kind, npcProps, _transform: { position, rotation, scale } })
        // than ModelInstance's own flat shape, so the adapter below translates
        // between them before delegating to the shared buildLoadConfig().
        if (Entropy.Composer) {
            Entropy.Composer.registerRenderer(this.name, (id, params: any) => {
                if (params._transform) {
                    this.Model.load(this.buildLoadConfig({
                        id,
                        path: params.path || "Player.glb",
                        position: params._transform.position,
                        rotation: params._transform.rotation || [0, 0, 0],
                        scale: params._transform.scale,
                        kind: params.kind,
                        npcProps: params.npcProps
                    }));
                }
            });

            // Cross-addon integration point: any other addon (e.g. Game Composer) can
            // trigger Model Viewer's own import pipeline directly - same shared-JS-realm
            // pattern FlexNoise Terrain already uses to call PBR Texture Designer's
            // registerTextureGenerator. Importing here (rather than duplicating the pick
            // + load logic elsewhere) keeps Model Viewer as the single owner of what a
            // "model" component is, so it stays correctly persisted/re-registered on load.
            Entropy.Composer.registerAction(this.name, "importModel", () => this.importModelFromDisk());
        }

        this.registerTool({
            name: "list_available_models",
            description: "List all 3D model files (.glb) available in the project to be spawned.",
            parameters: { type: "object", properties: {} }
        }, () => ({ success: true, models: this.availableModels }));

        this.registerTool({
            name: "spawn_model",
            description: "Spawn a 3D model and register it as a component for the Game Composer.",
            parameters: {
                type: "object",
                properties: {
                    path: { type: "string", description: "The filename of the model (e.g., 'Player.glb')." },
                    name: { type: "string", description: "A friendly name for this model instance." },
                    position: { type: "array", items: { type: "number" }, description: "[x, y, z] position." },
                    rotation: { type: "array", items: { type: "number" }, description: "[x, y, z] rotation in radians." },
                    scale: { type: "array", items: { type: "number" }, description: "[x, y, z] scale. Usually [1, 1, 1]." },
                    kind: { type: "string", enum: ["None", "Player", "NPC"], description: "Character type." },
                    npcProps: {
                        type: "object",
                        description: "NPC behavior settings.",
                        properties: {
                            aggressiveness: { type: "number", description: "Aggressiveness (0.0 to 1.0) (0.0 for friendly)" },
                            combatType: { type: "string", enum: ["Melee", "Ranged"], description: "Primary combat style" },
                            wanderRadius: { type: "number", description: "Random movement radius" },
                            wanderSpeed: { type: "number", description: "Movement speed multiplier" },
                            detectionRadius: { type: "number", description: "Player detection range" }
                        }
                    }
                },
                required: ["path", "name"]
            }
        }, (args: any) => {
            if (Entropy.Composer) {
                Entropy.Composer.registerComponent(this.name, args.path, args.name, {
                    path: args.path,
                    kind: args.kind || "None",
                    npcProps: args.npcProps
                });
            }

            const id = Entropy.generateUUID();
            this.Model.load(this.buildLoadConfig({
                id,
                path: args.path,
                position: args.position || [0, 0, 0],
                rotation: args.rotation || [0, 0, 0],
                scale: args.scale || [1, 1, 1],
                kind: args.kind || "None",
                npcProps: args.npcProps
            }));

            return { success: true, id, name: args.name, addonName: this.name };
        });
    }

    protected async onInit() {
        Entropy.println("Model Viewer Addon Initialized");

        await this.loadProjectData();

        this.tab({
            title: "Model Viewer",
            onRender: (ui) => {
                ui.label({ text: "📦 Model Viewer", bold: true });

                ui.button({
                    text: "📂 Import Model from Disk",
                    onClick: () => { this.importModelFromDisk(); }
                });

                ui.label({ text: "--- Available in Project ---", bold: true });
                if (this.availableModels.length === 0) {
                    ui.label({ text: "(No models in project folder)" });
                }
                this.availableModels.forEach(modelFile => {
                    ui.button({ text: "➕ " + modelFile, onClick: () => { this.spawn(modelFile); } });
                });

                ui.button({
                    text: "🔄 Refresh File List",
                    onClick: async () => { await this.updateAvailableModels(); }
                });

                ui.label({ text: "--- Active Scene Models ---", bold: true });
                if (this.instances.length === 0) {
                    ui.label({ text: "(No models active)" });
                }
                this.renderListUI(ui);

                const activeModel = this.activeInstance;
                if (activeModel) {
                    ui.label({ text: "--- Inspector ---", bold: true });

                    const kinds: CharacterKind[] = ["None", "Player", "NPC"];
                    ui.dropdown({
                        label: "Character Type",
                        options: kinds,
                        selectedIndex: kinds.indexOf(activeModel.kind),
                        onChange: (idx) => {
                            activeModel.kind = kinds[idx];
                            if (activeModel.kind === "NPC" && !activeModel.npcProps) {
                                activeModel.npcProps = {
                                    aggressiveness: 0.5,
                                    combatType: "Melee",
                                    wanderRadius: 20.0,
                                    wanderSpeed: 0.02,
                                    detectionRadius: 30.0
                                };
                            }
                            this.renderAll();
                            this.saveToProject();
                        }
                    });

                    if (activeModel.kind === "NPC" && activeModel.npcProps) {
                        const npcProps = activeModel.npcProps;
                        const commit = () => { this.renderAll(); this.saveToProject(); };

                        ui.label({ text: "NPC Behavior", bold: true });
                        ui.slider({ label: "Aggressiveness", value: npcProps.aggressiveness, min: 0, max: 1, onChange: (v) => { npcProps.aggressiveness = v; commit(); } });
                        ui.slider({ label: "Detection Radius", value: npcProps.detectionRadius, min: 5, max: 100, onChange: (v) => { npcProps.detectionRadius = v; commit(); } });
                        ui.slider({ label: "Wander Radius", value: npcProps.wanderRadius, min: 0, max: 100, onChange: (v) => { npcProps.wanderRadius = v; commit(); } });
                        ui.slider({ label: "Speed", value: npcProps.wanderSpeed, min: 0.001, max: 0.1, onChange: (v) => { npcProps.wanderSpeed = v; commit(); } });

                        const combatTypes: ("Melee" | "Ranged")[] = ["Melee", "Ranged"];
                        ui.dropdown({
                            label: "Combat Type",
                            options: combatTypes,
                            selectedIndex: combatTypes.indexOf(npcProps.combatType),
                            onChange: (idx) => { npcProps.combatType = combatTypes[idx]; commit(); }
                        });
                    }

                    const commit = () => { this.renderAll(); this.saveToProject(); };

                    ui.label({ text: "Position" });
                    ["X", "Y", "Z"].forEach((axis, i) => {
                        ui.slider({ label: axis, value: activeModel.position[i], min: -100, max: 100, onChange: (v) => { activeModel.position[i] = v; commit(); } });
                    });

                    ui.label({ text: "Rotation (Radians)" });
                    ["X", "Y", "Z"].forEach((axis, i) => {
                        ui.slider({ label: axis, value: activeModel.rotation[i], min: -3.14, max: 3.14, onChange: (v) => { activeModel.rotation[i] = v; commit(); } });
                    });

                    ui.label({ text: "Scale" });
                    ui.slider({
                        label: "Uniform", value: activeModel.scale[0], min: 0.1, max: 10,
                        onChange: (v) => { activeModel.scale = [v, v, v]; commit(); }
                    });

                    ui.button({
                        text: "🗑️ Delete Instance",
                        onClick: () => { this.removeInstance(activeModel.id); }
                    });
                }

                ui.label({ text: "--------------------------------" });
                ui.button({
                    text: "💾 Save State",
                    onClick: () => {
                        this.saveToProject();
                        Entropy.println("Model Viewer state saved");
                    }
                });
            }
        });
    }

    protected async onProjectChanged() {
        await this.loadProjectData();
    }
}

new ModelViewerAddon().register();
