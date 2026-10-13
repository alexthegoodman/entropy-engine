# The Abyss - The Open World Update

This pass turns the two chapters into an open-world RPG shooter: a floor with places to find and fights that find you, loot, levels, river powers and cyborg upgrades, cover and stealth, a bigger and darker world, positional sound and an orchestra. What follows is what exists now, then a roadmap of what is left (pick up from **Roadmap**).

## Exploring

- **Places of note** (`PLACES_OF_NOTE`, ab_script2.ts): the Vigil, the Broken Stair, the Silent Circle, the Bone Field, the Whispering Vein (a cave), the Source, the shrine, the Western Dark, Station Nine, the Lifter, Kappa and the convoy. Walking within a place's radius **discovers** it (banner, XP, journal entry) - no menu or giver.
- **Encounters** (`ENCOUNTERS`): each place of note can hold a fight that starts when you walk into it (quest kind `encounter`, banner *ENCOUNTER*). Its prize is guarded by a hard enemy - a champion, an elite seer, a behemoth and its rider - and is either a **potion** that teaches a river power or a piece of **Union tech** from a wreck (Station Nine, the Lifter, Kappa, the convoy).
- **Side stories that find you**: *Lantern Eleven* (a distress call when you pass within ~420 m of the wreck) and *The Procession* (a column of pilgrims under attack, within ~200 m).
- **The Whispering Vein**: the first cave - a fallen slab of the north wall with a temple carved inside. A winding tunnel opens into a domed chamber lit by crystals; the roof darkens the light (`LightMap.roofs`), so the Veil power and the lumen bead matter there. Built in ab_atmos.ts (`CAVES`, `buildCave`, `caveSolids`, `caveRoofs`).
- **The Western Dark**: west of the river the floor drops into an endless canyon (x -1600 to -7000) that cannot be crossed on foot; past x -1450 the fallout hurts and SAGE warns you back. Together with the smoke pall it makes the Abyss read as far bigger than the playable map.

## RPG (ab_rpg.ts)

- **XP and levels**: kills (by enemy kind and rank), discoveries, quests and encounters give XP; `xpToNext = 90 + 55 * level`, cap 20. Each level gives a perk point.
- **Perks** in three paths - *Soldier* (Steady Hands, Plate Bond, Field Medic, Quick Hands), *Ghost* (Soft Step, Ambusher, Scavenger), *River* (Deep Well, Attunement, Riverblood). Spend them on the CHARACTER page of the inventory.
- **River powers** learned from potions, paid for with **Resonance** (regenerates): Lumen Lance (piercing bolt), Still Water (absorbing ward), River Surge (area blast), Veil (12 s of near-invisibility), Mend (heal).
- **Union tech** found in wrecks and installed at once: Kinetic Dampers, Optic Overlay II, Dermal Weave, Reflex Booster, Subdermal Medpump.
- **Enemy ranks**: initiate, veteran, elite (tougher, hit harder, more XP, better loot; rank-coloured markers).
- **Enemy kinds**: warden, staff-bearer, adept, skirmisher, seer (heals allies), champion, rogue synthetic gunner, and the **behemoth** - an elephant-sized beast (Mesha `creature.behemoth`) ridden by a warden, which breathes a cone of fire and stomps.
- **Loot**: the fallen drop a glowing pickup - credits, slugs, medgel, river draughts, artifacts.

## Combat, cover and stealth

- **Cover**: barricades (jersey barriers, sandbags, stone walls - Mesha `street.barricade`) at the LZ, the FOB, the firebase checkpoints, the settlement fields and open floor. Shots stop at cover; the enemy uses it too.
- **Crouch**: `C` toggles, `Ctrl` holds. Lower, slower, quieter: unseen enemies notice you much closer, and the HUD shows CROUCHED / HIDDEN. Hitting an enemy who has not seen you does bonus damage (more with Ambusher).
- **Alert**: shooting or being hit raises an alert so nearby enemies converge.

## Chapter One additions

