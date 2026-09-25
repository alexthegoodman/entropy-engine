// DAW song library: many songs instead of one DAW.json, a version history per song, and a
// recycle bin. Pure logic over a tiny file-store interface (Entropy.IO.store in the app, a Map in
// the tests), so everything here can be tested without a window.
//
// On disk, under the DAW's store folder (`<dataDir>/DAW/`):
//
//   library.json                  the index: every song's name, dates and summary, and which is open
//   songs/<songId>.json           the song itself, rewritten (atomically) on every edit
//   versions/<songId>/index.json  that song's version history
//   versions/<songId>/<id>.json   one saved version
//
// The song file is the source of truth; the index is a fast listing that is rebuilt from the song
// files if it is ever lost. Version history works like a document app's, not a manual backup
// folder: a version is kept automatically every 10 minutes while a song is being changed, when a
// song is opened, and before a restore; you can also save a named version at any time. Automatic
// versions thin out as they age (all from the last hour, then one an hour for a day, one a day
// for a month, one a week after that); named versions are kept until you delete them.

export interface StoreEntry { name: string; isDir: boolean; size: number; modifiedMs: number }
/** The subset of `Entropy.IO.store` the library uses. */
export interface SongStore {
    read(path: string): string | null;
    write(path: string, text: string): void;
    list(path?: string): StoreEntry[];
    remove(path: string): boolean;
}

/** The minimum of a DAW project the library looks at: enough to summarise and compare songs. */
export interface ProjectShape {
    bpm: number;
    songBars: number;
    tracks: { id: string; name: string }[];
    arrangement: { id: string }[];
}

export interface SongStats { bpm: number; bars: number; tracks: number; clips: number }

export interface SongEntry extends SongStats {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    /** Set while the song is in Recently deleted. */
    deletedAt?: number;
}

export type VersionKind = "auto" | "opened" | "named" | "before-restore" | "imported";

export interface VersionEntry extends SongStats {
    id: string;
    at: number;
    kind: VersionKind;
    /** A named version's name; the others describe themselves by kind. */
    label?: string;
    /** Content fingerprint, so two identical automatic versions are never both kept. */
    hash: string;
    size: number;
}

export type SortMode = "recent" | "name" | "created";

export const AUTO_VERSION_INTERVAL_MS = 10 * 60 * 1000;
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_AUTO_VERSIONS = 100;
export const MAX_NAME_LENGTH = 60;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const LIBRARY_PATH = "library.json";
const songPath = (id: string) => `songs/${id}.json`;
const historyDir = (id: string) => `versions/${id}`;
const historyPath = (id: string) => `versions/${id}/index.json`;
const versionPath = (songId: string, versionId: string) => `versions/${songId}/${versionId}.json`;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

// --- Pure helpers -------------------------------------------------------------------------------

export function statsOf(project: ProjectShape): SongStats {
    return {
        bpm: project.bpm,
        bars: project.songBars,
        tracks: project.tracks?.length ?? 0,
        clips: project.arrangement?.length ?? 0,
    };
}

/** FNV-1a over the JSON text, plus its length: a cheap "is this the same content" check. */
export function fingerprint(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0") + "-" + text.length.toString(36);
}

/** Trims and bounds a name the user typed; an empty result means "not a name". */
export function cleanName(name: string): string {
    return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();
}

/** `base`, or `base 2`, `base 3`... - whichever is not taken yet (case-insensitively). */
export function uniqueName(base: string, taken: string[]): string {
    const clean = cleanName(base) || "Untitled song";
    const used = new Set(taken.map(n => n.toLocaleLowerCase()));
    if (!used.has(clean.toLocaleLowerCase())) return clean;
    const stem = clean.replace(/ \d+$/, "");
    for (let i = 2; ; i++) {
        const candidate = `${stem} ${i}`;
        if (!used.has(candidate.toLocaleLowerCase())) return candidate;
    }
}

export function sortSongs(songs: SongEntry[], mode: SortMode): SongEntry[] {
    const out = [...songs];
    if (mode === "name") out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || b.updatedAt - a.updatedAt);
    else if (mode === "created") out.sort((a, b) => b.createdAt - a.createdAt);
    else out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
}

