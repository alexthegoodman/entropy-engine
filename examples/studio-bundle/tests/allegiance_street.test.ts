// Allegiance's street layer without a window: the speech mini-game, the local frame and nav grid
// over OpenStreetMap-style buildings, A* paths, pedestrians, crowds, pamphlets, recruiting, and
// street combat. (The strategic layer is allegiance_world.test.ts.)
import { describe, expect, it } from "vitest";
import {
    startSpeech, chooseCard, deliver, stepSpeech, rebutHeckler, autoplay, bestCard, gradeAt, regionSegments, deckFor, BEATS,
    CHOOSE_SECONDS, type SpeechState,
} from "../src/games/allegiance/al_speech";
import {
    NavGrid, makeLocalFrame, toLocal, toWorld, buildingToRect, insideRect, pushOutOfRect, segmentHitsRect, type Rect,
} from "../src/games/allegiance/al_nav";
import {
    newStreet, stepStreet, startCrowd, endCrowd, listeners, convertListeners, givePamphlet, tryRecruit, recruitChance, persuade,
    playerShoot, spawnSquad, soldiers, nearestActor, opinionLabel, shiftStreet, rayHitsActor, type StreetContext, type Actor,
} from "../src/games/allegiance/al_street";
import { pamphletById, weaponById } from "../src/games/allegiance/al_data";
import { makeRng } from "../src/games/allegiance/al_rng";
import { latLonToDir } from "../src/apps/quadplanet/qp_planet";

// --- Speeches ------------------------------------------------------------------------------------

const speech = (seed = 1, extra: Partial<Parameters<typeof startSpeech>[0]> = {}): SpeechState =>
    startSpeech({ region: "lagos", ideology: "solidarity", oratory: 0, persuasion: 0, crowd: 15, seed, ...extra });

