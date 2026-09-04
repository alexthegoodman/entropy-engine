//! Per-frame draw list: an ordered, batched sequence of (clip_rect, texture, mesh) triples.
//! Consecutive entries sharing the same clip rect + texture are coalesced into a single
//! mesh so the backend can render them with one `draw_indexed` call.

use crate::core::vertex::Vertex;
use crate::entropy_gui::geometry::Rect;

/// Opaque handle to a GPU texture registered with the render backend (the sole texture
/// mechanism this app uses — no CPU-side `ColorImage`/`TextureHandle` loading).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TextureId(pub u64);

impl TextureId {
    /// Reserved id for the shared glyph atlas texture — `register_native_texture` never
    /// hands this id out (it allocates starting from 1).
    pub const ATLAS: TextureId = TextureId(0);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawTexture {
    /// A single opaque white texel — used for flat-color fills/strokes.
    White,
    /// The shared glyph atlas.
    Glyph,
    /// A texture registered via `register_native_texture`.
    Native(TextureId),
}

pub struct DrawCommand {
    pub clip_rect: Rect,
    pub texture: DrawTexture,
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
}

#[derive(Default)]
pub struct DrawList {
    pub commands: Vec<DrawCommand>,
}

impl DrawList {
    pub fn new() -> Self {
        Self { commands: Vec::new() }
    }

    pub fn clear(&mut self) {
        self.commands.clear();
    }

    /// Appends a mesh, merging into the previous command when it shares the same
    /// clip rect + texture (the common case: a run of widgets in one panel).
    pub fn push(&mut self, clip_rect: Rect, texture: DrawTexture, vertices: Vec<Vertex>, indices: Vec<u32>) {
        if vertices.is_empty() || indices.is_empty() {
            return;
        }
        if let Some(last) = self.commands.last_mut() {
            if last.clip_rect == clip_rect && last.texture == texture {
                let base = last.vertices.len() as u32;
                last.vertices.extend(vertices);
                last.indices.extend(indices.into_iter().map(|i| i + base));
                return;
            }
        }
        self.commands.push(DrawCommand { clip_rect, texture, vertices, indices });
    }
}
