// *** Procedural House Generator ***
// Generates full-scale houses with proper rooms, doorways, windows, and stairs

import { ComponentAddon } from "./system";
import type { AddonMetadata } from "./addon";

// ============================================================================
// GEOMETRY UTILITIES
// ============================================================================

interface Vec3 { x: number; y: number; z: number; }
interface Vec2 { x: number; y: number; }

function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function vec2(x: number, y: number): Vec2 {
  return { x, y };
}

class MeshBuilder {
  vertices: number[] = [];
  indices: number[] = [];
  
  private vertexCount = 0;
  
  addVertex(pos: Vec3, normal: Vec3, uv: Vec2): number {
    this.vertices.push(pos.x, pos.y, pos.z);
    this.vertices.push(normal.x, normal.y, normal.z);
    this.vertices.push(uv.x, uv.y);
    return this.vertexCount++;
  }
  
  addQuad(v0: number, v1: number, v2: number, v3: number) {
    // Two triangles
    this.indices.push(v0, v1, v2);
    this.indices.push(v0, v2, v3);
  }
  
  addTriangle(v0: number, v1: number, v2: number) {
    this.indices.push(v0, v1, v2);
  }
  
  merge(other: MeshBuilder) {
    const offset = this.vertexCount;
    this.vertices.push(...other.vertices);
    this.indices.push(...other.indices.map(i => i + offset));
    this.vertexCount += other.vertexCount;
  }
}

// ============================================================================
// FLOOR PLAN STRUCTURES
// ============================================================================

class Rect {
  constructor(
    public x: number,
    public y: number,
    public width: number,
    public height: number
  ) {}
  
  get centerX() { return this.x + this.width / 2; }
  get centerY() { return this.y + this.height / 2; }
  get right() { return this.x + this.width; }
  get bottom() { return this.y + this.height; }
  
  splitVertical(ratio: number): [Rect, Rect] {
    const splitX = this.x + this.width * ratio;
    return [
      new Rect(this.x, this.y, splitX - this.x, this.height),
      new Rect(splitX, this.y, this.right - splitX, this.height)
    ];
  }
  
  splitHorizontal(ratio: number): [Rect, Rect] {
    const splitY = this.y + this.height * ratio;
    return [
      new Rect(this.x, this.y, this.width, splitY - this.y),
      new Rect(this.x, splitY, this.width, this.bottom - splitY)
    ];
  }
  
  shrink(amount: number): Rect {
    return new Rect(
      this.x + amount,
      this.y + amount,
      this.width - amount * 2,
      this.height - amount * 2
    );
  }
  
  intersects(other: Rect): boolean {
    return !(this.right < other.x || this.x > other.right ||
             this.bottom < other.y || this.y > other.bottom);
  }
  
  touches(other: Rect, threshold: number = 0.1): boolean {
    const xTouch = Math.abs(this.right - other.x) < threshold || 
                   Math.abs(this.x - other.right) < threshold;
    const yTouch = Math.abs(this.bottom - other.y) < threshold || 
                   Math.abs(this.y - other.bottom) < threshold;
    
    const xOverlap = !(this.right < other.x || this.x > other.right);
    const yOverlap = !(this.bottom < other.y || this.y > other.bottom);
    
    return (xTouch && yOverlap) || (yTouch && xOverlap);
  }
  
  getSharedEdge(other: Rect): { start: Vec2, end: Vec2, axis: 'x' | 'y' } | null {
    const threshold = 0.1;
    
    // Right edge of this touches left edge of other
    if (Math.abs(this.right - other.x) < threshold) {
      const overlapStart = Math.max(this.y, other.y);
      const overlapEnd = Math.min(this.bottom, other.bottom);
      if (overlapEnd > overlapStart) {
        return {
          start: vec2(this.right, overlapStart),
          end: vec2(this.right, overlapEnd),
          axis: 'x'
        };
      }
    }
    
    // Left edge of this touches right edge of other
    if (Math.abs(this.x - other.right) < threshold) {
      const overlapStart = Math.max(this.y, other.y);
      const overlapEnd = Math.min(this.bottom, other.bottom);
      if (overlapEnd > overlapStart) {
        return {
          start: vec2(this.x, overlapStart),
          end: vec2(this.x, overlapEnd),
          axis: 'x'
        };
      }
    }
    
    // Bottom edge of this touches top edge of other
    if (Math.abs(this.bottom - other.y) < threshold) {
      const overlapStart = Math.max(this.x, other.x);
      const overlapEnd = Math.min(this.right, other.right);
      if (overlapEnd > overlapStart) {
        return {
          start: vec2(overlapStart, this.bottom),
          end: vec2(overlapEnd, this.bottom),
          axis: 'y'
        };
      }
    }
    
    // Top edge of this touches bottom edge of other
    if (Math.abs(this.y - other.bottom) < threshold) {
      const overlapStart = Math.max(this.x, other.x);
      const overlapEnd = Math.min(this.right, other.right);
      if (overlapEnd > overlapStart) {
        return {
          start: vec2(overlapStart, this.y),
          end: vec2(overlapEnd, this.y),
          axis: 'y'
        };
      }
    }
    
    return null;
  }
}

