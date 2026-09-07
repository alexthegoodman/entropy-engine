const PREVIEW_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct MeshUniforms {
    model_matrix: mat4x4<f32>,
};
@group(1) @binding(0)
var<uniform> mesh: MeshUniforms;

@group(2) @binding(1)
var t_diffuse: texture_2d<f32>;
@group(2) @binding(2)
var s_diffuse: sampler;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) color: vec4<f32>
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_pos: vec3<f32>,
    @location(1) uv: vec2<f32>,
    @location(2) normal: vec3<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let world_pos = mesh.model_matrix * vec4<f32>(in.position, 1.0);
    out.world_pos = world_pos.xyz;
    out.clip_position = camera.view_proj * world_pos;
    out.uv = in.uv;
    out.normal = (mesh.model_matrix * vec4<f32>(in.normal, 0.0)).xyz;
    return out;
}

struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

@fragment
fn fs_main(in: VertexOutput) -> GbufferOutput {
    let albedo = textureSample(t_diffuse, s_diffuse, in.uv);
    
    var out: GbufferOutput;
    out.position = vec4<f32>(in.world_pos, 1.0);
    out.normal = vec4<f32>(1.0, 1.0, 1.0, 1.0);
    out.albedo = albedo;
    out.pbr_material = vec4<f32>(0.0, 0.1, 0.4, 1.0);
    return out;
}
`;

function generateCubeData() {
    // Format: position(3) + normal(3) + uv(2) + color(4) = 12 floats per vertex
    const vertices = [
        // Front face
        -1, -1,  1,  0, 0, 1,  0, 1,  1, 1, 1, 1,
         1, -1,  1,  0, 0, 1,  1, 1,  1, 1, 1, 1,
         1,  1,  1,  0, 0, 1,  1, 0,  1, 1, 1, 1,
        -1,  1,  1,  0, 0, 1,  0, 0,  1, 1, 1, 1,
        // Back face
        -1, -1, -1,  0, 0, -1,  1, 1,  1, 1, 1, 1,
        -1,  1, -1,  0, 0, -1,  1, 0,  1, 1, 1, 1,
         1,  1, -1,  0, 0, -1,  0, 0,  1, 1, 1, 1,
         1, -1, -1,  0, 0, -1,  0, 1,  1, 1, 1, 1,
        // Top face
        -1,  1, -1,  0, 1, 0,  0, 0,  1, 1, 1, 1,
        -1,  1,  1,  0, 1, 0,  0, 1,  1, 1, 1, 1,
         1,  1,  1,  0, 1, 0,  1, 1,  1, 1, 1, 1,
         1,  1, -1,  0, 1, 0,  1, 0,  1, 1, 1, 1,
        // Bottom face
        -1, -1, -1,  0, -1, 0,  1, 0,  1, 1, 1, 1,
         1, -1, -1,  0, -1, 0,  0, 0,  1, 1, 1, 1,
         1, -1,  1,  0, -1, 0,  0, 1,  1, 1, 1, 1,
        -1, -1,  1,  0, -1, 0,  1, 1,  1, 1, 1, 1,
        // Right face
         1, -1, -1,  1, 0, 0,  1, 1,  1, 1, 1, 1,
         1,  1, -1,  1, 0, 0,  1, 0,  1, 1, 1, 1,
         1,  1,  1,  1, 0, 0,  0, 0,  1, 1, 1, 1,
         1, -1,  1,  1, 0, 0,  0, 1,  1, 1, 1, 1,
        // Left face
        -1, -1, -1, -1, 0, 0,  0, 1,  1, 1, 1, 1,
        -1, -1,  1, -1, 0, 0,  1, 1,  1, 1, 1, 1,
        -1,  1,  1, -1, 0, 0,  1, 0,  1, 1, 1, 1,
        -1,  1, -1, -1, 0, 0,  0, 0,  1, 1, 1, 1,
    ];
    const indices = [
        0, 1, 2, 0, 2, 3,
        4, 5, 6, 4, 6, 7,
        8, 9, 10, 8, 10, 11,
        12, 13, 14, 12, 14, 15,
        16, 17, 18, 16, 18, 19,
        20, 21, 22, 20, 22, 23,
    ];
    return { vertices, indices };
}


export const createMaterialCube = (addon: any, pipelineId: string, diffTextureId: string, id?: string) => {
    Entropy.Composer?.enableGameComposerOverride();

    if (id) {
        addon.Model.clearMesh(id);
    }

    const { vertices, indices } = generateCubeData();

    Entropy.println("createMaterialCube " + pipelineId + " " + diffTextureId + " " + id);

    addon.Model.createMesh({
        // id: id,
        pipelineId: pipelineId,
        position: [-2, -10, -2],
        rotation: [0, 0, 0],
        scale: [2, 2, 2],
        vertexData: vertices,
        indexData: indices,
        renderRole: "General",
        bindings: [
            // { group: 2, binding: 1, resource: { type: "Texture", value: { id: diffTextureId } } },
            { group: 2, binding: 1, resource: { type: "Texture", value: { id: diffTextureId } } },
            { group: 2, binding: 2, resource: { type: "Sampler" } }
        ]
    });

    Entropy.Composer?.disableGameComposerOverride();
}

export const createMaterialPipeline = () => {
    const pipelineId = Entropy.Pipeline.create({
        name: "Material_Preview_Pipeline",
        pbr: true,
        layout: "mesh",
        vertexShader: PREVIEW_SHADER,
        fragmentShader: PREVIEW_SHADER,
        extraBindGroups: [
            { entries: [
                { binding: 1, visibility: ["Fragment"], resourceType: "Texture" },
                { binding: 2, visibility: ["Fragment"], resourceType: "Sampler" }
            ]}
        ]
    });

    return pipelineId;
}
