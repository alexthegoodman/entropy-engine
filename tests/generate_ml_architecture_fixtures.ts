// Regenerate Rust fixture graphs from the editor's actual presets.
import { miniPicGraph, npcGraph, petGraph, tinyArchitecture, validateArchitecture } from "../examples/studio-bundle/src/apps/ml_architecture_graph.ts";

for (const [kind, make] of [["npc", npcGraph], ["pet", petGraph], ["mini_pic", miniPicGraph]] as const) {
    const graph = tinyArchitecture(make(), kind);
    const validation = validateArchitecture(graph);
    if (validation.errors.length) throw new Error(`${kind}: ${validation.errors.join("; ")}`);
    Deno.mkdirSync("tests/fixtures", { recursive: true });
    Deno.writeTextFileSync(`tests/fixtures/ml_${kind}_tiny.json`, JSON.stringify(graph, null, 2) + "\n");
}
