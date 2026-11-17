// Armageddon 2070 weapons and the bugs around them: every weapon fires for the player (launchers used to
// be locked out for 6-60 s after any rifle shot; the HMG and AMR refused to fire standing), launchers
// carry at least two rounds, semi-automatic weapons fire once per pull, guided launchers need a lock,
// the underbarrel grenade launcher works, supply drops restock a spent launcher, and the player gets into
// a vehicle from anywhere along its hull, even a full one.
import { describe, expect, it } from "vitest";
import { Battle, STEP, NO_INPUT, SUPPLY_FALL, type PlayerInput, type Slot, type Soldier, type BattleEvent } from "../src/games/armageddon/ar_sim";
import { WEAPONS, ROLE_LOADOUTS, type Loadout } from "../src/games/armageddon/ar_data";

const input = (me: Soldier, o: Partial<PlayerInput> = {}): PlayerInput => ({ ...NO_INPUT, yaw: me.yaw, pitch: me.pitch, ...o });
/** Steps the battle (no bot thinking), collecting events. */
function run(b: Battle, steps: number, f: (i: number) => Partial<PlayerInput> = () => ({})): BattleEvent[] {
    const out: BattleEvent[] = [];
    for (let i = 0; i < steps; i++) { b.step(STEP, input(b.me!, f(i))); out.push(...b.events); b.events.length = 0; }
    return out;
}
function battle(loadout: Partial<Loadout> = {}, seed = 3): Battle {
    const b = new Battle({ map: "glass-coast", perTeam: 8, seed, vehicles: true, playerLoadout: { ...ROLE_LOADOUTS.rifleman, ...loadout } });
    const me = b.me!;
    if (!me.alive) b.respawn(me, true);
    me.pitch = 0.3;
    return b;
}
const shotsOf = (ev: BattleEvent[], me: Soldier, weapon: string) => ev.filter(e => e.kind === "shot" && e.shooter === me.id && e.weapon === weapon);

