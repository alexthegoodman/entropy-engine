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
// SHARED STATE MANAGEMENT
// ============================================================================

interface NPCState {
    anchorPoint?: number[];
    wanderTarget?: number[];
    waitTime?: number;
    currentPatrolIndex?: number;
    coverPosition?: number[];
    lastCombatTime?: number;
    suppressionLevel?: number;
    alertLevel?: number; // 0 = idle, 1 = alert, 2 = combat
    lastKnownPlayerPos?: number[];
    squadId?: string;
    role?: 'assault' | 'support' | 'scout'; // For tactical coordination
}

const npcStates = new Map<string, NPCState>();

function getState(entityId: string): NPCState {
    if (!npcStates.has(entityId)) {
        npcStates.set(entityId, {});
    }
    return npcStates.get(entityId)!;
}

// ============================================================================
// TACTICAL SYSTEMS
// ============================================================================

interface CoverPoint {
    position: number[];
    quality: number; // 0-1, how good the cover is
    occupiedBy?: string;
}

const coverPoints = new Map<string, CoverPoint[]>(); // territoryId -> cover points

function findNearestCover(position: number[], maxDistance: number = 15): CoverPoint | null {
    // TODO: Implement proper cover point detection
    // For now, generate procedural cover points around anchor
    const angle = Math.random() * Math.PI * 2;
    const dist = 3 + Math.random() * 5;
    return {
        position: [
            position[0] + Math.cos(angle) * dist,
            position[1],
            position[2] + Math.sin(angle) * dist
        ],
        quality: 0.6 + Math.random() * 0.4
    };
}

interface Squad {
    id: string;
    members: string[];
    leader: string;
    target?: number[];
    formation: 'line' | 'wedge' | 'scattered';
}

const squads = new Map<string, Squad>();

function updateSquadCoordination(squad: Squad) {
    // Simple flanking logic: spread members around target
    if (!squad.target || squad.members.length < 2) return;
    
    const anglePerMember = (Math.PI * 2) / squad.members.length;
    squad.members.forEach((memberId, index) => {
        const state = getState(memberId);
        const angle = anglePerMember * index;
        const distance = 8 + Math.random() * 4;
        
        state.wanderTarget = [
            squad.target![0] + Math.cos(angle) * distance,
            squad.target![1],
            squad.target![2] + Math.sin(angle) * distance
        ];
    });
}

// ============================================================================
// SHARED MOVEMENT & ANIMATION
// ============================================================================

function setAnimation(entityId: string, animation: string) {
    Entropy.Entity.playAnimation(entityId, animation);
    worldManager.npcAnimations[entityId] = animation;
}

function moveTowards(
    entity: Entity,
    target: number[],
    speed: number,
    stopDistance: number = 1.0,
    animation: 'walk' | 'run' | 'sprint' | 'crouchwalk' = 'walk'
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
        
        // Map animation names to what the system expects
        const animMap: Record<string, string> = {
            'walk': 'Walking',
            'run': 'Walking', // Use Walking for now
            'sprint': 'Walking',
            'crouchwalk': 'Walking'
        };
        
        setAnimation(entity.id, animMap[animation]);
        return false; // Not arrived
    } else {
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        setAnimation(entity.id, 'Idle');
        return true; // Arrived
    }
}

// ============================================================================
// WANDER BEHAVIOR (SHARED)
// ============================================================================

interface WanderConfig {
    radius?: number;
    patrolPoints?: number[][];
    waitTimeMin?: number;
    waitTimeMax?: number;
    speed?: number;
}

