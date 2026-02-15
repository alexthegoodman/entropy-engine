import type { Entity } from "./addon";
import { ProceduralHumanoid } from "./humanoid_v2";
import { FPSUI, type DialogueState } from "./fps_ui";
import { 
    FloorPlan, 
    HouseGeometry, 
    type HouseParams, 
    Rect, 
    vec2, 
    vec3, 
    HOUSE_SHADER,
    MeshBuilder
} from "./procedural_houses_addon";

const addonInfo = {
    name: "The Fractured Realm",
    version: "1.0.0",
    description: "An open-world FPS RPG with branching storylines and faction warfare",
    author: ["Entropy AI"],
    capabilities: {
        ui: true,
        gameplay: true,
        quests: true
    }
};

const addon = Entropy.Addon.register(addonInfo);
const fpsUI = new FPSUI(addon);

// --- Game Configuration ---
// const LANDSCAPE_SIZE = 4096; // Configurable
// const LANDSCAPE_HEIGHT = 50;

// --- Faction System ---
enum Faction {
    CRIMSON_GUARD = "crimson_guard",
    AZURE_ORDER = "azure_order",
    SHADOW_COVENANT = "shadow_covenant",
    NEUTRAL = "neutral"
}

interface FactionData {
    name: string;
    color: [number, number, number, number];
    territory: { x: number, z: number, radius: number };
    reputation: number; // -100 to 100
}

const factions: Record<Faction, FactionData> = {
    [Faction.CRIMSON_GUARD]: {
        name: "Crimson Guard",
        color: [1, 0.2, 0.2, 1],
        territory: { x: -240, z: -240, radius: 240 },
        reputation: 0
    },
    [Faction.AZURE_ORDER]: {
        name: "Azure Order",
        color: [0.2, 0.4, 1, 1],
        territory: { x: 240, z: -240, radius: 240 },
        reputation: 0
    },
    [Faction.SHADOW_COVENANT]: {
        name: "Shadow Covenant",
        color: [0.5, 0.2, 0.8, 1],
        territory: { x: 240, z: 240, radius: 240 },
        reputation: 0
    },
    [Faction.NEUTRAL]: {
        name: "Neutral",
        color: [0.7, 0.7, 0.7, 1],
        territory: { x: -240, z: 240, radius: 240 },
        reputation: 0
    }
};

// --- Quest System ---
interface Quest {
    id: string;
    title: string;
    description: string;
    giver: string;
    faction: Faction;
    objectives: string[];
    completedObjectives: boolean[];
    reputationReward: { faction: Faction, amount: number }[];
    nextQuests?: string[];
    isActive: boolean;
    isCompleted: boolean;
}

const quests: Record<string, Quest> = {
    // === CRIMSON GUARD QUESTLINE ===
    "crimson_welcome": {
        id: "crimson_welcome",
        title: "Blood and Honor",
        description: "Commander Vex needs proof of your combat prowess.",
        giver: "commander_vex",
        faction: Faction.CRIMSON_GUARD,
        objectives: ["Defeat 5 Azure soldiers", "Collect their insignias"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.CRIMSON_GUARD, amount: 25 },
            { faction: Faction.AZURE_ORDER, amount: -15 }
        ],
        nextQuests: ["crimson_artifact"],
        isActive: false,
        isCompleted: false
    },
    "crimson_artifact": {
        id: "crimson_artifact",
        title: "The Crimson Relic",
        description: "Retrieve an ancient artifact from Shadow Covenant territory.",
        giver: "commander_vex",
        faction: Faction.CRIMSON_GUARD,
        objectives: ["Find the Crimson Relic", "Return to Commander Vex"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.CRIMSON_GUARD, amount: 40 },
            { faction: Faction.SHADOW_COVENANT, amount: -25 }
        ],
        nextQuests: ["crimson_finale"],
        isActive: false,
        isCompleted: false
    },
    "crimson_finale": {
        id: "crimson_finale",
        title: "The Final Stand",
        description: "Lead an assault on the Azure stronghold.",
        giver: "commander_vex",
        faction: Faction.CRIMSON_GUARD,
        objectives: ["Defeat Azure Commander", "Plant Crimson Banner"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.CRIMSON_GUARD, amount: 50 },
            { faction: Faction.AZURE_ORDER, amount: -50 }
        ],
        isActive: false,
        isCompleted: false
    },

    // === AZURE ORDER QUESTLINE ===
    "azure_welcome": {
        id: "azure_welcome",
        title: "Wisdom Through Action",
        description: "Scholar Lyra seeks help gathering knowledge.",
        giver: "scholar_lyra",
        faction: Faction.AZURE_ORDER,
        objectives: ["Collect 3 Ancient Scrolls", "Return to Scholar Lyra"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.AZURE_ORDER, amount: 25 },
            { faction: Faction.CRIMSON_GUARD, amount: -10 }
        ],
        nextQuests: ["azure_peace"],
        isActive: false,
        isCompleted: false
    },
    "azure_peace": {
        id: "azure_peace",
        title: "Diplomatic Mission",
        description: "Broker peace between Azure and Shadow factions.",
        giver: "scholar_lyra",
        faction: Faction.AZURE_ORDER,
        objectives: ["Speak with Shadow Emissary", "Deliver peace treaty"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.AZURE_ORDER, amount: 30 },
            { faction: Faction.SHADOW_COVENANT, amount: 20 }
        ],
        nextQuests: ["azure_finale"],
        isActive: false,
        isCompleted: false
    },
    "azure_finale": {
        id: "azure_finale",
        title: "Unity or Nothing",
        description: "Defend the peace summit from Crimson attackers.",
        giver: "scholar_lyra",
        faction: Faction.AZURE_ORDER,
        objectives: ["Survive 3 waves", "Protect the delegates"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.AZURE_ORDER, amount: 50 },
            { faction: Faction.SHADOW_COVENANT, amount: 30 }
        ],
        isActive: false,
        isCompleted: false
    },

    // === SHADOW COVENANT QUESTLINE ===
    "shadow_welcome": {
        id: "shadow_welcome",
        title: "Shadows and Secrets",
        description: "The Whisper Master needs information gathered.",
        giver: "whisper_master",
        faction: Faction.SHADOW_COVENANT,
        objectives: ["Spy on Crimson camp", "Spy on Azure library"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.SHADOW_COVENANT, amount: 25 }
        ],
        nextQuests: ["shadow_betrayal"],
        isActive: false,
        isCompleted: false
    },
    "shadow_betrayal": {
        id: "shadow_betrayal",
        title: "The Double Agent",
        description: "Plant false information with both factions.",
        giver: "whisper_master",
        faction: Faction.SHADOW_COVENANT,
        objectives: ["Deceive Crimson Guard", "Deceive Azure Order"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.SHADOW_COVENANT, amount: 40 },
            { faction: Faction.CRIMSON_GUARD, amount: -30 },
            { faction: Faction.AZURE_ORDER, amount: -30 }
        ],
        nextQuests: ["shadow_finale"],
        isActive: false,
        isCompleted: false
    },
    "shadow_finale": {
        id: "shadow_finale",
        title: "From the Shadows",
        description: "Seize power while the other factions fight.",
        giver: "whisper_master",
        faction: Faction.SHADOW_COVENANT,
        objectives: ["Assassinate both leaders", "Claim the throne"],
        completedObjectives: [false, false],
        reputationReward: [
            { faction: Faction.SHADOW_COVENANT, amount: 60 }
        ],
        isActive: false,
        isCompleted: false
    },

    // === NEUTRAL/DISCOVERY QUESTS ===
    "explore_ruins": {
        id: "explore_ruins",
        title: "Ancient Mysteries",
        description: "Explore the old ruins scattered across the realm.",
        giver: "wanderer",
        faction: Faction.NEUTRAL,
        objectives: ["Find 5 Ancient Artifacts"],
        completedObjectives: [false],
        reputationReward: [],
        isActive: false,
        isCompleted: false
    }
};

