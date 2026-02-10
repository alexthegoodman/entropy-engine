const addonInfo = {
    name: "Horde Mode",
    version: "1.0.0",
    description: "Survive waves of melee and ranged soldiers.",
    author: ["Entropy AI"],
    capabilities: {
        ui: true,
        gameplay: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

// --- Soldier Behavior ---

Entropy.Behavior.register("horde_soldier", {
    onUpdate: (entity, system, state) => {
        if (entity.isDead) return state;

        // 1. Find Player
        const [playerPos] = Entropy.Camera.getTransform();
        
        // 2. Calculate Direction
        const dx = playerPos[0] - entity.position[0];
        const dz = playerPos[2] - entity.position[2];
        const dist = Math.sqrt(dx * dx + dz * dz);

        // 3. Move towards player if far
        if (dist > 2.5) {
            const speed = 4.0;
            const impulse = [
                (dx / dist) * speed,
                0,
                (dz / dist) * speed
            ];
            Entropy.Entity.applyImpulse(entity.id, impulse as [number, number, number]);
            Entropy.Entity.playAnimation(entity.id, "Walking");
        } else {
            // 4. Attack if close
            Entropy.Entity.playAnimation(entity.id, "Attack");
            // Every few frames, spawn some "hit" particles
            if (Math.random() > 0.95) {
                system.spawn_particles(playerPos, [1, 0.2, 0.2, 1], [0, -5, 0]);
            }
        }

        return state;
    },
    onAttack: (entity, system, state) => {
        // When the soldier is hit by the player
        system.spawn_particles(entity.position, [1, 1, 0, 1], [0, -2, 0]);
        return state;
    }
});

// --- Game Manager ---

class HordeManager {
    waveNumber = 0;
    soldiersAlive = 0;
    isGameActive = false;
    spawnTimer = 0;
    
    start() {
        this.isGameActive = true;
        this.waveNumber = 0;
        this.nextWave();
        Entropy.println("[Horde Mode] Game Started!");
    }

    nextWave() {
        this.waveNumber++;
        const count = 3 + (this.waveNumber * 2);
        this.spawnWave(count);
        Entropy.println(`[Horde Mode] Starting Wave ${this.waveNumber} (${count} enemies)`);
    }

    spawnWave(count: number) {
        const [playerPos] = Entropy.Camera.getTransform();
        const radius = 40.0;

        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const x = playerPos[0] + Math.cos(angle) * radius;
            const z = playerPos[2] + Math.sin(angle) * radius;

            addon.Model.load({
                path: "Enemy1b.glb", // Assuming this exists in the project
                position: [x, 10, z], // Spawn slightly in air to let physics drop them
                behaviorId: "horde_soldier",
                physics: {
                    bodyType: "dynamic",
                    colliderShape: "capsule"
                }
            });
            this.soldiersAlive++;
        }
    }

    update() {
        if (!this.isGameActive) return;
        
        // In a real implementation, we would track deaths via events
        // For this prototype, we'll assume wave management is manual or timed
    }
}

const manager = new HordeManager();

addon.onInit(() => {
    Entropy.println("Horde Mode Addon Initialized");

    addon.UI.createTab({
        title: "Horde Mode",
        onRender: () => {
            const windowId = "HordeModeTab";
            Entropy.UI.Widget.label(windowId, { text: "⚔️ HORDE MODE", bold: true });
            
            if (!manager.isGameActive) {
                Entropy.UI.Widget.button(windowId, {
                    text: "🚀 START GAME",
                    onClick: () => manager.start()
                });
            } else {
                Entropy.UI.Widget.label(windowId, { text: `Wave: ${manager.waveNumber}` });
                Entropy.UI.Widget.label(windowId, { text: "Status: Survival in progress..." });
                
                Entropy.UI.Widget.button(windowId, {
                    text: "🌊 Next Wave",
                    onClick: () => manager.nextWave()
                });

                Entropy.UI.Widget.button(windowId, {
                    text: "🛑 Stop Game",
                    onClick: () => {
                        manager.isGameActive = false;
                        addon.Model.clearMeshes();
                    }
                });
            }
        }
    });
});

addon.onUpdate((time) => {
    manager.update();
});
