# Mesha: procedural objects, the component catalog and the authoring loop

This is the working reference for [Mesha](MESHA_APP.md): how to run it, how a procedural object is
written, the geometry-nodes-style component catalog every object is built from, and the loop an
agent (or a person) follows to add a new object to the library and prove it's ready.

## Running it

```bash
cd examples/studio-bundle
npm run build-mesha              # dist/mesha.js (the app hot-reloads it)
cd ../..
cargo run --release --bin example -- mesha
```

The viewport fills the window, with three frosted panels over it:

- **Library** (left): search by name or tag ("office chair", "wine", "cog"), filter by category,
  **Add**. Below it, the **Scene** list; Duplicate (Ctrl+D) and Delete.
- **Properties** (right): the selected object's most useful controls first, then every group.
  **Variation** (V) makes another sensible version; **Amount** goes from nudges to radical. The
  padlock beside each control (or each group) keeps it out of Variation. Controls that the last
  Variation changed are marked with •. Presets (shipped and your own, the disk button saves one),
  **Placement**, and **Check this generator** (runs the fuzzer below and prints the report).
- **Toolbar** (top): undo/redo (Ctrl+Z / Ctrl+Shift+Z), Frame (F), the studio lighting, **Export
  GLB** (one mesh per object material, textures embedded).

Right-drag orbits, scroll zooms, left-click selects, the gizmo moves the selection across the
floor. The scene and your presets persist in the app's data folder (`../mesha-data` by default).

Every action is also an MCP tool (`mesha_library`, `mesha_describe`, `mesha_add`, `mesha_select`,
`mesha_set`, `mesha_lock`, `mesha_vary`, `mesha_place`, `mesha_remove`, `mesha_undo`,
`mesha_view`, `mesha_state`, `mesha_verify`, `mesha_export`), so an agent can drive the real app.

## The library today

Acceptance numbers straight from the fuzzer (`npm run mesha:verify`):

| Category | Object | Id | Parameters | Groups | Constraints | Materials | Configurations tested | Status | Avg eval |
|---|---|---|---|---|---|---|---|---|---|
| Furniture | Office Chair | `furniture.office_chair` | 26 | 8 | 6 | 7 | 138 | Ready | 11 ms |
| Furniture | Table | `furniture.table` | 18 | 5 | 6 | 2 | 128 | Ready | 3 ms |
| Household | Bottle | `household.bottle` | 17 | 5 | 4 | 4 | 115 | Ready | 2 ms |
| Household | Mug | `household.mug` | 11 | 3 | 2 | 2 | 95 | Ready | 2 ms |
| Household | Table Lamp | `household.table_lamp` | 16 | 5 | 3 | 4 | 127 | Ready | 2 ms |
| Architecture | Window | `architecture.window` | 15 | 5 | 4 | 4 | 117 | Ready | 2 ms |
| Architecture | Facade | `architecture.facade` | 18 | 4 | 9 | 6 | 118 | Ready | 10 ms |
| Mechanical | Gear | `mechanical.gear` | 14 | 4 | 3 | 1 | 105 | Ready | 14 ms |
| Mechanical | Bolt | `mechanical.bolt` | 11 | 5 | 2 | 2 | 88 | Ready | 6 ms |
| Nature | Rock | `nature.rock` | 11 | 3 | 0 | 1 | 85 | Ready | 47 ms |
| Components | Leg | `component.leg` | 6 | 1 | 0 | 1 | 73 | Ready | 0 ms |
| Components | Rock piece | `component.rockPiece` | 8 | 1 | 0 | 1 | 76 | Ready | 14 ms |
| Components | Caster | `component.caster` | 2 | 1 | 0 | 2 | 51 | Ready | 1 ms |

Components are building blocks other objects compose (a table's legs are `component.leg`, the
office chair's casters `component.caster`, a facade's windows `architecture.window`); they don't
appear under Add Object.

