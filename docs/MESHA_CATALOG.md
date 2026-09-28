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
| Household | Coffee Maker | `household.coffee_maker` | 24 | 6 | 4 | 8 | 146 | Ready | 4 ms |
| Architecture | Window | `architecture.window` | 15 | 5 | 4 | 4 | 117 | Ready | 2 ms |
| Architecture | Facade | `architecture.facade` | 18 | 4 | 9 | 6 | 118 | Ready | 10 ms |
| Architecture | Dome Building | `architecture.dome_building` | 24 | 5 | 7 | 5 | 174 | Ready | 11 ms |
| Architecture | House | `architecture.house` | 63 | 10 | 18 | 21 | 298 | Ready | 41 ms |
| Architecture | Door | `architecture.door` | 23 | 5 | 4 | 6 | 139 | Ready | 3 ms |
| Mechanical | Gear | `mechanical.gear` | 14 | 4 | 3 | 1 | 105 | Ready | 14 ms |
| Mechanical | Bolt | `mechanical.bolt` | 11 | 5 | 2 | 2 | 88 | Ready | 6 ms |
| Nature | Rock | `nature.rock` | 11 | 3 | 0 | 1 | 85 | Ready | 47 ms |
| Nature | Tree | `nature.tree` | 36 | 6 | 6 | 5 | 189 | Ready | 10 ms |
| Nature | Conifer | `nature.conifer` | 22 | 5 | 4 | 3 | 135 | Ready | 14 ms |
| Nature | Palm Tree | `nature.palm` | 24 | 6 | 3 | 3 | 134 | Ready | 4 ms |
| Nature | Fern | `nature.fern` | 19 | 4 | 1 | 2 | 129 | Ready | 3 ms |
| Nature | Flower | `nature.flower` | 29 | 4 | 4 | 4 | 146 | Ready | 1 ms |
| Nature | Grass | `nature.grass` | 17 | 4 | 3 | 6 | 133 | Ready | 3 ms |
| Nature | Bush | `nature.bush` | 24 | 4 | 3 | 4 | 153 | Ready | 4 ms |
| Components | Leg | `component.leg` | 6 | 1 | 0 | 1 | 73 | Ready | 0 ms |
| Components | Rock piece | `component.rockPiece` | 8 | 1 | 0 | 1 | 76 | Ready | 14 ms |
| Components | Caster | `component.caster` | 2 | 1 | 0 | 2 | 51 | Ready | 1 ms |

Components are building blocks other objects compose (a table's legs are `component.leg`, the
office chair's casters `component.caster`, a facade's windows `architecture.window`); they don't
appear under Add Object. Ordinary objects compose too: a house's front and interior doors are
`architecture.door`, its windows `architecture.window`.

**Table Lamp:** tapered, drum and curved mushroom shades; vase, spindle and column bases;
independent shade, base and fitting finishes; optional metal foot and rims. Five presets:
Stoneware linen, Sage mushroom, Walnut reading, Terracotta atelier and Midnight brass.
Shade width, wall thickness and stem radius are constrained by the lamp's proportions. The shade
has a modeled inner wall, openings and three support arms. The bulb is decorative geometry;
the lamp does not emit light into the scene. The live BDD feature captures the default,
mushroom, locked variation and walnut designs. Contact sheets: `test-artifacts/mesha-lamp/`.

**Coffee Maker:** an espresso machine with one or two brewing groups, removable portafilters,
single/twin spouts, pressure dials, buttons, a steam wand, slatted drip tray and cup warming rail.
The optional cups compose `household.mug`. Housing, side panels, fittings, handles and cups have
separate finishes. Five presets: Sage barista, Cafe twin, Cream and walnut, Compact midnight,
Copper atelier. Two brewing groups require at least 38 cm width; tray and panel dimensions follow
body rounding, and cups fit below the spouts. This is an exterior model, with no brewing simulation
or internal plumbing. Contact sheets: `test-artifacts/mesha-coffee/`. The live BDD feature covers
presets, narrowing two groups to one, locked variation, persistence and GLB export.