type RoomType = "living_room" | "kitchen" | "bedroom" | "bathroom" | "hallway" | "dining_room" | "office";

class Room {
  type: RoomType = "bedroom";
  connectedRooms: Room[] = [];
  
  constructor(public bounds: Rect) {}
  
  get area() { return this.bounds.width * this.bounds.height; }
}

interface Doorway {
  position: Vec2;
  width: number;
  axis: 'x' | 'y'; // Direction the door opens
  room1: Room;
  room2: Room;
}

interface Window {
  position: Vec2;
  width: number;
  height: number;
  wallNormal: Vec2;
}

interface StairConfig {
  position: Vec2;
  direction: Vec2;
  width: number;
}

// ============================================================================
// HOUSE PARAMETERS
// ============================================================================

interface HouseParams {
  // Footprint
  width: number;
  depth: number;
  stories: number;
  
  // Style
  style: "modern" | "craftsman" | "traditional";
  
  // Room configuration
  minRoomSize: number;
  maxSubdivisions: number;
  
  // Details
  wallThickness: number;
  floorHeight: number;
  windowHeight: number;
  windowWidth: number;
  doorWidth: number;
  doorHeight: number;
  
  // Features
  addBasement: boolean;
  addAttic: boolean;
  addPorch: boolean;
  
  // Generation
  seed: number;
}

// ============================================================================
// SEEDED RANDOM
// ============================================================================

class SeededRandom {
  private seed: number;
  
  constructor(seed: number) {
    this.seed = seed;
  }
  
  next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
  
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  
  choice<T>(array: T[]): T {
    return array[Math.floor(this.next() * array.length)];
  }
}

// ============================================================================
// FLOOR PLAN GENERATOR
// ============================================================================

class FloorPlan {
  rooms: Room[] = [];
  doorways: Doorway[] = [];
  windows: Window[] = [];
  stairs: StairConfig | null = null;
  private rng: SeededRandom;
  
  constructor(seed: number) {
    this.rng = new SeededRandom(seed);
  }
  
  generate(params: HouseParams) {
    // 1. Create outer bounds (shrink slightly for walls)
    const bounds = new Rect(0, 0, params.width, params.depth);
    
    // 2. Subdivide into rooms
    this.rooms = this.subdivideRecursive(bounds, params, 0);
    
    // 3. Assign room types
    this.assignRoomTypes(params);
    
    // 4. Connect adjacent rooms with doorways
    this.placeDoorways(params);
    
    // 5. Place windows on exterior walls
    this.placeWindows(params);
    
    // 6. Place stairs if multi-story
    if (params.stories > 1) {
      this.placeStairs(params);
    }
  }
  
  private subdivideRecursive(rect: Rect, params: HouseParams, depth: number): Room[] {
    // Stop conditions
    if (depth >= params.maxSubdivisions) {
      return [new Room(rect)];
    }
    
    if (rect.width < params.minRoomSize * 2 && rect.height < params.minRoomSize * 2) {
      return [new Room(rect)];
    }
    
    // Can't split if too small in one dimension
    const canSplitVertical = rect.width >= params.minRoomSize * 2;
    const canSplitHorizontal = rect.height >= params.minRoomSize * 2;
    
    if (!canSplitVertical && !canSplitHorizontal) {
      return [new Room(rect)];
    }
    
    // Prefer splitting the longer side
    let splitVertical: boolean;
    if (canSplitVertical && !canSplitHorizontal) {
      splitVertical = true;
    } else if (!canSplitVertical && canSplitHorizontal) {
      splitVertical = false;
    } else {
      splitVertical = rect.width > rect.height;
      // Add some randomness
      if (this.rng.next() < 0.3) {
        splitVertical = !splitVertical;
      }
    }
    
    // Split ratio between 0.4 and 0.6 for balance
    const splitRatio = this.rng.range(0.4, 0.6);
    
    const [rect1, rect2] = splitVertical 
      ? rect.splitVertical(splitRatio)
      : rect.splitHorizontal(splitRatio);
    
    return [
      ...this.subdivideRecursive(rect1, params, depth + 1),
      ...this.subdivideRecursive(rect2, params, depth + 1)
    ];
  }
  
  private assignRoomTypes(params: HouseParams) {
    // Sort rooms by area
    const sorted = [...this.rooms].sort((a, b) => b.area - a.area);
    
    // Assign essential rooms first
    let idx = 0;
    if (sorted.length > idx) sorted[idx++].type = "living_room";
    if (sorted.length > idx) sorted[idx++].type = "kitchen";
    if (sorted.length > idx) sorted[idx++].type = "bedroom";
    
    // Assign remaining rooms
    const types: RoomType[] = ["bedroom", "bathroom", "office", "dining_room"];
    for (let i = idx; i < sorted.length; i++) {
      sorted[i].type = this.rng.choice(types);
      
      // Make sure bathrooms are small
      if (sorted[i].type === "bathroom" && sorted[i].area > 12) {
        sorted[i].type = "bedroom";
      }
    }
    
    // At least one hallway if many rooms
    if (sorted.length > 5) {
      const hallwayCandidate = sorted.find(r => r.area < 15 && r.area > 6);
      if (hallwayCandidate) hallwayCandidate.type = "hallway";
    }
  }
  
