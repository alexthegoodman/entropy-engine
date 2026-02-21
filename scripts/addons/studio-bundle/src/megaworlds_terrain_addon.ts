import { ComponentAddon } from "./system";

interface TerrainParams {
    seed: number;
    frequency: number;
    octaves: number;
    usePBR: boolean;
}

class MegaworldsTerrainAddon extends ComponentAddon<TerrainParams> {
    protected defaultParams: TerrainParams = {
        seed: Math.floor(Math.random() * 1000),
        frequency: 0.02,
        octaves: 6,
        usePBR: true
    };

    constructor() {
        super({
            name: "Megaworlds Quadtree Terrain",
            version: "2.0.0",
            description: "Generates terrain using Rust-side noise"
        });
    }

    protected setup() {
        this.initComponentState("Default Terrain");

        this.component(this.name)
            .name("Megaworlds Quadtree Terrain")
            .renderer((id, params) => this.generateTerrain(params, id))
            .editor((windowId) => this.renderUI(windowId))
            .register();
    }

    onInit() {        
        const windowId = this.UI.createTab({
            title: "Rust Noise",
            onRender: () => this.renderUI(windowId)
        });
    }

    onProjectChanged() {
        if (this.loadFromProject()) {
            Entropy.println("[MEGAWORLDS TERRAIN SYSTEM]: Project loaded successfully");
            // generate rarely to avoid excessive reload time
            this.generateTerrain(this.currentParams, this.state.activeComponentId);
        }
    }

    private async generateTerrain(params: TerrainParams, id: string) {
        const noiseId = this.Noise.create({
            type: "fbm",
            source: "perlin",
            seed: params.seed,
            frequency: params.frequency,
            octaves: params.octaves
        });

        let pipelineId = "default";
        if (!params.usePBR) {
            pipelineId = Entropy.Pipeline.create({
                name: "terrain_green",
                pbr: false,
                fragmentShader: `
                    @fragment
                    fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
                        return vec4<f32>(0.2, 0.8, 0.2, 1.0);
                    }
                `
            });
        }

        // roughly rdr2 size (64MB heightmap generation of u8 ints from noise upon load, a bit of time, but normal and light)
        // also must be a power of 2
        // let size = 8192;

        // small, super fast
        let size = 1024;

        this.api.Quadscape.create({
            id: id,
            
            width: size,
            height: size,
            size: size,
            noiseId: noiseId,
            position: [0, -10, 0],
            pipelineId: pipelineId,
            renderRole: "Terrain",
            scale: 10
        } as any);
    }

    private renderUI(windowId: string) {
        Entropy.Addon.setVisibility(this.name, true);

        this.renderComponentUI(windowId, () => {
            this.generateTerrain(this.currentParams, this.state.activeComponentId);
        });

        Entropy.UI.Widget.label(windowId, { text: "Noise Parameters", bold: true });
        
        Entropy.UI.Widget.button(windowId, {
            text: "Randomize Seed & Regenerate",
            onClick: () => {
                this.currentParams.seed = Math.floor(Math.random() * 1000);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(windowId, {
            text: this.currentParams.usePBR ? "Switch to non-PBR (Green)" : "Switch to PBR",
            onClick: () => {
                this.currentParams.usePBR = !this.currentParams.usePBR;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.label(windowId, { text: `Current Seed: ${this.currentParams.seed}` });
        Entropy.UI.Widget.label(windowId, { text: `Mode: ${this.currentParams.usePBR ? "PBR" : "Non-PBR"}` });
    }
}

new MegaworldsTerrainAddon().register();
