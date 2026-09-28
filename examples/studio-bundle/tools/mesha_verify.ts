// Mesha's agent verification loop, step "test": fuzzes every library object, prints the acceptance
// report, and renders a contact sheet per object (defaults, presets, extremes, random configurations)
// for a visual pass.
//   deno run -A --unstable-sloppy-imports tools/mesha_verify.ts [out dir] [object id ...]
import { mkdirSync, writeFileSync } from "node:fs";
import { evaluateObject } from "../src/apps/mesha/mesha_object.ts";
import { LIBRARY, lookupObject } from "../src/apps/mesha/library/index.ts";
import { fuzz, acceptanceText } from "../src/apps/mesha/mesha_verify.ts";
import { render, contactSheet } from "../src/apps/mesha/mesha_raster.ts";
import { encodePng } from "./mesha_png.ts";

const [outDir = "test-artifacts/mesha", ...only] = Deno.args;
mkdirSync(outDir, { recursive: true });
let allReady = true;
for (const def of LIBRARY.filter(d => (only.length ? only.includes(d.id) : true))) {
    const a = fuzz(def, lookupObject);
    // Visual sample: defaults and presets first, then the most extreme and a spread of random ones.
    const pick = [
        ...a.results.filter(r => r.label === "default" || r.label.startsWith("preset")),
        ...a.results.filter(r => /=(min|max)$/.test(r.label)).filter((_, i) => i % 3 === 0).slice(0, 8),
        ...a.results.filter(r => r.label.startsWith("random")).slice(0, 8),
        ...a.failures,
    ].filter((r, i, all) => all.indexOf(r) === i).slice(0, 24);
    const sheetPath = `${outDir}/${def.id}.png`;
    if (!def.component) {
        const tiles = pick.map(r => {
            const e = evaluateObject(def, r.values, lookupObject);
            return { caption: r.label, image: render(e.mesh, e.materials, { width: 220, height: 190, ss: 1 }) };
        });
        const sheet = contactSheet(tiles, 6);
        writeFileSync(sheetPath, encodePng(sheet.width, sheet.height, sheet.data));
    }
    console.log(`\n${acceptanceText(a, def.component ? 0 : pick.length)}${def.component ? "" : `\nContact sheet: ${sheetPath}`}`);
    for (const p of a.definitionProblems) console.log(`  definition: ${p}`);
    for (const f of a.failures) console.log(`  FAIL ${f.label}: ${f.issues.filter(i => i.severity === "error").map(i => i.message).join("; ")}`);
    const warned = new Map<string, number>();
    for (const w of a.warnings) for (const i of w.issues) if (i.severity === "warning") warned.set(i.message, (warned.get(i.message) ?? 0) + 1);
    for (const [m, c] of warned) console.log(`  warning x${c}: ${m}`);
    if (!a.ready) allReady = false;
}
if (!allReady) Deno.exit(1);
