//! Docking tree — an arena `Vec<Node>` addressed by `NodeIndex(usize)`, matching
//! `egui_dock`'s own internal shape. v1 covers exactly what this app's actual usage
//! exercises: static tree construction via `split_left/right/above/below` +
//! `NodeIndex::root()`, click-to-select-tab, and drag-to-resize-splitter (built in
//! `dock/mod.rs`). Deliberately NOT built (nothing in this app's egui_dock usage needs it):
//! tab drag-to-reorder, drag-tab-to-a-different-leaf, floating/undocked tabs, tab closing.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeIndex(pub usize);

impl NodeIndex {
    pub fn root() -> Self {
        NodeIndex(0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Orientation {
    Horizontal,
    Vertical,
}

pub enum Node<Tab> {
    Leaf { tabs: Vec<Tab>, active: usize },
    Split { fraction: f32, orientation: Orientation, children: [NodeIndex; 2] },
}

pub struct Surface<Tab> {
    pub(crate) nodes: Vec<Node<Tab>>,
}

impl<Tab> Surface<Tab> {
    fn new(tabs: Vec<Tab>) -> Self {
        Self { nodes: vec![Node::Leaf { tabs, active: 0 }] }
    }

    /// `fraction` is always the *first* child's share (spatially first: left for horizontal
    /// splits, top for vertical), regardless of which side receives the new tabs — this is a
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

    pub fn split_left(&mut self, target: NodeIndex, fraction: f32, new_tabs: Vec<Tab>) -> [NodeIndex; 2] {
        self.split(target, Orientation::Horizontal, fraction, new_tabs, true)
    }
    pub fn split_right(&mut self, target: NodeIndex, fraction: f32, new_tabs: Vec<Tab>) -> [NodeIndex; 2] {
        self.split(target, Orientation::Horizontal, fraction, new_tabs, false)
    }
    pub fn split_above(&mut self, target: NodeIndex, fraction: f32, new_tabs: Vec<Tab>) -> [NodeIndex; 2] {
        self.split(target, Orientation::Vertical, fraction, new_tabs, true)
    }
    pub fn split_below(&mut self, target: NodeIndex, fraction: f32, new_tabs: Vec<Tab>) -> [NodeIndex; 2] {
        self.split(target, Orientation::Vertical, fraction, new_tabs, false)
    }

    pub fn root(&self) -> NodeIndex {
        NodeIndex::root()
    }
}

pub struct DockState<Tab> {
    main_surface: Surface<Tab>,
}

impl<Tab> DockState<Tab> {
    pub fn new(tabs: Vec<Tab>) -> Self {
        Self { main_surface: Surface::new(tabs) }
    }

    pub fn main_surface_mut(&mut self) -> &mut Surface<Tab> {
        &mut self.main_surface
    }

    pub fn main_surface(&self) -> &Surface<Tab> {
        &self.main_surface
    }
}
