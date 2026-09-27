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

    /// Where the next mesh would land, so a container that only learns its size after laying
    /// out its content can still paint its background underneath that content (`insert_at`).
    pub fn mark(&self) -> DrawMark {
        let (vertices, indices) = self.commands.last().map_or((0, 0), |c| (c.vertices.len(), c.indices.len()));
        DrawMark { command: self.commands.len(), vertices, indices }
    }

    /// Inserts a mesh at `mark`, i.e. behind everything pushed since the mark was taken. A
    /// command that later meshes were merged into is split at the mark: every mesh only indexes
    /// its own vertices, so the indices before the mark never reach past its vertices.
    pub fn insert_at(&mut self, mark: DrawMark, clip_rect: Rect, texture: DrawTexture, vertices: Vec<Vertex>, indices: Vec<u32>) {
        if vertices.is_empty() || indices.is_empty() {
            return;
        }
        let mut at = mark.command.min(self.commands.len());
        if at > 0 {
            let prev = &mut self.commands[at - 1];
            if prev.vertices.len() > mark.vertices && prev.indices.len() >= mark.indices {
                let tail_vertices = prev.vertices.split_off(mark.vertices);
                let base = mark.vertices as u32;
                let tail_indices: Vec<u32> = prev.indices.split_off(mark.indices).into_iter().map(|i| i - base).collect();
                let tail = DrawCommand { clip_rect: prev.clip_rect, texture: prev.texture, vertices: tail_vertices, indices: tail_indices };
                self.commands.insert(at, tail);
            } else if prev.vertices.len() < mark.vertices {
                // The list was cleared or rewritten since the mark; drawing on top is the best we can do.
                at = self.commands.len();
            }
        }
        self.commands.insert(at, DrawCommand { clip_rect, texture, vertices, indices });
    }
}

/// A position in a `DrawList` - see `DrawList::mark`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrawMark {
    command: usize,
    vertices: usize,
    indices: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entropy_gui::geometry::{pos2, Rect};

    fn quad(tag: f32) -> (Vec<Vertex>, Vec<u32>) {
        let v = |x: f32| Vertex { position: [x, tag, 0.0], normal: [0.0; 3], tex_coords: [0.0, 0.0], color: [1.0; 4] };
        (vec![v(0.0), v(1.0), v(2.0), v(3.0)], vec![0, 1, 2, 0, 2, 3])
    }

    fn tags(list: &DrawList) -> Vec<f32> {
        list.commands.iter().flat_map(|c| c.indices.iter().map(|&i| c.vertices[i as usize].position[1])).step_by(6).collect()
    }

    #[test]
    fn a_mesh_inserted_at_a_mark_draws_behind_what_came_after_it() {
        let clip = Rect::from_min_max(pos2(0.0, 0.0), pos2(100.0, 100.0));
        let mut list = DrawList::new();
        let (v, i) = quad(1.0);
        list.push(clip, DrawTexture::White, v, i);
        let mark = list.mark();
        // Same clip and texture: merged into the first command.
        let (v, i) = quad(2.0);
        list.push(clip, DrawTexture::White, v, i);
        assert_eq!(list.commands.len(), 1);

        let (v, i) = quad(9.0);
        list.insert_at(mark, clip, DrawTexture::White, v, i);
        assert_eq!(tags(&list), vec![1.0, 9.0, 2.0]);
        // Every command still indexes only its own vertices.
        for c in &list.commands {
            assert!(c.indices.iter().all(|&i| (i as usize) < c.vertices.len()));
        }
    }

    #[test]
    fn inserting_at_the_end_mark_appends() {
        let clip = Rect::from_min_max(pos2(0.0, 0.0), pos2(10.0, 10.0));
        let mut list = DrawList::new();
        let mark = list.mark();
        let (v, i) = quad(5.0);
        list.insert_at(mark, clip, DrawTexture::White, v, i);
        assert_eq!(tags(&list), vec![5.0]);
    }
}
