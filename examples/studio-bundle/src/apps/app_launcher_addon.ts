// Entropy App Launcher - a home screen for the other example apps, styled after a phone launcher:
// one centered, borderless glass panel, icon-and-name tiles with no bordered cards or blurb text,
// and a flowing procedural backdrop instead of the old flat glow quads. `glass: true` samples the
// engine's real per-frame blur target (see `EntropyApp::with_glass_blur` and `core/glass_blur.rs`),
// so what shows through the panel is the actual drifting backdrop, blurred, not a flat fill.
//
// Which apps are "installed" is persisted through this addon's own IO.save/load (the app's
// `.with_data_dir(...)` in src/bin/example.rs decides where). Launching one calls
// `Entropy.System.launchExample`, which starts this same executable again with that example's
// name - fenced by `entropy_engine::LAUNCHABLE_EXAMPLES`, so no arbitrary string ever reaches a
// process spawn.

import type { IconName, IconStyle } from "../addon";

const addonInfo = {
    name: "App Launcher",
    version: "2.0.0",
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
    icon: IconName;
}

// Titles and icons live here rather than in the engine: `LAUNCHABLE_EXAMPLES` is a security fence
// and stays a bare list of names. Anything the engine can launch but this catalog does not
// describe still shows up under its raw name and a generic icon (see `catalogFor`). Blurbs were
// dropped along with the bordered per-app cards they used to sit in - a phone launcher names an
// app under its icon and nothing else.
const CATALOG: CatalogEntry[] = [
    { name: "daw", title: "DAW", icon: "waveform" },
    { name: "canvas-surface-demo", title: "Canvas Surfaces", icon: "cube" },
    { name: "cc-manager", title: "CC Manager", icon: "kanban" },
    { name: "doc-editor-demo", title: "Document Editor", icon: "file-text" },
    { name: "fft-water", title: "FFT Water", icon: "waves" },
    { name: "fft-river", title: "FFT River", icon: "wave-sine" },
    { name: "game2d", title: "2D Arena", icon: "game-controller" },
    { name: "level-editor-2d", title: "2D Level Editor", icon: "grid-four" },
    { name: "light-hive", title: "Light Hive", icon: "lightbulb" },
    { name: "html-ui-demo", title: "HTML UI", icon: "browser" },
    { name: "keyframe-tracks-demo", title: "Clip & Curve Editor", icon: "bezier-curve" },
    { name: "mcp-tools-demo", title: "MCP Tools", icon: "network" },
    { name: "media-player", title: "Media Player", icon: "monitor-play" },
    { name: "ml-graph-demo", title: "ML Graph Trainer", icon: "brain" },
    { name: "node-graph", title: "Nocode Calculator", icon: "graph" },
    { name: "stylus-drawing", title: "Stylus Drawing", icon: "pen-nib" },
    { name: "theme-gallery", title: "Theme Gallery", icon: "palette" },
    { name: "video-export-demo", title: "Video Export", icon: "film-strip" },
];

const FALLBACK_ICON: IconName = "app-window";

// What a fresh install starts with, so the grid is never empty on first run.
const DEFAULT_INSTALLED = ["daw", "canvas-surface-demo", "cc-manager", "theme-gallery"];

// The live Indie Machine site's own feed - the same route the site serves at
// `indie-machine.com/rss.xml` (see `indie-machine/app/rss.xml/route.ts`). No local dev server
// needed; this is a plain HTTPS GET like any other, unauthenticated, read-only.
const RSS_URL = "https://indie-machine.com/rss.xml";
const FEED_ITEMS = 2;

// Tiles are laid out COLS-per-row in plain `horizontal`/`vertical` widget rows (immediate mode,
// no fixed-width grid primitive exists here) - good enough for the handful of rows this catalog
// ever needs.
const COLS = 4;
const TILE_ICON_SIZE = 30;

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

// Eased fade-in for whichever grid (Installed or Discover) is on screen right now: reset to 0
// whenever the view is switched and counted back up to FADE_FRAMES in `onUpdatePlus`, so the new
// screen's tiles fade and grow in over a few frames instead of popping in fully formed. There is
// no engine-side tweening (`RichText.alpha`/`.font_size` are plain per-frame overrides - see
// entropy_gui/mod.rs), so this addon owns the timer and recomputes the eased value every frame.
const VIEW_FADE_FRAMES = 10;
let viewFadeFrame = VIEW_FADE_FRAMES;

