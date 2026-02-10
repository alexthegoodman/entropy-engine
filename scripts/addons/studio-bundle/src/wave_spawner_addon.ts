// Wave-based Enemy Spawner Addon
// Spawns waves of melee and ranged enemies with escalating difficulty

interface WaveConfig {
  waveNumber: number;
  meleeCount: number;
  rangedCount: number;
  enemyHealth: number;
  enemyDamage: number;
  spawnRadius: number;
  minSpawnDistance: number;
}

interface SpawnerState {
  currentWave: number;
  waveInProgress: boolean;
  timeBetweenWaves: number;
  waveTimer: number;
  enemiesPerWave: number;
  healthMultiplier: number;
  damageMultiplier: number;
  meleeRatio: number; // 0.0 to 1.0, percentage of melee vs ranged
  spawnRadius: number;
  minSpawnDistance: number;
  autoStart: boolean;
  isPaused: boolean;
  landscapeSize: number;
}

const addon = Entropy.Addon.register({
  name: "Wave Spawner",
  version: "1.0.0",
  description: "Spawns waves of enemies with escalating difficulty and quantity",
  author: ["Entropy AI"],
  capabilities: {
      ui: true,
      scripts: true
  }
});

let state: SpawnerState = {
  currentWave: 0,
  waveInProgress: false,
  timeBetweenWaves: 15.0, // seconds between waves
  waveTimer: 0,
  enemiesPerWave: 5, // base number of enemies
  healthMultiplier: 1.0,
  damageMultiplier: 1.0,
  meleeRatio: 0.6, // 60% melee, 40% ranged by default
  spawnRadius: 50, // spawn within this radius
  minSpawnDistance: 20, // minimum distance from player
  autoStart: false,
  isPaused: true,
  landscapeSize: 512 // adjust based on your landscape
};

Entropy.onGameStarted(() => {
  state.isPaused = false;
  state.autoStart = true;
  if (state.currentWave === 0) {
    startNextWave();
  }
  println("[Wave Spawner] Game Started via Hook");
});

Entropy.onGameStopped(() => {
  state.isPaused = true;
  state.autoStart = false;
  addon.Model.clearMeshes();
  println("[Wave Spawner] Game Stopped via Hook");
});

let windowId: string;
let playerPosition: [number, number, number] = [0, 0, 0];
let playerDirection: [number, number, number] = [0, 0, 1];

const MELEE_MODEL_PATH = "Enemy1b.glb";
const RANGED_MODEL_PATH = "Enemy1b.glb";

addon.onInit(() => {
  println("[Wave Spawner] Initializing...");
  
  // Create UI window
  windowId = addon.UI.createTab({
    title: "Wave Spawner"
  });
  
  createUI();
  
  // Load saved state if available
  const savedState = addon.IO.load();
  if (savedState) {
    state = { ...state, ...savedState };
    println("[Wave Spawner] Loaded saved state");
  }
});

addon.onUpdate((time: number, pos: [number, number, number], dir: [number, number, number]) => {
  playerPosition = pos;
  playerDirection = dir;
  
  if (!state.autoStart || state.isPaused) return;
  
  // Update wave timer
  state.waveTimer += 1/60; // Assuming 60 FPS
  
  if (!state.waveInProgress && state.waveTimer >= state.timeBetweenWaves) {
    startNextWave();
    state.waveTimer = 0;
  }
  
  // Mark wave as complete after spawn (timer-based assumption)
  if (state.waveInProgress && state.waveTimer >= 5.0) {
    state.waveInProgress = false;
  }
});

addon.onCleanup(() => {
  println("[Wave Spawner] Cleaning up...");
  addon.IO.save(state);
});

