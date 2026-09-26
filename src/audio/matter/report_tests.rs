//! Reports (ignored): they print the numbers, and write the pictures, that the Indie Machine drums
//! and cymbals post quotes. They assert almost nothing; the claims that are tests live in `tests`,
//! `cymbal_tests` and `kit_tests`. Run one with
//!
//! ```text
//! cargo test --release --lib matter::report_tests::matter_modal_report -- --ignored --nocapture
//! ```
//!
//! Names: `matter_modal_report`, `matter_contact_report`, `matter_membrane_report`,
//! `matter_glide_report`, `matter_drums_report`, `matter_plate_report`, `matter_cymbal_report`,
//! `matter_kit_report`. Pictures land in `test-artifacts/matter-report/`. Every report starts by
//! printing the build profile: timings from a debug build mean nothing.

use super::contact::*;
use super::cymbal::*;
use super::drum::*;
use super::kit::*;
use super::membrane::*;
use super::modal::*;
use super::plate::*;
use super::tests::{above, centroid, cents, db, peak, rms, secs};
use super::{bessel, render_cymbal, render_hit};
use crate::audio::physmod::analysis::spectrum;
use std::f64::consts::PI;
use std::time::Instant;

const SR: f32 = 44_100.0;

fn profile() -> &'static str {
    if cfg!(debug_assertions) { "debug" } else { "release" }
}

fn art_dir() -> std::path::PathBuf {
    let d = std::env::current_dir().unwrap().join("test-artifacts").join("matter-report");
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ---------------------------------------------------------------- svg

fn svg_start(w: f32, h: f32) -> String {
    format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" font-family=\"sans-serif\"><rect width=\"100%\" height=\"100%\" fill=\"#f7f6f2\"/>")
}

fn svg_save(mut svg: String, name: &str) {
    svg.push_str("</svg>");
    let path = art_dir().join(name);
    std::fs::write(&path, svg).unwrap();
    println!("wrote {}", path.display());
}

fn svg_text(svg: &mut String, x: f32, y: f32, size: f32, anchor: &str, fill: &str, bold: bool, s: &str) {
    svg.push_str(&format!("<text x=\"{x:.1}\" y=\"{y:.1}\" font-size=\"{size}\" fill=\"{fill}\" text-anchor=\"{anchor}\"{}>{s}</text>", if bold { " font-weight=\"bold\"" } else { "" }));
}

struct Axes {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    xr: (f32, f32),
    yr: (f32, f32),
}

impl Axes {
    fn px(&self, v: f32) -> f32 {
        self.x + (v - self.xr.0) / (self.xr.1 - self.xr.0) * self.w
    }
    fn py(&self, v: f32) -> f32 {
        self.y + self.h - (v - self.yr.0) / (self.yr.1 - self.yr.0) * self.h
    }
    fn frame(&self, svg: &mut String, title: &str, xlabel: &str, ylabel: &str, xt: &[(f32, String)], yt: &[(f32, String)]) {
        svg.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" fill=\"#ffffff\" stroke=\"#c9c4b8\"/>", self.x, self.y, self.w, self.h));
        for (v, l) in xt {
            let x = self.px(*v);
            svg.push_str(&format!("<line x1=\"{x:.1}\" y1=\"{}\" x2=\"{x:.1}\" y2=\"{}\" stroke=\"#ece8de\"/>", self.y, self.y + self.h));
            svg_text(svg, x, self.y + self.h + 13.0, 10.0, "middle", "#55524a", false, l);
        }
        for (v, l) in yt {
            let y = self.py(*v);
            svg.push_str(&format!("<line x1=\"{}\" y1=\"{y:.1}\" x2=\"{}\" y2=\"{y:.1}\" stroke=\"#ece8de\"/>", self.x, self.x + self.w));
            svg_text(svg, self.x - 4.0, y + 3.0, 10.0, "end", "#55524a", false, l);
        }
        svg_text(svg, self.x, self.y - 8.0, 13.0, "start", "#2a2925", true, title);
        svg_text(svg, self.x + self.w * 0.5, self.y + self.h + 28.0, 11.0, "middle", "#55524a", false, xlabel);
        svg.push_str(&format!("<text transform=\"translate({},{}) rotate(-90)\" font-size=\"11\" fill=\"#55524a\" text-anchor=\"middle\">{ylabel}</text>", self.x - 40.0, self.y + self.h * 0.5));
    }
    fn line(&self, svg: &mut String, pts: &[(f32, f32)], color: &str, width: f32, dash: &str) {
        let p: Vec<String> = pts.iter().map(|&(x, y)| format!("{:.1},{:.1}", self.px(x).clamp(self.x, self.x + self.w), self.py(y).clamp(self.y, self.y + self.h))).collect();
        svg.push_str(&format!("<polyline points=\"{}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"{width}\" stroke-dasharray=\"{dash}\"/>", p.join(" ")));
    }
    fn vline(&self, svg: &mut String, x: f32, color: &str, dash: &str) {
        let x = self.px(x);
        if x >= self.x && x <= self.x + self.w {
            svg.push_str(&format!("<line x1=\"{x:.1}\" y1=\"{}\" x2=\"{x:.1}\" y2=\"{}\" stroke=\"{color}\" stroke-dasharray=\"{dash}\"/>", self.y, self.y + self.h));
        }
    }
    fn dot(&self, svg: &mut String, x: f32, y: f32, r: f32, color: &str) {
        let (px, py) = (self.px(x), self.py(y));
        if px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h {
            svg.push_str(&format!("<circle cx=\"{px:.1}\" cy=\"{py:.1}\" r=\"{r}\" fill=\"{color}\"/>"));
        }
    }
}

fn ticks(from: f32, to: f32, step: f32, fmt: impl Fn(f32) -> String) -> Vec<(f32, String)> {
    let mut v = Vec::new();
    let mut t = from;
    while t <= to + 1.0e-4 {
        v.push((t, fmt(t)));
        t += step;
    }
    v
}

/// Ticks on a log10 axis at 1-2-5 steps between `lo` and `hi` (values, not logs); positions are log10.
fn log_ticks(lo: f32, hi: f32, fmt: impl Fn(f32) -> String) -> Vec<(f32, String)> {
    let mut v = Vec::new();
    let mut decade = 10f32.powf(lo.log10().floor());
    while decade <= hi {
        for m in [1.0f32, 2.0, 5.0] {
            let x = decade * m;
            if x >= lo * 0.999 && x <= hi * 1.001 {
                v.push((x.log10(), fmt(x)));
            }
        }
        decade *= 10.0;
    }
    v
}

const BLUE: &str = "#1f5f8b";
const RED: &str = "#b5462d";
const BROWN: &str = "#7a4b1e";
const GREEN: &str = "#3f7d4a";
const GREY: &str = "#8a867a";

struct Series {
    label: &'static str,
    color: &'static str,
    dash: &'static str,
    pts: Vec<(f32, f32)>,
    dots: bool,
}

fn series(label: &'static str, color: &'static str, pts: Vec<(f32, f32)>) -> Series {
    Series { label, color, dash: "", pts, dots: false }
}

/// One plot area with any number of series and a legend.
#[allow(clippy::too_many_arguments)]
fn chart(name: &str, title: &str, xlabel: &str, ylabel: &str, xr: (f32, f32), yr: (f32, f32), xt: &[(f32, String)], yt: &[(f32, String)], all: &[Series]) {
    chart_with(name, title, xlabel, ylabel, xr, yr, xt, yt, all, false)
}

#[allow(clippy::too_many_arguments)]
fn chart_with(name: &str, title: &str, xlabel: &str, ylabel: &str, xr: (f32, f32), yr: (f32, f32), xt: &[(f32, String)], yt: &[(f32, String)], all: &[Series], bottom: bool) {
    let mut svg = svg_start(720.0, 400.0);
    let ax = Axes { x: 70.0, y: 34.0, w: 620.0, h: 300.0, xr, yr };
    ax.frame(&mut svg, title, xlabel, ylabel, xt, yt);
    for s in all {
        if s.dots {
            for &(x, y) in &s.pts {
                ax.dot(&mut svg, x, y, 3.0, s.color);
            }
        } else {
            ax.line(&mut svg, &s.pts, s.color, 1.8, s.dash);
        }
    }
    for (i, s) in all.iter().enumerate() {
        let y = if bottom { ax.y + ax.h - 12.0 - 15.0 * (all.len() - 1 - i) as f32 } else { ax.y + 16.0 + 15.0 * i as f32 };
        let x = if bottom { ax.x + 14.0 } else { ax.x + ax.w - 250.0 };
        svg.push_str(&format!("<rect x=\"{}\" y=\"{}\" width=\"250\" height=\"15\" fill=\"#ffffff\" opacity=\"0.8\"/>", x - 4.0, y - 11.0));
        svg.push_str(&format!("<line x1=\"{x}\" y1=\"{}\" x2=\"{}\" y2=\"{}\" stroke=\"{}\" stroke-width=\"2\" stroke-dasharray=\"{}\"/>", y - 3.0, x + 22.0, y - 3.0, s.color, s.dash));
        svg_text(&mut svg, x + 28.0, y, 11.0, "start", "#2a2925", false, s.label);
    }
    svg_save(svg, name);
}

// ---------------------------------------------------------------- helpers

/// Frequency of a decaying sinusoid from its upward zero crossings (linear interpolation), Hz.
fn crossing_freq(x: &[f32], sr: f32) -> f64 {
    let (mut first, mut last, mut n) = (0.0f64, 0.0f64, 0usize);
    for i in 1..x.len() {
        if x[i - 1] <= 0.0 && x[i] > 0.0 {
            let t = (i - 1) as f64 + (-x[i - 1] as f64) / ((x[i] - x[i - 1]) as f64);
            if n == 0 {
                first = t;
            }
            last = t;
            n += 1;
        }
    }
    (n - 1) as f64 / (last - first) * sr as f64
}

/// The plain two-pole recurrence for a damped oscillator, coefficients rounded to `f32` and run in
/// `f32`: what a mode would be without the rotated state.
fn two_pole_f32(freq: f32, sigma: f32, n: usize) -> Vec<f32> {
    let h = 1.0 / SR as f64;
    let wd = ((2.0 * PI * freq as f64).powi(2) - (sigma as f64).powi(2)).sqrt();
    let r = (-(sigma as f64) * h).exp();
    let a1 = (2.0 * r * (wd * h).cos()) as f32;
    let a2 = (-r * r) as f32;
    let (mut y2, mut y1) = (0.0f32, (r * (wd * h).sin()) as f32);
    let mut out = vec![0.0f32; n];
    out[1] = y1;
    for o in out.iter_mut().skip(2) {
        let y = a1 * y1 + a2 * y2;
        y2 = y1;
        y1 = y;
        *o = y;
    }
    out
}

