// A world to start from when the Planner's library is empty: the Shattered Isles preset with its
// capital and village laid out building by building, forest, meadow and farmland painted around
// them, a guard and a pack of creatures placed, so every part of the Detailer has something to
// show. It is saved into the Planner's own library, so the Planner opens it too.

import type { GameWorld } from "../game_planner/planner_types";
import { PlannerModel } from "../game_planner/planner_model";
import { layOutTown } from "../game_planner/town_planning";
import { createPlacement, emptyOverlay, fillPolygon } from "../game_planner/planning_layers";
import { copyWorld } from "../game_planner/world_store";
import { createCodexEntry } from "../game_planner/codex_model";

const square = (x: number, y: number, r: number): [number, number][] => [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];

export function createSampleWorld(id?: string): GameWorld {
    const base = new PlannerModel().world;
    const world = copyWorld(base, "Shattered Isles (detailed)", id);
    world.structures = [];
    for (const type of ["capital", "village"] as const) {
        const spot = world.spots.find((s) => s.spotType === type);
        if (spot) world.structures.push(...layOutTown(world, spot).structures);
    }
    world.overlay = emptyOverlay(world.meta.worldWidthKm, world.meta.worldHeightKm);
    const capital = world.spots.find((s) => s.spotType === "capital") ?? world.spots[0];
    const village = world.spots.find((s) => s.spotType === "village");
    // Woods to the west of the capital, meadow around it, fields by the village.
    fillPolygon(world.overlay, world.meta, "forest", [[capital.x - 2.4, capital.y - 1.4], [capital.x - 0.55, capital.y - 1.4], [capital.x - 0.55, capital.y + 1.3], [capital.x - 2.4, capital.y + 1.3]], 0.9);
    fillPolygon(world.overlay, world.meta, "meadow", square(capital.x + 0.9, capital.y - 0.9, 0.6), 0.8);
    fillPolygon(world.overlay, world.meta, "rock", square(capital.x + 1.6, capital.y + 1.4, 0.5), 0.7);
    if (village) {
        fillPolygon(world.overlay, world.meta, "farmland", square(village.x, village.y, 0.9), 0.85);
        fillPolygon(world.overlay, world.meta, "conifer", square(village.x - 1.6, village.y + 1.2, 0.8), 0.9);
    }
    // A guard at the capital's gate road, and a pack of creatures in the woods.
    const guard = world.codex.find((c) => c.category === "character") ?? createCodexEntry("Gate Warden", "character", "Keeper of the capital gate", "Watches the road into the capital.");
    if (!world.codex.includes(guard)) world.codex.push(guard);
    let beast = world.codex.find((c) => c.category === "creature");
    if (!beast) { beast = createCodexEntry("Ashen Behemoth", "creature", "Beast of the deep woods", "Roams the woods west of the capital."); world.codex.push(beast); }
    world.placements = [
        createPlacement(guard, capital.x + 0.03, capital.y - 0.06, { count: 2, behavior: "guard" }),
        createPlacement(beast, capital.x - 1.2, capital.y + 0.3, { count: 3, behavior: "wander", levelMin: 8, levelMax: 12 }),
    ];
    world.meta.description = `${world.meta.description} Sample world for the Game World Detailer: its capital and village laid out, woods and fields painted.`.trim();
    return world;
}
