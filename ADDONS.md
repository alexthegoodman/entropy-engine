# Entropy Addons

Entropy Addons will be JavaScript bundles which leverage our API via Deno integration for managing Rust-side resources including graphics pipelines, 3D models, buffers,
and other crucial components. Heavy data will never be passed into the JavaScript context - the JavaScript context will simply orchestrate the Rust-side resources.

Addons have the powerful benefit of bundling NPM modules to manage native Rust code, creating a powerful combination. Deno processes JavaScript very quickly,
so there is little performance overhead in most cases. wgpu is used on the Rust side, providing a convenient compatability layer.

Entropy Addons must abide by some UX requirements, including:

- Register graphical pipelines via a special API which enables interoperability with other addons
- Register semantic handlers for all of the functionality enabled by your UI or more
- Do not require 3rd party accounts for addon users (there will be an API key automatically provided to each addon for each user so that the addon can associate data)

The Addon API will include egui abstractions which enable the JavaScript addon developer to create egui windows on the Rust side, for example. Or use rfd via the JavaScript API
so the user can select files. Or even the Windows Foundation API, thanks to all resources being manged Rust-side.

We never want state or anything React-like. Let's keep it immediate mode.

## Entropy Addons API

A powerful JavaScript API for managing Rust-side graphics resources via Deno integration. Here are most of the features it should have early on.

### Design Philosophy

The Entropy Addons API follows these core principles:

1. **Heavy data stays in Rust** - JavaScript only orchestrates resources via handles
2. **Interoperability first** - Semantic handler registration enables addon collaboration
3. **No third-party accounts** - Each user gets an automatic API key per addon
4. **Performance** - Deno provides minimal overhead for resource orchestration
5. **wgpu compatibility** - Works seamlessly with the Rust graphics backend

### Core Modules

#### 1. Pipeline Management

Create and manage graphics pipelines for rendering:

```javascript
const pipelineId = await Entropy.Pipeline.create({
  name: "my_pipeline",
  vertexShader: "shaders/vertex.wgsl", // or include the shader code directly in the JavaScript?
  fragmentShader: "shaders/fragment.wgsl",
  vertexLayout: [
    // fetch supported vertex layouts?
    { attribute: "position", format: "float3" }, // auto-calculate the offset
    { attribute: "color", format: "float4" }
  ],
  blendState: {
    enabled: true,
    srcFactor: "SrcAlpha",
    dstFactor: "One"
  }
});
```

#### 2. Model Management

Load and manage 3D models on the Rust side:

```javascript
// Load from file
const modelId = await Entropy.Model.load({
  path: "models/character.gltf",
  format: "gltf",
  options: {
    scale: [1, 1, 1],
    rotation: [0, 0, 0]
    // add option to specify vertex layout used?
  }
});

// Create procedural geometry
const cubeId = await Entropy.Model.createProcedural({
  type: "cube",
  parameters: {
    size: 2.0
    // add option to specify vertex layout used?
  }
});
```

#### 3. Buffer Management

Create and manage GPU buffers:

```javascript
const buffer = await Entropy.Buffer.create({
  type: "vertex", // also will need uniforms
  size: 4096,
  dynamic: true
});

// Write data 
// data source is Rust-side in this case, but can be JS side. 
// We just want to avoid sending heavy data from Rust into the JS
await Entropy.Buffer.write(buffer, {
  dataSource: rustDataHandle,
  offset: 0
});
```

#### 4. Texture Management

Load and create textures:

```javascript
const textureId = await Entropy.Texture.load({
  path: "textures/diffuse.png",
  options: {
    mipmap: true,
    format: "RGBA8"
  }
});
```

#### 5. Semantic Handler Registration

Register handlers to enable interoperability between addons:

```javascript
await Entropy.Handler.register({
  name: "apply_post_process",
  category: "post_processing",
  schema: {
    input: {
      textureId: "string",
      intensity: "float"
    },
    output: {
      processedTextureId: "string"
    }
  },
  handler: async (input) => {
    // Your processing logic
    return { processedTextureId: newTextureId };
  }
});

// Query and invoke other handlers
const handlers = await Entropy.Handler.query({ category: "post_processing" });
const result = await Entropy.Handler.invoke("apply_post_process", {
  textureId: myTexture,
  intensity: 0.5
});
```

#### 6. egui UI Integration

Create native UI windows with egui:

```javascript
const windowId = await Entropy.UI.createWindow({
  title: "My Addon Controls",
  resizable: true,
  defaultSize: { width: 400, height: 300 },
  onRender: async (ctx) => {
    await Entropy.UI.Widget.label(windowId, {
      text: "Settings",
      bold: true
    });

    await Entropy.UI.Widget.slider(windowId, {
      label: "Intensity",
      min: 0,
      max: 1,
      value: 0.5,
      onChange: async (value) => {
        // Handle change
      }
    });

    await Entropy.UI.Widget.button(windowId, {
      text: "Apply",
      onClick: async () => {
        // Handle click
      }
    });
  }
});
```

