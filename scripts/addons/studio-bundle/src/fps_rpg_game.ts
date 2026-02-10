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

// --- Game Configuration ---
const LANDSCAPE_SIZE = 4096; // Configurable
const LANDSCAPE_HEIGHT = 50;

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
        territory: { x: -60, z: -60, radius: 40 },
        reputation: 0
    },
    [Faction.AZURE_ORDER]: {
        name: "Azure Order",
        color: [0.2, 0.4, 1, 1],
        territory: { x: 60, z: -60, radius: 40 },
        reputation: 0
    },
    [Faction.SHADOW_COVENANT]: {
        name: "Shadow Covenant",
        color: [0.5, 0.2, 0.8, 1],
        territory: { x: 0, z: 60, radius: 40 },
        reputation: 0
    },
    [Faction.NEUTRAL]: {
        name: "Neutral",
        color: [0.7, 0.7, 0.7, 1],
        territory: { x: 0, z: 0, radius: 20 },
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
    
    addItem(itemId: string, quantity: number = 1) {
        this.inventory[itemId] = (this.inventory[itemId] || 0) + quantity;
        Entropy.Inventory.addItem(this.playerId!, itemId, quantity);
        Entropy.println(`[Inventory] +${quantity} ${itemId}`);
    }
    
    hasItem(itemId: string, quantity: number = 1): boolean {
        return (this.inventory[itemId] || 0) >= quantity;
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
        Entropy.Quest.create(questId, {
            title: quest.title,
            objectives: quest.objectives
        });
        Entropy.println(`[Quest Started] ${quest.title}`);
    }
    
    completeObjective(questId: string, objectiveIndex: number) {
        const quest = quests[questId];
        if (!quest || !quest.isActive || quest.completedObjectives[objectiveIndex]) return;
        
        quest.completedObjectives[objectiveIndex] = true;
        Entropy.Quest.updateObjective(questId, objectiveIndex, true);
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
        Entropy.GameState.save("fractured_realm_save", {
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
        const data = Entropy.GameState.load("fractured_realm_save");
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

Entropy.Behavior.register("quest_giver_vex", {
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
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.AZURE_ORDER].reputation;
        
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
    onInteract: (entity, dialogue) => {
        const rep = factions[Faction.SHADOW_COVENANT].reputation;
        
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
    onInteract: (entity, dialogue) => {
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
    onUpdate: (entity, system, state) => {
        if (entity.isDead) return state;
        
        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        // Only aggressive if player has negative reputation
        if (factions[Faction.CRIMSON_GUARD].reputation < -20 && dist < 30) {
            if (dist > 2.5) {
                const speed = 3.5;
                Entropy.Entity.applyImpulse(entity.id, [
                    (dx / dist) * speed, 0, (dz / dist) * speed
                ] as [number, number, number]);
                Entropy.Entity.playAnimation(entity.id, "Walking");
            } else {
                Entropy.Entity.playAnimation(entity.id, "Attack");
            }
        } else {
            // Patrol behavior
            Entropy.Entity.playAnimation(entity.id, "Idle");
        }
        
        return state;
    },
    onAttack: (entity, system, state) => {
        system.spawn_particles(entity.position, [1, 0.2, 0.2, 1], [0, -2, 0]);
        gameState.enemyKills.crimson++;
        
        // Drop insignia
        const y = Entropy.Landscape.getHeightAt(entity.position[0], entity.position[2]);
        Entropy.Collectable.create({
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
    onUpdate: (entity, system, state) => {
        if (entity.isDead) return state;
        
        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (factions[Faction.AZURE_ORDER].reputation < -20 && dist < 30) {
            if (dist > 2.5) {
                const speed = 3.5;
                Entropy.Entity.applyImpulse(entity.id, [
                    (dx / dist) * speed, 0, (dz / dist) * speed
                ] as [number, number, number]);
                Entropy.Entity.playAnimation(entity.id, "Walking");
            } else {
                Entropy.Entity.playAnimation(entity.id, "Attack");
            }
        } else {
            Entropy.Entity.playAnimation(entity.id, "Idle");
        }
        
        return state;
    },
    onAttack: (entity, system, state) => {
        system.spawn_particles(entity.position, [0.2, 0.4, 1, 1], [0, -2, 0]);
        gameState.enemyKills.azure++;
        
        const y = Entropy.Landscape.getHeightAt(entity.position[0], entity.position[2]);
        Entropy.Collectable.create({
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
    onUpdate: (entity, system, state) => {
        if (entity.isDead) return state;
        
        const [playerPos] = Entropy.Camera.getTransform();
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        // Shadows are always neutral unless attacked
        if (dist < 5) {
            // Stealth - disappear and reappear
            if (Math.random() > 0.98) {
                const angle = Math.random() * Math.PI * 2;
                const newX = playerPos[0] + Math.cos(angle) * 8;
                const newZ = playerPos[2] + Math.sin(angle) * 8;
                system.spawn_particles(entity.position, [0.5, 0.2, 0.8, 1], [0, 2, 0]);
                // Note: Would need teleport API, using impulse as approximation
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
    landscapeId: string | null = null;
    
    initialize() {
        // Create landscape
        this.landscapeId = Entropy.Landscape.create({
            width: LANDSCAPE_SIZE,
            height: LANDSCAPE_SIZE,
            position: [-LANDSCAPE_SIZE/2, 0, -LANDSCAPE_SIZE/2]
        });
        
        Entropy.println("[World] Landscape created");
        
        this.spawnPlayer();
        this.populateWorld();
    }
    
    spawnPlayer() {
        const spawnX = 0;
        const spawnZ = 0;
        const y = Entropy.Landscape.getHeightAt(spawnX, spawnZ);
        
        gameState.playerId = Entropy.generateUUID();
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
        
        Entropy.println("[Player] Spawned at center");
    }
    
    populateWorld() {
        // Spawn faction leaders (quest givers)
        this.spawnNPC("Commander Vex", "commander_vex", "Enemy1b.glb", 
            factions[Faction.CRIMSON_GUARD].territory, "quest_giver_vex");
        
        this.spawnNPC("Scholar Lyra", "scholar_lyra", "Friend2b.glb",
            factions[Faction.AZURE_ORDER].territory, "quest_giver_lyra");
        
        this.spawnNPC("Whisper Master", "whisper_master", "Enemy2b.glb",
            factions[Faction.SHADOW_COVENANT].territory, "quest_giver_whisper");
        
        this.spawnNPC("The Wanderer", "wanderer", "Friend1b.glb",
            { x: 0, z: 0, radius: 5 }, "neutral_wanderer");
        
        // Spawn faction soldiers
        this.spawnFactionGuards(Faction.CRIMSON_GUARD, "Enemy1b.glb", "crimson_soldier", 8);
        this.spawnFactionGuards(Faction.AZURE_ORDER, "Friend2b.glb", "azure_soldier", 8);
        this.spawnFactionGuards(Faction.SHADOW_COVENANT, "Enemy2b.glb", "shadow_assassin", 6);
        
        // Spawn collectables
        this.spawnCollectables();
        
        Entropy.println("[World] Populated with NPCs and items");
    }
    
    spawnNPC(name: string, id: string, model: string, territory: { x: number, z: number, radius: number }, behaviorId: string) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * territory.radius * 0.3; // Keep near center
        const x = territory.x + Math.cos(angle) * dist;
        const z = territory.z + Math.sin(angle) * dist;
        const y = Entropy.Landscape.getHeightAt(x, z);
        
        addon.Model.load({
            path: model,
            id: id,
            position: [x, y + 1, z],
            behaviorId: behaviorId,
            physics: {
                bodyType: "fixed",
                colliderShape: "capsule"
            }
        });
    }
    
    spawnFactionGuards(faction: Faction, model: string, behaviorId: string, count: number) {
        const territory = factions[faction].territory;
        
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2;
            const dist = territory.radius * (0.5 + Math.random() * 0.4);
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = Entropy.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: model,
                position: [x, y + 1, z],
                behaviorId: behaviorId,
                physics: {
                    bodyType: "dynamic",
                    colliderShape: "capsule"
                }
            });
        }
    }
    
    spawnCollectables() {
        // Ancient scrolls for Azure quest
        for (let i = 0; i < 3; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.8;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.8;
            const y = Entropy.Landscape.getHeightAt(x, z);
            
            Entropy.Collectable.create({
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
        const relicY = Entropy.Landscape.getHeightAt(shadowTerr.x, shadowTerr.z);
        Entropy.Collectable.create({
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
            const y = Entropy.Landscape.getHeightAt(x, z);
            
            Entropy.Collectable.create({
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
        for (let i = 0; i < 15; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const y = Entropy.Landscape.getHeightAt(x, z);
            
            Entropy.Collectable.create({
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
        this.landscapeId = null;
    }
}

const worldManager = new WorldManager();

// --- Game Lifecycle ---

Entropy.onGameStarted(() => {
    gameState.isGameActive = true;
    worldManager.initialize();
    Entropy.println("=== THE FRACTURED REALM ===");
    Entropy.println("Choose your path wisely. Every action has consequences.");
});

Entropy.onGameStopped(() => {
    gameState.save();
    gameState.isGameActive = false;
    worldManager.cleanup();
});

// --- UI ---

addon.onInit(() => {
    Entropy.println("The Fractured Realm initialized");
    
    addon.UI.createTab({
        title: "Fractured Realm",
        onRender: () => {
            const windowId = "FracturedRealmTab";
            
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
});