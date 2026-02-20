struct CameraUniforms {
    view_projection: mat4x4<f32>
};

struct InstanceData {
    model_matrix: mat4x4<f32>,
    mesh_index: u32,
    material_index: u32,
    _padding: vec2<u32>,
};

struct MeshDescriptor {
    meshlet_offset: u32,
    meshlet_count: u32,
    _padding: vec2<u32>,
};

struct Meshlet {
    vertex_offset: u32,
    index_offset: u32,
    index_count: u32,
    radius: f32,
    center: vec3<f32>,
    _padding: u32,
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
    let mesh_desc = mesh_descriptors[instance.mesh_index];

    for (var i = 0u; i < mesh_desc.meshlet_count; i = i + 1u) {
        let meshlet_index = mesh_desc.meshlet_offset + i;
        let meshlet = meshlets[meshlet_index];

        if (is_visible(meshlet.center, meshlet.radius, instance.model_matrix)) {
            let cmd_idx = atomicAdd(&draw_count, 1u);
            
            draw_commands[cmd_idx].index_count = meshlet.index_count;
            draw_commands[cmd_idx].instance_count = 1u;
            draw_commands[cmd_idx].first_index = meshlet.index_offset;
            draw_commands[cmd_idx].base_vertex = i32(meshlet.vertex_offset);
            // We store instance_index in first_instance so the vertex shader knows which transform to use
            draw_commands[cmd_idx].first_instance = instance_index;
        }
    }
}
