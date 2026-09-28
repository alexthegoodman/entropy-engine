// A small CPU renderer for Mesha's automatic visual checks: renders an evaluated object into an
// RGBA image with the same lighting ideas as the viewport shader (key + fill + sky, glossy
// highlights, metals reflecting a studio gradient, a soft contact shadow), so fuzzed configurations
// can be laid out on contact sheets and inspected without a GPU or a window.

import { type Mesh, type Vec3, bounds, mergeByRegion, normalize3, sub3, cross3, dot3, add3, scale3 } from "./mesha_mesh";
import { type MaterialPreset, FALLBACK_MATERIAL } from "./mesha_materials";
import { noise3 } from "./mesha_noise";

export interface RasterOptions {
    width?: number;
    height?: number;
    /** Degrees around +Y, 0 looks from +Z. */
    yaw?: number;
    /** Degrees above the horizon. */
    pitch?: number;
    fov?: number;
    /** Supersampling factor per axis. */
    ss?: number;
    background?: [number, number, number];
}

export interface Image { width: number; height: number; data: Uint8Array }

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Narkowicz's ACES fit: soft highlight roll-off so light surfaces keep their color. */
const aces = (x: number) => clamp01((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14));

/** Studio sky: the environment metals reflect and the sky fill light. */
function sky(d: Vec3): Vec3 {
    const t = clamp01(d[1] * 0.5 + 0.5);
    const horizon: Vec3 = [0.78, 0.8, 0.83], zenith: Vec3 = [0.42, 0.5, 0.62], ground: Vec3 = [0.22, 0.2, 0.19];
    if (d[1] < 0) return [ground[0] + (horizon[0] - ground[0]) * (1 + d[1]) ** 4, ground[1] + (horizon[1] - ground[1]) * (1 + d[1]) ** 4, ground[2] + (horizon[2] - ground[2]) * (1 + d[1]) ** 4];
    // A bright softbox up and to the side, which is what makes chrome read as chrome.
    const box = Math.max(0, dot3(d, normalize3([0.5, 0.75, 0.45]))) ** 24 * 3.5;
    const k = (t - 0.5) * 2;
    return [horizon[0] + (zenith[0] - horizon[0]) * k + box, horizon[1] + (zenith[1] - horizon[1]) * k + box, horizon[2] + (zenith[2] - horizon[2]) * k + box];
}

export const KEY_LIGHT = normalize3([0.55, 0.8, 0.35]);
const FILL_LIGHT = normalize3([-0.6, 0.35, -0.2]);

/** Shades one surface point; the same model the viewport's WGSL uses, in linear RGB. */
export function shade(mat: MaterialPreset, n: Vec3, view: Vec3, occlusion = 1): Vec3 {
    const base: Vec3 = [srgbToLinear(mat.color[0]), srgbToLinear(mat.color[1]), srgbToLinear(mat.color[2])];
    const rough = Math.max(0.04, mat.roughness), metal = mat.metallic;
    const ndl = Math.max(0, dot3(n, KEY_LIGHT)), ndf = Math.max(0, dot3(n, FILL_LIGHT));
    const hemi = 0.5 + 0.5 * n[1];
    const diffuseLight = 1.05 * ndl + 0.22 * ndf + (0.18 + 0.2 * hemi) * occlusion;
    const h = normalize3(add3(KEY_LIGHT, view));
    const shininess = 2 / (rough * rough * rough + 1e-3);
    const spec = ((shininess + 8) / 25) * Math.max(0, dot3(n, h)) ** Math.min(shininess, 4000) * ndl;
    const nv = Math.max(0, dot3(n, view));
    const fresnel = 0.04 + 0.96 * (1 - nv) ** 5;
    const refl = sub3(scale3(n, 2 * dot3(n, view)), view);
    const env = sky(refl);
    const f0: Vec3 = metal > 0.5 ? base : [0.04, 0.04, 0.04];
    const out: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        const diffuse = base[k] * (1 - metal) * diffuseLight;
        const reflectance = metal > 0.5 ? f0[k] + (1 - f0[k]) * fresnel * (1 - rough) : fresnel * (1 - rough) * (1 - rough) * 0.8;
        const specular = spec * (metal > 0.5 ? f0[k] : 0.05 + 0.3 * fresnel);
        out[k] = diffuse + env[k] * reflectance * occlusion * (0.35 + 0.65 * (1 - rough)) + specular;
    }
    if (mat.transmission) {
        // Glass: mostly environment and tint, a little diffuse so its shape still reads.
        const t = mat.transmission;
        for (let k = 0; k < 3; k++) out[k] = out[k] * (1 - t) + t * (base[k] * 0.55 + env[k] * (0.25 + fresnel * 0.9));
    }
    return out;
}

