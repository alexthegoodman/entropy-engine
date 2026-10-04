# Allegiance

**Allegiance** is a political conquest game on the full-scale Earth of 2100. You start with a
dozen believers in a real hometown of your choice. Make speeches, hand out pamphlets and recruit party
members. Build a chain of command, scheme against your rivals, and arm your followers. Then take
the planet one region at a time, by election, by coup or by war. You can do it as a liberator
or as a tyrant.

```bash
cd examples/studio-bundle
npm run build-allegiance
cargo run --bin example --release -- allegiance
```

The world is [QuadPlanet](QUADPLANET.md)'s Earth: real elevation, real OpenStreetMap buildings
and roads, and Mesha houses, all streamed in and cached as you go. The game is an ordinary addon
in `examples/studio-bundle/src/games/allegiance/`. Every screen is drawn with
`Entropy.UI.drawRect` and `drawText`, with no GUI widgets.

![A street on London's South Bank](../public/allegiance-street-london.png)

## Starting out

**New Campaign** opens the founding screen. Name your party and yourself, and pick an ideology:

| Ideology | Slogan | Strong on | Weak on |
|---|---|---|---|
| Solidarity | ONE PEOPLE. ONE BREAD. | Equality, Jobs | Liberty |
| Order | DISCIPLINE IS FREEDOM. | Security, Tradition | Equality |
| Liberty | BREAK THE SENSORS. | Liberty, Corruption | Security |
| Ascendancy | TOMORROW BELONGS TO US. | Progress, Climate | Tradition |

Then pick a party color and search **Home Town** by name (include a region or country to avoid
ambiguous names), select a result, and press **Begin**. A `latitude, longitude` search also works
offline. The map and **Random Territory** offer quick starts at their regional centers.

The 108 original centers now anchor surrounding territories. Populated places are discovered
from the streamed [OpenMapTiles place layer](https://openmaptiles.org/docs/schema/#place): cities,
towns, villages, hamlets and isolated dwellings. Each gets its own support, members, elections,
army and government; taking one never automatically takes its neighbors. Newly discovered towns
remain independent even if the surrounding hinterland has already fallen. The territory console
lists discovered places, with pagination, for selection and travel. Place definitions and their
political state persist in campaign saves; version-1 saves remain readable.

Countries belong to 2100: western former-US territories form **New America** (Liberty, Free Current),
and eastern territories form **The Workers States of America** (Solidarity, Verdant Accord).
Other territories belong to the existing future federations and assemblies. Countries extend
across the countryside; map land cells show their territories, while settlement markers show
local governors. Party-held hinterland uses your color. Country ideology establishes the incumbent,
not a recruitment lock: every movement can persuade people, give speeches and win support.
Uncommitted civilians are less hostile and initial persuasion has a higher success chance.

**Population and scope.** The fixed world budget is 7.038 billion fictional inhabitants.
Regional numbers include their hinterlands, not just municipal populations. Discovered-place
estimates are currently 100,000 for a city, 15,000 for a town, 2,000 for a village, 250 for a hamlet,
and 25 for an isolated dwelling, deducted from the surrounding territory. These are balance
estimates, not census data or forecasts. Population drives recruitment, taxes, garrisons and
population-weighted victory. Nearby NPCs remain a bounded simulation with a target of 34 civilians,
plus followers and soldiers. A village does not spawn thousands of meshes.

**The loading screen.** Your city streams in while a propaganda poster tracks the progress:
terrain chunks and elevation tiles, OpenStreetMap tiles and buildings, Mesha houses and people
(built once, then read from the mesh cache), and finally the street map. Everything is cached under the data
folder (`../allegiance-data`), so a second visit loads from disk.

People use Mesha's existing `people.human` generator at final quality. The loading screen prepares
two body/hair profiles and two reductions of each full mesh in `mesh-cache/allegiance-people`.
Within 18 m of the camera the complete geometry and smooth normals are retained; beyond that,
medium and distant meshes reduce geometry (the distant tier starts beyond 55 m). Hysteresis
extends these ranges to 22/65 m when moving away to prevent repeated switching. The third-person
player always uses full detail. Skin, hair and party clothing colors vary through uniforms;
weapons, hats, helmets and sashes remain game equipment. Walking and aiming use the game's shader,
with blended shoulder and hip motion; hair and clothes use their settled Mesha geometry.
Generator/version/parameters/LOD identify disk entries. Returning or restarting reuses them.

## On the street

| Key | Does |
|---|---|
| W A S D | walk (relative to where you look); Shift runs (stamina); Space jumps |
| Right mouse drag, arrow keys | look around |
| Left mouse | fire at the crosshair (hold for automatic weapons); R reloads; 1-9 switch weapons |
| E | talk to the person in front of you, or confront a rival orator |
| F | hand the nearest person a pamphlet; Q cycles the pamphlet you carry |
| B | take the stage: start a speech |
| V | first / third person; mouse wheel zooms the camera |
| Tab, M or Esc | the command console (time stops while it is open) |

Xbox and DualShock use the same semantic mappings:

| Controller | Action |
|---|---|
| Left stick / click left stick | Analog walk / sprint |
| Right stick / click right stick | Look / first-person toggle |
| A / Cross | Jump; confirm a menu item; deliver or close a speech |
| X / Square | Talk; first speech card; rebut a heckler |
| Y / Triangle | Start speech; second speech card |
| B / Circle | Reload; third speech card; close dialogue/console |
| RT / R2 | Fire (hold for automatic weapons) |
| LT / L2 | Raise the weapon to aim |
| LB/RB / L1/R1 | Cycle weapons; switch console tabs |
| D-pad up/down in play | Hand out / cycle pamphlet |
| D-pad or left stick in menus | Move focus; A/Cross activates it |
| Menu / Options | Open/close the command console |

Typing party and hometown names uses a keyboard. Stick drift is filtered with a radial 0.18
deadzone; movement retains analog speed. Disconnects and stale input release held actions.

**Aerial traffic.** Cabin-sized multicopters with four horizontal rotors cruise above local
rooftops, with some hovering. Housing within 400 m sets traffic density, capped at twelve
cars. Sparse areas have little or no traffic; separated altitude lanes keep dense areas readable.
Tall blocks contribute a provisional apartment estimate from their floor area, since the current
map bridge does not expose residential use. These are ambient vehicles in this iteration.
Your personal flying car is parked beside you on clear ground when you arrive. It stays where
you leave it and its location is saved with the campaign.

The HUD shows your party, the date and the time of day, your funds, members, world support and
reputation. It also shows the region you are in (who rules it, your share against the strongest
rival, the regime's heat, any war or rival rally), your health, armor, stamina and gear, and a
news ticker. An **objective** strip tells you what to do next: give a speech, recruit, appoint
officers, raise support, call an election, stage a coup, then take the next region.

**People.** The pedestrians are individuals with a name, an audience segment (worker, student,
professional, elder, faithful, veteran) and an opinion of your party. Each one also leans toward
a rival faction. Their first opinion comes from your party's support in the region. They walk
between the doors of real buildings along A* paths, stop, and walk on. They also run from
gunfire. Talk to them (**E**) to persuade them, give them a pamphlet, or invite them to join.
Recruits become named party members you can promote. Members wear your color. A member can walk
with you as a **follower** and fights beside you if armed.

**Pamphlets.** There are three kinds. The Plain Truth is honest: slow, and good for karma.
Glorious Tomorrow is bold promises. What They Hide is lies about your rivals, which hurt your
karma but cut into the strongest rival. Hostile people tear pamphlets up. The Printing Press
makes them cheaper and stronger.

## Speeches

Press **B** where people are and the podium and party flag go up. Passers-by gather in a ring
around you, walking there on A* paths. A speech is **five beats**:

1. **Choose** a line from three cards, with keys 1-3 or a click. Each card has a topic and a
   tone: *hope*, *anger* or *fear*. The crowd is a mix of segments that care about different
   topics and take each tone differently. Poor regions are mostly workers; rich ones have more
   professionals. Your ideology makes some topics stronger. Repeating a topic bores the crowd.
2. **Deliver** it: a marker sweeps a bar, and you press **Space** in the gold. Perfect, good,
   weak or miss multiplies the line. Perfect lines build a combo and **fervor**, which amplify
   everything after.
3. Sometimes a **heckler** interrupts. Press the key they flash before the timer runs out to
   rebut them and the crowd cheers. Miss it and they laugh.

At the end, the crowd's approval gives a score. Listeners' opinions move with their segment's
approval, the most convinced put on the armband and join, and the hat goes round for donations.
Regional support rises with the score and the size of the crowd. Big regions take more speeches,
and speech after speech on the same day returns less. Hope earns karma; fear costs it.

**Rivals.** The Concordat (the incumbent world order), the Iron Vanguard, the Verdant Accord and
the Free Current campaign across the planet every day, hardest where you are strong. They also
send orators: one sets up across the square, a banner on the HUD counts down, and listeners drift
to them. Walk up and press **E** to challenge them to a **debate**. That is a speech with the
rival speaking too, and their next topic is announced. Answer it with the same topic to tear the
argument apart: your line lands harder and theirs softer. Win, and you take support from them.
Leave them unanswered and their speech lands.

![A debate against a Verdant Accord orator](../public/allegiance-debate.png)

## The party

**The chain of command.** Members join faster than one person can lead them, and members nobody
organizes pay little and drift away. In the console's **Organization** tab:

- The **Inner Circle** costs no span. The Treasurer raises dues and taxes, the Propaganda
  Minister raises grassroots growth, the Spymaster raises scheme odds and lowers heat, and the
  General makes your troops fight better.
- You can direct **4 + Leadership** officers yourself: Region Chiefs and Bloc Commissioners.
- A **Region Chief** organizes their region and directs 3 + admin/2 **Cell Leaders**. Each cell
  leader organizes 150 + 25 x admin members.
- A **Bloc Commissioner** takes up to 3 + admin/2 chiefs in their bloc off your hands.
- At headquarters you organize a few dozen members yourself. In a region you govern, the state
  organizes thousands.

A named member can also **join the armed forces** (CR 120 to arm). When their home region is at
war, they fight beside you in its streets by name, along with its unnamed militia.

Named members come from your recruits and from talent the growing party turns up. Each has
charisma, admin, combat and loyalty. Disloyal members defect and talk to the authorities.
**Auto-Organize** fills empty posts the way a good chief of staff would. The warnings list says
where the hierarchy is failing.

**Leadership posture** (Overview tab): lead from **inside** (better schemes and dues), from the
**field** (your troops fight 25% harder where you are), or **mixed**.

**Money.** Credits come from dues (organized members pay in full), taxes from regions you govern
(you set the rate, and high taxes breed unrest), and donations from supporters (more with a good
reputation). They also come from speeches and schemes. Credits go to officer salaries, the armed
forces, facilities and governing. Three weeks broke and the party dissolves.

**Facilities.** Printing Press, Pirate Broadcast (daily support everywhere you have members),
Training Camp (troops fight 30% better), Safehouse Network (crackdowns and failed schemes cost
half) and Party Bank (+15% income).

**Schemes**, from any region with members: charity drives, strikes, hijacking the feeds, bribing
officials, smear campaigns, shaking down merchants, infiltrating unions, assassinating a rival's
chief, and gala fundraisers. Each has a cost, a duration, odds and a karma price. Exposed schemes
cost members and raise heat.

## Taking power

Each region has a government (democracy, technocracy, junta or oligarchy), a governing faction,
support shares, unrest, the regime's **heat** toward your party, and a garrison. In the
**Territory** tab:

- **Election.** Democracies vote every 60 days. With 20% support you can force a snap election
  (paid by region size). The biggest share wins, including a plurality, with a boost from your
  recent momentum and your members.
- **Coup.** Arm members (CR 120 each, upkeep daily), then strike at the regime. The odds weigh
  your armed members and their quality against the garrison, plus unrest, Intrigue and your
  Spymaster, minus heat. A coup needs no majority, so **minority rule** is possible, but the
  result is unrest and an underground insurgency. A failed coup costs most of the fighters and
  many members.
- **War.** Declare war with at least 10 armed members in the region. It is fought in rounds.
  You strike (your offensive), they strike back (their counterattack), and so on. Each side
  loses in proportion to the other's strength and quality. The regime calls up reserves from the
  rest of its bloc. The war goes on until one side breaks or you **sue for peace**, which is
  accepted when the enemy is losing or tired. Being there in person matters. When your region is
  at war, soldier squads come for you in the streets. Armed party members of the region fight
  beside you as militia, and every soldier you drop counts for 25 troops in the war. Fallen
  soldiers drop their weapons for you to collect.

Once you govern a region it pays taxes, organizes members, and you travel there free. It is
also a target. The Concordat and the rivals invade party regions more often the more of the
world you hold. Unrest turns into insurgencies. Democracies can vote you out, unless you
**suspend elections**, a tyrant's move. When the regime's heat runs high anywhere, it cracks down
on your members and can send troops after you in the street.

The Concordat brands the party an enemy of the state once you hold 4% of world support or govern
anywhere. From then on, heat rises everywhere.

## Reputation and the ending

Karma runs from -100 to +100. Hopeful speeches, charity, honest pamphlets and elections raise it.
Fear, smears, extortion, coups, wars, assassinations, suspended elections and killing civilians
lower it. Both roads win. A good reputation brings donations, loyalty and willing recruits; a
brutal one brings fear, obedience in the hard-bitten and revulsion everywhere else.

**Govern three quarters of humanity** and the planet is yours. The ending depends on how you got
there: Planetary Liberator, Champion, Pragmatist, Strongman or Tyrant.

## Gear and skills

Weapons: bare fists, the M-90 sidearm, the Kestrel SMG, the Breacher 12 shotgun, the AR-2100
rifle, the Longshot DMR and the Voltaic railgun. Armor: Kevlar vest, ceramic plates and
exo-frame, with repairs. Buy them in the **Armory**, or take them from fallen soldiers.

XP from speeches, recruits, battles, schemes and victories gives a skill point each level.
Skills go up to rank 5:

- **Oratory**: a wider timing window, stronger cards, a louder voice.
- **Persuasion**: more effective pamphlets, talks and recruiting.
- **Leadership**: more direct officers and followers, and better troops.
- **Marksmanship**: tighter spread and more damage.
- **Toughness**: more health.
- **Intrigue**: better and cheaper schemes.

## Travel and time

A campaign day is two real minutes on the street. The sun crosses the sky with the clock, and
each dawn the world turns: income and upkeep, rival campaigns, elections, war rounds, schemes,
crackdowns and talent. The console stops time. **Rest until tomorrow** skips ahead. **Travel**
(Territory tab) takes you to any region's city for a fare and the days on the road, and loads
the new city. The campaign autosaves every day. **Continue** on the title screen picks it up
where you left off.

## How it is built

| File | What it holds |
|---|---|
| `al_data.ts` | The world of 2100: 108 hinterland anchors, discovered settlements, future countries, 8 power blocs, factions, ideologies, topics, audience segments, speech cards, weapons, armor, skills, facilities, schemes, pamphlets |
| `al_state.ts` | The campaign as plain JSON (the save file), the region lookup (nearest city), support shares, the seeded RNG |
| `al_party.ts` | The chain of command, the ledger, the shop, XP and skills, schemes, followers |
| `al_world.ts` | The daily tick and every strategic rule: grassroots growth, rivals, unrest and heat, crackdowns, elections, coups, wars, counter-offensives, insurgencies, victory and defeat |
| `al_speech.ts` | The speech mini-game as a state machine |
| `al_nav.ts` | The street layer's local tangent frame on Earth, OSM buildings as oriented rectangles with doors, the nav grid, A* with string pulling, wall collision, line of sight |
| `al_street.ts` | Everyone around you: civilians, followers, militia, soldiers, rival orators; crowds, pamphlets, recruiting, hitscan combat |
| `al_player.ts` | You on foot, and the camera |
| `al_models.ts`, `al_shader.ts` | People (one mesh each, limbs animated in the vertex shader), the podium, the flag, tracers; three materials injected into QuadPlanet's shader |
| `al_ui.ts`, `al_screens.ts` | The propaganda UI kit and every screen |
| `allegiance_addon.ts` | The engine wiring: terrain, the loading screen, rendering, input, the day clock, saving, MCP tools |

**The street.** Earth is 6,371 km in radius, so within a kilometer the ground is a plane to the
centimeter. The street layer works in a local frame (x east, z north, meters) with heights from
the real terrain. `Entropy.QuadPlanet.buildings` gives every OSM footprint near you as an
oriented rectangle, with its front facing the street. The nav grid (2 m cells, 560 m across)
rasterizes the rectangles and open water. A* paths are string-pulled to straight legs and
budgeted per frame, with fighters on their own budget. The grid follows you and is rebuilt as
the city streams in. Buildings block movement and bullets.

**People in one draw each.** A person is one mesh with one 24-float uniform. uv.y tags each
vertex's limb, and the injected vertex shader swings legs and arms about the hip and shoulder by
the phase and amplitude in the uniform, or raises the arms to aim. Shirt and trousers take their
colors from the uniform, so an armband needs no new mesh. Meshes are shared per look (skin, hair,
hat, weapon).

**The UI.** Rects and texts are retained by the engine until `UI.clear()`, and every text is
rasterized when it is created. So each screen describes its whole frame into a `Painter`, which
resubmits only when the description changed: about 10 times a second at most on the street, and
30 for the speech's timing bar. The engine draws every rect before every text, so overlays that
must cover text are drawn as text with a background fill. Buttons are hit-tested against the last
frame. Fonts: Bungee for headlines, Vina Sans for numbers, Play for prose.

## MCP tools

These tools also drive the live test:

- `allegiance_state`: mode, loading, region, campaign, player, street, nav, speech, terrain, UI.
- `allegiance_new`: start at `hometown` by name, or `hometown` plus exact `lat`/`lon`; legacy `spawn` territory ids remain supported.
- `allegiance_settle`: run the loading screen to the end.
- `allegiance_config`: `fixedStep` for reproducible runs.
- `allegiance_ui`: open a screen, tab or selection.
- `allegiance_click`: a button by id or coordinates.
- `allegiance_key`: a key press.
- `allegiance_controller`: semantic button press/release or `left`/`right` stick vectors (positive Y up).
- `allegiance_speech`: `start` / `choose` / `deliver` / `rebut` / `auto` / `close`.
- `allegiance_act`: street and campaign actions such as `talk`, `pamphlet`, `persuade`,
  `recruit`, `follow`, `approach`, `walk`, `face`, `shoot`, `squad`, `rally`, `followers`,
  `rest`, `days`, `funds`, `organize`, `arm`, `war`, `coup`, `election`, `travel`, `buy`,
  `equip`, `save`, `load`, `view` and `govern`.

## Tests

- `npm run test:allegiance` runs the TypeScript tier. It covers the regions tiling Earth and the
  campaign state (deterministic, saveable), support dynamics, the hierarchy and its span of
  control, money and the shop, elections, coups, wars fought in rounds, peace, schemes, travel,
  victory and bankruptcy. It also covers the speech mini-game (beats, grading, hecklers, rival
  debates, crowd mixes), the local frame and building rectangles, nav-grid A* through gaps, water
  and walls, pedestrians walking between doors and gathering for speeches, pamphlets and
  recruiting, fleeing gunfire, hitscan through walls, squads against followers, militia and loot,
  and every screen through a stand-in for `Entropy.UI`. `npm run typecheck:allegiance` checks
  the types.
- `cargo test --release --test allegiance_live -- --nocapture --test-threads=1` runs under
  `xvfb-run -a` on a headless box. It plays `tests/features/allegiance_live.feature` in the real
  window: title, founding, loading London, walking, a speech, a conversation, every console tab,
  a street battle and victory. It also plays `allegiance_travel_live.feature`: a rival rally and a
  debate, travel to Paris, save and continue. It checks the tools' replies and the captured
  frames. `allegiance_iteration1_live.feature` covers hometown start, controller movement and menus,
  density-limited traffic, and save/resume. `ENTROPY_ALLEGIANCE_BDD_FEATURE=<file>` plays another feature without rebuilding.
  Every live fixture must exit normally within ten seconds of completing its feature; forced
  closure fails the test. Map and elevation downloads use shared process-lifetime HTTP clients
  to avoid joining network threads from Windows thread-local destructors during shutdown.

## Limits

- Buildings are their fitted rectangles to the nav grid and to bullets; you can't go inside. The
  houses' interiors are there to see, not to walk.
- Your personal hover car parks beside you on arrival, with clearance for its rotors; its parking
  location persists through save/resume. Cars cannot be driven yet. Long-distance travel is instant
  (it costs days and credits).
- Settlements become individual targets as their map tiles load or a hometown is selected.
  Coverage depends on mapped place labels. Political hinterlands use nearest regional centers;
  local settlement extents use provisional radii, not surveyed municipal boundaries. The street
  layer simulates the few hundred meters around you; distant battles resolve strategically.
- The sun never sets: the day runs from 07:00 to 19:00.
- First iteration: balance is tuned by simulation and short play sessions, not long campaigns.
