struct CameraUniforms {
    view_projection: mat4x4<f32>
};

struct InstanceData {
    model_matrix: mat4x4<f32>,
    mesh_index: u32,
    material_index: u32,
    _padding: vec2<u32>,
};

struct DrawIndexedIndirect {
    index_count: u32,
    instance_count: atomic<u32>,
    first_index: u32,
    base_vertex: i32,
    first_instance: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<storage, read> instances: array<InstanceData>;
@group(0) @binding(2) var<storage, read_write> draw_args: DrawIndexedIndirect;
@group(0) @binding(3) var<storage, read_write> visible_indices: array<u32>;

// Simple sphere-frustum culling
fn is_visible(pos: vec3<f32>, radius: f32) -> bool {
    let clip_pos = camera.view_projection * vec4<f32>(pos, 1.0);
    
    // This is a very crude culling check, just for demonstration.
    // A proper frustum culling would check against all 6 planes.
    let w = clip_pos.w;
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
    let pos = instance.model_matrix[3].xyz;
    
    // Radius should ideally come from the mesh descriptor
    let radius = 1.0; 

    if (is_visible(pos, radius)) {
        let index = atomicAdd(&draw_args.instance_count, 1u);
        visible_indices[index] = instance_index;
    }
}
