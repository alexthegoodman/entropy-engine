// Entropy 2D Level Editor - place entities on a plane, edit their properties, wire up basic
// per-entity logic with the real NodeGraphEditor widget, save/load the level to disk, and
// preview it in a Play mode. This is the actual "2D game engine" deliverable: a tool for
// designing 2D levels and their logic, not a specific game (see game2d/ for the underlying
// sprite/camera/input primitives, and the arena shooter addon for a hand-coded game built on
// those same primitives - this editor is what replaces hand-coding a game's layout in TS).
//
// Controls (Edit mode): click an entity to select it, drag to move it, click empty space to
// deselect. Controls (Play mode): whatever the selected level's OnKeyDown nodes are wired to.

import { createSpritePipeline } from "../game2d/sprite.ts";
import { createCircleTexture, createSolidTexture } from "../game2d/textures.ts";
import { Camera2D } from "../game2d/camera2d.ts";
import { Input2D } from "../game2d/input2d.ts";
import { EditorEntity, defaultEntityData, ENTITY_TAGS } from "./entity.ts";
import type { EntityTag, EntityShape, LogicNodeType } from "./entity.ts";
import { makeLogicNode, runFrom } from "./graph.ts";
import { serializeLevel, deserializeLevel } from "./level.ts";

const addonInfo = {
    name: "Entropy 2D Level Editor",
    version: "1.0.0",
    description: "Place entities, edit their properties, wire basic logic with the node graph, save/load levels",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const LEVEL_FILE = "level.json";
const VIEW_HEIGHT = 20;
const NODE_TYPES: LogicNodeType[] = ["OnStart", "OnCollide", "OnKeyDown", "SetVelocity", "Destroy", "SetColor", "Log"];
const KEY_OPTIONS = ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "space"];
const LOG_MESSAGES = ["hit!", "collected", "started", "destroyed", "triggered"];

let pipelineId: string;
let rectTex: string;
let circleTex: string;
let camera: Camera2D;
let input: Input2D;

let entities: EditorEntity[] = [];
let selectedId: string | null = null;
let mode: "edit" | "play" = "edit";
let nextTag: EntityTag = "platform";
let nextShape: EntityShape = "rect";

let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let prevMouseDown = false;
let lastTime = -1;
let statusMessage = "";

// Edge-trigger bookkeeping for Play mode - see runOnKeyDownNodes/runOnCollideNodes.
const firedKeyNodes = new Set<string>();
let overlapPairs = new Set<string>();

let toolboxWin: string;
let inspectorWin: string;
let logicWin: string;

function selected(): EditorEntity | undefined {
    return entities.find(e => e.data.id === selectedId);
}

function findEntityAt(worldX: number, worldY: number): EditorEntity | undefined {
    for (let i = entities.length - 1; i >= 0; i--) {
        if (entities[i].containsPoint(worldX, worldY)) return entities[i];
    }
    return undefined;
}

function addEntity(tag: EntityTag, shape: EntityShape): void {
    const col = entities.length % 5;
    const row = Math.floor(entities.length / 5);
    const x = col * 1.6 - 3.2;
    const y = row * 1.6 - 3.2;
    const data = defaultEntityData(tag, shape, x, y);
    const entity = new EditorEntity(data, pipelineId, rectTex, circleTex);
    entities.push(entity);
    selectedId = entity.data.id;
}

function deleteSelected(): void {
    const e = selected();
    if (!e) return;
    e.destroy();
    entities = entities.filter(x => x.data.id !== e.data.id);
    selectedId = null;
}

function clearLevel(): void {
    for (const e of entities) e.destroy();
    entities = [];
    selectedId = null;
}

function saveLevel(): void {
    try {
        addon.Scripts.write(LEVEL_FILE, serializeLevel(entities.map(e => e.data)));
        statusMessage = `Saved ${entities.length} entities to ${LEVEL_FILE}`;
    } catch (e) {
        statusMessage = `Save failed: ${e}`;
    }
}

function loadLevel(): void {
    try {
        const json = addon.Scripts.read(LEVEL_FILE);
        const datas = deserializeLevel(json);
        clearLevel();
        for (const data of datas) {
            entities.push(new EditorEntity(data, pipelineId, rectTex, circleTex));
        }
        statusMessage = `Loaded ${entities.length} entities from ${LEVEL_FILE}`;
    } catch (e) {
        statusMessage = `Load failed (no saved level yet?): ${e}`;
    }
}

