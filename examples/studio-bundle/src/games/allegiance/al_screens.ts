// Every screen of Allegiance, drawn with the propaganda UI kit (al_ui.ts) from a GameView - the
// addon implements it; the tests use a stand-in. Buttons call `g.act(name, arg)`.

import {
    ARMORS, BLOCS, FACILITIES, IDEOLOGIES, PAMPHLETS, PARTY, PARTY_COLORS, REGIONS, SCHEMES, SKILLS, SKILL_MAX, TOPICS, WEAPONS,
    factionById, ideologyById, regionDefById, skillCost, weaponById, type RegionDef,
} from "./al_data";
import { type Campaign, dateLabel, karmaTitle, partyShare, totalMembers, strongestRival, INNER_CIRCLE, type Member } from "./al_state";
import {
    ROLE_NAMES, orgReport, holder, maxHealth, xpForLevel, followers, followerLimit, ammoPrice, pamphletPrice, schemeChance,
    schemeCost, hasFacility, ARM_COST, blocOf,
} from "./al_party";
import { controlLevel, coupChance, electionCost, governedShare, travelCost, worldSupport, DAY_SECONDS, VICTORY_SHARE } from "./al_world";
import { BEATS, HECKLE_KEYS, type SpeechState } from "./al_speech";
import { opinionLabel } from "./al_street";
import { type ButtonOpts, type ButtonStyle, type Color, type Painter, FONT, THEME, big, fmt, money, pct, textWidth, withAlpha } from "./al_ui";

export type Mode = "title" | "setup" | "loading" | "play" | "console" | "speech" | "dialogue" | "outcome";
export type ConsoleTab = "overview" | "organization" | "territory" | "armory" | "skills";

export interface SetupState {
    party: string;
    leader: string;
    ideology: string;
    color: number;
    spawn: string | null;
    focus: "party" | "leader" | null;
}

export interface LoadingInfo {
    progress: number;
    stage: string;
    lines: string[];
    tip: string;
    place: string;
    elapsed: number;
}

export interface DialogueState {
    actorId: number;
    name: string;
    segment: string;
    opinion: number;
    lean: string;
    member: boolean;
    follower: boolean;
    orator: boolean;
    reply: string;
    recruitChance: number;
    memberId: number | null;
}

/** Land cells of the world map: runs of land in rows of a grid over lon -180..180, lat 72..-58. */
export interface LandRuns { cols: number; rows: number; runs: [number, number, number][] }
export const MAP_LAT_TOP = 72;
export const MAP_LAT_BOTTOM = -58;

export interface GameView {
    mode: Mode;
    tab: ConsoleTab;
    c: Campaign | null;
    setup: SetupState;
    loading: LoadingInfo;
    speech: SpeechState | null;
    dialogue: DialogueState | null;
    toasts: { text: string; age: number; kind: "good" | "bad" | "info" }[];
    region: string | null;
    selectedRegion: string | null;
    selectedMember: number | null;
    memberPage: number;
    prompt: string | null;
    street: { civilians: number; listeners: number; soldiers: number; followers: number; rally: string | null; rallyTime: number };
    weapon: { name: string; mag: number; reserve: number; reloading: boolean; magazine: number };
    pamphlet: string;
    stamina: number;
    armor: number;
    land: LandRuns | null;
    hasSave: boolean;
    time: number;
    firstPerson: boolean;
    debug: string | null;
    act(name: string, arg?: unknown): void;
}

/** A Painter plus click handlers for the buttons drawn this frame. */
export class UiFrame {
    handlers = new Map<string, () => void>();
    constructor(public p: Painter, public W: number, public H: number) {}
    button(id: string, x: number, y: number, w: number, h: number, label: string, style: ButtonStyle, onClick: () => void, opts: ButtonOpts = {}): void {
        this.p.button(id, x, y, w, h, label, style, opts);
        this.handlers.set(id, onClick);
    }
    /** An invisible click area (map dots, list rows). */
    hotspot(id: string, x: number, y: number, w: number, h: number, onClick: () => void): void {
        this.p.hotspot(id, x, y, w, h);
        this.handlers.set(id, onClick);
    }
    click(x: number, y: number): string | null {
        const b = this.p.hit(x, y);
        if (!b) return null;
        this.handlers.get(b.id)?.();
        return b.id;
    }
}

const partyColor = (c: Campaign | null): Color => (c ? c.party.color : THEME.red);
const factionColor = (c: Campaign | null, id: string): Color => (id === PARTY ? partyColor(c) : factionById(id).color);
const factionName = (c: Campaign | null, id: string): string => (id === PARTY ? (c?.party.name ?? "Party") : factionById(id).name);

// --- Shared pieces -------------------------------------------------------------------------------

function backdrop(ui: UiFrame, alpha = 0.78): void {
    ui.p.rect(0, 0, ui.W, ui.H, [0.04, 0.03, 0.03, alpha]);
}

/** The red poster frame with corner stars. */
function posterFrame(ui: UiFrame, x: number, y: number, w: number, h: number): void {
    const p = ui.p;
    p.rect(x, y, w, h, [0.92, 0.86, 0.72, 0.97], 4, THEME.black);
    p.rect(x + 10, y + 10, w - 20, h - 20, THEME.clear, 2, THEME.red);
}

function worldMap(ui: UiFrame, g: GameView, x: number, y: number, w: number, h: number, pick: ((id: string) => void) | null, selected: string | null): void {
    const p = ui.p;
    p.rect(x, y, w, h, [0.1, 0.16, 0.22, 1], 3, THEME.black);
    const land = g.land;
    if (land) {
        const cw = w / land.cols, ch = h / land.rows;
        for (const [row, a, b] of land.runs) p.rect(x + a * cw, y + row * ch, (b - a + 1) * cw, ch + 0.5, [0.78, 0.72, 0.58, 1]);
    }
    const toXY = (lat: number, lon: number): [number, number] => [x + (lon + 180) / 360 * w, y + (MAP_LAT_TOP - lat) / (MAP_LAT_TOP - MAP_LAT_BOTTOM) * h];
    const c = g.c;
    for (const r of REGIONS) {
        const [px, py] = toXY(r.lat, r.lon);
        if (py < y || py > y + h) continue;
        const s = 3 + Math.sqrt(r.pop) * 0.45;
        const rs = c?.regions[r.id];
        const col = rs ? factionColor(c, rs.governor) : [0.2, 0.2, 0.2, 1] as Color;
        const lvl = rs ? controlLevel(rs) : "none";
        if (lvl === "stronghold" || lvl === "presence") p.rect(px - s / 2 - 2, py - s / 2 - 2, s + 4, s + 4, partyColor(c));
        p.rect(px - s / 2, py - s / 2, s, s, col, 1, THEME.black);
        if (rs?.war) p.rect(px - 1.5, py - s / 2 - 8, 3, 6, THEME.gold);
        if (r.id === selected) p.rect(px - s / 2 - 5, py - s / 2 - 5, s + 10, s + 10, THEME.clear, 2, THEME.gold);
        if (r.id === g.region) p.rect(px - 2, py - 2, 4, 4, THEME.cream);
        if (pick) ui.hotspot(`map-${r.id}`, px - Math.max(7, s), py - Math.max(7, s), Math.max(14, s * 2), Math.max(14, s * 2), () => pick(r.id));
    }
}

// --- Title ---------------------------------------------------------------------------------------

