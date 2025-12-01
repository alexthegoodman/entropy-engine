use gltf::Glb;
use gltf::Gltf;
use meshopt::{self, SimplifyOptions, VertexDataAdapter};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::mem::size_of;
use std::path::Path;

use crate::core::vertex::Vertex;

// Define file header and chunk identifiers
const FILE_MAGIC: u32 = 0x444F4C4D; // "MLOD" in ASCII, reversed for endianness
const HEADER_VERSION: u32 = 1;
const MESH_CHUNK_ID: u32 = 0x4853454D; // "MESH" in ASCII, reversed

#[repr(C, packed)]
struct FileHeader {
    magic: u32,      // Magic number for file identification
    version: u32,    // Version of the file format
    mesh_count: u32, // Total number of meshes
    lod_levels: u32, // Number of LOD levels per mesh
}

#[repr(C, packed)]
struct MeshHeader {
    chunk_id: u32,     // Chunk identifier
    chunk_size: u64,   // Size of the chunk data in bytes
    vertex_count: u32, // Number of vertices
    lod_count: u32,    // Number of LOD levels
}

#[repr(C, packed)]
struct LODHeader {
    lod_level: u32,   // LOD level (0 = highest detail)
    index_count: u32, // Number of indices
    offset: u64,      // Offset into the index buffer
}

#[derive(Clone, Debug)]
pub struct MeshLOD {
    pub lod_level: u32,
    pub indices: Vec<u32>,
    pub index_count: u32,
}

#[derive(Clone, Debug)]
pub struct LoadedMesh {
    pub vertices: Vec<Vertex>,
    pub lods: Vec<MeshLOD>,
}

struct SavedMesh {
    lod_level: u32,
    vertices: Vec<Vertex>,
    indices: Vec<u32>,
    index_count: u32,
}

struct GLBImporter {}