interface Tri { p: Vec3[]; n: Vec3[]; uv: [number, number][]; mat: MaterialPreset }

/**
 * The viewport's surface patterns that matter at contact-sheet size: foliage (per-leaf tint, crown
 * shading, light through back-lit leaves), bark furrows and birch lenticels. Returns the material to
 * shade with, a light multiplier and whether light passes through.
 */
function patterned(mat: MaterialPreset, uv: [number, number]): { mat: MaterialPreset; dim: number; leaf: boolean } {
    if (mat.pattern === "foliage") {
        const whole = Math.floor(uv[1] + 1e-6), k = Math.min(1, Math.max(0, uv[1] - whole));
        const occ = Math.min(15, Math.max(0, whole)) / 15;
        const t = mat.tint ?? mat.color;
        const base = 0.78 + 0.22 * Math.min(1, Math.max(0, uv[0] / 0.7));
        const color: [number, number, number] = [0, 1, 2].map(i => (mat.color[i] + (t[i] - mat.color[i]) * k) * base) as [number, number, number];
        return { mat: { ...mat, color }, dim: 1 - 0.62 * occ, leaf: true };
    }
    if (mat.pattern === "bark") {
        const f = noise3(uv[0] * 9 + noise3(uv[0] * 4, uv[1] * 0.8, 0.3) * 1.6, uv[1] * 1.2, 1.7) * 0.5 + 0.5;
        const ridge = 1 - Math.abs(f * 2 - 1);
        const k = 0.5 + 0.65 * Math.min(1, Math.max(0, (ridge - 0.35) / 0.55));
        return { mat: { ...mat, color: [mat.color[0] * k, mat.color[1] * k, mat.color[2] * k] }, dim: 1, leaf: false };
    }
    if (mat.pattern === "birch") {
        const dash = noise3(uv[0] * 7, uv[1] * 34, 3.1) > 0.35 ? 0.9 : 0;
        const patch = noise3(uv[0] * 3, uv[1] * 2.2, 8.3) > 0.4 ? 0.85 : 0;
        const k = Math.max(dash, patch);
        return { mat: { ...mat, color: mat.color.map(c => c * (1 - k) + 0.2 * k) as [number, number, number] }, dim: 1, leaf: false };
    }
    return { mat, dim: 1, leaf: false };
}

