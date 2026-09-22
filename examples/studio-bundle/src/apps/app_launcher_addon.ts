// Entropy App Launcher - a home screen for the other example apps. Two frosted-glass panels
// (`glass: true`, which samples the engine's real per-frame blur target - see
// `EntropyApp::with_glass_blur` and `core/glass_blur.rs`) float over a drifting 3D backdrop, so
// what shows through the glass is the actual scene, blurred, not a flat translucent fill.
//
// Which apps are "installed" is persisted through this addon's own IO.save/load (the app's
// `.with_data_dir(...)` in src/bin/example.rs decides where). Launching one calls
// `Entropy.System.launchExample`, which starts this same executable again with that example's
// name - fenced by `entropy_engine::LAUNCHABLE_EXAMPLES`, so no arbitrary string ever reaches a
// process spawn.

const addonInfo = {
    name: "App Launcher",
    version: "1.0.0",
    description: "A glass home screen for Entropy's example apps, with one-click install and launch",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true, graphics: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

interface CatalogEntry {
    name: string;
    title: string;
    blurb: string;
}

// Titles and blurbs live here rather than in the engine: `LAUNCHABLE_EXAMPLES` is a security
// fence and stays a bare list of names. Anything the engine can launch but this catalog does not
// describe still shows up under its raw name (see `catalogFor`).
const CATALOG: CatalogEntry[] = [
    { name: "daw", title: "DAW", blurb: "Arrangement, wavetable synth, drum racks, VST3" },
    { name: "canvas-surface-demo", title: "Canvas Surfaces", blurb: "Draw on 3D surfaces and wire up gameplay" },
    { name: "cc-manager", title: "CC Manager", blurb: "Kanban board backed by a plain JSON file" },
    { name: "doc-editor-demo", title: "Document Editor", blurb: "Paginated rich text with per-run fonts" },
    { name: "fft-water", title: "FFT Water", blurb: "Ocean surface from an FFT on the GPU" },
    { name: "fft-river", title: "FFT River", blurb: "Flowing river built on the same spectrum" },
    { name: "game2d", title: "2D Arena", blurb: "Sprites, input and collision" },
    { name: "level-editor-2d", title: "2D Level Editor", blurb: "Tile and entity authoring" },
    { name: "light-hive", title: "Light Hive", blurb: "Point-light shader presets on a real model" },
    { name: "html-ui-demo", title: "HTML UI", blurb: "Real HTML and CSS through taffy" },
    { name: "keyframe-tracks-demo", title: "Clip & Curve Editor", blurb: "Keyframe timeline and track view" },
    { name: "mcp-tools-demo", title: "MCP Tools", blurb: "Expose addon functions to an agent" },
    { name: "media-player", title: "Media Player", blurb: "Hardware-decoded video playback" },
    { name: "ml-graph-demo", title: "ML Graph Trainer", blurb: "Build and train a small net" },
    { name: "node-graph", title: "Nocode Calculator", blurb: "Node graph editor" },
    { name: "stylus-drawing", title: "Stylus Drawing", blurb: "Pressure and tilt from a real pen" },
    { name: "theme-gallery", title: "Theme Gallery", blurb: "Every widget in every theme" },
    { name: "video-export-demo", title: "Video Export", blurb: "Render the scene out to H.264" },
];

// What a fresh install starts with, so the grid is never empty on first run.
const DEFAULT_INSTALLED = ["daw", "canvas-surface-demo", "cc-manager", "theme-gallery"];

const RSS_URL = "http://localhost:3000/rss.xml";
const FEED_ITEMS = 2;

interface LauncherState {
    installed: string[];
    lastLaunch?: { name: string; pid: number };
}

interface FeedPost {
    title: string;
    link: string;
    date: string;
}

let installed: string[] = [];
let lastLaunch: { name: string; pid: number } | undefined;
let showDiscover = false;
// A pid is the whole handle launchExample gives back, so this line reports that a process was
// created - never that the app it started came up, which nothing here can see.
let launchStatus = "";
let feed: FeedPost[] = [];
let feedError: string | null = null;
let pendingFeed: string | null = null;
let backdropAngle = 0;

function catalogFor(name: string): CatalogEntry {
    return CATALOG.find((entry) => entry.name === name) ?? { name, title: name, blurb: "" };
}

function launchable(): string[] {
    // Everything the catalog knows about, in catalog order, then anything installed that it does
    // not (a save written by an older or newer build).
    const known = CATALOG.map((entry) => entry.name);
    return known.concat(installed.filter((name) => !known.includes(name)));
}

function loadState() {
    const saved = addon.IO.load() as LauncherState | null;
    installed = saved && Array.isArray(saved.installed) ? saved.installed.slice() : DEFAULT_INSTALLED.slice();
    lastLaunch = saved?.lastLaunch;
}

function saveState() {
    addon.IO.save({ installed, lastLaunch } as LauncherState, { pretty: true });
}

function install(name: string) {
    if (installed.includes(name)) return;
    installed.push(name);
    saveState();
}

function uninstall(name: string) {
    const index = installed.indexOf(name);
    if (index === -1) return;
    installed.splice(index, 1);
    saveState();
}

function launch(name: string) {
    try {
        const pid = Entropy.System.launchExample(name);
        lastLaunch = { name, pid };
        launchStatus = `Started ${catalogFor(name).title} (pid ${pid})`;
        saveState();
    } catch (error) {
        launchStatus = `Could not start ${catalogFor(name).title}: ${error}`;
    }
}

// deno_core has no DOMParser and no XML parser of any kind, so the feed is read with two
// regexes: the item blocks, then the three fields inside one. Good enough for a feed this app
// also owns; it is not a general RSS reader.
function parseFeed(xml: string, limit: number): FeedPost[] {
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const field = (block: string, tag: string): string => {
        const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        if (!match) return "";
        return match[1]
            .replace(/^\s*<!\[CDATA\[/, "")
            .replace(/\]\]>\s*$/, "")
            .trim();
    };
    return items.slice(0, limit).map((block) => ({
        title: field(block, "title"),
        link: field(block, "link"),
        date: field(block, "pubDate"),
    }));
}

function startFeedFetch() {
    feedError = null;
    pendingFeed = Entropy.Net.fetchText(RSS_URL);
}

function pollFeed() {
    if (!pendingFeed) return;
    const result = Entropy.Net.pollText(pendingFeed);
    if (!result.done) return;
    pendingFeed = null;
    if (result.error) {
        feedError = result.error;
        return;
    }
    feed = parseFeed(result.text || "", FEED_ITEMS);
    if (feed.length === 0) feedError = "The feed came back with no posts.";
}

// 12 floats per vertex: position(3), normal(3), uv(2), color(4) - the layout every
// Entropy.Model.createMesh buffer uses.
function quad(
    center: [number, number, number],
    halfWidth: number,
    halfHeight: number,
    top: [number, number, number],
    bottom: [number, number, number],
): { vertices: number[]; indices: number[] } {
    const [cx, cy, cz] = center;
    const corners: [number, number, [number, number, number]][] = [
        [cx - halfWidth, cy - halfHeight, bottom],
        [cx + halfWidth, cy - halfHeight, bottom],
        [cx + halfWidth, cy + halfHeight, top],
        [cx - halfWidth, cy + halfHeight, top],
    ];
    const vertices: number[] = [];
    corners.forEach(([x, y, color], index) => {
        const uv = [[0, 1], [1, 1], [1, 0], [0, 0]][index];
        vertices.push(x, y, cz, 0, 0, 1, uv[0], uv[1], color[0], color[1], color[2], 1);
    });
    return { vertices, indices: [0, 1, 2, 0, 2, 3] };
}

// Overlapping wide bands in aurora colours at a few depths. Deliberately large and soft: the
// glass panels blur whatever lands behind them, and small high-contrast detail just turns to
// mush, while broad colour fields stay readable as colour.
const BACKDROP: { id: string; center: [number, number, number]; w: number; h: number; top: [number, number, number]; bottom: [number, number, number] }[] = [
    { id: "launcher_band_deep", center: [0, 0, -9], w: 34, h: 22, top: [0.11, 0.07, 0.24], bottom: [0.03, 0.02, 0.09] },
    { id: "launcher_band_violet", center: [-6, 2.5, -6], w: 16, h: 9, top: [0.55, 0.20, 0.85], bottom: [0.16, 0.06, 0.35] },
    { id: "launcher_band_teal", center: [7, -1.5, -5], w: 15, h: 7, top: [0.10, 0.70, 0.72], bottom: [0.04, 0.22, 0.34] },
    { id: "launcher_band_rose", center: [2, 5.0, -4], w: 18, h: 5, top: [0.95, 0.35, 0.45], bottom: [0.35, 0.10, 0.28] },
    { id: "launcher_band_amber", center: [-3, -5.5, -3], w: 20, h: 6, top: [0.98, 0.65, 0.25], bottom: [0.30, 0.14, 0.06] },
    { id: "launcher_band_indigo", center: [9, 4.5, -2], w: 10, h: 10, top: [0.25, 0.30, 0.95], bottom: [0.06, 0.08, 0.30] },
];

function buildBackdrop() {
    for (const band of BACKDROP) {
        const mesh = quad(band.center, band.w / 2, band.h / 2, band.top, band.bottom);
        Entropy.Model.createMesh({
            id: band.id,
            position: [0, 0, 0],
            vertexData: mesh.vertices,
            indexData: mesh.indices,
            pipelineId: "default",
        } as any);
    }

    Entropy.Lighting.updateSun({
        horizonColor: [0.16, 0.09, 0.30],
        zenithColor: [0.03, 0.02, 0.10],
        sunDirection: [0.1, 0.25, 1.0],
        sunColor: [1.0, 0.92, 0.85],
        sunIntensity: 5.0,
    });
}

// A slow drift rather than a still image: it is what makes the frosted panels read as glass
// instead of a static texture, and it is also what the live BDD tier measures (the pixels behind
// a glass panel have to change when the scene does).
const DRIFT_RADIUS = 2.2;
const DRIFT_SPEED = 0.012;

function driftCamera() {
    Entropy.Camera.setTransform(
        [Math.sin(backdropAngle) * DRIFT_RADIUS, Math.cos(backdropAngle * 0.7) * DRIFT_RADIUS * 0.5, 14],
        [Math.sin(backdropAngle) * 0.6, 0, 0],
    );
}

function setupUI() {
    const apps = Entropy.UI.createWindow({
        title: "Entropy Apps",
        width: 560,
        height: 500,
        x: 32,
        y: 32,
        glass: true,
        onRender: () => renderApps(apps),
    });
    const news = Entropy.UI.createWindow({
        title: "Indie Machine",
        width: 290,
        height: 240,
        x: 610,
        y: 32,
        glass: true,
        onRender: () => renderNews(news),
    });
}

function renderApps(win: string) {
    pollFeed();

    Entropy.UI.Widget.label(win, { text: showDiscover ? "Discover" : "Installed", bold: true });

    if (showDiscover) {
        const missing = launchable().filter((name) => !installed.includes(name));
        if (missing.length === 0) {
            Entropy.UI.Widget.label(win, { text: "Everything in this build is installed." });
        }
        for (const name of missing) {
            const entry = catalogFor(name);
            Entropy.UI.Widget.group(win, (w) => {
                Entropy.UI.Widget.label(w, { text: entry.title, bold: true });
                if (entry.blurb) Entropy.UI.Widget.label(w, { text: entry.blurb });
                Entropy.UI.Widget.button(w, {
                    id: `install-${name}`,
                    text: "Install",
                    onClick: () => install(name),
                });
            });
        }
        Entropy.UI.Widget.separator(win);
        Entropy.UI.Widget.button(win, { id: "show_home", text: "Back to home", onClick: () => { showDiscover = false; } });
        return;
    }

    if (installed.length === 0) {
        Entropy.UI.Widget.label(win, { text: "No apps installed yet - open Discover below." });
    }
    for (const name of installed) {
        const entry = catalogFor(name);
        Entropy.UI.Widget.group(win, (w) => {
            Entropy.UI.Widget.label(w, { text: entry.title, bold: true });
            if (entry.blurb) Entropy.UI.Widget.label(w, { text: entry.blurb });
            Entropy.UI.Widget.horizontal(w, (row) => {
                Entropy.UI.Widget.button(row, { id: `launch-${name}`, text: "Open", onClick: () => launch(name) });
                Entropy.UI.Widget.button(row, { id: `uninstall-${name}`, text: "Remove", onClick: () => uninstall(name) });
            });
        });
    }

    Entropy.UI.Widget.separator(win);
    Entropy.UI.Widget.button(win, { id: "show_discover", text: "Discover more apps", onClick: () => { showDiscover = true; } });
    if (launchStatus) Entropy.UI.Widget.label(win, { text: launchStatus });
}

function renderNews(win: string) {
    Entropy.UI.Widget.label(win, { text: "Latest posts", bold: true });
    if (feedError) {
        Entropy.UI.Widget.label(win, { text: "Couldn't reach Indie Machine (is `npm run dev` running in indie-machine/?)" });
        Entropy.UI.Widget.button(win, { id: "retry_feed", text: "Retry", onClick: () => startFeedFetch() });
        return;
    }
    if (feed.length === 0) {
        Entropy.UI.Widget.label(win, { text: pendingFeed ? "Loading..." : "No posts yet." });
        return;
    }
    for (const post of feed) {
        Entropy.UI.Widget.label(win, { text: post.title, bold: true });
        Entropy.UI.Widget.label(win, { text: post.date });
    }
}

addon.onInit(async () => {
    loadState();
    buildBackdrop();
    driftCamera();
    setupUI();
    startFeedFetch();
});

addon.onUpdatePlus("Global", (_time: number) => {
    backdropAngle += DRIFT_SPEED;
    driftCamera();
});
