//! `NodeGraphEditor` — a real, generic, pannable/zoomable node graph editor: drag nodes
//! around, drag new links out of pins, click a link to delete it, embed real widgets (a
//! `DragValue`, a `ComboBox`, a checkbox...) inside a node's body. Built to be domain-agnostic
//! so the caller's own node/pin/link types just get adapted into `GraphNode`/`GraphLink` each
//! frame - this is what lets both `src/deno/addon_engine.rs` (Studio's behavior-graph editor)
//! and a from-scratch nocode app built on `EntropyApp` share one editor.
//!
//! Replaces the old read-only `node_graph_view` fallback (see git history) that existed only
//! because `egui-snarl`'s `SnarlViewer` needed a real `&mut egui::Ui` this app's panels/docking
//! no longer had to hand it once they moved onto `entropy_gui::Ui`. That fallback could show a
//! graph but never let a user draw a connection - this is the real follow-up.
//!
//! ## Two levels of "who owns node position"
//!
//! `nodes: &[GraphNode]` is read-only - the widget never mutates the caller's data directly,
//! since the addon-relay call site rebuilds its node list from JS state every single frame and
//! has no persistent `&mut` to hand in. Instead, `show()` returns a `Vec<NodeGraphEvent>`
//! (`NodeMoved`, `LinkCreated`, `LinkRemoved`, ...) the caller applies to its own data after
//! the call. That alone would mean one frame of lag on every drag update relative to what's on
//! screen (a `NodeMoved` this frame only reaches the caller's `nodes` on the *next* frame's
//! `show()` call), which reads as jittery for something as continuous as dragging. So while a
//! drag is in progress, `Memory::node_drag` holds the live graph-space override position keyed
//! by the dragging node's own interact id, and rendering prefers that over `node.pos` - the
//! widget is self-contained-correct for drag *smoothness* even if a caller never applies the
//! events at all (as `example_light_hive.rs`'s existing `Snarl` relay currently doesn't - the
//! studio-bundle JS side has no consumer for these events yet, see the post's "what's next").
//!
//! ## Known v1 simplifications (documented, not accidental)
//!
//! - Overlapping-node hit testing follows array order, not visual (paint) order - the topmost
//!   *drawn* node isn't guaranteed to win a click if two nodes' rects overlap. Real graphs
//!   don't usually get dragged into overlap on purpose; not worth a second interaction pass.
//! - Panning is left-drag on empty canvas (no middle-mouse support - `PointerState` in this
//!   kit only tracks primary/secondary buttons at all, see `context.rs`).
//! - Node body content isn't font/widget-scaled with zoom, only repositioned/resized - a
//!   `DragValue` at 0.5x zoom is a smaller *hit rect* with full-size text. Same simplification
//!   this kit already makes elsewhere (nothing here does sub-pixel font scaling).

use crate::entropy_gui::color::{Color32, Stroke};
use crate::entropy_gui::context::Key;
use crate::entropy_gui::geometry::{pos2, vec2, Align, Align2, FontId, Layout, Pos2, Rect, StrokeKind, Vec2};
use crate::entropy_gui::id::Id;
use crate::entropy_gui::memory::LinkDrag;
use crate::entropy_gui::painter::Painter;
use crate::entropy_gui::response::{Response, Sense};
use crate::entropy_gui::ui::{interact, Ui};

const TITLE_H: f32 = 26.0;
const PIN_ROW_H: f32 = 20.0;
const PIN_TOP_PAD: f32 = 8.0;
const BODY_PAD: f32 = 8.0;
const DEFAULT_NODE_WIDTH: f32 = 170.0;
const PIN_RADIUS: f32 = 5.0;
const PIN_HIT_PAD: f32 = 6.0;
const MIN_ZOOM: f32 = 0.25;
const MAX_ZOOM: f32 = 2.5;
const GRID_SPACING: f32 = 32.0;
const LINK_HIT_DIST: f32 = 7.0;

