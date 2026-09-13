// A textured, alpha-tested quad ("sprite"). Follows the same custom-pipeline convention the
// Media Player addon proved for its video quad (pbr:false, layout:"mesh" so extraBindGroups
// start at group(2) - see examples/studio-bundle/src/media_player_addon.ts): vertex positions
// are baked directly into world space at creation time rather than driven through the mesh's
// group(1) transform uniform, because Entropy.Model.createMesh has no way to update that
// transform after creation for a plain (non-NPC) mesh.
//
// Movement instead goes through Entropy.Mesh.updateVertices, which rewrites the quad's 4 corner
// positions every frame - this only works because of an engine-side fix made alongside this
// module: `Mesh.updateVertices` was already declared in addon.d.ts and wired to a real op
// (op_mesh_update_vertices), but the op only ever pushed onto
// `AddonContext.pending_mesh_updates` - nothing drained that queue, so calling it silently did
// nothing. See src/deno/addon_engine.rs's new drain loop (right before the `pending_ui_clear`
// block) for the fix.

// Camera struct/binding matches every other custom "mesh" pipeline in this repo (see
// media_player_addon.ts's VIDEO_QUAD_SHADER) - group(0) binding(0), populated from whichever
// projection (perspective or, since this addon turns it on, orthographic) is active.
const SPRITE_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

@group(2) @binding(0)
var sprite_texture: texture_2d<f32>;
@group(2) @binding(1)
var sprite_sampler: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coords: vec2<f32>,
    @location(1) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.tex_coords = in.tex_coords;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let sampled = textureSample(sprite_texture, sprite_sampler, in.tex_coords);
    // Hard alpha cutoff rather than relying on blend order - draw order between sprites is
    // whatever order they were created in, not back-to-front, so soft edges would show seams
    // where a later-drawn sprite blends under an earlier one. A depth test still layers whole
    // sprites correctly by world z (see Sprite's z param); this just keeps each sprite's own
    // edge (e.g. the circle textures in textures.ts) clean regardless of draw order.
    if (sampled.a < 0.5) {
        discard;
    }
    return vec4<f32>(sampled.rgb * in.color.rgb, sampled.a * in.color.a);
}
`;

export function createSpritePipeline(name: string): string {
    return Entropy.Pipeline.create({
        name,
        layout: "mesh", // base groups = [camera(0), model transform(1)] - required so the
                         // texture/sampler extraBindGroups land at group(2), not group(1).
        pbr: false,
        vertexShader: SPRITE_SHADER,
        fragmentShader: SPRITE_SHADER,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Fragment"], resourceType: "Sampler" },
                ]
            }
        ]
    });
}

// Local-space corner offsets (unit square) and their UVs, and the matching triangle winding.
// Winding/UV mapping copied from buildQuad() in media_player_addon.ts, which documents why it's
// reversed from the "obvious" [0,1,2,0,2,3]: the default addon pipeline backface-culls with
// FrontFace::Ccw, and this winding is clockwise as seen from a camera sitting on +Z looking
// toward -Z (true for every sprite here - the 2D camera always looks down -Z).
const CORNERS: Array<[number, number, number, number]> = [
    [-1, 1, 0, 0],  // top-left
    [1, 1, 1, 0],   // top-right
    [1, -1, 1, 1],  // bottom-right
    [-1, -1, 0, 1], // bottom-left
];
const QUAD_INDICES = [0, 2, 1, 0, 3, 2];

export interface SpriteInit {
    textureId: string;
    pipelineId: string;
    x: number;
    y: number;
    z?: number;
    halfW: number;
    halfH: number;
    rotation?: number;
    tint?: [number, number, number, number];
}

export class Sprite {
    readonly id: string;
    x: number;
    y: number;
    z: number;
    halfW: number;
    halfH: number;
    rotation: number;
    tint: [number, number, number, number];
    alive = true;
    private textureId: string;
    private pipelineId: string;

    constructor(init: SpriteInit) {
        this.id = `sprite_${Entropy.generateUUID()}`;
        this.x = init.x;
        this.y = init.y;
        this.z = init.z ?? 0;
        this.halfW = init.halfW;
        this.halfH = init.halfH;
        this.rotation = init.rotation ?? 0;
        this.tint = init.tint ?? [1, 1, 1, 1];
        this.textureId = init.textureId;
        this.pipelineId = init.pipelineId;
        this.createMesh();
    }

    private createMesh(): void {
        const vertices: number[] = [];
        for (const [lx, ly, u, v] of CORNERS) {
            const [wx, wy] = this.worldCorner(lx, ly);
            vertices.push(wx, wy, this.z, 0, 0, 1, u, v, this.tint[0], this.tint[1], this.tint[2], this.tint[3]);
        }

        Entropy.Model.createMesh({
            id: this.id,
            position: [0, 0, 0],
            vertexData: vertices,
            indexData: QUAD_INDICES,
            pipelineId: this.pipelineId,
            bindings: [
                { group: 2, binding: 0, resource: { type: "Texture", value: { id: this.textureId } } },
                { group: 2, binding: 1, resource: { type: "Sampler" } },
            ],
        });
    }

    private worldCorner(lx: number, ly: number): [number, number] {
        const cos = Math.cos(this.rotation);
        const sin = Math.sin(this.rotation);
        const ox = lx * this.halfW;
        const oy = ly * this.halfH;
        return [this.x + (ox * cos - oy * sin), this.y + (ox * sin + oy * cos)];
    }

    // Pushes the current x/y/z/rotation to the GPU. Every mutator below calls this, but if
    // several fields change in the same frame prefer setting the fields directly and calling
    // sync() once.
    sync(): void {
        if (!this.alive) return;
        const positions: number[] = [];
        for (const [lx, ly] of CORNERS) {
            const [wx, wy] = this.worldCorner(lx, ly);
            positions.push(wx, wy, this.z);
        }
        Entropy.Mesh.updateVertices(this.id, [0, 1, 2, 3], positions);
    }

    setPosition(x: number, y: number): void {
        this.x = x;
        this.y = y;
        this.sync();
    }

    setRotation(rotation: number): void {
        this.rotation = rotation;
        this.sync();
    }

    // Resizing is just a change to the corner offsets sync() already recomputes every frame -
    // no mesh recreation needed, unlike color/texture (see retint/setTexture below).
    resize(halfW: number, halfH: number): void {
        this.halfW = halfW;
        this.halfH = halfH;
        this.sync();
    }

    // Vertex color is baked in at mesh-creation time (see createMesh) - Entropy.Mesh.
    // updateVertices only rewrites position floats, not the full 12-float vertex, so changing
    // tint means destroying and recreating the mesh (same id, so callers holding this Sprite
    // don't need to know). Cheap enough for event-driven color changes (a handful of times per
    // session, not per frame) - see the level editor's SetColor logic node.
    retint(tint: [number, number, number, number]): void {
        this.tint = tint;
        Entropy.Model.clearMesh(this.id);
        this.createMesh();
    }

    // Same recreate-in-place reasoning as retint - swaps which texture (e.g. rect vs. circle
    // shape mask) this sprite samples.
    setTexture(textureId: string): void {
        this.textureId = textureId;
        Entropy.Model.clearMesh(this.id);
        this.createMesh();
    }

    destroy(): void {
        if (!this.alive) return;
        this.alive = false;
        Entropy.Model.clearMesh(this.id);
    }
}