function setMode(newMode: "edit" | "play"): void {
    mode = newMode;
    dragging = false;
    firedKeyNodes.clear();
    overlapPairs = new Set<string>();
    if (newMode === "play") {
        // Re-runs OnStart every time Play is entered, even on a second press - a "play session"
        // starts from whatever the level currently looks like (including edits made since the
        // last Play), not from a fresh reload. Positions are not reset to their saved values;
        // only saved Load does that.
        for (const e of entities) {
            e.vx = 0;
            e.vy = 0;
            for (const node of e.data.graph.nodes) {
                if (node.nodeType === "OnStart") runFrom(node.id, e, e.data.graph, destroyEntity);
            }
        }
    } else {
        for (const e of entities) { e.vx = 0; e.vy = 0; }
    }
}

function destroyEntity(e: EditorEntity): void {
    e.destroy();
    entities = entities.filter(x => x.data.id !== e.data.id);
    if (selectedId === e.data.id) selectedId = null;
}

function runOnKeyDownNodes(): void {
    for (const e of entities) {
        for (const node of e.data.graph.nodes) {
            if (node.nodeType !== "OnKeyDown") continue;
            const key: string = node.properties.key ?? "";
            const held = key.length > 0 && input.isDown(key);
            if (held && !firedKeyNodes.has(node.id)) {
                firedKeyNodes.add(node.id);
                runFrom(node.id, e, e.data.graph, destroyEntity);
            } else if (!held && firedKeyNodes.has(node.id)) {
                firedKeyNodes.delete(node.id);
            }
        }
    }
}

function runOnCollideNodes(): void {
    const currentPairs = new Set<string>();
    for (const e of entities) {
        for (const node of e.data.graph.nodes) {
            if (node.nodeType !== "OnCollide") continue;
            const withTag: string = node.properties.withTag ?? "";
            for (const other of entities) {
                if (other === e || other.data.tag !== withTag) continue;
                if (!e.overlaps(other)) continue;
                const pairKey = `${node.id}:${other.data.id}`;
                currentPairs.add(pairKey);
                if (!overlapPairs.has(pairKey)) {
                    runFrom(node.id, e, e.data.graph, destroyEntity);
                }
            }
        }
    }
    overlapPairs = currentPairs;
}

function update(time: number): void {
    const dt = lastTime < 0 ? 0 : Math.min(time - lastTime, 0.05);
    lastTime = time;
    if (dt <= 0) return;

    const [worldX, worldY] = camera.screenToWorld(input.mouseX, input.mouseY);
    const justPressed = input.mouseDown && !prevMouseDown;
    const justReleased = !input.mouseDown && prevMouseDown;
    prevMouseDown = input.mouseDown;

    if (mode === "edit") {
        // Only treat a press as a world click if it didn't start on a UI window/widget - a
        // Toolbox/Inspector/Logic button click would otherwise also fire as a click on the
        // canvas underneath it (deselecting, or starting a drag), since UI and world input
        // aren't otherwise exclusive. See Input2D.pointerOverUI's doc comment.
        if (justPressed && !input.pointerOverUI()) {
            const hit = findEntityAt(worldX, worldY);
            if (hit) {
                selectedId = hit.data.id;
                dragging = true;
                dragOffsetX = hit.data.x - worldX;
                dragOffsetY = hit.data.y - worldY;
            } else {
                selectedId = null;
            }
        }
        if (justReleased) dragging = false;
        if (dragging) {
            const e = selected();
            if (e) {
                e.data.x = worldX + dragOffsetX;
                e.data.y = worldY + dragOffsetY;
                e.syncTransform();
            }
        }
    } else {
        for (const e of entities) {
            if (e.vx !== 0 || e.vy !== 0) {
                e.data.x += e.vx * dt;
                e.data.y += e.vy * dt;
                e.syncTransform();
            }
        }
        runOnKeyDownNodes();
        runOnCollideNodes();
    }
}

function tagIndex(tag: string): number {
    const i = ENTITY_TAGS.indexOf(tag as EntityTag);
    return i < 0 ? 0 : i;
}

