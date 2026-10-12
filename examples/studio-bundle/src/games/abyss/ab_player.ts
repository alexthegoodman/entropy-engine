// Alex: a body on the terrain (walking, sprinting on the augment's stamina, jumping, sliding off
// what is too steep to stand on, hurt by long falls), what he carries (weapons, armor, medgel,
// artifacts of the kingdoms below to sell, and - at the end - a vial of the river's water), and
// the weapons themselves. Pure functions over plain data.

import type { V3 } from "./ab_world";

export interface Body {
    x: number; y: number; z: number;
    vy: number;
    grounded: boolean;
    yaw: number;
    pitch: number;
    stamina: number;
    speed: number;
    stride: number;
    /** Fall speed at the last landing (for damage and the camera's dip). */
    landed: number;
    /** 0 standing .. 1 crouched (eased, so the eye sinks smoothly). */
    crouch: number;
}

export interface MoveInput {
    moveX: number;  // strafe right +
    moveY: number;  // forward +
    sprint: boolean;
    jump: boolean;
    /** Crouched: lower, slower, quieter - and hidden behind waist-high cover. */
    crouch?: boolean;
}

export const WALK = 4.4, SPRINT = 7.6, JUMP = 5.0, GRAVITY = 9.81, EYE = 1.66, RADIUS = 0.4;
/** Crouched: walking pace, and how far the eye sinks (to 1.0 m: below a barricade's top). */
export const CROUCH_WALK = 2.3, CROUCH_DROP = 0.66;
/** Slopes steeper than this (rise over run) cannot be climbed; on steeper ground you slide. */
export const MAX_CLIMB = 1.15, SLIDE = 1.6;

export function newBody(x: number, z: number, y: number, yaw = 0): Body {
    return { x, y, z, vy: 0, grounded: true, yaw, pitch: -0.05, stamina: 1, speed: 0, stride: 0, landed: 0, crouch: 0 };
}

export interface BodyWorld {
    ground(x: number, z: number): number;
    collide(x: number, z: number, r: number): [number, number];
    /** Map bounds (half size). */
    half: number;
}

/** One step. Returns the fall damage taken on landing (0 most steps). */
export function stepBody(b: Body, input: MoveInput, dt: number, w: BodyWorld, slow = 1, jump = 1, drain = 1): number {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    // Strafe right is the body's right: facing +Z, right is -X.
    const rx = -Math.cos(b.yaw), rz = Math.sin(b.yaw);
    let mx = fx * input.moveY + rx * input.moveX, mz = fz * input.moveY + rz * input.moveX;
    const len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; }
    const moving = len > 0.05;
    const sprinting = moving && input.sprint && input.moveY > 0.3 && b.stamina > 0.05;
    b.stamina = Math.max(0, Math.min(1, b.stamina + (sprinting ? -0.16 * drain : 0.12) * dt));
    // Sprinting or jumping stands Alex up; otherwise he sinks to a crouch or rises over a third of a second.
    const wantCrouch = !!input.crouch && !sprinting && !input.jump && b.grounded ? 1 : 0;
    b.crouch += (wantCrouch - b.crouch) * Math.min(1, dt * 9);
    if (Math.abs(wantCrouch - b.crouch) < 0.01) b.crouch = wantCrouch;
    const pace = sprinting ? SPRINT : WALK + (CROUCH_WALK - WALK) * b.crouch;
    const speed = pace * slow * (input.moveY < -0.2 ? 0.75 : 1);
    let nx = b.x + mx * speed * dt * (b.grounded ? 1 : 0.85), nz = b.z + mz * speed * dt * (b.grounded ? 1 : 0.85);
    [nx, nz] = w.collide(nx, nz, RADIUS);
    nx = Math.max(-w.half + 5, Math.min(w.half - 5, nx));
    nz = Math.max(-w.half + 5, Math.min(w.half - 5, nz));
    // Too steep to climb: stay put (on the ground; in the air the jump carries you).
    const here = w.ground(b.x, b.z), there = w.ground(nx, nz);
    const run = Math.hypot(nx - b.x, nz - b.z);
    if (b.grounded && run > 1e-4 && (there - here) / run > MAX_CLIMB) { nx = b.x; nz = b.z; }
    b.speed = Math.hypot(nx - b.x, nz - b.z) / Math.max(dt, 1e-6);
    b.stride += b.speed * dt;
    b.x = nx; b.z = nz;
    // Sliding off what is too steep to stand on.
    const e = 0.8, g0 = w.ground(b.x, b.z);
    const gx = (w.ground(b.x + e, b.z) - w.ground(b.x - e, b.z)) / (2 * e), gz = (w.ground(b.x, b.z + e) - w.ground(b.x, b.z - e)) / (2 * e);
    const steep = Math.hypot(gx, gz);
    if (b.grounded && steep > SLIDE) {
        const s = Math.min(8, (steep - SLIDE) * 6) * dt;
        [b.x, b.z] = w.collide(b.x - gx / steep * s, b.z - gz / steep * s, RADIUS);
    }
    if (input.jump && b.grounded) { b.vy = JUMP * jump; b.grounded = false; }
    b.vy -= GRAVITY * dt;
    b.y += b.vy * dt;
    const ground = w.ground(b.x, b.z);
    let hurt = 0;
    if (b.y <= ground) {
        if (!b.grounded) {
            b.landed = -b.vy;
            // Falls past ~6 m begin to hurt; past ~25 m they kill.
            if (b.landed > 11) hurt = Math.min(200, (b.landed - 11) ** 1.6 * 2.2);
        }
        b.y = ground; b.vy = 0; b.grounded = true;
    } else if (b.y - ground > 0.35 || b.vy > 0) b.grounded = false;
    else { b.y = ground; b.vy = 0; }
    void g0;
    return hurt;
}

