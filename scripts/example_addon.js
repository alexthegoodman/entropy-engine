// Example Entropy Addon

Entropy.Addon.register({
    name: "Cube Spawner",
    version: "1.0.0",
    description: "Spawns a cube in the scene",
    author: ["Entropy Engine Team"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

Entropy.Addon.onInit(() => {
    Entropy.println("Example Addon Initialized!");

    // Spawn a cube at the center
    Entropy.Model.createProcedural({
        type: "cube",
        parameters: {
            position: [0.0, 5.0, 0.0],
            scale: [2.0, 2.0, 2.0]
        }
    });

    Entropy.println("Cube spawned at [0, 5, 0]");
});