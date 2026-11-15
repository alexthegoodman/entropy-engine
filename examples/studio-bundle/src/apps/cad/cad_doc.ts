// The CAD document, as the kernel reads it (crates/entropy-cad/src/features.rs and sketch.rs are
// the other half of this file: keep them in step). A document is plain JSON: an ordered history of
// features. Apps edit it with the helpers here and hand it to `Entropy.Cad.evaluate`.
//
// Shared by every CAD app (Design, and later Engineering, Architecture, Electronics). Nothing in
// this file touches the engine, so it runs under vitest.

export type V2 = [number, number];
export type V3 = [number, number, number];

// --- Sketches ------------------------------------------------------------------------------------

export interface SketchPoint { id: string; x: number; y: number }

/** An outline around an open curve: half widths left and right of travel, scaled along its length. */
export interface Stroke { left: number; right: number; start: number; middle: number; end: number; round: boolean }

interface EntityBase { id: string; construction?: boolean; stroke?: Stroke }
export interface LineEntity extends EntityBase { type: "line"; a: string; b: string }
/** The circular arc from `a` to `b` through `via`. */
export interface ArcEntity extends EntityBase { type: "arc"; a: string; b: string; via: string }
export interface CircleEntity extends EntityBase { type: "circle"; center: string; radius: number }
export interface EllipseEntity extends EntityBase { type: "ellipse"; center: string; rx: number; ry: number; rotation?: number }
/** `through`: the curve passes through every point (weights are tensions). `control`: the points
 *  pull the curve toward them (weights are how hard). */
export interface SplineEntity extends EntityBase { type: "spline"; points: string[]; closed?: boolean; mode?: "through" | "control"; weights?: number[] }
export type SketchEntity = LineEntity | ArcEntity | CircleEntity | EllipseEntity | SplineEntity;

/** A base plane moved along its normal and tipped (degrees, about its own x, then y, then normal). */
export interface PlaneSpec { base: "top" | "front" | "side"; offset?: number; tiltX?: number; tiltY?: number; spin?: number }

// --- Features ------------------------------------------------------------------------------------

interface FeatureBase { id: string; name: string; suppressed?: boolean }
export type BodyOp = "new" | "add" | "cut" | "intersect";
/** The regions of a sketch a feature uses; none listed means all. */
export interface ProfileRef { sketch: string; regions?: string[] }
/** One direction of an extrude. */
export interface ExtrudeSide { distance: number; scale?: V2; shift?: V2; twist?: number; bulge?: number }

export interface SketchFeature extends FeatureBase { type: "sketch"; plane: PlaneSpec; points: SketchPoint[]; entities: SketchEntity[] }
export interface ExtrudeFeature extends FeatureBase { type: "extrude"; profile: ProfileRef; forward: ExtrudeSide; backward: ExtrudeSide; op: BodyOp; target?: string }
export interface RevolveFeature extends FeatureBase {
    type: "revolve"; profile: ProfileRef;
    axis: { entity?: string; origin?: V2; dir?: V2 };
    start: number; end: number; pitch?: number; grow?: number; squash?: number; lobes?: number; lobeDepth?: number;
    op: BodyOp; target?: string;
}
export interface LoftFeature extends FeatureBase { type: "loft"; sections: Array<{ profile: ProfileRef; spin?: number }>; ruled?: boolean; closed?: boolean; op: BodyOp; target?: string }
export interface SweepFeature extends FeatureBase { type: "sweep"; profile: ProfileRef; path: { sketch: string; entity?: string }; twist?: number; scaleEnd?: number; scaleMid?: number; op: BodyOp; target?: string }
export interface DeformFeature extends FeatureBase {
    type: "deform"; target?: string; kind: "twist" | "bend" | "taper" | "shear"; axis: "x" | "y" | "z";
    from: number; to: number; angle?: number; toward?: "x" | "y" | "z"; scale?: V2; shift?: V2; smooth?: boolean;
}
export interface MirrorFeature extends FeatureBase { type: "mirror"; target?: string; plane: PlaneSpec; scale?: V3; shift?: V3; merge?: boolean }

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | LoftFeature | SweepFeature | DeformFeature | MirrorFeature;
export type FeatureType = Feature["type"];

export interface CadDocument { version: 1; units: "mm"; features: Feature[] }

export const emptyDocument = (): CadDocument => ({ version: 1, units: "mm", features: [] });

// --- Ids and names -------------------------------------------------------------------------------

