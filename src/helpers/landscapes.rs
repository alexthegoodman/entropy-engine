use std::{fs::File, path::PathBuf};

use exr::prelude::read_first_rgba_layer_from_file;
use image::GenericImageView;
use serde::Serialize;
use tiff::decoder::{Decoder, DecodingResult};
use nalgebra as na;

use crate::helpers::saved_data::LandscapeTextureKinds;

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

// pub fn read_landscape_heightmap_as_texture(
//     // state: tauri::State<'_, AppState>,
//     projectId: String,
//     landscapeId: String,
//     textureFilename: String,
//     // textureKind: String,
// ) -> Result<TextureData, String> {
//     // let handle = &state.handle;
//     // let config = handle.config();
//     // let package_info = handle.package_info();
//     // let env = handle.env();

//     let sync_dir = get_common_os_dir().expect("Couldn't get CommonOS directory");
//     let texture_path = sync_dir.join(format!(
//         "midpoint/projects/{}/landscapes/{}/heightmaps/{}",
//         projectId, landscapeId, textureFilename // NOTE: this is a .tif file
//     ));

//     println!("texture path {:?}", texture_path,);

//     // Read the image file
//     let img = image::open(&texture_path)
//         .map_err(|e| format!("Failed to open landscape texture: {}", e))?;

//     // Get dimensions
//     let (width, height) = img.dimensions();

//     println!("heightfield image color {:?}", img.color());

//     let luma16 = img.to_luma16();

//     // Check min/max values in the heightmap
//     let mut min_val = u16::MAX;
//     let mut max_val = u16::MIN;
//     for pixel in luma16.pixels() {
//         let val = pixel[0];
//         min_val = min_val.min(val);
//         max_val = max_val.max(val);
//     }

//     println!("Heightmap range: {} to {} (should be 0-65535)", min_val, max_val);

//     // Now convert...
//     let rgba_img = img.to_rgba8();
//     let bytes = rgba_img.into_raw();

//     // Check converted values too
//     println!("First RGBA pixel: R={}, G={}, B={}, A={}", 
//         bytes[0], bytes[1], bytes[2], bytes[3]);

//     // Convert to RGBA
//     let rgba_img = img.to_rgba8();
//     let bytes = rgba_img.into_raw();

//     Ok(TextureData {
//         bytes,
//         width,
//         height,
//     })
// }

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

use image::{open, ImageBuffer, Luma};
use rayon::prelude::*;
use std::path::Path;

use rayon::prelude::*;
/// Upscales a TIFF heightmap by a given multiplier and subdivides it into tiles
///
/// # Arguments
/// * `input_path` - Path to the input TIFF file
/// * `output_dir` - Directory where the subdivided tiles will be saved
/// * `multiplier` - Factor by which to upscale (e.g., 100 will upscale by 100x then also create 100 images, each equal in size to the original image)
/// * `smoothing_factor` - 0.0 to 1.0, where 0.0 is no smoothing and 1.0 is maximum smoothing
///
/// # Returns
/// Result with the number of tiles created
use tiff::encoder::*;