function switchView(discover: boolean) {
    if (discover === showDiscover) return;
    showDiscover = discover;
    viewFadeFrame = 0;
}

/** Quadratic ease-out, 0 at the first frame after a view switch to 1 once settled. */
function viewFade(): number {
    const t = Math.min(1, viewFadeFrame / VIEW_FADE_FRAMES);
    return 1 - (1 - t) * (1 - t);
}

function catalogFor(name: string): CatalogEntry {
    return CATALOG.find((entry) => entry.name === name) ?? { name, title: name, icon: FALLBACK_ICON };
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
    launchStatus = withIcon("check-circle", `Installed ${catalogFor(name).title}`);
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

// --- Backdrop: one flowing procedural surface instead of six flat glow quads -----------------
//
// The previous backdrop stamped soft-edged aurora blobs onto a mesh's own vertex colors (a
// radial smoothstep falloff baked per vertex); blurred behind the glass panels it still read as
// a handful of separate rectangular quads rather than one continuous field. This version is a
// single large quad with a real fragment shader: three slow sine fields at different scales
// stand in for a cheap flow-noise (no texture lookup needed for something this blurred), mapped
// through a fixed palette and a soft vignette so the mesh's own rectangular edge fades to black
// rather than showing a seam. `resourceType: "Time"` binds a uniform the engine itself refreshes
// every frame (see `ResourceType::Time` in src/deno/addon_engine.rs) - no manual Buffer.write
// needed to animate it.
const BACKDROP_SHADER = `
struct Camera {
    view_proj: mat4x4<f32>,
    view_pos: vec4<f32>,
};
@group(0) @binding(0)
var<uniform> camera: Camera;

struct Time { time: f32 };
@group(2) @binding(0)
var<uniform> u_time: Time;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) tex_coords: vec2<f32>,
    @location(3) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // in.position is already world-space (this quad's corners are baked directly, same
    // convention as canvas_surface_addon's meshes), so no model matrix is needed.
    out.clip_position = camera.view_proj * vec4<f32>(in.position, 1.0);
    out.uv = in.tex_coords;
    return out;
}

fn palette(t: f32) -> vec3<f32> {
    // Deep indigo -> violet -> teal -> rose, matching applyTheme's accent colors below.
    let c0 = vec3<f32>(0.035, 0.03, 0.09);
    let c1 = vec3<f32>(0.40, 0.16, 0.60);
    let c2 = vec3<f32>(0.10, 0.55, 0.58);
    let c3 = vec3<f32>(0.80, 0.34, 0.42);
    let a = smoothstep(0.0, 0.4, t);
    let b = smoothstep(0.35, 0.7, t);
    let c = smoothstep(0.65, 1.0, t);
    var col = mix(c0, c1, a);
    col = mix(col, c2, b);
    col = mix(col, c3, c);
    return col;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let p = (in.uv - vec2<f32>(0.5, 0.5)) * vec2<f32>(2.0, 1.5);
    let t = u_time.time;

    var flow = sin(p.x * 1.6 + t * 0.18) * 0.5;
    flow += sin(p.y * 2.1 - t * 0.13 + p.x * 0.6) * 0.35;
    flow += sin(length(p) * 2.6 - t * 0.22) * 0.4;
    flow = flow * 0.5 + 0.5;

    var col = palette(clamp(flow, 0.0, 1.0));

    // Soft vignette: fades to near-black well inside the quad's true edge, so the rectangular
    // mesh boundary itself is never visible against the void behind it.
    let vign = smoothstep(1.25, 0.15, length(p));
    col *= vign;

    return vec4<f32>(col, 1.0);
}
`;

function buildBackdrop() {
    const pipelineId = Entropy.Pipeline.create({
        name: "LauncherBackdrop",
        layout: "mesh",
        pbr: false,
        vertexShader: BACKDROP_SHADER,
        fragmentShader: BACKDROP_SHADER,
        extraBindGroups: [
            { entries: [{ binding: 0, visibility: ["Fragment"], resourceType: "Uniform" }] },
        ],
    } as any);

    // One big quad, comfortably larger than the camera's drift range so it fills the view at
    // every angle `driftCamera` reaches. Vertex order/winding matches the old glowQuad grid
    // (bottom-left, bottom-right, top-left, top-right; two triangles sharing the BR-TL edge).
    const hw = 26, hh = 16, z = -11;
    const vertexData = [
        -hw, -hh, z, 0, 0, 1, 0, 0, 1, 1, 1, 1,
        hw, -hh, z, 0, 0, 1, 1, 0, 1, 1, 1, 1,
        -hw, hh, z, 0, 0, 1, 0, 1, 1, 1, 1, 1,
        hw, hh, z, 0, 0, 1, 1, 1, 1, 1, 1, 1,
    ];
    const indexData = [0, 1, 2, 1, 3, 2];

    Entropy.Model.createMesh({
        id: "launcher_backdrop",
        position: [0, 0, 0],
        vertexData,
        indexData,
        pipelineId,
        bindings: [{ group: 2, binding: 0, resource: { type: "Time" } }],
    } as any);

    Entropy.Lighting.updateSun({
        horizonColor: [0.12, 0.08, 0.22],
        zenithColor: [0.02, 0.02, 0.06],
        sunDirection: [0.1, 0.25, 1.0],
        sunColor: [1.0, 0.92, 0.85],
        sunIntensity: 3.0,
    });
}

// "#RRGGBB" -> [r, g, b, a] in 0..1, the format Entropy.UI.setTheme expects (same helper as
// theme_gallery_addon.ts).
function hex(h: string, a = 1): [number, number, number, number] {
    const v = parseInt(h.replace("#", ""), 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, a];
}

// A dark, violet-accented theme that matches the aurora backdrop showing through the glass
// panel, with rounder corners than the default Slate so the whole window reads as one glassy
// object rather than a themed dialog sitting on top of a scene.
function applyTheme() {
    Entropy.UI.setTheme({
        background: hex("#0B0A14", 0.92),
        surface: hex("#17142A", 0.72),
        surfaceHover: hex("#241F3F", 0.85),
        border: hex("#4A3F7A", 0.55),
        text: hex("#F1EEFB"),
        accent: hex("#B98CF2"),
        cornerRadius: 14,
        windowCornerRadius: 22,
        itemSpacing: 12,
        buttonPadding: [10, 6],
    });
}

// A slow drift rather than a still image: it is what makes the frosted panel read as glass
// instead of a static texture, and it is also what the live BDD tier measures (the pixels behind
// the panel have to change when the scene does).
const DRIFT_RADIUS = 2.2;
const DRIFT_SPEED = 0.012;

function driftCamera() {
    Entropy.Camera.setTransform(
        [Math.sin(backdropAngle) * DRIFT_RADIUS, Math.cos(backdropAngle * 0.7) * DRIFT_RADIUS * 0.5, 14],
        [Math.sin(backdropAngle) * 0.6, 0, 0],
    );
}

// A fresh window title (not "App Launcher"/"Entropy Apps" from earlier revisions) means a fresh
// `entropy_gui` memory slot: the window is never dragged (see `decorations: false` below), so it
// always opens centered instead of possibly reusing an old, dragged-off-center cached rect.
let winId: string;
const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 580;

function setupUI() {
    winId = Entropy.UI.createWindow({
        title: "Entropy",
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
        resizable: false,
        // No title bar, no border stroke, no resize handle - see entropy_gui::Window::decorations.
        // Leaving x/y unset centers the panel on screen, same as every other window here; without
        // a title bar to drag, it stays centered for the life of the run.
        decorations: false,
        glass: true,
        onRender: () => renderApps(winId),
    });
}

// An icon beside a title, each its own `Widget.label` so the title's text stays exactly what it
// was (the live BDD tier's "I see the label" step matches a label's full text, not a substring -
// see the doc comment on `icon`/`withIcon` above). An optional trailing borderless button (the
// Home/Discover toggle) rides in the same row instead of getting a whole line of its own.
function titleRow(win: string, name: IconName, title: string, trailing?: { id: string; text: string; onClick: () => void }) {
    Entropy.UI.Widget.horizontal(win, (row) => {
        Entropy.UI.Widget.label(row, { text: icon(name) });
        Entropy.UI.Widget.label(row, { text: title, bold: true });
        if (trailing) {
            Entropy.UI.Widget.button(row, { id: trailing.id, text: trailing.text, frame: false, onClick: trailing.onClick });
        }
    });
}

/** One phone-launcher-style tile: a big borderless icon button with the app's name below it - no
 * bordered card, no blurb. `fade` eases 0..1 (see `viewFade`) so a freshly switched-to screen's
 * tiles grow and fade in instead of appearing fully formed. */
function renderTile(win: string, entry: CatalogEntry, buttonId: string, onTap: () => void, removeId?: string) {
    const fade = viewFade();
    Entropy.UI.Widget.vertical(win, (col) => {
        Entropy.UI.Widget.button(col, {
            id: buttonId,
            text: icon(entry.icon),
            fontSize: TILE_ICON_SIZE * (0.85 + 0.15 * fade),
            alpha: fade,
            frame: false,
            onClick: onTap,
        });
        Entropy.UI.Widget.label(col, { text: entry.title, alpha: fade });
        if (removeId) {
            Entropy.UI.Widget.button(col, {
                id: removeId,
                text: icon("x-circle"),
                fontSize: 12,
                alpha: fade * 0.7,
                frame: false,
                onClick: () => uninstall(entry.name),
            });
        }
    });
}

function renderGrid(win: string, names: string[], tile: (name: string) => { id: string; onTap: () => void; removeId?: string }) {
    for (let i = 0; i < names.length; i += COLS) {
        Entropy.UI.Widget.horizontal(win, (row) => {
            for (const name of names.slice(i, i + COLS)) {
                const entry = catalogFor(name);
                const t = tile(name);
                renderTile(row, entry, t.id, t.onTap, t.removeId);
            }
        });
    }
}

function renderApps(win: string) {
    pollFeed();

    titleRow(win, showDiscover ? "compass" : "squares-four", showDiscover ? "Discover" : "Installed", {
        id: showDiscover ? "show_home" : "show_discover",
        text: showDiscover ? withIcon("house", "Home") : withIcon("compass", "Discover"),
        onClick: () => switchView(!showDiscover),
    });
    Entropy.UI.Widget.separator(win);

    if (showDiscover) {
        const missing = launchable().filter((name) => !installed.includes(name));
        if (missing.length === 0) {
            Entropy.UI.Widget.label(win, { text: "Everything in this build is installed." });
        } else {
            renderGrid(win, missing, (name) => ({ id: `install-${name}`, onTap: () => install(name) }));
        }
    } else {
        if (installed.length === 0) {
            Entropy.UI.Widget.label(win, { text: "No apps installed yet - open Discover above." });
        } else {
            renderGrid(win, installed, (name) => ({ id: `launch-${name}`, onTap: () => launch(name), removeId: `uninstall-${name}` }));
        }
    }

    Entropy.UI.Widget.separator(win);
    renderNews(win);
    if (launchStatus) Entropy.UI.Widget.label(win, { text: launchStatus, alpha: 0.85 });
}

function renderNews(win: string) {
    titleRow(win, "rss", "Latest posts");
    if (feedError) {
        Entropy.UI.Widget.label(win, { text: withIcon("warning-circle", "Couldn't reach indie-machine.com") });
        Entropy.UI.Widget.button(win, { id: "retry_feed", text: withIcon("arrow-clockwise", "Retry"), frame: false, onClick: () => startFeedFetch() });
        return;
    }
    if (feed.length === 0) {
        Entropy.UI.Widget.label(win, { text: pendingFeed ? "Loading..." : "No posts yet.", alpha: 0.7 });
        return;
    }
    feed.forEach((post) => {
        Entropy.UI.Widget.horizontal(win, (row) => {
            Entropy.UI.Widget.hyperlink(row, { id: `feed-${post.link}`, text: withIcon("arrow-square-out", post.title), url: post.link });
            Entropy.UI.Widget.label(row, { text: withIcon("clock", formatDate(post.date)), alpha: 0.6 });
        });
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
    if (viewFadeFrame < VIEW_FADE_FRAMES) viewFadeFrame++;
});