export function filterSongs(songs: SongEntry[], query: string): SongEntry[] {
    const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return songs;
    return songs.filter(s => words.every(w => s.name.toLocaleLowerCase().includes(w)));
}

/**
 * Which automatic versions to throw away, Time Machine style: every version from the last hour,
 * the newest of each hour for the last day, of each day for the last 30 days, and of each week
 * before that, never more than MAX_AUTO_VERSIONS. The newest automatic version and every named
 * version always stay. Buckets are fixed calendar slots, so a version that survives one pass keeps
 * surviving until it ages into a coarser slot.
 */
export function versionsToPrune(versions: VersionEntry[], now: number): string[] {
    const autos = versions.filter(v => v.kind !== "named").sort((a, b) => b.at - a.at);
    const drop: string[] = [];
    const seen = new Set<string>();
    let kept = 0;
    autos.forEach((v, i) => {
        const age = now - v.at;
        let bucket: string | null = null;
        if (i === 0 || age < HOUR) bucket = null;
        else if (age < DAY) bucket = "h" + Math.floor(v.at / HOUR);
        else if (age < 30 * DAY) bucket = "d" + Math.floor(v.at / DAY);
        else bucket = "w" + Math.floor(v.at / WEEK);
        if ((bucket && seen.has(bucket)) || kept >= MAX_AUTO_VERSIONS) { drop.push(v.id); return; }
        if (bucket) seen.add(bucket);
        kept++;
    });
    return drop;
}

/** "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function timeAgo(at: number, now: number): string {
    const s = Math.max(0, now - at) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    const days = Math.floor(s / 86400);
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return formatDate(at);
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDate(at: number): string {
    const d = new Date(at);
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
export function formatClock(at: number): string {
    const d = new Date(at);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** A heading for the day a version belongs to: "Today", "Yesterday" or the date. */
export function dayHeading(at: number, now: number): string {
    const start = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((start(now) - start(at)) / DAY);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    return formatDate(at);
}

export function versionTitle(v: VersionEntry): string {
    switch (v.kind) {
        case "named": return v.label || "Named version";
        case "opened": return "Opened";
        case "before-restore": return v.label || "Before restoring";
        case "imported": return v.label || "Imported";
        default: return "Autosave";
    }
}

export function describeStats(s: SongStats): string {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return `${Math.round(s.bpm * 10) / 10} BPM · ${plural(s.bars, "bar")} · ${plural(s.tracks, "track")} · ${plural(s.clips, "clip")}`;
}

/** What restoring `from` would change about `to`, in a few words ("Same as now" if nothing). */
export function describeChanges(now: ProjectShape, version: ProjectShape): string[] {
    const out: string[] = [];
    if (now.bpm !== version.bpm) out.push(`Tempo ${now.bpm} to ${version.bpm} BPM`);
    if (now.songBars !== version.songBars) out.push(`Length ${now.songBars} to ${version.songBars} bars`);
    const nowIds = new Set(now.tracks.map(t => t.id));
    const verIds = new Set(version.tracks.map(t => t.id));
    const back = version.tracks.filter(t => !nowIds.has(t.id)).map(t => t.name);
    const gone = now.tracks.filter(t => !verIds.has(t.id)).map(t => t.name);
    if (back.length) out.push(`Brings back ${back.join(", ")}`);
    if (gone.length) out.push(`Removes ${gone.join(", ")}`);
    const renamed = version.tracks.filter(t => nowIds.has(t.id) && now.tracks.find(n => n.id === t.id)!.name !== t.name);
    if (renamed.length) out.push(`Track names differ: ${renamed.map(t => t.name).join(", ")}`);
    const clipDelta = version.arrangement.length - now.arrangement.length;
    if (clipDelta) out.push(`${Math.abs(clipDelta)} ${clipDelta > 0 ? "more" : "fewer"} clip${Math.abs(clipDelta) === 1 ? "" : "s"}`);
    if (!out.length) {
        out.push(JSON.stringify(now) === JSON.stringify(version) ? "Same as the song now" : "Different notes, sounds or clip positions");
    }
    return out;
}

// --- The library -------------------------------------------------------------------------------

