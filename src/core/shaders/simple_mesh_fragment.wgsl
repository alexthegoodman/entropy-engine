// Single-target, unlit fragment shader for EntropyPipeline::simple_mesh_pipeline - the fallback
// for `pipelineId: "default"` addon cubes/landscapes/meshes with no PBR textures and no custom
// pipeline of their own. Paired with primary_vertex.wgsl (shared with geometry_pipeline), which
// already passes the vertex's own color straight through; this just writes it out untouched,
// matching the engine's existing convention that non-PBR geometry is untextured and unlit (see
// the "default" pipeline_id handling in render_addon_frame.rs, and the same statement documented
// for Entropy.Landscape's non-PBR path).
struct FragmentInput {
    @location(0) normal: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) world_pos: vec3<f32>,
};

@fragment
fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
    return in.color;
}
