# Armageddon 2070

Large-scale squad tactical combat in first person: 128 vs 128 on four battlefields, Conquer only.
Multiplayer comes later; for now every other soldier, every vehicle crew, every squad and both
teams' commands are bots, and every one of their decisions comes from a WIR network (Yumon Pet's
WIR language, compiled to ReLU weights and checked exact against its program).

> 2070. Fusion gave the world abundance. Abundance gave it decay, then the Directorates, then the
> war. The first fusion bombs fell on the Indian subcontinent; it is gone, and its glow still lights
> the southern sky. Now the Meridian Directorate and the Ember Ascendancy fight for what is left on
> the rim of the ash.

```bash
cd examples/studio-bundle && npm run build-armageddon && cd ../..
cargo run --bin example --release -- armageddon-2070
```

Code: `examples/studio-bundle/src/games/armageddon/`. Saves (the loadout and battle setup):
`../armageddon-data`. Design database: `docs/armageddon/v0.1` (as delivered) and
`docs/armageddon/v0.2` (every TBD filled; written from the game data by `npm run armageddon:csv`).

## Playing

- **Title -> Battle**: pick a map, a side, 32/64/128 per team, vehicles on or off. **Deploy** picks a
  spawn: headquarters, any territory your team holds, or a squad mate. You respawn within 5 s.
- **Keys**: WASD move, Shift sprint, Space jump, C crouch, Z prone, mouse look (click once to lock
  the pointer; Esc releases it; middle-drag and the arrow keys also look), LMB fire, RMB aim down
  sights, R reload, 1/2/3 primary/sidearm/launcher (or the underbarrel grenade launcher), G grenade,
  F equipment (in a vehicle: smoke or flares), E enter/exit a friendly vehicle whose hull is within
  3 m (a full one makes room) or take from a supply crate, Shift while aiming holds your breath, Q
  call your squad to the crosshair, 5-9 use a reward at the crosshair, Tab scoreboard, M map, V third
  person, P screen pass, [ and ] look speed (saved), H help. Arrow keys pick the spawn point on the
  deploy screen.
- **Gamepad** (gilrs names, Xbox layout): left stick move, right stick look, RT fire, LT aim down
  sights, L3 sprint (aimed: hold breath), A jump, B crouch, D-pad down prone, X reload, Y next
  weapon (next to a vehicle or crate: enter/exit or resupply), LB grenade, RB
  equipment, D-pad up enter/exit vehicle, D-pad left squad call, D-pad right first reward, R3 third
  person, Back map, Start deploy screen. Menus: A confirm, B back, D-pad navigates. In vehicles the
  left stick drives, A/B climb and descend, the right stick aims.
- **Vehicles**: W/S throttle, A/D steer, Space/Ctrl climb and descend in aircraft, the mouse aims
  the seat's gun, LMB fires, G drops the heavy transport aircraft's payload.
- **The armory** builds a loadout: a primary and its attachments (only ones that fit), ammunition,
  sidearm, launcher, up to four kits (inventory points come from the chest rig), and armor per slot:
  helmet, chest, shoulders, arms, legs, a utility cloak, an exoskeleton and a finish. The panel shows
  weight, speed, protection per hit location, visual/thermal/noise signature, inventory and the
  fitted weapon's numbers. Armor makes you heavier and stronger; the Mimetic Plate Coating makes you
  heavier, a little stronger and much harder to see. Role presets fill everything in at once.

## Weapons

- **Aiming down sights** zooms optically (the view's FOV is 70 deg divided by the magnification, in
  tangent space) and eases in over the fitted aim time. Iron sights 1.3x, red dot 1.4x, holographic
  1.45x (a ring reticle), 2x combat optic (a red chevron), 4x and 8x (mil-dots); sidearms 1.2x,
  launchers 1.5-2.5x with a range ladder. Optics of 2x and up show the scope picture. Look speed
  scales with the zoom. Scopes sway with breathing (less crouched, prone or on a braced bipod; Shift
  or L3 steadies).
