/** Gesture-sized undo entries. Snapshots must remain immutable after capture. */
export class CanvasHistory<T> {
    private past: { label: string; before: T; after: T }[] = [];
    private future: { label: string; before: T; after: T }[] = [];
    private pending: { label: string; before: T } | null = null;

    constructor(
        private readonly capture: () => T,
        private readonly restore: (state: T) => void,
        private readonly equal: (a: T, b: T) => boolean,
        private readonly retainedBytes: (states: T[]) => number,
        private readonly maxBytes = 64 * 1024 * 1024,
        private readonly maxEntries = 80,
    ) {}

    get undoLabel(): string | undefined { return this.past.at(-1)?.label; }
    get redoLabel(): string | undefined { return this.future.at(-1)?.label; }
    get inProgress(): boolean { return this.pending !== null; }

    /** Rebase document identity after Save As without losing the artwork's undo history. */
    remap(map: (state: T) => T): void {
        for (const entry of [...this.past, ...this.future]) {
            entry.before = map(entry.before);
            entry.after = map(entry.after);
        }
        if (this.pending) this.pending.before = map(this.pending.before);
    }

    begin(label: string): void {
        this.pending ??= { label, before: this.capture() };
    }

    commit(): void {
        if (!this.pending) return;
        const { label, before } = this.pending;
        this.pending = null;
        const after = this.capture();
        if (this.equal(before, after)) return;
        this.past.push({ label, before, after });
        this.future = [];
        // Keep the newest action even if one exceptionally large scene exceeds the budget.
        while (this.past.length > 1 && (this.past.length > this.maxEntries ||
            this.retainedBytes(this.past.flatMap(entry => [entry.before, entry.after])) > this.maxBytes)) {
            this.past.shift();
        }
    }

    cancel(): void {
        if (!this.pending) return;
        const { before } = this.pending;
        this.pending = null;
        this.restore(before);
    }

    undo(): void {
        this.commit();
        const entry = this.past.pop();
        if (!entry) return;
        this.restore(entry.before);
        this.future.push(entry);
    }

    redo(): void {
        this.commit();
        const entry = this.future.pop();
        if (!entry) return;
        this.restore(entry.after);
        this.past.push(entry);
    }
}
