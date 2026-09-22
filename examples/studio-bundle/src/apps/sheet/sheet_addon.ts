// Sheet - a spreadsheet addon exercising the new Entropy.UI.Widget.sheetGrid widget (see
// entropy_gui::widgets_sheet). Alex's own framing for the eventual differentiator here: live,
// beautiful 3D charts built from the same terrain-rendering trick as the wavetable synth's
// sculptable surface, plus color-coded cell borders for marking which column feeds which axis.
// This first pass is deliberately grid-only - the formula engine and the colored borders, with
// no chart yet (see the sheet-chart-3d and related backlog cards in cc-manager/tasks.json for
// what's next).
//
// Cell editing goes through a formula bar (a plain textInput bound to whichever cell is
// selected), not inline in the grid - SheetGrid only ever draws text it's handed and reports
// which cell is selected; everything else (the cell store, formula parsing/evaluation) lives in
// sheet_model.ts so it can be unit-tested with no window at all.

import type { CellAddr, SheetDoc } from "./sheet_model";
import { a1, cellKey, defaultSheet, evaluateSheet } from "./sheet_model";

const addonInfo = {
    name: "sheet",
    version: "1.0.0",
    description: "A spreadsheet grid with formulas (SUM/AVERAGE/MIN/MAX/COUNT) and color-coded cell borders - the first pass of Alex's live-3D-chart spreadsheet idea.",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true },
};

const addon = Entropy.AddonAtom.register(addonInfo);

const ROWS = 30;
const COLS = 12;
const GRID_MAX_HEIGHT = 560;

let doc: SheetDoc = defaultSheet(ROWS, COLS);
let selected: CellAddr = { row: 0, col: 0 };
let formulaDraft = "";
// Re-synced from the document every time `selected` changes, so typing in the formula bar
// doesn't get clobbered by the next frame's re-render.
let lastSyncedSelection = "";

function loadSheet() {
    const loaded = addon.IO.load() as SheetDoc | null;
    doc = loaded && typeof loaded === "object" && loaded.cells ? loaded : defaultSheet(ROWS, COLS);
}

function saveSheet() {
    addon.IO.save(doc, { pretty: true });
}

function getRaw(addr: CellAddr): string {
    return doc.cells[cellKey(addr.row, addr.col)]?.raw ?? "";
}

function setRaw(addr: CellAddr, raw: string) {
    const key = cellKey(addr.row, addr.col);
    const existing = doc.cells[key];
    if (raw.trim() === "" && !existing?.border) {
        delete doc.cells[key];
    } else {
        doc.cells[key] = { raw, border: existing?.border };
    }
    saveSheet();
}

function setBorder(addr: CellAddr, border: [number, number, number, number] | undefined) {
    const key = cellKey(addr.row, addr.col);
    const existing = doc.cells[key];
    if (!border && (!existing || existing.raw.trim() === "")) {
        delete doc.cells[key];
    } else {
        doc.cells[key] = { raw: existing?.raw ?? "", border };
    }
    saveSheet();
}

function selectionKey(addr: CellAddr): string {
    return cellKey(addr.row, addr.col);
}

function setupUI() {
    loadSheet();
    const win = Entropy.UI.createWindow({
        title: "Sheet",
        width: 1400,
        height: 860,
        x: 20,
        y: 20,
        onRender: () => renderUI(win),
    });
}

function renderUI(win: string) {
    // The formula bar shows the raw content of whichever cell is selected. Only re-sync it
    // from the document when the selection itself changes - otherwise every keystroke would
    // be overwritten by the very value it's editing.
    const key = selectionKey(selected);
    if (key !== lastSyncedSelection) {
        formulaDraft = getRaw(selected);
        lastSyncedSelection = key;
    }

    Entropy.UI.Widget.label(win, { text: "Sheet", bold: true });
    Entropy.UI.Widget.label(win, {
        text: "Click a cell, edit it in the formula bar below (try =SUM(A1:A4)), and use the border color to mark which cells feed which axis.",
    });
    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.textInput(win, {
        id: "formula_bar",
        label: `${a1(selected.row, selected.col)}:`,
        value: formulaDraft,
        onChange: (v) => {
            formulaDraft = v;
            setRaw(selected, v);
        },
    });

    const currentBorder = doc.cells[key]?.border ?? [0, 0, 0, 0];
    Entropy.UI.Widget.colorInput(win, {
        label: "Border color",
        color: currentBorder,
        onChange: (c) => {
            const a = c[3] ?? 1;
            setBorder(selected, a > 0.01 ? [c[0], c[1], c[2], a] : undefined);
        },
    });
    Entropy.UI.Widget.button(win, {
        text: "Clear border",
        onClick: () => setBorder(selected, undefined),
    });
    Entropy.UI.Widget.button(win, {
        text: "Clear cell",
        onClick: () => {
            formulaDraft = "";
            setRaw(selected, "");
        },
    });
    Entropy.UI.Widget.separator(win);

    const evaluated = evaluateSheet(doc);
    const cells = Object.entries(doc.cells).map(([k, data]) => {
        const [rowStr, colStr] = k.split(":");
        const row = parseInt(rowStr, 10);
        const col = parseInt(colStr, 10);
        const value = evaluated.get(k);
        return {
            row,
            col,
            text: value?.text ?? data.raw,
            numeric: value?.numeric ?? false,
            error: value?.error ?? false,
            border: data.border,
        };
    });

    Entropy.UI.Widget.sheetGrid(win, {
        id: "sheet_grid",
        cells,
        selected: { row: selected.row, col: selected.col },
        options: { rows: ROWS, cols: COLS, maxHeight: GRID_MAX_HEIGHT },
        onCellSelected: (row, col) => {
            selected = { row, col };
        },
        onCellClear: (row, col) => {
            setRaw({ row, col }, "");
            if (selected.row === row && selected.col === col) formulaDraft = "";
        },
    });
}

addon.onInit(async () => {
    setupUI();
});
