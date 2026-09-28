// Seeded randomness for Mesha. Everything a procedural object draws from goes through these, so the
// same parameters and seed always produce the same geometry (variation, presets and fuzz reports
// depend on that).

/** mulberry32: a small, fast, well-distributed 32-bit generator. Returns floats in [0, 1). */
export function rng(seed: number): () => number {
    let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** A stable float in [0, 1) for (seed, a, b): per-instance randomness without keeping a generator around. */
export function hash01(seed: number, a = 0, b = 0): number {
    let h = Math.imul((seed | 0) ^ 0x27d4eb2d, 0x165667b1);
    h = Math.imul(h ^ Math.imul(a | 0, 0x85ebca6b), 0xc2b2ae35);
    h = Math.imul(h ^ Math.imul(b | 0, 0x27d4eb2f), 0x165667b1);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

/** Standard normal via Box-Muller. */
export function gaussian(random: () => number): number {
    const u = Math.max(random(), 1e-12), v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const GRAD3: number[][] = [
    [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
    [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

const permutations = new Map<number, Uint8Array>();
function permutation(seed: number): Uint8Array {
    let p = permutations.get(seed);
    if (p) return p;
    const r = rng(seed * 7919 + 17);
    const base = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [base[i], base[j]] = [base[j], base[i]]; }
    p = new Uint8Array(512);
    for (let i = 0; i < 512; i++) p[i] = base[i & 255];
    if (permutations.size > 64) permutations.clear();
    permutations.set(seed, p);
    return p;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Classic gradient (Perlin) noise, roughly in [-1, 1]. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
    const p = permutation(seed);
    const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
    x -= X; y -= Y; z -= Z;
    const xi = X & 255, yi = Y & 255, zi = Z & 255;
    const u = fade(x), v = fade(y), w = fade(z);
    const g = (h: number, dx: number, dy: number, dz: number) => { const G = GRAD3[h % 12]; return G[0] * dx + G[1] * dy + G[2] * dz; };
    const aa = p[p[p[xi] + yi] + zi], ab = p[p[p[xi] + yi + 1] + zi], ba = p[p[p[xi + 1] + yi] + zi], bb = p[p[p[xi + 1] + yi + 1] + zi];
    const aa1 = p[p[p[xi] + yi] + zi + 1], ab1 = p[p[p[xi] + yi + 1] + zi + 1], ba1 = p[p[p[xi + 1] + yi] + zi + 1], bb1 = p[p[p[xi + 1] + yi + 1] + zi + 1];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
        l(l(g(aa, x, y, z), g(ba, x - 1, y, z), u), l(g(ab, x, y - 1, z), g(bb, x - 1, y - 1, z), u), v),
        l(l(g(aa1, x, y, z - 1), g(ba1, x - 1, y, z - 1), u), l(g(ab1, x, y - 1, z - 1), g(bb1, x - 1, y - 1, z - 1), u), v),
        w,
    );
}

/** Fractal sum of `octaves` noise layers, each twice the frequency and `gain` the amplitude. */
export function fbm3(x: number, y: number, z: number, seed = 0, octaves = 4, gain = 0.5, lacunarity = 2): number {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum += amp * noise3(x * freq, y * freq, z * freq, seed + o * 131);
        norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / (norm || 1);
}
