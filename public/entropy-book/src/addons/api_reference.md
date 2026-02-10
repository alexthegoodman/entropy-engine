# API Reference

The `Entropy` global object is the primary interface between your addon and the engine.

## Entropy.Addon

Used to manage addons and their lifecycle.

- `register(metadata: AddonMetadata): ScopedAPI`: Registers a new addon.
- `onCleanup(callback: CleanupCallback)`: Global cleanup hook.
- `setVisibility(addonName: string, visible: boolean)`: Toggles visibility of addon-owned resources.

## ScopedAPI (The `addon` object)

The object returned by `Entropy.Addon.register`.

### Lifecycle Hooks
- `onInit(callback: InitCallback)`
- `onUpdate(callback: UpdateCallback)`
- `onCleanup(callback: CleanupCallback)`
- `onProjectChanged(callback: ProjectChangedCallback)`

### Model Management
- `Model.load(config: ModelConfig)`: Load a GLB model from a path.
- `Model.createProcedural(config: ProceduralModelConfig)`: Create built-in shapes (e.g., "cube").
- `Model.createMesh(config: MeshConfig)`: Create a custom mesh from vertex and index data.

### Landscape
- `Landscape.create(config: LandscapeConfig)`: Create or update a terrain landscape.
- `Landscape.updateTexture(textureId: string, kind: LandscapeTextureKind)`: Update terrain textures (Primary, Rockmap, Soil).

### Pipeline & Shaders
- `Pipeline.create(config: PipelineConfig)`: Create a new WebGPU render pipeline.
- `Pipeline.createCompute(config: ComputePipelineConfig)`: Create a compute pipeline.

### Lighting
- `Lighting.createPointLight(config: PointLightConfig)`: Add a point light to the scene.
- `Lighting.updateSun(config: ProceduralSkyConfig)`: Update the global sun direction and color.

## Global Utilities

- `Entropy.println(msg: unknown)`: Log to the editor console.
- `Entropy.generateUUID()`: Generate a unique ID string.
- `Entropy.Texture.load(filename: string)`: Load an image as a texture.
- `Entropy.Audio.playSynth(config: SynthConfig)`: Play a sound using the built-in synthesizer.

## Agentic Tools

One of Entropy's unique features is the ability to register "Tools" that can be called by the AI agent.

```javascript
addon.registerTool({
    name: "set_time",
    description: "Set the time of day",
    parameters: {
        type: "object",
        properties: {
            time: { type: "number" }
        }
    }
}, (args) => {
    // Logic to update time
    return { success: true };
});
```
