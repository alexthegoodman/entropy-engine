// Allegiance's screens, drawn through a stand-in for Entropy.UI: every mode and console tab
// renders, registers the buttons a player needs, routes clicks to game actions, and only
// resubmits to the engine when the picture changed.
import { describe, expect, it } from "vitest";
import { Painter } from "../src/games/allegiance/al_ui";
import { UiFrame, drawScreen, objective, type GameView, type Mode, type ConsoleTab } from "../src/games/allegiance/al_screens";
import { newCampaign } from "../src/games/allegiance/al_state";
import { startSpeech } from "../src/games/allegiance/al_speech";
import { recruitInPerson, autoOrganize } from "../src/games/allegiance/al_party";
import { applySpeech, takeRegion } from "../src/games/allegiance/al_world";
import { newStreet, stepStreet, spawnSquad, takeLoot, playerShoot, soldiers, type StreetContext } from "../src/games/allegiance/al_street";
import { weaponById } from "../src/games/allegiance/al_data";
import { makeRng } from "../src/games/allegiance/al_rng";

function fakeEngine() {
    const log = { clears: 0, rects: 0, texts: 0, strings: [] as string[] };
    const painter = new Painter({
        clear: () => { log.clears++; log.rects = 0; log.texts = 0; log.strings = []; },
        rect: () => { log.rects++; },
        text: o => { log.texts++; log.strings.push(o.s); },
    });
    return { painter, log };
}

function view(mode: Mode, extra: Partial<GameView> = {}): GameView & { acts: [string, unknown][] } {
    const c = newCampaign({ seed: 3, spawn: "london", partyName: "Dawn Front", leader: "Ada" });
    const acts: [string, unknown][] = [];
    return {
        mode, tab: "overview", c, setup: { party: "Dawn Front", leader: "Ada", ideology: "solidarity", color: 0, spawn: "london", focus: null },
        loading: { progress: 0.4, stage: "Mapping the streets", lines: ["Terrain: 10 chunks"], tip: "Speak.", place: "London, Britain", elapsed: 3 },
        speech: null, dialogue: null, toasts: [{ text: "Hello", age: 0, kind: "info" }], region: "london", selectedRegion: "london", selectedMember: null,
        memberPage: 0, prompt: "[E] TALK", street: { civilians: 10, listeners: 0, soldiers: 0, followers: 0, rally: null, rallyTime: 0 },
        weapon: { name: "M-90 Sidearm", mag: 12, reserve: 36, reloading: false, magazine: 12 }, pamphlet: "propaganda", stamina: 1, armor: 0,
        land: { cols: 4, rows: 2, runs: [[0, 1, 2], [1, 0, 3]] }, hasSave: false, time: 0, firstPerson: false, debug: null,
        act: (name, arg) => { acts.push([name, arg]); },
        acts,
        ...extra,
    };
}

function render(g: GameView) {
    const { painter, log } = fakeEngine();
    const ui = new UiFrame(painter, 1600, 900);
    painter.begin();
    drawScreen(g, ui);
    painter.flush();
    return { ui, painter, log, ids: painter.buttons.map(b => b.id) };
}