#### 7. User Data Management

Store user-specific data with automatic API keys:

```javascript
// Get user's API key for this addon
const apiKey = await Entropy.User.getApiKey();

// Store preferences
await Entropy.User.setData("settings", {
  quality: "high",
  enabled: true
});

// Retrieve preferences
const settings = await Entropy.User.getData("settings");
```

## Addon Lifecycle

Every addon should register metadata and lifecycle hooks:

```javascript
// Register addon
await Entropy.Addon.register({
  name: "My Addon",
  version: "1.0.0",
  description: "Does something cool",
  author: ["Your Name"],
  capabilities: {
    graphics: true,
    compute: false,
    ui: true
  }
});

// Initialize
Entropy.Addon.onInit(async () => {
  // Setup resources
  console.log("Addon initialized");
});

// Cleanup
Entropy.Addon.onCleanup(async () => {
  // Release resources
  console.log("Addon cleaned up");
});
```

### UX Requirements

All addons must:

1. ✅ **Register pipelines** via the Pipeline API for interoperability
2. ✅ **Register semantic handlers** for all functionality
3. ✅ **Use automatic API keys** - no third-party accounts required
4. ✅ **Keep heavy data in Rust** - only pass handles in JavaScript

### Performance Considerations

- **Handles only**: JavaScript operates on string handles, not data
- **Batch operations**: Group related operations to minimize JS ↔ Rust calls
- **Async by default**: All operations are async to prevent blocking
- **Deno overhead**: Minimal - Deno is fast for orchestration tasks

### Interoperability Example

Addon A provides a post-processing effect:

```javascript
// Addon A
await Entropy.Handler.register({
  name: "bloom_effect",
  category: "post_processing",
  schema: {
    input: { textureId: "string", threshold: "float" },
    output: { textureId: "string" }
  },
  handler: async (input) => {
    // Apply bloom
    return { textureId: bloomTextureId };
  }
});
```

Addon B uses it:

```javascript
// Addon B
const postProcessHandlers = await Entropy.Handler.query({
  category: "post_processing"
});

const result = await Entropy.Handler.invoke("bloom_effect", {
  textureId: mySceneTexture,
  threshold: 0.8
});
```

### wgpu Integration

The API is designed to work seamlessly with wgpu on the Rust side:

- Pipeline creation maps to wgpu render pipelines
- Buffers map to wgpu buffer resources
- Textures map to wgpu texture resources
- All heavy lifting happens in Rust via wgpu

### TypeScript Definitions

For better developer experience, TypeScript definitions should be provided:

```typescript
declare namespace Entropy {
  namespace Pipeline {
    function create(config: PipelineConfig): Promise<string>;
    function update(id: string, updates: Partial<PipelineConfig>): Promise<boolean>;
    function destroy(id: string): Promise<boolean>;
  }
  
  // ... etc
}
```

### Example Use Cases

1. **Particle Systems** - Manage particle buffers and rendering
2. **Post-Processing** - Chain effects via semantic handlers
3. **Custom Shaders** - Load and apply shader pipelines
4. **Procedural Generation** - Generate meshes and textures
5. **Animation Systems** - Update model transforms over time
6. **Level Editors** - UI for scene manipulation

### Best Practices

1. **Resource cleanup**: Always destroy resources in cleanup hooks
2. **Error handling**: Wrap Rust ops in try-catch blocks
3. **Schema validation**: Define clear handler schemas
4. **Documentation**: Document your semantic handlers
5. **Testing**: Test interoperability with mock handlers

### Future Considerations

- **Compute shaders**: Add compute pipeline support
- **Ray tracing**: RT pipeline integration
- **Audio**: Audio buffer management
- **Networking**: Multi-user synchronization
- **Asset streaming**: Progressive loading APIs

## Essential Libraries to Expose for App-Like Addons

