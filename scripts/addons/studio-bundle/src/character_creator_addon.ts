import { ComponentAddon } from "./system";

// ============================================================================
// CORE TYPES & MATH
// ============================================================================

type Vec3 = [number, number, number];
type Quat = [number, number, number, number]; // [x, y, z, w]
type Mat4 = number[]; // 16 elements

function mat4_identity(): Mat4 {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ];
}

function mat4_multiply(a: Mat4, b: Mat4): Mat4 {
    const out = new Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[i * 4 + k] * b[k * 4 + j];
            }
            out[i * 4 + j] = sum;
        }
    }
    return out;
}

function mat4_from_rotation_translation_scale(q: Quat, t: Vec3, s: Vec3): Mat4 {
    const x = q[0], y = q[1], z = q[2], w = q[3];
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const sx = s[0], sy = s[1], sz = s[2];

    return [
        (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
        (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
        (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
        t[0], t[1], t[2], 1
    ];
}

function mat4_inverse(m: Mat4): Mat4 {
    const n = new Array(16);
    // Simplified inverse for TRS matrices (not general, but enough for bones)
    // Actually let's just use a simple one for now or a placeholder
    // In a real implementation we'd use a robust matrix inverse
    return m; // Placeholder: InverseBind should be precalculated
}

// ============================================================================
// PROCEDURAL HUMAN BODY GENERATOR
// ============================================================================

class Bone {
    public localTransform: Mat4 = mat4_identity();
    public worldTransform: Mat4 = mat4_identity();
    public children: Bone[] = [];
    public inverseBindMatrix: Mat4 = mat4_identity();

    constructor(public name: string, public id: number) {}

    updateWorldTransform(parentWorld: Mat4) {
        this.worldTransform = mat4_multiply(parentWorld, this.localTransform);
        for (const child of this.children) {
            child.updateWorldTransform(this.worldTransform);
        }
    }
}

interface SkinnedVertex {
    pos: Vec3;
    normal: Vec3;
    uv: [number, number];
    color: [number, number, number, number];
    joints: [number, number, number, number];
    weights: [number, number, number, number];
}

class ProceduralHumanoid {
    vertices: number[] = []; // Layout: 3 pos, 3 norm, 2 uv, 4 color, 4 jointIndex(u16), 4 weights(f32)
    indices: number[] = [];
    bones: Bone[] = [];
    rootBone: Bone;

    constructor() {
        // 1. Build Skeleton
        this.rootBone = new Bone("Hips", 0);
        const spine = new Bone("Spine", 1);
        const neck = new Bone("Neck", 2);
        const head = new Bone("Head", 3);
        const armL = new Bone("UpperArm_L", 4);
        const armR = new Bone("UpperArm_R", 5);
        const legL = new Bone("UpperLeg_L", 6);
        const legR = new Bone("UpperLeg_R", 7);

        this.rootBone.children.push(spine, legL, legR);
        spine.children.push(neck, armL, armR);
        neck.children.push(head);

        this.bones = [this.rootBone, spine, neck, head, armL, armR, legL, legR];

        // 2. Pre-set bone offsets (initial pose)
        this.resetPose();
    }

    resetPose() {
        this.rootBone.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0, 1, 0], [1,1,1]);
        this.getBone("Spine")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0, 0.4, 0], [1,1,1]);
        this.getBone("Neck")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0, 0.3, 0], [1,1,1]);
        this.getBone("Head")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0, 0.1, 0], [1,1,1]);
        this.getBone("UpperArm_L")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [-0.3, 0.2, 0], [1,1,1]);
        this.getBone("UpperArm_R")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0.3, 0.2, 0], [1,1,1]);
        this.getBone("UpperLeg_L")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [-0.15, -0.1, 0], [1,1,1]);
        this.getBone("UpperLeg_R")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0.15, -0.1, 0], [1,1,1]);
        
        this.rootBone.updateWorldTransform(mat4_identity());
        
        // Precalculate inverse binds
        for (const b of this.bones) {
            b.inverseBindMatrix = mat4_inverse(b.worldTransform);
        }
    }

    getBone(name: string) { return this.bones.find(b => b.name === name); }

    generateMesh() {
        this.vertices = [];
        this.indices = [];

        // Add body parts as boxes weighted to bones
        this.addBox([0.4, 0.4, 0.3], [0, 0, 0], 0, [0.9, 0.7, 0.6, 1]); // Hips
        this.addBox([0.5, 0.5, 0.3], [0, 0.4, 0], 1, [0.2, 0.4, 0.8, 1]); // Torso (Spine)
        this.addBox([0.25, 0.25, 0.25], [0, 0.1, 0], 3, [0.9, 0.7, 0.6, 1]); // Head
        this.addBox([0.15, 0.4, 0.15], [-0.3, 0, 0], 4, [0.9, 0.7, 0.6, 1]); // Arm L
        this.addBox([0.15, 0.4, 0.15], [0.3, 0, 0], 5, [0.9, 0.7, 0.6, 1]); // Arm R
        this.addBox([0.2, 0.5, 0.2], [-0.15, -0.3, 0], 6, [0.3, 0.3, 0.3, 1]); // Leg L
        this.addBox([0.2, 0.5, 0.2], [0.15, -0.3, 0], 7, [0.3, 0.3, 0.3, 1]); // Leg R
    }

    private addBox(size: Vec3, offset: Vec3, boneIdx: number, color: [number, number, number, number]) {
        const hx = size[0]/2, hy = size[1]/2, hz = size[2]/2;
        const startIdx = this.vertices.length / (3+3+2+4+2+4); // position(3), normal(3), uv(2), color(4), joints(2 u16 packed?), weights(4)
        // Note: ModelVertex stride is complex. 
        // position: Float32x3 (12 bytes)
        // normal: Float32x3 (12 bytes)
        // uv: Float32x2 (8 bytes)
        // color: Float32x4 (16 bytes)
        // joints: Uint16x4 (8 bytes)
        // weights: Float32x4 (16 bytes)
        // Total: 72 bytes. 
        // In JS we'll push them all as floats, but joints need to be bit-packed u16s into floats or handled carefully.
        // Actually, we can just push u32s for joint indices and let the engine interpret. 
        // But the layout says Uint16x4. 
        
        // Helper to push a vertex
        const pushV = (px: number, py: number, pz: number, nx: number, ny: number, nz: number) => {
            // Pos
            this.vertices.push(px + offset[0], py + offset[1], pz + offset[2]);
            // Normal
            this.vertices.push(nx, ny, nz);
            // UV
            this.vertices.push(0, 0);
            // Color
            this.vertices.push(...color);
            // Joint Indices (Uint16x4 -> packed into 2 floats or handled by the op)
            // The op_mesh_create takes Vec<f32>. We need to pack two u16 into one f32.
            const j1 = boneIdx;
            const j2 = 0; // only 1 bone influence for now
            const packedJoints = (j1 & 0xFFFF) | ((j2 & 0xFFFF) << 16);
            // We'll push them as two 32-bit floats but they will be interpreted as 4 u16s
            const view = new DataView(new ArrayBuffer(8));
            view.setUint16(0, boneIdx, true);
            view.setUint16(2, 0, true);
            view.setUint16(4, 0, true);
            view.setUint16(6, 0, true);
            this.vertices.push(view.getFloat32(0, true));
            this.vertices.push(view.getFloat32(4, true));
            // Weights
            this.vertices.push(1.0, 0.0, 0.0, 0.0);
        };

        // Front
        pushV(-hx, -hy,  hz, 0, 0, 1); pushV( hx, -hy,  hz, 0, 0, 1); pushV( hx,  hy,  hz, 0, 0, 1); pushV(-hx,  hy,  hz, 0, 0, 1);
        // Back
        pushV(-hx, -hy, -hz, 0, 0, -1); pushV(-hx,  hy, -hz, 0, 0, -1); pushV( hx,  hy, -hz, 0, 0, -1); pushV( hx, -hy, -hz, 0, 0, -1);
        
        const base = startIdx * 24 / 24; // Just a placeholder for index logic
        const s = Math.floor(this.vertices.length / 18) - 8; // 18 floats per vertex
        
        // Simple cube indices
        for (let f = 0; f < 6; f++) {
            const b = s + f * 4;
            this.indices.push(b, b+1, b+2, b, b+2, b+3);
        }
    }

    getJointMatrices(): number[] {
        const out: number[] = [];
        for (let i = 0; i < 256; i++) {
            const bone = this.bones[i];
            const mat = bone ? mat4_multiply(bone.worldTransform, bone.inverseBindMatrix) : mat4_identity();
            out.push(...mat);
        }
        return out;
    }
}

