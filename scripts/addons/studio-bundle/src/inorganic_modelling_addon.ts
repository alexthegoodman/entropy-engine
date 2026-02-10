// ============================================================================
// INORGANIC MODELER - Professional 3D Modeling for Entropy Engine
// Vertex/Edge/Face selection, Gizmo transforms, CSG operations
// ============================================================================

// ===== TYPE DEFINITIONS =====

interface ModelerState {
    selectionMode: "vertex" | "edge" | "face" | "object";
    activeMeshId: string | null;
    selectedVertices: Set<number>;
    selectedEdges: Set<string>; // "v1-v2" format
    selectedFaces: Set<string>; // "v1-v2-v3-..." format
    gizmoMode: "translate" | "rotate" | "scale";
    gizmoSpace: "world" | "local";
    activeGizmoId: string | null;
    meshes: Map<string, MeshData>;
    primitiveLibrary: Map<string, PrimitiveTemplate>;
    history: HistoryState[];
    historyIndex: number;
}

interface MeshData {
    id: string;
    name: string;
    vertices: number[]; // [x,y,z, nx,ny,nz, u,v, r,g,b,a, ...]
    indices: number[];
    position: [number, number, number];
    rotation: [number, number, number];
    scale: [number, number, number];
    pipelineId: string | null;
    renderRole: string | null;
}

interface PrimitiveTemplate {
    name: string;
    generate: (params: any) => { vertices: number[], indices: number[] };
}

interface HistoryState {
    type: string;
    meshId: string;
    data: any;
}

// ===== PRIMITIVE GENERATORS =====

class PrimitiveGenerator {
    static cube(size = 1.0): { vertices: number[], indices: number[] } {
        const s = size / 2;
        const vertices: number[] = [];
        const indices: number[] = [];
        
        // Each vertex: x,y,z, nx,ny,nz, u,v, r,g,b,a
        const positions = [
            // Front face
            [-s, -s,  s], [ s, -s,  s], [ s,  s,  s], [-s,  s,  s],
            // Back face
            [-s, -s, -s], [-s,  s, -s], [ s,  s, -s], [ s, -s, -s],
            // Top face
            [-s,  s, -s], [-s,  s,  s], [ s,  s,  s], [ s,  s, -s],
            // Bottom face
            [-s, -s, -s], [ s, -s, -s], [ s, -s,  s], [-s, -s,  s],
            // Right face
            [ s, -s, -s], [ s,  s, -s], [ s,  s,  s], [ s, -s,  s],
            // Left face
            [-s, -s, -s], [-s, -s,  s], [-s,  s,  s], [-s,  s, -s],
        ];
        
        const normals = [
            [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1],       // Front
            [0, 0, -1], [0, 0, -1], [0, 0, -1], [0, 0, -1],   // Back
            [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0],       // Top
            [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0],   // Bottom
            [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0],       // Right
            [-1, 0, 0], [-1, 0, 0], [-1, 0, 0], [-1, 0, 0],   // Left
        ];
        
        const uvs = [
            [0, 0], [1, 0], [1, 1], [0, 1],  // Front
            [1, 0], [1, 1], [0, 1], [0, 0],  // Back
            [0, 1], [0, 0], [1, 0], [1, 1],  // Top
            [1, 1], [0, 1], [0, 0], [1, 0],  // Bottom
            [1, 0], [1, 1], [0, 1], [0, 0],  // Right
            [0, 0], [1, 0], [1, 1], [0, 1],  // Left
        ];
        
        for (let i = 0; i < 24; i++) {
            vertices.push(
                ...positions[i],  // position
                ...normals[i],    // normal
                ...uvs[i],        // uv
                0.7, 0.7, 0.7, 1.0 // color
            );
        }
        
        // Indices (6 faces, 2 triangles each)
        for (let i = 0; i < 6; i++) {
            const offset = i * 4;
            indices.push(
                offset, offset + 1, offset + 2,
                offset, offset + 2, offset + 3
            );
        }
        
        return { vertices, indices };
    }
    
    static sphere(radius = 1.0, segments = 32, rings = 16): { vertices: number[], indices: number[] } {
        const vertices: number[] = [];
        const indices: number[] = [];
        
        for (let ring = 0; ring <= rings; ring++) {
            const v = ring / rings;
            const phi = v * Math.PI;
            
            for (let seg = 0; seg <= segments; seg++) {
                const u = seg / segments;
                const theta = u * Math.PI * 2;
                
                const x = radius * Math.sin(phi) * Math.cos(theta);
                const y = radius * Math.cos(phi);
                const z = radius * Math.sin(phi) * Math.sin(theta);
                
                const nx = Math.sin(phi) * Math.cos(theta);
                const ny = Math.cos(phi);
                const nz = Math.sin(phi) * Math.sin(theta);
                
                vertices.push(
                    x, y, z,           // position
                    nx, ny, nz,        // normal
                    u, v,              // uv
                    0.7, 0.7, 0.7, 1.0 // color
                );
            }
        }
        
        for (let ring = 0; ring < rings; ring++) {
            for (let seg = 0; seg < segments; seg++) {
                const a = ring * (segments + 1) + seg;
                const b = a + segments + 1;
                
                indices.push(a, b, a + 1);
                indices.push(b, b + 1, a + 1);
            }
        }
        
        return { vertices, indices };
    }
    
