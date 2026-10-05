// Going inside houses. The Mesha houses have real rooms; a house you enter stops being a solid
// block for you: you walk its floor inside its outer walls, find whatever supplies were left
// behind, and leave by the front door. Office blocks and other buildings stay closed.
//
// Works in a building's own axes: u along its right axis, v along its depth (positive v toward
// the street door), both from the footprint's center.

import { type Rect } from "./al_nav";

/** Meters from the door's outside spot that let you go in. */
export const DOOR_REACH = 2.4;
/** Walls are this thick (inside the footprint). */
export const WALL = 0.35;

export const toU = (r: Rect, x: number, z: number) => (x - r.cx) * r.ux + (z - r.cz) * r.uz;
export const toV = (r: Rect, x: number, z: number) => -(x - r.cx) * r.uz + (z - r.cz) * r.ux;
export const fromUV = (r: Rect, u: number, v: number): [number, number] => [r.cx + u * r.ux - v * r.uz, r.cz + u * r.uz + v * r.ux];

/** Which side (+1 or -1 along v) the door is on. */
export const doorSide = (r: Rect): number => Math.sign(toV(r, r.door[0], r.door[1])) || 1;

/** Houses can be entered; everything else stays closed. */
export const enterable = (r: Rect): boolean => r.kind === "house" && r.hw > 1.8 && r.hd > 1.8;

/** The enterable house whose front door you are standing at, if any. */
export function houseAtDoor(rects: readonly Rect[], x: number, z: number, reach = DOOR_REACH): Rect | null {
    let best: Rect | null = null, bestD = reach * reach;
    for (const r of rects) {
        if (!enterable(r)) continue;
        const d = (r.door[0] - x) ** 2 + (r.door[1] - z) ** 2;
        if (d < bestD) { bestD = d; best = r; }
    }
    return best;
}

/** Where you stand just inside the front door, facing in (x, z, yaw). */
export function entryPoint(r: Rect): { x: number; z: number; yaw: number } {
    const side = doorSide(r);
    const [x, z] = fromUV(r, 0, side * (r.hd - WALL - 0.9));
    const [ix, iz] = fromUV(r, 0, 0);
    return { x, z, yaw: Math.atan2(ix - x, iz - z) };
}

/** Where you stand outside after leaving (the door spot), facing the street. */
export function exitPoint(r: Rect): { x: number; z: number; yaw: number } {
    const side = doorSide(r);
    const [ox, oz] = fromUV(r, 0, side * (r.hd + 2.2));
    return { x: r.door[0], z: r.door[1], yaw: Math.atan2(ox - r.door[0], oz - r.door[1]) };
}

/** Keeps a body of `radius` inside the house's outer walls. */
export function clampInside(r: Rect, x: number, z: number, radius: number): [number, number] {
    const mu = Math.max(0.1, r.hw - WALL - radius), mv = Math.max(0.1, r.hd - WALL - radius);
    const u = Math.max(-mu, Math.min(mu, toU(r, x, z)));
    const v = Math.max(-mv, Math.min(mv, toV(r, x, z)));
    return fromUV(r, u, v);
}

/** Standing in the doorway, inside, close enough to leave. */
export function atDoorInside(r: Rect, x: number, z: number): boolean {
    const side = doorSide(r);
    return Math.abs(toU(r, x, z)) < 1.6 && toV(r, x, z) * side > r.hd - WALL - 1.8;
}

/** A point given as shares of the half-extents (al_items LootCache u/v), inside the walls. */
export function spotInside(r: Rect, su: number, sv: number): [number, number] {
    return fromUV(r, su * Math.max(0, r.hw - WALL - 0.8), sv * Math.max(0, r.hd - WALL - 0.8));
}