pub fn upscale_tiff_heightmap(
    input_path: &Path,
    output_dir: &Path,
    multiplier: u32,
    tiles_per_side: u32,
    smoothing_factor: f32,
) -> Result<usize, Box<dyn std::error::Error>> {
    println!(
        "Upscaling {:?} {:?} {:?} {:?}",
        input_path, output_dir, multiplier, smoothing_factor
    );

    // Open and decode input TIFF
    let mut decoder = Decoder::new(File::open(input_path)?)?;

    // Get image dimensions
    let width = decoder.dimensions()?.0;
    let height = decoder.dimensions()?.1;

    // Read the image data
    let image_data = match decoder.read_image()? {
        DecodingResult::F32(data) => data,
        _ => return Err("Unsupported TIFF format - expected F32".into()),
    };

    // Calculate dimensions
    let upscaled_width = width * multiplier;
    let upscaled_height = height * multiplier;
    let tile_width = upscaled_width / tiles_per_side; // still divide by multipler, not the square root
    let tile_height = upscaled_height / tiles_per_side;

    println!(
        "read data... {:?}x{:?} and {:?}x{:?}",
        upscaled_width, upscaled_height, tile_width, tile_height
    );

    // Create output directory if it doesn't exist
    std::fs::create_dir_all(output_dir)?;

    // Let's try both methods and compare
    let mut upscaled_nearest = vec![0.0f32; (upscaled_width * upscaled_height) as usize];
    let mut upscaled_bilinear = vec![0.0f32; (upscaled_width * upscaled_height) as usize];

    // let mut last_value = image_data[0]; // Initialize with first value
    // let mut value_changes = 0;

    // Upscale using both methods
    for y in 0..upscaled_height {
        for x in 0..upscaled_width {
            // Calculate source coordinates
            let src_x = (x as f32 / multiplier as f32).floor();
            let src_y = (y as f32 / multiplier as f32).floor();

            // Nearest Neighbor
            let nearest_x = src_x.clamp(0.0, (width - 1) as f32) as u32;
            let nearest_y = src_y.clamp(0.0, (height - 1) as f32) as u32;
            let nearest_value = image_data[(nearest_y * width + nearest_x) as usize];
            upscaled_nearest[(y * upscaled_width + x) as usize] = nearest_value;

            // // Log when value changes significantly (using a small epsilon to avoid float comparison issues)
            // const EPSILON: f32 = 0.0001;
            // if (nearest_value - last_value).abs() > EPSILON {
            //     println!(
            //         "Value changed at ({}, {}): {} -> {} (src: {}, {})",
            //         x, y, last_value, nearest_value, src_x, src_y
            //     );
            //     last_value = nearest_value;
            //     value_changes += 1;
            // }

            // Bilinear (modified to print debug info for first few pixels)
            let x_fract = (x as f32 / multiplier as f32) - src_x;
            let y_fract = (y as f32 / multiplier as f32) - src_y;

            let x1 = src_x.clamp(0.0, (width - 1) as f32) as u32;
            let y1 = src_y.clamp(0.0, (height - 1) as f32) as u32;
            let x2 = (x1 + 1).min(width - 1);
            let y2 = (y1 + 1).min(height - 1);

            let p11 = image_data[(y1 * width + x1) as usize];
            let p12 = image_data[(y2 * width + x1) as usize];
            let p21 = image_data[(y1 * width + x2) as usize];
            let p22 = image_data[(y2 * width + x2) as usize];

            // // Debug print for first few pixels to compare methods
            // if x < 5 && y < 5 {
            //     println!("Pixel ({}, {})", x, y);
            //     println!("  Nearest: {}", nearest_value);
            //     println!(
            //         "  Bilinear inputs: p11={}, p12={}, p21={}, p22={}",
            //         p11, p12, p21, p22
            //     );
            //     println!("  Fractions: x={}, y={}", x_fract, y_fract);
            // }

            let bilinear_value = bilinear_interpolate(p11, p12, p21, p22, x_fract, y_fract);
            upscaled_bilinear[(y * upscaled_width + x) as usize] = bilinear_value;
        }
    }

    // Print ranges for both methods
    let (nearest_min, nearest_max) = upscaled_nearest
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), &value| {
            (min.min(value), max.max(value))
        });
    println!("Nearest neighbor range: {} to {}", nearest_min, nearest_max);

    let (bilinear_min, bilinear_max) = upscaled_bilinear
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), &value| {
            (min.min(value), max.max(value))
        });
    println!("Bilinear range: {} to {}", bilinear_min, bilinear_max);

    // After upscaling, verify the data size
    assert_eq!(
        upscaled_nearest.len(),
        (upscaled_width * upscaled_height) as usize,
        "Upscaled data size mismatch"
    );

    println!("upscaled... {:?}", upscaled_nearest.len());

    // Apply smoothing if requested
    if smoothing_factor > 0.0 {
        apply_smoothing(
            &mut upscaled_nearest,
            upscaled_width,
            upscaled_height,
            smoothing_factor,
        );
    }

    println!("smoothed...");

    // DEBUG verify upscale
    // let tile_path = output_dir.join("test_tile.tiff");
    // let mut file = File::create(&tile_path).expect("Failed to create test tile file");

    // let mut tiff = TiffEncoder::new(&mut file).unwrap();
    // tiff.write_image::<colortype::Gray32Float>(upscaled_width, upscaled_height, &upscaled_nearest)
    //     .unwrap_or_else(|e| {
    //         panic!(
    //             "Failed to write test tile {}_{}: {}",
    //             upscaled_width, upscaled_height, e
    //         )
    //     });

    // Subdivide and save tiles
    let tiles: Vec<(usize, usize)> = (0..tiles_per_side as usize)
        .flat_map(|y| (0..tiles_per_side as usize).map(move |x| (x, y)))
        .collect();

    tiles.par_iter().for_each(|&(tile_x, tile_y)| {
        // Create buffer of correct size: 4096x4096
        let mut tile_data = vec![0.0f32; (tile_width * tile_height) as usize];

        let start_x = tile_x as u32 * tile_width;
        let start_y = tile_y as u32 * tile_height;

        println!(
            "Processing tile {}_{}: starts at ({}, {}), dimensions {}x{}",
            tile_x, tile_y, start_x, start_y, tile_width, tile_height
        );

        // Now we'll sample the full 4096x4096 region
        for y in 0..tile_height {
            for x in 0..tile_width {
                let src_x = start_x + x;
                let src_y = start_y + y;
                let src_idx = src_y * upscaled_width + src_x;
                let dst_idx = y * tile_width + x;
                tile_data[dst_idx as usize] = upscaled_nearest[src_idx as usize];
            }
        }

        // Save the full-sized tile...
        let tile_path = output_dir.join(format!("tile_{}_{}.tiff", tile_x, tile_y));
        let mut file = File::create(&tile_path).expect("Failed to create tile file");

        let mut tiff = TiffEncoder::new(&mut file).unwrap();
        tiff.write_image::<colortype::Gray32Float>(tile_width, tile_height, &tile_data)
            .unwrap_or_else(|e| panic!("Failed to write tile {}_{}: {}", tile_x, tile_y, e));
    });

    println!("upscale finsihed!");

    Ok(tiles.len())
}