function doWander(entity: Entity, config: WanderConfig = {}): void {
    if (entity.isDead) return;
    
    const state = getState(entity.id);
    entityPositions.set(entity.id, entity.position);
    
    // Initialize anchor point
    if (!state.anchorPoint) {
        state.anchorPoint = [...entity.position];
    }
    
    const {
        radius = 15,
        patrolPoints = null,
        waitTimeMin = 60,
        waitTimeMax = 180,
        speed = 4.5
    } = config;
    
    // Handle waiting
    if (state.waitTime && state.waitTime > 0) {
        state.waitTime--;
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        setAnimation(entity.id, 'Idle');
        return;
    }
    
    // Pick new target if needed
    if (!state.wanderTarget) {
        if (patrolPoints && patrolPoints.length > 0) {
            if (typeof state.currentPatrolIndex !== 'number') {
                state.currentPatrolIndex = 0;
            }
            state.wanderTarget = [...patrolPoints[state.currentPatrolIndex]];
        } else {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * radius;
            state.wanderTarget = [
                state.anchorPoint[0] + Math.cos(angle) * r,
                state.anchorPoint[1],
                state.anchorPoint[2] + Math.sin(angle) * r
            ];
        }
    }
    
    // Move to target
    const arrived = moveTowards(entity, state.wanderTarget, speed);
    
    if (arrived) {
        // Move to next patrol point or clear target
        if (patrolPoints && patrolPoints.length > 0) {
            state.currentPatrolIndex = (state.currentPatrolIndex! + 1) % patrolPoints.length;
        }
        
        state.wanderTarget = undefined;
        state.waitTime = waitTimeMin + Math.random() * (waitTimeMax - waitTimeMin);
    }
}

// ============================================================================
// TACTICAL COMBAT BEHAVIOR (SHARED)
// ============================================================================

interface CombatConfig {
    aggroRange: number;
    retreatHealth?: number;
    preferredRange?: number;
    usesCover?: boolean;
    aggressiveness?: number; // 0-1
}

