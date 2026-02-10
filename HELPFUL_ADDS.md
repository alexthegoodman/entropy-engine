What would be helpful to add to addon API:

Landscape height query - Essential for placing objects and NPCs at ground level

typescript   Landscape.getHeightAt(x: number, z: number) => number

Collectables API - Great for loot, quest items, health pickups

typescript   Collectable: {
     create: (config: {
       position: [number, number, number];
       modelPath?: string;
       type: "health" | "ammo" | "quest_item" | "currency";
       value?: number;
       questId?: string;
       onCollect?: (playerId: string) => void;
     }) => string;
     remove: (id: string) => void;
   }

Quest system helpers - You have dialogue that can start quests, but tracking would help:

typescript   Quest: {
     create: (id: string, config: { title: string; objectives: string[] }) => void;
     updateObjective: (questId: string, index: number, completed: boolean) => void;
     getStatus: (questId: string) => QuestStatus;
   }

Player inventory - To track collected items:

typescript   Inventory: {
     addItem: (playerId: string, itemId: string, quantity: number) => void;
     removeItem: (playerId: string, itemId: string, quantity: number) => void;
     hasItem: (playerId: string, itemId: string) => boolean;
   }