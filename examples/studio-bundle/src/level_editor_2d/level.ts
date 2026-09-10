// Pure (de)serialization - the actual file I/O (addon.Scripts.write/read, which needs the
// addon-scoped API object) lives in index.ts, where `addon` is already in scope.

import type { EntityData } from "./entity.ts";

export interface LevelFile {
    entities: EntityData[];
}

export function serializeLevel(entities: EntityData[]): string {
    const level: LevelFile = { entities };
    return JSON.stringify(level, null, 2);
}

export function deserializeLevel(json: string): EntityData[] {
    const level = JSON.parse(json) as LevelFile;
    return level.entities ?? [];
}
