# Mossbridge: the RPG level to block out through MCP

A standing brief for a Claude Code session. Alex draws all the art. Your job is to build the world he
draws on: flat-coloured, blocked-out surfaces in the right places, the lighting, and the whole quest as
gameplay logic, then prove it is finishable and hand it over. Do not paint anything. Every surface you
create is a flat colour on purpose, so Alex knows what is a placeholder.

Everything below is backed by code that ran. The canonical build is
`examples/studio-bundle/levels/mossbridge.json`: 53 tool calls in order (`calls`) and four headless
playtests (`playtests.quest`, `gate_blocks`, `gap_east`, `gap_west`). The addon registers 31 `canvas_*`
tools; `tools/list` shows their full descriptions and schemas. `tests/features/canvas_world.feature` replays it
against the real addon and asserts the counts in section 5, so the coordinates here are checked, not
guessed. Section 8 lists what was not checked.

## 1. Setup

```bash
cd entropy-engine/examples/studio-bundle
npm run build-canvas-surfaces          # the app loads dist/canvas_surfaces.js, not the TypeScript
cd ../..
cargo run --release --bin example -- canvas-surface-demo
claude mcp add --transport http entropy-engine http://127.0.0.1:47100/mcp   # once; ENTROPY_MCP_PORT changes the port
```

Check the bundle is current before blaming a tool: `dist/canvas_surfaces.js` must contain
`canvas_add_prefab`. If `tools/list` shows no `canvas_*` tools, the bundle is stale or the app is not up.
The Play button was always in the top row of the sidebar (`Play`, `Logic`, `Timeline`); it now walks a
player when the scene has one, and falls back to click-only Play when it does not.

If `canvas_list_scenes` already has a `Mossbridge` scene, load it (`canvas_load_scene`) and extend it: skip
sections 4 and 5 step 1, keep every name and counter as it is, and re-run the playtests after each change.
As of this brief the level has been proven in tests and a throwaway village, but never built in Alex's
own scene library.

Before touching the scene, call `canvas_get_scene` and `canvas_list_scenes`. If `unsavedChanges` is true
or the open scene has brush strokes, stop and ask: Alex's drawing lives in the open scene. Build into a
new scene named `Mossbridge` (step 1 below). Never pass `confirmDiscard: true` unless Alex said so for
that scene, and never `overwrite: true` on a surface with strokes.

## 2. The game

**The Lantern Keeper of Mossbridge.** The village lantern on the north hill has gone out and the village
is dark. The Keeper needs five glowcaps (glowing mushrooms) from the east and west woods to rekindle it.
Bring them, the Keeper opens the north gate, walk up the road, light the lantern, win.

Controls: WASD walk (relative to the camera), E interact, Q and R turn the camera, wheel zooms.

Counters (all start at 0 each Play, shown in the sidebar): `glowcaps`, `quest`, `gate_open`, `coins`, `won`.

| Who | Trigger | Says / does |
|-----|---------|-------------|
| Play starts | start | "Mossbridge is dark. Find the Keeper. WASD walks, E talks." |
| Glowcap 1 to 5 | walk within 1.3 | hides itself once, `glowcaps` +1, "Glowcap N of 5." |
| Chest | E within 2, once | `coins` +5, "Five coins. You have N." |
| Miller | E within 2.2 | "Glowcaps grow in the eastern and western woods." |
| Keeper, first talk | E, `quest` < 1 | "The lantern has gone out. Bring me 5 glowcaps." `quest` +1 |
| Keeper, mid quest | E, `quest` >= 1 and `glowcaps` < 5 | "You have N of 5 glowcaps." |
| Keeper, five caps | E, `quest` >= 1, `glowcaps` >= 5, `gate_open` < 1 | "The north gate is open. Light the lantern." Gate hides, `gate_open` +1 |
| Keeper, after | E, `gate_open` >= 1 | "Go north. The lantern is on the hill." |
| Shrine Lantern | E within 2.5, once, `gate_open` >= 1 | "The lantern blazes. Mossbridge is lit again. You win!" Beam shows, clip Rise plays, `won` +1 |
| Shrine Lantern, too early | E, `gate_open` < 1 | "The lantern is cold. Speak to the Keeper." |

