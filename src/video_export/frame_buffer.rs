use futures::channel::oneshot;
use wgpu::CommandEncoder;

pub struct FrameCaptureBuffer {
    capture_texture: wgpu::Texture,
    staging_buffer: wgpu::Buffer,
    buffer_size: u64,
}

impl FrameCaptureBuffer {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let texture_desc = wgpu::TextureDescriptor {
            label: Some("Capture Texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // format: wgpu::TextureFormat::Rgba8Unorm,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        };

        let capture_texture = device.create_texture(&texture_desc);

        // Calculate buffer size with alignment requirements
        let buffer_size = (width * 4) * height;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = ((width * 4 + align - 1) / align) * align;
        let buffer_size = (padded_bytes_per_row * height) as u64;

        let staging_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Capture Staging Buffer"),
            size: buffer_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        Self {
            capture_texture,
            staging_buffer,
            buffer_size,
        }
    }

    /// Copies `render_texture` into `capture_texture`, then `capture_texture` into the staging
    /// buffer, for later CPU readback via `get_frame_data`. Pre-existing (see
    /// render_addon_frame.rs/render_frame.rs, guarded behind `pipeline.frame_buffer.is_some()`,
    /// which nothing currently sets) - kept as-is for those call sites. `run_export` doesn't use
    /// this: it renders directly into the view from `create_view()` instead, so it only needs
    /// the second half - see `copy_to_staging`.
    pub fn capture_frame(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        render_texture: &wgpu::Texture,
        encoder: &mut CommandEncoder,
    ) {
        encoder.copy_texture_to_texture(
            render_texture.as_image_copy(),
            self.capture_texture.as_image_copy(),
            wgpu::Extent3d {
                width: self.capture_texture.width(),
                height: self.capture_texture.height(),
                depth_or_array_layers: 1,
            },
        );

        self.copy_to_staging(encoder);
    }

    /// A view onto `capture_texture` itself, for rendering directly into this buffer instead of
    /// rendering elsewhere and copying in - see `exporter::run_export`, which is the only
    /// current caller and needs a `RENDER_ATTACHMENT`-usable view to pass as a frame's
    /// `target_view`.
    pub fn create_view(&self) -> wgpu::TextureView {
        self.capture_texture.create_view(&wgpu::TextureViewDescriptor::default())
    }

    /// Copies `capture_texture`'s current contents into the staging buffer for CPU readback via
    /// `get_frame_data`.
    pub fn copy_to_staging(&self, encoder: &mut CommandEncoder) {
        let buffer_dimensions =
            BufferDimensions::new(self.capture_texture.width(), self.capture_texture.height());

        encoder.copy_texture_to_buffer(
            self.capture_texture.as_image_copy(),
            // wgpu::ImageCopyBuffer {
            wgpu::TexelCopyBufferInfo {
                buffer: &self.staging_buffer,
                // layout: wgpu::ImageDataLayout {
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(buffer_dimensions.padded_bytes_per_row),
                    rows_per_image: Some(buffer_dimensions.height),
                },
            },
            wgpu::Extent3d {
                width: buffer_dimensions.width,
                height: buffer_dimensions.height,
                depth_or_array_layers: 1,
            },
        );
    }

    pub async fn get_frame_data(&self, device: &wgpu::Device) -> Vec<u8> {
        let buffer_slice = self.staging_buffer.slice(..);
        // let (tx, rx) = futures_intrusive::channel::shared::oneshot_channel();
        let (tx, rx) = oneshot::channel();

        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            tx.send(result).unwrap();
        });
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None });

        rx.await.unwrap().unwrap();

        let padded_buffer = buffer_slice.get_mapped_range();
        let data = padded_buffer.to_vec();
        drop(padded_buffer);
        self.staging_buffer.unmap();

        // Remove padding if necessary
        let actual_width = self.capture_texture.width() as usize * 4;
        let padded_width = ((actual_width + 255) / 256) * 256;

        if actual_width == padded_width {
            data
        } else {
            let height = self.capture_texture.height() as usize;
            let mut unpadded = Vec::with_capacity(actual_width * height);
            for row in 0..height {
                // for row in (0..height).rev() {
                let row_start = row * padded_width;
                unpadded.extend_from_slice(&data[row_start..row_start + actual_width]);
            }
            unpadded
        }
    }
}

// Helper struct for buffer dimensions
#[derive(Debug)]
struct BufferDimensions {
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
}

impl BufferDimensions {
    fn new(width: u32, height: u32) -> Self {
        let bytes_per_pixel = 4;
        let unpadded_bytes_per_row = width * bytes_per_pixel;
        let align = wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let padded_bytes_per_row = ((unpadded_bytes_per_row + align - 1) / align) * align;

        Self {
            width,
            height,
            padded_bytes_per_row,
        }
    }
}
