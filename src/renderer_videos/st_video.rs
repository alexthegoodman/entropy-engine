use std::path::Path;
use std::time::Duration;

use nalgebra::{Matrix4, Vector3};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;
use wgpu::util::DeviceExt;
use wgpu::{Device, Queue};
use windows::Win32::Media::KernelStreaming::GUID_NULL;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::StructuredStorage::PropVariantToInt64;
use windows_core::{PCWSTR, PROPVARIANT};

use crate::core::SimpleCamera::SimpleCamera as Camera;
use crate::core::Transform_2::{Transform, matrix4_to_raw_array};
use crate::screen_capture::capture::{MousePosition, SourceData};
use crate::core::editor::{Point, WindowSize};
use crate::shape_primitives::polygon::SavedPoint;
use crate::core::transform::{create_empty_group_transform};
use crate::core::vertex::Vertex;
use crate::{
    core::editor::{CANVAS_HORIZ_OFFSET, CANVAS_VERT_OFFSET},
};

#[derive(Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Debug)]
pub struct SavedStVideoConfig {
    pub id: String,
    pub name: String,
    pub dimensions: (u32, u32),
    pub path: String,
    pub position: SavedPoint,
    pub layer: i32,
    pub mouse_path: Option<String>,
}

#[derive(Clone)]
pub struct StVideoConfig {
    pub id: String,
    pub name: String,
    pub dimensions: (u32, u32), // overrides actual image size
    pub position: Point,
    pub path: String,
    pub layer: i32,
    pub mouse_path: Option<String>,
}

pub struct StVideo {
    pub id: String,
    pub current_sequence_id: Uuid,
    pub name: String,
    pub path: String,
    pub source_duration: i64,
    pub source_duration_ms: i64,
    pub source_dimensions: (u32, u32),
    pub source_frame_rate: f64,
    pub texture: wgpu::Texture,
    pub texture_view: wgpu::TextureView,
    pub transform: Transform,
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub dimensions: (u32, u32),
    pub bind_group: wgpu::BindGroup,
    // pub vertices: [Vertex; 4],
    // pub indices: [u32; 6],
    pub vertices: Vec<Vertex>,
    pub indices: Vec<u32>,
    pub hidden: bool,
    pub layer: i32,
    pub group_bind_group: wgpu::BindGroup,
    pub current_zoom: f32,
    pub mouse_path: Option<String>,
    pub mouse_positions: Option<Vec<MousePosition>>,
    pub last_center_point: Option<Point>,
    pub last_start_point: Option<MousePosition>,
    pub last_end_point: Option<MousePosition>,
    pub last_shift_time: Option<u128>,
    pub source_data: Option<SourceData>,
    pub grid_resolution: (u32, u32),
    pub frame_timer: Option<FrameTimer>,
    pub dynamic_alpha: f32,
    pub num_frames_drawn: u32,
    pub original_dimensions: (u32, u32),
    #[cfg(target_os = "windows")]
    pub source_reader: IMFSourceReader,
    // #[cfg(target_arch = "wasm32")]
    // pub source_reader: WebCodecs
}

