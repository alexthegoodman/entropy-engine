// HTML UI Experiment - `Entropy.UI.Widget.html()` parses an HTML string into entropy_gui
// widgets (src/deno/html_ui.rs) as an optional, XML-shaped alternative to writing
// `Widget.label(...)`/`Widget.button(...)` calls by hand. There's deliberately no CSS engine
// behind it - no box model, no styling beyond "headings are bold" - so the real experiment
// this addon runs is: fetch an actual webpage off the internet and see how far tag shape alone
// gets you with zero style parsing.
//
// Two modes, switched with the buttons at the top: hand-authored markup (showing the
// tag-to-widget mapping deliberately), and a real fetched page.

const addonInfo = {
    name: "HTML UI Experiment",
    version: "1.0.0",
    description: "Renders HTML - including real, fetched webpages - through entropy_gui with no CSS",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const DEMO_MARKUP = `
<div>
  <h1>Entropy HTML UI</h1>
  <p>This block is <b>parsed</b> straight into entropy_gui widgets - no JSX, no imperative
  <code>Widget.*</code> calls. It's an optional, alternative description format, not a
  replacement for the existing API.</p>
  <hr/>
  <h2>What maps to what</h2>
  <ul>
    <li>Headings (h1-h6) become bold labels - there is no font-size scale, so h1 and h6 look
    the same</li>
    <li>Paragraphs, divs and list items each get their own line</li>
    <li>Links become real, clickable entropy_gui hyperlinks</li>
    <li>Inputs, buttons, checkboxes and selects map to their entropy_gui equivalents</li>
  </ul>
  <h2>Try it</h2>
  <button>A real button</button>
  <input type="text" placeholder="Type here" />
  <input type="checkbox" />
  <a href="https://github.com">A link (opens in your default browser)</a>
</div>
`;

const PAGES: { label: string; url: string }[] = [
    // The canonical minimal test page - stable, tiny, has a heading/paragraph/link.
    { label: "example.com", url: "https://example.com" },
    { label: "indie-machine.com", url: "https://indie-machine.com" },
];

let mode: "markup" | "webpage" = "markup";
let pageIndex = 0;
let fetchedHtml: string | null = null;
let fetchError: string | null = null;

function fetchPage(index: number) {
    fetchedHtml = null;
    fetchError = null;
    try {
        // Blocking (see Entropy.Net.getText's doc comment) - fine here since it only runs from
        // a button click / onInit, never from the per-frame onRender below.
        fetchedHtml = Entropy.Net.getText(PAGES[index].url);
    } catch (e) {
        fetchError = String(e);
    }
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "HTML UI Experiment",
        width: 900,
        height: 700,
        x: 40,
        y: 40,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    Entropy.UI.Widget.label(win, { text: "HTML-as-UI Experiment", bold: true });
    Entropy.UI.Widget.label(win, { text: "entropy_gui widgets, described as HTML - no CSS, tag shape only." });

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.button(win, {
            text: mode === "markup" ? "> Markup Demo" : "Markup Demo",
            onClick: () => { mode = "markup"; }
        });
        Entropy.UI.Widget.button(win, {
            text: mode === "webpage" ? "> Real Webpage" : "Real Webpage",
            onClick: () => {
                mode = "webpage";
                if (fetchedHtml === null && fetchError === null) fetchPage(pageIndex);
            }
        });
    });
    Entropy.UI.Widget.separator(win);

    if (mode === "markup") {
        Entropy.UI.Widget.html(win, DEMO_MARKUP);
        return;
    }

    Entropy.UI.Widget.horizontal(win, () => {
        Entropy.UI.Widget.dropdown(win, {
            label: "Page",
            options: PAGES.map(p => p.label),
            selectedIndex: pageIndex,
            onChange: (idx) => { pageIndex = parseInt(idx, 10); fetchPage(pageIndex); }
        });
        Entropy.UI.Widget.button(win, { text: "Refetch", onClick: () => fetchPage(pageIndex) });
    });
    Entropy.UI.Widget.separator(win);

    if (fetchError) {
        Entropy.UI.Widget.label(win, { text: `Fetch failed: ${fetchError}` });
    } else if (fetchedHtml === null) {
        Entropy.UI.Widget.label(win, { text: "Fetching..." });
    } else {
        Entropy.UI.Widget.html(win, fetchedHtml);
    }
}

addon.onInit(() => {
    fetchPage(pageIndex);
    setupUI();
});