- **Look feel** (`ar_aim.ts`): mouse counts are eased over ~12 ms (every count still arrives). The
  right stick has a 0.12 radial dead zone, a curve for fine aim near the centre, 3 rad/s at the rim
  rising to 4.65 after the rim is held 0.15 s, and a rate that eases up (60 ms) but stops in 12 ms.
  Over a visible enemy soldier the look slows (mouse 20%/35% hip/aimed, pad 40%/55%); it never pulls
  the view. Soldiers, vehicles and the camera are drawn blended between the last two 30 Hz steps.
- **Recoil** climbs the view by the weapon's deg/shot (x0.6, less aimed, crouched, prone, braced);
  about 60% comes back after the trigger is released, minus whatever the player already pulled down.
- **Triggers**: AR-70, AR-70C, SMG-70, LMG-72, HMG-75 and MP-70 are automatic; everything else fires
  once per pull (the SR-70 and AMR-76 cycle a bolt, the SG-70 a pump). The player reloads
  automatically when a magazine runs dry. The HMG and AMR fire standing without a Heavy Exoskeleton,
  with 3x spread and 2x kick.
- **Launchers**: AT-Disposable-70 carries two tubes (1.5 s to unsling the next), AT-Reusable-70 four
  rockets, AA-70 three missiles. Guided launchers lock a vehicle held in the crosshair for the lock
  time (1.2 s ground, 2 s air); only a full lock guides. A box, a beep and "LOCKED" show it.
- **Underbarrel grenade launcher** (A015, the squad leader's rifle): slot 3 when no launcher is
  carried, four 40 mm HE grenades in an arc, 90 HP within 5 m.
- Every weapon has its own first-person model and fitted attachments, muzzle flash, brass, and sound.
- **Supply drops** (Supply Drop killstreak) fall under a parachute at the crosshair (never more than
  120 m out), land in 3 s, smoke in the team colour and stay 120 s. Crates and drops give anyone near
  who is short of anything (ammunition, launcher rounds, grenades) a full restock once a second;
  E or Y takes at once.

## Conquer

- Each team has 1,600 tickets; a death costs one. Every 10 s the team holding fewer territories
  loses 2 tickets per territory it is behind. A team at 0 tickets loses when its last soldier falls
  (or at once if it also holds nothing).
- A territory flips by standing in it: progress runs at sqrt(attackers - defenders) / 16 s, a
  neutral middle, a flag that rises, contested territories marked gold.
- Each team starts with the territory nearest its base. Bases cannot be captured.
- **Killstreaks** (kills, vehicle kills and captures without dying): Recon Drone 3, Supply Drop 4,
  Combat Drone 5, Artillery Strike 7, Attack Helicopter 9, Tactical Airstrike 12, Hunter Protocol 15.
  Hunter Protocol sends up to 16 seeker bolts into a 60 m field after 2 s; each neutralizes its
  target with 80% (halved under a roof, in smoke or in a thermal cloak; each AA vehicle within 150 m
  shoots two bolts down).
- **Underdog rewards**: every 150 s spent in the bottom quarter of your team's leaderboard earns one
  (a rotating deck): the Mine Kit (16 mines in one go: 12 anti-personnel, 4 anti-vehicle, in an arc
  across the aim point), Emergency Ammunition, a Reinforcement Squad (8 bots who follow your calls for
  120 s, one per team at a time), Field Repair Kit, Portable Turret, Anti-Armor Kit, Emergency Recon,
  EMP Charge, Emergency Extraction (an AI transport helicopter). Bots get and use rewards too.
- **Mecha**: one per side at a time. A team's mecha unlocks while it holds half the territories or
  trails by 300 tickets; it walks out of the base with a bot pilot (Titan, Wraith or Bastion).
- **Vehicles**: each team fields the database's ground and air vehicles (buggies to tanks, AA and
  artillery, logistics and recovery, drones, attack/transport/heavy helicopters, fighter, attack
  aircraft, heavy transport aircraft). The heavy transport helicopter carries 16. When a team is
  short of tanks, its heavy transport aircraft flies a tank to its most forward territory and drops
  it under parachutes. Heavy vehicles crush light cover and run soldiers over.
