# Studio Bundle

This is the TypeScript addon bundle behind Entropy Studio, the reference editor/game-creation app shipped as an example of what you can build on `entropy-engine`. It includes the terrain system, FFT water, procedural houses, the FPS-RPG and Tower Defense game examples, and dozens of other addons under `src/`.

It's a useful reference for building your own addons, but you don't need any of it to embed `entropy-engine` in your own app — see the root [README](../../README.md) for the embedding quickstart.

## Development

Install the [Deno CLI](https://deno.com/), then:

- Install dependencies:

```bash
npm install
```

- Run the unit tests:

```bash
npm run test
```

- Build the bundle (produces `dist/bundle.js`, which `entropy-engine`'s `editor`/`game`/`game_addon` binaries compile in via `include_str!`):

```bash
npm run build
```
