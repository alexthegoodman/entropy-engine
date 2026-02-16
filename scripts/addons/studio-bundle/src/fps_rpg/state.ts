import type { Entity } from "../addon";
import { ProceduralHumanoid } from "../humanoid_v2";
import { FPSUI, type DialogueOption, type DialogueState } from "./fps_ui";
import { addon, combat, entityPositions, fpsUI } from "./index";
import { Faction, factions, quests } from "./quests";
import { worldManager } from "./world";
// import { behaviorHooks } from "./behaviors";
// import { behaviorHooks } from "./behaviors_v2";
import { behaviorHooks } from "./behaviors_squads";

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
    lastAttackedEnemyId: string | null = null;
    lastAttackedTime = 0;
    
    // Tracking for interaction
    trackedCollectables = new Map<string, { position: [number, number, number], onCollect: (playerId: string) => void }>();
    npcBehaviors = new Map<string, string>(); // entityId -> behaviorId
    currentDialogueNpcId: string | null = null;
    currentDialogueNode: string = "start";

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

    openDialogue(npcName: string, text: string, options: DialogueOption[]) {
        this.dialogue.npcName = npcName;
        this.dialogue.text = text;
        this.dialogue.options = options;
        this.dialogue.isOpen = true;
        this.dialogue.selectedIndex = 0;
        this.uiDirty = true;
    }

    closeDialogue() {
        this.dialogue.isOpen = false;
        this.currentDialogueNpcId = null;
        this.currentDialogueNode = "start";
        this.uiDirty = true;
    }

    navigateDialogue(delta: number) {
        if (!this.dialogue.isOpen || this.dialogue.options.length === 0) return;
        const count = this.dialogue.options.length;
        this.dialogue.selectedIndex = (this.dialogue.selectedIndex + delta + count) % count;
        this.uiDirty = true;
    }

    selectDialogueOption() {
        if (!this.dialogue.isOpen) return;
        const selected = this.dialogue.options[this.dialogue.selectedIndex];
        if (selected) {
            if (selected.next_node === "exit") {
                this.closeDialogue();
            } else {
                this.currentDialogueNode = selected.next_node;
                this.runDialogue();
            }
        }
    }

    private uiDirty = true;

    setupCombat() {
        combat.onEntityDamaged = (targetId, damage, attackerId) => {
            if (targetId === this.playerId) {
                this.setHealth(combat.getEntity(targetId)!.health);
                combat.playDamageSound();
            } else if (attackerId === this.playerId) {
                this.lastAttackedEnemyId = targetId;
                this.lastAttackedTime = Date.now();
                this.requestRedraw();
            }
        };

        combat.onEntityDeath = (targetId, attackerId) => {
            if (targetId === this.lastAttackedEnemyId) {
                this.lastAttackedEnemyId = null;
                this.requestRedraw();
            }
            const entity = combat.getEntity(targetId);
            if (!entity) return;

            if (targetId === this.playerId) {
                Entropy.println("--- YOU HAVE DIED ---");
                this.setHealth(0);
                this.requestRedraw();
                // Reset or Respawn logic?
            } else {
                // Handle NPC death
                const faction = entity.faction as Faction;
                const pos = entityPositions.get(targetId);
                
                if (pos) {
                    // Spawn particles (matching old onAttack logic)
                    let color: [number, number, number, number] = [1, 1, 1, 1];
                    if (faction === Faction.CRIMSON_GUARD) color = [1, 0.2, 0.2, 1];
                    else if (faction === Faction.AZURE_ORDER) color = [0.2, 0.4, 1, 1];
                    else if (faction === Faction.SHADOW_COVENANT) color = [0.5, 0.2, 0.8, 1];

                    // Use behavior system to spawn particles if available
                    // or just use Entropy.Particles if it had a simple emitter
                    // For now, let's just log and drop loot.
                    
                    if (faction === Faction.CRIMSON_GUARD) {
                        this.enemyKills.crimson++;
                        this.dropLoot(pos, "crimson_insignia");
                    } else if (faction === Faction.AZURE_ORDER) {
                        this.enemyKills.azure++;
                        this.dropLoot(pos, "azure_insignia");
                        
                        // Check quest progress
                        if (quests["crimson_welcome"].isActive && this.enemyKills.azure >= 5 && this.hasItem("azure_insignia", 5)) {
                            this.completeObjective("crimson_welcome", 0);
                            this.completeObjective("crimson_welcome", 1);
                        }
                    } else if (faction === Faction.SHADOW_COVENANT) {
                        this.enemyKills.shadow++;
                    }
                }
                
                Entropy.println(`[Combat] ${targetId} (${faction}) defeated by ${attackerId}`);

                // Remove the enemy mesh/model after a short delay
                addon.Model.clearMesh(targetId);
                Entropy.Composer?.clearMesh(targetId); // also clear from Game Composer
                combat.unregisterEntity(targetId);
                entityPositions.delete(targetId);
                this.npcBehaviors.delete(targetId);
                
                // Remove from humanoid tracking if present
                if (worldManager.npcHumanoids[targetId]) {
                    delete worldManager.npcHumanoids[targetId];
                    delete worldManager.npcJointBufferId[targetId];
                    delete worldManager.npcAnimations[targetId];
                }
            }
        };
    }

    syncPlayerStats() {
        if (!this.playerId) return;
        const player = combat.getEntity(this.playerId);
        if (player) {
            this.setHealth(player.health);
            this.maxHealth = player.maxHealth;
            this.setAmmo(player.weapon.ammo || 0);
            this.maxAmmo = player.weapon.maxAmmo || 0;
            this.requestRedraw();
        }
    }

    dropLoot(position: [number, number, number], itemId: string) {
        const y = addon.Landscape.getHeightAt(position[0], position[2]);
        this.createTrackedCollectable({
            position: [position[0], y + 1, position[2]],
            modelPath: "Barrel1medium.glb",
            type: "quest_item",
            value: 1,
            questId: itemId,
            onCollect: () => {
                this.addItem(itemId, 1);
            }
        });
    }

    createTrackedCollectable(config: any) {
        const onCollect = config.onCollect;
        const wrappedOnCollect = (playerId: string) => {
            if (onCollect) onCollect(playerId);
            this.trackedCollectables.delete(id);
        };
        config.onCollect = wrappedOnCollect;
        const id = addon.Collectable.create(config);
        this.trackedCollectables.set(id, { position: config.position, onCollect: wrappedOnCollect });
        return id;
    }

    interact() {
        if (!this.isGameActive || this.isInventoryOpen || this.dialogue.isOpen) return;

        const [playerPos] = Entropy.Camera.getTransform();
        
        // 1. Check for nearby Collectables (range 5)
        let closestColId: string | null = null;
        let minColDist = 5.0;

        for (const [id, col] of this.trackedCollectables.entries()) {
            const dx = col.position[0] - playerPos[0];
            const dy = col.position[1] - playerPos[1];
            const dz = col.position[2] - playerPos[2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            
            if (dist < minColDist) {
                minColDist = dist;
                closestColId = id;
            }
        }

        if (closestColId) {
            const col = this.trackedCollectables.get(closestColId)!;
            col.onCollect(this.playerId!);
            addon.Collectable.remove(closestColId);
            this.trackedCollectables.delete(closestColId);
            Entropy.println("[Interaction] Collected item");
            return;
        }

        // 2. Check for nearby NPCs (range 8)
        let closestNpcId: string | null = null;
        let minNpcDist = 8.0;

        for (const [id, pos] of entityPositions.entries()) {
            if (id === this.playerId) continue;
            
            const dx = pos[0] - playerPos[0];
            const dy = pos[1] - playerPos[1];
            const dz = pos[2] - playerPos[2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist < minNpcDist) {
                minNpcDist = dist;
                closestNpcId = id;
            }
        }

        if (closestNpcId) {
            this.currentDialogueNpcId = closestNpcId;
            this.currentDialogueNode = "start";
            this.runDialogue();
        }
    }

    runDialogue() {
        if (!this.currentDialogueNpcId) return;
        
        const behaviorId = this.npcBehaviors.get(this.currentDialogueNpcId);
        if (!behaviorId) return;

        const hooks = behaviorHooks.get(behaviorId);
        if (!hooks || !hooks.onInteract) return;

        const entity = combat.getEntity(this.currentDialogueNpcId);
        if (!entity || entity.isDead) return;

        const dialogueSystem: any = {
            show: (text: string) => {}, // GameState.openDialogue called by behavior
            add_option: (text: string, next_node: string) => {},
            start_quest: (id: string) => this.startQuest(id),
            close: () => this.closeDialogue(),
            get_node: () => this.currentDialogueNode
        };
        
        hooks.onInteract({
            id: this.currentDialogueNpcId,
            name: this.currentDialogueNpcId.substring(0, 8),
            position: entityPositions.get(this.currentDialogueNpcId)!,
            health: entity.health,
            stamina: 100,
            isDead: entity.isDead
        }, dialogueSystem);
        
        Entropy.println(`[Interaction] NPC: ${this.currentDialogueNpcId}, Node: ${this.currentDialogueNode}`);
    }

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
        
        // Render Enemy Health Bar
        if (this.lastAttackedEnemyId && Date.now() - this.lastAttackedTime < 5000) {
            const enemy = combat.getEntity(this.lastAttackedEnemyId);
            if (enemy && !enemy.isDead) {
                const name = enemy.id.substring(0, 8); // Fallback to ID slice
                fpsUI.renderEnemyHealthBar(name, enemy.health, enemy.maxHealth, width, height);
            }
        }
        
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

export const gameState = new GameState();