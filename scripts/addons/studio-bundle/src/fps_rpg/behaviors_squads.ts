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

// ============================================================================
// SQUAD SYSTEM
// ============================================================================

interface Squad {
    id: string;
    faction: Faction;
    members: Set<string>;
    leader: string | null;
    rallyPoint: number[];
    formation: 'wedge' | 'line' | 'scattered';
    state: 'patrol' | 'alert' | 'combat' | 'retreat';
    target: string | null; // Entity ID being engaged
    lastContactTime: number;
}

const squads = new Map<string, Squad>();
const entityToSquad = new Map<string, string>(); // entityId -> squadId

export function assignToSquad(entityId: string, squadId: string) {
    entityToSquad.set(entityId, squadId);
    const squad = squads.get(squadId);
    if (squad) {
        squad.members.add(entityId);
        if (!squad.leader) {
            squad.leader = entityId;
        }
    }
}

export function createSquad(
    id: string, 
    faction: Faction, 
    initialPosition: number[],
    memberIds: string[] = []
): Squad {
    const squad: Squad = {
        id,
        faction,
        members: new Set(memberIds),
        leader: memberIds[0] || null,
        rallyPoint: [...initialPosition],
        formation: 'wedge',
        state: 'patrol',
        target: null,
        lastContactTime: 0
    };
    
    squads.set(id, squad);
    memberIds.forEach(memberId => entityToSquad.set(memberId, id));
    
    return squad;
}

function getSquad(entityId: string): Squad | null {
    const squadId = entityToSquad.get(entityId);
    return squadId ? squads.get(squadId) || null : null;
}

function updateSquadState(squad: Squad, playerPos: number[]) {
    // Find closest member to player
    let closestDist = Infinity;
    let anyMemberInCombat = false;
    
    for (const memberId of squad.members) {
        const pos = entityPositions.get(memberId);
        if (!pos) continue;
        
        const dx = playerPos[0] - pos[0];
        const dz = playerPos[2] - pos[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < closestDist) {
            closestDist = dist;
        }
        
        if (dist < 30) {
            anyMemberInCombat = true;
        }
    }
    
    // State transitions
    if (anyMemberInCombat && squad.state === 'patrol') {
        squad.state = 'alert';
        squad.lastContactTime = Date.now();
    }
    
    if (closestDist < 25 && squad.state === 'alert') {
        squad.state = 'combat';
        squad.target = gameState.playerId || null;
    }
    
    // Return to patrol if no contact for a while
    if (squad.state === 'alert' && Date.now() - squad.lastContactTime > 5000) {
        squad.state = 'patrol';
    }
}

function getSquadPosition(squad: Squad, entityId: string, memberIndex: number, totalMembers: number): number[] | null {
    if (squad.state === 'patrol') {
        // Loose patrol formation around rally point
        const angle = (memberIndex / totalMembers) * Math.PI * 2;
        const spread = 5 + Math.random() * 3;
        return [
            squad.rallyPoint[0] + Math.cos(angle) * spread,
            squad.rallyPoint[1],
            squad.rallyPoint[2] + Math.sin(angle) * spread
        ];
    }
    
    if (squad.state === 'combat' && squad.target) {
        const targetPos = entityPositions.get(squad.target);
        if (!targetPos) return null;
        
        // Encircle target with some randomness
        const baseAngle = (memberIndex / totalMembers) * Math.PI * 2;
        const angleVariation = (Math.random() - 0.5) * 0.5; // +/- 15 degrees
        const angle = baseAngle + angleVariation;
        
        // Distance based on formation
        const distance = 12 + Math.random() * 6;
        
        return [
            targetPos[0] + Math.cos(angle) * distance,
            targetPos[1],
            targetPos[2] + Math.sin(angle) * distance
        ];
    }
    
    return null;
}

// ============================================================================
// NPC STATE
// ============================================================================

interface NPCState {
    anchorPoint?: number[];
    squadTarget?: number[];
    waitTime?: number;
    coverPosition?: number[];
    suppressionLevel?: number;
    lastShotTime?: number;
    health?: number;
    role?: 'leader' | 'soldier';
}

