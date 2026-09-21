//! The audio-thread half: one input buffer in, note events on a lock-free queue out. This is the
//! function a device callback calls, and the one a test calls with a synthetic recording, so what
//! runs live is what runs in a test (spec OUT-3, RT-1..RT-3).

use super::shared::{CalState, Shared};
use crate::guitar::events::{EventSink, GuitarEvent, GuitarEventKind, BEND_CENTER};
use crate::guitar::{gate_from_levels, velocity_range_from_levels, GuitarConfig, GuitarEngine, Tunables};
use rtrb::{Consumer, Producer};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::Thread;
use std::time::Instant;

/// Slots in the event queue. A note is at most a few events, a bend a couple hundred per second.
pub const EVENT_QUEUE: usize = 1024;
pub const CONTROL_QUEUE: usize = 64;
/// The largest chunk handed to the engine at once. A device buffer bigger than this is split.
const MAX_CHUNK: usize = 4096;
/// -1 dBFS.
const CLIP_LEVEL: f32 = 0.891;

/// Changes the UI sends to the audio thread.
#[derive(Clone, Copy, Debug)]
pub enum Control {
    Tunables(Tunables),
    ReleaseAll,
    /// Listen for `seconds` and measure, either the room (silence) or playing.
    Calibrate { playing: bool, seconds: f32 },
}

/// Milliseconds between the level readings calibration keeps.
const CAL_STEP_MS: f32 = 5.0;
/// Room for 80 seconds of readings, allocated up front so the audio thread never grows it.
const CAL_CAPACITY: usize = 16_384;

struct CalRun {
    playing: bool,
    frames_left: u64,
    frames_since_sample: u64,
}

/// The engine's event sink on the audio thread. Bends are the first thing given up when the queue
/// fills, and a note event is never dropped for a bend's sake: a quarter of the queue is kept back
/// for them (spec OUT-3).
struct QueueSink<'a> {
    producer: &'a mut Producer<GuitarEvent>,
    shared: &'a Shared,
    pushed: bool,
}