describe("screens", () => {
    it("title offers a new campaign and a disabled continue without a save", () => {
        const g = view("title");
        const { ids, ui, painter, log } = render(g);
        expect(ids).toContain("title-new");
        expect(log.strings).toContain("ALLEGIANCE");
        const b = painter.buttons.find(x => x.id === "title-new")!;
        ui.click(b.x + 5, b.y + 5);
        expect(g.acts[0][0]).toBe("setup");
        const cont = painter.buttons.find(x => x.id === "title-continue")!;
        expect(cont.disabled).toBe(true);
        expect(ui.click(cont.x + 5, cont.y + 5)).toBeNull();
    });

    it("setup lets you name the party, pick an ideology, a color and a city", () => {
        const { ids } = render(view("setup"));
        for (const id of ["setup-party", "setup-leader", "setup-ideo-order", "setup-color-3", "map-lagos", "setup-begin", "setup-random"]) expect(ids).toContain(id);
    });

    it("loading shows the progress bar and what is streaming", () => {
        const { log } = render(view("loading"));
        expect(log.strings).toContain("40%");
        expect(log.strings.some(s => s.includes("LONDON"))).toBe(true);
    });

    it("the HUD shows the party, the region, gear, the prompt and an objective", () => {
        const g = view("play");
        const { log } = render(g);
        expect(log.strings).toContain("DAWN FRONT");
        expect(log.strings).toContain("LONDON");
        expect(log.strings).toContain("[E] TALK");
        expect(log.strings).toContain("OBJECTIVE");
        expect(log.strings.some(s => s.includes("first speech"))).toBe(true);
    });

    it("the speech overlay draws cards, the timing bar, hecklers and results", () => {
        const s = startSpeech({ region: "london", ideology: "solidarity", oratory: 0, persuasion: 0, crowd: 10, seed: 1 });
        const g = view("speech", { speech: s });
        expect(render(g).ids).toEqual(["card-0", "card-1", "card-2"]);
        s.phase = "deliver";
        expect(render(g).log.strings.some(x => x.includes("PRESS SPACE"))).toBe(true);
        s.phase = "heckle";
        s.heckler = { key: "q", line: "LIAR!", window: 2 };
        expect(render(g).log.strings.some(x => x.includes("PRESS  Q"))).toBe(true);
        s.phase = "done";
        s.result = { score: 0.9, crowd: 20, joined: 5, karma: 2, approval: {}, grades: [], rival: null };
        expect(render(g).ids).toContain("speech-close");
    });

    it("every console tab renders its controls", () => {
        const expectations: Record<ConsoleTab, string[]> = {
            overview: ["posture-field", "dues-up", "rest", "save"],
            organization: ["auto-organize", "members-next"],
            territory: ["act-travel", "act-election", "scheme-charity", "map-paris"],
            armory: ["buy-rifle", "armor-vest", "pamphlet-truth", "facility-press"],
            skills: ["skill-oratory", "skill-intrigue"],
        };
        for (const [tab, ids] of Object.entries(expectations) as [ConsoleTab, string[]][]) {
            const r = render(view("console", { tab }));
            for (const id of ids) expect(r.ids, `${tab}: ${id}`).toContain(id);
            for (const t of ["overview", "organization", "territory", "armory", "skills"]) expect(r.ids).toContain(`tab-${t}`);
        }
    });

    it("organization shows a selected member's posts", () => {
        const g = view("console", { tab: "organization" });
        g.selectedMember = g.c!.members[0].id;
        const { ids } = render(g);
        for (const id of ["appoint-treasurer", "appoint-chief", "appoint-cell", "appoint-commissioner", "appoint-follower"]) expect(ids).toContain(id);
    });

    it("dialogue and the ending render their choices", () => {
        const d = view("dialogue", { dialogue: { actorId: 1, name: "Mara Okafor", segment: "workers", opinion: 0.5, lean: "concordat", member: false, follower: false, orator: false, reply: "Maybe.", recruitChance: 0.4, memberId: null } });
        expect(render(d).ids).toEqual(expect.arrayContaining(["dlg-persuade", "dlg-pamphlet", "dlg-recruit", "dlg-leave"]));
        const o = view("outcome");
        o.c!.outcome = { kind: "victory", title: "PLANETARY LIBERATOR", text: "Free.", day: 300 };
        expect(render(o).ids).toContain("outcome-title");
    });

    it("only resubmits to the engine when the picture changes", () => {
        const g = view("play");
        const { painter, log } = fakeEngine();
        const ui = new UiFrame(painter, 1600, 900);
        for (let i = 0; i < 3; i++) { painter.begin(); drawScreen(g, ui); painter.flush(); }
        expect(log.clears).toBe(1);
        g.prompt = "[E] SOMETHING ELSE";
        painter.begin(); drawScreen(g, ui); painter.flush();
        expect(log.clears).toBe(2);
    });
});

describe("objectives", () => {
    it("walk a new player through speeches, recruiting, officers and taking power", () => {
        const c = newCampaign({ seed: 5, spawn: "london" });
        expect(objective(c, "london")).toContain("speech");
        applySpeech(c, "london", { score: 0.7, crowd: 10, joined: 2, karma: 0 });
        expect(objective(c, "london")).toContain("join");
        for (let i = 0; i < 3; i++) recruitInPerson(c, "london", { name: `R${i}`, charisma: 5, admin: 5, combat: 5 });
        expect(objective(c, "london")).toContain("ORGANIZATION");
        autoOrganize(c);
        expect(objective(c, "london")).toContain("20%");
        expect(objective(c, "cairo")).toContain("coup");
        takeRegion(c, c.regions.london, "election");
        expect(objective(c, "london")).toContain("You govern");
    });
});

describe("militia and loot", () => {
    const ctx = (extra: Partial<StreetContext> = {}): StreetContext => ({
        partyShare: 0.1, rivalShares: { concordat: 0.4 }, atWar: true, heat: 0, enemyQuality: 0.6, followers: [], playerWeapon: "rifle", calm: true, ...extra,
    });

    it("armed members of a region at war fight beside you, and stand down after", () => {
        const st = newStreet(), r = makeRng(1);
        stepStreet(st, null, ctx({ militia: 3 }), 0.1, r, () => 0);
        expect(st.actors.filter(a => a.militia && a.state !== "dead")).toHaveLength(3);
        stepStreet(st, null, ctx({ militia: 0 }), 0.1, r, () => 0);
        expect(st.actors.filter(a => a.militia && a.state !== "dead")).toHaveLength(0);
    });

    it("fallen soldiers drop weapons you can pick up", () => {
        const st = newStreet(), r = makeRng(2);
        let dropped = false;
        for (let tries = 0; tries < 10 && !dropped; tries++) {
            spawnSquad(st, null, ctx(), r, 1, false);
            const s = soldiers(st)[0];
            s.x = 0; s.z = 6; s.health = 1;
            playerShoot(st, null, [0, 1.2, 0], [0, 0, 1], { ...weaponById("rifle"), spread: 0 }, 0, r);
            dropped = st.actors.some(a => a.loot);
        }
        expect(dropped).toBe(true);
        expect(takeLoot(st, 0, 0)).toBeNull();
        const corpse = st.actors.find(a => a.loot)!;
        expect(takeLoot(st, corpse.x, corpse.z)).toBe(corpse.weapon);
        expect(corpse.loot).toBeNull();
    });
});