interface LibraryIndex { format: "entropy-daw-library"; version: 1; currentSongId: string | null; songs: SongEntry[] }
interface SongFile<P> { format: "entropy-daw-song"; version: 1; id: string; name: string; savedAt: number; project: P }
interface HistoryIndex { format: "entropy-daw-history"; version: 1; songId: string; versions: VersionEntry[] }
interface VersionFile<P> { format: "entropy-daw-version"; version: 1; songId: string; entry: VersionEntry; project: P }

function isFiniteNumber(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v); }

function readSongEntry(raw: any): SongEntry | null {
    if (!raw || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id) || typeof raw.name !== "string") return null;
    const num = (v: unknown, d = 0) => (isFiniteNumber(v) ? v : d);
    const entry: SongEntry = {
        id: raw.id, name: cleanName(raw.name) || "Untitled song",
        createdAt: num(raw.createdAt), updatedAt: num(raw.updatedAt),
        bpm: num(raw.bpm, 120), bars: num(raw.bars), tracks: num(raw.tracks), clips: num(raw.clips),
    };
    if (isFiniteNumber(raw.deletedAt)) entry.deletedAt = raw.deletedAt;
    return entry;
}

function readVersionEntry(raw: any): VersionEntry | null {
    const kinds: VersionKind[] = ["auto", "opened", "named", "before-restore", "imported"];
    if (!raw || typeof raw.id !== "string" || !ID_PATTERN.test(raw.id) || !isFiniteNumber(raw.at) || !kinds.includes(raw.kind)) return null;
    const num = (v: unknown) => (isFiniteNumber(v) ? v : 0);
    const out: VersionEntry = {
        id: raw.id, at: raw.at, kind: raw.kind, hash: typeof raw.hash === "string" ? raw.hash : "",
        size: num(raw.size), bpm: num(raw.bpm), bars: num(raw.bars), tracks: num(raw.tracks), clips: num(raw.clips),
    };
    if (typeof raw.label === "string" && raw.label) out.label = cleanName(raw.label);
    return out;
}

export interface LibraryOptions {
    now: () => number;
    uuid: () => string;
}

export class SongLibrary<P extends ProjectShape> {
    songs: SongEntry[] = [];
    currentSongId: string | null = null;
    private indexDirty = false;
    private histories = new Map<string, VersionEntry[]>();
    // When each open song last got a version (or was opened), and whether it changed since - so an
    // automatic version is only kept when there is something new in it.
    private checkpointAt = new Map<string, number>();
    private changedSinceCheckpoint = new Set<string>();

    constructor(private readonly store: SongStore, private readonly opts: LibraryOptions) {}

    // --- Loading ------------------------------------------------------------------------------

    /** Reads the index, rebuilding it from the song files if it is missing or damaged, and empties
     * songs out of Recently deleted once they have been there for 30 days. */
    init(): void {
        let index: Partial<LibraryIndex> | null = null;
        try { index = JSON.parse(this.store.read(LIBRARY_PATH) ?? "null"); } catch { index = null; }
        if (index && index.format === "entropy-daw-library" && Array.isArray(index.songs)) {
            const ids = new Set<string>();
            this.songs = index.songs.map(readSongEntry).filter((s): s is SongEntry => !!s && !ids.has(s.id) && !!ids.add(s.id));
            this.currentSongId = typeof index.currentSongId === "string" ? index.currentSongId : null;
            // A song file written by a crash-interrupted session may be missing from the index.
            this.adoptUnindexedSongs();
        } else {
            this.songs = [];
            this.adoptUnindexedSongs();
        }
        if (this.currentSongId && !this.activeSongs().some(s => s.id === this.currentSongId)) this.currentSongId = null;
        const now = this.opts.now();
        for (const s of this.songs.filter(s => s.deletedAt !== undefined && now - s.deletedAt >= TRASH_RETENTION_MS)) this.deleteForever(s.id);
        if (this.indexDirty) this.flushIndex();
    }

