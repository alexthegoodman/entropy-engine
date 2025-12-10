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
            .map_err(|e| format!("Failed to load image from memory: {}", e)).unwrap();
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

pub fn pack_pbr_textures(
    // device: &wgpu::Device,
    // queue: &wgpu::Queue,
    roughness: Option<Texture>,
    metallic: Option<Texture>,
    ao: Option<Texture>,
) -> Result<Texture, String> {
    // Determine dimensions - use the first available texture's dimensions
    let (width, height) = if let Some(ref tex) = roughness {
        (tex.width, tex.height)
    } else if let Some(ref tex) = metallic {
        (tex.width, tex.height)
    } else if let Some(ref tex) = ao {
        (tex.width, tex.height)
    } else {
        return Err("At least one PBR texture must be provided".to_string());
    };

    // Verify all textures have the same dimensions
    for tex in [&roughness, &metallic, &ao].iter().filter_map(|t| t.as_ref()) {
        if tex.width != width || tex.height != height {
            return Err("All PBR textures must have the same dimensions".to_string());
        }
    }

    let pixel_count = (width * height) as usize;
    let mut packed_data = vec![0u8; pixel_count * 4]; // RGBA format

    for i in 0..pixel_count {
        let pixel_offset = i * 4;
        
        // R channel = roughness (take red channel from roughness texture)
        packed_data[pixel_offset] = if let Some(ref tex) = roughness {
            tex.data[i * 4] // Take R channel
        } else {
            128 // Default mid-roughness
        };
        
        // G channel = metallic (take red channel from metallic texture)
        packed_data[pixel_offset + 1] = if let Some(ref tex) = metallic {
            tex.data[i * 4] // Take R channel
        } else {
            0 // Default non-metallic
        };
        
        // B channel = AO (take red channel from AO texture)
        packed_data[pixel_offset + 2] = if let Some(ref tex) = ao {
            tex.data[i * 4] // Take R channel
        } else {
            255 // Default full ambient (no occlusion)
        };
        
        // A channel = 255 (full opacity)
        packed_data[pixel_offset + 3] = 255;
    }

    Ok(Texture {
        data: packed_data,
        width,
        height,
        format: wgpu::TextureFormat::Rgba8Unorm, // Linear for PBR parameters
    })
}