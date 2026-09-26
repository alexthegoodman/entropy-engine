//! The reel's mix: each part's level and hall send, a fader ride for the kit's soft intro rolls, a
//! convolution hall (a synthetic impulse response: early reflections, then a noise tail whose highs
//! die faster), and a look-ahead peak limiter on the bus. Also what the picture reads of the mix:
//! its level and a 24-band spectrum at every video frame.

use realfft::RealFftPlanner;
use serde_json::json;

const SR: usize = 44_100;
const FRAMES: usize = 900;
const SPF: usize = 735;

/// (part, level dB, hall send).
const MIX: [(&str, f32, f32); 11] = [
    ("tbn1", -4.0, 0.28),
    ("tbn2", -6.0, 0.30),
    ("tuba", -9.0, 0.24),
    ("hn1", -3.0, 0.38),
    ("hn2", -5.0, 0.38),
    ("tpt1", -8.0, 0.30),
    ("tpt2", -9.0, 0.30),
    ("violin", -8.0, 0.34),
    ("cello", -13.0, 0.20),
    ("bass", -12.0, 0.16),
    ("kit", -24.0, 0.14),
];
/// Fader rides, (seconds, dB): the kit's mallet and tom rolls into the first hit are ~30 dB below
/// its hits, as they would be in the room; the mix brings them up.
const KIT_RIDE: [(f32, f32); 3] = [(0.0, 12.0), (2.40, 12.0), (2.47, 0.0)];
/// Drive into the limiter (the loudest peak goes this far over the ceiling), and the ceiling.
const DRIVE_DB: f32 = 5.5;
const CEILING_DB: f32 = -1.0;

fn db(x: f32) -> f32 {
    10f32.powf(x / 20.0)
}

fn ride(keys: &[(f32, f32)], t: f32) -> f32 {
    if t <= keys[0].0 {
        return keys[0].1;
    }
    for w in keys.windows(2) {
        if t <= w[1].0 {
            return w[0].1 + (w[1].1 - w[0].1) * (t - w[0].0) / (w[1].0 - w[0].0);
        }
    }
    keys[keys.len() - 1].1
}

/// xorshift64*, and normals by Box-Muller: the hall is the same on every run.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
    fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.next()
    }
    fn normal(&mut self) -> f64 {
        let (u, v) = (self.next().max(1e-12), self.next());
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    }
}

/// A second-order Butterworth low- or high-pass (RBJ cookbook), run in place.
fn biquad(x: &mut [f64], f0: f64, high: bool) {
    let w = std::f64::consts::TAU * f0 / SR as f64;
    let (s, c) = w.sin_cos();
    // alpha = sin(w0) / 2Q, Q = 1/sqrt(2) for Butterworth.
    let alpha = s / (2.0 * std::f64::consts::FRAC_1_SQRT_2);
    let a0 = 1.0 + alpha;
    let (b0, b1, b2) = if high { ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0) } else { ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0) };
    let (a1, a2) = (-2.0 * c, 1.0 - alpha);
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    for v in x.iter_mut() {
        let y = (b0 * *v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
        x2 = x1;
        x1 = *v;
        y2 = y1;
        y1 = y;
        *v = y;
    }
}

