# Game World Planner: design intents and the agent loop

The Game World Planner (`cargo run --bin example -- game-planner`) is a topographic map editor for
game worlds: terrain with real drainage and contours, spots, roads, rivers, regions, travel times,
a codex and a quest organizer. This document covers the part that lets a designer **plan at the
level of vision and leave the building to agents**: design intents.

![Agent proposals previewed on the map](../public/game-planner-intents-proposed-live.png)

## The idea

Placing every village and routing every road by hand is implementation work. What a designer
actually knows is the intent: *"two quiet farming villages in these western lowlands"*, *"the walk
from the port to the caldera should take about four hours"*, *"something eerie in the southern
flats"*. The planner lets you sketch exactly that, on the map, and turns it into three things:

1. **A work order for agents.** Each intent carries its shape, your words, parameters and the
   spatial context an agent needs (terrain, what is inside and nearby, route ends).
2. **An acceptance test.** Every intent kind except freeform is checked against the world, live.
   The map shows ✓/✗ on every intent badge and the toolbar shows how much of the plan the world
   meets. Agents read the unmet ones as their queue; you see at a glance whether the world still
   matches your vision after any edit (move a spot and a pacing route re-times itself).
3. **A review surface.** Agents never edit the world. They file proposals, which appear on the map
   as violet previews (dashed roads, ringed spots, move arrows, region outlines). Click one to
   review it, accept (A) or reject (R) it, or accept a whole proposal at once. Every decision is one
   undo step.

## Sketching intents

Pick the **Intent** tool (`I`) and a shape in the toolbar:

| Shape | How | Kinds |
| ----- | --- | ----- |
| Pin   | one click | landmark, quest, freeform |
| Area  | click vertices, Enter or double-click to close | settle, danger, quest, freeform |
| Route | click start, click end (ends snap to spots and follow them when they move) | connect, pacing, freeform |

The kind defaults from the shape (area → settle, route → pacing, pin → landmark); choose one in the
toolbar or the inspector. Then write the directive in your own words. Simple patterns are read from
it - counts ("three", "2"), place types ("fishing villages" → ports, "keep" → fortress), threat
levels ("danger level 8"), travel times ("1 hour 30 minutes on horseback") - and fill any
parameter you haven't set explicitly. Precedence: the kind's defaults, then the directive, then what
you set in the inspector.

| Kind | Checked as met when |
| ---- | ------------------- |
| settle | at least *count* settlements (or spots of the chosen type) are inside the area |
| danger | a `danger` region at or above the threat level covers the area |
| landmark | a spot of the type is within the pin radius (4% of the world) |
| connect | a road (not a river) passes within 0.6 km of both ends |
| pacing | travel time between the ends, by the chosen mode, is within the tolerance of the target |
| quest | a mission's objective or start spot is in the area / at the pin |
| freeform | you mark it done (an LLM interprets it) |

With nothing selected, the inspector shows the **Plan Board**: every intent, its check, and a
health score.

## The built-in Planner Agent

**Draft with Planner Agent** (or **Draft open intents** for all of them) answers an intent from the
world's own data, offline and deterministically:

- **settle**: scores every terrain cell inside the area (dry, gentle, low, well-watered, coastal for
  ports), places the requested number of places at a spacing that fits the area, names them in the
  genre's style, and routes a road from each to its nearest neighbor with A* over the terrain.
- **danger**: a danger region over the area (or raises an existing one) and a lair - camp, dungeon
  or boss by threat level - in the area's most remote high ground.
- **landmark**: a spot at the pin, nudged onto the nearest land if the pin is in water.
- **connect**: a terrain-routed road (or the trail/highway you asked for).
- **pacing**: too long → it tries a trail, a road and a highway along a terrain route and proposes
  whichever lands nearest the target (a highway can overshoot as badly as nothing); too short → it
  moves the destination spot along the bearing until the journey takes the target time.
- **quest**: a mission given and turned in at the nearest settlement, with its objective an existing
  spot in the area or a new quest site.
- **freeform**: declines; that is what LLM agents are for.

