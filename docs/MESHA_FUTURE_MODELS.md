# Mesha: future procedural models

Planning snapshot: 2026-10-10. These are proposed generators, extensions and assemblies, not implemented features or delivery commitments.

Mesha should let someone furnish a room, populate a street, build a landscape or invent a world from objects they can still understand and edit. The next library expansion should fill everyday gaps while developing reusable parts for much larger creations. A convincing spoon and a convincing space station both belong here.

Each entry below describes a **family of models**. A bookshelf should produce a narrow bedside shelf, a wall of library shelving and a battered workshop rack through meaningful controls and presets. Color changes alone do not justify a new generator. Split families when their construction, constraints or user controls become substantially different.

## What we can build on

When this plan was written, the source [library registry](../examples/studio-bundle/src/apps/mesha/library/index.ts) registered 31 definitions: 28 browsable objects and three internal components. The first twelve families below have since added twelve browsable generators and two components (45 definitions in all). This inventory comes from source inspection, not a fresh runtime verification.

| Area | Existing foundation |
|---|---|
| People | Human with body and face controls, poses, clothing, shoes, hair and viewport cloth/hair dynamics |
| Furniture | Office chair, table |
| Household | Bottle, mug, table lamp, coffee maker, potted plant |
| Architecture | Window, door, facade, dome building, walkable house, Hab Lodge, Wasteland Depot, Arcane Emporium, City Building |
| Transport | Street car with configurable sections, doors, interior, running gear and optional track |
| Mechanical | Gear, bolt |
| Nature | Rock, tree, conifer, palm, fern, shrub, grass, flowers |
| Internal components | Leg, rock piece, caster |

The City Building (`architecture.city_block`) is registered in source but absent from the inventory table in [MESHA_CATALOG.md](MESHA_CATALOG.md). It covers rectangular urban building exteriors; it should not be counted as a new future model, nor assumed to provide walkable apartments.

The current [component catalog](../examples/studio-bundle/src/apps/mesha/mesha_catalog.ts) supplies primitives, 2D profiles, paths, extrusion, lathe, sweep, loft, deformation, repetition, scatter, plants and human generation. [Object definitions](../examples/studio-bundle/src/apps/mesha/mesha_object.ts) already support nested objects, conditional controls, derived values, constraints, presets, semantic material regions and geometry limits. Those are strong foundations for ordinary rigid objects and repeated construction.

The [product overview](MESHA_APP.md) describes the broader ambition. Do not infer that every capability described there, or every capability needed below, is already implemented. In particular, general mesh booleans, automatic furnishing, semantic attachment sockets, arbitrary animal rigs and exported cloth/hair animation are separate work. Reuse existing geometry and explicit construction before introducing a new system.

## Suggested first twelve families