#[derive(Clone, Debug)]
pub struct GraphPin {
    /// Unique among this node's own inputs (or outputs) - not globally unique.
    pub id: String,
    pub label: String,
}

impl GraphPin {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self { id: id.into(), label: label.into() }
    }
}

#[derive(Clone, Debug)]
pub struct GraphNode {
    /// Unique within the graph.
    pub id: String,
    pub title: String,
    /// Top-left corner, in graph space (not screen pixels - see the module's pan/zoom docs).
    pub pos: Pos2,
    /// Graph-space width; `<= 0.0` uses `DEFAULT_NODE_WIDTH`.
    pub width: f32,
    pub inputs: Vec<GraphPin>,
    pub outputs: Vec<GraphPin>,
    /// Extra graph-space height reserved below the pin rows for `node_body`'s content.
    /// `0.0` means the node has no custom body (title + pins only).
    pub body_height: f32,
}

impl GraphNode {
    pub fn new(id: impl Into<String>, title: impl Into<String>, pos: Pos2) -> Self {
        Self { id: id.into(), title: title.into(), pos, width: 0.0, inputs: Vec::new(), outputs: Vec::new(), body_height: 0.0 }
    }
    pub fn width(&self) -> f32 {
        if self.width > 0.0 { self.width } else { DEFAULT_NODE_WIDTH }
    }
    fn height(&self) -> f32 {
        let pin_rows = self.inputs.len().max(self.outputs.len()) as f32;
        let pins_h = if pin_rows > 0.0 { PIN_TOP_PAD + pin_rows * PIN_ROW_H } else { 0.0 };
        let body_h = if self.body_height > 0.0 { BODY_PAD + self.body_height } else { 0.0 };
        TITLE_H + pins_h + body_h + BODY_PAD
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphLink {
    pub from_node: String,
    pub from_pin: String,
    pub to_node: String,
    pub to_pin: String,
}

#[derive(Clone, Debug)]
pub enum NodeGraphEvent {
    /// Fired every frame a node's title bar is being dragged - apply it to your own `nodes`
    /// storage so the position the widget shows converges with what you hand back in next.
    NodeMoved { node: String, pos: Pos2 },
    /// A node's title bar was clicked (pressed) without starting a drag - use it to update
    /// your own selection state; the widget doesn't track selection itself (see `selected`).
    NodeClicked(String),
    /// Empty canvas was clicked - the conventional "deselect" signal.
    BackgroundClicked,
    /// A link was dragged from one pin and dropped on a valid, opposite-kind pin elsewhere.
    LinkCreated(GraphLink),
    /// The link at this index into the `links` slice was clicked - conventionally: delete it.
    LinkRemoved(usize),
    /// Delete/Backspace was pressed with the pointer over the canvas and `selected` set.
    DeleteRequested(String),
}

pub struct NodeGraphResponse {
    pub canvas_rect: Rect,
    /// Click/secondary-click on empty canvas - call `.context_menu(...)` on this yourself to
    /// show an "Add Node" menu (see `Response::context_menu`); its `rect` is the whole canvas.
    pub background: Response,
    pub events: Vec<NodeGraphEvent>,
    pub pan: Vec2,
    pub zoom: f32,
}

impl NodeGraphResponse {
    pub fn screen_to_graph(&self, p: Pos2) -> Pos2 {
        pos2((p.x - self.canvas_rect.min.x - self.pan.x) / self.zoom, (p.y - self.canvas_rect.min.y - self.pan.y) / self.zoom)
    }
}

pub struct NodeGraphEditor {
    id: Id,
}

impl NodeGraphEditor {
    pub fn new(id_salt: impl std::hash::Hash) -> Self {
        Self { id: Id::new("node_graph_editor").with(id_salt) }
    }

    /// `node_body` is called for every node with `body_height > 0.0`, with a `Ui` rooted at
    /// that node's body rect (already pan/zoom-transformed into screen space) - draw whatever
    /// widgets the node needs (a `DragValue`, a computed-value label, ...) into it directly.
    pub fn show(
        self,
        ui: &mut Ui,
        nodes: &[GraphNode],
        links: &[GraphLink],
        selected: Option<&str>,
        mut node_body: impl FnMut(&mut Ui, &GraphNode),
    ) -> NodeGraphResponse {
        let ctx = ui.ctx().clone();
        let editor_id = self.id;
        let (mut pan, mut zoom) = ctx.memory(|m| m.get_node_graph_view(editor_id));

        let size = ui.available_size().max(vec2(100.0, 100.0));
        let (bg_response, painter) = ui.allocate_painter(size, Sense::click());
        let canvas_rect = bg_response.rect;

        let visuals = ui.visuals();
        painter.rect_filled(canvas_rect, visuals.window_corner_radius, visuals.extreme_bg_color);
        draw_grid(&painter, canvas_rect, pan, zoom);

        let pointer_pos = ui.input(|i| i.pointer.pos);
        let over_canvas = pointer_pos.map_or(false, |p| canvas_rect.contains(p));

        // Zoom: mouse wheel, keeping the graph point under the cursor fixed on screen.
        let scroll = ui.input(|i| i.scroll_delta.y);
        if scroll.abs() > 0.0 && over_canvas {
            if let Some(cursor) = pointer_pos {
                let graph_pt = pos2((cursor.x - canvas_rect.min.x - pan.x) / zoom, (cursor.y - canvas_rect.min.y - pan.y) / zoom);
                let factor = (1.0 + scroll * 0.0015).clamp(0.5, 1.6);
                zoom = (zoom * factor).clamp(MIN_ZOOM, MAX_ZOOM);
                pan.x = cursor.x - canvas_rect.min.x - graph_pt.x * zoom;
                pan.y = cursor.y - canvas_rect.min.y - graph_pt.y * zoom;
            }
        }

        let to_screen = |p: Pos2, pan: Vec2, zoom: f32| pos2(canvas_rect.min.x + pan.x + p.x * zoom, canvas_rect.min.y + pan.y + p.y * zoom);

        let mut events = Vec::new();

        // Snapshot the in-flight link drag (if any) once, up front, so every pin this frame
        // checks a consistent source regardless of iteration order.
        let (link_drag_active, link_drag_snapshot) = ctx.memory(|m| (m.link_drag.is_some(), m.link_drag.clone()));
        let released_this_frame = ui.input(|i| i.pointer.primary_released);
        let mut link_consumed = false;

        // Existing links, drawn first so nodes/pins paint on top of the wires.
        let mut link_to_remove: Option<usize> = None;
        for (idx, link) in links.iter().enumerate() {
            let (Some(from), Some(to)) = (nodes.iter().find(|n| n.id == link.from_node), nodes.iter().find(|n| n.id == link.to_node)) else {
                continue;
            };
            let Some(from_i) = from.outputs.iter().position(|p| p.id == link.from_pin) else { continue };
            let Some(to_i) = to.inputs.iter().position(|p| p.id == link.to_pin) else { continue };
            let p0 = to_screen(pin_pos_graph(from, from_i, true), pan, zoom);
            let p1 = to_screen(pin_pos_graph(to, to_i, false), pan, zoom);
            let pts = bezier_points(p0, p1);

            let hovered_link = pointer_pos.map_or(false, |p| polyline_hit(&pts, p, LINK_HIT_DIST));
            let stroke = if hovered_link {
                Stroke::new(2.5, visuals.selection.stroke.color)
            } else {
                Stroke::new(2.0, visuals.widgets.inactive.fg_stroke.color)
            };
            for pair in pts.windows(2) {
                painter.line_segment([pair[0], pair[1]], stroke);
            }
            if hovered_link && ui.input(|i| i.pointer.primary_pressed) {
                link_to_remove = Some(idx);
            }
        }
        if let Some(idx) = link_to_remove {
            events.push(NodeGraphEvent::LinkRemoved(idx));
        }

        for node in nodes {
            let title_id = editor_id.with(("node_title", &node.id));
            let live_override = ctx.memory(|m| m.node_drag.clone()).filter(|(id, _)| *id == title_id).map(|(_, p)| p);
            let effective_pos = live_override.unwrap_or(node.pos);

            let node_rect_graph = Rect::from_min_size(effective_pos, vec2(node.width(), node.height()));
            let node_rect = Rect::from_min_max(to_screen(node_rect_graph.min, pan, zoom), to_screen(node_rect_graph.max, pan, zoom));
            let title_rect = Rect::from_min_max(node_rect.min, pos2(node_rect.max.x, node_rect.min.y + TITLE_H * zoom));

            let is_selected = selected == Some(node.id.as_str());
            let border = if is_selected { visuals.selection.stroke } else { visuals.widgets.inactive.bg_stroke };
            painter.rect_filled(node_rect, visuals.widgets.inactive.corner_radius, visuals.widgets.inactive.bg_fill);
            painter.rect_filled(title_rect, visuals.widgets.inactive.corner_radius, visuals.widgets.open.bg_fill);
            painter.rect_stroke(node_rect, visuals.widgets.inactive.corner_radius, border, StrokeKind::Middle);
            let text_color = visuals.override_text_color.unwrap_or(Color32::WHITE);
            painter.text(
                pos2(title_rect.min.x + 8.0, title_rect.center().y),
                Align2::LEFT_CENTER,
                &node.title,
                FontId::proportional((13.0 * zoom).max(8.0)),
                text_color,
            );

            let title_resp = interact(&ctx, title_rect, title_id, Sense::click_and_drag());
            if title_resp.drag_started() {
                ctx.memory_mut(|m| m.node_drag = Some((title_id, node.pos)));
            } else if title_resp.dragged() {
                let d = title_resp.drag_delta();
                let new_pos = pos2(effective_pos.x + d.x / zoom, effective_pos.y + d.y / zoom);
                ctx.memory_mut(|m| m.node_drag = Some((title_id, new_pos)));
                events.push(NodeGraphEvent::NodeMoved { node: node.id.clone(), pos: new_pos });
            }
            if title_resp.drag_stopped() {
                ctx.memory_mut(|m| m.node_drag = None);
            }
            // A click is indistinguishable from the start of a drag until release (this
            // kit's `interact()` sets both `clicked` and `drag_started` on the press frame) -
            // select on press, same convention most node editors use.
            if title_resp.drag_started() {
                events.push(NodeGraphEvent::NodeClicked(node.id.clone()));
            }

            let pin_font = FontId::proportional((12.0 * zoom).max(7.0));
            for (i, pin) in node.inputs.iter().enumerate() {
                let center = to_screen(pin_pos_graph(node, i, false), pan, zoom);
                let (created, consumed) = draw_and_interact_pin(
                    &ctx, &painter, editor_id, node, pin, false, center, zoom, &visuals,
                    link_drag_active, &link_drag_snapshot, released_this_frame, link_consumed,
                );
                if let Some(link) = created {
                    events.push(NodeGraphEvent::LinkCreated(link));
                }
                link_consumed |= consumed;
                painter.text(pos2(center.x + PIN_RADIUS * zoom + 4.0, center.y), Align2::LEFT_CENTER, &pin.label, pin_font, text_color);
            }
            for (i, pin) in node.outputs.iter().enumerate() {
                let center = to_screen(pin_pos_graph(node, i, true), pan, zoom);
                let (created, consumed) = draw_and_interact_pin(
                    &ctx, &painter, editor_id, node, pin, true, center, zoom, &visuals,
                    link_drag_active, &link_drag_snapshot, released_this_frame, link_consumed,
                );
                if let Some(link) = created {
                    events.push(NodeGraphEvent::LinkCreated(link));
                }
                link_consumed |= consumed;
                let label_w = Painter::measure_text(&ctx, pin_font, &pin.label).x;
                painter.text(pos2(center.x - PIN_RADIUS * zoom - 4.0 - label_w, center.y), Align2::LEFT_CENTER, &pin.label, pin_font, text_color);
            }

            if node.body_height > 0.0 {
                let pin_rows = node.inputs.len().max(node.outputs.len()) as f32;
                let body_top_graph = effective_pos.y + TITLE_H + PIN_TOP_PAD + pin_rows * PIN_ROW_H;
                let body_rect_graph = Rect::from_min_size(pos2(effective_pos.x, body_top_graph), vec2(node.width(), node.body_height));
                let body_rect = Rect::from_min_max(to_screen(body_rect_graph.min, pan, zoom), to_screen(body_rect_graph.max, pan, zoom)).shrink(4.0);
                let mut body_ui = ui.child_ui_at(body_rect, Layout::top_down(Align::Min), ("node_body", &node.id));
                node_body(&mut body_ui, node);
            }
        }

        if link_drag_active && released_this_frame {
            ctx.memory_mut(|m| m.link_drag = None);
        }
        if let Some(drag) = ctx.memory(|m| m.link_drag.clone()) {
            if let Some(cursor) = pointer_pos {
                let src_node = nodes.iter().find(|n| n.id == drag.from_node);
                if let Some(src_node) = src_node {
                    let idx = if drag.from_output {
                        src_node.outputs.iter().position(|p| p.id == drag.from_pin)
                    } else {
                        src_node.inputs.iter().position(|p| p.id == drag.from_pin)
                    };
                    if let Some(idx) = idx {
                        let p0 = to_screen(pin_pos_graph(src_node, idx, drag.from_output), pan, zoom);
                        let pts = bezier_points(p0, cursor);
                        let stroke = Stroke::new(2.0, visuals.selection.stroke.color);
                        for pair in pts.windows(2) {
                            painter.line_segment([pair[0], pair[1]], stroke);
                        }
                    }
                }
            }
        }

        // Background pan: resolved *after* every node/pin interaction above, so a press over
        // a node lets the node's own (already-processed) interact() claim `active_drag` first.
        let bg_drag_id = editor_id.with("bg_pan");
        let bg_drag_resp = interact(&ctx, canvas_rect, bg_drag_id, Sense::drag());
        if bg_drag_resp.dragged() {
            pan += bg_drag_resp.drag_delta();
        }

        if bg_response.clicked() {
            events.push(NodeGraphEvent::BackgroundClicked);
        }

        if over_canvas {
            let delete_pressed = ui.input(|i| i.key_events.iter().any(|k| k.pressed && matches!(k.key, Key::Delete | Key::Backspace)));
            if delete_pressed {
                if let Some(sel) = selected {
                    events.push(NodeGraphEvent::DeleteRequested(sel.to_string()));
                }
            }
        }

        ctx.memory_mut(|m| m.set_node_graph_view(editor_id, pan, zoom));

        NodeGraphResponse { canvas_rect, background: bg_response, events, pan, zoom }
    }
}

fn pin_pos_graph(node: &GraphNode, index: usize, is_output: bool) -> Pos2 {
    let y = node.pos.y + TITLE_H + PIN_TOP_PAD + PIN_ROW_H * (index as f32) + PIN_ROW_H * 0.5;
    let x = if is_output { node.pos.x + node.width() } else { node.pos.x };
    pos2(x, y)
}

#[allow(clippy::too_many_arguments)]
fn draw_and_interact_pin(
    ctx: &crate::entropy_gui::context::Context,
    painter: &Painter,
    editor_id: Id,
    node: &GraphNode,
    pin: &GraphPin,
    is_output: bool,
    center: Pos2,
    zoom: f32,
    visuals: &crate::entropy_gui::style::Visuals,
    link_drag_active: bool,
    link_drag_snapshot: &Option<LinkDrag>,
    released_this_frame: bool,
    already_consumed: bool,
) -> (Option<GraphLink>, bool) {
    let pin_id = editor_id.with(("pin", &node.id, &pin.id, is_output));
    let radius = PIN_RADIUS * zoom;
    let hit_rect = Rect::from_center_size(center, vec2((radius + PIN_HIT_PAD) * 2.0, (radius + PIN_HIT_PAD) * 2.0));
    let resp = interact(ctx, hit_rect, pin_id, Sense::click_and_drag());

    if resp.drag_started() {
        ctx.memory_mut(|m| m.link_drag = Some(LinkDrag { from_node: node.id.clone(), from_pin: pin.id.clone(), from_output: is_output }));
    }

    let mut created = None;
    let mut consumed = false;
    if !already_consumed && link_drag_active && released_this_frame && resp.hovered() {
        if let Some(src) = link_drag_snapshot {
            let is_self = src.from_node == node.id && src.from_pin == pin.id;
            if src.from_output != is_output && !is_self {
                created = Some(if src.from_output {
                    GraphLink { from_node: src.from_node.clone(), from_pin: src.from_pin.clone(), to_node: node.id.clone(), to_pin: pin.id.clone() }
                } else {
                    GraphLink { from_node: node.id.clone(), from_pin: pin.id.clone(), to_node: src.from_node.clone(), to_pin: src.from_pin.clone() }
                });
                consumed = true;
            }
        }
    }

    let fill = if resp.hovered() || (link_drag_active && link_drag_snapshot.as_ref().map_or(false, |d| d.from_node == node.id && d.from_pin == pin.id)) {
        visuals.selection.stroke.color
    } else {
        visuals.widgets.inactive.fg_stroke.color
    };
    painter.circle_filled(center, radius, fill);
    (created, consumed)
}

fn bezier_points(p0: Pos2, p1: Pos2) -> Vec<Pos2> {
    let dx = (p1.x - p0.x).abs().max(40.0) * 0.5;
    let c0 = pos2(p0.x + dx, p0.y);
    let c1 = pos2(p1.x - dx, p1.y);
    const SEGMENTS: usize = 20;
    (0..=SEGMENTS)
        .map(|i| {
            let t = i as f32 / SEGMENTS as f32;
            let mt = 1.0 - t;
            let x = mt * mt * mt * p0.x + 3.0 * mt * mt * t * c0.x + 3.0 * mt * t * t * c1.x + t * t * t * p1.x;
            let y = mt * mt * mt * p0.y + 3.0 * mt * mt * t * c0.y + 3.0 * mt * t * t * c1.y + t * t * t * p1.y;
            pos2(x, y)
        })
        .collect()
}

fn polyline_hit(pts: &[Pos2], p: Pos2, threshold: f32) -> bool {
    pts.windows(2).any(|pair| point_segment_dist(p, pair[0], pair[1]) <= threshold)
}

fn point_segment_dist(p: Pos2, a: Pos2, b: Pos2) -> f32 {
    let ab = vec2(b.x - a.x, b.y - a.y);
    let len2 = ab.x * ab.x + ab.y * ab.y;
    if len2 <= 1e-6 {
        return (p - a).length();
    }
    let ap = vec2(p.x - a.x, p.y - a.y);
    let t = ((ap.x * ab.x + ap.y * ab.y) / len2).clamp(0.0, 1.0);
    let closest = pos2(a.x + ab.x * t, a.y + ab.y * t);
    (p - closest).length()
}

fn draw_grid(painter: &Painter, rect: Rect, pan: Vec2, zoom: f32) {
    let step = GRID_SPACING * zoom;
    if step < 6.0 {
        return;
    }
    let stroke = Stroke::new(1.0, Color32::from_white_alpha(14));
    let mut x = rect.min.x + pan.x.rem_euclid(step);
    while x < rect.max.x {
        painter.line_segment([pos2(x, rect.min.y), pos2(x, rect.max.y)], stroke);
        x += step;
    }
    let mut y = rect.min.y + pan.y.rem_euclid(step);
    while y < rect.max.y {
        painter.line_segment([pos2(rect.min.x, y), pos2(rect.max.x, y)], stroke);
        y += step;
    }
}
