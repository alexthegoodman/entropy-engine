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
`mesha_view` takes an optional `zoom` (2 frames twice as close) for details of long objects.

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
| Household | Potted Plant | `household.potted_plant` | 12 | 3 | 3 | 12 | 124 | Ready | 11 ms |
| Architecture | Window | `architecture.window` | 15 | 5 | 4 | 4 | 117 | Ready | 2 ms |
| Architecture | Facade | `architecture.facade` | 18 | 4 | 9 | 6 | 118 | Ready | 10 ms |
| Architecture | Dome Building | `architecture.dome_building` | 24 | 5 | 7 | 5 | 174 | Ready | 11 ms |
| Architecture | House | `architecture.house` | 63 | 10 | 18 | 21 | 298 | Ready | 41 ms |
| Architecture | Hab Lodge | `architecture.hab_lodge` | 41 | 8 | 10 | 18 | 337 | Ready | 32 ms |
| Architecture | Wasteland Depot | `architecture.wasteland_depot` | 41 | 8 | 11 | 22 | 208 | Ready | 29 ms |
| Architecture | Arcane Emporium | `architecture.arcane_emporium` | 39 | 7 | 7 | 18 | 222 | Ready | 43 ms |
| Transport | Street Car | `transport.street_car` | 56 | 9 | 8 | 32 | 362 | Ready | 15 ms |
| Architecture | Door | `architecture.door` | 23 | 5 | 4 | 6 | 139 | Ready | 3 ms |
| Mechanical | Gear | `mechanical.gear` | 14 | 4 | 3 | 1 | 105 | Ready | 14 ms |
| Mechanical | Bolt | `mechanical.bolt` | 11 | 5 | 2 | 2 | 88 | Ready | 6 ms |
| Nature | Rock | `nature.rock` | 11 | 3 | 0 | 1 | 85 | Ready | 47 ms |
| Nature | Tree | `nature.tree` | 28 | 5 | 3 | 2 | 143 | Ready | 33 ms |
| Nature | Conifer | `nature.conifer` | 21 | 4 | 2 | 2 | 115 | Ready | 24 ms |
| Nature | Palm | `nature.palm` | 22 | 5 | 3 | 5 | 126 | Ready | 10 ms |
| Nature | Fern | `nature.fern` | 18 | 4 | 2 | 3 | 118 | Ready | 8 ms |
| Nature | Shrub | `nature.shrub` | 20 | 5 | 2 | 4 | 138 | Ready | 34 ms |
| Nature | Grass | `nature.grass` | 19 | 4 | 1 | 2 | 131 | Ready | 14 ms |
| Nature | Flowers | `nature.flowers` | 22 | 4 | 2 | 4 | 134 | Ready | 5 ms |
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

### Themed buildings

Three buildings built to the house's standard for thematic scenes: each is walkable, with a real
entrance, interior walls and doorways, stairs where it has more than one floor, an **Inspect** group
that lifts the roof or cuts a storey away, and no furniture. They lean on a few materials made for
them: self-lit `glow.*` (light strips, crystals, candlelit windows: the viewport draws them unlit),
`composite.*` hull panels and `solar.cell` (a panel-seam pattern), `metal.corrugated*` (ribbed sheet,
rusted or not), `metal.rust*` and `masonry.darkConcrete` (rust and grime streaks),
`glass.fibreglass`, `wood.weathered`, `fabric.sandbag`, `stone.purple`, `stone.moss`,
`masonry.plaster` and `roofing.violet`/`roofing.moss`.