/** The camera at the eyes: position and forward. */
export function eye(b: Body): { pos: V3; forward: V3 } {
    const cp = Math.cos(b.pitch);
    const bob = Math.sin(b.stride * 1.9) * 0.035 * Math.min(1, b.speed / 4) * (1 - b.crouch * 0.5);
    return {
        pos: [b.x, b.y + EYE - CROUCH_DROP * (b.crouch ?? 0) + bob, b.z],
        forward: [Math.sin(b.yaw) * cp, Math.sin(b.pitch), Math.cos(b.yaw) * cp],
    };
}

// --- What Alex carries -------------------------------------------------------------------------

export type WeaponId = "coil-rifle" | "arc-pistol" | "monoblade" | "warden-glaive" | "okafor-carbine";

export interface WeaponSpec {
    id: WeaponId;
    name: string;
    kind: "gun" | "melee";
    /** Guns: rounds a magazine, seconds between shots, automatic, damage, spread (rad), reload (s), range. */
    mag?: number; interval: number; auto?: boolean; damage: number; spread?: number; reload?: number; range: number;
    /** Melee: reach (m), arc (rad), windup before the hit lands (s). */
    reach?: number; arc?: number; windup?: number;
    /** The Mesha object drawn in the hand. */
    object: string;
    values: Record<string, string | number | boolean>;
    description: string;
    value: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
    "coil-rifle": { id: "coil-rifle", name: "VK-9 Coil Rifle", kind: "gun", mag: 32, interval: 0.095, auto: true, damage: 21, spread: 0.007, reload: 2.0, range: 400, object: "equipment.coil_rifle", values: {}, description: "Standard expedition rifle. Magnetic slugs through five accelerator coils.", value: 0 },
    "arc-pistol": { id: "arc-pistol", name: "Arc Sidearm", kind: "gun", mag: 14, interval: 0.22, damage: 32, spread: 0.01, reload: 1.3, range: 160, object: "equipment.coil_rifle", values: { kind: "pistol", coils: 3, sight: false }, description: "Officer's sidearm. Slow, heavy rounds.", value: 0 },
    "monoblade": { id: "monoblade", name: "Monoblade", kind: "melee", interval: 0.55, damage: 75, range: 2.4, reach: 2.4, arc: 0.9, windup: 0.14, object: "equipment.melee_weapon", values: { kind: "monoblade", shaftFinish: "polymer.black", trimFinish: "metal.gunmetal", glowFinish: "glow.cyan" }, description: "A molecular edge. Standard issue, rarely drawn.", value: 0 },
    "okafor-carbine": { id: "okafor-carbine", name: "Okafor's Carbine", kind: "gun", mag: 24, interval: 0.16, auto: true, damage: 34, spread: 0.005, reload: 1.7, range: 420, object: "equipment.coil_rifle", values: { kind: "carbine" }, description: "Sgt. Okafor's own. Shorter, heavier slugs; her name scratched into the stock.", value: 0 },
    "warden-glaive": { id: "warden-glaive", name: "Warden's Glaive", kind: "melee", interval: 0.8, damage: 120, range: 3.2, reach: 3.2, arc: 1.1, windup: 0.22, object: "equipment.melee_weapon", values: { kind: "glaive" }, description: "Taken from a fallen warden. The crystal at its socket is warm.", value: 900 },
};

