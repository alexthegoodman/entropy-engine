# Entropy Engine

![Entropy Engine / Chat Value](public/water1.png "Entropy Engine / Chat Value")

![Entropy Chat UI](public/image-3.png "Entropy Chat UI")

**Lightweight, powerful, sophisticated.**

Entropy is an end-to-end, native game engine with an API designed for LLM generation and fewer lines of code.
Create entire games in a single JavaScript file (on top of the fully native Rust-based core). No extra plugins needed.
Get everything you need, from PBR textures to animations to audio and level design. No extra tools required.

The API is clean enough to paste into any LLM (Claude, ChatGPT, local models) and get reliable code generation. 
Or use the built-in chat for convenience (best for non-coders). Your choice.

- Complete a game in one .js file - from mechanics to visuals to audio
- API surface optimized for both humans and LLMs
- Lightweight runtime - no heavyweight GPU requirements

## Getting Started

It is recommended to read the Entropy Book to get started: 
[Entropy Book](./public/entropy-book/src/SUMMARY.md)

There is an [example FPS-RPG game](./scripts/addons/studio-bundle/src/fps_rpg_game.ts) and an [example tower defense game](./scripts/addons/studio-bundle/src/tower_defense_game.ts) as well, which should make getting started much easier.

You can supply the [Rust-powered JavaScript addon API](./scripts/addons/studio-bundle/src/addon.d.ts) to an LLM to generate games and addons for this engine with incredible ease. Although to load an addon, it will need to be a bundled JavaScript file. I recommend using `deno bundle` to bundle your TypeScript to JavaScript, just as is done with the built-in addons.

And you don't need to pay for the chat - you can really use Entropy how you want. You can, for example, add NPCs via chat, via UI, or via JavaScript / TypeScript. You could even fork the engine, if you wish, to evolve the Rust core.

## Features

### Current Features:

- GLB (gltf) Import
- GLB (gltf) animations
- Physics with Rapier
- Shadow Mapping
- Magic particle effects (ex. fire from heavens, snow, etc)
- JavaScript Scripting (for game mechanics and behaviors, not just for creating addons themselves)
- Professional transform gizmo (as well as egui inputs)
- Rendered images and videos
- Rendered text with fonts
- In-Game UI Pipeline
- Procedural scattering of models
- Mini-Map
- Screen capture
- Vector animations
- Video export
- Do level design via LLM powered chat
- Wry webview embed for advanced rich text editing

### Current Mechanics

There are several configurable mechanics included in the engine, but you can easily write your own in an addon script.

- Basic game behaviors (melee, chase, inventory, quests, etc)
- Sprinting/Stamina
- Dialogue (integrates with UI and scripting)
- Aiming (with crosshair ui), ammo, and reloading
- NPC Swarm Systems
- Enemy looting
- Procedural recoil for ranged weapons
- Ranged weapon types (manual, semi-automatic, automatic)

### Currently Available In The Default Addon Bundle

The default addon bundle is automatically loaded in for all users without any need to download or install.

- Interactive, windy, hair particles (grass)
- Deferred rendering / lighting
- PBR Materials and Creation
- FFT Water Planes
- Quadtree landscapes with texture maps
- Skybox Pipeline
- Point lighting
- Heightmap creation CLI (specify features and flat areas too)

### How to approach addons

Addons will act as the "Source of Truth". They should:

* Register a Component: Use Entropy.Composer.registerComponent so their saved data show up in the Game Composer's library.
* Register a Renderer: Provide a render function (for a mesh, model, or whatever you render) so that it can be rendered in the Game Composer.
* Register an Editor: Use Entropy.Composer.registerEditor to provide the UI for various properties.
* Register your tools: Use addon.registerTool to add a handler for LLMs to use via the universal chat.

More info is in the [documentation](./public/entropy-book/src/SUMMARY.md)