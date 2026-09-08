---
title: "Replacing egui With Our Own Immediate-Mode GUI Kit"
date: 2026-09-08
series: Entropy
crate_versions:
  removed:
    - egui = "0.33.2"
    - egui-wgpu = "0.33.2"
    - egui-winit = "0.33.2"
    - egui_dock = "0.18"
    - egui-snarl = "0.9.0"
    - egui_code_editor = "0.2.20"
  added:
    - etagere = "0.2"
    - arboard = "3"
  unchanged:
    - wgpu = "27.0.1"
    - winit = "0.30.12"
  edition: "2024"
  os: "Windows 11 (only platform currently tested)"
  backend: "wgpu default instance backend selection (not explicitly pinned to Vulkan/DX12)"
repo_link: entropy-engine @ 885bb6a 
---

Entropy Engine's entire editor chrome - app shell, docking, panels, every widget, a hand-rolled video timeline, the JS-addon UI system - ran on `egui` + `egui-wgpu` + `egui-winit` + `egui_dock`, plus `egui-snarl` for a node-graph editor and `egui_code_editor` for script editing. All six of those crates are gone now, replaced by `entropy_gui`, an in-house immediate-mode kit living at `src/entropy_gui/`. This post covers what that migration actually involved, what it cost, and what still doesn't work.

## Why rip out a working UI library