  private placeDoorways(params: HouseParams) {
    // Find all adjacent room pairs
    for (let i = 0; i < this.rooms.length; i++) {
      for (let j = i + 1; j < this.rooms.length; j++) {
        const room1 = this.rooms[i];
        const room2 = this.rooms[j];
        
        const edge = room1.bounds.getSharedEdge(room2.bounds);
        if (edge) {
          // Place door in the middle of shared edge
          const edgeLength = edge.axis === 'x' 
            ? Math.abs(edge.end.y - edge.start.y)
            : Math.abs(edge.end.x - edge.start.x);
          
          // Only place door if edge is long enough
          if (edgeLength >= params.doorWidth + 0.5) {
            const doorPos = vec2(
              (edge.start.x + edge.end.x) / 2,
              (edge.start.y + edge.end.y) / 2
            );
            
            this.doorways.push({
              position: doorPos,
              width: params.doorWidth,
              axis: edge.axis,
              room1,
              room2
            });
            
            room1.connectedRooms.push(room2);
            room2.connectedRooms.push(room1);
          }
        }
      }
    }
  }
  
  private placeWindows(params: HouseParams) {
    for (const room of this.rooms) {
      // Skip bathrooms and hallways
      if (room.type === "bathroom" || room.type === "hallway") continue;
      
      const bounds = room.bounds;
      const spacing = 2.0; // meters between windows
      
      // Check each wall
      // Left wall (x = bounds.x)
      if (this.isExteriorWall(bounds.x, 0, params)) {
        const count = Math.floor(bounds.height / spacing);
        for (let i = 0; i < count; i++) {
          this.windows.push({
            position: vec2(bounds.x, bounds.y + (i + 0.5) * bounds.height / count),
            width: params.windowWidth,
            height: params.windowHeight,
            wallNormal: vec2(-1, 0)
          });
        }
      }
      
      // Right wall
      if (this.isExteriorWall(bounds.right, 0, params)) {
        const count = Math.floor(bounds.height / spacing);
        for (let i = 0; i < count; i++) {
          this.windows.push({
            position: vec2(bounds.right, bounds.y + (i + 0.5) * bounds.height / count),
            width: params.windowWidth,
            height: params.windowHeight,
            wallNormal: vec2(1, 0)
          });
        }
      }
      
      // Top wall
      if (this.isExteriorWall(0, bounds.y, params)) {
        const count = Math.floor(bounds.width / spacing);
        for (let i = 0; i < count; i++) {
          this.windows.push({
            position: vec2(bounds.x + (i + 0.5) * bounds.width / count, bounds.y),
            width: params.windowWidth,
            height: params.windowHeight,
            wallNormal: vec2(0, -1)
          });
        }
      }
      
      // Bottom wall
      if (this.isExteriorWall(0, bounds.bottom, params)) {
        const count = Math.floor(bounds.width / spacing);
        for (let i = 0; i < count; i++) {
          this.windows.push({
            position: vec2(bounds.x + (i + 0.5) * bounds.width / count, bounds.bottom),
            width: params.windowWidth,
            height: params.windowHeight,
            wallNormal: vec2(0, 1)
          });
        }
      }
    }
  }
  
  private isExteriorWall(x: number, z: number, params: HouseParams): boolean {
    const threshold = 0.1;
    return Math.abs(x) < threshold || 
           Math.abs(x - params.width) < threshold ||
           Math.abs(z) < threshold || 
           Math.abs(z - params.depth) < threshold;
  }
  
  private placeStairs(params: HouseParams) {
    // Find a room suitable for stairs (preferably hallway or living room)
    let stairRoom = this.rooms.find(r => r.type === "hallway");
    if (!stairRoom) {
      stairRoom = this.rooms.find(r => r.type === "living_room");
    }
    if (!stairRoom) {
      stairRoom = this.rooms[0];
    }
    
    const bounds = stairRoom.bounds;
    this.stairs = {
      position: vec2(bounds.centerX, bounds.centerY),
      direction: vec2(1, 0),
      width: 1.2
    };
  }
}

// ============================================================================
// GEOMETRY GENERATION
// ============================================================================