function renderToolbox(): void {
    Entropy.UI.Widget.label(toolboxWin, { text: "Entropy 2D Level Editor", bold: true });
    Entropy.UI.Widget.label(toolboxWin, { text: `Mode: ${mode.toUpperCase()} | Entities: ${entities.length}` });

    Entropy.UI.Widget.dropdown(toolboxWin, {
        label: "New entity tag",
        options: ENTITY_TAGS,
        selectedIndex: tagIndex(nextTag),
        onChange: (i) => { nextTag = ENTITY_TAGS[parseInt(i)] ?? "platform"; }
    });
    Entropy.UI.Widget.dropdown(toolboxWin, {
        label: "New entity shape",
        options: ["rect", "circle"],
        selectedIndex: nextShape === "circle" ? 1 : 0,
        onChange: (i) => { nextShape = parseInt(i) === 1 ? "circle" : "rect"; }
    });

    Entropy.UI.Widget.horizontal(toolboxWin, () => {
        Entropy.UI.Widget.button(toolboxWin, { text: "+ Add Entity", onClick: () => addEntity(nextTag, nextShape) });
        Entropy.UI.Widget.button(toolboxWin, { text: "Delete Selected", onClick: deleteSelected });
    });

    Entropy.UI.Widget.separator(toolboxWin);

    Entropy.UI.Widget.horizontal(toolboxWin, () => {
        Entropy.UI.Widget.button(toolboxWin, { text: "Save Level", onClick: saveLevel });
        Entropy.UI.Widget.button(toolboxWin, { text: "Load Level", onClick: loadLevel });
    });

    Entropy.UI.Widget.button(toolboxWin, {
        text: mode === "edit" ? "Play >" : "Stop (back to Edit)",
        onClick: () => setMode(mode === "edit" ? "play" : "edit")
    });

    if (statusMessage) Entropy.UI.Widget.label(toolboxWin, { text: statusMessage });
}

function renderInspector(): void {
    const e = selected();
    if (!e) {
        Entropy.UI.Widget.label(inspectorWin, { text: "Select an entity to edit its properties." });
        return;
    }

    Entropy.UI.Widget.label(inspectorWin, { text: `Entity ${e.data.id.slice(0, 13)}`, bold: true });

    Entropy.UI.Widget.dropdown(inspectorWin, {
        label: "Tag",
        options: ENTITY_TAGS,
        selectedIndex: tagIndex(e.data.tag),
        onChange: (i) => { e.data.tag = ENTITY_TAGS[parseInt(i)] ?? e.data.tag; }
    });

    Entropy.UI.Widget.numericInput(inspectorWin, { label: "X", value: e.data.x, onChange: (v) => { e.data.x = parseFloat(v); e.syncTransform(); } });
    Entropy.UI.Widget.numericInput(inspectorWin, { label: "Y", value: e.data.y, onChange: (v) => { e.data.y = parseFloat(v); e.syncTransform(); } });
    Entropy.UI.Widget.numericInput(inspectorWin, { label: "Width", value: e.data.w, onChange: (v) => { e.data.w = Math.max(0.1, parseFloat(v)); e.syncTransform(); } });
    Entropy.UI.Widget.numericInput(inspectorWin, { label: "Height", value: e.data.h, onChange: (v) => { e.data.h = Math.max(0.1, parseFloat(v)); e.syncTransform(); } });

    Entropy.UI.Widget.colorInput(inspectorWin, {
        label: "Color",
        color: e.data.color,
        onChange: (c) => {
            const color: [number, number, number, number] = [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, c[3] ?? 1];
            e.data.color = color;
            e.sprite.retint(color);
        }
    });
}