**Hab Lodge** (high-tech interplanetary lodgings): a panelled habitat hull with a pill-shaped
section (flat walls between rounded shoulders; the keel and crown are service voids) on four or
eight landing legs with hydraulic pistons and lit foot pads, over an optional chamfered landing pad.
One or two decks: a corridor runs the hull's length between guest cabins (1 to 3 each side of a
centre cell, on both sides, every deck), each through a chamfered doorway with a frame, each with a
rounded viewport. At the front of the lower deck the centre cell is the airlock vestibule: a hatch
whose leaf slides aside, a light ring, a canopy, a landing platform and a boarding stair to the
ground. At the back, with two decks, it is the stair core: a spiral stair of wedge treads round a
column with a helical handrail, through a stairwell guarded on the upper deck except where the stair
arrives. Open lounges at both ends with long panoramas along the sides and across the ends; the
observation dome (glass, ribs, collar, beacon) opens over the -X lounge through a well in the crown.
Outside: structural hull rings at every cabin wall, shoulder light strips, nav lights, solar arrays on
masts, radiator wings on the back crown shoulder, an antenna dish. Viewport width stays clear of the
partitions and of the open hatch; cabins are at least 2.3 m deep and the stair core at least 0.8 m in
radius. Five presets: Orbital lodge, Mars outpost inn, Luxury star hotel, Lunar bunkhouse and
Deep-space research lodge. Geometry tests walk it: the open hatch leads through the airlock across the
corridor (and the closed hatch seals it); every doorway on every deck opens into a cabin reaching the
hull; every spiral tread is where its riser says, with 2 m of headroom, and the stair lands on the
upper deck; lifting the crown and hiding the top deck expose the decks.

**Wasteland Depot** (apocalyptic warehouse): a steel portal-frame shed after the end of the world.
I-section columns and rafters at every bay line, purlins, girts and a concrete plinth wall carry
rusted corrugated cladding and roof sheets. Decay is per sheet and per pane, stable for the seed (the
`keep` node field): missing roof sheets open the roof onto the purlins, salvage patches in another
finish are bolted over the cladding and roof, fibreglass skylight sheets, clerestory strip windows
with broken panes, some nailed over with planks; a gutter hangs loose. The roller door rolls up
part-way with its bottom slats buckled; a steel side door (`architecture.door`) stands ajar under
caged lamps and a sign board. Inside: a mezzanine along the back on columns standing on the office
partitions, with a railing, reached by a steel stair up the left wall; under it, a row of offices,
each with a doorway and a window onto the floor. Fortifications: sandbag walls either side of the
door, Czech hedgehogs, tyre stacks, razor wire coils along the eaves and the barricade, and a braced
watchtower with a parapet, ladder, searchlight, tarp and a scrap wind turbine. A stove flue with a rain
cap. Five presets: Scavenger depot, Raider fortress, Abandoned factory, Settler workshop and
Irradiated garage. Geometry tests: the rolled-up door opens onto the floor as far as the offices (and
rolled down it shuts); roof damage removes a share of the sheets and stripping the roof opens it to
the sky; the mezzanine stair's treads are where they should be and land on the deck; every office has
a doorway.

