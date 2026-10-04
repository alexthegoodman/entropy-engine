// You, on foot: movement in the street layer's local frame (x east, z north, y up), relative to
// where the camera looks; sprinting on stamina, jumping, walls and water that stop you, and the
// over-the-shoulder (or first-person) camera.

import { type NavGrid } from "./al_nav";

export interface PlayerInput {
    moveX?: number; moveY?: number; lookX?: number; lookY?: number;
    forward: boolean; back: boolean; left: boolean; right: boolean;
    jump: boolean; sprint: boolean;
    turnLeft: boolean; turnRight: boolean; lookUp: boolean; lookDown: boolean;
}

export const NO_PLAYER_INPUT: PlayerInput = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, turnLeft: false, turnRight: false, lookUp: false, lookDown: false };

export interface PlayerBody {
    x: number; z: number; y: number;
    vy: number;
    grounded: boolean;
    /** Facing and camera yaw (same thing: you face where you look). Direction (sin, cos). */
    yaw: number;
    pitch: number;
    stamina: number;
    speed: number;
    stride: number;
    firstPerson: boolean;
    camDistance: number;
}

export const WALK_SPEED = 4.2;
export const SPRINT_SPEED = 7.8;
export const JUMP = 5.2;
export const GRAVITY = 9.81;
export const EYE = 1.62;
export const RADIUS = 0.38;

export function newBody(x = 0, z = 0, y = 0): PlayerBody {
    return { x, z, y, vy: 0, grounded: true, yaw: 0, pitch: -0.12, stamina: 1, speed: 0, stride: 0, firstPerson: false, camDistance: 4.2 };
}

export function stepBody(b: PlayerBody, input: PlayerInput, dt: number, nav: NavGrid | null, heightAt: (x: number, z: number) => number, slow = 1): void {
    const turn = (input.lookX ?? 0) + (input.turnRight ? 1 : 0) - (input.turnLeft ? 1 : 0);
    b.yaw += turn * 2.0 * dt;
    const look = (input.lookY ?? 0) + (input.lookUp ? 1 : 0) - (input.lookDown ? 1 : 0);
    b.pitch = Math.max(-1.2, Math.min(1.0, b.pitch + look * 1.4 * dt));
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const rx = Math.cos(b.yaw), rz = -Math.sin(b.yaw);
    let mx = 0, mz = 0;
    if (input.forward) { mx += fx; mz += fz; }
    if (input.back) { mx -= fx; mz -= fz; }
    if (input.right) { mx += rx; mz += rz; }
    if (input.left) { mx -= rx; mz -= rz; }
    mx += rx * (input.moveX ?? 0) + fx * (input.moveY ?? 0);
    mz += rz * (input.moveX ?? 0) + fz * (input.moveY ?? 0);
    const len = Math.hypot(mx, mz);
    const moving = len > 0;
    const sprinting = moving && input.sprint && b.stamina > 0.05 && (input.forward || (input.moveY ?? 0) > 0.1);
    b.stamina = Math.max(0, Math.min(1, b.stamina + (sprinting ? -0.18 : 0.12) * dt));
    const speed = (sprinting ? SPRINT_SPEED : WALK_SPEED) * slow * (input.back && !input.forward ? 0.7 : 1);
    let nx = b.x, nz = b.z;
    if (moving) {
        nx += mx / Math.max(1, len) * speed * dt;
        nz += mz / Math.max(1, len) * speed * dt;
    }
    if (nav) {
        // Walls push you out; open water (and the grid's edge) stops you.
        [nx, nz] = nav.collide(nx, nz, RADIUS);
        const [i, j] = nav.cellOf(nx, nz);
        const water = nav.inBounds(i, j) && nav.blocked[j * nav.size + i] === 2;
        if (water || !nav.inBounds(i, j)) { nx = b.x; nz = b.z; }
    }
    b.speed = Math.hypot(nx - b.x, nz - b.z) / Math.max(dt, 1e-6);
    b.stride += b.speed * dt * 2.2;
    b.x = nx; b.z = nz;
    if (input.jump && b.grounded) { b.vy = JUMP; b.grounded = false; }
    b.vy -= GRAVITY * dt;
    b.y += b.vy * dt;
    const ground = heightAt(b.x, b.z);
    if (b.y <= ground) { b.y = ground; b.vy = 0; b.grounded = true; }
    else b.grounded = b.y - ground < 0.05;
}

export interface CameraLocal { eye: [number, number, number]; target: [number, number, number]; forward: [number, number, number] }

/** Where the camera is (local): over the right shoulder, or at the eyes. */
export function bodyCamera(b: PlayerBody, groundAt: (x: number, z: number) => number, yawOffset = 0): CameraLocal {
    const cp = Math.cos(b.pitch), sp = Math.sin(b.pitch);
    const yaw = b.yaw + yawOffset;
    const f: [number, number, number] = [Math.sin(yaw) * cp, sp, Math.cos(yaw) * cp];
    if (b.firstPerson) {
        const eye: [number, number, number] = [b.x + Math.sin(b.yaw) * 0.12, b.y + EYE, b.z + Math.cos(b.yaw) * 0.12];
        return { eye, target: [eye[0] + f[0] * 10, eye[1] + f[1] * 10, eye[2] + f[2] * 10], forward: f };
    }
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const shoulder = yawOffset ? 0 : 0.55;
    const pivot: [number, number, number] = [b.x + rx * shoulder, b.y + 1.65, b.z + rz * shoulder];
    let eye: [number, number, number] = [pivot[0] - f[0] * b.camDistance, pivot[1] - f[1] * b.camDistance + 0.25, pivot[2] - f[2] * b.camDistance];
    const g = groundAt(eye[0], eye[2]) + 0.4;
    if (eye[1] < g) eye = [eye[0], g, eye[2]];
    return { eye, target: [pivot[0] + f[0] * 20, pivot[1] + f[1] * 20, pivot[2] + f[2] * 20], forward: f };
}
