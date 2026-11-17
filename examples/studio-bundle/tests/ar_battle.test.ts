// Armageddon 2070's battle, headless: a 128 vs 128 Conquer battle with every WIR decision checked
// against its rule, and the rules of the brief one by one (respawn within 5 s, the Mine Kit's 16
// mines, Hunter Protocol's 16 targets at 80%, underdog and killstreak rewards, the squad call, one
// mecha per side, the 16-seat helicopter, the transport aircraft's vehicle drop).
import { describe, expect, it } from "vitest";
import { Battle, STEP, type Soldier } from "../src/games/armageddon/ar_sim";
import { think } from "../src/games/armageddon/ar_bots";
import { BALANCE } from "../src/games/armageddon/ar_data";

const run = (b: Battle, seconds: number) => { for (let i = 0; i < seconds / STEP; i++) { b.step(STEP, undefined, think); b.events.length = 0; } };

describe("Armageddon battle", () => {
    it("runs 128 vs 128 with vehicles; every WIR decision matches its rule; squads leave their bases and fight", () => {
        const b = new Battle({ map: "fusion-plant-seven", perTeam: 128, player: false, seed: 4, check: true });
        expect(b.soldiers.length).toBe(256);
        expect(b.squads.length).toBe(32);
        const t0 = Date.now();
        run(b, 150);
        const ms = (Date.now() - t0) / (150 / STEP);
        const w = b.wirStats;
        expect(w.mismatches).toBe(0);
        expect(w.infantry).toBeGreaterThan(50000);
        expect(w.squad).toBeGreaterThan(3000);
        expect(w.strategic).toBeGreaterThan(800);
        expect(w.vehicle).toBeGreaterThan(5000);
        expect(b.stats.kills).toBeGreaterThan(20);
        expect(b.stats.captures).toBeGreaterThan(2);
        const away = b.soldiers.filter(s => s.alive && Math.hypot(s.pos[0] - b.world.bases[s.team].x, s.pos[2] - b.world.bases[s.team].z) > 150).length;
        expect(away).toBeGreaterThan(100);
        expect(ms).toBeLessThan(60);
    }, 240000);

    it("everyone respawns within 5 seconds", () => {
        const b = new Battle({ map: "glass-coast", perTeam: 16, player: false, seed: 1, vehicles: false });
        run(b, 1);
        const s = b.soldiers[3];
        b.kill(s, -1, "test");
        expect(s.alive).toBe(false);
        run(b, BALANCE.respawn + 0.1);
        expect(s.alive).toBe(true);
    });

    it("the Mine Kit lays 16 mines in one go (12 anti-personnel, 4 anti-vehicle)", () => {
        const b = new Battle({ map: "kush-corridor", perTeam: 8, seed: 2, vehicles: false });
        const me = b.me!;
        me.rewards.push("R101");
        expect(b.useReward(me, 0, [b.world.territories[2].x, 0, b.world.territories[2].z])).toBe("");
        expect(b.mines.length).toBe(16);
        expect(b.mines.filter(m => m.av).length).toBe(4);
    });

    it("Hunter Protocol strikes at most 16 targets in its field, each neutralized about 80% of the time", () => {
        let hit = 0, bolts = 0;
        for (let trial = 0; trial < 6; trial++) {
            const b = new Battle({ map: "fusion-plant-seven", perTeam: 40, seed: 10 + trial, vehicles: false });
            const me = b.me!;
            // Twenty enemies in the open, in the field.
            const field = b.territories[5];
            const foes = b.soldiers.filter(s => s.team !== me.team).slice(0, 20);
            foes.forEach((s, i) => { const [x, z] = b.world.openNear(field.def.x + (i % 5) * 4 - 8, field.def.z + Math.floor(i / 5) * 4 - 6); s.pos = [x, b.world.height(x, z), z]; s.loadout.armor = {}; });
            b.step(STEP);
            me.rewards.push("R007");
            b.useReward(me, 0, [field.def.x, 0, field.def.z]);
            const before = new Set(foes.filter(s => s.alive).map(s => s.id));
            for (let i = 0; i < 4 / STEP; i++) { b.step(STEP); for (const s of foes) if (!s.alive) before.delete(s.id); }
            const neutralized = foes.filter(s => !s.alive).length;
            // Bolts: up to 16, so at most 16 fall.
            expect(neutralized).toBeLessThanOrEqual(16);
            hit += neutralized; bolts += 16;
        }
        const rate = hit / bolts;
        expect(rate).toBeGreaterThan(0.6);
        expect(rate).toBeLessThan(0.95);
    });

    it("a long time at the bottom of the leaderboard earns an underdog reward", () => {
        const b = new Battle({ map: "lhasa-arcology", perTeam: 16, seed: 3, vehicles: false });
        const me = b.me!;
        for (const s of b.soldiers) if (s.id !== me.id) s.score = 500 + s.id;
        me.deaths = 4;
        run(b, BALANCE.underdogSeconds + 35);
        expect(me.rewards.some(r => r.startsWith("R1"))).toBe(true);
        expect(b.stats.underdog).toBeGreaterThan(0);
    });

    it("kills without dying earn killstreak rewards (a Recon Drone at 3)", () => {
        const b = new Battle({ map: "glass-coast", perTeam: 16, seed: 5, vehicles: false });
        const me = b.me!;
        b.step(STEP);
        for (const s of b.soldiers.filter(s => s.team !== me.team).slice(0, 3)) b.kill(s, me.id, "AR-70");
        expect(me.streak).toBe(3);
        expect(me.rewards).toContain("R001");
    });

    it("calling the squad brings its members to the point (they stick together but may spread)", () => {
        const b = new Battle({ map: "kush-corridor", perTeam: 8, seed: 6, vehicles: false, check: true });
        const me = b.me!;
        run(b, 2);
        const sq = b.squads[me.squad];
        const base = b.world.bases[me.team];
        const [cx, cz] = b.world.openNear(base.x + 60, base.z + (me.team === 0 ? 120 : -120));
        const mates = () => sq.members.map(i => b.soldiers[i]).filter((s: Soldier) => s.alive && s.id !== me.id);
        const dist = () => mates().reduce((a, s) => a + Math.hypot(s.pos[0] - cx, s.pos[2] - cz), 0) / mates().length;
        const start = dist();
        b.step(STEP, { ...noInput(me), call: true, point: [cx, b.world.height(cx, cz), cz] }, think);
        expect(sq.call).not.toBeNull();
        run(b, 25);
        expect(dist()).toBeLessThan(start * 0.5);
        expect(sq.mode).toBe("regroup");
        expect(b.wirStats.mismatches).toBe(0);
    });

    it("the heavy transport helicopter carries 16; the transport aircraft drops a vehicle", () => {
        const b = new Battle({ map: "glass-coast", perTeam: 32, seed: 7 });
        const heli = b.vehicles.find(v => v.def.id === "V015" && v.team === 0)!;
        for (const s of b.soldiers.filter(s => s.team === 0 && s.vehicle < 0).slice(0, 20)) b.enterVehicle(s, heli);
        expect(b.passengers(heli)).toBe(16);
        const plane = b.vehicles.find(v => v.def.id === "V018" && v.team === 0)!;
        plane.payload = "V005";
        const n = b.vehicles.length;
        b.airdrop(plane);
        expect(b.vehicles.length).toBe(n + 1);
        expect(b.vehicles[n].def.id).toBe("V005");
        expect(plane.payload).toBeNull();
    });

    it("one mecha per side at a time", () => {
        const b = new Battle({ map: "fusion-plant-seven", perTeam: 16, seed: 8 });
        for (const t of b.territories) { t.owner = 0; t.progress = 1; }
        run(b, 65);
        expect(b.mecha[0]).toBeGreaterThanOrEqual(0);
        const first = b.mecha[0];
        run(b, 5);
        expect(b.mecha[0]).toBe(first);
        expect(b.vehicles.filter(v => v.mecha && v.team === 0 && v.alive).length).toBe(1);
    }, 60000);

    it("Conquer ends when a team runs out of tickets", () => {
        const b = new Battle({ map: "glass-coast", perTeam: 8, seed: 9, vehicles: false });
        b.tickets[1] = 0;
        for (const s of b.soldiers) if (s.team === 1) s.alive = false;
        b.step(STEP);
        expect(b.winner).toBe(0);
    });
});

function noInput(me: Soldier) { return { move: [0, 0] as [number, number], yaw: me.yaw, pitch: 0, fire: false, aim: false, reload: false, jump: false, sprint: false, crouch: false, prone: false, use: false, slot: null, grenade: false, equipment: false, call: false, reward: -1, point: null, throttle: 0, steer: 0, lift: 0 }; }
