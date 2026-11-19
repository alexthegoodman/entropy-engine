# Game: True Error

Our games Nebula Kingdom and World of Music are distinctive and fun. Now, we want to make a new game called True Error, which takes realism and depth to the next level, by leveraging higher quality art assets, so that code can be used on quality gameplay.

[a cinematic game with cutscenes, yet very free and exploratory. You just find missions, there's no storyline, just backstory and an overall goal.] 

Backstory: people were uploading their minds, and traveling through worlds, living forever. but eventually, the machine was shut down during an emergency situation, and the simulation enters a hibernetic sleep state, yet the simulation never died - rather, it entered a period of turmoil that last 7 "epochs". errors, glitches. people's minds mixing, mutations, evil horrors. 
then when people (human cyborgs and robots) revived the simulation, in order to reconnect with their loved ones, they were decieved into letting some of them back on earth through robot avatars. This is a mistake, that leads the errors of the 7 epochs to enter the real world. many cyborgs and robots get hacked. 7 epochs is roughly 70 years of time in the virtual world, but only about 3 years of time on Mars. That's because the Virtuous Time Constant set the rate of time in virtual worlds to be roughly equal to 23.33x, for the sake of their relative development speed compared to people, maintaining satisfactory communications with the real world. Humans are, in fact, all cyborgs by now, but they still require a spacesuit when walking on the martian surface. A suit is easily carried in inventory.
The release of the Simulation Error into the real world leads to initial chaos and quick culmination in destruction. The game is set in this post-apocalyptic scene. You were born in the simulation during the hibernetic period, but a human has fixed you up now on Mars as a robot. he has used a homegrown AI to develop an algorithm out of sight of the Error. This algorithm is going to restore normal functioning to a robot, but it also wipes their memories. You are the first Reborn, and you feel compelled to restore the world to order and save everyone.
the world consists of humans and robots co-existing and surviving in the wasteland, but ever since the Last Day (the day the Error invaded the real world), it has been hard for humans and robots to trust each other.
The Last Day involved the detonation of a fusion bomb which destroyed multiple planets in our solar system. Since this game is base in the year 4122, it is based on a highly developed mars. Earth itself was destroyed by Mr. Tiny, a hyperspace-bending dark bomb, using a dark energy fusion reaction to produce a temporary rift similar to a black hole in strength and effect. Robots have inhabitated mars for thousands of years now, as it was a natural home for them.

Mechanics:
as a robot, you can digitize yourself for various purposes, and even transfer yourself into a new robot. the real world was always interlaced with the simulation, so people could visit each other through VR / AR, and that can certainly inspire some mechanics now that the simulation is back online, in restored order, and the real world is destroyed. you can see the simulation world through your lens, whether thats a human with an eye lens, or a robot with a built-in one.
As a robot with different optional heads, you gain different lenses, weapons, and capabilities. Humans can use the same attachments, just manually in their hands.
Third person, over the shoulder.
Dark bombs emit dark radiation that intereferes with electronics, so you must avoid dark zones, when without a biochip (a chip of biological neurons which enables robots to think in dark zones). Dark zones, are, of course, dangerous to humans also, and will degrade your biochip.
To defeat The Error, you must uses the Reset Algorithm given to you by the Secret Doctor on each Hacked Robot or Hacked Cyborg, or you may destroy the enemy - its your choice, and it simply unlocks different reward paths, rather than locking you into a moral situation.

Visuals:
realism, steampunk, with some holograms. 
the robots are quite unique. many have telescopes as heads. others have a weapon as their head. some robots roll, others are like spiders, and some are humanoids.
The world is full of junk and trash, there are imploded buildings, and bridges sticking out of the rivers. mars has been terraformed significantly by now, but still has a reddish hue.
Most things run on nuclear power, which is long-lasting and powerful. Even tiny batteries are nuclear.

Heads / Utilities:
- Lenses: Night vision, Heat vision, X-Ray vision, Distance vision, Simulation vision
- Weapons: Assault rifles, handguns, machine guns, etc (shoots dense packets of laser photons), grenade launcher (launches gravity grenades, they are small but pack a gravity-bending punch)
- Tools: Grappling hook, hologram projector

---

General Scenery:

i imagine glorious, hyper-tall cities. outstanding, though broken, views from ledges and such. bridges between towers at very high heights.

First Level:

I want a floating hypercube artifact, about the size of a car, which is essentially a reminder of mankind and robotic success before the Error. It's inside a central tower of the capital city on Mars. except a large portion of side of the tower has been destroyed, leaving the hypercube exposed to the elements. you start the game in this tower, and must reach the hypercube. We want the bigger objects as well as smaller objects.

The first level does not require all mechanics, such as character switching, which should hopefully keep scope manageable.

---

We will be using Meshy for most 3D assets, so we can create deep, rich, and immersive feel that centers on story and paced combat.

I generated the first model of the first character you play in the first level, the humanoid robot with a telescope head. He is in the `assets/models` folder.
This humanoid is already rigged and animated. His name is Ray.

Ideally, we would remesh each model, so that it does not over burden the triangle count.

I suggest that you always do generate an image before generating the model, so you can confirm you have the right look.
You can find an image of Ray in `assets/Ray1.png`.

Many models can be 30 to 50 credits total from start to finish, so let's try to fit the level within 20 models for now, then we can assess and see where we are at with it.

---

## Build status

Two missions. Winning Mission 1 continues to Mission 2 (and saves its start); `te_act` `mission` / `stage` jump to either.

### Mission 1: the Central Spire (five acts, ~30 min)

- Run: `npm run true-error:assets` (once), `npm run build-true-error`, then `cargo run --release --bin example -- true-error` from `entropy-engine/`.
- Assets: prompts in `assets/true_error/assets.json`, Meshy task trail in `meshy_tasks.json`, drivers `*.mjs` there; `tools/te_assets.py` turns the Meshy GLBs into `assets/true_error/game/` (geometry GLB + PNG maps).
- Acts: 1 the Central Spire, 2 the Sky Bridge, 3 the Relay Tower (sim-beam chasm, biochip vault, dark archive, breaker room), 4 the Descent (stair shaft, lower bridge, reactor hold-out), 5 the Return (service lift, the Warden, waking the hypercube). Stages live in `te_mission.ts`.
- Code: `te_level` (Act 1 layout, collision), `te_acts` (Acts 2-5), `te_mission` (stages, lines), `te_items` (24 procedural collectibles), `te_game` (simulation), `te_skin`/`te_glb` (CPU skinning), `te_render`/`te_shader` (pipelines), `true_error_addon` (camera, cinematics, MCP tools `te_state`/`te_act`/`te_expect`; `te_act` `stage` starts the mission at any stage).
- Tests: `npm run test:true-error` (vitest) and `cargo test --release --test true_error_live` (BDD screenshots, `tests/features/true_error_live.feature`).
- Keys: WASD, Shift runs, Space jumps, C / Ctrl crouch (toggle), V rolls (invulnerable mid-roll), E takes down / resets / uses / holds up a collectible (E keeps it, Esc puts it back), Q swaps weapons, 1-5 lenses.
- Gamepad: left stick moves (click to run), right stick looks, right stick click crouches, LT aims, RT fires, RB swaps weapons, A jumps, B rolls, X takes down / resets / uses, Y / D-pad lenses, Back help, Start / A begin, B skips cutscenes.
- Saves: run (stage, checkpoint, keeps, machines) at checkpoints and stage changes; the title offers Continue (N / Y for a new game). The collectible archive persists across runs.
- Meshy: Warden (rigged, shield and cannon glow drawn in code), crawler (static; Meshy rigs humanoids only, so its gait is procedural), archive rack, reactor, conduit; Ray's crouch and roll clips.
- Aim assist (Armageddon's `ar_aim.ts`): friction, sweep pull and tracking onto hostile machines in sight. 50% by default, 0-50% with - and = (saved through `addon.IO.save`).
- Props and the skyline are batched per spatial chunk (`chunkOf`) so the engine culls them per pass.

### Mission 2: Noctis (six acts, not yet timed)

The canyon floor under the capital (`te_noctis.ts` map, `te_m2.ts` story). The Doctor sees Ray off at his rover, then three places in any order: the Avatar Foundry (shut down the printing line; the racked shells wake), Gate Four (the sim lens shows the old queue to the terminal with the gate's last session), and the barge Patience (hold E on the winch to raise its mast while the hull empties). Then the Doctor's line goes dead and his camp is wrecked; his radio picks up survivors at the pumphouse (break three lure beacons), the Tithe offer to show Ray where the Doctor went, the quarry lift traps him in the Undercroft (the pit, the cable heart, the metro tunnel), and the hoist comes up into the Tithe's ambush on the south wall.

- Map: a terrain heightfield (`Terrain` in `te_level.ts`: walked, raycast by marching, too steep past `maxSlope`, ignored from far below; meshed in 5 x 5 chunks by `terrainMesh`), canyon walls, mesas with ramps, a sunken canal with a few gentle banks, pads under the buildings, a plateau frame beyond with the capital's towers. Every location has two or three ways in.
- New machines: the Hollow (rigged; sprints unwatched, nearly stops while Ray looks at it), the cherub (flying, circles and dives), the Tithe scavenger (rigged gunner; spared, not Reset), the lure beacon and the cable heart (break, never stunned; the heart's shell opens on a breath cycle).
- New weapons (Q / RB): the scattergun (pellets, close), the gravity launcher (lobbed shell, implodes, drags machines in, crushes; shells from `grav-*` pickups).
- Stealth: Noctis's patrols see in a cone ahead and hear a run within 11 m; crouched or behind, E is a takedown; unaware machines take double damage.
- People: the Doctor, Mara, Oduya, Pip, Vesper and the Tithe (`Game.npcs`, placed per stage).
- Meshy: 30 more models (prompts in `assets.json`, `add_m2.mjs`; rigs/clips `drive_anims_m2.mjs`); `harvest_pod`'s first prompt was declined by Meshy's safety check and redone.
- Tests: `tests/true_error_noctis.test.ts` (map sanity, weapons, stealth, a full playthrough, saves) and `tests/features/true_error_noctis.feature` (played after the Spire's feature by `tests/true_error_live.rs`).
- Frame time on a UHD 770 (release, 1600 x 900): 25-28 ms in Noctis, GPU-bound (JS 5-7.5 ms).