class HouseGeometry {
  static generateWall(
    start: Vec3,
    end: Vec3,
    height: number,
    thickness: number,
    doorways: Array<{ pos: Vec3, width: number, height: number }> = []
  ): MeshBuilder {
    const mesh = new MeshBuilder();
    
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    
    if (length < 0.01) return mesh;
    
    // Normalized direction
    const dirX = dx / length;
    const dirZ = dz / length;
    
    // Perpendicular (for thickness)
    const perpX = -dirZ;
    const perpZ = dirX;
    
    // Wall corners
    const corners = [
      vec3(start.x, start.y, start.z),
      vec3(start.x + perpX * thickness, start.y, start.z + perpZ * thickness),
      vec3(end.x + perpX * thickness, start.y, end.z + perpZ * thickness),
      vec3(end.x, start.y, end.z),
      vec3(start.x, start.y + height, start.z),
      vec3(start.x + perpX * thickness, start.y + height, start.z + perpZ * thickness),
      vec3(end.x + perpX * thickness, start.y + height, end.z + perpZ * thickness),
      vec3(end.x, start.y + height, end.z)
    ];
    
    // For simplicity, generate solid wall (doorway cutting is complex)
    // In production, you'd segment the wall and skip doorway sections
    
    // Front face
    const v0 = mesh.addVertex(corners[0], vec3(-perpX, 0, -perpZ), vec2(0, 0));
    const v1 = mesh.addVertex(corners[3], vec3(-perpX, 0, -perpZ), vec2(1, 0));
    const v2 = mesh.addVertex(corners[7], vec3(-perpX, 0, -perpZ), vec2(1, 1));
    const v3 = mesh.addVertex(corners[4], vec3(-perpX, 0, -perpZ), vec2(0, 1));
    mesh.addQuad(v0, v1, v2, v3);
    
    // Back face
    const v4 = mesh.addVertex(corners[1], vec3(perpX, 0, perpZ), vec2(0, 0));
    const v5 = mesh.addVertex(corners[2], vec3(perpX, 0, perpZ), vec2(1, 0));
    const v6 = mesh.addVertex(corners[6], vec3(perpX, 0, perpZ), vec2(1, 1));
    const v7 = mesh.addVertex(corners[5], vec3(perpX, 0, perpZ), vec2(0, 1));
    mesh.addQuad(v5, v4, v7, v6);
    
    // Top face
    const v8 = mesh.addVertex(corners[4], vec3(0, 1, 0), vec2(0, 0));
    const v9 = mesh.addVertex(corners[5], vec3(0, 1, 0), vec2(1, 0));
    const v10 = mesh.addVertex(corners[6], vec3(0, 1, 0), vec2(1, 1));
    const v11 = mesh.addVertex(corners[7], vec3(0, 1, 0), vec2(0, 1));
    mesh.addQuad(v8, v9, v10, v11);
    
    // Side faces
    const v12 = mesh.addVertex(corners[0], vec3(-dirX, 0, -dirZ), vec2(0, 0));
    const v13 = mesh.addVertex(corners[1], vec3(-dirX, 0, -dirZ), vec2(1, 0));
    const v14 = mesh.addVertex(corners[5], vec3(-dirX, 0, -dirZ), vec2(1, 1));
    const v15 = mesh.addVertex(corners[4], vec3(-dirX, 0, -dirZ), vec2(0, 1));
    mesh.addQuad(v12, v13, v14, v15);
    
    const v16 = mesh.addVertex(corners[3], vec3(dirX, 0, dirZ), vec2(0, 0));
    const v17 = mesh.addVertex(corners[2], vec3(dirX, 0, dirZ), vec2(1, 0));
    const v18 = mesh.addVertex(corners[6], vec3(dirX, 0, dirZ), vec2(1, 1));
    const v19 = mesh.addVertex(corners[7], vec3(dirX, 0, dirZ), vec2(0, 1));
    mesh.addQuad(v17, v16, v19, v18);
    
    return mesh;
  }
  
  static generateFloor(bounds: Rect, y: number): MeshBuilder {
    const mesh = new MeshBuilder();
    
    const v0 = mesh.addVertex(
      vec3(bounds.x, y, bounds.y),
      vec3(0, 1, 0),
      vec2(0, 0)
    );
    const v1 = mesh.addVertex(
      vec3(bounds.right, y, bounds.y),
      vec3(0, 1, 0),
      vec2(bounds.width / 4, 0)
    );
    const v2 = mesh.addVertex(
      vec3(bounds.right, y, bounds.bottom),
      vec3(0, 1, 0),
      vec2(bounds.width / 4, bounds.height / 4)
    );
    const v3 = mesh.addVertex(
      vec3(bounds.x, y, bounds.bottom),
      vec3(0, 1, 0),
      vec2(0, bounds.height / 4)
    );
    
    mesh.addQuad(v0, v1, v2, v3);
    
    return mesh;
  }
  
  static generateCeiling(bounds: Rect, y: number): MeshBuilder {
    const mesh = new MeshBuilder();
    
    const v0 = mesh.addVertex(
      vec3(bounds.x, y, bounds.y),
      vec3(0, -1, 0),
      vec2(0, 0)
    );
    const v1 = mesh.addVertex(
      vec3(bounds.right, y, bounds.y),
      vec3(0, -1, 0),
      vec2(bounds.width / 4, 0)
    );
    const v2 = mesh.addVertex(
      vec3(bounds.right, y, bounds.bottom),
      vec3(0, -1, 0),
      vec2(bounds.width / 4, bounds.height / 4)
    );
    const v3 = mesh.addVertex(
      vec3(bounds.x, y, bounds.bottom),
      vec3(0, -1, 0),
      vec2(0, bounds.height / 4)
    );
    
    mesh.addQuad(v3, v2, v1, v0);
    
    return mesh;
  }
  
