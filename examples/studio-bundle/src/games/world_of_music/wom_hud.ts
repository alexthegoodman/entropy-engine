// Every screen of World of Music, drawn with the Painter (Entropy.UI rects and texts). The HUD
// stays in the same visual language as the world: black ink, white paper, and color only where
// it means something - a swarm's own hue, magenta fruit, amber relics, teal mechanisms, red.

import { Painter, textWidth, type Color } from "../allegiance/al_ui";
import { SPECIES, TRAITS, TRAIT_IDS, COLOR_LANGUAGE, PIPE_NOTES, BINDINGS, PALETTE, SPLIT_AT, type RGB, type TraitId, type SpeciesId, type Device } from "./wom_data";

export const FONT = { head: "Kavoon", body: "Quicksand", num: "Vina Sans" };
const INK: Color = [0.04, 0.04, 0.05, 0.9];
const INK_SOLID: Color = [0.04, 0.04, 0.05, 1];
const PAPER: Color = [0.96, 0.95, 0.92, 1];
const DIM: Color = [0.7, 0.7, 0.72, 1];
const SOFT: Color = [0.82, 0.82, 0.85, 1];
const c4 = (c: RGB, a = 1): Color => [c[0], c[1], c[2], a];

export interface SwarmCard {
    name: string; species: SpeciesId; count: number; faded: number; food: number;
    traits: { id: TraitId; rank: number }[];
    order: string; selected: boolean; key: string; unreachable: boolean; flash: number;
}
export interface HudView {
    w: number; h: number; time: number; device: Device;
    island: string; hearts: { left: number; total: number };
    relics: number; chimes: number;
    hp: number;
    swarms: SwarmCard[];
    hover: { text: string; color: RGB } | null;
    link: { text: string; age: number } | null;
    say: { name: string; text: string; age: number } | null;
    lesson: { title: string; text: string; age: number; more: number } | null;
    toasts: { text: string; age: number }[];
    banner: { title: string; text: string; age: number; color: RGB } | null;
    boss: { name: string; hp: number; anchors: number } | null;
    prompt: string;
    jam: { npc: string; phrase: number; phrases: number; step: string; shown: number[]; input: number[]; length: number } | null;
    pipe: number[];
    exitOpen: boolean;
    down: number;
    hints: string;
}