export function render(mesh: Mesh, materials: Record<string, MaterialPreset>, options: RasterOptions = {}): Image {
    const ss = options.ss ?? 2;
    const W = (options.width ?? 320) * ss, H = (options.height ?? 320) * ss;
    const b = bounds(mesh) ?? { min: [-0.5, 0, -0.5] as Vec3, max: [0.5, 1, 0.5] as Vec3 };
    const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const radius = Math.max(1e-3, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2);
    const yaw = ((options.yaw ?? 35) * Math.PI) / 180, pitch = ((options.pitch ?? 22) * Math.PI) / 180;
    const fov = ((options.fov ?? 32) * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.02;
    const eye: Vec3 = [center[0] + Math.sin(yaw) * Math.cos(pitch) * dist, center[1] + Math.sin(pitch) * dist, center[2] + Math.cos(yaw) * Math.cos(pitch) * dist];
    const fwd = normalize3(sub3(center, eye));
    const right = normalize3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    const focal = 1 / Math.tan(fov / 2);
    const aspect = W / H;
    const project = (p: Vec3): Vec3 => {
        const d = sub3(p, eye);
        const z = dot3(d, fwd);
        const x = dot3(d, right), y = dot3(d, up);
        return [((x * focal) / (z * aspect) * 0.5 + 0.5) * W, (0.5 - ((y * focal) / z) * 0.5) * H, z];
    };
    const floorY = b.min[1];
    const color = new Float32Array(W * H * 3);
    const depth = new Float32Array(W * H).fill(Infinity);
    // Background: studio floor and backdrop, with a soft contact shadow from a top-down occupancy map.
    const shadow = contactShadow(mesh, b, 48);
    const bg = options.background;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const ndcX = ((x + 0.5) / W - 0.5) * 2 * aspect / focal, ndcY = (0.5 - (y + 0.5) / H) * 2 / focal;
            const dir = normalize3(add3(fwd, add3(scale3(right, ndcX), scale3(up, ndcY))));
            let c: Vec3 = bg ? [srgbToLinear(bg[0]), srgbToLinear(bg[1]), srgbToLinear(bg[2])] : [0.36, 0.37, 0.39];
            if (!bg && dir[1] < -1e-4) {
                const t = (floorY - eye[1]) / dir[1];
                const hit: Vec3 = add3(eye, scale3(dir, t));
                const fall = Math.exp(-((Math.hypot(hit[0] - center[0], hit[2] - center[2]) / (radius * 3)) ** 2));
                const occ = shadow(hit[0], hit[2]);
                const floor = 0.3 + 0.14 * fall;
                c = [floor * (1 - 0.55 * occ), floor * (1 - 0.55 * occ), floor * 1.01 * (1 - 0.55 * occ)];
                const horizon = Math.exp(-t / (radius * 14));
                c = [c[0] * horizon + 0.36 * (1 - horizon), c[1] * horizon + 0.37 * (1 - horizon), c[2] * horizon + 0.39 * (1 - horizon)];
            } else if (!bg) {
                const g = 0.3 + 0.08 * (1 - Math.min(1, dir[1] * 2));
                c = [g, g * 1.005, g * 1.02];
            }
            const o = (y * W + x) * 3;
            color[o] = c[0]; color[o + 1] = c[1]; color[o + 2] = c[2];
        }
    }
    const tris: Tri[] = [];
    for (const part of mergeByRegion(mesh)) {
        const mat = materials[part.region] ?? FALLBACK_MATERIAL;
        for (let t = 0; t < part.indices.length; t += 3) {
            const ids = [part.indices[t], part.indices[t + 1], part.indices[t + 2]];
            tris.push({
                p: ids.map(i => [part.positions[i * 3], part.positions[i * 3 + 1], part.positions[i * 3 + 2]] as Vec3),
                n: ids.map(i => [part.normals[i * 3], part.normals[i * 3 + 1], part.normals[i * 3 + 2]] as Vec3),
                uv: ids.map(i => [part.uvs[i * 2] ?? 0, part.uvs[i * 2 + 1] ?? 0] as [number, number]),
                mat,
            });
        }
    }
    for (const t of tris) {
        const s = t.p.map(project);
        if (s.some(v => v[2] <= 1e-4)) continue;
        const area = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[1][1] - s[0][1]) * (s[2][0] - s[0][0]);
        if (Math.abs(area) < 1e-12) continue;
        const minX = Math.max(0, Math.floor(Math.min(s[0][0], s[1][0], s[2][0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(s[0][0], s[1][0], s[2][0])));
        const minY = Math.max(0, Math.floor(Math.min(s[0][1], s[1][1], s[2][1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(s[0][1], s[1][1], s[2][1])));
        const iz = s.map(v => 1 / v[2]);
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((s[1][0] - px) * (s[2][1] - py) - (s[1][1] - py) * (s[2][0] - px)) / area;
                const w1 = ((s[2][0] - px) * (s[0][1] - py) - (s[2][1] - py) * (s[0][0] - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                // Perspective-correct weights.
                const q0 = w0 * iz[0], q1 = w1 * iz[1], q2 = w2 * iz[2], qs = q0 + q1 + q2;
                const z = 1 / qs;
                const idx = y * W + x;
                if (z >= depth[idx]) continue;
                depth[idx] = z;
                const a = q0 / qs, bb = q1 / qs, c = q2 / qs;
                let n = normalize3([t.n[0][0] * a + t.n[1][0] * bb + t.n[2][0] * c, t.n[0][1] * a + t.n[1][1] * bb + t.n[2][1] * c, t.n[0][2] * a + t.n[1][2] * bb + t.n[2][2] * c]);
                const wp: Vec3 = [t.p[0][0] * a + t.p[1][0] * bb + t.p[2][0] * c, t.p[0][1] * a + t.p[1][1] * bb + t.p[2][1] * c, t.p[0][2] * a + t.p[1][2] * bb + t.p[2][2] * c];
                const view = normalize3(sub3(eye, wp));
                if (dot3(n, view) < 0) n = scale3(n, -1); // backfaces of open shells shade like fronts
                // Cheap occlusion toward the floor, so feet and undersides settle.
                // Smoothstep, not a clamped ramp: a ramp's end leaves a visible brightness line.
                const lift = clamp01((wp[1] - floorY) / (radius * 0.5));
                const occ = 0.55 + 0.45 * lift * lift * (3 - 2 * lift);
                let col: Vec3;
                if (t.mat.pattern === "foliage" || t.mat.pattern === "bark" || t.mat.pattern === "birch") {
                    // Interpolate the foliage tint fraction, not uv.y itself: the whole part is a separate value.
                    const fr = (u: number) => u - Math.floor(u + 1e-6), wh = (u: number) => Math.floor(u + 1e-6);
                    const uvx = t.uv[0][0] * a + t.uv[1][0] * bb + t.uv[2][0] * c;
                    const uvy = t.mat.pattern === "foliage"
                        ? Math.round(wh(t.uv[0][1]) * a + wh(t.uv[1][1]) * bb + wh(t.uv[2][1]) * c) + Math.min(0.999, fr(t.uv[0][1]) * a + fr(t.uv[1][1]) * bb + fr(t.uv[2][1]) * c)
                        : t.uv[0][1] * a + t.uv[1][1] * bb + t.uv[2][1] * c;
                    const pm = patterned(t.mat, [uvx, uvy]);
                    col = scale3(shade(pm.mat, n, view, occ * pm.dim), pm.leaf ? 0.4 + 0.6 * pm.dim : 1);
                    if (pm.leaf) {
                        // Light through a back-lit leaf.
                        const through = Math.max(0, -dot3(n, KEY_LIGHT)) ** 1.5 * pm.dim * 0.5;
                        const lin = pm.mat.color.map(srgbToLinear);
                        col = [col[0] + lin[0] * through, col[1] + lin[1] * through * 1.12, col[2] + lin[2] * through * 0.62];
                    }
                } else col = shade(t.mat, n, view, occ);
                const o = idx * 3;
                color[o] = col[0]; color[o + 1] = col[1]; color[o + 2] = col[2];
            }
        }
    }
    // Resolve: box filter the supersamples, filmic-ish tone curve, sRGB.
    const w = W / ss, h = H / ss;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let r = 0, g = 0, bl = 0;
            for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
                const o = ((y * ss + sy) * W + x * ss + sx) * 3;
                r += color[o]; g += color[o + 1]; bl += color[o + 2];
            }
            const k = 1 / (ss * ss);
            const tone = (v: number) => clamp01(linearToSrgb(aces(v * k)));
            const o = (y * w + x) * 4;
            data[o] = Math.round(tone(r) * 255); data[o + 1] = Math.round(tone(g) * 255); data[o + 2] = Math.round(tone(bl) * 255); data[o + 3] = 255;
        }
    }
    return { width: w, height: h, data };
}