/** The next unused id with this prefix: s1, s2... Small and readable, since they show up in tools. */
export function nextId(taken: Iterable<string>, prefix: string): string {
    const used = new Set(taken);
    for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

const FEATURE_PREFIX: Record<FeatureType, string> = { sketch: "s", extrude: "x", revolve: "r", loft: "l", sweep: "w", deform: "d", mirror: "m" };
const FEATURE_LABEL: Record<FeatureType, string> = { sketch: "Sketch", extrude: "Extrude", revolve: "Revolve", loft: "Loft", sweep: "Sweep", deform: "Deform", mirror: "Mirror" };

export const featureLabel = (type: FeatureType): string => FEATURE_LABEL[type];

/** An id and a name ("Extrude 2") for a new feature of this type. */
export function newFeatureIdentity(doc: CadDocument, type: FeatureType, label = FEATURE_LABEL[type]): { id: string; name: string } {
    const id = nextId(doc.features.map(f => f.id), FEATURE_PREFIX[type]);
    const names = new Set(doc.features.map(f => f.name));
    for (let n = 1; ; n++) if (!names.has(`${label} ${n}`)) return { id, name: `${label} ${n}` };
}

export const findFeature = (doc: CadDocument, id: string | null | undefined): Feature | undefined => (id ? doc.features.find(f => f.id === id) : undefined);
export const findSketch = (doc: CadDocument, id: string | null | undefined): SketchFeature | undefined => {
    const f = findFeature(doc, id);
    return f?.type === "sketch" ? f : undefined;
};
export const sketches = (doc: CadDocument): SketchFeature[] => doc.features.filter((f): f is SketchFeature => f.type === "sketch");

// --- Building features ---------------------------------------------------------------------------

export function addSketch(doc: CadDocument, plane: PlaneSpec = { base: "top" }): SketchFeature {
    const f: SketchFeature = { ...newFeatureIdentity(doc, "sketch"), type: "sketch", plane: { ...plane }, points: [], entities: [] };
    doc.features.push(f);
    return f;
}

/** The sketches a feature reads. */
export function sketchRefs(f: Feature): string[] {
    switch (f.type) {
        case "extrude": case "revolve": return [f.profile.sketch];
        case "loft": return f.sections.map(s => s.profile.sketch);
        case "sweep": return [f.profile.sketch, f.path.sketch];
        default: return [];
    }
}

/** Features that would break if `id` were removed: readers of a sketch, modifiers of a body. */
export function dependents(doc: CadDocument, id: string): Feature[] {
    return doc.features.filter(f => f.id !== id && (sketchRefs(f).includes(id) || ("target" in f && f.target === id)));
}

/** Removes a feature and, with it, everything that depends on it. Returns the removed ids. */
export function removeFeature(doc: CadDocument, id: string): string[] {
    const gone: string[] = [];
    const drop = (fid: string) => {
        if (gone.includes(fid) || !doc.features.some(f => f.id === fid)) return;
        gone.push(fid);
        for (const d of dependents(doc, fid)) drop(d.id);
    };
    drop(id);
    doc.features = doc.features.filter(f => !gone.includes(f.id));
    return gone;
}

/** Moves a feature earlier or later in the history, never ahead of a sketch it reads. */
export function moveFeature(doc: CadDocument, id: string, by: -1 | 1): boolean {
    const i = doc.features.findIndex(f => f.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= doc.features.length) return false;
    const [a, b] = by < 0 ? [doc.features[j], doc.features[i]] : [doc.features[i], doc.features[j]];
    // `b` would move ahead of `a`: not if it reads it.
    if (sketchRefs(b).includes(a.id) || ("target" in b && b.target === a.id)) return false;
    [doc.features[i], doc.features[j]] = [doc.features[j], doc.features[i]];
    return true;
}

// --- Editing sketches ----------------------------------------------------------------------------

export function addPoint(s: SketchFeature, x: number, y: number): SketchPoint {
    const p: SketchPoint = { id: nextId(s.points.map(q => q.id), "p"), x: round(x), y: round(y) };
    s.points.push(p);
    return p;
}

/** Coordinates are kept to a micrometre: files stay readable and equal points compare equal. */
export const round = (v: number): number => Math.round(v * 1000) / 1000;

export const pointOf = (s: SketchFeature, id: string): SketchPoint | undefined => s.points.find(p => p.id === id);

type NewEntity = SketchEntity extends infer E ? (E extends SketchEntity ? Omit<E, "id"> : never) : never;

export function addEntity(s: SketchFeature, entity: NewEntity): SketchEntity {
    const e = { ...entity, id: nextId(s.entities.map(x => x.id), "e") } as SketchEntity;
    s.entities.push(e);
    return e;
}

/** Point ids an entity is defined by. */
export function entityPoints(e: SketchEntity): string[] {
    switch (e.type) {
        case "line": return [e.a, e.b];
        case "arc": return [e.a, e.via, e.b];
        case "circle": case "ellipse": return [e.center];
        case "spline": return [...e.points];
    }
}

/** Drops points no entity uses any more. */
export function prunePoints(s: SketchFeature): void {
    const used = new Set(s.entities.flatMap(entityPoints));
    s.points = s.points.filter(p => used.has(p.id));
}

export function removeEntities(s: SketchFeature, ids: string[]): void {
    s.entities = s.entities.filter(e => !ids.includes(e.id));
    prunePoints(s);
}

/**
 * Deletes a point. Splines simply lose it (down to two points); anything else defined by it goes.
 */
export function removePoint(s: SketchFeature, id: string): void {
    const doomed: string[] = [];
    for (const e of s.entities) {
        if (!entityPoints(e).includes(id)) continue;
        if (e.type === "spline" && e.points.length > 2) {
            const at = e.points.indexOf(id);
            e.points = e.points.filter(p => p !== id);
            if (e.weights?.length) e.weights = e.weights.filter((_, i) => i !== at);
        } else doomed.push(e.id);
    }
    removeEntities(s, doomed);
    prunePoints(s);
}

/** Makes `from` and `into` one point, so the curves on them are joined. Curves that collapse go. */
export function mergePoints(s: SketchFeature, from: string, into: string): void {
    if (from === into) return;
    const swap = (p: string) => (p === from ? into : p);
    for (const e of s.entities) {
        switch (e.type) {
            case "line": e.a = swap(e.a); e.b = swap(e.b); break;
            case "arc": e.a = swap(e.a); e.b = swap(e.b); e.via = swap(e.via); break;
            case "circle": case "ellipse": e.center = swap(e.center); break;
            case "spline": {
                const before = e.points;
                e.points = before.map(swap);
                // Ending where it began closes a spline instead of doubling a point.
                if (e.points.length > 3 && e.points[0] === e.points[e.points.length - 1]) {
                    e.points.pop();
                    if (e.weights?.length) e.weights = e.weights.slice(0, e.points.length);
                    e.closed = true;
                }
                break;
            }
        }
    }
    s.entities = s.entities.filter(e => {
        const pts = entityPoints(e);
        if (e.type === "line") return e.a !== e.b;
        if (e.type === "arc") return new Set(pts).size === 3;
        if (e.type === "spline") return new Set(pts).size >= 2;
        return true;
    });
    prunePoints(s);
}

/** A rectangle as four joined lines; returns their ids. */
export function addRectangle(s: SketchFeature, a: V2, b: V2): string[] {
    const p = [addPoint(s, a[0], a[1]), addPoint(s, b[0], a[1]), addPoint(s, b[0], b[1]), addPoint(s, a[0], b[1])];
    return p.map((q, i) => addEntity(s, { type: "line", a: q.id, b: p[(i + 1) % 4].id }).id);
}

export function addCircle(s: SketchFeature, center: V2, radius: number): string {
    return addEntity(s, { type: "circle", center: addPoint(s, center[0], center[1]).id, radius: round(radius) }).id;
}

export function addSpline(s: SketchFeature, points: V2[], options: { closed?: boolean; mode?: "through" | "control"; weights?: number[] } = {}): string {
    const ids = points.map(p => addPoint(s, p[0], p[1]).id);
    const e: Omit<SplineEntity, "id"> = { type: "spline", points: ids };
    if (options.closed) e.closed = true;
    if (options.mode === "control") e.mode = "control";
    if (options.weights?.length) e.weights = [...options.weights];
    return addEntity(s, e).id;
}

/** A spline point's weight (tension in `through` mode, pull in `control` mode); 1 if never set. */
export const splineWeight = (e: SplineEntity, index: number): number => e.weights?.[index] ?? 1;

export function setSplineWeight(e: SplineEntity, index: number, weight: number): void {
    const w = e.points.map((_, i) => e.weights?.[i] ?? 1);
    w[index] = round(Math.max(0.05, weight));
    if (w.every(x => x === 1)) delete e.weights; else e.weights = w;
}

// --- History -------------------------------------------------------------------------------------

/**
 * Undo and redo by snapshot. A gesture (a drag, a slider) calls `begin` once and `commit` when it
 * ends, becoming one step however many times the document changed in between.
 */
export class History<T> {
    private undoStack: { label: string; state: string }[] = [];
    private redoStack: { label: string; state: string }[] = [];
    private pending: { label: string; state: string } | null = null;

    constructor(private read: () => T, private write: (state: T) => void, private limit = 200) {}

    begin(label: string): void {
        if (!this.pending) this.pending = { label, state: JSON.stringify(this.read()) };
    }

    /** True if the gesture changed anything (and so became a step). */
    commit(): boolean {
        const p = this.pending;
        this.pending = null;
        if (!p || p.state === JSON.stringify(this.read())) return false;
        this.undoStack.push(p);
        if (this.undoStack.length > this.limit) this.undoStack.shift();
        this.redoStack.length = 0;
        return true;
    }

    /** Drops an open gesture and puts the document back as it was when it began. */
    cancel(): void {
        if (this.pending) this.write(JSON.parse(this.pending.state));
        this.pending = null;
    }

    get active(): boolean { return this.pending !== null; }

    undo(): string | null {
        this.commit();
        const step = this.undoStack.pop();
        if (!step) return null;
        this.redoStack.push({ label: step.label, state: JSON.stringify(this.read()) });
        this.write(JSON.parse(step.state));
        return step.label;
    }

    redo(): string | null {
        this.commit();
        const step = this.redoStack.pop();
        if (!step) return null;
        this.undoStack.push({ label: step.label, state: JSON.stringify(this.read()) });
        this.write(JSON.parse(step.state));
        return step.label;
    }

    clear(): void { this.undoStack.length = 0; this.redoStack.length = 0; this.pending = null; }
    get depth(): { undo: number; redo: number } { return { undo: this.undoStack.length, redo: this.redoStack.length }; }
}
