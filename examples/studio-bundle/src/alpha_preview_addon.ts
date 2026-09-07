import { InstanceAddon } from "./system";

interface AlphaModelInstance {
    id: string;
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
}

class AlphaPreviewAddon extends InstanceAddon<AlphaModelInstance> {
    private availableModels: string[] = [];

    constructor() {
        super({
            name: "Alpha Preview",
            version: "0.1.0",
            description: "Preview the new GPU-driven Alpha Renderer",
            author: ["Entropy Team"],
            capabilities: { ui: true }
        });
    }

    protected createInstance(path: string): AlphaModelInstance {
        return {
            id: Entropy.generateUUID(),
            path,
            position: [0, 5, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1]
        };
    }

    protected renderInstance(instance: AlphaModelInstance) {
        this.AlphaModel.load(instance);
    }

    // Pre-InstanceAddon saves used field name "models" instead of "instances".
    protected migrateLegacyState(data: any) {
        if (!data.instances && data.models) {
            data.instances = data.models;
        }
    }

    private async updateAvailableModels() {
        if (this.IO.listModels) {
            this.availableModels = await this.IO.listModels();
        }
    }

    protected setup(): void {
        this.Model.createProcedural({
            type: "cube",
            parameters: {
                position: [1.0, 10.0, 0.0],
                scale: [1.0, 1.0, 1.0]
            }
        });
    }

    protected onInit() {
        Entropy.println("Alpha Preview Addon Initialized");

        this.tab({
            title: "Alpha Preview",
            onRender: (ui) => {
                ui.label({ text: "🚀 Alpha GPU Renderer", bold: true });

                ui.button({
                    text: "📂 Import Model & Load into Alpha",
                    onClick: async () => {
                        if (this.IO.pickAndImportModel) {
                            const fileName = await this.IO.pickAndImportModel();
                            if (fileName && fileName !== "") {
                                await this.updateAvailableModels();
                                this.spawn(fileName);
                            }
                        }
                    }
                });

                ui.label({ text: "--- Models in Project ---", bold: true });
                this.availableModels.forEach(modelFile => {
                    ui.button({
                        text: "⚡ Load " + modelFile,
                        onClick: () => { this.spawn(modelFile); }
                    });
                });

                ui.button({
                    text: "🔄 Refresh File List",
                    onClick: async () => { await this.updateAvailableModels(); }
                });

                ui.label({ text: "--- Active Alpha Models ---", bold: true });
                this.instances.forEach(m => {
                    ui.label({ text: "• " + m.path });
                });

                ui.button({
                    text: "💾 Save State",
                    onClick: () => {
                        this.saveToProject();
                        Entropy.println("Alpha Preview state saved");
                    }
                });
            }
        });
    }

    protected async onProjectChanged() {
        this.loadFromProject();
        await this.updateAvailableModels();
    }
}

new AlphaPreviewAddon().register();
