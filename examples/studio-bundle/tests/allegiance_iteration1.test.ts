import { describe, expect, it } from "vitest";
import { newCampaign, discoverSettlement, restoreSettlements, campaignRegions, regionAt, partyShare, neighbors } from "../src/games/allegiance/al_state";
import { REGIONS, WORLD_POPULATION, PARTY, countryOf, regionDefById } from "../src/games/allegiance/al_data";
import { takeRegion, governedShare, advanceDay, applySpeech, callElection } from "../src/games/allegiance/al_world";
import { startSpeech, autoplay, bestCard } from "../src/games/allegiance/al_speech";
import { newStreet, persuade, tryRecruit } from "../src/games/allegiance/al_street";
import { makeRng } from "../src/games/allegiance/al_rng";
import { Controller, stick } from "../src/games/allegiance/al_controller";
import { newBody, stepBody, NO_PLAYER_INPUT } from "../src/games/allegiance/al_player";
import { housingUnits, trafficCount, trafficPose, TRAFFIC_LIMIT } from "../src/games/allegiance/al_traffic";
import { buildFlyingCar } from "../src/games/allegiance/al_models";

const hometown = { name: "Levittown", kind: "town", lat: 40.7259, lon: -73.5143 };
describe("Iteration 1 settlement campaigns", () => {
    it("starts at a hometown outside the fixed list, preserving exact coordinates and founding members", () => {
        const c = newCampaign({ seed: 17, hometown });
        const d = regionDefById(c.party.hq)!;
        expect(d.name).toBe("Levittown");
        expect(d.pop).toBe(0.015);
        expect(c.player.lat).toBe(hometown.lat);
        expect(c.player.lon).toBe(hometown.lon);
        expect(c.regions[d.id].members).toBe(12);
        expect(c.members.every(m => m.region === d.id)).toBe(true);
        expect(regionAt(hometown.lat, hometown.lon, c).id).toBe(d.id);
        expect(campaignRegions(c).reduce((n, d) => n + d.pop, 0)).toBeCloseTo(WORLD_POPULATION, 8);
    });
    it("discovers neighboring places once, with independent conquest and daily simulation", () => {
        const c = newCampaign({ seed: 17, hometown });
        const home = regionDefById(c.party.hq)!;
        const other = discoverSettlement(c, { name: "Bethpage", kind: "village", lat: 40.7443, lon: -73.4821 });
        expect(discoverSettlement(c, { ...hometown, lat: hometown.lat + 0.0001 }).id).toBe(home.id);
        expect(c.settlements).toHaveLength(2);
        takeRegion(c, c.regions[home.id], "election");
        expect(c.regions[other.id].governor).not.toBe(PARTY);
        expect(c.regions[home.parent!].governor).not.toBe(PARTY);
        expect(governedShare(c)).toBeCloseTo(home.pop / WORLD_POPULATION, 12);
        expect(neighbors(home.id, 4, c)).toContain(other.id);
        const countdown = c.regions[other.id].electionIn;
        advanceDay(c);
        expect(c.regions[other.id].electionIn).toBe(countdown - 1);
        expect(campaignRegions(c).reduce((n, d) => n + d.pop, 0)).toBeCloseTo(WORLD_POPULATION, 8);
    });
    it("keeps a newly discovered town independent after its surrounding territory falls", () => {
        const c = newCampaign({ spawn: "new-york" });
        takeRegion(c, c.regions["new-york"], "election");
        const d = discoverSettlement(c, hometown);
        expect(c.regions[d.id].governor).not.toBe(PARTY);
        const city = discoverSettlement(c, { name: "New York", lat: 40.7128, lon: -74.006, kind: "city" });
        expect(city.id).not.toBe("new-york");
        expect(city.parent).toBe("new-york");
    });
    it("round-trips discovered governments, coordinates and recruitment through a save", () => {
        const c = newCampaign({ seed: 17, hometown });
        c.regions[c.party.hq].support[PARTY] = 0.4;
        takeRegion(c, c.regions[c.party.hq], "election");
        const loaded = restoreSettlements(JSON.parse(JSON.stringify(c)));
        expect(regionAt(hometown.lat, hometown.lon, loaded).id).toBe(c.party.hq);
        expect(loaded).toEqual(c);
        expect(newCampaign({ spawn: "london" }).settlements).toEqual([]);
    });
    it("assigns future countries to their territories and local settlements", () => {
        expect(regionDefById("los-angeles")!.country).toBe("New America");
        expect(regionDefById("new-york")!.country).toBe("The Workers States of America");
        expect(REGIONS.some(d => ["USA", "Britain", "France"].includes(d.country))).toBe(false);
        const c = newCampaign({ hometown });
        const d = regionDefById(c.party.hq)!;
        expect(d.country).toBe(regionDefById(d.parent!)!.country);
        expect(c.regions[d.id].governor).toBe(countryOf(d).ruler);
    });
    it("lets every opposition ideology grow support and petition for a vote in a workers territory", () => {
        for (const ideology of ["solidarity", "order", "liberty", "ascendancy"]) {
            const c = newCampaign({ seed: 7, hometown, ideology });
            const before = partyShare(c.regions[c.party.hq]);
            for (let i = 0; i < 25; i++) {
                const speech = startSpeech({ region: c.party.hq, ideology, oratory: 2, persuasion: 2, crowd: 30, seed: i });
                const result = autoplay(speech, bestCard, "perfect", true);
                applySpeech(c, c.party.hq, { score: result.score, crowd: result.crowd, joined: result.joined, karma: result.karma });
                advanceDay(c);
            }
            expect(partyShare(c.regions[c.party.hq])).toBeGreaterThan(before + 0.2);
            c.regions[c.party.hq].electionIn = 30;
            expect(callElection(c, c.party.hq)).toBeNull();
        }
    });
    it("makes persuasion and recruitment achievable without prior regional support", () => {
        const actor = newStreet().player;
        actor.kind = "civilian"; actor.opinion = -0.5;
        const rng = makeRng(12);
        for (let i = 0; i < 100; i++) { actor.talkCooldown = 0; persuade(actor, 0, rng); }
        expect(actor.opinion).toBeGreaterThan(0.6);
        let joined = false;
        for (let i = 0; i < 20 && !joined; i++) joined = tryRecruit(actor, 0, rng);
        expect(joined).toBe(true);
    });
    it("rejects invalid coordinates without creating political territory", () => {
        const c = newCampaign();
        expect(() => discoverSettlement(c, { ...hometown, lat: NaN })).toThrow();
        expect(() => discoverSettlement(c, { ...hometown, lon: 181 })).toThrow();
        expect(c.settlements).toEqual([]);
    });
});

