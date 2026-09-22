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

import type { IconName, IconStyle } from "../addon";

const addonInfo = {
    name: "App Launcher",
    version: "1.0.0",
    description: "A glass home screen for Entropy's example apps, with one-click install and launch",
    author: ["Entropy Team", "Claude"],
    capabilities: { ui: true, graphics: true }
};

const addon = Entropy.AddonAtom.register(addonInfo);

/** Phosphor icons (`Entropy.Icons`): `icon("play")` alone, `withIcon("play", "Play")` beside text.
 * Regular weight only - Fill and Bold do not draw in the real window (see README, Icons). Icons
 * are never folded into a `Widget.label`'s own text: `ui_frame_labels` (what the live BDD tier's
 * "I see the label" step matches against) records a label's exact string, so an icon prefixed
 * onto a title would break `Then I see the label "DAW"`. Icons that sit beside a title are their
 * own label in a `horizontal` row instead - see `titleRow` below. */
const icon = (name: IconName, style?: IconStyle): string => Entropy.Icons.get(name, style);
const withIcon = (name: IconName, text: string, style?: IconStyle): string => Entropy.Icons.label(name, text, style);

interface CatalogEntry {
    name: string;
    title: string;
    blurb: string;
    icon: IconName;
}

// Titles, blurbs and icons live here rather than in the engine: `LAUNCHABLE_EXAMPLES` is a
// security fence and stays a bare list of names. Anything the engine can launch but this catalog
// does not describe still shows up under its raw name and a generic icon (see `catalogFor`).
const CATALOG: CatalogEntry[] = [
    { name: "daw", title: "DAW", blurb: "Arrangement, wavetable synth, drum racks, VST3", icon: "waveform" },
    { name: "canvas-surface-demo", title: "Canvas Surfaces", blurb: "Draw on 3D surfaces and wire up gameplay", icon: "cube" },
    { name: "cc-manager", title: "CC Manager", blurb: "Kanban board backed by a plain JSON file", icon: "kanban" },
    { name: "doc-editor-demo", title: "Document Editor", blurb: "Paginated rich text with per-run fonts", icon: "file-text" },
    { name: "fft-water", title: "FFT Water", blurb: "Ocean surface from an FFT on the GPU", icon: "waves" },
    { name: "fft-river", title: "FFT River", blurb: "Flowing river built on the same spectrum", icon: "wave-sine" },
    { name: "game2d", title: "2D Arena", blurb: "Sprites, input and collision", icon: "game-controller" },
    { name: "level-editor-2d", title: "2D Level Editor", blurb: "Tile and entity authoring", icon: "grid-four" },
    { name: "light-hive", title: "Light Hive", blurb: "Point-light shader presets on a real model", icon: "lightbulb" },
    { name: "html-ui-demo", title: "HTML UI", blurb: "Real HTML and CSS through taffy", icon: "browser" },
    { name: "keyframe-tracks-demo", title: "Clip & Curve Editor", blurb: "Keyframe timeline and track view", icon: "bezier-curve" },
    { name: "mcp-tools-demo", title: "MCP Tools", blurb: "Expose addon functions to an agent", icon: "network" },
    { name: "media-player", title: "Media Player", blurb: "Hardware-decoded video playback", icon: "monitor-play" },
    { name: "ml-graph-demo", title: "ML Graph Trainer", blurb: "Build and train a small net", icon: "brain" },
    { name: "node-graph", title: "Nocode Calculator", blurb: "Node graph editor", icon: "graph" },
    { name: "stylus-drawing", title: "Stylus Drawing", blurb: "Pressure and tilt from a real pen", icon: "pen-nib" },
    { name: "theme-gallery", title: "Theme Gallery", blurb: "Every widget in every theme", icon: "palette" },
    { name: "video-export-demo", title: "Video Export", blurb: "Render the scene out to H.264", icon: "film-strip" },
];

const FALLBACK_ICON: IconName = "app-window";

// What a fresh install starts with, so the grid is never empty on first run.
const DEFAULT_INSTALLED = ["daw", "canvas-surface-demo", "cc-manager", "theme-gallery"];

// The live Indie Machine site's own feed - the same route the site serves at
// `indie-machine.com/rss.xml` (see `indie-machine/app/rss.xml/route.ts`). No local dev server
// needed; this is a plain HTTPS GET like any other, unauthenticated, read-only.
const RSS_URL = "https://indie-machine.com/rss.xml";
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
    return CATALOG.find((entry) => entry.name === name) ?? { name, title: name, blurb: "", icon: FALLBACK_ICON };
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
        launchStatus = withIcon("check-circle", `Started ${catalogFor(name).title} (pid ${pid})`);
        saveState();
    } catch (error) {
        launchStatus = withIcon("warning-circle", `Could not start ${catalogFor(name).title}: ${error}`);
    }
}

// deno_core has no DOMParser and no XML parser of any kind, so the feed is read with two
// regexes: the item blocks, then the three fields inside one. Good enough for a feed this app
// also owns (the same route indie-machine's own repo serves); it is not a general RSS reader.
function parseFeed(xml: string, limit: number): FeedPost[] {
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    const field = (block: string, tag: string): string => {
        const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        if (!match) return "";
        return match[1]
            .replace(/^\s*<!\[CDATA\[/, "")
            .replace(/\]\]>\s*$/, "")
            .replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&")
            .trim();
    };
    return items.slice(0, limit).map((block) => ({
        title: field(block, "title"),
        link: field(block, "link"),
        date: field(block, "pubDate"),
    }));
}