fn rotated(freq: f32, sigma: f32, n: usize) -> Vec<f32> {
    let mut b = ModalBody::new(&[ModeSpec { freq, sigma, mass: 0.1, radiation: 1.0 }], SR);
    b.add_modal_force(0, 100.0);
    (0..n)
        .map(|_| {
            b.step();
            b.q(0)
        })
        .collect()
}

/// Third-octave band energies, dB, from 100 Hz by steps of 1.26 (the bands the cymbal tests use).
fn bands(x: &[f32]) -> Vec<f32> {
    let (m, bin) = spectrum(x, SR);
    let mut out = Vec::new();
    let mut f = 100.0f32;
    while f < 16_000.0 {
        let (a, b) = ((f / bin) as usize, ((f * 1.26) / bin) as usize);
        out.push(10.0 * m[a..b.min(m.len())].iter().map(|v| v * v).sum::<f32>().max(1e-30).log10());
        f *= 1.26;
    }
    out
}

fn band_freqs() -> Vec<f32> {
    let mut v = Vec::new();
    let mut f = 100.0f32;
    while f < 16_000.0 {
        v.push(f * 1.12);
        f *= 1.26;
    }
    v
}

fn strike_of(spec: &DrumSpec, velocity: f32, position: f32) -> Strike {
    Strike { velocity, position, angle: 0.0, striker: spec.striker }
}

fn hit(spec: &DrumSpec, velocity: f32, position: f32) -> Vec<f32> {
    render_hit(spec, strike_of(spec, velocity, position), SR, 2.0)
}

fn at(spec: &CymbalSpec, velocity: f32, position: f32) -> Strike {
    Strike { velocity, position, angle: 0.0, striker: spec.striker }
}

/// A spectrum thinned to `points` log-spaced maxima between `lo` and `hi`: (log10 Hz, dB re `reference`).
fn log_spectrum(seg: &[f32], lo: f32, hi: f32, points: usize, reference: f32) -> Vec<(f32, f32)> {
    let (m, bin) = spectrum(seg, SR);
    let ratio = (hi / lo).powf(1.0 / points as f32);
    (0..points)
        .map(|i| {
            let (f0, f1) = (lo * ratio.powi(i as i32), lo * ratio.powi(i as i32 + 1));
            let (a, b) = ((f0 / bin) as usize, ((f1 / bin) as usize + 1).min(m.len() - 1));
            let top = m[a..=b].iter().fold(0.0f32, |acc, v| acc.max(*v));
            ((f0 * f1).sqrt().log10(), db(top / reference))
        })
        .collect()
}

fn max_spectrum(seg: &[f32]) -> f32 {
    spectrum(seg, SR).0.iter().fold(0.0f32, |m, v| m.max(*v))
}

// ---------------------------------------------------------------- 3.2 modal bodies and Bessel

#[test]
#[ignore]
fn matter_modal_report() {
    println!("profile: {}", profile());
    println!("\n## J_m(x) against tabulated values (reference values typed from tables)");
    for (m, x, want) in [(0u32, 1.0f64, 0.765_197_686_557_966_6), (1, 1.0, 0.440_050_585_744_933_5), (0, 10.0, -0.245_935_764_451_348_3), (2, 5.0, 0.046_565_116_277_752_2), (5, 10.0, -0.234_061_528_186_794_3)] {
        let got = bessel::jn(m, x);
        println!("J_{m}({x}) = {got:.12}  table {want:.12}  difference {:.1e}", (got - want).abs());
    }
    println!("\n## zeros of J_m against tables");
    for (m, n, want) in [(0u32, 1usize, 2.404_825_557_695_773f64), (1, 1, 3.831_705_970_207_512), (2, 1, 5.135_622_301_840_683), (0, 2, 5.520_078_110_286_311), (3, 1, 6.380_161_895_923_984), (0, 3, 8.653_727_912_911_012), (0, 10, 30.634_606_468_431_975), (1, 5, 16.470_630_050_877_634)] {
        let got = bessel::jn_zeros(m, n)[n - 1];
        println!("j_{{{m},{n}}} = {got:.12}  table {want:.12}  difference {:.1e}", (got - want).abs());
    }

    println!("\n## tuning in f32: rotated state against a plain two-pole recurrence (8 s at 44.1 kHz, sigma 0.05/s)");
    println!("freq Hz | rotated (cents) | two-pole f32 (cents)");
    let mut r_pts = Vec::new();
    let mut t_pts = Vec::new();
    for f in [10.0f32, 15.0, 22.9, 30.0, 60.0, 120.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0] {
        let n = (8.0 * SR) as usize;
        let a = cents(crossing_freq(&rotated(f, 0.05, n), SR) as f32, f);
        let b = cents(crossing_freq(&two_pole_f32(f, 0.05, n), SR) as f32, f);
        println!("{f:>6} | {a:+.3} | {b:+.3}");
        r_pts.push((f.log10(), a));
        t_pts.push((f.log10(), b));
    }
    let lo = t_pts.iter().chain(r_pts.iter()).fold(0.0f32, |m, p| m.min(p.1)).min(-1.0);
    let hi = t_pts.iter().chain(r_pts.iter()).fold(0.0f32, |m, p| m.max(p.1)).max(1.0);
    chart(
        "modal-tuning.svg",
        "Tuning error of one mode in f32, 44.1 kHz",
        "mode frequency, Hz",
        "error, cents",
        (10f32.log10() - 0.05, 4000f32.log10() + 0.05),
        (lo - 1.0, hi + 1.0),
        &log_ticks(10.0, 4000.0, |v| format!("{v}")),
        &ticks((lo - 1.0).ceil(), (hi + 1.0).floor(), ((hi - lo + 2.0) / 6.0).ceil().max(1.0), |v| format!("{v:+}")),
        &[Series { label: "rotated complex state (ModalBody)", color: BLUE, dash: "", pts: r_pts, dots: false }, Series { label: "two-pole recurrence, f32 coefficients", color: RED, dash: "", pts: t_pts, dots: false }],
    );

    println!("\n## a mode above Nyquist");
    let mut b = ModalBody::new(&[ModeSpec { freq: 25_000.0, sigma: 5.0, mass: 0.1, radiation: 1.0 }], SR);
    b.add_modal_force(0, 100.0);
    let out: f32 = (0..1000).map(|_| b.step().abs()).sum();
    println!("25 kHz mode at 44.1 kHz: summed |output| over 1000 samples = {out}");

    println!("\n## retuning a ringing mode (200 Hz -> 300 Hz by set_scale(1.5))");
    let mut b = ModalBody::new(&[ModeSpec { freq: 200.0, sigma: 0.0, mass: 0.1, radiation: 1.0 }], SR);
    b.add_modal_force(0, 50.0);
    for _ in 0..1000 {
        b.step();
    }
    let (q0, v0) = (b.q(0), b.q_dot(0));
    b.set_scale(1.5);
    println!("displacement before {q0:.6e} after {:.6e}; velocity before {v0:.6e} after {:.6e}", b.q(0), b.q_dot(0));
    let x: Vec<f32> = (0..SR as usize)
        .map(|_| {
            b.step();
            b.q(0)
        })
        .collect();
    println!("rings at {:.3} Hz afterwards ({:+.2} cents from 300)", crossing_freq(&x, SR), cents(crossing_freq(&x, SR) as f32, 300.0));
    let mut b = ModalBody::new(&[ModeSpec { freq: 200.0, sigma: 0.0, mass: 0.1, radiation: 1.0 }], SR);
    b.add_modal_force(0, 50.0);
    for _ in 0..1000 {
        b.step();
    }
    let e0 = b.energy();
    for i in 0..2000 {
        b.set_scale(1.0 + 0.5 * (i as f32 / 2000.0));
        b.step();
    }
    println!("energy 1000 samples in {e0:.4e} J; after a slow retune to 1.5x over 2000 samples {:.4e} J (adiabatic invariant: E/f should hold: {:.4e} vs {:.4e})", b.energy(), e0 / 200.0, b.energy() / 300.0);

    println!("\n## cost of the step: 400 modes, 60 Hz to 9 kHz, 1 s of audio, one thread");
    let specs: Vec<ModeSpec> = (0..400).map(|k| ModeSpec { freq: 60.0 * 1.012_637f32.powi(k), sigma: 5.0, mass: 0.1, radiation: 1.0 }).collect();
    let mut b = ModalBody::new(&specs, SR);
    for k in 0..400 {
        b.add_modal_force(k, 1.0);
    }
    let t = Instant::now();
    let mut acc = 0.0f32;
    for _ in 0..SR as usize {
        acc += b.step();
    }
    let el = t.elapsed().as_secs_f32();
    println!("{:.2}% of a core, {:.2} ns per mode per sample ({acc:.1e})", el * 100.0, el / (400.0 * SR) * 1e9);

    println!("\n## subnormals: 400 modes decaying at sigma 3/s, 40 s, with and without flush_quiet every 64 samples (seconds per 5 s slice)");
    for flush in [true, false] {
        let specs: Vec<ModeSpec> = (0..400).map(|k| ModeSpec { freq: 60.0 * 1.012_637f32.powi(k), sigma: 3.0, mass: 0.1, radiation: 1.0 }).collect();
        let mut b = ModalBody::new(&specs, SR);
        for k in 0..400 {
            b.add_modal_force(k, 100.0);
        }
        let mut row = Vec::new();
        let mut acc = 0.0f32;
        for slice in 0..8 {
            let t = Instant::now();
            for i in 0..(5.0 * SR) as usize {
                acc += b.step();
                if flush && i % 64 == 0 {
                    b.flush_quiet();
                }
            }
            row.push(format!("{:.2}", t.elapsed().as_secs_f32()));
            let _ = slice;
        }
        println!("flush {flush}: {} s ({acc:.1e}); energy left {:.1e} J", row.join(", "), b.energy());
    }
}

// ---------------------------------------------------------------- 3.3 contact

/// A striker against a rigid, fixed wall: (contact time, peak force, rebound speed).
fn against_wall(striker: Striker, law: ContactLaw, sr: f32) -> (f32, f32, f32) {
    let h = 1.0 / sr;
    let mut s = Striker { y: -striker.v * h * 2.37, ..striker };
    let mut c = Contact::new(law);
    let (mut t, mut peak) = (0usize, 0.0f32);
    for _ in 0..(sr as usize) {
        let (free, comp) = s.predict(h);
        let f = c.solve(free, comp, h);
        s.apply(f, h);
        if f > 0.0 {
            t += 1;
        }
        peak = peak.max(f);
        if s.v < 0.0 && c.touches > 0 && !c.touching {
            break;
        }
    }
    (t as f32 / sr, peak, -s.v)
}