  static generateWindow(
    position: Vec2,
    wallNormal: Vec2,
    width: number,
    height: number,
    baseY: number,
    frameDepth: number
  ): MeshBuilder {
    const mesh = new MeshBuilder();
    
    // Window is placed 1m from floor
    const windowBaseY = baseY + 1.0;
    const windowTopY = windowBaseY + height;
    
    // Frame thickness
    const frameThick = 0.05;
    
    // Perpendicular to normal
    const perpX = -wallNormal.y;
    const perpZ = wallNormal.x;
    
    // Window center
    const cx = position.x + wallNormal.x * frameDepth * 0.5;
    const cz = position.y + wallNormal.y * frameDepth * 0.5;
    
    // Simple window frame (box around opening)
    // Bottom sill
    const sillY = windowBaseY - frameThick;
    const sillDepth = frameDepth + 0.1;
    
    const s0 = mesh.addVertex(
      vec3(cx - perpX * width * 0.5, sillY, cz - perpZ * width * 0.5),
      vec3(0, -1, 0),
      vec2(0, 0)
    );
    const s1 = mesh.addVertex(
      vec3(cx + perpX * width * 0.5, sillY, cz + perpZ * width * 0.5),
      vec3(0, -1, 0),
      vec2(1, 0)
    );
    const s2 = mesh.addVertex(
      vec3(cx + perpX * width * 0.5 + wallNormal.x * sillDepth, sillY, cz + perpZ * width * 0.5 + wallNormal.y * sillDepth),
      vec3(0, -1, 0),
      vec2(1, 1)
    );
    const s3 = mesh.addVertex(
      vec3(cx - perpX * width * 0.5 + wallNormal.x * sillDepth, sillY, cz - perpZ * width * 0.5 + wallNormal.y * sillDepth),
      vec3(0, -1, 0),
      vec2(0, 1)
    );
    mesh.addQuad(s0, s1, s2, s3);
    
    // Glass pane (simple quad)
    const g0 = mesh.addVertex(
      vec3(cx - perpX * width * 0.4, windowBaseY + 0.1, cz - perpZ * width * 0.4),
      vec3(-wallNormal.x, 0, -wallNormal.y),
      vec2(0, 0)
    );
    const g1 = mesh.addVertex(
      vec3(cx + perpX * width * 0.4, windowBaseY + 0.1, cz + perpZ * width * 0.4),
      vec3(-wallNormal.x, 0, -wallNormal.y),
      vec2(1, 0)
    );
    const g2 = mesh.addVertex(
      vec3(cx + perpX * width * 0.4, windowTopY - 0.1, cz + perpZ * width * 0.4),
      vec3(-wallNormal.x, 0, -wallNormal.y),
      vec2(1, 1)
    );
    const g3 = mesh.addVertex(
      vec3(cx - perpX * width * 0.4, windowTopY - 0.1, cz - perpZ * width * 0.4),
      vec3(-wallNormal.x, 0, -wallNormal.y),
      vec2(0, 1)
    );
    mesh.addQuad(g0, g1, g2, g3);
    
    return mesh;
  }
  
  static generateDoorFrame(
    position: Vec2,
    axis: 'x' | 'y',
    width: number,
    height: number,
    baseY: number,
    wallThickness: number
  ): MeshBuilder {
    const mesh = new MeshBuilder();
    
    // Frame dimensions
    const frameThick = 0.08;
    const frameDepth = wallThickness;
    
    // Door opening
    const halfWidth = width * 0.5;
    
    let p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3;
    
    if (axis === 'x') {
      // Door opens along X axis
      p0 = vec3(position.x - halfWidth, baseY, position.y - frameDepth * 0.5);
      p1 = vec3(position.x + halfWidth, baseY, position.y - frameDepth * 0.5);
      p2 = vec3(position.x + halfWidth, baseY + height, position.y - frameDepth * 0.5);
      p3 = vec3(position.x - halfWidth, baseY + height, position.y - frameDepth * 0.5);
    } else {
      // Door opens along Z axis
      p0 = vec3(position.x - frameDepth * 0.5, baseY, position.y - halfWidth);
      p1 = vec3(position.x - frameDepth * 0.5, baseY, position.y + halfWidth);
      p2 = vec3(position.x - frameDepth * 0.5, baseY + height, position.y + halfWidth);
      p3 = vec3(position.x - frameDepth * 0.5, baseY + height, position.y - halfWidth);
    }
    
    // Simple frame outline (left, right, top)
    const normal = axis === 'x' ? vec3(0, 0, -1) : vec3(-1, 0, 0);
    
    // Left frame
    const lf0 = mesh.addVertex(
      vec3(p0.x - frameThick, p0.y, p0.z),
      normal,
      vec2(0, 0)
    );
    const lf1 = mesh.addVertex(p0, normal, vec2(0.1, 0));
    const lf2 = mesh.addVertex(p3, normal, vec2(0.1, 1));
    const lf3 = mesh.addVertex(
      vec3(p3.x - frameThick, p3.y, p3.z),
      normal,
      vec2(0, 1)
    );
    mesh.addQuad(lf0, lf1, lf2, lf3);
    
    // Right frame
    const rf0 = mesh.addVertex(p1, normal, vec2(0.9, 0));
    const rf1 = mesh.addVertex(
      vec3(p1.x + frameThick, p1.y, p1.z),
      normal,
      vec2(1, 0)
    );
    const rf2 = mesh.addVertex(
      vec3(p2.x + frameThick, p2.y, p2.z),
      normal,
      vec2(1, 1)
    );
    const rf3 = mesh.addVertex(p2, normal, vec2(0.9, 1));
    mesh.addQuad(rf0, rf1, rf2, rf3);
    
    // Top frame
    const tf0 = mesh.addVertex(p3, normal, vec2(0, 0.9));
    const tf1 = mesh.addVertex(p2, normal, vec2(1, 0.9));
    const tf2 = mesh.addVertex(
      vec3(p2.x, p2.y + frameThick, p2.z),
      normal,
      vec2(1, 1)
    );
    const tf3 = mesh.addVertex(
      vec3(p3.x, p3.y + frameThick, p3.z),
      normal,
      vec2(0, 1)
    );
    mesh.addQuad(tf0, tf1, tf2, tf3);
    
    return mesh;
  }
  
