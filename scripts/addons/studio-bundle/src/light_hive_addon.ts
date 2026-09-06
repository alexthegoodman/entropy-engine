// Light Hive Addon
// Manages collections of point lights that can be placed in the scene

import { ComponentAddon } from "./system";

interface LightParams {
    color: [number, number, number];
    intensity: number;
    maxDistance: number;
}

class LightHiveAddon extends ComponentAddon<LightParams> {
    protected defaultParams: LightParams = {
        color: [1.0, 1.0, 1.0],
        intensity: 25.0,
        maxDistance: 150.0
    };

    constructor() {
        super({
            name: "Light Hive",
            version: "1.0.0",
            description: "Point Light Management System",
            author: ["Entropy Team"],
            capabilities: { graphics: true, ui: true }
        });
    }

    protected setup(): void {
        this.initComponentState("Basic Point Light");
        // Keep the original fixed id so existing saved projects referencing
        // componentId "basic_light" keep resolving to this preset.
        this.state.savedComponents[0].id = "basic_light";
        this.state.activeComponentId = "basic_light";

        if (Entropy.Composer) {
            // registerEditor's callback receives an overrideKey that must be
            // applied before spawning anything from inside it - Light Hive is
            // an AddonAtom (getAddonName() always resolves to "__VOID__"
            // without an active override), so without this a spawn triggered
            // from Game Composer's embedded editor would be misattributed.
            // ComponentBuilder's editor() doesn't plumb that second argument
            // through, so this is registered directly instead of via
            // this.component(...).
            Entropy.Composer.registerEditor(this.name, (windowId: string, overrideKey: string) => {
                this.renderSharedEditor(windowId, overrideKey);
            });
            Entropy.Composer.registerRenderer(this.name, (id, params) => this.renderLight(id, params as any));

            // Always available in Game Composer's picker, even on a brand
            // new project with no saved Light Hive data yet to load.
            Entropy.Composer.registerComponent(this.name, "basic_light", "Basic Point Light", this.currentParams);
        }
    }

    private renderLight(id: string, params: LightParams & { _transform?: { position: [number, number, number] } }) {
        const position = params._transform?.position || [0, 0, 0];
        this.Lighting.createPointLight({
            position,
            color: params.color,
            intensity: params.intensity,
            maxDistance: params.maxDistance
        });
    }

    private refreshPreview() {
        this.renderLight("preview_light", {
            ...this.currentParams,
            _transform: { position: [0, 5, 0] }
        });
    }

    private spawnAtCamera() {
        const [playerPos] = Entropy.Camera.getTransform();
        const spawnPos: [number, number, number] = [playerPos[0], playerPos[1], playerPos[2]];
        this.renderLight(Entropy.generateUUID(), { ...this.currentParams, _transform: { position: spawnPos } });
        Entropy.println(`Spawned light at camera: ${spawnPos}`);
    }

    // Registered as this addon's Composer editor - rendered inline inside Game Composer's own UI.
    private renderSharedEditor(windowId: string, overrideKey: string) {
        Entropy.UI.Widget.label(windowId, { text: "💡 Light Properties", bold: true });
        Entropy.UI.Widget.colorInput(windowId, {
            label: "Color",
            color: [...this.currentParams.color, 1.0],
            onChange: (col: number[]) => { this.currentParams.color = [col[0], col[1], col[2]]; }
        });
        Entropy.UI.Widget.slider(windowId, {
            label: "Intensity", value: this.currentParams.intensity, min: 0, max: 200,
            onChange: (v: string) => { this.currentParams.intensity = parseFloat(v); }
        });
        Entropy.UI.Widget.slider(windowId, {
            label: "Max Distance", value: this.currentParams.maxDistance, min: 1, max: 500,
            onChange: (v: string) => { this.currentParams.maxDistance = parseFloat(v); }
        });
        Entropy.UI.Widget.label(windowId, { text: "--------------------------------" });

        Entropy.UI.Widget.button(windowId, {
            text: "✨ Spawn Temporary Light",
            onClick: () => { this.withAddonContext(overrideKey, () => this.spawnAtCamera()); }
        });
    }

    protected onInit() {
        Entropy.println("Light Hive Initializing...");

        this.tab({
            title: "Light Hive",
            onRender: (ui) => {
                ui.label({ text: "💡 Light Properties", bold: true });
                ui.colorInput({
                    label: "Color",
                    color: [...this.currentParams.color, 1.0],
                    onChange: (col) => { this.currentParams.color = [col[0], col[1], col[2]]; this.refreshPreview(); }
                });
                ui.slider({ label: "Intensity", value: this.currentParams.intensity, min: 0, max: 200, onChange: (v) => { this.currentParams.intensity = v; this.refreshPreview(); } });
                ui.slider({ label: "Max Distance", value: this.currentParams.maxDistance, min: 1, max: 500, onChange: (v) => { this.currentParams.maxDistance = v; this.refreshPreview(); } });
                ui.label({ text: "--------------------------------" });

                ui.button({ text: "✨ Spawn Light", onClick: () => { this.spawnAtCamera(); } });

                this.renderComponentUI(ui.id, () => this.refreshPreview());
            }
        });

        this.registerTool({
            name: "spawn_point_light",
            description: "Spawn a new point light and register it as a component for the Game Composer.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the light (e.g., 'Red Beacon')." },
                    position: { type: "array", items: { type: "number" }, description: "[x, y, z] position." },
                    color: { type: "array", items: { type: "number" }, description: "RGB color." },
                    intensity: { type: "number", description: "Brightness." },
                    maxDistance: { type: "number", description: "Radius." }
                },
                required: ["name", "position"]
            }
        }, (args: any) => {
            Entropy.println("Spawning light component via tool: " + args.name);

            const id = Entropy.generateUUID();
            const params: LightParams = {
                color: args.color || [1.0, 1.0, 1.0],
                intensity: args.intensity || 10.0,
                maxDistance: args.maxDistance || 50.0
            };

            this.state.savedComponents.push({ id, name: args.name, params });
            if (Entropy.Composer) {
                Entropy.Composer.registerComponent(this.name, id, args.name, params);
            }

            this.renderLight(id, { ...params, _transform: { position: args.position } });

            return { success: true, id, name: args.name, addonName: this.name };
        });
    }

    protected onProjectChanged() {
        this.loadFromProject();
    }
}

new LightHiveAddon().registerAtom();
