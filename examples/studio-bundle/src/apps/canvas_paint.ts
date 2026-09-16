export type RGB = [number, number, number];
export interface PaintLayer {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    opacity: number;
    pixels: Uint8Array;
}

export interface PaintSettings {
    color: RGB;
    opacity: number;
    pressureMin: number;
    pressureMax: number;
    sizeCurve: number;
    opacityCurve: number;
    pressureSize: boolean;
    pressureOpacity: boolean;
    stabilization: number;
}

export const DEFAULT_PAINT_SETTINGS: PaintSettings = {
    color: [18, 20, 32], opacity: 1,
    pressureMin: 0, pressureMax: 1, sizeCurve: 1, opacityCurve: 1,
    pressureSize: true, pressureOpacity: true, stabilization: 0,
};

export function pressureResponse(raw: number, settings: PaintSettings, channel: "size" | "opacity"): number {
    if (channel === "size" ? !settings.pressureSize : !settings.pressureOpacity) return 1;
    const normalized = Math.max(0, Math.min(1,
        (raw - settings.pressureMin) / Math.max(0.05, settings.pressureMax - settings.pressureMin)));
    return Math.pow(normalized, channel === "size" ? settings.sizeCurve : settings.opacityCurve);
}

/** A distance-based trailing pen, independent of event rate. Zero lag is an exact passthrough. */
export function stabilizePoint(previous: { px: number; py: number }, raw: { px: number; py: number }, lag: number): { px: number; py: number } {
    const dx = raw.px - previous.px, dy = raw.py - previous.py;
    const distance = Math.hypot(dx, dy);
    if (lag <= 0) return { px: raw.px, py: raw.py };
    if (distance <= lag) return { px: previous.px, py: previous.py };
    return { px: raw.px - dx * lag / distance, py: raw.py - dy * lag / distance };
}

/** Straight-alpha source-over painting; erasing removes coverage instead of painting paper. */
export function blendPixel(pixels: Uint8Array, i: number, color: RGB, amount: number, erase: boolean): void {
    const oldAlpha = pixels[i + 3] / 255;
    if (erase) {
        pixels[i + 3] = Math.round(oldAlpha * (1 - amount) * 255);
        if (pixels[i + 3] === 0) pixels.fill(0, i, i + 4);
        return;
    }
    const alpha = amount + oldAlpha * (1 - amount);
    if (alpha <= 0) return;
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round((color[c] * amount + pixels[i + c] * oldAlpha * (1 - amount)) / alpha);
    pixels[i + 3] = Math.round(alpha * 255);
}

export function compositePixel(canvas: Uint8Array, layers: PaintLayer[], mask: Uint8Array, background: RGB, i: number): void {
    let r = background[0], g = background[1], b = background[2];
    for (const layer of layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        const alpha = layer.pixels[i + 3] / 255 * layer.opacity;
        r += (layer.pixels[i] - r) * alpha;
        g += (layer.pixels[i + 1] - g) * alpha;
        b += (layer.pixels[i + 2] - b) * alpha;
    }
    canvas[i] = Math.round(r); canvas[i + 1] = Math.round(g); canvas[i + 2] = Math.round(b);
    canvas[i + 3] = mask[i / 4];
}

export function compositeLayers(canvas: Uint8Array, layers: PaintLayer[], mask: Uint8Array, background: RGB): void {
    for (let i = 0; i < canvas.length; i += 4) compositePixel(canvas, layers, mask, background, i);
}
