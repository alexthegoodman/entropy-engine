struct FragmentInput {
    @location(0) normal: vec3<f32>,
    @location(1) tex_coords: vec2<f32>,
    @location(2) color: vec4<f32>
};

@group(1) @binding(1) var t_diffuse: texture_2d_array<f32>;
@group(1) @binding(2) var s_diffuse: sampler;
@group(1) @binding(3) var<uniform> renderMode: i32;

@fragment
fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
    let tiling_factor: f32 = 100.0;
    let tiled_tex_coords = fract(in.tex_coords * tiling_factor);

    let primary = textureSample(t_diffuse, s_diffuse, tiled_tex_coords, 0);
    let primary_mask = textureSample(t_diffuse, s_diffuse, in.tex_coords, 1).r;
    let rockmap = textureSample(t_diffuse, s_diffuse, tiled_tex_coords, 2);
    let rockmap_mask = textureSample(t_diffuse, s_diffuse, in.tex_coords, 3).r;
    let soil = textureSample(t_diffuse, s_diffuse, tiled_tex_coords, 4);
    let soil_mask = textureSample(t_diffuse, s_diffuse, in.tex_coords, 5).r;
    
    // Normalize masks
    let total_mask = primary_mask + rockmap_mask + soil_mask;
    let primary_weight = primary_mask / max(total_mask, 0.001);
    let rockmap_weight = rockmap_mask / max(total_mask, 0.001);
    let soil_weight = soil_mask / max(total_mask, 0.001);

    // Blend textures based on normalized weights
    let final_color = primary.rgb * primary_weight + 
                    rockmap.rgb * rockmap_weight + 
                    soil.rgb * soil_weight;

    if (renderMode == 1) { // Rendering terrain texture
        return vec4<f32>(final_color, 1.0); // Texture rendering
    } else if (renderMode == 2) {
        let reg_primary = textureSample(t_diffuse, s_diffuse, in.tex_coords, 0);

        return vec4<f32>(reg_primary.rgb, 1.0);
    } else {
        return in.color; // Color mode
    }

    // debug color coating
    // return vec4<f32>(f32(renderMode), 0.0, 0.0, 1.0);
}

// @group(1) @binding(1) var texture: texture_2d_array<f32>;
// @group(1) @binding(2) var texture_sampler: sampler;

// struct FragmentInput {
//     @location(0) tex_coords: vec2<f32>,
//     @location(1) color: vec4<f32>,
// };

// @fragment
// fn fs_main(in: FragmentInput) -> @location(0) vec4<f32> {
//     let tex_color = textureSample(texture, texture_sampler, in.tex_coords, 0);
//     return tex_color * in.color;
// }