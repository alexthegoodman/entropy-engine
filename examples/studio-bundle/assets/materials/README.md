# Material texture sets

Tiling PBR maps for Allegiance's surfaces (al_materials.ts). One folder per set, each with:

| File | Contents | Color space |
|---|---|---|
| `basecolor.png` | Albedo, no baked lighting | sRGB |
| `normal.png` | Tangent-space normal, OpenGL convention (+Y up) | linear |
| `roughness.png` | Roughness in red (white = rough) | linear |
| `height.png` | Height in red (white = high); parallax near the camera | linear |

Metallic is a per-set constant (these are dielectrics). A missing file loads as a magenta and
black checkerboard (base color) or a neutral value (the others), so a gap is visible in game.

- `fieldstone/`: mossy dry-laid fieldstone wall, 1024 x 1024, generated with fal.ai's Patina
  material model and supplied by the project owner.
