import type { Entity } from "../addon";
import { ProceduralHumanoid } from "../humanoid_v2";
import { FPSUI, type DialogueOption, type DialogueState } from "./fps_ui";
import { addon, combat, entityPositions } from "./index";
import { Faction, factions, quests } from "./quests";
import { worldManager } from "./world";
import { gameState } from "./state";

export const behaviorHooks = new Map<string, any>();
const originalBehaviorRegister = Entropy.Behavior.register;
Entropy.Behavior.register = (id: string, hooks: any) => {
    behaviorHooks.set(id, hooks);
    originalBehaviorRegister(id, hooks);
};
const npcWanderStates = new Map();

const doWander = (entity: Entity, system: any, state: any) => {
    if (entity.isDead) return state;

    // Track position for combat system
    entityPositions.set(entity.id, entity.position);

    // Get or create state for THIS specific entity
    if (!npcWanderStates.has(entity.id)) {
        npcWanderStates.set(entity.id, {});
    }
    const myState = npcWanderStates.get(entity.id);
    const entityPos = entity.position;

    // Initialize anchor point (where the NPC "lives")
    if (!myState.anchorPoint) {
        myState.anchorPoint = [...entityPos];
        Entropy.println(`Entity ${entity.id} anchor initialized: ` + JSON.stringify(myState.anchorPoint));
    }
    
    // Get wander config from entity data (or use defaults)
    const wanderRadius = 15;
    // const patrolPoints = [
    //     [100, 0, 200],  // Behind counter
    //     [102, 0, 198],  // Check inventory
    //     [98, 0, 202],   // Greet customers area
    //     [100, 0, 200]   // Back to counter
    // ];
    const patrolPoints: any = null;
    const waitTimeMin = 60;
    const waitTimeMax = 180;
    const wanderSpeed = 4.5;
    
    // Handle waiting
    if (myState.waitTime && myState.waitTime > 0) {
        myState.waitTime--;
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        Entropy.Entity.playAnimation(entity.id, "Idle");
        worldManager.npcAnimations[entity.id] = "Idle";
        return state;
    }
    
    // Pick new target if needed
    if (!myState.wanderTarget) {
        if (patrolPoints && patrolPoints.length > 0) {
            // Use patrol points
            if (typeof myState.currentPatrolIndex !== 'number') {
                myState.currentPatrolIndex = 0;
            }
            myState.wanderTarget = [...patrolPoints[myState.currentPatrolIndex]];
        } else {
            // Random wander around anchor point
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * wanderRadius;
            myState.wanderTarget = [
                myState.anchorPoint[0] + Math.cos(angle) * r,
                myState.anchorPoint[1],
                myState.anchorPoint[2] + Math.sin(angle) * r
            ];
        }
    }
    
    // Calculate distance to target
    const wdx = myState.wanderTarget[0] - entityPos[0];
    const wdz = myState.wanderTarget[2] - entityPos[2];
    const wdist = Math.sqrt(wdx * wdx + wdz * wdz);
    
    if (wdist > 1.0) {
        // Move toward target
        const velocityX = (wdx / wdist) * wanderSpeed;
        const velocityZ = (wdz / wdist) * wanderSpeed;
        
        Entropy.Entity.setXZVelocity(entity.id, [velocityX, velocityZ]);
        
        // Face movement direction
        const angle = Math.atan2(velocityX, velocityZ);
        Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
        
        Entropy.Entity.playAnimation(entity.id, "Walking");
        worldManager.npcAnimations[entity.id] = "Walk";
    } else {
        // Reached target
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        
        // Move to next patrol point or pick new random spot
        if (patrolPoints && patrolPoints.length > 0) {
            myState.currentPatrolIndex = (myState.currentPatrolIndex + 1) % patrolPoints.length;
        }
        
        myState.wanderTarget = null;
        myState.waitTime = waitTimeMin + Math.random() * (waitTimeMax - waitTimeMin);
        
        Entropy.Entity.playAnimation(entity.id, "Idle");
        worldManager.npcAnimations[entity.id] = "Idle";
    }
    
    return state;
};

