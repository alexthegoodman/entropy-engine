// MP4 (AAC) -> interleaved f32 chunks, via symphonia. OpenH264 is video-only, so the audio half of
// what Media Foundation's audio source reader did on Windows lives here.
use std::fs::File;
use std::path::Path;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

pub struct Mp4AudioDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    channels: u16,
    sample_rate: u32,
    /// After a seek, packets that end before this timestamp (track time base) are decoded but
    /// dropped, since symphonia lands on the packet boundary at or before the requested time.
    skip_before_ts: Option<u64>,
    samples: Option<SampleBuffer<f32>>,
}

impl Mp4AudioDecoder {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        let file = File::open(path).map_err(|e| format!("Couldn't open {}: {e}", path.display()))?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|e| e.to_str()) {
            hint.with_extension(extension);
        }
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("Couldn't read {} for audio: {e}", path.display()))?;
        let format = probed.format;

        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| format!("{} has no supported audio track", path.display()))?;
        let track_id = track.id;
        let sample_rate = track.codec_params.sample_rate.ok_or("audio track has no sample rate")?;
        let channels = track.codec_params.channels.map(|c| c.count() as u16);
        let decoder = symphonia::default::get_codecs()
            .make(&track.codec_params, &DecoderOptions::default())
            .map_err(|e| format!("Unsupported audio codec in {}: {e}", path.display()))?;

        let mut this = Self {
            format,
            decoder,
            track_id,
            channels: channels.unwrap_or(0),
            sample_rate,
            skip_before_ts: None,
            samples: None,
        };
        if this.channels == 0 {
            // AAC in MP4 doesn't always spell out the channel layout in the container; decode one
            // packet to learn it, then rewind.
            let first = this.next_chunk()?;
            if first.is_none() || this.channels == 0 {
                return Err(format!("{}: couldn't determine audio channel count", path.display()));
            }
            this.seek(0)?;
        }
        Ok(this)
    }

    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn seek(&mut self, ms: i64) -> Result<(), String> {
        let ms = ms.max(0) as u64;
        let seeked = self
            .format
            .seek(
                SeekMode::Accurate,
                SeekTo::Time { time: Time::new(ms / 1000, (ms % 1000) as f64 / 1000.0), track_id: Some(self.track_id) },
            )
            .map_err(|e| format!("Audio seek failed: {e}"))?;
        self.decoder.reset();
        self.skip_before_ts = (seeked.required_ts > seeked.actual_ts).then_some(seeked.required_ts);
        Ok(())
    }

    /// Next chunk of interleaved samples, or `None` at end of stream.
    pub fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(e) => return Err(format!("Audio demux error: {e}")),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            if let Some(skip) = self.skip_before_ts {
                if packet.ts() + packet.dur() <= skip {
                    // Still decode, so the decoder's state (AAC overlap) is primed for what follows.
                    let _ = self.decoder.decode(&packet);
                    continue;
                }
                self.skip_before_ts = None;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                // Corrupt packet: skip it rather than ending playback.
                Err(SymphoniaError::DecodeError(e)) => {
                    tracing::debug!("[openh264_codec] audio decode error: {e}");
                    continue;
                }
                Err(e) => return Err(format!("Audio decode error: {e}")),
            };
            let spec = *decoded.spec();
            if self.channels == 0 {
                self.channels = spec.channels.count() as u16;
            }
            let needed = decoded.capacity() as u64;
            if self.samples.as_ref().map_or(true, |buffer| buffer.capacity() < needed as usize * spec.channels.count()) {
                self.samples = Some(SampleBuffer::new(needed, spec));
            }
            let buffer = self.samples.as_mut().expect("sample buffer allocated above");
            buffer.copy_interleaved_ref(decoded);
            if buffer.samples().is_empty() {
                continue;
            }
            return Ok(Some(buffer.samples().to_vec()));
        }
    }
}