const npcStates = new Map<string, NPCState>();

function getState(entityId: string): NPCState {
    if (!npcStates.has(entityId)) {
        npcStates.set(entityId, { health: 100 });
    }
    return npcStates.get(entityId)!;
}

// ============================================================================
// SHARED ANIMATION & MOVEMENT
// ============================================================================

export function setAnimation(entityId: string, animation: string) {
    Entropy.Entity.playAnimation(entityId, animation);
    worldManager.npcAnimations[entityId] = animation;
}

function moveTowards(
    entity: Entity,
    target: number[],
    speed: number,
    stopDistance: number = 1.5,
    animationType: 'walk' | 'run' | 'sprint' | 'crouch' = 'walk'
): boolean {
    const dx = target[0] - entity.position[0];
    const dz = target[2] - entity.position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    if (dist > stopDistance) {
        const velocityX = (dx / dist) * speed;
        const velocityZ = (dz / dist) * speed;
        
        Entropy.Entity.setXZVelocity(entity.id, [velocityX, velocityZ]);
        
        const angle = Math.atan2(velocityX, velocityZ);
        Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
        
        const animMap: Record<string, string> = {
            'walk': 'Walking',
            'run': 'Walking',
            'sprint': 'Walking',
            'crouch': 'Walking'
        };
        
        setAnimation(entity.id, animMap[animationType]);
        return false;
    } else {
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        return true;
    }
}

// ============================================================================
// TACTICAL COMBAT
// ============================================================================

function doTacticalCombat(entity: Entity, squad: Squad | null, isHostile: boolean): boolean {
    if (entity.isDead || !gameState.playerId) return false;
    
    const state = getState(entity.id);
    const [playerPos] = Entropy.Camera.getTransform();
    const dx = playerPos[0] - entity.position[0];
    const dz = playerPos[2] - entity.position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    // Not hostile or out of range
    if (!isHostile || dist > 35) {
        return false;
    }
    
    // Update squad state
    if (squad) {
        updateSquadState(squad, playerPos);
    }
    
    // Suppression decay
    state.suppressionLevel = (state.suppressionLevel || 0) * 0.98;
    
    // Cover seeking logic
    const shouldSeekCover = (
        state.suppressionLevel! > 0.4 ||
        (state.health || 100) < 40 ||
        dist < 8
    );
    
    if (shouldSeekCover && !state.coverPosition) {
        // Find cover (simple: move perpendicular to player)
        const perpX = -dz / dist;
        const perpZ = dx / dist;
        const coverDist = 5 + Math.random() * 3;
        state.coverPosition = [
            entity.position[0] + perpX * coverDist,
            entity.position[1],
            entity.position[2] + perpZ * coverDist
        ];
    }
    
    // In cover
    if (state.coverPosition) {
        const arrived = moveTowards(entity, state.coverPosition, 7, 2, 'run');
        
        if (arrived) {
            setAnimation(entity.id, 'crouch');
            
            // Shoot from cover occasionally
            if (Math.random() > 0.96) {
                const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
                if (didAttack) {
                    setAnimation(entity.id, 'Attack');
                    const angle = combat.getAimDirection(entity.id, gameState.playerId);
                    if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                    state.lastShotTime = Date.now();
                }
            }
            
            // Leave cover randomly
            if (Math.random() > 0.99) {
                state.coverPosition = undefined;
            }
        }
        return true;
    }
    
    // Squad tactical positioning
    if (squad && squad.state === 'combat') {
        const memberIds = Array.from(squad.members);
        const myIndex = memberIds.indexOf(entity.id);
        const squadPos = getSquadPosition(squad, entity.id, myIndex, memberIds.length);
        
        if (squadPos) {
            const atPosition = moveTowards(entity, squadPos, 6, 3, 'run');
            
            if (atPosition || Math.random() > 0.97) {
                // Fire from position
                const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
                if (didAttack) {
                    setAnimation(entity.id, 'Attack');
                    const angle = combat.getAimDirection(entity.id, gameState.playerId);
                    if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                }
            }
            return true;
        }
    }
    
    // Default: advance and shoot
    if (dist > 12) {
        moveTowards(entity, playerPos, 6, 12, 'run');
    } else if (dist < 8) {
        // Back up
        const retreatX = entity.position[0] - dx / dist * 3;
        const retreatZ = entity.position[2] - dz / dist * 3;
        moveTowards(entity, [retreatX, entity.position[1], retreatZ], 5, 1, 'crouch');
    } else {
        // Ideal range - strafe and shoot
        if (Math.random() > 0.98) {
            const strafeDir = Math.random() > 0.5 ? 1 : -1;
            const strafeX = -dz / dist * strafeDir * 4;
            const strafeZ = dx / dist * strafeDir * 4;
            Entropy.Entity.setXZVelocity(entity.id, [strafeX, strafeZ]);
        }
        
        const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
        if (didAttack) {
            setAnimation(entity.id, 'Attack');
            const angle = combat.getAimDirection(entity.id, gameState.playerId);
            if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
        }
    }
    
    return true;
}

