# Allegiance

**Allegiance** is a political conquest game on the full-scale Earth of 2100. You start with a
dozen believers in a city of your choice. Make speeches, hand out pamphlets and recruit party
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

Then pick a party color and a starting city on the world map (or **Random City**). Every point
on Earth belongs to its nearest city, so the 113 regions cover the whole planet.

**The loading screen.** Your city streams in while a propaganda poster tracks the progress:
terrain chunks and elevation tiles, OpenStreetMap tiles and buildings, Mesha houses (built once,
then read from the mesh cache), and finally the street map. Everything is cached under the data
folder (`../allegiance-data`), so a second visit loads from disk.

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
| `al_data.ts` | The world of 2100: 113 regions (a city and its hinterland, with population, wealth, bloc and government), 8 power blocs, the factions, ideologies, topics, audience segments, speech cards, weapons, armor, skills, facilities, schemes, pamphlets |
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
- `allegiance_new`: start a campaign at a region (optionally an exact `lat`/`lon`).
- `allegiance_settle`: run the loading screen to the end.
- `allegiance_config`: `fixedStep` for reproducible runs.
- `allegiance_ui`: open a screen, tab or selection.
- `allegiance_click`: a button by id or coordinates.
- `allegiance_key`: a key press.
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
  frames. `ENTROPY_ALLEGIANCE_BDD_FEATURE=<file>` plays another feature without rebuilding.

## Limits

- Buildings are their fitted rectangles to the nav grid and to bullets; you can't go inside. The
  houses' interiors are there to see, not to walk.
- People are simple procedural figures. There are no vehicles yet, and travel between cities is
  instant (it costs days and credits).
- The campaign simulates 113 regions; the street layer simulates the few hundred meters around
  you. Distant battles are resolved strategically.
- The sun never sets: the day runs from 07:00 to 19:00.
- First iteration: balance is tuned by simulation and short play sessions, not long campaigns.