**Rule order matters.** Rules run in the order they were added, and a later rule sees counters an earlier
one changed. The four Keeper rules are added as: after, mid quest, five caps, first talk. Each reads a
counter before the rule that writes it runs, so one press of E says exactly one thing. If you add a rule
that reads a counter, add it before the rule that increments it.

## 3. The map

x is east, z is south (toward the default camera), y is up, ground is y = 0. The world is 70 by 70 and
the player is clamped to +-29. The player starts at (0, 14) at the south end of the road facing north.

```
                     north (-z)
                 Pine(-7,-24)  SHRINE LANTERN (0,-26)  Pine(8,-22)      z -26  Beam (hidden until win)
  ---------------- Fence West ---------- [ GATE ] ---------- Fence East ----------------   z -17
  Pond(-20,-18)  Birch4(-15,-14)         (road)       Glowcap5(12,-14)  Oak4(15,-12)
                 Bakery(-11,-8)                        Chest(3.5,-5)  Glowcap2(20.5,-6) Oak3(24,-9)
   Glowcap4(-14,-3) Birch2(-22,-2)                                 Oak1(17,-2)  Glowcap1(18.5,1.5)
  Keeper House(-10,3)  Keeper(-5.5,4)   PLAZA (0,7)   Miller(7,3)  Mill(11,4)    Oak2(21,6)
   Glowcap3(-19,6)  Birch1(-17,8)   Lamp W(-4,9)  Lamp E(4,9)
   Birch3(-21,13)                        HERO start (0,14)
                     south (+z)
```

The road (`Road`, 3 wide) runs from z = 18 to z = -26. The fences run to the world edge on both sides of
the gate, so the gate is the only way north. The fence ends leave less than the player's width beside
the gate posts, so nobody squeezes past.

## 4. Build order

Replay `calls` from `mossbridge.json` in order, one MCP tool call each. Do not batch or reorder: later
calls name earlier things ("Hero", "Gate") and the logic depends on the order above. In words:

1. `canvas_new_scene` `{name: "Mossbridge", confirmDiscard: true}` only after section 1's check.
2. `canvas_set_lighting` golden_hour with a light fog.
3. Ground, Road, Plaza: `canvas_add_prefab` `ground` three times (70x70 grass, 3x44 tan road lifted 0.02,
   12x10 stone plaza lifted 0.03).
4. Hero, then `canvas_set_world` `{player: "Hero", bounds: 29}`, then Keeper and Miller (`human` prefabs).
5. Keeper House, Mill (width 5), Bakery: `house` prefabs, yawed a little so doors turn toward the plaza.
6. Chest, Lamp West, Lamp East, Pond.
7. Ten trees (`tree`, varied height and leaf colour: Oak, Birch, Pine).
8. Fence West, Fence East (length 28 each), Gate (width 3).
9. Shrine Lantern (`lamppost`, height 4.5), then `Beam`: `canvas_create_surface` cylinder, radius 0.5,
   height 16, at (0, 8, -26), `visible: false`.
10. Five `pickup` prefabs, size 0.22, colour [90, 255, 200].
11. `canvas_set_lighting` with three lamps: both plaza lanterns and the shrine.
12. `canvas_create_clip` "Rise" (2 s) and `canvas_set_keyframes` on `Beam`, channel `sy`, 0.05 to 1.
13. Logic: `canvas_add_rule` for the start message, `canvas_add_collectible` x5, the chest, the Miller,
    the four Keeper rules in the order in section 2, the Shrine Lantern (with `otherwise`).
14. `canvas_set_world` `{player: "Hero"}` again (harmless; confirms it survived).

Then verify, then save.

## 5. Verify before you say it is done

1. `canvas_world_stats`: expect 70 surfaces, 32 groups, 60 logic nodes, 47 wires, 1 clip, 0 painted
   surfaces, about 354 MB open and about 4.5 MB saved. Each surface holds about 5 MB of pixels while the
   scene is open (that is why a level is budgeted around 70 surfaces, not the 128 limit).