Entropy.Behavior.register("quest_giver_vex", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.CRIMSON_GUARD].reputation;
        const currentNode = dialogue.get_node();
        
        let text = "";
        let options: DialogueOption[] = [];

        if (rep < -30) {
            text = "You dare approach me, traitor? Leave before I have you executed!";
            options = [{ text: "Leave", next_node: "exit" }];
        } else if (!quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted) {
            text = "Welcome, warrior. The Crimson Guard values strength. Prove yourself worthy.";
            options = [
                { text: "How can I prove myself?", next_node: "quest_offer" },
                { text: "Maybe later", next_node: "exit" }
            ];
        } else if (quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted) {
            const killed = gameState.enemyKills.azure >= 5;
            const hasInsignias = gameState.hasItem("azure_insignia", 5);
            
            if (killed && hasInsignias) {
                text = "Impressive work. You've proven your strength. The Crimson Guard welcomes you.";
                gameState.completeQuest("crimson_welcome");
                options = [{ text: "What's next?", next_node: "quest_artifact" }];
            } else {
                text = `Progress: ${gameState.enemyKills.azure}/5 Azure defeated, ${gameState.inventory["azure_insignia"] || 0}/5 insignias collected.`;
                options = [{ text: "I'll continue", next_node: "exit" }];
            }
        } else if (quests["crimson_artifact"].isActive && !quests["crimson_artifact"].isCompleted) {
            if (gameState.hasItem("crimson_relic")) {
                text = "You found it! The ancient Crimson Relic. With this, we can turn the tide of war.";
                gameState.completeQuest("crimson_artifact");
                options = [{ text: "For the Guard!", next_node: "exit" }];
            } else {
                text = "The relic lies in Shadow territory. Be careful, they don't take kindly to intruders.";
                options = [{ text: "I'm on it", next_node: "exit" }];
            }
        } else {
            text = "You've done well, warrior. Rest and prepare for what's to come.";
            options = [{ text: "Farewell", next_node: "exit" }];
        }
        
        if (currentNode === "quest_offer") {
            text = "Defeat five Azure Order soldiers and bring me their insignias. Show no mercy.";
            options = [
                { text: "I accept", next_node: "quest_accept" },
                { text: "That's too much", next_node: "exit" }
            ];
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("crimson_welcome");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }
        
        if (currentNode === "quest_artifact") {
            gameState.startQuest("crimson_artifact");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        if (currentNode === "exit") {
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        gameState.openDialogue(entity.name || "Commander Vex", text, options);
        // Still call engine dialogue for internal state tracking if needed
        dialogue.show(text);
        options.forEach(o => dialogue.add_option(o.text, o.next_node));
    }
});

Entropy.Behavior.register("quest_giver_lyra", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.AZURE_ORDER].reputation;
        const currentNode = dialogue.get_node();

        let text = "";
        let options: DialogueOption[] = [];
        
        if (rep < -30) {
            text = "Your violent reputation precedes you. The Azure Order seeks peace, not chaos.";
            options = [{ text: "I understand", next_node: "exit" }];
        } else if (!quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted) {
            text = "Greetings, traveler. The Azure Order seeks knowledge and wisdom. Will you aid our cause?";
            options = [
                { text: "Tell me more", next_node: "quest_offer" },
                { text: "Not interested", next_node: "exit" }
            ];
        } else if (quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted) {
            const scrolls = gameState.inventory["ancient_scroll"] || 0;
            if (scrolls >= 3) {
                text = "Wonderful! These scrolls contain knowledge lost for centuries. You have my gratitude.";
                gameState.completeQuest("azure_welcome");
                options = [{ text: "What now?", next_node: "quest_peace" }];
            } else {
                text = `You've found ${scrolls}/3 Ancient Scrolls. They're scattered across the realm.`;
                options = [{ text: "I'll keep searching", next_node: "exit" }];
            }
        } else {
            text = "Thank you for your help. The path to wisdom is long, but you walk it well.";
            options = [{ text: "Farewell", next_node: "exit" }];
        }
        
        if (currentNode === "quest_offer") {
            text = "Ancient scrolls are scattered across the realm. Bring me three, and I'll share our knowledge.";
            options = [
                { text: "I'll find them", next_node: "quest_accept" },
                { text: "Too tedious", next_node: "exit" }
            ];
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("azure_welcome");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }
        
        if (currentNode === "quest_peace") {
            gameState.startQuest("azure_peace");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        if (currentNode === "exit") {
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        gameState.openDialogue(entity.name || "Scholar Lyra", text, options);
        dialogue.show(text);
        options.forEach(o => dialogue.add_option(o.text, o.next_node));
    }
});