export function drawTitle(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    p.rect(0, 0, W, H * 0.16, [0.04, 0.03, 0.03, 0.85]);
    p.rect(0, H * 0.16, W, 6, THEME.red);
    p.rect(0, H - 70, W, 70, [0.04, 0.03, 0.03, 0.85]);
    const cx = W / 2;
    // The banner.
    const bw = Math.min(980, W - 80), bx = cx - bw / 2, by = H * 0.24;
    p.rect(bx, by, bw, 170, THEME.red, 5, THEME.black);
    p.rect(bx + 14, by + 14, bw - 28, 142, THEME.clear, 2, THEME.cream);
    p.textC("ALLEGIANCE", cx, by + 30, 84, THEME.cream, FONT.head);
    p.stars(cx - 7 * 16 * 1.6 / 2, by + 132, 7, 16);
    p.textC("EARTH  -  ANNO 2100", cx, H * 0.06, 26, THEME.gold, FONT.head);
    p.textC("SPEAK. ORGANIZE. SEIZE THE PLANET.", cx, by + 200, 22, THEME.cream, FONT.head);
    const bw2 = 340, x0 = cx - bw2 / 2;
    let y = by + 260;
    ui.button("title-new", x0, y, bw2, 58, "NEW CAMPAIGN", "red", () => g.act("setup"), { size: 22 });
    y += 72;
    ui.button("title-continue", x0, y, bw2, 50, "CONTINUE", "dark", () => g.act("continue"), { disabled: !g.hasSave, size: 18 });
    p.textC("Elevation: Terrain Tiles (SRTM, GMTED, ETOPO1). Map data (c) OpenStreetMap contributors (OpenFreeMap).", cx, H - 44, 13, THEME.dim, FONT.body);
}

// --- Setup ---------------------------------------------------------------------------------------

export function drawSetup(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const s = g.setup;
    backdrop(ui, 0.86);
    p.slab(0, 0, W, "FOUND YOUR PARTY", 24);
    const lx = 40, colW = Math.min(560, W * 0.38);
    let y = 80;
    const field = (id: "party" | "leader", label: string, value: string) => {
        p.text(label, lx, y, 14, THEME.gold, FONT.head);
        y += 24;
        const on = s.focus === id;
        ui.button(`setup-${id}`, lx, y, colW, 44, "", "paper", () => g.act("setup-focus", id), { active: false });
        const caret = on && Math.floor(g.time * 2) % 2 === 0 ? "_" : "";
        p.text((value || (on ? "" : "click to type")) + caret, lx + 12, y + 8, 22, value ? THEME.black : THEME.grey, FONT.head, colW - 24);
        if (on) p.rect(lx - 3, y - 3, colW + 6, 50, THEME.clear, 3, THEME.red);
        y += 58;
    };
    field("party", "PARTY NAME", s.party);
    field("leader", "YOUR NAME", s.leader);
    p.text("IDEOLOGY", lx, y, 14, THEME.gold, FONT.head);
    y += 24;
    const iw = (colW - 18) / 4;
    IDEOLOGIES.forEach((ideo, i) => {
        ui.button(`setup-ideo-${ideo.id}`, lx + i * (iw + 6), y, iw, 40, ideo.name.toUpperCase(), "dark", () => g.act("setup-ideology", ideo.id), { active: s.ideology === ideo.id, size: 12 });
    });
    y += 50;
    const ideo = ideologyById(s.ideology);
    p.text(ideo.slogan, lx, y, 18, THEME.red, FONT.head);
    y += 28;
    p.text(ideo.blurb, lx, y, 15, THEME.cream, FONT.body, colW, 48);
    y += 46;
    const strong = ideo.strong.map(t => TOPICS.find(x => x.id === t)!.name).join(", "), weak = ideo.weak.map(t => TOPICS.find(x => x.id === t)!.name).join(", ");
    p.text(`Strong on ${strong}. Weak on ${weak}.`, lx, y, 14, THEME.dim, FONT.body, colW);
    y += 34;
    p.text("PARTY COLOR", lx, y, 14, THEME.gold, FONT.head);
    y += 24;
    PARTY_COLORS.forEach((pc, i) => {
        const sx = lx + i * 58;
        p.rect(sx, y, 48, 36, pc.color, s.color === i ? 4 : 2, s.color === i ? THEME.gold : THEME.black);
        ui.hotspot(`setup-color-${i}`, sx, y, 48, 36, () => g.act("setup-color", i));
    });
    y += 56;
    // Spawn.
    const mx = lx + colW + 40, mw = W - mx - 40, mh = Math.min(mw / 2.77, H - 260);
    p.text("CHOOSE WHERE YOU BEGIN", mx, 80, 14, THEME.gold, FONT.head);
    worldMap(ui, g, mx, 104, mw, mh, id => g.act("setup-spawn", id), s.spawn);
    const sy = 104 + mh + 16;
    const def = s.spawn ? regionDefById(s.spawn) : null;
    if (def) {
        const bloc = BLOCS.find(b => b.id === def.bloc)!;
        p.text(def.name.toUpperCase(), mx, sy, 26, THEME.cream, FONT.head);
        p.text(`${def.country}  -  ${bloc.name}  -  ${def.pop}M people  -  wealth ${def.wealth.toFixed(1)}x`, mx, sy + 38, 15, THEME.dim, FONT.body, mw);
        const gov = g.c?.regions[def.id]?.gov ?? def.gov ?? bloc.gov;
        p.text(`Government: ${gov.toUpperCase()}. ${gov === "democracy" ? "Win it at the ballot box." : "No elections here: a coup or a war."}`, mx, sy + 62, 15, THEME.cream, FONT.body, mw);
    } else {
        p.text("Click a city on the map. Every point on Earth belongs to its nearest city.", mx, sy, 15, THEME.dim, FONT.body, mw);
    }
    ui.button("setup-random", mx, H - 80, 200, 50, "RANDOM CITY", "dark", () => g.act("setup-random"));
    ui.button("setup-back", lx, H - 80, 160, 50, "BACK", "ghost", () => g.act("title"));
    const ready = !!s.spawn;
    ui.button("setup-begin", W - 300, H - 86, 260, 62, "BEGIN", "red", () => g.act("begin"), { disabled: !ready, size: 24 });
}

// --- Loading -------------------------------------------------------------------------------------

export function drawLoading(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const L = g.loading;
    p.rect(0, 0, W, H, [0.06, 0.04, 0.04, 0.94]);
    const pw = Math.min(900, W - 80), ph = Math.min(560, H - 80), px = (W - pw) / 2, py = (H - ph) / 2;
    posterFrame(ui, px, py, pw, ph);
    p.rect(px + 24, py + 24, pw - 48, 96, THEME.red);
    p.textC("ALLEGIANCE", W / 2, py + 34, 46, THEME.cream, FONT.head);
    p.textC(`DESTINATION: ${L.place.toUpperCase()}`, W / 2, py + 88, 16, THEME.gold, FONT.head);
    let y = py + 150;
    p.text(L.stage.toUpperCase(), px + 40, y, 18, THEME.black, FONT.head);
    y += 34;
    p.bar(px + 40, y, pw - 80, 34, L.progress, THEME.red, [0.1, 0.08, 0.08, 0.9]);
    p.textC(`${Math.round(L.progress * 100)}%`, W / 2, y + 4, 20, THEME.cream, FONT.head);
    y += 54;
    for (const line of L.lines) { p.text(line, px + 40, y, 15, THEME.black, FONT.mono, pw - 80); y += 24; }
    p.rect(px + 40, py + ph - 120, pw - 80, 2, THEME.black);
    p.text("COMRADE'S HANDBOOK", px + 40, py + ph - 108, 13, THEME.red, FONT.head);
    p.text(L.tip, px + 40, py + ph - 84, 16, THEME.black, FONT.body, pw - 80, 60);
    p.textR(`${L.elapsed.toFixed(0)} s`, px + pw - 40, py + ph - 108, 13, THEME.grey, FONT.mono);
}

export const LOADING_TIPS = [
    "A speech is five beats. Read the crowd: workers want Jobs and anger, elders want Security and fear, students want Liberty and hope.",
    "Answer a rival orator's topic with the same topic to tear their argument apart in front of the crowd.",
    "Members nobody organizes drift away. Appoint Region Chiefs and Cell Leaders before the party outgrows you.",
    "Democracies can be won with votes. Juntas and oligarchies need a coup or a war.",
    "A coup needs no majority - but minority rule breeds unrest, and unrest breeds insurgents.",
    "Every soldier you drop in a street battle stands for a whole platoon in the region's war.",
    "Kindness wins donations and loyalty. Fear wins obedience. Both can win the planet.",
    "Lead from inside for better schemes and dues; lead from the field and your troops fight harder.",
    "Pamphlets cost little. The Printing Press makes them cheaper and stronger.",
];

// --- HUD -----------------------------------------------------------------------------------------

