import { createNoise2D, createNoise3D } from 'simplex-noise';
import Alea from 'alea';
import { vec3 } from 'gl-matrix';
import marchingCubes from 'marching-cubes-fast';
import { ComponentAddon } from './system';
import type { PBRMaterialType } from './addon';


var fmcvl = require('marching-cubes-fast/fast-marching-cubes-voxel-list.js');
var dfsb = require('marching-cubes-fast/df-sub-blocks.js');
function marchingCubesFast(RES: number, POTENTIAL: any, WORLD_BOUNDS: number[][], printProgress=false){
    // if(!powerOfTwo(RES)){
    //     throw 'resolution must be power of 2';
    // }
    var ITERS = Math.floor(Math.log2(RES)-1);
    if(printProgress){console.log('marching cubes: getting sub-blocks...');}
    var blocks = dfsb.getSubBlocksForBlockIteratedDFunc_edgesOnly(WORLD_BOUNDS, ITERS, POTENTIAL);
    if(printProgress){console.log(`marching cubes: got ${blocks.length} sub-blocks.`);}
    var tris = fmcvl.marchingCubes(POTENTIAL, blocks, printProgress); //{faces, vertices}
    return tris;
}


const TEXTURE_RES = 512;

interface PathPoint {
    x: number;
    z: number;
}

interface PathConfig {
    id: string;
    points: PathPoint[];
    width: number;
    smoothness: number;
    flattenStrength: number;
    blend: number;
    color?: [number, number, number, number]; // For minimap visualization
}

interface TerrainParams {
    seed: number;
    frequency: number;
    octaves: number;
    persistence: number;
    lacunarity: number;
    usePBR: boolean;
    width: number;
    height: number;
    heightScale: number;
    positionY: number;
    terrainColor: [number, number, number, number];
    use3D: boolean;
    time: number;
    autoSyncPBR: boolean;
    rockThreshold: number;
    brushSize: number;
    pipelineId: string | null;
    textureLayers: {
        Primary: string | null;
        Rockmap: string | null;
        Soil: string | null;
    };
    paths: PathConfig[];
}

class FlexNoiseAddon extends ComponentAddon<TerrainParams> {
    protected defaultParams: TerrainParams = {
        seed: 42,
        frequency: 0.005,
        octaves: 6,
        persistence: 0.5,
        lacunarity: 2.0,
        usePBR: true,
        width: 128,
        height: 128,
        heightScale: 1,
        positionY: 0.0,
        terrainColor: [0.3, 0.5, 0.2, 1.0],
        use3D: false,
        time: 0.0,
        autoSyncPBR: false,
        rockThreshold: 0.5,
        brushSize: 5.0,
        pipelineId: null,
        textureLayers: {
            Primary: null,
            Rockmap: null,
            Soil: null
        },
        paths: []
    };

    private interopState = {
        selectedSlot: "Rockmap" as "Primary" | "Rockmap" | "Soil",
        selectedTextureCompId: "",
        selectedPathId: "",
        newPathName: "New Path",
        paintingMode: false,
        currentPaintPath: null as PathConfig | null,
        lastPaintTime: 0,
        paintDebounceMs: 100, // Configurable debounce
        pendingRegenerateFrames: 0 // Frame counter for debouncing
    };

    // Path color palette
    private pathColors = [
        [1.0, 0.3, 0.3, 1.0], // Red
        [0.3, 0.6, 1.0, 1.0], // Blue
        [0.3, 1.0, 0.3, 1.0], // Green
        [1.0, 0.8, 0.2, 1.0], // Yellow
        [1.0, 0.5, 0.0, 1.0], // Orange
        [0.8, 0.3, 1.0, 1.0], // Purple
    ];

    constructor() {
        super({
            name: "FlexNoise Terrain",
            version: "2.4.0",
            description: "Highly customizable procedural terrain with paintable paths",
            author: ["Entropy Team"],
            capabilities: { graphics: true, ui: true }
        });
    }

    protected setup(): void {
        this.initComponentState("Default Terrain");
        this.setupTools();
        this.setupUI();
        this.setupProjectHandlers();
        this.setupLighting();
        this.setupUpdateLoop();
    }

    // ==================== PATH SYSTEM ====================

    private createPath(points: PathPoint[], width: number = 5, smoothness: number = 2, flattenStrength: number = 0.8, blend: number = 2): PathConfig {
        // Assign a color from the palette
        const colorIndex = this.currentParams.paths.length % this.pathColors.length;
        return {
            id: Entropy.generateUUID(),
            points,
            width,
            smoothness,
            flattenStrength,
            blend,
            color: this.pathColors[colorIndex] as [number, number, number, number]
        };
    }

    private getPathInfluence(x: number, z: number, path: PathConfig, terrainWidth: number, terrainHeight: number): number {
        if (path.points.length < 2) return 0;

        let minDist = Infinity;

        for (let i = 0; i < path.points.length - 1; i++) {
            const p1 = path.points[i];
            const p2 = path.points[i + 1];

            const x1 = p1.x * terrainWidth;
            const z1 = p1.z * terrainHeight;
            const x2 = p2.x * terrainWidth;
            const z2 = p2.z * terrainHeight;

            const dx = x2 - x1;
            const dz = z2 - z1;
            const lenSq = dx * dx + dz * dz;

            let t = 0;
            if (lenSq > 0) {
                t = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / lenSq));
            }

            const projX = x1 + t * dx;
            const projZ = z1 + t * dz;
            const dist = Math.sqrt((x - projX) ** 2 + (z - projZ) ** 2);