  static generateRoof(
    bounds: Rect,
    baseY: number,
    height: number,
    style: "gable" | "hip" | "flat"
  ): MeshBuilder {
    const mesh = new MeshBuilder();
    
    if (style === "flat") {
      // Simple flat roof
      const roofY = baseY + height;
      const overhang = 0.5;
      const expandedBounds = new Rect(
        bounds.x - overhang,
        bounds.y - overhang,
        bounds.width + overhang * 2,
        bounds.height + overhang * 2
      );
      
      const v0 = mesh.addVertex(
        vec3(expandedBounds.x, roofY, expandedBounds.y),
        vec3(0, 1, 0),
        vec2(0, 0)
      );
      const v1 = mesh.addVertex(
        vec3(expandedBounds.right, roofY, expandedBounds.y),
        vec3(0, 1, 0),
        vec2(1, 0)
      );
      const v2 = mesh.addVertex(
        vec3(expandedBounds.right, roofY, expandedBounds.bottom),
        vec3(0, 1, 0),
        vec2(1, 1)
      );
      const v3 = mesh.addVertex(
        vec3(expandedBounds.x, roofY, expandedBounds.bottom),
        vec3(0, 1, 0),
        vec2(0, 1)
      );
      
      mesh.addQuad(v0, v1, v2, v3);
      
    } else if (style === "gable") {
      // Gable roof (triangular ends)
      const peakY = baseY + height;
      const overhang = 0.5;
      
      const midX = bounds.centerX;
      
      // Front slope
      const f0 = mesh.addVertex(
        vec3(bounds.x - overhang, baseY, bounds.y - overhang),
        vec3(0, 0.7, -0.7),
        vec2(0, 0)
      );
      const f1 = mesh.addVertex(
        vec3(bounds.right + overhang, baseY, bounds.y - overhang),
        vec3(0, 0.7, -0.7),
        vec2(1, 0)
      );
      const f2 = mesh.addVertex(
        vec3(bounds.right + overhang, peakY, bounds.centerY),
        vec3(0, 0.7, -0.7),
        vec2(1, 1)
      );
      const f3 = mesh.addVertex(
        vec3(bounds.x - overhang, peakY, bounds.centerY),
        vec3(0, 0.7, -0.7),
        vec2(0, 1)
      );
      mesh.addQuad(f0, f1, f2, f3);
      
      // Back slope
      const b0 = mesh.addVertex(
        vec3(bounds.x - overhang, baseY, bounds.bottom + overhang),
        vec3(0, 0.7, 0.7),
        vec2(0, 0)
      );
      const b1 = mesh.addVertex(
        vec3(bounds.right + overhang, baseY, bounds.bottom + overhang),
        vec3(0, 0.7, 0.7),
        vec2(1, 0)
      );
      const b2 = mesh.addVertex(
        vec3(bounds.right + overhang, peakY, bounds.centerY),
        vec3(0, 0.7, 0.7),
        vec2(1, 1)
      );
      const b3 = mesh.addVertex(
        vec3(bounds.x - overhang, peakY, bounds.centerY),
        vec3(0, 0.7, 0.7),
        vec2(0, 1)
      );
      mesh.addQuad(b1, b0, b3, b2);
      
      // End caps (triangles)
      const e0 = mesh.addVertex(
        vec3(bounds.x - overhang, baseY, bounds.y - overhang),
        vec3(-1, 0, 0),
        vec2(0, 0)
      );
      const e1 = mesh.addVertex(
        vec3(bounds.x - overhang, baseY, bounds.bottom + overhang),
        vec3(-1, 0, 0),
        vec2(1, 0)
      );
      const e2 = mesh.addVertex(
        vec3(bounds.x - overhang, peakY, bounds.centerY),
        vec3(-1, 0, 0),
        vec2(0.5, 1)
      );
      mesh.addTriangle(e0, e1, e2);
      
      const e3 = mesh.addVertex(
        vec3(bounds.right + overhang, baseY, bounds.y - overhang),
        vec3(1, 0, 0),
        vec2(0, 0)
      );
      const e4 = mesh.addVertex(
        vec3(bounds.right + overhang, baseY, bounds.bottom + overhang),
        vec3(1, 0, 0),
        vec2(1, 0)
      );
      const e5 = mesh.addVertex(
        vec3(bounds.right + overhang, peakY, bounds.centerY),
        vec3(1, 0, 0),
        vec2(0.5, 1)
      );
      mesh.addTriangle(e4, e3, e5);
    }
    
    return mesh;
  }
  
