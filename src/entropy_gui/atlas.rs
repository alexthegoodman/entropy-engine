//! Shared glyph atlas — one dynamic-packed texture for the whole GUI, replacing the old
//! per-text-item 4096x4096 atlas in `src/renderer_text/text_due.rs`. Rasterization logic
//! (fontdue `rasterize_config` + alpha->RGBA expansion) ports directly from there; packing
//! is delegated to `etagere` instead of that file's naive non-evicting shelf packer.
//!
//! This module is GPU-agnostic on purpose: it only decides *where* a glyph's pixels live in
//! the atlas and records the upload as data (`AtlasUpload`), the same way real egui's
//! `textures_delta.set` works. The render backend (`backend/wgpu_renderer.rs`) is what
//! actually owns the `wgpu::Texture` and applies these uploads via `queue.write_texture`.

use std::collections::HashMap;

#[derive(Clone, Copy, Debug, Default)]
pub struct CachedGlyph {
    pub uv_min: (f32, f32),
    pub uv_size: (f32, f32),
    pub width: f32,
    pub height: f32,
    pub xmin: f32,
    pub ymin: f32,
    pub advance: f32,
}

pub struct AtlasUpload {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct GlyphAtlas {
    allocator: etagere::AtlasAllocator,
    size: u32,
    cache: HashMap<fontdue::layout::GlyphRasterConfig, CachedGlyph>,
    pending_uploads: Vec<AtlasUpload>,
}

impl GlyphAtlas {
    pub fn new(size: u32) -> Self {
        Self {
            allocator: etagere::AtlasAllocator::new(etagere::size2(size as i32, size as i32)),
            size,
            cache: HashMap::new(),
            pending_uploads: Vec::new(),
        }
    }

    pub fn size(&self) -> u32 {
        self.size
    }

    /// Drains queued texture uploads for the render backend to apply this frame.
    pub fn take_uploads(&mut self) -> Vec<AtlasUpload> {
        std::mem::take(&mut self.pending_uploads)
    }

    pub fn get_or_rasterize(
        &mut self,
        font: &fontdue::Font,
        raster_config: fontdue::layout::GlyphRasterConfig,
    ) -> CachedGlyph {
        let key = raster_config;
        if let Some(g) = self.cache.get(&key) {
            return *g;
        }

        let (metrics, bitmap) = font.rasterize_config(raster_config);

        if metrics.width == 0 || metrics.height == 0 {
            let g = CachedGlyph {
                uv_min: (0.0, 0.0),
                uv_size: (0.0, 0.0),
                width: 0.0,
                height: 0.0,
                xmin: metrics.xmin as f32,
                ymin: metrics.ymin as f32,
                advance: metrics.advance_width,
            };
            self.cache.insert(key, g);
            return g;
        }

        let want = etagere::size2(metrics.width as i32, metrics.height as i32);
        let alloc = self.allocator.allocate(want).or_else(|| {
            // Atlas full: v1 recovery is a full reset rather than per-glyph LRU eviction —
            // this app's glyph working set (UI text at a handful of sizes) is small and
            // bounded, so an occasional full re-pack is cheap and simple. A true LRU can be
            // added later if a workload ever churns through enough distinct glyphs to thrash.
            self.allocator.clear();
            self.cache.clear();
            self.allocator.allocate(want)
        });

        let Some(alloc) = alloc else {
            // Single glyph literally larger than the whole atlas — draw nothing rather than panic.
            return CachedGlyph {
                uv_min: (0.0, 0.0),
                uv_size: (0.0, 0.0),
                width: 0.0,
                height: 0.0,
                xmin: metrics.xmin as f32,
                ymin: metrics.ymin as f32,
                advance: metrics.advance_width,
            };
        };

        let x = alloc.rectangle.min.x as u32;
        let y = alloc.rectangle.min.y as u32;

        let mut rgba = Vec::with_capacity(bitmap.len() * 4);
        for &a in bitmap.iter() {
            rgba.extend_from_slice(&[255, 255, 255, a]);
        }
        self.pending_uploads.push(AtlasUpload {
            x,
            y,
            width: metrics.width as u32,
            height: metrics.height as u32,
            rgba,
        });

        let g = CachedGlyph {
            uv_min: (x as f32 / self.size as f32, y as f32 / self.size as f32),
            uv_size: (metrics.width as f32 / self.size as f32, metrics.height as f32 / self.size as f32),
            width: metrics.width as f32,
            height: metrics.height as f32,
            xmin: metrics.xmin as f32,
            ymin: metrics.ymin as f32,
            advance: metrics.advance_width,
        };
        self.cache.insert(key, g);
        g
    }
}
