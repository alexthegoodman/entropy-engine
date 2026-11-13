// Material Lab: a bare wall of one PBR material (materials/pbr_sets.ts) seen at any distance and
// angle, split down the middle so the two halves can use different parallax settings
// (materials/pom.ts) and be compared in one frame. No game, no world: it loads in a second, which
// makes it the test bed for parallax occlusion mapping and the template for plugging the shared
// materials into another addon.
//
// Driven by MCP tools (tests/features/material_lab_live.feature): lab_config picks the material,
// each half's mode, the sun and the exposure; lab_view places the camera; lab_state reports it.

import { labShader, LAB_WORLD_FLOATS, LAB_ITEM_FLOATS } from "./lab_shader";
import { materialLayout, loadMaterialSets, type PbrSet } from "../../materials/pbr_sets";
import { POM_CLASSIC, POM_REFINED, POM_FULL, POM_ULTRA, packPomSettings, type PomSettings } from "../../materials/pom";

const addon = Entropy.AddonAtom.register({
    name: "Material Lab",
    version: "0.1.0",
    description: "A wall of one PBR material, two halves with their own parallax settings, for comparing height-map relief",
    author: ["Entropy Team", "Claude"],
    capabilities: { graphics: true },
});

/** Sets the lab can show (a layer each). Depths are the relief the maps were made for. */
export const LAB_SETS: PbrSet[] = [
    { name: "fieldstone", tile: 1.6, depth: 0.15 },
    { name: "brick-red", tile: 1.8, depth: 0.15 },
    { name: "sandstone-blocks", tile: 2.4, depth: 0.15 },
    { name: "concrete", tile: 2.4, depth: 0.08 },
    { name: "granite", tile: 2.4, depth: 0.08 },
    { name: "stucco", tile: 1.5, depth: 0.08 },
    { name: "roof-clay", tile: 1.8, depth: 0.1 },
    { name: "roof-cedar", tile: 1.8, depth: 0.1 },
    { name: "metal-corrugated", tile: 2, depth: 0.15 },
    { name: "wood-oak", tile: 2.4, depth: 0.03 },
    { name: "asphalt", tile: 4, depth: 0.05 },
    { name: "soil", tile: 2, depth: 0.1 },
    { name: "snow", tile: 4, depth: 0.1 },
];

const MODES: Record<string, PomSettings> = {
    off: { ...POM_CLASSIC, mode: 0 },
    classic: POM_CLASSIC,
    refined: POM_REFINED,
    full: POM_FULL,
    ultra: POM_ULTRA,
};

const WALL_HALF = 3;      // meters each side of x = 0
const WALL_HEIGHT = 3;
const layout = materialLayout();

interface LabState {
    material: string;
    left: string;
    right: string;
    leftSettings: PomSettings;
    rightSettings: PomSettings;
    depthScale: number;
    sunAzimuth: number;     // degrees around the wall normal (0 = straight on)
    sunElevation: number;   // degrees above the horizon
    exposure: number;
    fadeNear: number;
    fadeFar: number;
    pole: boolean;
    view: { distance: number; yaw: number; pitch: number; x: number; y: number; fov: number };
}

const state: LabState = {
    material: "fieldstone", left: "classic", right: "refined",
    leftSettings: { ...POM_CLASSIC }, rightSettings: { ...POM_REFINED },
    depthScale: 1, sunAzimuth: 55, sunElevation: 35, exposure: 1.0, fadeNear: 6, fadeFar: 14, pole: false,
    view: { distance: 1.2, yaw: 0, pitch: 0, x: 0, y: 1.4, fov: 60 },
};

let pipelineId = "";
let worldBuffer = "";
let leftBuffer = "";
let rightBuffer = "";
let poleBuffer = "";
let missing: string[] = [];

const uniform = (floats: number) => Entropy.Buffer.create({ size: floats * 4, usage: "Uniform" });

function writeWorld(): void {
    const az = state.sunAzimuth * Math.PI / 180, el = state.sunElevation * Math.PI / 180;
    // The wall faces +z; azimuth swings the sun toward +x.
    const sun = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
    Entropy.Buffer.write(worldBuffer, new Float32Array([sun[0], sun[1], sun[2], 3.2, 0.62, 0.72, 0.9, state.exposure]));
}

function writeItem(buffer: string, settings: PomSettings, material = state.material): void {
    const layer = Math.max(0, LAB_SETS.findIndex(s => s.name === material));
    Entropy.Buffer.write(buffer, new Float32Array([...packPomSettings(settings), layer, state.depthScale, state.fadeNear, state.fadeFar]));
}

