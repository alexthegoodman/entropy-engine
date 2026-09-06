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

Every tool registered this way is automatically exposed two ways - nothing extra to configure:

1. To the in-app WryChat panel, as before.
2. Over a local **MCP server** the engine starts by itself as soon as the editor opens, at
   `http://127.0.0.1:47100/mcp` (override the port with the `ENTROPY_MCP_PORT` env var). This
   is a standard MCP server over the Streamable HTTP transport, so any MCP client - including
   Claude Code - can connect directly to a running instance of the app and call `tools/list` /
   `tools/call` against whatever addons happen to be loaded. To hook up Claude Code:

   ```sh
   claude mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp
   ```

   The tool list always reflects whatever is currently registered, so addons don't need to do
   anything beyond calling `registerTool` as shown above.
