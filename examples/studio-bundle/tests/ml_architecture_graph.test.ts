import { describe, expect, it } from "vitest";
import { miniPicGraph, npcGraph, petGraph, validateArchitecture } from "../src/apps/ml_architecture_graph";

describe("ML architecture graphs", () => {
    it("tracks the NPC's recurrent state into two different heads", () => {
        const result = validateArchitecture(npcGraph());
        expect(result.errors).toEqual([]);
        expect(result.shapes["memory.sequence"]).toEqual(["B", 16, 256]);
        expect(result.shapes["actions.out"]).toEqual(["B", 12]);
        expect(result.shapes["rotation.out"]).toEqual(["B", 1]);
    });

    it("keeps the routed decoder's token logits at sequence rank", () => {
        const result = validateArchitecture(petGraph());
        expect(result.errors).toEqual([]);
        expect(result.shapes["token_logits.out"]).toEqual(["B", 320, 8192]);
        expect(result.shapes["router_aux.out"]).toEqual([1]);
    });

    it("checks Mini-Pic's skip connections and restores image resolution", () => {
        const result = validateArchitecture(miniPicGraph());
        expect(result.errors).toEqual([]);
        expect(result.shapes["merge2.out"]).toEqual(["B", 256, 32, 32]);
        expect(result.shapes["noise.out"]).toEqual(["B", 3, 64, 64]);
    });

    it("rejects a U-Net skip wired at the wrong spatial resolution", () => {
        const graph = miniPicGraph();
        const skip = graph.links.find(l => l.to === "merge2" && l.input === "b")!;
        skip.from = "enc1";
        const result = validateArchitecture(graph);
        expect(result.errors.some(e => e.includes("merge2") && e.includes("height mismatch"))).toBe(true);
    });

    it("rejects an invalid top-k and a cycle", () => {
        const graph = petGraph();
        graph.nodes.find(n => n.id === "moe_0")!.config.topK = 5;
        expect(validateArchitecture(graph).errors.some(e => e.includes("topK"))).toBe(true);
        const cycle = petGraph();
        cycle.links.find(l => l.to === "attention_0")!.from = "moe_0";
        expect(validateArchitecture(cycle).errors.some(e => e.includes("cycle"))).toBe(true);
    });

    it("rejects a second wire into one pin and an unused source", () => {
        const graph = npcGraph();
        graph.links.push({ from: "moments", output: "out", to: "memory", input: "in" });
        graph.nodes.push({ id: "unused", kind: "SequenceInput", position: [0, 0], config: { steps: 4, features: 8 } });
        const errors = validateArchitecture(graph).errors;
        expect(errors.some(e => e.includes("memory.in") && e.includes("more than one source"))).toBe(true);
        expect(errors.some(e => e.includes("unused does not reach"))).toBe(true);
    });

    it.each([1, 2, 7])("accepts a tiny NPC sequence with %i time steps", steps => {
        const graph = npcGraph();
        graph.nodes.find(n => n.id === "moments")!.config = { steps, features: 4 };
        graph.nodes.find(n => n.id === "memory")!.config.hidden = 8;
        graph.nodes.find(n => n.id === "actions")!.config.units = 3;
        const result = validateArchitecture(graph);
        expect(result.errors).toEqual([]);
        expect(result.shapes["memory.sequence"]).toEqual(["B", steps, 8]);
        expect(result.shapes["actions.out"]).toEqual(["B", 3]);
    });

    it.each([1, 3, 9])("routes a tiny Pet token sequence of length %i", steps => {
        const graph = petGraph();
        graph.nodes.find(n => n.id === "tokens")!.config.steps = steps;
        graph.nodes.find(n => n.id === "embedding")!.config.width = 8;
        graph.nodes.find(n => n.id === "token_logits")!.config.units = 5;
        for (const node of graph.nodes.filter(n => n.kind === "SparseMoE")) {
            node.config = { experts: 2, topK: 2, hidden: 16 };
        }
        const result = validateArchitecture(graph);
        expect(result.errors).toEqual([]);
        expect(result.shapes["token_logits.out"]).toEqual(["B", steps, 5]);
        expect(result.shapes["router_aux.out"]).toEqual([1]);
    });

    it.each([8, 16, 32])("round-trips a %ix%i image through the U-Net skips", size => {
        const graph = miniPicGraph();
        graph.nodes.find(n => n.id === "image")!.config.height = size;
        graph.nodes.find(n => n.id === "image")!.config.width = size;
        const result = validateArchitecture(graph);
        expect(result.errors).toEqual([]);
        expect(result.shapes["noise.out"]).toEqual(["B", 3, size, size]);
    });

    it("rejects tiny tensors with invalid architectural parameters", () => {
        const npc = npcGraph();
        npc.nodes.find(n => n.id === "memory")!.config.hidden = 0;
        expect(validateArchitecture(npc).errors.some(e => e.includes("hidden must be a positive integer"))).toBe(true);
        const pet = petGraph();
        pet.nodes.find(n => n.id === "moe_0")!.config.topK = 0;
        expect(validateArchitecture(pet).errors.some(e => e.includes("topK must be a positive integer"))).toBe(true);
        const image = miniPicGraph();
        image.nodes.find(n => n.id === "image")!.config.height = 7;
        expect(validateArchitecture(image).errors.some(e => e.includes("height and width must be even"))).toBe(true);
    });
});