export function drawHud(p: Painter, v: HudView): void {
    const { w, h } = v;
    // --- top left: the island and what is left to do ---
    p.panel(18, 16, 330, 76, INK);
    p.text(v.island.toUpperCase(), 32, 22, 22, PAPER, FONT.head);
    const heartText = v.hearts.left ? `${v.hearts.left} of ${v.hearts.total} red hearts still beat` : v.exitOpen ? "The song gate is open" : "The island sings";
    p.text(heartText, 32, 56, 14, v.hearts.left ? c4(PALETTE.red) : PAPER, FONT.body);
    // relics and chimes
    p.panel(18, 98, 330, 34, INK);
    p.rect(30, 108, 14, 14, c4(PALETTE.relic));
    p.text(`${v.relics} relics`, 50, 104, 15, c4(PALETTE.relic), FONT.body);
    p.text(`${v.chimes} chimes`, 170, 104, 15, PAPER, FONT.body);
    // Tom's health.
    p.panel(18, 138, 330, 18, INK);
    p.bar(26, 142, 314, 10, v.hp, v.hp > 0.35 ? PAPER : c4(PALETTE.red), [1, 1, 1, 0.12]);

    // --- top right: the Link ---
    if (v.link && v.link.age < 11) {
        const lw = Math.min(520, w * 0.38), x = w - lw - 18, a = Math.min(1, v.link.age * 3, (11 - v.link.age) * 1.5);
        p.panel(x, 16, lw, 118, [0.02, 0.05, 0.09, 0.92 * a]);
        p.rect(x, 16, 6, 118, c4(PALETTE.link, a));
        p.text("THE LINK  -  WORLD OF COLOR", x + 18, 22, 13, c4(PALETTE.link, a), FONT.body);
        const shown = v.link.text.slice(0, Math.floor(v.link.age * 60));
        p.text(shown, x + 18, 44, 15, [0.92, 0.96, 1, a], FONT.body, lw - 30, 86);
    }

    // --- boss ---
    if (v.boss) {
        const bw = Math.min(620, w * 0.5), x = (w - bw) / 2;
        p.panel(x, 18, bw, 54, INK);
        p.textC(v.boss.name.toUpperCase(), w / 2, 22, 18, c4(PALETTE.red), FONT.head);
        p.bar(x + 14, 52, bw - 28, 10, v.boss.hp, c4(PALETTE.red), [1, 1, 1, 0.1]);
        if (v.boss.anchors > 0) p.textC(`Shielded by ${v.boss.anchors} anchor${v.boss.anchors > 1 ? "s" : ""}: purify them first`, w / 2, 76, 13, PAPER, FONT.body);
    }

    // --- banner ---
    if (v.banner && v.banner.age < 6) {
        const a = Math.min(1, v.banner.age * 2.5, (6 - v.banner.age) * 1.5);
        p.textC(v.banner.title, w / 2, h * 0.26, 40, c4(v.banner.color, a), FONT.head);
        p.textC(v.banner.text, w / 2, h * 0.26 + 56, 17, [1, 1, 1, a], FONT.body);
    }

    // --- toasts ---
    v.toasts.forEach((t, i) => {
        const a = Math.min(1, (4.5 - t.age) * 1.5);
        const tw = textWidth(t.text, 15, FONT.body) + 36;
        p.panel(w / 2 - tw / 2, h * 0.62 - i * 34, tw, 28, [0.04, 0.04, 0.05, 0.75 * a]);
        p.textC(t.text, w / 2, h * 0.62 - i * 34 + 4, 15, [1, 1, 1, a], FONT.body);
    });

    // --- the swarm cards ---
    const n = v.swarms.length, cw = Math.min(170, (w - 60) / Math.max(1, n) - 10), ch = 92;
    const total = n * (cw + 10) - 10, x0 = (w - total) / 2, y0 = h - ch - 18;
    v.swarms.forEach((s, i) => {
        const col = SPECIES[s.species].color, x = x0 + i * (cw + 10), lift = s.selected ? 10 : 0, y = y0 - lift;
        p.panel(x, y, cw, ch, s.selected ? [0.06, 0.06, 0.07, 0.96] : INK);
        p.rect(x, y, cw, 5, c4(col, s.selected ? 1 : 0.6));
        if (s.selected) { p.rect(x - 3, y - 3, cw + 6, 3, c4(col)); p.rect(x - 3, y + ch, cw + 6, 3, c4(col)); }
        p.text(s.key, x + 8, y + 9, 13, DIM, FONT.num);
        p.text(s.name, x + 24, y + 7, 16, c4(col), FONT.head);
        p.text(`x${s.count}${s.faded ? `  (${s.faded} fallen)` : ""}`, x + 10, y + 32, 14, s.faded ? c4(PALETTE.red) : PAPER, FONT.body);
        // Fruit toward the next split.
        for (let k = 0; k < SPLIT_AT; k++) p.rect(x + cw - 14 - k * 13, y + 36, 9, 9, k < s.food ? c4(PALETTE.fruit) : [1, 1, 1, 0.15]);
        p.text(s.traits.map(t => TRAITS[t.id].name.split(" ").pop()!.slice(0, 5) + (TRAITS[t.id].max > 1 ? ` ${t.rank}` : "")).join(" . "), x + 10, y + 52, 11, SOFT, FONT.body, cw - 16, 16);
        const order = s.unreachable ? "Can't reach that" : s.order;
        p.text(order, x + 10, y + 70, 12, s.unreachable ? c4(PALETTE.red) : s.flash > 0 ? c4(col) : DIM, FONT.body, cw - 16, 18);
        p.hotspot(`swarm:${i}`, x, y, cw, ch);
    });

    // What a click does right now.
    if (v.hover) {
        const tw = textWidth(v.hover.text, 15, FONT.body) + 30;
        p.panel(w / 2 - tw / 2, y0 - 48, tw, 28, INK);
        p.textC(v.hover.text, w / 2, y0 - 44, 15, c4(v.hover.color), FONT.body);
    }
    if (v.prompt) {
        const tw = textWidth(v.prompt, 14, FONT.body) + 30;
        p.panel(w / 2 - tw / 2, y0 - 82, tw, 26, [0.96, 0.95, 0.92, 0.92]);
        p.textC(v.prompt, w / 2, y0 - 78, 14, INK_SOLID, FONT.body);
    }

    // --- dialogue ---
    if (v.say && v.say.age < 6) {
        const dw = Math.min(640, w * 0.5), x = (w - dw) / 2, y = h * 0.66;
        p.panel(x, y, dw, 74, [0.96, 0.95, 0.92, 0.95]);
        p.text(v.say.name.toUpperCase(), x + 16, y + 6, 15, INK_SOLID, FONT.head);
        p.text(v.say.text.slice(0, Math.floor(v.say.age * 70)), x + 16, y + 30, 15, INK_SOLID, FONT.body, dw - 30, 40);
    }

    // --- the Field Guide ---
    if (v.lesson) {
        const lw = 340, x = w - lw - 18, y = 150;
        p.panel(x, y, lw, 128, [0.96, 0.95, 0.92, 0.94]);
        p.rect(x, y, lw, 4, INK_SOLID);
        p.text("FIELD GUIDE", x + 14, y + 8, 12, [0.35, 0.35, 0.38, 1], FONT.body);
        p.text(v.lesson.title, x + 14, y + 24, 18, INK_SOLID, FONT.head);
        p.text(v.lesson.text, x + 14, y + 52, 13, INK_SOLID, FONT.body, lw - 26, 70);
        p.text(`${v.device === "pad" ? "[HOLD BACK]" : "[H]"} next${v.lesson.more ? ` (${v.lesson.more} more)` : ""}`, x + 14, y + 108, 11, [0.35, 0.35, 0.38, 1], FONT.body);
    }

    // --- the Prism Pipe and the jam ---
    if (v.jam || v.pipe.some(g => g > 0)) {
        const bw = 5 * 64, x = (w - bw) / 2, y = h * 0.42;
        if (v.jam) {
            p.panel(x - 40, y - 74, bw + 80, 168, INK);
            p.textC(v.jam.step === "listen" ? "Listen..." : "Your turn: play it back", w / 2, y - 68, 18, PAPER, FONT.head);
            p.textC(`Phrase ${Math.min(v.jam.phrases, v.jam.phrase + 1)} of ${v.jam.phrases}`, w / 2, y - 40, 13, DIM, FONT.body);
            const seq = v.jam.step === "listen" ? v.jam.shown : v.jam.input;
            for (let k = 0; k < v.jam.length; k++) {
                const cx = w / 2 - (v.jam.length - 1) * 22 + k * 44;
                const note = seq[k];
                p.rect(cx - 14, y - 14, 28, 28, note === undefined ? [1, 1, 1, 0.12] : c4(PIPE_NOTES[note].color), 2, [1, 1, 1, 0.3]);
            }
        }
        PIPE_NOTES.forEach((n, i) => {
            const cx = x + i * 64 + 32, glow = v.pipe[i] > 0;
            p.rect(cx - 22, y + 30, 44, 44, glow ? c4(n.color) : c4(n.color, 0.35), 2, glow ? [1, 1, 1, 1] : [1, 1, 1, 0.2]);
            p.textC(v.device === "pad" ? ["A", "B", "X", "Y", "RT"][i] : n.key, cx, y + 42, 16, INK_SOLID, FONT.num);
        });
    }

    if (v.down > 0) p.textC("The Link is pulling you back together...", w / 2, h * 0.45, 22, c4(PALETTE.link), FONT.head);
    p.text(v.hints, 18, h - 22, 11, [1, 1, 1, 0.55], FONT.body, w * 0.9, 16);
}