impl StVideo {
    pub fn new(
        device: &Device,
        queue: &Queue,
        path: &Path,
        video_config: StVideoConfig,
        window_size: &WindowSize,
        bind_group_layout: &wgpu::BindGroupLayout,
        group_bind_group_layout: &Arc<wgpu::BindGroupLayout>,
        z_index: f32,
        new_id: String,
        current_sequence_id: Uuid,
    ) -> Result<Self, windows::core::Error> {
        let (source_reader, duration, duration_ms, source_width, source_height, source_frame_rate) =
            Self::initialize_media_source(path)?;

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Video Texture"),
            size: wgpu::Extent3d {
                // TODO: should be source video dimensions
                width: source_width,
                height: source_height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            // format: wgpu::TextureFormat::NV12,
            // use rgb for now
            // format: wgpu::TextureFormat::Rgba8Unorm,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            // view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb], // backwards
            // view_formats: &[wgpu::TextureFormat::Rgba8UnormSrgb], // washed out
            view_formats: &[wgpu::TextureFormat::Rgba8Unorm],
        });
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Create sampler with appropriate filtering
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        let empty_buffer = Matrix4::<f32>::identity();
        let raw_matrix = matrix4_to_raw_array(&empty_buffer);

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Video Uniform Buffer"),
            contents: bytemuck::cast_slice(&raw_matrix),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Rest of the bind group creation...
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
            label: Some("Image Bind Group"),
        });

        let mut transform = Transform::new(
            Vector3::new(video_config.position.x, video_config.position.y, 0.0),
            Vector3::new(0.0, 0.0, 0.0),
            Vector3::new(
                video_config.dimensions.0 as f32,
                video_config.dimensions.1 as f32,
                1.0
            ), // Apply scaling here instead of resizing image
            uniform_buffer,
        );

        // -10.0 to provide 10 spots for internal items on top of objects
        // transform.layer = video_config.layer as f32 - 0 as f32;
        transform.update_uniform_buffer(&queue);

        // let vertices = [
        //     Vertex {
        //         position: [-0.5, -0.5, 0.0],
        //         // tex_coords: [0.0, 1.0],
        //         tex_coords: [0.0, 0.0],
        //         color: [1.0, 1.0, 1.0, 1.0],
        //     },
        //     Vertex {
        //         position: [0.5, -0.5, 0.0],
        //         // tex_coords: [1.0, 1.0],
        //         tex_coords: [1.0, 0.0],
        //         color: [1.0, 1.0, 1.0, 1.0],
        //     },
        //     Vertex {
        //         position: [0.5, 0.5, 0.0],
        //         // tex_coords: [1.0, 0.0],
        //         tex_coords: [1.0, 1.0],
        //         color: [1.0, 1.0, 1.0, 1.0],
        //     },
        //     Vertex {
        //         position: [-0.5, 0.5, 0.0],
        //         // tex_coords: [0.0, 0.0],
        //         tex_coords: [0.0, 1.0],
        //         color: [1.0, 1.0, 1.0, 1.0],
        //     },
        // ];

        // self.grid_resolution = grid_resolution;
        let grid_resolution = (20, 20);
        let (rows, cols) = grid_resolution;

        // Create vertices
        let mut vertices = Vec::with_capacity(((rows + 1) * (cols + 1)) as usize);

        for y in 0..=rows {
            for x in 0..=cols {
                // let pos_x = -1.0 + (2.0 * x as f32 / cols as f32);
                // let pos_y = -1.0 + (2.0 * y as f32 / rows as f32);

                // Scale from -0.5 to 0.5 across the entire grid
                let pos_x = -0.5 + (x as f32 / cols as f32);
                let pos_y = -0.5 + (y as f32 / rows as f32);

                let tex_x = x as f32 / cols as f32;
                let tex_y = y as f32 / rows as f32;

                vertices.push(Vertex {
                    position: [pos_x, pos_y, 0.0],
                    normal: [0.0, 0.0, 0.0],
                    tex_coords: [tex_x, tex_y],
                    color: [1.0, 1.0, 1.0, 1.0],
                });
            }
        }

        // Create indices for triangle strips
        let mut indices = Vec::with_capacity((rows * cols * 6) as usize);
        for y in 0..rows {
            for x in 0..cols {
                let top_left = y * (cols + 1) + x;
                let top_right = top_left + 1;
                let bottom_left = (y + 1) * (cols + 1) + x;
                let bottom_right = bottom_left + 1;

                indices.push(bottom_right);
                indices.push(bottom_left);
                indices.push(top_right);

                indices.push(top_right);
                indices.push(bottom_left);
                indices.push(top_left);
            }
        }

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        });

        // let indices: [u32; 6] = [0, 1, 2, 0, 2, 3];
        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let (tmp_group_bind_group, tmp_group_transform) =
            create_empty_group_transform(device, group_bind_group_layout, window_size);

        println!(
            "Adding video id: {:?} duration_ms: {:?} frame rate: {:?}",
            new_id, duration_ms, source_frame_rate
        );

        Ok(Self {
            id: new_id,
            current_sequence_id,
            name: video_config.name,
            path: path
                .to_str()
                .expect("Couldn't convert to string")
                .to_string(),
            source_duration: duration,
            source_duration_ms: duration_ms,
            source_dimensions: (source_width, source_height),
            source_frame_rate,
            texture,
            texture_view,
            transform,
            vertex_buffer,
            index_buffer,
            dimensions: video_config.dimensions,
            bind_group,
            vertices,
            indices,
            hidden: false,
            layer: video_config.layer - 0,
            source_reader,
            group_bind_group: tmp_group_bind_group,
            current_zoom: 1.0,
            mouse_path: video_config.mouse_path,
            mouse_positions: None,
            last_center_point: None,
            source_data: None,
            last_shift_time: None,
            last_start_point: None,
            last_end_point: None,
            grid_resolution,
            frame_timer: None,
            dynamic_alpha: 0.01,
            num_frames_drawn: 0,
            original_dimensions: video_config.dimensions
        })
    }

    #[cfg(target_os = "windows")]
    fn initialize_media_source(
        path: &Path,
    ) -> Result<(IMFSourceReader, i64, i64, u32, u32, f64), windows::core::Error> {
        // Intialize Media Foundation
        unsafe {
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        }

        let source_reader =
            StVideo::create_source_reader(&path.to_str().expect("Couldn't get path string"))
                .expect("Couldn't create source reader");

        // Get source duration
        let mut duration = 0;
        let mut duration_ms = 0;
        unsafe {
            let presentation_duration = source_reader
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .expect("Couldn't get presentation duration");
            let ns_100_duration =
                PropVariantToInt64(&presentation_duration).expect("Couldn't get duration");
            duration = ns_100_duration / 10_000_000; // convert to seconds
            duration_ms = ns_100_duration / 10_000; // convert to milliseconds
        }

        // Get source dimensions
        let mut source_width = 0;
        let mut source_height = 0;
        unsafe {
            let media_type = source_reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)?;

            let size_attr = media_type.GetUINT64(&MF_MT_FRAME_SIZE)?;
            source_width = (size_attr >> 32) as u32;
            source_height = (size_attr & 0xFFFFFFFF) as u32;
        }

        // Get source frame rate
        let mut source_frame_rate = 0.0;
        unsafe {
            let media_type = source_reader
                .GetNativeMediaType(MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32, 0)
                .expect("Failed to get media type");

            let frame_rate_attr = media_type
                .GetUINT64(&MF_MT_FRAME_RATE)
                .expect("Failed to get frame rate");

            let frame_rate = (frame_rate_attr >> 32) as f64; // Numerator
            let frame_rate_base = (frame_rate_attr & 0xFFFFFFFF) as f64; // Denominator

            source_frame_rate = frame_rate / frame_rate_base;
        }

        Ok((
            source_reader,
            duration,
            duration_ms,
            source_width,
            source_height,
            source_frame_rate,
        ))
    }

    // #[cfg(target_arch = "wasm32")]
    // fn initialize_media_source() {}

    fn create_source_reader(
        // &self,
        file_path: &str,
    ) -> Result<IMFSourceReader, windows::core::Error> {
        unsafe {
            let wide_path: Vec<u16> = file_path.encode_utf16().chain(Some(0)).collect();

            // Create the media source from the file path
            let attributes: &mut Option<IMFAttributes> = &mut None;
            MFCreateAttributes(attributes, 0).expect("Couldn't create video decoder attributes");

            let attributes = attributes
                .as_ref()
                .expect("Couldn't get video decoder attributes");
            attributes.SetUINT32(&MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING, 1)?; // not necessary, can use nv12 which is YUV
            attributes.SetUINT32(&MF_READWRITE_DISABLE_CONVERTERS, 0)?; // not necessary, can use nv12 which is YUV

            // the only source reader needed for video
            let source_reader =
                MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), *&attributes)?;

            // Set the output format to RGB32
            // let mut media_type: IMFMediaType = std::ptr::null_mut();
            let media_type = MFCreateMediaType()?;
            media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            // media_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            source_reader.SetCurrentMediaType(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                None,
                &media_type,
            )?;

            Ok(source_reader)
        }
    }

    pub fn draw_video_frame(&self, device: &Device, queue: &Queue) -> windows::core::Result<()> {
        unsafe {
            // println!("Drawing video frame");
            let mut flags: u32 = 0;
            let mut timestamp: i64 = 0; // store timestamp for later use?
            let mut sample: Option<IMFSample> = None;
            let actual_stream_index: &mut u32 = &mut 0;

            // println!("Reading sample");
            self.source_reader.ReadSample(
                MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32,
                0,
                Some(actual_stream_index),
                Some(&mut flags),
                Some(&mut timestamp),
                Some(&mut sample),
            )?;

            // println!("Convert to buffer");
            let sample = sample.as_ref().expect("Couldn't get sample container");
            let buffer = sample.ConvertToContiguousBuffer()?;

            // println!("Lock buffer");
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut data_len: u32 = 0;
            let mut max_length = 0;
            buffer.Lock(&mut data_ptr, Some(&mut max_length), Some(&mut data_len))?;

            // println!("Copy data");
            let mut frame_data = Vec::with_capacity(data_len as usize);
            std::ptr::copy_nonoverlapping(data_ptr, frame_data.as_mut_ptr(), data_len as usize);
            frame_data.set_len(data_len as usize);

            // println!("Unlock buffer");
            buffer.Unlock()?;

            // println!("Write texture {:?}", frame_data.len());
            // Write texture data
            // need to write nv12 / YUV data to texture with proper bytes per row
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &self.texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                &frame_data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(4 * self.source_dimensions.0),
                    rows_per_image: Some(self.source_dimensions.1),
                },
                wgpu::Extent3d {
                    width: self.source_dimensions.0,
                    height: self.source_dimensions.1,
                    depth_or_array_layers: 1,
                },
            );

            Ok(())
        }
    }

    pub fn reset_playback(&mut self) -> Result<(), windows::core::Error> {
        let time = PROPVARIANT::from(0i64);

        unsafe {
            self.source_reader.SetCurrentPosition(&GUID_NULL, &time)?;
        }

        Ok(())
    }

    pub fn update_data_from_dimensions(
        &mut self,
        window_size: &WindowSize,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        dimensions: (f32, f32),
        camera: &Camera,
    ) {
        self.dimensions = (dimensions.0 as u32, dimensions.1 as u32);
        // self.transform.update_scale([dimensions.0, dimensions.1]);
        // self.transform.update_uniform_buffer(&queue, &window_size);
    }

    pub fn update_zoom(&mut self, queue: &Queue, new_zoom: f32, center_point: Point) {
        self.current_zoom = new_zoom;
        let (video_width, video_height) = self.dimensions;

        let uv_center_x = center_point.x / video_width as f32;
        let uv_center_y = center_point.y / video_height as f32;

        let half_width = 0.5 / new_zoom;
        let half_height = 0.5 / new_zoom;

        let mut uv_min_x = uv_center_x - half_width;
        let mut uv_max_x = uv_center_x + half_width;
        let mut uv_min_y = uv_center_y - half_height;
        let mut uv_max_y = uv_center_y + half_height;

        // Check for clamping and adjust other UVs accordingly to prevent warping
        if uv_min_x < 0.0 {
            let diff = -uv_min_x;
            uv_min_x = 0.0;
            uv_max_x = (uv_max_x + diff).min(1.0); // Clamp max_x as well
        } else if uv_max_x > 1.0 {
            let diff = uv_max_x - 1.0;
            uv_max_x = 1.0;
            uv_min_x = (uv_min_x - diff).max(0.0); // Clamp min_x
        }

        if uv_min_y < 0.0 {
            let diff = -uv_min_y;
            uv_min_y = 0.0;
            uv_max_y = (uv_max_y + diff).min(1.0); // Clamp max_y
        } else if uv_max_y > 1.0 {
            let diff = uv_max_y - 1.0;
            uv_max_y = 1.0;
            uv_min_y = (uv_min_y - diff).max(0.0); // Clamp min_y
        }

        // self.vertices
        //     .iter_mut()
        //     .enumerate()
        //     .for_each(|(i, v)| match i {
        //         0 => v.tex_coords = [uv_min_x, uv_min_y],
        //         1 => v.tex_coords = [uv_max_x, uv_min_y],
        //         2 => v.tex_coords = [uv_max_x, uv_max_y],
        //         3 => v.tex_coords = [uv_min_x, uv_max_y],
        //         _ => {}
        //     });

        let (rows, cols) = self.grid_resolution;

        // Update UV coordinates for each vertex in place
        for y in 0..=rows {
            let v_ratio = y as f32 / rows as f32;
            let uv_y = uv_min_y + (uv_max_y - uv_min_y) * v_ratio;

            for x in 0..=cols {
                let u_ratio = x as f32 / cols as f32;
                let uv_x = uv_min_x + (uv_max_x - uv_min_x) * u_ratio;

                let vertex = &mut self.vertices[y as usize * (cols as usize + 1) + x as usize];
                vertex.tex_coords = [uv_x, uv_y];
            }
        }

        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&self.vertices));
    }

    // pub fn update_popout(
    //     &mut self,
    //     queue: &Queue,
    //     mouse_point: Point,
    //     popout_intensity: f32,
    //     popout_dimensions: (f32, f32),
    // ) {
    //     let (video_width, video_height) = self.dimensions;
    //     let uv_mouse_x = mouse_point.x / video_width as f32;
    //     let uv_mouse_y = mouse_point.y / video_height as f32;

    //     let mut new_vertices = &mut self.vertices;

    //     let (popout_width, popout_height) = popout_dimensions;
    //     let radius_x = popout_width / (2.0 * video_width as f32);
    //     let radius_y = popout_height / (2.0 * video_height as f32);

    //     for vertex in new_vertices.iter_mut() {
    //         let dx = vertex.tex_coords[0] - uv_mouse_x;
    //         let dy = vertex.tex_coords[1] - uv_mouse_y;

    //         // Normalize distance based on elliptical shape
    //         let normalized_dist = ((dx / radius_x).powi(2) + (dy / radius_y).powi(2)).sqrt();

    //         if normalized_dist < 1.0 {
    //             let effect_strength = popout_intensity * (1.0 - normalized_dist.powi(2));

    //             // Calculate displacement direction
    //             if normalized_dist > 0.0 {
    //                 let dir_x = dx / normalized_dist;
    //                 let dir_y = dy / normalized_dist;

    //                 // Apply displacement to UV coordinates
    //                 vertex.tex_coords[0] += dir_x * effect_strength * radius_x;
    //                 vertex.tex_coords[1] += dir_y * effect_strength * radius_y;

    //                 // Clamp UV coordinates
    //                 vertex.tex_coords[0] = vertex.tex_coords[0].clamp(0.0, 1.0);
    //                 vertex.tex_coords[1] = vertex.tex_coords[1].clamp(0.0, 1.0);
    //             }
    //         }
    //     }

    //     // Update vertex buffer
    //     queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&new_vertices));
    // }

    pub fn update_popout(
        &mut self,
        queue: &Queue,
        mouse_point: Point,
        popout_intensity: f32,
        popout_dimensions: (f32, f32),
    ) {
        let (video_width, video_height) = self.dimensions;
        let uv_mouse_x = mouse_point.x / video_width as f32;
        let uv_mouse_y = mouse_point.y / video_height as f32;

        let new_vertices = &mut self.vertices;

        let (popout_width, popout_height) = popout_dimensions;
        let radius_x = popout_width / (2.0 * video_width as f32);
        let radius_y = popout_height / (2.0 * video_height as f32);

        for vertex in new_vertices.iter_mut() {
            let dx = vertex.tex_coords[0] - uv_mouse_x;
            let dy = vertex.tex_coords[1] - uv_mouse_y;

            // Check if the vertex is within the popout area
            if dx.abs() <= radius_x && dy.abs() <= radius_y {
                // Normalize the coordinates to the popout area
                let normalized_x = dx / radius_x;
                let normalized_y = dy / radius_y;

                // Apply the zoom effect by scaling the texture coordinates
                vertex.tex_coords[0] = uv_mouse_x + normalized_x * radius_x / popout_intensity;
                vertex.tex_coords[1] = uv_mouse_y + normalized_y * radius_y / popout_intensity;

                // Clamp the texture coordinates to avoid going out of bounds
                vertex.tex_coords[0] = vertex.tex_coords[0].clamp(0.0, 1.0);
                vertex.tex_coords[1] = vertex.tex_coords[1].clamp(0.0, 1.0);
            }
        }

        // Update vertex buffer
        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&new_vertices));
    }

    pub fn update_opacity(&mut self, queue: &wgpu::Queue, opacity: f32) {
        let new_color = [1.0, 1.0, 1.0, opacity];

        self.vertices.iter_mut().for_each(|v| {
            v.color = new_color;
        });

        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&self.vertices));
    }

    pub fn contains_point(&self, point: &Point, camera: &Camera) -> bool {
        let untranslated = Point {
            x: point.x - (self.transform.position.x),
            y: point.y - self.transform.position.y,
        };

        let (width, height) = self.dimensions;

        let scaled_width = self.transform.scale.x;
        let scaled_height = self.transform.scale.y;
        
        // Check if the point is within -0.5 to 0.5 range
        untranslated.x >= -0.5 * scaled_width as f32
            && untranslated.x <= 0.5 * scaled_width as f32
            && untranslated.y >= -0.5 * scaled_height as f32
            && untranslated.y <= 0.5 * scaled_height as f32
    }

    pub fn contains_point_with_tolerance(&self, point: &Point, camera: &Camera, tolerance_percent: f32) -> bool {
        let untranslated = Point {
            x: point.x - (self.transform.position.x),
            y: point.y - self.transform.position.y,
        };

        let (width, height) = self.dimensions;
        let scaled_width = self.transform.scale.x;
        let scaled_height = self.transform.scale.y;

        // Apply tolerance expansion to the detection area
        let tolerance_multiplier = 1.0 + (tolerance_percent / 100.0);
        let enhanced_width = scaled_width * tolerance_multiplier;
        let enhanced_height = scaled_height * tolerance_multiplier;
        
        // Check if the point is within the enhanced bounds
        untranslated.x >= -0.5 * enhanced_width as f32
            && untranslated.x <= 0.5 * enhanced_width as f32
            && untranslated.y >= -0.5 * enhanced_height as f32
            && untranslated.y <= 0.5 * enhanced_height as f32
    }

    pub fn update_layer(&mut self, layer_index: i32) {
        // -10.0 to provide 10 spots for internal items on top of objects
        let layer_index = layer_index - 0;
        self.layer = layer_index;
        // self.transform.layer = layer_index as f32;
    }

    pub fn to_config(&self) -> StVideoConfig {
        StVideoConfig {
            id: self.id.clone(),
            name: self.name.clone(),
            path: self.path.clone(),
            dimensions: self.dimensions,
            position: Point {
                x: self.transform.position.x - CANVAS_HORIZ_OFFSET,
                y: self.transform.position.y - CANVAS_VERT_OFFSET,
            },
            layer: self.layer,
            mouse_path: self.mouse_path.clone(),
        }
    }
}

