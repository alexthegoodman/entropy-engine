#[cfg(target_arch = "wasm32")]
use crate::helpers::saved_data::LandscapeTextureKinds;
use crate::helpers::saved_data::SavedState;
use crate::helpers::landscapes::{TextureData, LandscapePixelData, PixelData}; // Import TextureData, LandscapePixelData and PixelData
use reqwest;
use image::{self, GenericImageView};
use std::io::Cursor;
use tiff::decoder::{Decoder, DecodingResult};
use nalgebra as na;
use exr::prelude::ReadChannels;
use exr::prelude::ReadLayers;
use exr::image::read as exr_read;

#[cfg(target_arch = "wasm32")]
pub async fn load_project_state_wasm(project_id: &str) -> Result<SavedState, Box<dyn std::error::Error>> {
    let url = format!("http://asset.localhost/midpoint/projects/{}/midpoint.json", project_id);
    let json_content = reqwest::get(&url).await?.text().await?;
    let state: SavedState = serde_json::from_str(&json_content)?;
    Ok(state)
}

#[cfg(target_arch = "wasm32")]
pub async fn load_image_from_url(url: &str) -> Result<TextureData, Box<dyn std::error::Error>> {
    let response = reqwest::get(url).await?.bytes().await?;
    let img = image::load_from_memory(&response)?;
    let (width, height) = img.dimensions();
    let rgba_img = img.to_rgba8();
    let bytes = rgba_img.into_raw();
    Ok(TextureData { bytes, width, height })
}

