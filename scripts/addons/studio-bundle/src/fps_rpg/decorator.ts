import type { Entity } from "../addon";
import { ProceduralHumanoid } from "../humanoid_v2";
import { FPSUI, type DialogueOption, type DialogueState } from "./fps_ui";
import { addon } from "./index";
import { Faction, factions, quests } from "./quests";
import { worldManager } from "./world";
import { gameState } from "./state";
import { FloorPlan, HOUSE_SHADER, HouseGeometry, MeshBuilder, Rect, vec2, vec3, type HouseParams } from "../procedural_houses_addon";

class EnvironmentDecorator {
    private housePipelineId: string | null = null;
    private houseTextures: Record<string, string> = {};

    constructor() {
        this.setupHousePipeline();
    }

    private setupHousePipeline() {
        this.housePipelineId = Entropy.Pipeline.create({
            name: "RPG_House_Pipeline",
            pbr: true,
            layout: "mesh",
            vertexShader: HOUSE_SHADER,
            fragmentShader: HOUSE_SHADER,
            extraBindGroups: [
                { entries: [
                    { binding: 0, visibility: ["Vertex", "Fragment"], resourceType: "Uniform" },
                    { binding: 1, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 2, visibility: ["Fragment"], resourceType: "Sampler" },
                    { binding: 3, visibility: ["Fragment"], resourceType: "Texture" },
                    { binding: 4, visibility: ["Fragment"], resourceType: "Texture" }
                ]}
            ]
        });
    }

    private getBindingsForSlot(slot: string, compId: string | null): any[] {
        if (!compId || !Entropy.Composer) return [];
    
        const texAddonName = "PBR Texture Designer Pro";
        const components = Entropy.Composer.getComponents(texAddonName) || {};
        const comp = components[compId];
        if (!comp) return [];
    
        // Ensure textures are generated
        const generator = (Entropy.Composer as any).getTextureGenerator?.(texAddonName);
        let designerTextures = globalThis.lastPBRDesignerTextures ? globalThis.lastPBRDesignerTextures[compId] : null;
    
        if (!designerTextures && generator) {
            generator(compId, comp.params, 512);
            designerTextures = globalThis.lastPBRDesignerTextures ? globalThis.lastPBRDesignerTextures[compId] : null;
        }
    
        if (!designerTextures) return [];
    
        const params = comp.params;
        return [
            { group: 2, binding: 0, resource: { type: "Uniform", value: { data: [params.seed, 0, 0, 0, ...params.baseColor, params.roughness, params.metallic, params.aoStrength, params.normalStrength] } } },
            { group: 2, binding: 1, resource: { type: "Texture", value: {id: designerTextures.diffId} } },
            { group: 2, binding: 2, resource: { type: "Sampler" } },
            { group: 2, binding: 3, resource: { type: "Texture", value: {id: designerTextures.norId} } },
            { group: 2, binding: 4, resource: { type: "Texture", value: {id: designerTextures.armId} } }
        ];
    }

    private setupVillageTextures() {
        if (!Entropy.Composer) return;

        const texAddonName = "PBR Texture Designer Pro";
        
        // Wall Texture (Brick)
        const wallId = "village_wall_brick";
        Entropy.Composer.registerComponent(texAddonName, wallId, "Village Wall Brick", {
            seed: 42,
            patternType: "brick",
            patternScale: 1.5,
            baseColor: [0.6, 0.3, 0.2, 1.0],
            secondaryColor: [0.4, 0.4, 0.4, 1.0],
            tertiaryColor: [0.7, 0.4, 0.3, 1.0],
            roughness: 0.9,
            metallic: 0.0,
            aoStrength: 1.0,
            normalStrength: 12.0,
            brickWidth: 64,
            brickHeight: 32,
            mortarWidth: 4,
            brickVariation: 0.2
        });

        // Roof Texture (Scales/Shingles)
        const roofId = "village_roof_shingles";
        Entropy.Composer.registerComponent(texAddonName, roofId, "Village Roof Shingles", {
            seed: 123,
            patternType: "scales",
            patternScale: 2.0,
            baseColor: [0.2, 0.2, 0.25, 1.0],
            secondaryColor: [0.1, 0.1, 0.15, 1.0],
            tertiaryColor: [0.3, 0.3, 0.4, 1.0],
            roughness: 0.7,
            metallic: 0.1,
            aoStrength: 1.0,
            normalStrength: 15.0,
            scaleSize: 40.0,
            scaleOverlap: 0.2,
            scaleRoughness: 0.4
        });

        // Floor Texture (Wood)
        const floorId = "village_floor_wood";
        Entropy.Composer.registerComponent(texAddonName, floorId, "Village Floor Wood", {
            seed: 888,
            patternType: "wood_grain",
            patternScale: 1.0,
            baseColor: [0.4, 0.25, 0.15, 1.0],
            secondaryColor: [0.3, 0.15, 0.1, 1.0],
            tertiaryColor: [0.5, 0.35, 0.25, 1.0],
            roughness: 0.6,
            metallic: 0.0,
            aoStrength: 0.8,
            normalStrength: 5.0,
            woodRingFrequency: 0.4,
            woodGrainTurbulence: 2.5,
            woodGrainStretch: 4.0
        });

        this.houseTextures = {
            walls: wallId,
            roof: roofId,
            floor: floorId
        };
    }

