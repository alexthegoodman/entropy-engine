import { groupWorld, inverse } from "./canvas_animation";
import type { Group, Clip, Matrix, V3, RetainedStroke } from "./canvas_animation";
export interface SavedPaintLayer {
    id: string; name: string; visible: boolean; locked: boolean; opacity: number; pixelsBase64: string; basePixelsBase64?: string;
}
export interface SavedSurface {
    id?: string; parentId?: string | null; frame?: Matrix; scale?: V3; pivot?: V3; strokes?: RetainedStroke[];
    name: string;
    kind: "plane" | "box" | "cylinder" | "sphere";
    position: [number, number, number];
    yaw: number; pitch: number; roll: number;
    halfW: number; halfH: number; halfD: number; radius: number;
    bend: number; bendAxis: "x" | "y";
    visible: boolean;
    canvasBase64?: string; // version 1
    layers?: SavedPaintLayer[]; // version 2
    cutMaskBase64?: string;
    activeLayerId?: string;
}
export interface SavedScene { version: 1 | 2 | 3; surfaces: SavedSurface[]; groups?: Group[]; clips?: Clip[]; }
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PIXELS = 768 * 768;

export function bytesToBase64(bytes: Uint8Array): string {
    const chunks: string[] = [];
    for (let start = 0; start < bytes.length; start += 12288) {
        let out = "";
        for (let i = start; i < Math.min(start + 12288, bytes.length); i += 3) {
            const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
            out += BASE64[a >> 2] + BASE64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
            out += b === undefined ? "=" : BASE64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
            out += c === undefined ? "=" : BASE64[c & 63];
        }
        chunks.push(out);
    }
    return chunks.join("");
}

export function base64ToBytes(value: string): Uint8Array {
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    const out = new Uint8Array(value.length / 4 * 3 - padding);
    for (let i = 0, index = 0; i < value.length; i += 4) {
        const a = BASE64.indexOf(value[i]), b = BASE64.indexOf(value[i + 1]);
        const c = BASE64.indexOf(value[i + 2]), d = BASE64.indexOf(value[i + 3]);
        out[index++] = (a << 2) | (b >> 4);
        if (c >= 0) out[index++] = ((b & 15) << 4) | (c >> 2);
        if (d >= 0) out[index++] = ((c & 3) << 6) | d;
    }
    return out;
}

/** Validate the entire payload before replacing anything in the live scene. */
export function validateScene(value: unknown): SavedScene {
    const scene = value as SavedScene;
    if (!scene || ![1, 2, 3].includes(scene.version) || !Array.isArray(scene.surfaces) || scene.surfaces.length > 128)
        throw new Error("Unsupported or damaged scene file.");
    let totalBytes = 0;
    const image = (value: unknown, bytes: number) => {
        totalBytes += bytes;
        // Avoid a huge repeated regex group on multi-megabyte data (which can exhaust the stack).
        if (typeof value !== "string" || value.length !== Math.ceil(bytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value) ||
            value.includes("=")) throw new Error("Invalid scene image data."); // both image sizes are divisible by 3
    };
    for (const s of scene.surfaces) {
        if (!s || typeof s.name !== "string" || !["plane", "box", "cylinder", "sphere"].includes(s.kind) ||
            !Array.isArray(s.position) || s.position.length !== 3 || !s.position.every(Number.isFinite) ||
            ![s.yaw, s.pitch, s.roll, s.bend].every(Number.isFinite) ||
            ![s.halfW, s.halfH, s.halfD, s.radius].every(n => Number.isFinite(n) && n >= 0.1 && n <= 10000) ||
            !["x", "y"].includes(s.bendAxis) || Math.abs(s.bend) > 1 || typeof s.visible !== "boolean")
            throw new Error("Invalid surface geometry in scene.");
        if (scene.version === 1) image(s.canvasBase64, PIXELS * 4);
        else {
            if (!Array.isArray(s.layers) || s.layers.length < 1 || s.layers.length > 16) throw new Error("Invalid paint layers.");
            const ids = new Set<string>();
            for (const layer of s.layers) {
                if (!layer || typeof layer.id !== "string" || !layer.id || ids.has(layer.id) || typeof layer.name !== "string" ||
                    typeof layer.visible !== "boolean" || typeof layer.locked !== "boolean" ||
                    !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) throw new Error("Invalid paint layer.");
                ids.add(layer.id);
                image(layer.pixelsBase64, PIXELS * 4);
                if (scene.version === 3 && layer.basePixelsBase64 !== undefined) image(layer.basePixelsBase64, PIXELS * 4);
            }
            if (!ids.has(s.activeLayerId ?? "")) throw new Error("Active paint layer is missing.");
            image(s.cutMaskBase64, PIXELS);
        }
    }
    if (scene.version === 3) validateAnimation(scene);
    if (totalBytes > 256 * 1024 * 1024) throw new Error("Scene exceeds the 256 MiB artwork limit.");
    return scene;
}

