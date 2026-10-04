// Allegiance's in-game UI kit, drawn only with Entropy.UI.drawRect and drawText - no GUI widgets -
// so it can look like a 2100 propaganda poster: hard black bars, blood red, aged cream paper,
// gold stars, stamped headlines.
//
// The engine keeps rects and texts until UI.clear(), and building a text means rasterizing it, so
// the UI is retained: each screen describes its whole frame into a Painter, and the Painter
// resubmits to the engine only when that description changed. Clicks are hit-tested against the
// buttons the last frame registered.
//
// Draw order in the engine: every rect, then every text (each text's background fill right before
// it). So a panel that must cover text drawn earlier is emitted as a text with a background fill
// (`panel`), which keeps it in order with the texts.

export type Color = [number, number, number, number];

export const THEME = {
    red: [0.78, 0.06, 0.09, 1] as Color,
    redDark: [0.45, 0.03, 0.05, 1] as Color,
    black: [0.05, 0.045, 0.045, 1] as Color,
    ink: [0.09, 0.08, 0.08, 0.92] as Color,
    cream: [0.95, 0.9, 0.78, 1] as Color,
    paper: [0.9, 0.84, 0.7, 1] as Color,
    gold: [0.98, 0.78, 0.2, 1] as Color,
    grey: [0.55, 0.52, 0.48, 1] as Color,
    /** Secondary text on cream paper. */
    inkSoft: [0.3, 0.26, 0.22, 1] as Color,
    dim: [0.72, 0.68, 0.6, 1] as Color,
    green: [0.35, 0.8, 0.4, 1] as Color,
    blue: [0.35, 0.6, 0.95, 1] as Color,
    shade: [0, 0, 0, 0.55] as Color,
    clear: [0, 0, 0, 0] as Color,
};

/** Fonts: a stencil-poster face for headlines, a condensed one for numbers, a plain one for prose. */
export const FONT = { head: "Bungee", num: "Vina Sans", body: "Play", mono: "Play" };

/** Rough advance width per character (fraction of the font size), for centering and fitting. */
const ADVANCE: Record<string, number> = { Bungee: 0.72, "Vina Sans": 0.42, Exo: 0.52, Play: 0.5 };

export function textWidth(text: string, size: number, font: string = FONT.body): number {
    return text.length * size * (ADVANCE[font] ?? 0.55);
}

export type ButtonStyle = "red" | "dark" | "paper" | "ghost";
export interface ButtonOpts { disabled?: boolean; size?: number; overText?: boolean; active?: boolean }

export interface Button { id: string; x: number; y: number; w: number; h: number; disabled?: boolean }

type Op =
    | { k: "r"; x: number; y: number; w: number; h: number; c: Color; sw: number; sc: Color }
    | { k: "t"; s: string; x: number; y: number; w: number; h: number; size: number; c: Color; f: string; bg: Color };

const r1 = (v: number) => Math.round(v * 10) / 10;

export class Painter {
    private ops: Op[] = [];
    private lastSig = "";
    buttons: Button[] = [];
    private pending: Button[] = [];
    /** Button under the pointer (for hover highlights), set by the addon. */
    hover: string | null = null;
    pressed: string | null = null;
    /** How many times the engine was asked to redraw (for tests and the HUD's diagnostics). */
    submits = 0;

    constructor(private readonly engine: { clear(): void; rect(o: Op & { k: "r" }): void; text(o: Op & { k: "t" }): void }) {}

    begin(): void {
        this.ops = [];
        this.pending = [];
    }

    rect(x: number, y: number, w: number, h: number, c: Color, strokeWidth = 0, stroke: Color = THEME.clear): void {
        if (w <= 0 || h <= 0) return;
        this.ops.push({ k: "r", x: r1(x), y: r1(y), w: r1(w), h: r1(h), c, sw: strokeWidth, sc: stroke });
    }

    /** Text with its top-left at (x, y), wrapped to `w`. */
    text(s: string, x: number, y: number, size: number, c: Color, font: string = FONT.body, w = 0, h = 0, bg: Color = THEME.clear): void {
        if (!s) return;
        const width = w || Math.max(8, textWidth(s, size, font) * 1.15 + size);
        this.ops.push({ k: "t", s, x: r1(x), y: r1(y), w: r1(width), h: r1(h || size * 1.6), size, c, f: font, bg });
    }

    /** Centered on x. */
    textC(s: string, cx: number, y: number, size: number, c: Color, font: string = FONT.body): void {
        this.text(s, cx - textWidth(s, size, font) / 2, y, size, c, font);
    }

    /** Right-aligned to x. */
    textR(s: string, rx: number, y: number, size: number, c: Color, font: string = FONT.body): void {
        this.text(s, rx - textWidth(s, size, font), y, size, c, font);
    }

    /** A filled block that sits above any text drawn before it (see the file comment). */
    panel(x: number, y: number, w: number, h: number, c: Color): void {
        this.ops.push({ k: "t", s: " ", x: r1(x), y: r1(y), w: r1(w), h: r1(h), size: 8, c: THEME.clear, f: FONT.body, bg: c });
    }