    private adoptUnindexedSongs(): void {
        const known = new Set(this.songs.map(s => s.id));
        for (const file of this.store.list("songs")) {
            if (file.isDir || !file.name.endsWith(".json")) continue;
            const id = file.name.slice(0, -5);
            if (!ID_PATTERN.test(id) || known.has(id)) continue;
            try {
                const doc = JSON.parse(this.store.read(songPath(id)) ?? "null") as SongFile<P>;
                if (!doc?.project || !Array.isArray(doc.project.tracks)) continue;
                const at = isFiniteNumber(doc.savedAt) ? doc.savedAt : file.modifiedMs;
                this.songs.push({
                    id, name: uniqueName(typeof doc.name === "string" ? doc.name : "Recovered song", this.songs.map(s => s.name)),
                    createdAt: at, updatedAt: at, ...statsOf(doc.project),
                });
                this.indexDirty = true;
            } catch { /* A file that is not a song is left alone. */ }
        }
    }

    activeSongs(): SongEntry[] { return this.songs.filter(s => s.deletedAt === undefined); }
    trashedSongs(): SongEntry[] { return this.songs.filter(s => s.deletedAt !== undefined).sort((a, b) => b.deletedAt! - a.deletedAt!); }
    find(id: string | null): SongEntry | undefined { return this.songs.find(s => s.id === id); }
    current(): SongEntry | undefined { return this.find(this.currentSongId); }

    /**
     * The song's project. A song file that cannot be read falls back to the song's newest readable
     * version, and says so in `note`, rather than leaving the song unopenable.
     */
    loadSong(id: string): { project: P; note?: string } {
        const entry = this.find(id);
        if (!entry) throw new Error("That song is not in the library.");
        let problem = "";
        try {
            const doc = JSON.parse(this.store.read(songPath(id)) ?? "null") as SongFile<P> | null;
            if (doc?.project && Array.isArray(doc.project.tracks)) return { project: doc.project };
            problem = doc ? "its file is not a song" : "its file is missing";
        } catch (e) {
            problem = `its file could not be read (${e instanceof Error ? e.message : e})`;
        }
        for (const v of this.versions(id)) {
            try {
                return { project: this.loadVersion(id, v.id), note: `"${entry.name}" could not be opened because ${problem}, so its version from ${formatDate(v.at)} ${formatClock(v.at)} was opened instead.` };
            } catch { /* try an older one */ }
        }
        throw new Error(`"${entry.name}" could not be opened: ${problem}, and it has no saved versions.`);
    }

    // --- Songs ------------------------------------------------------------------------------

    private writeSongFile(entry: SongEntry, project: P): void {
        const doc: SongFile<P> = { format: "entropy-daw-song", version: 1, id: entry.id, name: entry.name, savedAt: entry.updatedAt, project };
        this.store.write(songPath(entry.id), JSON.stringify(doc));
    }

    /** Adds a new song (not opened; see `setCurrent`). The name is made unique. */
    createSong(name: string, project: P): SongEntry {
        const now = this.opts.now();
        const entry: SongEntry = {
            id: this.opts.uuid(), name: uniqueName(name, this.activeSongs().map(s => s.name)),
            createdAt: now, updatedAt: now, ...statsOf(project),
        };
        this.writeSongFile(entry, project);
        this.songs.push(entry);
        this.indexDirty = true;
        this.flushIndex();
        return entry;
    }

    /** Writes the song file now; the index (dates, summary) follows on the next `flushIndex`. */
    saveSong(id: string, project: P): void {
        const entry = this.find(id);
        if (!entry) throw new Error("That song is not in the library.");
        entry.updatedAt = this.opts.now();
        Object.assign(entry, statsOf(project));
        this.writeSongFile(entry, project);
        this.changedSinceCheckpoint.add(id);
        this.indexDirty = true;
    }

    setCurrent(id: string | null): void {
        if (this.currentSongId === id) return;
        this.currentSongId = id;
        this.indexDirty = true;
        this.flushIndex();
    }

    flushIndex(): void {
        if (!this.indexDirty) return;
        const index: LibraryIndex = { format: "entropy-daw-library", version: 1, currentSongId: this.currentSongId, songs: this.songs };
        this.store.write(LIBRARY_PATH, JSON.stringify(index, null, 1));
        this.indexDirty = false;
    }

