// Allegiance's strategic layer without a window: the regions tiling Earth, the campaign state,
// the party's hierarchy and money, and the daily world tick (rivals, elections, coups, wars,
// crackdowns, victory). The street layer (speeches, pedestrians, combat) has its own tests in
// allegiance_street.test.ts; the live tier is tests/features/allegiance_live.feature.
import { describe, expect, it } from "vitest";
import { REGIONS, WORLD_POPULATION, PARTY, UNDECIDED, BLOCS, SCHEMES, regionDefById } from "../src/games/allegiance/al_data";
import {
    newCampaign, regionAt, neighbors, normalizeSupport, shiftSupport, partyShare, totalMembers, dateLabel, karmaTitle,
    type Campaign,
} from "../src/games/allegiance/al_state";
import {
    advanceDay, applySpeech, attemptCoup, callElection, controlLevel, coupChance, declareWar, governedShare, proposePeace,
    takeRegion, travel, travelCost, worldSupport, reportFieldBattle, suspendElections, VICTORY_SHARE, applyPamphlet,
} from "../src/games/allegiance/al_world";
import {
    appoint, autoOrganize, armMembers, orgReport, buyWeapon, buyPamphlets, buyFacility, raiseSkill, gainXp, dailyLedger,
    startScheme, recruitInPerson, setFollower, followerLimit, leaderSpan, hqCapacity, maxHealth,
} from "../src/games/allegiance/al_party";
import { makeRng, weighted, hashString } from "../src/games/allegiance/al_rng";

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe("regions", () => {
    it("have unique ids, valid coordinates and a known bloc", () => {
        const ids = new Set(REGIONS.map(r => r.id));
        expect(ids.size).toBe(REGIONS.length);
        for (const r of REGIONS) {
            expect(Math.abs(r.lat)).toBeLessThanOrEqual(90);
            expect(Math.abs(r.lon)).toBeLessThanOrEqual(180);
            expect(BLOCS.some(b => b.id === r.bloc)).toBe(true);
            expect(r.pop).toBeGreaterThan(0);
        }
        expect(REGIONS.length).toBeGreaterThan(100);
        expect(WORLD_POPULATION).toBeGreaterThan(7000);
    });

    it("tile the whole planet: every point belongs to its nearest city", () => {
        expect(regionAt(40.75, -73.99).id).toBe("new-york");
        expect(regionAt(51.5, -0.1).id).toBe("london");
        expect(regionAt(-33.87, 151.2).id).toBe("sydney");
        // The middle of the Sahara and the South Pole still belong to someone.
        expect(regionAt(23, 12).bloc).toBe("africa");
        expect(regionAt(-89, 0)).toBeDefined();
        for (const r of REGIONS) expect(regionAt(r.lat, r.lon).id).toBe(r.id);
    });

    it("know their neighbors", () => {
        const n = neighbors("paris", 4);
        expect(n).toHaveLength(4);
        expect(n).toContain("amsterdam");
        expect(n).not.toContain("paris");
    });
});

describe("rng", () => {
    it("is deterministic and resumable from its state", () => {
        const a = makeRng(42), b = makeRng(42);
        const xs = [a.next(), a.next(), a.next()];
        expect([b.next(), b.next(), b.next()]).toEqual(xs);
        const c = makeRng(a.state());
        expect(c.next()).toBe(a.next());
        expect(weighted(makeRng(1), [0, 0, 5])).toBe(2);
        expect(hashString("abc")).toBe(hashString("abc"));
    });
});