- **Squads** of 8 (standard, recon, support, anti-armor mixes from Squads.csv). They stick together
  but split to flank. Q calls your squad to the crosshair: members within 250 m come (the squad's WIR
  mode becomes regroup), for 30 s.

## The balance scale (Design Database v0.2)

A soldier has 100 HP; vehicles use the same HP. Damage is per hit at point blank, falling to the
weapon's minimum at its effective range. Armor stops `protection x (1 - penetration)` of a hit per
location (head 10% of hits x2, torso 45%, arms 20% x0.75, legs 25% x0.8; protection capped at 80%).
A soldier carries 18 kg freely; speed falls to 55% at 70 kg (exoskeletons carry 22 or 48 kg for
you). Bots see a standing, moving soldier with signature 1 at 190 m, scaled by visual signature,
stance, movement, vegetation and recent muzzle flash. Every table is in `docs/armageddon/v0.2`,
including `Balance_Scale.csv`. Some database rows changed shape: the modular shoulder, arm and leg
armor became Light/Standard/Heavy rows (`AR007L/S/H` ...), and two finishes were added (`AR013`
Mimetic Plate Coating, `AR014` Biome Camouflage Finish). Vehicle fuel is a fusion cell with no
refuelling in Conquer.

Every crewed non-tank vehicle takes one more launcher blast than v0.2 first shipped (AT-Reusable-70
on ground vehicles, AA-70 on aircraft, from 60 m): buggy 2, jeep 3, APC 8, IFV 10, AA 9, artillery
13, truck 5, recovery 14, attack/transport helicopter 5, heavy helicopter 7, fighter 4, attack
aircraft 6, transport aircraft 11. The tanks (25, 14) and the uncrewed drones are unchanged.

Bot aim is human: a 0.45 s reaction on a fresh contact, then a bell-shaped error (rifle 0.5 deg,
marksman 0.22, support 0.75) that starts 2.5x wider and settles over 2.5 s, grows when the bot
moves, is suppressed or the target is far, and trails a target that moves across its view. A bot
rifleman hits a standing player at about 50% of shots at 30 m, 20% at 60 m and 5% at 120 m.
Infantry only engage aircraft with an AA launcher or inside 180 m. Enemies of the viewer wear
glowing red marks (helmet band, chest and back patches, armbands; a red band at long range).

## The maps

Four 1,024 m battlefields, each a seed plus a hand-placed layout (`ar_map.ts`):

| map | biome | territories | notes |
|---|---|---|---|
| Glass Coast | coast | 10 | the Makran shore: a container port, a breeze-block town, dunes fused to glass, the sea |
| Kush Corridor | mountain | 9 | a pass between snow-capped walls: qalat compounds, terraced farms, a broken bridge, pines |
| Fusion Plant Seven | industrial | 11 | reactor domes, cooling towers, pipe racks, a rail yard, containers |
| Lhasa Arcology | city | 12 | a grid of shattered blocks, plazas, a monastery on the hill |

**Cover is the point.** Every solid is a box rasterized into a 1 m cover grid holding up to two
spans per cell (so windows are gaps from sill to lintel and doors gaps from the floor). The grid is
coarse, so wherever a trace (bullets, sight, sound) finds a solid cell it tests the real boxes in
that cell and goes on if it misses them: shots and sight pass through windows, doors and gaps as
drawn (95-98% of square-on shots through a window centre get through; 49% did on the grid alone).
Territories are sites (port, town, city, village, compound, industrial, reactor, plaza, checkpoint,
outpost) of ruined buildings, low walls, sandbag nests, jersey barriers and T-walls, hesco,
containers, kiosks, wrecks, rubble, crates, towers. A building has at least two doors on different
sides (usually opposite, so it is a way through), windows, sometimes a breach at floor level, rooms
(a partition with a doorway in most, a second across the bigger ones), low cover inside and broken
tops. A fill pass then walks each territory on a 5 m lattice and drops mixed cover wherever nothing
at least 0.9 m tall stands within 6 m. The tests hold every territory to: cover within 6 m of at
least 85% of open spots (measured: 96-100%), at least four kinds of cover, and fewer than 75% of
15 m+ sightlines clear (measured 8-65%).

