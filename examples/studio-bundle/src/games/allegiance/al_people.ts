// The Mesha human, cached to disk just like the houses. No substitute body geometry.
import { buildHuman, DEFAULT_HUMAN, type HumanParams } from "../../apps/mesha/mesha_human";
import { material } from "../../apps/mesha/mesha_materials";
import type { Mesh } from "../../apps/mesha/mesha_mesh";
import { buildEquipment, type PersonLook } from "./al_models";
import { MAT_BODY, MAT_CLOTH_BOTTOM, MAT_CLOTH_TOP, MAT_SKIN, MAT_HAIR } from "./al_shader";

export const PEOPLE_NAMESPACE = "allegiance-people";
export const PEOPLE_GENERATOR = "people.human:1-allegiance:1";
export type PersonLod = 0 | 1 | 2;
export interface PersonMesh { vertexData: Float32Array; indexData: Uint32Array }
export type PeopleCache = Pick<MeshCacheAPI, "status" | "put" | "get" | "failure">;

export function humanParams(female: boolean): HumanParams {
    return { ...DEFAULT_HUMAN, masculinity: female ? DEFAULT_HUMAN.masculinity : 1,
        hair: { ...DEFAULT_HUMAN.hair, style: female ? DEFAULT_HUMAN.hair.style : "short" },
        quality: "final" };
}

export function humanKey(female: boolean, lod: PersonLod): string {
    return `${PEOPLE_GENERATOR}|${JSON.stringify(humanParams(female))}|lod${lod}`;
}

/** Hysteresis only extends the full-detail range: entering the nearby range always restores LOD 0. */
export function personLod(distance: number, previous?: PersonLod): PersonLod {
    if (distance <= 18 || previous === 0 && distance <= 22) return 0;
    if (distance <= 55 || previous === 1 && distance <= 65) return 1;
    return 2;
}

/** Preserves every vertex, normal and triangle of Mesha's evaluated human. Rotate 180 degrees
 * about Y to match Allegiance's -Z forward. UVs become the game's material/limb attributes. */
export function packHuman(mesh: Mesh): PersonMesh {
    const vertexData = new Float32Array(mesh.parts.reduce((n, p) => n + p.positions.length / 3, 0) * 12);
    const indexData = new Uint32Array(mesh.parts.reduce((n, p) => n + p.indices.length, 0));
    let vo = 0, io = 0;
    const finishes: Record<string, string> = { lips: "lips.natural", nails: "nails.natural", eyes: "eye.sclera",
        iris: "iris.brown", pupil: "eye.pupil", cornea: "eye.cornea", lashes: "hair.lashes",
        shoes: "leather.white", soles: "rubber.white" };
    for (const p of mesh.parts) {
        const base = vo / 12;
        const skin = p.region === "skin", hair = ["hair", "hairCap", "brows", "beard"].includes(p.region);
        const mat = p.region === "cornea" ? 7 : skin ? MAT_SKIN : hair ? MAT_HAIR : p.region === "top" ? MAT_CLOTH_TOP : p.region === "bottom" ? MAT_CLOTH_BOTTOM : MAT_BODY;
        const color = skin || hair || mat === MAT_CLOTH_TOP || mat === MAT_CLOTH_BOTTOM ? [1, 1, 1] : material(finishes[p.region] ?? "fabric.white").color;
        for (let i = 0; i < p.positions.length / 3; i++) {
            const x = -p.positions[i * 3], y = p.positions[i * 3 + 1], z = -p.positions[i * 3 + 2];
            // Arms hang outside the torso. Blend through shoulders/hips so the closed skin stays
            // connected instead of cutting a rigid limb off the body.
            let limb = 0, weight = 0;
            if (y < 0.95) { limb = x < 0 ? 1 : 2; weight = Math.min(1, Math.max(0, (0.95 - y) / 0.16)); }
            if (Math.abs(x) > 0.19 && y > 0.7 && y < 1.5 && !hair) {
                limb = x < 0 ? 3 : 4; weight = Math.min(1, Math.max(0, (Math.abs(x) - 0.19) / 0.065));
            }
            vertexData.set([x, y, z, -p.normals[i * 3], p.normals[i * 3 + 1], -p.normals[i * 3 + 2],
                mat + 0.5, limb + weight * 0.49, ...color, p.region === "cornea" ? material("eye.cornea").clear ?? 0.93 : 1], vo);
            vo += 12;
        }
        for (const index of p.indices) indexData[io++] = base + index;
    }
    return { vertexData, indexData };
}