describe("the speech mini-game", () => {
    it("runs five beats of choose, deliver, react", () => {
        const s = speech();
        expect(s.phase).toBe("choose");
        expect(s.hand).toHaveLength(3);
        expect(new Set(s.hand.map(c => c.topic)).size).toBe(3);
        let beats = 0;
        while (s.phase !== "done") {
            if (s.phase === "choose") { expect(chooseCard(s, 0)).toBe(true); beats++; }
            else if (s.phase === "deliver") { s.marker = s.sweet; expect(deliver(s)).toBe("perfect"); }
            else if (s.phase === "heckle") rebutHeckler(s, s.heckler!.key);
            else stepSpeech(s, 2);
        }
        expect(beats).toBe(BEATS);
        expect(s.grades.every(g => g === "perfect")).toBe(true);
        expect(s.result!.score).toBeGreaterThan(0.8);
        expect(s.result!.joined).toBeGreaterThan(0);
        expect(s.combo).toBeGreaterThanOrEqual(1);
    });

    it("grades the delivery by distance from the sweet spot", () => {
        expect(gradeAt(0.5, 0.5, 0.1)).toBe("perfect");
        expect(gradeAt(0.56, 0.5, 0.1)).toBe("good");
        expect(gradeAt(0.59, 0.5, 0.1)).toBe("weak");
        expect(gradeAt(0.7, 0.5, 0.1)).toBe("miss");
    });

    it("sweeps the marker and misses when you never press", () => {
        const s = speech(2);
        chooseCard(s, 0);
        const m0 = s.marker;
        stepSpeech(s, 0.2);
        expect(s.marker).not.toBe(m0);
        for (let t = 0; t < 60 && s.phase === "deliver"; t++) stepSpeech(s, 0.1);
        expect(s.lastGrade).toBe("miss");
        expect(s.marker).toBeGreaterThanOrEqual(0);
        expect(s.marker).toBeLessThanOrEqual(1);
    });

    it("picks for you when you hesitate", () => {
        const s = speech(3);
        stepSpeech(s, CHOOSE_SECONDS + 0.1);
        expect(s.phase).toBe("deliver");
    });

    it("rewards good timing and a well-read crowd", () => {
        const avg = (grade: "perfect" | "good" | "weak" | "miss", smart: boolean) => {
            let total = 0;
            for (let seed = 1; seed <= 12; seed++) total += autoplay(speech(seed), smart ? bestCard : () => 2, grade).score;
            return total / 12;
        };
        expect(avg("perfect", true)).toBeGreaterThan(avg("good", true));
        expect(avg("good", true)).toBeGreaterThan(avg("good", false));
        expect(avg("good", false)).toBeGreaterThan(avg("weak", false));
        expect(avg("miss", true)).toBeLessThan(0.3);
    });

    it("lets you rebut a heckler or lose face", () => {
        const s = speech(4, { heat: 1 });
        let found = false;
        for (let guard = 0; guard < 200 && s.phase !== "done" && !found; guard++) {
            if (s.phase === "choose") chooseCard(s, 0);
            else if (s.phase === "deliver") { s.marker = s.sweet; deliver(s); }
            else if (s.phase === "heckle") found = true;
            else stepSpeech(s, 2);
        }
        expect(found).toBe(true);
        const fervor = s.fervor;
        expect(rebutHeckler(s, s.heckler!.key.toUpperCase())).toBe(true);
        expect(s.fervor).toBeGreaterThan(fervor);
    });

    it("faces a rival orator: answering their topic wins the crowd", () => {
        const rival = { faction: "vanguard", name: "Gen. Holt", skill: 6 };
        const answer = (s: SpeechState) => Math.max(0, s.hand.findIndex(c => c.topic === s.rival!.topic));
        const won = autoplay(speech(5, { rival }), answer, "perfect").rival!;
        expect(won.faction).toBe("vanguard");
        expect(won.won).toBe(true);
        const lost = autoplay(speech(5, { rival }), () => 2, "miss").rival!;
        expect(lost.won).toBe(false);
    });

    it("unlocks stronger cards with oratory and knows each region's crowd", () => {
        expect(deckFor(4).length).toBeGreaterThan(deckFor(0).length);
        const poor = regionSegments("kinshasa"), rich = regionSegments("singapore");
        expect(poor.workers).toBeGreaterThan(rich.workers);
        expect(rich.professionals).toBeGreaterThan(poor.professionals);
        expect(Object.values(poor).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    });
});

// --- Navigation ----------------------------------------------------------------------------------

const square = (cx: number, cz: number, hw: number, hd: number, key: string): Rect =>
    ({ cx, cz, ux: 1, uz: 0, hw, hd, height: 8, base: 0, key, door: [cx, cz - hd - 1.6] });

describe("the local frame", () => {
    it("maps east, north and up on Earth's surface", () => {
        const R = 6371000;
        const origin = latLonToDir(45, 7).map(v => v * R) as [number, number, number];
        const f = makeLocalFrame(origin);
        const east = toWorld(f, 100, 0, 0);
        const back = toLocal(f, east);
        expect(back[0]).toBeCloseTo(100, 6);
        expect(back[2]).toBeCloseTo(0, 6);
        // North really is toward the pole: latitude grows.
        const north = toWorld(f, 0, 0, 1000);
        const lat = Math.asin(north[1] / Math.hypot(...north)) * 180 / Math.PI;
        expect(lat).toBeGreaterThan(45);
    });

    it("turns a building into a rectangle with its door at the front", () => {
        const f = makeLocalFrame([0, 0, 6371000]);
        const r = buildingToRect(f, { key: "b", anchor: [10, 0, 6371000], right: [1, 0, 0], forward: [0, -1, 0], width: 10, depth: 8, height: 6 });
        expect(r.cx).toBeCloseTo(10);
        expect(r.hw).toBe(5);
        expect(insideRect(r, 10, 0)).toBe(true);
        expect(insideRect(r, 10, 4.5)).toBe(false);
        expect(r.door[1]).toBeLessThan(-4);
    });

    it("pushes circles out of walls and hits them with segments", () => {
        const r = square(0, 0, 5, 5, "a");
        const [x, z] = pushOutOfRect(r, 4.8, 0, 0.4);
        expect(x).toBeCloseTo(5.4);
        expect(z).toBeCloseTo(0);
        expect(segmentHitsRect(r, -20, 0, 20, 0)).toBeCloseTo(15 / 40);
        expect(segmentHitsRect(r, -20, 10, 20, 10)).toBeNull();
    });
});

describe("the nav grid", () => {
    const grid = () => {
        const g = new NavGrid(0, 0, 100, 2);
        // A wall of buildings with one gap at x = 0.
        g.addRect(square(-54, 0, 50, 4, "w"));
        g.addRect(square(54, 0, 50, 4, "e"));
        return g;
    };

    it("blocks building footprints and finds a path around them through the gap", () => {
        const g = grid();
        expect(g.walkable(-25, 0)).toBe(false);
        expect(g.walkable(25, 0)).toBe(false);
        expect(g.walkable(0, 0)).toBe(true);
        const path = g.findPath(-30, -20, -30, 20)!;
        expect(path).not.toBeNull();
        expect(path[path.length - 1][0]).toBeCloseTo(-30);
        expect(path[path.length - 1][1]).toBeCloseTo(20);
        // Every leg stays on walkable ground (string pulling keeps lines clear).
        let prev: [number, number] = [-30, -20];
        for (const p of path) { expect(g.lineClear(prev[0], prev[1], p[0], p[1])).toBe(true); prev = p; }
        // It went through the gap.
        expect(path.some(p => Math.abs(p[0]) < 6 && Math.abs(p[1]) < 8)).toBe(true);
    });

    it("reports unreachable goals and water", () => {
        const g = new NavGrid(0, 0, 60, 2);
        g.addRect(square(0, 0, 70, 3, "wall"));
        expect(g.findPath(0, -20, 0, 20)).toBeNull();
        const w = new NavGrid(0, 0, 40, 2);
        w.markWhere((x) => x > 10);
        expect(w.walkable(20, 0)).toBe(false);
        expect(w.walkable(-10, 0)).toBe(true);
    });

    it("sees through gaps, not walls, and finds walkable ground nearby", () => {
        const g = grid();
        expect(g.sightClear(0, -20, 0, 20)).toBe(true);
        expect(g.sightClear(-25, -20, -25, 20)).toBe(false);
        const p = g.nearestWalkable(-25, 0)!;
        expect(g.walkable(p[0], p[1])).toBe(true);
        expect(g.collide(-25, 3.9, 0.4)[1]).toBeGreaterThan(4);
    });
});

// --- Pedestrians and combat ----------------------------------------------------------------------

const ctx = (extra: Partial<StreetContext> = {}): StreetContext => ({
    partyShare: 0.2, rivalShares: { concordat: 0.4, vanguard: 0.2, verdant: 0.1, current: 0.1 }, atWar: false, heat: 0,
    enemyQuality: 0.7, followers: [], playerWeapon: "pistol", calm: true, ...extra,
});
const flat = () => 0;

function town(): NavGrid {
    const g = new NavGrid(0, 0, 160, 2);
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
        if (i === 0 && j === 0) continue;
        g.addRect(square(i * 40, j * 40, 9, 7, `b${i}${j}`));
    }
    return g;
}