2. `canvas_get_logic`: `problems` must be `[]`.
3. `canvas_playtest` with `playtests.quest`: `passed: true`. It walks the whole game headlessly: talks to
   the Keeper, collects the five glowcaps, opens the gate, lights the lantern. The waypoints are there
   because the walk is a straight line to its goal and stops at solids.
4. `canvas_playtest` with `playtests.gate_blocks`, `playtests.gap_east` and `playtests.gap_west`: each must
   FAIL at its second step ("solid surface"). That is the gate and the fences doing their job. If one
   passes, the player can get past the gate: check the fences and the posts.
5. `canvas_play` and look at what the person will see; `canvas_get_play_state` shows the counters; then
   `canvas_stop`. A playtest never draws anything and leaves the scene exactly as it found it; real Play
   restores hidden surfaces and the player's spot on Stop.
6. `canvas_save_scene` (name "Mossbridge"). Report the id.

If any check fails, fix the level and say what you changed. Do not weaken a check to get green.

## 6. Lighting

`canvas_set_lighting` takes a preset (`editor`, `day`, `golden_hour`, `dusk`, `night`, `overcast`) and
any overrides. Mossbridge ships as golden hour with fog 0.006 and three lamps. Things worth trying, one
call each, and worth screenshotting for Alex: `dusk` (lamps carry the plaza), `night` with the lamps'
`intensity` raised to 3 and `reach` 4, `overcast` for the forest. There are at most four lamps; they are
point lights with no shadows. A lamppost's glowing head is a paint colour, not a light, so pair a real
lamp with each one you want to glow. Lighting is saved with the scene and is undoable.

## 7. Handing over

Tell Alex, briefly: the scene name and id, the counts from step 1 of section 5, and that everything is a
flat placeholder colour. Surfaces are named `<Group> <Part>`, for example `Keeper House Walls`,
`Keeper House Roof R`, `Keeper House Gable front` (the gable planes are cut to a triangle, paint inside
it), `Hero Torso`, `Oak 1 Crown`. Groups are the things logic points at, so hide, show or move a group,
not its parts. To repaint a placeholder: `Draw` mode, pick the surface, paint; the tools refuse to
recolour a surface that already has strokes.

Then update `cc-manager/tasks.json` and the Entropy section of `CLAUDE.md` as usual. Do not commit.

## 8. Limits and known traps

- Only one animation clip's tracks apply at a time: playing a second clip drops the first one's pose.
  Mossbridge has one clip on purpose.
- Collision is XZ boxes around each solid surface, taken from the world-space mesh. A rotated house
  blocks a slightly bigger box than its walls, and roofs and gables are never solid. There is no
  vertical movement, no jumping, and no interior spaces yet.
- `walkTo` in a playtest is a straight line. If it says "stopped by a solid surface", add waypoints.
- Prefab colours are placeholders; parts a person paints over keep working (logic points at groups).
- Not verified: the real keyboard. Tests inject keys into the same state the keyboard fills, so movement,
  collision and the follow camera are proven, but a physical keyboard was not used. The Escape key looks
  like it never reaches addons: `src/startup.rs` only maps Enter, the arrows, Space and Delete to
  strings, so "Esc returns to editing" in the sidebar may not work. Use the Stop button. Not tested with
  a stylus in Play. Windows only.
- Not verified: how it feels at 60 fps on Alex's machine, memory measured by the OS (the 354 MB is
  arithmetic over the arrays the addon holds), or a scene with real hand-painted surfaces (those save
  as full images, about 3 MB each, so 60 painted surfaces would be near the 256 MiB limit).
- If a tool call hangs or errors with "still starting", the addon has not finished `onInit`; wait a
  second. Tool calls that fail roll back anything they half-changed.

## 9. Good next steps (on the board as backlog cards)

Interior spaces through the `Move player to` node, an NPC dialogue tree with more than one line, a
day/night node so logic can change the lighting, sharing pixel buffers between flat surfaces to cut the
5 MB each, compressing painted surfaces on save, and mapping Escape through `startup.rs`.
