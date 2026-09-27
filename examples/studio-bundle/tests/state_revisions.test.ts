import { describe, expect, it } from "vitest";
import { createStateRevisions, diffValue } from "../src/apps/state_revisions";

describe("diffValue", () => {
    it("is undefined when nothing changed, whatever the key order", () => {
        expect(diffValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBeUndefined();
    });
    it("keeps only changed fields and marks removed ones null", () => {
        expect(diffValue({ a: 1, b: 2, c: { d: 1, e: 2 } }, { a: 1, b: 3, c: { d: 1, e: 5 } })).toEqual({ b: 3, c: { e: 5 } });
        expect(diffValue({ a: 1, gone: true }, { a: 1 })).toEqual({ gone: null });
    });
    it("diffs arrays of items with ids by id, including nested ones", () => {
        const before = { tracks: [{ id: "a", name: "A", gain: 1, patterns: [{ id: "p", notes: 1 }] }, { id: "b", name: "B", gain: 1 }] };
        const after = { tracks: [{ id: "c", name: "C", gain: 1 }, { id: "a", name: "A", gain: 1, patterns: [{ id: "p", notes: 4 }] }] };
        expect(diffValue(before, after)).toEqual({
            tracks: { added: [{ id: "c", name: "C", gain: 1 }], removed: ["b"], changed: [{ id: "a", name: "A", patterns: { changed: [{ id: "p", notes: 4 }] } }] },
        });
    });
    it("gives other arrays in full when they change", () => {
        expect(diffValue({ position: [0, 0, 0] }, { position: [1, 0, 0] })).toEqual({ position: [1, 0, 0] });
    });
});

describe("createStateRevisions", () => {
    it("tags reads with a revision that only moves when the state does", () => {
        const r = createStateRevisions();
        const first = r.read({ n: 1 });
        expect(first).toEqual({ revision: expect.any(String), n: 1 });
        expect(r.read({ n: 1 }).revision).toBe(first.revision);
        expect(r.read({ n: 2 }).revision).not.toBe(first.revision);
    });
    it("answers with what changed since a kept revision, or unchanged", () => {
        const r = createStateRevisions();
        const { revision } = r.read({ n: 1, m: 1 });
        expect(r.read({ n: 1, m: 1 }, revision)).toEqual({ revision, since: revision, unchanged: true });
        const next = r.read({ n: 2, m: 1 }, revision);
        expect(next).toEqual({ revision: expect.any(String), since: revision, changes: { n: 2 } });
        // Back to the old content under a newer revision: nothing changed relative to the baseline.
        expect(r.read({ n: 1, m: 1 }, revision)).toMatchObject({ since: revision, unchanged: true });
    });
    it("gives the whole state when the revision is unknown or no longer kept", () => {
        const r = createStateRevisions(2);
        const old = r.revisionOf({ n: 1 });
        r.read({ n: 2 });
        r.read({ n: 3 });
        expect(r.read({ n: 3 }, old)).toMatchObject({ fullState: true, n: 3, note: expect.stringContaining("no longer available") });
        expect(r.read({ n: 3 }, "someone-else-1")).toMatchObject({ fullState: true, n: 3 });
    });
    it("never matches a revision from another run of the app", () => {
        const a = createStateRevisions(), b = createStateRevisions();
        const fromA = a.revisionOf({ n: 1 });
        const now = Date.now;
        try {
            Date.now = () => now() + 60_000;
            const c = createStateRevisions();
            expect(c.read({ n: 1 }, fromA)).toMatchObject({ fullState: true });
        } finally { Date.now = now; }
        expect(b.revisionOf({ n: 1 })).toEqual(expect.any(String));
    });
});
