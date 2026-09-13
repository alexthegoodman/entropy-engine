// Document Editor Demo - the exercise addon for `entropy_gui::widgets_doc_editor::DocEditor`,
// a true multi-page document editor (fixed page size/margins, paragraphs that flow and break
// across page boundaries, basic bold/italic formatting). Unlike `tracks`/`keyframeTimeline`,
// the document itself never crosses into JS - it lives entirely Rust-side, keyed by the
// widget's id, so a large document isn't re-serialized through JSON 60 times a second (see
// `DocEditorConfig` in addon.d.ts and the widget's own module docs for why). This addon only
// supplies page geometry and reads back word/page-count stats each frame.

const addonInfo = {
    name: "Document Editor Demo",
    version: "1.0.0",
    description: "Exercises the new multi-page DocEditor widget - real pagination, margins, bold/italic",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

let stats = { words: 0, chars: 0, pages: 1 };

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "Document Editor Demo",
        width: 1000,
        height: 820,
        x: 20,
        y: 20,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "Document Editor Demo", bold: true });
    Entropy.UI.Widget.label(win, {
        text: "Click the page to place the cursor and type. Bold/Italic apply to a selection " +
              "(Shift+Arrow) or toggle formatting for what you type next. \"Load 300-Paragraph " +
              "Sample\" seeds a multi-page document to show real pagination."
    });
    Entropy.UI.Widget.label(win, { text: `${stats.words} words · ${stats.chars} characters · ${stats.pages} pages` });
    Entropy.UI.Widget.separator(win);

    Entropy.UI.Widget.docEditor(win, {
        id: "main_doc",
        pageWidth: 816,
        pageHeight: 1056,
        margin: 96,
        onStats: (s) => { stats = s; }
    });
}

addon.onInit(async () => {
    setupUI();
});