            minDist = Math.min(minDist, dist);
        }

        const influence = Math.max(0, 1 - (minDist / path.width));
        return Math.pow(influence, path.blend);
    }

    private applyPathsToHeights(heights: number[], terrainWidth: number, terrainHeight: number, paths: PathConfig[]): number[] {
        if (paths.length === 0) return heights;

        const modifiedHeights = [...heights];

        for (let y = 0; y < terrainHeight; y++) {
            for (let x = 0; x < terrainWidth; x++) {
                const idx = y * terrainWidth + x;
                const originalHeight = heights[idx];

                let totalInfluence = 0;
                let targetHeight = 0;

                paths.forEach(path => {
                    const influence = this.getPathInfluence(x, y, path, terrainWidth, terrainHeight);
                    if (influence > 0) {
                        const localHeight = this.getAverageHeightAround(heights, x, y, terrainWidth, terrainHeight, path.smoothness);
                        targetHeight += localHeight * influence * path.flattenStrength;
                        totalInfluence += influence;
                    }
                });

                if (totalInfluence > 0) {
                    const flattenedHeight = targetHeight / totalInfluence;
                    modifiedHeights[idx] = originalHeight * (1 - totalInfluence) + flattenedHeight * totalInfluence;
                }
            }
        }

        return modifiedHeights;
    }

    private getAverageHeightAround(heights: number[], x: number, z: number, width: number, height: number, radius: number): number {
        let sum = 0;
        let count = 0;
        const r = Math.floor(radius);

        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const nx = x + dx;
                const nz = z + dy;
                if (nx >= 0 && nx < width && nz >= 0 && nz < height) {
                    sum += heights[nz * width + nx];
                    count++;
                }
            }
        }

        return count > 0 ? sum / count : 0;
    }

    // ==================== PATH PAINTING ====================

    private startPathPainting(): void {
        this.interopState.paintingMode = true;
        const path = this.createPath([], 8, 3, 0.9, 2);
        this.interopState.currentPaintPath = path;
        Entropy.println("🎨 Path painting started! Click on minimap to draw path.");
    }

    private stopPathPainting(): void {
        if (this.interopState.currentPaintPath && this.interopState.currentPaintPath.points.length >= 2) {
            this.currentParams.paths.push(this.interopState.currentPaintPath);
            this.interopState.selectedPathId = this.interopState.currentPaintPath.id;
            Entropy.println(`✓ Path saved with ${this.interopState.currentPaintPath.points.length} points`);
            
            // Final regeneration
            this.generateTerrain(this.currentParams, this.state.activeComponentId);
            this.saveToProject();
        } else {
            Entropy.println("⚠️ Path cancelled (needs at least 2 points)");
        }
        
        this.interopState.paintingMode = false;
        this.interopState.currentPaintPath = null;
    }

    private addPointToCurrentPath(x: number, y: number): void {
        if (!this.interopState.currentPaintPath) return;

        // Add point in normalized coordinates
        this.interopState.currentPaintPath.points.push({ x, z: y });
        
        // Schedule debounced regeneration
        this.interopState.pendingRegenerateFrames = Math.floor(this.interopState.paintDebounceMs / 16); // ~16ms per frame
    }

    private simplifyPath(path: PathConfig, tolerance: number = 0.02): void {
        // Douglas-Peucker algorithm for path simplification
        if (path.points.length <= 2) return;

        const simplified = this.douglasPeucker(path.points, tolerance);
        path.points = simplified;
    }

    private douglasPeucker(points: PathPoint[], tolerance: number): PathPoint[] {
        if (points.length <= 2) return points;

        let maxDist = 0;
        let maxIndex = 0;
        const end = points.length - 1;

        for (let i = 1; i < end; i++) {
            const dist = this.perpendicularDistance(points[i], points[0], points[end]);
            if (dist > maxDist) {
                maxDist = dist;
                maxIndex = i;
            }
        }

        if (maxDist > tolerance) {
            const left = this.douglasPeucker(points.slice(0, maxIndex + 1), tolerance);
            const right = this.douglasPeucker(points.slice(maxIndex), tolerance);
            return [...left.slice(0, -1), ...right];
        } else {
            return [points[0], points[end]];
        }
    }

    private perpendicularDistance(point: PathPoint, lineStart: PathPoint, lineEnd: PathPoint): number {
        const dx = lineEnd.x - lineStart.x;
        const dz = lineEnd.z - lineStart.z;
        const lenSq = dx * dx + dz * dz;
        
        if (lenSq === 0) {
            return Math.sqrt((point.x - lineStart.x) ** 2 + (point.z - lineStart.z) ** 2);
        }

        const t = ((point.x - lineStart.x) * dx + (point.z - lineStart.z) * dz) / lenSq;
        const clampedT = Math.max(0, Math.min(1, t));
        
        const projX = lineStart.x + clampedT * dx;
        const projZ = lineStart.z + clampedT * dz;
        
        return Math.sqrt((point.x - projX) ** 2 + (point.z - projZ) ** 2);
    }

    // ==================== MINIMAP VISUALIZATION ====================

    private getMinimapMarkers() {
        const markers: any[] = [];

        // Add markers for all path points
        this.currentParams.paths.forEach(path => {
            const isSelected = path.id === this.interopState.selectedPathId;
            path.points.forEach((point, idx) => {
                markers.push({
                    position: [point.x, point.z],
                    color: isSelected ? [1, 1, 0, 1] : path.color || [0.5, 0.5, 0.5, 0.8],
                    label: isSelected ? `P${idx}` : undefined
                });
            });
        });

        // Add markers for current painting path
        if (this.interopState.currentPaintPath) {
            this.interopState.currentPaintPath.points.forEach((point, idx) => {
                markers.push({
                    position: [point.x, point.z],
                    color: [1, 0.5, 0, 1], // Orange for active painting
                    label: `${idx}`
                });
            });
        }

        return markers;
    }

    private getMinimapPolylines() {
        const polylines: any[] = [];

        // Add polylines for all paths
        this.currentParams.paths.forEach(path => {
            if (path.points.length >= 2) {
                const isSelected = path.id === this.interopState.selectedPathId;
                polylines.push({
                    points: path.points.map(p => [p.x, p.z]),
                    color: isSelected ? [1, 1, 0, 1] : path.color || [0.5, 0.5, 0.5, 0.8],
                    width: isSelected ? 3 : 2
                });
            }
        });

        // Add polyline for current painting path
        if (this.interopState.currentPaintPath && this.interopState.currentPaintPath.points.length >= 2) {
            polylines.push({
                points: this.interopState.currentPaintPath.points.map(p => [p.x, p.z]),
                color: [1, 0.5, 0, 1],
                width: 3
            });
        }

        return polylines;
    }

    // ==================== TERRAIN GENERATION ====================

    private fbm(noise2D: (x: number, y: number) => number, x: number, y: number, octaves: number, frequency: number, persistence: number, lacunarity: number): number {
        let total = 0;
        let amplitude = 1;
        let maxValue = 0;
        let freq = frequency;

        for (let i = 0; i < octaves; i++) {
            total += noise2D(x * freq, y * freq) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            freq *= lacunarity;
        }

        return total / maxValue;
    }

    private applyRockmapMask(): void {
        const res = TEXTURE_RES;
        const maskData = new Uint8Array(res * res * 4);
        
        const prng = Alea(this.currentParams.seed);
        const noise2D = createNoise2D(prng);
        
        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                const idx = (y * res + x) * 4;
                const nx = x / res;
                const ny = y / res;
                const sx = nx * this.currentParams.width;
                const sy = ny * this.currentParams.height;

                const noiseValue = (this.fbm(
                    noise2D,
                    sx, sy,
                    this.currentParams.octaves,
                    this.currentParams.frequency,
                    this.currentParams.persistence,
                    this.currentParams.lacunarity
                ) + 1) / 2;
                
                const val = noiseValue > this.currentParams.rockThreshold ? 255 : 0;
                maskData[idx] = val;
                maskData[idx + 1] = val;
                maskData[idx + 2] = val;
                maskData[idx + 3] = 255;
            }
        }
        
        const maskId = this.api.Texture.create(res, res, maskData);
        this.api.Landscape.updateTexture(maskId, "RockmapMask");
    }

    private applyPBRToSlot(addonName: string, pbrid: string, slot: PBRMaterialType): void {
        if (globalThis.lastPBRDesignerTextures) {
            const designerTextures = globalThis.lastPBRDesignerTextures[pbrid];
            if (designerTextures) {
                Entropy.println(`Applying PBR textures to ${slot}...`);

                if (slot === "Rockmap") {
                    this.applyRockmapMask();
                } else if (slot === "Primary") {
                    const res = TEXTURE_RES;
                    const maskData = new Uint8Array(res * res * 4).fill(255);
                    const maskId = this.api.Texture.create(res, res, maskData);
                    this.api.Landscape.updateTexturePlus(addonName, maskId, "PrimaryMask");
                } else if (slot === "Soil") {
                    const res = TEXTURE_RES;
                    const maskData = new Uint8Array(res * res * 4).fill(255);
                    const maskId = this.api.Texture.create(res, res, maskData);
                    this.api.Landscape.updateTexturePlus(addonName, maskId, "SoilMask");
                }

                this.api.Landscape.updateTexturePlus(addonName, designerTextures.diffId, slot);
                this.api.Landscape.updatePbrTexturePlus(addonName, designerTextures.norId, "Normal", slot);
                this.api.Landscape.updatePbrTexturePlus(addonName, designerTextures.armId, "AORoughnessMetallic", slot);
                
                Entropy.println(`✓ ${slot} updated!`);
            }
        }
    }

    private restoreLayerTextures(addonName: string, params: TerrainParams): void {
        if (!Entropy.Composer) return;
        
        const layers = ["Primary", "Rockmap", "Soil"];
        const texAddonName = "PBR Texture Designer Pro";
        const components = Entropy.Composer.getComponents(texAddonName) || {};
        
        layers.forEach(slot => {
            const layersMap = params.textureLayers || {};
            const compId = layersMap[slot as "Primary" | "Rockmap" | "Soil"];

            if (Entropy.Composer && compId && components[compId]) {
                const generator = Entropy.Composer.getTextureGenerator?.(texAddonName);
                if (generator) {
                    generator(compId, components[compId].params, TEXTURE_RES);
                    if (globalThis.lastPBRDesignerTextures && globalThis.lastPBRDesignerTextures[compId]) {
                        this.applyPBRToSlot(addonName, compId, slot as "Primary" | "Rockmap" | "Soil");
                        Entropy.println(`✓ Restoration successful (${TEXTURE_RES} res) for ` + slot);
                    }
                } else {
                    const renderer = Entropy.Composer?.getRenderer(texAddonName);
                    if (renderer) {
                        renderer(compId, components[compId].params);
                        if (globalThis.lastPBRDesignerTextures && globalThis.lastPBRDesignerTextures[compId]) {
                            this.applyPBRToSlot(addonName, compId, slot as "Primary" | "Rockmap" | "Soil");
                            Entropy.println("✓ Restoration successful (legacy) for " + slot);
                        }
                    }
                }
            }
        });
    }

    private async generateTerrain(params: TerrainParams & { _transform?: { position: [number, number, number], scale: [number, number, number] } }, id: string = "default"): Promise<void> {
        if (!params.width || !params.height) return;

        if (params.use3D) { // Simple heuristic for cave mode
             await this.generate3DTerrain(params, id);
             return;
        }

        Entropy.println(`Regenerating FlexNoise Terrain (${id}): ${params.width}x${params.height}...`);

        const prng = Alea(params.seed);
        const noise2D = createNoise2D(prng);
        const noise3D = createNoise3D(prng);
        
        const heights: number[] = [];
        
        for (let y = 0; y < params.height; y++) {
            for (let x = 0; x < params.width; x++) {
                let noiseValue;
                if (params.use3D) {
                    noiseValue = 0;
                    let amplitude = 1;
                    let freq = params.frequency;
                    let maxValue = 0;
                    for (let i = 0; i < params.octaves; i++) {
                        noiseValue += noise3D(x * freq, y * freq, params.time) * amplitude;
                        maxValue += amplitude;
                        amplitude *= params.persistence;
                        freq *= params.lacunarity;
                    }
                    noiseValue /= maxValue;
                } else {
                    noiseValue = this.fbm(
                        noise2D,
                        x, y,
                        params.octaves,
                        params.frequency,
                        params.persistence,
                        params.lacunarity
                    );
                }
                
                const height = noiseValue * params.heightScale;
                heights.push(height);
            }
        }

        const modifiedHeights = this.applyPathsToHeights(heights, params.width, params.height, params.paths);
        
        let pipelineId = "default";
        if (!params.usePBR) {
            pipelineId = Entropy.Pipeline.create({
                name: "terrain_custom_color",
                pbr: false,
                fragmentShader: `
                    struct VertexOutput {
                        @location(0) color: vec4<f32>,
                    }
                    @fragment
                    fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                        return vec4<f32>(${params.terrainColor[0]}, ${params.terrainColor[1]}, ${params.terrainColor[2]}, 1.0);
                    }
                `
            });
        }

        const posX = params._transform?.position?.[0] || 0;
        const posY = (params._transform?.position?.[1] || 0) + params.positionY;
        const posZ = params._transform?.position?.[2] || 0;

        const globalSettings = Entropy.Composer?.getGlobalSettings();

        this.api.Landscape.create({
            id: id,
            width: params.width,
            height: params.height,
            heights: modifiedHeights,
            noiseId: null,
            position: [posX, globalSettings?.landscapeSettings.yOffset || 0, posZ],
            pipelineId: pipelineId,
            renderRole: "Terrain",
            size: globalSettings?.landscapeSettings.size || 512,
            scale: globalSettings?.landscapeSettings.height || 150,
        });

        this.restoreLayerTextures("FlexNoise Terrain", params);
        this.restoreLayerTextures("Game Composer", params);
    }

    private async generate3DTerrain(params: TerrainParams, id: string): Promise<void> {
        Entropy.println(`Generating Volumetric Terrain (Marching Cubes Fast) for ${id}...`);
        
        const prng = Alea(params.seed);
        const noise3D = createNoise3D(prng);
        
        // const res = 48; // Grid resolution
        const res = 16;
        // const res = 4; // Grid resolution
        const halfSize = params.width / 2;
        const heightScale = params.heightScale * 10;
        
        // Signed Distance Function (SDF) / Density Field
        // const sdf = (x: number, y: number, z: number) => {
        //     let wx = x;
        //     let wy = y;
        //     let wz = z;

        //     // --- SPIRAL TWIST (Exotic Pillar Effect) ---
        //     // If frequency is low, assume we want large structures like pillars
        //     if (params.frequency < 0.015) {
        //         const twistAmount = 0.1;
        //         const angle = y * twistAmount;
        //         const s = Math.sin(angle);
        //         const c = Math.cos(angle);
        //         wx = x * c - z * s;
        //         wz = x * s + z * c;
        //     }

        //     // Sample FBM Noise
        //     let density = 0;
        //     let amplitude = 1;
        //     let maxValue = 0;
        //     let freq = params.frequency;

        //     for (let i = 0; i < params.octaves; i++) {
        //         density += noise3D(wx * freq, wy * freq, wz * freq) * amplitude;
        //         maxValue += amplitude;
        //         amplitude *= params.persistence;
        //         freq *= params.lacunarity;
        //     }
        //     density /= maxValue;

        //     // Boundary Constraints (to keep it contained)
        //     const distFromCenter = Math.sqrt(x*x + z*z);
        //     const radiusLimit = halfSize * 0.8;
        //     if (distFromCenter > radiusLimit) {
        //         density -= (distFromCenter - radiusLimit) * 0.5;
        //     }

        //     // Height bias (Floor/Ceiling logic)
        //     // Remap density to create cavernous holes or solid pillars
        //     // params.rockThreshold remapped to 0.5 center
        //     return density - (params.rockThreshold - 0.5);
        // };

        var sdf = function(x: number, y: number, z: number){
            var s = 20.0
            return noise3D(x/s,y/s,z/s)+0.5;
        }

        // scanBounds: [[minX, minY, minZ], [maxX, maxY, maxZ]]
        // const bounds: [[number, number, number], [number, number, number]] = [
        //     [-halfSize, 0, -halfSize],
        //     [halfSize, heightScale, halfSize]
        // ];
        const bounds: [[number, number, number], [number, number, number]] = [
            [0, 0, 0],
            [params.width, heightScale, params.width]
        ];

        Entropy.println("⚠️ Time 2 March Tha Cubez. now: " + Date.now());

        // marchingCubes(resolution, sdf, bounds)
        try {
            // const mesh = marchingCubes(res, sdf, bounds);
            const mesh = marchingCubesFast(res, sdf, bounds);
        
            if (!mesh || !mesh.positions || mesh.positions.length === 0) {
                Entropy.println("⚠️ Marching Cubes generated empty mesh. Adjust Rock Threshold.");
                return;
            }

            Entropy.println("⚠️ Time 2 Push Da Vertex.");

            const vertices: number[] = [];
            const indices: number[] = [];
            const caveColor: [number, number, number, number] = params.terrainColor;

            // Process positions and calculate normals using gl-matrix
            for (let i = 0; i < mesh.positions.length; i++) {
                const p = mesh.positions[i];
                const n = mesh.normals ? mesh.normals[i] : [0, 1, 0];
                
                // vertices: pos(3), normal(3), uv(2), color(4)
                vertices.push(
                    p[0], p[1] + params.positionY, p[2], // Position
                    n[0], n[1], n[2],                   // Normal
                    p[0] / params.width + 0.5,           // U
                    p[2] / params.width + 0.5,           // V
                    ...caveColor                         // Color
                );
            }

            // Indices
            for (const face of mesh.cells) {
                indices.push(face[0], face[1], face[2]);
            }

            this.api.Landscape3D.create({
                id,
                vertices,
                indices,
                position: [0, 0, 0],
                pipelineId: params.pipelineId || "default",
                renderRole: "Terrain"
            });
        } catch (error) {
            Entropy.println("Error on 3D Landscape: " + JSON.stringify(error));
        }
    }

    private fbm3D(noise3D: (x: number, y: number, z: number) => number, x: number, y: number, z: number, octaves: number, frequency: number, persistence: number, lacunarity: number): number {
        let total = 0;
        let amplitude = 1;
        let maxValue = 0;
        let freq = frequency;

        for (let i = 0; i < octaves; i++) {
            total += noise3D(x * freq, y * freq, z * freq) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            freq *= lacunarity;
        }

        return total / maxValue;
    }

    // ==================== UTILS ====================

    private getVertexCountEstimate(): string {
        if (this.currentParams.use3D && this.currentParams.rockThreshold > 0.7) {
            // Marching Cubes estimate
            // res^3 cells * avg triangles per cell (approx 1.5) * 3 vertices
            const res = 48;
            const cells = Math.pow(res, 3);
            const est = Math.floor(cells * 1.5 * 3);
            return `${(est / 1000000).toFixed(2)}M (Volumetric)`;
        } else {
            // Heightmap estimate
            const est = this.currentParams.width * this.currentParams.height;
            return `${(est / 1000000).toFixed(2)}M (Heightmap)`;
        }
    }

    // ==================== UPDATE LOOP ====================

    private setupUpdateLoop(): void {
        this.api.onUpdate((time, pos, dir) => {
            // Handle debounced regeneration
            if (this.interopState.pendingRegenerateFrames > 0) {
                this.interopState.pendingRegenerateFrames--;
                if (this.interopState.pendingRegenerateFrames === 0) {
                    // Include current painting path for preview
                    const previewParams = { ...this.currentParams };
                    if (this.interopState.currentPaintPath && this.interopState.currentPaintPath.points.length >= 2) {
                        previewParams.paths = [...this.currentParams.paths, this.interopState.currentPaintPath];
                    }
                    this.generateTerrain(previewParams, this.state.activeComponentId);
                }
            }
        });
    }

    // ==================== UI SETUP ====================

    private setupUI(): void {
        const renderUI = (tab: string) => {
            Entropy.Addon.setVisibility(this.name, true);
            
            Entropy.UI.Widget.label(tab, { text: "⛰️ FlexNoise Terrain Settings", bold: true });
            
            this.renderComponentUI(tab, () => {
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            });

            this.renderPathUI(tab);
            this.renderTerrainParamsUI(tab);
            this.renderTextureInteropUI(tab);
            this.renderPresetsUI(tab);

            Entropy.UI.Widget.button(tab, {
                text: "💾 Save All to Project",
                onClick: () => {
                    this.saveToProject();
                    Entropy.println("Terrain state saved!");
                }
            });
        };

        if (Entropy.Composer) {
            Entropy.Composer.registerEditor(this.name, renderUI);
            if (Entropy.Composer.registerRenderer) {
                Entropy.Composer.registerRenderer(this.name, (id: string, params: any) => {
                    this.generateTerrain(params, id);
                });
            }
        }

        const tab = this.api.UI.createTab({
            title: "FlexNoise",
            onRender: async () => renderUI(tab)
        });
    }

    private renderPathUI(tab: string): void {
        Entropy.UI.Widget.label(tab, { text: "🛤️ Procedural Paths", bold: true });

        // Paint mode toggle
        Entropy.UI.Widget.button(tab, {
            text: this.interopState.paintingMode ? "✓ Finish Path Painting" : "🎨 Start Path Painting",
            onClick: () => {
                if (this.interopState.paintingMode) {
                    this.stopPathPainting();
                } else {
                    this.startPathPainting();
                }
            }
        });

        if (this.interopState.paintingMode) {
            Entropy.UI.Widget.label(tab, { 
                text: `Drawing... (${this.interopState.currentPaintPath?.points.length || 0} points)` 
            });
            
            Entropy.UI.Widget.button(tab, {
                text: "❌ Cancel",
                onClick: () => {
                    this.interopState.paintingMode = false;
                    this.interopState.currentPaintPath = null;
                }
            });
        }

        Entropy.UI.Widget.separator(tab);

        // Minimap with path visualization
        Entropy.UI.Widget.miniMap(tab, {
            landscapeId: "Global",
            brushSize: this.currentParams.brushSize,
            markers: this.getMinimapMarkers(),
            polylines: this.getMinimapPolylines(), // NEW: Polyline support needed
            onDraw: (x, y, brushSize) => {
                if (this.interopState.paintingMode) {
                    this.addPointToCurrentPath(x, y);
                }
            },
            onClick: (x, y) => { // NEW: Single click support needed
                if (this.interopState.paintingMode) {
                    this.addPointToCurrentPath(x, y);
                }
            }
        });

        Entropy.UI.Widget.separator(tab);

        // Path list
        if (this.currentParams.paths.length > 0) {
            Entropy.UI.Widget.label(tab, { text: "Saved Paths:", bold: true });
            this.currentParams.paths.forEach((path, idx) => {
                Entropy.UI.Widget.button(tab, {
                    text: `${this.interopState.selectedPathId === path.id ? "✓ " : ""}Path ${idx + 1} (${path.points.length} pts)`,
                    onClick: () => {
                        this.interopState.selectedPathId = path.id;
                    }
                });
            });
        }

        // Selected path controls
        const selectedPath = this.currentParams.paths.find(p => p.id === this.interopState.selectedPathId);
        if (selectedPath) {
            Entropy.UI.Widget.separator(tab);
            Entropy.UI.Widget.label(tab, { text: "Selected Path Settings:", bold: true });

            Entropy.UI.Widget.slider(tab, {
                label: "Path Width",
                value: selectedPath.width,
                min: 1,
                max: 25,
                onChange: (v) => {
                    selectedPath.width = parseFloat(v);
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Smoothness (Radius)",
                value: selectedPath.smoothness,
                min: 0,
                max: 100,
                onChange: (v) => {
                    selectedPath.smoothness = parseFloat(v);
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Flatten Strength",
                value: selectedPath.flattenStrength,
                min: 0,
                max: 1,
                onChange: (v) => {
                    selectedPath.flattenStrength = parseFloat(v);
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });

            Entropy.UI.Widget.slider(tab, {
                label: "Blend Falloff",
                value: selectedPath.blend,
                min: 0.5,
                max: 5,
                onChange: (v) => {
                    selectedPath.blend = parseFloat(v);
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🔧 Simplify Path",
                onClick: () => {
                    this.simplifyPath(selectedPath, 0.02);
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                    this.saveToProject();
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🗑️ Delete Path",
                onClick: () => {
                    this.currentParams.paths = this.currentParams.paths.filter(p => p.id !== selectedPath.id);
                    this.interopState.selectedPathId = "";
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });
        }

        Entropy.UI.Widget.separator(tab);

        // Debounce settings
        Entropy.UI.Widget.slider(tab, {
            label: "Paint Update Delay (ms)",
            value: this.interopState.paintDebounceMs,
            min: 50,
            max: 500,
            onChange: (v) => {
                this.interopState.paintDebounceMs = parseFloat(v);
            }
        });

        Entropy.UI.Widget.separator(tab);

        // Quick path presets
        Entropy.UI.Widget.label(tab, { text: "Quick Add:", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "➕ Straight Path",
            onClick: () => {
                const path = this.createPath([
                    { x: 0.3, z: 0.3 },
                    { x: 0.7, z: 0.7 }
                ], 8, 3, 0.9, 2);
                this.currentParams.paths.push(path);
                this.interopState.selectedPathId = path.id;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "➕ Curved Path",
            onClick: () => {
                const path = this.createPath([
                    { x: 0.2, z: 0.2 },
                    { x: 0.4, z: 0.5 },
                    { x: 0.6, z: 0.5 },
                    { x: 0.8, z: 0.8 }
                ], 8, 3, 0.9, 2);
                this.currentParams.paths.push(path);
                this.interopState.selectedPathId = path.id;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "➕ River Path",
            onClick: () => {
                const path = this.createPath([
                    { x: 0.1, z: 0.5 },
                    { x: 0.3, z: 0.4 },
                    { x: 0.5, z: 0.6 },
                    { x: 0.7, z: 0.5 },
                    { x: 0.9, z: 0.5 }
                ], 12, 4, 1.0, 2.5);
                this.currentParams.paths.push(path);
                this.interopState.selectedPathId = path.id;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.separator(tab);
    }

    private renderTerrainParamsUI(tab: string): void {
        Entropy.UI.Widget.label(tab, { text: "🎲 Noise Parameters", bold: true });

        const est = this.getVertexCountEstimate();
        const color = est.includes("Heightmap") ? "Green" : "Orange";
        Entropy.UI.Widget.label(tab, { 
            text: `Estimated Vertices: ${est}`, 
            bold: true 
        });
        
        Entropy.UI.Widget.numericInput(tab, {
            label: "Seed",
            value: this.currentParams.seed,
            onChange: (val: string) => {
                this.currentParams.seed = parseInt(val);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: this.currentParams.use3D ? "🧊 Noise: 3D (Animated)" : "📄 Noise: 2D (Static)",
            onClick: () => {
                this.currentParams.use3D = !this.currentParams.use3D;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        if (this.currentParams.use3D) {
            Entropy.UI.Widget.slider(tab, {
                label: "3D Time/Depth",
                value: this.currentParams.time,
                min: 0.0,
                max: 10.0,
                onChange: (val: string) => {
                    this.currentParams.time = parseFloat(val);
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });

            Entropy.UI.Widget.button(tab, {
                text: "🏚️ Generate Cave Prototype",
                onClick: () => {
                    this.currentParams.rockThreshold = 0.8; // Trigger 3D logic
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });
        }

        Entropy.UI.Widget.slider(tab, {
            label: "Frequency",
            value: this.currentParams.frequency,
            min: 0.0001,
            max: 0.05,
            onChange: (val: string) => {
                this.currentParams.frequency = parseFloat(val);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Octaves",
            value: this.currentParams.octaves,
            min: 1,
            max: 12,
            onChange: (val: string) => {
                this.currentParams.octaves = parseInt(val);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Persistence",
            value: this.currentParams.persistence,
            min: 0.0,
            max: 1.0,
            onChange: (val: string) => {
                this.currentParams.persistence = parseFloat(val);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.slider(tab, {
            label: "Lacunarity",
            value: this.currentParams.lacunarity,
            min: 1.0,
            max: 4.0,
            onChange: (val: string) => {
                this.currentParams.lacunarity = parseFloat(val);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.separator(tab);
        Entropy.UI.Widget.label(tab, { text: "📐 Geometry & Scale", bold: true });

        Entropy.UI.Widget.slider(tab, {
            label: "Height Scale",
            value: this.currentParams.heightScale,
            min: 0.1,
            max: 10.0,
            onChange: (val: string) => {
                this.currentParams.heightScale = parseFloat(val);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.label(tab, { text: "🖥️ Resolution", bold: true });
        
        const resolutions = [128, 256, 512, 1024];
        resolutions.forEach(res => {
            Entropy.UI.Widget.button(tab, {
                text: `Set Resolution: ${res}x${res}`,
                onClick: () => {
                    this.currentParams.width = res;
                    this.currentParams.height = res;
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });
        });

        Entropy.UI.Widget.separator(tab);
        Entropy.UI.Widget.label(tab, { text: "🎨 Visuals", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: this.currentParams.usePBR ? "✨ Mode: PBR (Realistic)" : "🎨 Mode: Custom Color",
            onClick: () => {
                this.currentParams.usePBR = !this.currentParams.usePBR;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        if (!this.currentParams.usePBR) {
            Entropy.UI.Widget.colorInput(tab, {
                label: "Terrain Color",
                color: this.currentParams.terrainColor,
                onChange: (newColor: number[]) => {
                    this.currentParams.terrainColor = newColor as [number, number, number, number];
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                }
            });
        }

        Entropy.UI.Widget.separator(tab);
    }

    private renderTextureInteropUI(tab: string): void {
        Entropy.UI.Widget.label(tab, { text: "🔗 Texture Interop", bold: true });
        
        const slots = ["Primary", "Rockmap", "Soil"];
        Entropy.UI.Widget.dropdown(tab, {
            label: "Target Slot",
            options: slots,
            selectedIndex: slots.indexOf(this.interopState.selectedSlot),
            onChange: (idx) => {
                this.interopState.selectedSlot = slots[parseInt(idx)] as any;
            }
        });

        if (Entropy.Composer) {
            const texAddonName = "PBR Texture Designer Pro";
            const texComponents = Entropy.Composer.getComponents(texAddonName) || {};
            const texCompIds = Object.keys(texComponents);
            const texCompNames = texCompIds.map(id => texComponents[id].name);

            if (texCompIds.length > 0) {
                Entropy.UI.Widget.dropdown(tab, {
                    label: "Texture Component",
                    options: texCompNames,
                    selectedIndex: Math.max(0, texCompIds.indexOf(this.interopState.selectedTextureCompId)),
                    onChange: (idx) => {
                        this.interopState.selectedTextureCompId = texCompIds[parseInt(idx)];
                    }
                });

                Entropy.UI.Widget.button(tab, {
                    text: "✨ Apply Selected Component",
                    onClick: () => {
                        const compId = this.interopState.selectedTextureCompId || texCompIds[0];
                        const comp = texComponents[compId];
                        if (comp) {
                            this.currentParams.textureLayers[this.interopState.selectedSlot] = compId;

                            const generator = (Entropy.Composer as any).getTextureGenerator?.(texAddonName);
                            if (generator) {
                                generator("temp_interop_gen", comp.params, TEXTURE_RES);
                                this.applyPBRToSlot("FlexNoise Terrain", "temp_interop_gen", this.interopState.selectedSlot);
                                this.applyPBRToSlot("Game Composer", "temp_interop_gen", this.interopState.selectedSlot);
                            } else {
                                const renderer = Entropy.Composer?.getRenderer(texAddonName);
                                if (renderer) {
                                    renderer("temp_interop_gen", comp.params);
                                    this.applyPBRToSlot("FlexNoise Terrain", "temp_interop_gen", this.interopState.selectedSlot);
                                    this.applyPBRToSlot("Game Composer", "temp_interop_gen", this.interopState.selectedSlot);
                                }
                            }
                            
                            Entropy.println(`Linked component ${comp.name} to ${this.interopState.selectedSlot}`);
                        }
                    }
                });
            } else {
                Entropy.UI.Widget.label(tab, { text: "(No Texture Components saved yet)" });
            }
        }

        Entropy.UI.Widget.separator(tab);
    }

    private renderPresetsUI(tab: string): void {
        Entropy.UI.Widget.label(tab, { text: "🎭 Terrain Presets", bold: true });
        
        Entropy.UI.Widget.button(tab, {
            text: "🏔️ Sharp Mountains (~1M)",
            onClick: () => {
                this.currentParams.frequency = 0.01;
                this.currentParams.octaves = 8;
                this.currentParams.persistence = 0.5;
                this.currentParams.heightScale = 7.0;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🏜️ Rolling Hills (~1M)",
            onClick: () => {
                this.currentParams.frequency = 0.003;
                this.currentParams.octaves = 4;
                this.currentParams.persistence = 0.3;
                this.currentParams.heightScale = 1.5;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🌊 Sea Bed (~1M)",
            onClick: () => {
                this.currentParams.frequency = 0.002;
                this.currentParams.octaves = 3;
                this.currentParams.persistence = 0.4;
                this.currentParams.heightScale = 1.25;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🏚️ Deep Caverns (~0.5M 3D)",
            onClick: () => {
                this.currentParams.use3D = true;
                this.currentParams.rockThreshold = 0.8;
                this.currentParams.frequency = 0.02;
                this.currentParams.octaves = 4;
                this.currentParams.heightScale = 2.0;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "☁️ Floating Islands (~0.5M 3D)",
            onClick: () => {
                this.currentParams.use3D = true;
                this.currentParams.rockThreshold = 0.8;
                this.currentParams.frequency = 0.01;
                this.currentParams.octaves = 6;
                this.currentParams.heightScale = 5.0;
                this.currentParams.positionY = 50.0;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🌀 Alien Pillars (~0.5M 3D)",
            onClick: () => {
                this.currentParams.use3D = true;
                this.currentParams.rockThreshold = 0.6;
                this.currentParams.frequency = 0.01;
                this.currentParams.octaves = 2;
                this.currentParams.heightScale = 8.0;
                this.currentParams.positionY = 0.0;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });

        Entropy.UI.Widget.button(tab, {
            text: "🏛️ Ruined Arches (~0.5M 3D)",
            onClick: () => {
                this.currentParams.use3D = true;
                this.currentParams.rockThreshold = 0.7;
                this.currentParams.frequency = 0.03;
                this.currentParams.octaves = 1;
                this.currentParams.heightScale = 4.0;
                this.currentParams.positionY = 0.0;
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
            }
        });
    }

    // ==================== TOOLS SETUP ====================

    private setupTools(): void {
        this.tool("update_terrain_parameters")
            .description("Update the procedural noise parameters for the terrain generation.")
            .parameters({
                type: "object",
                properties: {
                    seed: { type: "number", description: "Random seed for the noise generator" },
                    frequency: { type: "number", description: "Noise frequency (detail density). Suggested: 0.001 to 0.05" },
                    octaves: { type: "number", description: "Number of noise layers. Suggested: 1 to 8" },
                    persistence: { type: "number", description: "Amplitude reduction per octave. Suggested: 0.0 to 1.0" },
                    lacunarity: { type: "number", description: "Frequency multiplier per octave. Suggested: 1.0 to 4.0" },
                    heightScale: { type: "number", description: "Vertical scaling factor. Suggested: 0.1 to 10.0" }
                }
            })
            .handler((args: any) => {
                let changed = false;
                
                if (typeof args.seed !== "undefined") { this.currentParams.seed = args.seed; changed = true; }
                if (typeof args.frequency !== "undefined") { this.currentParams.frequency = args.frequency; changed = true; }
                if (typeof args.octaves !== "undefined") { this.currentParams.octaves = args.octaves; changed = true; }
                if (typeof args.persistence !== "undefined") { this.currentParams.persistence = args.persistence; changed = true; }
                if (typeof args.lacunarity !== "undefined") { this.currentParams.lacunarity = args.lacunarity; changed = true; }
                if (typeof args.heightScale !== "undefined") { this.currentParams.heightScale = args.heightScale; changed = true; }

                if (changed) {
                    this.generateTerrain(this.currentParams, this.state.activeComponentId);
                    this.saveToProject();
                    return { success: true, currentParams: this.currentParams };
                }
                return { success: false, error: "No parameters provided to update." };
            })
            .register();

        this.tool("add_terrain_path")
            .description("Add a procedural flattened path to the terrain. Paths create roads, rivers, or trails by flattening the terrain along a series of points.")
            .parameters({
                type: "object",
                properties: {
                    points: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                x: { type: "number", description: "X coordinate (0-1 normalized)" },
                                z: { type: "number", description: "Z coordinate (0-1 normalized)" }
                            },
                            required: ["x", "z"]
                        },
                        description: "Array of path points in normalized coordinates (0-1 range)"
                    },
                    width: { type: "number", description: "Path width in terrain units. Default: 8" },
                    smoothness: { type: "number", description: "Smoothing radius for flattening. Default: 3" },
                    flattenStrength: { type: "number", description: "How much to flatten (0-1). Default: 0.9" },
                    blend: { type: "number", description: "Falloff curve power. Higher = sharper edges. Default: 2" }
                },
                required: ["points"]
            })
            .handler((args: any) => {
                if (!args.points || args.points.length < 2) {
                    return { success: false, error: "Path requires at least 2 points" };
                }

                const path = this.createPath(
                    args.points,
                    args.width || 8,
                    args.smoothness || 3,
                    args.flattenStrength || 0.9,
                    args.blend || 2
                );

                this.currentParams.paths.push(path);
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
                this.saveToProject();

                return { 
                    success: true, 
                    pathId: path.id,
                    message: `Added path with ${args.points.length} points`
                };
            })
            .register();

        this.tool("remove_terrain_path")
            .description("Remove a path from the terrain by its ID or index.")
            .parameters({
                type: "object",
                properties: {
                    pathId: { type: "string", description: "Path ID to remove" },
                    index: { type: "number", description: "Path index to remove (0-based)" }
                }
            })
            .handler((args: any) => {
                if (args.pathId) {
                    const before = this.currentParams.paths.length;
                    this.currentParams.paths = this.currentParams.paths.filter(p => p.id !== args.pathId);
                    if (this.currentParams.paths.length < before) {
                        this.generateTerrain(this.currentParams, this.state.activeComponentId);
                        this.saveToProject();
                        return { success: true, message: "Path removed" };
                    }
                    return { success: false, error: "Path ID not found" };
                } else if (typeof args.index !== "undefined") {
                    if (args.index >= 0 && args.index < this.currentParams.paths.length) {
                        this.currentParams.paths.splice(args.index, 1);
                        this.generateTerrain(this.currentParams, this.state.activeComponentId);
                        this.saveToProject();
                        return { success: true, message: "Path removed" };
                    }
                    return { success: false, error: "Invalid path index" };
                }
                return { success: false, error: "Provide either pathId or index" };
            })
            .register();

        this.tool("apply_texture_to_terrain")
            .description("Apply a PBR texture component to a specific terrain layer.")
            .parameters({
                type: "object",
                properties: {
                    textureComponentId: { type: "string", description: "The ID of the PBR Texture component to apply." },
                    slot: { 
                        type: "string", 
                        enum: ["Primary", "Rockmap", "Soil"],
                        description: "The terrain layer to apply the texture to."
                    }
                },
                required: ["textureComponentId", "slot"]
            })
            .handler((args: any) => {
                if (!Entropy.Composer) {
                    return { success: false, error: "Composer not available." };
                }

                const texAddonName = "PBR Texture Designer Pro";
                const components = Entropy.Composer.getComponents(texAddonName) || {};
                
                let compId = args.textureComponentId;
                let comp = components[compId];
                
                if (!comp) {
                    const foundId = Object.keys(components).find(k => components[k].id === args.textureComponentId);
                    if (foundId) {
                        compId = foundId;
                        comp = components[foundId];
                    }
                }

                if (!comp) {
                    return { success: false, error: `Texture component '${args.textureComponentId}' not found.` };
                }

                const slot = args.slot as "Primary" | "Rockmap" | "Soil";
                this.currentParams.textureLayers[slot] = compId;

                const generator = (Entropy.Composer as any).getTextureGenerator?.(texAddonName);
                if (generator) {
                    generator("temp_interop_gen", comp.params, TEXTURE_RES);
                    this.applyPBRToSlot("FlexNoise Terrain", "temp_interop_gen", slot);
                    this.applyPBRToSlot("Game Composer", "temp_interop_gen", slot);
                    this.saveToProject();
                    return { success: true, message: `Applied texture '${comp.name}' to '${slot}' layer.` };
                } else {
                    const renderer = Entropy.Composer.getRenderer(texAddonName);
                    if (renderer) {
                        renderer("temp_interop_gen", comp.params);
                        this.applyPBRToSlot("FlexNoise Terrain", "temp_interop_gen", slot);
                        this.applyPBRToSlot("Game Composer", "temp_interop_gen", slot);
                        this.saveToProject();
                        return { success: true, message: `Applied texture '${comp.name}' to '${slot}' layer (legacy).` };
                    }
                }

                return { success: false, error: "Texture generator/renderer not found." };
            })
            .register();

        this.tool("save_terrain_component")
            .description("Save the current terrain settings as a reusable component for the Game Composer.")
            .parameters({
                type: "object",
                properties: {
                    name: { type: "string", description: "Name for this terrain configuration (e.g., 'Rocky Highlands')." }
                },
                required: ["name"]
            })
            .handler((args: any) => {
                const id = Entropy.generateUUID();
                const name = args.name;
                this.state.savedComponents.push({
                    id,
                    name,
                    params: JSON.parse(JSON.stringify(this.currentParams))
                });
                this.state.activeComponentId = id;
                if (Entropy.Composer) {
                    Entropy.Composer.registerComponent(this.name, id, name, this.currentParams);
                }
                this.saveToProject();
                
                return { success: true, id: id, name: name, addonName: this.name };
            })
            .register();
    }

    // ==================== PROJECT HANDLERS ====================

    private setupProjectHandlers(): void {
        this.api.onProjectChanged((newProjectId) => {
            if (this.loadFromProject()) {
                this.generateTerrain(this.currentParams, this.state.activeComponentId);
                this.restoreLayerTextures("FlexNoise Terrain", this.currentParams);
                this.restoreLayerTextures("Game Composer", this.currentParams);
            }
        });
    }

    // ==================== LIGHTING ====================

    private setupLighting(): void {
        this.api.Lighting.createPointLight({
            position: [-3.0, 4.0, 65.0],
            color: [0.9, 0.9, 0.9],
            intensity: 8.0,
            maxDistance: 150.0
        });

        this.api.Lighting.createPointLight({
            position: [3.0, 4.0, 10.0],
            color: [0.9, 0.9, 0.9],
            intensity: 8.0,
            maxDistance: 150.0
        });

        this.api.Lighting.createPointLight({
            position: [0.0, 5.0, -60.0],
            color: [0.9, 0.9, 0.9],
            intensity: 8.0,
            maxDistance: 150.0
        });
    }
}

// Initialize addon
new FlexNoiseAddon().registerAtom();