**Dome Building:** a hollow ellipsoidal roof over a circular hall, with a real open entrance on
the +Z side. Exterior columns never span the room. Controls cover radius, wall height and shell
thickness, doorway size and surround, dome rise, an open oculus, smooth/faceted surfaces,
spiraling ribs (smooth roofs), exterior columns, cornice and five material regions. Hide **Show
roof** to inspect or furnish the empty interior; the floor slab is also optional. Five presets:
Civic rotunda, Senate hall, Alien seed vault, Lunar habitat and Obsidian embassy. The entrance
has no door leaf. Geometry tests trace clear paths through the entrance, check the interior and
oculus, and verify the roof shell has no boundary edges. Live BDD captures exteriors, the widened
entrance and a roof-hidden interior. Contact sheets: `test-artifacts/mesha-dome/`.

**House:** a residential house you can walk through, one to three storeys. A centre hall runs
front to back with a straight staircase along one of its walls (left or right; closed risers with
strings and a sloped soffit, or open treads on stringers; newels, handrail and balusters, and a
guard around each stairwell). Cross walls split each side into front and back rooms, stacked on
every storey (the ground floor can be open plan); every room is at least 2.4 m wide and opens off
the hall through a real doorway, with an optional panelled, half-glazed or flush door leaf swung
into the room. Stair-side doorways sit in the foyer and past the stair's top, never beside it,
and the cross walls stay clear of all of them. Exterior walls are brick (or render, paint, stone,
wood) outside and plaster inside, with windows centred on each room (sash, casement or fixed,
arched or square, shutters with louvres, stone lintels and keystones) and a hall window over the
front door. The front door is `architecture.door` with a fanlight, hinged away from the stair.
Stoop, pediment portico (a flat canopy on a flat-roofed house) or full-width veranda with turned
columns or square posts, railings and steps sized to the floor height. Gable roofs (gable windows,
barge boards, ridge), hip roofs (a `mesh.loft`) or flat roofs; gabled dormers (only as many as
the slope has room for), chimneys with pots, gutters and downpipes, quoins or corner boards and a
belt course at each floor. **Show roof** lifts the roof and top ceiling; **Hide top storeys** cuts
the house down to look into the rooms and stairs below. No furniture or fittings. Six presets:
Brick colonial, Craftsman bungalow, Modern flat roof, Georgian manor, White farmhouse and Stone
cottage. Geometry tests walk it: the front door opens onto a hall clear to the back wall; every
hall doorway on every storey leads into a room; every tread is where the risers say, with at least
2 m of headroom (stacked flights included) and a floor to step onto at the top; lifting the roof
and cutting away storeys expose the floors below. Live BDD captures the colonial, its top storey
and ground floor from above, a three-storey hip-roofed version, the farmhouse and a locked
Variation of it. (The viewport's aerial haze and floor fade scale with the camera's focus
distance, so a building framed from 40 m reads as crisply as a chair framed from 3 m.)

**Door:** a hinged door in its frame, facing +Z, frame centred on a wall `depth` thick: raised
panels (1 or 2 columns, up to 4 rows) with mouldings, half glazed with glazing bars, flush, or
ledged-and-braced planks; knob or lever, hinges, casing on both faces, an arched fanlight with
sunburst bars. **Exterior** adds a threshold and kick plate and puts the leaf in the `entry`
region instead of `leaf`, so a building can paint its front door apart from its interior doors.
**Open** swings the leaf into -Z about its hinge. Five presets: Six-panel, Georgian fanlight,
Half-glazed kitchen, Cottage plank and Modern flush.