function writeAll(): void {
    writeWorld();
    writeItem(leftBuffer, state.leftSettings);
    writeItem(rightBuffer, state.rightSettings);
    writeItem(poleBuffer, MODES.off, "wood-oak");
}

function placeCamera(): void {
    const v = state.view;
    const yaw = v.yaw * Math.PI / 180, pitch = v.pitch * Math.PI / 180;
    const target: [number, number, number] = [v.x, v.y, 0];
    const pos: [number, number, number] = [
        v.x + v.distance * Math.sin(yaw) * Math.cos(pitch),
        v.y + v.distance * Math.sin(pitch),
        v.distance * Math.cos(yaw) * Math.cos(pitch),
    ];
    Entropy.Camera.setTransform(pos, target, [0, 1, 0]);
    Entropy.Camera.setFov(v.fov);
}

/** One wall panel [x0, x1] x [0, WALL_HEIGHT], facing +z, uv in meters (v up). */
function panel(x0: number, x1: number): { vertexData: number[]; indexData: number[] } {
    const corner = (x: number, y: number) => [x, y, 0, 0, 0, 1, x, y, 1, 1, 1, 1];
    return {
        vertexData: [...corner(x0, 0), ...corner(x1, 0), ...corner(x1, WALL_HEIGHT), ...corner(x0, WALL_HEIGHT)],
        indexData: [0, 1, 2, 0, 2, 3],
    };
}

function createWall(id: string, x0: number, x1: number, itemBuffer: string): void {
    const { vertexData, indexData } = panel(x0, x1);
    Entropy.Model.clearMesh(id);
    Entropy.Model.createMesh({
        id, position: [0, 0, 0], vertexData, indexData, pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: worldBuffer } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: itemBuffer } } },
            ...layout.bindings,
        ],
    });
}

/**
 * A square pole standing in the wall: it starts behind the wall plane (inside the relief) and
 * reaches out in front of it, so where the stones' displaced depth is right, they hide its foot
 * in places and its sides show in the crevices. A flat tracer draws it over the whole wall plane.
 */
