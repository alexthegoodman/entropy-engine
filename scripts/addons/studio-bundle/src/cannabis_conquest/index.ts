// Cannabis Conquest
// Turn-based strategy. Bud is civilization. Serious mechanics, hilarious premise.
// Grid: 256×256 tiles on a 1024×1024 world landscape.

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TILE_SIZE    = 4;          // world units per tile (4 * 256 = 1024 ✓)
const GRID_W       = 256;
const GRID_H       = 256;
const LANDSCAPE_W  = 1024;       // world-space width/height
const LANDSCAPE_H  = 1024;
const LANDSCAPE_SCALE = 15;      // vertical exaggeration

// UI layout constants (screen-space pixels)
const HUD_PANEL_X  = 10;
const HUD_PANEL_Y  = 10;
const HUD_W        = 300;
const HUD_H        = 580;
const HUD_PAD      = 10;
const LINE_H       = 18;
const BTN_H        = 24;
const BTN_W        = 130;

// Colors [r, g, b, a] 0-255
const C = {
  BG:          [10,  20,  12,  210] as [number,number,number,number],
  PANEL:       [15,  35,  18,  230] as [number,number,number,number],
  HEADER:      [30,  80,  35,  255] as [number,number,number,number],
  ACCENT:      [80,  200, 90,  255] as [number,number,number,number],
  ACCENT2:     [180, 220, 80,  255] as [number,number,number,number],
  TEXT:        [210, 240, 210, 255] as [number,number,number,number],
  TEXT_DIM:    [120, 160, 120, 255] as [number,number,number,number],
  TEXT_BRIGHT: [255, 255, 200, 255] as [number,number,number,number],
  BTN:         [25,  70,  30,  230] as [number,number,number,number],
  BTN_HOV:     [40,  110, 45,  255] as [number,number,number,number],
  BTN_DIS:     [20,  40,  22,  180] as [number,number,number,number],
  SEL:         [100, 200, 80,  120] as [number,number,number,number],
  WARN:        [200, 160, 20,  255] as [number,number,number,number],
  DANGER:      [200, 60,  40,  255] as [number,number,number,number],
  NATION:      [200, 160, 255, 255] as [number,number,number,number],
};

// ─────────────────────────────────────────────────────────────────────────────
// DATA TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface TerrainDef {
  id:       number;
  name:     string;
  yieldMod: number;
  moveCost: number;
  color:    [number, number, number, number];
}

interface UnitDef {
  name:        string;
  movePoints:  number;
  visionRange: number;
  budCost:     number;
  budYield:    number;
  color:       [number, number, number, number];
  desc:        string;
  techReq?:    string;
}

interface BuildingDef {
  id:           number;
  name:         string;
  budToUpgrade: number;
  yieldBonus:   number;
}

interface TechNode {
  id:      string;
  name:    string;
  tier:    number;
  cost:    number;
  prereqs: string[];
  effect:  string;
  icon:    string;
}

interface Tile {
  x:       number;
  z:       number;
  terrain: TerrainDef;
  height:  number;
  building: string | null;
  resource: number;   // 0-3 bonus bud/turn
}

interface GameUnit {
  id:             string;
  faction:        number;
  type:           string;
  x:              number;
  z:              number;
  movePointsLeft: number;
  alive:          boolean;
  hasActed:       boolean;
  def:            UnitDef;
  meshId:         string | null;
}

interface Building {
  id:           string;
  faction:      number;
  type:         number;    // 0=Farm, 1=City, 2=NationCapital
  x:            number;
  z:            number;
  yieldPerTurn: number;
  meshId:       string | null;
}

interface Nation {
  id:       string;
  faction:  number;
  capitalX: number;
  capitalZ: number;
}

interface Faction {
  id:          number;
  name:        string;
  color:       [number, number, number];
  bud:         number;
  isPlayer:    boolean;
  nationCount: number;
}

interface TradeRoute {
  fromFaction: number;
  toFaction:   number;
  budPerTurn:  number;
}

type TabId = "overview" | "units" | "cities" | "tech" | "diplomacy";

