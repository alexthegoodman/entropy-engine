// Cutscenes as data: a scene is a list of shots; a shot moves the camera along a spline of keys
// over its duration, shows subtitles and title cards, fades, and fires events (a gunship falls, a
// bolt is thrown) at given times. `evaluate` turns a scene and a time into everything the frame
// needs, so a cutscene can be scrubbed, skipped or checked in tests without a window.

import type { V3 } from "./ab_world";

export interface CameraKey {
    /** Seconds from the start of the shot. */
    t: number;
    pos: V3;
    target: V3;
    /** Vertical field of view (degrees); default 45. */
    fov?: number;
    /** Roll (radians, right side down). */
    roll?: number;
}

/** A camera key can follow something that moves: the game resolves `follow` each frame. */
export interface FollowKey extends Omit<CameraKey, "pos" | "target"> {
    follow: string;
    /** Offsets in the followed thing's frame (right, up, forward). */
    offset: V3;
    lookOffset: V3;
    /** A camera standing here (world) instead of riding along: it only turns to follow. */
    pos?: V3;
}

export interface Subtitle {
    t: number;
    /** Seconds on screen (default: by length). */
    dur?: number;
    speaker: string;
    text: string;
    /** Radio chatter (rendered with the radio's static frame), the HUD's voice, or a line spoken here. */
    channel?: "radio" | "sage" | "voice" | "translation" | "caption";
}

export interface TitleCard {
    t: number;
    dur: number;
    lines: string[];
    style: "title" | "chapter" | "caption" | "lore";
}

export interface CinemaEvent { t: number; name: string; args?: Record<string, unknown> }

export interface Shot {
    id: string;
    duration: number;
    keys: (CameraKey | FollowKey)[];
    /** Ease the spline's time: "linear", "inOut" (slow at both ends), "out" (fast start). */
    ease?: "linear" | "inOut" | "out" | "in";
    subtitles?: Subtitle[];
    cards?: TitleCard[];
    events?: CinemaEvent[];
    /** Seconds of fade from black at the shot's start / to black at its end. */
    fadeIn?: number;
    fadeOut?: number;
    /** Letterbox bars (default true). */
    letterbox?: boolean;
    /** Camera shake (0..1) through the shot. */
    shake?: number;
    /** Color grade for the shot. */
    grade?: { saturation?: number; contrast?: number; exposure?: number };
}

export interface Scene { id: string; shots: Shot[] }

export const sceneDuration = (s: Scene): number => s.shots.reduce((a, b) => a + b.duration, 0);

export interface ShotAt { shot: Shot; index: number; local: number; start: number }

/** The shot playing at time t (clamped to the scene). */
export function shotAt(s: Scene, t: number): ShotAt {
    let start = 0;
    for (let i = 0; i < s.shots.length; i++) {
        const shot = s.shots[i];
        if (t < start + shot.duration || i === s.shots.length - 1) return { shot, index: i, local: Math.max(0, Math.min(shot.duration, t - start)), start };
        start += shot.duration;
    }
    throw new Error("empty scene");
}

export const ease = (kind: Shot["ease"], u: number): number => {
    const x = Math.max(0, Math.min(1, u));
    switch (kind) {
        case "inOut": return x * x * (3 - 2 * x);
        case "out": return 1 - (1 - x) * (1 - x);
        case "in": return x * x;
        default: return x;
    }
};

/** Centripetal-ish Catmull-Rom through p1..p2 (p0 and p3 the neighbors), u in 0..1. */
export function catmull(p0: V3, p1: V3, p2: V3, p3: V3, u: number): V3 {
    const u2 = u * u, u3 = u2 * u;
    const out: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        out[k] = 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
    }
    return out;
}

export interface Resolved { pos: V3; target: V3; fov: number; roll: number }

/** Resolves follow keys (the game passes how to find a followed thing's frame). */
export type FollowResolver = (name: string) => { pos: V3; right: V3; up: V3; forward: V3 } | null;

function resolveKey(k: CameraKey | FollowKey, follow: FollowResolver): Resolved {
    if ("follow" in k) {
        const f = follow(k.follow);
        const base = f ?? { pos: [0, 0, 0] as V3, right: [1, 0, 0] as V3, up: [0, 1, 0] as V3, forward: [0, 0, 1] as V3 };
        const at = (o: V3): V3 => [
            base.pos[0] + base.right[0] * o[0] + base.up[0] * o[1] + base.forward[0] * o[2],
            base.pos[1] + base.right[1] * o[0] + base.up[1] * o[1] + base.forward[1] * o[2],
            base.pos[2] + base.right[2] * o[0] + base.up[2] * o[1] + base.forward[2] * o[2],
        ];
        return { pos: k.pos ?? at(k.offset), target: at(k.lookOffset), fov: k.fov ?? 45, roll: k.roll ?? 0 };
    }
    return { pos: k.pos, target: k.target, fov: k.fov ?? 45, roll: k.roll ?? 0 };
}

