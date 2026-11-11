// Preview World: walk the level as a player would, in third or first person, decided without the
// engine (so it is tested). The Detailer feeds it the frame's input (keyboard, mouse drags, a
// gamepad's sticks and buttons), the ground's height and the things in the way; it moves the
// walker and says where the camera is.
//
// - Movement is relative to where the camera looks; the body turns toward where it walks (third
//   person) or with the view (first person). Walk, sprint, jump, gravity; swimming where the ground
//   is deep under the sea.
// - Buildings, walls and big props are solid (their footprints as turned boxes, things without one
//   as circles). Low things (a dock, a well's rim) can be stepped onto. Interiors are not part of
//   the level here: going inside will be a level of its own, behind a loading screen.
// - The third-person camera sits behind the shoulder at an adjustable distance, eases after the
//   walker and never goes under the ground; first person is at eye height with a slight step bob.
// - Gamepad (gilrs' semantic names, positive Y up): left stick moves, right stick looks, South
//   jumps, left stick click (or a trigger) sprints, North or right stick click switches the view,
//   East or Start leaves.
//
// Coordinates are render space (meters, +Y up).

import { orbitPosition, type CameraPose, type V3 } from "./detail_camera";

export type PreviewView = "third" | "first";

/** Something in the walker's way: a turned box (hw, hd: half sizes, m) or a circle (r). */
export interface Blocker {
    x: number;
    z: number;
    yaw: number;
    hw: number;
    hd: number;
    /** A circle instead of a box. */
    r?: number;
    /** Height of its top (m, absolute). */
    top: number;
    /** Name, for the HUD ("By the inn"). */
    name?: string;
}

export interface PreviewInput {
    /** Stick or keys: x right, y forward, -1..1. */
    move: [number, number];
    /** Look change this frame (radians): mouse drags and stick rates already scaled by dt. */
    lookYaw: number;
    lookPitch: number;
    sprint: boolean;
    /** Pressed this frame. */
    jump: boolean;
}

export const STICK_DEADZONE = 0.18;

/** A stick with a radial dead zone, rescaled so movement starts smoothly at its edge. */
export function deadzone(v: readonly [number, number]): [number, number] {
    const l = Math.hypot(v[0], v[1]);
    if (!Number.isFinite(l) || l <= STICK_DEADZONE) return [0, 0];
    const s = Math.min(1, (l - STICK_DEADZONE) / (1 - STICK_DEADZONE)) / l;
    return [v[0] * s, v[1] * s];
}