    /** A clickable button. Styles: "red" (primary), "dark", "paper", "ghost". */
    button(id: string, x: number, y: number, w: number, h: number, label: string, style: ButtonStyle = "dark", opts: ButtonOpts = {}): void {
        const hot = this.hover === id && !opts.disabled;
        const active = !!opts.active;
        let fill: Color, ink: Color, edge: Color;
        switch (style) {
            case "red": fill = hot ? [0.9, 0.12, 0.14, 1] : THEME.red; ink = THEME.cream; edge = THEME.black; break;
            case "paper": fill = hot ? [1, 0.96, 0.85, 1] : THEME.paper; ink = THEME.black; edge = THEME.black; break;
            case "ghost": fill = hot ? [1, 1, 1, 0.12] : [0, 0, 0, 0.25]; ink = THEME.cream; edge = [1, 1, 1, 0.25]; break;
            default: fill = hot ? [0.22, 0.2, 0.19, 1] : THEME.black; ink = THEME.cream; edge = [0.95, 0.9, 0.78, 0.35]; break;
        }
        if (active) { fill = THEME.gold; ink = THEME.black; }
        if (opts.disabled) { fill = [0.2, 0.19, 0.18, 0.8]; ink = THEME.grey; }
        const size = opts.size ?? Math.min(16, Math.max(11, h * 0.42));
        if (opts.overText) this.panel(x, y, w, h, fill);
        else this.rect(x, y, w, h, fill, 2, edge);
        const font = FONT.head;
        const tw = textWidth(label, size, font);
        this.text(label, x + Math.max(6, (w - tw) / 2), y + (h - size * 1.25) / 2, size, ink, font);
        this.pending.push({ id, x, y, w, h, disabled: opts.disabled });
    }

    /** A click area with nothing drawn (map dots, list rows, cards). */
    hotspot(id: string, x: number, y: number, w: number, h: number): void {
        this.pending.push({ id, x, y, w, h });
    }

    /** A labeled meter: track, fill and an optional tick. */
    bar(x: number, y: number, w: number, h: number, value: number, fill: Color, track: Color = [0, 0, 0, 0.6]): void {
        this.rect(x, y, w, h, track, 1, [1, 1, 1, 0.2]);
        this.rect(x + 1, y + 1, Math.max(0, (w - 2) * Math.max(0, Math.min(1, value))), h - 2, fill);
    }

    /** A poster headline: black slab with a red underline. */
    slab(x: number, y: number, w: number, title: string, size = 20): number {
        const h = size * 1.7;
        this.rect(x, y, w, h, THEME.black);
        this.rect(x, y + h, w, 4, THEME.red);
        this.text(title, x + 12, y + (h - size * 1.25) / 2, size, THEME.cream, FONT.head);
        return y + h + 4;
    }

    /** A row of five-pointed "stars" (diamond blocks, the poster's decoration). */
    stars(x: number, y: number, n: number, size: number, c: Color = THEME.gold): void {
        for (let i = 0; i < n; i++) {
            const cx = x + i * size * 1.6;
            this.rect(cx, y + size * 0.35, size, size * 0.3, c);
            this.rect(cx + size * 0.35, y, size * 0.3, size, c);
        }
    }

    /** Sends the frame to the engine if it changed. Returns true when it redrew. */
    flush(): boolean {
        this.buttons = this.pending;
        const sig = JSON.stringify(this.ops) + (this.hover ?? "");
        if (sig === this.lastSig) return false;
        this.lastSig = sig;
        this.engine.clear();
        for (const op of this.ops) {
            if (op.k === "r") this.engine.rect(op);
            else this.engine.text(op);
        }
        this.submits++;
        return true;
    }

    /** Forces the next flush to redraw (after something else cleared the UI). */
    invalidate(): void { this.lastSig = ""; }

    hit(x: number, y: number): Button | null {
        for (let i = this.buttons.length - 1; i >= 0; i--) {
            const b = this.buttons[i];
            if (x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h) return b.disabled ? null : b;
        }
        return null;
    }

    opCount(): number { return this.ops.length; }
}

/** The painter wired to an addon's UI (drawRect/drawText/clear live on the scoped addon API). */
export interface DrawApi {
    clear(): void;
    drawRect(c: { position: [number, number]; size: [number, number]; color: Color; strokeThickness: number; strokeColor: Color }): void;
    drawText(c: { text: string; position: [number, number]; dimensions: [number, number]; fontSize: number; color: Color; fontFamily: string; backgroundFill: Color }): void;
}

export function enginePainter(api: DrawApi): Painter {
    return new Painter({
        clear: () => api.clear(),
        rect: o => api.drawRect({ position: [o.x, o.y], size: [o.w, o.h], color: o.c, strokeThickness: o.sw, strokeColor: o.sc }),
        text: o => api.drawText({ text: o.s, position: [o.x, o.y], dimensions: [o.w, o.h], fontSize: o.size, color: o.c, fontFamily: o.f, backgroundFill: o.bg }),
    });
}

// --- Formatting ----------------------------------------------------------------------------------

export const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
export const money = (n: number): string => `${n < 0 ? "-" : ""}CR ${fmt(Math.abs(n))}`;
export const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
export function big(n: number): string {
    const a = Math.abs(n);
    if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
    return fmt(n);
}

export const withAlpha = (c: Color | [number, number, number], a: number): Color => [c[0], c[1], c[2], a];