    /** Renames; answers the name actually used (made unique), or throws on an empty name. */
    rename(id: string, name: string): string {
        const entry = this.find(id);
        if (!entry) throw new Error("That song is not in the library.");
        const clean = cleanName(name);
        if (!clean) throw new Error("A song needs a name.");
        if (clean === entry.name) return clean;
        entry.name = uniqueName(clean, this.activeSongs().filter(s => s.id !== id).map(s => s.name));
        // The name inside the song file only matters for rebuilding a lost index; it catches up on the next save.
        this.indexDirty = true;
        this.flushIndex();
        return entry.name;
    }

    duplicate(id: string, project: P): SongEntry {
        const entry = this.find(id);
        if (!entry) throw new Error("That song is not in the library.");
        const base = entry.name.replace(/ copy( \d+)?$/, "");
        return this.createSong(`${base} copy`, JSON.parse(JSON.stringify(project)) as P);
    }

    /** Moves a song to Recently deleted. Nothing is removed from disk until it is emptied. */
    trash(id: string): void {
        const entry = this.find(id);
        if (!entry || entry.deletedAt !== undefined) return;
        entry.deletedAt = this.opts.now();
        if (this.currentSongId === id) this.currentSongId = null;
        this.indexDirty = true;
        this.flushIndex();
    }

    restoreFromTrash(id: string): SongEntry {
        const entry = this.find(id);
        if (!entry || entry.deletedAt === undefined) throw new Error("That song is not in Recently deleted.");
        delete entry.deletedAt;
        entry.name = uniqueName(entry.name, this.activeSongs().filter(s => s.id !== id).map(s => s.name));
        this.indexDirty = true;
        this.flushIndex();
        return entry;
    }

    deleteForever(id: string): void {
        this.store.remove(songPath(id));
        this.store.remove(historyDir(id));
        this.histories.delete(id);
        this.songs = this.songs.filter(s => s.id !== id);
        if (this.currentSongId === id) this.currentSongId = null;
        this.indexDirty = true;
        this.flushIndex();
    }

    // --- Versions ---------------------------------------------------------------------------

    /** Newest first. */
    versions(songId: string): VersionEntry[] {
        let list = this.histories.get(songId);
        if (!list) {
            list = [];
            try {
                const doc = JSON.parse(this.store.read(historyPath(songId)) ?? "null") as HistoryIndex | null;
                if (doc && Array.isArray(doc.versions)) list = doc.versions.map(readVersionEntry).filter((v): v is VersionEntry => !!v);
            } catch { list = []; }
            // Version files the index does not know about (an interrupted write) are adopted.
            const known = new Set(list.map(v => v.id));
            for (const f of this.store.list(historyDir(songId))) {
                const id = f.name.endsWith(".json") ? f.name.slice(0, -5) : "";
                if (f.isDir || id === "index" || !ID_PATTERN.test(id) || known.has(id)) continue;
                try {
                    const doc = JSON.parse(this.store.read(versionPath(songId, id)) ?? "null") as VersionFile<P>;
                    const entry = readVersionEntry(doc?.entry);
                    if (entry && entry.id === id) list.push(entry);
                } catch { /* not a version */ }
            }
            list.sort((a, b) => b.at - a.at);
            this.histories.set(songId, list);
        }
        return list;
    }

    private writeHistory(songId: string): void {
        const doc: HistoryIndex = { format: "entropy-daw-history", version: 1, songId, versions: this.versions(songId) };
        this.store.write(historyPath(songId), JSON.stringify(doc, null, 1));
    }

    /**
     * Keeps a version of `project`. An automatic one (anything but "named") is skipped when it would
     * be identical to the newest version - answering null - so idle time never fills the history
     * with copies. Old automatic versions are thinned out afterwards.
     */
    addVersion(songId: string, project: P, kind: VersionKind, label?: string): VersionEntry | null {
        const text = JSON.stringify(project);
        const hash = fingerprint(text);
        const history = this.versions(songId);
        const now = this.opts.now();
        this.checkpointAt.set(songId, now);
        this.changedSinceCheckpoint.delete(songId);
        if (kind !== "named" && history[0]?.hash === hash) return null;
        const entry: VersionEntry = { id: this.opts.uuid(), at: now, kind, hash, size: text.length, ...statsOf(project) };
        const clean = label ? cleanName(label) : "";
        if (clean) entry.label = clean;
        const file: VersionFile<P> = { format: "entropy-daw-version", version: 1, songId, entry, project };
        this.store.write(versionPath(songId, entry.id), JSON.stringify(file));
        history.unshift(entry);
        this.prune(songId, false);
        this.writeHistory(songId);
        return entry;
    }

