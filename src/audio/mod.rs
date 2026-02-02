// use std::sync::{Arc, Mutex};
// use fundsp::prelude::*;
// use rodio::{OutputStream, Sink, Source};

// // A wrapper to make fundsp nodes compatible with rodio::Source
// struct FundspSource {
//     // Box<dyn AudioUnit64> is the generic audio node type in fundsp
//     node: Box<dyn AudioUnit64>,
//     sample_rate: f64,
// }

// impl Iterator for FundspSource {
//     type Item = f32;

//     fn next(&mut self) -> Option<Self::Item> {
//         // get_stereo returns (f64, f64), we mix to mono for this simple implementation
//         // or just take left channel
//         let (l, _r) = self.node.get_stereo();
//         Some(l as f32)
//     }
// }

// impl Source for FundspSource {
//     fn current_span_len(&self) -> Option<usize> {
//         None // Infinite
//     }

//     fn channels(&self) -> u16 {
//         1 // Mono for now
//     }

//     fn sample_rate(&self) -> u32 {
//         self.sample_rate as u32
//     }

//     fn total_duration(&self) -> Option<std::time::Duration> {
//         None
//     }
// }

// pub struct AudioEngine {
//     _stream: OutputStream,
//     stream_handle: rodio::OutputStream,
//     sink: Arc<Mutex<Sink>>,
// }

// impl AudioEngine {
//     pub fn new() -> Self {
//         let (_stream, stream_handle) = OutputStream::try_default().expect("Failed to create audio stream");
//         let sink = Sink::try_new(&stream_handle).expect("Failed to create sink");
        
//         AudioEngine {
//             _stream,
//             stream_handle,
//             sink: Arc::new(Mutex::new(sink)),
//         }
//     }

//     pub fn play_test_tone(&self) {
//         let source = rodio::source::SineWave::new(440.0)
//             .take_duration(std::time::Duration::from_secs_f32(0.5))
//             .amplify(0.20);
            
//         self.sink.lock().unwrap().append(source);
//     }

//     // Play a synth sound defined by parameters
//     pub fn play_synth(&self, freq: f64, waveform: &str, duration: f64, cutoff: f64, gain: f64) {
//         let sample_rate = 44100.0;
        
//         // Define the sound network using fundsp
//         // c = constant (frequency)
//         // sine(), square(), etc are oscillators
//         let mut node = match waveform {
//             "square" => {
//                 Box::new(lfo(move |_| freq) >> square() >> lowpass_hz(cutoff, 1.0) * gain) as Box<dyn AudioUnit64>
//             },
//             "saw" => {
//                 Box::new(lfo(move |_| freq) >> saw() >> lowpass_hz(cutoff, 1.0) * gain) as Box<dyn AudioUnit64>
//             },
//             "noise" => {
//                  Box::new(white() >> lowpass_hz(cutoff, 1.0) * gain) as Box<dyn AudioUnit64>
//             },
//             _ => { // sine default
//                 Box::new(sine_hz(freq) >> lowpass_hz(cutoff, 1.0) * gain) as Box<dyn AudioUnit64>
//             }
//         };

//         // Reset sample rate
//         node.reset(Some(sample_rate));

//         let source = FundspSource {
//             node,
//             sample_rate,
//         };

//         // Enveloping via rodio for simplicity (take_duration)
//         // In a real DAW we'd use ADSR in fundsp
//         let finite_source = source
//             .take_duration(std::time::Duration::from_secs_f64(duration));

//         self.sink.lock().unwrap().append(finite_source);
//     }
// }

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
        let sink = Sink::new();
        
        AudioEngine {
            // _stream,
            stream_handle,
            sink: Arc::new(Mutex::new(sink.0)),
        }
    }

    pub fn play_test_tone(&self) {
        let source = rodio::source::SineWave::new(440.0)
            .take_duration(std::time::Duration::from_secs_f32(0.5))
            .amplify(0.20);
            
        self.sink.lock().unwrap().append(source);
    }

    pub fn play_synth(&self, freq: f64, waveform: &str, duration: f64, cutoff: f64, gain: f64) {
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