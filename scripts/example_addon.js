// Example Entropy Addon

const addon = await Entropy.Addon.register({
    name: "Pipeline Demo",
    version: "1.0.0",
    description: "Demonstrates custom and default pipelines",
    author: ["Entropy Engine Team"],
    capabilities: {
        graphics: true
    }
});

Entropy.Addon.onInit(async () => {
    Entropy.println("Pipeline Demo Initialized!");

    // 1. Spawn a cube using the "Default Pipeline" (explicitly)
    addon.Model.createProcedural({
        type: "cube",
        pipelineId: "default",
        parameters: {
            position: [-2.0, 5.0, 0.0],
            scale: [1.0, 1.0, 1.0]
        }
    });

    // 2. Create a custom pipeline
    // This is a very simple red-tinting shader
    const customPipeline = await Entropy.Pipeline.create({
        name: "red_tint",
        fragmentShader: `
            struct FragmentOutput {
                @location(0) color0: vec4<f32>,
                @location(1) color1: vec4<f32>,
                @location(2) color2: vec4<f32>,
                @location(3) color3: vec4<f32>,
            }

            @fragment
            fn fs_main(@location(0) color: vec4<f32>) -> FragmentOutput {
                var output: FragmentOutput;
                output.color0 = vec4<f32>(1.0, 0.0, 0.0, 1.0); // Red
                output.color1 = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Empty/default
                output.color2 = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Empty/default
                output.color3 = vec4<f32>(0.0, 0.0, 0.0, 0.0); // Empty/default
                return output;
            }
        `
    });

    // 3. Spawn a cube using the custom pipeline
    addon.Model.createProcedural({
        type: "cube",
        pipelineId: customPipeline,
        parameters: {
            position: [2.0, 5.0, 0.0],
            scale: [1.0, 1.0, 1.0]
        }
    });

    Entropy.println("Spawned two cubes: one default, one red!");
});
