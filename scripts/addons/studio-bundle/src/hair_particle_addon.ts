const addonInfo = {
    name: "Hair Particles with Ornaments",
    version: "3.0.0",
    description: "Highly customizable hair and grass particles with decorative ornament clusters",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

let hairParams: any = {
    id: "main_hair",
    gridSize: 2.0,
    renderDistance: 50.0,
    windStrength: 2.5,
    windSpeed: 0.3,
    bladeHeight: 2.75,
    bladeWidth: 0.03,
    brownianStrength: 0.03,
    bladeHeightVariability: 0.6,
    bladeDensity: 15.0,
    landscapeSize: 1024.0,
    landscapeHeight: 150.0,
    landscapeYOffset: 0.0,
    baseColor: [0.1, 0.3, 0.35, 1.0],
    tipColor: [0.2, 0.7, 0.8, 1.0],
    pipelineId: null,
    
    // Shape parameters
    bladeCurvature: 0.5,
    bladeTwist: 0.2,
    bladeTaper: 0.7,
    colorVariation: 0.15,
    colorBandPosition: 0.5,
    colorBandWidth: 0.3,
    specularStrength: 0.2,
    clumpingStrength: 0.0,
    clumpingScale: 5.0,
    leanDirectionX: 0.0,
    leanDirectionZ: 0.0,
    edgeDarkening: 0.3,
    subsurfaceScattering: 0.4,
    translucency: 0.2,
    rimLightStrength: 0.5,
    
    // Ornament parameters
    ornamentsEnabled: true,
    ornamentProbability: 0.3,
    ornamentHeightPosition: 0.85,
    ornamentHeightRange: 0.15,
    ornamentSize: 0.08,
    ornamentSizeVariation: 0.4,
    ornamentCount: 5,
    ornamentClusterShape: 0, // 0=sphere, 1=hemisphere, 2=ring, 3=spiral, 4=starburst
    ornamentColor: [1.0, 0.9, 0.2, 1.0],
    ornamentColorVariation: 0.2,
    ornamentGlow: 0.5,
    ornamentRotationSpeed: 0.5,
    ornamentWeight: 0.3,
    ornamentSpacing: 0.0, // For multiple ornaments per blade
    ornamentInertia: 0.7
};

let addonState: {
    currentParams: typeof hairParams,
    savedComponents: { id: string, name: string, params: typeof hairParams }[],
    activeComponentId: string | null
} = {
    currentParams: { ...hairParams },
    savedComponents: [],
    activeComponentId: Entropy.generateUUID()
};

let newComponentName = "New Hair Component";

// Enhanced vertex shader with ornament support
const hairVertexShader = `
// ===== LANDSCAPE SAMPLING =====

// Sample height from landscape texture array
fn sample_landscape_height(world_pos: vec2<f32>) -> f32 {
    // default terrain sizing
    // square_size = 1024.0 * 4.0 = 4096.0
    // square_height = 150.0 * 4.0 = 600.0
    let landscape_size = 4096.0;
    let max_height = 600.0;
    // let max_height = 900.0; // 1.5 scale?
    // let landscape_y_offset = -450.0;
    let landscape_y_offset = -550.0 + 2.0; // +2.0 minor gap fix?

    // dynamic terrain sizing
    // let landscape_size = uniforms.landscape_size;
    // let max_height = uniforms.landscape_height;
    // let landscape_y_offset = uniforms.landscape_y_offset;
    
    // World coordinates are centered, so normalize to 0-1 UV space
    let uv = (world_pos + landscape_size * 0.5) / landscape_size;
    
    // Clamp UV to valid range to avoid sampling outside texture
    let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
    // Use textureSampleLevel for vertex shader (explicit LOD = 0)
    // let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, HEIGHTMAP_LAYER, 0.0);
    let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    
    // Heightmap is normalized (0-1), so scale to actual height
    // The R channel contains the normalized height value
    return (height_sample.r * max_height) + landscape_y_offset; // hardcoded landscape offset from generic properties!
}

// fn sample_landscape_height(world_pos: vec2<f32>) -> f32 {
//     let max_height = 600.0;  // This should be your HEIGHT RANGE, not just max
//     // let min_height = -691.66; // Add this
//     let min_height = -600.00; // Add this
//     // let landscape_size = uniforms.landscape_size;
//     // let landscape_y_offset = uniforms.landscape_y_offset;

//     let landscape_size = 4096.0;
//     let landscape_y_offset = 0.0;
    
//     let uv = (world_pos + landscape_size * 0.5) / landscape_size;
//     let clamped_uv = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
    
//     let height_sample = textureSampleLevel(landscape_texture, landscape_sampler, clamped_uv, 0.0);
    
//     // Denormalize from 0-1 back to actual height range
//     let height_range = max_height - min_height;
//     return (height_sample.r * height_range + min_height) + landscape_y_offset;
// }

// Calculate terrain normal by sampling nearby heights
fn sample_landscape_normal(world_pos: vec2<f32>) -> vec3<f32> {
    let offset = 2.0; // Sample distance - adjust based on terrain detail
    
    let h_center = sample_landscape_height(world_pos);
    let h_right = sample_landscape_height(world_pos + vec2<f32>(offset, 0.0));
    let h_up = sample_landscape_height(world_pos + vec2<f32>(0.0, offset));
    
    // Calculate tangent vectors
    let tangent_x = vec3<f32>(offset, h_right - h_center, 0.0);
    let tangent_z = vec3<f32>(0.0, h_up - h_center, offset);
    
    // Cross product gives us the normal
    return normalize(cross(tangent_z, tangent_x));
}

    struct Camera {
        view_proj: mat4x4<f32>,
    };
    @group(0) @binding(0)
    var<uniform> camera: Camera;

    struct GrassUniforms {
        time: f32,
        grid_size: f32,
        render_distance: f32,
        wind_strength: f32,
        player_pos: vec4<f32>,
        wind_speed: f32,
        blade_height: f32,
        blade_width: f32,
        brownian_strength: f32,
        blade_density: f32,
        landscape_size: f32,
        landscape_height: f32,
        landscape_y_offset: f32,
        base_color: vec4<f32>,
        tip_color: vec4<f32>,
    }
    @group(1) @binding(0)
    var<uniform> uniforms: GrassUniforms;

    @group(2) @binding(0)
    var landscape_texture: texture_2d<f32>;
    @group(2) @binding(1)
    var landscape_sampler: sampler;

    struct ExtraParams {
        blade_height_variability: f32,
        blade_curvature: f32,
        blade_twist: f32,
        blade_taper: f32,
        
        color_variation: f32,
        color_band_position: f32,
        color_band_width: f32,
        specular_strength: f32,
        
        clumping_strength: f32,
        clumping_scale: f32,
        lean_direction_x: f32,
        lean_direction_z: f32,
        
        edge_darkening: f32,
        subsurface_scattering: f32,
        translucency: f32,
        rim_light_strength: f32,
    }
    @group(3) @binding(0)
    var<uniform> extra: ExtraParams;

    struct VertexInput {
        @location(0) position: vec3<f32>,
        @location(1) normal: vec3<f32>,
        @location(2) tex_coords: vec2<f32>,
        @location(3) color: vec4<f32>,
        @builtin(instance_index) instance_index: u32,
    };

    struct VertexOutput {
        @builtin(position) clip_position: vec4<f32>,
        @location(0) world_pos: vec3<f32>,
        @location(1) height_factor: f32,
        @location(2) blade_id: f32,
        @location(3) normal: vec3<f32>,
        @location(4) tangent: vec3<f32>,
        @location(5) local_x: f32,
    };

    fn hash13(p3: vec3<f32>) -> f32 {
        var p = fract(p3 * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
    }

    fn hash23(p3: vec3<f32>) -> vec2<f32> {
        var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yzx + 33.33);
        return fract((p.xx + p.yz) * p.zy);
    }

    fn hash33(p3: vec3<f32>) -> vec3<f32> {
        var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
    }

    @vertex
    fn vs_main(in: VertexInput) -> VertexOutput {
        var out: VertexOutput;

        let grid_cells = u32(ceil(uniforms.render_distance * 2.0 / uniforms.grid_size));
        let blades_per_cell = u32(uniforms.blade_density);

        let cell_index = in.instance_index / blades_per_cell;
        let cell_x = cell_index % grid_cells;
        let cell_z = cell_index / grid_cells;
        let blade_in_cell = in.instance_index % blades_per_cell;
        
        let player_cell_x = floor(uniforms.player_pos.x / uniforms.grid_size);
        let player_cell_z = floor(uniforms.player_pos.z / uniforms.grid_size);
        
        let world_cell_x = player_cell_x + f32(cell_x) - f32(grid_cells) / 2.0;
        let world_cell_z = player_cell_z + f32(cell_z) - f32(grid_cells) / 2.0;
        
        let seed = vec3<f32>(world_cell_x, world_cell_z, f32(blade_in_cell));
        let random_offset = hash23(seed);
        
        // Apply clumping
        let clump_seed = floor(seed / extra.clumping_scale);
        let clump_offset = hash23(clump_seed);
        let clump_blend = extra.clumping_strength;
        let final_offset = mix(random_offset, clump_offset, clump_blend);
        
        let blade_x = world_cell_x * uniforms.grid_size + final_offset.x * uniforms.grid_size;
        let blade_z = world_cell_z * uniforms.grid_size + final_offset.y * uniforms.grid_size;
        
        // Sample landscape height at this position
        let blade_y = sample_landscape_height(vec2<f32>(blade_x, blade_z));
        
        // Get terrain normal for grass orientation
        let terrain_normal = sample_landscape_normal(vec2<f32>(blade_x, blade_z));
        
        let blade_pos = vec3<f32>(blade_x, blade_y, blade_z);
        
        let blade_seed = hash13(seed);
        let blade_height_variation = (1.0 - extra.blade_height_variability / 2.0) + blade_seed * extra.blade_height_variability;
        let blade_rotation = hash13(seed * 7.31) * 6.28318;
        
        let cos_r = cos(blade_rotation);
        let sin_r = sin(blade_rotation);
        
        // Apply twist along the blade height
        let twist_angle = blade_rotation + extra.blade_twist * in.position.y * 3.14159;
        let cos_t = cos(twist_angle);
        let sin_t = sin(twist_angle);
        
        var rotated_x = in.position.x * cos_t - in.position.z * sin_t;
        var rotated_z = in.position.x * sin_t + in.position.z * cos_t;
        
        // Apply taper
        let height_factor = in.position.y;
        let taper_factor = 1.0 - (height_factor * extra.blade_taper);
        
        let local_pos = vec3<f32>(
            rotated_x * uniforms.blade_width * taper_factor,
            in.position.y * uniforms.blade_height * blade_height_variation,
            rotated_z * uniforms.blade_width * taper_factor
        );
        
        // Wind displacement
        let sway_phase = uniforms.time * uniforms.wind_speed * 0.3 + blade_seed * 6.28;
        let sway_amount = sin(sway_phase) * 0.5 + 0.5;
        let wind_disp = vec3<f32>(
            uniforms.wind_strength * cos(sway_phase) * height_factor * height_factor,
            0.0,
            uniforms.wind_strength * sin(sway_phase) * height_factor * height_factor
        );

        // Apply curvature
        let curve_amount = extra.blade_curvature * height_factor * height_factor;
        let curve_dir = vec3<f32>(cos(blade_rotation), 0.0, sin(blade_rotation));
        let curvature_disp = curve_dir * curve_amount;
        
        // Apply global lean
        let lean_disp = vec3<f32>(
            extra.lean_direction_x * height_factor * height_factor,
            0.0,
            extra.lean_direction_z * height_factor * height_factor
        );

        let world_position = blade_pos + local_pos + wind_disp + curvature_disp + lean_disp;
        
        // Calculate tangent for better lighting
        let tangent_dir = normalize(vec3<f32>(-sin(blade_rotation), 0.0, cos(blade_rotation)));
        
        // Calculate normal considering the curve
        let curve_normal_tilt = normalize(vec3<f32>(
            -curve_dir.x * extra.blade_curvature * 2.0 * height_factor,
            1.0,
            -curve_dir.z * extra.blade_curvature * 2.0 * height_factor
        ));
        
        out.world_pos = world_position;
        out.clip_position = camera.view_proj * vec4<f32>(world_position, 1.0);
        out.height_factor = height_factor;
        out.blade_id = blade_seed;
        out.normal = curve_normal_tilt;
        out.tangent = tangent_dir;
        out.local_x = in.position.x;
        
        return out;
    }
`;

const hairFragShader = `
    struct GrassUniforms {
        time: f32,
        grid_size: f32,
        render_distance: f32,
        wind_strength: f32,
        player_pos: vec4<f32>,
        wind_speed: f32,
        blade_height: f32,
        blade_width: f32,
        brownian_strength: f32,
        blade_density: f32,
        landscape_size: f32,
        landscape_height: f32,
        landscape_y_offset: f32,
        base_color: vec4<f32>,
        tip_color: vec4<f32>,
    }
    @group(1) @binding(0)
    var<uniform> uniforms: GrassUniforms;

    struct ExtraParams {
        blade_height_variability: f32,
        blade_curvature: f32,
        blade_twist: f32,
        blade_taper: f32,
        
        color_variation: f32,
        color_band_position: f32,
        color_band_width: f32,
        specular_strength: f32,
        
        clumping_strength: f32,
        clumping_scale: f32,
        lean_direction_x: f32,
        lean_direction_z: f32,
        
        edge_darkening: f32,
        subsurface_scattering: f32,
        translucency: f32,
        rim_light_strength: f32,
    }
    @group(3) @binding(0)
    var<uniform> extra: ExtraParams;

    struct VertexOutput {
        @builtin(position) clip_position: vec4<f32>,
        @location(0) world_pos: vec3<f32>,
        @location(1) height_factor: f32,
        @location(2) blade_id: f32,
        @location(3) normal: vec3<f32>,
        @location(4) tangent: vec3<f32>,
        @location(5) local_x: f32,
    };

    struct GbufferOutput {
        @location(0) position: vec4<f32>,
        @location(1) normal: vec4<f32>,
        @location(2) albedo: vec4<f32>,
        @location(3) pbr_material: vec4<f32>,
    }

    @fragment
    fn fs_main(in: VertexOutput) -> GbufferOutput {
        // Color variation per blade
        let color_shift = (in.blade_id - 0.5) * extra.color_variation;
        
        // Color band effect
        let band_center = extra.color_band_position;
        let band_half_width = extra.color_band_width * 0.5;
        let dist_to_band = abs(in.height_factor - band_center);
        let band_influence = 1.0 - smoothstep(0.0, band_half_width, dist_to_band);
        
        // Mix colors
        let height_blend = in.height_factor + color_shift;
        var base_blend = mix(uniforms.base_color.rgb, uniforms.tip_color.rgb, height_blend);
        base_blend = mix(base_blend, uniforms.tip_color.rgb, band_influence * 0.3);
        
        // Edge darkening
        let edge_factor = abs(in.local_x);
        let edge_darken = 1.0 - (edge_factor * extra.edge_darkening);
        
        // Ambient occlusion
        let ao = 0.6 + in.height_factor * 0.3;
        
        // Subsurface scattering
        let subsurface = extra.subsurface_scattering * (1.0 - in.height_factor * 0.5) * extra.translucency;
        let subsurface_color = mix(base_blend, uniforms.tip_color.rgb * 1.5, subsurface);
        
        // Combine color effects
        let final_color = subsurface_color * ao * edge_darken;
        
        // Rim lighting
        let rim_fake = pow(1.0 - in.height_factor, 2.0) * extra.rim_light_strength;
        let rim_color = final_color + vec3<f32>(rim_fake * 0.3);
        
        // Material properties
        let roughness = 1.0 - (extra.specular_strength * 0.5);
        let metallic = 0.0;
        let alpha = 1.0 - (extra.translucency * 0.3 * (1.0 - in.height_factor));

        var output: GbufferOutput;
        output.position = vec4<f32>(in.world_pos, 1.0);
        output.normal = vec4<f32>(normalize(in.normal), 1.0);
        output.albedo = vec4<f32>(rim_color, alpha);
        output.pbr_material = vec4<f32>(metallic, roughness, ao, 1.0);
        
        return output;
    }
`;

// Ornament vertex shader - for the decorative clusters
const ornamentVertexShader = `
    struct Camera {
        view_proj: mat4x4<f32>,
    };
    @group(0) @binding(0)
    var<uniform> camera: Camera;

    struct TimeUniform {
        time: f32,
    }
    @group(2) @binding(0)
    var<uniform> time_uniform: TimeUniform;

    struct OrnamentUniforms {
        player_pos_x: f32,
        player_pos_z: f32,
        grid_size: f32,
        render_distance: f32,
        blade_density: f32,
        blade_height: f32,
        wind_strength: f32,
        wind_speed: f32,
        ornament_size: f32,
        ornament_size_variation: f32,
        ornament_height_position: f32,
        ornament_height_range: f32,
        ornament_probability: f32,
        ornament_count: f32,
        cluster_shape: f32,
        rotation_speed: f32,
        ornament_weight: f32,
        ornament_inertia: f32,
        blade_curvature: f32,
        blade_height_variability: f32,
        lean_direction_x: f32,
        lean_direction_z: f32,
        landscape_y_offset: f32,
        _padding: vec2<f32>,
    }
    @group(3) @binding(0)
    var<uniform> uniforms: OrnamentUniforms;

    struct VertexInput {
        @location(0) position: vec3<f32>,
        @location(1) normal: vec3<f32>,
        @builtin(instance_index) instance_index: u32,
    };

    struct VertexOutput {
        @builtin(position) clip_position: vec4<f32>,
        @location(0) world_pos: vec3<f32>,
        @location(1) normal: vec3<f32>,
        @location(2) ornament_id: f32,
        @location(3) cluster_id: f32,
    };

    fn hash13(p3: vec3<f32>) -> f32 {
        var p = fract(p3 * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
    }

    fn hash23(p3: vec3<f32>) -> vec2<f32> {
        var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yzx + 33.33);
        return fract((p.xx + p.yz) * p.zy);
    }

    fn hash33(p3: vec3<f32>) -> vec3<f32> {
        var p = fract(p3 * vec3<f32>(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
    }

    @vertex
    fn vs_main(in: VertexInput) -> VertexOutput {
        var out: VertexOutput;

        let orbs_per_cluster = u32(uniforms.ornament_count);
        let cluster_index = in.instance_index / orbs_per_cluster;
        let orb_in_cluster = in.instance_index % orbs_per_cluster;

        // Find which blade this ornament belongs to
        let grid_cells = u32(ceil(uniforms.render_distance * 2.0 / uniforms.grid_size));
        
        let blade_index = cluster_index;
        let blade_cell_index = blade_index / u32(uniforms.blade_density);
        let blade_in_cell = blade_index % u32(uniforms.blade_density);
        
        let cell_x = blade_cell_index % grid_cells;
        let cell_z = blade_cell_index / grid_cells;
        
        let player_cell_x = floor(uniforms.player_pos_x / uniforms.grid_size);
        let player_cell_z = floor(uniforms.player_pos_z / uniforms.grid_size);
        
        let world_cell_x = player_cell_x + f32(cell_x) - f32(grid_cells) / 2.0;
        let world_cell_z = player_cell_z + f32(cell_z) - f32(grid_cells) / 2.0;
        
        let seed = vec3<f32>(world_cell_x, world_cell_z, f32(blade_in_cell));
        
        // Check if this blade should have an ornament
        let ornament_chance = hash13(seed * 13.37);
        if (ornament_chance > uniforms.ornament_probability) {
            // Hide this ornament
            out.clip_position = vec4<f32>(0.0, 0.0, -1000.0, 1.0);
            return out;
        }
        
        let random_offset = hash23(seed);
        let blade_x = world_cell_x * uniforms.grid_size + random_offset.x * uniforms.grid_size;
        let blade_z = world_cell_z * uniforms.grid_size + random_offset.y * uniforms.grid_size;
        
        let blade_seed = hash13(seed);
        let blade_height_variation = (1.0 - uniforms.blade_height_variability / 2.0) + blade_seed * uniforms.blade_height_variability;
        let blade_rotation = hash13(seed * 7.31) * 6.28318;
        
        // Position along blade height with variation
        let height_variation = hash13(seed * 3.14) * uniforms.ornament_height_range;
        let attachment_height = uniforms.ornament_height_position + (height_variation - uniforms.ornament_height_range * 0.5);
        let clamped_height = clamp(attachment_height, 0.0, 1.0);
        
        let blade_y_at_ornament = uniforms.landscape_y_offset + clamped_height * uniforms.blade_height * blade_height_variation;
        
        // Wind effect on blade at ornament position
        let sway_phase = time_uniform.time * uniforms.wind_speed * 0.3 + blade_seed * 6.28;
        let wind_disp = vec3<f32>(
            uniforms.wind_strength * cos(sway_phase) * clamped_height * clamped_height,
            0.0,
            uniforms.wind_strength * sin(sway_phase) * clamped_height * clamped_height
        );
        
        // Curvature effect
        let curve_amount = uniforms.blade_curvature * clamped_height * clamped_height;
        let curve_dir = vec3<f32>(cos(blade_rotation), 0.0, sin(blade_rotation));
        let curvature_disp = curve_dir * curve_amount;
        
        // Global lean
        let actual_lean_disp = vec3<f32>(
            uniforms.lean_direction_x * clamped_height * clamped_height,
            0.0,
            uniforms.lean_direction_z * clamped_height * clamped_height
        );
        
        // Ornament weight pulls blade down slightly
        let weight_pull = vec3<f32>(0.0, -uniforms.ornament_weight * 0.2 * clamped_height, 0.0);
        
        // Ornament inertia - lags behind wind
        let inertia_phase = sway_phase - uniforms.ornament_inertia * 0.5;
        let inertia_wind = vec3<f32>(
            uniforms.wind_strength * cos(inertia_phase) * 0.3,
            0.0,
            uniforms.wind_strength * sin(inertia_phase) * 0.3
        );
        
        let blade_tip_pos = vec3<f32>(blade_x, blade_y_at_ornament, blade_z) 
            + wind_disp + curvature_disp + actual_lean_disp + weight_pull + inertia_wind;
        
        // Cluster shape positioning
        let orb_seed = hash33(vec3<f32>(f32(blade_index), f32(orb_in_cluster), 0.5));
        var cluster_offset: vec3<f32>;
        
        let shape_type = i32(uniforms.cluster_shape);
        let angle = f32(orb_in_cluster) / uniforms.ornament_count * 6.28318 * 2.0;
        let radius = 0.5 + orb_seed.x * 0.3;
        
        if (shape_type == 0) {
            // Sphere cluster
            let phi = orb_seed.y * 6.28318;
            let theta = orb_seed.z * 3.14159;
            cluster_offset = vec3<f32>(
                sin(theta) * cos(phi) * radius,
                cos(theta) * radius,
                sin(theta) * sin(phi) * radius
            );
        } else if (shape_type == 1) {
            // Hemisphere (flowers)
            let phi = orb_seed.y * 6.28318;
            let theta = orb_seed.z * 1.57; // 0 to PI/2
            cluster_offset = vec3<f32>(
                sin(theta) * cos(phi) * radius,
                cos(theta) * radius * 0.5,
                sin(theta) * sin(phi) * radius
            );
        } else if (shape_type == 2) {
            // Ring (flower petals)
            cluster_offset = vec3<f32>(
                cos(angle) * radius,
                (orb_seed.y - 0.5) * 0.2,
                sin(angle) * radius
            );
        } else if (shape_type == 3) {
            // Spiral
            let spiral_height = f32(orb_in_cluster) / uniforms.ornament_count;
            let spiral_radius = radius * (1.0 - spiral_height * 0.5);
            cluster_offset = vec3<f32>(
                cos(angle) * spiral_radius,
                spiral_height * 0.8 - 0.4,
                sin(angle) * spiral_radius
            );
        } else {
            // Starburst (radiating outward)
            let burst_length = 0.5 + orb_seed.x * 0.8;
            cluster_offset = vec3<f32>(
                cos(angle) * burst_length,
                (orb_seed.y - 0.5) * 0.3,
                sin(angle) * burst_length
            );
        }
        
        // Rotation animation
        let rotation_angle = time_uniform.time * uniforms.rotation_speed + blade_seed * 1.28;
        let cos_rot = cos(rotation_angle);
        let sin_rot = sin(rotation_angle);
        let rotated_offset = vec3<f32>(
            cluster_offset.x * cos_rot - cluster_offset.z * sin_rot,
            cluster_offset.y,
            cluster_offset.x * sin_rot + cluster_offset.z * cos_rot
        );
        
        // Scale ornament
        let size_var = 1.0 + (orb_seed.x - 0.5) * uniforms.ornament_size_variation;
        let ornament_scale = uniforms.ornament_size * size_var;
        
        let ornament_pos = in.position * ornament_scale;
        let final_offset = rotated_offset * ornament_scale;
        
        let world_position = blade_tip_pos + ornament_pos + final_offset;
        
        out.world_pos = world_position;
        out.clip_position = camera.view_proj * vec4<f32>(world_position, 1.0);
        out.normal = normalize(in.normal);
        out.ornament_id = orb_seed.x;
        out.cluster_id = f32(cluster_index);
        
        return out;
    }
`;

const ornamentFragShader = `
    struct TimeUniform {
        time: f32,
    }
    @group(2) @binding(0)
    var<uniform> time_uniform: TimeUniform;

    struct OrnamentUniforms {
        player_pos_x: f32,
        player_pos_z: f32,
        grid_size: f32,
        render_distance: f32,
        blade_density: f32,
        blade_height: f32,
        wind_strength: f32,
        wind_speed: f32,
        ornament_size: f32,
        ornament_size_variation: f32,
        ornament_height_position: f32,
        ornament_height_range: f32,
        ornament_probability: f32,
        ornament_count: f32,
        cluster_shape: f32,
        rotation_speed: f32,
        ornament_weight: f32,
        ornament_inertia: f32,
        blade_curvature: f32,
        blade_height_variability: f32,
        lean_direction_x: f32,
        lean_direction_z: f32,
        landscape_y_offset: f32,
        _padding: vec2<f32>,
    }
    @group(3) @binding(0)
    var<uniform> uniforms: OrnamentUniforms;

    struct OrnamentColorParams {
        ornament_color: vec4<f32>,
        color_variation: f32,
        glow_intensity: f32,
        _padding2: vec2<f32>,
    }
    @group(4) @binding(0)
    var<uniform> color_params: OrnamentColorParams;

    struct VertexOutput {
        @builtin(position) clip_position: vec4<f32>,
        @location(0) world_pos: vec3<f32>,
        @location(1) normal: vec3<f32>,
        @location(2) ornament_id: f32,
        @location(3) cluster_id: f32,
    };

    struct GbufferOutput {
        @location(0) position: vec4<f32>,
        @location(1) normal: vec4<f32>,
        @location(2) albedo: vec4<f32>,
        @location(3) pbr_material: vec4<f32>,
    }

    @fragment
    fn fs_main(in: VertexOutput) -> GbufferOutput {
        // Per-ornament color variation
        let hue_shift = (in.ornament_id - 0.5) * color_params.color_variation;
        
        // Simple hue shift approximation
        let varied_color = color_params.ornament_color.rgb + vec3<f32>(hue_shift, hue_shift * 0.5, -hue_shift * 0.3);
        let clamped_color = clamp(varied_color, vec3<f32>(0.0), vec3<f32>(1.0));
        
        // Add glow/emissive effect
        let glow_color = clamped_color * (1.0 + color_params.glow_intensity * 2.0);
        
        // Subtle pulsing effect based on time
        let pulse = sin(time_uniform.time * 2.0 + in.cluster_id) * 0.1 + 0.9;
        let final_color = glow_color * pulse;
        
        // Smooth sphere lighting
        let light_dir = normalize(vec3<f32>(0.5, 1.0, 0.3));
        let diffuse = max(dot(in.normal, light_dir), 0.3);
        
        var output: GbufferOutput;
        output.position = vec4<f32>(in.world_pos, 1.0);
        output.normal = vec4<f32>(in.normal, 1.0);
        output.albedo = vec4<f32>(final_color * diffuse, 1.0);
        
        // Smooth, slightly reflective material
        let metallic = 0.2;
        let roughness = 0.3;
        let ao = 1.0;
        output.pbr_material = vec4<f32>(metallic, roughness, ao, color_params.glow_intensity);
        
        return output;
    }
`;

function updateHair(params: typeof hairParams & { _transform?: { position: [number, number, number], scale: [number, number, number] } }, id: string = Entropy.generateUUID()) {
    const pos = params._transform?.position || [0, 0, 0];
    // Scale might need to be applied to blade dimensions or grid size, but for now let's just assume position.

    let globalSettings = Entropy.Composer?.getGlobalSettings();

    hairParams = {
        ...hairParams,
        landscapeSize: globalSettings?.landscapeSettings.size || 1024,
        landscapeHeight: globalSettings?.landscapeSettings.height || 150,
        landscapeYOffset: globalSettings?.landscapeSettings.yOffset || 0
    }
    
    addon.Particles.createHair({
        ...params,
        // landscapeHeight: 2.0,
        id: id,
        position: pos, // Pass position to the underlying system
        renderRole: "Vegetation",
        base_color: params.baseColor,
        tip_color: params.tipColor,
        bindings: [
            {
                group: 2,
                binding: 0,
                resource: {
                    type: "Texture",
                    value: {
                        id: "Landscape"
                    }
                }
            },
            { group: 2, binding: 1, resource: { type: "Sampler" } },
            {
                group: 3,
                binding: 0,
                resource: {
                    type: "Uniform",
                    value: { data: [
                        params.bladeHeightVariability,
                        params.bladeCurvature,
                        params.bladeTwist,
                        params.bladeTaper,
                        
                        params.colorVariation,
                        params.colorBandPosition,
                        params.colorBandWidth,
                        params.specularStrength,
                        
                        params.clumpingStrength,
                        params.clumpingScale,
                        params.leanDirectionX,
                        params.leanDirectionZ,
                        
                        params.edgeDarkening,
                        params.subsurfaceScattering,
                        params.translucency,
                        params.rimLightStrength
                    ] }
                }
            }
        ]
    });
}

let ornamentMeshId: string | null = null;
let ornamentPipelineId: string | null = null;

function updateOrnaments(params: typeof hairParams & { _transform?: { position: [number, number, number], scale: [number, number, number] } }, id: string = Entropy.generateUUID()) {
    if (!params.ornamentsEnabled) {
        return;
    }

    let globalSettings = Entropy.Composer?.getGlobalSettings();

    hairParams = {
        ...hairParams,
        landscapeSize: globalSettings?.landscapeSettings.size || 1024,
        landscapeHeight: globalSettings?.landscapeSettings.height || 150,
        landscapeYOffset: globalSettings?.landscapeSettings.yOffset || 0
    }

    // Create a simple sphere mesh for the orbs
    const sphereVertices: number[] = [];
    const sphereIndices: number[] = [];

    // Generate icosphere
    const segments = 8;
    for (let lat = 0; lat <= segments; lat++) {
        const theta = (lat * Math.PI) / segments;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        for (let lon = 0; lon <= segments; lon++) {
            const phi = (lon * 2 * Math.PI) / segments;
            const sinPhi = Math.sin(phi);
            const cosPhi = Math.cos(phi);

            const x = cosPhi * sinTheta;
            const y = cosTheta;
            const z = sinPhi * sinTheta;

            // Position (3)
            sphereVertices.push(x, y, z);
            
            // Normal (3) - same as position for a unit sphere
            sphereVertices.push(x, y, z);
            
            // UV / tex_coords (2)
            const u = lon / segments;
            const v = lat / segments;
            sphereVertices.push(u, v);
            
            // Color (4) - white/default
            sphereVertices.push(1, 1, 1, 1);
        }
    }

    // Generate indices
    for (let lat = 0; lat < segments; lat++) {
        for (let lon = 0; lon < segments; lon++) {
            const first = lat * (segments + 1) + lon;
            const second = first + segments + 1;

            sphereIndices.push(first, second, first + 1);
            sphereIndices.push(second, second + 1, first + 1);
        }
    }

    // Calculate instance count
    const gridCells = Math.ceil((params.renderDistance * 2.0) / params.gridSize);
    const totalBlades = gridCells * gridCells * params.bladeDensity;
    const ornamentInstances = Math.floor(totalBlades * params.ornamentProbability * params.ornamentCount);

    const pos = params._transform?.position || [0, 0, 0];
    // For ornaments, we also need to pass the position to the shader if the shader uses player_pos relative logic
    // But here we are moving the mesh itself. The shader logic `player_pos` usually centers the grid generation.
    // If we move the mesh, we might be double-moving or moving the "window".
    // For now, moving the mesh position is the standard Composer way.

    const ornamentData = {
        vertices: new Float32Array(sphereVertices),
        indices: new Uint32Array(sphereIndices),
        instanceCount: ornamentInstances,
        pipelineId: ornamentPipelineId,
        bindings: [
            {
                group: 2,
                binding: 0,
                resource: {
                    type: "Time" as "Time"
                }
            },
            {
                group: 3,
                binding: 0,
                resource: {
                    type: "Uniform" as "Uniform",
                    value: {
                        data: [
                            pos[0], // pass transform x as player_pos_x override? 
                            pos[2], // pass transform z as player_pos_z override?
                            params.gridSize,
                            params.renderDistance,
                            params.bladeDensity,
                            params.bladeHeight,
                            params.windStrength,
                            params.windSpeed,
                            params.ornamentSize,
                            params.ornamentSizeVariation,
                            params.ornamentHeightPosition,
                            params.ornamentHeightRange,
                            params.ornamentProbability,
                            params.ornamentCount,
                            params.ornamentClusterShape,
                            params.ornamentRotationSpeed,
                            params.ornamentWeight,
                            params.ornamentInertia,
                            params.bladeCurvature,
                            params.bladeHeightVariability,
                            params.leanDirectionX,
                            params.leanDirectionZ,
                            params.landscapeYOffset, // This is usually relative to mesh 0
                            0, 0, 0 // padding
                        ]
                    }
                }
            },
            {
                group: 4,
                binding: 0,
                resource: {
                    type: "Uniform" as "Uniform",
                    value: {
                        data: [
                            ...params.ornamentColor,
                            params.ornamentColorVariation,
                            params.ornamentGlow,
                            0, 0 // padding
                        ]
                    }
                }
            }
        ]
    };

    if (ornamentPipelineId) {
        addon.Model.createMesh({
            id: id + "_ornaments",
            vertexData: Array.from(sphereVertices),
            indexData: Array.from(sphereIndices),
            instanceCount: ornamentInstances,
            pipelineId: ornamentPipelineId,
            position: pos,
            bindings: ornamentData.bindings
        });
        
        Entropy.println(`Ornaments updated: ${ornamentInstances} orbs for component ${id}`);
    }
}

addon.onInit(async () => {
    Entropy.println("Hair Particle Addon with Ornaments Initializing...");

    const customPipelineId = Entropy.Pipeline.create({
        name: "custom_hair_shader_enhanced",
        layout: "hair",
        pbr: true,
        vertexShader: hairVertexShader,
        fragmentShader: hairFragShader,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Texture" },
                    { binding: 1, visibility: ["Vertex", "Fragment"], resourceType: "Sampler" }
                ]
            },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }
                ]
            }
        ]
    });

    // // Create ornament pipeline
    ornamentPipelineId = Entropy.Pipeline.create({
        name: "ornament_shader",
        layout: "mesh",
        pbr: true,
        vertexShader: ornamentVertexShader,
        fragmentShader: ornamentFragShader,
        extraBindGroups: [
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Time" }
                ]
            },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }
                ]
            },
            {
                entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }
                ]
            }
        ]
    });

    addonState.currentParams.pipelineId = customPipelineId;

    // Atmospheric lighting
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 5.0],
        color: [1.0, 0.2, 0.2],
        intensity: 8.0,
        maxDistance: 50.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.2, 0.2, 1.0],
        intensity: 8.0,
        maxDistance: 50.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -10.0],
        color: [0.2, 1.0, 0.2],
        intensity: 8.0,
        maxDistance: 50.0
    });

    const renderHairUI = (tab: string) => {
        Entropy.Addon.setVisibility("Hair Particles with Ornaments", true);
        Entropy.UI.Widget.label(tab, { text: "🌸 Hair & Grass with Ornaments", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "💾 Save All to Project",
            onClick: () => {
                addon.IO.save(addonState);
                if (Entropy.Composer) {
                    addonState.savedComponents.forEach(comp => {
                        Entropy.Composer!.registerComponent("Hair Particles with Ornaments", comp.id, comp.name, comp.params);
                    });
                }
                Entropy.println("Hair state saved!");
            }
        });

        Entropy.UI.Widget.label(tab, { text: "📦 Components", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "➕ Save Current as Component",
            onClick: () => {
                const id = Math.random().toString(36).substr(2, 9);
                addonState.savedComponents.push({
                    id,
                    name: newComponentName,
                    params: JSON.parse(JSON.stringify(addonState.currentParams))
                });
                if (Entropy.Composer) {
                    Entropy.Composer!.registerComponent("Hair Particles with Ornaments", id, newComponentName, addonState.currentParams);
                }
                Entropy.println(`Saved component: ${newComponentName}`);
            }
        });

        addonState.savedComponents.forEach(comp => {
            Entropy.UI.Widget.button(tab, {
                text: `📂 Load & Render: ${comp.name}`,
                onClick: () => {
                    addonState.currentParams = JSON.parse(JSON.stringify(comp.params));
                    addonState.activeComponentId = comp.id;
                    updateHair(addonState.currentParams, comp.id);
                    updateOrnaments(addonState.currentParams, comp.id);
                }
            });
        });

        Entropy.UI.Widget.label(tab, { text: "--------------------------------" });

        // === ORNAMENT CONTROLS ===
        Entropy.UI.Widget.label(tab, { text: "💎 Ornament System", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: addonState.currentParams.ornamentsEnabled ? "✅ Ornaments Enabled" : "❌ Ornaments Disabled",
            onClick: () => {
                addonState.currentParams.ornamentsEnabled = !addonState.currentParams.ornamentsEnabled;
                updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        if (addonState.currentParams.ornamentsEnabled) {
            Entropy.UI.Widget.label(tab, { text: "Cluster Shape", bold: false });
            const shapes = ["Sphere", "Hemisphere", "Ring", "Spiral", "Starburst"];
            Entropy.UI.Widget.button(tab, {
                text: `Shape: ${shapes[addonState.currentParams.ornamentClusterShape]}`,
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = (addonState.currentParams.ornamentClusterShape + 1) % shapes.length;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Probability (Coverage)",
                value: addonState.currentParams.ornamentProbability,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentProbability = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Orbs per Cluster",
                value: addonState.currentParams.ornamentCount,
                min: 1,
                max: 20,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentCount = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Height Position",
                value: addonState.currentParams.ornamentHeightPosition,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentHeightPosition = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Height Range (Spread)",
                value: addonState.currentParams.ornamentHeightRange,
                min: 0.0,
                max: 0.5,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentHeightRange = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Ornament Size",
                value: addonState.currentParams.ornamentSize,
                min: 0.01,
                max: 0.5,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentSize = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Size Variation",
                value: addonState.currentParams.ornamentSizeVariation,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentSizeVariation = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.colorInput(tab, {
                label: "Ornament Color",
                color: addonState.currentParams.ornamentColor,
                onChange: (newColor: number[]) => {
                    addonState.currentParams.ornamentColor = newColor;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Color Variation",
                value: addonState.currentParams.ornamentColorVariation,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentColorVariation = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Glow Intensity",
                value: addonState.currentParams.ornamentGlow,
                min: 0.0,
                max: 2.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentGlow = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Rotation Speed",
                value: addonState.currentParams.ornamentRotationSpeed,
                min: 0.0,
                max: 3.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentRotationSpeed = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Weight (Blade Pull)",
                value: addonState.currentParams.ornamentWeight,
                min: 0.0,
                max: 2.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentWeight = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Inertia (Lag)",
                value: addonState.currentParams.ornamentInertia,
                min: 0.0,
                max: 2.0,
                onChange: (val: string) => {
                    addonState.currentParams.ornamentInertia = parseFloat(val);
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.label(tab, { text: "Quick Ornament Presets", bold: false });
            
            Entropy.UI.Widget.button(tab, {
                text: "🌼 Wildflowers",
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = 2; // Ring
                    addonState.currentParams.ornamentCount = 6;
                    addonState.currentParams.ornamentSize = 0.12;
                    addonState.currentParams.ornamentHeightPosition = 0.9;
                    addonState.currentParams.ornamentHeightRange = 0.1;
                    addonState.currentParams.ornamentColor = [1.0, 0.85, 0.3, 1.0];
                    addonState.currentParams.ornamentGlow = 0.3;
                    addonState.currentParams.ornamentProbability = 0.15;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "💧 Water Droplets",
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = 0; // Sphere
                    addonState.currentParams.ornamentCount = 1;
                    addonState.currentParams.ornamentSize = 0.05;
                    addonState.currentParams.ornamentHeightPosition = 0.6;
                    addonState.currentParams.ornamentHeightRange = 0.4;
                    addonState.currentParams.ornamentColor = [0.7, 0.9, 1.0, 0.8];
                    addonState.currentParams.ornamentGlow = 0.6;
                    addonState.currentParams.ornamentProbability = 0.2;
                    addonState.currentParams.ornamentWeight = 0.5;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🔮 Fairy Lights",
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = 0; // Sphere
                    addonState.currentParams.ornamentCount = 3;
                    addonState.currentParams.ornamentSize = 0.06;
                    addonState.currentParams.ornamentHeightPosition = 0.7;
                    addonState.currentParams.ornamentHeightRange = 0.3;
                    addonState.currentParams.ornamentColor = [0.9, 0.7, 1.0, 1.0];
                    addonState.currentParams.ornamentGlow = 1.5;
                    addonState.currentParams.ornamentProbability = 0.25;
                    addonState.currentParams.ornamentRotationSpeed = 1.5;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🌾 Wheat Grains",
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = 3; // Spiral
                    addonState.currentParams.ornamentCount = 8;
                    addonState.currentParams.ornamentSize = 0.04;
                    addonState.currentParams.ornamentHeightPosition = 0.95;
                    addonState.currentParams.ornamentHeightRange = 0.05;
                    addonState.currentParams.ornamentColor = [0.9, 0.75, 0.4, 1.0];
                    addonState.currentParams.ornamentGlow = 0.1;
                    addonState.currentParams.ornamentProbability = 0.5;
                    addonState.currentParams.ornamentWeight = 0.8;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "✨ Stardust",
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = 4; // Starburst
                    addonState.currentParams.ornamentCount = 12;
                    addonState.currentParams.ornamentSize = 0.03;
                    addonState.currentParams.ornamentHeightPosition = 0.85;
                    addonState.currentParams.ornamentHeightRange = 0.2;
                    addonState.currentParams.ornamentColor = [1.0, 1.0, 0.8, 1.0];
                    addonState.currentParams.ornamentGlow = 2.0;
                    addonState.currentParams.ornamentProbability = 0.1;
                    addonState.currentParams.ornamentRotationSpeed = 2.5;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🍒 Berries",
                onClick: () => {
                    addonState.currentParams.ornamentClusterShape = 0; // Sphere
                    addonState.currentParams.ornamentCount = 3;
                    addonState.currentParams.ornamentSize = 0.08;
                    addonState.currentParams.ornamentHeightPosition = 0.75;
                    addonState.currentParams.ornamentHeightRange = 0.15;
                    addonState.currentParams.ornamentColor = [0.8, 0.1, 0.15, 1.0];
                    addonState.currentParams.ornamentGlow = 0.2;
                    addonState.currentParams.ornamentProbability = 0.12;
                    addonState.currentParams.ornamentWeight = 1.2;
                    updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                }
            });
        }

        // Colors Section
        Entropy.UI.Widget.label(tab, { text: "🎨 Color Settings", bold: true });
        Entropy.UI.Widget.colorInput(tab, {
            label: "Base Color",
            color: addonState.currentParams.baseColor,
            onChange: (newColor: number[]) => {
                addonState.currentParams.baseColor = newColor;
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.colorInput(tab, {
            label: "Tip Color",
            color: addonState.currentParams.tipColor,
            onChange: (newColor: number[]) => {
                addonState.currentParams.tipColor = newColor;
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Color Variation",
            value: hairParams.colorVariation,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.colorVariation = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Color Band Position",
            value: hairParams.colorBandPosition,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.colorBandPosition = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Color Band Width",
            value: hairParams.colorBandWidth,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.colorBandWidth = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Shape & Form Section
        Entropy.UI.Widget.label(tab, { text: "📐 Shape & Form", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Blade Curvature",
            value: addonState.currentParams.bladeCurvature,
            min: 0.0,
            max: 2.0,
            onChange: (val: string) => {
                addonState.currentParams.bladeCurvature = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Blade Twist",
            value: addonState.currentParams.bladeTwist,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.bladeTwist = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Blade Taper",
            value: hairParams.bladeTaper,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.bladeTaper = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Physical Properties
        Entropy.UI.Widget.label(tab, { text: "⚙️ Physical Properties", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Density",
            value: addonState.currentParams.bladeDensity,
            min: 1.0,
            max: 100.0,
            onChange: (val: string) => {
                addonState.currentParams.bladeDensity = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Height",
            value: addonState.currentParams.bladeHeight,
            min: 0.1,
            max: 10.0,
            onChange: (val: string) => {
                addonState.currentParams.bladeHeight = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Height Variability",
            value: hairParams.bladeHeightVariability,
            min: 0.0,
            max: 2.0,
            onChange: (val: string) => {
                addonState.currentParams.bladeHeightVariability = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Width",
            value: hairParams.bladeWidth,
            min: 0.001,
            max: 0.5,
            onChange: (val: string) => {
                addonState.currentParams.bladeWidth = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Clustering & Distribution
        Entropy.UI.Widget.label(tab, { text: "🌾 Clustering & Distribution", bold: true });

        Entropy.UI.Widget.slider(tab, {
            label: "Clumping Strength",
            value: hairParams.clumpingStrength,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.clumpingStrength = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Clumping Scale",
            value: hairParams.clumpingScale,
            min: 1.0,
            max: 20.0,
            onChange: (val: string) => {
                addonState.currentParams.clumpingScale = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lean Direction X",
            value: hairParams.leanDirectionX,
            min: -2.0,
            max: 2.0,
            onChange: (val: string) => {
                addonState.currentParams.leanDirectionX = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lean Direction Z",
            value: hairParams.leanDirectionZ,
            min: -2.0,
            max: 2.0,
            onChange: (val: string) => {
                addonState.currentParams.leanDirectionZ = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Lighting & Material
        Entropy.UI.Widget.label(tab, { text: "💡 Lighting & Material", bold: true });

        Entropy.UI.Widget.slider(tab, {
            label: "Specular Strength",
            value: hairParams.specularStrength,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.specularStrength = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Edge Darkening",
            value: hairParams.edgeDarkening,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.edgeDarkening = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Subsurface Scattering",
            value: hairParams.subsurfaceScattering,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.subsurfaceScattering = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Translucency",
            value: hairParams.translucency,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                addonState.currentParams.translucency = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Rim Light Strength",
            value: hairParams.rimLightStrength,
            min: 0.0,
            max: 2.0,
            onChange: (val: string) => {
                addonState.currentParams.rimLightStrength = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Environment
        Entropy.UI.Widget.label(tab, { text: "🌬️ Environment", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Wind Strength",
            value: addonState.currentParams.windStrength,
            min: 0.0,
            max: 10.0,
            onChange: (val: string) => {
                addonState.currentParams.windStrength = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Wind Speed",
            value: addonState.currentParams.windSpeed,
            min: 0.0,
            max: 5.0,
            onChange: (val: string) => {
                addonState.currentParams.windSpeed = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Rendering & Landscape
        Entropy.UI.Widget.label(tab, { text: "🖥️ Rendering & Landscape", bold: true });

        Entropy.UI.Widget.slider(tab, {
            label: "Grid Size",
            value: hairParams.gridSize,
            min: 0.5,
            max: 10.0,
            onChange: (val: string) => {
                addonState.currentParams.gridSize = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Render Distance",
            value: hairParams.renderDistance,
            min: 10.0,
            max: 500.0,
            onChange: (val: string) => {
                addonState.currentParams.renderDistance = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.numericInput(tab, {
            label: "Landscape Y Offset",
            value: hairParams.landscapeYOffset,
            onChange: (val: string) => {
                addonState.currentParams.landscapeYOffset = parseFloat(val);
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        // Presets
        Entropy.UI.Widget.label(tab, { text: "🎭 Presets", bold: true });

        Entropy.UI.Widget.button(tab, {
            text: "🌾 Realistic Grass",
            onClick: () => {
                addonState.currentParams.bladeCurvature = 0.3;
                addonState.currentParams.bladeTwist = 0.1;
                addonState.currentParams.bladeTaper = 0.8;
                addonState.currentParams.colorVariation = 0.2;
                addonState.currentParams.clumpingStrength = 0.15;
                addonState.currentParams.subsurfaceScattering = 0.6;
                addonState.currentParams.translucency = 0.3;
                addonState.currentParams.rimLightStrength = 0.4;
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "💇 Long Hair",
            onClick: () => {
                addonState.currentParams.bladeHeight = 5.0;
                addonState.currentParams.bladeCurvature = 1.2;
                addonState.currentParams.bladeTwist = 0.3;
                addonState.currentParams.bladeTaper = 0.9;
                addonState.currentParams.clumpingStrength = 0.5;
                addonState.currentParams.windStrength = 1.5;
                addonState.currentParams.specularStrength = 0.6;
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🌊 Kelp/Seaweed",
            onClick: () => {
                addonState.currentParams.bladeHeight = 6.0;
                addonState.currentParams.bladeCurvature = 1.8;
                addonState.currentParams.bladeTwist = 0.5;
                addonState.currentParams.bladeTaper = 0.5;
                addonState.currentParams.windSpeed = 0.1;
                addonState.currentParams.windStrength = 3.0;
                addonState.currentParams.baseColor = [0.1, 0.2, 0.15, 1.0];
                addonState.currentParams.tipColor = [0.2, 0.5, 0.3, 1.0];
                addonState.currentParams.translucency = 0.5;
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "✨ Magical Glow",
            onClick: () => {
                addonState.currentParams.colorVariation = 0.4;
                addonState.currentParams.colorBandPosition = 0.7;
                addonState.currentParams.colorBandWidth = 0.6;
                addonState.currentParams.rimLightStrength = 1.5;
                addonState.currentParams.subsurfaceScattering = 0.8;
                addonState.currentParams.specularStrength = 0.7;
                addonState.currentParams.baseColor = [0.2, 0.1, 0.4, 1.0];
                addonState.currentParams.tipColor = [0.6, 0.3, 0.9, 1.0];
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🔥 Fire Grass",
            onClick: () => {
                addonState.currentParams.bladeCurvature = 0.8;
                addonState.currentParams.bladeTwist = 0.4;
                addonState.currentParams.windStrength = 4.0;
                addonState.currentParams.windSpeed = 2.0;
                addonState.currentParams.baseColor = [0.8, 0.2, 0.0, 1.0];
                addonState.currentParams.tipColor = [1.0, 0.9, 0.0, 1.0];
                addonState.currentParams.colorBandPosition = 0.6;
                addonState.currentParams.rimLightStrength = 1.2;
                addonState.currentParams.translucency = 0.7;
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "Reset to Defaults",
            onClick: () => {
                addonState.currentParams = {
                    id: hairParams.id,
                    gridSize: 2.0,
                    renderDistance: 50.0,
                    windStrength: 2.5,
                    windSpeed: 0.3,
                    bladeHeight: 2.75,
                    bladeWidth: 0.03,
                    brownianStrength: 0.03,
                    bladeHeightVariability: 0.6,
                    bladeDensity: 15.0,
                    landscapeSize: 100.0,
                    landscapeHeight: 0.0,
                    landscapeYOffset: 0.0,
                    baseColor: [0.1, 0.3, 0.35, 1.0],
                    tipColor: [0.2, 0.7, 0.8, 1.0],
                    pipelineId: customPipelineId,
                    bladeCurvature: 0.5,
                    bladeTwist: 0.2,
                    bladeTaper: 0.7,
                    colorVariation: 0.15,
                    colorBandPosition: 0.5,
                    colorBandWidth: 0.3,
                    specularStrength: 0.2,
                    clumpingStrength: 0.0,
                    clumpingScale: 5.0,
                    leanDirectionX: 0.0,
                    leanDirectionZ: 0.0,
                    edgeDarkening: 0.3,
                    subsurfaceScattering: 0.4,
                    translucency: 0.2,
                    rimLightStrength: 0.5,
                    ornamentsEnabled: true,
                    ornamentProbability: 0.3,
                    ornamentHeightPosition: 0.85,
                    ornamentHeightRange: 0.15,
                    ornamentSize: 0.08,
                    ornamentSizeVariation: 0.4,
                    ornamentCount: 5,
                    ornamentClusterShape: 0,
                    ornamentColor: [1.0, 0.9, 0.2, 1.0],
                    ornamentColorVariation: 0.2,
                    ornamentGlow: 0.5,
                    ornamentRotationSpeed: 0.5,
                    ornamentWeight: 0.3,
                    ornamentSpacing: 0.0,
                    ornamentInertia: 0.7
                };
                updateHair(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
                updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            }
        });
    }

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("Hair Particles with Ornaments", renderHairUI);
        if (Entropy.Composer.registerRenderer) {
            Entropy.Composer.registerRenderer("Hair Particles with Ornaments", (id: string, params: any) => {
                // updateHair(params, id);
                // updateOrnaments(params, id);
                Entropy.println("register grass " + id + " " + JSON.stringify(params));
                // updateHair({ ...params, pipelineId: customPipelineId }, id);
                // updateOrnaments({ ...params, pipelineId: ornamentPipelineId }, id);
                
                updateHair({ ...addonState.currentParams, pipelineId: customPipelineId }, id);
                updateOrnaments({ ...addonState.currentParams, pipelineId: ornamentPipelineId }, id);
            });
        }
    }

    addon.onProjectChanged((newProjectId) => {
        const data = addon.IO.load();
        if (data) {
            addonState = { ...addonState, ...data };
        }
        // updateHair({ ...addonState.currentParams, pipelineId: customPipelineId }, addonState.activeComponentId || Entropy.generateUUID());
        // updateOrnaments({ ...addonState.currentParams, pipelineId: ornamentPipelineId }, addonState.activeComponentId || Entropy.generateUUID());
    });

    // if (Entropy.Composer) {
    //     Entropy.Composer.initCallbacks["FlexNoise Terrain"] = () => {
    //         updateHair({ ...addonState.currentParams, pipelineId: customPipelineId }, addonState.activeComponentId || Entropy.generateUUID());
    //         updateOrnaments({ ...addonState.currentParams, pipelineId: ornamentPipelineId }, addonState.activeComponentId || Entropy.generateUUID());
    //     };
    // }

    const tab = addon.UI.createTab({
        title: "Hair + Ornaments",
        onRender: async () => {
            renderHairUI(tab);
        }
    });

    // --- Tools Registration ---

    const persistState = (newComponent = false) => {
        let id = addonState.activeComponentId;
        
        // persist state
        if (newComponent) {
            id = Entropy.generateUUID();

            addonState.savedComponents.push({
                id,
                name: newComponentName,
                params: JSON.parse(JSON.stringify(addonState.currentParams))
            });

            if (Entropy.Composer) {
                Entropy.Composer!.registerComponent(addonInfo.name, id, newComponentName, addonState.currentParams);
            }
        }

        // at least, save the current state
        addon.IO.save(addonState);

        return id;
    }

    addon.registerTool({
        name: "update_hair_parameters",
        description: "Update the hair/grass particle parameters.",
        parameters: {
            type: "object",
            properties: {
                baseColor: { type: "array", items: { type: "number" }, description: "RGB(A) color at the root." },
                tipColor: { type: "array", items: { type: "number" }, description: "RGB(A) color at the tip." },
                bladeDensity: { type: "number", description: "Density of blades per grid cell (1 to 100)." },
                bladeHeight: { type: "number", description: "Base height of the blades." },
                windStrength: { type: "number", description: "How much the wind affects the hair." },
                windSpeed: { type: "number", description: "How fast the wind oscillates." }
            }
        }
    }, (args: any) => {
        Entropy.println("Updating hair parameters via tool: " + JSON.stringify(args));
        let changed = false;

        if (args.baseColor) { addonState.currentParams.baseColor = args.baseColor.length === 3 ? [...args.baseColor, 1.0] : args.baseColor; changed = true; }
        if (args.tipColor) { addonState.currentParams.tipColor = args.tipColor.length === 3 ? [...args.tipColor, 1.0] : args.tipColor; changed = true; }
        if (typeof args.bladeDensity !== "undefined") { addonState.currentParams.bladeDensity = args.bladeDensity; changed = true; }
        if (typeof args.bladeHeight !== "undefined") { addonState.currentParams.bladeHeight = args.bladeHeight; changed = true; }
        if (typeof args.windStrength !== "undefined") { addonState.currentParams.windStrength = args.windStrength; changed = true; }
        if (typeof args.windSpeed !== "undefined") { addonState.currentParams.windSpeed = args.windSpeed; changed = true; }

        if (changed) {
            const id = addonState.activeComponentId || Entropy.generateUUID();
            updateHair(addonState.currentParams, id);
            updateOrnaments(addonState.currentParams, id);
            persistState();
            return { success: true, currentParams: addonState.currentParams };
        }
        return { success: false, error: "No parameters provided to update." };
    });

    addon.registerTool({
        name: "configure_ornaments",
        description: "Configure the decorative ornaments (flowers, berries, lights) attached to the hair.",
        parameters: {
            type: "object",
            properties: {
                enabled: { type: "boolean", description: "Enable or disable ornaments." },
                type: { 
                    type: "string", 
                    enum: ["flowers", "droplets", "fairy_lights", "wheat", "stardust", "berries"],
                    description: "Quickly set the ornament style."
                },
                color: { type: "array", items: { type: "number" }, description: "Color of the ornaments." },
                glow: { type: "number", description: "Intensity of the ornament glow." },
                probability: { type: "number", description: "Probability of a blade having an ornament (0 to 1)." }
            }
        }
    }, (args: any) => {
        Entropy.println("Configuring ornaments via tool: " + JSON.stringify(args));
        let changed = false;

        if (typeof args.enabled !== "undefined") { addonState.currentParams.ornamentsEnabled = args.enabled; changed = true; }

        if (args.type) {
            changed = true;
            if (args.type === "flowers") {
                addonState.currentParams.ornamentClusterShape = 2; // Ring
                addonState.currentParams.ornamentCount = 6;
                addonState.currentParams.ornamentSize = 0.12;
                addonState.currentParams.ornamentColor = [1.0, 0.85, 0.3, 1.0];
                addonState.currentParams.ornamentProbability = 0.15;
            } else if (args.type === "droplets") {
                addonState.currentParams.ornamentClusterShape = 0; // Sphere
                addonState.currentParams.ornamentCount = 1;
                addonState.currentParams.ornamentSize = 0.05;
                addonState.currentParams.ornamentColor = [0.7, 0.9, 1.0, 0.8];
                addonState.currentParams.ornamentProbability = 0.2;
            } else if (args.type === "fairy_lights") {
                addonState.currentParams.ornamentClusterShape = 0;
                addonState.currentParams.ornamentCount = 3;
                addonState.currentParams.ornamentColor = [0.9, 0.7, 1.0, 1.0];
                addonState.currentParams.ornamentGlow = 1.5;
                addonState.currentParams.ornamentProbability = 0.25;
            } else if (args.type === "wheat") {
                addonState.currentParams.ornamentClusterShape = 3; // Spiral
                addonState.currentParams.ornamentCount = 8;
                addonState.currentParams.ornamentColor = [0.9, 0.75, 0.4, 1.0];
                addonState.currentParams.ornamentProbability = 0.5;
            } else if (args.type === "stardust") {
                addonState.currentParams.ornamentClusterShape = 4; // Starburst
                addonState.currentParams.ornamentCount = 12;
                addonState.currentParams.ornamentColor = [1.0, 1.0, 0.8, 1.0];
                addonState.currentParams.ornamentGlow = 2.0;
                addonState.currentParams.ornamentProbability = 0.1;
            } else if (args.type === "berries") {
                addonState.currentParams.ornamentClusterShape = 0;
                addonState.currentParams.ornamentCount = 3;
                addonState.currentParams.ornamentColor = [0.8, 0.1, 0.15, 1.0];
                addonState.currentParams.ornamentProbability = 0.12;
            }
        }

        if (args.color) { addonState.currentParams.ornamentColor = args.color.length === 3 ? [...args.color, 1.0] : args.color; changed = true; }
        if (typeof args.glow !== "undefined") { addonState.currentParams.ornamentGlow = args.glow; changed = true; }
        if (typeof args.probability !== "undefined") { addonState.currentParams.ornamentProbability = args.probability; changed = true; }

        if (changed) {
            updateOrnaments(addonState.currentParams, addonState.activeComponentId || Entropy.generateUUID());
            persistState();
            return { success: true, ornamentParams: addonState.currentParams };
        }
        return { success: false, error: "No ornament parameters provided." };
    });

    addon.registerTool({
        name: "set_hair_preset",
        description: "Apply a pre-defined hair/grass style.",
        parameters: {
            type: "object",
            properties: {
                preset: { 
                    type: "string", 
                    enum: ["realistic", "long", "kelp", "magical", "fire"],
                    description: "The name of the preset to apply."
                }
            },
            required: ["preset"]
        }
    }, (args: any) => {
        Entropy.println("Setting hair preset via tool: " + JSON.stringify(args));
        if (args.preset === "realistic") {
            addonState.currentParams.bladeCurvature = 0.3;
            addonState.currentParams.bladeTwist = 0.1;
            addonState.currentParams.bladeTaper = 0.8;
            addonState.currentParams.colorVariation = 0.2;
            addonState.currentParams.clumpingStrength = 0.15;
            addonState.currentParams.subsurfaceScattering = 0.6;
        } else if (args.preset === "long") {
            addonState.currentParams.bladeHeight = 5.0;
            addonState.currentParams.bladeCurvature = 1.2;
            addonState.currentParams.specularStrength = 0.6;
        } else if (args.preset === "kelp") {
            addonState.currentParams.bladeHeight = 6.0;
            addonState.currentParams.baseColor = [0.1, 0.2, 0.15, 1.0];
            addonState.currentParams.tipColor = [0.2, 0.5, 0.3, 1.0];
        } else if (args.preset === "magical") {
            addonState.currentParams.rimLightStrength = 1.5;
            addonState.currentParams.baseColor = [0.2, 0.1, 0.4, 1.0];
            addonState.currentParams.tipColor = [0.6, 0.3, 0.9, 1.0];
        } else if (args.preset === "fire") {
            addonState.currentParams.windStrength = 4.0;
            addonState.currentParams.windSpeed = 2.0;
            addonState.currentParams.baseColor = [0.8, 0.2, 0.0, 1.0];
            addonState.currentParams.tipColor = [1.0, 0.9, 0.0, 1.0];
        } else {
            return { success: false, error: "Unknown preset." };
        }

        const id = addonState.activeComponentId || Entropy.generateUUID();
        updateHair(addonState.currentParams, id);
        updateOrnaments(addonState.currentParams, id);
        persistState();
        return { success: true, preset: args.preset };
    });

    addon.registerTool({
        name: "save_hair_component",
        description: "Save the current hair/grass settings as a reusable component for the Game Composer.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for this hair configuration." }
            },
            required: ["name"]
        }
    }, (args: any) => {
        const id = persistState(true);
        
        return { success: true, id: id, name: args.name, addonName: addonInfo.name };
    });
});