// --- Bodhi's stall --------------------------------------------------------------------------

export interface StallView {
    w: number; h: number; device: Device;
    relics: number; chimes: number; relicValue: number;
    swarms: { name: string; species: SpeciesId; count: number; traits: Record<string, number> }[];
    selected: number; cursor: string;
    prices: Record<string, number | null>;
    hatch: { species: SpeciesId; price: number; can: boolean }[];
    note: string;
}

export function drawStall(p: Painter, v: StallView): void {
    const { w, h } = v;
    p.panel(0, 0, w, h, [0.02, 0.02, 0.03, 0.72]);
    const pw = Math.min(980, w - 60), ph = Math.min(640, h - 60), x = (w - pw) / 2, y = (h - ph) / 2;
    p.panel(x, y, pw, ph, [0.96, 0.95, 0.92, 0.98]);
    p.rect(x, y, pw, 6, INK_SOLID);
    p.text("BODHI'S STALL", x + 24, y + 16, 30, INK_SOLID, FONT.head);
    p.text("\"Relics hum, you know. I'll pay in chimes. Chimes teach Tones new tricks.\"", x + 24, y + 58, 14, [0.3, 0.3, 0.32, 1], FONT.body);
    // Sell.
    p.rect(x + 24, y + 90, 18, 18, c4(PALETTE.relic));
    p.text(`${v.relics} relics  (${v.relicValue} chimes each)`, x + 50, y + 88, 16, INK_SOLID, FONT.body);
    p.text(`${v.chimes} chimes`, x + pw - 180, y + 88, 18, INK_SOLID, FONT.head);
    p.button("sell", x + 360, y + 84, 170, 32, v.relics ? `SELL ALL  +${v.relics * v.relicValue}` : "NOTHING TO SELL", v.relics ? "red" : "paper", { disabled: !v.relics, active: v.cursor === "sell" });
    // Swarms.
    p.text("YOUR SWARMS", x + 24, y + 134, 13, [0.35, 0.35, 0.38, 1], FONT.body);
    v.swarms.forEach((s, i) => {
        const bx = x + 24 + i * 116, by = y + 154, col = SPECIES[s.species].color;
        p.rect(bx, by, 108, 52, i === v.selected ? c4(col) : [0.88, 0.87, 0.84, 1], 2, i === v.selected ? INK_SOLID : [0, 0, 0, 0.2]);
        p.text(s.name, bx + 8, by + 4, 15, INK_SOLID, FONT.head);
        p.text(`x${s.count}`, bx + 8, by + 28, 13, INK_SOLID, FONT.body);
        p.hotspot(`stall-swarm:${i}`, bx, by, 108, 52);
    });
    // Traits for the selected swarm.
    const sel = v.swarms[v.selected];
    if (sel) {
        p.text(`TEACH THE ${sel.name.toUpperCase()} SWARM`, x + 24, y + 222, 13, [0.35, 0.35, 0.38, 1], FONT.body);
        TRAIT_IDS.forEach((t, i) => {
            const col = i % 3, row = Math.floor(i / 3), bx = x + 24 + col * ((pw - 48) / 3), by = y + 242 + row * 92, bw = (pw - 48) / 3 - 12;
            const def = TRAITS[t], rank = sel.traits[t] ?? 0, price = v.prices[t];
            const hot = v.cursor === `buy:${t}`;
            p.rect(bx, by, bw, 82, hot ? [1, 1, 1, 1] : [0.9, 0.89, 0.86, 1], hot ? 3 : 1, hot ? INK_SOLID : [0, 0, 0, 0.18]);
            p.text(`${def.name}${def.max > 1 ? `  ${"*".repeat(rank)}${".".repeat(def.max - rank)}` : rank ? "  (has it)" : ""}`, bx + 10, by + 6, 15, INK_SOLID, FONT.head);
            p.text(def.text, bx + 10, by + 30, 12, [0.25, 0.25, 0.27, 1], FONT.body, bw - 110, 48);
            p.button(`buy:${t}`, bx + bw - 96, by + 44, 86, 28, price === null ? "DONE" : `${price}`, price !== null && v.chimes >= price ? "dark" : "paper", { disabled: price === null || v.chimes < price, size: 13 });
        });
    }
    // Hatch.
    const hy = y + ph - 74;
    p.text("HATCH A NEW SWARM OF THREE", x + 24, hy, 13, [0.35, 0.35, 0.38, 1], FONT.body);
    v.hatch.forEach((hh, i) => p.button(`hatch:${hh.species}`, x + 24 + i * 150, hy + 20, 140, 34, `${SPECIES[hh.species].name}  ${hh.price}`, hh.can ? "dark" : "paper", { disabled: !hh.can, size: 13, active: v.cursor === `hatch:${hh.species}` }));
    p.button("close", x + pw - 140, hy + 20, 116, 34, "LEAVE", "red", { active: v.cursor === "close" });
    if (v.note) p.text(v.note, x + 24, hy - 26, 14, c4(PALETTE.red), FONT.body);
    p.text(v.device === "pad" ? "[D-PAD] choose   [A] buy   [LB/RB] swarm   [B] leave" : "Click, or [ARROWS] + [ENTER]   [TAB] next swarm   [ESC] leave", x + 24, y + ph - 18, 11, [0.35, 0.35, 0.38, 1], FONT.body);
}