Entropy.Behavior.register("quest_giver_whisper", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        const currentNode = dialogue.get_node();

        let text = "";
        let options: DialogueOption[] = [];
        
        if (!quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted) {
            text = "*A hooded figure emerges from darkness* Information is power. Are you clever enough to serve us?";
            options = [
                { text: "I'm interested", next_node: "quest_offer" },
                { text: "This feels wrong", next_node: "exit" }
            ];
        } else if (quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted) {
            const crimsonSpied = gameState.hasItem("crimson_intel");
            const azureSpied = gameState.hasItem("azure_intel");
            
            if (crimsonSpied && azureSpied) {
                text = "Excellent work. You move like a shadow. Perhaps you have a future with us.";
                gameState.completeQuest("shadow_welcome");
                options = [{ text: "What's the plan?", next_node: "quest_betrayal" }];
            } else {
                text = "Gather intelligence from both camps. Move unseen, strike unheard.";
                options = [{ text: "Understood", next_node: "exit" }];
            }
        } else {
            text = "The shadows embrace those who serve them well. Continue your work.";
            options = [{ text: "Farewell", next_node: "exit" }];
        }
        
        if (currentNode === "quest_offer") {
            text = "Spy on the Crimson and Azure factions. Learn their secrets. Can you be invisible?";
            options = [
                { text: "Yes", next_node: "quest_accept" },
                { text: "No", next_node: "exit" }
            ];
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("shadow_welcome");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }
        
        if (currentNode === "quest_betrayal") {
            gameState.startQuest("shadow_betrayal");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        if (currentNode === "exit") {
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        gameState.openDialogue(entity.name || "Whisper Master", text, options);
        dialogue.show(text);
        options.forEach(o => dialogue.add_option(o.text, o.next_node));
    }
});

Entropy.Behavior.register("neutral_wanderer", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        const currentNode = dialogue.get_node();

        let text = "";
        let options: DialogueOption[] = [];

        text = "I've traveled far and wide. The old ruins hold many secrets, if you're brave enough to seek them.";
        options = [
            { text: "Tell me about the ruins", next_node: "ruins_info" },
            { text: "Farewell", next_node: "exit" }
        ];
        
        if (currentNode === "ruins_info") {
            if (!quests["explore_ruins"].isActive) {
                text = "Five ancient artifacts remain hidden. Find them all, and you'll unlock something... special.";
                options = [
                    { text: "I'll search for them", next_node: "quest_accept" },
                    { text: "Maybe another time", next_node: "exit" }
                ];
            } else {
                text = `You've found ${gameState.collectablesFound}/5 artifacts. Keep exploring!`;
                options = [{ text: "Thanks", next_node: "exit" }];
            }
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("explore_ruins");
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        if (currentNode === "exit") {
            gameState.closeDialogue();
            dialogue.close();
            return;
        }

        gameState.openDialogue(entity.name || "The Wanderer", text, options);
        dialogue.show(text);
        options.forEach(o => dialogue.add_option(o.text, o.next_node));
    }
});



// --- Enemy Behaviors ---

