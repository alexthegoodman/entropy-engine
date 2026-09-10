// The level's data model plus a thin runtime wrapper (`EditorEntity`) that keeps a `Sprite`
// (examples/studio-bundle/src/game2d/sprite.ts) in sync with it. `EntityData` is exactly what
// gets serialized to/from disk (see level.ts) - the wrapper's `vx`/`vy` (Play-mode velocity)
// deliberately live outside it, since they're runtime-only and never saved.

import { Sprite } from "../game2d/sprite.ts";
import { pointInRect, pointInCircle, aabbOverlap, circleOverlap } from "../game2d/physics2d.ts";

export type EntityTag = "player" | "enemy" | "platform" | "trigger" | "decoration";
export type EntityShape = "rect" | "circle";
export const ENTITY_TAGS: EntityTag[] = ["player", "enemy", "platform", "trigger", "decoration"];

export interface LogicPin {
    id: string;
    name: string;
    pinType: string;
}

export type LogicNodeType = "OnStart" | "OnCollide" | "OnKeyDown" | "SetVelocity" | "Destroy" | "SetColor" | "Log";

export interface LogicNode {
    id: string;
    name: string;
    nodeType: LogicNodeType;
    position: [number, number];
    inputs: LogicPin[];
    outputs: LogicPin[];
    properties: any;
}

export interface LogicConn {
    fromNode: string;
    fromPin: string;
    toNode: string;
    toPin: string;
}

export interface EntityGraph {
    nodes: LogicNode[];
    connections: LogicConn[];
}

export interface EntityData {
    id: string;
    tag: EntityTag;
    shape: EntityShape;
    x: number;
    y: number;
    w: number;
    h: number;
    color: [number, number, number, number];
    graph: EntityGraph;
}

const TAG_COLORS: Record<EntityTag, [number, number, number, number]> = {
    player: [0.25, 0.85, 0.95, 1],
    enemy: [0.95, 0.25, 0.3, 1],
    platform: [0.55, 0.55, 0.6, 1],
    trigger: [0.95, 0.75, 0.2, 0.85],
    decoration: [0.4, 0.8, 0.4, 1],
};

// Fixed draw-order-by-tag, since z is baked into each sprite's vertices at creation time (see
// Sprite.retint's doc comment) rather than something the editor can cheaply reorder per frame.
// Good enough default layering for a level editor whose entities mostly don't stack; genuine
// z-ordering (e.g. by selection or a per-entity "layer" property) is a `what's next` item.
const TAG_Z: Record<EntityTag, number> = {
    platform: 0.0,
    decoration: 0.1,
    trigger: 0.2,
    enemy: 0.3,
    player: 0.4,
};

export function defaultEntityData(tag: EntityTag, shape: EntityShape, x: number, y: number): EntityData {
    return {
        id: `entity_${Entropy.generateUUID()}`,
        tag,
        shape,
        x, y,
        w: 1.2, h: 1.2,
        color: TAG_COLORS[tag],
        graph: { nodes: [], connections: [] },
    };
}

export class EditorEntity {
    data: EntityData;
    sprite: Sprite;
    // Play-mode-only velocity, driven by SetVelocity logic nodes and integrated in graph.ts's
    // caller (level_editor_2d/index.ts's update loop). Not part of EntityData - never saved.
    vx = 0;
    vy = 0;

    constructor(data: EntityData, pipelineId: string, rectTextureId: string, circleTextureId: string) {
        this.data = data;
        this.sprite = new Sprite({
            textureId: data.shape === "circle" ? circleTextureId : rectTextureId,
            pipelineId,
            x: data.x,
            y: data.y,
            z: TAG_Z[data.tag],
            halfW: data.w / 2,
            halfH: data.h / 2,
            tint: data.color,
        });
    }

    // Pushes position/size to the sprite. Called after any edit-mode drag or play-mode velocity
    // integration touches data.x/y/w/h.
    syncTransform(): void {
        this.sprite.x = this.data.x;
        this.sprite.y = this.data.y;
        this.sprite.halfW = this.data.w / 2;
        this.sprite.halfH = this.data.h / 2;
        this.sprite.sync();
    }

    containsPoint(px: number, py: number): boolean {
        return this.data.shape === "circle"
            ? pointInCircle(px, py, this.data.x, this.data.y, this.data.w / 2)
            : pointInRect(px, py, this.data.x, this.data.y, this.data.w, this.data.h);
    }

    overlaps(other: EditorEntity): boolean {
        if (this.data.shape === "circle" && other.data.shape === "circle") {
            return circleOverlap(this.data.x, this.data.y, this.data.w / 2, other.data.x, other.data.y, other.data.w / 2);
        }
        // Mixed circle/rect and rect/rect both fall back to an AABB test (treating a circle as
        // its bounding box) - a small conservative-overlap approximation, not exact circle/rect
        // intersection. Acceptable for a v1 "did these roughly touch" gameplay signal.
        return aabbOverlap(this.data.x, this.data.y, this.data.w, this.data.h, other.data.x, other.data.y, other.data.w, other.data.h);
    }

    destroy(): void {
        this.sprite.destroy();
    }
}