**Arcane Emporium** (magical retail shop): a crooked storybook shop. A stone ground floor with a
projecting bay shop window (leaded panes, a panelled stall riser, a cornice with a glowing rune strip,
a little roof), a glazed door with a fanlight up two steps, a hanging sign (iron scroll bracket, board
with a glowing star) and a lantern. A jettied, half-timbered upper floor (posts, rails, braces and a
St Andrew's cross, a bressumer on brackets, joist ends carrying the oversail) under a steep gable roof
whose slabs sag and ripple with **Crookedness**, which also tilts the timbers, twists the chimney and
curls the tower's hat. Gables have king posts, collars and round moon windows. The round stone tower
on the left rises a storey above the shop: its wall is a ring of narrow stone pieces per band, and
`keep` removes the pieces where its doorways and lancet windows are, so the openings in the curved
wall are real (each lancet has glass, a lead bar, a stone arch and a sill). Inside the tower, stone
block steps wind 300 degrees a storey round a newel from beside its doorway to sector floors at each
storey. The shop and workroom downstairs and two rooms upstairs open off each other through
doorways, and the tower through doorways from the shop and the front room. The hat is swept up a
curling path with a glowing band and a star finial; crystals float around it; a glowing rune circle
with standing stones lies before the door; **Candlelit windows** makes every pane glow. Five presets:
Twilight emporium, Hedge-witch apothecary, Archmage's curios, Pumpkin-hat sweet shop and Grim
grimoire vault. Geometry tests: the door opens into the shop and the tower opens off it on both
floors; the tower's steps climb evenly and land on floors; every lancet is a real opening and the wall
between them solid; lifting the roofs and cutting away the upper floor open the rooms to view.

The live BDD feature captures each building: exteriors, roof-off and cut-away interiors, locked
Variations, the lodge and emporium under Gallery night lighting (glow reads best there), and a GLB
export of the lot.

**Door:** a hinged door in its frame, facing +Z, frame centred on a wall `depth` thick: raised
panels (1 or 2 columns, up to 4 rows) with mouldings, half glazed with glazing bars, flush, or
ledged-and-braced planks; knob or lever, hinges, casing on both faces, an arched fanlight with
sunburst bars. **Exterior** adds a threshold and kick plate and puts the leaf in the `entry`
region instead of `leaf`, so a building can paint its front door apart from its interior doors.
**Open** swings the leaf into -Z about its hinge. Five presets: Six-panel, Georgian fanlight,
Half-glazed kitchen, Cottage plank and Modern flush.

## Transport

**Street Car** (`transport.street_car`): a tram, from a heritage trolley to articulated light rail,
with a full interior. One to three body **sections** of four to nine **bays** each, joined by
bellows; a bay holds a window and two rows of seats, or a doorway, and a bogie sits under one.
Doors are spread between the bogies (one to three per side per section) or at the ends with the
bogies inboard, on both sides or one, and come as plug doors that pop out and slide apart, sliding
doors running inside the wall, or folding leaves swinging in about the jambs, all with **Doors
open** from shut to fully open. Each end is a driver's cab built once and mirrored: straight cab
sides into a superellipse nose (**Bluntness** goes from a bullet to a bluff, square-cornered end),
stacked as a dash, a windscreen band that leans back by **Windscreen rake**, a letterboard with a
curved destination sign and a roof that follows the plan, so every livery line runs unbroken
round the nose. Panoramic, split or three-pane windscreens, wipers, headlamps and tail lamps,
mirrors on arms, a bumper strip and a heritage lifeguard tray. Inside the cab: a partition with
a doorway and lights, a console with screens or a controller and brake wheel, and the driver's
seat. The saloon has facing bays, all-forward rows or benches along the sides (cushions, backs,
frames, aisle legs and grab handles), stanchions at every bay boundary and in wide doorways,
ceiling rails with hand straps, linings, sills, coves with advertising cards, ceiling lights and
a ribbed floor. A low floor lifts the seats over the wheels onto podiums (the wheel size is capped
by the floor height so they stay low); a high floor hangs boarding steps under each doorway. Bogies
have flanged wheels, side frames, axle boxes and coil springs (axles, transoms and motors only
where the floor clears them). A single-arm pantograph on insulators or a pair of trolley poles
(one raised, one hooked down), both raised by **Collector raised**, roof equipment pods, gutters,
and an optional stretch of paved street track with grooved rails or ballasted track on sleepers.
Window shapes are rounded, arched or square, with optional transom lights. Five presets: City tram,
Heritage streamliner, Vintage trolley, Articulated light rail and Metro shuttle. **Show roof** lifts
the roof, ceilings and roof gear off. Geometry tests ride it: every doorway on every side, in all
three door styles, opens from the street onto the floor and its shut doors seal it; every window
bay is a real opening glazed with see-through glass; no wheel pokes above the floor or its podium;
the noses are glazed with a desk inside, and the length is the sections plus both cabs; the roof
lifts off and the sections join under bellows. Live BDD captures the city tram, a close-up through
its windows with see-through and with ordinary glass (the seats show through only the first), the
interior from above, the heritage and vintage cars, the light rail at night, a locked Variation and
a GLB export.

It brings its own materials: **see-through window glass** (`glass.window`, `glass.windowTinted`,
`glass.windowBronze`, `glass.windowGreen`), liveries (`paint.cream`, `paint.crimson`,
`paint.brunswick`, `paint.signal`, `paint.silver`), `wood.teak`, transit moquette
(`fabric.moquette`, `fabric.moquetteRed`), `leather.green`, `rubber.floor` (ribbed), granite setts,
track ballast, creosoted sleepers and `glow.warmWhite` cabin lights. Window glass has a `clear`
share: the viewport leaves that share of each pane's pixels unpainted in a fine ordered dither
(fewer at grazing angles, where glass mirrors more), so the interior shows through an opaque
pipeline with no sorting, and contact sheets average the same dither away. Other glass stays
glossy and tinted but opaque.

## Foliage

Eight plant objects share one set of `Plants` components (below) and a foliage look the viewport
draws for every `leaf.*`, `grass.*` and `flower.*` material:

- **Leaves are thin, double-sided sheets** (`mesh.leaf`): ovate, narrow, round, heart, lobed (oak),
  strap, petal and a sawtooth conifer spray, with a V-fold along the midrib and a curl toward the tip.
  They're real geometry, so they survive GLB export (the viewport culls back faces, so each leaf
  carries both).