export function drawHud(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c;
    if (!c) return;
    // Top-left: the party.
    const tw = 430;
    p.rect(0, 0, tw, 92, [0.04, 0.035, 0.035, 0.86]);
    p.rect(0, 92, tw, 4, partyColor(c));
    p.text(c.party.name.toUpperCase(), 14, 8, 20, THEME.cream, FONT.head, tw - 20);
    p.text(`${dateLabel(c.day)}  ${clockLabel(c.dayClock)}`, 14, 40, 15, THEME.gold, FONT.head);
    p.text(money(c.party.funds), 14, 64, 18, c.party.funds < 0 ? THEME.red : THEME.cream, FONT.num);
    p.text(`${big(totalMembers(c))} MEMBERS`, 150, 64, 18, THEME.cream, FONT.num);
    p.text(`WORLD ${pct(worldSupport(c), 2)}`, 290, 64, 18, THEME.cream, FONT.num);
    p.textR(karmaTitle(c.party.karma), tw - 12, 40, 13, c.party.karma >= 0 ? THEME.green : THEME.red, FONT.head);
    // Top-right: where you are.
    const def = g.region ? regionDefById(g.region) : null;
    if (def) {
        const rs = c.regions[def.id];
        const rw = 360, rx = W - rw;
        p.rect(rx, 0, rw, 132, [0.04, 0.035, 0.035, 0.86]);
        p.rect(rx, 132, rw, 4, factionColor(c, rs.governor));
        p.text(def.name.toUpperCase(), rx + 14, 8, 20, THEME.cream, FONT.head, rw - 20);
        p.text(`${def.country} - ${BLOCS.find(b => b.id === def.bloc)!.short} - ${rs.gov.toUpperCase()}`, rx + 14, 38, 13, THEME.dim, FONT.body, rw - 20);
        p.text(`RULED BY ${factionName(c, rs.governor).toUpperCase()}`, rx + 14, 58, 13, factionColor(c, rs.governor), FONT.head, rw - 20);
        const share = partyShare(rs);
        p.text(`PARTY ${pct(share)}`, rx + 14, 80, 15, THEME.cream, FONT.num);
        p.bar(rx + 110, 84, rw - 124, 12, share, partyColor(c));
        const rival = strongestRival(rs);
        p.text(`${factionById(rival).short} ${pct(rs.support[rival] ?? 0)}`, rx + 14, 102, 15, THEME.dim, FONT.num);
        p.bar(rx + 110, 106, rw - 124, 12, rs.support[rival] ?? 0, factionById(rival).color);
        let ty = 142;
        if (rs.war) {
            p.rect(rx, ty, rw, 30, THEME.red);
            p.text(`WAR  ${fmt(rs.army)} vs ${fmt(rs.garrison)}`, rx + 12, ty + 6, 15, THEME.cream, FONT.head);
            ty += 34;
        }
        if (rs.heat > 0.4 && rs.governor !== PARTY) {
            p.rect(rx, ty, rw, 24, [0.3, 0.05, 0.05, 0.85]);
            p.text(`REGIME HEAT ${Math.round(rs.heat * 100)}%`, rx + 12, ty + 4, 13, THEME.gold, FONT.head);
            ty += 28;
        }
        if (g.street.rally) {
            p.rect(rx, ty, rw, 44, [0.1, 0.1, 0.1, 0.85], 2, THEME.gold);
            p.text(`RIVAL RALLY: ${g.street.rally}`, rx + 12, ty + 4, 13, THEME.gold, FONT.head, rw - 20);
            p.text(`${Math.ceil(g.street.rallyTime)} s - find them and press E to debate`, rx + 12, ty + 24, 12, THEME.cream, FONT.body, rw - 20);
        }
    }
    // Bottom-left: body and gear.
    const by = H - 118;
    p.rect(0, by, 380, 118, [0.04, 0.035, 0.035, 0.86]);
    p.rect(0, by - 4, 380, 4, THEME.red);
    p.text("HEALTH", 14, by + 10, 11, THEME.dim, FONT.head);
    p.bar(90, by + 10, 270, 14, c.player.health / maxHealth(c), [0.8, 0.15, 0.12, 1]);
    p.text("ARMOR", 14, by + 30, 11, THEME.dim, FONT.head);
    p.bar(90, by + 30, 270, 10, g.armor, [0.5, 0.65, 0.85, 1]);
    p.text("STAMINA", 14, by + 46, 11, THEME.dim, FONT.head);
    p.bar(90, by + 47, 270, 8, g.stamina, THEME.gold);
    const w = g.weapon;
    p.text(w.name.toUpperCase(), 14, by + 64, 16, THEME.cream, FONT.head, 240);
    if (Number.isFinite(w.magazine)) p.textR(w.reloading ? "RELOADING" : `${w.mag} / ${w.reserve}`, 366, by + 64, 20, w.mag === 0 ? THEME.red : THEME.cream, FONT.num);
    const pam = PAMPHLETS.find(x => x.id === g.pamphlet)!;
    p.text(`PAMPHLETS: ${pam.name.toUpperCase()} x${c.player.pamphlets[pam.id] ?? 0}`, 14, by + 92, 12, THEME.gold, FONT.head, 360);
    // Followers.
    if (g.street.followers) p.text(`FOLLOWERS ${g.street.followers}/${followerLimit(c)}`, 14, by - 26, 13, THEME.cream, FONT.head);
    // Crosshair.
    const cx = W / 2, cy = H / 2;
    p.rect(cx - 12, cy - 1, 8, 2, THEME.cream);
    p.rect(cx + 4, cy - 1, 8, 2, THEME.cream);
    p.rect(cx - 1, cy - 12, 2, 8, THEME.cream);
    p.rect(cx - 1, cy + 4, 2, 8, THEME.cream);
    // Prompt.
    if (g.prompt) {
        const tw2 = Math.min(W - 40, textWidth(g.prompt, 17, FONT.head) + 40);
        p.rect(cx - tw2 / 2, H - 190, tw2, 40, THEME.black, 2, THEME.gold);
        p.textC(g.prompt, cx, H - 182, 17, THEME.cream, FONT.head);
    }
    // News ticker.
    const news = c.news[0];
    if (news) {
        const nx = 400, nw = W - 420;
        p.rect(nx, H - 40, nw, 32, [0.04, 0.035, 0.035, 0.86]);
        p.rect(nx, H - 40, 110, 32, news.kind === "bad" || news.kind === "war" ? THEME.red : THEME.gold);
        p.text(news.kind === "war" ? "WAR" : news.kind === "bad" ? "ALERT" : "BULLETIN", nx + 8, H - 34, 14, THEME.black, FONT.head);
        p.text(news.text, nx + 122, H - 34, 15, THEME.cream, FONT.body, nw - 130, 28);
    }
    // Toasts.
    let ty = 110;
    for (const t of g.toasts.slice(0, 4)) {
        const tw3 = Math.min(W * 0.5, textWidth(t.text, 16, FONT.body) + 40);
        p.rect(cx - tw3 / 2, ty, tw3, 34, t.kind === "bad" ? withAlpha(THEME.redDark, 0.9) : t.kind === "good" ? [0.1, 0.25, 0.12, 0.9] : [0.05, 0.05, 0.05, 0.85], 2, THEME.gold);
        p.textC(t.text, cx, ty + 7, 16, THEME.cream, FONT.body);
        ty += 40;
    }
    // Controls hint and org warnings.
    const report = orgReport(c);
    const hint = `WASD MOVE  SHIFT RUN  RMB LOOK  LMB SHOOT  E TALK  F PAMPHLET  B SPEECH  TAB COMMAND${report.warnings.length ? `  (${report.warnings.length} ORG ALERTS)` : ""}`;
    p.text(hint, 440, 8, 12, report.warnings.length ? THEME.gold : THEME.dim, FONT.head, W - 440 - 380);
    if (g.debug) p.text(g.debug, 440, 30, 12, THEME.dim, FONT.mono, W - 840);
}

