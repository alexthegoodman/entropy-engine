/** Scene lighting for the Canvas Surfaces shader. One shared uniform buffer holds every value, so a
 * lighting change is a single buffer write and never touches a mesh. `sunDirection` points TOWARD the
 * sun (the same convention as the engine's sky pass). */
export type Color3 = [number, number, number];
export interface Lamp { position: Color3; color: Color3; intensity: number; /** Distance scale: 1 matches the editor lamps, 3 lights three times as far. */ reach: number; }
export interface LightingSettings {
    ambient: Color3;
    sunDirection: Color3; sunColor: Color3; sunIntensity: number;
    /** Tint for surfaces facing up and down, times fillStrength. */
    skyFill: Color3; groundFill: Color3; fillStrength: number;
    fogColor: Color3; fogDensity: number;
    horizonColor: Color3; zenithColor: Color3;
    lamps: Lamp[];
}
export const MAX_LAMPS = 4;
/** Floats in the uniform buffer: six vec4 plus four position and four colour vec4. Must match `Lighting` in the shader. */
export const LIGHTING_FLOATS = (6 + MAX_LAMPS * 2) * 4;

export const LIGHTING_PRESETS: Record<string, LightingSettings> = {
    // What the editor has always looked like: two fixed point lights and flat ambient.
    editor: {
        ambient: [0.45, 0.45, 0.45], sunDirection: [0.4, 0.8, 0.4], sunColor: [1, 0.96, 0.88], sunIntensity: 0,
        skyFill: [0, 0, 0], groundFill: [0, 0, 0], fillStrength: 0, fogColor: [0.62, 0.62, 0.66], fogDensity: 0,
        horizonColor: [0.62, 0.62, 0.66], zenithColor: [0.36, 0.36, 0.4],
        lamps: [
            { position: [4, 5, 3], color: [1, 0.96, 0.88], intensity: 1.1, reach: 1 },
            { position: [-4, 3, -3.5], color: [0.55, 0.65, 0.95], intensity: 0.7, reach: 1 },
        ],
    },
    day: {
        ambient: [0.34, 0.36, 0.4], sunDirection: [0.45, 0.8, 0.35], sunColor: [1, 0.96, 0.88], sunIntensity: 0.95,
        skyFill: [0.45, 0.6, 0.9], groundFill: [0.25, 0.22, 0.15], fillStrength: 0.35, fogColor: [0.72, 0.82, 0.95], fogDensity: 0.01,
        horizonColor: [0.72, 0.84, 0.96], zenithColor: [0.25, 0.5, 0.9], lamps: [],
    },
    golden_hour: {
        ambient: [0.34, 0.3, 0.3], sunDirection: [0.85, 0.28, 0.3], sunColor: [1, 0.72, 0.4], sunIntensity: 1.15,
        skyFill: [0.5, 0.45, 0.6], groundFill: [0.3, 0.2, 0.12], fillStrength: 0.3, fogColor: [0.95, 0.7, 0.5], fogDensity: 0.014,
        horizonColor: [0.98, 0.72, 0.5], zenithColor: [0.35, 0.42, 0.75], lamps: [],
    },
    dusk: {
        ambient: [0.24, 0.2, 0.3], sunDirection: [-0.7, 0.15, 0.4], sunColor: [0.9, 0.45, 0.35], sunIntensity: 0.6,
        skyFill: [0.3, 0.3, 0.55], groundFill: [0.16, 0.1, 0.12], fillStrength: 0.35, fogColor: [0.35, 0.28, 0.4], fogDensity: 0.018,
        horizonColor: [0.55, 0.35, 0.42], zenithColor: [0.12, 0.14, 0.32], lamps: [],
    },
    night: {
        ambient: [0.1, 0.12, 0.2], sunDirection: [-0.3, 0.7, -0.4], sunColor: [0.5, 0.6, 0.9], sunIntensity: 0.4,
        skyFill: [0.1, 0.14, 0.3], groundFill: [0.03, 0.03, 0.06], fillStrength: 0.3, fogColor: [0.03, 0.04, 0.09], fogDensity: 0.018,
        horizonColor: [0.05, 0.06, 0.12], zenithColor: [0.01, 0.015, 0.05], lamps: [],
    },
    overcast: {
        ambient: [0.5, 0.52, 0.55], sunDirection: [0.2, 0.9, 0.2], sunColor: [0.9, 0.92, 0.95], sunIntensity: 0.25,
        skyFill: [0.6, 0.62, 0.66], groundFill: [0.3, 0.3, 0.3], fillStrength: 0.4, fogColor: [0.66, 0.68, 0.72], fogDensity: 0.016,
        horizonColor: [0.66, 0.68, 0.72], zenithColor: [0.45, 0.48, 0.54], lamps: [],
    },
};
export const LIGHTING_PRESET_NAMES = Object.keys(LIGHTING_PRESETS);
export const cloneLighting = (l: LightingSettings): LightingSettings => JSON.parse(JSON.stringify(l));
export const defaultLighting = (): LightingSettings => cloneLighting(LIGHTING_PRESETS.editor);

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const color = (v: unknown, name: string, max = 2): Color3 => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(finite) || v.some(n => n < 0 || n > max)) throw new Error(`${name} must be [r, g, b] between 0 and ${max}.`);
    return [v[0], v[1], v[2]];
};
const vec = (v: unknown, name: string): Color3 => {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(finite) || v.some(n => Math.abs(n) > 1e5)) throw new Error(`${name} must be [x, y, z].`);
    return [v[0], v[1], v[2]];
};
const ranged = (v: unknown, name: string, min: number, max: number): number => {
    if (!finite(v) || v < min || v > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
    return v;
};

/** Start from `base`, apply the fields present in `patch`, and validate the result. Throws a message
 * naming the bad field; `base` is never modified. */
export function mergeLighting(base: LightingSettings, patch: Record<string, unknown>): LightingSettings {
    const out = cloneLighting(base);
    if (patch.ambient !== undefined) out.ambient = color(patch.ambient, "ambient");
    if (patch.sunDirection !== undefined) {
        out.sunDirection = vec(patch.sunDirection, "sunDirection");
        if (Math.hypot(...out.sunDirection) < 1e-6) throw new Error("sunDirection must not be zero.");
    }
    if (patch.sunColor !== undefined) out.sunColor = color(patch.sunColor, "sunColor");
    if (patch.sunIntensity !== undefined) out.sunIntensity = ranged(patch.sunIntensity, "sunIntensity", 0, 10);
    if (patch.skyFill !== undefined) out.skyFill = color(patch.skyFill, "skyFill");
    if (patch.groundFill !== undefined) out.groundFill = color(patch.groundFill, "groundFill");
    if (patch.fillStrength !== undefined) out.fillStrength = ranged(patch.fillStrength, "fillStrength", 0, 4);
    if (patch.fogColor !== undefined) out.fogColor = color(patch.fogColor, "fogColor", 1);
    if (patch.fogDensity !== undefined) out.fogDensity = ranged(patch.fogDensity, "fogDensity", 0, 0.5);
    if (patch.horizonColor !== undefined) out.horizonColor = color(patch.horizonColor, "horizonColor", 1);
    if (patch.zenithColor !== undefined) out.zenithColor = color(patch.zenithColor, "zenithColor", 1);
    if (patch.lamps !== undefined) {
        if (!Array.isArray(patch.lamps) || patch.lamps.length > MAX_LAMPS) throw new Error(`lamps must be a list of at most ${MAX_LAMPS}.`);
        out.lamps = patch.lamps.map((l: Record<string, unknown>, i) => ({
            position: vec(l?.position, `lamps[${i}].position`), color: color(l?.color ?? [1, 0.85, 0.6], `lamps[${i}].color`),
            intensity: ranged(l?.intensity ?? 1, `lamps[${i}].intensity`, 0, 20), reach: ranged(l?.reach ?? 1, `lamps[${i}].reach`, 0.1, 50),
        }));
    }
    return out;
}

/** Validate a saved lighting block (scene files are untrusted input). */
export function validateLighting(value: unknown): LightingSettings {
    if (!value || typeof value !== "object") throw new Error("Invalid lighting.");
    return mergeLighting(defaultLighting(), value as Record<string, unknown>);
}

/** Layout matches `struct Lighting` in the shader: ambient, sun_dir, sun_color, sky_fill, ground_fill, fog, then lamp positions and colours. */
export function packLighting(l: LightingSettings): Float32Array {
    const out = new Float32Array(LIGHTING_FLOATS);
    const len = Math.hypot(...l.sunDirection) || 1;
    out.set([...l.ambient, 0], 0);
    out.set([l.sunDirection[0] / len, l.sunDirection[1] / len, l.sunDirection[2] / len, 0], 4);
    out.set([...l.sunColor, l.sunIntensity], 8);
    out.set([...l.skyFill, l.fillStrength], 12);
    out.set([...l.groundFill, 0], 16);
    out.set([...l.fogColor, l.fogDensity], 20);
    l.lamps.slice(0, MAX_LAMPS).forEach((lamp, i) => {
        out.set([...lamp.position, lamp.reach], 24 + i * 4);
        out.set([...lamp.color, lamp.intensity], 24 + MAX_LAMPS * 4 + i * 4);
    });
    return out;
}
