// H.264/MP4 encoder via Windows Media Foundation's sink writer - revived from the version
// pulled in during the initial cross-engine merge (see git history for
// `src/video_export/encode.rs` at commit 1f7c534), which hardcoded a single 1920x1080/60fps
// output and was never wired to anything. Parameterized here so the caller (`exporter::run_export`)
// can size the encoder to whatever it's actually capturing.
use windows::{core::*, Win32::Media::MediaFoundation::*, Win32::System::Com::*};

pub struct VideoEncoder {
    sink_writer: IMFSinkWriter,
    stream_index: u32,
    frame_count: u64,
    width: u32,
    height: u32,
    frame_duration: i64, // 100ns units, per MF convention
}

impl VideoEncoder {
    pub fn new(output_path: &str, width: u32, height: u32, fps: u32) -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok();
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        }

        let bit_rate = (width as u64 * height as u64 * fps as u64 / 8) as u32; // ~1 bit/pixel/frame
        let frame_duration = 10_000_000i64 / fps as i64;

        let (sink_writer, stream_index) = Self::create_sink_writer(output_path, width, height, fps, bit_rate)?;

        Ok(VideoEncoder {
            sink_writer,
            stream_index,
            frame_count: 0,
            width,
            height,
            frame_duration,
        })
    }

    fn create_sink_writer(
        output_path: &str,
        width: u32,
        height: u32,
        fps: u32,
        bit_rate: u32,
    ) -> windows::core::Result<(IMFSinkWriter, u32)> {
        unsafe {
            let wide_path: Vec<u16> = output_path.encode_utf16().chain(Some(0)).collect();
            let sink_writer = MFCreateSinkWriterFromURL(PCWSTR(wide_path.as_ptr()), None, None)?;

            let media_type_out = MFCreateMediaType()?;
            media_type_out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            media_type_out.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            media_type_out.SetUINT32(&MF_MT_AVG_BITRATE, bit_rate)?;
            media_type_out.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            mf_set_attribute_size(&media_type_out, &MF_MT_FRAME_SIZE, width, height)?;
            mf_set_attribute_ratio(&media_type_out, &MF_MT_FRAME_RATE, fps, 1)?;
            mf_set_attribute_ratio(&media_type_out, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

            let stream_index = sink_writer.AddStream(&media_type_out)?;

            let media_type_in = MFCreateMediaType()?;
            media_type_in.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            media_type_in.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
            media_type_in.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            mf_set_attribute_size(&media_type_in, &MF_MT_FRAME_SIZE, width, height)?;
            mf_set_attribute_ratio(&media_type_in, &MF_MT_FRAME_RATE, fps, 1)?;
            mf_set_attribute_ratio(&media_type_in, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1)?;

            sink_writer.SetInputMediaType(stream_index, &media_type_in, None)?;
            sink_writer.BeginWriting()?;

            Ok((sink_writer, stream_index))
        }
    }

    /// `frame_data` is tightly-packed RGBA8 (no row padding) at `width` x `height` - the shape
    /// `FrameCaptureBuffer::get_frame_data` already returns after stripping wgpu's row alignment.
    /// MF's `MFVideoFormat_RGB32` reads it as BGRX, so this swaps R/B per pixel; alpha is ignored.
    pub fn write_frame(&mut self, frame_data: &[u8]) -> windows::core::Result<()> {
        unsafe {
            let stride = self.width * 4;
            let buffer_size = stride * self.height;

            let media_buffer = MFCreateMemoryBuffer(buffer_size)?;

            let mut buffer_ptr = std::ptr::null_mut();
            media_buffer.Lock(&mut buffer_ptr, Some(std::ptr::null_mut()), Some(std::ptr::null_mut()))?;

            if !buffer_ptr.is_null() {
                let dest = std::slice::from_raw_parts_mut(buffer_ptr, buffer_size as usize);
                for (px_in, px_out) in frame_data.chunks_exact(4).zip(dest.chunks_exact_mut(4)) {
                    px_out[0] = px_in[2]; // B
                    px_out[1] = px_in[1]; // G
                    px_out[2] = px_in[0]; // R
                    px_out[3] = 0xFF;
                }

                media_buffer.Unlock()?;
                media_buffer.SetCurrentLength(buffer_size)?;

                let sample = MFCreateSample()?;
                sample.AddBuffer(&media_buffer)?;

                let time_stamp = self.frame_count as i64 * self.frame_duration;
                sample.SetSampleTime(time_stamp)?;
                sample.SetSampleDuration(self.frame_duration)?;

                self.sink_writer.WriteSample(self.stream_index, &sample)?;
            }
        }

        self.frame_count += 1;
        Ok(())
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.sink_writer.Finalize();
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

fn mf_set_attribute_size(attributes: &IMFAttributes, guid_key: &GUID, width: u32, height: u32) -> windows::core::Result<()> {
    unsafe {
        let size_value: u64 = ((width as u64) << 32) | (height as u64);
        attributes.SetUINT64(guid_key, size_value)
    }
}

fn mf_set_attribute_ratio(attributes: &IMFAttributes, guid_key: &GUID, numerator: u32, denominator: u32) -> windows::core::Result<()> {
    unsafe {
        let ratio_value: u64 = ((numerator as u64) << 32) | (denominator as u64);
        attributes.SetUINT64(guid_key, ratio_value)
    }
}