// TODO: add to Drop trait?
fn shutdown_media_foundation() -> Result<(), windows::core::Error> {
    unsafe {
        MFShutdown()?;
    }
    Ok(())
}

impl Drop for StVideo {
    fn drop(&mut self) {
        unsafe {
            shutdown_media_foundation().expect("Couldn't shut down media foundation");
        }
    }
}

// Helper struct to manage frame timing
// pub struct FrameTimer {
//     pub frame_rate: f64,
//     pub last_frame_time: std::time::Duration,
//     pub frame_interval: std::time::Duration,
//     pub frame_count: u64,
//     pub drift_correction: f64,
// }

// impl FrameTimer {
//     pub fn new(frame_rate: f64, start_time: Duration) -> Self {
//         Self {
//             frame_rate,
//             last_frame_time: start_time,
//             frame_interval: Duration::from_secs_f64(1.0 / frame_rate),
//             frame_count: 0,
//             drift_correction: 0.0,
//         }
//     }

//     pub fn should_draw(&mut self, current_time: Duration) -> bool {
//         let elapsed = current_time - self.last_frame_time;

//         // Calculate ideal frame time including drift correction
//         let ideal_frame_time = self.frame_count as f64 * self.frame_interval.as_secs_f64();

//         // Calculate actual elapsed time
//         let actual_elapsed = elapsed.as_secs_f64() + self.drift_correction;