export function clockLabel(dayClock: number): string {
    const minutes = Math.floor(7 * 60 + (dayClock / DAY_SECONDS) * 12 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// --- Speech --------------------------------------------------------------------------------------

const TONE_COLOR: Record<string, Color> = { hope: [0.95, 0.8, 0.25, 1], anger: [0.85, 0.12, 0.12, 1], fear: [0.45, 0.35, 0.6, 1] };

export function drawSpeech(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const s = g.speech;
    if (!s) return;
    // Top: beat counter and the crowd.
    p.rect(0, 0, W, 64, [0.04, 0.035, 0.035, 0.88]);
    p.rect(0, 64, W, 4, THEME.red);
    p.text("THE SPEECH", 20, 14, 26, THEME.cream, FONT.head);
    for (let i = 0; i < BEATS; i++) {
        const done = i < s.grades.length;
        const g2 = s.grades[i];
        p.rect(250 + i * 46, 18, 38, 28, done ? (g2 === "perfect" ? THEME.gold : g2 === "good" ? THEME.green : g2 === "weak" ? THEME.grey : THEME.red) : i === s.beat ? THEME.cream : [0.2, 0.2, 0.2, 1], 2, THEME.black);
    }
    p.text(`CROWD ${s.crowd}`, 500, 16, 24, THEME.cream, FONT.num);
    p.text(`FERVOR`, 640, 12, 11, THEME.dim, FONT.head);
    p.bar(640, 30, 200, 16, s.fervor, THEME.red);
    if (s.combo > 1) p.text(`COMBO x${s.combo}`, 860, 18, 20, THEME.gold, FONT.head);
    if (s.rival) {
        p.rect(W - 380, 0, 380, 64, [0.15, 0.12, 0.05, 0.9]);
        p.text(`VS ${s.rival.name.toUpperCase()}`, W - 368, 8, 16, factionById(s.rival.faction).color, FONT.head, 360);
        p.text(`Next they argue: ${s.rival.topic.toUpperCase()}`, W - 368, 34, 15, THEME.cream, FONT.body, 360);
    }
    // Right: segments.
    const sx = W - 300;
    let sy = 90;
    p.rect(sx - 10, sy - 10, 300, 30 + s.segments.length * 44, [0.04, 0.035, 0.035, 0.8]);
    for (const seg of s.segments) {
        p.text(`${seg.name.toUpperCase()} ${Math.round(seg.share * 100)}%`, sx, sy, 12, THEME.cream, FONT.head);
        const v = (seg.approval + 1) / 2;
        p.bar(sx, sy + 18, 270, 12, v, seg.approval >= 0 ? partyColor(g.c) : [0.35, 0.35, 0.35, 1]);
        p.rect(sx + 135, sy + 16, 2, 16, THEME.cream);
        if (s.rival) p.rect(sx + 1 + 268 * (seg.rival + 1) / 2 - 1, sy + 31, 3, 6, factionById(s.rival.faction).color);
        sy += 44;
    }
    // Log.
    let ly = 90;
    p.rect(10, ly - 10, 520, 30 + Math.min(5, s.log.length) * 26, [0.04, 0.035, 0.035, 0.8]);
    for (const line of s.log.slice(0, 5)) { p.text(line, 22, ly, 15, ly === 90 ? THEME.cream : THEME.dim, FONT.body, 500); ly += 26; }
    // Bottom: the cards, the delivery bar or the heckler.
    if (s.phase === "choose") {
        const cw = Math.min(330, (W - 120) / 3), ch = 210, total = cw * 3 + 40, x0 = (W - total) / 2, y0 = H - ch - 40;
        p.textC("CHOOSE YOUR NEXT LINE  [1] [2] [3]", W / 2, y0 - 40, 18, THEME.cream, FONT.head);
        s.hand.forEach((card, i) => {
            const x = x0 + i * (cw + 20);
            const id = `card-${i}`;
            const hot = g.mode === "speech" && p.hover === id;
            p.rect(x, y0, cw, ch, hot ? [1, 0.96, 0.86, 1] : THEME.paper, 4, THEME.black);
            p.rect(x, y0, cw, 42, TONE_COLOR[card.tone]);
            p.text(`${i + 1}  ${TOPICS.find(t => t.id === card.topic)!.name.toUpperCase()}`, x + 12, y0 + 9, 18, card.tone === "hope" ? THEME.black : THEME.cream, FONT.head);
            p.textR(card.tone.toUpperCase(), x + cw - 12, y0 + 12, 13, card.tone === "hope" ? THEME.black : THEME.cream, FONT.head);
            p.text(card.title.toUpperCase(), x + 12, y0 + 54, 16, THEME.red, FONT.head, cw - 24, 44);
            p.text(`"${card.line}"`, x + 12, y0 + 100, 15, THEME.black, FONT.body, cw - 24, 80);
            p.text(`POWER ${card.power.toFixed(1)}${s.usedTopics.includes(card.topic) ? "  - REPEATED" : ""}${s.rival && s.rival.topic === card.topic ? "  - REBUTS!" : ""}`, x + 12, y0 + ch - 26, 12, THEME.grey, FONT.head);
            ui.hotspot(id, x, y0, cw, ch, () => g.act("speech-card", i));
        });
        p.text(`${Math.max(0, Math.ceil(9 - s.phaseTime))}`, W / 2 - 8, H - 34, 20, THEME.gold, FONT.num);
    } else if (s.phase === "deliver" && s.hand) {
        const bw = Math.min(900, W - 200), bx = (W - bw) / 2, by = H - 150;
        p.textC("DELIVER IT!  PRESS SPACE IN THE GOLD", W / 2, by - 50, 20, THEME.cream, FONT.head);
        p.rect(bx - 6, by - 6, bw + 12, 56, THEME.black);
        p.rect(bx, by, bw, 44, [0.25, 0.2, 0.18, 1]);
        p.rect(bx + (s.sweet - s.sweetHalf) * bw, by, s.sweetHalf * 2 * bw, 44, [0.85, 0.65, 0.15, 1]);
        p.rect(bx + (s.sweet - s.sweetHalf * 0.35) * bw, by, s.sweetHalf * 0.7 * bw, 44, [1, 0.92, 0.5, 1]);
        p.rect(bx + s.marker * bw - 4, by - 10, 8, 64, THEME.red, 2, THEME.cream);
    } else if (s.phase === "heckle" && s.heckler) {
        const hw = 560, hx = (W - hw) / 2, hy = H - 230;
        p.rect(hx, hy, hw, 170, THEME.red, 5, THEME.black);
        p.textC(`HECKLER: "${s.heckler.line}"`, W / 2, hy + 18, 18, THEME.cream, FONT.head);
        p.textC(`PRESS  ${s.heckler.key.toUpperCase()}  TO REBUT`, W / 2, hy + 60, 30, THEME.gold, FONT.head);
        p.bar(hx + 40, hy + 120, hw - 80, 16, 1 - s.phaseTime / s.heckler.window, THEME.gold);
        void HECKLE_KEYS;
    } else if (s.phase === "react" && s.lastGrade) {
        p.textC(s.lastGrade.toUpperCase() + "!", W / 2, H - 170, 54, s.lastGrade === "perfect" ? THEME.gold : s.lastGrade === "good" ? THEME.green : s.lastGrade === "weak" ? THEME.cream : THEME.red, FONT.head);
    } else if (s.phase === "done" && s.result) {
        const r = s.result;
        const pw = 640, ph = 260, px = (W - pw) / 2, py = H - ph - 40;
        posterFrame(ui, px, py, pw, ph);
        p.textC(r.score >= 0.8 ? "TRIUMPH" : r.score >= 0.6 ? "WELL SPOKEN" : r.score >= 0.45 ? "POLITE APPLAUSE" : "THEY WALKED AWAY", W / 2, py + 26, 34, THEME.red, FONT.head);
        p.textC(`SCORE ${Math.round(r.score * 100)}   CROWD ${r.crowd}   JOINED ${r.joined}`, W / 2, py + 82, 22, THEME.black, FONT.head);
        if (r.rival) p.textC(r.rival.won ? `You out-argued ${s.rival?.name ?? "the rival"}.` : `${s.rival?.name ?? "The rival"} won the crowd.`, W / 2, py + 120, 18, r.rival.won ? THEME.black : THEME.red, FONT.body);
        p.textC(r.karma > 0 ? "Hope spreads. (+karma)" : r.karma < 0 ? "Fear takes root. (-karma)" : "", W / 2, py + 150, 15, THEME.grey, FONT.body);
        ui.button("speech-close", W / 2 - 120, py + ph - 70, 240, 48, "STEP DOWN", "red", () => g.act("speech-close"));
    }
}

// --- Street dialogue -----------------------------------------------------------------------------

export function drawDialogue(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const d = g.dialogue;
    const c = g.c;
    if (!d || !c) return;
    const pw = 560, ph = 300, px = W / 2 - pw / 2, py = H - ph - 60;
    posterFrame(ui, px, py, pw, ph);
    p.text(d.name.toUpperCase(), px + 30, py + 26, 24, THEME.black, FONT.head, pw - 60);
    const seg = d.segment[0].toUpperCase() + d.segment.slice(1);
    p.text(d.orator ? `Orator for ${factionById(d.lean).name}` : `${seg.replace(/s$/, "")}${d.member ? " - PARTY MEMBER" : ""} - leans ${factionById(d.lean).short}`, px + 30, py + 62, 14, THEME.grey, FONT.body, pw - 60);
    if (!d.orator) {
        p.text(opinionLabel(d.opinion), px + 30, py + 88, 14, d.opinion >= 0.15 ? THEME.red : THEME.black, FONT.head);
        p.bar(px + 180, py + 90, pw - 210, 14, (d.opinion + 1) / 2, partyColor(c), [0.3, 0.3, 0.3, 1]);
    }
    p.text(`"${d.reply}"`, px + 30, py + 118, 16, THEME.black, FONT.body, pw - 60, 60);
    const bw = (pw - 70) / 2;
    let y = py + 186;
    const opts: [string, string, boolean][] = d.orator
        ? [["dlg-debate", "1  CHALLENGE TO DEBATE", true], ["dlg-leave", "ESC  WALK AWAY", true]]
        : d.member
            ? [["dlg-follow", d.follower ? "1  STAY HERE" : "1  FOLLOW ME", true], ["dlg-pamphlet", "2  GIVE PAMPHLETS", true], ["dlg-leave", "ESC  GOODBYE", true]]
            : [["dlg-persuade", "1  PERSUADE", true], ["dlg-pamphlet", "2  GIVE PAMPHLET", (c.player.pamphlets[g.pamphlet] ?? 0) > 0],
                ["dlg-recruit", `3  JOIN US (${Math.round(d.recruitChance * 100)}%)`, d.recruitChance > 0], ["dlg-leave", "ESC  GOODBYE", true]];
    opts.forEach(([id, label, enabled], i) => {
        const x = px + 25 + (i % 2) * (bw + 20);
        ui.button(id, x, y + Math.floor(i / 2) * 50, bw, 42, label, i === opts.length - 1 ? "ghost" : "dark", () => g.act(id), { disabled: !enabled, size: 13 });
    });
}

// --- Command console -----------------------------------------------------------------------------

const TABS: [ConsoleTab, string][] = [["overview", "OVERVIEW"], ["organization", "ORGANIZATION"], ["territory", "TERRITORY"], ["armory", "ARMORY"], ["skills", "SKILLS"]];

export function drawConsole(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c;
    if (!c) return;
    p.rect(0, 0, W, H, [0.07, 0.05, 0.05, 0.94]);
    p.rect(0, 0, W, 64, THEME.black);
    p.rect(0, 64, W, 5, partyColor(c));
    p.text(`${c.party.name.toUpperCase()}  -  COMMAND`, 20, 16, 24, THEME.cream, FONT.head);
    const tw = 170;
    TABS.forEach(([id, label], i) => ui.button(`tab-${id}`, W - (TABS.length - i) * (tw + 6) - 10, 12, tw, 42, label, "dark", () => g.act("tab", id), { active: g.tab === id, size: 13 }));
    ui.button("console-close", W - 60, H - 60, 44, 44, "X", "red", () => g.act("close-console"));
    const top = 90;
    switch (g.tab) {
        case "overview": drawOverview(g, ui, c, top); break;
        case "organization": drawOrganization(g, ui, c, top); break;
        case "territory": drawTerritory(g, ui, c, top); break;
        case "armory": drawArmory(g, ui, c, top); break;
        case "skills": drawSkills(g, ui, c, top); break;
    }
}

function drawOverview(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const col = (W - 60) / 3;
    let x = 20, y = top;
    p.text("THE PARTY", x, y, 16, THEME.gold, FONT.head);
    y += 30;
    const ideo = ideologyById(c.party.ideology);
    const rows: [string, string][] = [
        ["Leader", c.party.leader], ["Ideology", `${ideo.name} - ${ideo.slogan}`], ["Date", `${dateLabel(c.day)} (day ${c.day})`],
        ["Funds", money(c.party.funds)], ["Members", fmt(totalMembers(c))], ["Named members", fmt(c.members.length)],
        ["World support", pct(worldSupport(c), 2)], ["Humanity governed", `${pct(governedShare(c))} of ${pct(VICTORY_SHARE, 0)} needed`],
        ["Reputation", `${karmaTitle(c.party.karma)} (${Math.round(c.party.karma)})`], ["Level", `${c.party.level} (${fmt(c.party.xp)}/${fmt(xpForLevel(c.party.level))} XP)`],
        ["Headquarters", regionDefById(c.party.hq)?.name ?? c.party.hq],
        ["Outlawed", c.outlawedDay ? `since day ${c.outlawedDay}` : "not yet"],
    ];
    for (const [k, v] of rows) { p.text(k.toUpperCase(), x, y, 12, THEME.dim, FONT.head); p.text(v, x + 170, y - 2, 15, THEME.cream, FONT.body, col - 180); y += 26; }
    y += 10;
    p.text("LEADERSHIP POSTURE", x, y, 13, THEME.gold, FONT.head);
    y += 24;
    (["inside", "mixed", "field"] as const).forEach((ps, i) => ui.button(`posture-${ps}`, x + i * 125, y, 118, 38, ps.toUpperCase(), "dark", () => g.act("posture", ps), { active: c.party.posture === ps, size: 12 }));
    y += 46;
    p.text(c.party.posture === "inside" ? "From headquarters: schemes and dues improve." : c.party.posture === "field" ? "At the front: your troops fight harder when you are there." : "Half and half.", x, y, 13, THEME.dim, FONT.body, col);
    y += 34;
    p.text(`DUES ${c.party.duesRate.toFixed(2)} CR / MEMBER / DAY`, x, y, 13, THEME.gold, FONT.head);
    ui.button("dues-down", x + 280, y - 6, 36, 30, "-", "dark", () => g.act("dues", -0.05));
    ui.button("dues-up", x + 322, y - 6, 36, 30, "+", "dark", () => g.act("dues", 0.05));
    y += 40;
    ui.button("rest", x, y, 260, 46, "REST UNTIL TOMORROW", "red", () => g.act("rest"), { size: 14 });
    ui.button("save", x + 270, y, 120, 46, "SAVE", "dark", () => g.act("save"), { size: 14 });
    // Ledger.
    x = 40 + col;
    y = top;
    p.text("YESTERDAY'S LEDGER", x, y, 16, THEME.gold, FONT.head);
    y += 30;
    const l = c.ledger;
    const ledger: [string, number][] = [["Party dues", l.dues], ["Taxes", l.taxes], ["Donations", l.donations], ["Schemes", l.schemes], ["Officer salaries", -l.salaries], ["Armed forces", -l.army], ["Facilities", -l.facilities], ["Governing", -l.admin]];
    for (const [k, v] of ledger) { p.text(k, x, y, 15, THEME.cream, FONT.body); p.textR(money(v), x + col - 20, y, 16, v < 0 ? [0.95, 0.45, 0.4, 1] : THEME.cream, FONT.num); y += 26; }
    p.rect(x, y, col - 20, 2, THEME.cream);
    y += 8;
    p.text("NET PER DAY", x, y, 14, THEME.gold, FONT.head);
    p.textR(money(l.net), x + col - 20, y, 20, l.net < 0 ? THEME.red : THEME.green, FONT.num);
    y += 44;
    p.text("SCHEMES UNDERWAY", x, y, 14, THEME.gold, FONT.head);
    y += 26;
    if (!c.schemes.length) { p.text("None. Plot from the Territory tab.", x, y, 14, THEME.dim, FONT.body); y += 22; }
    for (const s of c.schemes.slice(0, 6)) {
        p.text(`${SCHEMES.find(x2 => x2.id === s.scheme)?.name} in ${regionDefById(s.region)?.name}: ${s.daysLeft}d, ${Math.round(s.chance * 100)}%`, x, y, 14, THEME.cream, FONT.body, col - 20);
        y += 22;
    }
    // News.
    x = 60 + col * 2;
    y = top;
    p.text("BULLETINS", x, y, 16, THEME.gold, FONT.head);
    y += 30;
    for (const n of c.news.slice(0, Math.floor((H - top - 80) / 44))) {
        p.rect(x, y + 2, 6, 34, n.kind === "good" ? THEME.green : n.kind === "bad" ? THEME.red : n.kind === "war" ? THEME.gold : THEME.grey);
        p.text(`${dateLabel(n.day)}`, x + 14, y, 11, THEME.dim, FONT.head);
        p.text(n.text, x + 14, y + 14, 13, THEME.cream, FONT.body, col - 30, 30);
        y += 44;
    }
}

function memberLine(m: Member): string {
    return `${m.name}`;
}

function drawOrganization(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const report = orgReport(c);
    let x = 20, y = top;
    // The chain of command.
    p.text("CHAIN OF COMMAND", x, y, 16, THEME.gold, FONT.head);
    p.text(`You direct ${report.directReports} of ${report.leaderSpan} officers. ${fmt(report.organized)} of ${fmt(report.total)} members organized.`, x + 250, y + 2, 14, THEME.cream, FONT.body, W - 300);
    y += 30;
    p.rect(x, y, 300, 50, partyColor(c), 3, THEME.black);
    p.text(c.party.leader.toUpperCase(), x + 12, y + 6, 18, THEME.cream, FONT.head, 280);
    p.text("THE LEADER", x + 12, y + 30, 11, THEME.cream, FONT.head);
    INNER_CIRCLE.forEach((role, i) => {
        const m = report.inner[role];
        const bx = x + 320 + i * 235;
        p.rect(bx, y, 225, 50, m ? THEME.black : [0.25, 0.08, 0.08, 1], 2, THEME.gold);
        p.text(ROLE_NAMES[role].toUpperCase(), bx + 10, y + 5, 11, THEME.gold, FONT.head, 210);
        p.text(m ? m.name : "VACANT", bx + 10, y + 22, 15, m ? THEME.cream : THEME.red, FONT.head, 210);
    });
    y += 64;
    ui.button("auto-organize", x, y, 260, 40, "AUTO-ORGANIZE", "red", () => g.act("auto-organize"), { size: 14 });
    let wy = y;
    for (const w of report.warnings.slice(0, 3)) { p.text(`! ${w}`, x + 280, wy, 13, THEME.gold, FONT.body, W - 320); wy += 18; }
    y += 56;
    // Members list.
    const perPage = Math.max(6, Math.floor((H - y - 100) / 30));
    const list = [...c.members].sort((a, b) => (a.role === "none" ? 1 : 0) - (b.role === "none" ? 1 : 0) || b.admin + b.charisma + b.combat - (a.admin + a.charisma + a.combat));
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    const page = Math.min(g.memberPage, pages - 1);
    const lw = Math.min(900, W * 0.58);
    p.rect(x, y, lw, 28, THEME.black);
    const cols: [string, number][] = [["NAME", 10], ["HOME", 240], ["CHA", 400], ["ADM", 450], ["CMB", 500], ["LOYAL", 550], ["ROLE", 620]];
    for (const [h, cx] of cols) p.text(h, x + cx, y + 6, 11, THEME.gold, FONT.head);
    y += 30;
    list.slice(page * perPage, page * perPage + perPage).forEach(m => {
        const sel = g.selectedMember === m.id;
        p.rect(x, y, lw, 28, sel ? [0.35, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.9]);
        p.text(memberLine(m) + (m.follower ? " *" : ""), x + 10, y + 5, 14, THEME.cream, FONT.body, 225);
        p.text(regionDefById(m.region)?.name ?? m.region, x + 240, y + 5, 13, THEME.dim, FONT.body, 150);
        p.text(String(m.charisma), x + 400, y + 4, 15, THEME.cream, FONT.num);
        p.text(String(m.admin), x + 450, y + 4, 15, THEME.cream, FONT.num);
        p.text(String(m.combat), x + 500, y + 4, 15, THEME.cream, FONT.num);
        p.text(String(Math.round(m.loyalty)), x + 550, y + 4, 15, m.loyalty < 30 ? THEME.red : THEME.cream, FONT.num);
        const post = m.post ? (m.role === "commissioner" ? BLOCS.find(b => b.id === m.post)?.short : regionDefById(m.post)?.name) : "";
        p.text(m.role === "none" ? (m.follower ? "Follower" : "-") : `${ROLE_NAMES[m.role]}${post ? `, ${post}` : ""}`, x + 620, y + 5, 13, m.role === "none" ? THEME.dim : THEME.gold, FONT.body, lw - 630);
        ui.hotspot(`member-${m.id}`, x, y, lw, 28, () => g.act("select-member", m.id));
        y += 30;
    });
    ui.button("members-prev", x, H - 70, 100, 40, "PREV", "dark", () => g.act("member-page", -1), { disabled: page === 0 });
    p.text(`PAGE ${page + 1} / ${pages}`, x + 120, H - 60, 14, THEME.cream, FONT.head);
    ui.button("members-next", x + 260, H - 70, 100, 40, "NEXT", "dark", () => g.act("member-page", 1), { disabled: page >= pages - 1 });
    // Selected member's posts.
    const m = c.members.find(mm => mm.id === g.selectedMember);
    const ax = x + lw + 30, aw = W - ax - 80;
    let ay = top + 150;
    if (!m) { p.text("Select a member to give them a post.", ax, ay, 15, THEME.dim, FONT.body, aw); return; }
    p.text(m.name.toUpperCase(), ax, ay, 20, THEME.cream, FONT.head, aw);
    ay += 30;
    p.text(`${regionDefById(m.region)?.name}. Charisma ${m.charisma}, Admin ${m.admin}, Combat ${m.combat}, Loyalty ${Math.round(m.loyalty)}.`, ax, ay, 14, THEME.dim, FONT.body, aw);
    ay += 40;
    const btn = (id: string, label: string, action: string, arg: unknown, active = false) => {
        ui.button(id, ax, ay, aw, 36, label, "dark", () => g.act(action, arg), { size: 12, active });
        ay += 42;
    };
    for (const role of INNER_CIRCLE) btn(`appoint-${role}`, ROLE_NAMES[role].toUpperCase(), "appoint", { id: m.id, role, post: null }, m.role === role);
    const home = regionDefById(m.region)?.name ?? "";
    btn("appoint-chief", `CHIEF OF ${home.toUpperCase()}`, "appoint", { id: m.id, role: "chief", post: m.region }, m.role === "chief");
    btn("appoint-cell", `CELL LEADER, ${home.toUpperCase()}`, "appoint", { id: m.id, role: "cell", post: m.region }, m.role === "cell");
    const bloc = BLOCS.find(b => b.id === blocOf(m.region));
    btn("appoint-commissioner", `COMMISSIONER OF ${bloc?.short ?? ""}`, "appoint", { id: m.id, role: "commissioner", post: bloc?.id }, m.role === "commissioner");
    btn("appoint-follower", m.follower ? "STOP FOLLOWING ME" : `FOLLOW ME (${followers(c).length}/${followerLimit(c)})`, "follower", m.id, m.follower);
    btn("appoint-none", "RELIEVE OF DUTY", "appoint", { id: m.id, role: "none", post: null });
}

function drawTerritory(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const mw = Math.min(W - 520, (H - top - 40) * 2.77), mh = mw / 2.77;
    worldMap(ui, g, 20, top, mw, mh, id => g.act("select-region", id), g.selectedRegion);
    // Legend.
    let lx = 20;
    const ly = top + mh + 12;
    for (const f of ["party", "concordat", "vanguard", "verdant", "current"]) {
        p.rect(lx, ly + 2, 14, 14, factionColor(c, f), 1, THEME.black);
        const name = factionName(c, f);
        p.text(name, lx + 20, ly, 13, THEME.cream, FONT.body);
        lx += textWidth(name, 13) + 50;
    }
    // Strongest regions.
    let sy = ly + 30;
    p.text("YOUR STRONGEST REGIONS", 20, sy, 13, THEME.gold, FONT.head);
    sy += 22;
    const best = REGIONS.map(r => ({ r, rs: c.regions[r.id] })).filter(x => x.rs.members > 0 || partyShare(x.rs) > 0.005)
        .sort((a, b) => partyShare(b.rs) - partyShare(a.rs)).slice(0, Math.max(3, Math.floor((H - sy - 20) / 22)));
    for (const { r, rs } of best) {
        const lvl = controlLevel(rs);
        p.text(`${r.name}`, 20, sy, 14, THEME.cream, FONT.body);
        p.text(`${pct(partyShare(rs))}  ${big(rs.members)} members  ${rs.army ? `${big(rs.army)} armed` : ""}  ${lvl.toUpperCase()}${rs.war ? "  AT WAR" : ""}`, 200, sy, 14, lvl === "governed" ? THEME.gold : THEME.dim, FONT.body, mw - 200);
        ui.hotspot(`best-${r.id}`, 20, sy, mw, 20, () => g.act("select-region", r.id));
        sy += 22;
    }
    // Region detail.
    const id = g.selectedRegion ?? g.region ?? c.party.hq;
    const def = regionDefById(id);
    if (!def) return;
    const rs = c.regions[id];
    const dx = 40 + mw, dw = W - dx - 20;
    let y = top;
    p.rect(dx, y, dw, 48, factionColor(c, rs.governor));
    p.text(def.name.toUpperCase(), dx + 12, y + 10, 22, rs.governor === PARTY || factionById(rs.governor).id === "current" ? THEME.black : THEME.cream, FONT.head, dw - 20);
    y += 58;
    p.text(`${def.country}, ${BLOCS.find(b => b.id === def.bloc)!.name}`, dx, y, 14, THEME.dim, FONT.body, dw);
    y += 22;
    p.text(`${def.pop}M people  -  ${rs.gov.toUpperCase()}  -  ruled by ${factionName(c, rs.governor)}`, dx, y, 14, THEME.cream, FONT.body, dw);
    y += 30;
    const shares = Object.entries(rs.support).sort((a, b) => b[1] - a[1]);
    for (const [f, v] of shares) {
        p.text(f === "undecided" ? "Undecided" : factionName(c, f), dx, y, 13, THEME.cream, FONT.body, 150);
        p.bar(dx + 150, y + 3, dw - 220, 12, v, f === "undecided" ? [0.5, 0.5, 0.5, 1] : factionColor(c, f));
        p.textR(pct(v), dx + dw, y, 14, THEME.cream, FONT.num);
        y += 20;
    }
    y += 8;
    const stat: [string, string][] = [["Members", fmt(rs.members)], ["Armed", fmt(rs.army)], [rs.governor === PARTY ? "Insurgents" : "Garrison", fmt(rs.garrison)],
        ["Unrest", pct(rs.unrest, 0)], ["Heat", pct(rs.heat, 0)], ["Election", rs.gov === "democracy" ? `in ${rs.electionIn} days` : "none"]];
    stat.forEach(([k, v], i) => {
        const sx = dx + (i % 3) * (dw / 3);
        const syy = y + Math.floor(i / 3) * 40;
        p.text(k.toUpperCase(), sx, syy, 11, THEME.dim, FONT.head);
        p.text(v, sx, syy + 14, 17, THEME.cream, FONT.num);
    });
    y += 88;
    if (rs.war) {
        p.rect(dx, y, dw, 24 + Math.min(4, rs.war.log.length) * 18, [0.25, 0.05, 0.05, 1]);
        p.text(`WAR vs ${factionName(c, rs.war.attacker === PARTY ? rs.war.defender : rs.war.attacker)} - day ${rs.war.days}, next: ${rs.war.phase === "offensive" ? (rs.war.attacker === PARTY ? "your offensive" : "their offensive") : (rs.war.attacker === PARTY ? "their counterattack" : "your counterattack")}`, dx + 8, y + 4, 13, THEME.gold, FONT.body, dw - 16);
        let wy = y + 22;
        for (const line of rs.war.log.slice(0, 4)) { p.text(line, dx + 8, wy, 12, THEME.cream, FONT.mono, dw - 16); wy += 18; }
        y = wy + 8;
    }
    // Actions.
    const bw = (dw - 10) / 2;
    const actions: [string, string, string, boolean][] = [];
    const t = travelCost(c, c.player.lat, c.player.lon, id);
    actions.push(["act-travel", id === g.region ? "YOU ARE HERE" : `TRAVEL (${t.cost ? money(t.cost) : "FREE"}${t.days ? `, ${t.days}D` : ""})`, "travel", id !== g.region]);
    actions.push(["act-hq", id === c.party.hq ? "HEADQUARTERS" : "MOVE HQ HERE", "move-hq", id !== c.party.hq]);
    if (rs.governor !== PARTY) {
        actions.push(["act-election", rs.gov === "democracy" ? `SNAP ELECTION (${money(electionCost(rs))})` : "NO ELECTIONS", "election", rs.gov === "democracy"]);
        actions.push(["act-coup", `COUP (${Math.round(coupChance(c, id) * 100)}%)`, "coup", rs.army >= 10 && !rs.war]);
        actions.push(rs.war ? ["act-peace", "SUE FOR PEACE", "peace", true] : ["act-war", "DECLARE WAR", "war", rs.army >= 10]);
    } else {
        actions.push(["act-tax-down", `TAX ${Math.round(rs.taxRate * 100)}%  -`, "tax", true]);
        actions.push(["act-tax-up", `TAX ${Math.round(rs.taxRate * 100)}%  +`, "tax-up", true]);
        if (rs.gov === "democracy") actions.push(["act-suspend", "SUSPEND ELECTIONS", "suspend", true]);
        if (rs.war) actions.push(["act-peace", "SUE FOR PEACE", "peace", true]);
    }
    const armN = Math.max(0, Math.min(rs.members - 1, Math.floor(c.party.funds / ARM_COST), Math.max(10, Math.round(rs.members * 0.25))));
    actions.push(["act-arm", `ARM ${fmt(armN)} (${money(armN * ARM_COST)})`, "arm", armN > 0]);
    actions.push(["act-disarm", "STAND DOWN 25%", "disarm", rs.army > 0]);
    const hereArmy = g.region ? c.regions[g.region].army : 0;
    actions.push(["act-march", `MARCH ${fmt(Math.floor(hereArmy / 2))} HERE`, "march", !!g.region && g.region !== id && hereArmy >= 2]);
    actions.forEach(([bid, label, action], i) => {
        const enabled = actions[i][3];
        ui.button(bid, dx + (i % 2) * (bw + 10), y + Math.floor(i / 2) * 44, bw, 38, label, action === "war" || action === "coup" ? "red" : "dark", () => g.act(action, id), { disabled: !enabled, size: 11 });
    });
    y += Math.ceil(actions.length / 2) * 44 + 10;
    p.text("SCHEMES", dx, y, 13, THEME.gold, FONT.head);
    y += 22;
    const sw = (dw - 10) / 2;
    SCHEMES.forEach((s, i) => {
        const label = `${s.name.toUpperCase()} ${schemeCost(c, s.id) ? money(schemeCost(c, s.id)) : ""} ${Math.round(schemeChance(c, s.id, id) * 100)}%`;
        const enabled = rs.members > 0 || id === c.party.hq;
        ui.button(`scheme-${s.id}`, dx + (i % 2) * (sw + 10), y + Math.floor(i / 2) * 38, sw, 32, label, s.karma < -5 ? "red" : "dark", () => g.act("scheme", { scheme: s.id, region: id }), { disabled: !enabled, size: 10 });
    });
}

function drawArmory(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W } = ui;
    const col = (W - 80) / 3;
    let x = 20, y = top;
    p.text(`WEAPONS  -  ${money(c.party.funds)}`, x, y, 16, THEME.gold, FONT.head);
    y += 30;
    for (const w of WEAPONS) {
        const owned = c.player.weapons.includes(w.id);
        p.rect(x, y, col, 62, c.player.weapon === w.id ? [0.3, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(w.name.toUpperCase(), x + 10, y + 6, 15, THEME.cream, FONT.head, col - 150);
        p.text(`DMG ${w.damage}${w.pellets > 1 ? `x${w.pellets}` : ""}  RATE ${w.rate}/s  RANGE ${w.range}m${Number.isFinite(w.magazine) ? `  MAG ${w.magazine}` : ""}`, x + 10, y + 28, 12, THEME.dim, FONT.mono, col - 150);
        p.text(w.blurb, x + 10, y + 44, 12, THEME.dim, FONT.body, col - 150);
        if (owned) {
            ui.button(`equip-${w.id}`, x + col - 130, y + 6, 120, 24, c.player.weapon === w.id ? "EQUIPPED" : "EQUIP", "dark", () => g.act("equip", w.id), { size: 11, active: c.player.weapon === w.id });
            if (Number.isFinite(w.magazine)) ui.button(`ammo-${w.id}`, x + col - 130, y + 34, 120, 24, `AMMO ${money(ammoPrice(w.id))}`, "dark", () => g.act("buy-ammo", w.id), { size: 10 });
        } else ui.button(`buy-${w.id}`, x + col - 130, y + 18, 120, 28, money(w.price), "red", () => g.act("buy-weapon", w.id), { size: 12, disabled: c.party.funds < w.price });
        y += 68;
    }
    x = 40 + col;
    y = top;
    p.text("ARMOR", x, y, 16, THEME.gold, FONT.head);
    y += 30;
    for (const a of ARMORS) {
        const worn = c.player.armorId === a.id;
        p.rect(x, y, col, 56, worn ? [0.3, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(a.name.toUpperCase(), x + 10, y + 6, 15, THEME.cream, FONT.head, col - 150);
        p.text(`${a.armor} ARMOR, ${Math.round(a.absorb * 100)}% ABSORB. ${a.blurb}`, x + 10, y + 28, 12, THEME.dim, FONT.body, col - 150);
        if (a.price) ui.button(`armor-${a.id}`, x + col - 130, y + 14, 120, 28, worn ? (c.player.armor < a.armor ? `REPAIR ${money(a.price / 4)}` : "WORN") : money(a.price), worn ? "dark" : "red", () => g.act("buy-armor", a.id), { size: 11, disabled: worn && c.player.armor >= a.armor });
        y += 62;
    }
    y += 14;
    p.text("PAMPHLETS (BUNDLES OF 10)", x, y, 16, THEME.gold, FONT.head);
    y += 30;
    for (const pm of PAMPHLETS) {
        p.rect(x, y, col, 50, g.pamphlet === pm.id ? [0.3, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(`${pm.name.toUpperCase()} x${c.player.pamphlets[pm.id] ?? 0}`, x + 10, y + 6, 14, THEME.cream, FONT.head, col - 150);
        p.text(pm.blurb, x + 10, y + 28, 12, THEME.dim, FONT.body, col - 150);
        ui.button(`pamphlet-${pm.id}`, x + col - 130, y + 4, 120, 20, `BUY ${money(pamphletPrice(c, pm.id))}`, "red", () => g.act("buy-pamphlets", pm.id), { size: 10 });
        ui.button(`pamphlet-use-${pm.id}`, x + col - 130, y + 27, 120, 20, g.pamphlet === pm.id ? "CARRYING" : "CARRY", "dark", () => g.act("select-pamphlet", pm.id), { size: 10, active: g.pamphlet === pm.id });
        y += 56;
    }
    x = 60 + col * 2;
    y = top;
    p.text("PARTY FACILITIES", x, y, 16, THEME.gold, FONT.head);
    y += 30;
    for (const f of FACILITIES) {
        const built = hasFacility(c, f.id);
        p.rect(x, y, col, 70, built ? [0.12, 0.25, 0.12, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(f.name.toUpperCase(), x + 10, y + 6, 15, THEME.cream, FONT.head, col - 150);
        p.text(`${f.blurb} Upkeep ${money(f.upkeep)}/day.`, x + 10, y + 28, 12, THEME.dim, FONT.body, col - 150, 40);
        ui.button(`facility-${f.id}`, x + col - 130, y + 20, 120, 28, built ? "BUILT" : money(f.price), built ? "dark" : "red", () => g.act("buy-facility", f.id), { size: 11, disabled: built || c.party.funds < f.price });
        y += 76;
    }
}

function drawSkills(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W } = ui;
    let y = top;
    p.text(`LEVEL ${c.party.level}  -  ${c.party.skillPoints} SKILL POINT${c.party.skillPoints === 1 ? "" : "S"}`, 20, y, 20, THEME.gold, FONT.head);
    y += 34;
    p.bar(20, y, 500, 16, c.party.xp / xpForLevel(c.party.level), THEME.gold);
    p.text(`${fmt(c.party.xp)} / ${fmt(xpForLevel(c.party.level))} XP. Speeches, recruits, victories and battles earn XP.`, 540, y - 2, 14, THEME.dim, FONT.body, W - 560);
    y += 40;
    const cw = (W - 60) / 2;
    SKILLS.forEach((s, i) => {
        const x = 20 + (i % 2) * (cw + 20), yy = y + Math.floor(i / 2) * 120;
        const lvl = c.party.skills[s.id];
        p.rect(x, yy, cw, 108, [0.12, 0.1, 0.1, 0.95], 2, THEME.black);
        p.text(s.name.toUpperCase(), x + 14, yy + 10, 20, THEME.cream, FONT.head);
        p.text(s.blurb, x + 14, yy + 42, 14, THEME.dim, FONT.body, cw - 200);
        for (let k = 0; k < SKILL_MAX; k++) p.rect(x + 14 + k * 34, yy + 74, 28, 18, k < lvl ? partyColor(c) : [0.25, 0.22, 0.2, 1], 1, THEME.black);
        const cost = skillCost(lvl);
        ui.button(`skill-${s.id}`, x + cw - 170, yy + 30, 150, 44, lvl >= SKILL_MAX ? "MASTERED" : `RAISE (${cost} SP)`, "red", () => g.act("raise-skill", s.id), { size: 12, disabled: lvl >= SKILL_MAX || c.party.skillPoints < cost });
    });
}

// --- Ending --------------------------------------------------------------------------------------

export function drawOutcome(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c;
    if (!c?.outcome) return;
    const o = c.outcome;
    backdrop(ui, 0.8);
    const pw = Math.min(980, W - 80), ph = 460, px = (W - pw) / 2, py = (H - ph) / 2;
    posterFrame(ui, px, py, pw, ph);
    p.rect(px + 24, py + 24, pw - 48, 110, o.kind === "victory" ? partyColor(c) : THEME.black);
    p.textC(o.kind === "victory" ? "VICTORY" : "DEFEAT", W / 2, py + 36, 52, THEME.cream, FONT.head);
    p.textC(o.title, W / 2, py + 100, 20, THEME.gold, FONT.head);
    p.text(o.text, px + 50, py + 160, 20, THEME.black, FONT.body, pw - 100, 120);
    p.textC(`Day ${o.day}. ${c.stats.speeches} speeches, ${c.stats.recruits} recruited in person, ${c.stats.regionsTaken} regions taken, ${c.stats.kills} enemies fallen.`, W / 2, py + 300, 15, THEME.grey, FONT.body);
    ui.button("outcome-title", W / 2 - 150, py + ph - 90, 300, 54, "RETURN TO TITLE", "red", () => g.act("title"), { size: 18 });
}

export function drawScreen(g: GameView, ui: UiFrame): void {
    ui.handlers.clear();
    switch (g.mode) {
        case "title": drawTitle(g, ui); break;
        case "setup": drawSetup(g, ui); break;
        case "loading": drawLoading(g, ui); break;
        case "play": drawHud(g, ui); break;
        case "speech": drawSpeech(g, ui); break;
        case "dialogue": drawHud(g, ui); drawDialogue(g, ui); break;
        case "console": drawConsole(g, ui); break;
        case "outcome": drawOutcome(g, ui); break;
    }
}

export { holder, weaponById, type RegionDef };
