# Allegiance material acquisition checklist

Source audit: 2026-10-05. This is the asset shopping list for replacing Allegiance's procedural and vertex-color surfaces with authored material maps. Fieldstone is already supplied. Folder names below are proposed asset names, not registrations already implemented in `al_materials.ts`.

## What to obtain for each tiling set

- `basecolor.png`: unlit albedo, sRGB, without baked shadows or highlights.
- `normal.png`: tangent-space OpenGL normal (+Y), linear.
- `roughness.png`: grayscale, white = rough, linear.
- `height.png`: grayscale, white = raised, linear. Flat finishes can use a constant height.
- Keep the source's physical repeat size in meters, source URL/name and license alongside the maps. Keep the original higher-resolution files if available. The current loader resizes arrays to 1024 x 1024.
- Maps must describe the same surface, align exactly, and tile seamlessly. Separate map files are easiest; packed maps can be unpacked during preparation.
- For exposed metals, also retain `metallic.png` if supplied. Current shading uses dielectric F0 = 0.04 and does not read metallic; it needs an extension before bare metal can look correct.
- AO is useful to retain if supplied, but is not currently loaded. Opacity/transmission maps apply to foliage and glass, which need their own shader support.

Use neutral-colored versions for finishes we recolor per building/person/party. Separate downloads for every paint or fabric color are unnecessary. Preserve material differences such as brick versus plaster and slate versus cedar.

## 1. Buildings, roofs and interiors: obtain first

These come directly from the house presets selected by `qp_city.ts`, the city styles selected by `qp_buildings.ts`, and Allegiance's military buildings.

| Proposed set | Surface and use | Source finish IDs / notes |
|---|---|---|
| `fieldstone` | Mossy rubble wall, cottages, chimneys and compound walls | Already supplied; `masonry.fieldstone` |
| `brick-red` | Red brick with mortar, houses and tenements | `masonry.brick` |
| `brick-buff` | Buff/yellow brick, manor chimneys | `masonry.buff`; can reuse red-brick structure if recoloring is sufficient |
| `stucco` | Rough render/stucco, apartments and house interiors | `masonry.stucco` |
| `paint-smooth` | Smooth painted walls, trim, doors and window frames | `paint.*`; use a neutral base |
| `brick-whitewashed` | Whitewashed masonry, cottage interiors | `masonry.whitewash`; currently classified as brick |
| `concrete` | Weathered concrete, apartment blocks, barracks, barriers | `masonry.concrete`, `masonry.darkConcrete`; light/dark can share maps and use tint |
| `sandstone-blocks` | Dressed sandstone walls, civic facades and quoins | `stone.sandstone`; visible block courses and mortar |
| `granite` | Granite foundations and dressings | `stone.granite`; also reusable on scattered rocks |
| `marble` | Polished marble floors, stairs and civic trim | `stone.marble`; continuous slab surface, not a block-wall pattern |
| `slate-slab` | Slate floors, foundations and dressings | `stone.slate`; distinct from overlapping roof slates |
| `roof-slate` | Overlapping slate roof courses | `roofing.slate` |
| `roof-clay` | Terracotta/clay roof tiles | `roofing.clay` |
| `roof-cedar` | Cedar roof shingles | `roofing.cedar` |
| `roof-standing-seam` | Standing-seam metal roofing | `roofing.seam` |
| `metal-corrugated` | Corrugated warehouse and hangar cladding | `metal.corrugated`, `metal.corrugatedGreen`; neutral or painted version |
| `metal-zinc` | Flat metal roofing and roof plant | `metal.zinc`; distinct from standing-seam geometry |
| `metal-aluminum` | Window frames | `metal.aluminum` |
| `metal-painted` | Black metal facade panels, doors, frames and fittings | `metal.black`; neutral tintable coated metal |
| `wood-oak` | Floors, doors, stair treads and furniture | `wood.oak` |
| `wood-walnut` | Doors, frames, stairs and furniture legs | `wood.walnut` |
| `wood-cherry` | Bungalow floors | `wood.cherry` |
| `wood-ash` | Modern-house floors | `wood.ash` |

For wood, obtain straight-grain seamless maps suitable for applying to individual parts. A floorboard variant is useful, but baking floorboard joints into every wooden door, table leg and handrail would be inappropriate. Oak/walnut/cherry/ash can initially share one neutral wood set if fewer downloads are preferred.

The current shader groups all woods together, all dressed stones together, and slate/clay/cedar roofing together. Preserving the variants above requires extending material selection beyond those broad categories.

## 2. Ground and roads

The terrain currently blends procedural ground, rock and snow. Roads use procedural grain. These require binding the maps to the terrain/city-tile pipelines, beyond the existing house material path.

| Proposed set | Surface and use |
|---|---|
| `asphalt` | Road surface; neutral worn asphalt without baked lane markings |
| `grass-ground` | Short grass and visible soil at the player's feet |
| `meadow-ground` | Rougher/drier grassy ground; may share `grass-ground` with tint and blending |
| `soil` | Bare earth, dirt patches and plant-pot soil |
| `rock` | Fractured natural rock, exposed terrain and scattered rocks |
| `snow` | Snow-covered terrain |
| `ice` | Frozen surface; retain crack/normal detail |
| `water-ripples` | Seamless ripple normals for animated water; two blended samples can reuse one map |

Sand, gravel, pavement slabs and cobblestones are useful later additions if we add explicit biome/path/pavement distinctions. They are not separately selected surface types in the current Allegiance shader, so do not need to be obtained for the first complete replacement.