fn bilinear_interpolate(p11: f32, p12: f32, p21: f32, p22: f32, x: f32, y: f32) -> f32 {
    let p1 = p11 * (1.0 - x) + p21 * x;
    let p2 = p12 * (1.0 - x) + p22 * x;
    p1 * (1.0 - y) + p2 * y
}

fn apply_smoothing(image: &mut Vec<f32>, width: u32, height: u32, factor: f32) {
    let mut smoothed = image.clone();
    let kernel_size = 3;
    let half_kernel = kernel_size / 2;

    for y in half_kernel..height - half_kernel {
        for x in half_kernel..width - half_kernel {
            let mut sum = 0.0;
            let mut count = 0.0;

            for ky in 0..kernel_size {
                for kx in 0..kernel_size {
                    let px = x + kx - half_kernel;
                    let py = y + ky - half_kernel;

                    let weight = 1.0
                        / (1.0
                            + ((kx as f32 - half_kernel as f32).powi(2)
                                + (ky as f32 - half_kernel as f32).powi(2)));

                    let idx = (py * width + px) as usize;
                    sum += image[idx] * weight;
                    count += weight;
                }
            }

            let idx = (y * width + x) as usize;
            let original = image[idx];
            let smoothed_value = sum / count;
            smoothed[idx] = original * (1.0 - factor) + smoothed_value * factor;
        }
    }

    *image = smoothed;
}

pub fn read_texture_bytes(
    project_id: String,
    asset_id: String, // This could be landscapeId or pbr_texture_id
    file_name: String,
) -> Result<Vec<u8>, String> {
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

    let bytes = match extension {
        "png" | "jpg" | "jpeg" => {
            image::open(&file_path)
                .map_err(|e| format!("Failed to open image file {}: {}", file_name, e))?
                .to_rgba8()
                .into_raw()
        }
        "tif" | "tiff" => {
            let file = File::open(&file_path)
                .map_err(|e| format!("Failed to open TIFF file {}: {}", file_name, e))?;
            let mut decoder = Decoder::new(file)
                .map_err(|e| format!("Failed to decode TIFF file {}: {}", file_name, e))?;
            let (width, height) = decoder.dimensions().map_err(|e| format!("Failed to get TIFF dimensions {}: {}", file_name, e))?;

            match decoder.read_image().map_err(|e| format!("Failed to read TIFF image data {}: {}", file_name, e))? {
                DecodingResult::U8(data) => data,
                DecodingResult::U16(data) => {
                    // Convert U16 to U8, perhaps by taking the most significant byte or scaling
                    data.into_iter().map(|v| (v / 256) as u8).collect()
                },
                DecodingResult::F32(data) => {
                    // Convert F32 to U8 by scaling 0-1 range to 0-255
                    data.into_iter().map(|v| (v * 255.0) as u8).collect()
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
            .map_err(|e| format!("Failed to read EXR file {}: {:?}", file_name, e))?;

            // Convert the nested Vec<Vec<[f32; 4]>> to a flat Vec<u8>
            // EXR stores HDR data as floats, so we need to convert to 8-bit
            image.layer_data.channel_data.pixels
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
                .collect()
        }
        _ => return Err(format!("Unsupported texture file format: {}", file_name)),
    };

    Ok(bytes)
}
