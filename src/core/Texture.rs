use image;

pub struct Texture {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub format: wgpu::TextureFormat,
}

impl Texture {
    pub fn new(data: Vec<u8>, width: u32, height: u32) -> Self {
        Self {
            data,
            width,
            height,
            format: wgpu::TextureFormat::Rgba8UnormSrgb, // Assuming this format for now
        }
    }

    pub fn from_bytes(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bytes: &[u8],
        label: String,
        is_normal_map: bool,
    ) -> Result<Self, String> {
        let img = image::load_from_memory(bytes)
            .map_err(|e| format!("Failed to load image from memory: {}", e))?;
        let img = img.to_rgba8();

        let width = img.width();
        let height = img.height();
        let data = img.into_raw();

        let format = if is_normal_map {
            wgpu::TextureFormat::Rgba8Unorm // Normal maps are usually linear
        } else {
            wgpu::TextureFormat::Rgba8UnormSrgb // SRGB for color textures
        };

        Ok(Self {
            data,
            width,
            height,
            format,
        })
    }

    pub fn from_bytes_1x1(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bytes: &[u8],
        label: &str,
        is_normal_map: bool,
    ) -> Result<Self, String> {
        if bytes.len() != 4 {
            return Err("1x1 texture data must be 4 bytes (RGBA)".to_string());
        }

        let format = if is_normal_map {
            wgpu::TextureFormat::Rgba8Unorm
        } else {
            wgpu::TextureFormat::Rgba8UnormSrgb
        };

        Ok(Self {
            data: bytes.to_vec(),
            width: 1,
            height: 1,
            format,
        })
    }

    pub fn size(&self) -> wgpu::Extent3d {
        wgpu::Extent3d {
            width: self.width,
            height: self.height,
            depth_or_array_layers: 1,
        }
    }
}