function doTacticalCombat(entity: Entity, config: CombatConfig): boolean {
    // Entropy.println("doTacticalCombat: " + JSON.stringify(entity) + " " + JSON.stringify(config) + " " + gameState.playerId);

    if (entity.isDead || !gameState.playerId) return false;
    
    const state = getState(entity.id);
    const [playerPos] = Entropy.Camera.getTransform();
    const dx = playerPos[0] - entity.position[0];
    const dz = playerPos[2] - entity.position[2];
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    const {
        aggroRange,
        preferredRange = 8,
        usesCover = true,
        aggressiveness = 0.7
    } = config;
    
    // Check if in combat range
    if (dist > aggroRange) {
        state.alertLevel = 0;
        return false;
    }
    
    state.alertLevel = 2;
    state.lastKnownPlayerPos = [...playerPos];
    state.lastCombatTime = Date.now();
    
    // SUPPRESSION SYSTEM - If player recently attacked, increase suppression
    state.suppressionLevel = (state.suppressionLevel || 0) * 0.95; // Decay over time
    
    // TACTICAL DECISION MAKING
    const shouldTakeCover = usesCover && (
        state.suppressionLevel! > 0.5 || // Suppressed
        dist < preferredRange * 0.5 || // Too close
        Math.random() > aggressiveness // Random tactical choice
    );
    
    if (shouldTakeCover && !state.coverPosition) {
        const cover = findNearestCover(entity.position);
        if (cover) {
            state.coverPosition = cover.position;
        }
    }
    
    // MOVEMENT LOGIC
    if (state.coverPosition) {
        const arrived = moveTowards(entity, state.coverPosition, 7, 1.5, 'run');
        
        if (arrived) {
            // In cover - crouch and peek
            setAnimation(entity.id, 'crouch');
            
            // Occasionally peek and shoot
            if (Math.random() > 0.97) {
                const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
                if (didAttack) {
                    setAnimation(entity.id, 'Attack');
                    const angle = combat.getAimDirection(entity.id, gameState.playerId);
                    if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
                }
            }
            
            // Leave cover after a while
            if (Math.random() > 0.98) {
                state.coverPosition = undefined;
            }
        }
        
        return true;
    }
    
    // NO COVER - Engage based on distance
    if (dist > preferredRange) {
        // Advance while firing
        const speed = 6;
        moveTowards(entity, playerPos, speed, preferredRange, 'run');
        
        // Shoot while advancing occasionally
        if (Math.random() > 0.95) {
            const didAttack = combat.updateNPCCombat(entity.id, gameState.playerId);
            if (didAttack) {
                setAnimation(entity.id, 'Attack');
                const angle = combat.getAimDirection(entity.id, gameState.playerId);
                if (angle !== null) Entropy.Entity.setRotation(entity.id, [0, angle, 0]);
            }
        }
    } else if (dist < preferredRange * 0.7) {
        // Too close - back up while firing
        const retreatPoint = [
            entity.position[0] - dx / dist * 5,
            entity.position[1],
            entity.position[2] - dz / dist * 5
        ];
        moveTowards(entity, retreatPoint, 5, 1, 'crouchwalk');
    } else {
        // Ideal range - strafe and shoot
        Entropy.Entity.setXZVelocity(entity.id, [0, 0]);
        
        // Strafe occasionally
        if (Math.random() > 0.97) {
            const strafeDir = Math.random() > 0.5 ? 1 : -1;
            const strafeX = -dz / dist * strafeDir * 3;
            const strafeZ = dx / dist * strafeDir * 3;
            Entropy.Entity.setXZVelocity(entity.id, [strafeX, strafeZ]);
            setAnimation(entity.id, 'crouchwalk');
        }
        
        // Fire!
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
// DIALOGUE HELPER
// ============================================================================

interface DialogueFlow {
    [nodeName: string]: {
        text: string;
        options: DialogueOption[];
        condition?: () => boolean;
        action?: () => void;
    };
}

function handleDialogue(entity: Entity, dialogue: any, flow: DialogueFlow, defaultNode: string = "start") {
    const currentNode = dialogue.get_node();
    const nodeData = flow[currentNode] || flow[defaultNode];
    
    if (!nodeData) return;
    
    // Check condition if present
    if (nodeData.condition && !nodeData.condition()) {
        // Fallback to default
        const fallback = flow[defaultNode];
        gameState.openDialogue(entity.name || "NPC", fallback.text, fallback.options);
        dialogue.show(fallback.text);
        fallback.options.forEach(o => dialogue.add_option(o.text, o.next_node));
        return;
    }
    
    // Execute action if present
    if (nodeData.action) {
        nodeData.action();
    }
    
    // Handle special nodes
    if (currentNode === "exit" || currentNode === "close") {
        gameState.closeDialogue();
        dialogue.close();
        return;
    }
    
    // Show dialogue
    gameState.openDialogue(entity.name || "NPC", nodeData.text, nodeData.options);
    dialogue.show(nodeData.text);
    nodeData.options.forEach(o => dialogue.add_option(o.text, o.next_node));
}

// ============================================================================
// QUEST GIVER BEHAVIORS
// ============================================================================

Entropy.Behavior.register("quest_giver_vex", {
    onUpdate: (entity, system, state) => {
        doWander(entity, { speed: 4.5 });
        return state;
    },
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.CRIMSON_GUARD].reputation;
        
        const flow: DialogueFlow = {
            start: {
                text: rep < -30 
                    ? "You dare approach me, traitor? Leave before I have you executed!"
                    : !quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted
                        ? "Welcome, warrior. The Crimson Guard values strength. Prove yourself worthy."
                        : quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted
                            ? `Progress: ${gameState.enemyKills.azure}/5 Azure defeated, ${gameState.inventory["azure_insignia"] || 0}/5 insignias.`
                            : quests["crimson_artifact"].isActive && !quests["crimson_artifact"].isCompleted
                                ? gameState.hasItem("crimson_relic")
                                    ? "You found it! The ancient Crimson Relic. With this, we can turn the tide."
                                    : "The relic lies in Shadow territory. Be careful."
                                : "You've done well, warrior. Rest and prepare.",
                options: rep < -30 
                    ? [{ text: "Leave", next_node: "exit" }]
                    : !quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted
                        ? [
                            { text: "How can I prove myself?", next_node: "quest_offer" },
                            { text: "Maybe later", next_node: "exit" }
                        ]
                        : quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted
                            ? gameState.enemyKills.azure >= 5 && gameState.hasItem("azure_insignia", 5)
                                ? [{ text: "What's next?", next_node: "quest_complete" }]
                                : [{ text: "I'll continue", next_node: "exit" }]
                            : [{ text: "Farewell", next_node: "exit" }]
            },
            quest_offer: {
                text: "Defeat five Azure Order soldiers and bring me their insignias. Show no mercy.",
                options: [
                    { text: "I accept", next_node: "quest_accept" },
                    { text: "That's too much", next_node: "exit" }
                ]
            },
            quest_accept: {
                text: "",
                options: [],
                action: () => {
                    gameState.startQuest("crimson_welcome");
                    gameState.closeDialogue();
                    dialogue.close();
                }
            },
            quest_complete: {
                text: "Impressive. The Crimson Guard welcomes you.",
                options: [{ text: "What's next?", next_node: "quest_artifact_offer" }],
                action: () => gameState.completeQuest("crimson_welcome")
            },
            quest_artifact_offer: {
                text: "",
                options: [],
                action: () => {
                    gameState.startQuest("crimson_artifact");
                    gameState.closeDialogue();
                    dialogue.close();
                }
            }
        };
        
        handleDialogue(entity, dialogue, flow);
    }
});