  static generateStaircase(
    position: Vec2,
    direction: Vec2,
    width: number,
    floorHeight: number,
    stepCount: number = 12
  ): MeshBuilder {
    const mesh = new MeshBuilder();
    
    const stepHeight = floorHeight / stepCount;
    const stepDepth = 0.25;
    
    for (let i = 0; i < stepCount; i++) {
      const y = i * stepHeight;
      const z = position.y + i * stepDepth * direction.y;
      const x = position.x + i * stepDepth * direction.x;
      
      // Step tread (top surface)
      const t0 = mesh.addVertex(
        vec3(x - width * 0.5, y + stepHeight, z),
        vec3(0, 1, 0),
        vec2(0, 0)
      );
      const t1 = mesh.addVertex(
        vec3(x + width * 0.5, y + stepHeight, z),
        vec3(0, 1, 0),
        vec2(1, 0)
      );
      const t2 = mesh.addVertex(
        vec3(x + width * 0.5, y + stepHeight, z + stepDepth),
        vec3(0, 1, 0),
        vec2(1, 1)
      );
      const t3 = mesh.addVertex(
        vec3(x - width * 0.5, y + stepHeight, z + stepDepth),
        vec3(0, 1, 0),
        vec2(0, 1)
      );
      mesh.addQuad(t0, t1, t2, t3);
      
      // Step riser (front face)
      const r0 = mesh.addVertex(
        vec3(x - width * 0.5, y, z + stepDepth),
        vec3(0, 0, 1),
        vec2(0, 0)
      );
      const r1 = mesh.addVertex(
        vec3(x + width * 0.5, y, z + stepDepth),
        vec3(0, 0, 1),
        vec2(1, 0)
      );
      const r2 = mesh.addVertex(
        vec3(x + width * 0.5, y + stepHeight, z + stepDepth),
        vec3(0, 0, 1),
        vec2(1, 1)
      );
      const r3 = mesh.addVertex(
        vec3(x - width * 0.5, y + stepHeight, z + stepDepth),
        vec3(0, 0, 1),
        vec2(0, 1)
      );
      mesh.addQuad(r0, r1, r2, r3);
    }
    
    return mesh;
  }
}

// ============================================================================
// HOUSE GENERATOR ADDON
// ============================================================================

export class ProceduralHouseGenerator extends ComponentAddon<HouseParams> {
  protected defaultParams: HouseParams = {
    width: 12,
    depth: 10,
    stories: 1,
    style: "traditional",
    minRoomSize: 2.5,
    maxSubdivisions: 4,
    wallThickness: 0.15,
    floorHeight: 2.7,
    windowHeight: 1.2,
    windowWidth: 0.8,
    doorWidth: 0.9,
    doorHeight: 2.1,
    addBasement: false,
    addAttic: false,
    addPorch: false,
    seed: 12345
  };
  
  private meshId: string | null = null;
  
  constructor() {
    super({
      name: "ProceduralHouseGenerator",
      version: "1.0.0",
      description: "Generates full-scale houses with proper rooms, doorways, and windows",
      author: ["Claude"],
      capabilities: { graphics: true, ui: true }
    });
  }
  
  protected setup(): void {
    this.initComponentState("Default House");
    this.createUI();

     this.api.onProjectChanged((newProjectId) => {
        if (this.loadFromProject()) {
            this.generateHouse();
        }
    });
  }
  
  private generateHouse() {
    const params = this.currentParams;
    
    // Clear existing mesh
    if (this.meshId) {
      this.api.Model.clearMesh(this.meshId);
    }
    
    // Generate floor plan
    const floorPlan = new FloorPlan(params.seed);
    floorPlan.generate(params);
    
    // Build geometry
    const houseMesh = new MeshBuilder();
    
    // Generate each story
    for (let story = 0; story < params.stories; story++) {
      const baseY = story * params.floorHeight;
      
      // Floor
      for (const room of floorPlan.rooms) {
        const floor = HouseGeometry.generateFloor(room.bounds, baseY);
        houseMesh.merge(floor);
        
        // Ceiling (except top story)
        if (story < params.stories - 1) {
          const ceiling = HouseGeometry.generateCeiling(
            room.bounds,
            baseY + params.floorHeight
          );
          houseMesh.merge(ceiling);
        }
      }
      
      // Walls for each room
      for (const room of floorPlan.rooms) {
        const bounds = room.bounds;
        
        // Four walls
        const walls = [
          { start: vec2(bounds.x, bounds.y), end: vec2(bounds.right, bounds.y) }, // Top
          { start: vec2(bounds.right, bounds.y), end: vec2(bounds.right, bounds.bottom) }, // Right
          { start: vec2(bounds.right, bounds.bottom), end: vec2(bounds.x, bounds.bottom) }, // Bottom
          { start: vec2(bounds.x, bounds.bottom), end: vec2(bounds.x, bounds.y) }  // Left
        ];
        
        for (const wall of walls) {
          const wallMesh = HouseGeometry.generateWall(
            vec3(wall.start.x, baseY, wall.start.y),
            vec3(wall.end.x, baseY, wall.end.y),
            params.floorHeight,
            params.wallThickness
          );
          houseMesh.merge(wallMesh);
        }
      }
      
      // Door frames
      for (const doorway of floorPlan.doorways) {
        const doorMesh = HouseGeometry.generateDoorFrame(
          doorway.position,
          doorway.axis,
          doorway.width,
          params.doorHeight,
          baseY,
          params.wallThickness
        );
        houseMesh.merge(doorMesh);
      }
      
      // Windows
      for (const window of floorPlan.windows) {
        const windowMesh = HouseGeometry.generateWindow(
          window.position,
          window.wallNormal,
          window.width,
          window.height,
          baseY,
          params.wallThickness
        );
        houseMesh.merge(windowMesh);
      }
      
      // Stairs (if multi-story and not top floor)
      if (params.stories > 1 && story < params.stories - 1 && floorPlan.stairs) {
        const stairMesh = HouseGeometry.generateStaircase(
          floorPlan.stairs.position,
          floorPlan.stairs.direction,
          floorPlan.stairs.width,
          params.floorHeight
        );
        houseMesh.merge(stairMesh);
      }
    }
    
    // Roof
    const topY = params.stories * params.floorHeight;
    const houseBounds = new Rect(0, 0, params.width, params.depth);
    const roofStyle = params.style === "modern" ? "flat" : "gable";
    const roofHeight = roofStyle === "flat" ? 0.3 : 2.0;
    
    const roofMesh = HouseGeometry.generateRoof(
      houseBounds,
      topY,
      roofHeight,
      roofStyle
    );
    houseMesh.merge(roofMesh);
    
    // Create mesh in engine
    this.meshId = Entropy.generateUUID();
    this.api.Model.createMesh({
      id: this.meshId,
      position: [-params.width / 2, 0, -params.depth / 2],
      vertexData: houseMesh.vertices,
      indexData: houseMesh.indices,
      pipelineId: "default"
    });
    
    Entropy.println(`Generated house: ${floorPlan.rooms.length} rooms, ${floorPlan.doorways.length} doorways, ${floorPlan.windows.length} windows`);
  }
  
