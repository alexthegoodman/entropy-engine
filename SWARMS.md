NOTE: This is for the approach before addons. We will like replace this with a Behavior Tree Node Graph Editor.

To use the new squad and swarm features, you assign a squad_id to your NPCs. Here is a breakdown of how they behave and how to set it up:

1. How to Specify a Squad
Currently, you can specify the squad in your project.json file (like example_project.json) under the npc_properties for each NPC component:

```
1 {
2   "id": "npc_1",
3   "kind": "NPC",
4   "npc_properties": {
5     "model_id": "soldier_model",
6     "squad_id": "alpha_squad",
7     "behavior": {
8       "aggressiveness": 0.8,
9       "combat_type": "Ranged",
10       "detection_radius": 20.0
11     }
12   },
13   ...
14 }
```

2. Squad Behavior (The "Follower" Logic)
When NPCs share a squad_id, the engine automatically designates the first living member as the Squad Leader.
* Following: If squad members are in the Wander state and move more than 10 units away from the leader, they will stop wandering randomly and move directly toward the
    leader's position.
* Cohesion: This keeps them moving together as a group across the map rather than scattering individually.

3. Swarm Behavior (The "Alert" Logic)
The "Swarm" effect kicks in during combat or detection, and it works based on proximity:
* Chain Reaction: If you shoot an NPC or if one spots you, they trigger an alert_nearby_npcs call.
* Reinforcements: Any nearby NPCs (within a 30-40 unit radius) will immediately switch from Wander to their combat state (Melee or Ranged).
* The Result: Instead of fighting a single isolated guard, his nearby allies will "swarm" your position once the alarm is raised.

4. Death & Looting
Since these items are now tied together:
* Dropped Loot: When an NPC in a squad dies, they now drop their entire inventory (weapons, items, etc.) as physical Collectable items on the ground.
* Looting: You can walk up to the dead NPC or the dropped items and press 'E' to loot them into your own inventory.