## External agents (MCP)

The same loop is open to any agent through the addon's MCP tools:

| Tool | Purpose |
| ---- | ------- |
| `game_planner_list_intents` | the open intents with full context and acceptance criteria, plus the Markdown brief |
| `game_planner_claim_intent` | mark an intent as yours (`intentId` or `intentNumber`); the map shows who has it |
| `game_planner_create_intent` | sketch an intent from a conversation ("make the north dangerous") |
| `game_planner_propose_revision` | file changes for review; pass `intentId`/`intentNumber` |
| `game_planner_proposal_status` | what the designer accepted or rejected |
| `game_planner_sample_terrain`, `game_planner_calculate_travel` | ground truth for placing things |

Proposals may be minimal: `add_spot { name, spotType, x, y }` gets its elevation from the terrain,
its color and icon from the type; `add_path { name, pathType, points }` gets width and surface from
the type; `modify_spot { targetId, after: { x, y } }` records the old position so the map can draw
the move. Supported change types: `add_spot`, `modify_spot`, `delete_spot`, `add_path`,
`modify_path`, `delete_path`, `add_region`, `modify_region`, `add_mission`, `add_codex`. Invalid
changes come back in `errors` and are not filed.

Without MCP, **Copy Agent Brief** (Agents tab) puts a Markdown work order on the clipboard - world
summary, every unmet intent with its context and done-when criteria, and the proposal format - to
paste into any chat. **Copy context for an agent** does the same for one intent as JSON.

Intents also appear in the Game Design Document (section 7, with ✓/✗) and in the SVG map export.

## Planning in depth: terrain, biomes, population, quests

Intents say *what* you want; these tools let you plan the ground, the ecology, who lives where and
how quests play, on the same map. With nothing selected, the map's sidebar holds the Plan Board,
the active tool's settings, and the **Terrain & Procedural** tools (heightfield, erosion, rivers,
settlements, points of interest) that used to have a tab of their own. The **World** button in
the layer bar clears the selection to get back to it.

### Sculpt (E): terrain editing

| Mode | How | What it does |
| ---- | --- | ------------ |
| Raise, Lower, Smooth, Flatten, Roughen | drag a brush (`[` `]` resize it) | build up, dig, soften, level (to the ground where the stroke starts, or a set height), add broken relief |
| Canyon | click along its course, Enter | cuts a floor `depth` below the ground with walls up to the rim; the floor runs downhill from the first point, so water could follow it |
| Mountain range | click along the spine, Enter | adds a crest of peaks and saddles that tapers at the ends, with ridged spurs on the flanks |
| Road bed | click along a road, Enter | cut and fill: the route's profile is smoothed and its grade capped (8% by default), shoulders blend into the land, water is left for bridges |
| Plateau / pad | outline an area, Enter | levels it to the mean ground (or a set height) with a soft edge |

Every stroke is one undo step. A selected road has **Grade terrain along it**; a river **Carve a
canyon for it**; a spot **Level ground here** (a building pad of the radius you pick).

**Snap to Landscape.** Spots have a *Snap to landscape* checkbox, on by default: the spot's
elevation is the ground's and follows it through drags and terrain edits. Turn it off for a sky
citadel or a tower top and the elevation field becomes editable and stays put when the terrain
changes (typing an elevation turns the snap off). Flatten and Plateau have the same checkbox for
their target height.

### Paint (N): planning marks

Paint marks where forest, jungle, pine, meadow, farmland, scrub, marsh, sand, rock, snow, ash,
blight, ruins or built-up ground should be. Marks are drawn as symbols (trees, tufts, hatching,
dots) over a soft tint, never as real foliage: they are a plan for artists and level builders.
The brush can be confined to a region ("Only inside", or **Paint inside this region** from the
region). A mark replaces other surface marks under it unless you untick that.

Regions read the paint: the region inspector lists what is painted inside (share and km²),
suggests a biome from it ("Paint says forest (64% forest) - use it"), fills or clears the outline
with a mark, and has a **Biome & regional plan**: climate, flora, fauna, resources, mood / light /
music, level range and notes, plus the faction that holds it.

