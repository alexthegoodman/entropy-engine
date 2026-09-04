//! Read-only fallback for a node-graph editor — replaces `egui-snarl`'s pin-dragging bezier
//! editor (see the plan's decision on deferred widgets: once panels/docking run on
//! `entropy_gui::Ui`, egui-snarl's real `SnarlViewer` — which needs a real `&mut egui::Ui` —
//! can no longer be invoked in place without a whole separate offscreen-egui bridge). Shows
//! nodes and their connections as plain text. Deliberately generic/app-agnostic: the caller
//! (`src/deno/addon_engine.rs`) adapts its own `BehaviorGraph` domain type into these.
//!
//! Nothing here lets a user draw new connections — an accepted, documented regression until
//! a real graph editor is built as a follow-up.

use crate::entropy_gui::widgets::ScrollArea;
use crate::entropy_gui::ui::Ui;
use crate::entropy_gui::RichText;

pub struct GraphNodeInfo {
    pub name: String,
    pub node_type: String,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

pub struct GraphConnectionInfo {
    pub from_node: String,
    pub from_pin: String,
    pub to_node: String,
    pub to_pin: String,
}

pub fn node_graph_view(ui: &mut Ui, nodes: &[GraphNodeInfo], connections: &[GraphConnectionInfo]) {
    ScrollArea::vertical().show(ui, |ui| {
        ui.label(RichText::new("Nodes").strong());
        for n in nodes {
            ui.group(|ui| {
                ui.strong(format!("{} ({})", n.name, n.node_type));
                if !n.inputs.is_empty() {
                    ui.label(format!("in: {}", n.inputs.join(", ")));
                }
                if !n.outputs.is_empty() {
                    ui.label(format!("out: {}", n.outputs.join(", ")));
                }
            });
        }

        ui.separator();
        ui.label(RichText::new("Connections").strong());
        for c in connections {
            ui.label(format!("{}.{} \u{2192} {}.{}", c.from_node, c.from_pin, c.to_node, c.to_pin));
        }
    });
}