export interface ArtifactSpec {
    id: string;
    name: string;
    value: number;
    /** SAGE's reading of it (the codex). */
    note: string;
    object: string;
    values: Record<string, string | number | boolean>;
}

export const ARTIFACTS: Record<string, ArtifactSpec> = {
    "lumen-shard": { id: "lumen-shard", name: "Lumen Shard", value: 140, object: "component.rockPiece", values: { size: 0.22, faceted: true, elongation: 2.2, flatness: 0.6 }, note: "A crystal fragment, faintly warm. Its glow pulses at 0.6 Hz - the same rhythm the Deep Bore's sensors recorded before the strike." },
    "river-idol": { id: "river-idol", name: "River Idol", value: 380, object: "household.bottle", values: { preset: "Apothecary" }, note: "A sealed vessel of carved glass. Inside, water that gives off its own light. Every house below seems to keep one." },
    "bronze-cup": { id: "bronze-cup", name: "Engraved Cup", value: 220, object: "household.mug", values: {}, note: "Bronze, worn smooth at the rim. The engraving shows a waterfall of light and figures kneeling beneath it." },
    "prayer-tablet": { id: "prayer-tablet", name: "Prayer Tablet", value: 310, object: "household.book", values: {}, note: "A stone leaf cut with script SAGE cannot read. One glyph repeats: a ring with a drop at its heart. It is on the wardens' tabards too." },
    "warden-mask": { id: "warden-mask", name: "Warden's Mask", value: 650, object: "household.dish", values: {}, note: "Bronze, the eye slits lined with crystal. Whoever made it expected to see by the river's light, not by ours." },
    // What the fallen carry.
    "lumen-bead": { id: "lumen-bead", name: "Lumen Beads", value: 45, object: "nature.crystal_cluster", values: { count: 4, height: 0.08, base: false, spread: 60 }, note: "A string of polished crystal beads. Every warden seems to carry one; they count them when they pray." },
    "warden-sigil": { id: "warden-sigil", name: "Warden's Sigil", value: 130, object: "household.dish", values: {}, note: "A bronze disc: the ring with a drop at its heart. Worn over the breastbone, warm to the touch." },
    "power-cell": { id: "power-cell", name: "Bore Power Cell", value: 90, object: "mechanical.gear", values: {}, note: "A Deep Bore security cell, still charged. Surface property, technically. The quartermaster won't ask." },
    "bore-core": { id: "bore-core", name: "Sentinel Logic Core", value: 520, object: "mechanical.gear", values: {}, note: "The mind of a Bore sentinel. SAGE wants to read it. The labs want it more." },
    "behemoth-tusk": { id: "behemoth-tusk", name: "Behemoth Tusk", value: 1200, object: "nature.rock", values: { size: 0.4 }, note: "Ivory as long as your arm, scorched at the root. The kingdoms raise these beasts for war, and for nothing else." },
};

export interface Inventory {
    weapons: WeaponId[];
    current: WeaponId;
    mags: Partial<Record<WeaponId, number>>;
    reserve: Partial<Record<WeaponId, number>>;
    armor: number;
    armorMax: number;
    armorName: string | null;
    medgel: number;
    /** River draughts: each fills half the Resonance that powers the river's gifts. */
    draughts: number;
    artifacts: string[];
    vial: boolean;
    credits: number;
}