### Populate (U): enemies and NPCs from the Codex

The Codex has a **Bestiary** (creature) category next to characters. With Populate, a click places
the chosen entry (a named NPC, a pack of 4 enemies, an outpost) and a drag paints where it roams.
Placements carry a count, behavior (static, wander, patrol, guard, ambush, spawner, vendor, quest
giver), level range and notes, can be dragged, and say which spot and region they are in. Deleting
a codex entry removes its placements and painted presence.

### Codex, story and quests on the map

- A spot lists its linked codex entries (link and unlink both ways), the quests given, pursued or
  turned in there, and who is there.
- A codex entry has **On the map**: linked spots, placements, painted area, the regions it appears
  in and the quests that name it, with **Place on map** and **Paint where it roams**.
- A quest's **Show on map** draws its journey (giver `!`, numbered objectives, turn-in `?`) and
  focuses the map on it; the **Quests** layer shows every quest's route faintly.

### Richer quests (all optional)

On top of quest giver, objective spots and prerequisites, a quest can say:

- **who** gives it (a character, not only a place) and its **hook**;
- **what happens at each objective**: go, talk to, defeat, collect, escort, defend, investigate,
  deliver, use; with a target from the codex, a count, optional, minutes and a note;
- the **level range**, codex **rewards** (items, powers) and faction **standing**;
- **outcomes**: endings or choices, each opening its own follow-up quests.

The **Planning check** reads all of it against the map: the journey's time over the real terrain and
roads leg by leg plus time spent at objectives; the most dangerous objective against the quest's
level (one danger step per five levels is "comfortable" - a heuristic); whether the creature to
defeat or the NPC to talk to is actually placed or painted near the objective, and whether the
giver is at the giver spot; enemies painted along the way; prerequisites that come later in the
story or are tuned for a higher level; what the quest unlocks and how deep in its chain it is. All
of it goes into the Game Design Document.

### MCP

| Tool | Purpose |
| ---- | ------- |
| `game_planner_sculpt_terrain` | any sculpt mode along points, with its parameters |
| `game_planner_paint_marks` | paint (or fill a polygon with) a mark or a codex entry's presence |
| `game_planner_place_codex` | place a codex entry with count, behavior, levels |
| `game_planner_quest_plan` | read or update a quest's planning detail and get its planning check |

## Code

- `examples/studio-bundle/src/apps/game_planner/intent_model.ts` - intents, directive parsing, live
  checks, plan health, agent context and brief.
- `.../planner_agent.ts` - the built-in Planner Agent and normalization of external proposals.
- `.../agent_pipeline.ts` - applying and rejecting changes, ghost previews, GDD and SVG export.
- `.../planner_model.ts` - intent CRUD, sketching state, the proposal inbox with undo.
- `.../terrain_sculpt.ts` - brushes, canyons, mountain ranges, road beds, plateaus.
- `.../planning_layers.ts` - painted marks, codex placements, region and codex map summaries.
- `.../quest_planning.ts` - quest objective detail and the planning check.
- `src/entropy_gui/widgets_game_map.rs` - intent and ghost layers (`MapIntent`, `MapGhost`), their
  hit-testing, tooltips and mini-map markers; painted marks (`MapOverlay`), codex markers
  (`MapMarker`), quest routes (`MapQuestRoute`) and the brush (`MapBrush`, `BrushStroke` events).

Tests: `npm run test:game-planner` in `examples/studio-bundle` (includes
`tests/game_planner_intents.test.ts` and `tests/game_planner_planning.test.ts`), and the live window test `tests/game_planner_live.rs`
(`xvfb-run -a cargo test --test game_planner_live` on Linux after `npm run build-game-planner`),
which sketches intents with real pointer input, runs the Planner Agent, rejects a proposal, and
answers an intent as an external agent over MCP, then sculpts a canyon and a mountain range with
real clicks, drags a raise brush, paints forest, places and paints a creature, and shows a quest on
the map.

![The plan, mostly met](../public/game-planner-intents-plan-live.png)