The short version: egui worked, but the team wanted a foundation they controlled - a specific dark theme ("Slate": warm-black surfaces, one teal accent, 6px corner radii throughout) and tighter integration with the engine's existing rendering primitives, rather than fighting egui's `Style`/`Visuals` system from outside. Two research passes catalogued every egui/`egui_dock`/`egui-snarl`/`egui_code_editor` API actually used across the 13 call-site files before a line of the new kit got written, and surveyed what the engine already had lying around that a GUI kit needs anyway: `fontdue` for glyph rasterization (already used per-widget in `src/renderer_text/text_due.rs`), `lyon_tessellation` for rounded-rect geometry (already feeding the engine's native `Vertex` format), and an existing 2D screen-space wgpu pipeline with the right bind-group layout.

## The alias trick that made this a "safe" migration

The riskiest part of swapping out a UI library used across 13 files and ~239 call sites isn't the widget code - it's the import surface. `entropy_gui` was built as the real library, then `src/lib.rs` aliases the old crate names onto it:

```rust
pub mod entropy_gui;
pub use entropy_gui as egui;
pub use entropy_gui::backend::wgpu_renderer as egui_wgpu;
pub use entropy_gui::backend::winit_input as egui_winit;
pub use entropy_gui::dock as egui_dock;
```

This only works because the real `egui` crate is gone from `Cargo.toml` - no naming collision. I checked `src/core/pipeline.rs` against this claim directly rather than trusting the migration notes: it still imports `crate::egui`, `crate::egui_wgpu`, `crate::egui_dock`, still calls `egui_ctx.run(raw_input, |ctx| {...})` and gets back something it treats as `FullOutput`, still calls `egui_wgpu::ScreenDescriptor`. None of that changed. The call sites that *did* change are exactly the two deferred widgets (below) plus `src/core/egui_theme.rs`, which needed its content - not its structure - rewritten with the Slate color tokens.

## What's actually different under the alias

The alias makes the migration look invisible from the call sites, but the implementation underneath is not a clone of egui - it diverges in a few deliberate places. All of the following is copied verbatim from `src/entropy_gui/` at `885bb6a`, not reconstructed from memory.

**Single-pass, not two-phase.** egui's own docs describe the real integration loop: `ctx.run(raw_input, |ctx| {...})` produces a `FullOutput`, and tessellation into triangles happens as a *separate* step - `ctx.tessellate(full_output.shapes, pixels_per_point)`. That two-phase split exists so egui can do things like defer layout by a frame (the `Grid` widget uses `Context::request_discard` to hide first-frame misplacement). `entropy_gui` doesn't need any of that - one frame per redraw, no cross-frame shape retention. `context.rs` keeps the two calls signature-compatible but collapses them to bookends around an already-populated draw list:

```rust
// src/entropy_gui/context.rs
pub fn run(&self, raw_input: RawInput, add_contents: impl FnOnce(&Context)) -> FullOutput {
    self.begin_frame(raw_input);
    add_contents(self);
    self.end_frame()
}

/// Signature-compatible adapter for the old `ctx.tessellate(shapes, ppp)` call site -
/// geometry is already tessellated into the draw list by the time this is called, so
/// this just drains it.
pub fn tessellate(&self, _shapes: (), _pixels_per_point: f32) -> Vec<crate::entropy_gui::draw_list::DrawCommand> {
    std::mem::take(&mut self.0.borrow_mut().draw_list).commands
}
```

Note `FullOutput.shapes` is typed `()` - a placeholder that exists purely so `ctx.tessellate(full_output.shapes, ...)` still compiles at the old call site. There's nothing to hand back; by the time `run()` returns, every widget called during `add_contents` has already pushed triangles straight into `ContextInner::draw_list` via `Painter::push` (below). `tessellate()` doesn't tessellate anything - it just takes the list.

**`Id` is a hashed `u64`, not `Uuid`.** Deliberate divergence from the engine's dominant `Uuid` convention elsewhere. Widget ids need to be a deterministic function of a label/parent-path so the same logical widget resolves to the same id across frames - that's what `Memory` lookups (scroll offset, open/closed state, drag state, text-edit cursor) key off of:

```rust
// src/entropy_gui/id.rs
impl Id {
    pub fn new(source: impl Hash) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        0xE7_u64.hash(&mut hasher); // fixed seed so Id::new("") != a bare zero hash
        source.hash(&mut hasher);
        Id(hasher.finish())
    }

    pub fn with(&self, child: impl Hash) -> Self {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.0.hash(&mut hasher);
        child.hash(&mut hasher);
        Id(hasher.finish())
    }
}
```

`Id::new("side_panel").with("save_button")` produces the same `u64` every frame that path is walked. A `Uuid::new_v4()` generated fresh per call would not - every frame's button would look like a brand-new widget to `Memory`, and scroll offsets/open-state/drag-state would reset constantly.

**`Memory` is a closed enum, not `Any`-boxed.** The full stateful-widget set was known from the API catalog before any of this got written, so there's no speculative generic store:

```rust
// src/entropy_gui/memory.rs
#[derive(Clone, Debug)]
pub enum WidgetState {
    ScrollOffset(Vec2),
    Open(bool),
    TextEdit(TextEditState),
    WindowRect(Rect),
    PanelWidth(f32),
}

pub struct Memory {
    data: IdMap<WidgetState>,
    pub focused: Option<Id>,
    // ...
}

impl Memory {
    pub fn get_open(&self, id: Id, default: bool) -> bool {
        match self.data.get(&id) {
            Some(WidgetState::Open(b)) => *b,
            _ => default,
        }
    }
    pub fn set_open(&mut self, id: Id, open: bool) {
        self.data.insert(id, WidgetState::Open(open));
    }
}
```

Every stateful widget in the kit follows that same `get_x(id, default)` / `set_x(id, value)` shape against one `IdMap<WidgetState>` - a `CollapsingHeader` calling `get_open`/`set_open` is doing the exact same lookup a `ScrollArea` does for `get_scroll`/`set_scroll`, just against a different enum variant.

**Docking is a hand-rolled arena tree that copies egui_dock's actual shape.** I pulled egui_dock 0.18's own docs rather than going from memory: it represents docking as a binary tree where internal nodes are `Split` (storing a fraction) and terminal nodes are `Leaf` (holding tabs), addressed via `NodeIndex`. `entropy_gui`'s `dock/tree.rs` reimplements exactly that shape:

```rust
// src/entropy_gui/dock/tree.rs
pub enum Node<Tab> {
    Leaf { tabs: Vec<Tab>, active: usize },
    Split { fraction: f32, orientation: Orientation, children: [NodeIndex; 2] },
}

/// `fraction` is always the *first* child's share (spatially first: left for horizontal
/// splits, top for vertical), regardless of which side receives the new tabs - this is a
/// real egui_dock semantic the app already depends on (see the comment in
/// `src/core/render_egui.rs` next to its `split_right` call), so it must be preserved
/// exactly: get it backwards and the app's already-tuned split fractions silently break.
fn split(&mut self, target: NodeIndex, orientation: Orientation, fraction: f32, new_tabs: Vec<Tab>, new_first: bool) -> [NodeIndex; 2] {
    let old_node = std::mem::replace(&mut self.nodes[target.0], Node::Leaf { tabs: Vec::new(), active: 0 });
    let old_idx = NodeIndex(self.nodes.len());
    self.nodes.push(old_node);
    let new_idx = NodeIndex(self.nodes.len());
    self.nodes.push(Node::Leaf { tabs: new_tabs, active: 0 });

    let children = if new_first { [new_idx, old_idx] } else { [old_idx, new_idx] };
    self.nodes[target.0] = Node::Split { fraction, orientation, children };
    children
}
```

`split_left`/`split_right`/`split_above`/`split_below` are one-line wrappers around `split()` that differ only in `orientation` and `new_first` - `split_left` passes `new_first: true` (the new leaf becomes the spatially-first child, so `fraction` correctly reads as "the new leaf's share"), `split_right` passes `false` (the *old* leaf stays first, so the same `fraction` now means "the old content's share" - same field, opposite meaning, which is exactly the semantic the source comment is warning future editors about).

**Clipping is scissor-rect based**, matching the engine's existing convention elsewhere (`render_addon_frame.rs`'s `set_scissor_rect` calls) rather than shader-based per-vertex clipping. In practice this means clip rects are just data riding along on `Painter`, intersected as you nest into child regions, and read back out by the renderer per draw call:

