/** Player movement for Play mode: flat XZ walking with sliding collision against solid rectangles.
 * Pure functions only, so the same code drives the keyboard, the headless playtest and the tests. */
export type XZ = [number, number];
export interface Rect { minX: number; maxX: number; minZ: number; maxZ: number; }
export const PLAYER_RADIUS = 0.35;
export const PLAYER_SPEED = 4.2; // world units per second

export const distanceToRect = (x: number, z: number, r: Rect): number =>
    Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));

export const unionRect = (rects: Rect[]): Rect | null => rects.length ? {
    minX: Math.min(...rects.map(r => r.minX)), maxX: Math.max(...rects.map(r => r.maxX)),
    minZ: Math.min(...rects.map(r => r.minZ)), maxZ: Math.max(...rects.map(r => r.maxZ)),
} : null;

export const hitsAny = (x: number, z: number, radius: number, blockers: Rect[]): boolean =>
    blockers.some(r => distanceToRect(x, z, r) < radius);

/** Longest distance covered between two collision checks. A fence is about 0.12 thick and the player
 * 0.35 wide, so a step under 0.25 cannot jump over one even on a slow frame. */
const MAX_SUBSTEP = 0.2;

/** Move `dir` (any length; normalised here) for `dt` seconds. Each axis is tried on its own, so walking
 * diagonally into a wall slides along it instead of stopping. The result never leaves +-`bounds`. */
export function stepPlayer(pos: XZ, dir: XZ, dt: number, blockers: Rect[], bounds: number, radius = PLAYER_RADIUS, speed = PLAYER_SPEED): { pos: XZ; moved: boolean } {
    const length = Math.hypot(dir[0], dir[1]);
    if (length < 1e-6 || !(dt > 0)) return { pos, moved: false };
    const clamp = (v: number) => Math.max(-bounds, Math.min(bounds, v));
    // A player who starts inside a solid (a rock dropped on them) may walk out of it instead of being stuck for good.
    blockers = blockers.filter(r => distanceToRect(pos[0], pos[1], r) >= radius);
    const pieces = Math.max(1, Math.ceil(speed * dt / MAX_SUBSTEP));
    const step = speed * dt / pieces / length;
    let [x, z] = pos;
    for (let i = 0; i < pieces; i++) {
        const nx = clamp(x + dir[0] * step);
        if (!hitsAny(nx, z, radius, blockers)) x = nx;
        const nz = clamp(z + dir[1] * step);
        if (!hitsAny(x, nz, radius, blockers)) z = nz;
    }
    return { pos: [x, z], moved: x !== pos[0] || z !== pos[1] };
}

/** Input is [right, forward] in -1..1; the camera sits behind the player at `yaw` (0 = looking down -Z). */
export function cameraRelative(input: XZ, yaw: number): XZ {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    return [fx * input[1] + -fz * input[0], fz * input[1] + fx * input[0]];
}

export function followCamera(target: [number, number, number], yaw: number, pitch: number, distance: number): { position: [number, number, number]; target: [number, number, number] } {
    const flat = Math.cos(pitch) * distance;
    return { position: [target[0] + Math.sin(yaw) * flat, target[1] + Math.sin(pitch) * distance, target[2] + Math.cos(yaw) * flat], target };
}
