// HTML UI Experiment - `Entropy.UI.Widget.html()` parses an HTML string (now with a basic CSS
// engine behind it - see src/deno/html_css.rs and html_layout.rs) into entropy_gui widgets laid
// out by `taffy` (Block by default, Flex opt-in via `display: flex`). Not a browser: no text
// wrapping, no specificity-aware cascade, no position/float/grid. `<img>` renders a real fetched
// bitmap. See html_layout.rs's doc comment for the full "what this covers" list, including the
// standing security note: nothing here ever executes fetched content as code - `<script>` is
// skipped outright, never read. If a future session ever adds real remote-script execution, that
// JS must run with CLI/filesystem/multithreading access denied by default, gated behind explicit
// user consent before any of the three is granted - a malicious page must not be able to touch
// the host machine just because the user browsed to it.
//
// Two modes, switched with the buttons at the top: hand-authored markup (showing what the CSS
// subset can do), and a real fetched page at whatever URL you type in.

const addonInfo = {
    name: "HTML UI Experiment",
    version: "1.0.0",
    description: "Renders HTML+CSS - including real, fetched webpages - through entropy_gui via a taffy layout",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

const DEMO_MARKUP = `
<style>
  h1 { color: #3b82f6; }
  .card { background-color: #1e293b; border: 1px solid #475569; padding: 12px; }
  .row { display: flex; flex-direction: row; gap: 12px; align-items: center; }
  .pill { background-color: #334155; color: #e2e8f0; padding: 4px 10px; }
</style>
<div>
  <h1>Entropy HTML UI</h1>
  <p>This block is <b>parsed</b> straight into entropy_gui widgets, laid out by a real (if
  basic) CSS engine - box model, backgrounds, borders and flexbox all come from <code>taffy</code>.
  Text still never wraps, and there's no specificity-aware cascade - see html_layout.rs.</p>
  <hr/>
  <div class="card">
    <p>A bordered, padded, background-colored box - all from the <code>.card</code> class above.</p>
    <div class="row">
      <div class="pill">flex row</div>
      <div class="pill">gap: 12px</div>
      <div class="pill">align-items: center</div>
    </div>
  </div>
  <h2>Try it</h2>
  <div class="row">
    <button>A real button</button>
    <input type="checkbox" />
  </div>
  <input type="text" placeholder="Type here" />
  <a href="https://github.com">A link (opens in your default browser)</a>
  <h2>A real fetched image</h2>
  <img src="https://placehold.co/240x120.png" alt="placeholder" />
</div>
`;

const DEFAULT_URL = "https://example.com";

let mode: "markup" | "webpage" = "markup";
let urlInput = DEFAULT_URL;
let currentUrl = DEFAULT_URL;
let fetchedHtml: string | null = null;
let fetchError: string | null = null;
let loading = false;
let pendingFetch: string | null = null;
type HistoryEntry = { url: string, html: string };
let history: HistoryEntry[] = [];
let historyIndex = -1;
let bookmarks: string[] = [];

function normalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
}

function loadPage(url: string, addToHistory: boolean) {
    if (pendingFetch) Entropy.Net.cancelText(pendingFetch);
    currentUrl = url;
    urlInput = url;
    fetchedHtml = null;
    fetchError = null;
    loading = true;
    pendingFetch = Entropy.Net.fetchText(url);
    pendingHistoryEntry = addToHistory;
}

let pendingHistoryEntry = false;

function pollPageFetch() {
    if (!pendingFetch) return;
    const result = Entropy.Net.pollText(pendingFetch);
    if (!result.done) return;
    pendingFetch = null;
    loading = false;
    if (result.error) {
        fetchError = result.error;
        return;
    }
    fetchedHtml = result.text || "";
    if (pendingHistoryEntry) {
        history = history.slice(0, historyIndex + 1);
        history.push({ url: currentUrl, html: fetchedHtml });
        historyIndex = history.length - 1;
    }
    pendingHistoryEntry = false;
}

function navigate(rawUrl: string) {
    loadPage(normalizeUrl(rawUrl), true);
}

function goHistory(index: number) {
    const page = history[index];
    if (!page) return;
    historyIndex = index;
    currentUrl = page.url;
    urlInput = page.url;
    fetchedHtml = page.html;
    fetchError = null;
}

function addBookmark() {
    if (!bookmarks.includes(currentUrl)) bookmarks.push(currentUrl);
}

function setupUI() {
    const win = Entropy.UI.createWindow({
        title: "HTML UI Experiment",
        width: 900,
        height: 760,
        x: 40,
        y: 40,
        onRender: () => renderUI(win)
    });
}

function renderUI(win: string) {
    pollPageFetch();
    Entropy.UI.Widget.label(win, { text: "HTML-as-UI Experiment", bold: true });
    Entropy.UI.Widget.label(win, { text: "entropy_gui widgets, described as HTML+CSS, laid out with taffy." });

    Entropy.UI.Widget.horizontal(win, (tid) => {
        Entropy.UI.Widget.button(tid, {
            text: mode === "markup" ? "> Markup Demo" : "Markup Demo",
            id: "browser-mode-markup",
            onClick: () => { mode = "markup"; }
        });
        Entropy.UI.Widget.button(tid, {
            text: mode === "webpage" ? "> Real Webpage" : "Real Webpage",
            id: "browser-mode-webpage",
            onClick: () => {
                mode = "webpage";
                if (fetchedHtml === null && fetchError === null) navigate(currentUrl);
            }
        });
    });
    Entropy.UI.Widget.separator(win);

    if (mode === "markup") {
        Entropy.UI.Widget.html(win, DEMO_MARKUP);
        return;
    }

    Entropy.UI.Widget.horizontal(win, (tid) => {
        Entropy.UI.Widget.button(tid, { text: "←", id: "browser-back", onClick: () => goHistory(historyIndex - 1) });
        Entropy.UI.Widget.button(tid, { text: "→", id: "browser-forward", onClick: () => goHistory(historyIndex + 1) });
        Entropy.UI.Widget.textInput(tid, {
            label: "URL",
            id: "browser-url",
            value: urlInput,
            onChange: (v) => { urlInput = v; }
        });
        // go
    });
    Entropy.UI.Widget.horizontal(win, (tid) => {
        Entropy.UI.Widget.button(tid, { text: "Go", id: "browser-go", onClick: () => navigate(urlInput) });
        Entropy.UI.Widget.button(tid, { text: "Bookmark", id: "browser-bookmark", onClick: addBookmark });
        for (const bookmark of bookmarks) {
            Entropy.UI.Widget.button(tid, { text: bookmark, onClick: () => navigate(bookmark) });
        }
    });
    Entropy.UI.Widget.separator(win);

    if (fetchError) {
        Entropy.UI.Widget.label(win, { text: `Fetch failed: ${fetchError}` });
    } else if (loading || fetchedHtml === null) {
        Entropy.UI.Widget.label(win, { text: "Fetching..." });
    } else {
        Entropy.UI.Widget.html(win, fetchedHtml, {
            id: "browser-page",
            baseUrl: currentUrl,
            onLinkClick: (url) => navigate(url)
        });
    }
}

addon.onInit(() => {
    navigate(currentUrl);
    setupUI();
});
