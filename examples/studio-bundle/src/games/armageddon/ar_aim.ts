// Armageddon 2070 aim feel: how mouse and right-stick motion turn into view rotation.
//
// - Mouse: raw counts, eased in over ~12 ms so uneven per-frame counts don't step the view. All of the
//   motion still arrives (nothing lost, nothing added), so the hand stays in charge of where it stops.
// - Right stick: a radial dead zone, a curve for fine aim near the centre, a turn boost that ramps in only
//   once the stick has been held at the rim, and a rate that eases up but stops almost at once (a slow
//   stop is what carries the crosshair past a target).
// - Friction: the look slows while the crosshair is on or near a visible enemy, so a flick or a sweep
//   stops on them instead of past them. Stronger on the pad and aimed down sights. It only scales the
//   player's own input; it never moves the view by itself.

import { clamp, type V3 } from "../nebula/nk_math";

const smooth = (t: number) => { const x = clamp(t); return x * x * (3 - 2 * x); };

/** Seconds for the mouse's motion to arrive (63% of it). */
export const MOUSE_EASE = 0.012;

export class MouseEase {
    private left: [number, number] = [0, 0];
    /** Adds this frame's counts; returns the part to apply now (the rest follows in later frames). */
    take(dx: number, dy: number, dt: number): [number, number] {
        this.left[0] += dx; this.left[1] += dy;
        const k = 1 - Math.exp(-Math.max(0, dt) / MOUSE_EASE);
        const out: [number, number] = [this.left[0] * k, this.left[1] * k];
        this.left[0] -= out[0]; this.left[1] -= out[1];
        if (Math.abs(this.left[0]) < 1e-3 && Math.abs(this.left[1]) < 1e-3) this.left = [0, 0];
        return out;
    }
    reset(): void { this.left = [0, 0]; }
}

export const STICK = {
    /** Radial dead zone, and where the curve reaches full (a little short of the physical rim). */
    dead: 0.12, full: 0.94,
    /** Full deflection rate (rad/s at 1x zoom), and the boost a held rim ramps up to. */
    rate: 3.0, boost: 1.55,
    /** The boost starts after the rim has been held this long, and takes this long to come in. */
    boostAfter: 0.15, boostRamp: 0.35,
    /** Time constants (s) for the rate speeding up and for slowing down or reversing. */
    rise: 0.06, fall: 0.012,
};

/** Fine aim near the centre, full speed at the rim (0..1 -> 0..1). */
export function stickCurve(t: number): number { const x = clamp(t); return 0.25 * x + 0.75 * x * x * x; }

export class StickLook {
    /** The current look rate (rad/s at 1x zoom): x yaw, y pitch, in stick axes. */
    vel: [number, number] = [0, 0];
    private rim = 0;
    step(rx: number, ry: number, dt: number): [number, number] {
        const m = Math.hypot(rx, ry);
        let want: [number, number] = [0, 0];
        if (m > STICK.dead) {
            const t = clamp((m - STICK.dead) / (STICK.full - STICK.dead));
            this.rim = t >= 1 ? this.rim + dt : 0;
            const boost = 1 + (STICK.boost - 1) * smooth((this.rim - STICK.boostAfter) / STICK.boostRamp);
            const r = stickCurve(t) * STICK.rate * boost;
            want = [(rx / m) * r, (ry / m) * r];
        } else this.rim = 0;
        for (const i of [0, 1]) {
            const v = this.vel[i], w = want[i];
            const faster = Math.abs(w) > Math.abs(v) && (v === 0 || Math.sign(w) === Math.sign(v));
            this.vel[i] = v + (w - v) * (1 - Math.exp(-Math.max(0, dt) / (faster ? STICK.rise : STICK.fall)));
            if (w === 0 && Math.abs(this.vel[i]) < 1e-3) this.vel[i] = 0;
        }
        return this.vel;
    }
    reset(): void { this.vel = [0, 0]; this.rim = 0; }
}

/** How much the look slows on a target, hip -> aimed (a share of the input taken away). */
export const FRICTION = { mouse: [0.2, 0.35], pad: [0.4, 0.55] } as const;
/** Half-size of a soldier as a target (m), the screen-space margin around one (rad at 1x zoom), and the reach (m). */
export const TARGET_RADIUS = 0.55, FRICTION_MARGIN = 0.022, FRICTION_RANGE = 350;

/** How much the crosshair (from `eye` along unit `dir`) is on a target: 1 on one, fading to 0 at the edge
 * of the margin around it. Only the best candidate is tested for line of sight. */
export function frictionWeight(eye: V3, dir: V3, targets: V3[], zoom: number, visible: (p: V3) => boolean): number {
    let best = 0, at: V3 | null = null;
    const margin = FRICTION_MARGIN / Math.max(1, zoom);
    for (const p of targets) {
        const v: V3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
        const along = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
        if (along <= 0.5 || along > FRICTION_RANGE) continue;
        const miss = Math.hypot(v[0] - dir[0] * along, v[1] - dir[1] * along, v[2] - dir[2] * along);
        const size = Math.atan2(TARGET_RADIUS, along);
        const u = Math.atan2(miss, along) / (size + margin);
        const w = 1 - smooth((u - 0.45) / 0.55);
        if (w > best) { best = w; at = p; }
    }
    return at && visible(at) ? best : 0;
}

/** The look multiplier for a friction weight, by device and how far into aiming down sights (0..1). */
export function frictionScale(weight: number, pad: boolean, adsT: number): number {
    const [hip, ads] = pad ? FRICTION.pad : FRICTION.mouse;
    return 1 - clamp(weight) * (hip + (ads - hip) * clamp(adsT));
}