/// The hall's impulse response, stereo, normalised to unit energy.
fn hall_ir(seconds: f64, rt60: f64, seed: u64) -> [Vec<f32>; 2] {
    let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
    let n = (seconds * SR as f64) as usize;
    let pre = (0.018 * SR as f64) as usize;
    let mut ir = [vec![0.0f64; n], vec![0.0f64; n]];
    // Early reflections.
    for _ in 0..18 {
        let d = pre + (rng.uniform(0.002, 0.075) * SR as f64) as usize;
        let g = 0.55 * (-3.0 * d as f64 / SR as f64 / 0.35).exp() * rng.uniform(0.4, 1.0);
        let sign = |r: &mut Rng| if r.next() < 0.5 { -1.0 } else { 1.0 };
        ir[0][d] += g * sign(&mut rng);
        let d2 = (d + (rng.uniform(0.0, 0.004) * SR as f64) as usize).min(n - 1);
        ir[1][d2] += g * sign(&mut rng);
    }
    // The tail: noise in bands, each decaying at its own rate.
    let bands = [(20.0, 250.0, 1.15), (250.0, 1000.0, 1.0), (1000.0, 4000.0, 0.78), (4000.0, 16000.0, 0.5)];
    for ch in &mut ir {
        let noise: Vec<f64> = (0..n).map(|_| rng.normal()).collect();
        let mut tail = vec![0.0f64; n];
        for &(lo, hi, f) in &bands {
            let mut b = noise.clone();
            biquad(&mut b, lo, true);
            biquad(&mut b, hi, false);
            for (i, v) in b.iter().enumerate() {
                tail[i] += v * (-6.91 * i as f64 / SR as f64 / (rt60 * f)).exp();
            }
        }
        for (i, v) in tail.iter().enumerate() {
            let t = i as f64 / SR as f64;
            let onset = ((t - pre as f64 / SR as f64 - 0.012) / 0.06).clamp(0.0, 1.0).powi(2);
            ch[i] += 0.16 * v * onset;
        }
    }
    let energy = 0.5 * ir.iter().map(|c| c.iter().map(|v| v * v).sum::<f64>()).sum::<f64>();
    let k = 1.0 / energy.sqrt();
    [ir[0].iter().map(|v| (v * k) as f32).collect(), ir[1].iter().map(|v| (v * k) as f32).collect()]
}

/// Linear convolution by one large FFT, truncated to the signal's length.
fn convolve(x: &[f32], h: &[f32]) -> Vec<f32> {
    let m = (x.len() + h.len()).next_power_of_two();
    let mut planner = RealFftPlanner::<f32>::new();
    let fwd = planner.plan_fft_forward(m);
    let inv = planner.plan_fft_inverse(m);
    let spectrum = |v: &[f32]| {
        let mut buf = vec![0.0f32; m];
        buf[..v.len()].copy_from_slice(v);
        let mut out = fwd.make_output_vec();
        fwd.process(&mut buf, &mut out).unwrap();
        out
    };
    let (a, b) = (spectrum(x), spectrum(h));
    let mut prod: Vec<_> = a.iter().zip(&b).map(|(p, q)| p * q).collect();
    let mut y = vec![0.0f32; m];
    inv.process(&mut prod, &mut y).unwrap();
    y.truncate(x.len());
    y.iter().map(|v| v / m as f32).collect()
}

/// Mixes the stems (interleaved stereo) into `dir/mix.wav` (16-bit, the picture's length) and
/// writes `dir/mix_env.json`. Returns the mix.
pub fn mix(dir: &str, stems: &[(&str, &[f32])]) -> Vec<f32> {
    let n = stems.iter().map(|s| s.1.len() / 2).min().unwrap_or(0);
    let (mut dry, mut send) = ([vec![0.0f32; n], vec![0.0f32; n]], [vec![0.0f32; n], vec![0.0f32; n]]);
    for &(name, audio) in stems {
        let Some(&(_, level, s)) = MIX.iter().find(|m| m.0 == name) else { continue };
        let g = db(level);
        for i in 0..n {
            let r = if name == "kit" { db(ride(&KIT_RIDE, i as f32 / SR as f32)) } else { 1.0 };
            for c in 0..2 {
                let v = audio[2 * i + c] * g * r;
                dry[c][i] += v;
                send[c][i] += v * s;
            }
        }
    }
    let ir = hall_ir(3.2, 2.3, 7);
    let wet = [convolve(&send[0], &ir[0]), convolve(&send[1], &ir[1])];
    let mut mix: Vec<[f32; 2]> = (0..n).map(|i| [dry[0][i] + wet[0][i], dry[1][i] + wet[1][i]]).collect();
    let peak = mix.iter().fold(0.0f32, |m, v| m.max(v[0].abs()).max(v[1].abs()));
    let ceiling = db(CEILING_DB);
    let drive = db(DRIVE_DB) * ceiling / peak.max(1e-9);
    // Look-ahead limiter: each sample takes the smallest gain the next 4 ms need; 90 ms release.
    let look = (0.004 * SR as f32) as usize;
    let need: Vec<f32> = mix.iter().map(|v| (ceiling / (v[0].abs().max(v[1].abs()) * drive).max(1e-12)).min(1.0)).collect();
    let mut gain = vec![1.0f32; n];
    let mut window: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    for i in (0..n).rev() {
        // Minimum of need[i ..= i + look] by a monotonic deque, walking backwards.
        while window.back().is_some_and(|&j| need[j] >= need[i]) {
            window.pop_back();
        }
        window.push_back(i);
        while window.front().is_some_and(|&j| j > i + look) {
            window.pop_front();
        }
        gain[i] = need[*window.front().unwrap()];
    }
    let rel = (-1.0 / (0.09 * SR as f32)).exp();
    let mut g = 1.0f32;
    for (i, v) in mix.iter_mut().enumerate() {
        g = if gain[i] < g { gain[i] } else { gain[i] + (g - gain[i]) * rel };
        let t = i as f32 / SR as f32;
        let fade = (1.0 - (t - 14.55) / 0.45).clamp(0.0, 1.0);
        v[0] *= drive * g * fade;
        v[1] *= drive * g * fade;
    }
    mix.truncate(FRAMES * SPF);
    let flat: Vec<f32> = mix.iter().flat_map(|v| [v[0], v[1]]).collect();
    let spec = hound::WavSpec { channels: 2, sample_rate: SR as u32, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(format!("{dir}/mix.wav"), spec).expect("mix.wav");
    for s in &flat {
        w.write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16).unwrap();
    }
    w.finalize().unwrap();
    write_env(dir, &mix);
    flat
}