describe("a new campaign", () => {
    const c = newCampaign({ seed: 1, spawn: "lagos", partyName: "Dawn Front", ideology: "liberty", leader: "Ade" });

    it("starts you at home with a few comrades and normalized support everywhere", () => {
        expect(c.party.name).toBe("Dawn Front");
        expect(c.party.hq).toBe("lagos");
        expect(c.regions.lagos.members).toBe(12);
        expect(c.members).toHaveLength(3);
        expect(c.player.lat).toBeCloseTo(regionDefById("lagos")!.lat);
        for (const rs of Object.values(c.regions)) expect(sum(rs.support)).toBeCloseTo(1, 6);
        expect(partyShare(c.regions.lagos)).toBeGreaterThan(0);
        expect(partyShare(c.regions.paris)).toBe(0);
        expect(governedShare(c)).toBe(0);
        expect(dateLabel(0)).toBe("1 MAR 2100");
        expect(dateLabel(31)).toBe("1 APR 2100");
    });

    it("lets the Concordat govern most of the world and the Vanguard its juntas", () => {
        expect(c.regions.cairo.governor).toBe("vanguard");
        const concordat = Object.values(c.regions).filter(r => r.governor === "concordat").length;
        expect(concordat).toBeGreaterThan(REGIONS.length / 2);
        expect(c.regions["new-york"].garrison).toBeGreaterThan(c.regions.auckland.garrison);
    });

    it("is the same campaign from the same seed", () => {
        const a = newCampaign({ seed: 9, spawn: "tokyo" }), b = newCampaign({ seed: 9, spawn: "tokyo" });
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
        for (let i = 0; i < 5; i++) { advanceDay(a); advanceDay(b); }
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it("survives a save round trip", () => {
        const copy: Campaign = JSON.parse(JSON.stringify(c));
        advanceDay(copy);
        expect(copy.day).toBe(1);
    });
});

describe("support", () => {
    it("moves from the undecided first and stays normalized", () => {
        const s = { [PARTY]: 0, [UNDECIDED]: 0.5, concordat: 0.5 };
        const rs = { support: s } as any;
        const moved = shiftSupport(rs, PARTY, 0.1);
        expect(moved).toBeCloseTo(0.1);
        expect(s[UNDECIDED]).toBeLessThan(0.5);
        expect(sum(s)).toBeCloseTo(1);
        shiftSupport(rs, PARTY, 0.05, "concordat");
        expect(s.concordat).toBeLessThan(0.5);
        normalizeSupport(s);
        expect(sum(s)).toBeCloseTo(1);
    });

    it("stagnates when you do nothing and grows when you speak", () => {
        const idle = newCampaign({ seed: 3, spawn: "berlin" });
        const busy = newCampaign({ seed: 3, spawn: "berlin" });
        for (let d = 0; d < 20; d++) {
            for (let k = 0; k < 2; k++) applySpeech(busy, "berlin", { score: 0.75, crowd: 25, joined: 5, karma: 1 });
            advanceDay(idle, "berlin");
            advanceDay(busy, "berlin");
        }
        expect(partyShare(idle.regions.berlin)).toBeLessThan(0.03);
        expect(partyShare(busy.regions.berlin)).toBeGreaterThan(0.1);
        expect(busy.regions.berlin.members).toBeGreaterThan(idle.regions.berlin.members);
        expect(busy.stats.speeches).toBe(40);
        expect(worldSupport(busy)).toBeGreaterThan(worldSupport(idle));
    });

    it("gives diminishing returns for speech after speech on one day", () => {
        const c = newCampaign({ seed: 4, spawn: "lima" });
        const first = applySpeech(c, "lima", { score: 0.8, crowd: 30, joined: 0, karma: 0 });
        let last = first;
        for (let i = 0; i < 4; i++) last = applySpeech(c, "lima", { score: 0.8, crowd: 30, joined: 0, karma: 0 });
        expect(last).toBeLessThan(first * 0.5);
    });

    it("pamphlets nudge support and karma", () => {
        const c = newCampaign({ seed: 5, spawn: "lima" });
        const before = partyShare(c.regions.lima);
        applyPamphlet(c, "lima", 0.2, -0.5, 0.15);
        expect(partyShare(c.regions.lima)).toBeGreaterThan(before);
        expect(c.party.karma).toBeLessThan(0);
    });
});

describe("hierarchy", () => {
    it("needs officers as the party grows", () => {
        const c = newCampaign({ seed: 6, spawn: "mumbai" });
        c.regions.mumbai.members = 2000;
        c.regions.delhi.members = 600;
        let report = orgReport(c);
        expect(report.organized).toBeLessThan(report.total);
        expect(report.warnings.some(w => w.includes("Delhi"))).toBe(true);
        expect(report.regions.mumbai.capacity).toBe(hqCapacity(c));
        for (let i = 0; i < 12; i++) recruitInPerson(c, i % 2 ? "delhi" : "mumbai", { name: `Recruit ${i}`, charisma: 5, admin: 6, combat: 4 });
        const done = autoOrganize(c);
        expect(done.length).toBeGreaterThan(3);
        report = orgReport(c);
        expect(report.inner.treasurer).not.toBeNull();
        expect(report.regions.delhi.chief).not.toBeNull();
        expect(report.organized).toBeGreaterThan(1000);
    });

    it("limits how many officers you can direct yourself", () => {
        const c = newCampaign({ seed: 7, spawn: "london" });
        const regions = REGIONS.filter(r => r.bloc === "euro").slice(0, 8);
        for (const r of regions) {
            c.regions[r.id].members = 100;
            const m = recruitInPerson(c, r.id, { name: r.name, charisma: 5, admin: 5, combat: 5 });
            expect(appoint(c, m.id, "chief", r.id)).toBeNull();
        }
        let report = orgReport(c);
        expect(report.directReports).toBe(8);
        expect(report.leaderSpan).toBe(leaderSpan(c));
        expect(report.warnings[0]).toContain("You can direct");
        const com = recruitInPerson(c, "london", { name: "Commissar", charisma: 5, admin: 10, combat: 5 });
        expect(appoint(c, com.id, "commissioner", "euro")).toBeNull();
        report = orgReport(c);
        expect(report.directReports).toBeLessThan(8);
    });

    it("rejects cells without a chief and replaces an office holder", () => {
        const c = newCampaign({ seed: 8, spawn: "rome" });
        const [a, b] = c.members;
        expect(appoint(c, a.id, "cell", "paris")).toContain("Region Chief");
        appoint(c, a.id, "treasurer");
        appoint(c, b.id, "treasurer");
        expect(c.members.filter(m => m.role === "treasurer")).toHaveLength(1);
        expect(c.members.find(m => m.id === b.id)!.role).toBe("treasurer");
    });

    it("caps followers by Leadership", () => {
        const c = newCampaign({ seed: 9, spawn: "rome" });
        for (const m of c.members) setFollower(c, m.id, true);
        const extra = recruitInPerson(c, "rome", { name: "X", charisma: 1, admin: 1, combat: 9 });
        expect(setFollower(c, extra.id, true)).toContain("followers");
        expect(c.members.filter(m => m.follower)).toHaveLength(followerLimit(c));
    });
});

describe("money, shop and skills", () => {
    it("collects dues and taxes and pays the bills", () => {
        const c = newCampaign({ seed: 10, spawn: "tokyo" });
        c.regions.tokyo.members = 5000;
        const before = dailyLedger(c);
        takeRegion(c, c.regions.tokyo, "election");
        const after = dailyLedger(c);
        expect(after.taxes).toBeGreaterThan(0);
        expect(after.dues).toBeGreaterThan(before.dues);
        expect(after.net).toBe(after.dues + after.taxes + after.donations + after.schemes - after.salaries - after.army - after.facilities - after.admin);
    });

    it("sells weapons, pamphlets and facilities", () => {
        const c = newCampaign({ seed: 11, spawn: "tokyo" });
        c.party.funds = 20000;
        expect(buyWeapon(c, "rifle")).toBeNull();
        expect(c.player.weapon).toBe("rifle");
        expect(c.player.ammo.rifle).toBe(90);
        expect(buyWeapon(c, "rifle")).toContain("already");
        const p = c.player.pamphlets.smear;
        expect(buyPamphlets(c, "smear")).toBeNull();
        expect(c.player.pamphlets.smear).toBe(p + 10);
        expect(buyFacility(c, "press")).toBeNull();
        c.party.funds = 0;
        expect(buyWeapon(c, "rail")).toContain("funds");
    });

    it("levels up and spends skill points", () => {
        const c = newCampaign({ seed: 12, spawn: "tokyo" });
        expect(gainXp(c, 350)).toBe(2);
        expect(c.party.skillPoints).toBe(3);
        expect(raiseSkill(c, "toughness")).toBeNull();
        expect(maxHealth(c)).toBe(125);
        expect(raiseSkill(c, "toughness")).toBeNull();
        expect(raiseSkill(c, "toughness")).toContain("skill point");
    });
});

describe("taking power", () => {
    it("wins an election with enough support", () => {
        const c = newCampaign({ seed: 13, spawn: "toronto" });
        const rs = c.regions.toronto;
        expect(callElection(c, "toronto")).toContain("20%");
        shiftSupport(rs, PARTY, 0.6);
        c.party.funds = 1e6;
        expect(callElection(c, "toronto")).toBeNull();
        for (let d = 0; d < 3; d++) advanceDay(c, "toronto");
        expect(rs.governor).toBe(PARTY);
        expect(controlLevel(rs)).toBe("governed");
        expect(c.stats.elections).toBe(1);
        expect(governedShare(c)).toBeGreaterThan(0);
    });

    it("can't hold an election in a junta; a coup is a gamble there", () => {
        const c = newCampaign({ seed: 14, spawn: "cairo" });
        expect(callElection(c, "cairo")).toContain("coup");
        expect(attemptCoup(c, "cairo").ok).toBe(false);
        c.regions.cairo.members = 50000;
        c.party.funds = 1e7;
        expect(armMembers(c, "cairo", 40000)).toBeNull();
        expect(coupChance(c, "cairo")).toBeGreaterThan(0.3);
        let tries = 0;
        while (c.regions.cairo.governor !== PARTY && tries++ < 20) {
            c.regions.cairo.army = 40000;
            attemptCoup(c, "cairo");
        }
        expect(c.regions.cairo.governor).toBe(PARTY);
        expect(c.regions.cairo.unrest).toBeGreaterThan(0.25);
        expect(c.party.karma).toBeLessThan(0);
    });

    it("fights a war in rounds until one side breaks", () => {
        const c = newCampaign({ seed: 15, spawn: "havana" });
        const rs = c.regions.havana;
        expect(declareWar(c, "havana")).toContain("armed");
        rs.army = rs.garrison * 3;
        expect(declareWar(c, "havana")).toBeNull();
        expect(c.outlawedDay).toBeGreaterThan(0);
        const phases: string[] = [];
        for (let d = 0; d < 80 && rs.war; d++) { phases.push(rs.war.phase); advanceDay(c, "havana"); }
        expect(phases.slice(0, 4)).toEqual(["offensive", "counter", "offensive", "counter"]);
        expect(rs.governor).toBe(PARTY);
        expect(c.stats.regionsTaken).toBe(1);
    });

    it("loses an uprising that is badly outnumbered, and counts street battles", () => {
        const c = newCampaign({ seed: 16, spawn: "moscow" });
        const rs = c.regions.moscow;
        rs.army = 200;
        expect(declareWar(c, "moscow")).toBeNull();
        const garrison = rs.garrison;
        reportFieldBattle(c, "moscow", 10, 0);
        expect(rs.war!.fieldKills).toBe(10);
        advanceDay(c, "moscow");
        expect(rs.garrison).toBeLessThan(garrison);
        for (let d = 0; d < 60 && rs.war; d++) advanceDay(c, "moscow");
        expect(rs.war).toBeNull();
        expect(rs.governor).not.toBe(PARTY);
    });

    it("can make peace when the enemy is weak", () => {
        const c = newCampaign({ seed: 17, spawn: "havana" });
        const rs = c.regions.havana;
        rs.army = rs.garrison * 2;
        declareWar(c, "havana");
        let ok = false;
        for (let i = 0; i < 10 && !ok; i++) ok = proposePeace(c, "havana").ok;
        expect(ok).toBe(true);
        expect(rs.war).toBeNull();
        expect(rs.ceasefire).toBeGreaterThan(0);
    });

    it("suspending elections is a tyrant's move", () => {
        const c = newCampaign({ seed: 18, spawn: "toronto" });
        takeRegion(c, c.regions.toronto, "election");
        const k = c.party.karma;
        expect(suspendElections(c, "toronto")).toBeNull();
        expect(c.regions.toronto.gov).toBe("junta");
        expect(c.party.karma).toBeLessThan(k - 10);
    });
});

describe("schemes, travel and the end", () => {
    it("runs a scheme to completion", () => {
        const c = newCampaign({ seed: 19, spawn: "seoul" });
        const before = c.party.funds;
        expect(startScheme(c, "fundraise", "seoul")).toBeNull();
        expect(startScheme(c, "fundraise", "seoul")).toContain("underway");
        for (let d = 0; d < SCHEMES.find(s => s.id === "fundraise")!.days; d++) advanceDay(c);
        expect(c.schemes).toHaveLength(0);
        expect(c.news.some(n => n.text.includes("Gala Fundraiser"))).toBe(true);
        expect(c.party.funds).not.toBe(before);
    });

    it("travels across the planet for a fare and the days on the road", () => {
        const c = newCampaign({ seed: 20, spawn: "london" });
        const t = travelCost(c, c.player.lat, c.player.lon, "sydney");
        expect(t.km).toBeGreaterThan(16000);
        expect(t.days).toBeGreaterThan(2);
        expect(travel(c, "sydney")).toBeNull();
        expect(c.day).toBe(t.days);
        expect(c.player.lat).toBeCloseTo(-33.87, 1);
    });

    it("declares victory once three quarters of humanity is governed", () => {
        const c = newCampaign({ seed: 21, spawn: "delhi" });
        c.party.karma = 70;
        const sorted = [...REGIONS].sort((a, b) => b.pop - a.pop);
        let share = 0;
        for (const r of sorted) {
            if (share >= VICTORY_SHARE) break;
            c.regions[r.id].governor = PARTY;
            share += r.pop / WORLD_POPULATION;
        }
        advanceDay(c);
        expect(c.outcome?.kind).toBe("victory");
        expect(c.outcome?.title).toContain(karmaTitle(c.party.karma));
    });

    it("ends in bankruptcy after three weeks broke", () => {
        const c = newCampaign({ seed: 22, spawn: "delhi" });
        c.party.funds = -100000;
        for (let d = 0; d < 25 && !c.outcome; d++) advanceDay(c);
        expect(c.outcome?.title).toBe("BANKRUPT");
        expect(totalMembers(c)).toBeGreaterThanOrEqual(0);
    });
});