export function newInventory(): Inventory {
    return {
        weapons: ["coil-rifle", "arc-pistol", "monoblade"], current: "coil-rifle",
        mags: { "coil-rifle": 32, "arc-pistol": 14 }, reserve: { "coil-rifle": 160, "arc-pistol": 42 },
        armor: 0, armorMax: 0, armorName: null, medgel: 1, draughts: 0, artifacts: [], vial: false, credits: 0,
    };
}

/** Damage after armor: plates take 70% of each hit until they are spent. Returns what reaches Alex. */
export function absorb(inv: Inventory, amount: number): number {
    if (inv.armor <= 0) return amount;
    const taken = Math.min(inv.armor, amount * 0.7);
    inv.armor -= taken;
    return amount - taken;
}

export const artifactValue = (inv: Inventory): number => inv.artifacts.reduce((s, id) => s + (ARTIFACTS[id]?.value ?? 0), 0);

export interface WeaponState {
    cooldown: number;
    reloading: number;
    /** Melee swing in progress (seconds since it began; -1 none) and whether it has landed. */
    swing: number;
    swingLanded: boolean;
    kick: number;
}

export const newWeaponState = (): WeaponState => ({ cooldown: 0, reloading: 0, swing: -1, swingLanded: false, kick: 0 });

/** Starts a reload if it is worth one. */
export function startReload(inv: Inventory, ws: WeaponState): boolean {
    const spec = WEAPONS[inv.current];
    if (spec.kind !== "gun" || ws.reloading > 0) return false;
    const mag = inv.mags[inv.current] ?? 0, reserve = inv.reserve[inv.current] ?? 0;
    if (mag >= (spec.mag ?? 0) || reserve <= 0) return false;
    ws.reloading = spec.reload ?? 1.5;
    return true;
}

export function stepWeapon(inv: Inventory, ws: WeaponState, dt: number): void {
    ws.cooldown = Math.max(0, ws.cooldown - dt);
    ws.kick = Math.max(0, ws.kick - dt * 6);
    if (ws.reloading > 0) {
        ws.reloading -= dt;
        if (ws.reloading <= 0) {
            ws.reloading = 0;
            const spec = WEAPONS[inv.current];
            const need = (spec.mag ?? 0) - (inv.mags[inv.current] ?? 0);
            const take = Math.min(need, inv.reserve[inv.current] ?? 0);
            inv.mags[inv.current] = (inv.mags[inv.current] ?? 0) + take;
            inv.reserve[inv.current] = (inv.reserve[inv.current] ?? 0) - take;
        }
    }
    if (ws.swing >= 0) {
        ws.swing += dt;
        if (ws.swing > WEAPONS[inv.current].interval) ws.swing = -1;
    }
}

/** Pulls the trigger: true if a round (or a swing) goes out this frame. */
export function trigger(inv: Inventory, ws: WeaponState): boolean {
    const spec = WEAPONS[inv.current];
    if (ws.cooldown > 0 || ws.reloading > 0) return false;
    if (spec.kind === "melee") {
        ws.swing = 0; ws.swingLanded = false;
        ws.cooldown = spec.interval;
        return true;
    }
    const mag = inv.mags[inv.current] ?? 0;
    if (mag <= 0) { startReload(inv, ws); return false; }
    inv.mags[inv.current] = mag - 1;
    ws.cooldown = spec.interval;
    ws.kick = 1;
    if (mag - 1 <= 0) startReload(inv, ws);
    return true;
}

export function switchWeapon(inv: Inventory, ws: WeaponState, id: WeaponId): boolean {
    if (!inv.weapons.includes(id) || inv.current === id) return false;
    inv.current = id;
    ws.reloading = 0; ws.swing = -1; ws.cooldown = 0.35;
    return true;
}

/** Medgel: 55 health back (more with the Field Medic perk), up to the maximum. */
export function useMedgel(inv: Inventory, health: number, max: number, heal = 55): number {
    if (inv.medgel <= 0 || health >= max) return health;
    inv.medgel--;
    return Math.min(max, health + heal);
}
