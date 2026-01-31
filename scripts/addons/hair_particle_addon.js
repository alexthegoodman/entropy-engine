const addon = await Entropy.Addon.register({
    name: "Hair Particles",
    version: "1.2.0",
    description: "Customizable hair and grass particles with custom shaders (VS + FS)",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let hairParams = {
    id: "main_hair",
    gridSize: 2.0,
    renderDistance: 50.0,
    windStrength: 2.5,
    windSpeed: 0.3,
    bladeHeight: 2.75,
    bladeWidth: 0.03,
    brownianStrength: 0.03,
    bladeDensity: 15.0,
    landscapeSize: 100.0,
    landscapeHeight: 0.0,
    landscapeYOffset: 0.0,
    pipelineId: null
};

// Full hair vertex shader logic provided JS-side
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
        landscape_y_offset: f32
    }
    @group(1) @binding(0)
    var<uniform> uniforms: GrassUniforms;

    @group(2) @binding(0)
    var landscape_texture: texture_2d<f32>;
    @group(2) @binding(1)
    var landscape_sampler: sampler;

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
        
        let blade_x = world_cell_x * uniforms.grid_size + random_offset.x * uniforms.grid_size;
        let blade_z = world_cell_z * uniforms.grid_size + random_offset.y * uniforms.grid_size;
        
        // Simple height for preview
        let blade_y = uniforms.landscape_y_offset;
        let terrain_normal = vec3<f32>(0.0, 1.0, 0.0);
        
        let blade_pos = vec3<f32>(blade_x, blade_y, blade_z);
        
        let blade_seed = hash13(seed);
        let blade_height_variation = 0.7 + blade_seed * 0.6;
        let blade_rotation = hash13(seed * 7.31) * 6.28318;
        
        let cos_r = cos(blade_rotation);
        let sin_r = sin(blade_rotation);
        
        var rotated_x = in.position.x * cos_r - in.position.z * sin_r;
        var rotated_z = in.position.x * sin_r + in.position.z * cos_r;
        
        let local_pos = vec3<f32>(
            rotated_x * uniforms.blade_width,
            in.position.y * uniforms.blade_height * blade_height_variation,
            rotated_z * uniforms.blade_width
        );
        
        let height_factor = in.position.y;
        let sway_phase = uniforms.time * uniforms.wind_speed * 0.3 + blade_seed * 6.28;
        let sway_amount = sin(sway_phase) * 0.5 + 0.5;
        let wind_disp = vec3<f32>(
            uniforms.wind_strength * cos(sway_phase) * height_factor * height_factor,
            0.0,
            uniforms.wind_strength * sin(sway_phase) * height_factor * height_factor
        );

        let world_position = blade_pos + local_pos + wind_disp;
        
        out.world_pos = world_position;
        out.clip_position = camera.view_proj * vec4<f32>(world_position, 1.0);
        out.height_factor = height_factor;
        out.blade_id = blade_seed;
        out.normal = terrain_normal;
        
        return out;
    }
`;

const hairFragShader = `
    struct VertexOutput {
        @builtin(position) clip_position: vec4<f32>,
        @location(0) world_pos: vec3<f32>,
        @location(1) height_factor: f32,
        @location(2) blade_id: f32,
        @location(3) normal: vec3<f32>,
    };

    struct GbufferOutput {
        @location(0) position: vec4<f32>,
        @location(1) normal: vec4<f32>,
        @location(2) albedo: vec4<f32>,
        @location(3) pbr_material: vec4<f32>,
    }

    @fragment
    fn fs_main(in: VertexOutput) -> GbufferOutput {
        // Neon cyan to deep purple based on height and time variation
        let color1 = vec3<f32>(0.0, 1.0, 1.0);
        let color2 = vec3<f32>(0.5, 0.0, 1.0);
        let final_color = mix(color1, color2, in.height_factor);
        
        let ao = 0.4 + in.height_factor * 0.2;

        var output: GbufferOutput;
        output.position = vec4<f32>(in.world_pos, 1.0);
        output.normal = vec4<f32>(in.normal, 1.0);
        output.albedo = vec4<f32>(final_color * ao, 1.0);
        output.pbr_material = vec4<f32>(0.0, 1.0, ao, 1.0); 
        
        return output;
    }
`;

function updateHair() {
    addon.Particles.createHair(hairParams);
}

Entropy.Addon.onInit(async () => {
    Entropy.println("Hair Particle Addon Initializing...");

    const customPipelineId = Entropy.Pipeline.create({
        name: "custom_hair_shader",
        layout: "hair", // Specialized hair layout
        pbr: true,
        vertexShader: hairVertexShader,
        fragmentShader: hairFragShader
    });

    Entropy.println("Hair Pipeline ID: " + customPipelineId);
    
    hairParams.pipelineId = customPipelineId;
    updateHair();

    const tab = Entropy.UI.createTab({
        title: "Hair Settings",
        onRender: async () => {
            Entropy.UI.Widget.label(tab, { text: "Hair & Grass Customization", bold: true });
            
            Entropy.UI.Widget.label(tab, { text: "Shader Selection", bold: true });
            Entropy.UI.Widget.button(tab, {
                text: hairParams.pipelineId === customPipelineId ? "✅ Using Custom Shader" : "Use Custom Shader (JS)",
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

            Entropy.UI.Widget.label(tab, { text: "Physical Properties", bold: true });
            Entropy.UI.Widget.label(tab, `Density: ${hairParams.bladeDensity}`);
            Entropy.UI.Widget.button(tab, {
                text: "Increase Density",
                onClick: () => {
                    hairParams.bladeDensity += 5;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: "Decrease Density",
                onClick: () => {
                    hairParams.bladeDensity = Math.max(1, hairParams.bladeDensity - 5);
                    updateHair();
                }
            });

            Entropy.UI.Widget.label(tab, `Height: ${hairParams.bladeHeight.toFixed(2)}`);
            Entropy.UI.Widget.button(tab, {
                text: "Taller",
                onClick: () => {
                    hairParams.bladeHeight += 0.25;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: "Shorter",
                onClick: () => {
                    hairParams.bladeHeight = Math.max(0.1, hairParams.bladeHeight - 0.25);
                    updateHair();
                }
            });

            Entropy.UI.Widget.label(tab, { text: "Environment", bold: true });
            Entropy.UI.Widget.label(tab, `Wind Strength: ${hairParams.windStrength.toFixed(2)}`);
            Entropy.UI.Widget.button(tab, {
                text: "Stronger Wind",
                onClick: () => {
                    hairParams.windStrength += 0.5;
                    updateHair();
                }
            });
            Entropy.UI.Widget.button(tab, {
                text: "Calmer Wind",
                onClick: () => {
                    hairParams.windStrength = Math.max(0, hairParams.windStrength - 0.5);
                    updateHair();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "Reset to Defaults",
                onClick: () => {
                    hairParams = {
                        gridSize: 2.0,
                        renderDistance: 50.0,
                        windStrength: 2.5,
                        windSpeed: 0.3,
                        bladeHeight: 2.75,
                        bladeWidth: 0.03,
                        brownian_strength: 0.03,
                        bladeDensity: 15.0,
                        landscapeSize: 100.0,
                        landscapeHeight: 0.0,
                        landscapeYOffset: 0.0,
                        pipelineId: customPipelineId
                    };
                    updateHair();
                }
            });
        }
    });
});
