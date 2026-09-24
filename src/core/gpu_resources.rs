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
    /// The format the window's swapchain is configured with. Always `Rgba8Unorm` where the
    /// surface supports it (Windows); otherwise the surface's closest match (e.g. `Bgra8Unorm`
    /// on Linux/X11 Vulkan), and the frame is blitted into it - see `crate::core::surface_blit`.
    pub surface_format: wgpu::TextureFormat,
}

impl GpuResources {
    /// Create GpuResources from Arc<Device> and Arc<Queue> (compatible with CommonUI)
    pub fn from_commonui(device: Arc<Device>, queue: Arc<Queue>) -> Self {
        Self {
            surface: None,
            device,
            queue,
            surface_format: crate::core::surface_blit::RENDER_FORMAT,
        }
    }

    /// Create GpuResources with full wgpu resources (for standalone usage)
    pub fn new(_adapter: Adapter, device: Device, queue: Queue) -> Self {
        Self {
            surface: None,
            device: Arc::new(device),
            queue: Arc::new(queue),
            surface_format: crate::core::surface_blit::RENDER_FORMAT,
        }
    }

    /// Create GpuResources with surface
    pub fn with_surface(adapter: Adapter, device: Device, queue: Queue, surface: Arc<Surface<'static>>) -> Self {
        let surface_format = crate::core::surface_blit::pick_surface_format(&surface.get_capabilities(&adapter).formats);
        Self {
            surface: Some(surface),
            device: Arc::new(device),
            queue: Arc::new(queue),
            surface_format,
        }
    }
}