- A 30-second **prologue** before the old opening: the Union and SAGE, the Deep Bore, and the people below by their river of light (scored with the orchestra's *prologue* cue). The city shot gained a SAGE line.
- **Citizens flee**: as the squad nears the settlement, fourteen civilians run for the nearest door (`settlementDoors`) and vanish inside; enemy gunners can target them.
- **Smoke and fire**: dense plumes billow from the Abyss (soft, transparent, sorted far to near), fires burn across the floor and rim, and a pall of smoke hangs over everything.

## World look

- **The pall**: an exponential height fog of smoke over the Abyss (`World.pall` in the shader) that also hides the far map.
- **Water**: the river and the Source's pool use a water pattern with ridged caustics, the falls a white-water pattern with mist.
- **Kesh** has a scales pattern (Mesha pattern 22, `scale.*` materials).
- **Positional sound** (engine `SpatialSource`): constant-power pan, an interaural delay and a muffle for sound behind walls, so you can tell where shots come from.
- **Music director** (`Mood` in ab_audio.ts): floor, surface, firebase, flight and combat moods; the intro has horns, trombone and strings (Brass and PhysMod voices).

## Controls

| Key | Pad | Action |
| --- | --- | --- |
| `C` / hold `Ctrl` | Right stick click | Crouch |
| `G` | Right shoulder | Cast the selected power |
| `B` | D-pad right | Next power |
| `X` | D-pad down | Drink a river draught |
| `Tab`, then `P` | Start | Inventory, then the CHARACTER page (perks, powers, tech) |
| `E` | West | Interact (now edge-triggered: mounting Kesh no longer flickers) |
| `V` | North | Whistle for Kesh |

The pack (weapons, ammo, medgel, draughts, credits) stays on the HUD's right; the team is on the left.

## Tests

- `examples/studio-bundle/tests/abyss_rpg.test.ts`: crouch, cover, stealth, loot, XP, perks, powers, tech, enemy kinds, the behemoth, encounters, Eleven, the Procession, saving, the prologue timing, fleeing citizens, the cave.
- `examples/studio-bundle/tests/abyss_chapter2.test.ts`: Chapter Two, including the mount regressions.
- `tests/features/abyss_live.feature`: the real window - the new scenario *The opening, the fleeing city, and the Whispering Vein* captures the prologue, the citizens and the cave.

## Roadmap (not done yet)

1. **Depth of field.** Far haze is done with the pall and terrain; a real DOF post-pass (blur by depth past ~600 m) needs an engine post-process hook.
2. **The Bone Field has no bones.** It is a place and an encounter (the behemoth) but needs Mesha rib cages, skulls and tusks scattered on it.
3. **More caves.** Only the Whispering Vein exists. `CAVES` is data: add entries (path, width, height, chamber) with their own encounters - a lava tube near the Western Dark, a flooded grotto by the Source.
4. **Cave entrance.** From outside the Vein reads as a dark lump with boulders; it wants a carved temple portal and a light spilling out.
5. **Audio has not been heard.** The orchestra, the moods and the spatial panning are tested as numbers only (no audio device in the test box). Listen to the intro, a firefight from each side, and a shot from behind a wall, and retune the levels.
6. **Behemoth polish.** The legs swing about one hip pivot each; it wants knee bends, a trunk, a howdah for the rider and a dust burst on stomps.
7. **Mission depth.** Encounters are one fight each. Next: multi-stage missions that pull you in (the Procession escorting to the shrine, Eleven's survivors asking you to fetch parts), consequences carried into Chapter Three.
8. **More Union tech.** Five upgrades; candidates - a grapple, thermal sight, a shoulder drone that marks enemies.
9. **Perk trees as a screen.** Perks are a list; a three-column tree with prerequisites would read better.
10. **Citizens.** They run home and vanish; they could peek from doors, and be found later in Chapter Two.
11. **Smoke cost.** Plumes are sorted transparent instances; on low-end GPUs cap the number of near puffs.