describe("Iteration 1 controller and traffic", () => {
    it("filters drift, retains analog movement speed, and applies look", () => {
        expect(stick([0.1, 0.05])).toEqual([0, 0]);
        const half = newBody(), full = newBody();
        stepBody(half, { ...NO_PLAYER_INPUT, moveY: 0.5, lookX: 0.25 }, 0.1, null, () => 0);
        stepBody(full, { ...NO_PLAYER_INPUT, moveY: 1 }, 0.1, null, () => 0);
        expect(Math.hypot(half.x, half.z)).toBeCloseTo(Math.hypot(full.x, full.z) / 2);
        expect(half.yaw).toBeGreaterThan(0);
    });
    it("distinguishes presses from held buttons and clears stale input", () => {
        const pad = new Controller();
        pad.axis([0, 1], [1, 0], 2);
        expect(pad.button("RightTrigger2", true)).toBe(true);
        expect(pad.button("RightTrigger2", true)).toBe(false);
        expect(pad.button("RightTrigger2", false)).toBe(false);
        expect(pad.button("RightTrigger2", true)).toBe(true);
        pad.expire(2.6);
        expect(pad.left).toEqual([0, 0]); expect(pad.held.size).toBe(0);
    });
    it("uses sparse housing-based traffic and puts hover vehicles above roofs", () => {
        expect(trafficCount(0)).toBe(0);
        expect(housingUnits([{ kind: "box", width: 30, depth: 30, height: 45 }])).toBeGreaterThan(housingUnits([{ kind: "house", width: 12, depth: 10, height: 6 }]));
        expect(trafficCount(5)).toBeLessThan(trafficCount(500));
        expect(trafficCount(100000)).toBe(TRAFFIC_LIMIT);
        const a = trafficPose(0, 0, 0, 0, 80), b = trafficPose(0, 10, 0, 0, 80);
        expect(a.x).toBe(b.x); expect(a.z).toBe(b.z); expect(a.y).toBeGreaterThan(100);
        expect(trafficPose(1, 0, 0, 0, 80).x).not.toBe(trafficPose(1, 10, 0, 0, 80).x);
        expect(buildFlyingCar().indexData.length).toBeGreaterThan(100);
    });
});