**Table Lamp:** tapered, drum and curved mushroom shades; vase, spindle and column bases;
independent shade, base and fitting finishes; optional metal foot and rims. Five presets:
Stoneware linen, Sage mushroom, Walnut reading, Terracotta atelier and Midnight brass.
Shade width, wall thickness and stem radius are constrained by the lamp's proportions. The shade
has a modeled inner wall, openings and three support arms. The bulb is decorative geometry;
the lamp does not emit light into the scene. The live BDD feature captures the default,
mushroom, locked variation and walnut designs. Contact sheets: `test-artifacts/mesha-lamp/`.

## Writing a procedural object

An object is plain JSON (the library files are TypeScript only for type checking; every one
round-trips through `JSON.stringify`). Files live in `examples/studio-bundle/src/apps/mesha/library/`
and are listed in `library/index.ts`.

```jsonc
{
  "id": "furniture.table", "name": "Table", "category": "Furniture",
  "tags": ["table", "dining table", "desk"],             // what search matches
  "featured": ["width", "depth", "height", "legStyle"],   // shown first
  "groups": [{ "id": "size", "label": "Size" }, { "id": "legs", "label": "Legs" }],
  "params": [
    { "id": "width", "label": "Width", "type": "number", "default": 1.6, "min": 0.4, "max": 3.2, "unit": "m", "group": "size" },
    { "id": "legStyle", "label": "Leg style", "type": "enum", "default": "tapered",
      "options": ["square", "tapered", "turned"], "optionLabels": ["Square", "Tapered", "Turned"], "group": "legs" },
    { "id": "legTaper", "label": "Foot size", "type": "number", "default": 0.6, "min": 0.35, "max": 1,
      "group": "legs", "visibleIf": "=legStyle == 'tapered'" },       // hidden (and never varied) otherwise
    { "id": "cornerRadius", "type": "number", "min": "=topThickness * 0.2", "max": "=min(width, depth) * 0.45", ... }, // ranges can depend on other parameters
    { "id": "topFinish", "label": "Top", "type": "material", "default": "wood.oak", "materials": ["wood", "stone.marble"], "group": "materials" },
    { "id": "seed", "label": "Seed", "type": "seed", "default": 7, "group": "materials", "variation": 0 }
  ],
  "derived": { "legH": "=height - topThickness" },         // named values any expression can use
  "rules": [{ "check": "=legX > legThickness", "message": "The legs crowd into each other." }],
  "regions": { "top": { "label": "Top", "material": "=topFinish" } },  // semantic material slots
  "presets": [{ "name": "Farmhouse dining", "values": { "legStyle": "turned" } }],
  "nodes": [ ... ],
  "limits": { "maxSize": 3.4, "maxTriangles": 60000 }      // sanity bounds the fuzzer enforces
}
```

**Parameter types:** `number`, `int`, `bool`, `enum`, `material` (a preset id from an allowed
list; `"wood"` allows every `wood.*`), `seed`. `variation` weights how much Variation moves a
parameter (0 never). Values are always clamped into range, dynamic ranges included, whatever
order parameters are declared in.

**Rules** must hold for a sensible object. Variation retries until they do; the Properties panel
shows a broken rule's message; the fuzzer reports them as warnings.

**Regions** are how materials survive editing: every node puts its geometry in a named region
(`"region": "legs"`), and each region is bound to a material. Resizing or restyling never breaks
the binding because it isn't tied to face indices.

### Nodes

Each node is one catalog component (`"type"`) plus its inputs, and these common fields:

| Field | Meaning |
|---|---|
| `id` | Name for `@id` references. |
| `when` | Skip the node unless this holds (`"=hasApron"`). |
| `repeat` | Build it N times; inputs see `index`, `count` and `t` (0..1). The copies join. |
| `at`, `rotate` (degrees), `scale` | Place the result: scale, then rotate X, Y, Z, then move. |
| `rest` | Lift each placed copy so its lowest point is on the floor (splayed legs, casters). |
| `region` | Semantic material region for everything the node makes. |
| `output: false` | An intermediate (a curve, a mesh another node deforms), not part of the result. |
| `type: "object"`, `object`, `params` | Compose another library object with these parameter values. |

