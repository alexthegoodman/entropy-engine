//! The audio input backend (spec AUD-1..AUD-4), isolated behind `open_input`: everything that
//! knows about cpal lives here, and the rest of the live layer sees only a `GuitarPipeline` being
//! fed buffers. WASAPI is what the default build uses; ASIO comes with `--features asio`.

use super::pipeline::GuitarPipeline;
use super::shared::Shared;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, SampleFormat, SampleRate, StreamConfig, StreamError, SupportedBufferSize};
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;

#[derive(Clone, Debug, PartialEq)]
pub struct InputDevice {
    pub host: String,
    pub name: String,
    pub channels: u16,
    pub default_sample_rate: u32,
    pub is_default: bool,
}

/// Every input device on every host cpal has here.
pub fn list_input_devices() -> Vec<InputDevice> {
    let mut out = Vec::new();
    for id in cpal::available_hosts() {
        let Ok(host) = cpal::host_from_id(id) else { continue };
        let default_name = host.default_input_device().and_then(|d| d.name().ok());
        let Ok(devices) = host.input_devices() else { continue };
        for d in devices {
            let Ok(name) = d.name() else { continue };
            let Ok(cfg) = d.default_input_config() else { continue };
            out.push(InputDevice {
                host: id.name().to_string(),
                is_default: default_name.as_deref() == Some(name.as_str()),
                name,
                channels: cfg.channels(),
                default_sample_rate: cfg.sample_rate().0,
            });
        }
    }
    out
}

#[derive(Clone, Debug)]
pub struct InputRequest {
    /// Host name as `list_input_devices` reports it. `None` is the platform default.
    pub host: Option<String>,
    /// Device name. `None` is the host's default input.
    pub device: Option<String>,
    /// Zero-based input channel to read as the guitar.
    pub channel: usize,
    pub sample_rate: u32,
    pub buffer_frames: u32,
}

impl Default for InputRequest {
    fn default() -> Self {
        InputRequest { host: None, device: None, channel: 0, sample_rate: 48_000, buffer_frames: 128 }
    }
}

/// What the backend actually gave, including anything it could not honor (spec 3.6: say what was
/// rejected and what it fell back to).
#[derive(Clone, Debug)]
pub struct OpenedInput {
    pub host: String,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// The buffer size that was requested and accepted, or `None` when the driver picks its own.
    pub buffer_frames: Option<u32>,
    pub sample_format: String,
    pub notes: Vec<String>,
}

/// The thread that owns the stream. cpal streams are not `Send` on every host, and a WASAPI stream
/// wants the thread that created it to stay alive, so one thread builds, plays and later drops it.
pub struct InputHandle {
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<()>>,
    pub opened: OpenedInput,
}