describe("pedestrians", () => {
    it("populate the streets and walk between building doors", () => {
        const st = newStreet(), nav = town(), r = makeRng(1);
        for (let i = 0; i < 600; i++) stepStreet(st, nav, ctx(), 1 / 10, r, flat);
        const civ = st.actors.filter(a => a.kind === "civilian");
        expect(civ.length).toBeGreaterThan(20);
        expect(civ.every(a => nav.walkable(a.x, a.z) || a.state === "dead" || nav.nearestWalkable(a.x, a.z, 1))).toBe(true);
        expect(civ.some(a => a.state === "walk" && a.speed > 0.5)).toBe(true);
        expect(civ.every(a => opinionLabel(a.opinion).length > 0)).toBe(true);
    });

    it("gather around you for a speech and go home after", () => {
        const st = newStreet(), nav = town(), r = makeRng(2);
        for (let i = 0; i < 100; i++) stepStreet(st, nav, ctx(), 0.1, r, flat);
        startCrowd(st, 0, 0, 12);
        for (let i = 0; i < 400; i++) stepStreet(st, nav, ctx(), 0.1, r, flat);
        const crowd = listeners(st);
        expect(crowd.length).toBeGreaterThan(6);
        expect(crowd.every(a => Math.hypot(a.x, a.z) < 14)).toBe(true);
        const before = crowd.map(a => a.opinion);
        const heard = endCrowd(st, { workers: 0.5, students: 0.5, professionals: 0.5, elders: 0.5, faithful: 0.5, veterans: 0.5 });
        expect(heard.length).toBe(crowd.length);
        heard.forEach((a, i) => expect(a.opinion).toBeGreaterThanOrEqual(before[i]));
        expect(listeners(st)).toHaveLength(0);
        expect(convertListeners(st, 3)).toHaveLength(3);
    });

    it("take pamphlets, can be persuaded and recruited", () => {
        const r = makeRng(3);
        const st = newStreet();
        for (let i = 0; i < 3; i++) stepStreet(st, null, ctx(), 0.1, r, flat);
        const a = st.actors[0];
        a.opinion = 0.2;
        const d = givePamphlet(a, pamphletById("propaganda"), 2, true, r)!;
        expect(d).toBeGreaterThan(0);
        expect(givePamphlet(a, pamphletById("propaganda"), 2, true, r)).toBeNull();
        a.opinion = 0.1;
        expect(recruitChance(a, 0)).toBe(0);
        a.opinion = 0.95;
        let joined = false;
        for (let i = 0; i < 20 && !joined; i++) { a.talkCooldown = 0; joined = tryRecruit(a, 3, r); }
        expect(joined).toBe(true);
        expect(a.member).toBe(true);
        const b = st.actors[1];
        b.talkCooldown = 0;
        persuade(b, 5, r);
        expect(b.talkCooldown).toBeGreaterThan(0);
    });

    it("flee from gunfire", () => {
        const st = newStreet(), r = makeRng(4);
        for (let i = 0; i < 30; i++) stepStreet(st, null, ctx(), 0.1, r, flat);
        const near = st.actors.filter(a => Math.hypot(a.x, a.z) < 50);
        playerShoot(st, null, [0, 1.6, 0], [0, 0, 1], weaponById("pistol"), 0, r);
        stepStreet(st, null, ctx(), 0.1, r, flat);
        expect(near.every(a => a.state === "flee" || a.state === "dead")).toBe(true);
    });

    it("finds who you are facing", () => {
        const st = newStreet(), r = makeRng(5);
        stepStreet(st, null, ctx(), 0.1, r, flat);
        const a = st.actors[0];
        a.x = 0; a.z = 2;
        st.player.heading = 0;
        expect(nearestActor(st)?.id).toBe(a.id);
        shiftStreet(st, 0, 1);
        expect(a.z).toBeCloseTo(1);
    });
});

