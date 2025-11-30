use windows::{core::*, Win32::Media::MediaFoundation::*, Win32::System::Com::*};

const VIDEO_WIDTH: u32 = 1920; // HD resolution
const VIDEO_HEIGHT: u32 = 1080;
const VIDEO_FPS: u32 = 60; // Higher framerate for smoother output
const VIDEO_FRAME_DURATION: i64 = 10 * 1000 * 1000 / VIDEO_FPS as i64;
const VIDEO_BIT_RATE: u32 = 5_000_000; // 5 Mbps for HD

pub struct VideoEncoder {
    sink_writer: Option<IMFSinkWriter>,
    stream_index: u32,
    frame_count: u64,
}

impl VideoEncoder {
    pub fn new(output_path: &str) -> windows::core::Result<Self> {
        // Initialize COM and Media Foundation
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        }

        let mut encoder = VideoEncoder {
            sink_writer: None,
            stream_index: 0,
            frame_count: 0,
        };

        encoder.initialize_sink_writer(output_path)?;
        Ok(encoder)
    }

    fn initialize_sink_writer(&mut self, output_path: &str) -> windows::core::Result<()> {
        unsafe {
            // Create sink writer
            let wide_path: Vec<u16> = output_path.encode_utf16().chain(Some(0)).collect();
            // let mut sink_writer = None;
            let sink_writer =
                MFCreateSinkWriterFromURL(PCWSTR(wide_path.as_ptr()), None, None)?;

            // Configure output media type (H264)
            let media_type_out = {
                // let mut type_out = None;
                let type_out = MFCreateMediaType()?;
                // let type_out = type_out.unwrap();

                type_out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                type_out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
                type_out.SetUINT32(&MF_MT_AVG_BITRATE, VIDEO_BIT_RATE)?;
                type_out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
                // MFSetAttributeSize(&type_out, &MF_MT_FRAME_SIZE, VIDEO_WIDTH, VIDEO_HEIGHT)?;
                // MFSetAttributeRatio(&type_out, &MF_MT_FRAME_RATE, VIDEO_FPS, 1)?;
                // MFSetAttributeRatio(&type_out, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

                mf_set_attribute_size(&type_out, &MF_MT_FRAME_SIZE, VIDEO_WIDTH, VIDEO_HEIGHT)?;
                mf_set_attribute_ratio(&type_out, &MF_MT_FRAME_RATE, VIDEO_FPS, 1)?;
                mf_set_attribute_ratio(&type_out, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

                type_out
            };

            // Create stream
            // let sink_writer = sink_writer.unwrap();
            // sink_writer.AddStream(&media_type_out, &mut self.stream_index)?;
            sink_writer.AddStream(&media_type_out)?;

            // Configure input media type (RGBA from wgpu)
            let media_type_in = {
                // let mut type_in = None;
                let type_in = MFCreateMediaType()?;
                // let type_in = type_in.unwrap();

                type_in.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                type_in.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
                type_in.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
                // MFSetAttributeSize(&type_in, &MF_MT_FRAME_SIZE, VIDEO_WIDTH, VIDEO_HEIGHT)?;
                // MFSetAttributeRatio(&type_in, &MF_MT_FRAME_RATE, VIDEO_FPS, 1)?;
                // MFSetAttributeRatio(&type_in, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

                mf_set_attribute_size(&type_in, &MF_MT_FRAME_SIZE, VIDEO_WIDTH, VIDEO_HEIGHT)?;
                mf_set_attribute_ratio(&type_in, &MF_MT_FRAME_RATE, VIDEO_FPS, 1)?;
                mf_set_attribute_ratio(&type_in, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

                type_in
            };

            sink_writer.SetInputMediaType(self.stream_index, &media_type_in, None)?;
            sink_writer.BeginWriting()?;
            self.sink_writer = Some(sink_writer);
        }
        Ok(())
    }

    pub fn write_frame(&mut self, frame_data: &[u8]) -> windows::core::Result<()> {
        unsafe {
            let sink_writer = self.sink_writer.as_ref().unwrap();

            // Calculate buffer size and stride
            let stride = VIDEO_WIDTH as u32 * 4; // 4 bytes per pixel (RGBA)
            let buffer_size = stride * VIDEO_HEIGHT;

            // Create and fill the media buffer
            // let mut media_buffer = None;
            let media_buffer = MFCreateMemoryBuffer(buffer_size)?;
            // let media_buffer = media_buffer.unwrap();

            // Lock the buffer and copy frame data
            let mut buffer_data = std::ptr::null_mut();
            let mut max_length = 0;
            media_buffer.Lock(
                &mut buffer_data,
                Some(&mut max_length),
                Some(std::ptr::null_mut()),
            )?;

            if !buffer_data.is_null() {
                // Copy frame data to the buffer
                std::ptr::copy_nonoverlapping(
                    frame_data.as_ptr(),
                    buffer_data,
                    buffer_size as usize,
                );

                media_buffer.Unlock()?;
                media_buffer.SetCurrentLength(buffer_size)?;

                // Create a media sample and add the buffer
                // let mut sample = None;
                let sample = MFCreateSample()?;
                // let sample = sample.unwrap();
                sample.AddBuffer(&media_buffer)?;

                // Set the sample time and duration
                let time_stamp = self.frame_count as i64 * VIDEO_FRAME_DURATION;
                sample.SetSampleTime(time_stamp)?;
                sample.SetSampleDuration(VIDEO_FRAME_DURATION)?;

                // Write the sample
                sink_writer.WriteSample(self.stream_index, &sample)?;
            }
        }

        self.frame_count += 1;
        Ok(())
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            if let Some(writer) = self.sink_writer.take() {
                let _ = writer.Finalize();
            }
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

use windows::core::{Result, GUID};
use windows::Win32::Media::MediaFoundation::IMFAttributes;

fn mf_set_attribute_size(
    attributes: &IMFAttributes,
    guid_key: &GUID,
    width: u32,
    height: u32,
) -> Result<()> {
    unsafe {
        let size_value: u64 = ((width as u64) << 32) | (height as u64);
        attributes.SetUINT64(guid_key, size_value)
    }
}

fn mf_set_attribute_ratio(
    attributes: &IMFAttributes,
    guid_key: &GUID,
    numerator: u32,
    denominator: u32,
) -> Result<()> {
    unsafe {
        let ratio_value: u64 = ((numerator as u64) << 32) | (denominator as u64);
        attributes.SetUINT64(guid_key, ratio_value)
    }
}

// // Example integration with wgpu loop:
// pub fn encode_from_wgpu(
//     encoder: &mut VideoEncoder,
//     texture: &wgpu::Texture,
// ) -> windows::core::Result<()> {
//     // Read pixels from texture
//     let buffer = texture.slice(..).get_mapped_range();
//     encoder.write_frame(&buffer)?;
//     Ok(())
// }