interface Button {
  label:    string;
  x:        number;
  y:        number;
  w:        number;
  h:        number;
  enabled:  boolean;
  onClick:  () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATIC DATA
// ─────────────────────────────────────────────────────────────────────────────

const TERRAIN: Record<string, TerrainDef> = {
  HIGHLAND:   { id: 0, name: "Highland",        yieldMod: 0.8, moveCost: 2, color: [0.55, 0.50, 0.35, 1] },
  RIVER:      { id: 1, name: "River Delta",     yieldMod: 1.5, moveCost: 1, color: [0.25, 0.55, 0.80, 1] },
  ARID:       { id: 2, name: "Arid Flats",      yieldMod: 0.5, moveCost: 1, color: [0.80, 0.70, 0.40, 1] },
  GREENHOUSE: { id: 3, name: "Greenhouse Zone", yieldMod: 2.0, moveCost: 2, color: [0.30, 0.75, 0.30, 1] },
  PLAINS:     { id: 4, name: "Plains",          yieldMod: 1.0, moveCost: 1, color: [0.50, 0.70, 0.35, 1] },
};

const UNIT_DEFS: Record<string, UnitDef> = {
  FARMER:     { name: "Farmer",     movePoints: 2, visionRange: 2, budCost: 20,  budYield: 5, color: [0.9, 0.8, 0.2, 1], desc: "Founds farms, steady yield" },
  HOMEGROWER: { name: "Homegrower", movePoints: 4, visionRange: 3, budCost: 15,  budYield: 2, color: [0.4, 0.9, 0.4, 1], desc: "Scout, fast movement" },
  BOTANIST:   { name: "Botanist",   movePoints: 2, visionRange: 2, budCost: 30,  budYield: 0, color: [0.2, 0.8, 0.6, 1], desc: "Boosts adjacent farm yield +2" },
  GENETICIST: { name: "Geneticist", movePoints: 2, visionRange: 2, budCost: 40,  budYield: 0, color: [0.7, 0.3, 0.9, 1], desc: "Doubles research speed" },
  HARVESTER:  { name: "Harvester",  movePoints: 3, visionRange: 2, budCost: 25,  budYield: 8, color: [0.9, 0.5, 0.1, 1], desc: "AoE bud collection", techReq: "sun_drying" },
};

const BUILDING_DEFS: BuildingDef[] = [
  { id: 0, name: "Farm",            budToUpgrade: 60,  yieldBonus: 3  },
  { id: 1, name: "City",            budToUpgrade: 150, yieldBonus: 8  },
  { id: 2, name: "Nation Capital",  budToUpgrade: 0,   yieldBonus: 20 },
];

const TECH_TREE: TechNode[] = [
  // Tier 1
  { id: "basic_cultivation",  name: "Basic Cultivation",     tier: 1, cost: 30,  prereqs: [],                                           effect: "+1 bud/turn per farm",         icon: "◈" },
  { id: "sun_drying",         name: "Solar Drying Mastery",  tier: 1, cost: 30,  prereqs: [],                                           effect: "Unlock Harvester unit",         icon: "✦" },
  { id: "seed_library",       name: "The Seed Library",      tier: 1, cost: 40,  prereqs: [],                                           effect: "+1 vision all units",           icon: "◉" },
  // Tier 2
  { id: "hydroponics",        name: "Hydroponic Revolution", tier: 2, cost: 80,  prereqs: ["basic_cultivation"],                        effect: "Greenhouse tiles +50% yield",   icon: "◆" },
  { id: "terpene_diplomacy",  name: "Terpene Diplomacy",     tier: 2, cost: 70,  prereqs: ["seed_library"],                             effect: "Trade routes +2 bud/turn",      icon: "◎" },
  { id: "strain_engineering", name: "Strain Engineering",    tier: 2, cost: 90,  prereqs: ["basic_cultivation"],                        effect: "Geneticist doubles tech speed", icon: "◈" },
  // Tier 3
  { id: "great_strain_lib",   name: "Great Strain Library",  tier: 3, cost: 150, prereqs: ["strain_engineering", "seed_library"],       effect: "+5 bud/turn global",            icon: "★" },
  { id: "quantum_grow",       name: "Quantum Grow Lights",   tier: 3, cost: 140, prereqs: ["hydroponics"],                              effect: "All tiles +25% yield",          icon: "✦" },
  { id: "mycelium_network",   name: "Mycelium Network",      tier: 3, cost: 130, prereqs: ["terpene_diplomacy"],                        effect: "Trade x1.5, instant routes",    icon: "◎" },
  // Tier 4
  { id: "transcendence",      name: "Cosmic Transcendence",  tier: 4, cost: 300, prereqs: ["great_strain_lib","quantum_grow","mycelium_network"], effect: "WIN: 2 Nations + this tech", icon: "★" },
];

const FACTION_NAMES  = ["The Emerald Republic", "Highland Growers Guild", "Delta Cultivars", "The Arid Strain Co."];
const FACTION_COLORS: [number,number,number][] = [
  [0.2, 0.9, 0.4],
  [0.9, 0.8, 0.2],
  [0.3, 0.6, 1.0],
  [1.0, 0.4, 0.2],
];

// ─────────────────────────────────────────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────────────────────────────────────────

const G = {
isGameActive: false as boolean,
  tiles:          [] as Tile[],
  units:          [] as GameUnit[],
  buildings:      [] as Building[],
  nations:        [] as Nation[],
  factions:       [] as Faction[],
  tradeRoutes:    [] as TradeRoute[],

  currentFaction: 0,
  turnNumber:     1,
  gameOver:       false,
  winner:         -1,

  // Fog of war [factionIdx][tileIdx]
  fogExplored:    [] as boolean[][],
  fogVisible:     [] as boolean[][],

  // Tech [factionIdx]
  unlockedTech:   [new Set<string>(), new Set<string>(), new Set<string>(), new Set<string>()],
  techInProgress: [null, null, null, null] as (string | null)[],
  techProgress:   [0, 0, 0, 0] as number[],

  // UI state
  selectedUnitId:  null as string | null,
  selectedTile:    null as { x: number; z: number } | null,
  activeTab:       "overview" as TabId,
  scrollOffset:    0,
  buttons:         [] as Button[],   // rebuilt each frame
  mouseX:          0,
  mouseY:          0,

  // IDs
  nextUnitId:      0,
  nextBuildingId:  0,
  nextNationId:    0,

  // Minimap state
  minimapW:        180,
  minimapH:        180,
  minimapX:        0,   // set in init after window size known
  minimapY:        0,

  // Camera position (world units) — player-controlled
  camX:            512,
  camZ:            512,
};

// ─────────────────────────────────────────────────────────────────────────────
// ADDON REGISTRATION
// ─────────────────────────────────────────────────────────────────────────────

const addonInfo = {
  name: "Cannabis Conquest",
  version: "0.2.0",
  description: "Turn-based strategy where bud is civilization.",
  author: ["Entropy Team"],
  capabilities: { graphics: true, ui: true },
};

const addon = Entropy.Addon.register(addonInfo);

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function tileIndex(x: number, z: number): number { return x + z * GRID_W; }
function tileAt(x: number, z: number): Tile       { return G?.tiles[tileIndex(x, z)]; }
function inBounds(x: number, z: number): boolean  { return x >= 0 && x < GRID_W && z >= 0 && z < GRID_H; }

function tileWorldPos(tx: number, tz: number): [number, number, number] {
  const wx = tx * TILE_SIZE + TILE_SIZE / 2;
  const wz = tz * TILE_SIZE + TILE_SIZE / 2;
  const y  = addon.Landscape.getHeightAt(wx, wz);
  return [wx, y, wz];
}

function tilesInRange(cx: number, cz: number, range: number): { x: number; z: number }[] {
  const result: { x: number; z: number }[] = [];
  for (let dz = -range; dz <= range; dz++)
    for (let dx = -range; dx <= range; dx++)
      if (Math.abs(dx) + Math.abs(dz) <= range && inBounds(cx+dx, cz+dz))
        result.push({ x: cx+dx, z: cz+dz });
  return result;
}

function adjacentTiles(cx: number, cz: number): { x: number; z: number }[] {
  return ([ [-1,0],[1,0],[0,-1],[0,1] ] as [number,number][])
    .map(([dx,dz]) => ({ x: cx+dx, z: cz+dz }))
    .filter(t => inBounds(t.x, t.z));
}

function getUnitAt(x: number, z: number): GameUnit | undefined {
  return G?.units.find(u => u.x === x && u.z === z && u.alive);
}
function getBuildingAt(x: number, z: number): Building | undefined {
  return G?.buildings.find(b => b.x === x && b.z === z);
}

function unitsOfFaction(fIdx: number): GameUnit[]  { return G?.units.filter(u => u.faction === fIdx && u.alive); }
function buildingsOfFaction(fIdx: number): Building[] { return G?.buildings.filter(b => b.faction === fIdx); }
function citiesOfFaction(fIdx: number): Building[]  { return G?.buildings.filter(b => b.faction === fIdx && b.type >= 1); }

function techUnlocked(fIdx: number, id: string): boolean { return G?.unlockedTech[fIdx].has(id); }
function earnBud(fIdx: number, amt: number): void  { G.factions[fIdx].bud += amt; }
function spendBud(fIdx: number, amt: number): void { G.factions[fIdx].bud = Math.max(0, G?.factions[fIdx]?.bud - amt); }

function log(msg: string): void { Entropy.println(`[CC] ${msg}`); }

// ─────────────────────────────────────────────────────────────────────────────
// MAP GENERATION
// ─────────────────────────────────────────────────────────────────────────────

function generateMap(): void {
  for (let z = 0; z < GRID_H; z++) {
    for (let x = 0; x < GRID_W; x++) {
      const wx = x * TILE_SIZE + TILE_SIZE / 2;
      const wz = z * TILE_SIZE + TILE_SIZE / 2;
      const height = addon.Landscape.getHeightAt(wx, wz);

      let terrain: TerrainDef;
      if (height > 50)      terrain = TERRAIN.HIGHLAND;
      else if (height < 6)  terrain = TERRAIN.RIVER;
      else {
        // Hash-based biome assignment for deterministic, varied results
        const h = (((x * 73856093) ^ (z * 19349663)) >>> 0) % 100;
        if      (h < 12) terrain = TERRAIN.GREENHOUSE;
        else if (h < 28) terrain = TERRAIN.ARID;
        else             terrain = TERRAIN.PLAINS;
      }

      G.tiles[tileIndex(x, z)] = {
        x, z, terrain, height,
        building: null,
        resource: Math.random() < 0.25 ? Math.floor(Math.random() * 3) + 1 : 0,
      };
    }
  }
  log(`Map generated: ${GRID_W}x${GRID_H} tiles (${LANDSCAPE_W}x${LANDSCAPE_H} world units)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

let _pipelineId: string | null = null;

function getPipeline(): string {
    return "default";

//   if (_pipelineId) return _pipelineId;
//   _pipelineId = Entropy.Pipeline.create({
//     name: "cc_mesh",
//     vertexShader: `
//       struct VIn {
//         @location(0) pos:    vec3<f32>,
//         @location(1) normal: vec3<f32>,
//         @location(2) uv:     vec2<f32>,
//         @location(3) col:    vec4<f32>,
//       }
//       struct VOut { @builtin(position) clip: vec4<f32>, @location(0) col: vec4<f32> }
//       @group(0) @binding(0) var<uniform> mvp: mat4x4<f32>;
//       @vertex fn vs_main(v: VIn) -> VOut {
//         var o: VOut;
//         o.clip = mvp * vec4<f32>(v.pos, 1.0);
//         o.col  = v.col;
//         return o;
//       }`,
//     fragmentShader: `
//       @fragment fn fs_main(@location(0) col: vec4<f32>) -> @location(0) vec4<f32> {
//         return col;
//       }`,
//     layout: "mesh",
//   });
//   return _pipelineId!;
}

function makeBoxGeom(
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  r: number, g: number, b: number, a: number
): { vertexData: number[]; indexData: number[] } {
  const hw = w / 2, hd = d / 2;
  const x0 = cx - hw, x1 = cx + hw;
  const y0 = cy,      y1 = cy + h;
  const z0 = cz - hd, z1 = cz + hd;

  // Helper: pos(3) + normal(3) + uv(2) + color(4) = 12 floats per vertex
  const vert = (
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    u: number,  v: number
  ) => [px, py, pz, nx, ny, nz, u, v, r, g, b, a];

  const verts = [
    // Bottom face (normal: 0,-1,0)
    ...vert(x0, y0, z0,  0,-1,0,  0,0),  // 0
    ...vert(x1, y0, z0,  0,-1,0,  1,0),  // 1
    ...vert(x1, y0, z1,  0,-1,0,  1,1),  // 2
    ...vert(x0, y0, z1,  0,-1,0,  0,1),  // 3
    // Top face (normal: 0,1,0)
    ...vert(x0, y1, z0,  0,1,0,   0,0),  // 4
    ...vert(x1, y1, z0,  0,1,0,   1,0),  // 5
    ...vert(x1, y1, z1,  0,1,0,   1,1),  // 6
    ...vert(x0, y1, z1,  0,1,0,   0,1),  // 7
    // Front face (normal: 0,0,-1)
    ...vert(x0, y0, z0,  0,0,-1,  0,0),  // 8
    ...vert(x1, y0, z0,  0,0,-1,  1,0),  // 9
    ...vert(x1, y1, z0,  0,0,-1,  1,1),  // 10
    ...vert(x0, y1, z0,  0,0,-1,  0,1),  // 11
    // Back face (normal: 0,0,1)
    ...vert(x1, y0, z1,  0,0,1,   0,0),  // 12
    ...vert(x0, y0, z1,  0,0,1,   1,0),  // 13
    ...vert(x0, y1, z1,  0,0,1,   1,1),  // 14
    ...vert(x1, y1, z1,  0,0,1,   0,1),  // 15
    // Right face (normal: 1,0,0)
    ...vert(x1, y0, z0,  1,0,0,   0,0),  // 16
    ...vert(x1, y0, z1,  1,0,0,   1,0),  // 17
    ...vert(x1, y1, z1,  1,0,0,   1,1),  // 18
    ...vert(x1, y1, z0,  1,0,0,   0,1),  // 19
    // Left face (normal: -1,0,0)
    ...vert(x0, y0, z1, -1,0,0,   0,0),  // 20
    ...vert(x0, y0, z0, -1,0,0,   1,0),  // 21
    ...vert(x0, y1, z0, -1,0,0,   1,1),  // 22
    ...vert(x0, y1, z1, -1,0,0,   0,1),  // 23
  ];

  const i = [
     0, 1, 2,   0, 2, 3,   // bottom
     4, 5, 6,   4, 6, 7,   // top
     8, 9,10,   8,10,11,   // front
    12,13,14,  12,14,15,   // back
    16,17,18,  16,18,19,   // right
    20,21,22,  20,22,23,   // left
  ];

  return { vertexData: verts, indexData: i };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT MESH
// ─────────────────────────────────────────────────────────────────────────────

function createUnitMesh(unit: GameUnit): void {
  const [wx, wy, wz] = tileWorldPos(unit.x, unit.z);
  const [r, g, b] = unit.def.color as [number, number, number, number];
  const geom = makeBoxGeom(wx, wy, wz, TILE_SIZE*0.4, TILE_SIZE*0.6, TILE_SIZE*0.4, r, g, b, 1.0);
  const meshId = Entropy.generateUUID();
  addon.Model.createMesh({ id: meshId, position: [0,0,0], ...geom, pipelineId: getPipeline() });
  unit.meshId = meshId;

  // Point light follows unit — reveals fog of war visually
  const fc = G?.factions[unit.faction].color;
  const vRange = unit.def.visionRange + (techUnlocked(unit.faction, "seed_library") ? 1 : 0);
  Entropy.Lighting.createPointLight({
    position:    [wx, wy + 8, wz],
    color:       fc,
    intensity:   60 + vRange * 15,
    maxDistance: vRange * TILE_SIZE * 2.2,
  });
}

function removeUnitMesh(unit: GameUnit): void {
  if (unit.meshId) { addon.Model.clearMesh(unit.meshId); unit.meshId = null; }
}

function refreshUnitMesh(unit: GameUnit): void {
  removeUnitMesh(unit);
  createUnitMesh(unit);
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILDING MESH
// ─────────────────────────────────────────────────────────────────────────────

function createBuildingMesh(bld: Building): void {
  const [wx, wy, wz] = tileWorldPos(bld.x, bld.z);
  const fc = G?.factions[bld.faction].color;
  const heights  = [TILE_SIZE*0.3, TILE_SIZE*0.7, TILE_SIZE*1.4];
  const sizes    = [TILE_SIZE*0.6, TILE_SIZE*0.7, TILE_SIZE*0.8];
  const h  = heights[bld.type] ?? TILE_SIZE*0.3;
  const sz = sizes[bld.type]   ?? TILE_SIZE*0.6;
  const geom = makeBoxGeom(wx, wy, wz, sz, h, sz, fc[0], fc[1], fc[2], 1.0);
  const meshId = Entropy.generateUUID();
  addon.Model.createMesh({ id: meshId, position: [0,0,0], ...geom, pipelineId: getPipeline() });
  bld.meshId = meshId;

  // Nation capitals get a dramatic light pillar
  if (bld.type === 2) {
    Entropy.Lighting.createPointLight({
      position:    [wx, wy + 20, wz],
      color:       fc,
      intensity:   400,
      maxDistance: 120,
    });
  }
}

function removeBuildingMesh(bld: Building): void {
  if (bld.meshId) { addon.Model.clearMesh(bld.meshId); bld.meshId = null; }
}

function refreshBuildingMesh(bld: Building): void {
  removeBuildingMesh(bld);
  createBuildingMesh(bld);
}

// ─────────────────────────────────────────────────────────────────────────────
// FOG OF WAR
// ─────────────────────────────────────────────────────────────────────────────

function updateFog(fIdx: number): void {
  G?.fogVisible[fIdx].fill(false);
  const extra = techUnlocked(fIdx, "seed_library") ? 1 : 0;

  unitsOfFaction(fIdx).forEach(u => {
    tilesInRange(u.x, u.z, u.def.visionRange + extra).forEach(({ x, z }) => {
      const idx = tileIndex(x, z);
      G.fogVisible[fIdx][idx]  = true;
      G.fogExplored[fIdx][idx] = true;
    });
  });

  buildingsOfFaction(fIdx).forEach(b => {
    tilesInRange(b.x, b.z, 2 + b.type).forEach(({ x, z }) => {
      const idx = tileIndex(x, z);
      G.fogVisible[fIdx][idx]  = true;
      G.fogExplored[fIdx][idx] = true;
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SPAWN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function spawnUnit(factionIdx: number, type: string, tx: number, tz: number): GameUnit {
  const def = UNIT_DEFS[type];
  const unit: GameUnit = {
    id:             `u${G.nextUnitId++}`,
    faction:        factionIdx,
    type,
    x: tx, z: tz,
    movePointsLeft: def.movePoints,
    alive:          true,
    hasActed:       false,
    def,
    meshId:         null,
  };
  G?.units.push(unit);
  createUnitMesh(unit);
  updateFog(factionIdx);
  return unit;
}

function spawnBuilding(factionIdx: number, typeDef: BuildingDef, tx: number, tz: number): Building {
  const bld: Building = {
    id:           `b${G.nextBuildingId++}`,
    faction:      factionIdx,
    type:         typeDef.id,
    x: tx, z: tz,
    yieldPerTurn: typeDef.yieldBonus,
    meshId:       null,
  };
  G.buildings.push(bld);
  G.tiles[tileIndex(tx, tz)].building = bld.id;
  createBuildingMesh(bld);
  checkNationFormation(factionIdx);
  return bld;
}

// ─────────────────────────────────────────────────────────────────────────────
// NATION FORMATION
// ─────────────────────────────────────────────────────────────────────────────

function checkNationFormation(fIdx: number): void {
  const cities  = citiesOfFaction(fIdx).length;
  const current = G?.nations.filter(n => n.faction === fIdx).length;
  const should  = Math.floor(cities / 3);
  if (should <= current) return;

  const newCity = citiesOfFaction(fIdx).at(-1)!;
  const nation: Nation = {
    id:       `n${G.nextNationId++}`,
    faction:  fIdx,
    capitalX: newCity.x,
    capitalZ: newCity.z,
  };
  G.nations.push(nation);
  G.factions[fIdx].nationCount++;

  // Promote city to Nation Capital visually
  newCity.type         = 2;
  newCity.yieldPerTurn = BUILDING_DEFS[2].yieldBonus;
  refreshBuildingMesh(newCity);

  log(`*** ${G?.factions[fIdx]?.name} formed a Nation! Capital at (${newCity.x}, ${newCity.z}) ***`);

  // Check win: Transcendence + 2 Nations
  if (techUnlocked(fIdx, "transcendence") && G?.factions[fIdx].nationCount >= 2) {
    G.gameOver = true;
    G.winner   = fIdx;
    log(`*** ${G?.factions[fIdx]?.name} achieves Cosmic Transcendence! GAME OVER ***`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVEMENT & ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

function moveUnit(unit: GameUnit, tx: number, tz: number): boolean {
  if (!inBounds(tx, tz))                   return false;
  if (unit.faction !== G?.currentFaction)   return false;
  if (unit.hasActed)                       return false;
  if (getUnitAt(tx, tz))                  return false;

  const cost = tileAt(tx, tz).terrain.moveCost;
  if (unit.movePointsLeft < cost)          return false;

  unit.movePointsLeft -= cost;
  unit.x = tx; unit.z = tz;
  refreshUnitMesh(unit);
  updateFog(unit.faction);
  return true;
}

function foundFarm(unit: GameUnit): boolean {
  if (unit.type !== "FARMER")             return false;
  const tile = tileAt(unit.x, unit.z);
  if (tile.building)                      return false;
  if (unit.hasActed)                      return false;
  if (G?.factions[unit.faction]?.bud < 10) return false;

  spendBud(unit.faction, 10);
  unit.hasActed = true;
  spawnBuilding(unit.faction, BUILDING_DEFS[0], unit.x, unit.z);
  log(`${G?.factions[unit.faction]?.name} founded Farm at (${unit.x}, ${unit.z})`);
  return true;
}

function upgradeBuilding(bld: Building): boolean {
  if (bld.faction !== G?.currentFaction) return false;
  if (bld.type >= 1)                    return false; // Farms only manually → City
  const cost = BUILDING_DEFS[bld.type]?.budToUpgrade;
  if (G?.factions[bld.faction]?.bud < cost) return false;

  spendBud(bld.faction, cost);
  bld.type++;
  bld.yieldPerTurn = BUILDING_DEFS[bld.type].yieldBonus;
  refreshBuildingMesh(bld);
  checkNationFormation(bld.faction);
  log(`${G?.factions[bld.faction]?.name} upgraded to ${BUILDING_DEFS[bld.type]?.name} at (${bld.x}, ${bld.z})`);
  return true;
}

function recruitUnit(fIdx: number, type: string): boolean {
  const def = UNIT_DEFS[type];
  if (!def) return false;
  if (def.techReq && !techUnlocked(fIdx, def.techReq)) return false;
  if (G?.factions[fIdx]?.bud < def?.budCost) return false;
  const city = citiesOfFaction(fIdx)[0];
  if (!city) return false;
  const free = adjacentTiles(city.x, city.z).find(t => !getUnitAt(t.x, t.z));
  if (!free) return false;

  spendBud(fIdx, def?.budCost);
  spawnUnit(fIdx, type, free.x, free.z);
  log(`${G?.factions[fIdx]?.name} recruited ${def?.name}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// ECONOMY
// ─────────────────────────────────────────────────────────────────────────────

function calcIncome(fIdx: number): number {
  let total = 0;

  buildingsOfFaction(fIdx).forEach(bld => {
    const tile = tileAt(bld.x, bld.z);
    let y = bld.yieldPerTurn * tile.terrain.yieldMod;
    if (techUnlocked(fIdx, "basic_cultivation")) y += 1;
    if (techUnlocked(fIdx, "hydroponics") && tile.terrain === TERRAIN.GREENHOUSE) y *= 1.5;
    if (techUnlocked(fIdx, "quantum_grow")) y *= 1.25;
    if (techUnlocked(fIdx, "great_strain_lib")) y += 5;

    adjacentTiles(bld.x, bld.z).forEach(({ x, z }) => {
      const u = getUnitAt(x, z);
      if (u?.faction === fIdx && u.type === "BOTANIST") y += 2;
    });

    y += tile.resource;
    total += y;
  });

  unitsOfFaction(fIdx).forEach(u => {
    total += u.def?.budYield * tileAt(u.x, u.z).terrain.yieldMod;
  });

  G?.tradeRoutes
    .filter(r => r.fromFaction === fIdx || r.toFaction === fIdx)
    .forEach(r => {
      let t = r?.budPerTurn;
      if (techUnlocked(fIdx, "terpene_diplomacy")) t += 2;
      if (techUnlocked(fIdx, "mycelium_network"))  t *= 1.5;
      total += t;
    });

  return Math.floor(total);
}

// ─────────────────────────────────────────────────────────────────────────────
// TECH
// ─────────────────────────────────────────────────────────────────────────────

function startResearch(fIdx: number, techId: string): boolean {
  const tech = TECH_TREE.find(t => t.id === techId);
  if (!tech)                                                 return false;
  if (techUnlocked(fIdx, techId))                           return false;
  if (G?.techInProgress[fIdx])                               return false;
  if (tech.prereqs.some(p => !techUnlocked(fIdx, p)))       return false;
  const upfront = Math.floor(tech.cost / 4);
  if (G?.factions[fIdx]?.bud < upfront)                       return false;

  spendBud(fIdx, upfront);
  G.techInProgress[fIdx] = techId;
  G.techProgress[fIdx]   = 0;
  log(`${G?.factions[fIdx]?.name} begins researching: ${tech?.name}`);
  return true;
}

function advanceTech(fIdx: number): void {
  const techId = G?.techInProgress[fIdx];
  if (!techId) return;
  const tech = TECH_TREE.find(t => t.id === techId)!;

  let rate = 1;
  if (techUnlocked(fIdx, "strain_engineering") &&
      unitsOfFaction(fIdx).some(u => u.type === "GENETICIST")) rate = 2;

  G.techProgress[fIdx] += rate;
  if (G?.techProgress[fIdx] >= tech.cost) {
    G.unlockedTech[fIdx].add(techId);
    G.techInProgress[fIdx] = null;
    G.techProgress[fIdx]   = 0;
    log(`${G?.factions[fIdx]?.name} unlocked: ${tech?.name}! (${tech.effect})`);
    checkNationFormation(fIdx); // transcendence win check
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE
// ─────────────────────────────────────────────────────────────────────────────

function proposeTradeRoute(from: number, to: number, bpt: number): void {
  if (G?.tradeRoutes.some(r => (r.fromFaction===from && r.toFaction===to) || (r.fromFaction===to && r.toFaction===from))) return;
  G?.tradeRoutes.push({ fromFaction: from, toFaction: to, budPerTurn: bpt });
  log(`Trade route: ${G?.factions[from]?.name} ↔ ${G?.factions[to]?.name} (+${bpt} bud/turn)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TURN SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

function processFactionTurn(fIdx: number): void {
  const income = calcIncome(fIdx);
  earnBud(fIdx, income);
  advanceTech(fIdx);
  unitsOfFaction(fIdx).forEach(u => {
    u.movePointsLeft = u.def.movePoints;
    u.hasActed       = false;
  });
  if (!G?.factions[fIdx].isPlayer) runAI(fIdx);
}

function endTurn(): void {
  if (G?.gameOver) return;
  processFactionTurn(G?.currentFaction);
  G.currentFaction = (G?.currentFaction + 1) % 4;

  // Process all AI turns immediately
  let safety = 0;
  while (!G?.factions[G?.currentFaction].isPlayer && safety++ < 10) {
    processFactionTurn(G?.currentFaction);
    G.currentFaction = (G?.currentFaction + 1) % 4;
    if (G?.currentFaction === 0) G.turnNumber++;
  }
  if (G?.currentFaction === 0) G.turnNumber++;

  updateFog(0);
  log(`Your turn. Bud: ${G?.factions[0]?.bud}. Income: ${calcIncome(0)}/turn`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI
// ─────────────────────────────────────────────────────────────────────────────

function runAI(fIdx: number): void {
  // 1. Found farms
  unitsOfFaction(fIdx).filter(u => u.type === "FARMER").forEach(u => {
    if (!u.hasActed && !tileAt(u.x, u.z).building && G?.factions[fIdx]?.bud >= 10) foundFarm(u);
  });

  // 2. Move units toward fertile unexplored tiles
  unitsOfFaction(fIdx).forEach(u => {
    if (u.hasActed) return;
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    for (let dz = -u.def.movePoints; dz <= u.def.movePoints; dz++) {
      for (let dx = -u.def.movePoints; dx <= u.def.movePoints; dx++) {
        const nx = u.x + dx, nz = u.z + dz;
        if (!inBounds(nx, nz) || tileAt(nx, nz).building || getUnitAt(nx, nz)) continue;
        const score = tileAt(nx, nz).terrain.yieldMod * 10
          + (G?.fogExplored[fIdx][tileIndex(nx, nz)] ? 0 : 5)
          - (Math.abs(dx) + Math.abs(dz));
        if (score > bestScore) { bestScore = score; best = { x: nx, z: nz }; }
      }
    }
    if (best) moveUnit(u, best.x, best.z);
  });

  // 3. Upgrade farms
  buildingsOfFaction(fIdx).filter(b => b.type === 0).forEach(b => {
    if (G?.factions[fIdx]?.bud >= BUILDING_DEFS[0]?.budToUpgrade) upgradeBuilding(b);
  });

  // 4. Research
  if (!G?.techInProgress[fIdx]) {
    const available = TECH_TREE.filter(t =>
      !techUnlocked(fIdx, t.id) &&
      t.prereqs.every(p => techUnlocked(fIdx, p)) &&
      G?.factions[fIdx]?.bud >= Math.floor(t.cost / 4)
    ).sort((a, b) => a.tier - b.tier);
    if (available.length > 0) startResearch(fIdx, available[0].id);
  }

  // 5. Trade
  if (citiesOfFaction(fIdx).length > 0) {
    [0, 1, 2, 3].filter(i => i !== fIdx && citiesOfFaction(i).length > 0)
      .forEach(i => proposeTradeRoute(fIdx, i, 2));
  }

  updateFog(fIdx);
}

// ─────────────────────────────────────────────────────────────────────────────
// SCENE SETUP
// ─────────────────────────────────────────────────────────────────────────────

function setupScene(): void {
  const noiseId = addon.Noise.create({
    type:        "fbm",
    source:      "perlin",
    seed:        137,
    octaves:     6,
    frequency:   0.005,   // Lower frequency = bigger features across 1024 world
    persistence: 0.55,
    lacunarity:  2.1,
  });

  addon.Landscape.create({
    width:   LANDSCAPE_W,
    height:  LANDSCAPE_W,
    noiseId,
    size:    LANDSCAPE_W,
    scale:   LANDSCAPE_SCALE,
    position:[0, 0, 0],
  });

  addon.Lighting.updateSun({
    horizonColor:  [0.10, 0.20, 0.10],
    zenithColor:   [0.03, 0.06, 0.10],
    sunDirection:  [0.3, -0.7, 0.5],
    sunColor:      [0.85, 0.80, 0.55],
    sunIntensity:  0.35,
  });

  // Ambient world light — dim, moody
  addon.Lighting.createPointLight({
    position:    [512, 150, 512],
    color:       [0.05, 0.15, 0.05],
    intensity:   5,
    maxDistance: 2000,
  });
}

function setupFactions(): void {
  for (let i = 0; i < 4; i++) {
    G?.factions.push({ id: i, name: FACTION_NAMES[i], color: FACTION_COLORS[i], bud: 100, isPlayer: i===0, nationCount: 0 });
    G?.fogExplored.push(new Array(GRID_W * GRID_H).fill(false));
    G?.fogVisible.push(new Array(GRID_W * GRID_H).fill(false));
  }
}

function setupStartPositions(): void {
  // Spread 4 factions across the 256x256 map
  const starts: [number, number][] = [ [10, 10], [240, 10], [10, 240], [240, 240] ];
  starts.forEach(([sx, sz], fIdx) => {
    spawnUnit(fIdx, "FARMER",     sx,   sz);
    spawnUnit(fIdx, "HOMEGROWER", sx+1, sz);
    spawnUnit(fIdx, "BOTANIST",   sx,   sz+1);
    spawnUnit(fIdx, "GENETICIST", sx+1, sz+1);
    updateFog(fIdx);
  });

  // Camera starts at player faction
  G.camX = starts[0][0] * TILE_SIZE;
  G.camZ = starts[0][1] * TILE_SIZE;

  log("Starting positions placed. Welcome to Cannabis Conquest!");
  log("Controls: Click tiles to move | E = End Turn | Tab/Q/W = change tab | Right-click = deselect");
}

// ─────────────────────────────────────────────────────────────────────────────
// IN-GAME HUD  (drawRect + drawText only)
// ─────────────────────────────────────────────────────────────────────────────

let winW = 1280, winH = 720;

function drawPanel(x: number, y: number, w: number, h: number, col: [number,number,number,number]): void {
  addon.UI.drawRect({ position:[x,y], size:[w,h], color:col });
}

function drawBorder(x: number, y: number, w: number, h: number, col: [number,number,number,number], thickness=1): void {
  addon.UI.drawRect({ position:[x,y], size:[w,h], color:[0,0,0,0], strokeColor:col, strokeThickness:thickness });
}

function drawText(text: string, x: number, y: number, col: [number,number,number,number], size=13): void {
  addon.UI.drawText({ text, position:[x,y], fontSize:size, color:col });
}

function drawButton(label: string, x: number, y: number, w: number, h: number, enabled: boolean, onClick: ()=>void): void {
  const col = enabled ? C.BTN : C.BTN_DIS;
  drawPanel(x, y, w, h, col);
  drawBorder(x, y, w, h, enabled ? C.ACCENT : C.TEXT_DIM);
  const tc = enabled ? C.TEXT_BRIGHT : C.TEXT_DIM;
  drawText(label, x + 6, y + (h - 13) / 2, tc, 12);
  G?.buttons.push({ label, x, y, w, h, enabled, onClick });
}

function drawSeparator(x: number, y: number, w: number): void {
  addon.UI.drawRect({ position:[x, y], size:[w, 1], color:C.HEADER });
}

// ─────────────────────────────────────────────────────────────────────────────
// MINIMAP
// ─────────────────────────────────────────────────────────────────────────────

const MINIMAP_SAMPLE = 2; // sample every Nth tile for minimap pixel (keeps it fast)

function drawMinimap(): void {
  const mx = winW - G?.minimapW - 10;
  const my = winH - G?.minimapH - 10;
  G.minimapX = mx; G.minimapY = my;

  drawPanel(mx, my, G?.minimapW, G?.minimapH, [0, 0, 0, 200]);
  drawBorder(mx, my, G?.minimapW, G?.minimapH, C.ACCENT, 2);

  // Draw terrain tiles as tiny rects
  const pixW = G?.minimapW / (GRID_W / MINIMAP_SAMPLE);
  const pixH = G?.minimapH / (GRID_H / MINIMAP_SAMPLE);

  for (let mz = 0; mz < GRID_H; mz += MINIMAP_SAMPLE) {
    for (let mx2 = 0; mx2 < GRID_W; mx2 += MINIMAP_SAMPLE) {
      const idx = tileIndex(mx2, mz);
      if (!G?.fogExplored[0][idx]) continue;
      const tile = G?.tiles[idx];
      const tc = tile.terrain.color;
      const dimmed = G?.fogVisible[0][idx] ? 1.0 : 0.35;
      const px = mx + (mx2 / GRID_W) * G?.minimapW;
      const py = my + (mz  / GRID_H) * G?.minimapH;
      const col: [number,number,number,number] = [tc[0]*dimmed, tc[1]*dimmed, tc[2]*dimmed, 1];
      addon.UI.drawRect({ position:[px, py], size:[pixW+0.5, pixH+0.5], color:col });
    }
  }

  // Draw buildings
  G?.buildings.forEach(b => {
    if (!G?.fogExplored[0][tileIndex(b.x, b.z)]) return;
    const fc = G?.factions[b.faction].color;
    const px = mx + (b.x / GRID_W) * G?.minimapW - 1;
    const py = my + (b.z / GRID_H) * G?.minimapH - 1;
    addon.UI.drawRect({ position:[px, py], size:[4, 4], color:[fc[0], fc[1], fc[2], 1] });
  });

  // Draw player units
  unitsOfFaction(0).forEach(u => {
    const px = mx + (u.x / GRID_W) * G?.minimapW - 1;
    const py = my + (u.z / GRID_H) * G?.minimapH - 1;
    addon.UI.drawRect({ position:[px, py], size:[3, 3], color:[1, 1, 1, 1] });
  });

  drawText("MINIMAP", mx+4, my+4, C.TEXT_DIM, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HUD DRAW
// ─────────────────────────────────────────────────────────────────────────────

function drawHUD(): void {
    // clears in onUpdate
  if (G?.gameOver) { drawGameOver(); return; }

  G.buttons = []; // reset hit-test list each frame

  // ── Left panel background ──
  drawPanel(HUD_PANEL_X, HUD_PANEL_Y, HUD_W, HUD_H, C.BG);
  drawBorder(HUD_PANEL_X, HUD_PANEL_Y, HUD_W, HUD_H, C.ACCENT, 2);

  const px = HUD_PANEL_X + HUD_PAD;
  let  py  = HUD_PANEL_Y + HUD_PAD;

  // ── Title bar ──
  drawPanel(HUD_PANEL_X, py - HUD_PAD, HUD_W, 28, C.HEADER);
  drawText("CANNABIS CONQUEST", px, py, C.ACCENT2, 14);
  py += 24;

  // ── Status row ──
  const f     = G?.factions[0];
  const income= calcIncome(0);
  drawText(`Turn ${G?.turnNumber}  |  ${f?.name}`, px, py, C.TEXT_BRIGHT, 12);  py += LINE_H;
  drawText(`Bud: ${f?.bud}  (+${income}/turn)`, px, py, C.ACCENT2, 12);        py += LINE_H;

  // ── Tech in progress ──
  const tInProg = G?.techInProgress[0];
  if (tInProg) {
    const td = TECH_TREE.find(t => t.id === tInProg);

    if (td) {
        drawText(`Research: ${td?.name} (${G?.techProgress[0]}/${td.cost})`, px, py, C.WARN, 11);
    }
  } else {
    drawText("No research in progress", px, py, C.TEXT_DIM, 11);
  }
  py += LINE_H;

  drawSeparator(px, py, HUD_W - HUD_PAD*2); py += 8;

  // ── Tabs ──
  const tabs: [TabId, string][] = [
    ["overview",  "MAP"],
    ["units",     "UNITS"],
    ["cities",    "CITIES"],
    ["tech",      "TECH"],
    ["diplomacy", "DIPLO"],
  ];
  const tabW = Math.floor((HUD_W - HUD_PAD*2) / tabs.length);
  tabs.forEach(([id, label], i) => {
    const tx = px + i * tabW;
    const active = G?.activeTab === id;
    drawPanel(tx, py, tabW-2, BTN_H, active ? C.HEADER : C.BTN);
    drawBorder(tx, py, tabW-2, BTN_H, active ? C.ACCENT2 : C.ACCENT);
    drawText(label, tx+4, py+6, active ? C.ACCENT2 : C.TEXT, 10);
    const capturedId = id;
    G?.buttons.push({ label, x:tx, y:py, w:tabW-2, h:BTN_H, enabled:true, onClick:()=>{ G.activeTab=capturedId; } });
  });
  py += BTN_H + 6;

  drawSeparator(px, py, HUD_W - HUD_PAD*2); py += 6;

  // ── Tab content ──
  const contentBottom = HUD_PANEL_Y + HUD_H - BTN_H - 14;
  drawTabContent(px, py, contentBottom);

  // ── End Turn button ──
  const etY = HUD_PANEL_Y + HUD_H - BTN_H - 8;
  drawButton(`END TURN  [E]`, px, etY, HUD_W - HUD_PAD*2, BTN_H, true, () => endTurn());

  // ── Minimap ──
  drawMinimap();

  // ── Selected unit tooltip ──
  if (G?.selectedUnitId) {
    const u = G?.units.find(u2 => u2.id === G?.selectedUnitId);
    if (u && u.def && u.def?.name) {
      const ty = winH - 80;
      drawPanel(HUD_PANEL_X + HUD_W + 10, ty, 260, 70, C.BG);
      drawBorder(HUD_PANEL_X + HUD_W + 10, ty, 260, 70, C.ACCENT);
      drawText(`Selected: ${u.def?.name}  (${u.x}, ${u.z})`, HUD_PANEL_X + HUD_W + 18, ty+8, C.TEXT_BRIGHT, 12);
      drawText(`MP: ${u.movePointsLeft}/${u.def.movePoints}  |  Vision: ${u.def.visionRange}`, HUD_PANEL_X + HUD_W + 18, ty+24, C.TEXT, 11);
      drawText(u.def.desc, HUD_PANEL_X + HUD_W + 18, ty+40, C.TEXT_DIM, 11);
    }
  }
}

function drawTabContent(px: number, startY: number, maxY: number): void {
  let py = startY;

  if (G?.activeTab === "overview")  py = drawOverviewTab(px, py, maxY);
  if (G?.activeTab === "units")     py = drawUnitsTab(px, py, maxY);
  if (G?.activeTab === "cities")    py = drawCitiesTab(px, py, maxY);
  if (G?.activeTab === "tech")      py = drawTechTab(px, py, maxY);
  if (G?.activeTab === "diplomacy") py = drawDiplomacyTab(px, py, maxY);
}

function drawOverviewTab(px: number, py: number, maxY: number): number {
  drawText("FACTIONS", px, py, C.ACCENT2, 12); py += LINE_H + 2;

  G?.factions.forEach(f => {
    if (py >= maxY - LINE_H) return;
    const marker = f.isPlayer ? "> " : "  ";
    const fc = f.color;
    drawText(`${marker}${f?.name}`, px, py, [fc[0]*255|0, fc[1]*255|0, fc[2]*255|0, 255] as [number,number,number,number], 11);
    py += LINE_H;
    if (py < maxY) {
      const cities  = citiesOfFaction(f.id).length;
      const nations = G?.nations.filter(n => n.faction===f.id).length;
      drawText(`   Bud:${f?.bud}  Cities:${cities}  Nations:${nations}`, px, py, C.TEXT_DIM, 10);
      py += LINE_H;
    }
  });

  py += 4;
  drawSeparator(px, py, HUD_W - HUD_PAD*2); py += 6;
  drawText("TERRAIN KEY", px, py, C.ACCENT2, 12); py += LINE_H;
  Object.values(TERRAIN).forEach(t => {
    if (py >= maxY - LINE_H) return;
    drawText(`${t?.name}: x${t.yieldMod} yield, ${t.moveCost} move`, px+4, py, C.TEXT_DIM, 10);
    py += LINE_H;
  });
  return py;
}

function drawUnitsTab(px: number, py: number, maxY: number): number {
  const myUnits = unitsOfFaction(0);
  drawText(`YOUR UNITS (${myUnits.length})`, px, py, C.ACCENT2, 12); py += LINE_H + 2;

  myUnits.forEach(u => {
    if (py >= maxY - LINE_H * 2) return;
    const sel = G?.selectedUnitId === u.id;
    drawPanel(px, py, HUD_W - HUD_PAD*2, LINE_H*2 + 4, sel ? [30,70,35,200] : [20,40,22,150]);
    drawBorder(px, py, HUD_W - HUD_PAD*2, LINE_H*2 + 4, sel ? C.ACCENT2 : C.TEXT_DIM);
    drawText(`${u.def?.name}  (${u.x},${u.z})  MP:${u.movePointsLeft}/${u.def.movePoints}`, px+4, py+2, sel ? C.ACCENT2 : C.TEXT, 11);
    drawText(u.def.desc, px+4, py+LINE_H, C.TEXT_DIM, 10);
    const uid2 = u.id;
    G?.buttons.push({ label:"", x:px, y:py, w:HUD_W-HUD_PAD*2, h:LINE_H*2+4, enabled:true, onClick:()=>{ G.selectedUnitId = uid2; } });
    py += LINE_H * 2 + 8;
  });

  py += 2;
  drawSeparator(px, py, HUD_W - HUD_PAD*2); py += 6;
  drawText("RECRUIT (from first city)", px, py, C.ACCENT2, 11); py += LINE_H;
  const hasCities = citiesOfFaction(0).length > 0;

  Object.entries(UNIT_DEFS).forEach(([type, def]) => {
    if (py >= maxY - BTN_H - 2) return;
    const canRecruit = hasCities && G?.factions[0]?.bud >= def?.budCost &&
      (!def.techReq || techUnlocked(0, def.techReq));
    drawButton(`${def?.name} (${def?.budCost}bud)`, px, py, HUD_W - HUD_PAD*2, BTN_H - 2, canRecruit, () => recruitUnit(0, type));
    py += BTN_H + 2;
  });

  return py;
}

function drawCitiesTab(px: number, py: number, maxY: number): number {
  const myBlds = buildingsOfFaction(0);
  const myNations = G?.nations.filter(n => n.faction === 0).length;
  drawText(`SETTLEMENTS (${myBlds.length})  Nations: ${myNations}`, px, py, C.ACCENT2, 12); py += LINE_H;
  drawText("3 cities auto-form a nation", px, py, C.TEXT_DIM, 10); py += LINE_H + 4;

  myBlds.forEach(bld => {
    if (py >= maxY - LINE_H * 3 - BTN_H) return;
    const tile  = tileAt(bld.x, bld.z);
    const yld   = Math.floor(bld.yieldPerTurn * tile.terrain.yieldMod + tile.resource);
    const bName = BUILDING_DEFS[bld.type]?.name;
    drawPanel(px, py, HUD_W - HUD_PAD*2, LINE_H*2 + BTN_H + 8, C.PANEL);
    drawBorder(px, py, HUD_W - HUD_PAD*2, LINE_H*2 + BTN_H + 8, bld.type === 2 ? C.NATION : C.ACCENT);
    drawText(`${bName}  (${bld.x},${bld.z})`, px+4, py+2, bld.type===2 ? C.NATION : C.TEXT_BRIGHT, 11);
    drawText(`${tile.terrain?.name}  |  ${yld} bud/turn`, px+4, py+LINE_H+2, C.TEXT_DIM, 10);
    if (bld.type === 0) {
      const canUp = G?.factions[0]?.bud >= BUILDING_DEFS[0]?.budToUpgrade;
      drawButton(`Upgrade->City (${BUILDING_DEFS[0]?.budToUpgrade}bud)`, px+4, py+LINE_H*2+4, HUD_W-HUD_PAD*2-8, BTN_H-2, canUp, () => upgradeBuilding(bld));
    } else {
      drawText(bld.type===2 ? "★ Nation Capital" : "City — counts toward nation", px+4, py+LINE_H*2+8, bld.type===2?C.NATION:C.TEXT_DIM, 10);
    }
    py += LINE_H*2 + BTN_H + 14;
  });

  if (myBlds.length === 0) {
    drawText("No settlements. Use a Farmer", px, py, C.TEXT_DIM, 11); py += LINE_H;
    drawText("on an empty tile to found a Farm.", px, py, C.TEXT_DIM, 11); py += LINE_H;
  }
  return py;
}

function drawTechTab(px: number, py: number, maxY: number): number {
  const inProg = G?.techInProgress[0];
  if (inProg) {
    const td = TECH_TREE.find(t => t.id === inProg)!;
    const pct = Math.floor((G?.techProgress[0] / td.cost) * 100);
    drawText(`Researching: ${td?.name}`, px, py, C.WARN, 11); py += LINE_H;
    // Progress bar
    const bw = HUD_W - HUD_PAD*2;
    drawPanel(px, py, bw, 8, [30,40,30,255]);
    drawPanel(px, py, Math.floor(bw * pct / 100), 8, C.ACCENT);
    drawText(`${pct}%`, px + bw + 4, py - 1, C.TEXT_DIM, 10);
    py += 14;
  }

  const tiers = [1, 2, 3, 4];
  tiers.forEach(tier => {
    if (py >= maxY - LINE_H) return;
    drawText(`── Tier ${tier} ──`, px, py, C.ACCENT, 11); py += LINE_H;
    TECH_TREE.filter(t => t.tier === tier).forEach(tech => {
      if (py >= maxY - BTN_H - LINE_H) return;
      const unlocked    = techUnlocked(0, tech.id);
      const active      = inProg === tech.id;
      const prereqsMet  = tech.prereqs.every(p => techUnlocked(0, p));
      const canStart    = !unlocked && !active && prereqsMet && !inProg && G?.factions[0]?.bud >= Math.floor(tech.cost/4);
      const statusIcon  = unlocked ? "[OK]" : active ? "[..]" : prereqsMet ? "[--]" : "[X]";
      const tc          = unlocked ? C.ACCENT : active ? C.WARN : prereqsMet ? C.TEXT : C.TEXT_DIM;
      drawText(`${statusIcon} ${tech.icon} ${tech?.name}`, px, py, tc, 11); py += LINE_H;
      drawText(`  ${tech.effect}`, px, py, C.TEXT_DIM, 10); py += LINE_H;
      if (canStart) {
        const capturedId = tech.id;
        drawButton(`Research (${Math.floor(tech.cost/4)} bud upfront)`, px, py, HUD_W-HUD_PAD*2, BTN_H-2, true, () => startResearch(0, capturedId));
        py += BTN_H + 2;
      }
      py += 2;
    });
  });
  return py;
}

function drawDiplomacyTab(px: number, py: number, maxY: number): number {
  drawText("TRADE ROUTES", px, py, C.ACCENT2, 12); py += LINE_H;
  const myRoutes = G?.tradeRoutes.filter(r => r.fromFaction===0 || r.toFaction===0);
  if (myRoutes.length === 0) {
    drawText("No active trade routes.", px, py, C.TEXT_DIM, 11); py += LINE_H;
  } else {
    myRoutes.forEach(r => {
      if (py >= maxY - LINE_H) return;
      const other = r.fromFaction===0 ? r.toFaction : r.fromFaction;
      drawText(`<-> ${G?.factions[other]?.name}: +${r?.budPerTurn} bud/turn`, px, py, C.TEXT, 11); py += LINE_H;
    });
  }

  py += 4; drawSeparator(px, py, HUD_W-HUD_PAD*2); py += 6;
  drawText("PROPOSE TRADE", px, py, C.ACCENT2, 12); py += LINE_H;

  const hasCities = citiesOfFaction(0).length > 0;
  [1, 2, 3].forEach(fIdx => {
    if (py >= maxY - BTN_H - 2) return;
    const f = G?.factions[fIdx];
    const alreadyTrading = G?.tradeRoutes.some(r =>
      (r.fromFaction===0 && r.toFaction===fIdx) || (r.fromFaction===fIdx && r.toFaction===0)
    );
    const theirCities = citiesOfFaction(fIdx).length > 0;
    const canTrade = hasCities && theirCities && !alreadyTrading;
    drawButton(`Trade w/ ${f?.name} (+2/turn)`, px, py, HUD_W-HUD_PAD*2, BTN_H-2, canTrade, () => proposeTradeRoute(0, fIdx, 2));
    py += BTN_H + 4;
  });

  py += 4; drawSeparator(px, py, HUD_W-HUD_PAD*2); py += 6;
  drawText("STANDINGS", px, py, C.ACCENT2, 12); py += LINE_H;
  const sorted = [...G?.factions].sort((a, b) => {
    const s = (f: Faction) => citiesOfFaction(f.id).length*10 + G?.nations.filter(n=>n.faction===f.id).length*30 + f?.bud;
    return s(b) - s(a);
  });
  sorted.forEach((f, rank) => {
    if (py >= maxY - LINE_H) return;
    const s = citiesOfFaction(f.id).length*10 + G?.nations.filter(n=>n.faction===f.id).length*30 + f?.bud;
    drawText(`${rank+1}. ${f.isPlayer?"[YOU]":"[AI]"} ${f?.name}  Sc:${s}`, px, py, rank===0?C.ACCENT2:C.TEXT_DIM, 10);
    py += LINE_H;
  });
  return py;
}

function drawGameOver(): void {
  const w = 400, h = 200;
  const gx = (winW - w) / 2, gy = (winH - h) / 2;
  drawPanel(gx, gy, w, h, C.BG);
  drawBorder(gx, gy, w, h, C.ACCENT2, 3);
  const winner = G?.factions[G?.winner];
  drawText("GAME OVER", gx + w/2 - 60, gy + 20, C.ACCENT2, 20);
  drawText(`${winner?.name} achieves`, gx + 20, gy + 70, C.TEXT_BRIGHT, 14);
  drawText("COSMIC TRANSCENDENCE!", gx + 20, gy + 90, C.NATION, 16);
  drawText(`Turn ${G?.turnNumber}`, gx + 20, gy + 130, C.TEXT_DIM, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────────────────────────────────────────

Entropy.Input.onMouseMove((x, y) => { G.mouseX = x; G.mouseY = y; });

Entropy.Input.onMouseDown((button, screenX, screenY) => {
  if (button === 0) {
    // Check HUD buttons first (hit-test against current frame's button list)
    for (const btn of G?.buttons) {
      if (!btn.enabled) continue;
      if (screenX >= btn.x && screenX <= btn.x + btn.w &&
          screenY >= btn.y && screenY <= btn.y + btn.h) {
        btn.onClick();
        return;
      }
    }

    // Otherwise: world click → find tile via ray
    const ray = Entropy.Camera.screenToWorldRay(screenX, screenY);
    const [ox, oy, oz] = ray.origin;
    const [dx, dy, dz] = ray.direction;

    for (let t = 0; t < 1200; t += 3) {
      const wx = ox + dx * t, wy = oy + dy * t, wz = oz + dz * t;
      if (wx < 0 || wz < 0 || wx > LANDSCAPE_W || wz > LANDSCAPE_H) break;
      const terrainY = addon.Landscape.getHeightAt(wx, wz);
      if (Math.abs(wy - terrainY) < 2.5) {
        const tx = Math.floor(wx / TILE_SIZE);
        const tz = Math.floor(wz / TILE_SIZE);
        if (!inBounds(tx, tz)) break;
        handleWorldClick(tx, tz);
        break;
      }
    }
  }

  if (button === 2) {
    G.selectedUnitId = null;
    G.selectedTile   = null;
  }
});

function handleWorldClick(tx: number, tz: number): void {
  log(`Clicked tile (${tx}, ${tz}) — ${tileAt(tx, tz).terrain?.name}`);
  G.selectedTile = { x: tx, z: tz };

  if (G?.selectedUnitId) {
    const unit = G?.units.find(u => u.id === G?.selectedUnitId);
    if (unit) {
      if (unit.type === "FARMER" && !tileAt(tx, tz).building && tx === unit.x && tz === unit.z) {
        foundFarm(unit);
        return;
      }
      if (moveUnit(unit, tx, tz)) return;
    }
  }

  // Try selecting a player unit at the clicked tile
  const u = getUnitAt(tx, tz);
  if (u && u.faction === 0) { G.selectedUnitId = u.id; return; }
  G.selectedUnitId = null;
}

Entropy.Input.onKeyDown((key, ctrl, shift, alt) => {
  if (key === "e" || key === "E") { endTurn(); return; }
  if (key === "Tab" || key === "q" || key === "Q") {
    const tabs: TabId[] = ["overview","units","cities","tech","diplomacy"];
    G.activeTab = tabs[(tabs.indexOf(G?.activeTab) + 1) % tabs.length];
  }
  if (key === "x" || key === "X") {
    const tabs: TabId[] = ["overview","units","cities","tech","diplomacy"];
    G.activeTab = tabs[(tabs.indexOf(G?.activeTab) + tabs.length - 1) % tabs.length];
  }
  // Farmer shortcut: F = found farm on selected farmer
  if (key === "f" || key === "F") {
    if (G?.selectedUnitId) {
      const u = G?.units.find(u2 => u2.id === G?.selectedUnitId);
      if (u) foundFarm(u);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INIT + UPDATE
// ─────────────────────────────────────────────────────────────────────────────

addon.onInit(() => {
    log("Cannabis Conquest v0.2 initializinG?...");
    const [ww, wh] = Entropy.Window.getSize();
    winW = ww; winH = wh;

    if (Entropy.Composer) {
        if (Entropy.Composer.registerGame) {
            Entropy.Composer.registerGame(addonInfo?.name, (id: string, params: any) => {  
                log("Adding CC game");
                
                setupScene();

                log("Adding CC map");

                generateMap();

                log("Adding CC factions");

                setupFactions();

                log("Adding CC positions");

                setupStartPositions();

                log("Ready! E=EndTurn  Q/W=Tabs  F=FoundFarm  RightClick=Deselect");
            });
        }
    }
});

// --- Game Lifecycle ---
Entropy.onGameStarted((gameName) => {
    if (gameName === addonInfo.name) {
        Entropy.Composer?.enableGameComposerOverride();

        Entropy.println("=== CANNABIS CONQUEST ===");

        G.isGameActive = true;
        drawHUD();
        
        Entropy.println("Become King of a world where cannabis is like gold.");

        Entropy.Composer?.disableGameComposerOverride();
    }
});

Entropy.onGameStopped((gameName) => {
    if (gameName === addonInfo.name) {
        // gameState.save();
        G.isGameActive = false;
    }
});

addon.onUpdatePlus("Game Composer", (time) => {
    Entropy.Composer?.enableGameComposerOverride();
    
    if (G?.isGameActive) {
        // addon.UI.clear(); // should only clear and redraw when dirty! like fps_rpg/state.ts

        // RTS Camera movement
        const speed = 4.0;
        Entropy.Input.onKeyDown((key) => {
            
            switch (key) {
                case "w":
                case "ArrowUp":
                    G.camZ -= speed;
                    Entropy.println("[CC] keydown: " + key + " G.camZ: " + G.camZ);
                    break;

                case "s":
                case "ArrowDown":
                    G.camZ += speed;
                    break;

                case "a":
                case "ArrowLeft":
                    G.camX -= speed;
                    break;

                case "d":
                case "ArrowRight":
                    G.camX += speed;
                    break;
            
                default:
                    break;
            }
        });

        // Clamp camera to map bounds
        G.camX = Math.max(0, Math.min(LANDSCAPE_W, G?.camX));
        G.camZ = Math.max(0, Math.min(LANDSCAPE_H, G?.camZ));

        // Set the actual camera position in the engine
        // Birds-eye view: looking down from 120 units up
        const camHeight = 120;
        Entropy.Camera.setTransform(
            [G?.camX, camHeight, G?.camZ + 40], // Position (slightly offset in Z for a better angle)
            [G?.camX, 0, G?.camZ]               // Target (looking at the map)
        );

        // drawHUD();  // should only clear and redraw when dirty! like fps_rpg/state.ts
    }

    Entropy.Composer?.disableGameComposerOverride();
});

addon.onCleanup(() => {
  log("Cannabis Conquest cleanup.");
});