import type { GlobalSettings } from "./addon";

const addonInfo = {
    name: "Game Composer",
    version: "2.0.0",
    description: "Advanced Scene Composition and Component management",
    author: ["Entropy Team"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

interface ComponentInstance {
    id: string;
    name: string;
    addon: string;
    componentId: string; // The ID from the addon's registry
    params?: any; // Deprecated: params are stored in each addons own file. We now fetch them dynamically.
    position: [number, number, number];
    scale: [number, number, number];
    visible: boolean;
    yumonBrainId?: string;
    // Per-field editor overrides. These always win over the source addon's live
    // params (see renderInstance) so an editor tweak survives the source addon
    // re-registering its component with fresh defaults.
    overrides?: Record<string, any>;
}

let composerState: {
    roles: Record<string, string>;
    activeInstanceId: string | null;
    components: ComponentInstance[];
    playMode: boolean;
    gameAdded: string | null;
    globalSettings?: GlobalSettings;
    yumonSettings: {
        archetypes: ["Berserker", "Coward", "Support"],
        activeRecordingBrainId: string | null,
        isRecording: boolean,
        createdBrains: string[],
        epochsToTrain: Record<string, number>
    }
    } = {
    roles: {
        "Vegetation": "default",
        "Terrain": "default",
        "Sky": "default",
        "Water": "default",
        "Lighting": "default"
    },
    activeInstanceId: null,
    components: [],
    playMode: false,
    // The game (from `gameAddons`) currently associated with/added to this
    // project's composition. Persisted via addon.IO so it's restored when the
    // project reloads, mirroring the sidebar's preferred-addon behavior.
    gameAdded: null,
    globalSettings: {
        landscapeSettings: {
            size: 4096,
            height: 600,
            yOffset: -500
        }
    },
    yumonSettings: {
        archetypes: ["Berserker", "Coward", "Support"],
        activeRecordingBrainId: null,
        isRecording: false,
        createdBrains: [],
        epochsToTrain: {
            "Berserker": 10,
            "Coward": 10,
            "Support": 10
        }
    }
    };

    let brainStates: Record<string, any> = {};
    let lastMoment: number[] = [];
    let lastAction: number | null = null;
    let lastThreatAngle: number | null = null;
    let lastRotation: number | null = null;

    let activeProjectId: string | null = null;

function raySphereIntersect(
    rayOrigin: [number, number, number],
    rayDir: [number, number, number],
    sphereCenter: [number, number, number],
    sphereRadius: number
): { distance: number } | null {
    const ox = rayOrigin[0] - sphereCenter[0];
    const oy = rayOrigin[1] - sphereCenter[1];
    const oz = rayOrigin[2] - sphereCenter[2];
    
    const a = rayDir[0] * rayDir[0] + rayDir[1] * rayDir[1] + rayDir[2] * rayDir[2];
    const b = 2 * (ox * rayDir[0] + oy * rayDir[1] + oz * rayDir[2]);
    const c = ox * ox + oy * oy + oz * oz - sphereRadius * sphereRadius;
    
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0) return null;
    
    return { distance: t };
}

let sectionsOpen = {
    hierarchy: true,
    inspector: true,
    library: false,
    addEntity: false,
    yumonAI: false
};

// Translate-only gizmo tracking (rotate/scale still edited via Inspector sliders -
// the engine only feeds a real transform to the addon gizmo in translate mode).
let activeGizmoId: string | null = null;
let lastGizmoInstanceId: string | null = null;

function trySelectAt(x: number, y: number) {
    const ray = Entropy.Camera?.screenToWorldRay(x, y);
    if (!ray) return;

    let bestId: string | null = null;
    let bestDist = Infinity;
    composerState.components.forEach(inst => {
        if (!inst.visible) return;
        const hit = raySphereIntersect(ray.origin, ray.direction, inst.position, 1.5);
        if (hit && hit.distance < bestDist) {
            bestDist = hit.distance;
            bestId = inst.id;
        }
    });
    composerState.activeInstanceId = bestId;
}

function syncGizmoToSelection() {
    if (composerState.activeInstanceId === lastGizmoInstanceId) return;
    lastGizmoInstanceId = composerState.activeInstanceId;

    if (activeGizmoId) {
        Entropy.Gizmo?.hide(activeGizmoId);
        activeGizmoId = null;
    }

    const inst = composerState.components.find(c => c.id === composerState.activeInstanceId);
    if (inst && Entropy.Gizmo) {
        activeGizmoId = Entropy.Gizmo.show({
            position: inst.position,
            mode: "translate",
            space: "world",
            onTransform: (delta) => {
                inst.position = [
                    inst.position[0] + delta[0],
                    inst.position[1] + delta[1],
                    inst.position[2] + delta[2]
                ];
                renderInstance(inst);
            }
        });
    }
}

function addInstance(opts: {
    id?: string;
    addonName: string;
    componentId: string;
    name: string;
    position?: [number, number, number];
    scale?: [number, number, number];
}): ComponentInstance {
    const newInst: ComponentInstance = {
        id: opts.id || Entropy.generateUUID(),
        name: opts.name,
        addon: opts.addonName,
        componentId: opts.componentId,
        position: opts.position || [0, 0, 0],
        scale: opts.scale || [1, 1, 1],
        visible: true,
        overrides: {}
    };
    composerState.components.push(newInst);
    return newInst;
}

// Picks up instances announced via Entropy.Composer.registerInstance (e.g. models
// spawned directly in Model Viewer) that aren't already tracked here. Additive only -
// never touches an existing instance, so user edits are never clobbered.
function reconcileInstances() {
    const registry = Entropy.Composer?.getInstances ? Entropy.Composer.getInstances() : {};
    Object.keys(registry).forEach(instanceId => {
        if (composerState.components.some(c => c.id === instanceId)) return;

        const rec = registry[instanceId];
        const comp = (Entropy.Composer?.getComponents(rec.addonName) || {})[rec.componentId];
        addInstance({
            id: instanceId,
            addonName: rec.addonName,
            componentId: rec.componentId,
            name: (comp?.name || rec.componentId) + " Instance",
            position: rec.defaults?.position,
            scale: rec.defaults?.scale
        });
    });
}

const availablePipelines = [
    "default", 
    "custom_hair_shader_enhanced", 
    "terrain_green", 
    "environment_lighting", 
    "WaterPipeline",
    "wireframe"
];

// NOTE: make this dynamic
const sourceAddons = [
    "FFT Ocean",
    "FFT River Water", 
    "FlexNoise Terrain",
    "Hair Particles with Ornaments",
    "PBR Texture Designer Pro",
    "Light Hive",
    "Model Viewer",
    "GPGPU River Simulation",
    "Yumon Organism"
];

// TODO: make this dynamic
const gameAddons = [
    "The Fractured Realm",
    "Cannabis Conquest"
];

// Renders a single instance. Split out from refreshScene so a gizmo drag or a
// single Inspector field edit only re-renders the one instance that changed,
// instead of re-invoking every visible instance's renderer on every tick.
function renderInstance(inst: ComponentInstance) {
    if (!inst.visible) return;

    // Use context override so everything spawned belongs to "Game Composer" bucket in Rust
    Entropy.Composer?.enableGameComposerOverride();

    const renderer = Entropy.Composer?.getRenderer(inst.addon);

    // Fetch the latest params from the source addon
    const components = Entropy.Composer?.getComponents(inst.addon) || {};
    const sourceParams = components[inst.componentId]?.params;

    // Fallback to inst.params if source is missing (legacy support), or {}
    // Editor overrides always win over whatever the source addon currently reports.
    const paramsToUse = { ...(sourceParams || inst.params || {}), ...(inst.overrides || {}) };

    if (renderer) {
        // Pass transform data so the renderer can position the mesh
        const renderParams = {
            ...paramsToUse,
            _transform: {
                position: inst.position,
                scale: inst.scale
            }
        };

        renderer(inst.id, renderParams);
    }

    Entropy.Composer?.disableGameComposerOverride();
}

function refreshScene() {
    // Clear existing meshes owned by Game Composer (implicit in how Addons work usually,
    // but if we want to be safe we might need a clear command.
    // For now, re-running renderers usually overwrites if IDs match).
    composerState.components.forEach(inst => renderInstance(inst));
}

// runs after all projects are loaded in non-composer addons
addon.onAllProjectsLoaded(() => {
    Entropy.println("[Game Composer] All projects loaded...");

    const data = addon.IO.load();
    if (data) {
        composerState = { ...composerState, ...data };

        if (composerState.globalSettings) {
            Entropy.Composer?.setGlobalSettings(composerState.globalSettings);
        }

        refreshScene(); // until we clear, lets avoid this?

        // Restore the previously-associated game's visuals, if any.
        if (composerState.gameAdded) {
            (globalThis as any).__entropy_current_addon_context_override = "Game Composer";
            const renderer = Entropy.Composer?.getGame(composerState.gameAdded);
            if (renderer) {
                renderer(composerState.gameAdded, {});
            }
            (globalThis as any).__entropy_current_addon_context_override = null;
        }
    }
});

addon.onInit(async () => {
    Entropy.println("Game Composer 2.0 Initializing...");

    // Atmospheric lighting
    addon.Lighting.createPointLight({
        position: [-3.0, 4.0, 65.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    addon.Lighting.createPointLight({
        position: [3.0, 4.0, 10.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    addon.Lighting.createPointLight({
        position: [0.0, 5.0, -60.0],
        color: [0.9, 0.9, 0.9],
        intensity: 8.0,
        maxDistance: 350.0
    });

    // --- Recording Logic ---
    let lastTickTime = 0;
    const TICK_MS = 500;
    let recordedActionThisTick: number = 11; // Idle
    let currentLeftStick: [number, number] = [0, 0];
    let currentRightStick: [number, number] = [0, 0];

    addon.onUpdate((time, pos, dir) => {
        if (!composerState.yumonSettings.isRecording || !composerState.yumonSettings.activeRecordingBrainId) return;

        // Event listeners for "one-shot" actions (Jump, Attack, etc.)
        // These ensure we don't miss a quick tap that happens between 500ms ticks.
        Entropy.Input.onKeyDown((key) => {
            if (!composerState.yumonSettings.isRecording) return;
            
            if (key === "Space") recordedActionThisTick = 2;      // ButtonA (Jump)
            else if (key === "ShiftLeft") recordedActionThisTick = 3; // ButtonB (Dodge)
            else if (key === "KeyE") recordedActionThisTick = 4; // ButtonX (Attack Light)
            else if (key === "KeyQ") recordedActionThisTick = 5; // ButtonY (Attack Heavy)
        });

        Entropy.Input.onMouseDown((btn) => {
            if (!composerState.yumonSettings.isRecording) return;
            if (btn === 0) recordedActionThisTick = 4; // Left Click -> Attack Light
            if (btn === 1) recordedActionThisTick = 5; // Right Click -> Attack Heavy
        });

        Entropy.Input.onGamepadButton((btn, pressed) => {
            // Entropy.println("gamepad button 2 " + btn + " " + pressed);
            if (!composerState.yumonSettings.isRecording || !pressed) return;
            
            // Mapping typical Gamepad strings (based on Gilrs/Winit mapping) also mapped in yumon/system.rs to Action
            if (btn === "South") recordedActionThisTick = 2;      // A / Cross (Jump)
            else if (btn === "East") recordedActionThisTick = 3;  // B / Circle (Dodge)
            else if (btn === "West") recordedActionThisTick = 4;  // X / Square (Attack L)
            else if (btn === "North") recordedActionThisTick = 5; // Y / Triangle (Attack H)
            else if (btn === "LeftTrigger2") recordedActionThisTick = 6; // ads
            else if (btn === "RightTrigger2") recordedActionThisTick = 7; //  ranged attack
            else if (btn === "LeftTrigger") recordedActionThisTick = 8;
            else if (btn === "RightTrigger") recordedActionThisTick = 9;
        });

        Entropy.Input.onGamepadAxis((left, right) => {
            currentLeftStick = left;
            currentRightStick = right;
        });

        const now = Date.now();
        if (now - lastTickTime < TICK_MS) return;
        lastTickTime = now;

        const [camPos, camDir] = Entropy.Camera.getTransform();
        const brainId = composerState.yumonSettings.activeRecordingBrainId;

        // 1. Build World State (Normalized)
        const world = new Array(16).fill(0);
        
        // Find nearest entities
        let nearestObstacleDist = 1000;
        let nearestObstacleAngle = 0;
        let nearestPlayerDist = 1000;
        let nearestPlayerAngle = 0;
        let nearestAllyDist = 1000;
        let nearestAllyAngle = 0;
        let nearestThreatDist = 1000;
        let nearestThreatAngle = 0;
        let nearbyEnemyCount = 0;
        let nearbyAllyCount = 0;
        let isPathBlocked = false;

        const forward = [dir[0], 0, dir[2]];
        const forwardMag = Math.sqrt(forward[0]*forward[0] + forward[2]*forward[2]);
        const normForward = [forward[0]/forwardMag, 0, forward[2]/forwardMag];

        // composerState.components.forEach(inst => {
        Entropy.Composer?.getNPCs().forEach(inst => {
            const dx = inst.position[0] - camPos[0];
            const dy = inst.position[1] - camPos[1];
            const dz = inst.position[2] - camPos[2];
            const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

            // Entropy.println("inst.position: " + JSON.stringify(inst.position) + " camPos: " + JSON.stringify(camPos) + " dist: " + dist);

            // Calculate ego-centric angle (-1 to 1, where 0 is directly forward)
            const targetDir = [dx/dist, 0, dz/dist];
            const dot = targetDir[0] * normForward[0] + targetDir[2] * normForward[2];
            const det = targetDir[0] * normForward[2] - targetDir[2] * normForward[0];
            const angle = Math.atan2(det, dot) / Math.PI;

            // Convert your absolute sin/cos rotation to a heading angle (radians)
            const playerHeadingRad = Math.atan2(normForward[0], normForward[2]); // world-space heading
            let absRad = playerHeadingRad + angle * Math.PI;
            // Normalize to (-π, π]
            absRad = (absRad + Math.PI) % (2 * Math.PI) - Math.PI;
            const worldAngle = absRad / Math.PI;

            const isNPC = inst.type === "Enemy" || inst.type === "Friendly";
            const isEnemy = inst.type === "Enemy";
            const isAlly = isNPC && !isEnemy;

            // World-space absolute rotation / angle towards the threat (-1 to 1, where 0 = world +Z axis)
            // const worldAngle = Math.atan2(dx, dz) / Math.PI;

            if (isNPC) {
                if (isEnemy) {
                    if (dist < nearestThreatDist) {
                        nearestThreatDist = dist;
                        nearestThreatAngle = worldAngle; // absolute, matches your sin/cos rotation space
                    }
                    // if (dist < nearestThreatDist) {
                    //     nearestThreatDist = dist;
                    //     nearestThreatAngle = angle;
                    // }
                    if (dist < 20) nearbyEnemyCount++;
                } else if (isAlly) {
                    if (dist < nearestAllyDist) {
                        nearestAllyDist = dist;
                        nearestAllyAngle = worldAngle; // absolute, matches your sin/cos rotation space
                    }
                    // if (dist < nearestAllyDist) {
                    //     nearestAllyDist = dist;
                    //     nearestAllyAngle = angle;
                    // }
                    if (dist < 20) nearbyAllyCount++;
                }
            } else {
                if (dist < nearestObstacleDist) {
                    nearestObstacleDist = dist;
                    nearestObstacleAngle = worldAngle; // absolute, matches your sin/cos rotation space
                }
                // Not an NPC, so it's an obstacle
                // if (dist < nearestObstacleDist) {
                //     nearestObstacleDist = dist;
                //     nearestObstacleAngle = angle;
                // }
                
                // Ray-sphere collision to check if it's blocking our path (radius approximated by average scale)
                // const radius = inst.scale ? (inst.scale[0] + inst.scale[1] + inst.scale[2]) / 3.0 : 1.0;
                const radius = 1.0;
                const hit = raySphereIntersect(camPos, [normForward[0], 0, normForward[2]], inst.position, radius * 1.5);
                if (hit && hit.distance < 5.0) {
                    isPathBlocked = true;
                }
            }

            //  Entropy.println(
            //     "enemy=" + inst.id +
            //     " dist=" + dist.toFixed(2) +
            //     " angle=" + worldAngle.toFixed(3)
            // );
        });

        // Populate World State (Indices from system.rs)
        world[0] = Math.min(nearestObstacleDist / 100, 1.0);
        world[1] = nearestObstacleAngle;
        world[2] = 0.0; // NearestPlayerDist (0 for self if designer is playing as NPC)
        world[3] = 0.0; // NearestPlayerAngle
        world[4] = Math.min(nearestAllyDist / 100, 1.0);
        world[5] = nearestAllyAngle;
        world[6] = Math.min(nearestThreatDist / 100, 1.0);
        world[7] = nearestThreatAngle;
        world[8] = 0; // IsInCover (placeholder)
        world[9] = isPathBlocked ? 0 : 1; // PathClearForward
        world[10] = Math.min(nearbyEnemyCount / 10, 1.0);
        world[11] = Math.min(nearbyAllyCount / 10, 1.0);
        world[12] = nearestThreatDist < 15 ? 1.0 : (nearestThreatDist < 40 ? 0.5 : 0.0); // AlertLevel
        world[15] = 0.8; // LightLevel

        // 2. Build Self State
        const self = new Array(8).fill(0);
        self[0] = 1.0; // Health
        self[1] = 1.0; // Stamina
        self[3] = 1.0; // IsGrounded
        self[5] = 0.5; // Speed (normalized)
        self[6] = (now % 10000) / 10000; // Clock (0..1 cycle)

        // 3. Resolve Action
        let actionIdx = recordedActionThisTick;

        // If no one-shot event occurred, check polling for sustained movement
        if (actionIdx === 11) {
            // Check Joystick (Left Stick Y for Forward/Backward)
            if (currentLeftStick[1] > 0.3) actionIdx = 0; // MoveForward
            else if (currentLeftStick[1] < -0.3) actionIdx = 1; // MoveBackward
        }

        // 4. Capture Absolute Rotation (Normalized -1..1)
        const absoluteRotation = Math.atan2(dir[0], dir[2]) / Math.PI;

        // Entropy.println("actionIdx: " + actionIdx);

        const reward = 0.1; 

        lastMoment = [...world, ...self];
        lastAction = actionIdx;
        lastThreatAngle = nearestThreatAngle;
        lastRotation = absoluteRotation;
        addon.Yumon.brain.observe(brainId, world, self, actionIdx, absoluteRotation, reward);

        recordedActionThisTick = 11; // Reset for next tick

        // Update brain states for UI display
        composerState.yumonSettings.archetypes.forEach(arch => {
            try {
                brainStates[arch] = addon.Yumon.brain.getState(arch);
            } catch(e) {}
        });

    //    Entropy.println(
    //         "player=" + absoluteRotation.toFixed(3) +
    //         " nearestThreat=" + nearestThreatAngle.toFixed(3)
    //     );
    });

    const tab = addon.UI.createTab({
        title: "Game Composer",
        onRender: () => {
            // Hide other addons' internal outputs when viewing the composer
            sourceAddons.forEach(name => {
                Entropy.Addon.setVisibility(name, false);
            });
            // Always show our own managed components
            Entropy.Addon.setVisibility("Game Composer", true);

            // Pick up instances announced by other addons (e.g. models spawned
            // directly in Model Viewer) that aren't in our list yet.
            reconcileInstances();

            // Re-arm click-to-select every frame this tab is open, same idiom the
            // Yumon recording logic below uses - Entropy.Input.onMouseDown is a
            // single global slot, so whoever last (re-)registers it each frame wins.
            // Skip while recording a Yumon session so the two don't fight over clicks.
            Entropy.Input.onMouseDown((btn, x, y) => {
                if (btn !== 0) return;
                if (composerState.yumonSettings.isRecording) return;
                trySelectAt(x, y);
            });

            syncGizmoToSelection();

            Entropy.UI.Widget.horizontal(tab, (trainTab) => {
                // === TOOLBAR ===
                Entropy.UI.Widget.button(trainTab, {
                    text: "💾 Save Scene",
                    onClick: () => {
                        // Clean up params from components before saving
                        const cleanState = {
                            ...composerState,
                            components: composerState.components.map(c => {
                                // Explicitly destructure to remove params, even if undefined
                                const { params, ...rest } = c;
                                return rest;
                            })
                        };
                        addon.IO.save(cleanState);
                        Entropy.println("Composition saved!");
                    }
                });
                
                Entropy.UI.Widget.button(trainTab, {
                    text: "🔄 Refresh Scene",
                    onClick: () => refreshScene()
                });
            });

            Entropy.UI.Widget.collapsingHeader(tab, "Game Preview", (headerTab) => {
                if (composerState.gameAdded) {
                    Entropy.UI.Widget.label(headerTab, { text: `✔ ${composerState.gameAdded}`, bold: true });

                    Entropy.UI.Widget.horizontal(headerTab, (hTab) => {
                        Entropy.UI.Widget.button(hTab, {
                            text: composerState.playMode ? "⏹ Stop Game" : "▶ Play Game",
                            onClick: () => {
                                if (composerState.gameAdded) {
                                    Entropy.println("Updating game status...");

                                    composerState.playMode = !composerState.playMode;
                                    Entropy.setGameMode(composerState.playMode);

                                    if (composerState.playMode) {
                                        Entropy._dispatchGameStarted(composerState.gameAdded);
                                        Entropy.println("Game started!");
                                    } else {
                                        Entropy._dispatchGameStopped(composerState.gameAdded);
                                        Entropy.println("Game stopped!");
                                    }
                                }
                            }
                        });

                        Entropy.UI.Widget.button(hTab, {
                            text: "🗑 Unload Game",
                            onClick: () => {
                                const previousGame = composerState.gameAdded;
                                if (!previousGame) return;

                                // Make sure we're not mid-play before tearing down.
                                if (composerState.playMode) {
                                    composerState.playMode = false;
                                    Entropy.setGameMode(false);
                                    Entropy._dispatchGameStopped(previousGame);
                                    Entropy.println("Game stopped!");
                                }

                                // Hide the previous game's rendered visuals so nothing lingers
                                // in the viewport before a new one is added.
                                Entropy.Addon.setVisibility(previousGame, false);

                                composerState.gameAdded = null;
                                Entropy.println("Unloaded game: " + previousGame);
                            }
                        });
                    });
                } else {
                    // in liue of a register system dedicated to the composer
                    // actually, registerGame, then let the user seslect one to restore, bingo
                    gameAddons.forEach((addonName) => {
                        Entropy.UI.Widget.button(headerTab, {
                            text: "🔄 Add Game: " + addonName,
                            onClick: () => {
                                (globalThis as any).__entropy_current_addon_context_override = "Game Composer";

                                Entropy.println("Adding game: " + addonName);

                                const renderer = Entropy.Composer?.getGame(addonName);

                                composerState.gameAdded = addonName;
                                Entropy.Addon.setVisibility(addonName, true);

                                if (renderer) {
                                    Entropy.println("Game Composer Game render ... ");
                                    renderer(addonName, {});
                                }

                                (globalThis as any).__entropy_current_addon_context_override = null;
                            }
                        });
                    });
                }
            });

            // tl;dr:
            // this is too complex to all be centralized into one view
            // i appreciate the desire to make certain edits convenient and in-context
            // but we need to carefully weigh the tradeoffs

            // // === MANAGE COMPONENTS ===
            // Entropy.UI.Widget.label(tab, { text: "Manage Components", bold: true });

            // if (Entropy.Composer && Entropy.Composer.editors) {
            //     Object.keys(Entropy.Composer.editors).forEach(addonName => {
            //         Entropy.UI.Widget.collapsingHeader(tab, addonName, (headerTab) => {
            //             Entropy.Composer!.enableGameComposerOverride();
            //             const renderFn = Entropy.Composer!.editors[addonName];
            //             if (renderFn) {
            //                 renderFn(headerTab, "Game Composer");
            //             }
            //             Entropy.Composer!.disableGameComposerOverride();
            //         });
            //     });
            // }

            // Entropy.UI.Widget.separator(tab);

            // === COMPONENT LIBRARY ===
            Entropy.UI.Widget.horizontal(tab, (libTab) => {
                Entropy.UI.Widget.button(libTab, {
                    text: (sectionsOpen.library ? "▼ " : "▶ ") + "Add Component",
                    onClick: () => { sectionsOpen.library = !sectionsOpen.library; }
                });

                // Convenience import, without leaving Game Composer. This calls
                // straight into Model Viewer's own import pipeline (registered via
                // Entropy.Composer.registerAction) instead of duplicating it here,
                // so the imported model stays owned/persisted by Model Viewer and
                // still shows up wherever "Model Viewer" components normally do.
                const importModel = Entropy.Composer?.getAction("Model Viewer", "importModel");
                if (importModel) {
                    Entropy.UI.Widget.button(libTab, {
                        text: "📂 Import Model",
                        onClick: async () => {
                            const result = await importModel();
                            if (result && result.id) {
                                reconcileInstances();
                                composerState.activeInstanceId = result.id;
                                refreshScene();
                            }
                        }
                    });
                }
            });

            if (sectionsOpen.library) {
                let hasComponents = false;
                sourceAddons.forEach(addonName => {
                    const components = Entropy.Composer?.getComponents(addonName) || {};
                    const ids = Object.keys(components);
                    if (ids.length > 0) {
                        hasComponents = true;
                        Entropy.UI.Widget.label(tab, { text: `▶ ${addonName}` }); // Group Header
                        ids.forEach(compId => {
                            const comp = components[compId];
                            Entropy.UI.Widget.button(tab, {
                                text: `  ➕ ${comp.name}`,
                                onClick: () => {
                                    const newInst = addInstance({
                                        addonName,
                                        componentId: compId,
                                        name: `${comp.name} Instance`
                                    });
                                    composerState.activeInstanceId = newInst.id;
                                    refreshScene();
                                }
                            });
                        });
                    }
                });
                
                if (!hasComponents) {
                    Entropy.UI.Widget.label(tab, { text: "No components found. Create them in other addons first!" });
                }
            }

            Entropy.UI.Widget.separator(tab);

            // === HIERARCHY (all placed components, including ones spawned
            // programmatically elsewhere via Entropy.Composer.registerInstance) ===
            Entropy.UI.Widget.button(tab, {
                text: (sectionsOpen.hierarchy ? "▼ " : "▶ ") + `Hierarchy (${composerState.components.length})`,
                onClick: () => { sectionsOpen.hierarchy = !sectionsOpen.hierarchy; }
            });

            if (sectionsOpen.hierarchy) {
                if (composerState.components.length === 0) {
                    Entropy.UI.Widget.label(tab, { text: "No components placed yet." });
                }
                composerState.components.forEach(inst => {
                    Entropy.UI.Widget.horizontal(tab, (hTab) => {
                        const isActive = composerState.activeInstanceId === inst.id;
                        Entropy.UI.Widget.button(hTab, {
                            text: (isActive ? "● " : "○ ") + inst.name,
                            onClick: () => { composerState.activeInstanceId = inst.id; }
                        });
                        Entropy.UI.Widget.checkbox(hTab, {
                            label: "Visible",
                            value: inst.visible,
                            onChange: (v) => { inst.visible = v; refreshScene(); }
                        });
                        Entropy.UI.Widget.button(hTab, {
                            text: "🗑",
                            onClick: () => {
                                composerState.components = composerState.components.filter(c => c.id !== inst.id);
                                if (composerState.activeInstanceId === inst.id) composerState.activeInstanceId = null;
                            }
                        });
                    });
                });
            }

            Entropy.UI.Widget.separator(tab);

            // === INSPECTOR (only rendered for the currently selected component,
            // so we don't overwhelm the user with every addon's settings at once) ===
            Entropy.UI.Widget.button(tab, {
                text: (sectionsOpen.inspector ? "▼ " : "▶ ") + "Inspector",
                onClick: () => { sectionsOpen.inspector = !sectionsOpen.inspector; }
            });

            if (sectionsOpen.inspector) {
                const inst = composerState.components.find(c => c.id === composerState.activeInstanceId);
                if (!inst) {
                    Entropy.UI.Widget.label(tab, { text: "Select a component (in the viewport or Hierarchy) to inspect it." });
                } else {
                    Entropy.UI.Widget.label(tab, { text: inst.name, bold: true });

                    (["X", "Y", "Z"] as const).forEach((axis, i) => {
                        Entropy.UI.Widget.numericInput(tab, {
                            label: "Position " + axis,
                            value: inst.position[i],
                            onChange: (v) => {
                                const n = parseFloat(v);
                                if (!isNaN(n)) {
                                    inst.position[i] = n;
                                    renderInstance(inst);
                                }
                            }
                        });
                    });
                    (["X", "Y", "Z"] as const).forEach((axis, i) => {
                        Entropy.UI.Widget.numericInput(tab, {
                            label: "Scale " + axis,
                            value: inst.scale[i],
                            onChange: (v) => {
                                const n = parseFloat(v);
                                if (!isNaN(n)) {
                                    inst.scale[i] = n;
                                    renderInstance(inst);
                                }
                            }
                        });
                    });
                    Entropy.UI.Widget.checkbox(tab, {
                        label: "Visible",
                        value: inst.visible,
                        onChange: (v) => { inst.visible = v; refreshScene(); }
                    });

                    // Addon-supplied "complex" property view, scoped to just this
                    // selection (Entropy.Composer.editors already exists and is
                    // populated by ~10 addons - it was never shown here before
                    // because rendering ALL of them at once was overwhelming).
                    const editorFn = Entropy.Composer?.getEditor(inst.addon);
                    if (editorFn) {
                        Entropy.UI.Widget.collapsingHeader(tab, `${inst.addon} Settings`, (eTab) => {
                            Entropy.Composer!.enableGameComposerOverride();
                            editorFn(eTab, inst.id);
                            Entropy.Composer!.disableGameComposerOverride();
                        });
                    }

                    // Generic per-field overrides: any primitive field the source
                    // component currently reports can be pinned to an editor-chosen
                    // value that survives the source addon re-registering.
                    const sourceParams = (Entropy.Composer?.getComponents(inst.addon) || {})[inst.componentId]?.params || {};
                    const overridableKeys = Object.keys(sourceParams).filter(k => {
                        const v = sourceParams[k];
                        return typeof v === "number" || typeof v === "boolean" || typeof v === "string";
                    });
                    if (overridableKeys.length > 0) {
                        Entropy.UI.Widget.collapsingHeader(tab, "Overrides", (oTab) => {
                            overridableKeys.forEach(key => {
                                inst.overrides = inst.overrides || {};
                                const hasOverride = Object.prototype.hasOwnProperty.call(inst.overrides, key);
                                const current = hasOverride ? inst.overrides[key] : sourceParams[key];

                                Entropy.UI.Widget.horizontal(oTab, (rowTab) => {
                                    if (typeof sourceParams[key] === "boolean") {
                                        Entropy.UI.Widget.checkbox(rowTab, {
                                            label: key,
                                            value: !!current,
                                            onChange: (v) => {
                                                inst.overrides![key] = v;
                                                renderInstance(inst);
                                            }
                                        });
                                    } else if (typeof sourceParams[key] === "number") {
                                        Entropy.UI.Widget.numericInput(rowTab, {
                                            label: key,
                                            value: current,
                                            onChange: (v) => {
                                                const n = parseFloat(v);
                                                if (!isNaN(n)) {
                                                    inst.overrides![key] = n;
                                                    renderInstance(inst);
                                                }
                                            }
                                        });
                                    } else {
                                        Entropy.UI.Widget.label(rowTab, { text: `${key}: ${current}` });
                                    }

                                    if (hasOverride) {
                                        Entropy.UI.Widget.button(rowTab, {
                                            text: "↺",
                                            onClick: () => {
                                                delete inst.overrides![key];
                                                renderInstance(inst);
                                            }
                                        });
                                    }
                                });
                            });
                        });
                    }
                }
            }

            Entropy.UI.Widget.separator(tab);

            // === YUMON AI ===
            // Entropy.UI.Widget.collapsingHeader(tab, "📖 How to use Yumon AI", (hTab) => {
            //     Entropy.UI.Widget.label(hTab, {
            //         text: "1. Click 'Create' on an Archetype (e.g. Berserker)."
            //     });
            //     Entropy.UI.Widget.label(hTab, {
            //         text: "2. Select that Archetype in the 'Target Archetype' dropdown below."
            //     });
            //     Entropy.UI.Widget.label(hTab, {
            //         text: "3. Click 'Record Designer Session' and move/attack (WASD, Space, Shift, E, Q)."
            //     });
            //     Entropy.UI.Widget.label(hTab, {
            //         text: "4. Click 'Stop Recording' when finished."
            //     });
            //     Entropy.UI.Widget.label(hTab, {
            //         text: "5. Click 'Train' on the Archetype to run Behavior Cloning."
            //     });
            //     Entropy.UI.Widget.label(hTab, {
            //         text: "6. Click 'Save' to persist your trained model."
            //     });
            // });

            Entropy.UI.Widget.button(tab, {
                text: (sectionsOpen.yumonAI ? "▼ " : "▶ ") + "Yumon AI System",
                onClick: () => { sectionsOpen.yumonAI = !sectionsOpen.yumonAI; }
            });

            if (sectionsOpen.yumonAI) {
                // LATER: gracefully save when only Moments are recorded, but no training has been done (also gracefully load in this scenario)
                Entropy.UI.Widget.label(tab, { text: "Manage NPC Archetypes and Recordings", bold: true });

                composerState.yumonSettings.archetypes.forEach(arch => {
                    const bState = brainStates[arch];
                    Entropy.UI.Widget.horizontal(tab, (hTab) => {
                        Entropy.UI.Widget.label(hTab, { text: arch, bold: true });
                        if (bState) {
                            const lossStr = bState.lastLoss ? bState.lastLoss.toFixed(4) : "N/A";
                            Entropy.UI.Widget.label(hTab, { text: `Moments: ${bState.totalMoments} | Loss: ${lossStr}` });
                        }
                    });

                    Entropy.UI.Widget.horizontal(tab, (hTab) => {
                        Entropy.UI.Widget.button(hTab, {
                            text: "Create",
                            onClick: () => {
                                addon.Yumon.brain.create(arch, arch);
                                if (!composerState.yumonSettings.createdBrains.includes(arch)) {
                                    composerState.yumonSettings.createdBrains.push(arch);
                                    composerState.yumonSettings.activeRecordingBrainId = arch;
                                }
                                Entropy.println(`Created Yumon Brain for ${arch}`);
                            }
                        });
                        if (composerState.yumonSettings.createdBrains.includes(arch)) {
                            Entropy.UI.Widget.button(hTab, {
                                text: "Save",
                                onClick: () => {
                                    addon.Yumon.brain.save(arch);
                                    Entropy.println(`Saved Yumon Brain for ${arch}`);
                                }
                            });

                            Entropy.UI.Widget.button(hTab, {
                                text: "🧪 Test Infer",
                                onClick: () => {
                                    const context = [];
                                    for (let i = 0; i < 16; i++) {
                                        const world = new Array(16).fill(0);
                                        // Simulate a threat approaching from the front
                                        world[6] = Math.max(0, (16 - i) / 32); // NearestThreatDist decreasing (0.5 to 0)
                                        world[7] = 0.905; // Test output rotation alignment
                                        world[12] = i > 8 ? 1.0 : 0.5; // AlertLevel increasing

                                        const self = new Array(8).fill(0);
                                        self[0] = 1.0; // Health
                                        self[3] = 1.0; // Grounded
                                        self[5] = 0.2; // Speed
                                        self[6] = i / 16; // Clock
                                        
                                        context.push({ world, selfState: self });
                                    }

                                    try {
                                        const result = addon.Yumon.brain.testInfer(arch, context);
                                        Entropy.println(`[Test Inference:${arch}] Result: ${result.actionName} (Rot: ${result.absoluteRotation.toFixed(3)})`);
                                    } catch (e) {
                                        Entropy.println(`[Test Inference:${arch}] Error: ${e}`);
                                    }
                                }
                            });
                        }
                    });

                    if (composerState.yumonSettings.createdBrains.includes(arch)) {
                        const isTraining = bState?.isTraining || false;

                        if (isTraining) {
                            const progress = bState.totalTrainingEpochs > 0 
                                ? (bState.trainingEpoch / bState.totalTrainingEpochs * 100).toFixed(1)
                                : "0";
                            const trainLoss = bState.trainingLoss ? bState.trainingLoss.toFixed(4) : "N/A";
                            Entropy.UI.Widget.label(tab, { 
                                text: `Training: ${progress}% (Epoch ${bState.trainingEpoch}/${bState.totalTrainingEpochs}) Loss: ${trainLoss}`
                            });
                        } else {
                            // Numeric input for epochs
                            let currentEpochs = composerState.yumonSettings.epochsToTrain[arch] || 10;
                            Entropy.UI.Widget.slider(tab, {
                                label: "Epochs",
                                min: 1,
                                max: 100,
                                value: currentEpochs,
                                onChange: (v: string) => { composerState.yumonSettings.epochsToTrain[arch] = parseInt(v); }
                            });

                            Entropy.UI.Widget.horizontal(tab, (trainTab) => {
                                Entropy.UI.Widget.button(trainTab, {
                                    text: `Train ${composerState.yumonSettings.epochsToTrain[arch] || 10} Epochs`,
                                    onClick: () => {
                                        const epochs = composerState.yumonSettings.epochsToTrain[arch] || 10;
                                        addon.Yumon.brain.sleep(arch, epochs);
                                        Entropy.println(`Started background training for ${arch} (${epochs} epochs)...`);
                                    }
                                });

                                Entropy.UI.Widget.button(trainTab, {
                                    text: "Augment (4x)",
                                    onClick: () => {
                                        addon.Yumon.brain.augment(arch);
                                        Entropy.println(`Augmented dataset for ${arch}. Moments quadrupled.`);
                                    }
                                });
                            });
                        }
                    }
                });

                Entropy.UI.Widget.separator(tab);
                Entropy.UI.Widget.label(tab, { text: "Session Recording", bold: true });

                if (composerState.yumonSettings.isRecording && lastMoment.length > 0) {
                    // Quick visualizer for the last moment vector (normalized states)
                    const viz = lastMoment.map((v) => v.toFixed(1)).join(" ");
                    Entropy.UI.Widget.label(tab, { text: `Moment: [${viz}]` });
                    Entropy.UI.Widget.label(tab, { text: `Action: [${lastAction}]` });
                    Entropy.UI.Widget.label(tab, { text: `Threat Angle: [${lastThreatAngle}]` });
                    Entropy.UI.Widget.label(tab, { text: `Player Rotation: [${lastRotation}]` });
                }

                const recordingId = composerState.yumonSettings.activeRecordingBrainId;

                if (composerState.yumonSettings.createdBrains.includes(recordingId as string)) {
                    Entropy.UI.Widget.dropdown(tab, {
                        label: "Target Archetype",
                        options: composerState.yumonSettings.archetypes,
                        selectedIndex: recordingId ? composerState.yumonSettings.archetypes.indexOf(recordingId as any) : 0,
                        onChange: (v) => {
                            composerState.yumonSettings.activeRecordingBrainId = composerState.yumonSettings.archetypes[parseInt(v)];
                        }
                    });

                    Entropy.UI.Widget.button(tab, {
                        text: composerState.yumonSettings.isRecording ? "🔴 Stop Recording" : "⏺ Record Play Session",
                        onClick: () => {
                            composerState.yumonSettings.isRecording = !composerState.yumonSettings.isRecording;
                            if (composerState.yumonSettings.isRecording && !composerState.yumonSettings.activeRecordingBrainId) {
                                composerState.yumonSettings.activeRecordingBrainId = composerState.yumonSettings.archetypes[0];
                            }
                        }
                    });
                }
            }
        }
    });

    // --- Tools Registration ---

    addon.registerTool({
        name: "list_scene_objects",
        description: "List all object instances currently in the scene managed by the Game Composer.",
        parameters: { type: "object", properties: {} }
    }, () => {
        return { success: true, objects: composerState.components };
    });

    addon.registerTool({
        name: "add_to_scene",
        description: "Add a specific component (e.g., a specific Terrain or NPC) to the scene. The y position will auto-set to the terrain height.",
        parameters: {
            type: "object",
            properties: {
                addonName: { type: "string", description: "The addon the component belongs to (e.g., 'FlexNoise Terrain')." },
                componentId: { type: "string", description: "The ID of the saved component from that addon." },
                name: { type: "string", description: "A friendly name for this instance." },
                position: { type: "array", items: { type: "number" } },
                scale: { type: "array", items: { type: "number" } }
            },
            required: ["addonName", "componentId"]
        }
    }, (args: any) => {
        Entropy.println("Adding component to scene via tool: " + args.componentId);
        const y = addon.Landscape.getHeightAt(args.position[0], args.position[2]);
        const newInst = addInstance({
            addonName: args.addonName,
            componentId: args.componentId,
            name: args.name || `${args.componentId} Instance`,
            position: [args.position[0] || 0, y || 0, args.position[2] || 0],
            scale: args.scale || [1, 1, 1]
        });
        composerState.activeInstanceId = newInst.id;
        refreshScene();
        return { success: true, id: newInst.id };
    });

    addon.registerTool({
        name: "update_scene_object",
        description: "Update the transform or visibility of an object in the scene.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "The instance ID of the object." },
                position: { type: "array", items: { type: "number" } },
                scale: { type: "array", items: { type: "number" } },
                visible: { type: "boolean" }
            },
            required: ["id"]
        }
    }, (args: any) => {
        const inst = composerState.components.find(c => c.id === args.id);
        if (!inst) return { success: false, error: "Object not found." };

        if (args.position) inst.position = args.position;
        if (args.scale) inst.scale = args.scale;
        if (typeof args.visible !== "undefined") inst.visible = args.visible;

        refreshScene();
        return { success: true };
    });

    addon.registerTool({
        name: "remove_from_scene",
        description: "Remove an object instance from the scene.",
        parameters: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"]
        }
    }, (args: any) => {
        composerState.components = composerState.components.filter(c => c.id !== args.id);
        if (composerState.activeInstanceId === args.id) composerState.activeInstanceId = null;
        refreshScene();
        return { success: true };
    });
});