An input is a literal, an `"=expression"`, an `"@node"` reference, a list mixing them, or a choice
between references: `{ "if": "=cond", "then": "@a", "else": "@b" }` or
`{ "switch": "=expr", "cases": { "x": ..., "y": ... }, "default": ... }`. The object's result is
every node without `output: false`, joined.

### Expressions

`"=..."` strings are parsed once and evaluated with no access to anything but the object's
parameters, derived values and `index`/`count`/`t`: numbers, `'strings'`, `true`/`false`, `PI`,
`TAU`; `+ - * / % ^`, comparisons, `&& || !`, `a ? b : c`, `[a, b][i]`; and `min max clamp lerp
mix smoothstep bez abs sign floor ceil round sqrt pow sin cos tan atan2 hypot rad deg select len
vec`, plus `rand(a, b?)` and `randRange(key, lo, hi)`, which are stable for the object's seed.

### Materials

Presets in `mesha_materials.ts`: woods (oak, walnut, ash, cherry, ebonized), paints, metals
(chrome, brushed steel, black steel, brass, copper, aluminum, zinc), plastics, rubber, fabrics,
leathers, glass (clear, green, amber, frosted), ceramics, stones (granite, sandstone, slate,
marble), paper and cork. Each has a color, roughness, metalness and a surface pattern (wood grain,
fabric sheen, brushed, speckle) the viewport draws.

## The authoring loop

The loop from MESHA_APP.md, with the tools that run it:

1. **Components.** Build from the catalog below. Missing one? Add it to `mesha_catalog.ts` (inputs
   documented, `build` pure) and give it a test in `tests/mesha.test.ts`.
2. **JSON.** Write the definition: parameters with sensible ranges, groups, rules, regions,
   presets.
3. **Look at it.** `npm run mesha:render -- <id> out.png` renders the defaults and every preset
   onto a contact sheet (CPU, no window); pass a JSON list of `{caption, values}` for any other
   configurations, then yaw and pitch.
4. **Fuzz it.** `npm run mesha:verify -- <out dir> [id ...]` drives every parameter to both ends,
   every option, random pairs of extremes and Variation-at-full-strength designs; checks for
   invalid numbers, empty geometry, degenerate and inward-facing faces, non-unit normals, extreme
   sizes, dipping through the floor, triangle budgets, slow evaluation and unbound regions; prints
   the acceptance report; and renders a contact sheet of defaults, presets, extremes and random
   designs for the visual pass. It exits non-zero unless everything is ready.
5. **Inspect and relate.** Valid geometry can still be ridiculous. When a sheet shows something
   odd, add a relationship (a dynamic range, a derived value, a rule) and go back to 3. Examples
   from building this library: the gear's module is capped so 120 teeth can't make a 1.8 m gear;
   drilled holes shrink to their spacing; a mug handle thins so its tube never exceeds its bend;
   legs stay inside large rounded table corners; a headrest needs the star base.
6. **Real window.** `cargo test --release --test mesha_live -- --nocapture` (under `xvfb-run -a`
   on a headless box) runs `tests/features/mesha_live.feature` against the real app and keeps its
   screenshots in `test-artifacts/`.

`npm run test:mesha` covers the expression language, every builder's orientation (signed volume),
triangulation, the whole library through the fuzzer, Variation's locks and determinism, visibility,
composition and region stability.

## Component catalog

Regenerate with `deno run -A --unstable-sloppy-imports tools/mesha_catalog_doc.ts`.

### Mesh Primitives

**`mesh.box`** (Box, outputs mesh): A box centered on the origin with rounded edges and corners. `radius` 0 is sharp; half the smallest side is a pill.

