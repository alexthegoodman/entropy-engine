// The DAW's song templates as a browsable catalog: collections, a short write-up of each song
// (what it is, what to listen for), a search over them, and the rows of the template tree in the
// Songs window. Pure, so it can be tested without a window; the addon supplies each template's
// project.

export interface TemplateCollection {
    id: string;
    label: string;
    blurb: string;
}

export const TEMPLATE_COLLECTIONS: TemplateCollection[] = [
    { id: "start", label: "Start here", blurb: "An empty song, or a short demo to take apart." },
    { id: "beats", label: "Beats and dance", blurb: "32-bar grooves with a drum breakdown: EDM, house and hip hop." },
    { id: "cinematic", label: "Cinematic sketches", blurb: "32-bar scores for modeled strings and brass over a drum rack." },
    { id: "showcase", label: "Showcase", blurb: "64-bar productions using every kind of voice, with bus cuts before each drop." },
    { id: "film", label: "Film scores", blurb: "Full cues played only by physically modeled instruments: bowed strings, brass, the Matter kit and Water." },
];

export interface TemplateInfo {
    id: string;
    /** The name the new song gets, and the row's label in the browser. */
    name: string;
    collection: string;
    /** Genre or mood, a few words. */
    style: string;
    key?: string;
    blurb: string;
    /** What the song demonstrates: things to listen for or open up. */
    listen?: string[];
}

/** The minimum of a project the browser summarises. */
export interface TemplateProject {
    bpm: number;
    songBars: number;
    tracks: { name: string; kind: string; voice?: { waveform?: string }; instrument?: unknown; physmod?: { instrument?: string }; brass?: { instrument?: string }; water?: { play?: string } }[];
}

/** What a track is played by, in a few words. */
export function voiceFamily(t: TemplateProject["tracks"][number]): string {
    if (t.instrument) return "plugin";
    if (t.kind === "drum") return "drum rack";
    switch (t.voice?.waveform) {
        case "physmod": return `bowed ${t.physmod?.instrument ?? "string"}`;
        case "brass": return t.brass?.instrument ?? "brass";
        case "matter": return "Matter kit";
        case "water": return t.water?.play === "weather" ? "Water weather" : `Water ${t.water?.play === "drip" ? "drips" : t.water?.play === "fill" ? "fills" : "glass harp"}`;
        case "wavetable": return "wavetable";
        default: return `${t.voice?.waveform ?? "synth"} synth`;
    }
}

const MODELED = new Set(["physmod", "brass", "matter", "water"]);
/** Whether every track is a physically modeled instrument. */
export function allModeled(p: TemplateProject): boolean {
    return p.tracks.length > 0 && p.tracks.every(t => t.kind === "synth" && !t.instrument && MODELED.has(t.voice?.waveform ?? ""));
}

/** "2:05" for a song's length at its tempo. */
export function songLength(p: Pick<TemplateProject, "bpm" | "songBars">): string {
    const seconds = Math.round(p.songBars * 4 * 60 / Math.max(1, p.bpm));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One line under a template's name: tempo, key, length and size. */
export function templateFacts(info: TemplateInfo, p: TemplateProject): string {
    return [`${Math.round(p.bpm)} BPM`, info.key, `${p.songBars} bars (${songLength(p)})`, `${p.tracks.length} tracks`]
        .filter(Boolean).join(" · ");
}

/** Whether a template matches a search: every word must appear in its name, style, key,
 *  collection or write-up. */
export function matchesTemplate(info: TemplateInfo, query: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const collection = TEMPLATE_COLLECTIONS.find(c => c.id === info.collection)?.label ?? "";
    const text = [info.name, info.style, info.key ?? "", collection, info.blurb, ...(info.listen ?? [])].join(" ").toLowerCase();
    return words.every(w => text.includes(w));
}

export interface TemplateRow {
    id: string;
    label: string;
    depth: number;
    hasChildren?: boolean;
    expanded?: boolean;
    selected: boolean;
    icon?: string;
    detail: string;
}

export const COLLECTION_ROW = "collection:";
export const TEMPLATE_ROW = "template:";

/** The tree's rows: each collection with any matching templates, then its templates (unless the
 *  collection is collapsed). A search shows every collection with a match, expanded. */
export function templateRows(
    templates: TemplateInfo[],
    opts: { collection: string; query: string; collapsed: Set<string>; selected: string | null; detail: (t: TemplateInfo) => string },
): TemplateRow[] {
    const rows: TemplateRow[] = [];
    const searching = opts.query.trim() !== "";
    for (const c of TEMPLATE_COLLECTIONS) {
        if (opts.collection !== "all" && opts.collection !== c.id) continue;
        const inside = templates.filter(t => t.collection === c.id && matchesTemplate(t, opts.query));
        if (!inside.length) continue;
        const expanded = searching || !opts.collapsed.has(c.id);
        rows.push({ id: COLLECTION_ROW + c.id, label: c.label, depth: 0, hasChildren: true, expanded, selected: false,
            detail: `${inside.length} song${inside.length === 1 ? "" : "s"}` });
        if (!expanded) continue;
        for (const t of inside) {
            rows.push({ id: TEMPLATE_ROW + t.id, label: t.name, depth: 1, selected: t.id === opts.selected, detail: opts.detail(t) });
        }
    }
    return rows;
}
