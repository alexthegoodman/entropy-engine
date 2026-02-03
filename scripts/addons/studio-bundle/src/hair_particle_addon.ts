const addon = Entropy.Addon.register({
    name: "Hair Particles with Ornaments",
    version: "3.0.0",
    description: "Highly customizable hair and grass particles with decorative ornament clusters",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

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
    landscapeSize: 100.0,
    landscapeHeight: 0.0,
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

// Enhanced vertex shader with ornament support
const hairVertexShader = `
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
        @location(1) tex_coords: vec2<f32>,
        @location(2) normal: vec3<f32>,
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
        
        let blade_y = uniforms.landscape_y_offset;
        let terrain_normal = vec3<f32>(0.0, 1.0, 0.0);
        
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
        let lean_disp = vec3<f32>(
            uniforms.player_pos_x * clamped_height * clamped_height, // Wait, lean_direction was missing? Using player_pos_x as placeholder if so
            0.0,
            uniforms.player_pos_z * clamped_height * clamped_height
        );
        // Let me re-check fields. uniforms.lean_direction_x/z should be there.
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
        // let orb_seed = hash33(vec3<f32>(f32(blade_index), f32(orb_in_cluster), time_uniform.time * 0.1));
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
        // let rotation_angle = 3.14;
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

function updateHair() {
    addon.Particles.createHair({
        ...hairParams,
        renderRole: "Vegetation",
        base_color: hairParams.baseColor,
        tip_color: hairParams.tipColor,
        bindings: [
            {
                group: 3,
                binding: 0,
                resource: {
                    type: "Uniform",
                    value: { data: [
                        hairParams.bladeHeightVariability,
                        hairParams.bladeCurvature,
                        hairParams.bladeTwist,
                        hairParams.bladeTaper,
                        
                        hairParams.colorVariation,
                        hairParams.colorBandPosition,
                        hairParams.colorBandWidth,
                        hairParams.specularStrength,
                        
                        hairParams.clumpingStrength,
                        hairParams.clumpingScale,
                        hairParams.leanDirectionX,
                        hairParams.leanDirectionZ,
                        
                        hairParams.edgeDarkening,
                        hairParams.subsurfaceScattering,
                        hairParams.translucency,
                        hairParams.rimLightStrength
                    ] }
                }
            }
        ]
    });
}

let ornamentMeshId: string | null = null;
let ornamentPipelineId: string | null = null;

function updateOrnaments() {
    if (!hairParams.ornamentsEnabled) {
        addon.Model.clearMeshes();
        return;
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

    // Generate indices (unchanged)
    for (let lat = 0; lat < segments; lat++) {
        for (let lon = 0; lon < segments; lon++) {
            const first = lat * (segments + 1) + lon;
            const second = first + segments + 1;

            sphereIndices.push(first, second, first + 1);
            sphereIndices.push(second, second + 1, first + 1);
        }
    }

    // Calculate instance count
    const gridCells = Math.ceil((hairParams.renderDistance * 2.0) / hairParams.gridSize);
    const totalBlades = gridCells * gridCells * hairParams.bladeDensity;
    const ornamentInstances = Math.floor(totalBlades * hairParams.ornamentProbability * hairParams.ornamentCount);

    // Create instanced mesh (this is pseudocode - adapt to your engine's API)
    // Create instanced mesh
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
                            0, // player_pos_x (reserved/placeholder)
                            0, // player_pos_z (reserved/placeholder)
                            hairParams.gridSize,
                            hairParams.renderDistance,
                            hairParams.bladeDensity,
                            hairParams.bladeHeight,
                            hairParams.windStrength,
                            hairParams.windSpeed,
                            hairParams.ornamentSize,
                            hairParams.ornamentSizeVariation,
                            hairParams.ornamentHeightPosition,
                            hairParams.ornamentHeightRange,
                            hairParams.ornamentProbability,
                            hairParams.ornamentCount,
                            hairParams.ornamentClusterShape,
                            hairParams.ornamentRotationSpeed,
                            hairParams.ornamentWeight,
                            hairParams.ornamentInertia,
                            hairParams.bladeCurvature,
                            hairParams.bladeHeightVariability,
                            hairParams.leanDirectionX,
                            hairParams.leanDirectionZ,
                            hairParams.landscapeYOffset,
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
                            ...hairParams.ornamentColor,
                            hairParams.ornamentColorVariation,
                            hairParams.ornamentGlow,
                            0, 0 // padding
                        ]
                    }
                }
            }
        ]
    };

    if (ornamentPipelineId) {
        // Clear old ornaments
        addon.Model.clearMeshes();

        // Create instanced mesh
        addon.Model.createMesh({
            vertexData: Array.from(sphereVertices),
            indexData: Array.from(sphereIndices),
            instanceCount: ornamentInstances,
            pipelineId: ornamentPipelineId,
            position: [0, 0, 0],
            bindings: ornamentData.bindings
        });
        
        Entropy.println(`Ornaments updated: ${ornamentInstances} orbs across ${Math.floor(totalBlades * hairParams.ornamentProbability)} clusters`);
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
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" }
                ]
            }
        ]
    });

    // Create ornament pipeline
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

    Entropy.println("Hair Pipeline ID: " + customPipelineId);
    Entropy.println("Ornament Pipeline ID: " + ornamentPipelineId);
    
    hairParams.pipelineId = customPipelineId;
    updateHair();
    updateOrnaments();

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
        Entropy.UI.Widget.label(tab, { text: "🌸 Hair & Grass with Ornaments", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "💾 Save Settings",
            onClick: () => {
                addon.IO.save(hairParams);
                Entropy.println("Hair settings saved!");
            }
        });

        // === ORNAMENT CONTROLS ===
        Entropy.UI.Widget.label(tab, { text: "💎 Ornament System", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: hairParams.ornamentsEnabled ? "✅ Ornaments Enabled" : "❌ Ornaments Disabled",
            onClick: () => {
                hairParams.ornamentsEnabled = !hairParams.ornamentsEnabled;
                updateOrnaments();
            }
        });

        if (hairParams.ornamentsEnabled) {
            Entropy.UI.Widget.label(tab, { text: "Cluster Shape", bold: false });
            const shapes = ["Sphere", "Hemisphere", "Ring", "Spiral", "Starburst"];
            Entropy.UI.Widget.button(tab, {
                text: `Shape: ${shapes[hairParams.ornamentClusterShape]}`,
                onClick: () => {
                    hairParams.ornamentClusterShape = (hairParams.ornamentClusterShape + 1) % shapes.length;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Probability (Coverage)",
                value: hairParams.ornamentProbability,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    hairParams.ornamentProbability = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Orbs per Cluster",
                value: hairParams.ornamentCount,
                min: 1,
                max: 20,
                onChange: (val: string) => {
                    hairParams.ornamentCount = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Height Position",
                value: hairParams.ornamentHeightPosition,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    hairParams.ornamentHeightPosition = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Height Range (Spread)",
                value: hairParams.ornamentHeightRange,
                min: 0.0,
                max: 0.5,
                onChange: (val: string) => {
                    hairParams.ornamentHeightRange = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Ornament Size",
                value: hairParams.ornamentSize,
                min: 0.01,
                max: 0.5,
                onChange: (val: string) => {
                    hairParams.ornamentSize = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Size Variation",
                value: hairParams.ornamentSizeVariation,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    hairParams.ornamentSizeVariation = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.colorInput(tab, {
                label: "Ornament Color",
                color: hairParams.ornamentColor,
                onChange: (newColor: number[]) => {
                    hairParams.ornamentColor = newColor;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Color Variation",
                value: hairParams.ornamentColorVariation,
                min: 0.0,
                max: 1.0,
                onChange: (val: string) => {
                    hairParams.ornamentColorVariation = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Glow Intensity",
                value: hairParams.ornamentGlow,
                min: 0.0,
                max: 2.0,
                onChange: (val: string) => {
                    hairParams.ornamentGlow = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Rotation Speed",
                value: hairParams.ornamentRotationSpeed,
                min: 0.0,
                max: 3.0,
                onChange: (val: string) => {
                    hairParams.ornamentRotationSpeed = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Weight (Blade Pull)",
                value: hairParams.ornamentWeight,
                min: 0.0,
                max: 2.0,
                onChange: (val: string) => {
                    hairParams.ornamentWeight = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Inertia (Lag)",
                value: hairParams.ornamentInertia,
                min: 0.0,
                max: 2.0,
                onChange: (val: string) => {
                    hairParams.ornamentInertia = parseFloat(val);
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.label(tab, { text: "Quick Ornament Presets", bold: false });
            
            Entropy.UI.Widget.button(tab, {
                text: "🌼 Wildflowers",
                onClick: () => {
                    hairParams.ornamentClusterShape = 2; // Ring
                    hairParams.ornamentCount = 6;
                    hairParams.ornamentSize = 0.12;
                    hairParams.ornamentHeightPosition = 0.9;
                    hairParams.ornamentHeightRange = 0.1;
                    hairParams.ornamentColor = [1.0, 0.85, 0.3, 1.0];
                    hairParams.ornamentGlow = 0.3;
                    hairParams.ornamentProbability = 0.15;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "💧 Water Droplets",
                onClick: () => {
                    hairParams.ornamentClusterShape = 0; // Sphere
                    hairParams.ornamentCount = 1;
                    hairParams.ornamentSize = 0.05;
                    hairParams.ornamentHeightPosition = 0.6;
                    hairParams.ornamentHeightRange = 0.4;
                    hairParams.ornamentColor = [0.7, 0.9, 1.0, 0.8];
                    hairParams.ornamentGlow = 0.6;
                    hairParams.ornamentProbability = 0.2;
                    hairParams.ornamentWeight = 0.5;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🔮 Fairy Lights",
                onClick: () => {
                    hairParams.ornamentClusterShape = 0; // Sphere
                    hairParams.ornamentCount = 3;
                    hairParams.ornamentSize = 0.06;
                    hairParams.ornamentHeightPosition = 0.7;
                    hairParams.ornamentHeightRange = 0.3;
                    hairParams.ornamentColor = [0.9, 0.7, 1.0, 1.0];
                    hairParams.ornamentGlow = 1.5;
                    hairParams.ornamentProbability = 0.25;
                    hairParams.ornamentRotationSpeed = 1.5;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🌾 Wheat Grains",
                onClick: () => {
                    hairParams.ornamentClusterShape = 3; // Spiral
                    hairParams.ornamentCount = 8;
                    hairParams.ornamentSize = 0.04;
                    hairParams.ornamentHeightPosition = 0.95;
                    hairParams.ornamentHeightRange = 0.05;
                    hairParams.ornamentColor = [0.9, 0.75, 0.4, 1.0];
                    hairParams.ornamentGlow = 0.1;
                    hairParams.ornamentProbability = 0.5;
                    hairParams.ornamentWeight = 0.8;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "✨ Stardust",
                onClick: () => {
                    hairParams.ornamentClusterShape = 4; // Starburst
                    hairParams.ornamentCount = 12;
                    hairParams.ornamentSize = 0.03;
                    hairParams.ornamentHeightPosition = 0.85;
                    hairParams.ornamentHeightRange = 0.2;
                    hairParams.ornamentColor = [1.0, 1.0, 0.8, 1.0];
                    hairParams.ornamentGlow = 2.0;
                    hairParams.ornamentProbability = 0.1;
                    hairParams.ornamentRotationSpeed = 2.5;
                    updateOrnaments();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🍒 Berries",
                onClick: () => {
                    hairParams.ornamentClusterShape = 0; // Sphere
                    hairParams.ornamentCount = 3;
                    hairParams.ornamentSize = 0.08;
                    hairParams.ornamentHeightPosition = 0.75;
                    hairParams.ornamentHeightRange = 0.15;
                    hairParams.ornamentColor = [0.8, 0.1, 0.15, 1.0];
                    hairParams.ornamentGlow = 0.2;
                    hairParams.ornamentProbability = 0.12;
                    hairParams.ornamentWeight = 1.2;
                    updateOrnaments();
                }
            });
        }

        // === SHADER SELECTION ===
        Entropy.UI.Widget.label(tab, { text: "Shader Selection", bold: true });
        Entropy.UI.Widget.button(tab, {
            text: hairParams.pipelineId === customPipelineId ? "✅ Using Custom Shader" : "Use Custom Shader",
            onClick: () => {
                hairParams.pipelineId = customPipelineId;
                updateHair();
            }
        });

        // Colors Section
        Entropy.UI.Widget.label(tab, { text: "🎨 Color Settings", bold: true });
        Entropy.UI.Widget.colorInput(tab, {
            label: "Base Color",
            color: hairParams.baseColor,
            onChange: (newColor: number[]) => {
                hairParams.baseColor = newColor;
                updateHair();
            }
        });

        Entropy.UI.Widget.colorInput(tab, {
            label: "Tip Color",
            color: hairParams.tipColor,
            onChange: (newColor: number[]) => {
                hairParams.tipColor = newColor;
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Color Variation",
            value: hairParams.colorVariation,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.colorVariation = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Color Band Position",
            value: hairParams.colorBandPosition,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.colorBandPosition = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Color Band Width",
            value: hairParams.colorBandWidth,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.colorBandWidth = parseFloat(val);
                updateHair();
            }
        });

        // Shape & Form Section
        Entropy.UI.Widget.label(tab, { text: "📐 Shape & Form", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Blade Curvature",
            value: hairParams.bladeCurvature,
            min: 0.0,
            max: 2.0,
            onChange: (val: string) => {
                hairParams.bladeCurvature = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Blade Twist",
            value: hairParams.bladeTwist,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.bladeTwist = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Blade Taper",
            value: hairParams.bladeTaper,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.bladeTaper = parseFloat(val);
                updateHair();
            }
        });

        // Physical Properties
        Entropy.UI.Widget.label(tab, { text: "⚙️ Physical Properties", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Density",
            value: hairParams.bladeDensity,
            min: 1.0,
            max: 100.0,
            onChange: (val: string) => {
                hairParams.bladeDensity = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Height",
            value: hairParams.bladeHeight,
            min: 0.1,
            max: 10.0,
            onChange: (val: string) => {
                hairParams.bladeHeight = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Height Variability",
            value: hairParams.bladeHeightVariability,
            min: 0.0,
            max: 2.0,
            onChange: (val: string) => {
                hairParams.bladeHeightVariability = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Width",
            value: hairParams.bladeWidth,
            min: 0.001,
            max: 0.5,
            onChange: (val: string) => {
                hairParams.bladeWidth = parseFloat(val);
                updateHair();
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
                hairParams.clumpingStrength = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Clumping Scale",
            value: hairParams.clumpingScale,
            min: 1.0,
            max: 20.0,
            onChange: (val: string) => {
                hairParams.clumpingScale = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lean Direction X",
            value: hairParams.leanDirectionX,
            min: -2.0,
            max: 2.0,
            onChange: (val: string) => {
                hairParams.leanDirectionX = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lean Direction Z",
            value: hairParams.leanDirectionZ,
            min: -2.0,
            max: 2.0,
            onChange: (val: string) => {
                hairParams.leanDirectionZ = parseFloat(val);
                updateHair();
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
                hairParams.specularStrength = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Edge Darkening",
            value: hairParams.edgeDarkening,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.edgeDarkening = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Subsurface Scattering",
            value: hairParams.subsurfaceScattering,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.subsurfaceScattering = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Translucency",
            value: hairParams.translucency,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                hairParams.translucency = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Rim Light Strength",
            value: hairParams.rimLightStrength,
            min: 0.0,
            max: 2.0,
            onChange: (val: string) => {
                hairParams.rimLightStrength = parseFloat(val);
                updateHair();
            }
        });

        // Environment
        Entropy.UI.Widget.label(tab, { text: "🌬️ Environment", bold: true });
        
        Entropy.UI.Widget.slider(tab, {
            label: "Wind Strength",
            value: hairParams.windStrength,
            min: 0.0,
            max: 10.0,
            onChange: (val: string) => {
                hairParams.windStrength = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Wind Speed",
            value: hairParams.windSpeed,
            min: 0.0,
            max: 5.0,
            onChange: (val: string) => {
                hairParams.windSpeed = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Brownian Strength",
            value: hairParams.brownianStrength,
            min: 0.0,
            max: 0.5,
            onChange: (val: string) => {
                hairParams.brownianStrength = parseFloat(val);
                updateHair();
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
                hairParams.gridSize = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Render Distance",
            value: hairParams.renderDistance,
            min: 10.0,
            max: 500.0,
            onChange: (val: string) => {
                hairParams.renderDistance = parseFloat(val);
                updateHair();
            }
        });

        Entropy.UI.Widget.numericInput(tab, {
            label: "Landscape Y Offset",
            value: hairParams.landscapeYOffset,
            onChange: (val: string) => {
                hairParams.landscapeYOffset = parseFloat(val);
                updateHair();
            }
        });

        // Presets
        Entropy.UI.Widget.label(tab, { text: "🎭 Presets", bold: true });

        Entropy.UI.Widget.button(tab, {
            text: "🌾 Realistic Grass",
            onClick: () => {
                hairParams.bladeCurvature = 0.3;
                hairParams.bladeTwist = 0.1;
                hairParams.bladeTaper = 0.8;
                hairParams.colorVariation = 0.2;
                hairParams.clumpingStrength = 0.15;
                hairParams.subsurfaceScattering = 0.6;
                hairParams.translucency = 0.3;
                hairParams.rimLightStrength = 0.4;
                updateHair();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "💇 Long Hair",
            onClick: () => {
                hairParams.bladeHeight = 5.0;
                hairParams.bladeCurvature = 1.2;
                hairParams.bladeTwist = 0.3;
                hairParams.bladeTaper = 0.9;
                hairParams.clumpingStrength = 0.5;
                hairParams.windStrength = 1.5;
                hairParams.specularStrength = 0.6;
                updateHair();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🌊 Kelp/Seaweed",
            onClick: () => {
                hairParams.bladeHeight = 6.0;
                hairParams.bladeCurvature = 1.8;
                hairParams.bladeTwist = 0.5;
                hairParams.bladeTaper = 0.5;
                hairParams.windSpeed = 0.1;
                hairParams.windStrength = 3.0;
                hairParams.baseColor = [0.1, 0.2, 0.15, 1.0];
                hairParams.tipColor = [0.2, 0.5, 0.3, 1.0];
                hairParams.translucency = 0.5;
                updateHair();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "✨ Magical Glow",
            onClick: () => {
                hairParams.colorVariation = 0.4;
                hairParams.colorBandPosition = 0.7;
                hairParams.colorBandWidth = 0.6;
                hairParams.rimLightStrength = 1.5;
                hairParams.subsurfaceScattering = 0.8;
                hairParams.specularStrength = 0.7;
                hairParams.baseColor = [0.2, 0.1, 0.4, 1.0];
                hairParams.tipColor = [0.6, 0.3, 0.9, 1.0];
                updateHair();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🔥 Fire Grass",
            onClick: () => {
                hairParams.bladeCurvature = 0.8;
                hairParams.bladeTwist = 0.4;
                hairParams.windStrength = 4.0;
                hairParams.windSpeed = 2.0;
                hairParams.baseColor = [0.8, 0.2, 0.0, 1.0];
                hairParams.tipColor = [1.0, 0.9, 0.0, 1.0];
                hairParams.colorBandPosition = 0.6;
                hairParams.rimLightStrength = 1.2;
                hairParams.translucency = 0.7;
                updateHair();
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "Reset to Defaults",
            onClick: () => {
                hairParams = {
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
                updateHair();
                updateOrnaments();
            }
        });
    }

    if (Entropy.Composer) {
        Entropy.Composer.registerEditor("Hair Particles with Ornaments", renderHairUI);
    }

    // Try load saved data
    // const savedData = addon.IO.load();
    // if (savedData) {
    //     hairParams = { ...hairParams, ...savedData };
    //     // Ensure colors are arrays if JSON parsed them differently (usually fine)
    //     Entropy.println("Loaded saved hair settings");
    // }

    addon.onProjectChanged((newProjectId) => {
        Entropy.println("Project changed: " + newProjectId);

        // Reload addon state for new project
        const data = addon.IO.load(); // Will load from new project
        // Re-initialize your addon's state
        hairParams = { ...hairParams, ...data };

        updateHair();
        updateOrnaments();

        Entropy.println("ReLoaded saved hair settings");
    });

    const tab = addon.UI.createTab({
        title: "Hair + Ornaments",
        onRender: async () => {
            renderHairUI(tab);
        }
    });
});