impl GLBImporter {
    pub fn import(bytes: &Vec<u8>, output_path: &str) {
        let glb = Glb::from_slice(&bytes).expect("Couldn't create glb from slice");

        let mut meshes = Vec::new();

        let gltf = Gltf::from_slice(&glb.json).expect("Failed to parse GLTF JSON");

        let buffer_data = match glb.bin {
            Some(bin) => bin,
            None => panic!("No binary data found in GLB file"),
        };

        let uses_textures = gltf.textures().len().gt(&0);

        println!("Import textures count: {:?}", gltf.textures().len());

        if gltf.textures().len() > 0 {
            for texture in gltf.textures() {
                match texture.source().source() {
                    gltf::image::Source::View { view, mime_type: _ } => {
                        let img_data = &buffer_data[view.offset()..view.offset() + view.length()];
                        let img = image::load_from_memory(img_data).unwrap().to_rgba8();
                        let (width, height) = img.dimensions();

                        // TODO: save texture to png file
                    }
                    gltf::image::Source::Uri { uri, mime_type: _ } => {
                        panic!(
                            "External URI image sources are not yet supported in glb files: {}",
                            uri
                        );
                    }
                }
            }
        }

        for mesh in gltf.meshes() {
            for primitive in mesh.primitives() {
                let reader = primitive.reader(|buffer| Some(&buffer_data));

                let positions = reader
                    .read_positions()
                    .expect("Positions not existing in glb");
                let colors = reader
                    .read_colors(0)
                    .map(|v| v.into_rgb_f32().collect())
                    .unwrap_or_else(|| vec![[1.0, 1.0, 1.0]; positions.len()]);
                let normals: Vec<[f32; 3]> = reader
                    .read_normals()
                    .map(|iter| iter.collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0, 1.0]; positions.len()]);
                let tex_coords: Vec<[f32; 2]> = reader
                    .read_tex_coords(0)
                    .map(|v| v.into_f32().collect())
                    .unwrap_or_else(|| vec![[0.0, 0.0]; positions.len()]);

                let vertices: Vec<Vertex> = positions
                    .zip(normals.iter())
                    .zip(tex_coords.iter())
                    .zip(colors.iter())
                    .map(|(((p, n), t), c)| Vertex {
                        position: p,
                        normal: *n,
                        tex_coords: *t,
                        color: [c[0], c[1], c[2], 1.0],
                    })
                    .collect();

                let indices: Vec<u32> = reader
                    .read_indices()
                    .map(|iter| iter.into_u32().collect())
                    .unwrap_or_default();

                println!("Import Model vertices: {:?}", vertices.len());
                println!("Import Model indices: {:?}", indices.len());

                let index_count = indices.len() as u32;

                // Add the original mesh as LOD level 0
                meshes.push(SavedMesh {
                    lod_level: 0,
                    vertices: vertices.clone(),
                    indices: indices.clone(),
                    index_count,
                });

                // Generate additional LOD levels
                Self::generate_lods(&vertices, &indices, &mut meshes);
            }
        }

        // Save meshes to .bin file
        Self::save_to_binary(&meshes, output_path).expect("Couldn't save meshes to binary file");
    }

    fn generate_lods(vertices: &Vec<Vertex>, indices: &Vec<u32>, meshes: &mut Vec<SavedMesh>) {
        // Define LOD reduction factors - each level reduces triangle count by this percentage
        let lod_ratios = [0.5, 0.25, 0.125, 0.0625, 0.03125]; // 50%, 25%, 12.5%, 6.25%, 3.125%

        // Skip if we don't have a valid mesh
        if indices.len() < 3 || vertices.is_empty() {
            return;
        }

        // Prepare vertex data for meshopt
        // We need to get the vertex positions as a byte slice
        let vertex_positions_raw: Vec<u8> = vertices
            .iter()
            .flat_map(|v| {
                let pos = v.position;
                // Convert each position to raw bytes
                let x_bytes = pos[0].to_ne_bytes();
                let y_bytes = pos[1].to_ne_bytes();
                let z_bytes = pos[2].to_ne_bytes();
                // Concatenate all bytes
                [&x_bytes[..], &y_bytes[..], &z_bytes[..]].concat()
            })
            .collect();

        // Create vertex data adapter for meshopt
        let vertex_stride = size_of::<[f32; 3]>();
        let vertex_data_adapter = VertexDataAdapter::new(
            &vertex_positions_raw,
            vertex_stride,
            0, // Offset is 0 since we're passing just the positions
        )
        .unwrap();

        // Create each LOD level
        for (i, ratio) in lod_ratios.iter().enumerate() {
            let lod_level = i as u32 + 1; // LOD levels start from 1 (0 is original)

            // Calculate target triangle count
            let original_triangle_count = indices.len() / 3;
            let target_triangle_count = (original_triangle_count as f32 * ratio) as usize;

            // Skip if target count is too small
            if target_triangle_count < 1 {
                continue;
            }

            // Configure simplification options
            // let options = SimplifyOptions {
            //     lock_border: false, // Don't lock border vertices
            //     aggressive: false,  // Use less aggressive simplification
            // };
            let options = SimplifyOptions::empty();

            // Keep track of the simplification error
            let mut result_error = 0.0;

            // Simplify the mesh
            let simplified_indices = meshopt::simplify(
                &indices,
                &vertex_data_adapter,
                target_triangle_count * 3, // Target index count
                0.01,                      // Target error threshold (adjust as needed)
                options,
                Some(&mut result_error),
            );

            println!(
                "LOD {} - Original indices: {}, Simplified indices: {}, Error: {}",
                lod_level,
                indices.len(),
                simplified_indices.len(),
                result_error
            );

            let index_count = simplified_indices.len() as u32;

            // Store the simplified mesh
            meshes.push(SavedMesh {
                lod_level,
                vertices: vertices.clone(), // Keep the original vertices
                indices: simplified_indices,
                index_count,
            });
        }
    }

    fn save_to_binary(meshes: &Vec<SavedMesh>, output_path: &str) -> Result<(), std::io::Error> {
        // Open file for writing
        let file = File::create(Path::new(output_path))?;
        let mut writer = BufWriter::new(file);

        // If we have no meshes, create an empty file with just a header
        if meshes.is_empty() {
            let header = FileHeader {
                magic: FILE_MAGIC,
                version: HEADER_VERSION,
                mesh_count: 0,
                lod_levels: 0,
            };

            // Write file header
            writer.write_all(unsafe {
                std::slice::from_raw_parts(
                    &header as *const FileHeader as *const u8,
                    std::mem::size_of::<FileHeader>(),
                )
            })?;

            return Ok(());
        }

        // Group meshes by their original mesh (grouping LODs together)
        let mut mesh_groups: Vec<Vec<&SavedMesh>> = Vec::new();

        // Find all unique mesh groups by looking at LOD level 0
        let base_meshes: Vec<&SavedMesh> = meshes.iter().filter(|m| m.lod_level == 0).collect();

        // For each base mesh, find all its LOD levels
        for base_mesh in base_meshes {
            let vertex_count = base_mesh.vertices.len();
            let mut group = Vec::new();

            // Find all LOD levels for this mesh
            for mesh in meshes.iter() {
                if mesh.vertices.len() == vertex_count {
                    group.push(mesh);
                }
            }

            // Sort by LOD level (highest detail first)
            group.sort_by_key(|m| m.lod_level);
            mesh_groups.push(group);
        }

        // Create and write file header
        let header = FileHeader {
            magic: FILE_MAGIC,
            version: HEADER_VERSION,
            mesh_count: mesh_groups.len() as u32,
            lod_levels: if !mesh_groups.is_empty() {
                mesh_groups[0].len() as u32
            } else {
                0
            },
        };

        // Write file header
        writer.write_all(unsafe {
            std::slice::from_raw_parts(
                &header as *const FileHeader as *const u8,
                std::mem::size_of::<FileHeader>(),
            )
        })?;

        // Write each mesh group
        for mesh_group in &mesh_groups {
            if mesh_group.is_empty() {
                continue;
            }

            let base_mesh = &mesh_group[0]; // LOD level 0

            // Create and write mesh header
            let mesh_header = MeshHeader {
                chunk_id: MESH_CHUNK_ID,
                chunk_size: 0, // We'll update this later
                vertex_count: base_mesh.vertices.len() as u32,
                lod_count: mesh_group.len() as u32,
            };

            // Remember position for updating chunk size later
            let mesh_header_pos = writer.stream_position()?;

            // Write mesh header
            writer.write_all(unsafe {
                std::slice::from_raw_parts(
                    &mesh_header as *const MeshHeader as *const u8,
                    std::mem::size_of::<MeshHeader>(),
                )
            })?;

            // Write LOD headers - we'll need to update offsets later
            let lod_headers_start_pos = writer.stream_position()?;
            let mut lod_headers = Vec::new();

            for mesh in mesh_group {
                lod_headers.push(LODHeader {
                    lod_level: mesh.lod_level,
                    index_count: mesh.index_count,
                    offset: 0, // We'll update this later
                });
            }

            // Write placeholder LOD headers
            for lod_header in &lod_headers {
                writer.write_all(unsafe {
                    std::slice::from_raw_parts(
                        lod_header as *const LODHeader as *const u8,
                        std::mem::size_of::<LODHeader>(),
                    )
                })?;
            }

            // Write vertices once (shared across all LODs)
            let vertices_start_pos = writer.stream_position()?;
            for vertex in &base_mesh.vertices {
                // Write position
                writer.write_all(unsafe {
                    std::slice::from_raw_parts(
                        &vertex.position as *const [f32; 3] as *const u8,
                        std::mem::size_of::<[f32; 3]>(),
                    )
                })?;

                // Write normal
                writer.write_all(unsafe {
                    std::slice::from_raw_parts(
                        &vertex.normal as *const [f32; 3] as *const u8,
                        std::mem::size_of::<[f32; 3]>(),
                    )
                })?;

                // Write texture coordinates
                writer.write_all(unsafe {
                    std::slice::from_raw_parts(
                        &vertex.tex_coords as *const [f32; 2] as *const u8,
                        std::mem::size_of::<[f32; 2]>(),
                    )
                })?;

                // Write color
                writer.write_all(unsafe {
                    std::slice::from_raw_parts(
                        &vertex.color as *const [f32; 4] as *const u8,
                        std::mem::size_of::<[f32; 3]>(),
                    )
                })?;
            }

            // Remember current position for indices start
            let indices_start_pos = writer.stream_position()?;

            // Write indices for each LOD level and update offsets
            let mut current_offset = 0;
            for (i, mesh) in mesh_group.iter().enumerate() {
                // Update LOD header with correct offset
                lod_headers[i].offset = current_offset;

                // Write indices
                for index in &mesh.indices {
                    writer.write_all(&index.to_ne_bytes())?;
                }

                current_offset += mesh.indices.len() as u64 * std::mem::size_of::<u32>() as u64;
            }

            // Calculate chunk size
            let chunk_end_pos = writer.stream_position()?;
            let chunk_size =
                chunk_end_pos - mesh_header_pos - std::mem::size_of::<MeshHeader>() as u64;

            // Go back and update mesh header with correct chunk size
            writer.seek(std::io::SeekFrom::Start(mesh_header_pos))?;
            let mut updated_mesh_header = mesh_header;
            updated_mesh_header.chunk_size = chunk_size;

            writer.write_all(unsafe {
                std::slice::from_raw_parts(
                    &updated_mesh_header as *const MeshHeader as *const u8,
                    std::mem::size_of::<MeshHeader>(),
                )
            })?;

            // Go back and update LOD headers with correct offsets
            writer.seek(std::io::SeekFrom::Start(lod_headers_start_pos))?;
            for lod_header in &lod_headers {
                writer.write_all(unsafe {
                    std::slice::from_raw_parts(
                        lod_header as *const LODHeader as *const u8,
                        std::mem::size_of::<LODHeader>(),
                    )
                })?;
            }

            // Return to end of file for next mesh
            writer.seek(std::io::SeekFrom::Start(chunk_end_pos))?;
        }

        writer.flush()?;
        println!("Successfully wrote mesh data to: {}", output_path);

        Ok(())
    }

    pub fn load_from_binary(file_path: &str) -> Result<Vec<LoadedMesh>, std::io::Error> {
        // Open file for reading
        let file = File::open(Path::new(file_path))?;
        let mut reader = BufReader::new(file);

        // Read file header
        let mut header_bytes = [0u8; std::mem::size_of::<FileHeader>()];
        reader.read_exact(&mut header_bytes)?;

        let header =
            unsafe { std::ptr::read_unaligned(header_bytes.as_ptr() as *const FileHeader) };

        let header_magic = header.magic;
        let header_version = header.version;
        let header_mesh_count = header.mesh_count;
        let header_lod_levels = header.lod_levels;

        // Verify magic number
        if header_magic != FILE_MAGIC {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Invalid file format: magic number mismatch: found {:x}, expected {:x}",
                    header_magic, FILE_MAGIC
                ),
            ));
        }

        // Verify version
        if header_version != HEADER_VERSION {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "Unsupported file version: {}, expected {}",
                    header_version, HEADER_VERSION
                ),
            ));
        }

        println!(
            "Loading file with {} meshes, {} LOD levels per mesh",
            header_mesh_count, header_lod_levels
        );

        // Load all meshes
        let mut loaded_meshes = Vec::new();

        for _ in 0..header_mesh_count {
            // Read mesh header
            let mut mesh_header_bytes = [0u8; std::mem::size_of::<MeshHeader>()];
            reader.read_exact(&mut mesh_header_bytes)?;

            let mesh_header = unsafe {
                std::ptr::read_unaligned(mesh_header_bytes.as_ptr() as *const MeshHeader)
            };

            let mesh_header_chunk_id = mesh_header.chunk_id;
            let mesh_header_vertex_count = mesh_header.vertex_count;
            let mesh_header_lod_count = mesh_header.lod_count;

            // Verify chunk ID
            if mesh_header_chunk_id != MESH_CHUNK_ID {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "Invalid mesh chunk ID: {:x}, expected {:x}",
                        mesh_header_chunk_id, MESH_CHUNK_ID
                    ),
                ));
            }

            println!(
                "Loading mesh with {} vertices and {} LOD levels",
                mesh_header_vertex_count, mesh_header_lod_count
            );

            // Read LOD headers
            let mut lod_headers = Vec::new();
            for _ in 0..mesh_header_lod_count {
                let mut lod_header_bytes = [0u8; std::mem::size_of::<LODHeader>()];
                reader.read_exact(&mut lod_header_bytes)?;

                let lod_header = unsafe {
                    std::ptr::read_unaligned(lod_header_bytes.as_ptr() as *const LODHeader)
                };

                lod_headers.push(lod_header);
            }

            // Read vertex data
            let mut vertices = Vec::new();
            for _ in 0..mesh_header_vertex_count {
                let mut position = [0f32; 3];
                let mut normal = [0f32; 3];
                let mut tex_coords = [0f32; 2];
                let mut color = [0f32; 4];

                // Read position
                let mut position_bytes = [0u8; std::mem::size_of::<[f32; 3]>()];
                reader.read_exact(&mut position_bytes)?;
                position =
                    unsafe { std::ptr::read_unaligned(position_bytes.as_ptr() as *const [f32; 3]) };

                // Read normal
                let mut normal_bytes = [0u8; std::mem::size_of::<[f32; 3]>()];
                reader.read_exact(&mut normal_bytes)?;
                normal =
                    unsafe { std::ptr::read_unaligned(normal_bytes.as_ptr() as *const [f32; 3]) };

                // Read texture coordinates
                let mut tex_coords_bytes = [0u8; std::mem::size_of::<[f32; 2]>()];
                reader.read_exact(&mut tex_coords_bytes)?;
                tex_coords = unsafe {
                    std::ptr::read_unaligned(tex_coords_bytes.as_ptr() as *const [f32; 2])
                };

                // Read color
                let mut color_bytes = [0u8; std::mem::size_of::<[f32; 4]>()];
                reader.read_exact(&mut color_bytes)?;
                color =
                    unsafe { std::ptr::read_unaligned(color_bytes.as_ptr() as *const [f32; 4]) };

                vertices.push(Vertex {
                    position,
                    normal,
                    tex_coords,
                    color,
                });
            }

            // Remember indices start for seeking
            let indices_start_pos = reader.stream_position()?;

            // Read indices for each LOD level
            let mut lods = Vec::new();
            for lod_header in &lod_headers {
                // Seek to correct position in index buffer
                reader.seek(SeekFrom::Start(indices_start_pos + lod_header.offset))?;

                // Read indices
                let mut indices = Vec::new();
                for _ in 0..lod_header.index_count {
                    let mut index_bytes = [0u8; std::mem::size_of::<u32>()];
                    reader.read_exact(&mut index_bytes)?;
                    let index = u32::from_ne_bytes(index_bytes);
                    indices.push(index);
                }

                lods.push(MeshLOD {
                    lod_level: lod_header.lod_level,
                    indices,
                    index_count: lod_header.index_count,
                });
            }

            // Sort LODs by level (just to be safe)
            lods.sort_by_key(|lod| lod.lod_level);

            // Add loaded mesh
            loaded_meshes.push(LoadedMesh { vertices, lods });

            // Seek to end of this mesh chunk to prepare for next mesh
            let mesh_end_pos = indices_start_pos
                + lod_headers
                    .last()
                    .map(|h| h.offset + h.index_count as u64 * 4)
                    .unwrap_or(0);
            reader.seek(SeekFrom::Start(mesh_end_pos))?;
        }

        println!(
            "Successfully loaded {} meshes from: {}",
            loaded_meshes.len(),
            file_path
        );

        Ok(loaded_meshes)
    }

    // // Helper function to get specific LOD level from a loaded mesh
    // pub fn get_lod(mesh: &LoadedMesh, desired_lod: u32) -> Option<&MeshLOD> {
    //     mesh.lods.iter().find(|lod| lod.lod_level == desired_lod)
    // }

    // // Helper function to get the best LOD level for a given distance
    // pub fn get_lod_for_distance(mesh: &LoadedMesh, distance: f32, base_distance: f32) -> &MeshLOD {
    //     // Calculate which LOD to use based on distance
    //     // The formula is: LOD level = floor(log2(distance / base_distance))
    //     // where base_distance is the distance at which LOD 0 is used

    //     if distance <= base_distance {
    //         // Use highest detail LOD (level 0)
    //         return Self::get_lod(mesh, 0).unwrap_or(&mesh.lods[0]);
    //     }

    //     let ratio = distance / base_distance;
    //     let ideal_lod = (ratio.log2()).floor() as u32;

    //     // Find the closest available LOD level that doesn't exceed our calculated level
    //     let mut available_lods: Vec<&MeshLOD> = mesh.lods.iter().collect();
    //     available_lods.sort_by_key(|lod| lod.lod_level);

    //     // Find the best LOD that doesn't exceed our ideal LOD
    //     for lod in available_lods.iter().rev() {
    //         if lod.lod_level <= ideal_lod {
    //             return lod;
    //         }
    //     }

    //     // If we can't find a suitable LOD, return the lowest detail one
    //     available_lods.last().unwrap()
    // }
}

// Example usage function
// pub fn example_usage() -> Result<(), std::io::Error> {
//     // Import GLB and save to binary
//     let bytes = std::fs::read("your_model.glb").expect("Failed to read GLB file");
//     GLBImporter::import(&bytes, "output_model.bin")?;

//     // Later, load the model from binary file
//     let loaded_meshes = GLBImporter::load_from_binary("output_model.bin")?;

//     // Access a specific mesh and its LODs
//     if !loaded_meshes.is_empty() {
//         let mesh = &loaded_meshes[0];

//         // Get highest detail LOD (level 0)
//         let highest_lod = GLBImporter::get_lod(mesh, 0).unwrap();
//         println!("Highest LOD has {} indices", highest_lod.index_count);

//         // Get LOD for a specific distance (e.g., 100 units away, with base distance of 10)
//         let distance_lod = GLBImporter::get_lod_for_distance(mesh, 100.0, 10.0);
//         println!("At distance 100, using LOD level {} with {} indices",
//                  distance_lod.lod_level, distance_lod.index_count);
//     }

//     Ok(())
// }
