struct GbufferOutput {
    @location(0) position: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) albedo: vec4<f32>,
    @location(3) pbr_material: vec4<f32>,
}

struct FragmentInput {
    @location(0) normal: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>,
    @location(3) world_pos: vec3<f32>,
};

@group(1) @binding(1) var t_diffuse: texture_2d_array<f32>;
@group(1) @binding(2) var s_model: sampler;
@group(1) @binding(3) var<uniform> renderMode: i32;
@group(1) @binding(4) var t_normal: texture_2d_array<f32>;
@group(1) @binding(5) var t_pbr_params: texture_2d_array<f32>;

@fragment
fn fs_main(in: FragmentInput) -> GbufferOutput {
    var output: GbufferOutput;

    let tiling_factor: f32 = 100.0;
    let tiled_tex_coords = fract(in.tex_coords * tiling_factor);

    let primary_albedo = textureSample(t_diffuse, s_model, tiled_tex_coords, 0);
    let primary_normal = textureSample(t_normal, s_model, tiled_tex_coords, 0);
    let primary_pbr_params = textureSample(t_pbr_params, s_model, tiled_tex_coords, 0);
    let primary_mask = textureSample(t_diffuse, s_model, in.tex_coords, 1).r;

    let rockmap_albedo = textureSample(t_diffuse, s_model, tiled_tex_coords, 2);
    let rockmap_normal = textureSample(t_normal, s_model, tiled_tex_coords, 1);
    let rockmap_pbr_params = textureSample(t_pbr_params, s_model, tiled_tex_coords, 1);
    let rockmap_mask = textureSample(t_diffuse, s_model, in.tex_coords, 3).r;

    let soil_albedo = textureSample(t_diffuse, s_model, tiled_tex_coords, 4);
    let soil_normal = textureSample(t_normal, s_model, tiled_tex_coords, 2);
    let soil_pbr_params = textureSample(t_pbr_params, s_model, tiled_tex_coords, 2);
    let soil_mask = textureSample(t_diffuse, s_model, in.tex_coords, 5).r;
    
    // Normalize masks
    let total_mask = primary_mask + rockmap_mask + soil_mask;
    let primary_weight = primary_mask / max(total_mask, 0.001);
    let rockmap_weight = rockmap_mask / max(total_mask, 0.001);
    let soil_weight = soil_mask / max(total_mask, 0.001);

    // Blend textures based on normalized weights
    let albedo = primary_albedo.rgb * primary_weight + 
                    rockmap_albedo.rgb * rockmap_weight + 
                    soil_albedo.rgb * soil_weight;

    let normal_map_color = primary_normal.rgb * primary_weight +
                           rockmap_normal.rgb * rockmap_weight +
                           soil_normal.rgb * soil_weight;
    
    let pbr_params = primary_pbr_params.rgb * primary_weight +
                     rockmap_pbr_params.rgb * rockmap_weight +
                     soil_pbr_params.rgb * soil_weight;

    if (renderMode == 1) { // Rendering terrain texture
        output.albedo = vec4<f32>(albedo, 1.0);
    } else if (renderMode == 2) {
        let reg_primary = textureSample(t_diffuse, s_model, in.tex_coords, 0);
        output.albedo = vec4<f32>(reg_primary.rgb, 1.0);
    } else {
        output.albedo = in.color; // Color mode
    }

    output.position = vec4<f32>(in.world_pos, 1.0);
    
    // Unpack normal from texture and transform to world space
    let unpacked_normal = normalize(normal_map_color * 2.0 - 1.0);
    // Assuming 'in.normal' is the vertex normal, and 'in.world_pos' provides the context for tangent space.
    // For now, let's just output the unpacked normal. If tangent space normals are used,
    // a TBN matrix construction would be needed here, which is beyond simple replacement.
    output.normal = vec4<f32>(unpacked_normal, 1.0);

    // metallic, roughness, AO
    output.pbr_material = vec4<f32>(pbr_params, 1.0);

    return output;
}