// ============================================================================
// PATROL WITH SQUAD
// ============================================================================

function doSquadPatrol(entity: Entity, squad: Squad): void {
    if (entity.isDead) return;
    
    const state = getState(entity.id);
    
    if (!state.anchorPoint) {
        state.anchorPoint = [...entity.position];
    }
    
    // Wait handling
    if (state.waitTime && state.waitTime > 0) {
        state.waitTime--;
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        setAnimation(entity.id, 'Idle');
        return;
    }
    
    // Get position in squad formation
    const memberIds = Array.from(squad.members);
    const myIndex = memberIds.indexOf(entity.id);
    const targetPos = getSquadPosition(squad, entity.id, myIndex, memberIds.length);
    
    if (!targetPos) {
        setAnimation(entity.id, 'Idle');
        return;
    }
    
    // Move to squad position
    const arrived = moveTowards(entity, targetPos, 5, 2, 'walk');
    
    if (arrived) {
        state.waitTime = 90 + Math.random() * 120; // Wait 1.5-3 seconds
        
        // Squad leader occasionally picks new rally point
        if (entity.id === squad.leader && Math.random() > 0.99) {
            const territory = factions[squad.faction].territory;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * territory.radius * 0.7;
            squad.rallyPoint = [
                territory.x + Math.cos(angle) * r,
                0,
                territory.z + Math.sin(angle) * r
            ];
        }
    }
}

// ============================================================================
// SIMPLE WANDER (NON-COMBAT NPCs)
// ============================================================================

function doWander(entity: Entity, speed: number = 4.5, radius: number = 15): void {
    if (entity.isDead) return;
    
    const state = getState(entity.id);
    entityPositions.set(entity.id, entity.position);
    
    if (!state.anchorPoint) {
        state.anchorPoint = [...entity.position];
    }
    
    if (state.waitTime && state.waitTime > 0) {
        state.waitTime--;
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        setAnimation(entity.id, 'Idle');
        return;
    }
    
    if (!state.squadTarget) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * radius;
        state.squadTarget = [
            state.anchorPoint[0] + Math.cos(angle) * r,
            state.anchorPoint[1],
            state.anchorPoint[2] + Math.sin(angle) * r
        ];
    }
    
    const arrived = moveTowards(entity, state.squadTarget, speed);
    
    if (arrived) {
        state.squadTarget = undefined;
        state.waitTime = 60 + Math.random() * 180;
    }
}

// ============================================================================
// DIALOGUE SYSTEM
// ============================================================================

function showDialogue(
    npcName: string,
    text: string, 
    options: DialogueOption[],
    dialogue: any
) {
    gameState.openDialogue(npcName, text, options);
    dialogue.show(text);
    options.forEach(o => dialogue.add_option(o.text, o.next_node));
}

function closeDialogue(dialogue: any) {
    gameState.closeDialogue();
    dialogue.close();
}