/**
 * A soft top-down occlusion lookup: 1 under the object's footprint (stronger for parts near the
 * floor), fading out around it. The viewport's ground plane uses the same map as a texture.
 */
export function contactShadow(mesh: Mesh, b: { min: Vec3; max: Vec3 }, res = 64): (x: number, z: number) => number {
    const map = contactShadowMap(mesh, b, res);
    return (x, z) => {
        const u = (x - map.x0) / map.size, v = (z - map.z0) / map.size;
        if (u < 0 || v < 0 || u >= 1 || v >= 1) return 0;
        const fx = u * res - 0.5, fz = v * res - 0.5;
        const ix = Math.max(0, Math.min(res - 2, Math.floor(fx))), iz = Math.max(0, Math.min(res - 2, Math.floor(fz)));
        const tx = clamp01(fx - ix), tz = clamp01(fz - iz);
        const at = (i: number, j: number) => map.values[j * res + i];
        return (at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx) * (1 - tz) + (at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx) * tz;
    };
}

export interface ShadowMap { values: Float32Array; res: number; x0: number; z0: number; size: number }

export function contactShadowMap(mesh: Mesh, b: { min: Vec3; max: Vec3 }, res = 64): ShadowMap {
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const extent = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 1e-3);
    const size = extent * 1.8;
    const x0 = cx - size / 2, z0 = cz - size / 2;
    const heightSpan = Math.max(1e-3, b.max[1] - b.min[1]);
    const grid = new Float32Array(res * res);
    // Splat every triangle's covered cells, weighted by how close to the floor it is.
    for (const p of mesh.parts) {
        for (let t = 0; t < p.indices.length; t += 3) {
            const vs = [p.indices[t], p.indices[t + 1], p.indices[t + 2]].map(i => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]]);
            const y = Math.min(vs[0][1], vs[1][1], vs[2][1]);
            const weight = 0.35 + 0.65 * Math.exp(-((y - b.min[1]) / (heightSpan * 0.25)));
            const minU = Math.floor(((Math.min(vs[0][0], vs[1][0], vs[2][0]) - x0) / size) * res), maxU = Math.floor(((Math.max(vs[0][0], vs[1][0], vs[2][0]) - x0) / size) * res);
            const minV = Math.floor(((Math.min(vs[0][2], vs[1][2], vs[2][2]) - z0) / size) * res), maxV = Math.floor(((Math.max(vs[0][2], vs[1][2], vs[2][2]) - z0) / size) * res);
            for (let v = Math.max(0, minV); v <= Math.min(res - 1, maxV); v++) {
                for (let u = Math.max(0, minU); u <= Math.min(res - 1, maxU); u++) {
                    const cxw = x0 + ((u + 0.5) / res) * size, czw = z0 + ((v + 0.5) / res) * size;
                    if (!inTri2(cxw, czw, vs) && maxU - minU > 1 && maxV - minV > 1) continue;
                    const i = v * res + u;
                    if (weight > grid[i]) grid[i] = weight;
                }
            }
        }
    }
    // Blur twice (box) for a soft penumbra.
    let src = grid;
    const radius = Math.max(1, Math.round(res / 24));
    for (let pass = 0; pass < 3; pass++) {
        const tmp = new Float32Array(res * res), out = new Float32Array(res * res);
        for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
            let s = 0, c = 0;
            for (let k = -radius; k <= radius; k++) { const ii = i + k; if (ii >= 0 && ii < res) { s += src[j * res + ii]; c++; } }
            tmp[j * res + i] = s / c;
        }
        for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
            let s = 0, c = 0;
            for (let k = -radius; k <= radius; k++) { const jj = j + k; if (jj >= 0 && jj < res) { s += tmp[jj * res + i]; c++; } }
            out[j * res + i] = s / c;
        }
        src = out;
    }
    return { values: src, res, x0, z0, size };
}