export const WALK_SPEED = 4.2;
export const SPRINT_SPEED = 8.5;
export const SWIM_SPEED = 2.2;
export const JUMP_SPEED = 5.6;
export const GRAVITY = 18;
export const BODY_RADIUS = 0.35;
export const EYE_HEIGHT = 1.62;
/** Highest step (m) the walker climbs without jumping. */
export const STEP_HEIGHT = 0.55;
/** Water deeper than this (m) is swum. */
export const SWIM_DEPTH = 1.3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class Walker {
    x: number;
    z: number;
    /** Feet height. */
    y: number;
    vy = 0;
    /** Body heading (radians, 0 faces +Z as models do). */
    bodyYaw: number;
    /** View heading and pitch (the camera looks along -[sin(yaw), cos(yaw)] at yaw, like the editor camera). */
    lookYaw: number;
    lookPitch = -0.12;
    view: PreviewView = "third";
    /** Third-person camera distance (m). */
    camDistance = 4.6;
    onGround = true;
    swimming = false;
    /** Horizontal speed now (m/s). */
    speed = 0;
    /** Walking phase, for the step bob. */
    stride = 0;
    /** The blocker the walker last bumped into. */
    touching: Blocker | null = null;
    private vel: [number, number] = [0, 0];
    private cam: V3 | null = null;

    constructor(x: number, z: number, groundY: number, lookYaw = 0) {
        this.x = x; this.z = z; this.y = groundY;
        this.lookYaw = lookYaw;
        this.bodyYaw = lookYaw + Math.PI; // facing away from the camera
    }

    toggleView(): PreviewView {
        this.view = this.view === "third" ? "first" : "third";
        this.cam = null;
        return this.view;
    }

    zoom(steps: number): void {
        this.camDistance = clamp(this.camDistance * Math.pow(0.88, steps), 1.8, 14);
    }

    /**
     * One frame. `groundAt(x, z)`: the ground's height; `seaLevel`: the water's; `blockers`: what
     * is near (the caller gathers it around the walker).
     */
    step(dt: number, input: PreviewInput, groundAt: (x: number, z: number) => number, seaLevel: number, blockers: readonly Blocker[]): void {
        dt = Math.min(0.05, Math.max(0, dt));
        this.lookYaw += input.lookYaw;
        this.lookPitch = clamp(this.lookPitch + input.lookPitch, -1.35, 1.25);
        // Wanted horizontal velocity, relative to the view's heading.
        const fx = -Math.sin(this.lookYaw), fz = -Math.cos(this.lookYaw);
        const rx = Math.cos(this.lookYaw), rz = -Math.sin(this.lookYaw);
        let [mx, my] = input.move;
        const ml = Math.hypot(mx, my);
        if (ml > 1) { mx /= ml; my /= ml; }
        const top = this.swimming ? SWIM_SPEED : input.sprint ? SPRINT_SPEED : WALK_SPEED;
        const want: [number, number] = [(fx * my + rx * mx) * top, (fz * my + rz * mx) * top];
        // Quick to start and stop on the ground, sluggish in the air.
        const grip = 1 - Math.exp(-dt * (this.onGround || this.swimming ? 12 : 2));
        this.vel[0] += (want[0] - this.vel[0]) * grip;
        this.vel[1] += (want[1] - this.vel[1]) * grip;
        let nx = this.x + this.vel[0] * dt, nz = this.z + this.vel[1] * dt;
        // Solid things: push out of each one the body overlaps (twice, for corners).
        this.touching = null;
        for (let pass = 0; pass < 2; pass++) {
            for (const b of blockers) {
                if (b.top - this.y <= STEP_HEIGHT) continue; // low enough to step onto
                const p = pushOut(nx, nz, BODY_RADIUS, b);
                if (p) { nx = p[0]; nz = p[1]; this.touching = b; }
            }
        }
        // Too steep to walk up (a cliff): the move is refused, sliding along is fine.
        const gHere = groundAt(this.x, this.z), gThere = groundAt(nx, nz);
        const run = Math.hypot(nx - this.x, nz - this.z);
        if (this.onGround && run > 1e-4 && (gThere - gHere) / run > 1.6 && gThere - this.y > STEP_HEIGHT) { nx = this.x; nz = this.z; }
        const moved = Math.hypot(nx - this.x, nz - this.z);
        this.speed = dt > 0 ? moved / dt : 0;
        this.x = nx; this.z = nz;
        // Standing height: the ground, or the top of a low thing underfoot.
        let floor = groundAt(this.x, this.z);
        for (const b of blockers) {
            if (b.top - this.y > STEP_HEIGHT || b.top <= floor) continue;
            if (inside(this.x, this.z, 0, b)) floor = b.top;
        }
        const swimLevel = seaLevel - SWIM_DEPTH;
        this.swimming = floor < swimLevel && this.y <= swimLevel + 0.05;
        if (this.swimming) {
            this.y = swimLevel; this.vy = 0; this.onGround = false;
        } else {
            if (input.jump && this.onGround) { this.vy = JUMP_SPEED; this.onGround = false; }
            this.vy -= GRAVITY * dt;
            this.y += this.vy * dt;
            // Down a step or a slope while walking: stay on the ground rather than hop.
            if (this.y <= floor || (this.onGround && this.vy <= 0 && this.y - floor < STEP_HEIGHT)) {
                this.y = floor; this.vy = 0; this.onGround = true;
            } else this.onGround = false;
            if (floor < swimLevel && this.y < swimLevel) { this.y = swimLevel; this.vy = 0; this.swimming = true; }
        }
        // The body turns toward where it walks (third person) or with the view (first).
        if (this.view === "first") this.bodyYaw = this.lookYaw + Math.PI;
        else if (moved > 1e-3) {
            const heading = Math.atan2(this.vel[0], this.vel[1]);
            let d = heading - this.bodyYaw;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            this.bodyYaw += d * (1 - Math.exp(-dt * 12));
        }
        this.stride += moved * 1.9;
    }

    /** Where the camera is this frame (eased in third person). */
    camera(dt: number, groundAt: (x: number, z: number) => number): CameraPose {
        const cp = Math.cos(this.lookPitch), sp = Math.sin(this.lookPitch);
        const look: V3 = [-Math.sin(this.lookYaw) * cp, sp, -Math.cos(this.lookYaw) * cp];
        if (this.view === "first") {
            const bob = this.onGround ? Math.sin(this.stride) * Math.min(1, this.speed / WALK_SPEED) * 0.035 : 0;
            const eye: V3 = [this.x, this.y + EYE_HEIGHT + bob, this.z];
            this.cam = eye;
            return { pos: eye, target: [eye[0] + look[0] * 10, eye[1] + look[1] * 10, eye[2] + look[2] * 10] };
        }
        // Behind and a little right of the head, looking past the shoulder.
        const head: V3 = [this.x, this.y + 1.55, this.z];
        const right: V3 = [Math.cos(this.lookYaw), 0, -Math.sin(this.lookYaw)];
        const pivot: V3 = [head[0] + right[0] * 0.45, head[1], head[2] + right[2] * 0.45];
        const want = orbitPosition(pivot, this.lookYaw, -this.lookPitch + 0.18, this.camDistance);
        const floor = groundAt(want[0], want[2]) + 0.4;
        if (want[1] < floor) want[1] = floor;
        if (!this.cam) this.cam = want;
        else {
            const k = 1 - Math.exp(-Math.min(0.1, dt) * 18);
            for (let i = 0; i < 3; i++) this.cam[i] += (want[i] - this.cam[i]) * k;
        }
        const pos: V3 = [...this.cam];
        return { pos, target: [pivot[0] + look[0] * 6, pivot[1] + look[1] * 6, pivot[2] + look[2] * 6] };
    }

    /** Moves everything by (dx, dz): the render origin moved. */
    shift(dx: number, dz: number): void {
        this.x += dx; this.z += dz;
        if (this.cam) { this.cam[0] += dx; this.cam[2] += dz; }
    }
}