```rust
// src/entropy_gui/painter.rs
pub fn with_clip_rect(&self, clip_rect: Rect) -> Painter {
    Painter { ctx: self.ctx.clone(), clip_rect: self.clip_rect.intersect(clip_rect), target: self.target }
}

fn push(&self, texture: DrawTexture, vertices: Vec<Vertex>, indices: Vec<u32>) {
    if vertices.is_empty() || indices.is_empty() {
        return;
    }
    let mut inner = self.ctx.inner_mut();
    let list = match self.target {
        DrawTarget::Main => &mut inner.draw_list,
        DrawTarget::Overlay => &mut inner.overlay_draw_list,
    };
    list.push(self.clip_rect, texture, vertices, indices);
}
```

No shader branch ever asks "is this pixel inside the rect" - `self.clip_rect` just rides along with every vertex batch into `DrawList`, and the wgpu backend turns it into an actual `set_scissor_rect` call at draw time. One clipping model in the codebase, not two.

**Glyph atlas is shared and evicting.** The old per-widget atlas in `text_due.rs` was a non-evicting shelf packer - fine for a handful of large text blocks, not fine for a GUI with dozens of small widgets sharing space. `entropy_gui` adds `etagere = "0.2"` and ports the fontdue rasterization logic from `text_due.rs` almost verbatim, re-keyed to one shared cache.

**The Slate theme is just data, not a rendering path.** Every color a widget draws with comes from one function that builds a `Style`:

```rust
// src/entropy_gui/style.rs
pub fn slate_style() -> Style {
    let bg = Color32::from_rgb(0x14, 0x14, 0x14);
    let surface = Color32::from_rgb(0x1B, 0x1B, 0x1B);
    let surface_2 = Color32::from_rgb(0x22, 0x22, 0x22);
    let border = Color32::from_rgb(0x2C, 0x2C, 0x2C);
    let text = Color32::from_rgb(0xEC, 0xEC, 0xEC);
    let accent = Color32::from_rgb(0x3F, 0xD1, 0xC4);

    let mut style = Style::default();
    style.visuals = Visuals {
        dark_mode: true,
        override_text_color: Some(text),
        widgets: Widgets {
            inactive: WidgetVisuals {
                bg_fill: surface,
                weak_bg_fill: surface,
                bg_stroke: Stroke::new(1.0, border),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, text),
                expansion: 0.0,
            },
            hovered: WidgetVisuals {
                bg_fill: surface_2,
                weak_bg_fill: surface_2,
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            active: WidgetVisuals {
                bg_fill: accent.linear_multiply(0.9),
                weak_bg_fill: accent.linear_multiply(0.16),
                bg_stroke: Stroke::new(1.0, accent),
                corner_radius: CornerRadius::same(6),
                fg_stroke: Stroke::new(1.0, Color32::WHITE),
                expansion: 0.5,
            },
            /* noninteractive, open: same shape, omitted here for length */
        },
        window_corner_radius: CornerRadius::same(6),
        panel_fill: bg,
        hyperlink_color: accent,
        /* remaining Visuals fields omitted for length */
    };
    /* style.spacing assignment omitted for length */
    style
}
```

