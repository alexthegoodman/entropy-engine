// The logic-graph node set and its interpreter. Same widget/ownership pattern as
// examples/studio-bundle/src/node_graph_addon.ts's "Nocode Calculator" (JS-owned nodes/
// connections, Entropy.UI.Widget.snarl renders them, onConnect/onDisconnect/onNodeMoved mutate
// them) - swapping that demo's number/math nodes for event/action nodes wired to a real entity.
//
// Unlike the calculator, which recomputes pure values, these nodes have side effects (moving an
// entity, destroying it), so the interpreter is a forward walk from an event node rather than a
// memoized backward pull from an output node.

import type { EntityGraph, LogicNode, LogicNodeType } from "./entity.ts";
import type { EditorEntity } from "./entity.ts";

let nextId = 0;
function freshId(prefix: string): string {
    nextId += 1;
    return `${prefix}_${nextId}`;
}

const FLOW_IN = { id: "in", name: "", pinType: "flow" };
const FLOW_OUT = { id: "out", name: "then", pinType: "flow" };

export function makeLogicNode(nodeType: LogicNodeType, position: [number, number]): LogicNode {
    const id = freshId(nodeType.toLowerCase());
    switch (nodeType) {
        case "OnStart":
            return { id, name: "On Start", nodeType, position, inputs: [], outputs: [FLOW_OUT], properties: {} };
        case "OnCollide":
            return { id, name: "On Collide", nodeType, position, inputs: [], outputs: [FLOW_OUT], properties: { withTag: "player" } };
        case "OnKeyDown":
            return { id, name: "On Key Down", nodeType, position, inputs: [], outputs: [FLOW_OUT], properties: { key: "d" } };
        case "SetVelocity":
            return { id, name: "Set Velocity", nodeType, position, inputs: [FLOW_IN], outputs: [FLOW_OUT], properties: { vx: 0, vy: 0 } };
        case "Destroy":
            return { id, name: "Destroy", nodeType, position, inputs: [FLOW_IN], outputs: [], properties: {} };
        case "SetColor":
            return { id, name: "Set Color", nodeType, position, inputs: [FLOW_IN], outputs: [FLOW_OUT], properties: { r: 1, g: 1, b: 1, a: 1 } };
        case "Log":
            return { id, name: "Log", nodeType, position, inputs: [FLOW_IN], outputs: [FLOW_OUT], properties: { message: "hello" } };
    }
}

// Runs every action node reachable by following outgoing connections from `startNodeId`
// (normally an event node's id). Breadth-first with a `visited` guard - a cycle in
// hand-wired connections would otherwise loop forever, unlike the calculator's pure/memoized
// walk which cycles safely by construction.
export function runFrom(startNodeId: string, entity: EditorEntity, graph: EntityGraph, onDestroyed: (entity: EditorEntity) => void): void {
    const visited = new Set<string>([startNodeId]);
    const queue: string[] = graph.connections.filter(c => c.fromNode === startNodeId).map(c => c.toNode);

    while (queue.length > 0) {
        const nodeId = queue.shift()!;
        if (visited.has(nodeId)) continue;
        visited.add(nodeId);

        const node = graph.nodes.find(n => n.id === nodeId);
        if (!node) continue;

        let stop = false;
        switch (node.nodeType) {
            case "SetVelocity":
                entity.vx = node.properties.vx ?? 0;
                entity.vy = node.properties.vy ?? 0;
                break;
            case "SetColor": {
                const color: [number, number, number, number] = [
                    node.properties.r ?? 1, node.properties.g ?? 1, node.properties.b ?? 1, node.properties.a ?? 1,
                ];
                entity.data.color = color;
                entity.sprite.retint(color);
                break;
            }
            case "Log":
                Entropy.println(`[Logic] ${entity.data.tag} ${entity.data.id.slice(0, 13)}: ${node.properties.message ?? ""}`);
                break;
            case "Destroy":
                onDestroyed(entity);
                stop = true;
                break;
            default:
                break; // event nodes reached mid-graph (shouldn't normally happen) do nothing
        }

        if (stop) break;
        for (const c of graph.connections.filter(c => c.fromNode === nodeId)) {
            if (!visited.has(c.toNode)) queue.push(c.toNode);
        }
    }
}
