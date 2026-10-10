// Renders a procedural Mesha scene into a PNG contact sheet: an overview and walk-through views
// along its road, under the scene's mood.
//   deno run -A --unstable-sloppy-imports tools/mesha_scene_render.ts <scene id> [out.png] [json values] [width]
import { writeFileSync } from "node:fs";
import { lookupObject } from "../src/apps/mesha/library/index.ts";
import { lookupScene } from "../src/apps/mesha/scenes/index.ts";
import { evaluateScene } from "../src/apps/mesha/mesha_scene_def.ts";
import { evaluateObject } from "../src/apps/mesha/mesha_object.ts";
import { transformMesh, type Mesh, type Vec3 } from "../src/apps/mesha/mesha_mesh.ts";
import { instanceMatrix } from "../src/apps/mesha/mesha_scene.ts";
import type { MaterialPreset } from "../src/apps/mesha/mesha_materials.ts";
import { render, contactSheet } from "../src/apps/mesha/mesha_raster.ts";
import { encodePng } from "./mesha_png.ts";

const [id, out = `/tmp/${id}.png`, list, widthArg] = Deno.args;
const def = lookupScene(id);
if (!def) throw new Error(`no scene ${id}`);
const values = list ? JSON.parse(list) : {};
const tw = widthArg ? Number(widthArg) : 520;

const started = performance.now();
const scene = evaluateScene(def, values, lookupObject);
const parts: Mesh["parts"] = [];
const materials: Record<string, MaterialPreset> = {};
let triangles = 0;
scene.placements.forEach((p, i) => {
    const e = evaluateObject(lookupObject(p.objectId)!, p.values, lookupObject);
    triangles += e.stats.triangles;
    const world = transformMesh(e.mesh, instanceMatrix({ id: p.key, objectId: p.objectId, values: p.values, position: p.position, rotationY: p.rotationY, scale: p.scale }));
    for (const part of world.parts) {
        const region = `${i}:${part.region}`;
        materials[region] = e.materials[part.region];
        parts.push({ ...part, region });
    }
});
console.log(`${scene.placements.length} objects, ${triangles} triangles, ${(performance.now() - started).toFixed(0)} ms; lighting ${scene.lighting}; ${scene.violations.join("; ")}`);
const mesh: Mesh = { parts };

const MOODS: Record<string, { haze: { color: [number, number, number]; density: number }; grade: [number, number, number] }> = {
    ashen: { haze: { color: [0.62, 0.53, 0.43], density: 0.008 }, grade: [1.0, 0.86, 0.72] },
    toxic: { haze: { color: [0.5, 0.56, 0.36], density: 0.016 }, grade: [0.86, 1.0, 0.7] },
    night: { haze: { color: [0.06, 0.07, 0.1], density: 0.028 }, grade: [0.32, 0.38, 0.52] },
};
const mood = MOODS[scene.lighting ?? "ashen"] ?? MOODS.ashen;
const P = scene.params;
const L = Number(P.length), Wd = Number(P.width);
const domeZ = -L / 2 + Number(P.domeRadius) + 6;
const views: { caption: string; eye: Vec3; target: Vec3; fov?: number }[] = [
    { caption: "overview from the start", eye: [Wd * 0.55, L * 0.42, L * 0.78], target: [0, 0, -L * 0.08], fov: 42 },
    { caption: "start: eye level down the road", eye: [1.2, 1.7, L / 2 - 3], target: [0, 4, domeZ], fov: 55 },
    { caption: "through the checkpoint gap", eye: [Number(P.roadWidth) / 2 - 1.8, 1.7, L / 2 - 15], target: [0.5, 4, domeZ], fov: 55 },
    { caption: "the corridor, outpost side", eye: [2.5, 2.2, 6], target: [-12, 3, -6], fov: 60 },
    { caption: "arriving at the plaza", eye: [-Number(P.roadWidth) / 2 - 1, 1.7, domeZ + Number(P.domeRadius) + 17], target: [0, 7, domeZ], fov: 58 },
    { caption: "top down", eye: [0, L * 1.05, 2], target: [0, 0, 0], fov: 50 },
];
const tiles = views.map(v => ({ caption: v.caption, image: render(mesh, materials, { width: tw, height: Math.round(tw * 0.62), eye: v.eye, target: v.target, fov: v.fov, haze: mood.haze, grade: mood.grade, ss: 2 }) }));
const sheet = contactSheet(tiles, 2);
writeFileSync(out, encodePng(sheet.width, sheet.height, sheet.data));
console.log(out);