// ============================================================================
// CHARACTER CREATOR ADDON
// ============================================================================

const SKINNED_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view: mat4x4<f32>,
    proj: mat4x4<f32>,
};
@group(0) @binding(0) var<uniform> camera: Camera;

struct MeshUniforms {
    model_matrix: mat4x4<f32>,
    normal_matrix: mat4x4<f32>,
};
@group(1) @binding(0) var<uniform> mesh: MeshUniforms;

struct SkinUniforms {
    joints: array<mat4x4<f32>, 256>,
};
@group(2) @binding(0) var<uniform> skin: SkinUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>,
    @location(4) joint_indices: vec4<u32>,
    @location(5) joint_weights: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) world_pos: vec3<f32>,
    @location(2) normal: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var skin_matrix = mat4x4<f32>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    
    // Weight blending
    for (var i = 0u; i < 4u; i = i + 1u) {
        let joint_index = in.joint_indices[i];
        let joint_weight = in.joint_weights[i];
        skin_matrix = skin_matrix + joint_weight * skin.joints[joint_index];
    }

    let world_pos = mesh.model_matrix * skin_matrix * vec4<f32>(in.position, 1.0);
    
    var out: VertexOutput;
    out.clip_position = camera.view_proj * world_pos;
    out.world_pos = world_pos.xyz;
    out.normal = (mesh.model_matrix * skin_matrix * vec4<f32>(in.normal, 0.0)).xyz;
    out.color = in.color;
    return out;
}