// --- Game State ---
class GameState {
    playerId: string | null = null;
    isGameActive = false;
    inventory: Record<string, number> = {};
    activeQuests: string[] = [];
    enemyKills: Record<string, number> = {
        crimson: 0,
        azure: 0,
        shadow: 0
    };
    collectablesFound = 0;
    isInventoryOpen = false;
    lastInventoryToggleTime = 0;
    
    // Stats
    health = 100;
    maxHealth = 100;
    ammo = 30;
    maxAmmo = 30;

    // Dialogue
    dialogue: DialogueState = {
        isOpen: false,
        npcName: "",
        text: "",
        options: [],
        selectedIndex: 0
    };

    private uiDirty = true;

    requestRedraw() {
        this.uiDirty = true;
    }

    setHealth(value: number) {
        if (this.health !== value) {
            this.health = value;
            this.uiDirty = true;
        }
    }

    setAmmo(value: number) {
        if (this.ammo !== value) {
            this.ammo = value;
            this.uiDirty = true;
        }
    }

    update() {
        if (this.uiDirty) {
            this.renderUI();
            this.uiDirty = false;
        }
    }

    renderUI() {
        if (!this.isGameActive) return;
        
        addon.UI.clear();

        if (this.isInventoryOpen) {
            this.renderInventory();
            return;
        }

        const [width, height] = Entropy.Window.getSize();
        
        // Render HUD via reusable system
        fpsUI.renderHealthBar(this.health, this.maxHealth);
        fpsUI.renderAmmo(this.ammo, this.maxAmmo);
        fpsUI.renderCrosshair(width, height); 
        
        if (this.dialogue.isOpen) {
            fpsUI.renderDialogue(this.dialogue, width, height);
        }
    }
    
    addItem(itemId: string, quantity: number = 1) {
        this.inventory[itemId] = (this.inventory[itemId] || 0) + quantity;
        addon.Inventory.addItem(this.playerId!, itemId, quantity);
        Entropy.println(`[Inventory] +${quantity} ${itemId}`);
        if (this.isInventoryOpen) this.requestRedraw();
    }
    
    hasItem(itemId: string, quantity: number = 1): boolean {
        return (this.inventory[itemId] || 0) >= quantity;
    }

    toggleInventory() {
        const now = Date.now();
        if (now - this.lastInventoryToggleTime < 200) return;
        this.lastInventoryToggleTime = now;

        this.isInventoryOpen = !this.isInventoryOpen;
        this.requestRedraw();
    }

    renderInventory() {
        // addon.UI.clear(); // Handled by renderUI
        
        // const width = 1920; 
        // const height = 1080;
        const bgWidth = 800;
        const bgHeight = 600;
        // const x = (width - bgWidth) / 2;
        // const y = (height - bgHeight) / 2;
        const x = 50;
        const y = 50;

        // Background
        addon.UI.drawRect({
            position: [x, y],
            size: [bgWidth, bgHeight],
            color: [0.1, 0.1, 0.1, 0.9],
            strokeThickness: 2,
            strokeColor: [0.8, 0.8, 0.8, 1],
            layer: 200
        });

        // Title
        addon.UI.drawText({
            text: "INVENTORY",
            position: [x + 50, y + 30],
            dimensions: [300, 50],
            fontSize: 48,
            color: [1, 1, 1, 1],
            layer: 201
        });

        // Items
        let i = 0;
        for (const [itemId, quantity] of Object.entries(this.inventory)) {
            addon.UI.drawText({
                text: `${itemId}: ${quantity}`,
                position: [x + 60, y + 100 + (i * 40)],
                dimensions: [400, 30],
                fontSize: 24,
                color: [0.8, 0.8, 0.8, 1],
                layer: 201
            });
            i++;
        }

        if (Object.keys(this.inventory).length === 0) {
            addon.UI.drawText({
                text: "Empty",
                position: [x + 60, y + 100],
                dimensions: [400, 30],
                fontSize: 24,
                color: [0.5, 0.5, 0.5, 1],
                layer: 201
            });
        }
    }
    
    updateReputation(faction: Faction, amount: number) {
        factions[faction].reputation = Math.max(-100, Math.min(100, 
            factions[faction].reputation + amount));
        Entropy.println(`[Reputation] ${factions[faction].name}: ${factions[faction].reputation > 0 ? '+' : ''}${amount} (Total: ${factions[faction].reputation})`);
    }
    
    startQuest(questId: string) {
        const quest = quests[questId];
        if (!quest || quest.isActive) return;
        
        quest.isActive = true;
        this.activeQuests.push(questId);
        addon.Quest.create(questId, {
            title: quest.title,
            objectives: quest.objectives
        });
        Entropy.println(`[Quest Started] ${quest.title}`);
    }
    
    completeObjective(questId: string, objectiveIndex: number) {
        const quest = quests[questId];
        if (!quest || !quest.isActive || quest.completedObjectives[objectiveIndex]) return;
        
        quest.completedObjectives[objectiveIndex] = true;
        addon.Quest.updateObjective(questId, objectiveIndex, true);
        Entropy.println(`[Objective Complete] ${quest.objectives[objectiveIndex]}`);
        
        // Check if quest is fully complete
        if (quest.completedObjectives.every(c => c)) {
            this.completeQuest(questId);
        }
    }
    
    completeQuest(questId: string) {
        const quest = quests[questId];
        if (!quest || quest.isCompleted) return;
        
        quest.isCompleted = true;
        quest.isActive = false;
        
        // Apply reputation rewards
        quest.reputationReward.forEach(({ faction, amount }) => {
            this.updateReputation(faction, amount);
        });
        
        Entropy.println(`[Quest Complete] ${quest.title}! 🎉`);
        
        // Unlock next quests
        if (quest.nextQuests) {
            quest.nextQuests.forEach(nextQuestId => {
                Entropy.println(`[New Quest Available] ${quests[nextQuestId].title}`);
            });
        }
    }
    
    save() {
        addon.GameState.save("fractured_realm_save", {
            inventory: this.inventory,
            activeQuests: this.activeQuests,
            quests: quests,
            factions: factions,
            enemyKills: this.enemyKills,
            collectablesFound: this.collectablesFound
        });
        Entropy.println("[Game Saved]");
    }
    
