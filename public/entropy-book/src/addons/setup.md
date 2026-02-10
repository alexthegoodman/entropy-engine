# Setting Up Addons

Creating an addon for Entropy is straightforward. This guide will walk you through the basic structure and registration process.

## Basic Structure

An addon is essentially a JavaScript or TypeScript file that calls `Entropy.Addon.register`.

```javascript
// my_first_addon.js

const addon = await Entropy.Addon.register({
    name: "My Awesome Addon",
    version: "1.0.0",
    description: "Doing something cool!",
    author: ["Your Name"],
    capabilities: {
        graphics: true,
        ui: true
    }
});

addon.onInit(async () => {
    Entropy.println("My Awesome Addon has started!");
    
    // Your initialization logic here...
});
```

## Registration

When you call `Entropy.Addon.register`, you receive a `ScopedAPI` object. This object provides methods that are specific to your addon, such as:

- `onInit(callback)`: Called when the addon is loaded.
- `onUpdate(callback)`: Called every frame.
- `onCleanup(callback)`: Called when the addon is removed or the project is closed.
- `onProjectChanged(callback)`: Called when the active project changes.

### Metadata

The metadata object passed to `register` helps the engine categorize and display your addon:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique name for your addon. |
| `version` | string | SemVer version string. |
| `description`| string | A brief summary of what the addon does. |
| `author` | string[] | List of contributors. |
| `capabilities`| object | Hints for the engine (e.g., `graphics`, `audio`, `ui`). |

## The Lifecycle

1. **Registration**: Your script is executed and calls `register`.
2. **Initialization**: The engine calls your `onInit` callback. This is where you should create pipelines, spawn initial models, or register UI tabs.
3. **Update Loop**: If you've registered `onUpdate`, it will be called every frame with the current time and camera information.
4. **Cleanup**: When the addon is no longer needed, your `onCleanup` callback is called to release resources.

## Example: Spawning a Cube

Here is a complete example of an addon that spawns a cube using the default pipeline.

```javascript
const addon = await Entropy.Addon.register({
    name: "Cube Spawner"
});

addon.onInit(async () => {
    addon.Model.createProcedural({
        type: "cube",
        parameters: {
            position: [0.0, 5.0, 0.0],
            scale: [1.0, 1.0, 1.0]
        }
    });
});
```

## Tips for Success

- **Use Scoped API**: Always use the `addon` object (the `ScopedAPI`) for creating objects like models or lights. This allows the engine to track which addon owns which resource.
- **Async Initialization**: `onInit` can be `async`. Use this to load assets or create pipelines before the update loop starts.
- **Logging**: Use `Entropy.println(msg)` to log messages to the editor's console. It's much more reliable than `console.log` in the native environment.