describe("street combat", () => {
    it("hits a standing capsule and not the air beside it", () => {
        const a = { x: 0, z: 10, y: 0, state: "idle" } as Actor;
        expect(rayHitsActor([0, 1.6, 0], [0, 0, 1], a, 100)).toBeCloseTo(10, 0);
        expect(rayHitsActor([3, 1.6, 0], [0, 0, 1], a, 100)).toBeNull();
        expect(rayHitsActor([0, 5, 0], [0, 0, 1], a, 100)).toBeNull();
    });

    it("walls stop bullets", () => {
        const st = newStreet(), r = makeRng(6);
        const nav = new NavGrid(0, 0, 60, 2);
        nav.addRect(square(0, 6, 5, 1, "wall"));
        stepStreet(st, nav, ctx(), 0.1, r, flat);
        const a = st.actors[0];
        a.x = 0; a.z = 12; a.state = "idle";
        const [shot] = playerShoot(st, nav, [0, 1.5, 0], [0, 0, 1], { ...weaponById("rifle"), spread: 0 }, 0, r);
        expect(shot.blocked).toBe(true);
        expect(shot.hit).toBeNull();
    });

    it("soldiers fight followers and you, and every kill is counted", () => {
        const st = newStreet(), nav = town(), r = makeRng(7);
        st.player.health = 1e9;
        const c = ctx({ atWar: true, calm: false, followers: [1, 2].map(id => ({ id, name: `F${id}`, armed: true, combat: 3 })) });
        stepStreet(st, nav, c, 0.1, r, flat);
        expect(st.actors.filter(a => a.kind === "follower")).toHaveLength(2);
        expect(spawnSquad(st, nav, c, r, 4, false)).toBeGreaterThan(0);
        const events: string[] = [];
        let kills = 0, enemyShots = 0;
        for (let i = 0; i < 3000 && soldiers(st).length; i++) {
            stepStreet(st, nav, { ...c, calm: true }, 0.05, r, flat);
            // You fire back at the nearest soldier you can see, three times a second.
            const foe = soldiers(st).filter(a => nav.sightClear(st.player.x, st.player.z, a.x, a.z))
                .sort((a, b) => Math.hypot(a.x - st.player.x, a.z - st.player.z) - Math.hypot(b.x - st.player.x, b.z - st.player.z))[0];
            if (foe && i % 7 === 0) {
                const dx = foe.x - st.player.x, dy = foe.y + 1.2 - 1.6, dz = foe.z - st.player.z, l = Math.hypot(dx, dy, dz);
                playerShoot(st, nav, [st.player.x, 1.6, st.player.z], [dx / l, dy / l, dz / l], { ...weaponById("rifle"), spread: 0.005 }, 0, r);
            }
            for (const e of st.events) { events.push(e.kind); if (e.kind === "kill") kills++; }
            enemyShots += st.shots.filter(x => x.side === "enemy" && x.age === 0).length;
        }
        // They shoot back: the fight is two-sided.
        expect(enemyShots).toBeGreaterThan(0);
        expect(soldiers(st)).toHaveLength(0);
        expect(kills).toBeGreaterThan(0);
        expect(events).toContain("squad-defeated");
    });

    it("hurting civilians is reported against you", () => {
        const st = newStreet(), r = makeRng(8);
        stepStreet(st, null, ctx(), 0.1, r, flat);
        const a = st.actors[0];
        a.x = 0; a.z = 5; a.health = 1;
        playerShoot(st, null, [0, 1.2, 0], [0, 0, 1], { ...weaponById("pistol"), spread: 0 }, 0, r);
        expect(st.events.some(e => e.kind === "civilian-killed" && e.byPlayer)).toBe(true);
    });
});
