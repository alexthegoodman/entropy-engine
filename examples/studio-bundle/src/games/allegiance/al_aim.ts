// Aiming: how the view turns (smoothed, with a response curve for sticks), aiming down sights,
// and aim assist. Pure functions over plain data, so the tests drive them without a window.
//
// - Smoothing: mouse motion is queued and played out over a few hundredths of a second, so the
//   view glides instead of jumping a pixel-step at a time; stick and arrow-key turning ease up to
//   speed (and back down) instead of starting and stopping dead, with a curve that keeps small
//   deflections fine and full ones fast.
// - Aiming down sights (ADS): the view narrows (Camera.setFov), turning slows, the weapon comes
//   up to the eye, spread tightens and you walk slower. Raised over ADS_TIME seconds.
// - Aim assist (0-100%, a setting): near a soldier the view turns slower over them (friction),
//   drifts onto them while you aim down sights or fire (magnetism), and shots a hair off them are
//   bent onto them. 0% turns all of it off.

export interface LookState {
    /** Mouse motion not yet applied (radians of yaw and pitch). */
    pendingYaw: number; pendingPitch: number;
    /** Current stick/keyboard turn rates (radians per second), eased toward the input. */
    rateYaw: number; ratePitch: number;
    /** Seconds the stick has been held near full deflection (turning speeds up a little). */
    held: number;
    /** 0 (hip) .. 1 (down the sights). */
    ads: number;
}

export const newLook = (): LookState => ({ pendingYaw: 0, pendingPitch: 0, rateYaw: 0, ratePitch: 0, held: 0, ads: 0 });

/** Radians per pixel of mouse motion (before ADS and assist). */
export const MOUSE_YAW = 0.005, MOUSE_PITCH = 0.004;
/** Mouse motion plays out with this time constant (seconds). */
export const MOUSE_SMOOTH = 0.03;
/** Stick turn rates at full deflection (rad/s), and how fast the rate follows the stick (s). */
export const STICK_YAW = 2.4, STICK_PITCH = 1.6, STICK_EASE = 0.08;
/** Full deflection held this long turns up to STICK_BOOST times faster. */
export const STICK_BOOST = 1.5, BOOST_AFTER = 0.35, BOOST_RAMP = 0.5;
/** Seconds to raise the sights, field of view at the hip and down the sights (degrees). */
export const ADS_TIME = 0.18, HIP_FOV = 45, ADS_FOV = 28;
/** Turning while down the sights, as a share of the hip rate. */
export const ADS_TURN = 0.55;

/** The stick's response curve: fine near the center, fast at the edge (sign kept). */
export function stickCurve(v: number): number {
    const a = Math.min(1, Math.abs(v));
    return Math.sign(v) * Math.pow(a, 1.8);
}

/** Queues mouse motion (pixels) to play out over the next frames. */
export function addMouse(s: LookState, dx: number, dy: number, sensitivity = 1): void {
    const k = sensitivity * (1 - s.ads * (1 - ADS_TURN));
    s.pendingYaw += dx * MOUSE_YAW * k;
    s.pendingPitch -= dy * MOUSE_PITCH * k;
}

/** Raises or lowers the sights. */
export function stepAds(s: LookState, wanted: boolean, dt: number): void {
    s.ads = Math.max(0, Math.min(1, s.ads + (wanted ? dt : -dt) / ADS_TIME));
}

/** Field of view (degrees) for the current ADS raise, eased. */
export function adsFov(s: LookState): number {
    const t = s.ads * s.ads * (3 - 2 * s.ads);
    return HIP_FOV + (ADS_FOV - HIP_FOV) * t;
}

/**
 * One frame of turning: returns the yaw and pitch change. `stickX`/`stickY` are the right stick
 * (or arrow keys as +-1), `friction` (0..1) slows turning over a target (aim assist).
 */
