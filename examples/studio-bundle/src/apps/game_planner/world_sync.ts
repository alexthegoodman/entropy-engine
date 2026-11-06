// Keeping one world file in step between apps. The Game World Planner and the Game World Detailer
// open the same `worlds/<id>.world.json` (often at the same time, in two processes): the Planner
// edits the plan, the Detailer edits the plan where it overlaps (moving a building, a spot, an
// NPC) and its own `detail` section. Neither may silently throw the other's work away.
//
// - `WorldFileWatcher` notices when the file changed on disk behind an app's back (its modified
//   time moved and the save stamp is not one this app wrote).
// - `mergeWorlds(base, mine, theirs)` is a three-way merge: `base` is the file as this app last
//   read or wrote it, `mine` what the app has in memory now, `theirs` the file as it is now.
//   Lists of things with ids (spots, structures, placements, props...) merge entity by entity and
//   field by field, so the Planner renaming a house and the Detailer moving it both survive.
//   Where both changed the same field, this app's value wins and the conflict is reported.
//
// Pure apart from the store passed in, so it is tested without either app.

import type { GameWorld } from "./planner_types";
import { WORLD_FORMAT, deserializeWorld, worldFileName, type WorldStoreLike } from "./world_store";

/** Deep structural equality for JSON-like values (fast on long number arrays: the heightfield). */
export function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
        // Treat a missing value and undefined alike; NaN never appears in JSON.
        return a === b;
    }
    const aa = Array.isArray(a), ba = Array.isArray(b);
    if (aa !== ba) return false;
    if (aa) {
        const x = a as unknown[], y = b as unknown[];
        if (x.length !== y.length) return false;
        for (let i = 0; i < x.length; i++) if (!sameValue(x[i], y[i])) return false;
        return true;
    }
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const kx = Object.keys(x).filter((k) => x[k] !== undefined), ky = Object.keys(y).filter((k) => y[k] !== undefined);
    if (kx.length !== ky.length) return false;
    for (const k of kx) if (!sameValue(x[k], y[k])) return false;
    return true;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** A list whose every item is an object with a string id: merged entity by entity. */
const isEntityList = (v: unknown): v is Array<{ id: string }> =>
    Array.isArray(v) && v.every((e) => isPlainObject(e) && typeof e.id === "string");

export interface MergeReport {
    /** Paths where both sides changed the same thing differently ("structures/s12/x"); mine won. */
    conflicts: string[];
    /** How many changes came in from `theirs`. */
    incoming: number;
}

function mergeValue(base: unknown, mine: unknown, theirs: unknown, path: string, report: MergeReport): unknown {
    if (sameValue(mine, theirs)) return mine;
    if (sameValue(base, mine)) {
        report.incoming++;
        return theirs;
    }
    if (sameValue(base, theirs)) return mine;
    // Both sides changed it.
    const lists = [mine, theirs, base ?? []];
    if (lists.every(isEntityList)) return mergeEntities(base as Array<{ id: string }> | undefined ?? [], mine as Array<{ id: string }>, theirs as Array<{ id: string }>, path, report);
    if (isPlainObject(mine) && isPlainObject(theirs) && (base === undefined || isPlainObject(base))) {
        const b = (base ?? {}) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        const keys = new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(b)]);
        for (const k of keys) {
            const v = mergeValue(b[k], mine[k], theirs[k], path ? `${path}/${k}` : k, report);
            if (v !== undefined) out[k] = v;
        }
        return out;
    }
    report.conflicts.push(path || "(world)");
    return mine;
}