    static cylinder(radius = 1.0, height = 2.0, segments = 32): { vertices: number[], indices: number[] } {
        const vertices: number[] = [];
        const indices: number[] = [];
        const halfHeight = height / 2;
        
        // Side vertices
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const x = radius * Math.cos(theta);
            const z = radius * Math.sin(theta);
            const u = i / segments;
            
            const nx = Math.cos(theta);
            const nz = Math.sin(theta);
            
            // Top vertex
            vertices.push(
                x, halfHeight, z,
                nx, 0, nz,
                u, 0,
                0.7, 0.7, 0.7, 1.0
            );
            
            // Bottom vertex
            vertices.push(
                x, -halfHeight, z,
                nx, 0, nz,
                u, 1,
                0.7, 0.7, 0.7, 1.0
            );
        }
        
        // Side faces
        for (let i = 0; i < segments; i++) {
            const a = i * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            
            indices.push(a, b, c);
            indices.push(b, d, c);
        }
        
        // Cap centers
        const topCenterIdx = vertices.length / 13;
        vertices.push(0, halfHeight, 0, 0, 1, 0, 0.5, 0.5, 0.7, 0.7, 0.7, 1.0);
        
        const bottomCenterIdx = vertices.length / 13;
        vertices.push(0, -halfHeight, 0, 0, -1, 0, 0.5, 0.5, 0.7, 0.7, 0.7, 1.0);
        
        // Top cap
        for (let i = 0; i < segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const x = radius * Math.cos(theta);
            const z = radius * Math.sin(theta);
            
            const capIdx = vertices.length / 13;
            vertices.push(x, halfHeight, z, 0, 1, 0, 0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta), 0.7, 0.7, 0.7, 1.0);
            
