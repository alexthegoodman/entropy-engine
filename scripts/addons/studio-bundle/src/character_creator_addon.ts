import { ComponentAddon } from "./system";
import { ProceduralHumanoid, mat4_identity } from "./humanoid_v2";

// Expose Humanoid API to Entropy for interop
(Entropy as any).Humanoid = {
    create: () => new ProceduralHumanoid()
};

// ============================================================================
// SHADER
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
    var skin_matrix = mat4x4<f32>(
        vec4<f32>(0.0, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, 0.0, 0.0),
        vec4<f32>(0.0, 0.0, 0.0, 0.0)
    );
    
    for (var i = 0u; i < 4u; i = i + 1u) {
        let joint_index = in.joint_indices[i];
        let joint_weight = in.joint_weights[i];
        skin_matrix = skin_matrix + joint_weight * skin.joints[joint_index];
    }

    let skinned_pos = skin_matrix * vec4<f32>(in.position, 1.0);
    let world_pos = mesh.model_matrix * skinned_pos;
    
    let skinned_normal = skin_matrix * vec4<f32>(in.normal, 0.0);
    let world_normal = mesh.model_matrix * skinned_normal;
    
    var out: VertexOutput;
    out.clip_position = camera.view_proj * world_pos;
    out.world_pos = world_pos.xyz;
    out.normal = normalize(world_normal.xyz);
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
    out.norm = vec4<f32>(in.normal, 1.0);
    out.albedo = in.color;
    out.mat = vec4<f32>(0.6, 0.0, 1.0, 1.0);
    return out;
}
`;

// ============================================================================
// ANIMATION SYSTEM
// ============================================================================

interface CharacterParams {
    bodyScale: number;
    headScale: number;
    armLength: number;
    activeAnimation: "Idle" | "Walk" | "Wave" | "Jump" | "Dance";
}

export class CharacterCreator extends ComponentAddon<CharacterParams> {
    protected defaultParams: CharacterParams = {
        bodyScale: 1.0,
        headScale: 1.0,
        armLength: 1.0,
        activeAnimation: "Idle"
    };

    public pipelineId: string | null = null;
    public meshId: string | null = null;
    public humanoid: ProceduralHumanoid;
    public jointBufferId: string | null = null;
    public animationTime: number = 0;

    constructor() {
        super({
            name: "Character Creator",
            version: "3.0.0",
            description: "Realistic procedural humanoid with smooth animations",
            author: ["Entropy Team"],
            capabilities: { graphics: true, ui: true }
        });
        this.humanoid = new ProceduralHumanoid();
    }

    protected setup(): void {
        this.initComponentState("Realistic Hero");
        
        this.pipelineId = Entropy.Pipeline.create({
            name: "Realistic_Skinned_Pipeline",
            layout: "skinned",
            pbr: true,
            vertexShader: SKINNED_SHADER,
            fragmentShader: SKINNED_SHADER,
            extraBindGroups: [
                { entries: [{ binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }] }
            ]
        });

        this.jointBufferId = this.api.Buffer.create({
            size: 16384,
            usage: "Uniform"
        });

        this.generateCharacter();

        if (this.meshId) {
            this.registerVisual("humanoid_character", {
                vertexData: this.humanoid.vertices,
                indexData: this.humanoid.indices,
                pipelineId: this.pipelineId,
                bindings: [
                    { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.jointBufferId! } } }
                ]
            });
        }

        this.setupUI();

        this.api.onUpdate((time) => {
            this.animationTime = time;
            this.animate(time);
        });
    }

    public generateCharacter() {
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

    public animate(time: number) {
        // Animate the main preview character (for UI)
        this.humanoid.animate(time, this.currentParams.activeAnimation);
        
        // Upload joint matrices to GPU
        const matrices = this.humanoid.getJointMatrices();
        this.api.Buffer.write(this.jointBufferId!, new Float32Array(matrices));
    }

    public setupUI() {
        const tab = this.api.UI.createTab({
            title: "Character Creator",
            onRender: () => {
                Entropy.UI.Widget.label(tab, { text: "👤 Realistic Character Creator", bold: true });
                Entropy.UI.Widget.separator(tab);
                
                this.renderComponentUI(tab, () => this.generateCharacter());
                
                Entropy.UI.Widget.separator(tab);
                Entropy.UI.Widget.label(tab, { text: "Animation Controls", bold: true });
                
                Entropy.UI.Widget.dropdown(tab, {
                    label: "Active Animation",
                    options: ["Idle", "Walk", "Wave", "Jump", "Dance"],
                    selectedIndex: ["Idle", "Walk", "Wave", "Jump", "Dance"].indexOf(this.currentParams.activeAnimation),
                    onChange: (idx) => { 
                        this.currentParams.activeAnimation = ["Idle", "Walk", "Wave", "Jump", "Dance"][parseInt(idx)] as any;
                    }
                });

                Entropy.UI.Widget.separator(tab);
                Entropy.UI.Widget.label(tab, { text: "Morphology", bold: true });
                
                Entropy.UI.Widget.button(tab, {
                    text: "🎲 Randomize Character",
                    onClick: () => {
                        this.generateCharacter();
                    }
                });
            }
        });
    }
}

new CharacterCreator().register();