impl InputHandle {
    pub fn stop(&mut self) {
        let _ = self.stop.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for InputHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Higher is better: a device usually lists several formats, and the first is often the worst (an
/// 8-bit one turned up on a webcam microphone). Floating point needs no conversion loss, then the
/// widest integers.
fn format_rank(f: SampleFormat) -> u8 {
    match f {
        SampleFormat::F32 => 10,
        SampleFormat::I32 => 9,
        SampleFormat::F64 => 8,
        SampleFormat::I16 => 7,
        SampleFormat::U16 => 6,
        SampleFormat::I8 => 5,
        SampleFormat::U8 => 4,
        SampleFormat::I64 | SampleFormat::U32 | SampleFormat::U64 => 3,
        _ => 0,
    }
}

fn pick_host(name: &Option<String>) -> Result<cpal::Host, String> {
    match name {
        None => Ok(cpal::default_host()),
        Some(n) => {
            let id = cpal::available_hosts().into_iter().find(|h| h.name().eq_ignore_ascii_case(n)).ok_or_else(|| {
                let have: Vec<_> = cpal::available_hosts().iter().map(|h| h.name().to_string()).collect();
                format!("audio host '{n}' is not available here (have: {})", have.join(", "))
            })?;
            cpal::host_from_id(id).map_err(|e| format!("could not start audio host '{n}': {e}"))
        }
    }
}

/// Builds the input stream on a dedicated thread and returns once it is playing or has failed.
///
/// `make_pipeline` is called with the sample rate the device really runs at, because the engine's
/// window lengths depend on it.
pub fn open_input(
    req: InputRequest,
    shared: Arc<Shared>,
    make_pipeline: impl FnOnce(u32) -> GuitarPipeline + Send + 'static,
) -> Result<InputHandle, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<OpenedInput, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let thread = std::thread::Builder::new()
        .name("guitar-input".into())
        .spawn(move || {
            let built = build_stream(&req, &shared, make_pipeline);
            match built {
                Ok((stream, opened)) => {
                    if let Err(e) = stream.play() {
                        let _ = ready_tx.send(Err(format!("the input device would not start: {e}")));
                        return;
                    }
                    shared.running.store(true, Ordering::Release);
                    let _ = ready_tx.send(Ok(opened));
                    // Hold the stream until asked to stop or the handle is dropped.
                    let _ = stop_rx.recv();
                    shared.running.store(false, Ordering::Release);
                    drop(stream);
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
            }
        })
        .map_err(|e| format!("could not start the input thread: {e}"))?;

    match ready_rx.recv() {
        Ok(Ok(opened)) => Ok(InputHandle { stop: stop_tx, thread: Some(thread), opened }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err("the input thread ended before reporting".into()),
    }
}

fn build_stream(
    req: &InputRequest,
    shared: &Arc<Shared>,
    make_pipeline: impl FnOnce(u32) -> GuitarPipeline,
) -> Result<(cpal::Stream, OpenedInput), String> {
    let host = pick_host(&req.host)?;
    let host_name = host.id().name().to_string();
    let mut notes = Vec::new();

    let device = match &req.device {
        Some(name) => host
            .input_devices()
            .map_err(|e| format!("could not list inputs on {host_name}: {e}"))?
            .find(|d| d.name().map_or(false, |n| &n == name))
            .ok_or_else(|| format!("input device '{name}' is not available on {host_name}. Is the interface connected and switched on?"))?,
        None => host.default_input_device().ok_or_else(|| format!("no input device on {host_name}"))?,
    };
    let device_name = device.name().unwrap_or_else(|_| "unknown".into());

    let ranges: Vec<_> = device.supported_input_configs().map_err(|e| format!("could not read what '{device_name}' supports: {e}"))?.collect();
    if ranges.is_empty() {
        return Err(format!("'{device_name}' reports no input formats"));
    }
    let channel_ok = |c: u16| (c as usize) > req.channel;
    let usable: Vec<_> = ranges.iter().filter(|r| channel_ok(r.channels())).collect();
    if usable.is_empty() {
        let most = ranges.iter().map(|r| r.channels()).max().unwrap_or(0);
        return Err(format!("'{device_name}' has {most} input channel(s); channel {} was asked for", req.channel + 1));
    }

    // The requested rate if any format offers it, else the device's default, and say so.
    let wanted = SampleRate(req.sample_rate);
    let chosen = usable
        .iter()
        .filter(|r| r.min_sample_rate() <= wanted && wanted <= r.max_sample_rate())
        .max_by_key(|r| format_rank(r.sample_format()));
    let (range, rate) = match chosen {
        Some(r) => (*r, wanted),
        None => {
            let default = device.default_input_config().map_err(|e| format!("no default input format: {e}"))?;
            let r = usable
                .iter()
                .filter(|r| r.min_sample_rate() <= default.sample_rate() && default.sample_rate() <= r.max_sample_rate())
                .max_by_key(|r| format_rank(r.sample_format()))
                .copied()
                .unwrap_or(usable[0]);
            let rate = default.sample_rate().clamp(r.min_sample_rate(), r.max_sample_rate());
            notes.push(format!("{} Hz is not supported by '{device_name}'; running at {} Hz instead", req.sample_rate, rate.0));
            (r, rate)
        }
    };
    let format = range.sample_format();
    let channels = range.channels();

    // A fixed buffer if the driver says it can, and if it will not build, the driver's own choice.
    let mut config = StreamConfig { channels, sample_rate: rate, buffer_size: BufferSize::Default };
    let mut requested_frames = None;
    match range.buffer_size() {
        SupportedBufferSize::Range { min, max } => {
            if (*min..=*max).contains(&req.buffer_frames) {
                config.buffer_size = BufferSize::Fixed(req.buffer_frames);
                requested_frames = Some(req.buffer_frames);
            } else {
                let clamped = req.buffer_frames.clamp(*min, *max);
                notes.push(format!("a buffer of {} frames is outside what '{device_name}' allows ({min}-{max}); using {clamped}", req.buffer_frames));
                config.buffer_size = BufferSize::Fixed(clamped);
                requested_frames = Some(clamped);
            }
        }
        SupportedBufferSize::Unknown => {
            config.buffer_size = BufferSize::Fixed(req.buffer_frames);
            requested_frames = Some(req.buffer_frames);
        }
    }

    // Ask the driver whether it accepts this configuration with a throwaway stream, so that a refused
    // fixed buffer can fall back to the driver's own choice before the real pipeline is built once.
    let probe = |cfg: &StreamConfig| -> Result<(), cpal::BuildStreamError> {
        macro_rules! dummy {
            ($t:ty) => {
                device.build_input_stream(cfg, |_: &[$t], _| {}, |_| {}, None).map(drop)
            };
        }
        match format {
            SampleFormat::F32 => dummy!(f32),
            SampleFormat::F64 => dummy!(f64),
            SampleFormat::I8 => dummy!(i8),
            SampleFormat::I16 => dummy!(i16),
            SampleFormat::I32 => dummy!(i32),
            SampleFormat::I64 => dummy!(i64),
            SampleFormat::U8 => dummy!(u8),
            SampleFormat::U16 => dummy!(u16),
            SampleFormat::U32 => dummy!(u32),
            SampleFormat::U64 => dummy!(u64),
            _ => Err(cpal::BuildStreamError::StreamConfigNotSupported),
        }
    };
    if let Some(frames) = requested_frames {
        if let Err(e) = probe(&config) {
            notes.push(format!("'{device_name}' would not take a fixed buffer of {frames} frames ({e}); using the driver's own size"));
            config.buffer_size = BufferSize::Default;
            requested_frames = None;
        }
    }

    let mut pipeline = Some(make_pipeline(rate.0));
    let error_shared = shared.clone();
    let err_fn = move |e: StreamError| {
        error_shared.stream_errors.fetch_add(1, Ordering::Relaxed);
        if matches!(e, StreamError::DeviceNotAvailable) {
            error_shared.device_lost.store(true, Ordering::Release);
        }
    };

    macro_rules! build {
        ($t:ty) => {{
            let mut p = pipeline.take().expect("pipeline used once");
            let ch = channels as usize;
            device.build_input_stream(&config, move |data: &[$t], _| p.process_interleaved(data, ch), err_fn, None)
        }};
    }
    let stream = match format {
        SampleFormat::F32 => build!(f32),
        SampleFormat::F64 => build!(f64),
        SampleFormat::I8 => build!(i8),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I32 => build!(i32),
        SampleFormat::I64 => build!(i64),
        SampleFormat::U8 => build!(u8),
        SampleFormat::U16 => build!(u16),
        SampleFormat::U32 => build!(u32),
        SampleFormat::U64 => build!(u64),
        other => return Err(format!("'{device_name}' delivers {other:?} samples, which this input does not handle yet")),
    }
    .map_err(|e| format!("could not open '{device_name}': {e}"))?;

    Ok((
        stream,
        OpenedInput {
            host: host_name,
            device: device_name,
            sample_rate: rate.0,
            channels,
            buffer_frames: requested_frames,
            sample_format: format!("{format:?}"),
            notes,
        },
    ))
}
