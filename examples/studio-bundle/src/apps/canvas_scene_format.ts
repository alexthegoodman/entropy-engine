export interface SavedPaintLayer {
    id: string; name: string; visible: boolean; locked: boolean; opacity: number; pixelsBase64: string;
}
export interface SavedSurface {
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
export interface SavedScene { version: 1 | 2; surfaces: SavedSurface[]; }
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
    if (!scene || ![1, 2].includes(scene.version) || !Array.isArray(scene.surfaces) || scene.surfaces.length > 128)
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
            }
            if (!ids.has(s.activeLayerId ?? "")) throw new Error("Active paint layer is missing.");
            image(s.cutMaskBase64, PIXELS);
        }
    }
    if (totalBytes > 256 * 1024 * 1024) throw new Error("Scene exceeds the 256 MiB artwork limit.");
    return scene;
}