struct GbufferOutput {
    @location(0) pos: vec4<f32>,
    @location(1) norm: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) mat: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    var out: GbufferOutput;
    out.pos = vec4<f32>(in.world_pos, 1.0);
    out.norm = vec4<f32>(normalize(in.normal), 1.0);
    out.albedo = in.color;
    out.mat = vec4<f32>(0.5, 0.0, 1.0, 1.0); // Roughness, Metallic, AO
    return out;
}
`;

interface CharacterParams {
    bodyScale: number;
    headScale: number;
    torsoWidth: number;
    activeAnimation: "Idle" | "Walk" | "Wave";
}

export class CharacterCreator extends ComponentAddon<CharacterParams> {
    protected defaultParams: CharacterParams = {
        bodyScale: 1.0,
        headScale: 1.0,
        torsoWidth: 1.0,
        activeAnimation: "Idle"
    };

    private pipelineId: string | null = null;
    private meshId: string | null = null;
    private humanoid: ProceduralHumanoid;
    private jointBufferId: string | null = null;

    constructor() {
        super({
            name: "Character Creator",
            version: "2.0.0",
            description: "Procedural skinned humanoid character",
            author: ["Entropy Team"],
            capabilities: { graphics: true, ui: true }
        });
        this.humanoid = new ProceduralHumanoid();
    }

    protected setup(): void {
        this.initComponentState("Procedural Hero");
        
        // 1. Create Skinned Pipeline
        this.pipelineId = Entropy.Pipeline.create({
            name: "Procedural_Skinned_Pipeline",
            layout: "skinned",
            vertexShader: SKINNED_SHADER,
            fragmentShader: SKINNED_SHADER,
            extraBindGroups: [
                { entries: [{ binding: 0, visibility: ["Vertex"], resourceType: "Uniform" }] }
            ]
        });

        // 2. Create Joint Buffer (256 mat4x4 = 256 * 64 bytes = 16384)
        this.jointBufferId = this.api.Buffer.create({
            size: 16384,
            usage: "Uniform"
        });

        this.generateCharacter();
        this.setupUI();

        this.api.onUpdate((time) => {
            this.animate(time);
        });
    }

    private generateCharacter() {
        if (this.meshId) this.api.Model.clearMesh(this.meshId);
        
        this.humanoid.generateMesh();
        this.meshId = Entropy.generateUUID();

        this.api.Model.createMesh({
            id: this.meshId,
            position: [0, 0, 0],
            vertexData: this.humanoid.vertices,
            indexData: this.humanoid.indices,
            pipelineId: this.pipelineId!,
            bindings: [
                { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.jointBufferId! } } }
            ]
        });
    }

    private animate(time: number) {
        const params = this.currentParams;
        this.humanoid.resetPose();

        if (params.activeAnimation === "Idle") {
            const breath = 1.0 + Math.sin(time * 2) * 0.05;
            this.humanoid.getBone("Spine")!.localTransform = mat4_from_rotation_translation_scale([0,0,0,1], [0, 0.4 * breath, 0], [1,1,1]);
        } else if (params.activeAnimation === "Walk") {
            const swing = Math.sin(time * 5) * 0.5;
            // Simplified walk
            this.humanoid.getBone("UpperLeg_L")!.localTransform = mat4_from_rotation_translation_scale([Math.sin(swing), 0, 0, Math.cos(swing)], [-0.15, -0.1, 0], [1,1,1]);
            this.humanoid.getBone("UpperLeg_R")!.localTransform = mat4_from_rotation_translation_scale([Math.sin(-swing), 0, 0, Math.cos(-swing)], [0.15, -0.1, 0], [1,1,1]);
        }

        this.humanoid.rootBone.updateWorldTransform(mat4_identity());
        
        // Upload joint matrices to GPU
        const matrices = this.humanoid.getJointMatrices();
        this.api.Buffer.write(this.jointBufferId!, new Float32Array(matrices));
    }

    private setupUI() {
        const tab = this.api.UI.createTab({
            title: "Character Gen",
            onRender: () => {
                Entropy.UI.Widget.label(tab, { text: "👤 Procedural Character Creator", bold: true });
                this.renderComponentUI(tab, () => this.generateCharacter());
                
                Entropy.UI.Widget.dropdown(tab, {
                    label: "Animation",
                    options: ["Idle", "Walk", "Wave"],
                    selectedIndex: ["Idle", "Walk", "Wave"].indexOf(this.currentParams.activeAnimation),
                    onChange: (idx) => { this.currentParams.activeAnimation = ["Idle", "Walk", "Wave"][parseInt(idx)] as any; }
                });

                Entropy.UI.Widget.button(tab, {
                    text: "🎲 Randomize Proportions",
                    onClick: () => {
                        this.currentParams.headScale = 0.5 + Math.random();
                        this.generateCharacter();
                    }
                });
            }
        });
    }
}

new CharacterCreator().register();