**Status:** all twelve are implemented, with handles and hinges as shared components; see
[Rooms and streets](MESHA_CATALOG.md#rooms-and-streets) in the catalog for what each one does and
how it is checked. The table below is kept as the original brief. Next steps for these families are
the "later" items it names: spiral stairs, fences on arbitrary paths and terrain, draped bedding
and soft upholstery, labels on books and signs, and emitted light from street lamps.

Build a usable room and street before spreading across every category. This order favors visible gaps, frequent reuse and generators that can be composed into later work. Scope each first version to the behavior listed here; expansion can follow.

| Order | Generator | Useful controls and presets | Reuse and first acceptance concern |
|---|---|---|---|
| 1 | Cabinet / drawer unit | Width, height, depth, bays, shelf count, doors vs drawers, handle style, open amount; bedside, kitchen base, workshop cabinet | Introduce reusable handles and hinges. Shelves and drawers must fit; opening travel must clear the frame. Begin with rectangular carcasses. |
| 2 | Dining chair / stool / bench | Seat size, back style, leg splay, armrests, cushion, number of seats; cafe stool, spindle chair, park bench | Reuse `component.leg`; add slats and stretchers. Differentiate from the existing wheeled office chair. Keep every leg attached across variation. |
| 3 | Bookshelf / shelving rack | Bays, shelf pitch, side panels, braces, feet, optional doors; bookcase, shop shelf, industrial rack | Reuse cabinet dimensions and shelf construction. Shelf spacing and span must remain plausible. Books are separate children, not fused decorations. |
| 4 | Book / notebook | Page count, trim size, spine, binding, cover thickness, open angle; paperback, atlas, journal | Repeated pages with a cheaper closed-book mode. An open book needs credible page curvature; lettering can wait. |
| 5 | Crate / carton / storage bin | Footprint, wall construction, lid, hand holes, stacking rim, wear; timber crate, shipping carton, plastic tote | Reuse slats, handles and panels. Build actual hollow storage; leave drainage holes and complex cutouts to explicit profiles or later tooling. |
| 6 | Plate / bowl / tray | Diameter or footprint, depth, rim, wall thickness, foot ring; dinner plate, cereal bowl, serving tray | Reuse lathe and rounded profiles. Test wall thickness and open interiors; pair with the existing mug and bottle. |
| 7 | Sofa / armchair | Seat count, cushion divisions, arms, back height, upholstery, leg style; loveseat, club chair, modular couch | Reuse legs and rounded boxes for an initial rigid upholstered model. Cushions must follow seat dimensions; soft wrinkle detail can wait. |
| 8 | Bed / mattress | Width, length, frame, headboard, footboard, mattress layers, under-bed storage; single, double, bunk | Reuse panels, slats and legs. Start with rigid mattress and bedding forms; physically draped blankets are a later extension. |
| 9 | Fence / gate / railing | Span, panel count, post spacing, infill style, height, gate opening; picket, ironwork, balcony guard | Reuse sweep and repetition. First version follows a straight span; arbitrary paths and terrain following are later. Gate swing must clear posts. |
| 10 | Stair / ramp / landing | Rise, width, steps, landing, rail side, open/closed risers; porch stair, interior flight, access ramp | Extract useful patterns from existing buildings. Require connected landings and clear headroom. Spiral stairs are a later subtype. |
| 11 | Streetlight / bollard / signpost | Pole height, arm count, fitting, base, sign dimensions; heritage lamp, modern streetlight, transit stop | Reuse lamp/profile parts and semantic finishes. Emissive geometry and actual scene illumination need separate acceptance checks. |
| 12 | Pipe / elbow / valve kit | Diameter, wall thickness, bend radius, flange, valve wheel; plumbing, factory pipe, habitat utility | Reuse sweeps, torus, bolt and radial arrays. Agree on connector dimensions first. Model visual plumbing without promising flow or engineering certification. |

For each family, ship a few deliberately different presets and useful parameter locks. The user should be able to keep a shelf's footprint while varying its construction, or keep a chair's seat height while exploring its appearance.

## The small things: reusable parts and close-up props

These deserve explicit attention. They make larger models believable and reduce repeated authoring. Parts useful only inside another object can start as internal components; independently useful objects should remain discoverable in Add Object.

| Family | Examples and variation | Larger models it supports |
|---|---|---|
| Handles and pulls | Bar, knob, cup pull, recessed grip; spacing, projection, mounting plates | Cabinets, appliances, luggage, vehicles |
| Hinges and latches | Butt hinge, strap hinge, concealed hinge, hasp, sliding bolt | Doors, gates, chests, lockers |
| Fastener companions | Nut, washer, screw, rivet, anchor; head type, diameter, length | Extend the existing bolt into a reusable visual hardware kit |
| Brackets and joints | Angle bracket, shelf bracket, gusset, corner plate, timber joint | Furniture, scaffolds, machinery |
| Feet, caps and pads | Rubber foot, leveling foot, end cap, glider, bumper | Tables, shelving, electronics |
| Wheels and tires | Spoked, solid, pneumatic, flanged; hub, tread, axle | Carts, bicycles, robots; preserve the existing caster as a small-wheel option |
| Springs and bearings | Coil spring, leaf spring, pulley, bearing housing | Vehicles, tools, machines; geometry first, no load simulation |
| Vents and grilles | Slats, louvers, perforation patterns, protective cages | HVAC, computers, appliances, transit |
| Cable, hose and rope | Thickness, slack, coil count, connectors, braid detail | Desks, workshops, boats, industrial scenes |
| Switches and sockets | Wall plate, toggle, rocker, outlet, plug, cable gland | Rooms, equipment panels, appliances |
| Trim and mouldings | Skirting, cornice, picture rail, sill, corner trim | Interiors and building facades |
| Gutters and roof details | Gutter runs, downpipe elbows, chimney pots, ridge caps, flashing | Extract and generalize details already present on buildings |
| Knobs, dials and buttons | Pointer, scale face, bezel, keycap, indicator housing | Coffee equipment, audio gear, vehicle controls |
| Cutlery and utensils | Spoon, fork, knife, spatula, ladle, whisk | Dining, kitchens, cafes |
| Writing and desk items | Pencil, pen, ruler, eraser, paperclip, binder clip, tape dispenser | Offices, classrooms, shops |
| Keys and small personal items | Key, key ring, coin, card, wallet, glasses, watch | Character accessories and believable clutter |
| Containers and closures | Jar, tin, cap, cork, pump, spray nozzle, tube | Extend bottle use into pantries, bathrooms and laboratories |
| Cloth accessories | Towel, cushion, doormat, folded cloth, curtain tie | Furnished interiors; begin with static forms |
| Tiny street details | Drain cover, curb piece, paving slab, reflector, doorbell, house-number plaque | Streets and building entrances |
| Surface debris | Pebble, leaf litter, broken brick, shard, offcut, discarded can | Forest floors, construction sites, ruins |

Keep fine details optional. A distant room should not pay for every screw thread, book page or grille opening. Wear should follow construction: chipped rims, scuffed feet, sagging shelves and bent slats should remain recognizable and bounded.

## Broader model backlog

Readiness labels are planning judgments from the current source, not measured effort estimates:

- **Direct:** a bounded first version appears suitable for the existing component catalog.
- **Compose:** build from several reusable families; dependent models or layout rules come first.
- **Research:** a convincing version needs new geometry, fitting, animation or placement support. A simpler static version may still be practical.

### Home, work and everyday interiors

| Model family | Meaningful design space | Initial route |
|---|---|---|
| Desk / workbench extension | Cable routing, modesty panels, drawers, tool rail, adjustable legs | Compose; extend the current table rather than duplicate it |
| Wardrobe / locker | Compartments, hanging rails, doors, vents, locks | Compose; cabinet, handles, hinges |
| Kitchen units | Base/wall cabinets, corner units, worktops, islands | Compose; cabinet kit plus countertop fitting |
| Sink / basin / faucet | Bowl count, depth, mount, spout, taps, drain | Direct for a simple basin; complex joined bowls need research |
| Toilet / bathtub / shower | Bowl and tank proportions, tub profile, screen, shower head | Research for convincing continuous sanitary forms |
| Refrigerator / oven / dishwasher | Size, compartments, handles, controls, door opening | Compose; exterior first, fitted interiors later |
| Kettle / toaster / grinder | Capacity, housing, lever, lid, hopper, tray | Direct; complements the existing coffee maker |
| Cookware | Saucepan, frying pan, stockpot, lid, handles | Direct; lathed vessels and handle components |
| Pendant / floor / wall light | Fixture count, shade, mount, cable, arm articulation | Compose; extend lamp parts and finishes |
| Rug / curtain / blind | Size, pattern scale, pleats, hem, opening | Direct for static rugs/blinds; research for fitted drapes |
| Picture frame / mirror / clock | Border profile, mat, face, hands, mount | Direct; image content, lettering and reflection are separate concerns |
| Basket / hamper | Shape, weave spacing, handles, lid | Direct for bounded coarse weave; budget close-up strands |
| Cleaning kit | Broom, mop, bucket, brush, vacuum | Direct for props; optional hose/cable composition |
| Food and produce | Bread, pastry, fruit, vegetables, sliced portions | Direct for simple forms; research convincing cuts and soft surfaces |

### Electronics, music and creative tools

| Model family | Meaningful design space | Initial route |
|---|---|---|
| Monitor / television | Aspect, bezel, stand, mount, rear ports | Direct |
| Keyboard / mouse / controller | Layout, key profile, casing, buttons, thumbsticks | Direct for block forms; ergonomic shells need research |
| Laptop / tablet / phone | Body dimensions, hinge angle, camera cluster, ports | Direct; labels and screens can start as material regions |
| Computer case / server rack | Form factor, bays, fans, panels, cable runs | Compose; grille, fastener and rack-unit parts |
| Speaker / headphones / microphone | Driver count, cabinet, grille, stand, headband | Direct for simple forms; research fitted ear cushions |
| Synthesizer / mixer / audio interface | Channels, keys, faders, knobs, patch points | Compose; shared panel controls, keyboard and sockets |
| Guitar / bass / violin | Body outline, scale length, neck, bridge, tuning hardware | Research; credible body transitions and fitting matter |
| Drum / cymbal / percussion kit | Shell sizes, lugs, stands, cymbal profile, layout | Compose; repeated hardware and lathed shells |
| Camera / tripod / telescope | Lens stack, controls, leg spread, mount, tube | Direct initially; composition for accessories |
| Art and fabrication tools | Easel, palette, brushes, sewing machine, 3D printer | Compose; larger equipment needs clear mechanisms and access |

### Architecture, streets and infrastructure

| Model family | Meaningful design space | Initial route |
|---|---|---|
| Wall / floor / ceiling modules | Thickness, openings, finish, trim, structural bays | Direct with explicit opening construction; reusable room kit |
| Roof system | Gable, hip, shed, mansard, dormer, tile courses | Compose; generalize building roof patterns |
| Balcony / porch / veranda | Projection, posts, railing, steps, canopy | Compose; stair and railing kit |
| Shopfront / market stall / kiosk | Display bays, awning, counter, shutters, stock | Compose; build on existing facade/storefront work |
| Garage / shed / greenhouse | Footprint, framing, cladding, roof, opening style | Compose; research glazing behavior where needed |
| Apartment / office interior | Room count, corridor, service core, partitions | Research; extend City Building with real circulation and interiors |
| School / clinic / library | Wings, classrooms or rooms, corridors, entrances | Compose after a constrained room-layout system |
| Factory / workshop | Structural spans, cranes, loading bays, equipment zones | Compose; depot and industrial parts are useful foundations |
| Civic / sacred building | Nave or hall, courtyard, colonnade, tower, roof | Compose; distinct regional construction should guide separate families |
| Road / sidewalk / intersection kit | Width, lanes, curb, crossings, corners, markings | Direct for straight pieces; research coherent junctions and slopes |
| Street furniture | Bin, mailbox, bus shelter, bench, bike rack, hydrant | Compose from small hardware and furniture families |
| Playground / outdoor exercise kit | Frame, platform, slide, swings, climbing bars | Compose; static first, clearances essential |
| Bridge / viaduct | Span, piers, arch or truss, deck, railings | Direct for straight bounded spans; curved alignments later |
| Tunnel / culvert / retaining wall | Cross-section, length, portal, ribs, drainage | Direct; terrain integration is separate |
| Rail / platform / overhead wire kit | Gauge, sleeper pitch, platform height, poles, catenary | Compose; extend the street car's optional track into independent parts |
| Utility infrastructure | Power pole, transformer, substation, water tower, antenna | Compose; connectors, cables, panels and repeated hardware |
| Construction kit | Scaffold, ladder, barrier, cone, pallet, portable cabin | Direct/Compose; repeated bays with bounded counts |
| Memorial / fountain / public sculpture | Plinth, basin, tiers, ornament, plaques | Direct for architectural forms; water and figurative sculpture need separate work |

### Nature, agriculture and terrain features

| Model family | Meaningful design space | Initial route |
|---|---|---|
| Tree lifecycle extension | Sapling, dead tree, stump, fallen trunk, exposed roots | Extend existing trees; research connected root geometry |
| Additional plant structures | Bamboo, cactus, succulent, vine, reeds, aquatic plant | Direct for several bounded structures; vines need support-aware paths |
| Mushroom / fungus | Cap, gills, stalk, clusters, shelf fungus | Direct; keep fine gills optional |
| Crops and orchard rows | Species structure, growth stage, row spacing, harvest state | Compose; reuse plants and ground scatter |
| Rock formations | Cliffs, strata, arches, cave mouths, scree | Research for convincing connected formations; reuse rocks for scree |
| Snow / ice formations | Icicle, drift, ice sheet, crystal cluster | Direct for isolated forms; research accumulation on arbitrary objects |
| Pond / riverbank / waterfall setting | Banks, stones, bed, reeds, falls height | Compose for geometry; animated water is separate |
| Farm structures | Barn, silo, coop, trough, raised bed, irrigation kit | Compose; building, vessel, pipe and fence families |
| Garden structures | Pergola, trellis, planter, arbor, compost bin | Compose; reuse potted plant, beams and slats |

### Transport, machines and moving things

| Model family | Meaningful design space | Initial route |
|---|---|---|
| Cart / hand truck / wheelbarrow | Bed, wheel count, handles, frame, load | Compose; an accessible first wheeled assembly |
| Bicycle / cargo bike | Frame size, wheelbase, tubes, bars, carrier | Compose for static models; chain path and fit need care |
| Wheelchair / mobility scooter | Seat, wheel arrangement, footrests, controls, frame | Compose; use credible human scale and transfer clearance |
| Motorcycle / scooter | Frame, fairing, engine volume, seat, suspension | Research for coherent bodywork; static geometry first |
| Car / van / pickup | Wheelbase, body class, roofline, doors, lights, interior | Research; a shared vehicle shell system precedes many presets |
| Bus / coach | Length, axle count, doors, seating, floor arrangement | Compose/Research; reuse transit construction without assuming tram geometry fits |
| Train / carriage / freight wagon | Bogies, couplers, car length, cargo, interior | Compose; street-car parts provide patterns, new vehicle types need their own constraints |
| Boat / ship | Hull sections, beam, draft appearance, deck, cabin, rigging | Research; hull continuity and deck fitting |
| Aircraft / helicopter | Fuselage, wing plan, tail, gear, rotor | Research; these are visual generators, not aerodynamic design tools |
| Drone / rover / robot arm | Arm count, wheelbase, joints, sensors, gripper | Compose for static posing; articulation/export support later |
| Engine / pump / compressor | Housing, cylinders, belts, ports, mounts | Compose; machinery details and pipe kit |
| Crane / excavator / forklift | Boom reach, chassis, cab, attachment, joint pose | Compose/Research; stable parent-child transforms and clearance checks |
| Tools and workshop machines | Hammer, wrench, drill, vise, lathe, bench saw | Direct for hand tools; Compose for machines |

### Characters, animals and imagined worlds

| Model family | Meaningful design space | Initial route |
|---|---|---|
| Human wardrobe extension | Coats, jackets, uniforms, workwear, layered outfits | Extend the current human; research layering and collision |
| Character accessories | Hat, helmet, bag, belt, jewelry, eyewear, held tool | Direct for standalone props; research reliable body attachment |
| Dog / cat / horse / livestock | Body proportions, muzzle, ears, limbs, tail, coat | Research; start with one static quadruped before sharing anatomy |
| Bird / fish / insect | Beak or mouth, fins or wings, body segments, pose | Research; separate anatomy families rather than one universal creature |
| Toy / plush / figurine | Proportions, seams, joints, accessories | Direct for rigid toy forms; research soft continuous plush shapes |
| Suit of armor / space suit | Plates, joints, helmet, packs, hoses, silhouette | Compose/Research; fitting to humans without clipping |
| Castle / fortress / dungeon | Walls, towers, gates, rooms, stairs, battlements | Compose; circulation and modular joints before scale |
| Fantasy props | Chest, lantern, potion vessel, staff, wand, altar, portal frame | Direct/Compose; builds on Arcane Emporium materials and vocabulary |
| Ruined / reclaimed structures | Missing panels, broken walls, exposed beams, vegetation | Research for connected breakage; bounded authored damage states first |
| Habitat / spacecraft / station modules | Pressure shell, airlock, corridor, docking ring, equipment | Compose/Research; build on Hab Lodge while adding real module connections |
| Alien ecosystems | Branch rules, leaf forms, mineral growth, unusual symmetry | Direct for visual experiments; habitat-aware growth later |
| Large creatures / mechs | Limb modules, armor, appendages, pose, equipment | Research; coherent articulation and fitting before procedural scale |

## Think big: assemblies worth building toward

Assemblies should preserve access to their constituent generators. A cafe is useful when the user can still change one chair, a counter's depth or a machine's finish. Flattening everything into one anonymous mesh would lose much of Mesha's value. This requires scene/composition work beyond simply nesting geometry in an `ObjectDef`.

| Target assembly | What it should produce | Foundations and hard part |
|---|---|---|
| Furnished room | Bedroom, kitchen, bathroom, study or living room with editable furniture and clutter | Room surfaces, cabinets, seating, bed, lighting; fit objects while keeping doors, circulation and usable space clear |
| Cafe / bookstore / workshop | A coherent small business, from frontage to fitted interior | Existing coffee maker, mug and storefront patterns plus counters, shelving and stock; preserve working aisles and access |
| Transit stop / station | Shelters, platforms, track, signage, ticket machines and waiting furniture | Existing street car plus independent infrastructure; boarding heights and connected passenger routes |
| Neighborhood street | Varied buildings, entrances, gardens, sidewalks and street furniture | Houses and City Building plus street kit; lot boundaries, corner conditions and slope transitions |
| Farm / village | Crop rows, barns, fences, wells, sheds, carts and homes | Plant, farm and building families; coherent paths and reusable regional construction |
| Industrial yard / port | Warehouses, pipes, tanks, cranes, containers and service roads | Depot, hardware and machinery; equipment clearances and bounded repetition |
| Castle settlement | Keep, wall walks, courtyard, gatehouse, market and surrounding homes | Modular fortifications and stairs; complete walkable routes rather than disconnected towers |
| Space habitat / orbital station | Linked living, laboratory, greenhouse and docking modules | Hab Lodge, dome, pipe, airlock and furniture kits; consistent connectors, interior access and hierarchical detail budgets |
| Biome scene | Forest clearing, wetland, desert oasis or alpine slope | Existing foliage and rocks plus new ground detail; deterministic distribution, exclusions and density budgets |
| Modular megastructure | Arcology, vertical city, enormous station or walking machine | Mature module and connection systems; staged generation, caching and explicit scene budgets before increasing scale |

## Shared work that unlocks more models

These are enabling tasks, not reasons to postpone every simple object. Add them when a concrete family needs them.

| Capability | Models it unlocks | Practical first scope |
|---|---|---|
| Component conventions | Cabinets, machines, buildings and vehicles | Shared units, origins, facing directions, connector dimensions and material-region names; document these before building dependent families |
| Attachment points | Accessories, pipe networks, vehicles, habitat modules | Named position/orientation anchors and compatibility checks; not present as a general socket contract in today's `ObjectDef` |
| Profile and shell helpers | Basins, hulls, casings, continuous bodywork | Consistent wall thickness and predictable capped/open boundaries for a constrained shape family |
| Opening / cutout construction | Panels, sanitary ware, caves, vehicle shells | Explicit openings for common cases first; evaluate general booleans separately rather than assuming the catalog provides them |
| Path-following construction | Fences, rails, gutters, cables, rivers | Stable frames, bend limits and endpoint joins along paths; terrain following needs its own placement rules |
| Surface-aware placement | Clutter, vines, accessories, vegetation | Support surfaces, orientation, keep-out zones and bounded overlap checks |
| Constrained room composition | Furnished interiors, shops, public buildings | Rectangular rooms, fixed door clearance zones and a few furniture arrangements before arbitrary floor plans |
| Articulation and export | Robots, animals, vehicles, characters | Static pose controls first; verify hierarchy, skinning and animation separately from ordinary mesh export |
| Detail tiers and caching | Books, baskets, crowds, streets, megastructures | Per-family coarse/fine settings and explicit triangle limits; measure evaluation cost before promising interactive regeneration |
| Labels and authored images | Books, signs, instruments, displays | Dedicated text/decal or texture inputs; blank semantic regions are acceptable first versions |
| Damage construction | Ruins, scrap, broken furniture | Seeded missing/bent parts with safe bounds first; fracture and physical destruction are separate systems |

## A practical release sequence

1. **Room essentials:** first twelve families, prioritizing furniture, shelf contents and reusable fittings. Show them together in a manually composed furnished room and a small street-side scene.
2. **Places people use:** kitchen and bathroom objects, electronics, street furniture, shop fittings and a fuller construction kit. Add simple room composition only when the constituent models are ready.
3. **Connected environments:** modular rooms, roofs, rail infrastructure, bridge spans, farm kits and industrial utilities. Develop anchors and placement rules against these concrete cases.
4. **Complex forms and characters:** vehicle shells, hulls, animals, layered clothing and articulated machinery. Prototype one representative family before committing to dozens of variants.
5. **Large worlds:** stations, neighborhoods, castles and space habitats. Promote assemblies once editability, connectivity and generation budgets hold up at useful scale.

Within each release, choose a mix of one major object, a few ordinary props and the small components they share. This keeps the library useful between ambitious projects. A cafe counter with cups, a spoon, a book, a chair and the existing coffee maker can demonstrate more practical value than several unrelated landmark exteriors.

## What makes a future model ready

Use the existing [catalog authoring and verification workflow](MESHA_CATALOG.md). A proposed family is ready to ship when:

- The default and distinct presets read clearly at their intended viewing distance, and the exposed controls describe the object in ordinary language.
- Variation stays inside the family's design space. Locks preserve dimensions and chosen features; hidden controls do not produce contradictory results.
- Parameter extremes and important combinations pass deterministic checks. Test object-specific relationships such as drawer travel, shelf fit, tire clearance, stair headroom and accessible entrances.
- Semantic material regions survive evaluation and export. Thin walls, glass, double-sided leaves and overlapping parts receive explicit visual inspection where relevant.
- Repeated parts have limits. Record measured evaluation cost and geometry size for representative defaults and extremes; do not copy timings from unrelated generators.
- Contact sheets show defaults, presets, extremes and seeded variations. Live BDD checks cover new viewport behavior and important composition or export paths when applicable.
- Exported geometry is checked for the intended use. Document whether the result is static, hollow, walkable, articulated or only an exterior representation. Visual assets are not automatically watertight print models or manufacturing-ready parts.

The goal is a library where small useful objects accumulate into editable places, and the same dependable parts eventually support the extraordinary ones.