function createUI() {
  // Wave Info
  Entropy.UI.Widget.label(windowId, {
    text: "Wave-Based Enemy Spawner",
    bold: true
  });
  
  Entropy.UI.Widget.separator(windowId);
  
  // Current Wave Display
  Entropy.UI.Widget.label(windowId, {
    text: `Current Wave: ${state.currentWave}`
  });
  
  Entropy.UI.Widget.label(windowId, {
    text: state.waveInProgress ? "Wave in Progress!" : "Waiting for next wave..."
  });
  
  Entropy.UI.Widget.separator(windowId);
  
  // Controls
  Entropy.UI.Widget.button(windowId, {
    text: state.isPaused ? "▶ Resume Waves" : "⏸ Pause Waves",
    onClick: () => {
      state.isPaused = !state.isPaused;
      println(`[Wave Spawner] ${state.isPaused ? 'Paused' : 'Resumed'}`);
    }
  });
  
  Entropy.UI.Widget.checkbox(windowId, {
    label: "Auto Start Waves",
    value: state.autoStart,
    onChange: (value: boolean) => {
      state.autoStart = value;
    }
  });
  
  Entropy.UI.Widget.button(windowId, {
    text: "Start Wave Manually",
    onClick: () => {
      if (!state.waveInProgress) {
        startNextWave();
        state.waveTimer = 0;
      }
    }
  });
  
  Entropy.UI.Widget.button(windowId, {
    text: "Reset Waves",
    onClick: () => {
      state.currentWave = 0;
      state.waveInProgress = false;
      state.waveTimer = 0;
      state.healthMultiplier = 1.0;
      state.damageMultiplier = 1.0;
      println("[Wave Spawner] Reset to wave 0");
    }
  });
  
  Entropy.UI.Widget.separator(windowId);
  
  // Wave Settings
  Entropy.UI.Widget.label(windowId, {
    text: "Wave Settings",
    bold: true
  });
  
  Entropy.UI.Widget.slider(windowId, {
    label: `Base Enemies per Wave: ${state.enemiesPerWave}`,
    value: state.enemiesPerWave,
    min: 1,
    max: 50,
    onChange: (value: string) => {
      state.enemiesPerWave = parseInt(value);
    }
  });
  
  Entropy.UI.Widget.slider(windowId, {
    label: `Melee Ratio: ${Math.round(state.meleeRatio * 100)}%`,
    value: state.meleeRatio * 100,
    min: 0,
    max: 100,
    onChange: (value: string) => {
      state.meleeRatio = parseInt(value) / 100;
    }
  });
  
  Entropy.UI.Widget.slider(windowId, {
    label: `Time Between Waves: ${state.timeBetweenWaves}s`,
    value: state.timeBetweenWaves,
    min: 5,
    max: 60,
    onChange: (value: string) => {
      state.timeBetweenWaves = parseFloat(value);
    }
  });
  
  Entropy.UI.Widget.separator(windowId);
  
  // Spawn Settings
  Entropy.UI.Widget.label(windowId, {
    text: "Spawn Settings",
    bold: true
  });
  
  Entropy.UI.Widget.slider(windowId, {
    label: `Spawn Radius: ${state.spawnRadius}m`,
    value: state.spawnRadius,
    min: 10,
    max: 200,
    onChange: (value: string) => {
      state.spawnRadius = parseFloat(value);
    }
  });
  
  Entropy.UI.Widget.slider(windowId, {
    label: `Min Distance from Player: ${state.minSpawnDistance}m`,
    value: state.minSpawnDistance,
    min: 5,
    max: 100,
    onChange: (value: string) => {
      state.minSpawnDistance = parseFloat(value);
    }
  });
  
  Entropy.UI.Widget.separator(windowId);
  
  // Difficulty Info
  Entropy.UI.Widget.label(windowId, {
    text: "Difficulty Scaling",
    bold: true
  });
  
  Entropy.UI.Widget.label(windowId, {
    text: `Health Multiplier: ${state.healthMultiplier.toFixed(2)}x`
  });
  
  Entropy.UI.Widget.label(windowId, {
    text: `Damage Multiplier: ${state.damageMultiplier.toFixed(2)}x`
  });
}

function startNextWave() {
  state.currentWave++;
  state.waveInProgress = true;
  
  // Calculate wave configuration with escalating difficulty
  const config = calculateWaveConfig(state.currentWave);
  
  println(`[Wave Spawner] Starting Wave ${state.currentWave}`);
  println(`  - Melee enemies: ${config.meleeCount}`);
  println(`  - Ranged enemies: ${config.rangedCount}`);
  println(`  - Enemy health: ${config.enemyHealth}`);
  println(`  - Enemy damage: ${config.enemyDamage}`);
  
  // Update difficulty multipliers for UI
  state.healthMultiplier = config.enemyHealth / 100;
  state.damageMultiplier = config.enemyDamage / 10;
  
  // Spawn enemies
  spawnWave(config);
}

