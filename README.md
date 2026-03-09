# Entropy Engine

![Entropy Engine / Chat Value](public/water1.png "Entropy Engine / Chat Value")

![Entropy Chat UI](public/image-3.png "Entropy Chat UI")

**Out-of-the-box open worlds + all the standard features you expect**

Some engines have appeal through intense visual fidelity, while others appeal via broad platform support. Entropy is different.

If you want to build a true open-world in the major engines, you will quickly find yourself deep in custom code. Not so with Entropy.
Thanks to the first-class, seamless quadtree terrain system, you can create planet-sized worlds without dropping a frame.

Entropy also features a first-class behavior cloning system called Yumon which enables you to train NPCs through imitation learning.
It is highly effective for organic behaviors and more engaging than predictable, hardcoded behavior logic (although hardcoded logic is supported as well).

Entropy Engine is lightweight and runs great on iGPUs. The Rust core provides all of the native functionality and performance,
while the TypeScript addon system allows for extensibility and rapid development.

Thank you for taking a look. Feel free to ask any questions or open an issue as the need arises.

**Entropy Engine is experimental and in beta, and some things may not work as expected**

---

## The Workflow You Actually Want

| **What You're Doing** | **How It Works** |
|----------------------|------------------|
| **Creating environments** | Design landscapes, place water systems, add particle effects - all live in the editor |
| **Making materials** | Build PBR textures visually, apply them anywhere, change once and see everywhere |
| **Building structures** | Generate procedural houses, scatter props, compose levels - instant feedback |
| **Adding game logic** | Write clean JavaScript for behaviors and mechanics (perfect for LLMs too) |
| **Getting AI help** | Optional chat integration - ask to place NPCs, adjust lighting, generate code |
| **Testing** | Hit play. No build step. No export pipeline. Just your game running. |

---

## What's Actually Included

No hunting for plugins. No "this only works with the paid version." Everything's here:

### Environment & Visuals
- **FFT Water & Rivers** - Realistic flowing water with physics-based simulation
- **Terrain System** - Heightmap-based landscapes with texture blending
- **Procedural Houses** - Generate and customize buildings on the fly
- **Interactive Grass** - Wind-reactive hair particles that respond to movement
- **Volumetric Effects** - Fog, dust, atmospheric particles
- **PBR Material Designer** - Create textures with metallic, roughness, normal maps
- **Skybox & Lighting** - Point lights, shadow mapping, deferred rendering

### Characters & Animation
- **Character Creator** - Humanoid system with customization
- **GLB/GLTF Support** - Import models with full animation support
- **Transform Gizmo** - Professional 3D manipulation tools

### Game Systems
- **Physics** - Powered by Rapier for realistic collisions
- **Behaviors & Mechanics** - Inventory, quests, dialogue, combat, AI
- **Audio** - DAW-style synth integration
- **UI Pipeline** - In-game interface system with text rendering
- **Game Modes** - Tower defense, FPS-RPG, horde mode examples included

### In Progress / Coming Soon
- **GPU-Driven Renderer** Entropy's "Alpha" renderer avoids CPU-driven draw calls almost entirely
- **Virtualized Geometry** Load meshes as many tiny meshlets which get rendered at various detail levels
- **First-Class Localization** Viral games require many languages to work well, and Entropy will support that
- **Stable QuadTree Terrains** Create massive open worlds with our hyper-performant quadtree system
- **Yumon ML Model(s)** Train NPC and Enemy Behaviors by playing as those characters - avoiding tangled behavior trees

---

## Traditional Workflow vs. Entropy

| | **Traditional Engine** | **Entropy** |
|---|---|---|
| **Making a texture** | Create in Substance → Export → Import → Apply → Realize it's wrong → Repeat | Create in PBR Designer → Apply → Adjust in real-time |
| **Terrain + water** | Terrain in World Creator → Water plugin → Hope they work together | Terrain tool + FFT Water → They already work together |
| **Updating materials** | Find source file → Edit → Re-export → Re-import → Re-apply to all objects | Edit once → Everything updates automatically |
| **Adding game logic** | Navigate complex GameObject hierarchies → Attach scripts → Debug serialization issues | Write clean JavaScript → It just works |
| **LLM assistance** | Copy/paste code → Try to adapt it to engine-specific patterns | Give Claude the API → Get working code immediately |
| **Plugin management** | Search asset store → Check compatibility → Deal with version conflicts → Pay for half of them | Everything included out of the box |

---

## Built for Real Development

**Rust core, JavaScript flexibility**  
Fast native runtime with a scripting layer that makes sense. No performance overhead from bloated frameworks.

**LLM-optimized API**  
The entire API is designed to be pasteable into Claude, ChatGPT, or local models for reliable code generation. Clean, consistent, predictable.

**Lightweight**  
No heavyweight GPU requirements. No gigabytes of dependencies. Just the engine and your creativity.

**Complete examples included**  
Full FPS-RPG and Tower Defense games with source code. Learn by seeing how real games are built.

---

## Getting Started

To start the editor, simply clone the project and run:

`cargo run --bin editor --release` 

Currently, Entropy has only been tested on Windows machines.

## Documentation

**Read the Book:**  
[Entropy Book](./public/entropy-book/src/SUMMARY.md) - Complete documentation and tutorials

**Explore Examples:**
- [FPS-RPG Game](./scripts/addons/studio-bundle/src/fps_rpg/index.ts)
- [Tower Defense Game](./scripts/addons/studio-bundle/src/tower_defense_game.ts)

**Use with LLMs:**  
Supply the [JavaScript API](./scripts/addons/studio-bundle/src/addon.d.ts) to any LLM and generate game code instantly. Bundle TypeScript with `deno bundle` to load as addons.

**Or just use the built-in chat** - Best for non-coders who want to create through conversation.