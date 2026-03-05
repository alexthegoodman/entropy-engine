import type { Entity } from "../addon";
import { ProceduralHumanoid } from "../humanoid_v2";
import { FPSUI, type DialogueOption, type DialogueState } from "./fps_ui";
import { addon, combat, entityPositions } from "./index";
import { Faction, factions, quests } from "./quests";
import { gameState } from "./state";
import { environmentDecorator } from "./decorator";
import { WeaponType } from "./combat";

class WorldManager {    
    public playerJointBufferId: string = "";
    public playerHumanoid: ProceduralHumanoid | null = null;
    public npcJointBufferId: Record<string, string> = {};
    public npcHumanoids: Record<string, ProceduralHumanoid> = {};
    public npcAnimations: Record<string, string> = {};

    initialize() {
        gameState.setupCombat();
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

        // Register in combat system
        combat.registerEntity(gameState.playerId, Faction.NEUTRAL, {
            type: WeaponType.RANGED,
            damage: 25,
            range: 100,
            fireRate: 5,
            ammo: 30,
            maxAmmo: 30
        }, 100);

        gameState.syncPlayerStats();
    }
    
    populateWorld() {
        // Spawn faction leaders (quest givers)
        this.spawnNPC("Commander Vex", Entropy.generateUUID(), "Enemy1b.glb", 
            factions[Faction.CRIMSON_GUARD].territory, {
                behaviorId: "quest_giver_vex"
            }, Faction.CRIMSON_GUARD);
        
        this.spawnNPC("Scholar Lyra", Entropy.generateUUID(), "Player1b.glb",
            factions[Faction.AZURE_ORDER].territory, {
                behaviorId: "quest_giver_lyra"
            }, Faction.AZURE_ORDER);
        
        this.spawnNPC("Whisper Master", Entropy.generateUUID(), "Enemy1b.glb",
            factions[Faction.SHADOW_COVENANT].territory, {
                behaviorId: "quest_giver_whisper"
            }, Faction.SHADOW_COVENANT);
        
        this.spawnNPC("The Wanderer", Entropy.generateUUID(), "Friend1b.glb",
            { x: 0, z: 0, radius: 5 }, {
                behaviorId: "neutral_wanderer"
            }, Faction.NEUTRAL);
        
        // Spawn faction soldiers
        this.spawnFactionGuards(Faction.CRIMSON_GUARD, "Enemy1b.glb", 
            // hardcoded behaviors
            // {
            //     behaviorId: "crimson_soldier",
            // }, 
            // 25,
            
            // trained LSTM behaviors
            {
                behaviorId: "movement_tracker",
                yumonId: "Berserker"
            },
            3
        );
        this.spawnFactionGuards(Faction.AZURE_ORDER, "Friend1b.glb", 
            // {
            //     behaviorId: "azure_soldier",
            // }, 
            // 25,
            {
                behaviorId: "movement_tracker",
                yumonId: "Berserker"
            },
            3
        );
        this.spawnFactionGuards(Faction.SHADOW_COVENANT, "Enemy1b.glb", 
            // {
            //     behaviorId: "shadow_assassin",
            // }, 
            // 25,
            {
                behaviorId: "movement_tracker",
                yumonId: "Berserker"
            },
            3
        );
        
        // Spawn collectables
        this.spawnCollectables();
        
        Entropy.println("[World] Populated with NPCs and items");
    }
    
    spawnNPC(name: string, id: string, model: string, territory: { x: number, z: number, radius: number }, intelligence: { behaviorId?: string, yumonId?: string }, faction: Faction = Faction.NEUTRAL) {
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
                behaviorId: intelligence.behaviorId || (intelligence.yumonId ? "movement_tracker" : undefined),
                yumonId: intelligence.yumonId,
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
                behaviorId: intelligence.behaviorId || (intelligence.yumonId ? "movement_tracker" : undefined),
                yumonId: intelligence.yumonId,
                isNpc: true,
                physics: {
                    bodyType: "dynamic",
                    colliderShape: "capsule",
                    mass: 100
                }
            });
        }

        if (intelligence.behaviorId) {
            gameState.npcBehaviors.set(id, intelligence.behaviorId);
        }

        // Register in combat system
        combat.registerEntity(id, faction, {
            type: WeaponType.MELEE,
            damage: 10,
            range: 3,
            fireRate: 1
        }, 100);
    }
    
    spawnFactionGuards(faction: Faction, model: string, intelligence: { behaviorId?: string, yumonId?: string }, count: number) {
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
                    behaviorId: intelligence.behaviorId || (intelligence.yumonId ? "movement_tracker" : undefined),
                    yumonId: intelligence.yumonId,
                    isNpc: true,
                });
            } else {
                addon.Model.load({
                    path: model,
                    id: id,
                    position: [x, y + 1, z],
                    behaviorId: intelligence.behaviorId || (intelligence.yumonId ? "movement_tracker" : undefined),
                    yumonId: intelligence.yumonId,
                    isNpc: true,
                    physics: {
                        bodyType: "dynamic",
                        colliderShape: "capsule"
                    }
                });
            }

            if (intelligence.behaviorId) {
                gameState.npcBehaviors.set(id, intelligence.behaviorId);
            }

            // Register in combat system
            combat.registerEntity(id, faction, {
                type: WeaponType.RANGED,
                damage: 10,
                range: 40,
                fireRate: 0.5,
                ammo: 100,
                maxAmmo: 100
            }, 80);
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
            
            this.createTrackedCollectable({
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
        this.createTrackedCollectable({
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
            
            this.createTrackedCollectable({
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
            
            this.createTrackedCollectable({
                modelPath: "Barrel1small.glb",
                position: [x, y + 0.5, z],
                type: "health",
                value: 25,
                onCollect: (playerId: any) => {
                    Entropy.Entity.setStats(playerId, { 
                        health: 100,
                        stamina: 100
                    });
                    Entropy.println("[Health] +25 HP");
                }
            });
        }
    }

    createTrackedCollectable(config: any) {
        return gameState.createTrackedCollectable(config);
    }
    
    cleanup() {
        addon.Model.clearMeshes();
    }
}

export const worldManager = new WorldManager();