/** Distant LOD of the same human. Weld only within one material and limb; retain smooth normals.
 * The building simplifier cannot be used here: it discards per-vertex animation attributes. */
export function coarseHuman(mesh: PersonMesh, cell = 0.045): PersonMesh {
    const vertices: number[] = [], remap = new Uint32Array(mesh.vertexData.length / 12);
    const cells = new Map<string, number>();
    for (let i = 0; i < remap.length; i++) {
        const v = mesh.vertexData.subarray(i * 12, i * 12 + 12);
        const key = [Math.floor(v[6]), Math.floor(v[7]), ...[v[0], v[1], v[2]].map(x => Math.round(x / cell)), ...v.subarray(8, 11)].join(",");
        let index = cells.get(key);
        if (index === undefined) { index = vertices.length / 12; cells.set(key, index); vertices.push(...v); }
        remap[i] = index;
    }
    const indices: number[] = [], seen = new Set<string>();
    for (let i = 0; i < mesh.indexData.length; i += 3) {
        const a = remap[mesh.indexData[i]], b = remap[mesh.indexData[i + 1]], c = remap[mesh.indexData[i + 2]];
        if (a === b || b === c || c === a) continue;
        const key = [a, b, c].sort((x, y) => x - y).join(",");
        if (!seen.has(key)) { seen.add(key); indices.push(a, b, c); }
    }
    return { vertexData: new Float32Array(vertices), indexData: new Uint32Array(indices) };
}

export class PeopleMeshes {
    generated = 0;
    private prepared = false;
    constructor(private cache: PeopleCache, private generate = (female: boolean) => packHuman(buildHuman(humanParams(female)))) {}
    /** Called only on the loading screen. At most one costly Mesha evaluation per frame. */
    prepare(): boolean {
        if (this.prepared) return true;
        for (const female of [false, true]) for (const lod of [0, 1, 2] as const) {
            const key = humanKey(female, lod), status = this.cache.status(PEOPLE_NAMESPACE, key);
            if (status === "ready") continue;
            const failure = this.cache.failure(PEOPLE_NAMESPACE, key);
            if (failure) throw new Error(`Human mesh cache: ${failure}`);
            if (status === "pending") return false;
            const source = lod === 0 ? null : this.cache.get(PEOPLE_NAMESPACE, humanKey(female, 0));
            if (lod !== 0 && !source) return false;
            const mesh = lod === 0 ? this.generate(female) : coarseHuman(source!, lod === 1 ? 0.012 : 0.045);
            if (lod === 0) this.generated++;
            this.cache.put(PEOPLE_NAMESPACE, key, { ...mesh, meta: { generator: PEOPLE_GENERATOR, female, lod } }, { background: true });
            return false;
        }
        this.prepared = true;
        return true;
    }
    key(look: PersonLook, lod: PersonLod): string {
        if (!look.hat && !look.soldier && !look.sash && look.weapon === "none") return humanKey(look.female, lod);
        return `${humanKey(look.female, lod)}|gear:${look.hat},${look.soldier},${look.sash},${look.weapon}`;
    }
    /** Cheap equipment composition on a cache miss. Never evaluates a human during gameplay. */
    ensure(look: PersonLook, lod: PersonLod): string | null {
        const key = this.key(look, lod);
        if (this.cache.status(PEOPLE_NAMESPACE, key) === "ready") return key;
        const base = this.cache.get(PEOPLE_NAMESPACE, humanKey(look.female, lod));
        if (!base) { this.prepared = false; return null; }
        const gear = buildEquipment(look), nv = base.vertexData.length / 12;
        const vertexData = new Float32Array(base.vertexData.length + gear.vertexData.length);
        vertexData.set(base.vertexData); vertexData.set(gear.vertexData, base.vertexData.length);
        const indexData = new Uint32Array(base.indexData.length + gear.indexData.length);
        indexData.set(base.indexData);
        gear.indexData.forEach((v, i) => { indexData[base.indexData.length + i] = v + nv; });
        this.cache.put(PEOPLE_NAMESPACE, key, { vertexData, indexData });
        return key;
    }
}