//         println!(
//             "should_draw {:?} vs {:?}, {:?} vs {:?} and drift {:?}",
//             elapsed.as_secs_f64(),
//             actual_elapsed,
//             current_time.as_secs_f64(),
//             ideal_frame_time,
//             self.drift_correction
//         );

//         if actual_elapsed >= self.frame_interval.as_secs_f64() {
//             // Update frame count and last frame time
//             self.frame_count += 1;
//             self.last_frame_time = current_time;

//             // Calculate and accumulate drift
//             // let drift = current_time.as_secs_f64() - ideal_frame_time; // accumlates, but we are doing frame by frame drift?
//             let drift = elapsed.as_secs_f64() - self.frame_interval.as_secs_f64();
//             // self.drift_correction = if drift.abs() < 0.002 { 0.0 } else { drift };
//             self.drift_correction = drift;

//             true
//         } else {
//             false
//         }
//     }
// }

// pub struct FrameTimer {
//     pub frame_rate: f64,
//     pub start_time: Duration, // Keep start_time as Duration
//     pub frame_interval: Duration,
//     pub frame_count: u64,
//     pub accumulated_drift: f64,
//     last_instant: Instant, // Add an Instant to track time
// }

// impl FrameTimer {
//     pub fn new(frame_rate: f64, start_time: Duration) -> Self {
//         Self {
//             frame_rate,
//             start_time,
//             frame_interval: Duration::from_secs_f64(1.0 / frame_rate),
//             frame_count: 0,
//             accumulated_drift: 0.0,
//             last_instant: Instant::now(), // Initialize last_instant
//         }
//     }

