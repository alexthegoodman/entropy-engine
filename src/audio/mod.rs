use std::sync::{Arc, Mutex};
use fundsp::prelude::*;
use rodio::{OutputStream, OutputStreamBuilder, Sink, Source};

// A wrapper to make fundsp nodes compatible with rodio::Source
struct FundspSource<N>
where
    N: AudioUnit,
{
    node: N,
    sample_rate: f32,
}

impl<N> Iterator for FundspSource<N>
where
    N: AudioUnit,
{
    type Item = f32;

    fn next(&mut self) -> Option<Self::Item> {
        let mut output = [0.0f32; 2]; // Stereo output buffer
        self.node.tick(&[], &mut output);
        Some(output[0]) // Return left channel
    }
}

impl<N> Source for FundspSource<N>
where
    N: AudioUnit,
{
    fn current_span_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        1
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate as u32
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

pub struct AudioEngine {
    // _stream: OutputStream,
    stream_handle: rodio::OutputStream,
    sink: Arc<Mutex<Sink>>,
}

impl AudioEngine {
    pub fn new() -> Self {
        let stream_handle = OutputStreamBuilder::open_default_stream().expect("Failed to create audio stream");
        let mixer = stream_handle.mixer();
        let sink = Sink::connect_new(mixer);
        
        AudioEngine {
            // _stream,
            stream_handle,
            sink: Arc::new(Mutex::new(sink)),
        }
    }

    pub fn play_test_tone(&self) {
        let source = rodio::source::SineWave::new(440.0)
            .take_duration(std::time::Duration::from_secs_f32(0.5))
            .amplify(0.20);
            
        self.sink.lock().unwrap().append(source);
    }

    pub fn play_synth(&self, freq: f64, waveform: &str, duration: f64, cutoff: f64, gain: f64) {
        println!("Play synth");

        let sample_rate = 44100.0f32;
        
        // Convert f64 parameters to f32 for fundsp
        let freq = freq as f32;
        let cutoff = cutoff as f32;
        let gain = gain as f32;
        
        match waveform {
            "square" => {
                let mut node = square_hz(freq) >> lowpass_hz(cutoff, 1.0) * gain;
                node.set_sample_rate(sample_rate as f64);
                node.reset();
                
                let source = FundspSource { node, sample_rate };
                let finite_source = source.take_duration(std::time::Duration::from_secs_f64(duration));
                self.sink.lock().unwrap().append(finite_source);
            },
            "saw" => {
                let mut node = saw_hz(freq) >> lowpass_hz(cutoff, 1.0) * gain;
                node.set_sample_rate(sample_rate as f64);
                node.reset();
                
                let source = FundspSource { node, sample_rate };
                let finite_source = source.take_duration(std::time::Duration::from_secs_f64(duration));
                self.sink.lock().unwrap().append(finite_source);
            },
            "noise" => {
                let mut node = noise() >> lowpass_hz(cutoff, 1.0) * gain;
                node.set_sample_rate(sample_rate as f64);
                node.reset();
                
                let source = FundspSource { node, sample_rate };
                let finite_source = source.take_duration(std::time::Duration::from_secs_f64(duration));
                self.sink.lock().unwrap().append(finite_source);
            },
            _ => {
                let mut node = sine_hz::<f32>(freq) >> lowpass_hz(cutoff, 1.0) * gain;
                node.set_sample_rate(sample_rate as f64);
                node.reset();
                
                let source = FundspSource { node, sample_rate };
                let finite_source = source.take_duration(std::time::Duration::from_secs_f64(duration));
                self.sink.lock().unwrap().append(finite_source);
            }
        }
    }
}