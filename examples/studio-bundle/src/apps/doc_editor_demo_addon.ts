// Document Editor Demo - the exercise addon for `entropy_gui::widgets_doc_editor::DocEditor`,
// a true multi-page document editor (fixed page size/margins, paragraphs that flow and break
// across page boundaries, per-run font family/size/color/bold/italic, an optional continuous
// mode). Unlike `tracks`/`keyframeTimeline`, the document itself never crosses into JS - it
// lives entirely Rust-side, keyed by the widget's id (see `DocEditorConfig` in addon.d.ts and
// the widget's own module docs for why). This widget draws only the page canvas - the entire
// toolbar below (Bold/Italic/font/size/color/pagination/load-sample) is built out of ordinary
// `Entropy.UI.Widget.*` controls in this addon and driven through the `docEditor*` command
// functions, reading current state back from `onStats` so the buttons/inputs reflect it.

const addonInfo = {
    name: "Document Editor Demo",
    version: "1.0.0",
    description: "Exercises the new multi-page DocEditor widget - real pagination, fonts, sizes, colors, an addon-built toolbar",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const DOC_ID = "main_doc";

let stats = {
    words: 0, chars: 0, pages: 1, paginated: true,
    bold: false, italic: false, fontFamily: "Figtree", fontSize: 15,
    color: [0.08, 0.08, 0.08, 1] as [number, number, number, number],
};

let fontNames: string[] = [];
let fontIndex = 0;

function setupUI() {
    fontNames = Entropy.UI.Widget.docEditorFontNames();
    fontIndex = Math.max(0, fontNames.indexOf(stats.fontFamily));

    const win = Entropy.UI.createWindow({
        title: "Document Editor Demo",
        width: 1000,
        height: 860,
        x: 20,
        y: 20,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Document Editor Demo", bold: true });
    Entropy.UI.Widget.label(win, {
        text: "Click the page to place the cursor and type. This whole toolbar is addon-built, " +
              "driven through docEditor* command functions - the widget itself is just the page canvas."
    });

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, {
            text: stats.bold ? "Bold [on]" : "Bold",
            onClick: () => Entropy.UI.Widget.docEditorToggleBold(DOC_ID)
        });
        Entropy.UI.Widget.button(win, {
            text: stats.italic ? "Italic [on]" : "Italic",
            onClick: () => Entropy.UI.Widget.docEditorToggleItalic(DOC_ID)
        });
        Entropy.UI.Widget.checkbox(win, {
            label: "Paginated",
            value: stats.paginated,
            onChange: (v) => Entropy.UI.Widget.docEditorSetPaginated(DOC_ID, v)
        });
        Entropy.UI.Widget.button(win, {
            text: "Load 300-Paragraph Sample",
            onClick: () => Entropy.UI.Widget.docEditorLoadSample(DOC_ID, 300)
        });
    });

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.label(win, { text: "Font:" });
        Entropy.UI.Widget.dropdown(win, {
            label: "",
            options: fontNames,
            selectedIndex: fontIndex,
            onChange: (indexStr) => {
                fontIndex = parseInt(indexStr, 10);
                const family = fontNames[fontIndex];
                if (family) Entropy.UI.Widget.docEditorSetFontFamily(DOC_ID, family);
            }
        });
        Entropy.UI.Widget.label(win, { text: "Size:" });
        Entropy.UI.Widget.numericInput(win, {
            label: "",
            value: stats.fontSize,
            onChange: (v) => {
                const size = parseFloat(v);
                if (!Number.isNaN(size)) Entropy.UI.Widget.docEditorSetFontSize(DOC_ID, size);
            }
        });
        Entropy.UI.Widget.colorInput(win, {
            label: "Color:",
            color: stats.color,
            onChange: (c) => Entropy.UI.Widget.docEditorSetColor(DOC_ID, c as [number, number, number, number])
        });
    });

    Entropy.UI.Widget.label(win, {
        text: `${stats.words} words - ${stats.chars} characters - ${stats.pages} page${stats.pages === 1 ? "" : "s"}` +
              (stats.paginated ? "" : " (continuous mode)")
    });
    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.docEditor(win, {
        id: DOC_ID,
        pageWidth: 816,
        pageHeight: 1056,
        margin: 96,
        onStats: (s) => { stats = s; }
    });
}

addon.onInit(async () => {
    setupUI();
});
