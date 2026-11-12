# Rhai scripting and the web build

Entropy apps can be scripted in [Rhai](https://rhai.rs) as well as TypeScript. Rhai is interpreted by Rust inside the engine, so a Rhai app runs the same natively and in a browser (WebAssembly + WebGPU), where Deno/V8 cannot go. In the browser, the page runs no JavaScript of the game's: one fixed loader (`web/main.js`) starts the engine's WASM, and the game is Rhai inside it. `web/index.html` sets a Content-Security-Policy that allows only that loader and the WASM: no inline or remote scripts, no `eval`.

Code: `src/script/` (the runtime), `examples/rhai/` (apps), `scripts/ts2rhai.mjs` (TypeScript → Rhai), `web/` (the page).

## Running

```bash
cargo run --bin example -- rhai-nebula-kingdom      # natively, in a window
cargo run --bin example -- rhai-hello
cargo run --bin example -- rhai-file a.rhai b.rhai  # any Rhai files, in order
```

```bash
./scripts/build-web.sh                              # builds web/pkg (needs the wasm32 target and wasm-bindgen-cli)
python3 -m http.server -d web 8080                  # then open http://localhost:8080/?app=nebula-kingdom
```

The browser needs WebGPU (current Chrome, Edge, Safari; Firefox with WebGPU enabled). Apps a web build can start are compiled into it: `src/script/apps.rs`.

On wasm32 the engine library is `src/script` only; the rest of Studio (Deno, the desktop audio stack, P2P, VST3...) is native-only (`src/lib.rs`, `Cargo.toml`).

## Writing a Rhai app

A script is a set of functions. The host calls these as methods on the app object, so `this` keeps the app's state between calls; each is optional:

| function | when |
|---|---|
| `init()` | once |
| `update(dt)` | every frame |
| `on_key_down(key)`, `on_key_up(key)` | keys, named as in TypeScript (`"w"`, `"ArrowUp"`, `" "`, `"Shift"`) |
| `on_mouse_down(button, x, y)`, `on_mouse_up(...)`, `on_mouse_move(x, y)`, `on_mouse_wheel(dx, dy)` | window pixels |
| `on_gamepad_button(name, down)`, `on_gamepad_axis(left, right, triggers)` | the first gamepad |
| `tool_<name>(args)` | a tool registered with `Entropy::registerTool(name, description)` |

Top-level `const`s are visible inside functions as `G::NAME` (Rhai functions cannot see the top level).

The API mirrors the TypeScript `Entropy` object: `Entropy::Pipeline::create`, `Buffer::create/write/destroy`, `Mesh::icosphere/quad/cone/fromArrays`, `MeshCache::put/status/createMesh`, `Model::clearMesh/setInstanceCount/setBounds`, `Camera::setTransform/setFov`, `Lighting::setClearColor/updateSun`, `UI::clear/drawRect/drawText` (and the faster `rect/rectStroked/text/measure`), `Audio::playNote`, `Store::read/write/remove` (files natively, `localStorage` in a browser), `Json::parse/stringify`, `Window::getSize`, `Time::now/frame`, `println`. Pipelines use Studio's `mesh` bind-group layout (group 0 camera, 1 model, 2+ your `extraBindGroups`), so addon WGSL runs unchanged. `examples/rhai/hello/main.rhai` uses all of it.

Native helpers for inner loops (`src/script/rmath.rs`): vector math (`v_add`, `v_norm`, `basis`...), a mulberry32 `rng(seed)` bit-exact with the TypeScript games' `Rng`, `floats(n)` for GPU data, and `instance_batches(...)`, which draws every instance of a cached mesh with one draw call.

Safety: a script reaches only what is registered. Each callback is capped in operations and call depth, so a runaway loop ends in a reported error instead of a frozen page.

## Browser specifics the runtime handles

- Shaders: browsers (Tint) reject derivatives in non-uniform control flow, which wgpu's native compiler allows; script shaders get `diagnostic(off, derivative_uniformity)` on the web.
- Buffers are created empty and written (Chrome refuses large buffers mapped at creation).
- The canvas is sized after the GPU starts; the surface follows the window every frame.
- HiDPI: the scene renders at CSS pixels and is scaled up; UI text is rasterized at device pixels.
- Audio starts on the first key, click or button (autoplay policy).
- `stats()` (exported to the page) reports script and render milliseconds per frame.

## TypeScript games: ts2rhai

`node scripts/ts2rhai.mjs examples/rhai/nebula_kingdom/ts2rhai.json` translates Nebula Kingdom from `examples/studio-bundle/src/games/nebula` into `nebula_kingdom.gen.rhai`. The TypeScript stays the source: change the game there and regenerate (`./scripts/build-web.sh --regenerate`). It needs `npm install` in `examples/studio-bundle` (for the TypeScript compiler and type checker).

How it maps (details in the script's header):

- Objects and arrays become `Obj`/`List` (`src/script/jsrt.rs`), reference types like JavaScript's, so aliasing works; every number is a float.
- Classes become functions (`C__new`, `x.C__method()`), dispatched by the type checker.
- Module state lives in `G::__V`, filled by `__module_init()`; `examples/rhai/ts_prelude.rhai` connects the addon's hooks (`onInit`, `Input.on*`, `registerTool`...) to the host.
- The config's `api` maps `Entropy.*` calls; `skipModules`/`provided` leave hot code to native helpers or hand-written Rhai (Nebula's renderer is `nk_render_native.rhai`); `interfaceCalls` sends an interface's calls straight to native functions.
- Speed: enum-like constants are inlined, closures that are only called are lifted to functions, and properties get registered accessors.

Constructs it does not support stop it with the file and line; add them to the script as games need them.

`--profile` writes a `.profile.rhai` whose functions time themselves (`script::rmath::profile_report()`).

### Fidelity check

`examples/rhai/nebula_kingdom/fidelity/` plays the same scripted flight in the TypeScript game (Deno) and the translation, and the results match value for value:

```bash
cd examples/studio-bundle && deno run -A --unstable-sloppy-imports ../rhai/nebula_kingdom/fidelity/harness.ts > /tmp/ts.json
```

```bash
mkdir -p ../rhai-app-data/rhai-file && cp examples/rhai/nebula_kingdom/fidelity/plan.json ../rhai-app-data/rhai-file/
cargo run --bin example -- rhai-file examples/rhai/ts_prelude.rhai examples/rhai/nebula_kingdom/nk_render_native.rhai examples/rhai/nebula_kingdom/nebula_kingdom.gen.rhai examples/rhai/nebula_kingdom/fidelity/harness.rhai
```

The second prints `FIDELITY {...}` (close the window when it appears, or set `ENTROPY_SCRIPT_DRIVE` to a file with `[{"frame": 2, "exit": true}]`); compare it with the first.

## Testing natively

`ENTROPY_SCRIPT_DRIVE=<steps.json>` drives an app: `[{"frame": 5, "tool": "nebula_start", "args": {"region": "cradle"}}, {"frame": 60, "capture": "shot.png"}, {"frame": 61, "exit": true}]`, also `key`/`down`. `ENTROPY_SCRIPT_DRIVE_OUT` collects tool results; the exit code is non-zero if the script reported errors.