  private createUI() {
    const windowId = this.UI.createTab({
      title: "🏠 House Generator",
      onRender: () => this.renderUI(windowId)
    });
  }
  
  private renderUI(windowId: string) {
    if (Entropy.Composer) {
        const lightUI = Entropy.Composer.getEditor("Light Hive");
        if (lightUI) {
            lightUI(windowId, this.name); // Renders the light hive controls here!
        }
    }

    this.renderComponentUI(windowId, () => this.generateHouse());
    
    const params = this.currentParams;
    
    Entropy.UI.Widget.label(windowId, { text: "🏗️ Structure", bold: true });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Width: ${params.width.toFixed(1)}m`,
      value: params.width,
      min: 6,
      max: 20,
      onChange: (val) => {
        params.width = parseFloat(val);
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Depth: ${params.depth.toFixed(1)}m`,
      value: params.depth,
      min: 6,
      max: 20,
      onChange: (val) => {
        params.depth = parseFloat(val);
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Stories: ${params.stories}`,
      value: params.stories,
      min: 1,
      max: 3,
      onChange: (val) => {
        params.stories = Math.round(parseFloat(val));
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.separator(windowId);
    Entropy.UI.Widget.label(windowId, { text: "🎨 Style", bold: true });
    
    Entropy.UI.Widget.dropdown(windowId, {
      label: "Style",
      options: ["traditional", "modern", "craftsman"],
      selectedIndex: ["traditional", "modern", "craftsman"].indexOf(params.style),
      onChange: (idx) => {
        params.style = ["traditional", "modern", "craftsman"][parseInt(idx)] as any;
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.separator(windowId);
    Entropy.UI.Widget.label(windowId, { text: "🚪 Layout", bold: true });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Min Room: ${params.minRoomSize.toFixed(1)}m`,
      value: params.minRoomSize,
      min: 2,
      max: 5,
      onChange: (val) => {
        params.minRoomSize = parseFloat(val);
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Subdivisions: ${params.maxSubdivisions}`,
      value: params.maxSubdivisions,
      min: 2,
      max: 6,
      onChange: (val) => {
        params.maxSubdivisions = Math.round(parseFloat(val));
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Seed: ${params.seed}`,
      value: params.seed,
      min: 1,
      max: 99999,
      onChange: (val) => {
        params.seed = Math.round(parseFloat(val));
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.separator(windowId);
    Entropy.UI.Widget.label(windowId, { text: "🔧 Details", bold: true });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Floor Height: ${params.floorHeight.toFixed(2)}m`,
      value: params.floorHeight,
      min: 2.4,
      max: 3.5,
      onChange: (val) => {
        params.floorHeight = parseFloat(val);
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.slider(windowId, {
      label: `Wall Thickness: ${(params.wallThickness * 100).toFixed(0)}cm`,
      value: params.wallThickness,
      min: 0.1,
      max: 0.3,
      onChange: (val) => {
        params.wallThickness = parseFloat(val);
        this.generateHouse();
      }
    });
    
    Entropy.UI.Widget.button(windowId, {
      text: "🎲 Randomize",
      onClick: () => {
        params.seed = Math.floor(Math.random() * 99999);
        params.width = 8 + Math.random() * 10;
        params.depth = 8 + Math.random() * 10;
        params.maxSubdivisions = 3 + Math.floor(Math.random() * 3);
        this.generateHouse();
      }
    });
  }
}

// Register the addon
new ProceduralHouseGenerator().register();