            const nextIdx = i === segments - 1 ? topCenterIdx + 1 : capIdx + 1;
            indices.push(topCenterIdx, nextIdx, capIdx);
        }
        
        // Bottom cap
        for (let i = 0; i < segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const x = radius * Math.cos(theta);
            const z = radius * Math.sin(theta);
            
            const capIdx = vertices.length / 13;
            vertices.push(x, -halfHeight, z, 0, -1, 0, 0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta), 0.7, 0.7, 0.7, 1.0);
            
            const nextIdx = i === segments - 1 ? bottomCenterIdx + 1 : capIdx + 1;
            indices.push(bottomCenterIdx, capIdx, nextIdx);
        }
        
        return { vertices, indices };
    }
    
    static cone(radius = 1.0, height = 2.0, segments = 32): { vertices: number[], indices: number[] } {
        const vertices: number[] = [];
        const indices: number[] = [];
        const halfHeight = height / 2;
        
        // Apex
        const apexIdx = 0;
        vertices.push(0, halfHeight, 0, 0, 1, 0, 0.5, 0, 0.7, 0.7, 0.7, 1.0);
        
        // Base vertices
        for (let i = 0; i <= segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const x = radius * Math.cos(theta);
            const z = radius * Math.sin(theta);
            
            // Calculate normal for smooth shading
            const len = Math.sqrt(radius * radius + height * height);
            const nx = (height * Math.cos(theta)) / len;
            const ny = radius / len;
            const nz = (height * Math.sin(theta)) / len;
            
            vertices.push(
                x, -halfHeight, z,
                nx, ny, nz,
                i / segments, 1,
                0.7, 0.7, 0.7, 1.0
            );
        }
        
        // Side faces
        for (let i = 0; i < segments; i++) {
            indices.push(apexIdx, i + 2, i + 1);
        }
        
        // Base center
        const baseCenterIdx = vertices.length / 13;
        vertices.push(0, -halfHeight, 0, 0, -1, 0, 0.5, 0.5, 0.7, 0.7, 0.7, 1.0);
        
        // Base cap
        for (let i = 0; i < segments; i++) {
            const theta = (i / segments) * Math.PI * 2;
            const x = radius * Math.cos(theta);
            const z = radius * Math.sin(theta);
            
            const capIdx = vertices.length / 13;
            vertices.push(x, -halfHeight, z, 0, -1, 0, 0.5 + 0.5 * Math.cos(theta), 0.5 + 0.5 * Math.sin(theta), 0.7, 0.7, 0.7, 1.0);
            
            const nextIdx = i === segments - 1 ? baseCenterIdx + 1 : capIdx + 1;
            indices.push(baseCenterIdx, capIdx, nextIdx);
        }
        
        return { vertices, indices };
    }
    
    static torus(majorRadius = 1.0, minorRadius = 0.3, majorSegments = 32, minorSegments = 16): { vertices: number[], indices: number[] } {
        const vertices: number[] = [];
        const indices: number[] = [];
        
        for (let i = 0; i <= majorSegments; i++) {
            const u = (i / majorSegments) * Math.PI * 2;
            const cosU = Math.cos(u);
            const sinU = Math.sin(u);
            
            for (let j = 0; j <= minorSegments; j++) {
                const v = (j / minorSegments) * Math.PI * 2;
                const cosV = Math.cos(v);
                const sinV = Math.sin(v);
                
                const x = (majorRadius + minorRadius * cosV) * cosU;
                const y = minorRadius * sinV;
                const z = (majorRadius + minorRadius * cosV) * sinU;
                
                const nx = cosV * cosU;
                const ny = sinV;
                const nz = cosV * sinU;
                
                vertices.push(
                    x, y, z,
                    nx, ny, nz,
                    i / majorSegments, j / minorSegments,
                    0.7, 0.7, 0.7, 1.0
                );
            }
        }
        
        for (let i = 0; i < majorSegments; i++) {
            for (let j = 0; j < minorSegments; j++) {
                const a = i * (minorSegments + 1) + j;
                const b = a + minorSegments + 1;
                
                indices.push(a, b, a + 1);
                indices.push(b, b + 1, a + 1);
            }
        }
        
        return { vertices, indices };
    }
    
    static plane(width = 2.0, depth = 2.0, widthSegments = 1, depthSegments = 1): { vertices: number[], indices: number[] } {
        const vertices: number[] = [];
        const indices: number[] = [];
        
        const halfWidth = width / 2;
        const halfDepth = depth / 2;
        
        for (let i = 0; i <= depthSegments; i++) {
            const z = -halfDepth + (i / depthSegments) * depth;
            const v = i / depthSegments;
            
            for (let j = 0; j <= widthSegments; j++) {
                const x = -halfWidth + (j / widthSegments) * width;
                const u = j / widthSegments;
                
                vertices.push(
                    x, 0, z,
                    0, 1, 0,
                    u, v,
                    0.7, 0.7, 0.7, 1.0
                );
            }
        }
        
        for (let i = 0; i < depthSegments; i++) {
            for (let j = 0; j < widthSegments; j++) {
                const a = i * (widthSegments + 1) + j;
                const b = a + widthSegments + 1;
                
                indices.push(a, b, a + 1);
                indices.push(b, b + 1, a + 1);
            }
        }
        
        return { vertices, indices };
    }

    static pyramid(baseSize = 1.0, height = 1.5): { vertices: number[], indices: number[] } {
        const vertices: number[] = [];
        const indices: number[] = [];
        const h = baseSize / 2;
        const apex = height / 2;
        const base = -height / 2;
        
        // Apex
        vertices.push(0, apex, 0, 0, 1, 0, 0.5, 0.5, 0.7, 0.7, 0.7, 1.0);
        
        // Base corners
        const baseCorners = [
            [-h, base, -h],
            [ h, base, -h],
            [ h, base,  h],
            [-h, base,  h],
        ];
        
        // Create side faces with proper normals
        for (let i = 0; i < 4; i++) {
            const current = baseCorners[i];
            const next = baseCorners[(i + 1) % 4];
            
            // Calculate face normal
            const edge1 = [next[0] - current[0], next[1] - current[1], next[2] - current[2]];
            const edge2 = [0 - current[0], apex - current[1], 0 - current[2]];
            const normal = [
                edge1[1] * edge2[2] - edge1[2] * edge2[1],
                edge1[2] * edge2[0] - edge1[0] * edge2[2],
                edge1[0] * edge2[1] - edge1[1] * edge2[0]
            ];
            const len = Math.sqrt(normal[0]**2 + normal[1]**2 + normal[2]**2);
            normal[0] /= len; normal[1] /= len; normal[2] /= len;
            
            const vIdx = vertices.length / 13;
            
            // Add vertices for this face
            vertices.push(0, apex, 0, ...normal, 0.5, 0, 0.7, 0.7, 0.7, 1.0);
            vertices.push(...current, ...normal, 0, 1, 0.7, 0.7, 0.7, 1.0);
            vertices.push(...next, ...normal, 1, 1, 0.7, 0.7, 0.7, 1.0);
            
            indices.push(vIdx, vIdx + 1, vIdx + 2);
        }
        
        // Base face
        const baseCenter = vertices.length / 13;
        vertices.push(0, base, 0, 0, -1, 0, 0.5, 0.5, 0.7, 0.7, 0.7, 1.0);
        
        for (let i = 0; i < 4; i++) {
            const current = baseCorners[i];
            const next = baseCorners[(i + 1) % 4];
            
            const v1 = vertices.length / 13;
            vertices.push(...current, 0, -1, 0, 0, 0, 0.7, 0.7, 0.7, 1.0);
            const v2 = vertices.length / 13;
            vertices.push(...next, 0, -1, 0, 1, 0, 0.7, 0.7, 0.7, 1.0);
            
            indices.push(baseCenter, v1, v2);
        }
        
        return { vertices, indices };
    }
}

// ===== MESH UTILITIES =====

class MeshUtils {
    static getVertexPosition(vertices: number[], vertexIndex: number): [number, number, number] {
        const offset = vertexIndex * 13;
        return [vertices[offset], vertices[offset + 1], vertices[offset + 2]];
    }
    
    static setVertexPosition(vertices: number[], vertexIndex: number, pos: [number, number, number]) {
        const offset = vertexIndex * 13;
        vertices[offset] = pos[0];
        vertices[offset + 1] = pos[1];
        vertices[offset + 2] = pos[2];
    }
    
    static getVertexNormal(vertices: number[], vertexIndex: number): [number, number, number] {
        const offset = vertexIndex * 13;
        return [vertices[offset + 3], vertices[offset + 4], vertices[offset + 5]];
    }
    
    static setVertexNormal(vertices: number[], vertexIndex: number, normal: [number, number, number]) {
        const offset = vertexIndex * 13;
        vertices[offset + 3] = normal[0];
        vertices[offset + 4] = normal[1];
        vertices[offset + 5] = normal[2];
    }
    
