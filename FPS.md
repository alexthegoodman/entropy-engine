To build a functional Battlefield-style sandbox.

## 1. Character & Movement (The "Feel")

The player needs to feel like a physical entity, not a floating camera.

* **Physics-Based Controller:** Support for sprinting, crouching, and prone positions with varying speed modifiers.
* **Dynamic Camera:** View bobbing while moving and "camera shake" during nearby explosions or high-recoil fire.
* **Mantling System:** A requirement for Battlefield's flow—the ability to climb over low walls or pull oneself up ledges.
* **Stamina/Weight System:** (Optional but recommended) To prevent "bunny hopping" and encourage tactical movement.

## 2. Weapon Systems (The "Gunplay")

* **Procedural Recoil:** A mix of "Vertical Kick" and "Horizontal Sway" that the player must actively counteract.
* **Attachment System:** A modular way to swap scopes or barrels that modify the weapon's base stats (accuracy, recoil, etc.).

## 3. Bot AI & Commander Logic (The "War")

Bots shouldn't just stand and shoot; they need to play the objective.

* **Objective-Based Behavior:** A "High-Level Brain" that assigns bots to specific Capture Points based on team needs.
* **Squad Logic:** Bots should attempt to stay within a certain radius of a "Squad Leader" (either the player or another bot).
* **Suppression System:** If bullets land near a bot, their accuracy should decrease and they should prioritize finding cover.
* **Variable Difficulty:** A "Reaction Time" variable so bots don't have 0ms aimbot reflexes.

## 4. Environment & Game Mode (The "Loop")

* **Conquest Logic:** A system to track "Capture Points."
* **Neutral/Capturing/Owned** states.
* **Ticket Bleed:** The team with fewer flags loses "Life Tickets" over time.

* **Destructible Cover:** Even simple "Health-based" crates or walls that disappear when shot make the battlefield feel dynamic.
* **Spawn System:** The ability to spawn on captured points or living squadmates.