**Foliage** is a family of seven plants (rock's siblings under Nature), each with many controls, all built
from the new Foliage components (`mesh.leaf`, `mesh.frond`, `instance.scatter`, `instance.rosette`,
`mesh.branches`, `points.branchTips`) and drawn with the viewport's `foliage` and `bark` surface
patterns: mottled tone with sun-yellowed patches, a midrib and side veins from each leaf's own UVs,
and light glowing through the blade when it is backlit. Leaves, fronds, petals and blades are open
sheets (the shader lights both faces, GLB export marks materials double-sided). Every plant lists its
leaf/petal/bark colours as material presets (`leaf.*`, `petal.*`, `bark.*`, `fruit.*`, `stem.*`), and
Variation moves shape, size, density, colour and season together while a lock keeps what you want.

**Tree:** a leaning, flared, gently snaking trunk; a spiral of arching branches and twigs grown to a
crown outline (round, spreading, columnar, conical or vase, with weeping droop); and clumps of leaves
on every tip over a soft "canopy body" mass so the crown reads as full. Leaves come in six outlines
(ovate, elliptic, narrow willow, round aspen, serrated birch, palmate maple), lie flat on the crown or
point outward, and take size, curl, fold, droop, scatter and size variety. A second-colour share turns
part of the foliage autumn gold or copper, and **Blossom** or **Fruit** dots the clumps (cherry
petals, apples, olives). Eight presets: Summer oak, Silver birch, Autumn maple, Weeping willow, Cherry
blossom, Lombardy poplar, Apple tree, Old olive. Crown width and trunk radius are constrained by the
height, clump size by the crown, and the leaf and blossom counts by a triangle budget.

**Conifer:** a tapering trunk hung with tiers of needled boughs (each a pinnate frond arching from the
trunk), a leader spike and optional hanging cones. Spruce, fir, pine and cypress crown outlines, tier
and bough counts, bough angle and droop, needle density, length, width, sweep, lift and fold. Six
presets: Norway spruce, Balsam fir, Scots pine, Blue spruce, Italian cypress, Forest fir sapling.

**Palm Tree:** a ringed trunk (a stack of short bevelled cones following its lean and curve), and a
crown of arching pinnate fronds or fan leaves on long stalks, from a drooping skirt to a shuttlecock,
with coconuts or dates. Five presets: Coconut palm, Date palm, Fan palm, Beach palm, Young sago.

**Fern:** a rosette of arching pinnate fronds from flat to upright vase, with leaflet count, length,
width, sweep, fold and droop, bare stalk and unfurling fiddleheads. Six presets: Woodland fern, Bracken,
Sword fern, Boston fern, Lady fern, Tree fern crown.

**Flower:** a curving stem with leaves and a ground rosette, and a head of layered petals
(`instance.rosette`) around an optional seed disc: petal count, layers, openness, cup, curl, ruffle,
roundness and width. Six presets: Daisy, Tulip, Poppy, Sunflower, Garden rose, Cosmos.

**Grass:** curved blades springing from a disc: count, height and variety, width, bend, outward lean,
tip sharpness, clumping, a share of dry blades and optional composed wildflowers (`nature.flower`).
Six presets: Lawn tuft, Tall meadow, Clipped lawn, Dry savanna, Marsh reeds, Wildflower patch.

**Bush:** a natural shrub (stems and twigs ending in leaf clumps), a clipped globe or a hedge block,
with flowers or berries. Seven presets: Garden shrub, Boxwood globe, Privet hedge, Hydrangea, Rose bush,
Blueberry bush, Autumn burning bush. The live BDD feature captures oaks, an autumn maple, a cherry
blossom, a willow, spruce, fir, pine, palms, ferns, flowers, grass, hydrangea and hedges, and
asserts the trees really render green and autumn red. Contact sheets: `test-artifacts/mesha-foliage/`.

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
  // plants that droop below y = 0 add "floorTolerance": 0.03 (a share of the object's size) before the fuzzer warns
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
A region may also set `"shade": 0.6` to darken its bound material (the shaded body behind a tree's leaves, a hedge's inner mass).

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

Inside a repeated node, `index`, `count` and `t` are the copy's own, so they hide any parameter or
derived value of the same name (a derived wall thickness called `t` becomes 0..1 there); the
definition check reports it. Every node is evaluated once, so an expensive intermediate (a
composed window, a dormer joined from several nodes) placed by a repeated `geo.transform` costs
one build however many copies it makes.

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
marble), masonry (red, buff and whitewashed brick, stucco, fieldstone), roofing (slate, asphalt
shingle, clay tile, cedar shake, standing-seam metal), paper and cork, and plants: leaves (fresh, spring, deep, forest, pine, blue spruce, olive, sage, silver, copper beech, autumn gold, orange, red, crimson, dry straw), petals, flower centers, fruit, bark (oak, dark, pine, redwood, grey, palm, birch, cherry) and stems. Each has a color,
roughness, metalness and a surface pattern (wood grain, fabric sheen, brushed, speckle) the
viewport draws.

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