Entropy.Behavior.register("crimson_soldier", {
    onUpdate: (entity, system, _s) => {
        if (entity.isDead) return _s;

        // Track position for combat system
        entityPositions.set(entity.id, entity.position);

        // Get or create state for THIS specific entity
        if (!npcWanderStates.has(entity.id)) {
            npcWanderStates.set(entity.id, {});
        }
        const state = npcWanderStates.get(entity.id);
        const entityPos = entity.position;

        // Initialize anchor point (where the NPC "lives")
        if (!state.anchorPoint) {
            state.anchorPoint = [...entityPos];
            Entropy.println(`Entity ${entity.id} anchor initialized: ` + JSON.stringify(state.anchorPoint));
        }

        // Entropy.println("crimson soldier update. entity: " + JSON.stringify(entity));
        
        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Update hostility based on reputation
        const isHostile = factions[Faction.CRIMSON_GUARD].reputation < -20;
        combat.setEntityHostile(entity.id, isHostile);

        // Combat AI
        if (isHostile && dist < 30 && gameState.playerId) {
            const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
            if (didAttack) {
                Entropy.Entity.playAnimation(entity.id, "Attack");
                worldManager.npcAnimations[entity.id] = "Wave";
                
                const angle = combat.getAimDirection(entity.id, gameState.playerId);
                if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                
                return state;
            }
        }
        
        // Initialize wander state
        if (!state.wanderTarget || state.waitTime > 0) {
            state.waitTime = state.waitTime || 0;
            if (state.waitTime > 0) {
                state.waitTime--;
                Entropy.Entity.playAnimation(entity.id, "Idle");
                worldManager.npcAnimations[entity.id] = "Idle";
                return state;
            }
            
            // Pick a random point in territory
            const territory = factions[Faction.CRIMSON_GUARD].territory;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * territory.radius;
            state.wanderTarget = [
                territory.x + Math.cos(angle) * r,
                0,
                territory.z + Math.sin(angle) * r
            ];
        }

        // Only aggressive if player has negative reputation
        if (factions[Faction.CRIMSON_GUARD].reputation < -20 && dist < 30) {
            if (dist > 2.5) {
                const speed = 9.5;
                
                let velocityX = (dx / dist) * speed;
                let velocityZ = (dz / dist) * speed;

                Entropy.Entity.setXZVelocity(entity.id, [
                    velocityX, velocityZ
                ]);

                // Face movement direction
                const angle = Math.atan2(velocityX, velocityZ);
                Entropy.Entity.setRotation(entity.id, [0, angle, 0]);

                Entropy.Entity.playAnimation(entity.id, "Walking");
                worldManager.npcAnimations[entity.id] = "Walk";
            } else {
                Entropy.Entity.playAnimation(entity.id, "Attack");
                worldManager.npcAnimations[entity.id] = "Wave"; // Attack placeholder
            }
        } else {
            // Wander behavior
            const wdx = state.wanderTarget[0] - entity.position[0];
            const wdz = state.wanderTarget[2] - entity.position[2];
            const wdist = Math.sqrt(wdx * wdx + wdz * wdz);

            // Entropy.println("CRIMSON GUARD: " + JSON.stringify(state.wanderTarget) + " " + JSON.stringify(entity.position) + " " + wdist);
            
            if (wdist > 1.0) {
                const speed = 6.5;
                
                let velocityX = (dx / dist) * speed;
                let velocityZ = (dz / dist) * speed;
                
                Entropy.Entity.setXZVelocity(entity.id, [
                    velocityX, velocityZ
                ]);

                // Face movement direction
                const angle = Math.atan2(velocityX, velocityZ);
                Entropy.Entity.setRotation(entity.id, [0, angle, 0]);

                Entropy.Entity.playAnimation(entity.id, "Walking");
                worldManager.npcAnimations[entity.id] = "Walk";
            } else {
                state.wanderTarget = null;
                state.waitTime = 60 + Math.random() * 120; // Wait 1-3 seconds
                Entropy.Entity.playAnimation(entity.id, "Idle");
                worldManager.npcAnimations[entity.id] = "Idle";
            }
        }
        
        return state;
    },
    onAttack: (entity, system, state) => {
        system.spawn_particles(entity.position, [1, 0.2, 0.2, 1], [0, -2, 0]);
        gameState.enemyKills.crimson++;
        
        // Drop insignia
        const y = addon.Landscape.getHeightAt(entity.position[0], entity.position[2]);
        gameState.createTrackedCollectable({
            position: [entity.position[0], y + 1, entity.position[2]],
            type: "quest_item",
            modelPath: "Barrel1medium.glb",
            value: 1,
            questId: "crimson_insignia",
            onCollect: () => {
                gameState.addItem("crimson_insignia", 1);
            }
        });
        
        return state;
    }
});

