// Renders one Mesha object at given parameter sets into a PNG contact sheet.
//   deno run -A tools/mesha_render.ts <object id> [out.png] [json list of {caption, values}] [yaw] [pitch]
import { writeFileSync } from "node:fs";
import { evaluateObject, type ParamValues } from "../src/apps/mesha/mesha_object.ts";
import { lookupObject } from "../src/apps/mesha/library/index.ts";
import { render, contactSheet } from "../src/apps/mesha/mesha_raster.ts";
import { encodePng } from "./mesha_png.ts";

const [id, out = `/tmp/${id}.png`, list, yaw, pitch] = Deno.args;
const def = lookupObject(id);
if (!def) throw new Error(`no object ${id}`);
const configs: { caption: string; values: ParamValues }[] = list && list !== "-" ? JSON.parse(list) : [{ caption: "default", values: {} }, ...(def.presets ?? []).map(p => ({ caption: p.name, values: p.values }))];
const tiles = configs.map(c => {
    const e = evaluateObject(def, c.values, lookupObject);
    console.log(`${c.caption}: ${e.stats.triangles} tris ${e.stats.ms.toFixed(1)} ms ${e.violations.join("; ")}`);
    return { caption: c.caption, image: render(e.mesh, e.materials, { width: 360, height: 300, yaw: yaw ? Number(yaw) : 35, pitch: pitch ? Number(pitch) : 22 }) };
});
const sheet = contactSheet(tiles, Math.min(3, tiles.length));
writeFileSync(out, encodePng(sheet.width, sheet.height, sheet.data));
console.log(out);