| Input | Kind | Default | |
|---|---|---|---|
| `size` | vec3 | [1,1,1] | Width, height, depth. |
| `radius` | number | 0 (0..) | Edge rounding. |
| `segments` | int | 3 (1..16) | Rows per rounded band. |
| `divisions` | vec3 | [1,1,1] | Extra rows across each flat side (give a box to be bent or tapered some). |

**`mesh.cylinder`** (Cylinder, outputs mesh): A closed cylinder standing on y = 0 with optional rounded rims.

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.5 (0..) | Radius. |
| `height` | number | 1 (0..) | Height. |
| `segments` | int | 32 (3..512) | Sides. |
| `bevel` | number | 0 (0..) | Rim rounding. |
| `bevelSegments` | int | 3 (1..12) | Rows per rim. |

**`mesh.cone`** (Cone / Frustum, outputs mesh): A closed frustum from `bottomRadius` at y = 0 to `topRadius` at `height` (0 top radius is a cone).

| Input | Kind | Default | |
|---|---|---|---|
| `bottomRadius` | number | 0.5 (0..) | Radius at the base. |
| `topRadius` | number | 0.25 (0..) | Radius at the top. |
| `height` | number | 1 (0..) | Height. |
| `segments` | int | 32 (3..512) | Sides. |
| `bevel` | number | 0 (0..) | Rim rounding. |

**`mesh.sphere`** (UV Sphere, outputs mesh): A sphere centered on the origin.

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.5 (0..) | Radius. |
| `segments` | int | 32 (3..512) | Around. |
| `rings` | int | 16 (2..512) | Pole to pole. |

**`mesh.icosphere`** (Ico Sphere, outputs mesh): A sphere of evenly sized triangles, the base for rocks and other displaced organic shapes.

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.5 (0..) | Radius. |
| `subdivisions` | int | 3 (0..6) | Each level quadruples the triangles. |

**`mesh.torus`** (Torus, outputs mesh): A ring around +Y centered on the origin.

| Input | Kind | Default | |
|---|---|---|---|
| `major` | number | 0.5 (0..) | Ring radius. |
| `minor` | number | 0.1 (0..) | Tube radius. |
| `segments` | int | 48 (3..512) | Around the ring. |
| `sides` | int | 16 (3..512) | Around the tube. |

### Curve Primitives

**`curve.circle`** (Circle, outputs curve2): A closed circle in the plane.

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.5 (0..) | Radius. |
| `segments` | int | 32 (3..512) | Points. |
| `center` | vec2 | [0,0] | Center. |

**`curve.ellipse`** (Ellipse, outputs curve2): A closed ellipse.

| Input | Kind | Default | |
|---|---|---|---|
| `rx` | number | 0.5 (0..) | X radius. |
| `ry` | number | 0.3 (0..) | Y radius. |
| `segments` | int | 32 (3..512) | Points. |

**`curve.polygon`** (Regular Polygon, outputs curve2): A regular polygon (a hexagon for a bolt head).

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.5 (0..) | Corner radius. |
| `sides` | int | 6 (3..64) | Sides. |
| `rotation` | number | 0 | Degrees. |

**`curve.rect`** (Rounded Rectangle, outputs curve2): A rectangle centered on the origin with rounded corners.

| Input | Kind | Default | |
|---|---|---|---|
| `width` | number | 1 (0..) | Width. |
| `height` | number | 1 (0..) | Height. |
| `radius` | number | 0 (0..) | Corner radius. |
| `cornerSegments` | int | 6 (1..32) | Points per corner. |

**`curve.superellipse`** (Superellipse, outputs curve2): Between an ellipse (exponent 2) and a rectangle (large exponent): squircle table tops and bottles.

| Input | Kind | Default | |
|---|---|---|---|
| `width` | number | 1 (0..) | Width. |
| `height` | number | 1 (0..) | Height. |
| `exponent` | number | 4 (0.5..20) | Squareness. |
| `segments` | int | 64 (8..512) | Points. |