- **Per-leaf color and crown shading ride in the UVs.** uv.x runs from a leaf's base (a touch darker)
  to its tip. uv.y's whole part (0..15) is how deep the leaf sits in its crown, and its fraction is
  how far the leaf's color leans toward the material's second color, `tint`. That's how an autumn
  crown mixes orange and red, and how grass tips dry to straw and lavender spikes turn purple. The
  viewport bakes the tint into each vertex color (`packVertices`) and darkens deep leaves. It also
  lets light through: a leaf lit from behind glows warm. Bark gets furrows running along each branch
  (`bark.*`), and birch its dark lenticels. The CPU contact-sheet renderer draws the same things.
- **Budgets, not surprises.** `plant.tree` thins its deepest twigs above about 2,400 branches and
  spreads a triangle budget over its twigs (the tree object allows 130,000 leaf triangles). Grass caps
  blades and plumes across a patch, and shrubs cap mophead clusters, so every configuration the
  fuzzer tries stays interactive.
- **Everything stands on the floor.** Whatever a plant sweeps below it (a leaning trunk's base ring,
  a spruce's lowest sprays, fronds arching to the ground) is squashed flat onto the ground rather
  than poking through.

**Tree:** a broadleaf tree. The trunk either forks into limbs at the crown base or keeps a central
leader, and it has root flare, lean, gnarl and bark relief. Controls cover branching depth (1 to 4),
limbs, twigs per branch, branch angle, limb and twig reach, and a Weeping control (twigs hang in
curtains; negative values sweep branches up). Crowns can be round, oval, spreading, conical or
columnar. The canopy is leaves, leafy clusters (stylized puffs) or bare winter branches, with leaf
shape, size, width, count and hang, and a color-variety control. Presets: English oak, Silver birch,
Weeping willow, Autumn maple, Cherry blossom, Storybook and Winter oak.

**Conifer:** one leader with whorled limbs. Crowns are conical, columnar or rounded (a pine on a
tall bare trunk). Foliage is flat needle sprays in two ranks along each branchlet (fir, spruce),
bottlebrush needle tufts (pine) or stylized stacked tiers. Presets: Norway spruce, Blue spruce, Scots
pine, Italian cypress, Stylized pine and Golden fir.

**Palm:** a ringed, tapering trunk curving along a Bézier, with a swollen boot. The crown is a
spiral of arching pinnate fronds: young ones rise from the top, older ones fan out wider. It can
carry dead fronds hanging below and coconuts. Presets: Coconut palm, Date palm, Royal palm,
Windswept and Pygmy date.

**Fern:** a rosette of arching pinnate fronds with coiled fiddleheads in the middle (`plant.frond`'s
`unfurl`). Fronds can be undivided straps instead (bird's nest), and an optional ringed trunk makes a
tree fern. Presets: Boston fern, Maidenhair, Bird's nest, Tree fern and Bracken.

**Shrub:** a natural multi-stemmed bush (a short trunk forking at once into arching stems), or a
clipped ball, hedge or cone. A clipped shape is a lumpy body wearing an area-weighted coat of leaves
(`instance.onSurface`), with the body kept and shaded as deep foliage so no gaps show. Balls and cones
can stand on a bare stem. Flowers can be five-petal blossoms or mopheads, which are domes of
four-petal florets (a hydrangea). There are also berries. They sit at the twig tips of a natural
bush or over a clipped body's upper faces. Presets: Garden shrub, Boxwood ball, Clipped hedge,
Hydrangea, Topiary cone, Holly standard and Azalea in bloom.

**Grass:** a clump (`plant.blades`) or a patch of clumps. Blades lean out and curl over, and their
tips can shade toward the tint. Optional stalks carry feathery plumes (pampas), flower spikes
(lavender) or seed ears (wheat, reeds). Presets: Meadow tuft, Lawn patch, Pampas grass, Dry savanna,
Lavender and Reeds.

**Flowers:** one flower or a bed of them, scattered on a jittered spiral with size and per-flower
tint variety. Each bloom has 1 to 3 rings of petals, rising from flat (daisy) to a closed cup
(tulip) and curling at the tips, around a seed head. Stems bend and blooms nod, with narrow, strap,
ovate or lobed leaves. Presets: Daisies, Red tulips, Poppies, Sunflower, Pink cosmos and Snowdrops.

**Potted Plant:** a hollow turned pot (classic rim, cylinder, bowl or urn) with soil and an optional
saucer. The plant composes the Nature library (a fern, a parlour palm, a topiary ball, tulips) or
grows here: a succulent rosette spiralling by the golden angle and blushing at its tips, or a snake
plant's upright swords. Presets: Terracotta fern, Parlour palm, Succulent bowl, Snake plant, Topiary
urn and Tulip pot.

These plants are geometry only. They don't sway in wind, and they have no alpha-cut leaf cards or
LODs. The GLB carries one flat color per material, so per-leaf tint and crown shading are
viewport-only. Geometry tests check that leaves are double-sided, that the UV encoding round-trips
into vertex colors, and that a tree stands on the floor within its leaf budget with inner leaves
shaded deeper. They also check that weeping lowers the leaves, that a conifer tapers to a spire,
that palm fronds crown the trunk, that a clipped hedge is covered, and that a potted plant rises
from soil inside its pot. Live BDD captures an oak, a willow, a back-lit autumn maple, the same maple
bare and then varied with its size and finishes locked, a spruce and its stylized tiers, a pine, a
coconut palm, tree and Boston ferns, a hedge, a hydrangea recoloured pink, pampas, lavender, tulips,
a sunflower, potted fern and succulent, and a composed garden.

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
| `keep` | Per copy of a repeat: drop the copies where this is false (`"=rand(index, 11) >= roofDamage"`, a window's wall pieces). |
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
leathers, glass (clear, green, amber, frosted), ceramics (with terracotta), stones (granite,
sandstone, slate, marble), masonry (red, buff and whitewashed brick, stucco, fieldstone), roofing
(slate, asphalt shingle, clay tile, cedar shake, standing-seam metal), paper, cork, potting soil;
barks (oak, grey, dark, pine, birch, palm), stems, fruit; and foliage: leaves (summer and spring
green, evergreen, silver olive, tropical, autumn orange and gold, maple red, copper beech, cherry
blossom, spruce and blue spruce needles, fern, palm, succulent), grasses (lawn, meadow, dry,
lavender) and petals (white, cream, yellow, orange, red, pink, purple, blue) with seed heads and
pollen; and themed architecture: composite hull panels, titanium, gold foil, corrugated sheet (bare,
rusted, red, green), rusted plate, concrete, weathered and charred timber, canvas, sandbags, solar
cells, regolith, mossy and twilight stone, lime plaster, tinted, violet and fibreglass glazing, and
self-lit `glow.*` colors; and transit: see-through window glass (clear, tinted, bronze, sea-green),
cream, crimson, Brunswick green, signal yellow and silver liveries, teak, moquettes, green
leatherette, ribbed rubber flooring, granite setts, ballast and sleepers. Each has a color, roughness, metalness and a surface pattern (wood grain,
fabric sheen, brushed, speckle, bark furrows, birch, foliage, glow, corrugated ribs, rust, hull panel
seams) the viewport draws; foliage also has a second
`tint` color each leaf varies toward.

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

**`instance.scatter`** (Scatter on Ground, outputs mesh): `count` copies of `mesh` spread over a disc on the floor (an even, jittered spiral), each turned, tilted and sized at random: flower beds, meadows, pebbles.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Instance, standing on its origin. |
| `count` | int | 12 (1..2000) | Copies. |
| `radius` | number | 0.5 (0..) | Disc radius. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |
| `scaleMin` | number | 0.8 (0..) | Smallest size. |
| `scaleMax` | number | 1.2 (0..) | Largest size. |
| `tilt` | number | 8 (0..60) | Degrees of random tilt. |
| `falloff` | number | 0 (0..1) | 0 even; 1 crowds the middle. |
| `tintVariation` | number | 0 (0..1) | Random lean toward the foliage tint per copy. |

**`instance.onSurface`** (Distribute on Surface, outputs mesh): `count` copies of `mesh` over the faces of `surface` (area-weighted), each copy's +Y along the surface normal and its +Z along the surface tipped up by `tilt`: leaves over a clipped hedge, blossoms on a shrub.

| Input | Kind | Default | |
|---|---|---|---|
| `surface` | mesh | required | Surface to cover. |
| `mesh` | mesh | required | Instance (a leaf lies flat on it). |
| `count` | int | 200 (0..20000) | Copies. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |
| `scaleMin` | number | 0.8 (0..) | Smallest size. |
| `scaleMax` | number | 1.2 (0..) | Largest size. |
| `tilt` | number | 25 (-90..90) | Degrees each copy lifts off the surface. |
| `tintVariation` | number | 0.4 (0..1) | Random lean toward the foliage tint. |
| `keepSurface` | bool | false | Also output the surface, shaded as deep foliage. |
| `surfaceRegion` | string | "" | Region for the kept surface (empty keeps its own). |
| `minNormalY` | number | -1 (-1..1) | Only faces whose normal's y is at least this (0: upward-facing only). |

### Plants

**`mesh.leaf`** (Leaf, outputs mesh): One double-sided leaf lying flat: it grows along +Z from the origin (after its stalk), its upper face looks up +Y, and `curl` bends the tip down. Also petals, grass blades and conifer sprays.

| Input | Kind | Default | |
|---|---|---|---|
| `shape` | enum: ovate, lanceolate, round, heart, lobed, blade, petal, spray | "ovate" | Outline: ovate, lanceolate, round, heart, lobed (oak), blade (grass), petal, spray (a flat conifer sprig). |
| `length` | number | 0.1 (0.0005..) | Blade length. |
| `width` | number | 0.05 (0.0001..) | Blade width. |
| `fold` | number | 15 (0..80) | Degrees each half rises from the midrib. |
| `curl` | number | 20 (-180..360) | Degrees the blade bends down toward its tip. |
| `petiole` | number | 0 (0..) | Stalk length. |
| `segments` | int | 5 (2..32) | Rows along the blade. |
| `lobes` | int | 3 (1..24) | Lobes (lobed) or teeth (spray). |
| `tipTint` | number | 0 (0..1) | Tint gradient toward the tip (dry grass, lavender). |

**`plant.tree`** (Tree, outputs mesh): A branching tree standing on the origin: a trunk (forking into limbs, or one leader to the top), limbs and twigs as tapering bark tubes in `barkRegion`, and `leaf` copies on every twig, shaded darker deep inside the crown.

| Input | Kind | Default | |
|---|---|---|---|
| `height` | number | 6 (0.05..) | Overall height. |
| `trunkRadius` | number | 0.18 (0.001..) | Trunk radius at the base. |
| `levels` | int | 3 (0..4) | Branching depth below the trunk. |
| `branches` | int | 6 (1..64) | Main limbs. |
| `twigs` | int | 4 (0..24) | Branches on every limb, and on theirs. |
| `crownBase` | number | 0.35 (0..0.95) | Share of the height that is bare trunk. |
| `leader` | number | 0 (0..1) | 0 forks into limbs; 1 one leader to the top. |
| `angle` | number | 45 (0..150) | Degrees limbs leave their parent at. |
| `reach` | number | 0.6 (0.02..3) | Limb length relative to the crown height. |
| `subReach` | number | 0.5 (0.05..1.5) | Branch length relative to its parent. |
| `crownShape` | enum: round, oval, conical, spreading, columnar | "round" | How limb length changes up the trunk. |
| `radiusRatio` | number | 0.55 (0.05..1) | Child radius relative to its parent. |
| `gnarl` | number | 0.3 (0..2) | Random bending. |
| `droop` | number | 0 (-2..4) | Positive arches branches down (weeping); negative sweeps them up. |
| `lean` | number | 0 (0..60) | Degrees the trunk leans. |
| `flare` | number | 0.4 (0..2) | Root flare at the base. |
| `sides` | int | 12 (3..32) | Trunk sides (thinner branches use fewer). |
| `segments` | int | 6 (2..24) | Points along each branch. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |
| `leaf` | mesh | null | Leaf (or cluster) placed on every terminal branch; its +Z points out along the twig. |
| `leaves` | int | 8 (0..200) | Leaves per terminal branch. |
| `leafStart` | number | 0.3 (0..1) | Where leaves begin along a twig. |
| `leafAngle` | number | 55 (0..120) | Degrees between a leaf and its twig. |
| `leafDroop` | number | 0.1 (-1..2) | 0 leaves face the sky; 1 they hang. |
| `leafAlign` | enum: twig, flat, random | "twig" | Spiralling around the twig facing up; in two flat ranks either side (fir sprays); or any orientation (clusters, puffs). |
| `leafScaleVariation` | number | 0.25 (0..0.9) | Random size spread. |
| `tintVariation` | number | 0.5 (0..1) | Random lean toward the leaf material's tint. |
| `leafBudget` | int | 120000 (1..1000000) | Triangles all the leaves may use; the count per twig drops to fit. |
| `bark` | number | 0.5 (0..2) | Trunk surface roughness. |
| `bloom` | mesh | null | Flower or fruit placed at twig tips, its +Y facing out. |
| `blooms` | int | 0 (0..12) | Per twig tip. |
| `barkRegion` | string | "default" | Region for the wood. |
| `leafRegion` | string | "" | Region for the leaves (empty keeps the leaf's own). |

**`plant.frond`** (Frond, outputs mesh): A pinnate frond (fern, palm) growing along +Z from the origin and arching down: a tapering stem in `stemRegion` and leaflets on both sides in `leafRegion`. `unfurl` below 1 coils the tip into a fiddlehead.

| Input | Kind | Default | |
|---|---|---|---|
| `length` | number | 0.8 (0.001..) | Frond length. |
| `arch` | number | 60 (-90..270) | Degrees it arches over its length. |
| `unfurl` | number | 1 (0..1) | 1 open; lower coils the tip. |
| `leaflets` | int | 18 (0..80) | Leaflets on each side. |
| `leafletLength` | number | 0.22 (0.01..1) | Longest leaflet relative to the frond. |
| `leafletWidth` | number | 0.25 (0.02..2) | Leaflet width relative to its length. |
| `leafletAngle` | number | 70 (5..120) | Degrees from the stem toward the tip. |
| `leafletDroop` | number | 15 (-60..80) | Degrees the leaflets hang below the frond's plane. |
| `shape` | enum: ovate, lanceolate, round, heart, lobed, blade, petal, spray | "lanceolate" | Leaflet outline. |
| `stalk` | number | 0.15 (0..0.9) | Bare stem share at the base. |
| `stemRadius` | number | 0.006 (0.0002..) | Stem radius at the base. |
| `tintVariation` | number | 0.3 (0..1) | Random lean toward the tint. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |
| `stemRegion` | string | "default" | Region for the stem. |
| `leafRegion` | string | "default" | Region for the leaflets. |

**`plant.blades`** (Grass Clump, outputs mesh): A clump of grass blades (or straps, spikes) rising from a small disc on the floor, leaning out and curling over, with an optional tint gradient toward the tips.

| Input | Kind | Default | |
|---|---|---|---|
| `count` | int | 40 (1..600) | Blades. |
| `height` | number | 0.3 (0.001..) | Blade height. |
| `heightVariation` | number | 0.4 (0..0.95) | Random height spread. |
| `width` | number | 0.008 (0.0002..) | Blade width. |
| `radius` | number | 0.04 (0..) | Radius of the clump's base. |
| `lean` | number | 25 (0..85) | Degrees the blades lean out. |
| `curl` | number | 50 (0..240) | Degrees each blade bends over. |
| `tipTint` | number | 0 (0..1) | Gradient toward the tint color at the tips. |
| `tintVariation` | number | 0.3 (0..1) | Random lean toward the tint. |
| `segments` | int | 4 (2..16) | Rows along each blade. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |
| `shape` | enum: ovate, lanceolate, round, heart, lobed, blade, petal, spray | "blade" | Blade outline. |

**`plant.stalk`** (Stalk, outputs mesh): A tapering, closed round stalk along a path: palm and tree-fern trunks (with `rings`), flower stems, reeds.

| Input | Kind | Default | |
|---|---|---|---|
| `path` | curve3 | required | Path from the base up. |
| `radius` | number | 0.05 (0.0001..) | Radius at the base. |
| `tipRadius` | number | 0.03 (0.0001..) | Radius at the top. |
| `sides` | int | 12 (3..64) | Sides. |
| `rings` | number | 0 (0..400) | Bands along the stalk. |
| `ringDepth` | number | 0.12 (0..0.6) | How deep the bands pinch. |
| `flare` | number | 0 (0..2) | Swelling at the base. |
| `bark` | number | 0 (0..2) | Surface roughness. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |

**`plant.shade`** (Foliage Shading, outputs mesh): Shades geometry that isn't leaves (stylized puffs, conifer tiers, a hedge's body) like foliage: how deep in the crown it sits, lower parts deeper by `gradient`, and a random tint lean per part.

| Input | Kind | Default | |
|---|---|---|---|
| `mesh` | mesh | required | Input. |
| `occlusion` | number | 0 (0..1) | How buried (0 outside, 1 deep inside). |
| `gradient` | number | 0.4 (0..1) | Extra depth toward the bottom. |
| `tintVariation` | number | 0 (0..1) | Random lean toward the tint per part. |
| `seed` | int | 0 (-1000000000..1000000000) | Seed. |

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
