// The sky over the street: where the sun-shadow cascades go, and the weather (cloud cover, the
// clouds' drift and the wind that bends the trees).
//
// Shadows (core/addon_sun_shadows.rs, al_shader.ts). Each cascade is an orthographic view down
// the sun's rays covering a sphere around the camera, a little ahead of it so more of the map
// lies where you look. A sphere rather than a fitted box keeps a cascade the same size however
// you turn, and its center is snapped to whole texels across the light, so walking and turning do
// not make shadow edges crawl. The light's near plane stands far toward the sun so that a tower
// down the street still shades you.
//
// Weather is cosmetic: it comes from its own hash of the region and day and never touches the
// campaign's RNG, so changing it cannot change an election.

import { type Vec3, add, cross, dot, normalize, scale } from "../../apps/quadplanet/qp_math";
import { CLOUD_PERIOD } from "../../apps/quadplanet/qp_shader";
import { hashString } from "./al_rng";

/** Cascade radii (m), nearest first: your feet and the people near you, the street, the block, the district. */
export const SHADOW_RADII = [12, 40, 140, 520];
export const SHADOW_MAP_SIZE = 2048;
/** How far toward the sun (m) the light's near plane stands beyond a cascade's sphere. */
export const SHADOW_REACH = 2500;

export interface ShadowCascades { cascades: number[][]; texel: number[]; depthRange: number }

/**
 * Light matrices (column-major, render space -> clip with z in 0..1) for a camera at `eye`
 * looking along `forward`, with `sun` the unit vector toward the sun.
 */
export function shadowCascades(eye: Vec3, forward: Vec3, sun: Vec3, radii = SHADOW_RADII, mapSize = SHADOW_MAP_SIZE): ShadowCascades {
    const s = normalize(sun);
    // A light basis that only changes when the sun does.
    let x = cross([0, 1, 0], s);
    if (Math.hypot(x[0], x[1], x[2]) < 1e-3) x = cross([1, 0, 0], s);
    x = normalize(x);
    const y = cross(s, x);
    const maxR = Math.max(...radii);
    const depthRange = SHADOW_REACH + 2 * maxR;
    const cascades: number[][] = [];
    const texel: number[] = [];
    for (const r of radii) {
        const center = add(eye, scale(forward, r * 0.6));
        const t = (2 * r) / mapSize;
        const cx = Math.round(dot(center, x) / t) * t;
        const cy = Math.round(dot(center, y) / t) * t;
        // Depth 0 at the near plane (toward the sun), 1 at the far one, beyond the sphere; in
        // whole meters, so stored depths hold still too.
        const near = Math.round(dot(center, s) + r + SHADOW_REACH);
        const r0 = [x[0] / r, x[1] / r, x[2] / r, -cx / r];
        const r1 = [y[0] / r, y[1] / r, y[2] / r, -cy / r];
        const r2 = [-s[0] / depthRange, -s[1] / depthRange, -s[2] / depthRange, near / depthRange];
        cascades.push([r0[0], r1[0], r2[0], 0, r0[1], r1[1], r2[1], 0, r0[2], r1[2], r2[2], 0, r0[3], r1[3], r2[3], 1]);
        texel.push(t);
    }
    return { cascades, texel, depthRange };
}

export interface Weather {
    /** 0 clear .. 1 overcast. */
    cloudCover: number;
    /** Wind speed at street level (m/s) and the direction it blows toward (radians from east, toward north). */
    windSpeed: number;
    windHeading: number;
}

const unit = (key: string): number => (hashString(key) >>> 0) / 4294967296;

/**
 * The weather in a region on a day, `t` (0..1) through it: a cover and wind picked for the day,
 * drifting toward the next day's so dawn never jumps.
 */
export function weatherAt(region: string, day: number, t: number): Weather {
    const pick = (d: number): Weather => {
        const a = unit(`weather:${region}:${d}`), b = unit(`wind:${region}:${d}`), c = unit(`heading:${region}:${d}`);
        // Mostly fair to broken cloud; now and then nearly clear or heavy.
        return { cloudCover: 0.12 + 0.6 * a * a + 0.2 * a, windSpeed: 1.5 + 7 * b, windHeading: c * Math.PI * 2 };
    };
    const now = pick(day), next = pick(day + 1);
    const k = Math.max(0, Math.min(1, t)) ** 3;
    const dh = Math.atan2(Math.sin(next.windHeading - now.windHeading), Math.cos(next.windHeading - now.windHeading));
    return {
        cloudCover: now.cloudCover + (next.cloudCover - now.cloudCover) * k,
        windSpeed: now.windSpeed + (next.windSpeed - now.windSpeed) * k,
        windHeading: now.windHeading + dh * k,
    };
}

/** Clouds sail with the upper wind: faster than the street's, a little veered. */
export const CLOUD_WIND_FACTOR = 3.2;

/**
 * Where the cloud noise is sampled relative to the render origin: the origin's planet position
 * plus how far the clouds have drifted, wrapped to the noise's period (exact in doubles here, small
 * in floats on the GPU).
 */
export function cloudOffset(renderOrigin: Vec3, drift: Vec3): Vec3 {
    const wrap = (v: number) => ((v % CLOUD_PERIOD) + CLOUD_PERIOD) % CLOUD_PERIOD;
    return [wrap(renderOrigin[0] + drift[0]), wrap(renderOrigin[1] + drift[1]), wrap(renderOrigin[2] + drift[2])];
}

/** The wind as a velocity in render space, from the street frame's east and north. */
export function windVector(w: Weather, east: Vec3, north: Vec3): Vec3 {
    return add(scale(east, Math.cos(w.windHeading) * w.windSpeed), scale(north, Math.sin(w.windHeading) * w.windSpeed));
}