// ============================================================================
// QUEST GIVERS
// ============================================================================

Entropy.Behavior.register("quest_giver_vex", {
    onUpdate: (entity, system, state) => {
        doWander(entity, 4.5);
        return state;
    },
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
                text = `Progress: ${gameState.enemyKills.azure}/5 Azure defeated, ${gameState.inventory["azure_insignia"] || 0}/5 insignias.`;
                options = [{ text: "I'll continue", next_node: "exit" }];
            }
        } else if (quests["crimson_artifact"].isActive && !quests["crimson_artifact"].isCompleted) {
            if (gameState.hasItem("crimson_relic")) {
                text = "You found it! The ancient Crimson Relic. With this, we can turn the tide.";
                gameState.completeQuest("crimson_artifact");
                options = [{ text: "For the Guard!", next_node: "exit" }];
            } else {
                text = "The relic lies in Shadow territory. Be careful.";
                options = [{ text: "I'm on it", next_node: "exit" }];
            }
        } else {
            text = "You've done well, warrior. Rest and prepare.";
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
            closeDialogue(dialogue);
            return;
        }
        
        if (currentNode === "quest_artifact") {
            gameState.startQuest("crimson_artifact");
            closeDialogue(dialogue);
            return;
        }

        if (currentNode === "exit") {
            closeDialogue(dialogue);
            return;
        }

        showDialogue(entity.name || "Commander Vex", text, options, dialogue);
    }
});

Entropy.Behavior.register("quest_giver_lyra", {
    onUpdate: (entity, system, state) => {
        doWander(entity);
        return state;
    },
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.AZURE_ORDER].reputation;
        const currentNode = dialogue.get_node();

        let text = "";
        let options: DialogueOption[] = [];
        
        if (rep < -30) {
            text = "Your violent reputation precedes you. The Azure Order seeks peace, not chaos.";
            options = [{ text: "I understand", next_node: "exit" }];
        } else if (!quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted) {
            text = "Greetings, traveler. The Azure Order seeks knowledge. Will you aid us?";
            options = [
                { text: "Tell me more", next_node: "quest_offer" },
                { text: "Not interested", next_node: "exit" }
            ];
        } else if (quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted) {
            const scrolls = gameState.inventory["ancient_scroll"] || 0;
            if (scrolls >= 3) {
                text = "Wonderful! These scrolls contain knowledge lost for centuries.";
                gameState.completeQuest("azure_welcome");
                options = [{ text: "What now?", next_node: "quest_peace" }];
            } else {
                text = `You've found ${scrolls}/3 Ancient Scrolls.`;
                options = [{ text: "I'll keep searching", next_node: "exit" }];
            }
        } else {
            text = "Thank you for your help. The path to wisdom is long.";
            options = [{ text: "Farewell", next_node: "exit" }];
        }
        
        if (currentNode === "quest_offer") {
            text = "Ancient scrolls are scattered across the realm. Bring me three.";
            options = [
                { text: "I'll find them", next_node: "quest_accept" },
                { text: "Too tedious", next_node: "exit" }
            ];
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("azure_welcome");
            closeDialogue(dialogue);
            return;
        }
        
        if (currentNode === "quest_peace") {
            gameState.startQuest("azure_peace");
            closeDialogue(dialogue);
            return;
        }

        if (currentNode === "exit") {
            closeDialogue(dialogue);
            return;
        }

        showDialogue(entity.name || "Scholar Lyra", text, options, dialogue);
    }
});

