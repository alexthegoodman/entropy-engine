// One static, periodic 3D cloud-noise field stored as padded slices in a filterable 2D atlas.
// Weather thresholds and wind offsets stay live. No rebaking for movement, travel or rebasing.
import type { BindingConfig, BindingEntry } from "../../addon";
import { CLOUD_PERIOD, QUADPLANET_SHADER } from "../../apps/quadplanet/qp_shader";

export const CLOUD_CACHE_SIZE = 64;
export const CLOUD_CACHE_TILE = CLOUD_CACHE_SIZE + 2;
export const CLOUD_CACHE_COLUMNS = 8;
export const CLOUD_CACHE_WIDTH = CLOUD_CACHE_TILE * CLOUD_CACHE_COLUMNS;
export const CLOUD_CACHE_HEIGHT = CLOUD_CACHE_TILE * CLOUD_CACHE_SIZE / CLOUD_CACHE_COLUMNS;
export const CLOUD_CACHE_BYTES = CLOUD_CACHE_WIDTH * CLOUD_CACHE_HEIGHT * 8; // RGBA16F

export const CLOUD_BIND_ENTRIES: BindingEntry[] = [
    { binding: 7, visibility: ["Fragment"], resourceType: "Texture" },
    { binding: 8, visibility: ["Fragment"], resourceType: "Sampler" },
];
export function cloudBindings(texture: string): BindingConfig[] {
    return [
        { group: 2, binding: 7, resource: { type: "Texture", value: { id: texture } } },
        // Atlas wrapping is explicit; anisotropic/repeat sampling can cross slice boundaries.
        { group: 2, binding: 8, resource: { type: "Sampler" } },
    ];
}

// Use the exact lattice hash and value-noise implementation of the reference cloud shader.
const noise = QUADPLANET_SHADER.slice(QUADPLANET_SHADER.indexOf("fn lattice("), QUADPLANET_SHADER.indexOf("// How much of an octave"));
export const CLOUD_BAKE_SHADER = /* wgsl */ `
@group(0) @binding(0) var atlas: texture_storage_2d<rgba16float, write>;
${noise}
fn field(p: vec3<f32>) -> vec2<f32> {
    var sum = 0.0;
    var amp = 0.5;
    var freq = 1.0 / 4096.0;
    var coarse = 0.0;
    for (var o = 0; o < 6; o++) {
        sum += vnoise(p * freq + vec3<f32>(f32(o) * 5.0, f32(o) * 13.0, f32(o) * 3.0), ${CLOUD_PERIOD}.0 * freq).x * amp;
        if (o == 2) { coarse = sum; }
        amp *= 0.5;
        freq *= 2.0;
    }
    return vec2<f32>(coarse, sum);
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= ${CLOUD_CACHE_WIDTH}u || id.y >= ${CLOUD_CACHE_HEIGHT}u) { return; }
    let tile = id.xy / ${CLOUD_CACHE_TILE}u;
    // One wrapped border texel on each side makes XY filtering seam-free.
    let xy = (id.xy % ${CLOUD_CACHE_TILE}u + ${CLOUD_CACHE_SIZE - 1}u) % ${CLOUD_CACHE_SIZE}u;
    let z = tile.y * ${CLOUD_CACHE_COLUMNS}u + tile.x;
    let p = vec3<f32>(vec2<f32>(xy), f32(z)) * ${CLOUD_PERIOD / CLOUD_CACHE_SIZE}.0;
    let a = field(p);
    let b = field(vec3<f32>(p.xy, f32((z + 1u) % ${CLOUD_CACHE_SIZE}u) * ${CLOUD_PERIOD / CLOUD_CACHE_SIZE}.0));
    // RG = coarse/fine at Z; BA = coarse/fine at Z+1. A single XY-filtered fetch
    // supplies both Z planes for trilinear interpolation, including the periodic seam.
    textureStore(atlas, vec2<i32>(id.xy), vec4<f32>(a, b));
}
`;

export function createCloudCache(): string {
    const texture = Entropy.Texture.createStorage(CLOUD_CACHE_WIDTH, CLOUD_CACHE_HEIGHT, "Rgba16Float");
    const pipeline = Entropy.Pipeline.createCompute({ name: "Allegiance cloud cache", shaderSource: CLOUD_BAKE_SHADER,
        bindGroups: [{ entries: [{ binding: 0, visibility: ["Compute"], resourceType: "StorageTextureRgba16" }] }] });
    Entropy.Compute.dispatch({ pipelineId: pipeline, groups: [CLOUD_CACHE_WIDTH / 8, CLOUD_CACHE_HEIGHT / 8, 1],
        bindings: [{ group: 0, binding: 0, resource: { type: "StorageTextureRgba16", value: { id: texture } } }] });
    return texture;
}

export const CLOUD_CACHE_WGSL = /* wgsl */ `
@group(2) @binding(7) var cloud_atlas: texture_2d<f32>;
@group(2) @binding(8) var cloud_sampler: sampler;
fn cloud_slice(p: vec2<f32>, z: f32) -> vec4<f32> {
    let tile = vec2<f32>(z - floor(z / ${CLOUD_CACHE_COLUMNS}.0) * ${CLOUD_CACHE_COLUMNS}.0, floor(z / ${CLOUD_CACHE_COLUMNS}.0));
    let uv = (tile * ${CLOUD_CACHE_TILE}.0 + p + vec2<f32>(1.5)) / vec2<f32>(${CLOUD_CACHE_WIDTH}.0, ${CLOUD_CACHE_HEIGHT}.0);
    return textureSampleLevel(cloud_atlas, cloud_sampler, uv, 0.0);
}
fn cloud_density(p: vec3<f32>, octaves: i32) -> f32 {
    if (world.cloud.w <= 0.0) { return 0.0; }
    if (world.city.w < 0.5) { return cloud_density_procedural(p, octaves); }
    let q = fract((p + world.cloud.xyz) / ${CLOUD_PERIOD}.0) * ${CLOUD_CACHE_SIZE}.0;
    let z = floor(q.z);
    let planes = cloud_slice(q.xy, z);
    let raw = mix(planes.rg, planes.ba, fract(q.z));
    // Sky density and its light probe share the fine field; ground shadows use the coarse field.
    let sum = select(raw.x, raw.y, octaves >= 4);
    return smoothstep(1.0 - world.cloud.w * 1.15, 1.25 - world.cloud.w * 0.9, sum + 0.5);
}
`;