#[cfg(target_arch = "wasm32")]
pub fn read_tiff_heightmap_wasm(
    tiff_bytes: Vec<u8>,
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
    let cursor = Cursor::new(tiff_bytes);
    let mut decoder = Decoder::new(cursor).expect("Couldn't decode tif bytes");

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

#[cfg(target_arch = "wasm32")]
pub async fn get_landscape_pixels_wasm(
    project_id: String,
    landscape_asset_id: String,
    landscape_filename: String,
) -> LandscapePixelData {
    let url = format!(
        "http://asset.localhost/midpoint/projects/{}/landscapes/{}/heightmaps/{}",
        project_id, landscape_asset_id, landscape_filename
    );

    let tiff_bytes = reqwest::get(&url)
        .await
        .expect("Failed to fetch tiff file")
        .bytes()
        .await
        .expect("Failed to get tiff bytes")
        .to_vec();

    let square_size = 1024.0 * 4.0;
    let square_height = 150.0 * 4.0;
    let (width, height, pixel_data, rapier_heights, raw_heights, max_height) = read_tiff_heightmap_wasm(
        tiff_bytes,
        square_size,
        square_size,
        square_height,
    );

    LandscapePixelData {
        width,
        height,
        pixel_data,
        rapier_heights,
        raw_heights,
        max_height,
    }
}

#[cfg(target_arch = "wasm32")]
pub async fn read_landscape_heightmap_as_texture_wasm(
    project_id: String,
    landscape_id: String,
    texture_filename: String,
) -> Result<TextureData, String> {
    let url = format!(
        "http://asset.localhost/midpoint/projects/{}/landscapes/{}/heightmaps/{}",
        project_id, landscape_id, texture_filename
    );

    let response_bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch heightmap texture: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to get heightmap texture bytes: {}", e))?;

    let img = image::load_from_memory(&response_bytes)
        .map_err(|e| format!("Failed to load heightmap image from memory: {}", e))?;

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

#[cfg(target_arch = "wasm32")]
pub async fn read_landscape_texture_wasm(
    project_id: String,
    _landscape_id: String, // Note: original takes landscapeId, but URL uses projectId only for textures dir
    texture_filename: String,
) -> Result<TextureData, String> {
    let url = format!(
        "http://asset.localhost/midpoint/projects/{}/textures/{}.png",
        project_id, texture_filename
    );
    load_image_from_url(&url)
        .await
        .map_err(|e| format!("Failed to load landscape texture: {}", e))
}


#[cfg(target_arch = "wasm32")]
pub async fn read_landscape_mask_wasm(
    project_id: String,
    landscape_id: String,
    mask_filename: String,
    mask_kind: LandscapeTextureKinds,
) -> Result<TextureData, String> {
    let kind_slug = match mask_kind {
        LandscapeTextureKinds::Primary => "heightmaps",
        LandscapeTextureKinds::Rockmap => "rockmaps",
        LandscapeTextureKinds::Soil => "soils",
        _ => "", // Handle other cases if necessary
    };

    let url = format!(
        "http://asset.localhost/midpoint/projects/{}/landscapes/{}/{}/{}",
        project_id, landscape_id, kind_slug, mask_filename
    );

    load_image_from_url(&url)
        .await
        .map_err(|e| format!("Failed to load landscape mask: {}", e))
}

#[cfg(target_arch = "wasm32")]
pub async fn read_texture_bytes_wasm(
    project_id: String,
    _asset_id: String, // This could be landscapeId or pbr_texture_id
    file_name: String,
) -> Result<(Vec<u8>, u32, u32), String> {
    // Determine the base directory based on asset_id type
    let url = format!(
        "http://asset.localhost/midpoint/projects/{}/textures/{}",
        project_id, file_name
    );

    println!("Attempting to read texture from URL: {:?}", url);

    let response_bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch texture: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to get texture bytes: {}", e))?;

    let extension = file_name
        .rsplit('.')
        .next()
        .unwrap_or("");

    let (bytes, width, height) = match extension {
        "png" | "jpg" | "jpeg" => {
            let img = image::load_from_memory(&response_bytes)
                .map_err(|e| format!("Failed to load image file {}: {}", file_name, e))?;
            let (width, height) = img.dimensions();
            (img.to_rgba8().into_raw(), width, height)
        }
        "tif" | "tiff" => {
            let cursor = Cursor::new(response_bytes);
            let mut decoder = Decoder::new(cursor)
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
            // let image = read_first_rgba_layer_from_reader(
            //     Cursor::new(response_bytes),
            //     // Instantiate image type with the size of the image in file
            //     |resolution, _| {
            //         let default_pixel = [0.0, 0.0, 0.0, 0.0];
            //         let empty_line = vec![default_pixel; resolution.width()];
            //         let empty_image = vec![empty_line; resolution.height()];
            //         empty_image
            //     },
            //     // Transfer the colors from the file to your image type
            //     |pixel_vector, position, (r, g, b, a): (f32, f32, f32, f32)| {
            //         pixel_vector[position.y()][position.x()] = [r, g, b, a]
            //     }
            // )
            // .map_err(|e| format!("Failed to read EXR file {}: {:?}", file_name, e)).unwrap();

            

            let image = exr_read::read()
                .no_deep_data()
                .largest_resolution_level()
                .rgba_channels(|resolution, _| {
                    let default_pixel = [0.0, 0.0, 0.0, 0.0];
                    let empty_line = vec![default_pixel; resolution.width()];
                    let empty_image = vec![empty_line; resolution.height()];
                    empty_image
                },
                // Transfer the colors from the file to your image type
                |pixel_vector, position, (r, g, b, a): (f32, f32, f32, f32)| {
                    pixel_vector[position.y()][position.x()] = [r, g, b, a]
                })
                .first_valid_layer()
                .all_attributes()
                // .from_file(path)
                .from_buffered(Cursor::new(response_bytes))
                .map_err(|e| format!("Failed to read EXR file {}: {:?}", file_name, e)).unwrap();

            // println!("exr pixels {:?}", image.layer_data.channel_data.pixels.len());

            // Convert the nested Vec<Vec<[f32; 4]>> to a flat Vec<u8>
            // EXR stores HDR data as floats, so we need to convert to 8-bit
            let width_exr = image.layer_data.size.0;
            let height_exr = image.layer_data.size.1;

            (image.layer_data.channel_data.pixels
                .into_iter()
                .flat_map(|row| {
                    row.into_iter().flat_map(|[r, g, b, a]| {
                        // Clamp and convert f32 values (0.0-1.0) to u8 (0-255)
                        [
                            (r.clamp(0.0, 1.0) * 255.0) as u8,
                            (g.clamp(0.0, 1.0) * 255.0) as u8,
                            (b.clamp(0.0, 1.0) * 255.0) as u8,
                            (a.clamp(0.0, 1.0) * 255.0) as u8,
                        ]
                    })
                })
                .collect(), width_exr as u32, height_exr as u32)
        }
        _ => return Err(format!("Unsupported texture file format: {}", file_name)),
    };

    Ok((bytes, width, height))
}

pub async fn read_model_wasm(
    projectId: String,
    modelFilename: String,
) -> Result<Vec<u8>, String> {
    let url = format!(
        "http://asset.localhost/midpoint/projects/{}/models/{}",
        projectId, modelFilename
    );

    println!("Attempting to read texture from URL: {:?}", url);

    let response_bytes = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch texture: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to get texture bytes: {}", e))?;

    Ok(response_bytes.to_vec())
}