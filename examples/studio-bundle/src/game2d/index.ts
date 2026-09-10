// Entropy 2D Arena - a minimal top-down arena shooter proving a lightweight 2D layer on top of
// Entropy's addon API: sprites (sprite.ts), a real orthographic camera (camera2d.ts, backed by
// a small engine-side fix - see src/core/SimpleCamera.rs), polled keyboard/mouse input
// (input2d.ts), procedural textures (textures.ts, no external asset files), and plain
// circle-circle collision here - no rapier3d involvement, which would be a 3D-physics/2D-game
// mismatch for something this simple.
//
// Controls: WASD/arrows to move, mouse to aim, hold left click to fire. R restarts after death.

import { createSpritePipeline, Sprite } from "./sprite.ts";
import { createCircleTexture, createSolidTexture } from "./textures.ts";
import { Camera2D } from "./camera2d.ts";
import { Input2D } from "./input2d.ts";

const addonInfo = {
    name: "Entropy 2D Arena",
    version: "1.0.0",
    description: "A top-down arena shooter built entirely on Entropy's TS addon API",
    author: ["Entropy Team", "Claude"],
    capabilities: {
        ui: true,
        gameplay: true,
    }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const ARENA_HALF_W = 12;
const ARENA_HALF_H = 8;
const PLAYER_SPEED = 7;
const PLAYER_RADIUS = 0.55;
const ENEMY_RADIUS = 0.5;
const BULLET_RADIUS = 0.15;
const BULLET_SPEED = 16;
const BULLET_LIFE_SEC = 2.2;
const FIRE_COOLDOWN_SEC = 0.22;
const ENEMY_BASE_SPEED = 2.2;
const ENEMY_SPEED_PER_WAVE = 0.15;
const ENEMY_HP = 2;
const CONTACT_DPS = 30; // player damage/sec while touching an enemy
const WAVE_DELAY_SEC = 2.0;
const SCORE_PER_KILL = 10;

interface Bullet {
    sprite: Sprite;
    vx: number;
    vy: number;
    life: number;
}

interface Enemy {
    sprite: Sprite;
    hp: number;
    speed: number;
}

interface Player {
    sprite: Sprite;
    x: number;
    y: number;
    rotation: number;
    hp: number;
    maxHp: number;
}

let camera: Camera2D;
let input: Input2D;
let pipelineId: string;
let bulletTex: string;
let enemyTex: string;

let player: Player;
let bullets: Bullet[] = [];
let enemies: Enemy[] = [];

let score = 0;
let wave = 0;
let waveActive = false;
let waveTimer = 0;
let gameOver = false;
let lastFireTime = -999;
let lastTime = -1;
let uiWindowId: string;

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

function spawnWave(): void {
    wave += 1;
    const count = 2 + wave;
    const spawnRadius = Math.max(ARENA_HALF_W, ARENA_HALF_H) + 2;
    for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
        const x = Math.cos(angle) * spawnRadius;
        const y = Math.sin(angle) * spawnRadius;
        const sprite = new Sprite({ textureId: enemyTex, pipelineId, x, y, z: 0.6, halfW: ENEMY_RADIUS, halfH: ENEMY_RADIUS });
        enemies.push({ sprite, hp: ENEMY_HP, speed: ENEMY_BASE_SPEED + wave * ENEMY_SPEED_PER_WAVE });
    }
    waveActive = true;
}

function fireBullet(): void {
    const dx = Math.cos(player.rotation);
    const dy = Math.sin(player.rotation);
    const sprite = new Sprite({
        textureId: bulletTex,
        pipelineId,
        x: player.x + dx * (PLAYER_RADIUS + 0.2),
        y: player.y + dy * (PLAYER_RADIUS + 0.2),
        z: 0.5,
        halfW: BULLET_RADIUS,
        halfH: BULLET_RADIUS,
    });
    bullets.push({ sprite, vx: dx * BULLET_SPEED, vy: dy * BULLET_SPEED, life: BULLET_LIFE_SEC });
}

function resetGame(): void {
    for (const b of bullets) b.sprite.destroy();
    for (const e of enemies) e.sprite.destroy();
    bullets = [];
    enemies = [];
    score = 0;
    wave = 0;
    waveActive = false;
    waveTimer = 1.0;
    gameOver = false;
    player.hp = player.maxHp;
    player.x = 0;
    player.y = 0;
    player.rotation = 0;
    player.sprite.setPosition(0, 0);
    player.sprite.setRotation(0);
}