/** Whether (x, z) widened by `r` is inside the blocker. */
export function inside(x: number, z: number, r: number, b: Blocker): boolean {
    if (b.r !== undefined) return Math.hypot(x - b.x, z - b.z) < b.r + r;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const dx = x - b.x, dz = z - b.z;
    // Into the box's frame (local +x along its width, +z along its depth).
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    return Math.abs(lx) < b.hw + r && Math.abs(lz) < b.hd + r;
}

/** A circle at (x, z) of radius r pushed out of the blocker, or null when they don't overlap. */
export function pushOut(x: number, z: number, r: number, b: Blocker): [number, number] | null {
    if (b.r !== undefined) {
        const dx = x - b.x, dz = z - b.z;
        const d = Math.hypot(dx, dz);
        const min = b.r + r;
        if (d >= min) return null;
        if (d < 1e-6) return [b.x + min, b.z];
        return [b.x + (dx / d) * min, b.z + (dz / d) * min];
    }
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const dx = x - b.x, dz = z - b.z;
    let lx = dx * c - dz * s, lz = dx * s + dz * c;
    // Nearest point of the box to the circle's center.
    const qx = Math.max(-b.hw, Math.min(b.hw, lx)), qz = Math.max(-b.hd, Math.min(b.hd, lz));
    const ox = lx - qx, oz = lz - qz;
    const d = Math.hypot(ox, oz);
    if (d >= r) return null;
    if (d > 1e-6) {
        lx = qx + (ox / d) * r; lz = qz + (oz / d) * r;
    } else {
        // The center is inside the box: out through the nearest side.
        const px = b.hw - Math.abs(lx), pz = b.hd - Math.abs(lz);
        if (px < pz) lx = Math.sign(lx || 1) * (b.hw + r);
        else lz = Math.sign(lz || 1) * (b.hd + r);
    }
    // Back to the world frame (the inverse rotation).
    return [b.x + lx * c + lz * s, b.z - lx * s + lz * c];
}
