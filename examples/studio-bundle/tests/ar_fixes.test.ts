// Armageddon 2070 regressions: aircraft that start inside the map and fly (they used to spawn past the
// edge and spin in place), bot aim that is human rather than perfect, and non-tank vehicles that take
// one more launcher blast than v0.2 shipped with.
import { describe, expect, it } from "vitest";
import { Battle, STEP, NO_INPUT, eyeOf, chestOf } from "../src/games/armageddon/ar_sim";
import { think } from "../src/games/armageddon/ar_bots";
import { MAPS } from "../src/games/armageddon/ar_map";

describe("Armageddon fixes", () => {
    it("every vehicle starts inside the map on all four battlefields", () => {
        for (const m of MAPS) {
            const b = new Battle({ map: m.id, perTeam: 8, player: false, seed: 4 });
            for (const v of b.vehicles) expect(b.world.inBounds(v.pos[0], v.pos[2], 10), `${m.id} ${v.def.id}`).toBe(true);
        }
    });

    it("crewed aircraft fly instead of spinning in place", () => {
        const b = new Battle({ map: "glass-coast", perTeam: 64, player: false, seed: 4 });
        const run = (s: number) => { for (let i = 0; i < s / STEP; i++) { b.step(STEP, undefined, think); b.events.length = 0; } };
        run(25);
        let airborne = 0, spinning = 0;
        for (let k = 0; k < 6; k++) {
            const before = new Map(b.vehicles.map(v => [v.id, { x: v.pos[0], z: v.pos[2], yaw: v.yaw }]));
            run(5);
            for (const v of b.vehicles) {
                if (v.def.domain !== "Air" || !v.alive || v.landed || !b.driverOf(v)) continue;
                const o = before.get(v.id)!;
                airborne++;
                // The old out-of-bounds loop turned pi rad/s without moving a metre.
                if (Math.hypot(v.pos[0] - o.x, v.pos[2] - o.z) < 5 && Math.abs(v.yaw - o.yaw) > 6) spinning++;
            }
        }
        expect(airborne).toBeGreaterThan(5);
        expect(spinning).toBe(0);
    }, 120000);

    it("a bot rifleman hits a standing player about half the time at 30 m and rarely at 120 m", () => {
        const rate = (d: number) => {
            let shots = 0, hits = 0;
            for (let seed = 1; seed <= 8; seed++) {
                const b = new Battle({ map: "glass-coast", perTeam: 8, player: true, seed, vehicles: false });
                const me = b.me!, bot = b.soldiers.find(s => s.team === 1 && s.role === "rifleman")!;
                for (const s of b.soldiers) if (s !== me && s !== bot) { s.alive = false; s.respawnAt = Infinity; }
                let ok = false;
                for (let t = 0; t < 400 && !ok; t++) {
                    const [ax, az] = b.world.openNear(b.rng.range(-400, 400), b.rng.range(-400, 400));
                    if (b.world.infBlocked(ax + d, az) || b.world.wet(ax, az) || b.world.wet(ax + d, az)) continue;
                    me.pos = [ax, b.world.height(ax, az), az]; bot.pos = [ax + d, b.world.height(ax + d, az), az];
                    ok = b.sight(eyeOf(bot), chestOf(me)) && b.sight(eyeOf(bot), [me.pos[0], me.pos[1] + 0.5, me.pos[2]]);
                }
                if (!ok) continue;
                const at = [...me.pos] as typeof me.pos;
                for (let i = 0; i < 6 / STEP; i++) {
                    const last = bot.lastShot;
                    me.hp = 1000; me.pos = [...at] as typeof me.pos;
                    b.step(STEP, NO_INPUT, think);
                    if (bot.lastShot !== last) shots++;
                    hits += b.events.filter(e => e.kind === "hit" && e.target === me.id && !e.vehicle).length;
                    b.events.length = 0; bot.hp = 100; bot.suppression = 0;
                }
            }
            return hits / Math.max(1, shots);
        };
        const near = rate(30), mid = rate(60), far = rate(120);
        expect(near).toBeGreaterThan(0.3); expect(near).toBeLessThan(0.7);
        expect(mid).toBeLessThan(0.4);
        expect(far).toBeLessThan(0.15);
    }, 120000);

    it("non-tank vehicles take one more launcher blast than v0.2; tanks are unchanged", () => {
        // Launcher blasts (AT-Reusable-70 on the ground, AA-70 in the air) to destroy each vehicle from 60 m.
        // v0.2 shipped with: buggy 1, jeep 2, APC 7, IFV 9, MBT 25, TD 14, AA 8, artillery 12, truck 4,
        // recovery 13, attack heli 4, transport heli 4, heavy heli 6, fighter 3, attack aircraft 5, transport aircraft 10.
        const want: Record<string, number> = { V001: 2, V002: 3, V003: 8, V004: 10, V005: 25, V006: 14, V007: 9, V008: 13, V009: 5, V010: 14, V013: 5, V014: 5, V015: 7, V016: 4, V017: 6, V018: 11 };
        for (const [id, n] of Object.entries(want)) {
            const b = new Battle({ map: "glass-coast", perTeam: 8, player: false, seed: 1, vehicles: false });
            for (const s of b.soldiers) { s.alive = false; s.respawnAt = Infinity; }
            const s = b.soldiers.find(o => o.team === 0)!;
            s.alive = true;
            const [x, z] = b.world.vehOpenNear(0, 0);
            const v = b.spawnVehicle(1, id, 0, [x, z]);
            const air = v.def.domain === "Air", y = b.world.height(x, z) + (air ? 40 : 0);
            s.loadout.launcher = air ? "W015" : "W014"; s.slot = "launcher";
            v.pos[1] = y; v.landed = !air; v.altitude = y; v.speed = 0;
            for (let k = 0; k < 64; k++) { const a = k * 0.7, px = x + Math.sin(a) * 60, pz = z + Math.cos(a) * 60; s.pos = [px, b.world.height(px, pz), pz]; if (b.sight([px, s.pos[1] + 1.1, pz], [x, y + (air ? 0 : 1.2), z])) break; }
            let blasts = 0;
            for (let tries = 0; v.alive && tries < 60; tries++) {
                s.mag.launcher = 1; s.reloadUntil = 0; s.nextShot = 0; s.hp = 100; s.stance = "crouch";
                const e = [s.pos[0], s.pos[1] + 1.1, s.pos[2]], c = [x, y + (air ? 0 : 1.2), z];
                if (b.fire(s, Math.atan2(c[0] - e[0], c[2] - e[2]), Math.atan2(c[1] - e[1], Math.hypot(c[0] - e[0], c[2] - e[2])), true, v.id, "vehicle")) blasts++;
                for (let i = 0; i < 60 && b.projectiles.length; i++) { b.step(STEP); b.events.length = 0; v.speed = 0; v.pos[1] = y; }
                b.projectiles.length = 0;
            }
            expect(v.alive, id).toBe(false);
            expect(blasts, id).toBe(n);
        }
    }, 120000);
});