    static recalculateNormals(vertices: number[], indices: number[]) {
        const vertexCount = vertices.length / 13;
        const normals = new Array(vertexCount).fill(0).map(() => [0, 0, 0]);
        
        // Calculate face normals and accumulate
        for (let i = 0; i < indices.length; i += 3) {
            const i0 = indices[i];
            const i1 = indices[i + 1];
            const i2 = indices[i + 2];
            
            const p0 = this.getVertexPosition(vertices, i0);
            const p1 = this.getVertexPosition(vertices, i1);
            const p2 = this.getVertexPosition(vertices, i2);
            
            const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
            const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            
            const normal = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0]
            ];
            
            normals[i0][0] += normal[0];
            normals[i0][1] += normal[1];
            normals[i0][2] += normal[2];
            
            normals[i1][0] += normal[0];
            normals[i1][1] += normal[1];
            normals[i1][2] += normal[2];
            
            normals[i2][0] += normal[0];
            normals[i2][1] += normal[1];
            normals[i2][2] += normal[2];
        }
        
        // Normalize and write back
        for (let i = 0; i < vertexCount; i++) {
            const len = Math.sqrt(normals[i][0]**2 + normals[i][1]**2 + normals[i][2]**2);
            if (len > 0.0001) {
                normals[i][0] /= len;
                normals[i][1] /= len;
                normals[i][2] /= len;
            }
            this.setVertexNormal(vertices, i, normals[i] as [number, number, number]);
        }
    }
    
    static getSelectionCenter(vertices: number[], selectedVertices: number[]): [number, number, number] {
        if (selectedVertices.length === 0) return [0, 0, 0];
        
        let sum = [0, 0, 0];
        for (const vIdx of selectedVertices) {
            const pos = this.getVertexPosition(vertices, vIdx);
            sum[0] += pos[0];
            sum[1] += pos[1];
            sum[2] += pos[2];
        }
        
        return [
            sum[0] / selectedVertices.length,
            sum[1] / selectedVertices.length,
            sum[2] / selectedVertices.length
        ];
    }
    
    static transformVertices(
        vertices: number[], 
        vertexIndices: number[], 
        delta: [number, number, number],
        mode: "translate" | "scale" | "rotate",
        center: [number, number, number]
    ) {
        for (const vIdx of vertexIndices) {
            const pos = this.getVertexPosition(vertices, vIdx);
            
            if (mode === "translate") {
                pos[0] += delta[0];
                pos[1] += delta[1];
                pos[2] += delta[2];
            } else if (mode === "scale") {
                // Scale relative to center
                const relative = [
                    pos[0] - center[0],
                    pos[1] - center[1],
                    pos[2] - center[2]
                ];
                
                pos[0] = center[0] + relative[0] * (1 + delta[0]);
                pos[1] = center[1] + relative[1] * (1 + delta[1]);
                pos[2] = center[2] + relative[2] * (1 + delta[2]);
            }
            // TODO: rotation needs proper quaternion math
            
            this.setVertexPosition(vertices, vIdx, pos);
        }
    }
    
    static extrudeFaces(vertices: number[], indices: number[], faceIndices: number[][], distance: number): { vertices: number[], indices: number[] } {
        // This is a complex operation - simplified version
        const newVertices = [...vertices];
        const newIndices = [...indices];
        
        // For each face, duplicate vertices and move along normal
        for (const face of faceIndices) {
            if (face.length < 3) continue;
            
            // Calculate face normal
            const p0 = this.getVertexPosition(vertices, face[0]);
            const p1 = this.getVertexPosition(vertices, face[1]);
            const p2 = this.getVertexPosition(vertices, face[2]);
            
            const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
            const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            
            const normal = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0]
            ];
            const len = Math.sqrt(normal[0]**2 + normal[1]**2 + normal[2]**2);
            if (len > 0.0001) {
                normal[0] /= len; normal[1] /= len; normal[2] /= len;
            }
            
            // Create new vertices
            const newVertexIndices: number[] = [];
            for (const vIdx of face) {
                const pos = this.getVertexPosition(vertices, vIdx);
                const newPos: [number, number, number] = [
                    pos[0] + normal[0] * distance,
                    pos[1] + normal[1] * distance,
                    pos[2] + normal[2] * distance
                ];
                
                // Duplicate entire vertex
                const offset = vIdx * 13;
                const newVIdx = newVertices.length / 13;
                for (let i = 0; i < 13; i++) {
                    newVertices.push(vertices[offset + i]);
                }
                // Update position
                this.setVertexPosition(newVertices, newVIdx, newPos);
                newVertexIndices.push(newVIdx);
            }
            
            // Create side faces
            for (let i = 0; i < face.length; i++) {
                const curr = i;
                const next = (i + 1) % face.length;
                
                const v0 = face[curr];
                const v1 = face[next];
                const v2 = newVertexIndices[next];
                const v3 = newVertexIndices[curr];
                
                newIndices.push(v0, v1, v2);
                newIndices.push(v0, v2, v3);
            }
            
            // Add top face
            if (newVertexIndices.length >= 3) {
                for (let i = 1; i < newVertexIndices.length - 1; i++) {
                    newIndices.push(newVertexIndices[0], newVertexIndices[i], newVertexIndices[i + 1]);
                }
            }
        }
        
        return { vertices: newVertices, indices: newIndices };
    }
}

