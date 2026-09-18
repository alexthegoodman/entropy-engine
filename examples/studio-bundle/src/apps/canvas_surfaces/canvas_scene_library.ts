export interface SceneEntry { id: string; name: string; key: string; updatedAt: string; }
interface SceneIndex { format: "canvas-surfaces-library"; version: 1; revision: string; scenes: SceneEntry[]; }
export interface SceneStorage {
    loadIndex(): unknown;
    saveIndex(value: unknown): void;
    load(key: string): unknown;
    save(key: string, value: unknown): void;
    uuid(): string;
}

/** Named scenes use generated keys, never user-provided filenames. Writes use new revisions:
 * the old scene remains intact if writing its replacement or the index fails. */
export class SceneLibrary<T> {
    entries: SceneEntry[] = [];
    private legacy: T | null = null;
    constructor(private readonly storage: SceneStorage, private readonly validate: (value: unknown) => T) {}

    read(): void {
        const value = this.storage.loadIndex() as Partial<SceneIndex> | null;
        if (!value) return;
        if (value.format !== "canvas-surfaces-library") {
            this.legacy = this.validate(value);
            this.entries = [{ id: "legacy", name: "Imported scene", key: "legacy", updatedAt: "" }];
            return;
        }
        if (value.version !== 1 || !Array.isArray(value.scenes)) throw new Error("Unsupported scene library.");
        const ids = new Set<string>();
        for (const entry of value.scenes) {
            if (!entry || typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.name !== "string" ||
                typeof entry.key !== "string" || !/^CanvasSurfaces_Scene_[a-zA-Z0-9_-]+$/.test(entry.key)) throw new Error("Invalid scene library entry.");
            ids.add(entry.id);
        }
        this.entries = value.scenes.map(entry => ({ ...entry }));
    }

    load(id: string): T {
        const entry = this.entries.find(e => e.id === id);
        if (!entry) throw new Error("Choose a saved scene first.");
        return this.validate(entry.key === "legacy" ? this.legacy : this.storage.load(entry.key));
    }

    save(id: string | null, name: string, scene: T): SceneEntry {
        name = name.trim();
        if (!name) throw new Error("Enter a scene name.");
        if (this.entries.some(e => e.id !== id && e.name.toLocaleLowerCase() === name.toLocaleLowerCase()))
            throw new Error("That name is already used. Choose another name or load that scene to update it.");
        const writeScene = (data: T): string => {
            const key = `CanvasSurfaces_Scene_${this.storage.uuid()}`;
            this.storage.save(key, data);
            // Read-back catches the engine's no-op behavior when no data directory is configured.
            const read = this.validate(this.storage.load(key));
            if (JSON.stringify(read) !== JSON.stringify(data)) throw new Error("Scene could not be verified after saving.");
            return key;
        };
        const next = this.entries.map(entry => ({ ...entry }));
        const legacy = next.find(e => e.key === "legacy");
        if (legacy && this.legacy) legacy.key = writeScene(this.legacy);
        const entry: SceneEntry = { id: id ?? this.storage.uuid(), name, key: writeScene(scene), updatedAt: new Date().toISOString() };
        const index = next.findIndex(e => e.id === entry.id);
        if (index < 0) next.push(entry); else next[index] = entry;
        const previous = this.storage.loadIndex();
        const record: SceneIndex = { format: "canvas-surfaces-library", version: 1, revision: this.storage.uuid(), scenes: next };
        try {
            this.storage.saveIndex(record);
            const stored = this.storage.loadIndex() as SceneIndex | null;
            if (stored?.revision !== record.revision) throw new Error("Scene library could not be verified after saving.");
        } catch (error) {
            // Best effort rollback; payload revisions are never overwritten.
            if (previous) { try { this.storage.saveIndex(previous); } catch { /* Preserve original error. */ } }
            throw error;
        }
        this.entries = next;
        this.legacy = null;
        return entry;
    }
}
