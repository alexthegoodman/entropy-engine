// Procedural pixel sprites. Entropy.Texture.load requires ctx.project_id (Studio's project/
// asset-folder convention - src/deno/addon_ops.rs's op_texture_load) and errors under a bare
// EntropyApp with no project loaded. Entropy.Texture.create has no such requirement - it just
// needs GPU resources - so generating sprites as raw RGBA here keeps this whole example
// self-contained with no external asset file for a reader to supply.

export function createCircleTexture(size: number, color: [number, number, number, number]): string {
    const data = new Uint8Array(size * size * 4);
    const radius = size / 2 - 1;
    const cx = size / 2;
    const cy = size / 2;
    const [r, g, b, a] = color;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - cx + 0.5;
            const dy = y - cy + 0.5;
            const i = (y * size + x) * 4;
            if (Math.sqrt(dx * dx + dy * dy) <= radius) {
                data[i] = Math.round(r * 255);
                data[i + 1] = Math.round(g * 255);
                data[i + 2] = Math.round(b * 255);
                data[i + 3] = Math.round(a * 255);
            } else {
                data[i + 3] = 0;
            }
        }
    }

    return Entropy.Texture.create(size, size, data);
}

export function createSolidTexture(color: [number, number, number, number]): string {
    const data = new Uint8Array([
        Math.round(color[0] * 255),
        Math.round(color[1] * 255),
        Math.round(color[2] * 255),
        Math.round(color[3] * 255),
    ]);
    return Entropy.Texture.create(1, 1, data);
}