Five `WidgetVisuals` states (`noninteractive`/`inactive`/`hovered`/`active`/`open`), each a plain struct of fill/stroke/corner-radius/expansion. Nothing in `painter.rs` or the widgets knows the word "Slate" - a widget just asks its `Ui` for the current `WidgetVisuals` for its interaction state and draws with those fields. Retheming the whole app is writing a different function with this same shape, not touching render code.

## Evidence

I built `--bin editor --release` against this repo's pinned toolchain (wgpu 27.0.1, winit 0.30.12, `edition = "2024"`) and ran it. The release build finished clean (one unrelated unused-import warning in `src/bin/editor.rs`), producing a 71.25 MiB `editor.exe`.

Running it and opening a project gets you this - docked `Viewport`/`Game Composer` tabs, a scrollable Inspector panel with collapsing headers, drag-value fields for position/scale, a checkbox - all `entropy_gui` widgets, Slate theme, screenshotted from the actual running window this session, not a mockup:

![entropy_gui rendering docked panels, tabs, drag-values, and a collapsing inspector in the Slate theme](images/entropy-gui-slate-docking.png)

First-party numbers, all pulled from this repo directly:

- **Size of the replacement**: `entropy_gui` is 4,734 lines across 39 files (`find src/entropy_gui -name "*.rs" | xargs wc -l`).
- **Dependency delta**: comparing `Cargo.lock` at the commit right before `entropy_gui` work started (`37f642b`) against `HEAD`, the resolved package count went from 1,110 to 1,099. 13 packages dropped out entirely - the 7 egui-family crates (`egui`, `egui-scale`, `egui-snarl`, `egui-wgpu`, `egui-winit`, `egui_code_editor`, `egui_dock`) plus 6 packages that existed only to support them transitively (`smithay-clipboard`, `wayland-protocols-experimental`, `wayland-protocols-misc`, `webbrowser`, `proc-macro2-diagnostics`, `duplicate`). 5 packages came in to support the replacement (`etagere`, `arboard`'s `chunked_transfer`/`ascii` transitive deps, `svg_fmt`, `tiny_http` - the last unrelated, added the same period for the addon MCP server). Still a ton of work ahead to reduce our dependency count.
- **Binary**: 71.25 MiB release `editor.exe`, this session, this machine.

## Decision log

- **Scope was locked to "replace the whole core shell, defer the two hardest widgets."** `egui`, `egui-wgpu`, `egui-winit`, `egui_dock` got a full from-scratch replacement. `egui-snarl` (node-graph editor) and `egui_code_editor` did not - they got placeholder widgets instead. The real tradeoff: once panels and docking run on `entropy_gui::Ui` instead of `egui::Ui`, the actual `egui-snarl`/`egui_code_editor` widgets - which need a real `&mut egui::Ui` - can't be invoked in place anymore without building a whole separate offscreen-egui bridge just to keep two of the twenty-some widgets. That's more engineering than the payoff justified for this pass, so both got simplified stand-ins instead, documented as an accepted regression rather than something quietly dropped.
- **`Id` as a hashed `u64` over `Uuid`** cost API-consistency with the rest of the codebase (which is `Uuid`-heavy) in exchange for the actual property the widget system needs: determinism across frames from a label/path, which a random id can't give you.
- **A closed `WidgetState` enum over `Any`-boxed storage** trades extensibility (a future exotic stateful widget needs a new enum variant, not just a new type) for not needing a generic store at all when the full set was already known.

## Failure notes

- **Text-edit is a documented v1 stand-in**, straight from the source comment in `widgets/text_edit.rs`: typing, backspace/delete, arrow nav, home/end, and Enter (multiline) all work. Click-to-place cursor does not - a click always jumps the caret to the end of the text. No drag-to-select. No IME composition despite key events being captured. No clipboard cut/copy/paste despite `arboard` already being a dependency for exactly that.
- **Code editor and node graph are exactly what the plan called them: placeholders.** `widgets_code_editor.rs` is 41 lines - a plain multiline text edit with a line-number gutter, no syntax highlighting. `widgets_node_graph.rs` is 50 lines - a read-only scrollable list of nodes and their connections, with an explicit doc comment: "Nothing here lets a user draw new connections - an accepted, documented regression until a real graph editor is built as a follow-up."