describe("Armageddon weapons", () => {
    it("every weapon fires for the player, right after a rifle burst", () => {
        for (const w of WEAPONS) {
            const slot: Slot = w.slot === "Sidearm" ? "sidearm" : w.slot === "Launcher" ? "launcher" : "primary";
            const b = battle(slot === "primary" ? { primary: w.id, attachments: {} } : slot === "sidearm" ? { sidearm: w.id } : { launcher: w.id });
            const me = b.me!;
            // A burst from the primary first (the old launcher lockout counted from any weapon's last shot).
            run(b, 6, () => ({ fire: true }));
            run(b, 1, () => ({ slot }));
            run(b, Math.ceil(Math.max(0.5, 60 / w.rpm + 0.1) / STEP)); // the swap (0.4 s), a pump or bolt cycle
            expect(me.slot, w.id).toBe(slot);
            const ev = run(b, 3, i => ({ fire: i === 0 }));
            expect(shotsOf(ev, me, w.id).length, `${w.id} ${w.name} fired`).toBeGreaterThan(0);
        }
    });

    it("every launcher carries at least two rounds and fires them all", () => {
        for (const id of ["W013", "W014", "W015"]) {
            const b = battle({ launcher: id });
            const me = b.me!;
            const total = me.mag.launcher + me.reserve.launcher;
            expect(total, id).toBeGreaterThanOrEqual(2);
            run(b, 1, () => ({ slot: "launcher" }));
            run(b, 15);
            // Pull the trigger twice a second for 30 s (reloads run between).
            const ev = run(b, 30 / STEP, i => ({ fire: i % 15 === 0 }));
            expect(shotsOf(ev, me, id).length, id).toBe(total);
        }
    });

    it("semi-automatic weapons fire once per pull, automatic ones while held", () => {
        const dmr = battle({ primary: "W009", attachments: {} });
        expect(shotsOf(run(dmr, 30, () => ({ fire: true })), dmr.me!, "W009").length).toBe(1);
        // Three pulls, 0.33 s apart (the DMR cycles in 0.27 s).
        expect(shotsOf(run(dmr, 30, i => ({ fire: i % 10 === 5 })), dmr.me!, "W009").length).toBe(3);
        const ar = battle({ primary: "W001", attachments: {} });
        expect(shotsOf(run(ar, 30, () => ({ fire: true })), ar.me!, "W001").length).toBeGreaterThan(8);
    });

    it("the player reloads by themselves when the magazine runs dry", () => {
        const b = battle({ primary: "W001", attachments: {} });
        const me = b.me!;
        me.mag.primary = 2;
        run(b, 10, () => ({ fire: true }));
        expect(me.mag.primary === 0 && me.reloadUntil > 0 || me.mag.primary === me.stats.mag).toBe(true);
        run(b, 4 / STEP);
        expect(me.mag.primary).toBe(me.stats.mag);
    });

    it("the HMG fires standing without an exoskeleton, wildly; braced it is accurate", () => {
        const b = battle({ primary: "W007", attachments: {} });
        const me = b.me!;
        const spread = (ev: BattleEvent[]) => { const d = ev.filter(e => e.kind === "shot").map(e => e.kind === "shot" ? Math.atan2(e.to[1] - e.from[1], Math.hypot(e.to[0] - e.from[0], e.to[2] - e.from[2])) : 0); return Math.max(...d) - Math.min(...d); };
        me.pitch = 0.05;
        const standing = run(b, 20, () => ({ fire: true, pitch: 0.05 }));
        expect(shotsOf(standing, me, "W007").length).toBeGreaterThan(3);
        run(b, 60, () => ({ pitch: 0.05 }));
        const prone = run(b, 20, () => ({ fire: true, prone: true, pitch: 0.05 }));
        expect(spread(prone)).toBeLessThan(spread(standing));
    });

    it("guided launchers only guide after holding a lock for the lock time", () => {
        const b = battle({ launcher: "W014" });
        const me = b.me!;
        const tank = b.vehicles.find(v => v.team !== me.team && v.def.domain === "Ground")!;
        for (const s of tank.seats) if (s >= 0) b.exitVehicle(b.soldiers[s]);
        const [x, z] = b.world.vehOpenNear(me.pos[0] + 120, me.pos[2]);
        tank.pos = [x, b.world.height(x, z), z];
        const aim = () => { const e = me.pos; return { yaw: Math.atan2(tank.pos[0] - e[0], tank.pos[2] - e[2]), pitch: Math.atan2(tank.pos[1] + 1 - (e[1] + 1.6), Math.hypot(tank.pos[0] - e[0], tank.pos[2] - e[2])) }; };
        run(b, 1, () => ({ slot: "launcher", ...aim() }));
        run(b, 15, () => aim());
        run(b, 1, () => ({ fire: true, ...aim() }));
        expect(b.projectiles.find(p => p.owner === me.id)?.guided).toBe(false);
        run(b, 6 / STEP, () => aim());
        expect(me.lock.target).toBe(tank.id);
        run(b, 1, () => ({ fire: true, ...aim() }));
        expect(b.projectiles.filter(p => p.owner === me.id).some(p => p.guided)).toBe(true);
    });

    it("the underbarrel grenade launcher takes slot 3 and lobs four HE grenades", () => {
        const b = battle({ ...ROLE_LOADOUTS.leader });
        const me = b.me!;
        expect(me.mag.launcher + me.reserve.launcher).toBe(4);
        run(b, 1, () => ({ slot: "launcher" }));
        run(b, 15);
        expect(me.slot).toBe("launcher");
        run(b, 1, () => ({ fire: true }));
        expect(b.projectiles.some(p => p.owner === me.id && p.kind === "mortar")).toBe(true);
        const ev = run(b, 5 / STEP);
        expect(ev.some(e => e.kind === "explode")).toBe(true);
    });

    it("a supply drop lands near the crosshair and restocks a spent launcher and grenades", () => {
        const b = battle({ launcher: "W014" });
        const me = b.me!;
        me.mag.launcher = 0; me.reserve.launcher = 0; me.grenades = 0;
        me.rewards.push("R002");
        // Aimed 600 m away: the drop comes down 120 m out at most.
        expect(b.useReward(me, 0, [me.pos[0] + 600, 0, me.pos[2]])).toBe("");
        const drop = b.deployables.find(d => d.kind === "supply")!;
        expect(Math.hypot(drop.x - me.pos[0], drop.z - me.pos[2])).toBeLessThan(125);
        // Walk onto it: nothing until it lands, then everything comes back.
        const [x, z] = [drop.x + 2, drop.z];
        me.pos = [x, b.world.height(x, z), z];
        run(b, Math.floor((SUPPLY_FALL - 0.5) / STEP));
        expect(me.reserve.launcher + me.mag.launcher).toBe(0);
        const ev = run(b, 2.5 / STEP);
        expect(me.mag.launcher + me.reserve.launcher).toBe(4);
        expect(me.grenades).toBeGreaterThan(0);
        expect(ev.some(e => e.kind === "resupply")).toBe(true);
        // Use (E / Y) takes from it at once.
        me.mag.launcher = 0; me.reserve.launcher = 0;
        run(b, 1, () => ({ use: true }));
        expect(me.mag.launcher + me.reserve.launcher).toBe(4);
        expect(me.vehicle).toBe(-1);
    });

    it("the player gets into a vehicle from in front of its hull, and into a full one", () => {
        const b = battle();
        const me = b.me!;
        const tank = b.vehicles.find(v => v.team === me.team && v.def.id === "V005")!;
        // 2 m in front of the hull: the old centre-distance rule (6.4 m for a tank) missed this.
        const ahead = tank.def.dims[0] / 2 + 2;
        me.pos = [tank.pos[0] + Math.sin(tank.yaw) * ahead, tank.pos[1], tank.pos[2] + Math.cos(tank.yaw) * ahead];
        run(b, 1, () => ({ use: true }));
        expect(me.vehicle).toBe(tank.id);
        run(b, 1, () => ({ use: true }));
        expect(me.vehicle).toBe(-1);
        // Full of bots: one gets out for the player.
        const bots = b.soldiers.filter(s => s.team === me.team && s.id !== me.id && s.alive && s.vehicle < 0);
        for (let i = 0; i < tank.seats.length; i++) if (tank.seats[i] < 0) b.enterVehicle(bots.pop()!, tank, i);
        expect(tank.seats.includes(-1)).toBe(false);
        me.pos = [tank.pos[0] + Math.cos(tank.yaw) * 3, tank.pos[1], tank.pos[2] - Math.sin(tank.yaw) * 3];
        run(b, 1, () => ({ use: true }));
        expect(me.vehicle).toBe(tank.id);
        expect(me.seat).toBe(0);
    });
});