/// The mix as the picture reads it: level, and a 24-band spectrum (40 Hz - 16 kHz, tilted +3 dB
/// per octave as analysers are, 60 dB of range) at every frame.
fn write_env(dir: &str, mix: &[[f32; 2]]) {
    let rms: Vec<f32> = (0..FRAMES).map(|f| (mix[f * SPF..(f + 1) * SPF].iter().map(|v| v[0] * v[0] + v[1] * v[1]).sum::<f32>() / (2 * SPF) as f32).sqrt()).collect();
    let (win, nfft) = (2048usize, 8192usize);
    let hann: Vec<f32> = (0..win).map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (win - 1) as f32).cos()).collect();
    let edges: Vec<f32> = (0..=24).map(|k| 40.0 * (16000.0f32 / 40.0).powf(k as f32 / 24.0)).collect();
    let bin = |hz: f32| ((hz * nfft as f32 / SR as f32).ceil() as usize).min(nfft / 2);
    let bands: Vec<(usize, usize)> = (0..24).map(|k| { let (lo, hi) = (bin(edges[k]), bin(edges[k + 1])); (lo, hi.max(lo + 1)) }).collect();
    let fft = RealFftPlanner::<f32>::new().plan_fft_forward(nfft);
    let mut spec = Vec::with_capacity(FRAMES);
    for f in 0..FRAMES {
        let c = f * SPF + SPF / 2;
        let mut buf = vec![0.0f32; nfft];
        for i in 0..win {
            let j = (c + i).checked_sub(win / 2);
            if let Some(v) = j.and_then(|j| mix.get(j)) {
                buf[i] = 0.5 * (v[0] + v[1]) * hann[i];
            }
        }
        let mut out = fft.make_output_vec();
        fft.process(&mut buf, &mut out).unwrap();
        let row: Vec<f32> = bands
            .iter()
            .enumerate()
            .map(|(k, &(lo, hi))| {
                let p = out[lo..hi].iter().map(|z| z.norm_sqr()).sum::<f32>() / (hi - lo) as f32;
                10.0 * (p + 1e-12).log10() + 3.0 * ((edges[k] * edges[k + 1]).sqrt() / 1000.0).log2()
            })
            .collect();
        spec.push(row);
    }
    let mut all: Vec<f32> = spec.iter().flatten().copied().collect();
    all.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let top = all[((all.len() - 1) as f32 * 0.995) as usize];
    let r3 = |v: f32| (v as f64 * 1000.0).round() / 1000.0;
    let spec: Vec<Vec<f64>> = spec.iter().map(|row| row.iter().map(|v| r3(((v - (top - 60.0)) / 60.0).clamp(0.0, 1.0))).collect()).collect();
    let rms: Vec<f64> = rms.iter().map(|v| (*v as f64 * 1e5).round() / 1e5).collect();
    std::fs::write(format!("{dir}/mix_env.json"), serde_json::to_string(&json!({"rms": rms, "spec": spec})).unwrap()).unwrap();
}