Physics & Simulation
NOTE: for Physics, we want to hold off on giving complete control of rigidbodies. We want to provide a physics config to the landscape or
to the model when created, but let the rest be automatic for now. Later we will add deep control.
javascript// Rapier3D (Rust physics engine)
```
const rigidBodyId = await addon.Physics.createRigidBody({
    type: "dynamic",
    position: [0, 10, 0],
    collider: { type: "cuboid", halfExtents: [1, 1, 1] }
});

await addon.Physics.applyImpulse(rigidBodyId, [0, 100, 0]);
await addon.Physics.onCollision(rigidBodyId, (otherBodyId) => { /* ... */ });
```
Audio
javascript// Rodio or similar (Rust audio)
```
const soundId = await addon.Audio.loadSound("assets/explosion.wav");
const sourceId = await addon.Audio.play(soundId, {
    volume: 0.8,
    looping: false,
    spatial: { position: [10, 0, 5] }
});

// For music/DAW features
const trackId = await addon.Audio.createTrack({
    bpm: 120,
    timeSignature: [4, 4]
});
```
Animation
javascript// Skeletal animation (via ozz-animation or similar)
```
const animId = await addon.Animation.load("assets/character_walk.gltf");
const instanceId = await addon.Animation.createInstance(animId);

await addon.Animation.play(instanceId, {
    speed: 1.0,
    blendTime: 0.2,
    loop: true
});

// Procedural animation
const curveId = await addon.Animation.createCurve({
    keyframes: [[0, 0], [1, 10], [2, 0]],
    interpolation: "cubic"
});
```
Particle Systems
javascript
```
const particleSystemId = await addon.Particles.create({
    maxParticles: 1000,
    emissionRate: 50,
    lifetime: [2.0, 3.0],
    velocity: { min: [-1, 2, -1], max: [1, 5, 1] },
    pipelineId: "fire_shader"
});

await addon.Particles.burst(particleSystemId, 100);
Image Processing (for video/photo editors)
```
javascript
```
// image-rs or similar
const imageId = await addon.Image.load("photo.jpg");

const blurredId = await addon.Image.gaussianBlur(imageId, 5.0);
const adjustedId = await addon.Image.adjustLevels(imageId, {
    brightness: 1.2,
    contrast: 1.1,
    saturation: 0.9
});

await addon.Image.extractNormals(imageId); // Your video lighting idea!
```
Text Rendering & Typography
javascript
```
// cosmic-text or rusttype
const fontId = await addon.Text.loadFont("assets/Roboto-Regular.ttf");
const textId = await addon.Text.create({
    content: "Hello World",
    fontId: fontId,
    fontSize: 24,
    color: [1, 1, 1, 1],
    position: [100, 100]
});

// For advanced layout
const layoutId = await addon.Text.createLayout({
    width: 300,
    alignment: "justify",
    lineHeight: 1.5
});

```
Navigation & Pathfinding
javascript
```
// recast-rs or similar
const navMeshId = await addon.Navigation.buildFromTerrain(terrainId);

const pathId = await addon.Navigation.findPath(
    navMeshId,
    [0, 0, 0],  // start
    [50, 0, 50] // end
);

const waypoints = await addon.Navigation.getWaypoints(pathId);
Asset Management
```
javascript
```
// Asset hot-reloading, bundles
const bundleId = await addon.Assets.createBundle("level_1");

await addon.Assets.preload(bundleId, [
    "models/tree.gltf",
    "textures/bark.png",
    "sounds/wind.wav"
]);

addon.Assets.onReload("textures/bark.png", (newAssetId) => {
    // Hot-reload in editor
});
```
Compute Shaders (for ML, data science)
javascript
```
// WGPU compute
const computeId = await addon.Compute.create({
    shader: `
        @compute @workgroup_size(64)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
            // Matrix multiply, fluid sim, etc.
        }
    `,
    bufferSize: 1024 * 1024
});

const resultBuffer = await addon.Compute.dispatch(computeId, [16, 16, 1]);
```
Video Processing
javascript
```
// Using our Media Foundation implementation
const videoId = await addon.Video.load("footage.mp4");

const clipId = await addon.Video.trim(videoId, {
    start: 5.0,
    end: 15.0
});

const encodedId = await addon.Video.encode(clipId, {
    codec: "h264",
    bitrate: "5M",
    resolution: [1920, 1080]
});

// Frame-by-frame access for AI/VFX
const frameId = await addon.Video.getFrame(videoId, 120); // frame 120
```
UI Components (beyond basic widgets)
javascript
```
// Advanced egui or custom
const graphId = await addon.UI.createGraph({
    nodes: [
        { id: "blur", type: "filter", pos: [100, 100] },
        { id: "output", type: "sink", pos: [300, 100] }
    ],
    connections: [["blur.out", "output.in"]]
});

addon.UI.onNodeConnection(graphId, (from, to) => {
    // Build processing pipeline
});
```
Database (for research, notes, RPG data)
javascript
```
// SQLite via rusqlite
const dbId = await addon.Database.open("project.db");

await addon.Database.execute(dbId, `
    CREATE TABLE IF NOT EXISTS characters (
        id INTEGER PRIMARY KEY,
        name TEXT,
        health INTEGER
    )
`);

const rows = await addon.Database.query(dbId, 
    "SELECT * FROM characters WHERE health > ?", 
    [50]
);
```
Networking (for multiplayer, collaboration)
javascript
```
// quinn (QUIC) or tokio-tungstenite
const sessionId = await addon.Network.createSession({
    maxPlayers: 4,
    tickRate: 60
});

addon.Network.onPlayerJoin(sessionId, (playerId) => {
    Entropy.println(`Player ${playerId} joined`);
});

await addon.Network.broadcast(sessionId, {
    type: "position_update",
    data: { x: 10, y: 0, z: 5 }
});

```