Entropy.Behavior.register("quest_giver_whisper", {
    onUpdate: (entity, system, state) => {
        doWander(entity);
        return state;
    },
    onInteract: (entity, dialogue) => {
        const currentNode = dialogue.get_node();

        let text = "";
        let options: DialogueOption[] = [];
        
        if (!quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted) {
            text = "*A hooded figure emerges from darkness* Information is power. Are you clever enough?";
            options = [
                { text: "I'm interested", next_node: "quest_offer" },
                { text: "This feels wrong", next_node: "exit" }
            ];
        } else if (quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted) {
            const crimsonSpied = gameState.hasItem("crimson_intel");
            const azureSpied = gameState.hasItem("azure_intel");
            
            if (crimsonSpied && azureSpied) {
                text = "Excellent work. You move like a shadow.";
                gameState.completeQuest("shadow_welcome");
                options = [{ text: "What's the plan?", next_node: "quest_betrayal" }];
            } else {
                text = "Gather intelligence from both camps. Move unseen.";
                options = [{ text: "Understood", next_node: "exit" }];
            }
        } else {
            text = "The shadows embrace those who serve them well.";
            options = [{ text: "Farewell", next_node: "exit" }];
        }
        
        if (currentNode === "quest_offer") {
            text = "Spy on the Crimson and Azure factions. Learn their secrets.";
            options = [
                { text: "Yes", next_node: "quest_accept" },
                { text: "No", next_node: "exit" }
            ];
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("shadow_welcome");
            closeDialogue(dialogue);
            return;
        }
        
        if (currentNode === "quest_betrayal") {
            gameState.startQuest("shadow_betrayal");
            closeDialogue(dialogue);
            return;
        }

        if (currentNode === "exit") {
            closeDialogue(dialogue);
            return;
        }

        showDialogue(entity.name || "Whisper Master", text, options, dialogue);
    }
});

Entropy.Behavior.register("neutral_wanderer", {
    onUpdate: (entity, system, state) => {
        doWander(entity);
        return state;
    },
    onInteract: (entity, dialogue) => {
        const currentNode = dialogue.get_node();

        let text = "";
        let options: DialogueOption[] = [];

        text = "I've traveled far. The old ruins hold many secrets.";
        options = [
            { text: "Tell me about the ruins", next_node: "ruins_info" },
            { text: "Farewell", next_node: "exit" }
        ];
        
        if (currentNode === "ruins_info") {
            if (!quests["explore_ruins"].isActive) {
                text = "Five ancient artifacts remain hidden. Find them all...";
                options = [
                    { text: "I'll search", next_node: "quest_accept" },
                    { text: "Maybe another time", next_node: "exit" }
                ];
            } else {
                text = `You've found ${gameState.collectablesFound}/5 artifacts. Keep exploring!`;
                options = [{ text: "Thanks", next_node: "exit" }];
            }
        }
        
        if (currentNode === "quest_accept") {
            gameState.startQuest("explore_ruins");
            closeDialogue(dialogue);
            return;
        }

        if (currentNode === "exit") {
            closeDialogue(dialogue);
            return;
        }

        showDialogue(entity.name || "The Wanderer", text, options, dialogue);
    }
});

// ============================================================================
// FACTION SOLDIERS (SQUAD-BASED)
// ============================================================================

