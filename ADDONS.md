# Entropy Addons

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

## Additional API capabilities on top of existing api

Physics & Simulation
We have physics configs on the models when loading them. We could do more physics integration, especially with forces and impulses.

```
Animation
javascript// Skeletal animation (we have skeletal animations in Model.rs but no way to play them from addon yet)
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
Dot Particle Systems (requires specialized shader compared to hair particles)
javascript
```
const particleSystemId = await addon.DotParticles.create({
    maxParticles: 1000,
    emissionRate: 50,
    lifetime: [2.0, 3.0],
    velocity: { min: [-1, 2, -1], max: [1, 5, 1] },
    pipelineId: "fire_shader"
});

await addon.DotParticles.burst(particleSystemId, 100);
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
Text Rendering & Typography (plus other UI stuff like renering polygons and actually rendering images or textures)
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
Navigation & Pathfinding (perhaps this can be done rudimentary in game scripts, or perhaps we supply firstclass solutions?)
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