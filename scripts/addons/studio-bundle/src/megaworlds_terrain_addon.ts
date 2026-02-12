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
            name: "Simple Procedural Terrain",
            version: "2.0.0",
            description: "Generates terrain using Rust-side noise"
        });
    }

    protected setup() {
        this.initComponentState("Default Terrain");

        this.component(this.name)
            .name("Simple Procedural Terrain")
            .renderer((id, params) => this.generateTerrain(params, id))
            .editor((windowId) => this.renderUI(windowId))
            .register();
    }

    onInit() {
        this.generateTerrain(this.currentParams, this.state.activeComponentId);
        
        const windowId = this.UI.createTab({
            title: "Rust Noise",
            onRender: () => this.renderUI(windowId)
        });
    }

    onProjectChanged() {
        if (this.loadFromProject()) {
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

        this.Landscape.create({
            id: id,
            width: 128,
            height: 128,
            noiseId: noiseId,
            position: [0, 0, 0],
            pipelineId: pipelineId,
            renderRole: "Terrain",
            size: 512, // Default size
            scale: 150  // Default scale
        } as any);
    }

    private renderUI(windowId: string) {
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
