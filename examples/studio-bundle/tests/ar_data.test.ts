// Armageddon 2070: the design database v0.2 (ar_data.ts) - every TBD filled, the brief's numbers
// kept, loadouts legal, and the CSV export matching the v0.1 columns.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as D from "../src/games/armageddon/ar_data";
import { csvTables } from "../src/games/armageddon/ar_csv";

describe("Armageddon design data", () => {
    it("passes its own audit (unique ids, legal role loadouts, the brief's numbers)", () => {
        expect(D.auditData()).toEqual([]);
    });
    it("keeps the brief: 8-person squads, a 16-seat heavy helicopter, a vehicle-carrying transport aircraft, 16-mine kit, 16-target Hunter Protocol at 80%", () => {
        for (const s of D.SQUADS) expect(s.size).toBe(8);
        expect(Math.max(...D.VEHICLES.filter(v => v.domain === "Air" && v.id !== "V018").map(v => v.seats))).toBe(16);
        expect(D.VEHICLE.get("V015")!.seats).toBe(16);
        expect(D.VEHICLE.get("V018")!.armament).toMatch(/vehicle/i);
        expect(D.REWARD.get("R101")!.count).toBe(16);
        expect(D.REWARD.get("R007")!.count).toBe(16);
        expect(D.REWARD.get("R007")!.chance).toBe(0.8);
        expect(D.BALANCE.respawn).toBeLessThanOrEqual(5);
        expect(D.MECHA_RULE.oneAtATime).toBe(true);
    });
    it("armor trades weight against protection and concealment", () => {
        const light = D.loadoutStats({ ...D.ROLE_LOADOUTS.rifleman, armor: { Helmet: "AR001", Chest: "AR004" } });
        const heavy = D.loadoutStats({ ...D.ROLE_LOADOUTS.rifleman, armor: { Helmet: "AR003", Chest: "AR006", Shoulders: "AR007H", Arms: "AR008H", Legs: "AR009H" } });
        const mimetic = D.loadoutStats({ ...D.ROLE_LOADOUTS.rifleman, armor: { Helmet: "AR003", Chest: "AR006", Finish: "AR013" } });
        expect(heavy.weight).toBeGreaterThan(light.weight + 15);
        expect(heavy.torso).toBeGreaterThan(light.torso);
        expect(heavy.speedShare).toBeLessThan(light.speedShare);
        expect(heavy.visual).toBeGreaterThan(light.visual);
        // Heavier and stronger, and harder to see.
        expect(mimetic.weight).toBeGreaterThan(light.weight);
        expect(mimetic.torso).toBeGreaterThan(light.torso);
        expect(mimetic.visual).toBeLessThan(light.visual);
    });
    it("damage falls off with range and armor stops less of armor-piercing rounds", () => {
        const ar = D.WEAPON.get("W001")!;
        expect(D.falloff(ar, 10)).toBe(ar.damage);
        expect(D.falloff(ar, ar.range)).toBeCloseTo(ar.minDamage);
        const ball = D.AMMO_BY_ID.get("AM001")!, ap = D.AMMO_BY_ID.get("AM002")!;
        expect(D.afterArmor(30, 0.6, ap)).toBeGreaterThan(D.afterArmor(30, 0.6, ball));
    });
    it("exports Design Database v0.2 with the v0.1 columns and no TBD left", () => {
        const tables = csvTables(D);
        for (const name of ["Weapons.csv", "Attachments.csv", "Armor.csv", "Vehicles.csv", "Rewards.csv", "Ammunition.csv", "Equipment.csv", "Mecha.csv", "Squads.csv", "WIR_Behaviors.csv"]) {
            const v1 = fs.readFileSync(new URL(`../../../docs/armageddon/v0.1/${name}`, import.meta.url), "utf8").split("\n")[0].trim();
            expect(tables[name].split("\n")[0].trim(), name).toBe(v1);
            expect(tables[name], name).not.toMatch(/\bTBD\b/);
            const v2 = fs.readFileSync(new URL(`../../../docs/armageddon/v0.2/${name}`, import.meta.url), "utf8");
            expect(v2, `${name} on disk is stale: npm run armageddon:csv`).toBe(tables[name]);
        }
    });
});
