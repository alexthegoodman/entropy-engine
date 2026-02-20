struct CameraUniforms {
    view_projection: mat4x4<f32>,
    view_pos: vec4<f32>,
    window_size: vec2<f32>,
    _pad0: f32,
    _pad1: f32,
    inverse_view: mat4x4<f32>,
    inverse_projection: mat4x4<f32>,
};

struct InstanceData {
    model_matrix: mat4x4<f32>,
    mesh_index: f32,
    material_index: f32,
    _pad0: f32,
    _pad1: f32,
};

struct MeshDescriptor {
    meshlet_offset: f32,
    meshlet_count: f32,
    _pad0: f32,
    _pad1: f32,
};

struct Meshlet {
    vertex_offset: f32,
    index_offset: f32,
    index_count: f32,
    radius: f32,
    center_x: f32,
    center_y: f32,
    center_z: f32,
    lod_error: f32,
    parent_error: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

struct DrawIndexedIndirect {
    index_count: u32,
    instance_count: u32,
    first_index: u32,
    base_vertex: i32,
    first_instance: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(0) @binding(2) var<storage, read_write> draw_count: atomic<u32>;
@group(0) @binding(3) var<storage, read_write> draw_commands: array<DrawIndexedIndirect>;
@group(0) @binding(4) var<storage, read> mesh_descriptors: array<MeshDescriptor>;
@group(0) @binding(5) var<storage, read> meshlets: array<Meshlet>;

fn is_visible(center: vec3<f32>, radius: f32, model_matrix: mat4x4<f32>) -> bool {
    let world_center = (model_matrix * vec4<f32>(center, 1.0)).xyz;
    let clip_pos = camera.view_projection * vec4<f32>(world_center, 1.0);
    
    let w = clip_pos.w + radius;
    return clip_pos.x >= -w && clip_pos.x <= w &&
           clip_pos.y >= -w && clip_pos.y <= w &&
           clip_pos.z >= 0.0 && clip_pos.z <= w;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let instance_index = id.x;
    if (instance_index >= arrayLength(&instances)) {
        return;
    }

    let instance = instances[instance_index];
    let mesh_desc = mesh_descriptors[u32(instance.mesh_index)];

    for (var i = 0u; i < u32(mesh_desc.meshlet_count); i = i + 1u) {
        let meshlet_index = u32(mesh_desc.meshlet_offset) + i;
        let meshlet = meshlets[meshlet_index];

        let center = vec3<f32>(meshlet.center_x, meshlet.center_y, meshlet.center_z);

        if (is_visible(center, meshlet.radius, instance.model_matrix)) {
            let cmd_idx = atomicAdd(&draw_count, 1u);

            draw_commands[cmd_idx].index_count = u32(meshlet.index_count);
            draw_commands[cmd_idx].instance_count = 1u;
            draw_commands[cmd_idx].first_index = u32(meshlet.index_offset);
            draw_commands[cmd_idx].base_vertex = i32(meshlet.vertex_offset);
            draw_commands[cmd_idx].first_instance = instance_index;
        }
    }
}