function calculateWaveConfig(waveNumber: number): WaveConfig {
  // Escalate both quantity and difficulty
  // Quantity: +20% enemies every 2 waves
  const quantityScale = 1 + Math.floor(waveNumber / 2) * 0.2;
  const totalEnemies = Math.floor(state.enemiesPerWave * quantityScale);
  
  // Difficulty: +15% health and +10% damage per wave
  const healthScale = 1 + (waveNumber - 1) * 0.15;
  const damageScale = 1 + (waveNumber - 1) * 0.10;
  
  const meleeCount = Math.floor(totalEnemies * state.meleeRatio);
  const rangedCount = totalEnemies - meleeCount;
  
  return {
    waveNumber,
    meleeCount,
    rangedCount,
    enemyHealth: 100 * healthScale,
    enemyDamage: 10 * damageScale,
    spawnRadius: state.spawnRadius,
    minSpawnDistance: state.minSpawnDistance
  };
}

function spawnWave(config: WaveConfig) {
  // Create a unique squad ID for this wave
  const squadId = `wave_${config.waveNumber}_${Date.now()}`;
  
  // Spawn melee enemies
  for (let i = 0; i < config.meleeCount; i++) {
    const spawnPos = getRandomSpawnPosition(config.spawnRadius, config.minSpawnDistance);
    spawnMeleeEnemy(spawnPos, config.enemyHealth, config.enemyDamage, squadId);
  }
  
  // Spawn ranged enemies
  for (let i = 0; i < config.rangedCount; i++) {
    const spawnPos = getRandomSpawnPosition(config.spawnRadius, config.minSpawnDistance);
    spawnRangedEnemy(spawnPos, config.enemyHealth, config.enemyDamage, squadId);
  }
}

function getRandomSpawnPosition(maxRadius: number, minRadius: number): [number, number, number] {
  // Generate random angle
  const angle = Math.random() * Math.PI * 2;
  
  // Generate random distance between minRadius and maxRadius
  const distance = minRadius + Math.random() * (maxRadius - minRadius);
  
  // Calculate position relative to player
  const x = playerPosition[0] + Math.cos(angle) * distance;
  const z = playerPosition[2] + Math.sin(angle) * distance;
  
  // Use player's Y position + small offset for ground level
  const y = playerPosition[1];
  
  return [x, y, z];
}

function spawnMeleeEnemy(position: [number, number, number], health: number, damage: number, squadId: string) {
  const enemyId = `melee_${Entropy.generateUUID()}`;
  
  addon.Model.load({
    path: MELEE_MODEL_PATH,
    id: enemyId,
    position: position,
    scale: [1, 1, 1],
    physics: {
      bodyType: "dynamic",
      colliderShape: "capsule",
      mass: 80,
      friction: 0.5,
      restitution: 0.1
    },
    npc: {
      modelId: enemyId,
      behavior: {
        aggressiveness: 0.9,
        combatType: "Melee",
        wanderRadius: 10,
        wanderSpeed: 2.0,
        detectionRadius: 30,
        meleeStats: {
          damage: damage,
          attackSpeed: 1.5,
          attackRange: 2.0
        }
      },
      squadId: squadId
    }
  });
  
  // Set enemy health
  Entropy.Entity.setStats(enemyId, {
    health: health,
    stamina: 100
  });
}

function spawnRangedEnemy(position: [number, number, number], health: number, damage: number, squadId: string) {
  const enemyId = `ranged_${Entropy.generateUUID()}`;
  
  addon.Model.load({
    path: RANGED_MODEL_PATH,
    id: enemyId,
    position: position,
    scale: [1, 1, 1],
    physics: {
      bodyType: "dynamic",
      colliderShape: "capsule",
      mass: 70,
      friction: 0.5,
      restitution: 0.1
    },
    npc: {
      modelId: enemyId,
      behavior: {
        aggressiveness: 0.7,
        combatType: "Ranged",
        wanderRadius: 15,
        wanderSpeed: 1.5,
        detectionRadius: 40,
        rangedStats: {
          damage: damage * 0.8, // Ranged enemies do slightly less damage
          attackSpeed: 1.0,
          attackRange: 25.0,
          projectileSpeed: 20.0
        }
      },
      squadId: squadId
    }
  });
  
  // Set enemy health (ranged enemies have slightly less health)
  Entropy.Entity.setStats(enemyId, {
    health: health * 0.9,
    stamina: 100
  });
}

println("[Wave Spawner] Addon loaded successfully!");