Between sites, every territory and HQ is linked to its three nearest; each link gets a centre lane
and, past 70 m, a flanking lane bowed out to each side. Along a lane a piece of cover stands every
8-13 m, alternating sides: low walls along the lane to move behind crouched, ruined corners head
high with a window, wrecks, boulders (the only thing on steep slopes), nests, rubble and the biome's
pieces (containers and hesco, barriers, glass slabs, crates); a link past 110 m gets a waystation
(a ruined house, a low wall, a nest) at its middle. Roads stay drivable. On the straight line
between linked sites, cover stands within 8 m of 97-99% of the way and the longest open run is
10-26 m (was 41-51% and 68-246 m; the test holds 93% and 32 m). Random rocks, wrecks, walls,
rubble and nests are scattered over the rest. Bullets damage destructible cover (sandbags,
barriers, wrecks, crates, deployable cover) until it collapses.

Foliage is billboard cards cut out in the shader (grass, bushes, broadleaf, pines, palms, dead
trees, reeds), about 2,000-6,000 placed plants per map plus grass scattered in 32 m chunks around
the camera. Bushes and reeds conceal: they cut how far bots see you.

## The bots think with WIR

`yumon-pet/wir/src/armageddon.rs` writes 23 WIR 0.2 programs (`wir armageddon --out
examples/armageddon --export armageddon.json`), compiles each and checks the network against the
program on random in-domain inputs; `tools/ar_import_wir.mjs` imports the weights into
`ar_wir_data.ts`. `ar_wir.ts` runs them and holds the same rules as plain TypeScript; the tests and
`ar_config {check: true}` compare every live decision with its rule. The chain follows
`WIR_Behaviors.csv`:

| network | layer | decides | inputs | hidden | weights |
|---|---|---|---|---|---|
| `ar_sense` | all ground and air agents | a 5 x 5 grid program: grades of 4 fields per heading, exposure, friends per sector, blocked headings | 74 taps | 8 layers | 2,216 |
| `ar_strategic_brain` | team | which of up to 12 territories each squad goes for (value, owner, contest, distance, squads already sent, enemy strength) | 108 | [120, 168, 12, 132, 12] | 1,212 |
| `ar_squad_brain` | squad | advance, assault, defend, regroup, flank, fall back, mount | 22 | 6 layers | 325 |
| `ar_{rifle,support,marksman,antiarmor}_brain` | soldier | heading or hold, fire, reload, crouch, grenade, launcher | 84 | [83, 114, 171, 19, 82, 19] | 1,284 |
| `ar_tank_{mbt,destroyer,antiair,artillery}` | tank | hull heading/hull-down hold, target class for the turret, main gun, coax, smoke | 80 | 6 layers | 1,158-1,295 |
| `ar_apc_{apc,ifv,light}` | transports, logistics | heading, pick up, deliver, dismount, support fire, ATGM, smoke | 79 | 7 layers | 1,369-1,375 |
| `ar_heli_{attack,transport,drone}` | helicopters, drones | heading on a 16 m air grid or hover, altitude band, land, fire, flares; random bits vary approaches | 91 | 7 layers | 1,206 |
| `ar_jet_{fighter,attack,transport}` | aircraft | patrol, attack run, pull out, evade, return; fire, flares, drop (bombs or a vehicle) | 16 | 6 layers | 185-238 |
| `ar_mecha_{titan,wraith,bastion}` | mecha | heading or hold (lame legs favour holding), weapon by arm health, brace | 77 | 6 layers | 1,142-1,163 |

