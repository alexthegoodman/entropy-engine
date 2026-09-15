// Minimal glTF 2.0 / GLB binary writer for addon-authored, already-world-space-baked meshes
// (Canvas Surfaces' own surfaces: flat vertex/index/texture data, unlit textured materials, no
// skinning/animation/node hierarchy). The `gltf` crate (already a Cargo dependency, used for
// import) has no writer at all, so this hand-assembles the two-chunk GLB container directly
// per the spec: a JSON chunk (scene graph/accessors/bufferViews/materials, built with
// serde_json) and one BIN chunk holding every mesh's vertex/index data plus each surface's own
// PNG-encoded texture back-to-back - glTF images must be a real image codec, not raw RGBA, so
// each surface's canvas is PNG-encoded here via the `image` crate (already a dependency) before
// being embedded.
//
// Deliberately minimal: one scene, one node per mesh (no transform - every position is already
// world-space, matching how canvas_surface_addon.ts already treats vertex data everywhere
// else), one unlit material per mesh (KHR_materials_unlit - the addon's own CanvasSurface
// shader is unlit too, so this is the faithful export, not a simplification of something PBR).

use serde_json::json;

pub struct GlbMeshExport {
    pub name: String,
    pub positions: Vec<f32>, // flat x,y,z - world-space, already baked (see module doc comment)
    pub normals: Vec<f32>,   // flat x,y,z
    pub uvs: Vec<f32>,       // flat u,v
    pub indices: Vec<u32>,
    pub texture_rgba: Vec<u8>,
    pub texture_width: u32,
    pub texture_height: u32,
}

const GLTF_MAGIC: u32 = 0x46546C67; // "glTF"
const CHUNK_TYPE_JSON: u32 = 0x4E4F534A; // "JSON"
const CHUNK_TYPE_BIN: u32 = 0x004E4942; // "BIN\0"

/// Appends `data` to `buf`, then pads `buf` out to the next 4-byte boundary with zeros (glTF's
/// own alignment requirement for bufferViews). Returns the (byteOffset, byteLength) of the
/// UNPADDED data - the padding added after it belongs to whatever comes next, not this view.
fn push_aligned(buf: &mut Vec<u8>, data: &[u8]) -> (usize, usize) {
    let offset = buf.len();
    buf.extend_from_slice(data);
    let len = data.len();
    while buf.len() % 4 != 0 {
        buf.push(0);
    }
    (offset, len)
}

fn f32_min_max(values: &[f32], components: usize) -> (Vec<f32>, Vec<f32>) {
    let mut min = vec![f32::INFINITY; components];
    let mut max = vec![f32::NEG_INFINITY; components];
    for chunk in values.chunks(components) {
        for (i, v) in chunk.iter().enumerate() {
            if *v < min[i] { min[i] = *v; }
            if *v > max[i] { max[i] = *v; }
        }
    }
    (min, max)
}

