// The Detailer's editing camera, decided without the engine (so it is tested). It replaces the
// engine's generic orbit control, whose fixed pan and zoom speeds made a world awkward to cross:
// panning crawled from 500 m up and leapt from 5 m, the wheel moved a fixed number of meters
// whatever the distance, and WASD dragged the view in jumps.
//
// It is the camera of a map-first level editor (an RTS or city builder's, with an orbit):
// - a pivot on the ground the camera looks at, from a distance, a heading and a pitch;
// - the wheel zooms by a share of the distance (exponential), toward the point under the cursor;
// - middle-drag (or Shift + right-drag) grabs the ground and drags it, at a speed that keeps the
//   grabbed point under the cursor wherever the camera is;
// - right-drag orbits around the pivot;
// - WASD / arrows glide the pivot over the ground at a speed that scales with the distance, Q/E
//   turn, Z/X (or R/F... F frames) zoom; a gamepad's sticks and triggers do the same;
// - everything eases toward where it was asked to go (critically damped), so moves never jump;
// - the camera never goes under the ground.
//
// Coordinates are render space (meters, +Y up); yaw 0 puts the camera south (+Z) of the pivot.

export type V3 = [number, number, number];

export interface CameraPose {
    pos: V3;
    target: V3;
}

export interface EditorCameraState {
    pivot: V3;
    yaw: number;
    pitch: number;
    distance: number;
}

export const MIN_DISTANCE = 1.5;
export const MAX_DISTANCE = 3200;
export const MIN_PITCH = (4 * Math.PI) / 180;
export const MAX_PITCH = (88 * Math.PI) / 180;
/** Vertical field of view (the engine's default, 45 degrees). */
export const FOV_Y = Math.PI / 4;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Position of a camera at `distance` from `pivot` along a heading and pitch. */
export function orbitPosition(pivot: V3, yaw: number, pitch: number, distance: number): V3 {
    return [
        pivot[0] + Math.sin(yaw) * Math.cos(pitch) * distance,
        pivot[1] + Math.sin(pitch) * distance,
        pivot[2] + Math.cos(yaw) * Math.cos(pitch) * distance,
    ];
}