The infantry brain is the tactical grunt (`docs/WIR.md` "Tactical enemies") upgraded for a chain of
command: drives are response curves (fear from hit points, an empty magazine and suppression;
approach to a preferred range shifted by the squad's mode; the pull of the objective by mode; squad
cohesion with a leash plus the player's call; cover; peek; plant to shoot), each multiplied by a field
grade per heading, plus spacing, inertia and a blocked penalty. Vehicles split hull and turret: the
network chooses where the hull goes and which class of target the turret takes, and the host aims.
Each bot fills its fields locally: the path distance to its objective (Dial's algorithm per territory,
cached), the distance to its threat, cover facing that threat within a 9 x 9 window, exposure by line
of sight from up to two seen enemies, its squad anchor (leader or call point), walls and friends.

The Electronic Warfare WIR (AI010) is deferred.

## Tests

- `npm run test:armageddon` (in `examples/studio-bundle`, ~2 min): the database (audit, the brief's
  numbers, armor trade-offs, damage, the v0.2 CSVs current), the maps (territory counts,
  reachability on foot and by vehicle from both bases, the cover metrics above, windows and doors,
  foliage), every WIR network against its rule (3,000 random inputs each, the senses on 5,000 random
  windows), and the battle: 128 vs 128 for 150 s with every decision checked (0 mismatches), respawn
  within 5 s, the Mine Kit's 16 mines, Hunter Protocol's 16 targets at about 80%, underdog and
  killstreak rewards, the squad call, the 16-seat helicopter, the aircraft's vehicle drop, one mecha
  per side, the end of a battle. `ar_fixes.test.ts`: vehicles spawn inside every map, crewed aircraft
  fly (never spin in place), bot hit rates by range, launcher blasts per vehicle. `ar_weapons.test.ts`: every weapon fires for the player, launcher rounds, semi-auto triggers, guided locks, the UGL, supply drops, entering vehicles. `ar_aim.test.ts`: eased mouse keeps every count, stick dead zone / easing / rim boost / stop, friction only on a visible target.
- `cargo test --release --test armageddon` in `yumon-pet/wir`: all 23 networks compile and match
  their programs.
- `tests/features/armageddon_maps.feature` (played with `ENTROPY_ARMAGEDDON_BDD_FEATURE`): aerial and
  on-foot captures of the ground between territories on all four maps and an HQ wall from 0.6 m, for
  reviewing cover and near-wall rendering.
- `xvfb-run -a cargo test --release --test armageddon_live`: six scenarios in the real window
  (tests/features/armageddon_live.feature), 36 captures: menus, the armory, a 128 vs 128 battle in
  first person, the scoreboard and map, the squad call, the Mine Kit and Hunter Protocol, a tank and
  the heavy helicopter, all four maps, the debrief; and real input through the engine's event queue
  (`I hold the key`, `I press the mouse button`, `I hold the gamepad button/sticks`, checked with the
  `ar_expect` tool): weapon keys between 30 Hz battle steps, RMB and LT aim, the pad, red enemy marks.

## Numbers and limits

- Headless (Deno, 4 cores of a cloud VM): a full 128 vs 128 battle with vehicles steps in 9-17 ms
  per 1/30 s step (the bots about 70% of it), with occasional 120-180 ms steps when a new path field is
  built. A battle runs 15-20 minutes. The live window runs the same step; performance figures under
  Xvfb (software rendering) mean nothing.
- Depth is written per fragment (w / (w + 200), so the screen pass recovers distance) from the
  interpolated view depth; written per vertex, a big face beside the camera came out metres too deep
  and whatever was behind it showed through.
- Looks are deliberately simple: boxes, cylinders and spheres for soldiers, vehicles and buildings,
  procedural materials, no shadow maps, a fog/tone-map screen pass.
- Transport helicopters wait landed at their base until a squad picks one for a "mount"; few squads
  do yet, so they mostly sit there.
- Not built yet: multiplayer, the EW WIR, player control of the heavy transport aircraft's drop
  point, ballistic drop, bots using the underbarrel grenade launcher.