function renderLogic(): void {
    const e = selected();
    if (!e) {
        Entropy.UI.Widget.label(logicWin, { text: "Select an entity to edit its logic graph." });
        return;
    }

    Entropy.UI.Widget.label(logicWin, { text: `Logic for ${e.data.id.slice(0, 13)} - drag nodes, drag between pins to connect, click a wire to delete it.` });

    Entropy.UI.Widget.horizontal(logicWin, () => {
        for (const nodeType of NODE_TYPES) {
            Entropy.UI.Widget.button(logicWin, {
                text: `+ ${nodeType}`,
                onClick: () => {
                    const n = e.data.graph.nodes.length;
                    e.data.graph.nodes.push(makeLogicNode(nodeType, [40 + (n % 4) * 230, 40 + Math.floor(n / 4) * 140]));
                }
            });
        }
    });
    Entropy.UI.Widget.separator(logicWin);

    // Per-node property editors - Entropy.UI has no free-text input widget, so `key` and
    // `message` are dropdowns over a fixed small set rather than user-typed strings. There's
    // also no way to know which node is "selected" in the graph itself (SnarlConfig has no
    // onNodeClicked, only onConnect/onDisconnect/onNodeMoved), so every node in the graph gets
    // an editor row, the same "list them all, filtered by type" approach the Nocode Calculator
    // addon uses for its Number nodes.
    for (const node of e.data.graph.nodes) {
        Entropy.UI.Widget.horizontal(logicWin, () => {
            Entropy.UI.Widget.label(logicWin, { text: node.name });
            if (node.nodeType === "OnKeyDown") {
                Entropy.UI.Widget.dropdown(logicWin, {
                    label: "key", options: KEY_OPTIONS,
                    selectedIndex: Math.max(0, KEY_OPTIONS.indexOf(node.properties.key ?? "d")),
                    onChange: (i) => { node.properties.key = KEY_OPTIONS[parseInt(i)] ?? "d"; }
                });
            } else if (node.nodeType === "OnCollide") {
                Entropy.UI.Widget.dropdown(logicWin, {
                    label: "withTag", options: ENTITY_TAGS,
                    selectedIndex: tagIndex(node.properties.withTag ?? "player"),
                    onChange: (i) => { node.properties.withTag = ENTITY_TAGS[parseInt(i)] ?? "player"; }
                });
            } else if (node.nodeType === "SetVelocity") {
                Entropy.UI.Widget.numericInput(logicWin, { label: "vx", value: node.properties.vx ?? 0, onChange: (v) => { node.properties.vx = parseFloat(v); } });
                Entropy.UI.Widget.numericInput(logicWin, { label: "vy", value: node.properties.vy ?? 0, onChange: (v) => { node.properties.vy = parseFloat(v); } });
            } else if (node.nodeType === "SetColor") {
                Entropy.UI.Widget.colorInput(logicWin, {
                    label: "color",
                    color: [node.properties.r ?? 1, node.properties.g ?? 1, node.properties.b ?? 1, node.properties.a ?? 1],
                    onChange: (c) => { node.properties.r = c[0]; node.properties.g = c[1]; node.properties.b = c[2]; node.properties.a = c[3]; }
                });
            } else if (node.nodeType === "Log") {
                Entropy.UI.Widget.dropdown(logicWin, {
                    label: "message", options: LOG_MESSAGES,
                    selectedIndex: Math.max(0, LOG_MESSAGES.indexOf(node.properties.message ?? LOG_MESSAGES[0])),
                    onChange: (i) => { node.properties.message = LOG_MESSAGES[parseInt(i)] ?? LOG_MESSAGES[0]; }
                });
            }
        });
    }
    if (e.data.graph.nodes.length > 0) Entropy.UI.Widget.separator(logicWin);

    Entropy.UI.Widget.snarl(logicWin, {
        id: `logic_${e.data.id}`,
        graph: e.data.graph,
        onConnect: (params) => {
            const [fromNode, fromPin, toNode, toPin] = params;
            e.data.graph.connections = e.data.graph.connections.filter(c => !(c.toNode === toNode && c.toPin === toPin));
            e.data.graph.connections.push({ fromNode, fromPin, toNode, toPin });
        },
        onDisconnect: (params) => {
            const [fromNode, fromPin, toNode, toPin] = params;
            e.data.graph.connections = e.data.graph.connections.filter(c => !(c.fromNode === fromNode && c.fromPin === fromPin && c.toNode === toNode && c.toPin === toPin));
        },
        onNodeMoved: (nodeId, position) => {
            const n = e.data.graph.nodes.find(n => n.id === nodeId);
            if (n) n.position = position;
        }
    });
}

addon.onInit(() => {
    pipelineId = createSpritePipeline("Sprite2D");
    rectTex = createSolidTexture([1, 1, 1, 1]);
    circleTex = createCircleTexture(64, [1, 1, 1, 1]);

    camera = new Camera2D(VIEW_HEIGHT);
    camera.lookAt(0, 0);
    input = new Input2D();

    toolboxWin = Entropy.UI.createWindow({ title: "Toolbox", width: 300, height: 400, x: 20, y: 20, onRender: renderToolbox });
    inspectorWin = Entropy.UI.createWindow({ title: "Inspector", width: 300, height: 300, x: 20, y: 440, onRender: renderInspector });
    logicWin = Entropy.UI.createWindow({ title: "Logic", width: 900, height: 420, x: 340, y: 20, onRender: renderLogic });

    // Two default entities so the editor isn't empty on first launch - a player-tagged rect and
    // a trigger-tagged rect, close enough to collide once Play is pressed and moved into.
    addEntity("player", "rect");
    addEntity("trigger", "rect");
    selectedId = null;

    Entropy.println("Entropy 2D Level Editor initialized");
});

addon.onUpdatePlus("Global", (time) => update(time));