`npm run test:mesha` covers the expression language, presets holding their values and rules, every builder's orientation (signed volume),
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

**`mesh.loft`** (Loft, outputs mesh): A closed, flat-shaded solid from a `bottom` outline (x, z) at y = 0 to a `top` outline at `height`, point to point (resampled when the counts differ): hip and gable roofs, hoppers, plinths, chimney caps.

| Input | Kind | Default | |
|---|---|---|---|
| `bottom` | curve2 | required | Closed outline at y = 0. |
| `top` | curve2 | required | Closed outline at the top (a very thin one makes a ridge). |
| `height` | number | 1 (0..) | Height. |

**`mesh.sweep`** (Sweep (Curve to Mesh), outputs mesh): Sweeps a profile along a path - `radius` for a round tube, or any closed `profile`. `taper` scales the far end.

| Input | Kind | Default | |
|---|---|---|---|
| `path` | curve3 | required | Path. |
| `profile` | curve2 | null | Closed profile (overrides radius). |
| `radius` | number | 0.02 (0..) | Tube radius. |
| `sides` | int | 16 (3..128) | Tube sides. |
| `taper` | number | 1 (0..) | Scale at the end of the path. |
| `flare` | number | 0 (0..4) | Extra girth at the start that fades out over the first quarter of the path (a trunk's root flare). |
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

### Foliage

**`mesh.leaf`** (Leaf, outputs mesh): One leaf or petal lying in the XY plane: base at the origin, tip along +Y, front face toward +Z. `curl` bends it toward -Z and `fold` lifts both edges toward +Z. `widest`/`fullness` give ovate, lanceolate, round or blade-like outlines; `teeth` saws the edge; `lobes` of 3 or more makes a palmate leaf (maple, fan palm).

| Input | Kind | Default | |
|---|---|---|---|
| `length` | number | 1 (0.001..) | Blade length. |
| `width` | number | 0.5 (0.001..) | Blade width. |
| `widest` | number | 0.4 (0.05..0.95) | Where along the blade it is widest (0..1). |
| `fullness` | number | 1 (0.15..4) | Below 1 the ends are rounder, above 1 pointier. |
| `stalk` | number | 0 (0..) | Bare petiole before the blade. |
| `fold` | number | 15 (-65..65) | Degrees the halves fold up along the midrib. |
| `curl` | number | 20 (-180..180) | Degrees the blade bends tip-down (toward -Z). |
| `wave` | number | 0 (0..1) | Edge ruffle as a share of the half width. |
| `waveCount` | number | 3 (0.5..12) | Ruffles along the blade. |
| `teeth` | int | 0 (0..24) | Saw teeth (0 is a smooth edge). |
| `toothDepth` | number | 0.15 (0..0.6) | How deep the teeth cut. |
| `lobes` | int | 0 (0..24) | 0 is a simple leaf; 3+ makes a palmate leaf with that many lobes. |
| `lobeDepth` | number | 0.5 (0..0.85) | How far the notches between lobes cut in. |
| `spread` | number | 200 (60..340) | Degrees a palmate leaf fans across. |
| `rows` | int | 5 (2..32) | Rows along the blade. |
| `half` | int | 1 (1..4) | Columns on each half of the blade. |

**`mesh.frond`** (Frond, outputs mesh): A pinnate frond (fern, palm, fir bough): a rachis arching along +Y with pairs of leaflets, base at the origin, front face toward +Z, `curl` arching it toward -Z.

| Input | Kind | Default | |
|---|---|---|---|
| `length` | number | 1 (0.001..) | Rachis length. |
| `pairs` | int | 12 (1..60) | Leaflet pairs. |
| `leafletLength` | number | 0.3 (0.005..2) | Longest leaflet as a share of the length. |
| `leafletWidth` | number | 0.2 (0.02..0.9) | Leaflet width as a share of its length. |
| `angle` | number | 65 (15..90) | Degrees between leaflets and the rachis (90 is square). |
| `lift` | number | 15 (-60..60) | Degrees the leaflets tilt up out of the frond's plane (negative droops them). |
| `droop` | number | 20 (-90..120) | Degrees each leaflet curls down along its length. |
| `curl` | number | 40 (-90..200) | Degrees the frond arches tip-down. |
| `peak` | number | 0.35 (0.1..0.9) | Where the leaflets are longest (0..1). |
| `gap` | number | 0.1 (0..0.7) | Share of the frond that is bare stalk at the base. |
| `rachis` | number | 0.006 (0.0001..) | Rachis radius. |
| `fold` | number | 20 (-60..80) | Degrees each leaflet folds along its midrib. |

**`instance.scatter`** (Scatter on Volume, outputs mesh): `count` copies of `mesh` (base at the origin, pointing along +Y) spread evenly over a volume around each center, pointing outward, up or every which way, with random tilt, droop, roll and scale.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Instance. |
| `centers` | points3 | [[0,0,0]] | Volume centers (a list, e.g. `@tips`). |
| `count` | int | 24 (0..2000) | Copies per center. |
| `volume` | enum: sphere, dome, cone, disc, column, box | "sphere" | Shape filled (`box` covers the top and four sides of a box of half extents `size`). |
| `size` | vec3 | [0.5,0.5,0.5] | Radii (a cone's base and height, a disc's radius). |
| `hollow` | number | 0.5 (0..1) | 0 fills the volume, 1 only its surface. |
| `orient` | enum: outward, up, random, surface | "outward" | Which way each copy's +Y points; `surface` lies each flat on the volume's skin, facing out, pointing downhill. |
| `spread` | number | 20 (0..180) | Degrees of random wobble (`surface`: how far each may spin from pointing downhill, up to 180). |
| `droop` | number | 0 (0..1.5) | Pulls every direction toward -Y. |
| `scaleMin` | number | 0.8 (0.0001..) | Smallest scale. |
| `scaleMax` | number | 1.2 (0.0001..) | Largest scale. |
| `roll` | number | 180 (0..180) | Degrees of random roll about each copy's own axis. |
| `minY` | number | -1000000000 | Copies whose base would lie below this height are left out (keeps foliage off the ground). |
| `seed` | int | 1 (-1000000000..1000000000) | Placement seed. |

**`instance.rosette`** (Rosette, outputs mesh): `count` copies of `mesh` (base at the origin, +Y along it, front toward +Z) around +Y, each leaning `open` degrees out from vertical with its front facing in and up, in `layers` that open, shrink and rise: flower petals, agave and succulent whorls, tulip and lily cups.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Petal or leaf. |
| `count` | int | 8 (1..200) | Copies per layer. |
| `layers` | int | 1 (1..8) | Layers, each offset by half a step. |
| `open` | number | 60 (0..175) | Degrees from vertical (0 upright, 90 flat). |
| `openStep` | number | 0 (-90..90) | Added to `open` on each further layer. |
| `scaleStep` | number | 0.85 (0.1..3) | Each layer's scale relative to the last. |
| `lift` | number | 0 | Height gained per layer. |
| `jitter` | number | 0.2 (0..1) | Random tilt, roll and size (0..1). |
| `seed` | int | 1 (-1000000000..1000000000) | Seed. |

**`mesh.branches`** (Branching Crown, outputs mesh): Branches and twigs grown out of a trunk to fill a crown outline (round, spreading, columnar, conical or vase): each rises from the trunk, arches and bends out to the outline at its own height, spiraling around by the golden angle.

| Input | Kind | Default | |
|---|---|---|---|
| `trunk` | curve3 | required | Trunk path, base to top (rising in Y). |
| `count` | int | 8 (0..40) | Primary branches. |
| `crownBase` | number | 2 | Height where the crown starts. |
| `crownHeight` | number | 4 | Height of the crown. |
| `crownRadius` | number | 2 | Widest reach of the crown. |
| `envelope` | enum: round, spreading, columnar, conical, vase | "round" | The crown's outline. |
| `angle` | number | 40 (5..80) | Degrees a branch rises from the trunk. |
| `droop` | number | 0 (0..1.5) | How far tips sag, as a share of the reach. |
| `arch` | number | 0.15 (0..1) | How much each branch bows upward before bending out. |
| `radius` | number | 0.05 (0.0005..) | Branch radius where it leaves the trunk. |
| `taper` | number | 0.3 (0.1..1) | Scale at the branch tip. |
| `twigs` | int | 2 (0..6) | Twigs per branch. |
| `twigLength` | number | 0.45 (0.05..1) | Twig length as a share of its branch's reach. |
| `twigSpread` | number | 45 (0..90) | Degrees a twig splays from its branch. |
| `jitter` | number | 0.35 (0..1) | Randomness of placement. |
| `minTipY` | number | 0 | No branch or twig ends lower than this. |
| `seed` | int | 1 (-1000000000..1000000000) | Branch seed. |
| `sides` | int | 6 (3..12) | Tube sides. |

**`points.branchTips`** (Branch Tips, outputs points3): Where `mesh.branches` with the same inputs ends: every branch and twig tip plus the trunk's top. Feed it to `instance.scatter` `centers` to put leaf clumps on the tips.

| Input | Kind | Default | |
|---|---|---|---|
| `trunk` | curve3 | required | Trunk path, base to top (rising in Y). |
| `count` | int | 8 (0..40) | Primary branches. |
| `crownBase` | number | 2 | Height where the crown starts. |
| `crownHeight` | number | 4 | Height of the crown. |
| `crownRadius` | number | 2 | Widest reach of the crown. |
| `envelope` | enum: round, spreading, columnar, conical, vase | "round" | The crown's outline. |
| `angle` | number | 40 (5..80) | Degrees a branch rises from the trunk. |
| `droop` | number | 0 (0..1.5) | How far tips sag, as a share of the reach. |
| `arch` | number | 0.15 (0..1) | How much each branch bows upward before bending out. |
| `radius` | number | 0.05 (0.0005..) | Branch radius where it leaves the trunk. |
| `taper` | number | 0.3 (0.1..1) | Scale at the branch tip. |
| `twigs` | int | 2 (0..6) | Twigs per branch. |
| `twigLength` | number | 0.45 (0.05..1) | Twig length as a share of its branch's reach. |
| `twigSpread` | number | 45 (0..90) | Degrees a twig splays from its branch. |
| `jitter` | number | 0.35 (0..1) | Randomness of placement. |
| `minTipY` | number | 0 | No branch or twig ends lower than this. |
| `seed` | int | 1 (-1000000000..1000000000) | Branch seed. |
| `sides` | int | 6 (3..12) | Tube sides. |

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