    loadVersion(songId: string, versionId: string): P {
        const doc = JSON.parse(this.store.read(versionPath(songId, versionId)) ?? "null") as VersionFile<P> | null;
        if (!doc?.project || !Array.isArray(doc.project.tracks)) throw new Error("That version's file is missing or damaged.");
        return doc.project;
    }

    /** Names (or renames) a version, which also keeps it from being thinned out. An empty name turns
     * a named version back into an ordinary automatic one. */
    nameVersion(songId: string, versionId: string, label: string): void {
        const v = this.versions(songId).find(x => x.id === versionId);
        if (!v) throw new Error("That version no longer exists.");
        const clean = cleanName(label);
        if (clean) { v.kind = "named"; v.label = clean; }
        else if (v.kind === "named") { v.kind = "auto"; delete v.label; }
        this.writeHistory(songId);
    }

    deleteVersion(songId: string, versionId: string): void {
        const history = this.versions(songId);
        const i = history.findIndex(v => v.id === versionId);
        if (i < 0) return;
        history.splice(i, 1);
        this.store.remove(versionPath(songId, versionId));
        this.writeHistory(songId);
    }

    /** Thins old automatic versions (see versionsToPrune). Answers how many were removed. */
    prune(songId: string, write = true): number {
        const history = this.versions(songId);
        const drop = new Set(versionsToPrune(history, this.opts.now()));
        if (!drop.size) return 0;
        for (const id of drop) this.store.remove(versionPath(songId, id));
        this.histories.set(songId, history.filter(v => !drop.has(v.id)));
        if (write) this.writeHistory(songId);
        return drop.size;
    }

    /** Marks the moment a song was opened, so the 10-minute clock starts from there. */
    markOpened(songId: string): void {
        this.checkpointAt.set(songId, this.opts.now());
        this.changedSinceCheckpoint.delete(songId);
    }

    /** True once a song has changed and 10 minutes have passed since its last version. */
    autoVersionDue(songId: string): boolean {
        if (!this.changedSinceCheckpoint.has(songId)) return false;
        const last = this.checkpointAt.get(songId) ?? 0;
        return this.opts.now() - last >= AUTO_VERSION_INTERVAL_MS;
    }

    /** Milliseconds until the next automatic version, or null when nothing has changed. */
    nextAutoVersionIn(songId: string): number | null {
        if (!this.changedSinceCheckpoint.has(songId)) return null;
        return Math.max(0, (this.checkpointAt.get(songId) ?? 0) + AUTO_VERSION_INTERVAL_MS - this.opts.now());
    }
}

/** A Map-backed SongStore for tests and for running without a data folder (nothing survives a restart). */
export function memoryStore(files = new Map<string, string>()): SongStore & { files: Map<string, string> } {
    return {
        files,
        read: path => files.get(path) ?? null,
        write: (path, text) => { files.set(path, text); },
        list: (path = "") => {
            const prefix = path ? path.replace(/\/+$/, "") + "/" : "";
            const out = new Map<string, StoreEntry>();
            for (const [key, text] of files) {
                if (!key.startsWith(prefix)) continue;
                const rest = key.slice(prefix.length);
                const slash = rest.indexOf("/");
                const name = slash < 0 ? rest : rest.slice(0, slash);
                if (!out.has(name)) out.set(name, { name, isDir: slash >= 0, size: slash < 0 ? text.length : 0, modifiedMs: 0 });
            }
            return [...out.values()].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
        },
        remove: path => {
            let any = false;
            for (const key of [...files.keys()]) if (key === path || key.startsWith(path + "/")) { files.delete(key); any = true; }
            return any;
        },
    };
}