Entropy.Behavior.register("azure_soldier", {
    onUpdate: (entity, system, _s) => {
        if (entity.isDead) return _s;
        
        // Track position for combat system
        entityPositions.set(entity.id, entity.position);

        // Get or create state for THIS specific entity
        if (!npcWanderStates.has(entity.id)) {
            npcWanderStates.set(entity.id, {});
        }
        const state = npcWanderStates.get(entity.id);
        const entityPos = entity.position;

        // Initialize anchor point (where the NPC "lives")
        if (!state.anchorPoint) {
            state.anchorPoint = [...entityPos];
            Entropy.println(`Entity ${entity.id} anchor initialized: ` + JSON.stringify(state.anchorPoint));
        }

        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Update hostility based on reputation
        const isHostile = factions[Faction.AZURE_ORDER].reputation < -20;
        combat.setEntityHostile(entity.id, isHostile);

        // Combat AI
        if (isHostile && dist < 30 && gameState.playerId) {
            const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
            if (didAttack) {
                Entropy.Entity.playAnimation(entity.id, "Attack");
                worldManager.npcAnimations[entity.id] = "Wave";
                
                const angle = combat.getAimDirection(entity.id, gameState.playerId);
                if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                
                return state;
            }
        }
        
        // Initialize wander state
        if (!state.wanderTarget || state.waitTime > 0) {
            state.waitTime = state.waitTime || 0;
            if (state.waitTime > 0) {
                state.waitTime--;
                Entropy.Entity.playAnimation(entity.id, "Idle");
                worldManager.npcAnimations[entity.id] = "Idle";
                return state;
            }
            
            // Pick a random point in territory
            const territory = factions[Faction.AZURE_ORDER].territory;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * territory.radius;
            state.wanderTarget = [
                territory.x + Math.cos(angle) * r,
                0,
                territory.z + Math.sin(angle) * r
            ];
        }

        if (factions[Faction.AZURE_ORDER].reputation < -20 && dist < 30) {
            if (dist > 2.5) {
                const speed = 9.5;
                
                let velocityX = (dx / dist) * speed;
                let velocityZ = (dz / dist) * speed;
                
                Entropy.Entity.setXZVelocity(entity.id, [
                    velocityX, velocityZ
                ]);

                // Face movement direction
                const angle = Math.atan2(velocityX, velocityZ);
                Entropy.Entity.setRotation(entity.id, [0, angle, 0]);

                Entropy.Entity.playAnimation(entity.id, "Walking");
                worldManager.npcAnimations[entity.id] = "Walk";
            } else {
                Entropy.Entity.playAnimation(entity.id, "Attack");
                worldManager.npcAnimations[entity.id] = "Wave"; // Placeholder
            }
        } else {
            // Wander behavior
            const wdx = state.wanderTarget[0] - entity.position[0];
            const wdz = state.wanderTarget[2] - entity.position[2];
            const wdist = Math.sqrt(wdx * wdx + wdz * wdz);
            
            if (wdist > 1.0) {
                const speed = 6.5;
                
                let velocityX = (dx / dist) * speed;
                let velocityZ = (dz / dist) * speed;
                
                Entropy.Entity.setXZVelocity(entity.id, [
                    velocityX, velocityZ
                ]);

                // Face movement direction
                const angle = Math.atan2(velocityX, velocityZ);
                Entropy.Entity.setRotation(entity.id, [0, angle, 0]);

                Entropy.Entity.playAnimation(entity.id, "Walking");
                worldManager.npcAnimations[entity.id] = "Walk";
            } else {
                state.wanderTarget = null;
                state.waitTime = 60 + Math.random() * 120; // Wait 1-3 seconds
                Entropy.Entity.playAnimation(entity.id, "Idle");
                worldManager.npcAnimations[entity.id] = "Idle";
            }
        }
        
        return state;
    },
    onAttack: (entity, system, state) => {
        system.spawn_particles(entity.position, [0.2, 0.4, 1, 1], [0, -2, 0]);
        gameState.enemyKills.azure++;
        
        const y = addon.Landscape.getHeightAt(entity.position[0], entity.position[2]);
        gameState.createTrackedCollectable({
            position: [entity.position[0], y + 1, entity.position[2]],
            type: "quest_item",
            modelPath: "Barrel1medium.glb",
            value: 1,
            questId: "azure_insignia",
            onCollect: () => {
                gameState.addItem("azure_insignia", 1);
                
                // Check quest progress
                if (quests["crimson_welcome"].isActive && gameState.enemyKills.azure >= 5 && gameState.hasItem("azure_insignia", 5)) {
                    gameState.completeObjective("crimson_welcome", 0);
                    gameState.completeObjective("crimson_welcome", 1);
                }
            }
        });
        
        return state;
    }
});