// ===== ADDON REGISTRATION =====

const addonInfo = {
    name: "Inorganic Modeler",
    version: "1.0.0",
    description: "Professional 3D modeling with vertex/edge/face selection and gizmo transforms",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        ui: true
    }
};

const addon = Entropy.Addon.register(addonInfo);

let state: ModelerState = {
    selectionMode: "object",
    activeMeshId: null,
    selectedVertices: new Set(),
    selectedEdges: new Set(),
    selectedFaces: new Set(),
    gizmoMode: "translate",
    gizmoSpace: "world",
    activeGizmoId: null,
    meshes: new Map(),
    primitiveLibrary: new Map(),
    history: [],
    historyIndex: -1
};

let defaultPipelineId: string | null = null;
let wireframePipelineId: string | null = null;

// ===== SHADERS =====

const WIREFRAME_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return in.color;
}
`;

// ===== INITIALIZATION =====

addon.onInit(async () => {
    Entropy.println("🔧 Inorganic Modeler: Initializing...");
    
    // Create default pipeline (PBR)
    defaultPipelineId = Entropy.Pipeline.create({
        name: "Modeler_Default",
        layout: "mesh",
        pbr: true
    });
    
    // Create wireframe pipeline for selection visualization
    wireframePipelineId = Entropy.Pipeline.create({
        name: "Modeler_Wireframe",
        layout: "mesh",
        vertexShader: WIREFRAME_SHADER,
        fragmentShader: WIREFRAME_SHADER,
        pbr: false
    });
    
    // Register primitives
    state.primitiveLibrary.set("cube", {
        name: "Cube",
        generate: (params) => PrimitiveGenerator.cube(params?.size ?? 1.0)
    });
    
    state.primitiveLibrary.set("sphere", {
        name: "Sphere",
        generate: (params) => PrimitiveGenerator.sphere(
            params?.radius ?? 1.0,
            params?.segments ?? 32,
            params?.rings ?? 16
        )
    });
    
    state.primitiveLibrary.set("cylinder", {
        name: "Cylinder",
        generate: (params) => PrimitiveGenerator.cylinder(
            params?.radius ?? 1.0,
            params?.height ?? 2.0,
            params?.segments ?? 32
        )
    });
    
    state.primitiveLibrary.set("cone", {
        name: "Cone",
        generate: (params) => PrimitiveGenerator.cone(
            params?.radius ?? 1.0,
            params?.height ?? 2.0,
            params?.segments ?? 32
        )
    });
    
    state.primitiveLibrary.set("torus", {
        name: "Torus",
        generate: (params) => PrimitiveGenerator.torus(
            params?.majorRadius ?? 1.0,
            params?.minorRadius ?? 0.3,
            params?.majorSegments ?? 32,
            params?.minorSegments ?? 16
        )
    });
    
    state.primitiveLibrary.set("plane", {
        name: "Plane",
        generate: (params) => PrimitiveGenerator.plane(
            params?.width ?? 2.0,
            params?.depth ?? 2.0,
            params?.widthSegments ?? 1,
            params?.depthSegments ?? 1
        )
    });
    
    state.primitiveLibrary.set("pyramid", {
        name: "Pyramid",
        generate: (params) => PrimitiveGenerator.pyramid(
            params?.baseSize ?? 1.0,
            params?.height ?? 1.5
        )
    });
    
    // Load saved state
    const savedState = addon.IO.load();
    if (savedState) {
        // Restore meshes
        if (savedState.meshes) {
            for (const [id, meshData] of Object.entries(savedState.meshes as any)) {
                state.meshes.set(id, meshData as MeshData);
                createMeshInEngine(meshData as MeshData);
            }
        }
    }
    
    // Setup UI
    setupUI();
    
    // Register tools for AI interaction
    registerTools();
    
    // Setup input handlers (placeholder until API is ready)
    setupInputHandlers();
    
    Entropy.println("✅ Inorganic Modeler: Ready!");
});

// ===== MESH MANAGEMENT =====

function createPrimitive(type: string, params: any = {}, name?: string): string {
    const template = state.primitiveLibrary.get(type);
    if (!template) {
        Entropy.println(`❌ Unknown primitive type: ${type}`);
        return "";
    }
    
    const { vertices, indices } = template.generate(params);
    const id = Entropy.generateUUID();
    
    const meshData: MeshData = {
        id,
        name: name || `${template.name}_${Date.now()}`,
        vertices,
        indices,
        position: params.position || [0, 0, 0],
        rotation: params.rotation || [0, 0, 0],
        scale: params.scale || [1, 1, 1],
        pipelineId: defaultPipelineId,
        renderRole: "Opaque"
    };
    
    state.meshes.set(id, meshData);
    createMeshInEngine(meshData);
    
    Entropy.println(`✅ Created ${template.name}: ${id}`);
    return id;
}

function createMeshInEngine(meshData: MeshData) {
    addon.Model.createMesh({
        id: meshData.id,
        position: meshData.position,
        rotation: meshData.rotation,
        scale: meshData.scale,
        vertexData: meshData.vertices,
        indexData: meshData.indices,
        pipelineId: meshData.pipelineId || defaultPipelineId!,
        renderRole: meshData.renderRole || "Opaque"
    });
}

function updateMeshInEngine(meshId: string) {
    const meshData = state.meshes.get(meshId);
    if (!meshData) return;
    
    // Clear old mesh and recreate
    addon.Model.clearMesh(meshId);
    createMeshInEngine(meshData);
}

function deleteMesh(meshId: string) {
    state.meshes.delete(meshId);
    addon.Model.clearMesh(meshId);
    
    if (state.activeMeshId === meshId) {
        state.activeMeshId = null;
        clearSelection();
    }
}

function clearSelection() {
    state.selectedVertices.clear();
    state.selectedEdges.clear();
    state.selectedFaces.clear();
    
    // TODO: Use Entropy.Selection.clear() when available
    // TODO: Hide gizmo when available
}

function setActiveMesh(meshId: string | null) {
    state.activeMeshId = meshId;
    clearSelection();
}

// ===== SELECTION OPERATIONS =====

function selectVertex(meshId: string, vertexIndex: number, addToSelection = false) {
    if (!addToSelection) {
        state.selectedVertices.clear();
    }
    state.selectedVertices.add(vertexIndex);
    
    // TODO: Use Entropy.Selection.highlightElements() when available
    Entropy.println(`Selected vertex ${vertexIndex} on mesh ${meshId}`);
    
    updateGizmoPosition();
}

function selectEdge(meshId: string, v1: number, v2: number, addToSelection = false) {
    if (!addToSelection) {
        state.selectedEdges.clear();
    }
    const edgeKey = `${Math.min(v1, v2)}-${Math.max(v1, v2)}`;
    state.selectedEdges.add(edgeKey);
    
    Entropy.println(`Selected edge ${edgeKey} on mesh ${meshId}`);
    updateGizmoPosition();
}

function selectFace(meshId: string, faceVertices: number[], addToSelection = false) {
    if (!addToSelection) {
        state.selectedFaces.clear();
    }
    const faceKey = faceVertices.sort((a, b) => a - b).join("-");
    state.selectedFaces.add(faceKey);
    
    Entropy.println(`Selected face ${faceKey} on mesh ${meshId}`);
    updateGizmoPosition();
}

function updateGizmoPosition() {
    if (!state.activeMeshId) return;
    
    const meshData = state.meshes.get(state.activeMeshId);
    if (!meshData) return;
    
    // Calculate center of selection
    const selectedVerts = Array.from(state.selectedVertices);
    if (selectedVerts.length > 0) {
        const center = MeshUtils.getSelectionCenter(meshData.vertices, selectedVerts);
        
        // TODO: Use Entropy.Gizmo.show() or updatePosition() when available
        Entropy.println(`Gizmo should be at: [${center[0].toFixed(2)}, ${center[1].toFixed(2)}, ${center[2].toFixed(2)}]`);
    }
}

// ===== TRANSFORM OPERATIONS =====

function transformSelection(delta: [number, number, number]) {
    if (!state.activeMeshId) return;
    
    const meshData = state.meshes.get(state.activeMeshId);
    if (!meshData) return;
    
    const selectedVerts = Array.from(state.selectedVertices);
    if (selectedVerts.length === 0) return;
    
    const center = MeshUtils.getSelectionCenter(meshData.vertices, selectedVerts);
    
    MeshUtils.transformVertices(
        meshData.vertices,
        selectedVerts,
        delta,
        state.gizmoMode,
        center
    );
    
    // Recalculate normals
    MeshUtils.recalculateNormals(meshData.vertices, meshData.indices);
    
    // Update mesh in engine
    updateMeshInEngine(state.activeMeshId);
    
    Entropy.println(`Transformed ${selectedVerts.length} vertices`);
}

// ===== MODELING OPERATIONS =====

function extrudeSelectedFaces(distance: number) {
    if (!state.activeMeshId) return;
    
    const meshData = state.meshes.get(state.activeMeshId);
    if (!meshData) return;
    
    if (state.selectedFaces.size === 0) {
        Entropy.println("⚠️ No faces selected for extrusion");
        return;
    }
    
    // Convert face keys to vertex indices
    const faceIndices: number[][] = Array.from(state.selectedFaces).map(faceKey => 
        faceKey.split("-").map(v => parseInt(v))
    );
    
    const result = MeshUtils.extrudeFaces(meshData.vertices, meshData.indices, faceIndices, distance);
    
    meshData.vertices = result.vertices;
    meshData.indices = result.indices;
    
    MeshUtils.recalculateNormals(meshData.vertices, meshData.indices);
    updateMeshInEngine(state.activeMeshId);
    
    Entropy.println(`✅ Extruded ${state.selectedFaces.size} faces by ${distance}`);
}

function duplicateMesh(meshId: string): string {
    const original = state.meshes.get(meshId);
    if (!original) return "";
    
    const newId = Entropy.generateUUID();
    const duplicate: MeshData = {
        ...original,
        id: newId,
        name: original.name + "_copy",
        vertices: [...original.vertices],
        indices: [...original.indices],
        position: [original.position[0] + 2, original.position[1], original.position[2]]
    };
    
    state.meshes.set(newId, duplicate);
    createMeshInEngine(duplicate);
    
    return newId;
}

function mergeMeshes(meshIds: string[]): string {
    if (meshIds.length < 2) {
        Entropy.println("⚠️ Need at least 2 meshes to merge");
        return "";
    }
    
    const mergedVertices: number[] = [];
    const mergedIndices: number[] = [];
    let vertexOffset = 0;
    
    for (const meshId of meshIds) {
        const meshData = state.meshes.get(meshId);
        if (!meshData) continue;
        
        // Add vertices
        mergedVertices.push(...meshData.vertices);
        
        // Add indices with offset
        for (const idx of meshData.indices) {
            mergedIndices.push(idx + vertexOffset);
        }
        
        vertexOffset += meshData.vertices.length / 13;
    }
    
    const newId = Entropy.generateUUID();
    const merged: MeshData = {
        id: newId,
        name: "Merged_Mesh",
        vertices: mergedVertices,
        indices: mergedIndices,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        pipelineId: defaultPipelineId,
        renderRole: "Opaque"
    };
    
    state.meshes.set(newId, merged);
    createMeshInEngine(merged);
    
    // Optionally delete original meshes
    // meshIds.forEach(id => deleteMesh(id));
    
    Entropy.println(`✅ Merged ${meshIds.length} meshes into ${newId}`);
    return newId;
}

// ===== INPUT HANDLERS (PLACEHOLDER) =====

function setupInputHandlers() {    
    Entropy.println("⚠️ Inorganic Input handlers");
        
    Entropy.Input.onMouseDown((button, x, y) => {
        if (button === 0) { // Left click
            const raycast = Entropy.Selection.raycast(x, y);
            if (raycast) {
                const shift = Entropy.Input.isShiftPressed();
                
                switch (state.selectionMode) {
                    case "vertex":
                        if (raycast.vertexIndex !== undefined) {
                            selectVertex(raycast.meshId, raycast.vertexIndex, shift);
                        }
                        break;
                    case "edge":
                        if (raycast.edgeIndices) {
                            selectEdge(raycast.meshId, raycast.edgeIndices[0], raycast.edgeIndices[1], shift);
                        }
                        break;
                    case "face":
                        if (raycast.faceIndices) {
                            selectFace(raycast.meshId, raycast.faceIndices, shift);
                        }
                        break;
                    case "object":
                        setActiveMesh(raycast.meshId);
                        break;
                }
            }
        }
    });
    
    Entropy.Input.onKeyDown((key, ctrl, shift, alt) => {
        if (key === "g") { // Grab/Move
            state.gizmoMode = "translate";
            // Show gizmo
        } else if (key === "s") { // Scale
            state.gizmoMode = "scale";
        } else if (key === "r") { // Rotate
            state.gizmoMode = "rotate";
        } else if (key === "e") { // Extrude
            if (state.selectionMode === "face") {
                extrudeSelectedFaces(1.0);
            }
        } else if (key === "x" || key === "Delete") {
            // Delete selection
        }
    });
    
}

// ===== UI =====

function setupUI() {
    const tab = addon.UI.createTab({
        title: "Modeler",
        onRender: () => renderUI(tab)
    });
}

function renderUI(tab: string) {
    Entropy.UI.Widget.label(tab, { text: "🔧 Inorganic Modeler", bold: true });
    
    // Selection mode
    Entropy.UI.Widget.label(tab, { text: "Selection Mode", bold: true });
    const modes = ["object", "vertex", "edge", "face"];
    Entropy.UI.Widget.dropdown(tab, {
        label: "Mode",
        options: modes,
        selectedIndex: modes.indexOf(state.selectionMode),
        onChange: (idx) => {
            state.selectionMode = modes[parseInt(idx)] as any;
            clearSelection();
        }
    });
    
    Entropy.UI.Widget.separator(tab);
    
    // Gizmo settings
    Entropy.UI.Widget.label(tab, { text: "Transform", bold: true });
    const gizmoModes = ["translate", "rotate", "scale"];
    Entropy.UI.Widget.dropdown(tab, {
        label: "Gizmo Mode",
        options: gizmoModes,
        selectedIndex: gizmoModes.indexOf(state.gizmoMode),
        onChange: (idx) => {
            state.gizmoMode = gizmoModes[parseInt(idx)] as any;
        }
    });
    
    Entropy.UI.Widget.separator(tab);
    
    // Primitives
    Entropy.UI.Widget.label(tab, { text: "Add Primitive", bold: true });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Cube",
        onClick: () => createPrimitive("cube")
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Sphere",
        onClick: () => createPrimitive("sphere")
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Cylinder",
        onClick: () => createPrimitive("cylinder")
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Cone",
        onClick: () => createPrimitive("cone")
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Torus",
        onClick: () => createPrimitive("torus")
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Plane",
        onClick: () => createPrimitive("plane")
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "➕ Pyramid",
        onClick: () => createPrimitive("pyramid")
    });
    
    Entropy.UI.Widget.separator(tab);
    
    // Mesh operations
    Entropy.UI.Widget.label(tab, { text: "Mesh Operations", bold: true });
    
    if (state.activeMeshId) {
        const mesh = state.meshes.get(state.activeMeshId);
        Entropy.UI.Widget.label(tab, { text: `Active: ${mesh?.name || "None"}` });
        
        Entropy.UI.Widget.button(tab, {
            text: "🗑️ Delete Active Mesh",
            onClick: () => {
                if (state.activeMeshId) {
                    deleteMesh(state.activeMeshId);
                }
            }
        });
        
        Entropy.UI.Widget.button(tab, {
            text: "📋 Duplicate",
            onClick: () => {
                if (state.activeMeshId) {
                    duplicateMesh(state.activeMeshId);
                }
            }
        });
        
        if (state.selectedFaces.size > 0) {
            Entropy.UI.Widget.slider(tab, {
                label: "Extrude Distance",
                value: 1.0,
                min: -5.0,
                max: 5.0,
                onChange: (v) => {
                    extrudeSelectedFaces(parseFloat(v));
                }
            });
        }
        
        Entropy.UI.Widget.button(tab, {
            text: "🔄 Recalculate Normals",
            onClick: () => {
                if (state.activeMeshId) {
                    const mesh = state.meshes.get(state.activeMeshId);
                    if (mesh) {
                        MeshUtils.recalculateNormals(mesh.vertices, mesh.indices);
                        updateMeshInEngine(state.activeMeshId);
                    }
                }
            }
        });
    } else {
        Entropy.UI.Widget.label(tab, { text: "No active mesh" });
    }
    
    Entropy.UI.Widget.separator(tab);
    
    // Mesh list
    Entropy.UI.Widget.label(tab, { text: "Meshes in Scene", bold: true });
    
    for (const [id, mesh] of state.meshes) {
        Entropy.UI.Widget.button(tab, {
            text: `${mesh.name} ${id === state.activeMeshId ? "⭐" : ""}`,
            onClick: () => setActiveMesh(id)
        });
    }
    
    Entropy.UI.Widget.separator(tab);
    
    // Save/Load
    Entropy.UI.Widget.label(tab, { text: "Project", bold: true });
    
    Entropy.UI.Widget.button(tab, {
        text: "💾 Save All Meshes",
        onClick: () => {
            const meshesData = Object.fromEntries(state.meshes);
            addon.IO.save({ meshes: meshesData });
            Entropy.println("✅ Saved all meshes to project");
        }
    });
    
    Entropy.UI.Widget.button(tab, {
        text: "🗑️ Clear All Meshes",
        onClick: () => {
            for (const id of state.meshes.keys()) {
                addon.Model.clearMesh(id);
            }
            state.meshes.clear();
            state.activeMeshId = null;
            clearSelection();
        }
    });
    
    Entropy.UI.Widget.separator(tab);
    
    // Debug info
    Entropy.UI.Widget.label(tab, { text: `Vertices selected: ${state.selectedVertices.size}` });
    Entropy.UI.Widget.label(tab, { text: `Edges selected: ${state.selectedEdges.size}` });
    Entropy.UI.Widget.label(tab, { text: `Faces selected: ${state.selectedFaces.size}` });
}

// ===== AI TOOLS =====

function registerTools() {
    addon.registerTool({
        name: "create_primitive",
        description: "Create a primitive mesh (cube, sphere, cylinder, cone, torus, plane, pyramid)",
        parameters: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["cube", "sphere", "cylinder", "cone", "torus", "plane", "pyramid"],
                    description: "Type of primitive to create"
                },
                name: {
                    type: "string",
                    description: "Name for the mesh"
                },
                position: {
                    type: "array",
                    items: { type: "number" },
                    description: "Position [x, y, z]"
                },
                size: { type: "number", description: "Size parameter (for cube, etc.)" },
                radius: { type: "number", description: "Radius (for sphere, cylinder, cone)" },
                height: { type: "number", description: "Height (for cylinder, cone, pyramid)" },
                segments: { type: "number", description: "Number of segments for round shapes" }
            },
            required: ["type"]
        }
    }, (args: any) => {
        const id = createPrimitive(args.type, args, args.name);
        return { success: true, meshId: id };
    });
    
    addon.registerTool({
        name: "transform_selection",
        description: "Transform selected vertices/edges/faces",
        parameters: {
            type: "object",
            properties: {
                mode: {
                    type: "string",
                    enum: ["translate", "scale", "rotate"],
                    description: "Transform mode"
                },
                delta: {
                    type: "array",
                    items: { type: "number" },
                    description: "Transform delta [x, y, z]"
                }
            },
            required: ["mode", "delta"]
        }
    }, (args: any) => {
        state.gizmoMode = args.mode;
        transformSelection(args.delta);
        return { success: true };
    });
    
    addon.registerTool({
        name: "extrude_faces",
        description: "Extrude selected faces along their normals",
        parameters: {
            type: "object",
            properties: {
                distance: { type: "number", description: "Extrusion distance" }
            },
            required: ["distance"]
        }
    }, (args: any) => {
        extrudeSelectedFaces(args.distance);
        return { success: true };
    });
    
    addon.registerTool({
        name: "merge_meshes",
        description: "Merge multiple meshes into one",
        parameters: {
            type: "object",
            properties: {
                meshIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "IDs of meshes to merge"
                }
            },
            required: ["meshIds"]
        }
    }, (args: any) => {
        const newId = mergeMeshes(args.meshIds);
        return { success: true, meshId: newId };
    });
    
    addon.registerTool({
        name: "set_selection_mode",
        description: "Change selection mode (object, vertex, edge, face)",
        parameters: {
            type: "object",
            properties: {
                mode: {
                    type: "string",
                    enum: ["object", "vertex", "edge", "face"],
                    description: "Selection mode"
                }
            },
            required: ["mode"]
        }
    }, (args: any) => {
        state.selectionMode = args.mode;
        clearSelection();
        return { success: true, mode: args.mode };
    });
}