// "Mon, 21 Sep 2026 00:00:00 GMT" -> "Sep 21, 2026". Falls back to the raw RFC-2822 string for
// anything that does not parse rather than showing "Invalid Date".
function formatDate(pubDate: string): string {
    const parsed = new Date(pubDate);
    if (Number.isNaN(parsed.getTime())) return pubDate;
    return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

// "#RRGGBB" -> [r, g, b, a] in 0..1, the format Entropy.UI.setTheme expects (same helper as
// theme_gallery_addon.ts).
function hex(h: string, a = 1): [number, number, number, number] {
    const v = parseInt(h.replace("#", ""), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a];
}

// A dark, violet-accented theme that matches the aurora backdrop showing through the glass
// panels, with rounder corners than the default Slate so the whole window reads as one glassy
// object rather than a themed dialog sitting on top of a scene.
function applyTheme() {
    Entropy.UI.setTheme({
        background: hex("#0B0A14", 0.92),
        surface: hex("#17142A", 0.72),
        surfaceHover: hex("#241F3F", 0.85),
        border: hex("#4A3F7A", 0.55),
        text: hex("#F1EEFB"),
        accent: hex("#B98CF2"),
        cornerRadius: 12,
        windowCornerRadius: 16,
        itemSpacing: 10,
        buttonPadding: [12, 6],
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
        title: withIcon("squares-four", "Entropy Apps"),
        width: 560,
        height: 500,
        x: 32,
        y: 32,
        glass: true,
        onRender: () => renderApps(apps),
    });
    const news = Entropy.UI.createWindow({
        title: withIcon("rss", "Indie Machine"),
        width: 290,
        height: 260,
        x: 610,
        y: 32,
        glass: true,
        onRender: () => renderNews(news),
    });
}

// An icon beside a title, each its own `Widget.label` so the title's text stays exactly what it
// was (the live BDD tier's "I see the label" step matches a label's full text, not a substring -
// see the doc comment on `icon`/`withIcon` above).
function titleRow(win: string, name: IconName, title: string) {
    Entropy.UI.Widget.horizontal(win, (row) => {
        Entropy.UI.Widget.label(row, { text: icon(name) });
        Entropy.UI.Widget.label(row, { text: title, bold: true });
    });
}

function renderApps(win: string) {
    pollFeed();

    titleRow(win, showDiscover ? "compass" : "squares-four", showDiscover ? "Discover" : "Installed");

    if (showDiscover) {
        const missing = launchable().filter((name) => !installed.includes(name));
        if (missing.length === 0) {
            Entropy.UI.Widget.label(win, { text: "Everything in this build is installed." });
        }
        for (const name of missing) {
            const entry = catalogFor(name);
            Entropy.UI.Widget.group(win, (w) => {
                titleRow(w, entry.icon, entry.title);
                if (entry.blurb) Entropy.UI.Widget.label(w, { text: entry.blurb });
                Entropy.UI.Widget.button(w, {
                    id: `install-${name}`,
                    text: withIcon("download-simple", "Install"),
                    onClick: () => install(name),
                });
            });
        }
        Entropy.UI.Widget.separator(win);
        Entropy.UI.Widget.button(win, { id: "show_home", text: withIcon("arrow-left", "Back to home"), onClick: () => { showDiscover = false; } });
        return;
    }

    if (installed.length === 0) {
        Entropy.UI.Widget.label(win, { text: "No apps installed yet - open Discover below." });
    }
    for (const name of installed) {
        const entry = catalogFor(name);
        Entropy.UI.Widget.group(win, (w) => {
            titleRow(w, entry.icon, entry.title);
            if (entry.blurb) Entropy.UI.Widget.label(w, { text: entry.blurb });
            Entropy.UI.Widget.horizontal(w, (row) => {
                Entropy.UI.Widget.button(row, { id: `launch-${name}`, text: withIcon("rocket-launch", "Open"), onClick: () => launch(name) });
                Entropy.UI.Widget.button(row, { id: `uninstall-${name}`, text: withIcon("trash", "Remove"), onClick: () => uninstall(name) });
            });
        });
    }

    Entropy.UI.Widget.separator(win);
    Entropy.UI.Widget.button(win, { id: "show_discover", text: withIcon("compass", "Discover more apps"), onClick: () => { showDiscover = true; } });
    if (launchStatus) Entropy.UI.Widget.label(win, { text: launchStatus });
}

function renderNews(win: string) {
    titleRow(win, "rss", "Latest posts");
    if (feedError) {
        Entropy.UI.Widget.label(win, { text: withIcon("warning-circle", "Couldn't reach indie-machine.com") });
        Entropy.UI.Widget.button(win, { id: "retry_feed", text: withIcon("arrow-clockwise", "Retry"), onClick: () => startFeedFetch() });
        return;
    }
    if (feed.length === 0) {
        Entropy.UI.Widget.label(win, { text: pendingFeed ? "Loading..." : "No posts yet." });
        return;
    }
    feed.forEach((post, index) => {
        Entropy.UI.Widget.hyperlink(win, { id: `feed-${post.link}`, text: withIcon("arrow-square-out", post.title), url: post.link });
        Entropy.UI.Widget.label(win, { text: withIcon("clock", formatDate(post.date)) });
        if (index < feed.length - 1) Entropy.UI.Widget.separator(win);
    });
}

addon.onInit(async () => {
    loadState();
    applyTheme();
    buildBackdrop();
    driftCamera();
    setupUI();
    startFeedFetch();
});

addon.onUpdatePlus("Global", (_time: number) => {
    backdropAngle += DRIFT_SPEED;
    driftCamera();
});
