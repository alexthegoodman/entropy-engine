// H.264/MP4 encoder via Windows Media Foundation's sink writer - revived from the version
// pulled in during the initial cross-engine merge (see git history for
// `src/video_export/encode.rs` at commit 1f7c534), which hardcoded a single 1920x1080/60fps
// output and was never wired to anything. Parameterized here so the caller (`exporter::run_export`)
// can size the encoder to whatever it's actually capturing.
//
// `new_with_audio` adds an AAC stream (Media Foundation's own AAC encoder, fed 16-bit PCM through
// `write_audio`) for the music-video export (`crate::music_video`); `new` stays video-only.
use windows::{core::*, Win32::Media::MediaFoundation::*, Win32::System::Com::*};

/// The AAC stream `new_with_audio` adds. MF's AAC encoder takes 44.1 or 48 kHz, mono or stereo.
struct AudioStream {
    index: u32,
    sample_rate: u32,
    channels: u16,
    samples_written: u64,
}

pub struct VideoEncoder {
    sink_writer: IMFSinkWriter,
    stream_index: u32,
    frame_count: u64,
    width: u32,
    height: u32,
    frame_duration: i64, // 100ns units, per MF convention
    audio: Option<AudioStream>,
    finalized: bool,
}

impl VideoEncoder {
    pub fn new(output_path: &str, width: u32, height: u32, fps: u32) -> windows::core::Result<Self> {
        Self::new_with_audio(output_path, width, height, fps, None)
    }

    /// Like `new`, plus an AAC stream at `audio = (sample_rate, channels)` fed by `write_audio`.
    pub fn new_with_audio(output_path: &str, width: u32, height: u32, fps: u32, audio: Option<(u32, u16)>) -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok();
            MFStartup(MF_VERSION, MFSTARTUP_FULL)?;
        }

        let bit_rate = (width as u64 * height as u64 * fps as u64 / 8) as u32; // ~1 bit/pixel/frame
        let frame_duration = 10_000_000i64 / fps as i64;

        let audio = audio.map(|(sample_rate, channels)| (sample_rate, channels.clamp(1, 2)));
        let (sink_writer, stream_index, audio_index) = Self::create_sink_writer(output_path, width, height, fps, bit_rate, audio)?;

        Ok(VideoEncoder {
            sink_writer,
            stream_index,
            frame_count: 0,
            width,
            height,
            frame_duration,
            audio: audio.zip(audio_index).map(|((sample_rate, channels), index)| AudioStream { index, sample_rate, channels, samples_written: 0 }),
            finalized: false,
        })
    }

    fn create_sink_writer(
        output_path: &str,
        width: u32,
        height: u32,
        fps: u32,
        bit_rate: u32,
        audio: Option<(u32, u16)>,
    ) -> windows::core::Result<(IMFSinkWriter, u32, Option<u32>)> {
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

            let audio_index = match audio {
                Some((sample_rate, channels)) => Some(Self::add_audio_stream(&sink_writer, sample_rate, channels)?),
                None => None,
            };

            sink_writer.BeginWriting()?;

            Ok((sink_writer, stream_index, audio_index))
        }
    }

    fn add_audio_stream(sink_writer: &IMFSinkWriter, sample_rate: u32, channels: u16) -> windows::core::Result<u32> {
        unsafe {
            let audio_out = MFCreateMediaType()?;
            audio_out.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            audio_out.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            audio_out.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            audio_out.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)?;
            audio_out.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels as u32)?;
            // Bytes per second: 24000 (192 kbit/s) is the highest the MF AAC encoder accepts.
            audio_out.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)?;
            let audio_index = sink_writer.AddStream(&audio_out)?;

            let block_align = 2 * channels as u32;
            let audio_in = MFCreateMediaType()?;
            audio_in.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            audio_in.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            audio_in.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            audio_in.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, sample_rate)?;
            audio_in.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels as u32)?;
            audio_in.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_align)?;
            audio_in.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, sample_rate * block_align)?;
            sink_writer.SetInputMediaType(audio_index, &audio_in, None)?;
            Ok(audio_index)
        }
    }

    /// Interleaved f32 samples at the rate and channel count given to `new_with_audio`, written
    /// as 16-bit PCM for MF's AAC encoder. Errors if the encoder has no audio stream.
    pub fn write_audio(&mut self, interleaved: &[f32]) -> windows::core::Result<()> {
        let Some(audio) = self.audio.as_mut() else {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED));
        };
        let frames = interleaved.len() / audio.channels as usize;
        if frames == 0 {
            return Ok(());
        }
        let bytes = (frames * audio.channels as usize * 2) as u32;
        unsafe {
            let media_buffer = MFCreateMemoryBuffer(bytes)?;
            let mut buffer_ptr = std::ptr::null_mut();
            media_buffer.Lock(&mut buffer_ptr, Some(std::ptr::null_mut()), Some(std::ptr::null_mut()))?;
            if !buffer_ptr.is_null() {
                let dest = std::slice::from_raw_parts_mut(buffer_ptr, bytes as usize);
                for (s, out) in interleaved.iter().zip(dest.chunks_exact_mut(2)) {
                    out.copy_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
                }
            }
            media_buffer.Unlock()?;
            media_buffer.SetCurrentLength(bytes)?;

            let sample = MFCreateSample()?;
            sample.AddBuffer(&media_buffer)?;
            let rate = audio.sample_rate as i64;
            sample.SetSampleTime(audio.samples_written as i64 * 10_000_000 / rate)?;
            sample.SetSampleDuration(frames as i64 * 10_000_000 / rate)?;
            self.sink_writer.WriteSample(audio.index, &sample)?;
        }
        audio.samples_written += frames as u64;
        Ok(())
    }

    /// Media Foundation handles the AAC encoder's priming itself, so no shift is needed.
    pub fn audio_delay_samples(&self) -> u32 {
        0
    }

    /// Writes the MP4 index. Called by `Drop` if not called explicitly, but only this reports
    /// failure.
    pub fn finish(&mut self) -> windows::core::Result<()> {
        if self.finalized {
            return Ok(());
        }
        self.finalized = true;
        unsafe { self.sink_writer.Finalize() }
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
        let _ = self.finish();
        unsafe {
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
