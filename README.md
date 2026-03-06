# Entropy Engine

![Entropy Engine / Chat Value](public/water1.png "Entropy Engine / Chat Value")

![Entropy Chat UI](public/image-3.png "Entropy Chat UI")

**Stop jumping between tools. Start creating.**

Entropy Engine aims to be the first "end-to-end" game engine. You should never have to leave Entropy. 
Never import, export, re-import, and re-configure. It's a genuine time-hog.
You should be able to update a PBR texture and have it update everywhere it is applied, instantly.
You should be able to create massive, open-world terrains with photorealistic water, without using a 3rd party tool. All it takes is a few lines of code, some clicking around, or even chatting with the built-in level design agent.

Entropy Engine is lightweight and runs great on iGPUs. The Rust core provides all of the native functionality and performance,
while the TypeScript addon system allows for extendability and rapid development.

There are some features here which you will be hard-pressed to find anywhere else. One of the most excting features, currently in beta stage,
is the Yumon AI System. This System enables you to play a character from your game, such as an enemy, thereby capturing play sessions as data.
Then, all within the editor, you can Train a machine learning model on that data using a method called Behavior Cloning.
This enables you to create highly dynamic, rich NPCs that act like real people, rather than hardcoding your behaviors (which is also supported).

Thank you for taking a look. Feel free to ask any questions or open an issue as the need arises.

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

**Read the Book:**  
[Entropy Book](./public/entropy-book/src/SUMMARY.md) - Complete documentation and tutorials

**Explore Examples:**
- [FPS-RPG Game](./scripts/addons/studio-bundle/src/fps_rpg/index.ts)
- [Tower Defense Game](./scripts/addons/studio-bundle/src/tower_defense_game.ts)

**Use with LLMs:**  
Supply the [JavaScript API](./scripts/addons/studio-bundle/src/addon.d.ts) to any LLM and generate game code instantly. Bundle TypeScript with `deno bundle` to load as addons.

**Or just use the built-in chat** - Best for non-coders who want to create through conversation.