    load() {
        const data = addon.GameState.load("fractured_realm_save");
        if (data) {
            this.inventory = data.inventory || {};
            this.activeQuests = data.activeQuests || [];
            Object.assign(quests, data.quests || {});
            Object.assign(factions, data.factions || {});
            this.enemyKills = data.enemyKills || { crimson: 0, azure: 0, shadow: 0 };
            this.collectablesFound = data.collectablesFound || 0;
            Entropy.println("[Game Loaded]");
        }
    }
}

const gameState = new GameState();

// --- NPC Behaviors ---

// const doWander = (entity: Entity, system: any, state: any) => {
//     if (entity.isDead) return state;

//     // Entropy.println("crimson soldier update. entity: " + JSON.stringify(entity));
    
//     const [playerPos] = Entropy.Camera.getTransform();
//     const dx = playerPos[0] - entity.position[0];
//     const dz = playerPos[2] - entity.position[2];
//     const dist = Math.sqrt(dx * dx + dz * dz);
    
//     // Initialize wander state
//     if (!state.wanderTarget || state.waitTime > 0) {
//         state.waitTime = state.waitTime || 0;
//         if (state.waitTime > 0) {
//             state.waitTime--;
//             Entropy.Entity.playAnimation(entity.id, "Idle");
//             worldManager.npcAnimations[entity.id] = "Idle";
//             return state;
//         }
        
//         // Pick a random point in territory
//         const territory = factions[Faction.CRIMSON_GUARD].territory;
//         const angle = Math.random() * Math.PI * 2;
//         const r = Math.random() * territory.radius;
//         state.wanderTarget = [
//             territory.x + Math.cos(angle) * r,
//             0,
//             territory.z + Math.sin(angle) * r
//         ];
//     }

//     // Wander behavior
//     const wdx = state.wanderTarget[0] - entity.position[0];
//     const wdz = state.wanderTarget[2] - entity.position[2];
//     const wdist = Math.sqrt(wdx * wdx + wdz * wdz);

//     // Entropy.println("DO WANDER: " + JSON.stringify(state.wanderTarget) + " " + JSON.stringify(entity.position) + " " + wdist);
    
//     if (wdist > 1.0) {
//         const speed = 6.5;
//         Entropy.Entity.setXZVelocity(entity.id, [
//             (wdx / wdist) * speed, (wdz / wdist) * speed
//         ]);
//         Entropy.Entity.playAnimation(entity.id, "Walking");
//         worldManager.npcAnimations[entity.id] = "Walk";
//     } else {
//         state.wanderTarget = null;
//         state.waitTime = 60 + Math.random() * 120; // Wait 1-3 seconds
//         Entropy.Entity.playAnimation(entity.id, "Idle");
//         worldManager.npcAnimations[entity.id] = "Idle";
//     }
    
    
//     return state;
// };

const npcWanderStates = new Map();

const doWander = (entity: Entity, system: any, state: any) => {
    if (entity.isDead) return state;

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
        
        if (rep < -30) {
            dialogue.show("You dare approach me, traitor? Leave before I have you executed!");
            dialogue.add_option("Leave", "exit");
        } else if (!quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted) {
            dialogue.show("Welcome, warrior. The Crimson Guard values strength. Prove yourself worthy.");
            dialogue.add_option("How can I prove myself?", "quest_offer");
            dialogue.add_option("Maybe later", "exit");
        } else if (quests["crimson_welcome"].isActive && !quests["crimson_welcome"].isCompleted) {
            const killed = gameState.enemyKills.azure >= 5;
            const hasInsignias = gameState.hasItem("azure_insignia", 5);
            
            if (killed && hasInsignias) {
                dialogue.show("Impressive work. You've proven your strength. The Crimson Guard welcomes you.");
                gameState.completeQuest("crimson_welcome");
                dialogue.add_option("What's next?", "quest_artifact");
            } else {
                dialogue.show(`Progress: ${gameState.enemyKills.azure}/5 Azure defeated, ${gameState.inventory["azure_insignia"] || 0}/5 insignias collected.`);
                dialogue.add_option("I'll continue", "exit");
            }
        } else if (quests["crimson_artifact"].isActive && !quests["crimson_artifact"].isCompleted) {
            if (gameState.hasItem("crimson_relic")) {
                dialogue.show("You found it! The ancient Crimson Relic. With this, we can turn the tide of war.");
                gameState.completeQuest("crimson_artifact");
                dialogue.add_option("For the Guard!", "exit");
            } else {
                dialogue.show("The relic lies in Shadow territory. Be careful, they don't take kindly to intruders.");
                dialogue.add_option("I'm on it", "exit");
            }
        } else {
            dialogue.show("You've done well, warrior. Rest and prepare for what's to come.");
            dialogue.add_option("Farewell", "exit");
        }
        
        if (dialogue.get_node() === "quest_offer") {
            dialogue.show("Defeat five Azure Order soldiers and bring me their insignias. Show no mercy.");
            dialogue.add_option("I accept", "quest_accept");
            dialogue.add_option("That's too much", "exit");
        }
        
        if (dialogue.get_node() === "quest_accept") {
            gameState.startQuest("crimson_welcome");
            dialogue.close();
        }
        
        if (dialogue.get_node() === "quest_artifact") {
            gameState.startQuest("crimson_artifact");
            dialogue.close();
        }
    }
});

Entropy.Behavior.register("quest_giver_lyra", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.AZURE_ORDER].reputation;

        Entropy.println("Interaction with quest giver");
        
        if (rep < -30) {
            dialogue.show("Your violent reputation precedes you. The Azure Order seeks peace, not chaos.");
            dialogue.add_option("I understand", "exit");
        } else if (!quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted) {
            dialogue.show("Greetings, traveler. The Azure Order seeks knowledge and wisdom. Will you aid our cause?");
            dialogue.add_option("Tell me more", "quest_offer");
            dialogue.add_option("Not interested", "exit");
        } else if (quests["azure_welcome"].isActive && !quests["azure_welcome"].isCompleted) {
            const scrolls = gameState.inventory["ancient_scroll"] || 0;
            if (scrolls >= 3) {
                dialogue.show("Wonderful! These scrolls contain knowledge lost for centuries. You have my gratitude.");
                gameState.completeQuest("azure_welcome");
                dialogue.add_option("What now?", "quest_peace");
            } else {
                dialogue.show(`You've found ${scrolls}/3 Ancient Scrolls. They're scattered across the realm.`);
                dialogue.add_option("I'll keep searching", "exit");
            }
        } else {
            dialogue.show("Thank you for your help. The path to wisdom is long, but you walk it well.");
            dialogue.add_option("Farewell", "exit");
        }
        
        if (dialogue.get_node() === "quest_offer") {
            dialogue.show("Ancient scrolls are scattered across the realm. Bring me three, and I'll share our knowledge.");
            dialogue.add_option("I'll find them", "quest_accept");
            dialogue.add_option("Too tedious", "exit");
        }
        
        if (dialogue.get_node() === "quest_accept") {
            gameState.startQuest("azure_welcome");
            dialogue.close();
        }
        
        if (dialogue.get_node() === "quest_peace") {
            gameState.startQuest("azure_peace");
            dialogue.close();
        }
    }
});