function createSquadSoldier(
    factionType: Faction,
    colorParticles: number[],
    dropItem: string,
    killCounter: 'crimson' | 'azure' | 'shadow'
) {
    return {
        onUpdate: (entity: Entity, system: any, _s: any) => {
            if (entity.isDead) return _s;
            
            const state = getState(entity.id);
            entityPositions.set(entity.id, entity.position);
            
            if (!state.anchorPoint) {
                state.anchorPoint = [...entity.position];
            }
            
            const [playerPos] = Entropy.Camera.getTransform();
            const dx = playerPos[0] - entity.position[0];
            const dz = playerPos[2] - entity.position[2];
            const dist = Math.sqrt(dx * dx + dz * dz);
            
            // Get squad
            const squad = getSquad(entity.id);
            
            // Check hostility - ALWAYS HOSTILE FOR TESTING
            // Remove or modify this later for reputation system
            const isHostile = true; // dist < 30; // Make them always hostile for now
            combat.setEntityHostile(entity.id, isHostile);
            
            // Combat mode
            if (isHostile && dist < 35) {
                const inCombat = doTacticalCombat(entity, squad, isHostile);
                if (inCombat) return state;
            }
            
            // Patrol with squad
            if (squad) {
                doSquadPatrol(entity, squad);
            } else {
                // Fallback: solo wander
                const territory = factions[factionType].territory;
                if (!state.squadTarget || state.waitTime! > 0) {
                    if (state.waitTime! > 0) {
                        state.waitTime!--;
                        setAnimation(entity.id, 'Idle');
                        return state;
                    }
                    
                    const angle = Math.random() * Math.PI * 2;
                    const r = Math.random() * territory.radius;
                    state.squadTarget = [
                        territory.x + Math.cos(angle) * r,
                        0,
                        territory.z + Math.sin(angle) * r
                    ];
                }
                
                const arrived = moveTowards(entity, state.squadTarget!, 6);
                if (arrived) {
                    state.squadTarget = undefined;
                    state.waitTime = 60 + Math.random() * 120;
                }
            }
            
            return state;
        },
        onAttack: (entity: Entity, system: any, state: any) => {
            system.spawn_particles(entity.position, colorParticles, [0, -2, 0]);
            gameState.enemyKills[killCounter]++;
            
            const y = addon.Landscape.getHeightAt(entity.position[0], entity.position[2]);
            gameState.createTrackedCollectable({
                position: [entity.position[0], y + 1, entity.position[2]],
                type: "quest_item",
                modelPath: "Barrel1medium.glb",
                value: 1,
                questId: dropItem,
                onCollect: () => {
                    gameState.addItem(dropItem, 1);
                    
                    if (killCounter === 'azure' && quests["crimson_welcome"].isActive) {
                        if (gameState.enemyKills.azure >= 5 && gameState.hasItem("azure_insignia", 5)) {
                            gameState.completeObjective("crimson_welcome", 0);
                            gameState.completeObjective("crimson_welcome", 1);
                        }
                    }
                }
            });
            
            return state;
        }
    };
}

Entropy.Behavior.register("crimson_soldier", 
    createSquadSoldier(Faction.CRIMSON_GUARD, [1, 0.2, 0.2, 1], "crimson_insignia", 'crimson')
);

Entropy.Behavior.register("azure_soldier",
    createSquadSoldier(Faction.AZURE_ORDER, [0.2, 0.4, 1, 1], "azure_insignia", 'azure')
);

Entropy.Behavior.register("shadow_assassin", {
    onUpdate: (entity: Entity, system: any, _s: any) => {
        if (entity.isDead) return _s;
        
        const state = getState(entity.id);
        entityPositions.set(entity.id, entity.position);
        
        if (!state.anchorPoint) {
            state.anchorPoint = [...entity.position];
        }
        
        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        const isHostile = dist < 15; // Closer range for stealth
        combat.setEntityHostile(entity.id, isHostile);
        
        if (isHostile && gameState.playerId) {
            // Aggressive melee combat
            if (dist > 3) {
                moveTowards(entity, playerPos, 8, 3, 'sprint');
            } else {
                const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
                if (didAttack) {
                    setAnimation(entity.id, 'Attack');
                    const angle = combat.getAimDirection(entity.id, gameState.playerId);
                    if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                }
            }
            
            // Teleport ability
            if (dist < 8 && Math.random() > 0.98) {
                const angle = Math.random() * Math.PI * 2;
                const newX = playerPos[0] + Math.cos(angle) * 6;
                const newZ = playerPos[2] + Math.sin(angle) * 6;
                
                system.spawn_particles(entity.position, [0.5, 0.2, 0.8, 1], [0, 2, 0]);
                Entropy.Entity.setXZVelocity(entity.id, [
                    (newX - entity.position[0]) * 2,
                    (newZ - entity.position[2]) * 2
                ]);
            }
            
            return state;
        }
        
        // Stealth patrol
        doWander(entity, 3, 12);
        
        return state;
    },
    onAttack: (entity: Entity, system: any, state: any) => {
        system.spawn_particles(entity.position, [0.5, 0.2, 0.8, 1], [0, -2, 0]);
        gameState.enemyKills.shadow++;
        return state;
    }
});