// --- title, intro, island complete, ending --------------------------------------------------

export function drawTitle(p: Painter, w: number, h: number, time: number, canContinue: boolean, summary: string, device: Device): void {
    p.panel(0, 0, w, h * 0.12, [0, 0, 0, 0.35]);
    const ty = h * 0.14;
    p.textC("WORLD OF MUSIC", w / 2, ty, 64, PAPER, FONT.head);
    p.textC("where no one sees color - they see music", w / 2, ty + 84, 18, [1, 1, 1, 0.85], FONT.body);
    // The color language.
    const lw = 560, lx = (w - lw) / 2, ly = ty + 130;
    p.panel(lx, ly, lw, 36 + COLOR_LANGUAGE.length * 28, INK);
    p.text("ONLY TOM SEES COLOR. HERE IS WHAT IT MEANS:", lx + 18, ly + 8, 12, DIM, FONT.body);
    COLOR_LANGUAGE.forEach((c, i) => {
        p.rect(lx + 18, ly + 34 + i * 28, 18, 18, c4(c.color));
        p.text(`${c.name}: ${c.meaning}`, lx + 46, ly + 32 + i * 28, 13, PAPER, FONT.body, lw - 60, 22);
    });
    const by = ly + 60 + COLOR_LANGUAGE.length * 28;
    if (canContinue) p.button("continue", w / 2 - 230, by, 220, 44, "CONTINUE", "red");
    p.button("new", canContinue ? w / 2 + 10 : w / 2 - 110, by, 220, 44, "NEW MISSION", canContinue ? "dark" : "red");
    if (summary) p.textC(summary, w / 2, by + 54, 13, [1, 1, 1, 0.8], FONT.body);
    const keys = ["move", "direct", "recall", "select", "jump", "camera", "talk", "pipe", "stall", "gather"];
    const cx = (w - 760) / 2, cy = by + 86;
    p.panel(cx, cy, 760, 22 + Math.ceil(keys.length / 2) * 22, [0, 0, 0, 0.45]);
    keys.forEach((k, i) => {
        const b = BINDINGS[k], col = i % 2, row = Math.floor(i / 2);
        p.text(`${b.what}:  ${device === "pad" ? b.pad : b.keys}`, cx + 16 + col * 380, cy + 8 + row * 22, 12, [1, 1, 1, 0.85], FONT.body, 370, 20);
    });
    void time;
}