function mergeEntities(base: Array<{ id: string }>, mine: Array<{ id: string }>, theirs: Array<{ id: string }>, path: string, report: MergeReport): Array<{ id: string }> {
    const byId = (l: Array<{ id: string }>) => new Map(l.map((e) => [e.id, e]));
    const b = byId(base), m = byId(mine), t = byId(theirs);
    const out: Array<{ id: string }> = [];
    const take = (id: string) => {
        const inBase = b.get(id), inMine = m.get(id), inTheirs = t.get(id);
        if (inMine && inTheirs) {
            out.push(mergeValue(inBase, inMine, inTheirs, `${path}/${id}`, report) as { id: string });
        } else if (inMine && !inTheirs) {
            // Theirs deleted it: gone unless mine changed it since (then keep mine, and say so).
            if (!inBase) out.push(inMine);
            else if (!sameValue(inBase, inMine)) {
                report.conflicts.push(`${path}/${id} (deleted elsewhere, kept: changed here)`);
                out.push(inMine);
            } else report.incoming++;
        } else if (!inMine && inTheirs) {
            if (!inBase) {
                report.incoming++;
                out.push(inTheirs);
            } else if (!sameValue(inBase, inTheirs)) {
                report.conflicts.push(`${path}/${id} (deleted here, kept: changed elsewhere)`);
                out.push(inTheirs);
            }
        }
    };
    const seen = new Set<string>();
    // My order first, then what theirs added, in their order.
    for (const e of mine) if (!seen.has(e.id)) { seen.add(e.id); take(e.id); }
    for (const e of theirs) if (!seen.has(e.id)) { seen.add(e.id); take(e.id); }
    return out;
}

/** Three-way merge of whole worlds (see the top of this file). Never mutates its inputs. */
export function mergeWorlds(base: GameWorld, mine: GameWorld, theirs: GameWorld): { world: GameWorld; report: MergeReport } {
    const report: MergeReport = { conflicts: [], incoming: 0 };
    const merged = mergeValue(base, mine, theirs, "", report) as GameWorld;
    // Hand back an independent copy: the inputs may still be in use (an undo history, a cache).
    return { world: JSON.parse(JSON.stringify(merged)), report };
}

// -------------------------------------------------------------------------------------------------
// Noticing changes on disk
// -------------------------------------------------------------------------------------------------

export interface ExternalChange {
    world: GameWorld;
    text: string;
    savedAt: number;
    /** Which app wrote it, when the file says ("game-world-planner", "game-world-detailer"). */
    savedBy?: string;
}

/**
 * Watches one world file in a store. `poll()` is cheap (a folder listing, at most every
 * `intervalMs`) and returns the new world only when the file changed and the change is not this
 * app's own save (`noteSaved` records those by their save stamp).
 */
export class WorldFileWatcher {
    private modifiedMs = -1;
    private savedAt = -1;
    private lastPoll = -Infinity;

    constructor(private store: WorldStoreLike, public worldId: string, private intervalMs = 1200) {
        this.modifiedMs = this.currentModified();
    }

    private currentModified(): number {
        const name = worldFileName(this.worldId).split("/").pop()!;
        const dir = worldFileName(this.worldId).slice(0, -name.length - 1);
        try {
            return this.store.list(dir).find((e) => !e.isDir && e.name === name)?.modifiedMs ?? 0;
        } catch {
            return 0;
        }
    }

    /** Watches another world (the app opened a different one). */
    watch(worldId: string, savedAt = -1): void {
        this.worldId = worldId;
        this.savedAt = savedAt;
        this.modifiedMs = this.currentModified();
        this.lastPoll = -Infinity;
    }

    /** This app just wrote the file with this save stamp. */
    noteSaved(savedAt: number): void {
        this.savedAt = savedAt;
        this.modifiedMs = this.currentModified();
    }

    /** The changed world, or null. `now` is milliseconds (Date.now() by default). */
    poll(now = Date.now(), force = false): ExternalChange | null {
        if (!force && now - this.lastPoll < this.intervalMs) return null;
        this.lastPoll = now;
        const modified = this.currentModified();
        if (modified === this.modifiedMs) return null;
        this.modifiedMs = modified;
        let text: string | null = null;
        try {
            text = this.store.read(worldFileName(this.worldId));
        } catch {
            return null;
        }
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            const savedAt = parsed?.format === WORLD_FORMAT ? Number(parsed.savedAt) : NaN;
            if (Number.isFinite(savedAt) && savedAt === this.savedAt) return null;
            const world = deserializeWorld(text);
            if (Number.isFinite(savedAt)) this.savedAt = savedAt;
            return { world, text, savedAt, savedBy: parsed?.savedBy };
        } catch {
            // Half-written files never appear (writes are atomic); anything unreadable is ignored.
            return null;
        }
    }
}

/** A deep copy suitable as a merge base. */
export const cloneWorld = (w: GameWorld): GameWorld => JSON.parse(JSON.stringify(w));
