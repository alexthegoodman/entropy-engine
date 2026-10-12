# The Abyss - Chapter Two: Retaliation

The first open chapter of [The Abyss](THE_ABYSS_STORY.md). Chapter One is a corridor through a battle; Chapter Two hands Alex the whole floor of the crack and lets him choose what to do with it. The main quest gives him the flying creature Kesh, and Kesh is what will open the rest of the world up: the north wall, the rim, and - in later chapters - the surface.

Run it: `cargo run --bin example -- abyss`, then **CHAPTER TWO - RETALIATION** on the title (or **SELECT A MOMENT** for the hollow, Skybound, or the open world after the main quest).

## Premise

Nine days after First Blood the surface has poured its army into the Abyss and raised **Firebase Lantern** on the landing zone where Kilo-Two died. Alex, the only officer who walked out - with the river's water still in his blood - is kept off the line. Major Voss gives him room instead: *"The floor is yours. Go where SAGE can't see. Just come back."*

## Main quest: The Beast Below

| Stage | What happens |
| --- | --- |
| Report to Major Voss | At the firebase's command dome. |
| Recover Lantern Four's flight recorder | At its wreck by the shrine. The recorder caught a burst from the gunship's chin gun at something in the air - and a cry. |
| Follow the glowing trail | Drops of light lead north to the hollow. |
| *Cutscene: The Hollow* | A skywing lies there, a surface coil slug in its shoulder. Wardens come over the ridge: they think Alex came to finish it. |
| Drive off the hunters | Four wardens. |
| Calm the creature | Approach and reach out [E] three times. Sprinting in or firing nearby makes it flinch. |
| Bring it the river's water | Two ways: draw it from the Source's pool far east, or earn a vessel from Maelis (side quest *The River Idol*). |
| Pour the river's water | *Cutscene: Skybound* - the wound drinks the water and closes. SAGE logs it as **KESH** (the healer's word if Alex returned her idol, the wardens' chant if not). |
| Climb on | [E] at Kesh. |
| Fly up out of the Abyss | Rise above the rim. |
| Land at Forward Base Lantern | *Cutscene: First Light* - the surface's own base, every rifle aimed at a man on a creature of the deep. **Chapter complete; the world stays open.** |

## Side quests

None is needed to finish the chapter; all can be done before, during or after the main quest.

| Quest | Giver | Summary | Reward |
| --- | --- | --- | --- |
| Seven Is Down | QM Dace | Find Lantern Seven's wreck; its pilot Pell has survived nine days. Hold off the wardens who come for her, then meet her back at the firebase. | Aegis Mk.III plates (150), 300 CR |
| Names in the Dust | BRASK-7 | Six of Kilo-Two's tags lie where they fell (shrine, the road west, the landing zone). Hang them at the memorial. | Okafor's Carbine (weapon 5) |
| The River Idol | Maelis (a healer of below, in the ruins north of the shrine) | Recovery crated her family's river idol. Find it in the firebase's artifact crates, then **choose**: give it back (river water for Kesh, her trust, a better translation) or sell it to Dace for 900 CR (she disappears). | Depends on the choice |
| Salvage Rights | QM Dace | Collect five lumen shards on the open floor. | 450 CR, 2 medgel |
| Last Transmission | BRASK-7 (once Kesh can fly) | Kilo-Two's relay drone fell on a ledge high on the north wall that only wings reach. Its core holds Okafor's last words. | 400 CR, scans reach twice as far |

Also on the floor: artifacts of below and medgel to find, **warden patrols** that roam five wild zones (never the firebase; they come back a few minutes after being driven off), and the quartermaster's **trade** - sell artifacts, buy medgel, slugs, a plate refit and, once Kesh is healed, a saddle rig.

## Kesh, the skywing

A new Mesha object, `creature.skywing` (Nature): long neck and horned head, a lean body on two hind legs, membrane wings on three long fingers, a long tail with a glowing fin, bioluminescent spots; options for length, neck, tail, bulk, wingspan, fingers, a `wounded` state (a broken slug-bolt and a glowing wound) and a rider's `saddle`. Each wing is its own region, so the game turns them about the shoulders (`skywingShoulder`) to fold and beat them.

Flying (ab_creature.ts) is arcade gliding: **W/S** set the speed, the look controls (mouse, stick, arrows) steer and pitch, it banks by itself; **Space** beats the wings to climb, **Shift** dives/boosts (both spend its breath; gliding wins it back); diving trades height for speed. It never flies into the ground and turns back at the map's edge. **E** close to the ground sets down, **E** again climbs off. On foot, **V** whistles: Kesh flies to Alex from anywhere and lands beside him.

## Controls added

`V` whistle for Kesh - `T` cycle the tracked quest - `1`/`2` answer a choice - `5` Okafor's carbine - `TAB` journal (click a quest to track it) - riding: `W/S`, look, `Space`, `Shift`, `E`.

## Code

| File | What |
| --- | --- |
| `ab_quests.ts` | The quest engine: quests as data (stages waiting on talk, reach, collect, kill, flag, interact or choice triggers), offering, tracking, saving. Pure. |
| `ab_script2.ts` | Chapter Two's data: places, people, quests, lines, the shop, the four cutscenes. |
| `ab_chapter2.ts` | Plays it over the Game: NPCs, quest actions, patrols, Kesh, trade, choices, save and load. |
| `ab_creature.ts` | Kesh's simulation and flight model, the chase camera. |
| `apps/mesha/library/skywing.ts` | The creature model. |

Headless tests: `examples/studio-bundle/tests/abyss_chapter2.test.ts` plays the main quest from Voss to the landing on the rim, every side quest (both ends of the idol), the patrols, trade, a save restored mid-chapter, and death. The live run (`tests/features/abyss_live.feature`, *Chapter Two*) captures the firebase, the trail, the hollow, Kesh and the flight in the real window.

## Where this goes next

Kesh is the key to the open world the story wants: in later chapters it can carry Alex between the Abyss and the surface's successor states, reach the kingdoms' cities across the floor, and serve as the hub's courier. The quest engine is chapter-agnostic, so later chapters add quests as data.