function pole(): { vertexData: number[]; indexData: number[] } {
    const [x0, x1, y0, y1, z0, z1] = [0.3, 0.45, 0.2, WALL_HEIGHT - 0.2, -0.14, 0.2];
    const vertexData: number[] = [], indexData: number[] = [];
    const face = (n: number[], corners: number[][], uvs: number[][]) => {
        const base = vertexData.length / 12;
        corners.forEach((c, i) => vertexData.push(...c, ...n, ...uvs[i], 1, 1, 1, 1));
        indexData.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    face([0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    face([1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[z1, y0], [z0, y0], [z0, y1], [z1, y1]]);
    face([-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
    return { vertexData, indexData };
}

function createPole(): void {
    const { vertexData, indexData } = pole();
    Entropy.Model.clearMesh("lab-pole");
    Entropy.Model.createMesh({
        id: "lab-pole", position: [0, 0, 0], vertexData, indexData, pipelineId,
        bindings: [
            { group: 2, binding: 0, resource: { type: "Buffer", value: { id: worldBuffer } } },
            { group: 2, binding: 1, resource: { type: "Buffer", value: { id: poleBuffer } } },
            ...layout.bindings,
        ],
    });
    Entropy.Model.setInstanceCount("lab-pole", 0);
}

type Args = Record<string, any>;

function pickMode(name: string, extra?: Args): PomSettings {
    const base = MODES[name];
    if (!base) throw new Error(`Unknown mode ${name}; use ${Object.keys(MODES).join(", ")}`);
    const out = { ...base };
    if (extra) {
        for (const key of ["minSteps", "maxSteps", "refine", "shadowSteps", "shadowSoft", "smooth"] as const) {
            if (typeof extra[key] === "number") out[key] = extra[key];
        }
        for (const key of ["jitter", "depthWrite"] as const) {
            if (typeof extra[key] === "boolean") out[key] = extra[key];
        }
    }
    return out;
}

const snapshot = () => ({
    material: state.material, left: state.left, right: state.right,
    leftSettings: state.leftSettings, rightSettings: state.rightSettings,
    depthScale: state.depthScale, sun: { azimuth: state.sunAzimuth, elevation: state.sunElevation },
    exposure: state.exposure, pole: state.pole, view: state.view, missingMaps: missing, materials: LAB_SETS.map(s => s.name),
});

const TOOLS: { name: string; description: string; parameters: any; run: (a: Args) => any }[] = [
    {
        name: "lab_config",
        description: "Pick the material, each half's parallax mode (off, classic, refined, full; left/right, with leftOptions/rightOptions overriding minSteps, maxSteps, refine, shadowSteps, shadowSoft, jitter, depthWrite), the sun (azimuth, elevation in degrees), exposure, depthScale (relief multiplier), fadeNear/fadeFar (meters) and pole (a square pole piercing the wall, to check depth).",
        parameters: { type: "object", properties: {
            material: { type: "string" }, left: { type: "string" }, right: { type: "string" },
            leftOptions: { type: "object" }, rightOptions: { type: "object" },
            sunAzimuth: { type: "number" }, sunElevation: { type: "number" }, exposure: { type: "number" },
            depthScale: { type: "number" }, fadeNear: { type: "number" }, fadeFar: { type: "number" }, pole: { type: "boolean" },
        } },
        run: a => {
            if (typeof a.material === "string") {
                if (!LAB_SETS.some(s => s.name === a.material)) throw new Error(`Unknown material ${a.material}; use ${LAB_SETS.map(s => s.name).join(", ")}`);
                state.material = a.material;
            }
            if (typeof a.left === "string") { state.left = a.left; state.leftSettings = pickMode(a.left, a.leftOptions); }
            else if (a.leftOptions) state.leftSettings = pickMode(state.left, { ...state.leftSettings, ...a.leftOptions });
            if (typeof a.right === "string") { state.right = a.right; state.rightSettings = pickMode(a.right, a.rightOptions); }
            else if (a.rightOptions) state.rightSettings = pickMode(state.right, { ...state.rightSettings, ...a.rightOptions });
            for (const key of ["sunAzimuth", "sunElevation", "exposure", "depthScale", "fadeNear", "fadeFar"] as const) {
                if (typeof a[key] === "number") state[key] = a[key];
            }
            if (typeof a.pole === "boolean") { state.pole = a.pole; Entropy.Model.setInstanceCount("lab-pole", a.pole ? 1 : 0); }
            writeAll();
            return snapshot();
        },
    },
    {
        name: "lab_view",
        description: "Place the camera: distance from the wall (m), yaw and pitch (degrees around the point looked at), x and y of that point on the wall, fov.",
        parameters: { type: "object", properties: {
            distance: { type: "number" }, yaw: { type: "number" }, pitch: { type: "number" },
            x: { type: "number" }, y: { type: "number" }, fov: { type: "number" },
        } },
        run: a => {
            for (const key of ["distance", "yaw", "pitch", "x", "y", "fov"] as const) {
                if (typeof a[key] === "number") state.view[key] = a[key];
            }
            placeCamera();
            return snapshot();
        },
    },
    { name: "lab_state", description: "What the lab shows now.", parameters: { type: "object", properties: {} }, run: () => snapshot() },
];

addon.onInit(() => {
    pipelineId = Entropy.Pipeline.create({
        name: "Material Lab", layout: "mesh", pbr: false, doubleSided: true,
        vertexShader: labShader(layout, LAB_SETS), fragmentShader: labShader(layout, LAB_SETS),
        extraBindGroups: [{ entries: [
            { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
            ...layout.entries,
        ] }],
    });
    try {
        missing = loadMaterialSets(LAB_SETS, c => Entropy.Texture.loadArray(c), layout);
        if (missing.length) Entropy.println(`[material-lab] maps missing (fallback): ${missing.join(", ")}`);
    } catch (e) { Entropy.println(`[material-lab] material maps: ${(e as Error).message}`); }
    worldBuffer = uniform(LAB_WORLD_FLOATS);
    leftBuffer = uniform(LAB_ITEM_FLOATS);
    poleBuffer = uniform(LAB_ITEM_FLOATS);
    rightBuffer = uniform(LAB_ITEM_FLOATS);
    writeAll();
    createWall("lab-wall-left", -WALL_HALF, 0, leftBuffer);
    createWall("lab-wall-right", 0, WALL_HALF, rightBuffer);
    createPole();
    placeCamera();
    for (const t of TOOLS) {
        addon.registerTool({ name: t.name, description: t.description, parameters: t.parameters }, (args: Args) => {
            try { return { success: true, ...t.run(args && typeof args === "object" ? args : {}) }; }
            catch (error) { return { success: false, error: (error as Error).message }; }
        });
    }
    Entropy.println("[material-lab] ready");
});