**`curve.star`** (Star, outputs curve2): A star with alternating outer and inner points.

| Input | Kind | Default | |
|---|---|---|---|
| `outer` | number | 0.5 (0..) | Tip radius. |
| `inner` | number | 0.25 (0..) | Valley radius. |
| `points` | int | 5 (2..64) | Tips. |

**`curve.gear`** (Gear Outline, outputs curve2): A spur gear's toothed outline.

| Input | Kind | Default | |
|---|---|---|---|
| `teeth` | int | 24 (3..400) | Teeth. |
| `root` | number | 0.45 (0..) | Root radius. |
| `tip` | number | 0.5 (0..) | Tip radius. |
| `toothWidth` | number | 0.45 (0.1..0.9) | Tip width as a share of the pitch. |
| `flank` | number | 0.25 (0..0.5) | Extra width at the root. |

**`curve.points`** (Point List, outputs curve2): A 2D polyline from literal points, optionally with every corner filleted and/or smoothed.

| Input | Kind | Default | |
|---|---|---|---|
| `points` | curve2 | [] | [[x, y], ...]. |
| `fillet` | number | 0 (0..) | Corner radius. |
| `filletSegments` | int | 4 (1..32) | Points per fillet. |
| `closed` | bool | false | Treat as a loop. |
| `smooth` | int | 0 (0..64) | Catmull-Rom samples per span (0 keeps corners). |

**`curve.transform`** (Transform Curve, outputs curve2): Moves, rotates (degrees) and scales a 2D curve.

| Input | Kind | Default | |
|---|---|---|---|
| `curve` | curve2 | required | Input. |
| `offset` | vec2 | [0,0] | Move. |
| `rotation` | number | 0 | Degrees. |
| `scale` | vec2 | [1,1] | Scale. |

**`curve.sector`** (Annular Sector, outputs curve2): A ring segment between two radii and two angles (degrees) with rounded corners: gear cut-outs, vents, arcs of trim.

| Input | Kind | Default | |
|---|---|---|---|
| `inner` | number | 0.2 (0..) | Inner radius. |
| `outer` | number | 0.4 (0..) | Outer radius. |
| `start` | number | 0 | Start angle. |
| `end` | number | 60 | End angle. |
| `radius` | number | 0.02 (0..) | Corner rounding. |
| `segments` | int | 24 (2..256) | Points along each arc. |

**`curve.arch`** (Arch, outputs curve2): An opening outline: a width x height rectangle whose top is a round arch `rise` high (0 is square-topped), bottom centred on the origin. Windows, doors, niches.

| Input | Kind | Default | |
|---|---|---|---|
| `width` | number | 1 (0..) | Width. |
| `height` | number | 2 (0..) | Total height. |
| `rise` | number | 0.5 (0..) | Arch height (half the width is a semicircle). |
| `segments` | int | 24 (2..256) | Points along the arch. |

**`curves.linear`** (Linear Curve Copies, outputs curves2): `count` copies of a 2D curve, each `offset` further - a row of window openings for Extrude's holes.

| Input | Kind | Default | |
|---|---|---|---|
| `curve` | curve2 | required | Input. |
| `count` | int | 3 (1..512) | Copies. |
| `offset` | vec2 | [1,0] | Step between copies. |
| `centered` | bool | true | Centre the row on the original. |

**`curves.radial`** (Radial Curve Copies, outputs curves2): `count` copies of a 2D curve rotated evenly about the origin - a list of curves for Extrude's holes (spokes, vents, bolt circles).

| Input | Kind | Default | |
|---|---|---|---|
| `curve` | curve2 | required | Input. |
| `count` | int | 6 (1..512) | Copies. |
| `startAngle` | number | 0 | Degrees. |

### Paths

**`path.points`** (Path, outputs curve3): A 3D polyline through literal points, with filleted corners (bent tube) or a smooth spline through them.

