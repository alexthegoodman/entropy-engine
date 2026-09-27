/** Revisioned state reads for MCP "get state" tools (daw_get_state, canvas_get_scene).
 *
 * Every read snapshots the whole state and tags it with a revision; the revision only changes when
 * the state did. A caller that still has an earlier read can pass that revision back as
 * `sinceRevision` and get just what changed instead of the whole state again, which keeps an
 * agent's context from filling up with near-identical copies. The caller names its own baseline, so
 * a caller that lost its copy (a new conversation, a summarised one) just reads without it. A
 * revision this tracker no longer keeps (too old, or from before the app restarted) answers with the
 * whole state and says so, never with a diff against something the caller does not have.
 *
 * A diff has the same shape as the state, holding only what changed:
 * - a changed plain value is its new value, and a field that disappeared is null;
 * - an object is diffed field by field;
 * - an array whose items all have an `id` becomes `{ added, removed, changed }`: added items in
 *   full, removed items by id, changed items as `{ id, name?, ...changed fields }`;
 * - any other array that changed is given in full. */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: Json | undefined): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const hasIds = (v: Json | undefined): v is JsonObject[] =>
    Array.isArray(v) && v.every(item => isObject(item) && (typeof item.id === "string" || typeof item.id === "number"));
const same = (a: Json | undefined, b: Json | undefined) => JSON.stringify(a) === JSON.stringify(b);

function diffObject(before: JsonObject, after: JsonObject): JsonObject | undefined {
    const out: JsonObject = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const d = diffValue(before[key], after[key]);
        if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? out : undefined;
}

function diffList(before: JsonObject[], after: JsonObject[]): JsonObject | undefined {
    const old = new Map(before.map(item => [String(item.id), item]));
    const now = new Set(after.map(item => String(item.id)));
    const added: Json[] = [], changed: Json[] = [];
    for (const item of after) {
        const was = old.get(String(item.id));
        if (!was) { added.push(item); continue; }
        const d = diffObject(was, item);
        if (d) changed.push({ id: item.id, ...(typeof item.name === "string" ? { name: item.name } : {}), ...d });
    }
    const removed = before.filter(item => !now.has(String(item.id))).map(item => item.id);
    const out: JsonObject = {};
    if (added.length) out.added = added;
    if (removed.length) out.removed = removed;
    if (changed.length) out.changed = changed;
    return Object.keys(out).length ? out : undefined;
}

/** What changed from `before` to `after`, or undefined when nothing did. */
export function diffValue(before: Json | undefined, after: Json | undefined): Json | undefined {
    if (same(before, after)) return undefined;
    if (after === undefined) return null;
    if (isObject(before) && isObject(after)) return diffObject(before, after);
    if (hasIds(before) && hasIds(after)) return diffList(before, after);
    return after;
}

export interface StateRead { [key: string]: unknown; revision: string }

export interface StateRevisions {
    /** Snapshot `state` (the whole, unfiltered state) and return it with its revision, or, when
     * `since` is a kept revision, only what changed since then. */
    read(state: object, since?: unknown): StateRead;
    /** Snapshot `state` and return just its revision, for a scoped read that shows less than the
     * whole state but should still give the caller a baseline to diff from later. */
    revisionOf(state: object): string;
}

/** `keep` is how many distinct past states stay available as a `sinceRevision` baseline. */
export function createStateRevisions(keep = 32): StateRevisions {
    // Revisions look like "k3x9a1-4": the prefix is fixed when the app starts, so a revision from
    // before a restart can never be mistaken for one from after it.
    const epoch = Date.now().toString(36);
    let counter = 0;
    const kept: { revision: string; text: string; value: Json }[] = [];

    const snapshot = (state: object) => {
        const text = JSON.stringify(state);
        const latest = kept.at(-1);
        if (latest && latest.text === text) return latest;
        const entry = { revision: `${epoch}-${++counter}`, text, value: JSON.parse(text) as Json };
        kept.push(entry);
        if (kept.length > keep) kept.shift();
        return entry;
    };

    return {
        revisionOf: state => snapshot(state).revision,
        read(state, since) {
            const now = snapshot(state);
            if (since === undefined || since === null) return { revision: now.revision, ...(now.value as JsonObject) };
            const base = kept.find(k => k.revision === since);
            if (!base) {
                return {
                    revision: now.revision, fullState: true,
                    note: `Revision ${JSON.stringify(since)} is no longer available, so this is the whole state. Diff from revision ${now.revision} next time.`,
                    ...(now.value as JsonObject),
                };
            }
            const changes = base === now ? undefined : diffValue(base.value, now.value);
            if (changes === undefined) return { revision: now.revision, since: base.revision, unchanged: true };
            return { revision: now.revision, since: base.revision, changes };
        },
    };
}

/** Description text for the `sinceRevision` parameter, shared so both apps word it the same. */
export const SINCE_REVISION_DESCRIPTION =
    "The revision from an earlier read that you still have. Returns only what changed since then (changes, or unchanged: true) plus the new revision. " +
    "In changes, arrays of items with ids become { added, removed, changed }; changed items list only their changed fields; a field set to null was removed. " +
    "If that revision is no longer available you get the whole state again with fullState: true. Leave it out when you no longer have the earlier result.";