/** Shortest signed angle from a to b. */
export function angleDelta(a: number, b: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

export class EditorCamera {
    /** Where the camera is going (what input changes). */
    goal: EditorCameraState;
    /** Where it is (eases toward the goal). */
    now: EditorCameraState;
    /** Pixels of the viewport's height, for drag speeds (set from the window). */
    viewportHeight = 900;
    /** Pivot glide velocity (m/s), for smooth starts and stops of keyboard / stick moves. */
    private velocity: [number, number] = [0, 0];

    constructor(start: EditorCameraState = { pivot: [0, 0, 0], yaw: 0.6, pitch: 0.6, distance: 160 }) {
        this.goal = { ...start, pivot: [...start.pivot] };
        this.now = { ...start, pivot: [...start.pivot] };
    }

    /** Jumps there (opening a world, going to a site). */
    set(state: EditorCameraState): void {
        const s = { ...state, pivot: [...state.pivot] as V3, pitch: clamp(state.pitch, MIN_PITCH, MAX_PITCH), distance: clamp(state.distance, MIN_DISTANCE, MAX_DISTANCE) };
        this.goal = s;
        this.now = { ...s, pivot: [...s.pivot] };
        this.velocity = [0, 0];
    }

    /** Glides there (framing a thing, double-clicking a place). */
    glideTo(pivot: V3, distance?: number, yaw?: number, pitch?: number): void {
        this.goal.pivot = [...pivot];
        if (distance !== undefined) this.goal.distance = clamp(distance, MIN_DISTANCE, MAX_DISTANCE);
        if (yaw !== undefined) this.goal.yaw = this.now.yaw + angleDelta(this.now.yaw, yaw);
        if (pitch !== undefined) this.goal.pitch = clamp(pitch, MIN_PITCH, MAX_PITCH);
    }

    /** Right-drag: turn around the pivot (pixels). */
    orbit(dxPx: number, dyPx: number): void {
        const k = 3.2 / Math.max(300, this.viewportHeight);
        this.goal.yaw -= dxPx * k;
        this.goal.pitch = clamp(this.goal.pitch + dyPx * k, MIN_PITCH, MAX_PITCH);
    }

    /** Ground meters per screen pixel at the pivot. */
    metersPerPixel(): number {
        return (2 * this.now.distance * Math.tan(FOV_Y / 2)) / Math.max(300, this.viewportHeight);
    }

    /** Middle-drag: drag the ground (pixels); the grabbed point stays under the cursor. */
    pan(dxPx: number, dyPx: number): void {
        const m = this.metersPerPixel();
        const yaw = this.now.yaw;
        // Screen right on the ground, and screen up (away from the camera) on the ground.
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        // Looking down steeply, screen up is ground forward 1:1; at a grazing angle a pixel covers more ground.
        const stretch = 1 / Math.max(0.35, Math.sin(this.now.pitch));
        const dx = -dxPx * m * rx + dyPx * m * stretch * fx;
        const dz = -dxPx * m * rz + dyPx * m * stretch * fz;
        this.goal.pivot[0] += dx; this.goal.pivot[2] += dz;
        this.now.pivot[0] += dx; this.now.pivot[2] += dz;
    }

    /**
     * Wheel: `steps` > 0 zooms in by a share of the distance, toward `toward` (the ground under the
     * cursor) so what is under the cursor stays there.
     */
    zoom(steps: number, toward?: V3 | null): void {
        const before = this.goal.distance;
        const after = clamp(before * Math.pow(0.84, steps), MIN_DISTANCE, MAX_DISTANCE);
        this.goal.distance = after;
        if (toward && steps > 0) {
            const share = 1 - after / before;
            this.goal.pivot = [
                this.goal.pivot[0] + (toward[0] - this.goal.pivot[0]) * share,
                this.goal.pivot[1] + (toward[1] - this.goal.pivot[1]) * share,
                this.goal.pivot[2] + (toward[2] - this.goal.pivot[2]) * share,
            ];
        }
    }

    /**
     * Keyboard / stick: glide the pivot (forward and right in -1..1, relative to the view's heading),
     * turn (rad/s), zoom (+1 in per second). Speed scales with the distance; `fast` triples it.
     */
    drive(dt: number, forward: number, right: number, turn = 0, zoomRate = 0, fast = false): void {
        const speed = Math.max(12, this.now.distance * 1.1) * (fast ? 3 : 1);
        const yaw = this.now.yaw;
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
        const rx = Math.cos(yaw), rz = -Math.sin(yaw);
        const want: [number, number] = [(fx * forward + rx * right) * speed, (fz * forward + rz * right) * speed];
        // Ease into and out of moving (about a sixth of a second).
        const a = 1 - Math.exp(-dt * 9);
        this.velocity[0] += (want[0] - this.velocity[0]) * a;
        this.velocity[1] += (want[1] - this.velocity[1]) * a;
        if (Math.abs(this.velocity[0]) < 1e-3 && Math.abs(this.velocity[1]) < 1e-3 && !forward && !right) this.velocity = [0, 0];
        const dx = this.velocity[0] * dt, dz = this.velocity[1] * dt;
        this.goal.pivot[0] += dx; this.goal.pivot[2] += dz;
        this.now.pivot[0] += dx; this.now.pivot[2] += dz;
        if (turn) { this.goal.yaw += turn * dt; }
        if (zoomRate) this.goal.distance = clamp(this.goal.distance * Math.pow(0.3, zoomRate * dt), MIN_DISTANCE, MAX_DISTANCE);
    }

    /** Moving (gliding or easing): the caller keeps rendering. */
    get moving(): boolean {
        const g = this.goal, n = this.now;
        return Math.abs(this.velocity[0]) + Math.abs(this.velocity[1]) > 1e-3
            || Math.hypot(g.pivot[0] - n.pivot[0], g.pivot[1] - n.pivot[1], g.pivot[2] - n.pivot[2]) > 0.01
            || Math.abs(g.yaw - n.yaw) > 1e-4 || Math.abs(g.pitch - n.pitch) > 1e-4 || Math.abs(g.distance - n.distance) / n.distance > 1e-4;
    }

    /**
     * Eases toward the goal and returns the camera. `groundAt(x, z)` is the ground's height: the
     * pivot rides on it and the camera stays above it.
     */
    update(dt: number, groundAt: (x: number, z: number) => number): CameraPose {
        const g = this.goal, n = this.now;
        // The pivot sits on the ground where it is.
        g.pivot[1] = groundAt(g.pivot[0], g.pivot[2]);
        const k = 1 - Math.exp(-Math.min(0.1, dt) * 14);
        for (let i = 0; i < 3; i++) n.pivot[i] += (g.pivot[i] - n.pivot[i]) * k;
        n.yaw += (g.yaw - n.yaw) * k;
        n.pitch += (g.pitch - n.pitch) * k;
        // Distance eases in log space, so a big zoom feels even all the way.
        n.distance = Math.exp(Math.log(n.distance) + (Math.log(g.distance) - Math.log(n.distance)) * k);
        const target: V3 = [n.pivot[0], n.pivot[1] + Math.min(2, n.distance * 0.02), n.pivot[2]];
        const pos = orbitPosition(target, n.yaw, n.pitch, n.distance);
        // Never under the ground: lift the camera (it keeps looking at the pivot).
        const floor = groundAt(pos[0], pos[2]) + Math.max(1.2, n.distance * 0.02);
        if (pos[1] < floor) pos[1] = floor;
        return { pos, target };
    }

    /** Shifts everything by (dx, dz): the render origin moved. */
    shift(dx: number, dz: number): void {
        for (const s of [this.goal, this.now]) { s.pivot[0] += dx; s.pivot[2] += dz; }
    }
}