| Input | Kind | Default | |
|---|---|---|---|
| `points` | points3 | [] | [[x, y, z], ...]. |
| `fillet` | number | 0 (0..) | Bend radius at each corner. |
| `filletSegments` | int | 6 (1..32) | Points per bend. |
| `smooth` | int | 0 (0..64) | Spline samples per span (0 keeps corners). |
| `closed` | bool | false | Loop. |
| `step` | number | 0 (0..) | Split straight runs longer than this (so a later bend has points to move); 0 is off. |

**`path.bezier`** (Bezier, outputs curve3): A cubic Bezier from p0 to p3.

| Input | Kind | Default | |
|---|---|---|---|
| `p0` | vec3 | [0,0,0] | Control point. |
| `p1` | vec3 | [0,0,0] | Control point. |
| `p2` | vec3 | [0,0,0] | Control point. |
| `p3` | vec3 | [0,0,0] | Control point. |
| `segments` | int | 16 (2..512) | Samples. |

**`path.arc`** (Arc, outputs curve3): An arc in the XZ plane (degrees).

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.5 (0..) | Radius. |
| `start` | number | 0 | Start angle. |
| `end` | number | 180 | End angle. |
| `segments` | int | 16 (1..512) | Samples. |

**`path.helix`** (Helix, outputs curve3): A helix rising around +Y (threads, springs, coils).

| Input | Kind | Default | |
|---|---|---|---|
| `radius` | number | 0.1 (0..) | Radius. |
| `pitch` | number | 0.02 (0..) | Rise per turn. |
| `turns` | number | 5 (0..) | Turns. |
| `segmentsPerTurn` | int | 24 (3..512) | Samples per turn. |

**`path.resample`** (Resample, outputs curve3): The same path with `count` evenly spaced points.

| Input | Kind | Default | |
|---|---|---|---|
| `path` | curve3 | required | Input. |
| `count` | int | 16 (2..2048) | Points. |

### Curve to Mesh

**`mesh.lathe`** (Lathe (Revolve), outputs mesh): Spins a (radius, y) profile around +Y, bottom to top. Start and end on the axis for a closed solid: bottles, vases, turned legs, knobs.

| Input | Kind | Default | |
|---|---|---|---|
| `profile` | curve2 | required | (radius, y) points. |
| `segments` | int | 48 (3..512) | Around. |
| `sweep` | number | 360 (0..360) | Degrees. |
| `smoothAngle` | number | 40 (0..180) | Corners sharper than this stay crisp. |
| `fillet` | number | 0 (0..) | Round every profile corner. |
| `filletSegments` | int | 4 (1..32) | Points per fillet. |
| `cap` | bool | false | Close both ends onto the axis (adds (0, y) points), for a solid from a side-only profile. |

**`mesh.extrude`** (Extrude, outputs mesh): Extrudes a 2D outline (x, z) up from y = 0, with holes and a rounded bevel on both rims: table tops, gears, panels, frames.

| Input | Kind | Default | |
|---|---|---|---|
| `outline` | curve2 | required | Closed outline. |
| `holes` | curves2 | [] | Closed hole outlines. |
| `height` | number | 0.1 (0..) | Thickness. |
| `bevel` | number | 0 (0..) | Rim rounding. |
| `bevelSegments` | int | 3 (1..12) | Rows per rim. |
| `smoothAngle` | number | 35 (0..180) | Outline corners sharper than this stay crisp. |

**`mesh.sweep`** (Sweep (Curve to Mesh), outputs mesh): Sweeps a profile along a path - `radius` for a round tube, or any closed `profile`. `taper` scales the far end.

| Input | Kind | Default | |
|---|---|---|---|
| `path` | curve3 | required | Path. |
| `profile` | curve2 | null | Closed profile (overrides radius). |
| `radius` | number | 0.02 (0..) | Tube radius. |
| `sides` | int | 16 (3..128) | Tube sides. |
| `taper` | number | 1 (0..) | Scale at the end of the path. |
| `twist` | number | 0 | Degrees per unit length. |
| `closed` | bool | false | Loop the path. |
| `caps` | bool | true | Close the ends. |