## 3. Furniture, street props, equipment and people

Reuse concrete, wood, painted metal, zinc and aluminum from the building sets where appropriate. The additional finishes below cover the current props and characters. Cloth color variations should remain tintable.

| Proposed set | Surface and use |
|---|---|
| `wood-weathered` | Benches, crates and podium; can initially reuse oak |
| `metal-steel` | Streetlamp poles, supports and equipment |
| `metal-brass` | Table-lamp fittings |
| `fabric-clothing` | Shirts, trousers, civilian hats and sashes; neutral cotton/twill weave |
| `fabric-upholstery` | Cafe/dining chair cushions and lamp shades; oatmeal/olive via tint |
| `fabric-canvas` | Shop awnings, party banners and military webbing |
| `burlap` | Sandbags |
| `leather` | Character shoes |
| `rubber` | Shoe soles |
| `plastic` | Chair parts and reusable equipment detail |
| `ceramic-terracotta` | Plant pots |
| `ceramic-speckled` | Table-lamp bases |

Flying cars, held weapons and first-person weapons are currently simple colored meshes. Painted metal, steel and plastic can cover those surfaces after parts receive suitable IDs. Car glass should use the glass shader. Separate automotive clearcoat or weapon-specific packs are optional polish, not a prerequisite.

Skin, hair, eyes, lips and nails are also present. Skin pore detail and hair strand detail are useful upgrades, but a generic seamless building-style material cannot supply a complete character appearance. For detailed faces obtain a matching character texture set with its mesh/UV layout, or plan explicit procedural projection. Eye/cornea appearance also needs dedicated shading. These are a separate character-art task, not an additional wall-texture purchase.

## 4. Vegetation

Allegiance currently places oak, maple, birch, conifer and palm trees; shrubs, boxwood, hydrangea, ferns, grass, poppies, daisies and potted plants.

| Proposed asset | Surface and use |
|---|---|
| `bark-oak` | Oak trunks; can initially cover generic shrub branches |
| `bark-grey` | Maple trunks |
| `bark-birch` | White birch bark |
| `bark-pine` | Conifer trunks |
| `bark-palm` | Ringed palm trunks |
| Broadleaf leaf atlas | Oak/maple/birch leaves; include normal, roughness, opacity and optional translucency |
| Conifer foliage atlas | Needles/sprays, with opacity where needed |
| Palm frond atlas | Palm leaflets/fronds |
| Shrub/fern atlas | Shrub and boxwood leaves, hydrangea flowers, fern fronds |
| Grass/flower atlas | Grass blades, poppy/daisy petals and centers |

Bark should tile. Leaf/flower atlases should be arranged for individual plant parts, not as seamless photos of a whole tree canopy. Current plants are geometric leaves/blades with vertex colors, so atlases are optional if we retain that geometry and color treatment; adding detailed leaf textures requires projection/UVs and preserving the plant-part identity. Small stems, petals and fruit can continue using tintable colors with suitable roughness rather than each needing a separate downloaded set.

## Glass and effects

Clear house windows, tinted office windows, warehouse fibreglass glazing and character corneas already take glass paths. Preserve these as distinct shader materials. Obtain a subtle glass roughness/normal set only if scratches/dirt are desired; obtain a translucent fibreglass sheet set for warehouse glazing. A photograph of a window with baked reflections is unsuitable.

Sky, atmosphere, cloud noise, glowing lamps, markers, beacons and tracers are shader/effect assets. They do not require opaque tiling PBR material packs.

## Integration notes for when the assets arrive

1. `al_materials.ts` currently registers only fieldstone and loads four texture arrays. Its nine-entry table maps one layer per `SURFACE` kind, not one per original Mesha finish ID.
2. `al_shader.ts` uses these maps only for material 11 in the textured instanced houses/buildings/props shader. Terrain, roads, people, foliage and glass need additional integration.
3. `qp_city.ts` packs foundations as material 6, with surface kind 0. They need material identity retained while preserving the foundation skirt behavior.
4. `al_scatter.ts` discards finish IDs when packing furniture/plants: furniture becomes plain surface kind 0 and plants become material 17. `al_models.ts` also assigns many hand-built props generic paint/body IDs. These need explicit surface/part IDs.
5. Metal shading needs metallic support. Glass and foliage need their own transmission/opacity treatment. Existing dielectric parallax shading alone does not cover every material type.
6. Rebuild/version cached mesh packing when IDs change. Start with the building sets, then ground/roads, props, and vegetation/characters.

## Source references

- [Current loader](../examples/studio-bundle/src/games/allegiance/al_materials.ts), [map conventions](../examples/studio-bundle/assets/materials/README.md), [Allegiance shader](../examples/studio-bundle/src/games/allegiance/al_shader.ts).
- [Surface categories](../examples/studio-bundle/src/apps/quadplanet/qp_shader.ts), [house selection and packing](../examples/studio-bundle/src/apps/quadplanet/qp_city.ts), [city style selection](../examples/studio-bundle/src/apps/quadplanet/qp_buildings.ts).
- [House finishes/presets](../examples/studio-bundle/src/apps/mesha/library/house.ts), [city and military finishes/presets](../examples/studio-bundle/src/apps/mesha/library/city_block.ts).
- [Plants/furniture and military overrides](../examples/studio-bundle/src/games/allegiance/al_scatter.ts), [hand-built props and equipment](../examples/studio-bundle/src/games/allegiance/al_models.ts), [character parts](../examples/studio-bundle/src/games/allegiance/al_people.ts).