    /**
     * Spawn a cluster of procedural houses
     */
    spawnHouseCluster(center: {x: number, z: number}, radius: number, count: number) {
        if (Object.keys(this.houseTextures).length === 0) {
            this.setupVillageTextures();
        }

        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * radius;
            const x = center.x + Math.cos(angle) * dist;
            const z = center.z + Math.sin(angle) * dist;
            
            this.createHouseAt(x, z);
        }
    }

    private createHouseAt(x: number, z: number) {
        const y = addon.Landscape.getHeightAt(x, z);
        const rotation = Math.random() * Math.PI * 2;
        const seed = Math.floor(Math.random() * 100000);
        
        const params: HouseParams = {
            width: 8 + Math.random() * 6,
            depth: 8 + Math.random() * 6,
            stories: Math.random() > 0.7 ? 2 : 1,
            style: "traditional",
            minRoomSize: 2.5,
            maxSubdivisions: 3 + Math.floor(Math.random() * 2),
            wallThickness: 0.15,
            floorHeight: 2.7,
            windowHeight: 1.2,
            windowWidth: 0.8,
            doorWidth: 0.9,
            doorHeight: 2.1,
            addBasement: false,
            addAttic: false,
            addPorch: false,
            seed: seed,
            textureLayers: {
                Walls: this.houseTextures.walls,
                Roof: this.houseTextures.roof,
                Floor: this.houseTextures.floor
            }
        };

        const floorPlan = new FloorPlan(params.seed);
        floorPlan.generate(params);

        const wallMesh = new MeshBuilder();
        const floorMesh = new MeshBuilder();
        const roofMesh = new MeshBuilder();
        const detailMesh = new MeshBuilder();

        for (let story = 0; story < params.stories; story++) {
            const baseY = story * params.floorHeight;
            for (const room of floorPlan.rooms) {
                floorMesh.merge(HouseGeometry.generateFloor(room.bounds, baseY));
                if (story < params.stories - 1) {
                    floorMesh.merge(HouseGeometry.generateCeiling(room.bounds, baseY + params.floorHeight));
                }
            }
            for (const room of floorPlan.rooms) {
                const b = room.bounds;
                const walls = [
                    { start: vec2(b.x, b.y), end: vec2(b.right, b.y) },
                    { start: vec2(b.right, b.y), end: vec2(b.right, b.bottom) },
                    { start: vec2(b.right, b.bottom), end: vec2(b.x, b.bottom) },
                    { start: vec2(b.x, b.bottom), end: vec2(b.x, b.y) }
                ];
                for (const wall of walls) {
                    wallMesh.merge(HouseGeometry.generateWall(
                        vec3(wall.start.x, baseY, wall.start.y),
                        vec3(wall.end.x, baseY, wall.end.y),
                        params.floorHeight,
                        params.wallThickness
                    ));
                }
            }
            for (const doorway of floorPlan.doorways) {
                detailMesh.merge(HouseGeometry.generateDoorFrame(doorway.position, doorway.axis, doorway.width, params.doorHeight, baseY, params.wallThickness));
            }
            for (const window of floorPlan.windows) {
                detailMesh.merge(HouseGeometry.generateWindow(window.position, window.wallNormal, window.width, window.height, baseY, params.wallThickness));
            }
            if (params.stories > 1 && story < params.stories - 1 && floorPlan.stairs) {
                detailMesh.merge(HouseGeometry.generateStaircase(floorPlan.stairs.position, floorPlan.stairs.direction, floorPlan.stairs.width, params.floorHeight));
            }
        }

        const topY = params.stories * params.floorHeight;
        const roofStyle = params.style === "modern" ? "flat" : "gable";
        roofMesh.merge(HouseGeometry.generateRoof(new Rect(0, 0, params.width, params.depth), topY, roofStyle === "flat" ? 0.3 : 2.0, roofStyle));

        const basePos: [number, number, number] = [x - params.width/2, y, z - params.depth/2];
        const pbrPipeline = this.housePipelineId || "default";

        // Create the meshes
        const wallId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: wallId,
            position: basePos,
            vertexData: wallMesh.vertices,
            indexData: wallMesh.indices,
            pipelineId: pbrPipeline,
            bindings: this.getBindingsForSlot("Walls", this.houseTextures.walls),
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });

        const floorId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: floorId,
            position: basePos,
            vertexData: floorMesh.vertices,
            indexData: floorMesh.indices,
            pipelineId: pbrPipeline,
            bindings: this.getBindingsForSlot("Floor", this.houseTextures.floor),
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });

        const roofId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: roofId,
            position: basePos,
            vertexData: roofMesh.vertices,
            indexData: roofMesh.indices,
            pipelineId: pbrPipeline,
            bindings: this.getBindingsForSlot("Roof", this.houseTextures.roof),
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });

        const detailId = Entropy.generateUUID();
        addon.Model.createMesh({
            id: detailId,
            position: basePos,
            vertexData: detailMesh.vertices,
            indexData: detailMesh.indices,
            pipelineId: "default",
            // physics: { bodyType: "fixed", colliderShape: "trimesh" }
        });
    }
    
    /**
     * Spawn trees around the map
     */
    spawnTrees(count: number = 50) {
        let globalSettings = Entropy.Composer?.getGlobalSettings();
        let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;
        
        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const y = addon.Landscape.getHeightAt(x, z);
            const scale = 3.0 + Math.random() * 0.8; // Vary tree sizes
            
            addon.Model.load({
                path: "Tree1b.glb",
                position: [x, y, z],
                scale: [scale, scale, scale],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "capsule"
                }
            });
        }
        Entropy.println(`[Environment] Spawned ${count} trees`);
    }
    
    /**
     * Spawn foliage patches
     */
    spawnFoliage(count: number = 100) {
        let globalSettings = Entropy.Composer?.getGlobalSettings();
        let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;
        
        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.9;
            const y = addon.Landscape.getHeightAt(x, z);
            const rotation = Math.random() * Math.PI * 2;
            
            addon.Model.load({
                path: Math.random() > 0.5 ? "Foliage1.glb" : "Plant_02_Art.glb",
                position: [x, y, z],
                rotation: [0, rotation, 0],
                scale: [1.5 + Math.random() * 0.5, 1.5 + Math.random() * 0.5, 1.5 + Math.random() * 0.5]
            });
        }
        Entropy.println(`[Environment] Spawned ${count} foliage patches`);
    }
    
    /**
     * Build faction outposts with houses and structures
     */
    buildFactionOutpost(faction: Faction, houseCount: number = 3) {
        const territory = factions[faction].territory;
        const houseModels = ["House1b.glb", "House2a.glb", "House3a.glb"];
        
        for (let i = 0; i < houseCount; i++) {
            const angle = (i / houseCount) * Math.PI * 2;
            const dist = territory.radius * 0.6;
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: houseModels[i % houseModels.length],
                position: [x, y, z],
                rotation: [0, angle + Math.PI / 2, 0],
                scale: [2.2, 2.2, 2.2],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "cuboid"
                }
            });
        }
        
        Entropy.println(`[Outpost] Built ${houseCount} structures for ${factions[faction].name}`);
    }
    
    /**
     * Add towers to faction territories
     */
    buildFactionTowers(faction: Faction, towerCount: number = 4) {
        const territory = factions[faction].territory;
        const towerModels = ["Tower_Base_02_Art.glb", "Spooky_Tower_Floating_Cabin_03_Art.glb"];
        
        for (let i = 0; i < towerCount; i++) {
            const angle = (i / towerCount) * Math.PI * 2;
            const dist = territory.radius * 0.8; // Place at perimeter
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: towerModels[i % towerModels.length],
                position: [x, y, z],
                rotation: [0, angle, 0],
                scale: [4, 4, 4],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "capsule"
                }
            });
        }
        
        Entropy.println(`[Towers] Built ${towerCount} towers for ${factions[faction].name}`);
    }
    
    /**
     * Spawn decorative props across the map
     */
    spawnScatteredProps(count: number = 40) {
        let globalSettings = Entropy.Composer?.getGlobalSettings();
        let LANDSCAPE_SIZE = globalSettings?.landscapeSettings.size || 1024;
        
        const props = [
            "ElectricPost02_Art.glb",
            "Iron_Structure_01_Art.glb",
            "Tank.glb",
            "013_Octogecko_Art.glb"
        ];
        
        for (let i = 0; i < count; i++) {
            const x = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const z = (Math.random() - 0.5) * LANDSCAPE_SIZE * 0.85;
            const y = addon.Landscape.getHeightAt(x, z);
            const rotation = Math.random() * Math.PI * 2;
            const propModel = props[Math.floor(Math.random() * props.length)];
            
            addon.Model.load({
                path: propModel,
                position: [x, y, z],
                rotation: [0, rotation, 0],
                scale: [1.8, 1.8, 1.8],
                physics: {
                    bodyType: "fixed",
                    colliderShape: "cuboid"
                }
            });
        }
        
        Entropy.println(`[Props] Spawned ${count} decorative props`);
    }
    
    /**
     * Create a central bridge landmark
     */
    buildCentralBridge() {
        const y = addon.Landscape.getHeightAt(0, 0);
        
        addon.Model.load({
            path: "LoveDeath_Bridge_Fragment_Art.glb",
            position: [0, y + 5, 0],
            scale: [6, 6, 6],
            physics: {
                bodyType: "fixed",
                colliderShape: "cuboid"
            }
        });
        
        Entropy.println("[Landmark] Built central bridge");
    }
    
    /**
     * Add weapon racks/displays in faction areas
     */
    spawnWeaponDisplays(faction: Faction, count: number = 5) {
        const territory = factions[faction].territory;
        const swordModels = [
            "Sword1small.glb",
            "Sword1medium.glb", 
            "Sword1large.glb",
            "Sword1extralarge.glb"
        ];
        
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * territory.radius * 0.5;
            const x = territory.x + Math.cos(angle) * dist;
            const z = territory.z + Math.sin(angle) * dist;
            const y = addon.Landscape.getHeightAt(x, z);
            
            addon.Model.load({
                path: swordModels[Math.floor(Math.random() * swordModels.length)],
                position: [x, y + 1, z],
                rotation: [Math.PI / 4, Math.random() * Math.PI * 2, 0],
                scale: [1, 1, 1]
            });
        }
        
        Entropy.println(`[Weapons] Added ${count} weapon displays to ${factions[faction].name}`);
    }
    
    /**
     * Place a dome structure (could be used as a central hub or special location)
     */
    buildDomeStructure(x: number, z: number) {
        // const y = addon.Landscape.getHeightAt(x, z);
        
        addon.Model.load({
            path: "DomeKit8.glb",
            position: [x, -50, z],
            scale: [1.0, 1.0, 1.0],
            physics: {
                bodyType: "fixed",
                colliderShape: "trimesh"
            }
        });
        
        Entropy.println(`[Structure] Built dome at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    }
    
    /**
     * Master function to decorate the entire world
     */
    decorateWorld() {
        // // just trees during testing
        // this.spawnTrees(30);
        
        // this.spawnFoliage(20);
        // // this.buildCentralBridge();
        
        // // // Build outposts for each faction
        // this.buildFactionOutpost(Faction.CRIMSON_GUARD, 4);
        // this.buildFactionOutpost(Faction.AZURE_ORDER, 4);
        // this.buildFactionOutpost(Faction.SHADOW_COVENANT, 3);
        
        // // Add towers
        // this.buildFactionTowers(Faction.CRIMSON_GUARD, 4);
        // this.buildFactionTowers(Faction.AZURE_ORDER, 4);
        // this.buildFactionTowers(Faction.SHADOW_COVENANT, 4);
        
        // // Add weapon displays
        // this.spawnWeaponDisplays(Faction.CRIMSON_GUARD, 6);
        // this.spawnWeaponDisplays(Faction.AZURE_ORDER, 6);
        // this.spawnWeaponDisplays(Faction.SHADOW_COVENANT, 6);
        
        // // Scatter props
        // this.spawnScatteredProps(50);
        
        // Build a dome at neutral zone
        this.buildDomeStructure(0, 0);

        // this.spawnHouseCluster({
        //     x: 250, z: 250
        // }, 200, 40);
        
        Entropy.println("[World] Full decoration complete! 🌍");
    }
}

export const environmentDecorator = new EnvironmentDecorator();
