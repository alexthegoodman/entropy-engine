use std::sync::Arc;
use wgpu::{Adapter, Device, Queue, Surface};

/// GPU resources wrapper for compatibility with the stunts-engine
/// This replaces the floem_renderer::gpu_resources::GpuResources
/// 
/// This struct is designed to be compatible with CommonUI's VelloRenderer
/// and can be created from the same Device/Queue instances
#[derive(Clone)]
pub struct GpuResources {
    pub surface: Option<Arc<Surface<'static>>>,
    pub device: Arc<Device>,
    pub queue: Arc<Queue>,
}

impl GpuResources {
    /// Create GpuResources from Arc<Device> and Arc<Queue> (compatible with CommonUI)
    pub fn from_commonui(device: Arc<Device>, queue: Arc<Queue>) -> Self {
        Self {
            surface: None,
            device,
            queue,
        }
    }

    /// Create GpuResources with full wgpu resources (for standalone usage)
    pub fn new(_adapter: Adapter, device: Device, queue: Queue) -> Self {
        Self {
            surface: None,
            device: Arc::new(device),
            queue: Arc::new(queue),
        }
    }

    /// Create GpuResources with surface
    pub fn with_surface(_adapter: Adapter, device: Device, queue: Queue, surface: Arc<Surface<'static>>) -> Self {
        Self {
            surface: Some(surface),
            device: Arc::new(device),
            queue: Arc::new(queue),
        }
    }
}