/// Builds a complete, self-contained .glb file (JSON + BIN chunks, textures embedded, no
/// external references) from a flat list of already-world-space meshes.
pub fn build_glb(meshes: &[GlbMeshExport]) -> Result<Vec<u8>, String> {
    if meshes.is_empty() {
        return Err("no meshes to export".to_string());
    }

    let mut bin: Vec<u8> = Vec::new();
    let mut buffer_views = Vec::new();
    let mut accessors = Vec::new();
    let mut images = Vec::new();
    let mut samplers = Vec::new();
    let mut textures = Vec::new();
    let mut materials = Vec::new();
    let mut gltf_meshes = Vec::new();
    let mut nodes = Vec::new();
    let mut node_indices = Vec::new();

    samplers.push(json!({ "magFilter": 9729, "minFilter": 9729, "wrapS": 10497, "wrapT": 10497 }));

    for m in meshes {
        // POSITION
        let pos_bytes: &[u8] = bytemuck::cast_slice(&m.positions);
        let (pos_offset, pos_len) = push_aligned(&mut bin, pos_bytes);
        let pos_bv = buffer_views.len();
        buffer_views.push(json!({ "buffer": 0, "byteOffset": pos_offset, "byteLength": pos_len, "target": 34962 }));
        let (pos_min, pos_max) = f32_min_max(&m.positions, 3);
        let pos_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": pos_bv, "byteOffset": 0, "componentType": 5126, "count": m.positions.len() / 3,
            "type": "VEC3", "min": pos_min, "max": pos_max
        }));

        // NORMAL
        let normal_bytes: &[u8] = bytemuck::cast_slice(&m.normals);
        let (n_offset, n_len) = push_aligned(&mut bin, normal_bytes);
        let n_bv = buffer_views.len();
        buffer_views.push(json!({ "buffer": 0, "byteOffset": n_offset, "byteLength": n_len, "target": 34962 }));
        let normal_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": n_bv, "byteOffset": 0, "componentType": 5126, "count": m.normals.len() / 3, "type": "VEC3"
        }));

        // TEXCOORD_0
        let uv_bytes: &[u8] = bytemuck::cast_slice(&m.uvs);
        let (uv_offset, uv_len) = push_aligned(&mut bin, uv_bytes);
        let uv_bv = buffer_views.len();
        buffer_views.push(json!({ "buffer": 0, "byteOffset": uv_offset, "byteLength": uv_len, "target": 34962 }));
        let uv_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": uv_bv, "byteOffset": 0, "componentType": 5126, "count": m.uvs.len() / 2, "type": "VEC2"
        }));

        // Indices
        let index_bytes: &[u8] = bytemuck::cast_slice(&m.indices);
        let (idx_offset, idx_len) = push_aligned(&mut bin, index_bytes);
        let idx_bv = buffer_views.len();
        buffer_views.push(json!({ "buffer": 0, "byteOffset": idx_offset, "byteLength": idx_len, "target": 34963 }));
        let idx_accessor = accessors.len();
        accessors.push(json!({
            "bufferView": idx_bv, "byteOffset": 0, "componentType": 5125, "count": m.indices.len(), "type": "SCALAR"
        }));

        // Texture - glTF images must be a real codec (PNG/JPEG), not raw RGBA, so encode here.
        let img = image::RgbaImage::from_raw(m.texture_width, m.texture_height, m.texture_rgba.clone())
            .ok_or_else(|| format!("bad texture dimensions for mesh '{}'", m.name))?;
        let mut png_bytes: Vec<u8> = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
            .map_err(|e| format!("PNG encode failed for mesh '{}': {e}", m.name))?;
        let (img_offset, img_len) = push_aligned(&mut bin, &png_bytes);
        let img_bv = buffer_views.len();
        buffer_views.push(json!({ "buffer": 0, "byteOffset": img_offset, "byteLength": img_len }));
        let image_index = images.len();
        images.push(json!({ "bufferView": img_bv, "mimeType": "image/png" }));
        let texture_index = textures.len();
        textures.push(json!({ "sampler": 0, "source": image_index }));

        let material_index = materials.len();
        materials.push(json!({
            "name": format!("{}_material", m.name),
            "pbrMetallicRoughness": { "baseColorTexture": { "index": texture_index } },
            // The addon's own CanvasSurface pipeline is unlit (samples the painted texture
            // directly, no lighting math) - KHR_materials_unlit is the faithful export of that,
            // not a fallback for missing PBR data.
            "extensions": { "KHR_materials_unlit": {} }
        }));

        let mesh_index = gltf_meshes.len();
        gltf_meshes.push(json!({
            "name": m.name,
            "primitives": [{
                "attributes": { "POSITION": pos_accessor, "NORMAL": normal_accessor, "TEXCOORD_0": uv_accessor },
                "indices": idx_accessor,
                "material": material_index
            }]
        }));

        let node_index = nodes.len();
        nodes.push(json!({ "name": m.name, "mesh": mesh_index }));
        node_indices.push(node_index);
    }

    let total_bin_len = bin.len();
    let doc = json!({
        "asset": { "version": "2.0", "generator": "Entropy Canvas Surfaces" },
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{ "nodes": node_indices }],
        "nodes": nodes,
        "meshes": gltf_meshes,
        "materials": materials,
        "textures": textures,
        "images": images,
        "samplers": samplers,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{ "byteLength": total_bin_len }]
    });

    let mut json_bytes = serde_json::to_vec(&doc).map_err(|e| format!("glTF JSON serialize failed: {e}"))?;
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(0x20); // glTF pads the JSON chunk with spaces, not zeros
    }
    while bin.len() % 4 != 0 {
        bin.push(0);
    }

    let total_len = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out = Vec::with_capacity(total_len);
    out.extend_from_slice(&GLTF_MAGIC.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes()); // glTF version
    out.extend_from_slice(&(total_len as u32).to_le_bytes());

    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_TYPE_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);

    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_TYPE_BIN.to_le_bytes());
    out.extend_from_slice(&bin);

    Ok(out)
}