Entropy.Behavior.register("quest_giver_whisper", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.SHADOW_COVENANT].reputation;

        Entropy.println("Interaction with quest giver");
        
        if (!quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted) {
            dialogue.show("*A hooded figure emerges from darkness* Information is power. Are you clever enough to serve us?");
            dialogue.add_option("I'm interested", "quest_offer");
            dialogue.add_option("This feels wrong", "exit");
        } else if (quests["shadow_welcome"].isActive && !quests["shadow_welcome"].isCompleted) {
            const crimsonSpied = gameState.hasItem("crimson_intel");
            const azureSpied = gameState.hasItem("azure_intel");
            
            if (crimsonSpied && azureSpied) {
                dialogue.show("Excellent work. You move like a shadow. Perhaps you have a future with us.");
                gameState.completeQuest("shadow_welcome");
                dialogue.add_option("What's the plan?", "quest_betrayal");
            } else {
                dialogue.show("Gather intelligence from both camps. Move unseen, strike unheard.");
                dialogue.add_option("Understood", "exit");
            }
        } else {
            dialogue.show("The shadows embrace those who serve them well. Continue your work.");
            dialogue.add_option("Farewell", "exit");
        }
        
        if (dialogue.get_node() === "quest_offer") {
            dialogue.show("Spy on the Crimson and Azure factions. Learn their secrets. Can you be invisible?");
            dialogue.add_option("Yes", "quest_accept");
            dialogue.add_option("No", "exit");
        }
        
        if (dialogue.get_node() === "quest_accept") {
            gameState.startQuest("shadow_welcome");
            dialogue.close();
        }
        
        if (dialogue.get_node() === "quest_betrayal") {
            gameState.startQuest("shadow_betrayal");
            dialogue.close();
        }
    }
});

Entropy.Behavior.register("neutral_wanderer", {
    onUpdate: doWander,
    onInteract: (entity, dialogue) => {
        Entropy.println("Interaction with quest giver");

        dialogue.show("I've traveled far and wide. The old ruins hold many secrets, if you're brave enough to seek them.");
        dialogue.add_option("Tell me about the ruins", "ruins_info");
        dialogue.add_option("Farewell", "exit");
        
        if (dialogue.get_node() === "ruins_info") {
            if (!quests["explore_ruins"].isActive) {
                dialogue.show("Five ancient artifacts remain hidden. Find them all, and you'll unlock something... special.");
                dialogue.add_option("I'll search for them", "quest_accept");
                dialogue.add_option("Maybe another time", "exit");
            } else {
                dialogue.show(`You've found ${gameState.collectablesFound}/5 artifacts. Keep exploring!`);
                dialogue.add_option("Thanks", "exit");
            }
        }
        
        if (dialogue.get_node() === "quest_accept") {
            gameState.startQuest("explore_ruins");
            dialogue.close();
        }
    }
});



// --- Enemy Behaviors ---