impl EventSink for QueueSink<'_> {
    fn push(&mut self, e: GuitarEvent) {
        let droppable = matches!(e.kind, GuitarEventKind::PitchBend { value } if value != BEND_CENTER);
        if droppable && self.producer.slots() < EVENT_QUEUE / 4 {
            self.shared.dropped_bends.fetch_add(1, Ordering::Relaxed);
            return;
        }
        match self.producer.push(e) {
            Ok(()) => self.pushed = true,
            Err(_) => {
                let counter = if droppable { &self.shared.dropped_bends } else { &self.shared.dropped_events };
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// Everything a pipeline needs except the sample rate, which is only known once the device is open.
pub struct PipelineParts {
    pub cfg: GuitarConfig,
    pub channel: usize,
    pub events: Producer<GuitarEvent>,
    pub controls: Consumer<Control>,
    pub shared: Arc<Shared>,
    pub wake: Thread,
}

impl PipelineParts {
    pub fn build(self, sample_rate: f32) -> GuitarPipeline {
        let mut cfg = self.cfg;
        cfg.sample_rate = sample_rate;
        GuitarPipeline::new(cfg, self.channel, self.events, self.controls, self.shared, self.wake)
    }
}

pub struct GuitarPipeline {
    engine: GuitarEngine,
    events: Producer<GuitarEvent>,
    controls: Consumer<Control>,
    shared: Arc<Shared>,
    mono: Vec<f32>,
    channel: usize,
    wake: Thread,
    period_us_per_frame: f32,
    calls: u64,
    cal: Option<CalRun>,
    cal_levels: Vec<f32>,
}

impl GuitarPipeline {
    pub fn new(cfg: GuitarConfig, channel: usize, events: Producer<GuitarEvent>, controls: Consumer<Control>, shared: Arc<Shared>, wake: Thread) -> Self {
        shared.sample_rate.store(cfg.sample_rate as u32, Ordering::Relaxed);
        GuitarPipeline {
            period_us_per_frame: 1e6 / cfg.sample_rate,
            engine: GuitarEngine::new(cfg),
            events,
            controls,
            shared,
            mono: vec![0.0; MAX_CHUNK],
            channel,
            wake,
            calls: 0,
            cal: None,
            cal_levels: Vec::with_capacity(CAL_CAPACITY),
        }
    }

    pub fn engine(&self) -> &GuitarEngine {
        &self.engine
    }

    /// One device buffer of interleaved samples of any type the backend delivers.
    pub fn process_interleaved<T>(&mut self, data: &[T], channels: usize)
    where
        T: Copy,
        f32: cpal::FromSample<T>,
    {
        let started = Instant::now();
        let channels = channels.max(1);
        let channel = self.channel.min(channels - 1);
        let frames = data.len() / channels;

        while let Ok(c) = self.controls.pop() {
            match c {
                Control::Tunables(t) => self.engine.set_tunables(&t),
                Control::Calibrate { playing, seconds } => {
                    self.cal_levels.clear();
                    let frames = (seconds.clamp(0.5, 60.0) * self.engine.config().sample_rate) as u64;
                    self.cal = Some(CalRun { playing, frames_left: frames, frames_since_sample: 0 });
                    let state = if playing { CalState::ListeningToPlaying } else { CalState::ListeningToSilence };
                    self.shared.cal_state.store(state as u32, Ordering::Release);
                }
                Control::ReleaseAll => {
                    let mut sink = QueueSink { producer: &mut self.events, shared: &self.shared, pushed: false };
                    self.engine.release_all(&mut sink);
                    if sink.pushed {
                        self.wake.unpark();
                    }
                }
            }
        }

        let mut done = 0;
        let mut pushed = false;
        while done < frames {
            let n = (frames - done).min(MAX_CHUNK);
            for i in 0..n {
                self.mono[i] = <f32 as cpal::FromSample<T>>::from_sample_(data[(done + i) * channels + channel]);
            }
            let mut sink = QueueSink { producer: &mut self.events, shared: &self.shared, pushed: false };
            self.engine.process(&self.mono[..n], &mut sink);
            pushed |= sink.pushed;
            done += n;
        }

        self.calibrate_step(frames as u64);

        let peak = self.engine.take_peak();
        self.shared.input_peak.fetch_max(peak);
        if peak >= CLIP_LEVEL {
            self.shared.clipped.store(true, Ordering::Relaxed);
        }
        self.shared.publish(&self.engine.diagnostics(), self.engine.position());
        self.shared.buffer_frames.store(frames as u32, Ordering::Relaxed);

        if pushed {
            self.wake.unpark();
        }

        let took_us = started.elapsed().as_secs_f32() * 1e6;
        let budget_us = frames as f32 * self.period_us_per_frame;
        self.calls += 1;
        self.shared.callbacks.store(self.calls, Ordering::Relaxed);
        if took_us > budget_us {
            self.shared.overruns.fetch_add(1, Ordering::Relaxed);
        }
        self.shared.max_callback_us.fetch_max(took_us as u32, Ordering::Relaxed);
        let mean = self.shared.mean_callback_us.load();
        self.shared.mean_callback_us.store(mean + (took_us - mean) * 0.02);
    }

    /// Collects level readings while calibrating, and finishes the measurement on this thread: it is a
    /// max and a scan over a preallocated buffer, so it does not allocate.
    fn calibrate_step(&mut self, frames: u64) {
        let Some(run) = self.cal.as_mut() else { return };
        run.frames_since_sample += frames;
        let step_frames = (CAL_STEP_MS / 1000.0 * self.engine.config().sample_rate) as u64;
        if run.frames_since_sample >= step_frames.max(1) {
            run.frames_since_sample = 0;
            if self.cal_levels.len() < CAL_CAPACITY {
                self.cal_levels.push(self.engine.diagnostics().level_db);
            }
        }
        run.frames_left = run.frames_left.saturating_sub(frames);
        if run.frames_left > 0 {
            return;
        }
        let playing = run.playing;
        self.cal = None;
        let cfg = self.engine.config();
        if playing {
            match velocity_range_from_levels(&self.cal_levels, CAL_STEP_MS, cfg.gate_open_db) {
                Some((floor, ceil)) => {
                    self.shared.cal_a.store(floor);
                    self.shared.cal_b.store(ceil);
                    self.shared.cal_state.store(CalState::PlayingDone as u32, Ordering::Release);
                }
                None => self.shared.cal_state.store(CalState::Failed as u32, Ordering::Release),
            }
        } else if self.cal_levels.len() < 4 {
            self.shared.cal_state.store(CalState::Failed as u32, Ordering::Release);
        } else {
            let (open, close) = gate_from_levels(&self.cal_levels, cfg);
            self.shared.cal_a.store(open);
            self.shared.cal_b.store(close);
            self.shared.cal_state.store(CalState::SilenceDone as u32, Ordering::Release);
        }
    }

    /// Feeds mono `f32` samples: the shape a synthetic recording has.
    pub fn process_mono(&mut self, samples: &[f32]) {
        self.process_interleaved(samples, 1);
    }
}