function validateAnimation(scene: SavedScene): void {
    const fail = (): never => { throw new Error("Invalid scene hierarchy, strokes or animation."); };
    const vector = (v: unknown): v is V3 => Array.isArray(v) && v.length === 3 && v.every(n => Number.isFinite(n) && Math.abs(n) <= 1e6);
    const matrix = (m: unknown): m is Matrix => {
        if (!Array.isArray(m) || m.length !== 16 || !m.every(Number.isFinite) || m[12] !== 0 || m[13] !== 0 || m[14] !== 0 || m[15] !== 1) return false;
        try { inverse(m); return true; } catch { return false; }
    };
    if (!Array.isArray(scene.groups) || scene.groups.length > 128 || !Array.isArray(scene.clips) || scene.clips.length > 128) fail();
    const groups = scene.groups!, clips = scene.clips!;
    const ids = new Set<string>();
    const takeId = (id: unknown) => { if (typeof id !== "string" || !id || id.length > 200 || ids.has(id)) fail(); ids.add(id as string); };
    for (const node of [...groups, ...scene.surfaces]) {
        takeId(node.id);
        if (typeof node.name !== "string" || !vector(node.position) || !vector(node.pivot) || !vector(node.scale) || node.scale.some(n => n < 0.001) || !matrix(node.frame) ||
            !(node.parentId === null || typeof node.parentId === "string")) fail();
        if (groups.includes(node as Group) && !vector((node as Group).rotation)) fail();
    }
    const nodeIds = new Set(ids), strokeIds = new Set<string>();
    for (const node of [...groups, ...scene.surfaces]) groupWorld(groups, node.parentId!);
    for (const group of groups) groupWorld(groups, group.id);
    let stampCount = 0;
    for (const surface of scene.surfaces) {
        if (!Array.isArray(surface.strokes) || surface.strokes.length > 10000) fail();
        for (const st of surface.strokes!) {
            takeId(st.id); strokeIds.add(st.id);
            if (typeof st.name !== "string" || typeof st.visible !== "boolean" || !Number.isFinite(st.progress) || st.progress < 0 || st.progress > 1 ||
                !surface.layers?.some(l => l.id === st.layerId && l.basePixelsBase64 !== undefined) || !st.brush || !vector(st.brush.color) || st.brush.color.some(n => n < 0 || n > 255) ||
                !Number.isFinite(st.brush.softness) || st.brush.softness < 0 || st.brush.softness > 1 || typeof st.brush.isEraser !== "boolean" || !Array.isArray(st.stamps) || !st.stamps.length) fail();
            stampCount += st.stamps.length;
            if (stampCount > 1000000) fail();
            for (const p of st.stamps) if (![p.x, p.y, p.radius, p.alpha, p.angle, p.elongation].every(Number.isFinite) ||
                p.x < -1 || p.x > 769 || p.y < -1 || p.y > 769 || p.radius <= 0 || p.radius > 2048 || p.alpha < 0 || p.alpha > 1 || p.elongation < 0 || p.elongation > 1) fail();
        }
    }
    const names = new Set<string>();
    for (const clip of clips) {
        takeId(clip.id);
        if (typeof clip.name !== "string" || !clip.name.trim() || names.has(clip.name) || !Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 3600 || !Array.isArray(clip.tracks) || clip.tracks.length > 10000) fail();
        names.add(clip.name);
        const tracks = new Set<string>();
        for (const track of clip.tracks) {
            const signature = `${track.targetId}:${track.channel}`;
            const channels = strokeIds.has(track.targetId) ? ["progress", "visible"] : nodeIds.has(track.targetId) ? ["x", "y", "z", "pitch", "yaw", "roll", "sx", "sy", "sz"] : [];
            if (!channels.includes(track.channel) || tracks.has(signature) || !Array.isArray(track.keys) || !track.keys.length || track.keys.length > 10000) fail();
            tracks.add(signature);
            let previous = -1;
            for (const key of track.keys) {
                if (!Number.isFinite(key.time) || key.time <= previous || key.time < 0 || key.time > clip.duration || !Number.isFinite(key.value) ||
                    (track.channel.startsWith("s") && key.value < 0.001) || (["visible", "progress"].includes(track.channel) && (key.value < 0 || key.value > 1))) fail();
                previous = key.time;
            }
        }
    }
}
