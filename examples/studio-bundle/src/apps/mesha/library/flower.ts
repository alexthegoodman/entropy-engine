import type { ObjectDef, NodeDef } from "../mesha_object";

/**
 * A single flower: a curving stem with leaves, a rosette of basal leaves and a head of layered petals
 * around an optional seed disc. Daisy, tulip, poppy, sunflower, rose-like and cosmos come from the
 * same controls.
 */

// Position on the stem at fraction f of its height: a parabola, so leaves and head stay attached.
const stemX = (f: string) => `(bendX * ${f} * ${f})`;
const stemPoints = [0, 0.2, 0.4, 0.6, 0.8, 1].map(f => [`=${stemX(String(f))}`, `=height * ${f}`, 0]);

const flower: ObjectDef = {
    id: "nature.flower",
    name: "Flower",
    category: "Nature",
    tags: ["flower", "daisy", "tulip", "poppy", "sunflower", "rose", "cosmos", "bloom", "blossom", "petal", "petals", "garden", "wildflower", "plant", "foliage", "nature"],
    description: "A stemmed flower with layered petals, seed disc and leaves.",
    featured: ["height", "headSize", "petals", "layers", "openness", "petalFinish", "seed"],
    groups: [
        { id: "stem", label: "Stem & leaves" },
        { id: "head", label: "Head" },
        { id: "petal", label: "Petals" },
        { id: "materials", label: "Materials" },
    ],
    params: [
        { id: "height", label: "Height", type: "number", default: 0.5, min: 0.08, max: 2.5, unit: "m", group: "stem" },
        { id: "stemThickness", label: "Stem thickness", type: "number", default: 0.008, min: 0.002, max: "=height * 0.03 + 0.004", unit: "m", group: "stem" },
        { id: "bend", label: "Bend", type: "number", default: 0.12, min: 0, max: 0.6, group: "stem", description: "How far the stem leans over, as a share of its height." },
        { id: "nod", label: "Nod", type: "number", default: 12, min: 0, max: 90, unit: "°", group: "stem", description: "How far the head tips over." },
        { id: "leaves", label: "Stem leaves", type: "int", default: 4, min: 0, max: 10, group: "stem" },
        { id: "leafLength", label: "Leaf length", type: "number", default: 0.16, min: 0.03, max: "=max(0.05, height * 0.9)", unit: "m", group: "stem" },
        { id: "leafWidth", label: "Leaf width", type: "number", default: 0.28, min: 0.08, max: 0.9, group: "stem", description: "As a share of its length." },
        { id: "leafCurl", label: "Leaf curl", type: "number", default: 35, min: 0, max: 90, unit: "°", group: "stem" },
        { id: "basal", label: "Ground leaves", type: "int", default: 4, min: 0, max: 10, group: "stem" },
        { id: "headSize", label: "Head width", type: "number", default: 0.1, min: 0.02, max: "=max(0.03, height * 0.6)", unit: "m", group: "head" },
        { id: "centerSize", label: "Center size", type: "number", default: 0.3, min: 0, max: 0.7, group: "head", description: "The seed disc, as a share of the head's radius (0 for a tulip or rose)." },
        { id: "centerDome", label: "Center dome", type: "number", default: 0.45, min: 0.1, max: 1.3, group: "head", visibleIf: "=centerSize > 0" },
        { id: "petals", label: "Petals per layer", type: "int", default: 12, min: 3, max: 40, group: "petal" },
        { id: "layers", label: "Layers", type: "int", default: 1, min: 1, max: 6, group: "petal" },
        { id: "openness", label: "Openness", type: "number", default: 78, min: 0, max: 100, unit: "°", group: "petal", description: "Angle of the petals from upright: 0 is a closed bud, 90 lies flat." },
        { id: "openStep", label: "Layer opening", type: "number", default: 0, min: -25, max: 25, unit: "°", group: "petal", visibleIf: "=layers > 1", description: "How much wider each inner layer is set." },
        { id: "layerScale", label: "Layer shrink", type: "number", default: 0.8, min: 0.4, max: 1.1, group: "petal", visibleIf: "=layers > 1" },
        { id: "petalWidth", label: "Petal width", type: "number", default: 0.35, min: 0.1, max: 1.3, group: "petal", description: "As a share of the petal's length." },
        { id: "petalRound", label: "Petal roundness", type: "number", default: 0.7, min: 0.3, max: 2.2, group: "petal", description: "Below 1 blunt, above 1 pointed." },
        { id: "petalWidest", label: "Widest at", type: "number", default: 0.5, min: 0.2, max: 0.8, group: "petal" },
        { id: "petalCup", label: "Petal cup", type: "number", default: 15, min: 0, max: 60, unit: "°", group: "petal" },
        { id: "petalCurl", label: "Petal curl", type: "number", default: 20, min: -30, max: 80, unit: "°", group: "petal", description: "Positive rolls the tips back." },
        { id: "petalRuffle", label: "Ruffle", type: "number", default: 0, min: 0, max: 0.5, group: "petal" },
        { id: "petalVariety", label: "Irregularity", type: "number", default: 0.25, min: 0, max: 1, group: "petal" },
        { id: "petalFinish", label: "Petals", type: "material", default: "petal.white", materials: ["petal"], group: "materials" },
        { id: "centerFinish", label: "Center", type: "material", default: "flower.gold", materials: ["flower"], group: "materials", visibleIf: "=centerSize > 0" },
        { id: "leafFinish", label: "Leaves", type: "material", default: "leaf.fresh", materials: ["leaf"], group: "materials" },
        { id: "stemFinish", label: "Stem", type: "material", default: "stem.green", materials: ["stem"], group: "materials" },
        { id: "seed", label: "Seed", type: "seed", default: 4, group: "materials", variation: 0 },
    ],
    derived: {
        bendX: "=height * bend",
        petalLen: "=headSize / 2",
        headTilt: "=nod + deg(atan2(2 * bend, 1)) * 0.6",
    },
    rules: [
        { check: "=stemThickness < headSize * 0.5", message: "The stem is thicker than the flower head." },
    ],
    regions: {
        stem: { label: "Stem", material: "=stemFinish" },
        leaves: { label: "Leaves", material: "=leafFinish" },
        petals: { label: "Petals", material: "=petalFinish" },
        center: { label: "Seed disc", material: "=centerFinish" },
    },
    presets: [
        { name: "Daisy", values: { height: 0.4, headSize: 0.1, petals: 21, openness: 88, petalWidth: 0.16, petalRound: 0.8, petalCup: 6, petalCurl: 12, centerSize: 0.34, centerFinish: "flower.gold", petalFinish: "petal.white", leaves: 3, basal: 5, leafWidth: 0.2 } },
        { name: "Tulip", values: { height: 0.45, headSize: 0.09, petals: 3, layers: 2, openness: 8, openStep: 0, layerScale: 0.95, petalWidth: 1.05, petalRound: 0.5, petalWidest: 0.5, petalCup: 38, petalCurl: 22, centerSize: 0, petalFinish: "petal.red", leaves: 2, leafLength: 0.3, leafWidth: 0.2, leafCurl: 25, basal: 2, bend: 0.04, nod: 4, stemThickness: 0.009 } },
        { name: "Poppy", values: { height: 0.5, headSize: 0.11, petals: 4, layers: 1, openness: 62, petalWidth: 1.0, petalRound: 0.45, petalWidest: 0.55, petalCup: 28, petalCurl: 22, petalRuffle: 0.14, centerSize: 0.14, centerDome: 0.9, centerFinish: "flower.center", petalFinish: "petal.red", leaves: 3, leafWidth: 0.24, basal: 4, nod: 22 } },
        { name: "Sunflower", values: { height: 1.6, stemThickness: 0.026, headSize: 0.34, petals: 30, layers: 2, openness: 84, openStep: -2, layerScale: 0.86, petalWidth: 0.24, petalRound: 1.0, petalCup: 4, petalCurl: 18, centerSize: 0.5, centerDome: 0.3, centerFinish: "flower.center", petalFinish: "petal.yellow", leaves: 7, leafLength: 0.32, leafWidth: 0.75, leafCurl: 30, basal: 0, bend: 0.06, nod: 32 } },
        { name: "Garden rose", values: { height: 0.6, stemThickness: 0.009, headSize: 0.11, petals: 7, layers: 4, openness: 62, openStep: -15, layerScale: 0.8, petalWidth: 1.0, petalRound: 0.45, petalCup: 42, petalCurl: 34, centerSize: 0, petalFinish: "petal.pink", petalVariety: 0.15, leaves: 5, leafLength: 0.12, leafWidth: 0.55, leafCurl: 20, basal: 0, nod: 10 } },
        { name: "Cosmos", values: { height: 0.7, headSize: 0.1, petals: 8, openness: 84, petalWidth: 0.6, petalRound: 0.55, petalWidest: 0.7, petalCup: 10, petalCurl: 12, petalRuffle: 0.12, centerSize: 0.2, centerFinish: "flower.gold", petalFinish: "petal.magenta", leaves: 6, leafWidth: 0.1, leafCurl: 20, basal: 0, nod: 15 } },
    ],
    nodes: [
        { id: "stemPath", type: "path.points", output: false, points: stemPoints, smooth: 5 },
        { id: "stem", type: "mesh.sweep", path: "@stemPath", radius: "=stemThickness", sides: 6, taper: 0.8, region: "stem" },
        {
            id: "leaf", type: "mesh.leaf", output: false, length: "=leafLength", width: "=leafLength * leafWidth", widest: 0.38, fullness: 1, stalk: "=leafLength * 0.05",
            fold: 22, curl: "=leafCurl", rows: 5, half: 1,
        },
        {
            id: "stemLeaves", type: "geo.transform", repeat: "=leaves", when: "=leaves > 0", mesh: "@leaf",
            at: [`=${stemX("(0.08 + 0.55 * t)")}`, "=height * (0.08 + 0.55 * t)", 0],
            rotate: ["=-90 + 55 - 30 * t + (rand(index, 1) - 0.5) * 20", "=index * 137.5 + 15", 0],
            scale: "=1 - 0.4 * t",
            region: "leaves",
        },
        {
            id: "basalLeaves", type: "instance.rosette", when: "=basal > 0", mesh: "@leaf", count: "=basal", layers: 1, open: 70, openStep: 0, scaleStep: 1, lift: 0, jitter: 0.5, seed: "=seed * 3 + 1", region: "leaves",
        },
        {
            id: "petal", type: "mesh.leaf", output: false, length: "=petalLen", width: "=petalLen * petalWidth", widest: "=petalWidest", fullness: "=petalRound", fold: "=petalCup", curl: "=petalCurl",
            wave: "=petalRuffle", waveCount: 4, rows: 6, half: 1,
        },
        {
            id: "petalRing", type: "instance.rosette", output: false, mesh: "@petal", count: "=petals", layers: "=layers", open: "=openness", openStep: "=openStep", scaleStep: "=layerScale", lift: "=petalLen * 0.05",
            jitter: "=petalVariety", seed: "=seed * 3 + 2",
        },
        {
            id: "head", type: "geo.transform", mesh: "@petalRing", at: [`=${stemX("1")}`, "=height", 0], rotate: [0, 0, "=-headTilt"], region: "petals",
        },
        { id: "disc", type: "mesh.icosphere", output: false, when: "=centerSize > 0", radius: "=headSize / 2 * centerSize", subdivisions: 2 },
        { id: "discShape", type: "deform.noise", output: false, when: "=centerSize > 0", mesh: "@disc", amount: "=headSize * 0.012", frequency: 40, octaves: 2, seed: "=seed", radial: true },
        {
            id: "center", type: "geo.transform", when: "=centerSize > 0", mesh: "@discShape",
            at: [`=${stemX("1")}`, "=height", 0], rotate: [0, 0, "=-headTilt"], scale: [1, "=centerDome", 1], region: "center",
        },
    ] as NodeDef[],
    limits: { maxSize: 4, minSize: 0.05, maxTriangles: 40000, floorTolerance: 0.03 },
};

export default flower;
