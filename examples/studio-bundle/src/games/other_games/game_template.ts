export const addonInfo = {
    name: "Game Template",
    version: "1.0.0",
    description: "An open game template",
    author: ["Entropy Team"],
    capabilities: {
        ui: true,
        gameplay: true,
        quests: true
    }
};

export const addon = Entropy.Addon.register(addonInfo);

// --- Game Lifecycle ---
Entropy.onGameStarted((gameName) => {
    if (gameName === addonInfo.name) {
        Entropy.Composer?.enableGameComposerOverride();

        Entropy.println("=== GAME TEMPLATE ===");

        gameState.isGameActive = true;
        gameState.requestRedraw();
        
        Entropy.println("welcome to the game template.");

        Entropy.Composer?.disableGameComposerOverride();
    }
});

Entropy.onGameStopped((gameName) => {
    if (gameName === addonInfo.name) {
        gameState.save();
        gameState.isGameActive = false;
        // worldManager.cleanup(); // example
    }
});

// --- Animation Update Loop ---
addon.onUpdatePlus("Game Composer", (time) => {
    if (gameState.isGameActive) {
        Entropy.Composer?.enableGameComposerOverride();

        gameState.update();

        // Check for inventory toggle
        if (Entropy.Input.isKeyPressed("i")) {
        }

        // --- Interaction Hooks ---
        Entropy.Input.onMouseDown((button) => {
            if (!gameState.isGameActive) return;
            
            if (button === 0) { // Left Click - Fire
            }
        });

        Entropy.Input.onKeyDown((key) => {
            if (!gameState.isGameActive) return;
            
            if (key === "w" || key === "ArrowUp") {
            }
            if (key === "s" || key === "ArrowDown") {
            }
            if (key === "Enter" || key === "e") {
            } else if (key === "e") {
            }

            if (key === "e") { // Interact
            }

            if (key === "r") { // Reload
            }

            if (key === "k") { // Simulation: Take Damage (now via combat system)
                
            }
        });

        Entropy.Input.onGamepadButton((button, pressed) => {
            if (!gameState.isGameActive || !pressed) return;

            if (button === "DPadUp") {}
            if (button === "DPadDown") {}
            if (button === "South") { // Select
            }

            if (button === "South") { // Jump placeholder / Interact
            }

            if (button === "RightTrigger" || button === "RightTrigger2") { // Fire
            }

            if (button === "West") { // Reload (Square/X)
            }
            
            if (button === "Start") {
            }
        });

        Entropy.Composer?.disableGameComposerOverride();
    }
});

// --- UI ---

addon.onInit(() => {
    // renderEngineUI(); // not needed usually

    if (Entropy.Composer) {
        if (Entropy.Composer.registerGame) {
            Entropy.Composer.registerGame(addonInfo.name, (id: string, params: any) => {                
                // worldManager.initialize(); // create landscape, meshes, load models, etc
            });
        }
    }

    Entropy.println("⚔️ GAME TEMPLATE initialized");
});

class GameState {
    playerId: string | null = null;
    isGameActive = false;
    // activeQuests: string[] = []; // example

    // Stats example
    health = 100;
    maxHealth = 100;
    ammo = 30;
    maxAmmo = 30;

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

    // example
    renderUI() {
        if (!this.isGameActive) return;
        
        addon.UI.clear();

        const [width, height] = Entropy.Window.getSize();
        
        // Render HUD via reusable system
        this.renderHealthBar(this.health, this.maxHealth);
        this.renderAmmo(this.ammo, this.maxAmmo);
    }

    renderHealthBar(health: number, maxHealth: number, x: number = 50, y: number = 50, width: number = 250, height: number = 25) {
        // Background
        addon.UI.drawRect({
            position: [x, y],
            size: [width, height],
            color: [0.1, 0.1, 0.1, 0.8],
            strokeThickness: 2,
            strokeColor: [0.8, 0.8, 0.8, 1],
            layer: 100
        });

        // Bar
        const percentage = Math.max(0, Math.min(1, health / maxHealth));
        addon.UI.drawRect({
            position: [x, y],
            size: [width * percentage, height],
            color: [1.0, 0.2, 0.2, 1.0],
            layer: 101
        });
        
        // Text (Optional: could add "100/100" text here)
    }

    renderAmmo(ammo: number, maxAmmo?: number, x: number = 50, y: number = 90) {
        const text = maxAmmo !== undefined ? `AMMO: ${ammo} / ${maxAmmo}` : `AMMO: ${ammo}`;
        addon.UI.drawText({
            text: text,
            position: [x, y],
            dimensions: [300, 40],
            fontSize: 32,
            color: [1, 1, 1, 1],
            layer: 100
        });
    }

    // example
    // completeQuest(questId: string) {
    //     handle logic
    // }
    
    save() {
        // addon.GameState.save("example_game_save", {
        //     // inventory: this.inventory, // example
        // });
        Entropy.println("[Game Saved]");
    }
    
    load() {
        // const data = addon.GameState.load("example_game_save");
        // if (data) {
        //     // this.inventory = data.inventory || {}; // example
        //     Entropy.println("[Game Loaded]");
        // }
    }
}

export const gameState = new GameState();