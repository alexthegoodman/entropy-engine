import { FPSUI, type DialogueOption, type DialogueState } from "./fps_ui";
import { CombatSystem, WeaponType } from "./combat";
import { gameState } from "./state";
import { worldManager } from "./world";
import { Faction, factions, quests } from "./quests";
import { renderEngineUI } from "./engine_ui";

// Note: This game currently expects the designer to add a landscape before loading
export const addonInfo = {
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

export const addon = Entropy.Addon.register(addonInfo);
export const fpsUI = new FPSUI(addon);
export const entityPositions = new Map<string, [number, number, number]>();

export const combat = new CombatSystem(
    (id) => {
        if (id === gameState.playerId) {
            const [pos] = Entropy.Camera.getTransform();
            return pos;
        }
        return entityPositions.get(id) || null;
    },
    () => Entropy.Camera.getTransform(),
    addon.Audio
);


// --- Game Lifecycle ---
Entropy.onGameStarted((gameName) => {
    if (gameName === addonInfo.name) {
        Entropy.Composer?.enableGameComposerOverride();

        Entropy.println("=== THE FRACTURED REALM ===");

        gameState.isGameActive = true;
        gameState.requestRedraw();
        
        Entropy.println("Choose your path wisely. Every action has consequences.");

        Entropy.Composer?.disableGameComposerOverride();
    }
});

Entropy.onGameStopped((gameName) => {
    if (gameName === addonInfo.name) {
        gameState.save();
        gameState.isGameActive = false;
        worldManager.cleanup();
    }
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
            if (combat.attack(gameState.playerId!, true)) {
                combat.playFireSound();
                const weapon = combat.getWeapon(gameState.playerId!);
                if (weapon) {
                    gameState.setAmmo(weapon.ammo || 0);
                }
            } else {
                const weapon = combat.getWeapon(gameState.playerId!);
                if (weapon?.type === WeaponType.RANGED && !combat.hasAmmo(gameState.playerId!)) {
                    combat.playEmptySound();
                    Entropy.println("Click! Out of ammo.");
                }
            }
        }
    });

    Entropy.Input.onKeyDown((key) => {
        if (!gameState.isGameActive) return;

        if (gameState.dialogue.isOpen) {
            if (key === "w" || key === "ArrowUp") {
                gameState.navigateDialogue(-1);
            }
            if (key === "s" || key === "ArrowDown") {
                gameState.navigateDialogue(1);
            }
            if (key === "Enter" || key === "e") {
                if (gameState.dialogue.isOpen) {
                    gameState.selectDialogueOption();
                } else if (key === "e") {
                    gameState.interact();
                }
            }
            return;
        }

        if (key === "e") { // Interact
            gameState.interact();
        }

        if (key === "r") { // Reload
            if (combat.reload(gameState.playerId!)) {
                combat.playReloadSound();
                const weapon = combat.getWeapon(gameState.playerId!);
                if (weapon) {
                    gameState.setAmmo(weapon.ammo || 0);
                }
                Entropy.println("Reloading...");
            }
        }

        if (key === "k") { // Simulation: Take Damage (now via combat system)
            const player = combat.getEntity(gameState.playerId!);
            if (player) {
                player.health = Math.max(0, player.health - 10);
                gameState.setHealth(player.health);
                combat.playDamageSound();
            }
        }
    });

    Entropy.Input.onGamepadButton((button, pressed) => {
        if (!gameState.isGameActive || !pressed) return;

        if (gameState.dialogue.isOpen) {
            if (button === "DPadUp") gameState.navigateDialogue(-1);
            if (button === "DPadDown") gameState.navigateDialogue(1);
            if (button === "South") { // Select
                gameState.selectDialogueOption();
            }
            return;
        }

        if (button === "South") { // Jump placeholder / Interact
             gameState.interact();
        }

        if (button === "RightTrigger" || button === "RightTrigger2") { // Fire
            if (combat.attack(gameState.playerId!, true)) {
                combat.playFireSound();
                const weapon = combat.getWeapon(gameState.playerId!);
                if (weapon) {
                    gameState.setAmmo(weapon.ammo || 0);
                }
            } else {
                const weapon = combat.getWeapon(gameState.playerId!);
                if (weapon?.type === WeaponType.RANGED && !combat.hasAmmo(gameState.playerId!)) {
                    combat.playEmptySound();
                    Entropy.println("Click! Out of ammo.");
                }
            }
        }

        if (button === "West") { // Reload (Square/X)
            if (combat.reload(gameState.playerId!)) {
                combat.playReloadSound();
                const weapon = combat.getWeapon(gameState.playerId!);
                if (weapon) {
                    gameState.setAmmo(weapon.ammo || 0);
                }
                Entropy.println("Reloading (Gamepad)...");
            }
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

    Entropy.Composer?.disableGameComposerOverride();
});

// --- UI ---

addon.onInit(() => {
    renderEngineUI();

    if (Entropy.Composer) {
        if (Entropy.Composer.registerGame) {
            Entropy.Composer.registerGame(addonInfo.name, (id: string, params: any) => {                
                worldManager.initialize();
            });
        }
    }

    Entropy.println("⚔️ THE FRACTURED REALM initialized");
});