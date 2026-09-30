// The Guitar Tabs app's model: reading a pasted ASCII tab, the spreadsheet it is reviewed in, where the
// fingers go, and which detector mode each part of the song wants. No `Entropy` calls, so it all runs
// under vitest as it is (tests/guitar_tabs.test.ts). Grading a performance is in tab_practice.ts.
//
// Strings are numbered as the guitar engine numbers them (src/guitar/tab.rs): 0 is the lowest string,
// 5 the highest. A written tab lists them the other way up, highest first.

export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64];
export const STRINGS = 6;
export const MAX_FRET = 24;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function noteName(midi: number): string {
    return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** A pitch class name without the octave: "C#". */
export function pitchName(midi: number): string {
    return NOTE_NAMES[((midi % 12) + 12) % 12];
}

/** How a tab names a string: the lowest string upper case, the highest lower case ("E A D G B e"). */
export function stringLabel(tuning: number[], s: number): string {
    const name = pitchName(tuning[s]);
    return s === tuning.length - 1 && name === pitchName(tuning[0]) ? name.toLowerCase() : name;
}

export interface TuningPreset { id: string; label: string; tuning: number[] }

export const TUNINGS: TuningPreset[] = [
    { id: "standard", label: "Standard (E A D G B e)", tuning: [40, 45, 50, 55, 59, 64] },
    { id: "drop_d", label: "Drop D (D A D G B e)", tuning: [38, 45, 50, 55, 59, 64] },
    { id: "half_down", label: "Half step down (Eb)", tuning: [39, 44, 49, 54, 58, 63] },
    { id: "full_down", label: "Whole step down (D)", tuning: [38, 43, 48, 53, 57, 62] },
    { id: "dadgad", label: "DADGAD", tuning: [38, 45, 50, 55, 57, 62] },
    { id: "open_g", label: "Open G (D G D G B D)", tuning: [38, 43, 50, 55, 59, 62] },
    { id: "open_d", label: "Open D (D A D F# A D)", tuning: [38, 45, 50, 54, 57, 62] },
];

export function tuningPresetIndex(tuning: number[]): number {
    return TUNINGS.findIndex(t => t.tuning.every((n, i) => n === tuning[i]));
}

// --- The song ------------------------------------------------------------------------------------

/** Letters a tab writes right after a fret: hammer-on, pull-off, bend, release, slides, vibrato. */
export const TECHNIQUES = "hpbr/\\~s";

export interface TabNote {
    /** 0 = lowest string. */
    string: number;
    fret: number;
    /** A technique written after the fret ("h", "p", "b", "/", ...), for display. */
    tech?: string;
}

/** How the guitar engine should listen to a step: one note at a time with bends (pick mode), or
 * several strings at once (chord mode). `auto` lets the song decide (see `polyphonyPlan`). */
export type PlayAs = "auto" | "pick" | "chord";

export interface TabStep {
    notes: TabNote[];
    /** Strings struck muted ("x" in the tab). Shown, never graded. */
    muted: number[];
    /** 1-based bar number. */
    bar: number;
    /** Length until the next step, in beats. */
    beats: number;
    playAs?: PlayAs;
}

export interface TabSong {
    title: string;
    /** MIDI note of each open string, lowest first. */
    tuning: number[];
    bpm: number;
    steps: TabStep[];
}

export function emptySong(): TabSong {
    return { title: "Untitled tab", tuning: [...STANDARD_TUNING], bpm: 90, steps: [] };
}

export function midiOf(song: TabSong, n: TabNote): number {
    return song.tuning[n.string] + n.fret;
}

/** The notes a step sounds, lowest first, without repeats. */
export function stepMidi(song: TabSong, step: TabStep): number[] {
    return [...new Set(step.notes.map(n => midiOf(song, n)))].sort((a, b) => a - b);
}

/** "G2 B2 D3" for a chord, or one name. */
export function stepNotesText(song: TabSong, step: TabStep): string {
    return stepMidi(song, step).map(noteName).join(" ");
}

// --- Reading a pasted tab ------------------------------------------------------------------------

export interface ParseResult {
    song: TabSong;
    /** Blocks of six tab lines found. */
    systems: number;
    bars: number;
    warnings: string[];
}

const TAB_BODY_CHARS = /[-0-9|hpbrxX\/\\~().*<>=^vsSPMt:\s\[\]]/;

interface LineHead { name: string | null; body: string }

/** Splits a tab line into its string name and what follows the first bar line: "e|--0--|" is
 * { name: "e", body: "--0--|" }. Null for anything that is not a tab line. */
export function readTabLine(line: string): LineHead | null {
    const m = /^\s*([A-Ga-g][#b]?)?\s*([|:\[])?(.*)$/.exec(line);
    if (!m) return null;
    const name = m[1] ?? null;
    if (!name && !m[2] && !/^\s*-/.test(line)) return null;
    if (name && !m[2] && !/^[-\d]/.test(m[3])) return null;
    const body = m[3].replace(/\s+$/, "");
    const dashes = (body.match(/-/g) ?? []).length;
    if (dashes < 3) return null;
    const chars = [...body];
    const allowed = chars.filter(c => TAB_BODY_CHARS.test(c)).length;
    if (allowed / chars.length < 0.9) return null;
    const solid = chars.filter(c => c !== " ").length;
    if (dashes / Math.max(1, solid) < 0.3) return null;
    return { name, body };
}

/** The octave for each named string: the one nearest the standard-tuned string in its place. */
export function tuningFromNames(names: string[]): number[] | null {
    if (names.length !== STRINGS) return null;
    const out: number[] = [];
    for (let s = 0; s < STRINGS; s++) {
        const m = /^([A-Ga-g])([#b]?)$/.exec(names[s]);
        if (!m) return null;
        let pc = NOTE_NAMES.indexOf(m[1].toUpperCase());
        if (m[2] === "#") pc += 1;
        if (m[2] === "b") pc -= 1;
        pc = ((pc % 12) + 12) % 12;
        const ref = STANDARD_TUNING[s];
        let best = ref, bestDist = 99;
        for (let midi = ref - 12; midi <= ref + 12; midi++) {
            if (((midi % 12) + 12) % 12 !== pc) continue;
            // Down-tunings are far more common than tuning up, so a tie goes down.
            const dist = Math.abs(midi - ref) + (midi > ref ? 0.5 : 0);
            if (dist < bestDist) { bestDist = dist; best = midi; }
        }
        out.push(best);
    }
    return out;
}

/** "Tuning: D A D G B E", "Tuning: DADGAD", "Drop D". */
function tuningFromText(line: string): number[] | null {
    if (/\bdrop\s*d\b/i.test(line)) return [...TUNINGS[1].tuning];
    const m = /tuning\s*[:=-]?\s*(.+)$/i.exec(line);
    if (!m) return null;
    if (/standard/i.test(m[1])) return [...STANDARD_TUNING];
    const names = m[1].match(/[A-Ga-g][#b]?/g);
    return names && names.length === STRINGS ? tuningFromNames(names) : null;
}

interface RawNote { line: number; start: number; end: number; fret: number; tech?: string; muted?: boolean }

/** Reads an ASCII tab: six lines per system, highest string on top (a tab written lowest string
 * first is recognised by its string names), frets of one or two digits, bar lines, "x" for a muted
 * string, techniques after a fret. Notes whose columns overlap across strings are one step (a
 * chord); how far apart steps sit sets their length in beats. */
export function parseTab(text: string, fallbackTuning: number[] = STANDARD_TUNING): ParseResult {
    const warnings: string[] = [];
    const lines = text.replace(/\t/g, "    ").split(/\r?\n/);
    const song = emptySong();
    song.tuning = [...fallbackTuning];
    let titled = false;
    let tuningSet = false;

    // Consecutive tab lines form a block; everything else is prose, some of which we can read.
    const blocks: { heads: LineHead[]; first: number; letRing: boolean }[] = [];
    let current: { heads: LineHead[]; first: number; letRing: boolean } | null = null;
    let letRingNext = false;
    lines.forEach((line, i) => {
        const head = readTabLine(line);
        if (head) {
            if (!current) { current = { heads: [], first: i, letRing: letRingNext }; blocks.push(current); letRingNext = false; }
            current.heads.push(head);
            return;
        }
        current = null;
        const t = line.trim();
        if (!t) return;
        // "let ring" over a system: its notes overlap, so it is heard in chord mode.
        if (/let\s*ring/i.test(t)) { letRingNext = true; return; }
        const tuning = tuningFromText(t);
        if (tuning) { song.tuning = tuning; tuningSet = true; return; }
        const bpm = /(?:tempo|bpm)\s*[:=]?\s*(\d{2,3})|(\d{2,3})\s*bpm/i.exec(t);
        if (bpm) { song.bpm = clampBpm(parseInt(bpm[1] ?? bpm[2], 10)); return; }
        if (!titled && blocks.length === 0 && t.length <= 60 && !/-{3,}/.test(t)) {
            song.title = t.replace(/^title\s*[:=]\s*/i, "");
            titled = true;
        }
    });

    // Split each block into systems of six strings, dropping annotation rows (palm-mute marks and
    // the like) that happen to look like tab lines.
    const systems: LineHead[][] = [];
    const letRing = new Set<number>();
    for (const block of blocks) {
        let heads = block.heads;
        if (heads.length % STRINGS !== 0) {
            const kept = heads.filter(h => !/P\.?M|let ring|harm/i.test(h.body));
            const named = kept.filter(h => h.name);
            heads = kept.length % STRINGS === 0 ? kept : named.length > 0 && named.length % STRINGS === 0 ? named : heads;
        }
        if (heads.length % STRINGS !== 0) {
            warnings.push(`Skipped a block of ${heads.length} tab lines near line ${block.first + 1}: a guitar system has 6.`);
            continue;
        }
        for (let i = 0; i < heads.length; i += STRINGS) {
            if (block.letRing) letRing.add(systems.length);
            systems.push(heads.slice(i, i + STRINGS));
        }
    }
    if (systems.length === 0) {
        warnings.push("No tab found. Paste six lines per system, like e|---0---|.");
        return { song, systems: 0, bars: 0, warnings };
    }

    // Orientation and tuning from the first system that names its strings.
    const named = systems.find(sys => sys.every(h => h.name));
    let lowFirst = false;
    if (named) {
        const names = named.map(h => h.name!);
        lowFirst = names[0] === "E" && names[5] === "e" || (names[0] === names[0].toUpperCase() && names[5] !== names[5].toUpperCase() && names[0].toLowerCase() === names[5]);
        const low = lowFirst ? names : [...names].reverse();
        const t = tuningFromNames(low);
        if (t && !tuningSet) song.tuning = t;
    }

    // Columns per beat, from the bars: most tabs write a 4/4 bar in 16 to 32 columns.
    const barWidths: number[] = [];
    for (const sys of systems) {
        const body = sys[0].body;
        let last = -1;
        for (let c = 0; c < body.length; c++) {
            if (isBarColumn(sys, c)) {
                if (last >= 0 && c - last > 2) barWidths.push(c - last - 1);
                last = c;
            }
        }
        if (last === -1) barWidths.push(body.length);
    }

    const stepsWithCols: { step: TabStep | null; start: number; systemEnd: number; barsBefore: number }[] = [];
    systems.forEach((sys, sysIndex) => {
        const rows = lowFirst ? sys : [...sys].reverse();
        const raw: RawNote[] = [];
        rows.forEach((h, s) => readNotes(h.body, s, raw));
        raw.sort((a, b) => a.start - b.start || a.line - b.line);
        const width = Math.max(...sys.map(h => h.body.length));
        const barCols: number[] = [];
        for (let c = 0; c < width; c++) if (isBarColumn(sys, c)) barCols.push(c);

        // Group overlapping notes into steps.
        const groups: { start: number; end: number; notes: RawNote[] }[] = [];
        for (const n of raw) {
            const g = groups[groups.length - 1];
            if (g && n.start <= g.end) {
                g.notes.push(n);
                g.end = Math.max(g.end, n.end);
            } else groups.push({ start: n.start, end: n.end, notes: [n] });
        }
        for (const g of groups) {
            // A provisional bar id: bars are renumbered 1, 2, 3... once every system is read.
            const bar = sysIndex * 1000 + barCols.filter(c => c < g.start).length;
            const notes: TabNote[] = [];
            const muted: number[] = [];
            for (const n of g.notes) {
                if (n.muted) { if (!muted.includes(n.line)) muted.push(n.line); continue; }
                if (notes.some(x => x.string === n.line)) continue;
                notes.push(n.tech ? { string: n.line, fret: n.fret, tech: n.tech } : { string: n.line, fret: n.fret });
            }
            notes.sort((a, b) => a.string - b.string);
            if (notes.length === 0) continue;
            const step: TabStep = { notes, muted: muted.filter(s => !notes.some(n => n.string === s)).sort(), bar, beats: 1 };
            if (letRing.has(sysIndex)) step.playAs = "chord";
            stepsWithCols.push({ step, start: g.start, systemEnd: width, barsBefore: bar - sysIndex * 1000 });
        }
        // The next system's steps are measured from their own columns.
        stepsWithCols.push({ step: null, start: -1, systemEnd: width, barsBefore: barCols.length });
    });

    const colsPerBeat = Math.max(1, median(barWidths) / 4);
    for (let i = 0; i < stepsWithCols.length; i++) {
        const cur = stepsWithCols[i];
        if (!cur.step) continue;
        const next = stepsWithCols[i + 1];
        // Bar lines take a column of the text but no time.
        const gap = next && next.step
            ? next.start - cur.start - (next.barsBefore - cur.barsBefore)
            : Math.max(colsPerBeat, cur.systemEnd - cur.start - (next ? next.barsBefore - cur.barsBefore : 0));
        cur.step.beats = quantizeBeats(gap / colsPerBeat);
        song.steps.push(cur.step);
    }
    // Renumber bars from 1 without holes (bars that held nothing are dropped).
    const barMap = new Map<number, number>();
    for (const s of song.steps) {
        if (!barMap.has(s.bar)) barMap.set(s.bar, barMap.size + 1);
        s.bar = barMap.get(s.bar)!;
    }
    const tooHigh = song.steps.some(s => s.notes.some(n => n.fret > MAX_FRET));
    if (tooHigh) warnings.push(`Frets above ${MAX_FRET} were read; check the two-digit numbers.`);
    return { song, systems: systems.length, bars: barMap.size, warnings };
}

function clampBpm(v: number): number {
    return Math.min(300, Math.max(20, Number.isFinite(v) ? v : 90));
}

function isBarColumn(sys: LineHead[], c: number): boolean {
    let n = 0;
    for (const h of sys) if (h.body[c] === "|") n++;
    return n >= 4;
}

function readNotes(body: string, line: number, out: RawNote[]) {
    for (let p = 0; p < body.length; p++) {
        const ch = body[p];
        if ((ch === "x" || ch === "X") && !/[0-9]/.test(body[p - 1] ?? "")) {
            out.push({ line, start: p, end: p, fret: 0, muted: true });
            continue;
        }
        if (!/[0-9]/.test(ch) || /[0-9]/.test(body[p - 1] ?? "")) continue;
        let text = ch;
        if (/[0-9]/.test(body[p + 1] ?? "") && parseInt(ch + body[p + 1], 10) <= MAX_FRET) text += body[p + 1];
        const end = p + text.length - 1;
        const after = body[end + 1] ?? "";
        const tech = TECHNIQUES.includes(after) && after !== "" ? after : undefined;
        out.push({ line, start: p, end, fret: parseInt(text, 10), tech });
        p = end;
    }
}

function median(values: number[]): number {
    if (values.length === 0) return 8;
    const v = [...values].sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
}

/** Lengths come out of column counts, so they are rounded to quarter beats and kept to 1/4..4. */
export function quantizeBeats(b: number): number {
    if (!Number.isFinite(b)) return 1;
    return Math.min(4, Math.max(0.25, Math.round(b * 4) / 4));
}

/** Writes a song back out as ASCII tab (highest string on top), one line per 32 or so columns. */
export function songToTabText(song: TabSong): string {
    const out: string[] = [];
    if (song.title) out.push(song.title);
    out.push(`Tuning: ${song.tuning.map((_, s) => stringLabel(song.tuning, s)).join(" ")}`);
    out.push(`Tempo: ${song.bpm}`);
    const labels = song.tuning.map((_, s) => stringLabel(song.tuning, s));
    const width = Math.max(...labels.map(l => l.length));
    let rows = labels.map(() => "");
    let bar = song.steps[0]?.bar ?? 1;
    let barsInLine = 0;
    const flush = () => {
        if (!rows[0]) return;
        for (let s = STRINGS - 1; s >= 0; s--) out.push(labels[s].padEnd(width) + "|" + rows[s] + "|");
        out.push("");
        rows = labels.map(() => "");
        barsInLine = 0;
    };
    for (const step of song.steps) {
        if (step.bar !== bar) {
            bar = step.bar;
            barsInLine++;
            if (barsInLine >= 4) flush();
            else rows = rows.map(r => r + "|");
        }
        const cells = rows.map((_, s) => {
            const n = step.notes.find(x => x.string === s);
            if (n) return String(n.fret) + (n.tech ?? "");
            return step.muted.includes(s) ? "x" : "";
        });
        const w = Math.max(1, ...cells.map(c => c.length));
        const pad = Math.max(1, Math.round(step.beats * 2));
        rows = rows.map((r, s) => r + "-" + cells[s].padEnd(w, "-") + "-".repeat(pad));
    }
    flush();
    return out.join("\n").trimEnd() + "\n";
}

// --- The review spreadsheet ----------------------------------------------------------------------
// Row 0 is a header; each step is a row after it. Columns: step number, bar, beats, the six strings
// highest first (as a tab reads), the notes they make, and how the step is listened to.

export const SHEET_COL = { step: 0, bar: 1, beats: 2, firstString: 3, notes: 9, playAs: 10 } as const;
export const SHEET_COLS = 11;

/** Sheet column of a string, highest string in the leftmost string column. */
export function sheetColOfString(s: number): number {
    return SHEET_COL.firstString + (STRINGS - 1 - s);
}

export function stringOfSheetCol(col: number): number | null {
    const k = col - SHEET_COL.firstString;
    return k >= 0 && k < STRINGS ? STRINGS - 1 - k : null;
}

export interface SheetCell { row: number; col: number; text: string; numeric?: boolean; error?: boolean; border?: [number, number, number, number] }

export function sheetHeader(song: TabSong): string[] {
    const h = ["Step", "Bar", "Beats"];
    for (let s = STRINGS - 1; s >= 0; s--) h.push(`${stringLabel(song.tuning, s)} string`);
    h.push("Notes", "Play as");
    return h;
}

/** What a cell shows (and what an edit starts from). */
export function sheetCellText(song: TabSong, plan: ("pick" | "chord")[], row: number, col: number): string {
    if (row === 0) return sheetHeader(song)[col] ?? "";
    const step = song.steps[row - 1];
    if (!step) return "";
    if (col === SHEET_COL.step) return String(row);
    if (col === SHEET_COL.bar) return String(step.bar);
    if (col === SHEET_COL.beats) return String(step.beats);
    if (col === SHEET_COL.notes) return stepNotesText(song, step);
    if (col === SHEET_COL.playAs) {
        const p = step.playAs ?? "auto";
        return p === "auto" ? `auto (${plan[row - 1] ?? "pick"})` : p;
    }
    const s = stringOfSheetCol(col);
    if (s === null) return "";
    const n = step.notes.find(x => x.string === s);
    if (n) return `${n.fret}${n.tech ?? ""}`;
    return step.muted.includes(s) ? "x" : "";
}

const HEADER_BORDER: [number, number, number, number] = [0.45, 0.62, 1.0, 0.9];
const CURRENT_BORDER: [number, number, number, number] = [1.0, 0.78, 0.36, 1.0];

/** Every non-empty cell of the review grid. `highlight` outlines one step's row (the one the
 * practice cursor is on, say). */
export function songToSheetCells(song: TabSong, highlight = -1): SheetCell[] {
    const plan = polyphonyPlan(song);
    const cells: SheetCell[] = [];
    for (let col = 0; col < SHEET_COLS; col++) cells.push({ row: 0, col, text: sheetCellText(song, plan, 0, col), border: HEADER_BORDER });
    song.steps.forEach((step, i) => {
        const row = i + 1;
        const unplayable = !stepPlayable(song, step);
        for (let col = 0; col < SHEET_COLS; col++) {
            const text = sheetCellText(song, plan, row, col);
            if (!text && i !== highlight) continue;
            const cell: SheetCell = { row, col, text, numeric: col <= SHEET_COL.beats || stringOfSheetCol(col) !== null };
            if (col === SHEET_COL.notes && unplayable) cell.error = true;
            if (i === highlight) cell.border = CURRENT_BORDER;
            cells.push(cell);
        }
    });
    return cells;
}

/** Two notes on one string can't sound together; frets must be on the neck. */
export function stepPlayable(song: TabSong, step: TabStep): boolean {
    const strings = new Set(step.notes.map(n => n.string));
    return strings.size === step.notes.length && step.notes.every(n => n.fret >= 0 && n.fret <= MAX_FRET && n.string >= 0 && n.string < STRINGS);
}

export interface EditOutcome { ok: boolean; error?: string }

/** Writes one edited cell back into the song. Row 0 and the derived Notes column are read-only.
 * A string cell takes a fret ("7"), a fret and a technique ("5h"), "x" for a muted string, or
 * nothing. Editing the row after the last step adds a step. */
export function applySheetEdit(song: TabSong, row: number, col: number, raw: string): EditOutcome {
    const text = raw.trim();
    if (row <= 0) return { ok: false, error: "The header row names the columns and cannot be edited." };
    if (col === SHEET_COL.step || col === SHEET_COL.notes) return { ok: false, error: "That column is worked out from the others." };
    if (row === song.steps.length + 1) {
        if (!text) return { ok: true };
        insertStep(song, song.steps.length);
    }
    const step = song.steps[row - 1];
    if (!step) return { ok: false, error: "Add steps in order: edit the row just below the last one." };
    if (col === SHEET_COL.bar) {
        const v = parseInt(text, 10);
        if (!(v >= 1 && v <= 9999)) return { ok: false, error: "A bar is a whole number from 1." };
        step.bar = v;
        return { ok: true };
    }
    if (col === SHEET_COL.beats) {
        const v = parseFloat(text);
        if (!(v > 0 && v <= 16)) return { ok: false, error: "Beats is a length above 0, up to 16 (0.5 is an eighth note at 4/4)." };
        step.beats = v;
        return { ok: true };
    }
    if (col === SHEET_COL.playAs) {
        const v = text.toLowerCase().replace(/\s*\(.*$/, "");
        if (v === "" || v === "auto") { delete step.playAs; return { ok: true }; }
        if (v === "pick" || v === "chord") { step.playAs = v; return { ok: true }; }
        return { ok: false, error: "Play as is auto, pick or chord." };
    }
    const s = stringOfSheetCol(col);
    if (s === null) return { ok: false, error: "No such column." };
    step.notes = step.notes.filter(n => n.string !== s);
    step.muted = step.muted.filter(m => m !== s);
    if (text === "") return { ok: true };
    if (/^x$/i.test(text)) { step.muted.push(s); step.muted.sort(); return { ok: true }; }
    const m = /^(\d{1,2})([hpbr\/\\~s]?)$/.exec(text);
    if (!m || parseInt(m[1], 10) > MAX_FRET) return { ok: false, error: `A fret is 0 to ${MAX_FRET}, optionally followed by h, p, b, r, /, \\, ~ or s; "x" is a muted string.` };
    const note: TabNote = { string: s, fret: parseInt(m[1], 10) };
    if (m[2]) note.tech = m[2];
    step.notes.push(note);
    step.notes.sort((a, b) => a.string - b.string);
    return { ok: true };
}

/** A new empty step at `index`, in the bar of the step before it. */
export function insertStep(song: TabSong, index: number) {
    const i = Math.max(0, Math.min(song.steps.length, index));
    const bar = song.steps[i - 1]?.bar ?? song.steps[i]?.bar ?? 1;
    song.steps.splice(i, 0, { notes: [], muted: [], bar, beats: 1 });
}

export function deleteStep(song: TabSong, index: number) {
    if (index >= 0 && index < song.steps.length) song.steps.splice(index, 1);
}

/** Steps with something to play: the ones practice walks through. */
export function playableSteps(song: TabSong): number[] {
    return song.steps.map((s, i) => (s.notes.length ? i : -1)).filter(i => i >= 0);
}

// --- Pick mode or chord mode ---------------------------------------------------------------------

/** The detector mode for each step. A step with two or more notes wants chord mode; a single note
 * wants pick mode (faster, with bends). Switching releases whatever sounds, so a short run of single
 * notes between chords (an arpeggio, a fill of one or two notes) stays in chord mode rather than
 * flapping back and forth. An explicit `playAs` always wins. */
export function polyphonyPlan(song: TabSong, shortRun = 3): ("pick" | "chord")[] {
    const base = song.steps.map(s => (s.playAs && s.playAs !== "auto" ? s.playAs : s.notes.length >= 2 ? "chord" : "pick") as "pick" | "chord");
    const out = [...base];
    let i = 0;
    while (i < out.length) {
        if (base[i] !== "pick" || song.steps[i].playAs === "pick") { i++; continue; }
        let j = i;
        while (j < out.length && base[j] === "pick" && song.steps[j].playAs !== "pick") j++;
        const chordBefore = i > 0 && base[i - 1] === "chord";
        const chordAfter = j < out.length && base[j] === "chord";
        if (chordBefore && chordAfter && j - i < shortRun) for (let k = i; k < j; k++) out[k] = "chord";
        // Single notes that ring on different strings right after a chord are an arpeggio of it.
        else if (chordBefore && j - i < shortRun * 2 && ringsAsArpeggio(song, i, j)) for (let k = i; k < j; k++) out[k] = "chord";
        i = j;
    }
    return out;
}

function ringsAsArpeggio(song: TabSong, from: number, to: number): boolean {
    const strings = song.steps.slice(from, to).map(s => s.notes[0]?.string);
    return new Set(strings).size === strings.length && song.steps.slice(from, to).every(s => s.beats <= 1);
}

// --- Where the fingers go ------------------------------------------------------------------------

export interface FingeredNote extends TabNote {
    midi: number;
    /** 0 for an open string, 1 (index) to 4 (little finger). A suggestion, not a rule. */
    finger: number;
}

/** The fret the index finger sits at around step `i`: the lowest fretted note of the step, or for a
 * single note, of its neighbours when they fit under one hand (four frets). */
export function handPosition(song: TabSong, i: number): number {
    const fretted = (k: number) => (song.steps[k]?.notes ?? []).map(n => n.fret).filter(f => f > 0);
    const own = fretted(i);
    if (own.length === 0) return Math.max(1, handPosition0(song, i));
    if (own.length > 1) return Math.min(...own);
    const f = own[0];
    const around: number[] = [];
    for (let k = i - 3; k <= i + 3; k++) around.push(...fretted(k).filter(x => Math.abs(x - f) <= 3));
    const lo = Math.min(...around, f);
    return f - lo <= 3 ? lo : f;
}

function handPosition0(song: TabSong, i: number): number {
    for (let d = 1; d < 6; d++) {
        for (const k of [i - d, i + d]) {
            const f = (song.steps[k]?.notes ?? []).map(n => n.fret).filter(x => x > 0);
            if (f.length) return Math.min(...f);
        }
    }
    return 1;
}

/** A step's notes with a suggested finger each: one finger per fret from the hand's position, and
 * where two notes want the same finger the higher string takes the next one - unless three or more
 * notes sit at the index finger's fret, which is a barre (F major: 1 3 4 2 1 1). */
export function fingerStep(song: TabSong, i: number): FingeredNote[] {
    const step = song.steps[i];
    if (!step) return [];
    const pos = handPosition(song, i);
    const fretted = step.notes.filter(n => n.fret > 0);
    const hi = fretted.length ? Math.max(...fretted.map(n => n.fret)) : pos;
    const span = hi - pos;
    const base = (fret: number) => span <= 3
        ? Math.min(4, Math.max(1, fret - pos + 1))
        : Math.min(4, Math.max(1, 1 + Math.round(((fret - pos) / span) * 3)));
    const barre = fretted.filter(n => n.fret === pos).length >= 3;
    const fingers = new Map<TabNote, number>();
    const used = new Set<number>();
    for (const n of [...fretted].sort((a, b) => a.fret - b.fret || a.string - b.string)) {
        let f = base(n.fret);
        if (!(barre && n.fret === pos && f === 1)) {
            while (used.has(f) && f < 4) f++;
        }
        used.add(f);
        fingers.set(n, f);
    }
    return step.notes.map(n => ({ ...n, midi: midiOf(song, n), finger: fingers.get(n) ?? 0 }));
}

/** Where a heard note most likely is: the string and fret nearest the hand's position. */
export function positionFor(midi: number, tuning: number[], hand: number): { string: number; fret: number } | null {
    let best: { string: number; fret: number } | null = null;
    let bestCost = Infinity;
    tuning.forEach((open, s) => {
        const fret = midi - open;
        if (fret < 0 || fret > MAX_FRET) return;
        const cost = fret === 0 ? 1.5 : Math.abs(fret - (hand + 1.5));
        if (cost < bestCost) { bestCost = cost; best = { string: s, fret }; }
    });
    return best;
}

/** The fret window worth drawing for a song: from just below its lowest fretted note to past its
 * highest, at least twelve frets, starting at the nut when the song is low on the neck. */
export function fretWindow(song: TabSong): [number, number] {
    const frets = song.steps.flatMap(s => s.notes.map(n => n.fret));
    if (frets.length === 0) return [0, 12];
    const lo = Math.min(...frets), hi = Math.max(...frets);
    let first = lo <= 4 ? 0 : lo - 1;
    let last = Math.max(hi + 2, first + 12);
    if (last > MAX_FRET) { last = MAX_FRET; first = Math.max(0, Math.min(first, last - 12)); }
    return [first, last];
}
