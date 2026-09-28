// Prints Mesha's component catalog as Markdown (docs/MESHA_CATALOG.md's reference section):
//   deno run -A --unstable-sloppy-imports tools/mesha_catalog_doc.ts
import { CATALOG, CATALOG_CATEGORIES } from "../src/apps/mesha/mesha_catalog.ts";

const fmt = (v: unknown) => (v === undefined ? "required" : JSON.stringify(v));
const out: string[] = [];
for (const category of CATALOG_CATEGORIES) {
    out.push(`### ${category}`, "");
    for (const c of CATALOG.values()) {
        if (c.category !== category) continue;
        out.push(`**\`${c.type}\`** (${c.label}, outputs ${c.output}): ${c.description}`, "");
        out.push("| Input | Kind | Default | |", "|---|---|---|---|");
        for (const i of c.inputs) {
            const range = i.min !== undefined || i.max !== undefined ? ` (${i.min ?? ""}..${i.max ?? ""})` : "";
            out.push(`| \`${i.name}\` | ${i.kind}${i.options ? `: ${i.options.join(", ")}` : ""} | ${fmt(i.default)}${range} | ${i.description} |`);
        }
        out.push("");
    }
}
console.log(out.join("\n"));