/// The force pulse of one stroke on a cymbal at `sr`: (force per sample, contact time s, impulse N s, peak N).
fn bronze_pulse(spec: &CymbalSpec, v: f32, pos: f32, sr: f32) -> (Vec<f32>, f32, f32, f32) {
    let mut c = Cymbal::new(*spec, sr);
    c.strike(at(spec, v, pos));
    let mut f = Vec::new();
    for _ in 0..(0.02 * sr) as usize {
        c.next_sample();
        f.push(c.last_force);
    }
    let n = f.iter().filter(|&&x| x > 0.0).count();
    let peak = f.iter().fold(0.0f32, |m, v| m.max(*v));
    let impulse = f.iter().sum::<f32>() / sr;
    (f, n as f32 / sr, impulse, peak)
}

#[test]
#[ignore]
fn matter_contact_report() {
    println!("profile: {}", profile());
    let felt = Striker { mass: 0.03, tip: Tip::Felt { stiffness: 3.0e8, exponent: 2.5 }, y: 0.0, v: 2.0 };
    println!("\n## a 30 g felt mallet at 2 m/s on a film (e 0.8): the audio rate against a 4x finer step");
    let law = ContactLaw::between(felt.tip, Material::MYLAR, 0.8);
    for sr in [44_100.0f32, 88_200.0, 176_400.0, 705_600.0] {
        let (t, f, out) = against_wall(felt, law, sr);
        println!("sr {sr:>8}: contact {:.3} ms, peak {f:.1} N, rebound {out:.3} m/s", t * 1e3);
    }

    println!("\n## Hertz scaling: a 20 g steel ball (10 mm radius) on steel at 20 MHz");
    let tip = Tip::Solid { radius: 0.01, material: Material::STEEL };
    let law = ContactLaw::between(tip, Material::STEEL, 1.0);
    println!("K = {:.4e} N/m^1.5, alpha {}", law.k, law.alpha);
    let mut pts = Vec::new();
    let mut hertz = Vec::new();
    let (mut sx, mut sy, mut sxx, mut sxy, mut n) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for v in [0.25f32, 0.5, 1.0, 2.0, 4.0, 8.0, 16.0] {
        let (t, peak, out) = against_wall(Striker { mass: 0.02, tip, y: 0.0, v }, law, 20.0e6);
        let closed = 2.943 * (1.25f32 * 0.02 / law.k).powf(0.4) * v.powf(-0.2);
        println!("v {v:>5} m/s: contact {:.2} us, Hertz {:.2} us (ratio {:.3}), peak {peak:.0} N, rebound {out:.2} m/s", t * 1e6, closed * 1e6, t / closed);
        let (lx, ly) = ((v as f64).ln(), (t as f64).ln());
        sx += lx;
        sy += ly;
        sxx += lx * lx;
        sxy += lx * ly;
        n += 1.0;
        pts.push((v.log2(), t * 1e6));
        hertz.push((v.log2(), closed * 1e6));
    }
    let slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    println!("fitted exponent of contact time against speed: {slope:.4} (Hertz: -0.2)");
    let ymax = pts.iter().fold(0.0f32, |m, p| m.max(p.1)) * 1.1;
    chart(
        "contact-hertz.svg",
        "Contact time of a steel ball on steel against speed",
        "impact speed, m/s",
        "contact time, microseconds",
        (-2.2, 4.2),
        (0.0, ymax),
        &[(-2.0, "0.25".to_string()), (-1.0, "0.5".to_string()), (0.0, "1".to_string()), (1.0, "2".to_string()), (2.0, "4".to_string()), (3.0, "8".to_string()), (4.0, "16".to_string())],
        &ticks(0.0, ymax, (ymax / 6.0).ceil(), |v| format!("{v:.0}")),
        &[series("Hertz's closed form", GREY, hertz), Series { label: "solved contact, 20 MHz step", color: RED, dash: "", pts, dots: true }],
    );

    println!("\n## the coefficient of restitution (felt on film, 176.4 kHz, 2 m/s in)");
    for e in [0.3f32, 0.6, 0.9] {
        let law = ContactLaw { restitution: e, ..ContactLaw::between(felt.tip, Material::MYLAR, e) };
        let (t, _, out) = against_wall(felt, law, 176_400.0);
        println!("e {e}: rebound {:.3} m/s = {:.3} of the approach; contact {:.3} ms", out, out / 2.0, t * 1e3);
    }

    println!("\n## a stick (or shoulder) on bronze, 44.1 kHz against 176.4 kHz, striking at 0.6 of the radius");
    for (name, spec) in [("crash, shoulder", CymbalSpec::crash()), ("ride, stick bead", CymbalSpec::ride()), ("ride, yarn mallet", CymbalSpec { striker: StrikerSpec::yarn_mallet(), ..CymbalSpec::ride() })] {
        for v in [1.0f32, 5.0] {
            let (_, ta, ia, pa) = bronze_pulse(&spec, v, 0.6, 44_100.0);
            let (_, tb, ib, pb) = bronze_pulse(&spec, v, 0.6, 176_400.0);
            println!("{name} {v} m/s: contact {:.3} ms vs {:.3} ms ({:+.1}%), impulse {ia:.4} vs {ib:.4} N s ({:+.1}%), peak {pa:.0} vs {pb:.0} N (x{:.2})", ta * 1e3, tb * 1e3, (ta / tb - 1.0) * 100.0, (ia / ib - 1.0) * 100.0, pa / pb);
        }
    }
    let ride = CymbalSpec::ride();
    let (fa, ..) = bronze_pulse(&ride, 5.0, 0.6, 44_100.0);
    let (fb, ..) = bronze_pulse(&ride, 5.0, 0.6, 176_400.0);
    let win = |f: &[f32], sr: f32| -> Vec<(f32, f32)> { f.iter().enumerate().take((0.0016 * sr) as usize).map(|(i, v)| (i as f32 / sr * 1e3, *v)).collect() };
    let (pa, pb) = (win(&fa, 44_100.0), win(&fb, 176_400.0));
    let ymax = pb.iter().chain(pa.iter()).fold(0.0f32, |m, p| m.max(p.1)) * 1.1;
    chart(
        "contact-bronze.svg",
        "A 5 m/s stick on the ride: the same contact at two rates",
        "time from first touch, ms",
        "contact force, N",
        (0.0, 1.6),
        (0.0, ymax),
        &ticks(0.0, 1.6, 0.2, |v| format!("{v:.1}")),
        &ticks(0.0, ymax, (ymax / 5.0).ceil(), |v| format!("{v:.0}")),
        &[series("44.1 kHz (as the engine runs)", RED, pa), series("176.4 kHz", BLUE, pb)],
    );
}

// ---------------------------------------------------------------- 3.4 the membrane