//     pub fn should_draw(&mut self, current_time: Duration) -> bool {
//         let now = Instant::now();
//         let elapsed_since_last = now.duration_since(self.last_instant);
//         self.last_instant = now;

//         let ideal_time_instant = Instant::now() - self.start_time
//             + Duration::from_secs_f64(self.frame_count as f64 / self.frame_rate);
//         let current_time_instant = Instant::now() - current_time;

//         let time_difference = current_time_instant
//             .duration_since(ideal_time_instant)
//             .as_secs_f64();

//         // Accumulate drift, but clamp it to prevent runaway correction.
//         self.accumulated_drift += time_difference;

//         // Apply a small correction each frame to avoid over-correction.
//         let correction = time_difference * 0.1; // Adjust this factor (0.1) as needed
//         self.accumulated_drift -= correction;

//         println!(
//             "should_draw: ideal_time: {:?}, current_time: {:?}, time_difference: {:?}, accumulated_drift: {:?}",
//             ideal_time_instant, current_time_instant, time_difference, self.accumulated_drift
//         );

//         if time_difference >= 0.0 {
//             // If current time is ahead of ideal time.
//             self.frame_count += 1;
//             true
//         } else {
//             false
//         }
//     }
// }

pub struct FrameTimer {
    pub last_step_time: Duration,
    pub last_frame_time: Duration,
    pub accumulated_video_time: Duration,
}

impl FrameTimer {
    pub fn new() -> Self {
        Self {
            last_step_time: Duration::ZERO,
            last_frame_time: Duration::ZERO,
            accumulated_video_time: Duration::ZERO,
        }
    }

    pub fn update_and_get_frames_to_draw(
        &mut self,
        current_time: Duration,
        video_frame_rate: f32,
    ) -> u32 {
        // Calculate time since last step
        let step_delta = current_time - self.last_step_time;

        // Accumulate time for video frames
        self.accumulated_video_time += step_delta;

        // Calculate how many video frames we need to draw to catch up
        let frame_interval = Duration::from_secs_f32(1.0 / video_frame_rate);
        let frames_to_draw = (self.accumulated_video_time.as_secs_f32()
            / frame_interval.as_secs_f32())
        .floor() as u32;

        // Subtract the time for frames we're about to draw
        if frames_to_draw > 0 {
            self.accumulated_video_time -= frame_interval * frames_to_draw;
            self.last_frame_time = current_time;
        }

        self.last_step_time = current_time;
        frames_to_draw
    }
}