function update(time: number): void {
    const dt = lastTime < 0 ? 0 : Math.min(time - lastTime, 0.05);
    lastTime = time;
    if (dt <= 0) return;

    if (gameOver) {
        if (input.isDown("r")) resetGame();
        return;
    }

    // Movement
    const [ax, ay] = input.moveAxis();
    const moveLen = Math.hypot(ax, ay);
    if (moveLen > 0) {
        player.x += (ax / moveLen) * PLAYER_SPEED * dt;
        player.y += (ay / moveLen) * PLAYER_SPEED * dt;
        player.x = clamp(player.x, -ARENA_HALF_W + PLAYER_RADIUS, ARENA_HALF_W - PLAYER_RADIUS);
        player.y = clamp(player.y, -ARENA_HALF_H + PLAYER_RADIUS, ARENA_HALF_H - PLAYER_RADIUS);
    }

    // Aim toward the mouse cursor's world position.
    const [wx, wy] = camera.screenToWorld(input.mouseX, input.mouseY);
    player.rotation = Math.atan2(wy - player.y, wx - player.x);
    player.sprite.x = player.x;
    player.sprite.y = player.y;
    player.sprite.rotation = player.rotation;
    player.sprite.sync();

    if (input.mouseDown && time - lastFireTime > FIRE_COOLDOWN_SEC) {
        lastFireTime = time;
        fireBullet();
    }

    // Bullets: move, expire, and check collision against enemies.
    for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        b.life -= dt;
        b.sprite.x += b.vx * dt;
        b.sprite.y += b.vy * dt;
        b.sprite.sync();

        let dead = b.life <= 0
            || Math.abs(b.sprite.x) > ARENA_HALF_W + 3
            || Math.abs(b.sprite.y) > ARENA_HALF_H + 3;

        if (!dead) {
            for (let j = enemies.length - 1; j >= 0; j--) {
                const e = enemies[j];
                const dist = Math.hypot(e.sprite.x - b.sprite.x, e.sprite.y - b.sprite.y);
                if (dist < ENEMY_RADIUS + BULLET_RADIUS) {
                    dead = true;
                    e.hp -= 1;
                    if (e.hp <= 0) {
                        e.sprite.destroy();
                        enemies.splice(j, 1);
                        score += SCORE_PER_KILL;
                    }
                    break;
                }
            }
        }

        if (dead) {
            b.sprite.destroy();
            bullets.splice(i, 1);
        }
    }

    // Enemies: chase the player, deal contact damage.
    for (const e of enemies) {
        const dist = Math.hypot(player.x - e.sprite.x, player.y - e.sprite.y) || 1;
        e.sprite.x += ((player.x - e.sprite.x) / dist) * e.speed * dt;
        e.sprite.y += ((player.y - e.sprite.y) / dist) * e.speed * dt;
        e.sprite.sync();

        if (dist < PLAYER_RADIUS + ENEMY_RADIUS) {
            player.hp -= CONTACT_DPS * dt;
        }
    }

    if (player.hp <= 0) {
        player.hp = 0;
        gameOver = true;
    }

    // Wave spawning: next wave starts WAVE_DELAY_SEC after the previous one is fully cleared.
    if (!waveActive) {
        waveTimer -= dt;
        if (waveTimer <= 0) spawnWave();
    } else if (enemies.length === 0) {
        waveActive = false;
        waveTimer = WAVE_DELAY_SEC;
    }
}

function renderUI(): void {
    Entropy.UI.Widget.label(uiWindowId, { text: "Entropy 2D Arena", bold: true });
    Entropy.UI.Widget.label(uiWindowId, { text: `Score: ${score}` });
    Entropy.UI.Widget.label(uiWindowId, { text: `Wave: ${wave}` });
    Entropy.UI.Widget.label(uiWindowId, { text: `HP: ${Math.max(0, Math.round(player.hp))} / ${player.maxHp}` });
    if (gameOver) {
        Entropy.UI.Widget.label(uiWindowId, { text: "GAME OVER - hold R to restart" });
    } else {
        Entropy.UI.Widget.label(uiWindowId, { text: "WASD move, mouse aim, click to fire" });
    }
}

addon.onInit(() => {
    pipelineId = createSpritePipeline("Sprite2D");

    const playerTex = createCircleTexture(64, [0.25, 0.85, 0.95, 1]);
    enemyTex = createCircleTexture(64, [0.95, 0.25, 0.3, 1]);
    bulletTex = createCircleTexture(24, [1, 0.95, 0.4, 1]);
    const floorTex = createSolidTexture([0.08, 0.09, 0.12, 1]);

    camera = new Camera2D(20);
    camera.lookAt(0, 0);

    input = new Input2D();

    // Arena floor - a single large tinted quad, drawn behind everything else via a lower z.
    new Sprite({ textureId: floorTex, pipelineId, x: 0, y: 0, z: 0, halfW: ARENA_HALF_W, halfH: ARENA_HALF_H });

    const playerSprite = new Sprite({ textureId: playerTex, pipelineId, x: 0, y: 0, z: 0.7, halfW: PLAYER_RADIUS, halfH: PLAYER_RADIUS });
    player = { sprite: playerSprite, x: 0, y: 0, rotation: 0, hp: 100, maxHp: 100 };

    waveTimer = 1.0;

    uiWindowId = Entropy.UI.createWindow({ title: "Arena", width: 240, height: 190, x: 20, y: 20, onRender: renderUI });

    Entropy.println("Entropy 2D Arena initialized");
});

// `addon.onUpdate` only fires when this addon's own tab is the focused Studio workspace -
// irrelevant here since this ships as a standalone EntropyApp, which never sets a workspace and
// defaults `current_addon_name` to "Global" instead (same reasoning as fft_water_addon.ts's
// identical onUpdatePlus("Global", ...) registration).
addon.onUpdatePlus("Global", (time) => update(time));