export function drawStory(p: Painter, w: number, h: number, title: string, lines: string[], age: number, prompt: string): void {
    p.panel(0, 0, w, h, [0, 0, 0, 0.78]);
    p.textC(title, w / 2, h * 0.18, 36, PAPER, FONT.head);
    lines.forEach((l, i) => {
        const a = Math.max(0, Math.min(1, age * 0.9 - i * 0.7));
        p.textC(l, w / 2, h * 0.3 + i * 40, 18, [1, 1, 1, a], FONT.body);
    });
    if (age > lines.length * 0.75) p.textC(prompt, w / 2, h * 0.3 + lines.length * 40 + 40, 15, [0.55, 0.85, 1, 0.6 + 0.4 * Math.sin(age * 4)], FONT.body);
}

export const LESSONS: Record<string, { title: string; text: string }> = {
    direct: { title: "Point and click", text: "Aim at anything and click: the selected swarm goes and does the obvious thing there. Then the next swarm is selected, so the next click sends it." },
    autoselect: { title: "One click per swarm", text: "After an order the selection moves on by itself. Tab or 1-8 picks a swarm; right click calls the selected one back." },
    fruit: { title: "Magenta is food", text: "Send a swarm to a fruit tree: they shake it and eat. Every three fruit a swarm eats, one Tone splits into two." },
    split: { title: "A Tone split in two", text: "Swarms grow up to twelve. A swarm of six or more can divide into two swarms [V] - handy for two switches." },
    crate: { title: "Crates", text: "A swarm breaks a crate. Amber relics inside are carried home to you by the Tones themselves." },
    shop: { title: "Amber is treasure", text: "Relics sell at Bodhi's stall for chimes [B near Bodhi]. Chimes teach a swarm a trait: claws, wings, blasters and more." },
    stall: { title: "Bodhi trades", text: "Press B near Bodhi to sell relics and buy traits for any swarm, or hatch a new swarm of three." },
    switch: { title: "Teal is a mechanism", text: "A switch plate needs weight: each Tone is one (Heft makes it two). Gates stay open only while their plates are held." },
    climb: { title: "Only claws climb", text: "That is up a teal-marked cliff. Hop Tones have claws - or buy Climbing Claws for another swarm." },
    portal: { title: "The rings are roads", text: "Only Tones that phase can walk a teal ring to its pair. Violet Lulls phase; Bodhi sells Phase too." },
    water: { title: "Deep water", text: "Tones sink in deep water. Swarms with Wings fly over it." },
    fade: { title: "A Tone has fallen", text: "It lies as a grey ghost note for twenty seconds. Walk over it, or send its swarm there, to bring it back. After that it passes away." },
    dark: { title: "Red is the Corruption", text: "Clear the corrupted creatures, then send swarms to the red heart: they sing at it until it is pure." },
    anchors: { title: "Anchors", text: "Red threads feed the giant from its anchors. Send swarms to sing each anchor pure; only then can they hurt it." },
    slam: { title: "The slam", text: "A red ring rolls out along the ground. Jump [Space] as it passes. Flying Tones are safe from it." },
    freed: { title: "A new swarm", text: "Tones the Corruption had swallowed are free, and they follow you now. Their kind can hatch at Bodhi's stall too." },
    jam: { title: "Answer the music", text: "Press F near a player to jam: listen to the phrase, then echo it on your Prism Pipe with 1-5." },
    gathering: { title: "No song yet", text: "Hoolu the owl can teach you the Gathering Song. Until then, call swarms back one by one with right click." },
    down: { title: "You fell", text: "The Link pulls you back to the last place your Tones made safe. Your swarms come with you." },
};