### Deform

**`deform.bend`** (Bend, outputs mesh): Bends geometry around a vertical axis: `angle` degrees across `width` of X, both ends curving toward +Z (a chair back wrapping the sitter).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `angle` | number | 30 | Degrees across the width. |
| `width` | number | 1 (0..) | Span of X the angle covers. |

**`deform.taper`** (Taper, outputs mesh): Scales X/Z from 1 at `y0` to `amount` at `y1`.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `amount` | number | 0.5 (0..) | Scale at y1. |
| `y0` | number | 0 | Start height. |
| `y1` | number | 1 | End height. |

**`deform.twist`** (Twist, outputs mesh): Twists around +Y by `rate` degrees per unit of height.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `rate` | number | 90 | Degrees per unit height. |

**`deform.noise`** (Noise Displace, outputs mesh): Pushes the surface along its normals by fractal noise, then rebuilds normals (smooth or faceted).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `amount` | number | 0.1 | Displacement. |
| `frequency` | number | 2 (0..) | Noise scale. |
| `octaves` | int | 4 (1..8) | Detail layers. |
| `seed` | int | 0 (-1000000000..1000000000) | Noise seed. |
| `faceted` | bool | false | Flat-shaded facets. |
| `radial` | bool | false | Push away from the origin instead of along normals: never folds a closed blob (rocks). |

**`deform.clamp`** (Clamp Height, outputs mesh): Flattens everything below `min` (and above `max`) onto that plane: a rock's resting face, a cushion's flat underside.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `min` | number | -1000000000 | Floor. |
| `max` | number | 1000000000 | Ceiling. |
| `give` | number | 0 (0..1) | 0 flattens hard; above 0 squashes what's past the plane to this fraction instead, which never folds a face (rebuild normals after). |

### Instances

**`instance.radial`** (Radial Array, outputs mesh): `count` copies rotated evenly around +Y (chair base spokes, wheel spokes, petals).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `count` | int | 5 (1..1024) | Copies. |
| `startAngle` | number | 0 | Degrees. |

**`instance.linear`** (Linear Array, outputs mesh): `count` copies, each `offset` further (slats, shelves, balusters).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `count` | int | 3 (1..1024) | Copies. |
| `offset` | vec3 | [1,0,0] | Step between copies. |

**`instance.mirror`** (Mirror, outputs mesh): The input plus its reflection across the plane normal to `axis` (x, y or z).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `axis` | enum: x, y, z | "x" | Mirror axis. |

**`instance.onPoints`** (Instance on Points, outputs mesh): A copy of `mesh` at every point, optionally rotated about Y by `rotations` (degrees, one per point or one for all).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Instance. |
| `points` | points3 | required | Positions. |
| `rotations` | points3 | [] | Per-point [x, y, z] degrees. |
| `scales` | points3 | [] | Per-point [x, y, z] scale. |

### Geometry

**`geo.join`** (Join, outputs mesh): Combines meshes, keeping each part's region.

| Input | Kind | Default | |
|---|---|---|---|
| `meshes` | meshes | [] | Inputs. |

**`geo.transform`** (Transform, outputs mesh): Pass-through: use the common `at`/`rotate`/`scale` fields to place a copy of `mesh`.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |

**`geo.smooth`** (Shade Smooth / Flat, outputs mesh): Rebuilds normals: smooth (welded by position), auto-smooth (creases sharper than `angle` stay crisp) or flat facets.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `smooth` | bool | true | Smooth or flat. |
| `angle` | number | 180 (0..180) | Degrees: faces meeting at a sharper angle don't share a normal (180 smooths everything). |

**`geo.region`** (Set Region, outputs mesh): Moves every part of `mesh` into one semantic material region (same as the common `region` field).

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `name` | string | "default" | Region. |