Entropy.Behavior.register("crimson_soldier", {
    onUpdate: (entity, system, _s) => {
        if (entity.isDead) return _s;

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
        addon.Collectable.create({
            position: [entity.position[0], y + 1, entity.position[2]],
            type: "quest_item",
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
        addon.Collectable.create({
            position: [entity.position[0], y + 1, entity.position[2]],
            type: "quest_item",
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

// --- World Manager ---

class WorldManager {    
    public playerJointBufferId: string = "";
    public playerHumanoid: ProceduralHumanoid | null = null;
    public npcJointBufferId: Record<string, string> = {};
    public npcHumanoids: Record<string, ProceduralHumanoid> = {};
    public npcAnimations: Record<string, string> = {};

    initialize() {
        this.spawnPlayer();
        this.populateWorld();

        environmentDecorator.decorateWorld();
    }
    
    spawnPlayer() {
        const spawnX = 0;
        const spawnZ = 0;
        const y = addon.Landscape.getHeightAt(spawnX, spawnZ);
        
        gameState.playerId = Entropy.generateUUID();
        
        // Try to use the humanoid character from CharacterCreator addon
        const visual = addon.getVisualProvider("humanoid_character");
        
        if (visual) {
            this.playerJointBufferId = addon.Buffer.create({
                size: 16384,
                usage: "Uniform"
            });
            this.playerHumanoid = new ProceduralHumanoid();

            Entropy.println("--------------------------- FPS RPG PLAYER MESH" + visual.vertexData.length + " " +  visual.indexData.length + " " +  visual.pipelineId);

            addon.Model.createMesh({
                id: gameState.playerId,
                position: [0, y + 2, 0],
                scale: [2, 2, 2],
                vertexData: visual.vertexData,
                indexData: visual.indexData,
                pipelineId: visual.pipelineId,
                bindings: [
                    { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.playerJointBufferId! } } }
                ],
                player: {
                    modelId: gameState.playerId
                }
            });
        } else {
            addon.Model.load({
                path: "Friend1b.glb",
                id: gameState.playerId,
                position: [spawnX, y + 2, spawnZ],
                scale: [1, 1, 1],
                physics: {
                    bodyType: "dynamic",
                    colliderShape: "capsule",
                    mass: 80
                },
                player: {
                    modelId: gameState.playerId
                }
            });
        }
        
        Entropy.println("[Player] Spawned at center");
    }
    
    populateWorld() {
        // Spawn faction leaders (quest givers)
        this.spawnNPC("Commander Vex", Entropy.generateUUID(), "Enemy1b.glb", 
            factions[Faction.CRIMSON_GUARD].territory, "quest_giver_vex");
        
        this.spawnNPC("Scholar Lyra", Entropy.generateUUID(), "Player1b.glb",
            factions[Faction.AZURE_ORDER].territory, "quest_giver_lyra");
        
        this.spawnNPC("Whisper Master", Entropy.generateUUID(), "Enemy1b.glb",
            factions[Faction.SHADOW_COVENANT].territory, "quest_giver_whisper");
        
        this.spawnNPC("The Wanderer", Entropy.generateUUID(), "Friend1b.glb",
            { x: 0, z: 0, radius: 5 }, "neutral_wanderer");
        
        // Spawn faction soldiers
        this.spawnFactionGuards(Faction.CRIMSON_GUARD, "Enemy1b.glb", "crimson_soldier", 25);
        this.spawnFactionGuards(Faction.AZURE_ORDER, "Friend1b.glb", "azure_soldier", 25);
        this.spawnFactionGuards(Faction.SHADOW_COVENANT, "Enemy1b.glb", "shadow_assassin", 20);
        
        // Spawn collectables
        this.spawnCollectables();
        
        Entropy.println("[World] Populated with NPCs and items");
    }
    
    spawnNPC(name: string, id: string, model: string, territory: { x: number, z: number, radius: number }, behaviorId: string) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * territory.radius * 0.3; // Keep near center
        const x = territory.x + Math.cos(angle) * dist;
        const z = territory.z + Math.sin(angle) * dist;
        const y = addon.Landscape.getHeightAt(x, z);
        
        const visual = addon.getVisualProvider("humanoid_character");

        if (visual) {
            this.npcJointBufferId[id] = addon.Buffer.create({
                size: 16384,
                usage: "Uniform"
            });
            this.npcHumanoids[id] = new ProceduralHumanoid();
            this.npcAnimations[id] = "Idle";

            Entropy.println("--------------------------- FPS RPG NPC MESH" + visual.vertexData.length + " " +  visual.indexData.length + " " +  visual.pipelineId);


            addon.Model.createMesh({
                id: id,
                position: [x, y + 1, z],
                scale: [2, 2, 2],
                vertexData: visual.vertexData,
                indexData: visual.indexData,
                pipelineId: visual.pipelineId,
                bindings: [
                    { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.npcJointBufferId[id]! } } }
                ],
                behaviorId: behaviorId,
                isNpc: true,
                // physics: {
                //     bodyType: "dynamic",
                //     colliderShape: "capsule",
                //     mass: 100
                // }
            });
        } else {
            addon.Model.load({
                path: model,
                id: id,
                position: [x, y + 1, z],
                behaviorId: behaviorId,
                isNpc: true,
                physics: {
                    bodyType: "dynamic",
                    colliderShape: "capsule",
                    mass: 100
                }
            });
        }
    }
    
    spawnFactionGuards(faction: Faction, model: string, behaviorId: string, count: number) {
        const territory = factions[faction].territory;
        const visual = addon.getVisualProvider("humanoid_character");
        
        for (let i = 0; i < count; i++) {
            let id = Entropy.generateUUID();

            const angle = (i / count) * Math.PI * 2;
            const dist = territory.radius * (0.5 + Math.random() * 0.4);
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            if (visual) {
                this.npcJointBufferId[id] = addon.Buffer.create({
                    size: 16384,
                    usage: "Uniform"
                });
                this.npcHumanoids[id] = new ProceduralHumanoid();
                this.npcAnimations[id] = "Idle";

                addon.Model.createMesh({
                    id,
                    scale: [2, 2, 2],
                    position: [x, y + 1, z],
                    vertexData: visual.vertexData,
                    indexData: visual.indexData,
                    pipelineId: visual.pipelineId,
                    bindings: [
                        { group: 2, binding: 0, resource: { type: "Buffer", value: { id: this.npcJointBufferId[id]! } } }
                    ],
                    behaviorId: behaviorId,
                    isNpc: true,
                    // physics: {
                    //     bodyType: "dynamic",
                    //     colliderShape: "capsule",
                    //     mass: 100
                    // }
                });
            } else {
                addon.Model.load({
                    path: model,
                    position: [x, y + 1, z],
                    behaviorId: behaviorId,
                    isNpc: true,
                    physics: {
                        bodyType: "dynamic",
                        colliderShape: "capsule"
                    }
                });
            }
        }
    }
    
    spawnCollectables() {
        // Ancient scrolls for Azure quest
            let globalSettings = Entropy.Composer?.getGlobalSettings();

            let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;

        for (let i = 0; i < 3; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.8;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.8;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Collectable.create({
                modelPath: "Barrel1large.glb",
                position: [x, y + 1, z],
                type: "quest_item",
                questId: "ancient_scroll",
                onCollect: () => {
                    gameState.addItem("ancient_scroll", 1);
                    
                    if (quests["azure_welcome"].isActive && gameState.hasItem("ancient_scroll", 3)) {
                        gameState.completeObjective("azure_welcome", 0);
                    }
                }
            });
        }
        
        // Crimson Relic in Shadow territory
        const shadowTerr = factions[Faction.SHADOW_COVENANT].territory;
        const relicY = addon.Landscape.getHeightAt(shadowTerr.x, shadowTerr.z);
        addon.Collectable.create({
            modelPath: "Barrel1medium.glb",
            position: [shadowTerr.x, relicY + 1, shadowTerr.z],
            type: "quest_item",
            questId: "crimson_relic",
            onCollect: () => {
                gameState.addItem("crimson_relic", 1);
                
                if (quests["crimson_artifact"].isActive) {
                    gameState.completeObjective("crimson_artifact", 0);
                }
            }
        });
        
        // Ancient artifacts for exploration quest
        for (let i = 0; i < 5; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Collectable.create({
                modelPath: "Barrel1small.glb",
                position: [x, y + 1, z],
                type: "quest_item",
                questId: "ancient_artifact",
                onCollect: () => {
                    gameState.collectablesFound++;
                    gameState.addItem("ancient_artifact", 1);
                    
                    if (quests["explore_ruins"].isActive && gameState.collectablesFound >= 5) {
                        gameState.completeObjective("explore_ruins", 0);
                        gameState.completeQuest("explore_ruins");
                    }
                }
            });
        }
        
        // Health pickups scattered around
        for (let i = 0; i < 25; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Collectable.create({
                modelPath: "Barrel1small.glb",
                position: [x, y + 0.5, z],
                type: "health",
                value: 25,
                onCollect: (playerId) => {
                    Entropy.Entity.setStats(playerId, { 
                        health: 100,
                        stamina: 100
                    });
                    Entropy.println("[Health] +25 HP");
                }
            });
        }
    }
    
    cleanup() {
        addon.Model.clearMeshes();
    }
}

const worldManager = new WorldManager();

// --- Environmental Decoration Functions ---

class EnvironmentDecorator {
    private housePipelineId: string | null = null;
    private houseTextures: Record<string, string> = {};

    constructor() {
        this.setupHousePipeline();
    }

    private setupHousePipeline() {
        this.housePipelineId = Entropy.Pipeline.create({
            name: "RPG_House_Pipeline",
            pbr: true,
            layout: "mesh",
            vertexShader: HOUSE_SHADER,
            fragmentShader: HOUSE_SHADER,
            extraBindGroups: [
                { entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
                    { binding: 1, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 2, visibility: ["Fragment"], resourceType: "Sampler" },
                    { binding: 3, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 4, visibility: ["Fragment"], resourceType: "Texture" }
                ]}
            ]
        });
    }

    private getBindingsForSlot(slot: string, compId: string | null): any[] {
        if (!compId || !Entropy.Composer) return [];
    
        const texAddonName = "PBR Texture Designer Pro";
        const components = Entropy.Composer.getComponents(texAddonName) || {};
        const comp = components[compId];
        if (!comp) return [];
    
        // Ensure textures are generated
        const generator = (Entropy.Composer as any).getTextureGenerator?.(texAddonName);
        let designerTextures = globalThis.lastPBRDesignerTextures ? globalThis.lastPBRDesignerTextures[compId] : null;
    
        if (!designerTextures && generator) {
            generator(compId, comp.params, 512);
            designerTextures = globalThis.lastPBRDesignerTextures ? globalThis.lastPBRDesignerTextures[compId] : null;
        }
    
        if (!designerTextures) return [];
    
        const params = comp.params;
        return [
            { group: 2, binding: 0, resource: { type: "Uniform", value: { data: [params.seed, 0, 0, 0, ...params.baseColor, params.roughness, params.metallic, params.aoStrength, params.normalStrength] } } },
            { group: 2, binding: 1, resource: { type: "Texture", value: {id: designerTextures.diffId} } },
            { group: 2, binding: 2, resource: { type: "Sampler" } },
            { group: 2, binding: 3, resource: { type: "Texture", value: {id: designerTextures.norId} } },
            { group: 2, binding: 4, resource: { type: "Texture", value: {id: designerTextures.armId} } }
        ];
    }

    private setupVillageTextures() {
        if (!Entropy.Composer) return;

        const texAddonName = "PBR Texture Designer Pro";
        
        // Wall Texture (Brick)
        const wallId = "village_wall_brick";
        Entropy.Composer.registerComponent(texAddonName, wallId, "Village Wall Brick", {
            seed: 42,
            patternType: "brick",
            patternScale: 1.5,
            baseColor: [0.6, 0.3, 0.2, 1.0],
            secondaryColor: [0.4, 0.4, 0.4, 1.0],
            tertiaryColor: [0.7, 0.4, 0.3, 1.0],
            roughness: 0.9,
            metallic: 0.0,
            aoStrength: 1.0,
            normalStrength: 12.0,
            brickWidth: 64,
            brickHeight: 32,
            mortarWidth: 4,
            brickVariation: 0.2
        });

        // Roof Texture (Scales/Shingles)
        const roofId = "village_roof_shingles";
        Entropy.Composer.registerComponent(texAddonName, roofId, "Village Roof Shingles", {
            seed: 123,
            patternType: "scales",
            patternScale: 2.0,
            baseColor: [0.2, 0.2, 0.25, 1.0],
            secondaryColor: [0.1, 0.1, 0.15, 1.0],
            tertiaryColor: [0.3, 0.3, 0.4, 1.0],
            roughness: 0.7,
            metallic: 0.1,
            aoStrength: 1.0,
            normalStrength: 15.0,
            scaleSize: 40.0,
            scaleOverlap: 0.2,
            scaleRoughness: 0.4
        });

        // Floor Texture (Wood)
        const floorId = "village_floor_wood";
        Entropy.Composer.registerComponent(texAddonName, floorId, "Village Floor Wood", {
            seed: 888,
            patternType: "wood_grain",
            patternScale: 1.0,
            baseColor: [0.4, 0.25, 0.15, 1.0],
            secondaryColor: [0.3, 0.15, 0.1, 1.0],
            tertiaryColor: [0.5, 0.35, 0.25, 1.0],
            roughness: 0.6,
            metallic: 0.0,
            aoStrength: 0.8,
            normalStrength: 5.0,
            woodRingFrequency: 0.4,
            woodGrainTurbulence: 2.5,
            woodGrainStretch: 4.0
        });

        this.houseTextures = {
            walls: wallId,
            roof: roofId,
            floor: floorId
        };
    }

    /**
     * Spawn a cluster of procedural houses
     */
    spawnHouseCluster(center: {x: number, z: number}, radius: number, count: number) {
        if (Object.keys(this.houseTextures).length === 0) {
            this.setupVillageTextures();
        }

        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * radius;
            const x = center.x + Math.cos(angle) * dist;
            const z = center.z + Math.sin(angle) * dist;
            
            this.createHouseAt(x, z);
        }
    }

    private createHouseAt(x: number, z: number) {
        const y = addon.Landscape.getHeightAt(x, z);
        const rotation = Math.random() * Math.PI * 2;
        const seed = Math.floor(Math.random() * 100000);
        
        const params: HouseParams = {
            width: 8 + Math.random() * 6,
            depth: 8 + Math.random() * 6,
            stories: Math.random() > 0.7 ? 2 : 1,
            style: "traditional",
            minRoomSize: 2.5,
            maxSubdivisions: 3 + Math.floor(Math.random() * 2),
            wallThickness: 0.15,
            floorHeight: 2.7,
            windowHeight: 1.2,
            windowWidth: 0.8,
            doorWidth: 0.9,
            doorHeight: 2.1,
            addBasement: false,
            addAttic: false,
            addPorch: false,
            seed: seed,
            textureLayers: {
                Walls: this.houseTextures.walls,
                Roof: this.houseTextures.roof,
                Floor: this.houseTextures.floor
            }
        };

        const floorPlan = new FloorPlan(params.seed);
        floorPlan.generate(params);

        const wallMesh = new MeshBuilder();
        const floorMesh = new MeshBuilder();
        const roofMesh = new MeshBuilder();
        const detailMesh = new MeshBuilder();

        for (let story = 0; story < params.stories; story++) {
            const baseY = story * params.floorHeight;
            for (const room of floorPlan.rooms) {
                floorMesh.merge(HouseGeometry.generateFloor(room.bounds, baseY));
                if (story < params.stories - 1) {
                    floorMesh.merge(HouseGeometry.generateCeiling(room.bounds, baseY + params.floorHeight));
                }
            }
            for (const room of floorPlan.rooms) {
                const b = room.bounds;
                const walls = [
                    { start: vec2(b.x, b.y), end: vec2(b.right, b.y) },
                    { start: vec2(b.right, b.y), end: vec2(b.right, b.bottom) },
                    { start: vec2(b.right, b.bottom), end: vec2(b.x, b.bottom) },
                    { start: vec2(b.x, b.bottom), end: vec2(b.x, b.y) }
                ];
                for (const wall of walls) {
                    wallMesh.merge(HouseGeometry.generateWall(
                        vec3(wall.start.x, baseY, wall.start.y),
                        vec3(wall.end.x, baseY, wall.end.y),
                        params.floorHeight,
                        params.wallThickness
                    ));
                }
            }
            for (const doorway of floorPlan.doorways) {
                detailMesh.merge(HouseGeometry.generateDoorFrame(doorway.position, doorway.axis, doorway.width, params.doorHeight, baseY, params.wallThickness));
            }
            for (const window of floorPlan.windows) {
                detailMesh.merge(HouseGeometry.generateWindow(window.position, window.wallNormal, window.width, window.height, baseY, params.wallThickness));
            }
            if (params.stories > 1 && story < params.stories - 1 && floorPlan.stairs) {
                detailMesh.merge(HouseGeometry.generateStaircase(floorPlan.stairs.position, floorPlan.stairs.direction, floorPlan.stairs.width, params.floorHeight));
            }
        }

        const topY = params.stories * params.floorHeight;
        const roofStyle = params.style === "modern" ? "flat" : "gable";
        roofMesh.merge(HouseGeometry.generateRoof(new Rect(0, 0, params.width, params.depth), topY, roofStyle === "flat" ? 0.3 : 2.0, roofStyle));

        const basePos: [number, number, number] = [x - params.width/2, y, z - params.depth/2];
        const pbrPipeline = this.housePipelineId || "default";

        // Create the meshes
        const wallId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: wallId,
            position: basePos,
            vertexData: wallMesh.vertices,
            indexData: wallMesh.indices,
            pipelineId: pbrPipeline,
            bindings: this.getBindingsForSlot("Walls", this.houseTextures.walls),
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });

        const floorId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: floorId,
            position: basePos,
            vertexData: floorMesh.vertices,
            indexData: floorMesh.indices,
            pipelineId: pbrPipeline,
            bindings: this.getBindingsForSlot("Floor", this.houseTextures.floor),
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });

        const roofId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: roofId,
            position: basePos,
            vertexData: roofMesh.vertices,
            indexData: roofMesh.indices,
            pipelineId: pbrPipeline,
            bindings: this.getBindingsForSlot("Roof", this.houseTextures.roof),
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });

        const detailId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: detailId,
            position: basePos,
            vertexData: detailMesh.vertices,
            indexData: detailMesh.indices,
            pipelineId: "default",
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });
    }
    
    /**
     * Spawn trees around the map
     */
    spawnTrees(count: number = 50) {
        let globalSettings = Entropy.Composer?.getGlobalSettings();
        let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;
        
        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const y = addon.Landscape.getHeightAt(x, z);
            const scale = 3.0 + Math.random() * 0.8; // Vary tree sizes
            
            addon.Model.load({
                path: "Tree1b.glb",
                position: [x, y, z],
                scale: [scale, scale, scale],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "capsule"
                }
            });
        }
        Entropy.println(`[Environment] Spawned ${count} trees`);
    }
    
    /**
     * Spawn foliage patches
     */
    spawnFoliage(count: number = 100) {
        let globalSettings = Entropy.Composer?.getGlobalSettings();
        let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;
        
        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const y = addon.Landscape.getHeightAt(x, z);
            const rotation = Math.random() * Math.PI * 2;
            
            addon.Model.load({
                path: Math.random() > 0.5 ? "Foliage1.glb" : "Plant_02_Art.glb",
                position: [x, y, z],
                rotation: [0, rotation, 0],
                scale: [1.5 + Math.random() * 0.5, 1.5 + Math.random() * 0.5, 1.5 + Math.random() * 0.5]
            });
        }
        Entropy.println(`[Environment] Spawned ${count} foliage patches`);
    }
    
    /**
     * Build faction outposts with houses and structures
     */
    buildFactionOutpost(faction: Faction, houseCount: number = 3) {
        const territory = factions[faction].territory;
        const houseModels = ["House1b.glb", "House2a.glb", "House3a.glb"];
        
        for (let i = 0; i < houseCount; i++) {
            const angle = (i / houseCount) * Math.PI * 2;
            const dist = territory.radius * 0.6;
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: houseModels[i % houseModels.length],
                position: [x, y, z],
                rotation: [0, angle + Math.PI / 2, 0],
                scale: [1.2, 1.2, 1.2],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "cuboid"
                }
            });
        }
        
        Entropy.println(`[Outpost] Built ${houseCount} structures for ${factions[faction].name}`);
    }
    
    /**
     * Add towers to faction territories
     */
    buildFactionTowers(faction: Faction, towerCount: number = 4) {
        const territory = factions[faction].territory;
        const towerModels = ["Tower_Base_02_Art.glb", "Spooky_Tower_Floating_Cabin_03_Art.glb"];
        
        for (let i = 0; i < towerCount; i++) {
            const angle = (i / towerCount) * Math.PI * 2;
            const dist = territory.radius * 0.8; // Place at perimeter
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: towerModels[i % towerModels.length],
                position: [x, y, z],
                rotation: [0, angle, 0],
                scale: [1, 1, 1],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "capsule"
                }
            });
        }
        
        Entropy.println(`[Towers] Built ${towerCount} towers for ${factions[faction].name}`);
    }
    
    /**
     * Spawn decorative props across the map
     */
    spawnScatteredProps(count: number = 40) {
        let globalSettings = Entropy.Composer?.getGlobalSettings();
        let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;
        
        const props = [
            "ElectricPost02_Art.glb",
            "Iron_Structure_01_Art.glb",
            "Tank.glb",
            "013_Octogecko_Art.glb"
        ];
        
        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const y = addon.Landscape.getHeightAt(x, z);
            const rotation = Math.random() * Math.PI * 2;
            const propModel = props[Math.floor(Math.random() * props.length)];
            
            addon.Model.load({
                path: propModel,
                position: [x, y, z],
                rotation: [0, rotation, 0],
                scale: [0.8, 0.8, 0.8],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "cuboid"
                }
            });
        }
        
        Entropy.println(`[Props] Spawned ${count} decorative props`);
    }
    
    /**
     * Create a central bridge landmark
     */
    buildCentralBridge() {
        const y = addon.Landscape.getHeightAt(0, 0);
        
        addon.Model.load({
            path: "LoveDeath_Bridge_Fragment_Art.glb",
            position: [0, y + 5, 0],
            scale: [2, 2, 2],
            physics: {
                bodyType: "fixed",
                colliderShape: "cuboid"
            }
        });
        
        Entropy.println("[Landmark] Built central bridge");
    }
    
    /**
     * Add weapon racks/displays in faction areas
     */
    spawnWeaponDisplays(faction: Faction, count: number = 5) {
        const territory = factions[faction].territory;
        const swordModels = [
            "Sword1small.glb",
            "Sword1medium.glb", 
            "Sword1large.glb",
            "Sword1extralarge.glb"
        ];
        
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * territory.radius * 0.5;
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: swordModels[Math.floor(Math.random() * swordModels.length)],
                position: [x, y + 1, z],
                rotation: [Math.PI / 4, Math.random() * Math.PI * 2, 0],
                scale: [1, 1, 1]
            });
        }
        
        Entropy.println(`[Weapons] Added ${count} weapon displays to ${factions[faction].name}`);
    }
    
    /**
     * Place a dome structure (could be used as a central hub or special location)
     */
    buildDomeStructure(x: number, z: number) {
        const y = addon.Landscape.getHeightAt(x, z);
        
        addon.Model.load({
            path: "DomeKit5.glb",
            position: [x, y, z],
            scale: [1.5, 1.5, 1.5],
            physics: {
                bodyType: "fixed",
                colliderShape: "trimesh"
            }
        });
        
        Entropy.println(`[Structure] Built dome at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    }
    
    /**
     * Master function to decorate the entire world
     */
    decorateWorld() {
        // just trees during testing
        this.spawnTrees(30);
        
        // this.spawnFoliage(80);
        // this.buildCentralBridge();
        
        // // Build outposts for each faction
        // this.buildFactionOutpost(Faction.CRIMSON_GUARD, 4);
        // this.buildFactionOutpost(Faction.AZURE_ORDER, 4);
        // this.buildFactionOutpost(Faction.SHADOW_COVENANT, 3);
        
        // // Add towers
        // this.buildFactionTowers(Faction.CRIMSON_GUARD, 4);
        // this.buildFactionTowers(Faction.AZURE_ORDER, 4);
        // this.buildFactionTowers(Faction.SHADOW_COVENANT, 4);
        
        // // Add weapon displays
        // this.spawnWeaponDisplays(Faction.CRIMSON_GUARD, 6);
        // this.spawnWeaponDisplays(Faction.AZURE_ORDER, 6);
        // this.spawnWeaponDisplays(Faction.SHADOW_COVENANT, 6);
        
        // // Scatter props
        // this.spawnScatteredProps(50);
        
        // // Build a dome at neutral zone
        // this.buildDomeStructure(-440, 440);

        this.spawnHouseCluster({
            x: 250, z: 250
        }, 200, 40);
        
        Entropy.println("[World] Full decoration complete! 🌍");
    }
}

const environmentDecorator = new EnvironmentDecorator();

// --- Game Lifecycle ---

Entropy.onGameStarted(() => {
    Entropy.Composer?.enableGameComposerOverride();

    Entropy.println("=== THE FRACTURED REALM ===");

    gameState.isGameActive = true;
    // worldManager.initialize();
    
    Entropy.println("Choose your path wisely. Every action has consequences.");

    Entropy.Composer?.disableGameComposerOverride();
});

Entropy.onGameStopped(() => {
    gameState.save();
    gameState.isGameActive = false;
    worldManager.cleanup();
});

// --- Animation Update Loop ---

addon.onUpdatePlus("Game Composer", (time) => {
    Entropy.Composer?.enableGameComposerOverride();

    gameState.update();

    // Check for inventory toggle
    if (Entropy.Input.isKeyPressed("i")) {
        gameState.toggleInventory();
    }

    // --- Interaction Hooks ---
    Entropy.Input.onMouseDown((button) => {
        if (!gameState.isGameActive || gameState.isInventoryOpen) return;
        
        if (button === 0) { // Left Click - Fire
            if (gameState.ammo > 0) {
                gameState.setAmmo(gameState.ammo - 1);
                // Trigger muzzle flash/recoil logic here
            } else {
                Entropy.println("Click! Out of ammo.");
            }
        }
    });

    Entropy.Input.onKeyDown((key) => {
        if (!gameState.isGameActive) return;

        if (key === "r") { // Reload
            gameState.setAmmo(gameState.maxAmmo);
            Entropy.println("Reloading...");
        }

        if (key === "k") { // Simulation: Take Damage
            gameState.setHealth(Math.max(0, gameState.health - 10));
        }
    });

    Entropy.Input.onGamepadButton((button, pressed) => {
        if (!gameState.isGameActive || !pressed) return;

        if (button === "South") { // Jump placeholder / Interact
             // Jump logic
        }

        if (button === "RightTrigger") { // Fire
            if (gameState.ammo > 0) {
                gameState.setAmmo(gameState.ammo - 1);
            } else {
                Entropy.println("Click! Out of ammo.");
            }
        }

        if (button === "West") { // Reload (Square/X)
            gameState.setAmmo(gameState.maxAmmo);
            Entropy.println("Reloading (Gamepad)...");
        }
        
        if (button === "Start") {
            gameState.toggleInventory();
        }
    });

    // Animate player
    if (worldManager.playerHumanoid) {
        worldManager.playerHumanoid.animate(time, "Idle"); // Player idle for now
        const matrices = worldManager.playerHumanoid.getJointMatrices();
        addon.Buffer.write(worldManager.playerJointBufferId, new Float32Array(matrices));
    }

    // Entropy.println("Continue bro");

    // Animate NPCs
    for (const id in worldManager.npcHumanoids) {
        const humanoid = worldManager.npcHumanoids[id];
        const animation = worldManager.npcAnimations[id] || "Idle";
        humanoid.animate(time, animation);
        const matrices = humanoid.getJointMatrices();
        const bufferId = worldManager.npcJointBufferId[id];
        if (bufferId) {
            addon.Buffer.write(bufferId, new Float32Array(matrices));
        }
    }

    // Entropy.println("Fomosj bro");

    Entropy.Composer?.disableGameComposerOverride();
});

// --- UI ---

addon.onInit(() => {
    const windowId = addon.UI.createTab({
        title: "Fractured Realm",
        onRender: () => {
            Entropy.UI.Widget.label(windowId, { text: "⚔️ THE FRACTURED REALM", bold: true });
            Entropy.UI.Widget.separator(windowId);
            
            if (!gameState.isGameActive) {
                Entropy.UI.Widget.button(windowId, {
                    text: "🎮 Start New Game",
                    onClick: () => {
                        Entropy.setGameMode(true);
                    }
                });
                
                Entropy.UI.Widget.button(windowId, {
                    text: "📂 Load Game",
                    onClick: () => {
                        gameState.load();
                        Entropy.setGameMode(true);
                    }
                });
            } else {
                // Faction reputations
                Entropy.UI.Widget.label(windowId, { text: "=== FACTION STANDING ===", bold: true });
                Object.entries(factions).forEach(([key, faction]) => {
                    if (key !== Faction.NEUTRAL) {
                        const rep = faction.reputation;
                        const status = rep > 50 ? "Allied" : rep > 0 ? "Friendly" : rep > -30 ? "Neutral" : "Hostile";
                        Entropy.UI.Widget.label(windowId, { 
                            text: `${faction.name}: ${rep} (${status})` 
                        });
                    }
                });
                
                Entropy.UI.Widget.separator(windowId);
                
                // Active quests
                Entropy.UI.Widget.label(windowId, { text: "=== ACTIVE QUESTS ===", bold: true });
                if (gameState.activeQuests.length === 0) {
                    Entropy.UI.Widget.label(windowId, { text: "No active quests. Find quest givers!" });
                } else {
                    gameState.activeQuests.forEach(questId => {
                        const quest = quests[questId];
                        Entropy.UI.Widget.label(windowId, { text: `• ${quest.title}` });
                        quest.objectives.forEach((obj, idx) => {
                            const status = quest.completedObjectives[idx] ? "✓" : "○";
                            Entropy.UI.Widget.label(windowId, { text: `  ${status} ${obj}` });
                        });
                    });
                }
                
                Entropy.UI.Widget.separator(windowId);
                
                // Stats
                Entropy.UI.Widget.label(windowId, { text: "=== STATISTICS ===", bold: true });
                Entropy.UI.Widget.label(windowId, { 
                    text: `Artifacts Found: ${gameState.collectablesFound}/5` 
                });
                Entropy.UI.Widget.label(windowId, { 
                    text: `Enemies Defeated: ${Object.values(gameState.enemyKills).reduce((a, b) => a + b, 0)}` 
                });
                
                Entropy.UI.Widget.separator(windowId);
                
                Entropy.UI.Widget.button(windowId, {
                    text: "💾 Save Game",
                    onClick: () => gameState.save()
                });
                
                Entropy.UI.Widget.button(windowId, {
                    text: "🛑 Stop Game",
                    onClick: () => {
                        gameState.save();
                        Entropy.setGameMode(false);
                    }
                });
            }
        }
    });

    if (Entropy.Composer) {
        // Entropy.Composer.registerEditor("Hair Particles with Ornaments", renderHairUI);
        if (Entropy.Composer.registerGame) {
            Entropy.Composer.registerGame(addonInfo.name, (id: string, params: any) => {                
                worldManager.initialize();
            });
        }
    }

    Entropy.println("⚔️ THE FRACTURED REALM initialized");
});