Entropy.Behavior.register("shadow_assassin", {
    onUpdate: (entity, system, _s) => {
        if (entity.isDead) return _s;

        // Track position for combat system
        entityPositions.set(entity.id, entity.position);

        // Get or create state for THIS specific entity
        if (!npcWanderStates.has(entity.id)) {
            npcWanderStates.set(entity.id, {});
        }
        const state = npcWanderStates.get(entity.id);
        const entityPos = entity.position;

        // Initialize anchor point (where the NPC "lives")
        if (!state.anchorPoint) {
            state.anchorPoint = [...entityPos];
            Entropy.println(`Entity ${entity.id} anchor initialized: ` + JSON.stringify(state.anchorPoint));
        }
        
        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);

        // Combat AI (Assassins are hostile if dist < 10)
        const isHostile = dist < 10;
        combat.setEntityHostile(entity.id, isHostile);

        if (isHostile && gameState.playerId) {
            const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
            if (didAttack) {
                Entropy.Entity.playAnimation(entity.id, "Attack");
                worldManager.npcAnimations[entity.id] = "Wave";
                
                const angle = combat.getAimDirection(entity.id, gameState.playerId!);
                if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                
                return state;
            }
        }

        // Initialize wander state
        if (!state.wanderTarget || state.waitTime > 0) {
            state.waitTime = state.waitTime || 0;
            if (state.waitTime > 0) {
                state.waitTime--;
                Entropy.Entity.playAnimation(entity.id, "Idle");
                worldManager.npcAnimations[entity.id] = "Idle";
                return state;
            }
            
            // Pick a random point in territory
            const territory = factions[Faction.SHADOW_COVENANT].territory;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * territory.radius;
            state.wanderTarget = [
                territory.x + Math.cos(angle) * r,
                0,
                territory.z + Math.sin(angle) * r
            ];
        }
        
        // Shadows are always neutral unless attacked
        if (dist < 5) {
            // Stealth - disappear and reappear
            if (Math.random() > 0.98) {
                const angle = Math.random() * Math.PI * 2;
                const newX = playerPos[0] + Math.cos(angle) * 8;
                const newZ = playerPos[2] + Math.sin(angle) * 8;
                system.spawn_particles(entity.position, [0.5, 0.2, 0.8, 1], [0, 2, 0]);
                // Teleport via position set if possible, otherwise just use impulse
                Entropy.Entity.setXZVelocity(entity.id, [
                    (newX - entity.position[0]) * 2, (newZ - entity.position[2]) * 2
                ]);
            }
        } else {
            // Wander behavior
            const wdx = state.wanderTarget[0] - entity.position[0];
            const wdz = state.wanderTarget[2] - entity.position[2];
            const wdist = Math.sqrt(wdx * wdx + wdz * wdz);
            
            if (wdist > 1.0) {
                const speed = 2.0; // Assassins are a bit faster
                
                let velocityX = (dx / dist) * speed;
                let velocityZ = (dz / dist) * speed;
                
                Entropy.Entity.setXZVelocity(entity.id, [
                    velocityX, velocityZ
                ]);

                // Face movement direction
                const angle = Math.atan2(velocityX, velocityZ);
                Entropy.Entity.setRotation(entity.id, [0, angle, 0]);

                Entropy.Entity.playAnimation(entity.id, "Walking");
                worldManager.npcAnimations[entity.id] = "Walk";
            } else {
                state.wanderTarget = null;
                state.waitTime = 30 + Math.random() * 60; // Wait 0.5-1.5 seconds
                Entropy.Entity.playAnimation(entity.id, "Idle");
                worldManager.npcAnimations[entity.id] = "Idle";
            }
        }
        
        return state;
    },
    onAttack: (entity, system, state) => {
        system.spawn_particles(entity.position, [0.5, 0.2, 0.8, 1], [0, -2, 0]);
        gameState.enemyKills.shadow++;
        return state;
    }
});