// Similar refactoring for other quest givers...
Entropy.Behavior.register("quest_giver_lyra", {
    onUpdate: (entity, system, state) => {
        doWander(entity);
        return state;
    },
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.AZURE_ORDER].reputation;
        
        const flow: DialogueFlow = {
            start: {
                text: rep < -30
                    ? "Your violent reputation precedes you. The Azure Order seeks peace, not chaos."
                    : !quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted
                        ? "Greetings, traveler. The Azure Order seeks knowledge. Will you aid us?"
                        : quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted
                            ? `You've found ${gameState.inventory["ancient_scroll"] || 0}/3 Ancient Scrolls.`
                            : "Thank you for your help. The path to wisdom is long.",
                options: rep < -30
                    ? [{ text: "I understand", next_node: "exit" }]
                    : !quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted
                        ? [
                            { text: "Tell me more", next_node: "quest_offer" },
                            { text: "Not interested", next_node: "exit" }
                        ]
                        : [{ text: "Farewell", next_node: "exit" }]
            },
            quest_offer: {
                text: "Ancient scrolls are scattered across the realm. Bring me three.",
                options: [
                    { text: "I'll find them", next_node: "quest_accept" },
                    { text: "Too tedious", next_node: "exit" }
                ]
            },
            quest_accept: {
                text: "",
                options: [],
                action: () => {
                    gameState.startQuest("azure_welcome");
                    gameState.closeDialogue();
                    dialogue.close();
                }
            }
        };
        
        handleDialogue(entity, dialogue, flow);
    }
});

Entropy.Behavior.register("quest_giver_whisper", {
    onUpdate: (entity, system, state) => {
        doWander(entity);
        return state;
    },
    onInteract: (entity, dialogue) => {
        const flow: DialogueFlow = {
            start: {
                text: !quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted
                    ? "*A hooded figure emerges from darkness* Information is power. Are you clever enough?"
                    : quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted
                        ? "Gather intelligence from both camps. Move unseen, strike unheard."
                        : "The shadows embrace those who serve them well.",
                options: !quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted
                    ? [
                        { text: "I'm interested", next_node: "quest_offer" },
                        { text: "This feels wrong", next_node: "exit" }
                    ]
                    : [{ text: "Farewell", next_node: "exit" }]
            },
            quest_offer: {
                text: "Spy on the Crimson and Azure factions. Learn their secrets.",
                options: [
                    { text: "Yes", next_node: "quest_accept" },
                    { text: "No", next_node: "exit" }
                ]
            },
            quest_accept: {
                text: "",
                options: [],
                action: () => {
                    gameState.startQuest("shadow_welcome");
                    gameState.closeDialogue();
                    dialogue.close();
                }
            }
        };
        
        handleDialogue(entity, dialogue, flow);
    }
});

Entropy.Behavior.register("neutral_wanderer", {
    onUpdate: (entity, system, state) => {
        doWander(entity);
        return state;
    },
    onInteract: (entity, dialogue) => {
        const flow: DialogueFlow = {
            start: {
                text: "I've traveled far. The old ruins hold many secrets, if you're brave enough.",
                options: [
                    { text: "Tell me about the ruins", next_node: "ruins_info" },
                    { text: "Farewell", next_node: "exit" }
                ]
            },
            ruins_info: {
                text: !quests["explore_ruins"].isActive
                    ? "Five ancient artifacts remain hidden. Find them all..."
                    : `You've found ${gameState.collectablesFound}/5 artifacts. Keep exploring!`,
                options: !quests["explore_ruins"].isActive
                    ? [
                        { text: "I'll search", next_node: "quest_accept" },
                        { text: "Maybe later", next_node: "exit" }
                    ]
                    : [{ text: "Thanks", next_node: "exit" }]
            },
            quest_accept: {
                text: "",
                options: [],
                action: () => {
                    gameState.startQuest("explore_ruins");
                    gameState.closeDialogue();
                    dialogue.close();
                }
            }
        };
        
        handleDialogue(entity, dialogue, flow);
    }
});

// ============================================================================
// FACTION SOLDIER BEHAVIORS (TACTICAL)
// ============================================================================