function inTri2(x: number, z: number, v: number[][]): boolean {
    const s = (ax: number, az: number, bx: number, bz: number) => (x - bx) * (az - bz) - (ax - bx) * (z - bz);
    const d1 = s(v[0][0], v[0][2], v[1][0], v[1][2]), d2 = s(v[1][0], v[1][2], v[2][0], v[2][2]), d3 = s(v[2][0], v[2][2], v[0][0], v[0][2]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}

// --- Contact sheets ------------------------------------------------------------------------------

/** Tiles images into a grid with a caption strip (tiny bitmap font) under each. */
export function contactSheet(tiles: { image: Image; caption: string }[], columns = 4, gap = 6): Image {
    if (!tiles.length) return { width: 1, height: 1, data: new Uint8Array(4) };
    const tw = tiles[0].image.width, th = tiles[0].image.height, cap = 14;
    const rows = Math.ceil(tiles.length / columns);
    const W = columns * tw + (columns + 1) * gap, H = rows * (th + cap) + (rows + 1) * gap;
    const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([34, 36, 40, 255], i * 4);
    tiles.forEach((t, k) => {
        const ox = gap + (k % columns) * (tw + gap), oy = gap + Math.floor(k / columns) * (th + cap + gap);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
            const s = (y * tw + x) * 4, d = ((oy + y) * W + ox + x) * 4;
            data[d] = t.image.data[s]; data[d + 1] = t.image.data[s + 1]; data[d + 2] = t.image.data[s + 2]; data[d + 3] = 255;
        }
        drawText(data, W, ox + 3, oy + th + 4, t.caption.toUpperCase().slice(0, Math.floor((tw - 6) / 4)), [225, 228, 232]);
    });
    return { width: W, height: H, data };
}

// 3x5 glyphs, rows top to bottom, 3 bits each.
const FONT: Record<string, number[]> = {
    "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 3, 1, 7], "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 2, 2], "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
    A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4], G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7], M: [5, 7, 7, 5, 5],
    N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5], S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5], Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
    ".": [0, 0, 0, 0, 2], "=": [0, 7, 0, 7, 0], "-": [0, 0, 7, 0, 0], ":": [0, 2, 0, 2, 0], "/": [1, 1, 2, 4, 4], "_": [0, 0, 0, 0, 7], "+": [0, 2, 7, 2, 0], "#": [5, 7, 5, 7, 5], "!": [2, 2, 2, 0, 2], ",": [0, 0, 0, 2, 4], "(": [1, 2, 2, 2, 1], ")": [4, 2, 2, 2, 4],
};

function drawText(data: Uint8Array, W: number, x: number, y: number, text: string, rgb: [number, number, number]): void {
    for (let c = 0; c < text.length; c++) {
        const g = FONT[text[c]];
        if (!g) continue;
        for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) {
            if (!((g[row] >> (2 - col)) & 1)) continue;
            const px = x + c * 4 + col, py = y + row;
            const o = (py * W + px) * 4;
            if (o >= 0 && o + 2 < data.length) { data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; }
        }
    }
}
