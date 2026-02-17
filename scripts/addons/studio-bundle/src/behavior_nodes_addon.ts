import type { BehaviorGraph, BehaviorNode, BehaviorPin } from './addon';
import { ComponentAddon, EntropyAddon } from './system';

interface AddonState {
    graphs: { [id: string]: BehaviorGraph };
    activeGraphId: string | null;
}

export class BehaviorNodesAddon extends ComponentAddon<AddonState> {
    defaultParams: AddonState = {
        graphs: {},
        activeGraphId: null
    };

    protected setup() {
        this.initComponentState("Default Behavior Nodes");

        this.setupProjectHandlers();

        this.renderUI();

        // Register a tool to assign behavior to an entity
        this.tool("assignBehavior")
            .description("Assign a behavior graph to an entity")
            .parameters({
                entityId: "string",
                behaviorId: "string"
            })
            .handler((params) => {
                const { entityId, behaviorId } = params;
                Entropy.println(`Assigning behavior ${behaviorId} to entity ${entityId}`);
                // In a real implementation, we would register this behavior with the global Behavior system
            })
            .register();
    }

    private setupProjectHandlers(): void {
        this.api.onProjectChanged((newProjectId) => {
            this.loadFromProject();
        });
    }

    private createNewGraph(name: string) {
        const id = name.toLowerCase().replace(/\s+/g, '_');
        this.currentParams.graphs[id] = {
            nodes: [],
            connections: []
        };
        this.currentParams.activeGraphId = id;
        this.saveToProject();
    }

    private addNode(graphId: string, type: string, position: [number, number] = [100, 100]) {
        const graph = this.currentParams.graphs[graphId];
        if (!graph) return;

        const node: BehaviorNode = {
            id: Entropy.generateUUID(),
            name: type,
            nodeType: type,
            position,
            inputs: this.getDefaultInputs(type),
            outputs: this.getDefaultOutputs(type),
            properties: {}
        };

        graph.nodes.push(node);
        this.saveToProject();
    }

    private getDefaultInputs(type: string): BehaviorPin[] {
        switch (type) {
            case 'Sequence':
            case 'Selector':
                return [{ id: 'in', name: 'In', pinType: 'flow' }];
            case 'Wander':
            case 'Tactical Combat':
            case 'Attack':
            case 'Move To':
            case 'Set Animation':
            case 'Teleport':
            case 'Dialogue':
                return [{ id: 'in', name: 'In', pinType: 'flow' }];
            case 'Condition':
            case 'Check Reputation':
                return [
                    { id: 'in', name: 'In', pinType: 'flow' }
                ];
            default:
                return [];
        }
    }

    private getDefaultOutputs(type: string): BehaviorPin[] {
        switch (type) {
            case 'Sequence':
            case 'Selector':
                return [
                    { id: 'out1', name: '1', pinType: 'flow' },
                    { id: 'out2', name: '2', pinType: 'flow' },
                    { id: 'out3', name: '3', pinType: 'flow' }
                ];
            case 'Wander':
            case 'Tactical Combat':
            case 'Attack':
            case 'Move To':
            case 'Set Animation':
            case 'Teleport':
                return [{ id: 'out', name: 'Done', pinType: 'flow' }];
            case 'Dialogue':
                return [
                    { id: 'opt1', name: 'Option 1', pinType: 'flow' },
                    { id: 'opt2', name: 'Option 2', pinType: 'flow' },
                    { id: 'exit', name: 'Exit', pinType: 'flow' }
                ];
            case 'Condition':
            case 'Check Reputation':
                return [
                    { id: 'true', name: 'True', pinType: 'flow' },
                    { id: 'false', name: 'False', pinType: 'flow' }
                ];
            default:
                return [];
        }
    }

    private renderUI() {
        const windowId = this.api.UI.createTab({
            title: "🧠 Behavior Nodes",
            onRender: () => {
                this.api.UI.Widget.label(windowId, { text: "Behavior Graphs", bold: true });
                
                this.api.UI.Widget.button(windowId, {
                    text: "➕ Create New Behavior",
                    onClick: () => {
                        const name = "New Behavior " + (Object.keys(this.currentParams.graphs).length + 1);
                        this.createNewGraph(name);
                    }
                });

                const graphIds = Object.keys(this.currentParams.graphs);
                if (graphIds.length > 0) {
                    this.api.UI.Widget.dropdown(windowId, {
                        label: "Select Graph",
                        options: graphIds,
                        selectedIndex: this.currentParams.activeGraphId ? graphIds.indexOf(this.currentParams.activeGraphId) : 0,
                        onChange: (idx) => {
                            this.currentParams.activeGraphId = graphIds[parseInt(idx)];
                        }
                    });
                }

                if (this.currentParams.activeGraphId) {
                    const graphId = this.currentParams.activeGraphId;
                    const graph = this.currentParams.graphs[graphId];

                    this.api.UI.Widget.separator(windowId);
                    this.api.UI.Widget.label(windowId, { text: `Editing: ${graphId}`, bold: true });

                    this.api.UI.Widget.label(windowId, { text: "Add Nodes:", bold: true });
                    this.api.UI.Widget.horizontal(windowId, (ui) => {
                        this.api.UI.Widget.button(windowId, { text: "🏃 Wander", onClick: () => this.addNode(graphId, 'Wander') });
                        this.api.UI.Widget.button(windowId, { text: "⚔️ Combat", onClick: () => this.addNode(graphId, 'Tactical Combat') });
                        this.api.UI.Widget.button(windowId, { text: "🎯 Move To", onClick: () => this.addNode(graphId, 'Move To') });
                        this.api.UI.Widget.button(windowId, { text: "🎭 Anim", onClick: () => this.addNode(graphId, 'Set Animation') });
                    });
                    this.api.UI.Widget.horizontal(windowId, (ui) => {
                        this.api.UI.Widget.button(windowId, { text: "🌲 Sequence", onClick: () => this.addNode(graphId, 'Sequence') });
                        this.api.UI.Widget.button(windowId, { text: "❓ Condition", onClick: () => this.addNode(graphId, 'Condition') });
                        this.api.UI.Widget.button(windowId, { text: "💬 Dialogue", onClick: () => this.addNode(graphId, 'Dialogue') });
                        this.api.UI.Widget.button(windowId, { text: "✨ Teleport", onClick: () => this.addNode(graphId, 'Teleport') });
                    });

                    this.api.UI.Widget.snarl(windowId, {
                        id: "behavior_graph_" + graphId,
                        graph: graph,
                        onConnect: (params) => {
                            const [fromNode, fromPin, toNode, toPin] = params;
                            graph.connections.push({ fromNode, fromPin, toNode, toPin });
                            this.saveToProject();
                        },
                        onDisconnect: (params) => {
                            const [fromNode, fromPin, toNode, toPin] = params;
                            graph.connections = graph.connections.filter(c => 
                                !(c.fromNode === fromNode && c.fromPin === fromPin && c.toNode === toNode && c.toPin === toPin)
                            );
                            this.saveToProject();
                        }
                    });
                }
            }
        });
    }
}

new BehaviorNodesAddon({
    name: "BehaviorNodes",
    version: "0.1.0",
    description: "Visual node-based behavior editor for entities",
    author: ["Entropy Team"]
}).register();