function createSoldierBehavior(
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
            
            // Initialize
            if (!state.anchorPoint) {
                state.anchorPoint = [...entity.position];
            }
            
            const [playerPos] = Entropy.Camera.getTransform();
            const dx = playerPos[0] - entity.position[0];
            const dz = playerPos[2] - entity.position[2];
            const dist = Math.sqrt(dx * dx + dz * dz);
            
            // Determine hostility based on reputation
            const isHostile = factions[factionType].reputation < -20;
            combat.setEntityHostile(entity.id, isHostile);
            
            // COMBAT MODE
            if (isHostile && dist < 30) {
                const inCombat = doTacticalCombat(entity, {
                    aggroRange: 30,
                    preferredRange: 10,
                    usesCover: true,
                    aggressiveness: 0.6
                });
                
                if (inCombat) return state;
            }
            
            // PATROL MODE
            if (!state.wanderTarget || state.waitTime! > 0) {
                if (state.waitTime! > 0) {
                    state.waitTime!--;
                    setAnimation(entity.id, 'Idle');
                    return state;
                }
                
                // Pick patrol point in territory
                const territory = factions[factionType].territory;
                const angle = Math.random() * Math.PI * 2;
                const r = Math.random() * territory.radius;
                state.wanderTarget = [
                    territory.x + Math.cos(angle) * r,
                    0,
                    territory.z + Math.sin(angle) * r
                ];
            }
            
            const arrived = moveTowards(entity, state.wanderTarget, 6.5);
            if (arrived) {
                state.wanderTarget = undefined;
                state.waitTime = 60 + Math.random() * 120;
            }
            
            return state;
        },
        onAttack: (entity: Entity, system: any, state: any) => {
            system.spawn_particles(entity.position, colorParticles, [0, -2, 0]);
            gameState.enemyKills[killCounter]++;
            
            // Drop insignia
            const y = addon.Landscape.getHeightAt(entity.position[0], entity.position[2]);
            gameState.createTrackedCollectable({
                position: [entity.position[0], y + 1, entity.position[2]],
                type: "quest_item",
                modelPath: "Barrel1medium.glb",
                value: 1,
                questId: dropItem,
                onCollect: () => {
                    gameState.addItem(dropItem, 1);
                    
                    // Quest progress check
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
    createSoldierBehavior(
        Faction.CRIMSON_GUARD, 
        [1, 0.2, 0.2, 1], 
        "crimson_insignia",
        'crimson'
    )
);

Entropy.Behavior.register("azure_soldier",
    createSoldierBehavior(
        Faction.AZURE_ORDER,
        [0.2, 0.4, 1, 1],
        "azure_insignia",
        'azure'
    )
);

// ============================================================================
// SHADOW ASSASSIN (STEALTH)
// ============================================================================

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
        
        // Assassins are hostile within 10m
        const isHostile = dist < 10;
        combat.setEntityHostile(entity.id, isHostile);
        
        if (isHostile && gameState.playerId) {
            // Aggressive close-range combat with teleport ability
            const inCombat = doTacticalCombat(entity, {
                aggroRange: 10,
                preferredRange: 3,
                usesCover: false,
                aggressiveness: 0.9
            });
            
            // TELEPORT ABILITY
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
            
            if (inCombat) return state;
        }
        
        // Stealth patrol
        if (!state.wanderTarget || state.waitTime! > 0) {
            if (state.waitTime! > 0) {
                state.waitTime!--;
                setAnimation(entity.id, 'crouch'); // Crouched when idle
                return state;
            }
            
            const territory = factions[Faction.SHADOW_COVENANT].territory;
            const angle = Math.random() * Math.PI * 2;
            const r = Math.random() * territory.radius;
            state.wanderTarget = [
                territory.x + Math.cos(angle) * r,
                0,
                territory.z + Math.sin(angle) * r
            ];
        }
        
        const arrived = moveTowards(entity, state.wanderTarget, 3, 1, 'crouchwalk');
        if (arrived) {
            state.wanderTarget = undefined;
            state.waitTime = 30 + Math.random() * 60;
        }
        
        return state;
    },
    onAttack: (entity: Entity, system: any, state: any) => {
        system.spawn_particles(entity.position, [0.5, 0.2, 0.8, 1], [0, -2, 0]);
        gameState.enemyKills.shadow++;
        return state;
    }
});