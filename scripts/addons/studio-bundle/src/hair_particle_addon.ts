const addon = Entropy.Addon.register({
    name: "Hair Particles Enhanced",
    version: "2.0.0",
    description: "Highly customizable hair and grass particles with advanced visual parameters",
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
    
    // New visual parameters
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
    rimLightStrength: 0.5
};

// Enhanced hair vertex shader with new visual parameters
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
        
        // Apply taper - blades get thinner towards the tip
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

        // Apply curvature - blades bend naturally
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

    fn hash13(p3: vec3<f32>) -> f32 {
        var p = fract(p3 * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
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
        
        // Mix colors with variation and band
        let height_blend = in.height_factor + color_shift;
        var base_blend = mix(uniforms.base_color.rgb, uniforms.tip_color.rgb, height_blend);
        
        // Add color band effect (push towards tip color in the band region)
        base_blend = mix(base_blend, uniforms.tip_color.rgb, band_influence * 0.3);
        
        // Edge darkening - makes blades look more three-dimensional
        let edge_factor = abs(in.local_x);
        let edge_darken = 1.0 - (edge_factor * extra.edge_darkening);
        
        // Ambient occlusion based on height
        let ao = 0.6 + in.height_factor * 0.3;
        
        // Subsurface scattering simulation
        // Light penetrates through thin parts of the blade
        let subsurface = extra.subsurface_scattering * (1.0 - in.height_factor * 0.5) * extra.translucency;
        let subsurface_color = mix(base_blend, uniforms.tip_color.rgb * 1.5, subsurface);
        
        // Combine all color effects
        let final_color = subsurface_color * ao * edge_darken;
        
        // Rim lighting effect (edge highlight)
        // This would typically use view direction, but we approximate it
        let rim_fake = pow(1.0 - in.height_factor, 2.0) * extra.rim_light_strength;
        let rim_color = final_color + vec3<f32>(rim_fake * 0.3);
        
        // Specular/roughness based on parameters
        let roughness = 1.0 - (extra.specular_strength * 0.5);
        let metallic = 0.0;
        
        // Alpha for translucency
        let alpha = 1.0 - (extra.translucency * 0.3 * (1.0 - in.height_factor));

        var output: GbufferOutput;
        output.position = vec4<f32>(in.world_pos, 1.0);
        output.normal = vec4<f32>(normalize(in.normal), 1.0);
        output.albedo = vec4<f32>(rim_color, alpha);
        output.pbr_material = vec4<f32>(metallic, roughness, ao, 1.0);
        
        return output;
    }
`;

function updateHair() {
    addon.Particles.createHair({
        ...hairParams,
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

addon.onInit(async () => {
    Entropy.println("Enhanced Hair Particle Addon Initializing...");

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

    Entropy.println("Enhanced Hair Pipeline ID: " + customPipelineId);
    
    hairParams.pipelineId = customPipelineId;
    updateHair();

    // Create atmospheric lighting
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

    const tab = addon.UI.createTab({
        title: "Hair Settings Enhanced",
        onRender: async () => {
            Entropy.UI.Widget.label(tab, { text: "🌿 Advanced Hair & Grass System", bold: true });
            
            // Shader Selection
            Entropy.UI.Widget.label(tab, { text: "Shader Selection", bold: true });
            Entropy.UI.Widget.button(tab, {
                text: hairParams.pipelineId === customPipelineId ? "✅ Using Enhanced Custom Shader" : "Use Enhanced Custom Shader",
                onClick: () => {
                    hairParams.pipelineId = customPipelineId;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: hairParams.pipelineId === null ? "✅ Using Default Shader" : "Use Default Shader (Rust)",
                onClick: () => {
                    hairParams.pipelineId = null;
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
                        rimLightStrength: 0.5
                    };
                    updateHair();
                }
            });
        }
    });
});