export function stepLook(s: LookState, stickX: number, stickY: number, dt: number, friction = 0, sensitivity = 1): { yaw: number; pitch: number } {
    // Mouse: play out the queue.
    const take = 1 - Math.exp(-dt / MOUSE_SMOOTH);
    let yaw = s.pendingYaw * take, pitch = s.pendingPitch * take;
    s.pendingYaw -= yaw; s.pendingPitch -= pitch;
    if (Math.abs(s.pendingYaw) < 1e-6) s.pendingYaw = 0;
    if (Math.abs(s.pendingPitch) < 1e-6) s.pendingPitch = 0;
    // Stick: a response curve, a short ease toward the target rate, and a boost when held at full.
    const full = Math.hypot(stickX, stickY) > 0.92;
    s.held = full ? s.held + dt : 0;
    const boost = 1 + (STICK_BOOST - 1) * Math.max(0, Math.min(1, (s.held - BOOST_AFTER) / BOOST_RAMP));
    const scale = sensitivity * (1 - s.ads * (1 - ADS_TURN));
    const wantYaw = stickCurve(stickX) * STICK_YAW * boost * scale;
    const wantPitch = stickCurve(stickY) * STICK_PITCH * scale;
    const ease = 1 - Math.exp(-dt / STICK_EASE);
    s.rateYaw += (wantYaw - s.rateYaw) * ease;
    s.ratePitch += (wantPitch - s.ratePitch) * ease;
    if (Math.abs(s.rateYaw) < 1e-4 && wantYaw === 0) s.rateYaw = 0;
    if (Math.abs(s.ratePitch) < 1e-4 && wantPitch === 0) s.ratePitch = 0;
    yaw += s.rateYaw * dt;
    pitch += s.ratePitch * dt;
    const f = 1 - Math.max(0, Math.min(0.9, friction));
    return { yaw: yaw * f, pitch: pitch * f };
}

// --- Aim assist ----------------------------------------------------------------------------------

export interface AimTarget { id: number; x: number; y: number; z: number }

export interface AssistPick {
    target: AimTarget;
    /** Yaw and pitch (radians) that would put the crosshair on it. */
    dYaw: number; dPitch: number;
    /** Angle off the crosshair, and the assist cone's half angle at its distance (radians). */
    angle: number; cone: number;
    distance: number;
}

/** Wraps an angle into -pi..pi. */
export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Yaw/pitch of the direction from `eye` to `p` (yaw: atan2(x, z), as the player faces). */
export function anglesTo(eye: [number, number, number], p: [number, number, number]): { yaw: number; pitch: number; distance: number } {
    const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
    const h = Math.hypot(dx, dz);
    return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, h), distance: Math.hypot(h, dy) };
}

/**
 * The target nearest the crosshair inside the assist cone (or null). The cone is the body's own
 * angular size plus a margin that grows with the assist strength and while aiming down sights.
 * `visible` filters by line of sight.
 */
export function pickAssistTarget(eye: [number, number, number], yaw: number, pitch: number, targets: readonly AimTarget[], strength: number, ads: number, range: number,
    visible: (t: AimTarget) => boolean = () => true): AssistPick | null {
    if (strength <= 0) return null;
    let best: AssistPick | null = null;
    for (const t of targets) {
        const chest: [number, number, number] = [t.x, t.y + 1.25, t.z];
        const a = anglesTo(eye, chest);
        if (a.distance > range || a.distance < 0.5) continue;
        const dYaw = wrapAngle(a.yaw - yaw), dPitch = a.pitch - pitch;
        const angle = Math.hypot(dYaw * Math.cos(pitch), dPitch);
        const cone = Math.atan(0.45 / a.distance) + (0.04 + 0.05 * ads) * strength;
        if (angle > cone) continue;
        if (best && angle >= best.angle) continue;
        if (!visible(t)) continue;
        best = { target: t, dYaw, dPitch, angle, cone, distance: a.distance };
    }
    return best;
}

/** How much the view slows over a target (0..0.6): strongest dead center. */
export function assistFriction(pick: AssistPick | null, strength: number): number {
    if (!pick) return 0;
    return 0.6 * strength * (1 - pick.angle / pick.cone);
}

/**
 * Magnetism: the turn (yaw, pitch) this frame that draws the crosshair onto the target while you
 * aim down sights or fire. Never more than the remaining error.
 */
export function assistPull(pick: AssistPick | null, strength: number, ads: number, firing: boolean, dt: number): { yaw: number; pitch: number } {
    if (!pick || strength <= 0) return { yaw: 0, pitch: 0 };
    const engaged = Math.max(ads, firing ? 0.6 : 0);
    if (engaged <= 0) return { yaw: 0, pitch: 0 };
    const k = Math.min(1, dt * 7 * strength * engaged);
    return { yaw: pick.dYaw * k, pitch: pick.dPitch * k };
}

/** Bullet magnetism: a shot this close to a target (radians) goes onto it. */
export const bendAngle = (strength: number): number => 0.025 * strength;

/** Spread multiplier while aiming down sights (tighter), and walking speed. */
export const adsSpread = (ads: number): number => 1 - 0.55 * ads;
export const adsMove = (ads: number): number => 1 - 0.45 * ads;