#[test]
#[ignore]
fn matter_membrane_report() {
    println!("profile: {}", profile());
    let t = DrumSpec::timpani(130.81);
    let head_mass = t.batter.surface_density() * t.batter.area();
    println!("\n26 inch timpani, tuned to 130.81 Hz on (1,1): tension {:.0} N/m, head {:.4} kg ({:.3} mm of film, radius {} m)", t.batter.tension, head_mass, t.batter.thickness * 1e3, t.batter.radius);
    let mem = Membrane::new(t.batter, 40, 5000.0, true);
    let find = |m: u32, n: u32| *mem.modes.iter().find(|x| x.m == m && x.n == n).unwrap();
    let f11 = find(1, 1);
    println!("\n(m,n) | vacuum Hz | loaded Hz | air mass kg (one side) | t60 s | vacuum ratio to (1,1) | loaded ratio to (1,1)");
    for (m, n) in [(0u32, 1u32), (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (0, 2), (1, 2), (2, 2)] {
        let md = find(m, n);
        println!("({m},{n}) | {:.1} | {:.1} | {:.4} | {:.2} | {:.3} | {:.3}", md.vacuum_freq, md.freq, md.air_mass, md.spec.t60(), md.vacuum_freq / f11.vacuum_freq, md.freq / f11.freq);
    }
    println!("(0,1) air mass {:.4} kg against the head's {:.4} kg", find(0, 1).air_mass, head_mass);

    println!("\n## the ratios as rendered (peaks of a 2 m/s mallet stroke at 0.75 of the radius, 0.2 to 1.8 s)");
    let x = hit(&t, 2.0, 0.75);
    let seg = secs(&x, 0.2, 1.8);
    let (f11m, _) = peak(seg, 120.0, 140.0);
    println!("(1,1) sounds at {f11m:.2} Hz ({:+.1} cents from 130.81)", cents(f11m, 130.81));
    let rossing = [1.50f32, 1.97, 2.44];
    for (i, m) in [2u32, 3, 4].into_iter().enumerate() {
        let g = find(m, 1).freq;
        let (f, _) = peak(seg, g * 0.97, g * 1.03);
        println!("({m},1) rendered {:.2} Hz, ratio {:.3}; vacuum {:.3}; the doc's Rossing figure {:.2}", f, f / f11m, find(m, 1).vacuum_freq / f11.vacuum_freq, rossing[i]);
    }

    println!("\n## the thud dies before the note: level of each mode early (0-0.25 s) against late (0.75-1.0 s)");
    let level = |seg: &[f32], f: f32| peak(seg, f * 0.97, f * 1.03).1;
    let centre = hit(&t, 2.0, 0.0);
    let edge = hit(&t, 2.0, 0.75);
    // The kettle's air stiffens (0,1), so where it sounds is found from a centre stroke, which only
    // axisymmetric modes answer.
    let f01 = peak(secs(&centre, 0.02, 0.6), 50.0, 120.0).0;
    let f11l = find(1, 1).freq;
    println!("(0,1) sounds at {f01:.1} Hz in the drum (the membrane alone: {:.1} Hz; in vacuum {:.1} Hz)", find(0, 1).freq, find(0, 1).vacuum_freq);
    let (early, late) = (secs(&edge, 0.0, 0.25), secs(&edge, 0.75, 1.0));
    println!("edge stroke: (0,1) fell {:.1} dB, (1,1) fell {:.1} dB from 0-0.25 s to 0.75-1.0 s", db(level(early, f01) / level(late, f01)), db(level(early, f11l) / level(late, f11l)));
    let t60 = |seg_x: &[f32], f: f32| {
        // Level in 50 ms windows at the mode, and the time it takes to fall 20 dB, times three.
        let l: Vec<f32> = (0..30).map(|i| level(secs(seg_x, 0.02 + 0.05 * i as f32, 0.12 + 0.05 * i as f32), f)).collect();
        let fall = l.iter().position(|v| *v < l[0] * 0.1).map(|i| i as f32 * 0.05 * 3.0);
        fall
    };
    println!("time to fall 20 dB, times three (a rough T60): (0,1) {:?} s, (1,1) {:?} s", t60(&edge, f01), t60(&edge, f11l));

    println!("\n## centre strike against edge strike: the (1,1) level against (0,1)");
    let rel = |x: &[f32]| { let s = secs(x, 0.05, 1.05); db(level(s, f11l) / level(s, f01)) };
    println!("centre {:.1} dB, 0.75 of the radius {:.1} dB, difference {:.1} dB", rel(&centre), rel(&edge), rel(&edge) - rel(&centre));

    // The picture: the spectrum of the edge stroke, with the vacuum ratios, the loaded ones and the
    // harmonic series a timpanist tunes toward.
    let seg = secs(&edge, 0.2, 1.8);
    let reference = max_spectrum(seg);
    let pts = log_spectrum(seg, 60.0, 900.0, 900, reference);
    let mut svg = svg_start(720.0, 400.0);
    let ax = Axes { x: 70.0, y: 34.0, w: 620.0, h: 300.0, xr: (60f32.log10(), 900f32.log10()), yr: (-90.0, 3.0) };
    ax.frame(&mut svg, "Timpani stroke at 0.75 of the radius: spectrum and modes", "frequency, Hz", "level, dB re strongest", &log_ticks(60.0, 900.0, |v| format!("{v}")), &ticks(-90.0, 0.0, 15.0, |v| format!("{v:.0}")));
    ax.line(&mut svg, &pts, BLUE, 1.2, "");
    let f0 = f11.freq;
    for k in 1..=5 {
        let md = find(k, 1);
        ax.vline(&mut svg, md.vacuum_freq.log10(), GREY, "4 3");
        ax.vline(&mut svg, md.freq.log10(), RED, "");
        svg_text(&mut svg, ax.px(md.freq.log10()) + 3.0, ax.y + 12.0, 10.0, "start", RED, false, &format!("({k},1)"));
    }
    for r in [1.5f32, 2.0, 2.5] {
        ax.vline(&mut svg, (f0 * r).log10(), GREEN, "1 3");
    }
    ax.vline(&mut svg, f01.log10(), BROWN, "");
    svg_text(&mut svg, ax.px(f01.log10()) + 3.0, ax.y + 26.0, 10.0, "start", BROWN, false, "(0,1) with the kettle");
    svg_text(&mut svg, ax.x + 6.0, ax.y + ax.h - 34.0, 10.0, "start", RED, false, "red: loaded modes (air included)");
    svg_text(&mut svg, ax.x + 6.0, ax.y + ax.h - 20.0, 10.0, "start", GREY, false, "grey dashed: the same modes in a vacuum");
    svg_text(&mut svg, ax.x + 6.0, ax.y + ax.h - 6.0, 10.0, "start", GREEN, false, "green dotted: 1.5, 2 and 2.5 times the note");
    svg_save(svg, "timpani-spectrum.svg");
}

// ---------------------------------------------------------------- 3.5 tension modulation and the glide

/// How far (cents) the batter's (1,1) sounds above its settled pitch just after a hit, watched on
/// the head itself, on the drum with its resonant head off and its bottom open (as the test does).
fn glide_audio(spec: &DrumSpec, velocity: f32, position: f32) -> f32 {
    let spec = &DrumSpec { reso: None, volume: 0.0, ..*spec };
    let f = Membrane::new(spec.batter, spec.max_modes, 20_000.0, true).modes.iter().find(|x| x.m == 1 && x.n == 1).unwrap().freq;
    let mut d = Drum::new(*spec, SR);
    d.strike(strike_of(spec, velocity, position));
    let mem = d.head(0).unwrap();
    let mut watch = vec![0.0; mem.modes.len()];
    mem.shape_at(0.5, 0.0, &mut watch);
    let x: Vec<f32> = (0..(1.6 * SR) as usize)
        .map(|_| {
            d.next_sample();
            d.head_body(0).unwrap().displacement(&watch)
        })
        .collect();
    let (early, _) = peak(secs(&x, 0.005, 0.085), f * 0.97, f * 1.3);
    let (late, _) = peak(secs(&x, 0.8, 1.6), f * 0.97, f * 1.03);
    cents(early, late)
}

/// The model's own frequency scale after a hit, in cents above rest, every millisecond: `sqrt(T / T0)`.
fn tension_trace(spec: &DrumSpec, velocity: f32, position: f32, seconds: f32) -> Vec<(f32, f32)> {
    let spec = &DrumSpec { reso: None, volume: 0.0, ..*spec };
    let mut d = Drum::new(*spec, SR);
    let t0 = spec.batter.tension;
    d.strike(strike_of(spec, velocity, position));
    let mut out = Vec::new();
    for i in 0..(seconds * SR) as usize {
        d.next_sample();
        if i % 44 == 0 {
            out.push((i as f32 / SR, 600.0 * (d.head_tension(0) / t0).log2()));
        }
    }
    out
}

#[test]
#[ignore]
fn matter_glide_report() {
    println!("profile: {}", profile());
    println!("\n## floor tom, one head, open shell (a concert tom), struck at 0.5 of the radius: cents above the settled pitch");
    println!("tuning Hz | speed m/s | measured 5-85 ms (audio) | peak of the tension trace");
    let mut cases = Vec::new();
    for (tune, v) in [(82.0f32, 0.5f32), (82.0, 1.5), (82.0, 3.0), (82.0, 6.0), (65.0, 5.0), (82.0, 5.0), (110.0, 5.0)] {
        let spec = DrumSpec::floor_tom(tune);
        let g = glide_audio(&spec, v, 0.5);
        let tr = tension_trace(&spec, v, 0.5, 0.3);
        let pk = tr.iter().fold(0.0f32, |m, p| m.max(p.1));
        println!("{tune:>5} | {v:>4} | {g:+.1} | {pk:.1}");
        cases.push((tune, v, tr));
    }
    let pick = |tune: f32, v: f32| cases.iter().find(|c| c.0 == tune && c.1 == v).unwrap().2.iter().map(|p| (p.0 * 1e3, p.1)).collect::<Vec<_>>();
    let ymax = cases.iter().flat_map(|c| c.2.iter()).fold(0.0f32, |m, p| m.max(p.1)) * 1.1;
    chart(
        "glide.svg",
        "The pitch glide of a floor tom, from the head's own tension",
        "time after the hit, ms",
        "frequency above rest, cents",
        (0.0, 300.0),
        (0.0, ymax),
        &ticks(0.0, 300.0, 50.0, |v| format!("{v:.0}")),
        &ticks(0.0, ymax, ((ymax / 6.0) / 50.0).ceil() * 50.0, |v| format!("{v:.0}")),
        &[series("82 Hz, 6 m/s", RED, pick(82.0, 6.0)), series("82 Hz, 3 m/s", BROWN, pick(82.0, 3.0)), series("82 Hz, 0.5 m/s", BLUE, pick(82.0, 0.5)), series("65 Hz (slack), 5 m/s", GREEN, pick(65.0, 5.0)), series("110 Hz (tight), 5 m/s", GREY, pick(110.0, 5.0))],
    );

    println!("\n## the kick: felt beater on the slack 55 Hz head (its resonant head and shell left off), struck at 0.2");
    println!("speed | pressed in (mm) | contact ms | leaves at m/s | glide peak, cents (tension trace)");
    for v in [1.0f32, 2.0, 4.0, 6.0] {
        for (name, striker) in [("felt", StrikerSpec::felt_beater()), ("plastic", StrikerSpec::plastic_beater())] {
            let mut spec = DrumSpec::kick(55.0);
            spec.striker = striker;
            let open = DrumSpec { reso: None, volume: 0.0, ..spec };
            let mut d = Drum::new(open, SR);
            d.strike(strike_of(&open, v, 0.2));
            let mut pen = 0.0f32;
            for _ in 0..(0.08 * SR) as usize {
                d.next_sample();
                pen = pen.max(-d.report.gap);
            }
            let tr = tension_trace(&spec, v, 0.2, 0.2);
            let pk = tr.iter().fold(0.0f32, |m, p| m.max(p.1));
            println!("{name} {v} m/s | {:.1} | {:.1} | {:.2} | {pk:.0}", pen * 1e3, d.report.contact_samples as f32 / SR * 1e3, d.report.speed_out);
        }
    }
}

// ---------------------------------------------------------------- 3.6 and 3.7 drums and the snare

fn stats(spec: &DrumSpec, v: f32, pos: f32) -> (f32, f32, f32, f32) {
    let mut d = Drum::new(*spec, SR);
    d.strike(strike_of(spec, v, pos));
    let mut pen = 0.0f32;
    for _ in 0..(0.06 * SR) as usize {
        d.next_sample();
        pen = pen.max(-d.report.gap);
    }
    (d.report.contact_samples as f32 / SR * 1e3, d.report.peak_force, d.report.speed_out, pen * 1e3)
}

fn snare_hit(spec: &DrumSpec, velocity: f32, position: f32) -> (Vec<f32>, u32, f32, Vec<f32>) {
    let mut d = Drum::new(*spec, SR);
    d.strike(strike_of(spec, velocity, position));
    let mut last = 0.0;
    let mut lifted = vec![0.0f32; 400];
    let x = (0..SR as usize)
        .map(|i| {
            let y = d.next_sample();
            let l = d.wires_lifted();
            if l > 0 {
                last = i as f32 / SR;
            }
            if i / 88 < lifted.len() {
                lifted[i / 88] += l as f32 / 88.0;
            }
            y
        })
        .collect();
    (x, d.wire_landings(), last, lifted)
}

fn with_preload(preload: f32) -> DrumSpec {
    let mut s = DrumSpec::snare(220.0);
    s.snares.as_mut().unwrap().preload = preload;
    s
}

#[test]
#[ignore]
fn matter_drums_report() {
    println!("profile: {}", profile());
    println!("\n## how long a strike is in contact (the head's give sets it)");
    println!("case | contact ms | peak N | leaves at m/s | pressed in mm");
    for (name, spec, v, pos) in [
        ("timpani, felt mallet, 2 m/s at 0.75", DrumSpec::timpani(130.81), 2.0f32, 0.75f32),
        ("timpani, hard mallet, 2 m/s at 0.75", DrumSpec { striker: StrikerSpec::hard_mallet(), ..DrumSpec::timpani(130.81) }, 2.0, 0.75),
        ("rack tom, stick, 4 m/s at 0.4", DrumSpec::rack_tom(140.0), 4.0, 0.4),
        ("floor tom, stick, 4 m/s at 0.4", DrumSpec::floor_tom(82.0), 4.0, 0.4),
        ("snare, stick, 4 m/s at 0.35", DrumSpec::snare(220.0), 4.0, 0.35),
        ("kick, felt beater, 3 m/s at 0.2", DrumSpec::kick(55.0), 3.0, 0.2),
        ("kick, plastic beater, 3 m/s at 0.2", DrumSpec { striker: StrikerSpec::plastic_beater(), ..DrumSpec::kick(55.0) }, 3.0, 0.2),
    ] {
        let (t, f, out, pen) = stats(&spec, v, pos);
        println!("{name} | {t:.2} | {f:.0} | {out:.2} | {pen:.2}");
    }

    println!("\n## the tom follows its tuning (rack tom, 1 m/s at 0.5, the (1,1) peak)");
    for tune in [120.0f32, 140.0, 160.0, 200.0] {
        let s = DrumSpec::rack_tom(tune);
        let g = Membrane::new(s.batter, s.max_modes, 20_000.0, true).modes.iter().find(|x| x.m == 1 && x.n == 1).unwrap().freq;
        let f = peak(secs(&hit(&s, 1.0, 0.5), 0.3, 1.0), g * 0.95, g * 1.05).0;
        println!("batter tuned to {tune} Hz: (1,1) sounds at {f:.1} Hz (ratio to the 120 Hz drum's tuning ratio {:.3})", f / tune);
    }

    println!("\n## the kick: pillow and beater");
    let damped = DrumSpec::kick(55.0);
    let open = DrumSpec { batter: HeadSpec { loss: 3.0, loss_hf: 5.0, ..damped.batter }, ..damped };
    for (name, s) in [("pillow", damped), ("open", open)] {
        let x = hit(&s, 3.0, 0.2);
        println!("{name}: rms falls {:.1} dB from 0-0.1 s to 0.4-0.6 s", db(rms(secs(&x, 0.0, 0.1)) / rms(secs(&x, 0.4, 0.6))));
    }
    for (name, s) in [("felt", damped), ("plastic", DrumSpec { striker: StrikerSpec::plastic_beater(), ..damped })] {
        let x = hit(&s, 3.0, 0.2);
        println!("{name} beater: share of the first 150 ms above 4 kHz {:.1} dB", above(secs(&x, 0.0, 0.15), 4000.0));
    }

    println!("\n## a harder stroke is louder but barely brighter (centroid of the first 100 ms, Hz)");
    for (name, s, pos) in [("snare", DrumSpec::snare(220.0), 0.4f32), ("rack tom", DrumSpec::rack_tom(140.0), 0.4)] {
        let (a, b) = (hit(&s, 1.0, pos), hit(&s, 5.0, pos));
        println!("{name}: 1 m/s {:.0} Hz, 5 m/s {:.0} Hz; level difference {:.1} dB", centroid(secs(&a, 0.0, 0.1)), centroid(secs(&b, 0.0, 0.1)), db(rms(&b) / rms(&a)));
    }
    let (soft, hard) = (DrumSpec::timpani(130.81), DrumSpec { striker: StrikerSpec::hard_mallet(), ..DrumSpec::timpani(130.81) });
    let (xs, xh) = (hit(&soft, 2.0, 0.75), hit(&hard, 2.0, 0.75));
    println!("timpani felt against hard mallet: centroid {:.0} against {:.0} Hz; above 1 kHz {:.1} against {:.1} dB", centroid(secs(&xs, 0.0, 0.15)), centroid(secs(&xh, 0.0, 0.15)), above(secs(&xs, 0.0, 0.15), 1000.0), above(secs(&xh, 0.0, 0.15), 1000.0));
    let (xq, xl) = (hit(&soft, 0.4, 0.75), hit(&soft, 4.0, 0.75));
    println!("timpani felt mallet, 0.4 against 4 m/s: centroid {:.0} against {:.0} Hz", centroid(secs(&xq, 0.0, 0.15)), centroid(secs(&xl, 0.0, 0.15)));

    println!("\n## the sampled high band: rack tom, 4 m/s at 0.4, first 200 ms");
    let with = DrumSpec::rack_tom(140.0);
    let without = DrumSpec { high_band: 0.0, ..with };
    let run = |spec: &DrumSpec| {
        let mut d = Drum::new(*spec, SR);
        d.strike(strike_of(spec, 4.0, 0.4));
        let mut force = Vec::new();
        let x: Vec<f32> = (0..(0.2 * SR) as usize)
            .map(|_| {
                let y = d.next_sample();
                force.push(d.last_force);
                y
            })
            .collect();
        (x, force)
    };
    let (xw, fw) = run(&with);
    let (xo, fo) = run(&without);
    let pk = |f: &[f32]| f.iter().fold(0.0f32, |m, v| m.max(*v));
    let touch = |f: &[f32]| f.iter().filter(|v| **v > 0.0).count();
    println!("above 4 kHz: {:.1} dB with, {:.1} dB without; peak force {:.1} against {:.1} N, contact {} against {} samples", above(&xw, 4000.0), above(&xo, 4000.0), pk(&fw), pk(&fo), touch(&fw), touch(&fo));
    let reference = max_spectrum(&xw);
    chart(
        "highband.svg",
        "A stick on the rack tom, with and without the sampled high band",
        "frequency, Hz",
        "level, dB re strongest",
        (200f32.log10(), 16_000f32.log10()),
        (-110.0, 3.0),
        &log_ticks(200.0, 16_000.0, |v| if v >= 1000.0 { format!("{}k", v / 1000.0) } else { format!("{v}") }),
        &ticks(-105.0, 0.0, 15.0, |v| format!("{v:.0}")),
        &[series("high band on", BLUE, log_spectrum(&xw, 200.0, 16_000.0, 300, reference)), series("high band off", RED, log_spectrum(&xo, 200.0, 16_000.0, 300, reference))],
    );

    println!("\n## the air inside the snare");
    let snare = DrumSpec::snare(220.0);
    let b = Membrane::new(snare.batter, 40, 5000.0, true);
    let r = Membrane::new(snare.reso.unwrap(), 40, 5000.0, true);
    let cav = super::cavity::Cavity::new(&[&b, &r], snare.volume, snare.depth, SR);
    let modes: Vec<String> = cav.modes.iter().take(8).map(|m| format!("({},{}) {:.0} Hz", m.m, m.l, m.freq)).collect();
    println!("cavity modes of the 14 x 5.5 inch shell: {}", modes.join(", "));
    let energy_m1 = |spec: DrumSpec| {
        let mut d = Drum::new(spec, SR);
        d.strike(strike_of(&spec, 2.0, 0.5));
        for _ in 0..(0.05 * SR) as usize {
            d.next_sample();
        }
        let (head, body) = (d.head(1).unwrap(), d.head_body(1).unwrap());
        let e = |pick: &dyn Fn(u32) -> bool| head.modes.iter().enumerate().filter(|(_, m)| pick(m.m) && m.count == 1.0).map(|(k, m)| 0.5 * m.spec.mass * (2.0 * std::f32::consts::PI * m.freq).powi(2) * body.mean_square(k)).sum::<f32>();
        e(&|m| m == 1) / e(&|_| true).max(1.0e-30)
    };
    let off = snare.snares_off();
    println!("share of the snare side's energy in m = 1 modes 50 ms in: {:.3} with the cavity's modes, {:.3} with only the uniform one", energy_m1(off), energy_m1(DrumSpec { depth: 0.0, ..off }));

    println!("\n## the snare wires (14 inch snare, 220 Hz batter, twenty strands in eight groups)");
    println!("case | landings in 1 s | last time a group was off the head, s");
    for (name, spec, v) in [
        ("0.8 m/s", snare, 0.8f32),
        ("2 m/s", snare, 2.0),
        ("4 m/s", snare, 4.0),
        ("2 m/s, snares off", snare.snares_off(), 2.0),
        ("2 m/s, preload 0.05 N", with_preload(0.05), 2.0),
        ("2 m/s, preload 0.15 N (default)", with_preload(0.15), 2.0),
        ("2 m/s, preload 1.2 N", with_preload(1.2), 2.0),
    ] {
        let (_, landings, last, _) = snare_hit(&spec, v, 0.4);
        println!("{name} | {landings} | {last:.3}");
    }
    let (ghost, gl, _, _) = snare_hit(&snare, 0.3, 0.4);
    println!("a ghost note at 0.3 m/s: {gl} landings, peak {:.4} of full scale", ghost.iter().fold(0.0f32, |m, v| m.max(v.abs())));
    let level = |x: &[f32]| {
        let (m, bin) = spectrum(secs(x, 0.0, 0.05), SR);
        db(m.iter().enumerate().filter(|(k, _)| *k as f32 * bin > 3000.0).map(|(_, v)| v * v).sum::<f32>().sqrt())
    };
    let (on, _, _, _) = snare_hit(&snare, 2.0, 0.4);
    let (offx, _, _, _) = snare_hit(&snare.snares_off(), 2.0, 0.4);
    println!("above 3 kHz in the first 50 ms: {:.1} dB snares on, {:.1} dB off", level(&on), level(&offx));
    let mut all = Vec::new();
    for (label, color, p) in [("preload 0.05 N (loose)", GREEN, 0.05f32), ("preload 0.15 N (default)", BLUE, 0.15), ("preload 1.2 N (tight)", RED, 1.2)] {
        let (_, _, _, lifted) = snare_hit(&with_preload(p), 2.0, 0.4);
        all.push(series(label, color, lifted.iter().enumerate().map(|(i, v)| (i as f32 * 2.0, *v)).collect()));
    }
    chart(
        "snare-wires.svg",
        "Snare wire groups off the head after a 2 m/s stick, by preload",
        "time after the hit, ms",
        "groups off the head (of 8), mean over 2 ms",
        (0.0, 200.0),
        (0.0, 8.0),
        &ticks(0.0, 200.0, 25.0, |v| format!("{v:.0}")),
        &ticks(0.0, 8.0, 1.0, |v| format!("{v:.0}")),
        &all,
    );
}

// ---------------------------------------------------------------- 3.8 plates

#[test]
#[ignore]
fn matter_plate_report() {
    println!("profile: {}", profile());
    println!("\n## a free circular plate (nu 0.33): lambda^2 from the frequency equation against Leissa's table");
    for (m, n, exact, leissa) in [(2u32, 0usize, 5.2620f64, 5.253f64), (0, 0, 9.0689, 9.084), (3, 0, 12.2439, 12.23), (1, 0, 20.5127, 20.52), (4, 0, 21.5272, 21.6)] {
        let got = free_modes(m, 0.33, 6.0)[n].lambda.powi(2);
        println!("m {m}: {got:.4}; solved to full precision {exact}; Leissa {leissa} (difference from Leissa {:.2}%)", (got / leissa - 1.0).abs() * 100.0);
    }
    println!("\n## the plates (build time, sizes, the dome)");
    let mut plates = Vec::new();
    for (name, spec) in [("crash 16 inch", CymbalSpec::crash()), ("ride 20 inch", CymbalSpec::ride()), ("splash 10 inch", CymbalSpec::splash())] {
        let t = Instant::now();
        let p = Plate::new(spec.plate, spec.options);
        let ring = (spec.plate.dome_omega2().sqrt() / PI / 2.0) as f32;
        let flat = Plate::new(PlateSpec { dome_radius: 0.0, ..spec.plate }, spec.options);
        let find = |p: &Plate, m: u32| p.modes[..p.nonlinear].iter().filter(|x| x.m == m).map(|x| x.freq).fold(f32::MAX, f32::min);
        println!(
            "{name}: built in {:.2} s; {:.2} mm of bronze, {:.2} kg, dome radius {:.2} m, ring frequency {ring:.0} Hz, coincidence {:.0} Hz; {} modes, {} nonlinear, {} coupled; (0,1) {:.1} Hz flat -> {:.1} Hz dome; (2,0) {:.1} -> {:.1}, (3,0) {:.1} -> {:.1}",
            t.elapsed().as_secs_f32(),
            spec.plate.thickness * 1e3,
            spec.plate.mass(),
            spec.plate.dome_radius,
            spec.plate.coincidence(),
            p.modes.len(),
            p.nonlinear,
            p.coupled,
            find(&flat, 0),
            find(&p, 0),
            find(&flat, 2),
            find(&p, 2),
            find(&flat, 3),
            find(&p, 3)
        );
        println!("    couplings: {} quadratic entries of {} possible, {} in-plane functions", p.couplings.quad.iter().map(|q| q.len()).sum::<usize>(), p.couplings.full, p.couplings.c.len());
        plates.push((name, spec, p, ring));
    }
    let (_, crash, dome, ring) = &plates[0];
    let mut worst = 0.0f32;
    let mut count = 0;
    for md in dome.modes[..dome.nonlinear].iter().filter(|x| x.flat_freq > 1500.0 && x.m < 10) {
        let want = (md.flat_freq.powi(2) + ring * ring).sqrt();
        worst = worst.max((md.freq / want - 1.0).abs());
        count += 1;
    }
    println!("\nthe crash's {count} nonlinear modes above 1.5 kHz (flat) with m below 10 follow omega^2 = omega_flat^2 + ring^2 to within {:.2}%", worst * 100.0);
    let mut low: Vec<(f32, f32, u32)> = dome.modes[..dome.nonlinear].iter().map(|m| (m.flat_freq, m.freq, m.m)).collect();
    low.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    println!("the crash's 14 lowest modes by flat-plate frequency (order m, flat Hz, dome Hz):");
    for (f, g, m) in low.iter().take(14) {
        println!("  m {m}: {f:.1} -> {g:.1}");
    }
    let mut svg = svg_start(720.0, 400.0);
    let ax = Axes { x: 70.0, y: 34.0, w: 620.0, h: 300.0, xr: (1.3, 3.55), yr: (1.3, 3.55) };
    ax.frame(&mut svg, "Crash modes: the flat plate's frequency against the dome's", "flat plate frequency, Hz", "dome frequency, Hz", &log_ticks(20.0, 3000.0, |v| format!("{v}")), &log_ticks(20.0, 3000.0, |v| format!("{v}")));
    let diag: Vec<(f32, f32)> = (0..=40).map(|i| { let x = 1.3 + 2.25 * i as f32 / 40.0; (x, x) }).collect();
    ax.line(&mut svg, &diag, GREY, 1.2, "4 3");
    let curve: Vec<(f32, f32)> = (0..=80).map(|i| { let x = 1.3 + 2.25 * i as f32 / 80.0; let f = 10f32.powf(x); (x, (f * f + ring * ring).sqrt().log10()) }).collect();
    ax.line(&mut svg, &curve, "#2a2925", 1.2, "");
    for md in &dome.modes[..dome.nonlinear] {
        ax.dot(&mut svg, md.flat_freq.log10(), md.freq.log10(), 2.6, if md.m == 0 { RED } else { BLUE });
    }
    svg_text(&mut svg, ax.x + 8.0, ax.y + 14.0, 10.0, "start", RED, false, "red: axisymmetric modes (m = 0), which must stretch the dome to move");
    svg_text(&mut svg, ax.x + 8.0, ax.y + 28.0, 10.0, "start", BLUE, false, "blue: modes with nodal diameters");
    svg_text(&mut svg, ax.x + 8.0, ax.y + 42.0, 10.0, "start", "#2a2925", false, &format!("black: sqrt(flat^2 + ring^2), ring = {ring:.0} Hz. grey dashed: no dome"));
    svg_save(svg, "plate-modes.svg");
    let _ = crash;
}

// ---------------------------------------------------------------- 3.9 the von Karman nonlinearity

/// Energy-weighted mean frequency of the nonlinear set's modes at `times` (s).
fn climb(spec: &CymbalSpec, v: f32, times: &[f32]) -> Vec<f32> {
    let mut c = Cymbal::new(*spec, SR);
    c.strike(at(spec, v, 0.9));
    let n = c.plate().nonlinear;
    let mut out = Vec::new();
    for i in 0..=(times.last().unwrap() * SR) as usize {
        c.next_sample();
        if times.iter().any(|&t| (t * SR) as usize == i) {
            let e = super::cymbal_tests::modal_energies(c.body());
            let tot: f32 = e[..n].iter().map(|x| x.1).sum();
            out.push(e[..n].iter().map(|x| x.0 * x.1).sum::<f32>() / tot);
        }
    }
    out
}

#[test]
#[ignore]
fn matter_cymbal_report() {
    println!("profile: {}", profile());
    let crash = CymbalSpec::crash();
    let render = |s: &CymbalSpec, v: f32, pos: f32, secs_: f32| render_cymbal(s, &[(0.0, at(s, v, pos))], SR, secs_);

    println!("\n## the crash, struck by its shoulder at 0.9 of the radius: with the stretching and the same plate made linear");
    println!("speed | rms dB (0-0.1 s) nonlinear / linear / difference | (0.1-0.3 s) | (0.3-1.0 s) | peak nonlinear / linear");
    for v in [0.05f32, 0.3, 1.5, 5.0, 6.0] {
        let (n, l) = (render(&crash, v, 0.9, 1.0), render(&crash.linear(), v, 0.9, 1.0));
        let w = |a: f32, b: f32| { let (x, y) = (db(rms(secs(&n, a, b))), db(rms(secs(&l, a, b)))); format!("{x:.1} / {y:.1} / {:+.1}", x - y) };
        let pk = |x: &[f32]| x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        println!("{v} m/s | {} | {} | {} | {:.4} / {:.4}", w(0.0, 0.1), w(0.1, 0.3), w(0.3, 1.0), pk(&n), pk(&l));
    }

    println!("\n## the radiated spectrum, third-octave bands over the first second (dB, relative)");
    let hard = render(&crash, 5.0, 0.9, 1.0);
    let hard_lin = render(&crash.linear(), 5.0, 0.9, 1.0);
    let soft = render(&crash, 0.3, 0.9, 1.0);
    let soft_lin = render(&crash.linear(), 0.3, 0.9, 1.0);
    let (bh, bl, bs, bsl) = (bands(&hard), bands(&hard_lin), bands(&soft), bands(&soft_lin));
    let freqs = band_freqs();
    println!("band Hz | hard 5 m/s | linear | difference | soft 0.3 m/s | linear | difference");
    for i in 0..bh.len() {
        println!("{:.0} | {:.1} | {:.1} | {:+.1} | {:.1} | {:.1} | {:+.1}", freqs[i], bh[i], bl[i], bh[i] - bl[i], bs[i], bsl[i], bs[i] - bsl[i]);
    }
    // Only the bands above 500 Hz are drawn: below that the stretching's output carries an offset
    // (see `matter_offset_report`) that would set the scale of the whole picture.
    let pts = |b: &[f32]| -> Vec<(f32, f32)> { freqs.iter().zip(b).filter(|(f, _)| **f > 500.0).map(|(f, v)| (f.log10(), *v)).collect() };
    let ymax = bh.iter().fold(f32::MIN, |m, v| m.max(*v)) + 3.0;
    let ymin = bs.iter().chain(bsl.iter()).zip(freqs.iter().cycle()).filter(|(_, f)| **f > 500.0).fold(f32::MAX, |m, (v, _)| m.min(*v)) - 3.0;
    let mut hs = series("5 m/s, with the stretching", RED, pts(&bh));
    hs.dash = "";
    let mut ls = series("5 m/s, plate made linear", GREY, pts(&bl));
    ls.dash = "5 3";
    let mut ss = series("0.3 m/s, with the stretching", BLUE, pts(&bs));
    ss.dash = "";
    let mut sls = series("0.3 m/s, plate made linear", GREEN, pts(&bsl));
    sls.dash = "5 3";
    chart(
        "cymbal-bands.svg",
        "Crash, first second: energy per third octave, stretching on and off",
        "band centre, Hz",
        "band energy, dB",
        (500f32.log10(), 16_000f32.log10()),
        (ymin, ymax),
        &log_ticks(500.0, 16_000.0, |v| if v >= 1000.0 { format!("{}k", v / 1000.0) } else { format!("{v}") }),
        &ticks((ymin / 10.0).ceil() * 10.0, ymax, 10.0, |v| format!("{v:.0}")),
        &[hs, ls, ss, sls],
    );

    println!("\n## the radiated centroid, Hz, in windows after the hit (5 m/s)");
    for (a, b) in [(0.0f32, 0.05f32), (0.05, 0.1), (0.1, 0.25), (0.25, 0.5), (0.5, 1.0)] {
        println!("{a}-{b} s: nonlinear {:.0}, linear {:.0}", centroid(secs(&hard, a, b)), centroid(secs(&hard_lin, a, b)));
    }

    println!("\n## the energy-weighted frequency of the nonlinear set (Hz), and how it moves");
    let times = [0.003f32, 0.01, 0.02, 0.03, 0.045, 0.06, 0.08, 0.1, 0.15, 0.25, 0.5, 0.75, 1.0];
    let h5 = climb(&crash, 5.0, &times);
    let s03 = climb(&crash, 0.3, &times);
    let l5 = climb(&crash.linear(), 5.0, &times);
    println!("t s | 5 m/s | 0.3 m/s | 5 m/s linear");
    for i in 0..times.len() {
        println!("{} | {:.0} | {:.0} | {:.0}", times[i], h5[i], s03[i], l5[i]);
    }
    let lo = h5.iter().chain(s03.iter()).chain(l5.iter()).fold(f32::MAX, |m, v| m.min(*v));
    let hi = h5.iter().chain(s03.iter()).chain(l5.iter()).fold(0.0f32, |m, v| m.max(*v));
    let to = |v: &[f32]| -> Vec<(f32, f32)> { times.iter().zip(v).map(|(t, f)| (t.log10(), *f)).collect() };
    chart_with(
        "cymbal-climb.svg",
        "Crash: where the energy of the nonlinear set sits after a hit",
        "time after the hit, s",
        "energy-weighted frequency, Hz",
        (0.003f32.log10() - 0.05, 0.05),
        (lo * 0.9, hi * 1.05),
        &[(0.003f32.log10(), "0.003".into()), (0.01f32.log10(), "0.01".into()), (0.03f32.log10(), "0.03".into()), (0.1f32.log10(), "0.1".into()), (0.3f32.log10(), "0.3".into()), (1.0f32.log10(), "1".into())],
        &ticks((lo * 0.9 / 100.0).ceil() * 100.0, hi * 1.05, 100.0, |v| format!("{v:.0}")),
        &[series("5 m/s", RED, to(&h5)), series("0.3 m/s", BLUE, to(&s03)), series("5 m/s, plate made linear", GREY, to(&l5))],
        true,
    );

    println!("\n## where the modal energy sits, by band of mode frequency (% of the total), after a 5 m/s hit");
    let edges = [0.0f32, 300.0, 700.0, 1200.0, 2000.0, 3000.0, 5000.0, 20_000.0];
    println!("bands: {:?}", edges);
    for (name, spec) in [("nonlinear", crash), ("linear", crash.linear())] {
        let mut c = Cymbal::new(spec, SR);
        c.strike(at(&spec, 5.0, 0.9));
        for i in 0..SR as usize {
            c.next_sample();
            if [441usize, 4410, 22050, 44099].contains(&i) {
                let e = super::cymbal_tests::modal_energies(c.body());
                let tot: f32 = e.iter().map(|x| x.1).sum();
                let sh: Vec<String> = edges.windows(2).map(|w| format!("{:.1}", 100.0 * e.iter().filter(|x| x.0 >= w[0] && x.0 < w[1]).map(|x| x.1).sum::<f32>() / tot)).collect();
                println!("{name} t {:.2}: {}", i as f32 / SR, sh.join(" | "));
            }
        }
    }

    println!("\n## energy when nothing is lost: modes plus the scheme's stretching energy, undamped, 1 s");
    {
        let mut p = crash.plate;
        p.loss = 0.0;
        p.loss_hf = 0.0;
        let plate = Plate::new(p, crash.options);
        let mut specs = plate.mode_specs();
        specs.iter_mut().for_each(|s| s.sigma = 0.0);
        let mut body = ModalBody::new(&specs, SR);
        let mut vk = super::vonkarman::VonKarman::new(&plate.couplings, &body, p.mass(), crash.every);
        for amp in [0.02f32, 0.1] {
            body.clear();
            for k in 0..6 {
                body.add_modal_force(k, amp * p.mass() as f32 * SR * (k as f32 + 1.0).recip());
            }
            body.step();
            vk.tick(&mut body, true);
            body.step();
            let e0 = body.energy() as f64 + vk.energy();
            let (mut worst, mut swing) = (0.0f64, 0.0f64);
            for i in 0..SR as usize {
                vk.tick(&mut body, false);
                body.step();
                if i % 441 == 0 {
                    let e = body.energy() as f64 + vk.energy();
                    worst = worst.max((e / e0 - 1.0).abs());
                    swing = swing.max(vk.stretching(&body).abs() / e0);
                }
            }
            println!("start amplitude {amp}: E {e0:.3e} J; worst drift {:.3}% in a second; the stretching energy swings by {:.2}% of E", worst * 100.0, swing * 100.0);
        }
    }

    println!("\n## two 25 m/s hits on each cymbal (0.98 then 0.5 of the radius, 50 ms apart)");
    for spec in [CymbalSpec::crash(), CymbalSpec::ride(), CymbalSpec::splash()] {
        let x = render_cymbal(&spec, &[(0.0, at(&spec, 25.0, 0.98)), (0.05, at(&spec, 25.0, 0.5))], SR, 2.0);
        let r = |a: f32, b: f32| rms(secs(&x, a, b));
        println!("{:?}: finite {}; peak {:.2}; rms {:.4} at 0.1-0.2 s, {:.4} at 1.9-2.0 s", spec.kind, x.iter().all(|v| v.is_finite()), x.iter().fold(0.0f32, |m, v| m.max(v.abs())), r(0.1, 0.2), r(1.9, 2.0));
    }

    println!("\n## resting the coupling once the plate is quiet (crash, 5 m/s at 0.92, 8 s): the band change against never resting");
    let run = |floor: f32| {
        let mut c = Cymbal::new(crash, SR);
        c.set_nonlinear_floor(floor);
        c.strike(Strike { velocity: 5.0, position: 0.92, angle: 0.0, striker: crash.striker });
        let mut rest = None;
        let x: Vec<f32> = (0..(8.0 * SR) as usize)
            .map(|i| {
                let v = c.next_sample();
                if rest.is_none() && c.nonlinear_resting() {
                    rest = Some(i as f32 / SR);
                }
                v
            })
            .collect();
        (x, rest)
    };
    let (reference, _) = run(0.0);
    let rb = bands(&reference);
    for floor in [1.0e-3f32, NONLINEAR_FLOOR, 1.0e-2, 3.0e-2] {
        let (x, rest) = run(floor);
        let b = bands(&x);
        let d: Vec<f32> = rb.iter().zip(&b).map(|(a, b)| (a - b).abs()).collect();
        println!("floor {floor:e}: rests at {rest:?} s; bands change by {:.2} dB on average, {:.2} at most", d.iter().sum::<f32>() / d.len() as f32, d.iter().fold(0.0f32, |m, v| m.max(*v)));
    }
}

// ---------------------------------------------------------------- 3.10 the kit

fn dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

#[test]
#[ignore]
fn matter_kit_report() {
    println!("profile: {}", profile());
    println!("\n## how long each piece's sound takes to reach each drum's batter head (samples at 44.1 kHz; the kit clamps to at least one block of {BLOCK})");
    print!("target \\ source |");
    for s in Piece::ALL {
        print!(" {} |", s.name());
    }
    println!();
    let mut smallest = (usize::MAX, "", "");
    for t in [Piece::Kick, Piece::Snare, Piece::RackTom, Piece::FloorTom] {
        print!("{} |", t.name());
        for s in Piece::ALL {
            if s == t {
                print!(" - |");
                continue;
            }
            let d = dist(placement(s).source(), placement(t).centre).max(0.25);
            let n = (d / C_AIR * SR).round() as usize;
            if n < smallest.0 {
                smallest = (n, s.name(), t.name());
            }
            print!(" {n} ({d:.2} m) |");
        }
        println!();
    }
    println!("closest pair: {} to {}, {} samples; Kit::min_delay() reports {}", smallest.1, smallest.2, smallest.0, Kit::new(KitSpec::default(), SR).min_delay());

    println!("\n## sympathy: snare-wire landings in the second after one hit elsewhere (default kit)");
    println!("piece | 2 m/s | 4 m/s | 6 m/s");
    for p in [Piece::Kick, Piece::RackTom, Piece::FloorTom, Piece::Crash, Piece::Ride, Piece::Splash] {
        let mut row = Vec::new();
        for v in [2.0f32, 4.0, 6.0] {
            let mut k = Kit::new(KitSpec::default(), SR);
            k.strike(p, KitHit::at(p, v, if p.is_cymbal() { 0.9 } else { 0.35 }).strike);
            for _ in 0..SR as usize {
                k.next_frame();
            }
            row.push(k.state(Piece::Snare).wire_landings.to_string());
        }
        println!("{} | {}", p.name(), row.join(" | "));
    }
    let mut k = Kit::new(KitSpec::default(), SR);
    k.strike(Piece::Snare, KitHit::at(Piece::Snare, 0.3, 0.4).strike);
    for _ in 0..SR as usize {
        k.next_frame();
    }
    println!("a stick on the snare itself at 0.3 m/s: {} landings", k.state(Piece::Snare).wire_landings);

    // The layout, top view: the listener at the bottom.
    let mut svg = svg_start(720.0, 470.0);
    let ax = Axes { x: 40.0, y: 30.0, w: 640.0, h: 368.0, xr: (-1.0, 1.0), yr: (-0.4, 0.75) };
    ax.frame(&mut svg, "The kit from above: one layout drives the sound and the view", "x, m (listener's right)", "", &ticks(-1.0, 1.0, 0.5, |v| format!("{v}")), &[]);
    let scale = ax.w / 2.0;
    for p in Piece::ALL {
        let pl = placement(p);
        let (cx, cy) = (ax.px(pl.centre[0]), ax.py(-pl.centre[2]));
        let color = if p.is_cymbal() { BROWN } else { BLUE };
        svg.push_str(&format!("<circle cx=\"{cx:.1}\" cy=\"{cy:.1}\" r=\"{:.1}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"1.8\" stroke-dasharray=\"{}\"/>", pl.radius * scale, if p.is_cymbal() { "5 3" } else { "" }));
        svg_text(&mut svg, cx, cy + 4.0, 10.0, "middle", color, true, p.name());
    }
    let snare = placement(Piece::Snare);
    for s in [Piece::RackTom, Piece::Kick, Piece::FloorTom] {
        let src = placement(s);
        let d = dist(src.source(), snare.centre).max(0.25);
        let n = (d / C_AIR * SR).round() as usize;
        let (x0, y0, x1, y1) = (ax.px(src.centre[0]), ax.py(-src.centre[2]), ax.px(snare.centre[0]), ax.py(-snare.centre[2]));
        svg.push_str(&format!("<line x1=\"{x0:.1}\" y1=\"{y0:.1}\" x2=\"{x1:.1}\" y2=\"{y1:.1}\" stroke=\"{RED}\" stroke-dasharray=\"2 3\"/>"));
        svg_text(&mut svg, (x0 + x1) * 0.5, (y0 + y1) * 0.5 - 5.0, 10.0, "middle", RED, false, &format!("{n} samples to the snare"));
    }
    svg_text(&mut svg, ax.x + 6.0, ax.y + ax.h - 6.0, 10.0, "start", GREY, false, "listener side. circles are each piece's own radius. sound travel in samples at 44.1 kHz (a block is 32).");
    svg_save(svg, "kit-layout.svg");
}

// ---------------------------------------------------------------- diagnostics

/// The strongest spectral peaks of `seg` between `lo` and `hi` Hz: (Hz, dB re the strongest anywhere).
fn top_peaks(seg: &[f32], lo: f32, hi: f32, count: usize) -> Vec<(f32, f32)> {
    let (m, bin) = spectrum(seg, SR);
    let reference = m.iter().fold(0.0f32, |a, v| a.max(*v));
    let mut p: Vec<(f32, f32)> = (((lo / bin) as usize).max(1)..((hi / bin) as usize).min(m.len() - 2)).filter(|&i| m[i] > m[i - 1] && m[i] >= m[i + 1]).map(|i| (i as f32 * bin, db(m[i] / reference))).collect();
    p.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    p.truncate(count);
    p
}

#[test]
#[ignore]
fn matter_diag_report() {
    println!("profile: {}", profile());
    let crash = CymbalSpec::crash();
    let n = render_cymbal(&crash, &[(0.0, at(&crash, 5.0, 0.9))], SR, 1.0);
    let l = render_cymbal(&crash.linear(), &[(0.0, at(&crash.linear(), 5.0, 0.9))], SR, 1.0);
    println!("nonlinear peaks 30-700 Hz: {:?}", top_peaks(&n, 30.0, 700.0, 8));
    println!("linear peaks 30-700 Hz: {:?}", top_peaks(&l, 30.0, 700.0, 8));
    println!("nonlinear peaks 700-3000 Hz: {:?}", top_peaks(&n, 700.0, 3000.0, 6));
    println!("linear peaks 700-3000 Hz: {:?}", top_peaks(&l, 700.0, 3000.0, 6));
    // DC and very low content.
    let mean = |x: &[f32]| x.iter().sum::<f32>() / x.len() as f32;
    println!("mean nonlinear {:.5} linear {:.5}; rms {:.4} / {:.4}", mean(&n), mean(&l), rms(&n), rms(&l));
    for (a, b) in [(0.0f32, 0.02f32), (0.02, 0.05), (0.05, 0.1), (0.1, 0.2), (0.2, 0.5)] {
        println!("{a}-{b}: rms nonlinear {:.4} linear {:.4}", rms(secs(&n, a, b)), rms(secs(&l, a, b)));
    }
    // Timpani: where the axisymmetric modes are as rendered.
    let t = DrumSpec::timpani(130.81);
    let centre = hit(&t, 2.0, 0.0);
    let edge = hit(&t, 2.0, 0.75);
    println!("timpani centre stroke, peaks 40-600 Hz: {:?}", top_peaks(secs(&centre, 0.02, 0.6), 40.0, 600.0, 6));
    println!("timpani edge stroke, peaks 40-600 Hz: {:?}", top_peaks(secs(&edge, 0.02, 0.6), 40.0, 600.0, 8));
}

fn region_db(x: &[f32], lo: f32, hi: f32) -> f32 {
    let (m, bin) = spectrum(x, SR);
    10.0 * m.iter().enumerate().filter(|(k, _)| { let f = *k as f32 * bin; f >= lo && f < hi }).map(|(_, v)| v * v).sum::<f32>().max(1e-30).log10()
}

/// The nonlinear crash's output carries a slowly decaying offset: its mean, window by window, and the
/// level of each region of the spectrum with and without the stretching.
#[test]
#[ignore]
fn matter_offset_report() {
    println!("profile: {}", profile());
    for (name, spec, v, pos) in [("crash", CymbalSpec::crash(), 5.0f32, 0.9f32), ("crash", CymbalSpec::crash(), 1.5, 0.9), ("crash", CymbalSpec::crash(), 0.3, 0.9), ("ride", CymbalSpec::ride(), 3.0, 0.6), ("splash", CymbalSpec::splash(), 4.0, 0.9)] {
        let x = render_cymbal(&spec, &[(0.0, at(&spec, v, pos))], SR, 8.0);
        let l = render_cymbal(&spec.linear(), &[(0.0, at(&spec.linear(), v, pos))], SR, 3.0);
        let mean = |a: f32, b: f32| { let s = secs(&x, a, b); s.iter().sum::<f32>() / s.len() as f32 };
        let row: Vec<String> = [(0.0f32, 0.1f32), (0.1, 0.5), (0.5, 1.0), (1.0, 2.0), (2.0, 4.0), (4.0, 8.0)].iter().map(|&(a, b)| format!("{a}-{b}s {:+.4}", mean(a, b))).collect();
        println!("{name} {v} m/s: mean of the output: {}", row.join(", "));
        println!("   first 3 s: mean {:+.4}, rms {:.4}; rms with the mean removed {:.4}; linear plate: mean {:+.5}, rms {:.4}", mean(0.0, 3.0), rms(secs(&x, 0.0, 3.0)), { let s = secs(&x, 0.0, 3.0); let m = mean(0.0, 3.0); rms(&s.iter().map(|v| v - m).collect::<Vec<_>>()) }, { let s = secs(&l, 0.0, 3.0); s.iter().sum::<f32>() / s.len() as f32 }, rms(secs(&l, 0.0, 3.0)));
        let (xs, ls) = (secs(&x, 0.0, 3.0), secs(&l, 0.0, 3.0));
        for (lo, hi) in [(0.0f32, 30.0f32), (30.0, 100.0), (100.0, 500.0), (500.0, 2000.0), (2000.0, 20_000.0)] {
            println!("   {lo:>6}-{hi:>6} Hz: nonlinear {:.1} dB, linear {:.1} dB, difference {:+.1}", region_db(xs, lo, hi), region_db(ls, lo, hi), region_db(xs, lo, hi) - region_db(ls, lo, hi));
        }
    }
}

/// What a hard hit does to a head's energy: run once on the code as it is and once for each of the
/// two ways of driving the tension that the design doc says failed (patched in by hand while
/// measuring, then reverted).
#[test]
#[ignore]
fn matter_stretch_report() {
    println!("profile: {}", profile());
    for (name, spec, v, pos) in [("kick, felt beater, slack 55 Hz", DrumSpec::kick(55.0), 6.0f32, 0.2f32), ("floor tom, stick, 82 Hz", DrumSpec::floor_tom(82.0), 6.0, 0.4), ("floor tom, stick, 25 m/s at the rim", DrumSpec::floor_tom(82.0), 25.0, 0.9)] {
        let mut d = Drum::new(spec, SR);
        d.strike(strike_of(&spec, v, pos));
        let (mut peak_out, mut e_max) = (0.0f32, 0.0f32);
        let mut e = [0.0f32; 3];
        let mut finite = true;
        for i in 0..(3.0 * SR) as usize {
            let y = d.next_sample();
            finite &= y.is_finite();
            peak_out = peak_out.max(y.abs());
            e_max = e_max.max(d.energy());
            if i == (0.1 * SR) as usize { e[0] = d.energy(); }
            if i == SR as usize { e[1] = d.energy(); }
            if i == 3 * SR as usize - 1 { e[2] = d.energy(); }
        }
        println!("{name}: leaves at {:.2} m/s (arrives {v}); peak output {peak_out:.4}; energy 0.1 s {:.3e} J, 1 s {:.3e}, 3 s {:.3e}; largest {e_max:.3e}; finite {finite}", d.report.speed_out, e[0], e[1], e[2]);
    }
}

// ---------------------------------------------------------------- cost

fn median3(mut f: impl FnMut() -> f32) -> f32 {
    let mut v = [f(), f(), f()];
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[1]
}

/// The cost of each piece ringing after a hard hit, and of the kit, as a share of real time on one
/// thread (median of three), engine only. Release builds only.
#[test]
#[ignore]
fn matter_cost_report() {
    println!("profile: {}", profile());
    println!("\n## one drum, 1 s after a 3 m/s hit at 0.4 of the radius");
    for (name, spec) in [("snare", DrumSpec::snare(220.0)), ("kick", DrumSpec::kick(55.0)), ("floor tom", DrumSpec::floor_tom(82.0)), ("rack tom", DrumSpec::rack_tom(140.0)), ("timpani", DrumSpec::timpani(130.81))] {
        let modes = { let d = Drum::new(spec, SR); (0..2).filter_map(|i| d.head(i)).map(|h| h.modes.len()).sum::<usize>() };
        let pct = median3(|| {
            let mut d = Drum::new(spec, SR);
            d.strike(strike_of(&spec, 3.0, 0.4));
            let t = Instant::now();
            let mut acc = 0.0;
            for _ in 0..SR as usize {
                acc += d.next_sample();
            }
            std::hint::black_box(acc);
            t.elapsed().as_secs_f32() * 100.0
        });
        println!("{name}: {modes} head modes, {pct:.1}% of a core");
    }
    println!("\n## one cymbal, 1 s after a 5 m/s hit at 0.9 of the radius");
    for (name, spec) in [("crash", CymbalSpec::crash()), ("ride", CymbalSpec::ride()), ("splash", CymbalSpec::splash())] {
        let pct = median3(|| {
            let mut c = Cymbal::new(spec, SR);
            c.strike(at(&spec, 5.0, 0.9));
            let t = Instant::now();
            let mut acc = 0.0;
            for _ in 0..SR as usize {
                acc += c.next_sample();
            }
            std::hint::black_box(acc);
            t.elapsed().as_secs_f32() * 100.0
        });
        let vk = { let mut c = Cymbal::new(spec, SR); c.von_karman().map(|v| (v.len(), v.couplings())).unwrap_or((0, 0)) };
        println!("{name}: {} nonlinear modes, {} coupling coefficients, {pct:.1}% of a core", vk.0, vk.1);
    }
    println!("\n## the kit: audio-thread time as a share of real time, 4 s (median of three)");
    for workers in [0usize, 1, 2, 3] {
        let all = median3(|| {
            let mut kit = Kit::with_workers(KitSpec::default(), SR, workers);
            for p in Piece::ALL {
                kit.strike(p, KitHit::at(p, 5.0, if p.is_cymbal() { 0.9 } else { 0.35 }).strike);
            }
            let mut cost = std::time::Duration::ZERO;
            for _ in 0..(4.0 * SR) as usize {
                let t = Instant::now();
                std::hint::black_box(kit.next_frame());
                cost += t.elapsed();
            }
            cost.as_secs_f32() / 4.0 * 100.0
        });
        let groove = median3(|| {
            let mut kit = Kit::with_workers(KitSpec::default(), SR, workers);
            let mut cost = std::time::Duration::ZERO;
            let beat = (0.25 * SR) as usize;
            for i in 0..(4.0 * SR) as usize {
                if i % BLOCK == 0 && i % beat == 0 {
                    let b = i / beat;
                    kit.strike(Piece::Ride, KitHit::at(Piece::Ride, 2.5, 0.6).strike);
                    if b % 4 == 0 { kit.strike(Piece::Kick, KitHit::at(Piece::Kick, 3.0, 0.2).strike); }
                    if b % 4 == 2 { kit.strike(Piece::Snare, KitHit::at(Piece::Snare, 4.0, 0.3).strike); }
                    if b == 0 { kit.strike(Piece::Crash, KitHit::at(Piece::Crash, 5.0, 0.92).strike); }
                }
                let t = Instant::now();
                std::hint::black_box(kit.next_frame());
                cost += t.elapsed();
            }
            cost.as_secs_f32() / 4.0 * 100.0
        });
        println!("{workers} workers: all seven struck at once {all:.0}%, the groove {groove:.0}%");
    }
}
