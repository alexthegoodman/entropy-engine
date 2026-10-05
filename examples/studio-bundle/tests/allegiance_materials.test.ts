// Textured PBR surfaces (al_materials.ts): the material table, the files and fallbacks each map
// loads with, the bindings, and the shader that samples them. The live tier is
// tests/features/allegiance_materials_live.feature.
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MATERIAL_SETS, MATERIAL_MAPS, materialFiles, materialFallback, materialTable, materialBindings, MATERIAL_BIND_ENTRIES, loadMaterials, materialTextureId } from "../src/games/allegiance/al_materials";
import { ALLEGIANCE_SHADER, ALLEGIANCE_INSTANCED_SHADER, PEOPLE_SHADER } from "../src/games/allegiance/al_shader";
import { buildMilitary } from "../src/games/allegiance/al_models";
import { SURFACE, surfaceKind } from "../src/apps/quadplanet/qp_shader";

describe("material sets", () => {
    it("has every map of every set on disk (paths are relative to the repository root)", () => {
        for (const map of MATERIAL_MAPS) for (const f of materialFiles(map)) expect(existsSync(resolve(__dirname, "../../..", f)), f).toBe(true);
    });

    it("lays fieldstone on rubble walls only, leaving dressed stone procedural", () => {
        const t = materialTable();
        expect(t.layer[SURFACE.fieldstone]).toBe(0);
        expect(t.layer[SURFACE.stone]).toBe(-1);
        expect(t.tile[SURFACE.fieldstone]).toBeGreaterThan(0.5);
        expect(surfaceKind("masonry.fieldstone")).toBe(SURFACE.fieldstone);
        expect(surfaceKind("stone.sandstone")).toBe(SURFACE.stone);
    });

    it("loads each map as one array, color in sRGB, and falls back to a checkerboard (color) or neutral values", () => {
        const calls: { id: string; files: string[]; srgb: boolean; fallback: unknown }[] = [];
        const r = loadMaterials(c => { calls.push(c); return { missing: c.id === materialTextureId("basecolor") ? [0] : [] }; });
        expect(calls.map(c => c.id)).toEqual(MATERIAL_MAPS.map(materialTextureId));
        expect(calls.every(c => c.files.length === MATERIAL_SETS.length)).toBe(true);
        expect(calls.find(c => c.srgb)?.id).toBe(materialTextureId("basecolor"));
        expect(materialFallback("basecolor")).toBe("checker");
        expect(materialFallback("normal")).toEqual([0.5, 0.5, 1, 1]);
        expect(r.missing).toEqual([{ map: "basecolor", set: "fieldstone" }]);
    });

    it("binds the maps and a tiling sampler after the world and records in group 2", () => {
        const b = materialBindings();
        expect(b.map(x => x.binding)).toEqual([2, 3, 4, 5, 6]);
        expect(b.every(x => x.group === 2)).toBe(true);
        expect(b[4].resource).toEqual({ type: "SamplerRepeat" });
        expect(MATERIAL_BIND_ENTRIES.slice(0, 4).every(e => e.resourceType === "TextureArray")).toBe(true);
    });

    it("draws the compounds' perimeter walls as fieldstone", () => {
        const wall = buildMilitary("wall");
        const kinds = new Set<number>();
        for (let i = 0; i < wall.vertexData.length; i += 12) if (Math.floor(wall.vertexData[i + 6]) === 11) kinds.add(Math.floor(wall.vertexData[i + 7]));
        expect([...kinds]).toEqual([SURFACE.fieldstone]);
    });
});

describe("textured shader", () => {
    it("samples the maps (with parallax) only in the houses pipeline, whose layout binds them", () => {
        expect(ALLEGIANCE_INSTANCED_SHADER).toContain("var mat_basecolor: texture_2d_array<f32>;");
        expect(ALLEGIANCE_INSTANCED_SHADER).toContain("fn textured_surface(");
        expect(ALLEGIANCE_INSTANCED_SHADER).toContain("textureSampleGrad(mat_height");
        // Derivatives are taken before any branch (uniform control flow).
        expect(ALLEGIANCE_INSTANCED_SHADER.indexOf("let mat_dx = dpdx(mat_uv0);")).toBeLessThan(ALLEGIANCE_INSTANCED_SHADER.lastIndexOf("if (material == 9) {"));
        for (const s of [ALLEGIANCE_SHADER, PEOPLE_SHADER]) expect(s).not.toContain("mat_basecolor");
    });
});
