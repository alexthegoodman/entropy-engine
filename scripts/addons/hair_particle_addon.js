const addon = await Entropy.Addon.register({
    name: "Hair Particles",
    version: "1.1.0",
    description: "Customizable hair and grass particles with custom shaders",
    author: ["Entropy Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

let hairParams = {
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

// Example of a custom shader from JS
const customPipelineId = await Entropy.Pipeline.create({
    name: "custom_hair_shader",
    pbr: true,
    fragmentShader: `
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
            // Hot pink to electric blue gradient based on height
            let color1 = vec3<f32>(1.0, 0.0, 0.5);
            let color2 = vec3<f32>(0.0, 0.5, 1.0);
            let final_color = mix(color1, color2, in.height_factor);
            
            let ao = 0.5;

            var output: GbufferOutput;
            output.position = vec4<f32>(in.world_pos, 1.0);
            output.normal = vec4<f32>(in.normal, 1.0);
            output.albedo = vec4<f32>(final_color * ao, 1.0);
            output.pbr_material = vec4<f32>(0.0, 1.0, ao, 1.0); 
            
            return output;
        }
    `
});

function updateHair() {
    addon.Particles.createHair(hairParams);
}

Entropy.Addon.onInit(async () => {
    Entropy.println("Hair Particle Addon Initializing...");
    
    // Default to custom shader for maximum power demo!
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
                        brownianStrength: 0.03,
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