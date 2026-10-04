//! GPU time per render pass, for the frame profiler (ENTROPY_FRAME_PROFILE). Wall-clock phases
//! can't tell GPU work from waiting on it: with timestamp queries each timed pass reports how
//! long the GPU itself spent on it, as a `gpu ...` row beside the CPU phases.
//!
//! Needs the adapter's TIMESTAMP_QUERY feature (requested in pipeline.rs when supported); without
//! it, or with profiling off, nothing is created and `pass` returns None. Results are read back
//! a few frames later through a small ring of buffers, so timing never stalls a frame: a frame
//! whose readback buffer is still busy simply goes unmeasured.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

/// Passes timed per frame at most.
const MAX_PASSES: u32 = 8;
const RING: usize = 3;

const FREE: u8 = 0;
const COPIED: u8 = 1;
const MAPPING: u8 = 2;
const MAPPED: u8 = 3;

struct Readback {
    buffer: wgpu::Buffer,
    labels: Vec<&'static str>,
    state: Arc<AtomicU8>,
}

pub struct GpuTimer {
    query_set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    ring: Vec<Readback>,
    /// Nanoseconds per timestamp tick.
    period: f64,
    /// Passes timed in the frame being encoded.
    labels: Vec<&'static str>,
}

impl GpuTimer {
    /// None when the device can't time passes.
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Self> {
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) { return None; }
        let bytes = (MAX_PASSES * 2) as u64 * 8;
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("GPU pass timer"), ty: wgpu::QueryType::Timestamp, count: MAX_PASSES * 2 });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("GPU pass timer resolve"), size: bytes,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false,
        });
        let ring = (0..RING).map(|i| Readback {
            buffer: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(&format!("GPU pass timer readback {i}")), size: bytes,
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
            }),
            labels: Vec::new(),
            state: Arc::new(AtomicU8::new(FREE)),
        }).collect();
        Some(Self { query_set, resolve, ring, period: queue.get_timestamp_period() as f64, labels: Vec::new() })
    }

    /// Timestamp writes for a pass named `label` (a `gpu ...` row), or None when this frame
    /// already times as many passes as it can.
    pub fn pass(&mut self, label: &'static str) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
        let n = self.labels.len() as u32;
        if n >= MAX_PASSES { return None; }
        self.labels.push(label);
        Some(wgpu::RenderPassTimestampWrites { query_set: &self.query_set, beginning_of_pass_write_index: Some(n * 2), end_of_pass_write_index: Some(n * 2 + 1) })
    }

    /// Resolves this frame's timestamps into a free readback buffer (call before finishing the encoder).
    pub fn resolve(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let labels = std::mem::take(&mut self.labels);
        if labels.is_empty() { return; }
        let Some(rb) = self.ring.iter_mut().find(|r| r.state.load(Ordering::Acquire) == FREE) else { return };
        let count = labels.len() as u32 * 2;
        encoder.resolve_query_set(&self.query_set, 0..count, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &rb.buffer, 0, count as u64 * 8);
        rb.labels = labels;
        rb.state.store(COPIED, Ordering::Release);
    }

    /// Starts mapping what `resolve` copied (call after the frame's submit).
    pub fn after_submit(&mut self) {
        for rb in &mut self.ring {
            if rb.state.load(Ordering::Acquire) != COPIED { continue; }
            rb.state.store(MAPPING, Ordering::Release);
            let state = rb.state.clone();
            rb.buffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
                state.store(if r.is_ok() { MAPPED } else { FREE }, Ordering::Release);
            });
        }
    }

    /// Reports finished measurements to the frame profiler (call once a frame).
    pub fn collect(&mut self, device: &wgpu::Device) {
        let _ = device.poll(wgpu::PollType::Poll);
        for rb in &mut self.ring {
            if rb.state.load(Ordering::Acquire) != MAPPED { continue; }
            {
                let data = rb.buffer.slice(..).get_mapped_range();
                let ticks: &[u64] = bytemuck::cast_slice(&data[..rb.labels.len() * 16]);
                for (i, label) in rb.labels.iter().enumerate() {
                    let (start, end) = (ticks[i * 2], ticks[i * 2 + 1]);
                    if end > start {
                        let ns = (end - start) as f64 * self.period;
                        crate::core::frame_profile::record(label, std::time::Duration::from_nanos(ns as u64));
                    }
                }
            }
            rb.buffer.unmap();
            rb.labels.clear();
            rb.state.store(FREE, Ordering::Release);
        }
    }
}
