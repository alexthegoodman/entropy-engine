use std::{fs::File, path::PathBuf};

use exr::prelude::read_first_rgba_layer_from_file;
use image::GenericImageView;
use serde::Serialize;
use tiff::decoder::{Decoder, DecodingResult};
use nalgebra as na;

use crate::helpers::saved_data::LandscapeTextureKinds;
#[cfg(target_arch = "wasm32")]
use crate::helpers::wasm_loaders::read_texture_bytes_wasm;

use super::utilities::get_common_os_dir;

pub struct LandscapePixelData {
    pub width: usize,
    pub height: usize,
    // data: Vec<u8>,
    pub pixel_data: Vec<Vec<PixelData>>,
    pub rapier_heights: na::DMatrix<f32>,
    pub raw_heights: Vec<f32>,
    pub max_height: f32,
}

#[derive(Serialize)]
pub struct PixelData {
    pub height_value: f32,
    pub position: [f32; 3],
    pub tex_coords: [f32; 2],
}

#[derive(Serialize)]
pub struct TextureData {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

pub fn read_tiff_heightmap(
    landscape_path: &str,
    target_width: f32,
    target_length: f32,
    target_height: f32,
) -> (
    usize,
    usize,
    Vec<Vec<PixelData>>,
    na::DMatrix<f32>,
    Vec<f32>,
    f32,
) {
    // Added DMatrix return
    let file = File::open(landscape_path).expect("Couldn't open tif file");
    let mut decoder = Decoder::new(file).expect("Couldn't decode tif file");

    let (width, height) = decoder.dimensions().expect("Couldn't get tif dimensions");

    let width = usize::try_from(width).unwrap();
    let height = usize::try_from(height).unwrap();

    let image = match decoder
        .read_image()
        .expect("Couldn't read image data from tif")
    {
        DecodingResult::F32(vec) => vec,
        DecodingResult::U16(vec) => {
            // Convert u16 to f32 if needed
            vec.into_iter().map(|v| v as f32).collect()
        }
        _ => return (0, 0, Vec::new(), na::DMatrix::zeros(0, 0), Vec::new(), 0.0),
    };

    println!("Continuing!");

    let mut pixel_data = Vec::new();
    let mut raw_heights = Vec::new();
    // Create the heights matrix for the collider
    let mut heights = na::DMatrix::zeros(height, width);

    // Calculate scaling factors
    let x_scale = target_width / width as f32;
    let y_scale = target_length / height as f32;
    let z_scale = target_height;

    let min_height = *image
        .iter()
        .min_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap();
    let max_height = *image
        .iter()
        .max_by(|a, b| a.partial_cmp(b).unwrap())
        .unwrap();
    let height_range = max_height - min_height;

    let mut max_height_actual: f32 = 0.0;

    for y in 0..height {
        let mut row = Vec::new();
        for x in 0..width {
            let idx = (y * width + x) as usize;
            let normalized_height = (image[idx] - min_height) / height_range;
            let height_value = normalized_height * z_scale;

            max_height_actual = max_height_actual.max(height_value);

            // Set the height in the DMatrix
            heights[(y, x)] = height_value;
            // heights[(x, y)] = height_value;
            raw_heights.push(height_value);

            let position = [
                x as f32 * x_scale - target_width / 2.0,
                height_value,
                y as f32 * y_scale - target_length / 2.0,
            ];
            let tex_coords = [x as f32 / width as f32, y as f32 / height as f32];

            row.push(PixelData {
                height_value,
                position,
                tex_coords,
            });
        }
        pixel_data.push(row);
    }

    println!("Tiff heightmap finished!");

    (
        width,
        height,
        pixel_data,
        heights,
        raw_heights,
        max_height_actual,
    )
}

pub fn get_landscape_pixels(
    // state: tauri::State<'_, AppState>,
    projectId: String,
    landscapeAssetId: String,
    landscapeFilename: String,
) -> LandscapePixelData {
    // let handle = &state.handle;
    // let config = handle.config();
    // let package_info = handle.package_info();
    // let env = handle.env();

    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let landscapes_dir = sync_dir.join(format!(
        "midpoint/projects/{}/landscapes/{}/heightmaps",
        projectId, landscapeAssetId
    ));
    let landscape_path = landscapes_dir.join(landscapeFilename);
    // let landscape_path = landscapes_dir
    //     .join("upscaled")
    //     .join("upscaled_heightmap.tiff");

    println!("landscape_path {:?}", landscape_path);

    // let square_size = 1024.0 * 100.0;
    // let square_height = 1858.0 * 10.0;
    let square_size = 1024.0 * 4.0;
    let square_height = 150.0 * 4.0;
    let (width, height, pixel_data, rapier_heights, raw_heights, max_height) = read_tiff_heightmap(
        landscape_path
            .to_str()
            .expect("Couldn't form landscape string"),
        // battlefield size
        // 2048.0,
        // 2048.0,
        // 250.0,
        // literal grand canyon in meters
        square_size,
        square_size,
        square_height,
    );

    LandscapePixelData {
        width,
        height,
        // data: heightmap.to_vec(),
        pixel_data,
        rapier_heights,
        raw_heights,
        max_height,
    }
}

pub fn read_landscape_heightmap_as_texture(
    projectId: String,
    landscapeId: String,
    textureFilename: String,
) -> Result<TextureData, String> {
    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let texture_path = sync_dir.join(format!(
        "midpoint/projects/{}/landscapes/{}/heightmaps/{}",
        projectId, landscapeId, textureFilename
    ));

    println!("texture path {:?}", texture_path);

    let img = image::open(&texture_path)
        .map_err(|e| format!("Failed to open landscape texture: {}", e))?;

    let (width, height) = img.dimensions();
    
    let luma16 = img.to_luma16();

    // Find min/max values
    let mut min_val = u16::MAX;
    let mut max_val = u16::MIN;
    for pixel in luma16.pixels() {
        let val = pixel[0];
        min_val = min_val.min(val);
        max_val = max_val.max(val);
    }

    println!("Heightmap range: {} to {}", min_val, max_val);

    // Normalize to 0-255 range
    let mut bytes = Vec::with_capacity((width * height * 4) as usize);
    let range = (max_val - min_val) as f32;
    
    for pixel in luma16.pixels() {
        let val = pixel[0];
        // Normalize: (value - min) / (max - min) * 255
        let normalized = ((val - min_val) as f32 / range * 255.0) as u8;
        bytes.push(normalized); // R
        bytes.push(normalized); // G
        bytes.push(normalized); // B
        bytes.push(255);        // A
    }

    println!("First normalized pixel: R={}", bytes[0]);

    Ok(TextureData {
        bytes,
        width,
        height,
    })
}

pub fn read_landscape_texture(
    // state: tauri::State<'_, AppState>,
    projectId: String,
    landscapeId: String,
    textureFilename: String,
    // textureKind: String,
) -> Result<TextureData, String> {
    // let handle = &state.handle;
    // let config = handle.config();
    // let package_info = handle.package_info();
    // let env = handle.env();

    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let texture_path = sync_dir.join(format!(
        "midpoint/projects/{}/textures/{}{}",
        projectId, textureFilename, ".png"
    ));

    println!("texture path {:?}", texture_path);

    // Read the image file
    let img = image::open(&texture_path)
        .map_err(|e| format!("Failed to open landscape texture: {}", e))?;

    // Get dimensions
    let (width, height) = img.dimensions();

    // Convert to RGBA
    let rgba_img = img.to_rgba8();
    let bytes = rgba_img.into_raw();

    Ok(TextureData {
        bytes,
        width,
        height,
    })
}

pub fn read_landscape_mask(
    // state: tauri::State<'_, AppState>,
    projectId: String,
    landscapeId: String,
    maskFilename: String,
    maskKind: LandscapeTextureKinds,
) -> Result<TextureData, String> {
    // let handle = &state.handle;
    // let config = handle.config();
    // let package_info = handle.package_info();
    // let env = handle.env();

    let kind_slug = match maskKind {
        LandscapeTextureKinds::Primary => "heightmaps",
        LandscapeTextureKinds::Rockmap => "rockmaps",
        LandscapeTextureKinds::Soil => "soils",
        _ => "",
    };

    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
    let mask_path = sync_dir.join(format!(
        "midpoint/projects/{}/landscapes/{}/{}/{}",
        projectId, landscapeId, kind_slug, maskFilename
    ));

    println!("mask_path {:?}", mask_path);

    // Read the image file
    let img =
        image::open(&mask_path).map_err(|e| format!("Failed to open landscape mask: {}", e))?;

    // Get dimensions
    let (width, height) = img.dimensions();

    // Convert to RGBA
    let rgba_img = img.to_rgba8();
    let bytes = rgba_img.into_raw();

    Ok(TextureData {
        bytes,
        width,
        height,
    })
}

pub async fn read_texture_bytes(
    project_id: String,
    asset_id: String, // This could be landscapeId or pbr_texture_id
    file_name: String,
) -> Result<(Vec<u8>, u32, u32), String> {
    #[cfg(target_os = "windows")]
    return read_texture_bytes_local(
        project_id,
        asset_id,
        file_name
    );

    #[cfg(target_arch = "wasm32")]
    read_texture_bytes_wasm(
        project_id,
        asset_id,
        file_name
    ).await
}

pub fn read_texture_bytes_local(
    project_id: String,
    asset_id: String, // This could be landscapeId or pbr_texture_id
    file_name: String,
) -> Result<(Vec<u8>, u32, u32), String> {
    let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");

    // Determine the base directory based on asset_id type
    let base_path =
        sync_dir.join(format!(
            "midpoint/projects/{}/textures/",
            project_id
        ));

    let file_path = base_path.join(file_name.clone());

    println!("Attempting to read texture from path: {:?}", file_path);

    let extension = file_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let data = match extension {
        "png" | "jpg" | "jpeg" => {
            let image = image::open(&file_path)
                .map_err(|e| format!("Failed to open image file {}: {}", file_name, e))?;

            let width = image.width();
            let height = image.height();

                (image.to_rgba8()
                .into_raw(), width, height)
        }
        "tif" | "tiff" => {
            let file = File::open(&file_path)
                .map_err(|e| format!("Failed to open TIFF file {}: {}", file_name, e))?;
            let mut decoder = Decoder::new(file)
                .map_err(|e| format!("Failed to decode TIFF file {}: {}", file_name, e))?;
            let (width, height) = decoder.dimensions().map_err(|e| format!("Failed to get TIFF dimensions {}: {}", file_name, e))?;

            match decoder.read_image().map_err(|e| format!("Failed to read TIFF image data {}: {}", file_name, e))? {
                DecodingResult::U8(data) => (data, width, height),
                DecodingResult::U16(data) => {
                    // Convert U16 to U8, perhaps by taking the most significant byte or scaling
                    (data.into_iter().map(|v| (v / 256) as u8).collect(), width, height)
                },
                DecodingResult::F32(data) => {
                    // Convert F32 to U8 by scaling 0-1 range to 0-255
                    (data.into_iter().map(|v| (v * 255.0) as u8).collect(), width, height)
                }
                _ => return Err(format!("Unsupported TIFF decoding result for file: {}", file_name)),
            }
        }
        "exr" => {
            // Read EXR file into a nested Vec<Vec<[f32; 4]>> structure
            let image = read_first_rgba_layer_from_file(
                &file_path,
                // Instantiate image type with the size of the image in file
                |resolution, _| {
                    let default_pixel = [0.0, 0.0, 0.0, 0.0];
                    let empty_line = vec![default_pixel; resolution.width()];
                    let empty_image = vec![empty_line; resolution.height()];
                    empty_image
                },
                // Transfer the colors from the file to your image type
                |pixel_vector, position, (r, g, b, a): (f32, f32, f32, f32)| {
                    pixel_vector[position.y()][position.x()] = [r, g, b, a]
                }
            )
            .map_err(|e| format!("Failed to read EXR file {}: {:?}", file_name, e)).unwrap();

            // println!("exr pixels {:?}", image.layer_data.channel_data.pixels.len());

            // Convert the nested Vec<Vec<[f32; 4]>> to a flat Vec<u8>
            // EXR stores HDR data as floats, so we need to convert to 8-bit
            (image.layer_data.channel_data.pixels
                .iter()
                .flat_map(|row| {
                    row.iter().flat_map(|&[r, g, b, a]| {
                        // Clamp and convert f32 values (0.0-1.0) to u8 (0-255)
                        [
                            (r.clamp(0.0, 1.0) * 255.0) as u8,
                            (g.clamp(0.0, 1.0) * 255.0) as u8,
                            (b.clamp(0.0, 1.0) * 255.0) as u8,
                            (a.clamp(0.0, 1.0) * 255.0) as u8,
                        ]
                    })
                })
                .collect(), 0, 0)
        }
        _ => return Err(format!("Unsupported texture file format: {}", file_name)),
    };

    Ok(data)
}