/** The camera of a shot at local time t. */
export function shotCamera(shot: Shot, t: number, follow: FollowResolver = () => null): Resolved {
    const keys = shot.keys;
    if (!keys.length) return { pos: [0, 10, 0], target: [0, 0, 1], fov: 45, roll: 0 };
    const r = keys.map(k => resolveKey(k, follow));
    if (keys.length === 1) return r[0];
    // Ease the shot's time, then find the span.
    const first = keys[0].t, last = keys[keys.length - 1].t;
    const u = ease(shot.ease ?? "inOut", (t - first) / Math.max(1e-6, last - first));
    const tt = first + u * (last - first);
    let i = 0;
    while (i < keys.length - 2 && tt > keys[i + 1].t) i++;
    const span = Math.max(1e-6, keys[i + 1].t - keys[i].t);
    const s = Math.max(0, Math.min(1, (tt - keys[i].t) / span));
    const p = (j: number) => r[Math.max(0, Math.min(r.length - 1, j))];
    return {
        pos: catmull(p(i - 1).pos, p(i).pos, p(i + 1).pos, p(i + 2).pos, s),
        target: catmull(p(i - 1).target, p(i).target, p(i + 1).target, p(i + 2).target, s),
        fov: p(i).fov + (p(i + 1).fov - p(i).fov) * s,
        roll: p(i).roll + (p(i + 1).roll - p(i).roll) * s,
    };
}

/** How long a subtitle stays: by its length, 2.2 s at least. */
export const subtitleDuration = (s: Subtitle): number => s.dur ?? Math.max(2.2, 1.2 + s.text.length * 0.055);

export interface Frame {
    camera: Resolved;
    shot: ShotAt;
    /** 0 clear .. 1 black. */
    fade: number;
    letterbox: boolean;
    shake: number;
    subtitles: (Subtitle & { age: number })[];
    cards: (TitleCard & { age: number; alpha: number })[];
    grade: { saturation: number; contrast: number; exposure: number };
    done: boolean;
}

export function evaluate(scene: Scene, t: number, follow: FollowResolver = () => null): Frame {
    const at = shotAt(scene, t);
    const { shot, local } = at;
    let fade = 0;
    if (shot.fadeIn && local < shot.fadeIn) fade = Math.max(fade, 1 - local / shot.fadeIn);
    if (shot.fadeOut && local > shot.duration - shot.fadeOut) fade = Math.max(fade, 1 - (shot.duration - local) / shot.fadeOut);
    const subtitles = (shot.subtitles ?? []).filter(s => local >= s.t && local < s.t + subtitleDuration(s)).map(s => ({ ...s, age: local - s.t }));
    const cards = (shot.cards ?? []).filter(c => local >= c.t && local < c.t + c.dur).map(c => {
        const age = local - c.t;
        const alpha = Math.min(1, age / 0.8, (c.dur - age) / 0.8);
        return { ...c, age, alpha: Math.max(0, alpha) };
    });
    return {
        camera: shotCamera(shot, local, follow),
        shot: at,
        fade: Math.max(0, Math.min(1, fade)),
        letterbox: shot.letterbox ?? true,
        shake: shot.shake ?? 0,
        subtitles,
        cards,
        grade: { saturation: shot.grade?.saturation ?? 1, contrast: shot.grade?.contrast ?? 1.05, exposure: shot.grade?.exposure ?? 1 },
        done: t >= sceneDuration(scene),
    };
}

/** Events whose time falls in (from, to] of the scene's clock: what to fire this frame. */
export function eventsBetween(scene: Scene, from: number, to: number): (CinemaEvent & { shot: string })[] {
    const out: (CinemaEvent & { shot: string })[] = [];
    let start = 0;
    for (const shot of scene.shots) {
        for (const e of shot.events ?? []) {
            const at = start + e.t;
            if (at > from && at <= to) out.push({ ...e, shot: shot.id });
        }
        start += shot.duration;
    }
    return out;
}

/** All events of a scene at or before t (to bring the world to a skipped-to moment). */
export const eventsUntil = (scene: Scene, t: number) => eventsBetween(scene, -Infinity, t);
