// CC Manager - a kanban board for planning Claude Code work across the Common monorepo
// (Entropy Engine, Indie Machine, Yumon Pet). Exercises the new `Entropy.UI.Widget.kanban`
// widget (see `entropy_gui::widgets_kanban`). The board is a plain JSON file, written via
// this addon's own scoped `IO.save`/`IO.load` (which round-trip to `<dataDir>/tasks.json` - see this
// binary's `.with_data_dir(...)` in src/bin/example.rs) - not squirreled away behind a
// project id, so a Claude Code session can read and edit the same file directly with no API
// of its own, and whatever it writes shows up here on this addon's periodic reload.

const addonInfo = {
    name: "tasks",
    version: "1.0.0",
    description: "CC Manager - a kanban board for planning Claude Code work, backed by a plain JSON file a human (via this app) and a Claude Code session (by editing the file) both maintain.",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

interface Card {
    id: string;
    title: string;
    description: string;
    tags: string[];
}

interface Column {
    id: string;
    title: string;
    cards: Card[];
}

interface Board {
    columns: Column[];
}

function defaultBoard(): Board {
    return {
        columns: [
            { id: "backlog", title: "Backlog", cards: [] },
            { id: "in_progress", title: "In Progress", cards: [] },
            { id: "review", title: "Review", cards: [] },
            { id: "done", title: "Done", cards: [] },
        ],
    };
}

let board: Board = defaultBoard();
let selected: { column: string; card: string } | null = null;
let addingToColumn: string | null = null;
let newCardTitle = "";
let editDescription = "";
let editTags = "";
// Re-read tasks.json this often (in frames) so edits a Claude Code session makes to the file
// while this app is open show up without a restart. Skipped while the user has an in-progress
// local edit (a card selected, or the add-card form open) so a reload can't clobber unsaved
// keystrokes - those paths already write straight through to disk on every change anyway.
const RELOAD_INTERVAL_FRAMES = 90;
let frame = 0;

function loadBoard() {
    // `IO` is scoped to this addon's own registration handle, not the global `Entropy`
    // object - see `ScopedAPI` in addon.d.ts.
    const loaded = addon.IO.load() as Board | null;
    board = loaded && Array.isArray(loaded.columns) ? loaded : defaultBoard();
}

function saveBoard() {
    addon.IO.save(board);
}

function findCard(columnId: string, cardId: string): { column: Column; card: Card; index: number } | null {
    const column = board.columns.find((c) => c.id === columnId);
    if (!column) return null;
    const index = column.cards.findIndex((c) => c.id === cardId);
    if (index === -1) return null;
    return { column, card: column.cards[index], index };
}

function setupUI() {
    loadBoard();
    const win = Entropy.UI.createWindow({
        title: "CC Manager",
        width: 1240,
        height: 800,
        x: 20,
        y: 20,
        onRender: () => renderUI(win),
    });
}

function renderUI(win: string) {
    frame++;
    if (frame % RELOAD_INTERVAL_FRAMES === 0 && addingToColumn === null && selected === null) {
        loadBoard();
    }

    Entropy.UI.Widget.label(win, { text: "CC Manager", bold: true });
    Entropy.UI.Widget.label(win, {
        text: "Plan Claude Code work here, or point a Claude Code session at cc-manager/tasks.json directly - both read and write the same file.",
    });
    Entropy.UI.Widget.separator(win);

    if (addingToColumn !== null) {
        const columnId = addingToColumn;
        // A text input fills all remaining horizontal space in its row, so it can't share a
        // `horizontal()` with the buttons that submit it (they'd render past the window's
        // right edge) - the input gets its own row, Add/Cancel go on the next one.
        Entropy.UI.Widget.textInput(win, {
            id: "new_card_title",
            label: `New card in "${columnId}":`,
            value: newCardTitle,
            onChange: (v) => {
                newCardTitle = v;
            },
        });
        // Plain standalone calls, not grouped in one `horizontal()` - a `horizontal()` block
        // placed right after a full-width `textInput` row doesn't render (a pre-existing
        // entropy_gui layout quirk, not specific to this widget); two standalone buttons
        // stack as their own rows instead, which does work.
        Entropy.UI.Widget.button(win, {
            text: "Add",
            onClick: () => {
                const title = newCardTitle.trim();
                if (title.length > 0) {
                    const column = board.columns.find((c) => c.id === columnId);
                    if (column) {
                        column.cards.push({ id: Entropy.generateUUID(), title, description: "", tags: [] });
                        saveBoard();
                    }
                }
                newCardTitle = "";
                addingToColumn = null;
            },
        });
        Entropy.UI.Widget.button(win, {
            text: "Cancel",
            onClick: () => {
                newCardTitle = "";
                addingToColumn = null;
            },
        });
        Entropy.UI.Widget.separator(win);
    }

    // The kanban board below fills all remaining window height, so anything placed after it
    // never shows without a scroll region this window doesn't have - the card editor goes
    // above it instead, same as the add-card form.
    if (selected) {
        const found = findCard(selected.column, selected.card);
        if (!found) {
            selected = null;
        } else {
            Entropy.UI.Widget.label(win, { text: `Editing: ${found.card.title}`, bold: true });
            Entropy.UI.Widget.textInput(win, {
                id: "edit_card_title",
                label: "Title:",
                value: found.card.title,
                onChange: (v) => {
                    found.card.title = v;
                    saveBoard();
                },
            });
            Entropy.UI.Widget.textInput(win, {
                id: "edit_card_description",
                label: "Description:",
                value: editDescription,
                onChange: (v) => {
                    editDescription = v;
                    found.card.description = v;
                    saveBoard();
                },
            });
            Entropy.UI.Widget.textInput(win, {
                id: "edit_card_tags",
                label: "Tags (comma-separated):",
                value: editTags,
                onChange: (v) => {
                    editTags = v;
                    found.card.tags = v.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
                    saveBoard();
                },
            });
            // Standalone, not grouped - see the add-card form's comment above on why a
            // `horizontal()` right after a `textInput` row doesn't render.
            Entropy.UI.Widget.button(win, { text: "Close", onClick: () => { selected = null; } });
            Entropy.UI.Widget.button(win, {
                text: "Delete Card",
                onClick: () => {
                    found.column.cards.splice(found.index, 1);
                    saveBoard();
                    selected = null;
                },
            });
            Entropy.UI.Widget.separator(win);
        }
    }

    Entropy.UI.Widget.kanban(win, {
        id: "cc_manager_board",
        columns: board.columns,
        selected: selected ?? undefined,
        onCardMoved: (card, fromColumn, toColumn, toIndex) => {
            const from = findCard(fromColumn, card);
            if (!from) return;
            const [moved] = from.column.cards.splice(from.index, 1);
            const to = board.columns.find((c) => c.id === toColumn);
            if (!to) {
                // Column vanished mid-drag (shouldn't happen); put it back where it came from.
                from.column.cards.splice(from.index, 0, moved);
                return;
            }
            const clampedIndex = Math.max(0, Math.min(toIndex, to.cards.length));
            to.cards.splice(clampedIndex, 0, moved);
            saveBoard();
        },
        onCardSelected: (column, card) => {
            selected = { column, card };
            const found = findCard(column, card);
            if (found) {
                editDescription = found.card.description;
                editTags = found.card.tags.join(", ");
            }
        },
        onCardDelete: (column, card) => {
            const found = findCard(column, card);
            if (found) {
                found.column.cards.splice(found.index, 1);
                saveBoard();
            }
            if (selected && selected.column === column && selected.card === card) selected = null;
        },
        onAddCard: (column) => {
            addingToColumn = column;
            newCardTitle = "";
        },
        onBackgroundClicked: () => {
            selected = null;
        },
    });
}

addon.onInit(async () => {
    setupUI();
});
