// --- Faction System ---
export enum Faction {
    CRIMSON_GUARD = "crimson_guard",
    AZURE_ORDER = "azure_order",
    SHADOW_COVENANT = "shadow_covenant",
    NEUTRAL = "neutral"
}

export interface FactionData {
    name: string;
    color: [number, number, number, number];
    territory: { x: number, z: number, radius: number };
    reputation: number; // -100 to 100
}

export const factions: Record<Faction, FactionData> = {
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
export interface Quest {
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

export const quests: Record<string, Quest> = {
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
