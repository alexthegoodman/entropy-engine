// Builds src/heightfield_landscapes/QuadPlanet/terrarium_z0.png, the whole-world elevation tile
// compiled into the engine (Earth's continents with no network). The published zoom-0 Terrarium
// tile carries bedrock under Greenland and Antarctica (their ice sheets would draw near or below
// sea level); zoom 1 has the ice surface. So: fetch the four zoom-1 tiles and average each 2x2
// block into one zoom-0 pixel (Web Mercator pixels nest exactly). Run: node scripts/quadplanet_base_tile.mjs
import { inflateSync, deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const TILE = 256;

function decodePng(buf) {
    let p = 8;
    const idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString("ascii", p + 4, p + 8);
        if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
        p += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const stride = TILE * 3;
    const out = Buffer.alloc(TILE * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < TILE; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = Buffer.alloc(stride);
        for (let i = 0; i < stride; i++) {
            const a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
            let v = line[i];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            cur[i] = v & 255;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return (x, y) => { const i = y * stride + x * 3; return out[i] * 256 + out[i + 1] + out[i + 2] / 256 - 32768; };
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

const tiles = {};
for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const res = await fetch(TILE_URL.replace("{z}", "1").replace("{x}", x).replace("{y}", y));
    if (!res.ok) throw new Error(`tile 1/${x}/${y}: ${res.status}`);
    tiles[`${x},${y}`] = decodePng(Buffer.from(await res.arrayBuffer()));
}
const raw = Buffer.alloc(TILE * (TILE * 3 + 1));
for (let y = 0; y < TILE; y++) {
    raw[y * (TILE * 3 + 1)] = 0;
    for (let x = 0; x < TILE; x++) {
        let sum = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
            const gx = x * 2 + i, gy = y * 2 + j;
            sum += tiles[`${gx >> 8},${gy >> 8}`](gx & 255, gy & 255);
        }
        const v = sum / 4 + 32768;
        const o = y * (TILE * 3 + 1) + 1 + x * 3;
        raw[o] = Math.floor(v / 256);
        raw[o + 1] = Math.floor(v) % 256;
        raw[o + 2] = Math.floor((v - Math.floor(v)) * 256);
    }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(TILE, 0); ihdr.writeUInt32BE(TILE, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
const out = new URL("../src/heightfield_landscapes/QuadPlanet/terrarium_z0.png", import.meta.url);
writeFileSync(out, png);
console.log(`wrote ${out.pathname} (${png.length} bytes)`);
