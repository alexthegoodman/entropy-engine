// ## Battlefield-Style Bot AI Summary

// ### Core Philosophy
// **Entity-by-entity approach** with raycasts for a 1024×1024 terrain map with 15 bots. Skip complex pathfinding - use simple obstacle avoidance with raycasts since it's mostly open terrain with buildings/trees.

// ### The State Machine (Heart of the AI)
// ```typescript
// enum BotState {
//   PATROL,      // Wandering, looking for threats
//   ENGAGE,      // Actively shooting at player
//   ADVANCE,     // Moving toward enemy's last known position
//   RETREAT,     // Falling back when hurt/outnumbered
//   TAKE_COVER,  // Moving to cover position
//   IN_COVER,    // Behind cover, peeking out to shoot
//   RELOAD,      // Reloading weapon
//   HEALING,     // Using medkit
//   STUNNED,     // Flashbanged/suppressed
// }

// enum Stance {
//   STANDING,
//   CROUCHING,
//   PRONE,
//   SPRINTING,
// }
// ```

// ### Critical Systems

// **1. Realistic Aiming**
// - Smooth tracking (no instant snap-to-target)
// - Accuracy affected by: stance, movement, distance, suppression, time-on-target
// - Prone = most accurate, sprinting = terrible
// - Gets more accurate the longer they aim at you

// **2. Cover System**
// - Raycast around bot to find positions that block line-of-sight to player
// - Evaluate cover quality (full height vs crouch vs prone)
// - Score by: distance, quality, angle, not occupied
// - Bots peek out periodically to shoot, then duck back

// **3. Stance Management**
// - Go prone when: under fire with no cover, sniping at range, health critical
// - Crouch when: in partial cover, medium range combat
// - Sprint when: advancing/retreating, not in combat
// - Dynamically switch based on situation

// **4. Weapon/Ammo**
// - Reload when safe (in cover or out of sight)
// - Don't reload mid-firefight unless empty
// - Fire mode selection: auto for close, burst for medium, single for long range

// **5. Combat Awareness**
// - Track last known player position even after losing sight
// - Field of view ~120-160° (not omniscient)
// - Suppression: being shot at reduces accuracy, increases cover-seeking
// - Threat assessment if multiple enemies

// ### Key Behaviors

// **Navigation**: Direct approach with local obstacle avoidance (raycasts left/right/forward)
// **Stuck detection**: If not moving for ~0.5 seconds, wiggle out or try different direction
// **Cover seeking**: When health low, need reload, or heavily suppressed
// **Peeking**: Pop out from cover every 2-4 seconds to take shots
// **Variable aggression**: Some bots more aggressive (push forward), others cautious (hold position)

// ### The Feel
// - Bots that feel **tactical** not robotic
// - Take cover when hurt, peek to return fire
// - Smooth aim tracking, not instant headshots
// - Realistic weapon handling and stance changes
// - Emergent squad behavior from individual decision-making

// ### Implementation Priority
// 1. Basic movement + obstacle avoidance (raycasts)
// 2. State machine with PATROL → ENGAGE → TAKE_COVER → IN_COVER flow
// 3. Stance system (affects accuracy)
// 4. Cover detection (raycasts to find safe positions)
// 5. Realistic aiming (smooth tracking + spread calculations)
// 6. Weapon management (reload timing, fire modes)

// There needs to be an animation for each BotState and Stance on the humanoid (add animation functions 
// to separate file outside of character_creator_addon.ts, and then use that file inside character_creator_addon.ts)
// There should be a synth sound every time a weapon fires (see DAW addon)
// Make sure that these guys dont walk off the edge of the map :)