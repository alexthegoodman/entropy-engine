import type { AddonMetadata, ScopedAPI } from "./addon";

const metadata: AddonMetadata = {
    name: "Yumon Organism",
    version: "1.0.0",
    description: "Intelligent Yumon organism roaming a 32x32 room.",
    author: ["Entropy"],
    capabilities: {
        graphics: true
    }
};

const addon: ScopedAPI = Entropy.Addon.register(metadata);

const yumonId = Entropy.generateUUID();
const modelId = Entropy.generateUUID();
const landscapeId = Entropy.generateUUID();

let lastState: any = null;
let currentWorldX = 0;
let roomCreated = false;

const createRoom = () => {
    // 1. Create a 32x32 landscape "room"
    addon.Landscape.create({
        id: landscapeId,
        width: 32,
        height: 32,
        size: 32.0,
        scale: 1.0,
        position: [0, -1, 0],
    });

    // 2. Initialize Yumon Simulation (Rust side)
    addon.Yumon.create(yumonId);

    // 3. Load the Friend1 model
    // We use a fixed ID so we can reference it in Entity updates
    addon.Model.load({
        path: "Friend1.glb",
        id: modelId,
        position: [0, 0, 0],
        scale: [1, 1, 1],
        physics: {
            bodyType: "kinematic",
            colliderShape: "cuboid",
        }
    });

    roomCreated = true;
}

addon.onInit(() => {
    Entropy.println("Yumon Addon: Initializing TypeScript version...");

    const loadData = () => {
        // const saved = addon.IO.load();
        // if (saved) {
            // state = { ...state, ...saved };
            createRoom();
        // }
    };

    addon.onProjectChanged((newProjectId) => {
        loadData();
    });

    const windowId = addon.UI.createTab({
        title: "Yumon Stats",
        onRender: () => {
            if (lastState) {
                addon.UI.Widget.label(windowId, { text: `Last Action: ${lastState.lastAction}`, bold: true });
                addon.UI.Widget.label(windowId, { text: `World X: ${currentWorldX.toFixed(2)}` });
                addon.UI.Widget.separator(windowId);
                addon.UI.Widget.label(windowId, { text: `Battery: ${(lastState.battery * 100).toFixed(1)}%` });
                addon.UI.Widget.label(windowId, { text: `Health: ${(lastState.health * 100).toFixed(1)}%` });
                addon.UI.Widget.label(windowId, { text: `Stamina: ${(lastState.stamina * 100).toFixed(1)}%` });
                addon.UI.Widget.label(windowId, { text: `Boredom: ${(lastState.boredom * 100).toFixed(1)}%` });
                addon.UI.Widget.label(windowId, { text: `Storage: ${(lastState.storage * 100).toFixed(1)}%` });
                
                addon.UI.Widget.separator(windowId);
                // if (addon.UI.Widget.button(windowId, { text: "Teleport Camera to Yumon" })) {
                //     Entropy.Camera.setTransform([currentWorldX, 5, 10], [currentWorldX, 0, 0]);
                // }
            } else {
                addon.UI.Widget.label(windowId, { text: "Waiting for simulation..." });
            }
        }
    });
});

addon.onUpdate((time: number) => {
    if (roomCreated) {
        // Tick the Yumon simulation
        const state = addon.Yumon.tick(yumonId);
        if (state) {
            lastState = state;
            
            // Map 1D pos (0-1) to 3D world space (X axis from -16 to 16)
            const targetWorldX = (state.pos * 32.0) - 16.0;
            
            // Simple P-controller for smooth movement via velocity
            // We calculate the delta and set velocity to reach the target
            const kP = 5.0; 
            const velocityX = (targetWorldX - currentWorldX) * kP;
            
            // Update the entity velocity
            Entropy.Entity.setXZVelocity(modelId, [velocityX, 0]);
            
            // Update our local tracking (or we could raycast/query actual position)
            // For kinematic movement, we'll assume it follows velocity closely
            currentWorldX += velocityX * 0.016; // Approx 60fps delta
            
            // We could also update rotation based on movement direction
            if (Math.abs(velocityX) > 0.01) {
                const rotY = velocityX > 0 ? Math.PI / 2 : -Math.PI / 2;
                Entropy.Entity.setRotation(modelId, [0, rotY, 0]);
            }
        }
    } 
});


