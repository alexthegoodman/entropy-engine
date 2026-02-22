import type { BehaviorSystem, Entity, MiniMapConfig, MiniMapMarker, PhysicsConfig, Scale, UpdateCallback } from "./addon";

const addonInfo = {
    name: "Tower Siege",
    version: "1.0.0",
    description: "Defend your base from endless enemy waves! Place towers strategically on the terrain.",
    author: ["Entropy AI"],
    capabilities: {
        ui: true,
        gameplay: true,
        quests: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

// --- Game Configuration ---
const LANDSCAPE_SIZE = 4096;
const HALF_SIZE = LANDSCAPE_SIZE / 2;
const SPAWN_POS = [-1800, 0, -1800];
const BASE_POS = [1800, 0, 1800];

// Waypoints for enemy path (diagonal across map)
const NUM_WAYPOINTS = 40;
const waypoints: [number, number][] = [];
for (let i = 0; i <= NUM_WAYPOINTS; i++) {
    const t = i / NUM_WAYPOINTS;
    waypoints.push([
        SPAWN_POS[0] + t * (BASE_POS[0] - SPAWN_POS[0]),
        SPAWN_POS[2] + t * (BASE_POS[2] - SPAWN_POS[2])
    ]);
}

// Minimap markers (0-1 normalized)
const minimapMarkers: MiniMapMarker[] = [
    {
        position: [(SPAWN_POS[0] + HALF_SIZE) / LANDSCAPE_SIZE, (SPAWN_POS[2] + HALF_SIZE) / LANDSCAPE_SIZE],
        color: [0, 0.5, 1, 1],
        label: "Spawn"
    },
    {
        position: [(BASE_POS[0] + HALF_SIZE) / LANDSCAPE_SIZE, (BASE_POS[2] + HALF_SIZE) / LANDSCAPE_SIZE],
        color: [1, 0, 0, 1],
        label: "Base"
    }
];
// Add waypoint markers every 10%
for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const px = SPAWN_POS[0] + t * (BASE_POS[0] - SPAWN_POS[0]);
    const pz = SPAWN_POS[2] + t * (BASE_POS[2] - SPAWN_POS[2]);
    minimapMarkers.push({
        position: [(px + HALF_SIZE) / LANDSCAPE_SIZE, (pz + HALF_SIZE) / LANDSCAPE_SIZE],
        color: [0.7, 0.7, 0.7, 1]
    });
}

// Tower types
const towerTypes: Record<string, { scale: Scale, range: number, dmg: number, cost: number }> = {
    basic: {
        scale: [1.5, 3.5, 1.5],
        range: 18,
        dmg: 1.8,
        cost: 50
    },
    sniper: {
        scale: [0.8, 5.5, 0.8],
        range: 35,
        dmg: 4.2,
        cost: 150
    }
};

// Enemy types (hardcoded in behaviors)
const enemyTypes = {
    basic: { model: "Enemy1b.glb" },
    fast: { model: "Friend1b.glb" },
    tank: { model: "Enemy1b.glb" }
} as const;

// Waves definition
const waves: Array<{ enemies: Record<string, number> }> = [];
for (let i = 0; i < 20; i++) {
    const w: any = { basic: 6 + i };
    if (i >= 3) w.fast = Math.floor(i / 2) + 1;
    if (i >= 8) w.tank = Math.floor(i / 4);
    waves.push(w);
}

export interface Quest {
    id: string;
        title: string;
        description: string;
        giver:string;
        faction: string;
        objectives: string[];
        completedObjectives: string[];
        reputationReward: string[];
        nextQuests: string[];
        isActive: boolean;
        isCompleted: boolean;
}

// --- Quest System ---
const quests: Record<string, Quest> = {
    tower_siege: {
        id: "tower_siege",
        title: "Defend the Realm",
        description: "Survive 20 waves of invaders!",
        giver: "commander",
        faction: "neutral" as any,
        objectives: [],
        completedObjectives: [],
        reputationReward: [],
        nextQuests: [],
        isActive: false,
        isCompleted: false
    }
};
for (let i = 1; i <= 20; i++) {
    quests.tower_siege.objectives!.push(`Survive Wave ${i}`);
}

// --- Game State ---
class GameState {
    playerId: string | null = null;
    isGameActive = false;
    inventory: Record<string, number> = {};
    activeQuests: string[] = [];
    gold = 300; // Starting gold
    lives = 20;
    currentWave = 0;
    activeEnemies = 0;
    nextSpawnTime = 0;
    towers: Array<{ pos: [number, number, number], scale: Scale, range: number, dmg: number }> = [];
    pendingTower: { scale: Scale, range: number, dmg: number, cost: number } | null = null;
    lastTime = 0;
    
    addGold(amount: number) {
        this.gold += amount;
        Entropy.println(`[Gold] +${amount} (Total: ${this.gold})`);
    }
    
    startQuest(questId: string) {
        const quest = quests[questId];
        if (!quest || quest.isActive) return;
        
        quest.isActive = true;
        this.activeQuests.push(questId);
        addon.Quest.create(questId, {
            title: quest.title,
            objectives: quest.objectives as string[]
        });
        Entropy.println(`[Quest Started] ${quest.title}`);
    }
    
    restoreQuests() {
        this.activeQuests.forEach(questId => {
            const quest = quests[questId];
            addon.Quest.create(questId, {
                title: quest.title,
                objectives: quest.objectives as string[]
            });
            quest.completedObjectives.forEach((completed, index) => {
                if (completed) {
                    addon.Quest.updateObjective(questId, index, true);
                }
            });
        });
    }
    
    restoreTowers() {
        this.towers.forEach(tower => {
            addon.Model.createProcedural({
                type: "cube",
                parameters: {
                    position: tower.pos,
                    scale: tower.scale
                },
                // physics: {
                //     bodyType: "fixed",
                //     colliderShape: "cuboid"
                // } as any
            });
        });
    }
    
    save() {
        addon.GameState.save("tower_siege_save", {
            inventory: this.inventory,
            activeQuests: this.activeQuests,
            quests: quests,
            gold: this.gold,
            lives: this.lives,
            currentWave: this.currentWave,
            activeEnemies: this.activeEnemies,
            nextSpawnTime: this.nextSpawnTime,
            towers: this.towers
        });
        Entropy.println("[Game Saved]");
    }
    
    load() {
        const data = addon.GameState.load("tower_siege_save");
        if (data) {
            this.inventory = data.inventory || {};
            this.activeQuests = data.activeQuests || [];
            Object.assign(quests, data.quests || {});
            this.gold = data.gold || 300;
            this.lives = data.lives || 20;
            this.currentWave = data.currentWave || 0;
            this.activeEnemies = 0; // Reset
            this.nextSpawnTime = 0;
            this.towers = data.towers || [];
            this.restoreQuests();
            this.restoreTowers();
            Entropy.println("[Game Loaded]");
        }
    }
}

const gameState = new GameState();

// --- Enemy Behaviors ---
function registerEnemyBehavior(type: string, hp: number, speed: number, goldDrop: number, model: string) {
    Entropy.Behavior.register(`enemy_${type}`, {
        onUpdate: (entity: Entity, system: BehaviorSystem, state: any) => {
            if (entity.isDead) return state;

            // Initialize state
            state.hp = state.hp || hp;
            state.speed = state.speed || speed;
            state.wpIndex = state.wpIndex || 0;
            state.immuneTime = Math.max(0, (state.immuneTime || 0) - 1);

            // Check tower damage
            for (const tower of gameState.towers) {
                const dx = tower.pos[0] - entity.position[0];
                const dz = tower.pos[2] - entity.position[2];
                const dist = Math.sqrt(dx * dx + dz * dz);
                if (dist < tower.range && state.immuneTime === 0) {
                    state.hp -= tower.dmg;
                    state.immuneTime = 45; // Immunity frames
                    system.spawn_particles(entity.position, [1, 0.6, 0, 1], [0, -3, 0]);
                    Entropy.Audio.playSynth({ freq: 180, waveform: "saw", duration: 0.05, gain: 0.2 });
                }
            }

            // Death
            if (state.hp <= 0) {
                system.spawn_particles(entity.position, [1, 0.2, 0.2, 1], [0, -9.8, 0]);
                const dropY = addon.Landscape.getHeightAt(entity.position[0], entity.position[2]) + 1;
                addon.Collectable.create({
                    position: [entity.position[0], dropY, entity.position[2]],
                    modelPath: "Barrel1small.glb",
                    type: "currency",
                    value: goldDrop,
                    onCollect: (playerId: string) => {
                        gameState.addGold(goldDrop);
                    }
                });
                gameState.activeEnemies--;
                addon.Model.clearMesh(entity.id);
                Entropy.Audio.playSynth({ freq: 80, waveform: "noise", duration: 0.3, gain: 0.4 });
                return state;
            }

            // Movement to next waypoint
            if (state.wpIndex < waypoints.length) {
                const [tx, tz] = waypoints[state.wpIndex];
                const dx = tx - entity.position[0];
                const dz = tz - entity.position[2];
                const dist = Math.sqrt(dx * dx + dz * dz);
                if (dist < 30) {
                    state.wpIndex++;
                } else {
                    const impulseStrength = state.speed * 25; // Tune for good movement
                    const impulse: [number, number, number] = [
                        (dx / dist) * impulseStrength,
                        0,
                        (dz / dist) * impulseStrength
                    ];
                    Entropy.Entity.applyImpulse(entity.id, impulse);
                }

                // Reached base
                if (state.wpIndex >= waypoints.length) {
                    gameState.lives--;
                    Entropy.println(`[Base Hit!] Lives remaining: ${gameState.lives}`);
                    if (gameState.lives <= 0) {
                        Entropy.println("💀 GAME OVER - Base Destroyed! 💀");
                        Entropy.setGameMode(false);
                    }
                    addon.Model.clearMesh(entity.id);
                    gameState.activeEnemies--;
                    return state;
                }
            }

            return state;
        }
    });
}

registerEnemyBehavior("basic", 90, 1.4, 15, "Enemy1b.glb");
registerEnemyBehavior("fast", 55, 2.8, 22, "Friend1b.glb");
registerEnemyBehavior("tank", 450, 0.7, 55, "Enemy1b.glb");

// --- World Manager ---
class WorldManager {
    landscapeId?: string;
    
    initialize() {
        this.spawnBase();
        Entropy.println("[Tower Siege] Ready! Place towers and survive the waves.");
    }
    
    spawnBase() {
        const bx = BASE_POS[0];
        const bz = BASE_POS[2];
        const by = addon.Landscape.getHeightAt(bx, bz) + 4;
        addon.Model.createProcedural({
            type: "cube",
            parameters: {
                position: [bx, by, bz],
                scale: [12, 8, 12]
            },
            // physics: {
            //     bodyType: "fixed",
            //     colliderShape: "cuboid"
            // } as PhysicsConfig
        });
    }
    
    spawnWave(waveIdx: number) {
        const waveDef = waves[waveIdx];
        Object.entries(waveDef.enemies).forEach(([etype, count]) => {
            for (let j = 0; j < count; j++) {
                setTimeout(() => { // TODO: need Entropy.setTimeout that runs functions have set ms time
                    const angle = (j / count) * Math.PI * 2;
                    const offx = Math.cos(angle) * 20;
                    const offz = Math.sin(angle) * 20;
                    const sy = addon.Landscape.getHeightAt(SPAWN_POS[0] + offx, SPAWN_POS[2] + offz) + 1.8;
                    addon.Model.load({
                        path: (enemyTypes as any)[etype].model,
                        position: [SPAWN_POS[0] + offx, sy, SPAWN_POS[2] + offz],
                        behaviorId: `enemy_${etype}`,
                        isNpc: true,
                        physics: {
                            bodyType: "dynamic",
                            colliderShape: "capsule",
                            mass: 60,
                            friction: 0.6,
                            restitution: 0.1
                        }
                    });
                    gameState.activeEnemies++;
                }, j * 250);
            }
        });
        Entropy.Audio.playSynth({
            freq: 110 + waveIdx * 8,
            waveform: "saw",
            duration: 2.5,
            gain: 0.35
        });
        Entropy.println(`[Wave ${waveIdx + 1} Started!]`);
    }
    
    spawnTower(pos: [number, number, number], towerConfig: any) {
        addon.Model.createProcedural({
            type: "cube",
            parameters: {
                position: pos,
                scale: towerConfig.scale
            },
            // physics: {
            //     bodyType: "fixed",
            //     colliderShape: "cuboid"
            // } as PhysicsConfig
        });
        gameState.towers.push({
            pos,
            scale: towerConfig.scale,
            range: towerConfig.range,
            dmg: towerConfig.dmg
        });
        Entropy.println(`[Tower Placed] Range: ${towerConfig.range}, DMG: ${towerConfig.dmg}`);
        Entropy.Audio.playSynth({ freq: 660, waveform: "sine", duration: 0.15, gain: 0.4 });
    }
    
    cleanup() {
        addon.Model.clearMeshes();
    }
}

const worldManager = new WorldManager();

// --- Game Lifecycle ---
let updateCallback: UpdateCallback | undefined;

Entropy.onGameStarted(() => {
    Entropy.Composer?.enableGameComposerOverride();

    Entropy.println("=== 🏰 TOWER SIEGE 🏰 ===");

    gameState.isGameActive = true;
    worldManager.initialize();
    gameState.startQuest("tower_siege");
    gameState.nextSpawnTime = 0; // Start first wave immediately

    // Global update loop
    updateCallback = (time: number) => {
        gameState.lastTime = time;

        if (gameState.activeEnemies === 0 && time > gameState.nextSpawnTime && gameState.currentWave < 20) {
            const waveIdx = gameState.currentWave;
            worldManager.spawnWave(waveIdx);
            if (waveIdx > 0) {
                addon.Quest.updateObjective("tower_siege", waveIdx - 1, true);
            }
            gameState.currentWave++;
            gameState.nextSpawnTime = time + 1200; // 20 seconds inter-wave
        }

        if (gameState.currentWave >= 20 && gameState.activeEnemies === 0) {
            Entropy.println("🏆 VICTORY! The realm is defended! 🏆");
            Entropy.setGameMode(false);
        }
    };
    addon.onUpdate(updateCallback);

    Entropy.println("First wave incoming! Place your towers wisely.");

    Entropy.Composer?.disableGameComposerOverride();
});

Entropy.onGameStopped(() => {
    if (updateCallback) {
        // Note: onUpdate removal not directly supported, but game mode stops it
    }
    gameState.save();
    gameState.isGameActive = false;
    worldManager.cleanup();
    gameState.towers = [];
    gameState.activeEnemies = 0;
});

// --- UI ---
const minimapConfig: MiniMapConfig = {
    // landscapeId: worldManager.landscapeId, // Uses default if omitted
    brushSize: 0.025,
    markers: minimapMarkers,
    onDraw: (x: number, y: number, brushSize: number) => {
        if (!gameState.pendingTower) return;

        const cost = gameState.pendingTower.cost;
        if (gameState.gold < cost) return;

        const wx = LANDSCAPE_SIZE * x - HALF_SIZE;
        const wz = LANDSCAPE_SIZE * y - HALF_SIZE;
        const wy = addon.Landscape.getHeightAt(wx, wz) + 2;

        worldManager.spawnTower([wx, wy, wz] as [number, number, number], gameState.pendingTower);
        gameState.gold -= cost;
        gameState.pendingTower = null;
    },
    onHover: (x: number, y: number, brushSize: number) => {
        // Preview could be added here if UI supports
    }
};

addon.onInit(() => {
    const windowId = addon.UI.createTab({
        title: "🏰 Tower Siege",
        onRender: () => {
            Entropy.UI.Widget.label(windowId, { text: "🏰 TOWER SIEGE", bold: true });
            Entropy.UI.Widget.separator(windowId);
            
            if (!gameState.isGameActive) {
                Entropy.UI.Widget.button(windowId, {
                    text: "⚔️ Start Defense",
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
                // Stats
                Entropy.UI.Widget.label(windowId, { text: `💰 Gold: ${gameState.gold}`, bold: true });
                Entropy.UI.Widget.label(windowId, { text: `❤️ Lives: ${gameState.lives}`, bold: true });
                Entropy.UI.Widget.label(windowId, { text: `🌊 Wave: ${gameState.currentWave}/20 | Enemies: ${gameState.activeEnemies}`, bold: true });
                
                Entropy.UI.Widget.separator(windowId);
                
                // Tower placement
                Entropy.UI.Widget.label(windowId, { text: "🛠️ Place Towers (Click minimap!):", bold: true });
                Entropy.UI.Widget.button(windowId, {
                    text: "Basic (50g)",
                    onClick: () => {
                        if (gameState.gold >= 50) {
                            gameState.pendingTower = towerTypes.basic;
                        }
                    }
                });
                Entropy.UI.Widget.button(windowId, {
                    text: "Sniper (150g)",
                    onClick: () => {
                        if (gameState.gold >= 150) {
                            gameState.pendingTower = towerTypes.sniper;
                        }
                    }
                });
                Entropy.UI.Widget.button(windowId, {
                    text: "❌ Clear",
                    onClick: () => { gameState.pendingTower = null; }
                });
                
                Entropy.UI.Widget.separator(windowId);
                
                // Minimap for placement
                Entropy.UI.Widget.miniMap(windowId, minimapConfig);
                
                Entropy.UI.Widget.separator(windowId);
                
                // Active quests
                Entropy.UI.Widget.label(windowId, { text: "=== QUEST ===", bold: true });
                if (gameState.activeQuests.length === 0) {
                    Entropy.UI.Widget.label(windowId, { text: "No active quests." });
                } else {
                    gameState.activeQuests.forEach(questId => {
                        const quest = quests[questId];
                        Entropy.UI.Widget.label(windowId, { text: `• ${quest.title}` });
                        (quest.objectives as string[]).forEach((obj, idx) => {
                            const status = quest.completedObjectives[idx] ? "✓" : "○";
                            Entropy.UI.Widget.label(windowId, { text: `  ${status} ${obj}` });
                        });
                    });
                }
                
                Entropy.UI.Widget.separator(windowId);
                
                Entropy.UI.Widget.button(windowId, {
                    text: "💾 Save Game",
                    onClick: () => gameState.save()
                });
                
                Entropy.UI.Widget.button(windowId, {
                    text: "🛑 End Defense",
                    onClick: () => {
                        gameState.save();
                        Entropy.setGameMode(false);
                    }
                });
            }
        }
    });

    Entropy.println("🏰 TOWER SIEGE initialized - Defend the base!");
});