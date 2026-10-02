//! Headless tier for the analyzer widgets (`Oscilloscope`, `SpectrumView`, `LevelMeter`).
//!
//! `tests/features/audio_widgets.feature` runs against the real widgets inside a headless
//! `entropy_gui::Context`, one frame at a time at 60 fps. Nothing here reads the widgets' internal
//! state to decide a step passed: each frame's draw list is rasterized on the CPU (triangles with
//! per-vertex colour, glyph-atlas text, 2x supersampled) and the assertions look at pixels, the
//! same thing a person would look at. Every picture a scenario saves lands in
//! `test-artifacts/audio-widgets/`.
//!
//! "Lit" means a pixel differs from the same widget drawn with no signal, which cancels the panel
//! gradient and the graticule without hard-coding either.

use cucumber::{given, then, when, World as _};
use entropy_engine::audio::analysis::SpectrumAnalyzer;
use entropy_engine::entropy_gui::context::PointerState;
use entropy_engine::entropy_gui::draw_list::DrawCommand;
use entropy_engine::entropy_gui::geometry::{pos2, Rect};
use entropy_engine::entropy_gui::widgets_analysis::{db_to_frac, frac_to_hz, hz_to_frac, note_name};
use entropy_engine::entropy_gui::{
    LevelMeter, MeterOptions, MeterReading, MeterResponse, Oscilloscope, ScopeMode, ScopeOptions,
    ScopeResponse, SpectrogramColorMap, SpectrogramOptions, SpectrogramResponse, SpectrogramView, SpectrumOptions,
    SpectrumResponse, SpectrumStyle, SpectrumView,
};
use image::RgbaImage;

#[path = "common/raster.rs"]
mod raster;
use raster::Harness;

const SR: f32 = 44_100.0;

fn diff(a: &image::Rgba<u8>, b: &image::Rgba<u8>) -> i32 {
    (0..3).map(|i| (a[i] as i32 - b[i] as i32).abs()).sum()
}

fn lit(img: &RgbaImage, reference: &RgbaImage, x: u32, y: u32) -> bool {
    diff(img.get_pixel(x, y), reference.get_pixel(x, y)) > 90
}

/// A pixel the scope traces are drawn in: green-heavy, unlike the grey graticule text.
fn mint(img: &RgbaImage, x: u32, y: u32) -> bool {
    let p = img.get_pixel(x, y);
    p[1] > 130 && p[2] > 100 && (p[1] as i32 - p[0] as i32) > 60
}

/// The first row (from `from`, going down to `to`) that starts a run of `run` lit pixels: the top of a
/// filled area, ignoring a one- or two-pixel line drawn above it.
fn top_of_fill(img: &RgbaImage, reference: &RgbaImage, x: u32, from: u32, to: u32, run: u32) -> Option<u32> {
    (from..to.saturating_sub(run)).find(|&y| (0..run).all(|k| lit(img, reference, x, y + k)))
}

/// A pixel that is saturated colour (the curve's mint-to-orange fill and outline), as opposed to
/// the grey-white of the graticule and the peak-hold marker (white over the dark panel keeps the
/// panel's own channel spread of about 13). The faint orange top of the fill at -12 dBFS still has a
/// spread of about 45, and labels (28) are never inside the plot rows, so 22 separates them.
fn coloured(img: &RgbaImage, x: u32, y: u32) -> bool {
    let p = img.get_pixel(x, y);
    p[0].max(p[1]).max(p[2]) as i32 - p[0].min(p[1]).min(p[2]) as i32 > 22
}

fn top_of_colour(img: &RgbaImage, x: u32, from: u32, to: u32, run: u32) -> Option<u32> {
    (from..to.saturating_sub(run)).find(|&y| (0..run).all(|k| coloured(img, x, y + k)))
}

fn first_lit(img: &RgbaImage, reference: &RgbaImage, x: u32, from: u32, to: u32) -> Option<u32> {
    (from..to).find(|&y| lit(img, reference, x, y))
}

// ------------------------------------------------------------------------------------------
// World
// ------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Spectrum,
    Scope,
    Meter,
    Spectrogram,
}

#[derive(cucumber::World)]
struct WidgetWorld {
    h: Harness,
    kind: Kind,
    spectrum: SpectrumOptions,
    scope: ScopeOptions,
    meter: MeterOptions,
    spectrogram: SpectrogramOptions,
    analyzer: SpectrumAnalyzer,
    last_bins: Vec<f32>,
    pointer: PointerState,
    spec_resp: Option<SpectrumResponse>,
    scope_resp: Option<ScopeResponse>,
    meter_resp: Option<MeterResponse>,
    spectrogram_resp: Option<SpectrogramResponse>,
    pending: Vec<DrawCommand>,
    image: Option<RgbaImage>,
    /// One trace (centre row per column, NaN where no trace) per frame of a steadiness scenario.
    traces: Vec<Vec<f32>>,
    /// The last reading told to the meter, so a click frame keeps showing the same thing.
    reading: MeterReading,
    /// Whether any frame of the last click reported the meter as cleared (`clicked` is true on
    /// the frame the button goes down, not the frame it comes up).
    cleared_seen: bool,
}

impl std::fmt::Debug for WidgetWorld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WidgetWorld({:?})", self.kind)
    }
}

impl Default for WidgetWorld {
    fn default() -> Self {
        Self {
            h: Harness::new(760, 270),
            kind: Kind::Spectrum,
            spectrum: SpectrumOptions { height: 240.0, ..Default::default() },
            scope: ScopeOptions::default(),
            meter: MeterOptions::default(),
            spectrogram: SpectrogramOptions { height: 240.0, ..Default::default() },
            analyzer: SpectrumAnalyzer::new(),
            last_bins: Vec::new(),
            pointer: PointerState::default(),
            spec_resp: None,
            scope_resp: None,
            meter_resp: None,
            spectrogram_resp: None,
            pending: Vec::new(),
            image: None,
            traces: Vec::new(),
            reading: MeterReading::default(),
            cleared_seen: false,
        }
    }
}

fn sine(hz: f32, amp: f32, frames: usize, phase: f32) -> Vec<f32> {
    (0..frames).map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / SR + phase).sin()).collect()
}

fn amp(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

impl WidgetWorld {
    fn frame_spectrum(&mut self, bins: Vec<f32>) {
        let (opts, ptr) = (self.spectrum.clone(), self.pointer);
        let mut resp = None;
        let cmds = self.h.run(ptr, 0.0, |ui| resp = Some(SpectrumView::new("spectrum").options(opts).show(ui, &bins, SR)));
        self.pending = cmds;
        self.spec_resp = resp;
        self.last_bins = bins;
        self.image = None;
    }

    fn frame_spectrogram(&mut self, bins: Vec<f32>) {
        let (opts, ptr) = (self.spectrogram.clone(), self.pointer);
        let mut resp = None;
        let cmds = self.h.run(ptr, 0.0, |ui| resp = Some(SpectrogramView::new("spectrogram").options(opts).show(ui, &bins, SR)));
        self.pending = cmds;
        self.spectrogram_resp = resp;
        self.last_bins = bins;
        self.image = None;
    }

    fn frame_scope(&mut self, l: &[f32], r: &[f32]) {
        let (opts, ptr) = (self.scope.clone(), self.pointer);
        let mut resp = None;
        let cmds = self.h.run(ptr, 0.0, |ui| resp = Some(Oscilloscope::new("scope").options(opts).show(ui, l, r)));
        self.pending = cmds;
        self.scope_resp = resp;
        self.image = None;
    }

    fn frame_meter(&mut self, reading: MeterReading, ptr: PointerState) {
        let opts = self.meter.clone();
        let mut resp = None;
        let cmds = self.h.run(ptr, 0.0, |ui| resp = Some(LevelMeter::new("meter").options(opts).show(ui, reading)));
        self.pending = cmds;
        self.meter_resp = resp;
        self.reading = reading;
        self.image = None;
    }

    fn picture(&mut self) -> RgbaImage {
        if self.image.is_none() {
            self.image = Some(self.h.render(&self.pending));
        }
        self.image.clone().unwrap()
    }

    /// The same widget, same size, told there is nothing to draw: the "unlit" baseline.
    fn reference(&self) -> RgbaImage {
        let mut h = Harness::new(self.h.width, self.h.height);
        let cmds = match self.kind {
            Kind::Spectrum => {
                let opts = self.spectrum.clone();
                let bins = vec![-120.0f32; 2049];
                let mut c = Vec::new();
                for _ in 0..3 {
                    c = h.run(PointerState::default(), 0.0, |ui| {
                        SpectrumView::new("spectrum").options(opts.clone()).show(ui, &bins, SR);
                    });
                }
                c
            }
            Kind::Scope => {
                let opts = self.scope.clone();
                let silence = vec![0.0f32; 2048];
                h.run(PointerState::default(), 0.0, |ui| {
                    Oscilloscope::new("scope").options(opts).show(ui, &silence, &silence);
                })
            }
            Kind::Meter => {
                let opts = self.meter.clone();
                h.run(PointerState::default(), 0.0, |ui| {
                    LevelMeter::new("meter").options(opts).show(ui, MeterReading::default());
                })
            }
            Kind::Spectrogram => {
                let opts = self.spectrogram.clone();
                let bins = vec![-120.0f32; 2049];
                let mut c = Vec::new();
                for _ in 0..3 {
                    c = h.run(PointerState::default(), 0.0, |ui| {
                        SpectrogramView::new("spectrogram").options(opts.clone()).show(ui, &bins, SR);
                    });
                }
                c
            }
        };
        h.render(&cmds)
    }
}

fn artifacts_dir() -> std::path::PathBuf {
    let dir = std::env::current_dir().unwrap().join("test-artifacts").join("audio-widgets");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[then(expr = "I save the picture {string}")]
fn save_picture(world: &mut WidgetWorld, name: String) {
    let img = world.picture();
    let path = artifacts_dir().join(format!("{name}.png"));
    img.save(&path).unwrap();
    // A blank or unchanged picture would make every pixel assertion above meaningless.
    let colours: std::collections::HashSet<[u8; 4]> = img.pixels().map(|p| p.0).collect();
    assert!(colours.len() > 60, "{name} looks blank: {} colours", colours.len());
}

// ------------------------------------------------------------------------------------------
// Spectrum steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a spectrum view {int} px wide")]
fn spectrum_view(world: &mut WidgetWorld, width: usize) {
    world.kind = Kind::Spectrum;
    world.h = Harness::new(width + 40, 270);
}

#[given(expr = "a spectrum view {int} px wide in bar style")]
fn spectrum_bars(world: &mut WidgetWorld, width: usize) {
    spectrum_view(world, width);
    world.spectrum.style = SpectrumStyle::Bars;
}

fn feed_spectrum(world: &mut WidgetWorld, signal: impl Fn(usize) -> Vec<f32>, frames: usize) {
    for f in 0..frames {
        let s = signal(f);
        let spec = world.analyzer.analyze(&s, &s, 4096, SR);
        match world.kind {
            Kind::Spectrum => world.frame_spectrum(spec.bins_db),
            Kind::Spectrogram => world.frame_spectrogram(spec.bins_db),
            _ => {}
        }
    }
}

#[when(expr = "I show a {int} Hz sine at {int} dBFS for {int} frames")]
fn show_sine_spectrum(world: &mut WidgetWorld, hz: u32, db: i32, frames: usize) {
    feed_spectrum(world, |f| sine(hz as f32, amp(db as f32), 4096, f as f32 * 0.3), frames);
}

#[when(expr = "I show a {int} Hz sine and a {int} Hz sine at {int} dBFS for {int} frames")]
fn show_two_sines(world: &mut WidgetWorld, a: u32, b: u32, db: i32, frames: usize) {
    feed_spectrum(
        world,
        |f| sine(a as f32, amp(db as f32), 4096, f as f32 * 0.3).iter().zip(sine(b as f32, amp(db as f32), 4096, f as f32 * 0.7)).map(|(x, y)| x + y).collect(),
        frames,
    );
}

#[when(expr = "I show silence for {int} frames")]
fn show_silence(world: &mut WidgetWorld, frames: usize) {
    match world.kind {
        Kind::Spectrum => feed_spectrum(world, |_| vec![0.0; 4096], frames),
        Kind::Spectrogram => feed_spectrum(world, |_| vec![0.0; 4096], frames),
        Kind::Scope => {
            for _ in 0..frames {
                world.frame_scope(&vec![0.0; 2048], &vec![0.0; 2048]);
            }
        }
        Kind::Meter => unreachable!("the meter has its own silence step"),
    }
}

fn spectrum_geometry(world: &WidgetWorld) -> Rect {
    world.spec_resp.expect("a frame was drawn").plot
}

/// Top row of the fill in the column at `hz`, as dBFS.
fn curve_db_at(world: &mut WidgetWorld, hz: f32) -> f32 {
    let plot = spectrum_geometry(world);
    let img = world.picture();
    let x = (plot.min.x + hz_to_frac(hz, 20.0, 20_000.0) * plot.width()) as u32;
    let y = top_of_colour(&img, x, plot.min.y as u32, plot.max.y as u32 - 2, 3).expect("a filled curve at that frequency");
    world.spectrum.max_db - (y as f32 - plot.min.y) / plot.height() * (world.spectrum.max_db - world.spectrum.min_db)
}

fn column_top_row(world: &mut WidgetWorld) -> Vec<Option<u32>> {
    let plot = spectrum_geometry(world);
    let img = world.picture();
    // Above the floor line only: rows near the bottom edge are the axis hairline.
    (plot.min.x as u32..plot.max.x as u32).map(|x| top_of_colour(&img, x, plot.min.y as u32, plot.max.y as u32 - 6, 3)).collect()
}

fn hz_of_column(world: &WidgetWorld, offset: usize) -> f32 {
    let plot = spectrum_geometry(world);
    frac_to_hz((offset as f32 + 0.5) / plot.width().floor(), 20.0, 20_000.0)
}

fn expected_offset(world: &WidgetWorld, hz: f32) -> f32 {
    hz_to_frac(hz, 20.0, 20_000.0) * spectrum_geometry(world).width() - 0.5
}

#[then(expr = "the tallest part of the curve is at {int} Hz within {int} px")]
fn tallest_at(world: &mut WidgetWorld, hz: u32, tol: f32) {
    let tops = column_top_row(world);
    let best = tops.iter().flatten().min().copied().expect("some curve");
    let cols: Vec<usize> = tops.iter().enumerate().filter(|(_, t)| t.map_or(false, |t| t <= best + 1)).map(|(i, _)| i).collect();
    let centre = cols.iter().sum::<usize>() as f32 / cols.len() as f32;
    let want = expected_offset(world, hz as f32);
    println!("    tallest columns {cols:?} centre {centre:.1}px, {hz} Hz should be at {want:.1}px ({:.0} Hz)", hz_of_column(world, centre.round() as usize));
    assert!((centre - want).abs() <= tol, "curve peaks at column {centre:.1}, {hz} Hz is at {want:.1}");
}

#[then(expr = "the curve peaks at {int} dBFS within {int} dB")]
fn peak_db(world: &mut WidgetWorld, db: i32, tol: f32) {
    let tops = column_top_row(world);
    let plot = spectrum_geometry(world);
    let best = tops.iter().flatten().min().copied().unwrap();
    let got = world.spectrum.max_db - (best as f32 - plot.min.y) / plot.height() * (world.spectrum.max_db - world.spectrum.min_db);
    println!("    the curve tops out at {got:.1} dBFS");
    assert!((got - db as f32).abs() <= tol, "{got:.1} dBFS, wanted {db} +/- {tol}");
}

#[then(expr = "the curve has two separate peaks, at {int} Hz and at {int} Hz, each within {int} px")]
fn two_peaks(world: &mut WidgetWorld, a: u32, b: u32, tol: f32) {
    let tops = column_top_row(world);
    let plot_w = tops.len();
    let want = [expected_offset(world, a as f32), expected_offset(world, b as f32)];
    for (hz, want) in [a, b].iter().zip(want) {
        let lo = (want as i32 - 12).max(0) as usize;
        let hi = ((want as i32 + 12) as usize).min(plot_w - 1);
        let top = (lo..=hi).filter_map(|i| tops[i]).min().expect("a peak near each tone");
        let flat: Vec<usize> = (lo..=hi).filter(|i| tops[*i].map_or(false, |t| t <= top + 1)).collect();
        let centre = flat.iter().sum::<usize>() as f32 / flat.len() as f32;
        println!("    {hz} Hz: tallest columns near it {}..={} (centre {centre:.1}, expected {want:.1}), row {top}", flat[0], flat[flat.len() - 1]);
        assert!((centre - want).abs() <= tol, "{hz} Hz peak is at column {centre:.1}, wanted {want:.1}");
    }
    // And they are separate: the axis midway between the two tones is far below both.
    let mid = ((want[0] + want[1]) / 2.0) as usize;
    let valley = tops[mid].unwrap_or(u32::MAX);
    let lower_peak = [want[0], want[1]].iter().map(|w| tops[*w as usize].unwrap_or(u32::MAX)).max().unwrap();
    assert!(valley > lower_peak + 40, "no valley between the tones: row {valley} vs peak row {lower_peak}");
}

#[then(expr = "the curve at {int} Hz has fallen but is still above {int} dBFS")]
fn fallen(world: &mut WidgetWorld, hz: u32, floor: i32) {
    let db = curve_db_at(world, hz as f32);
    println!("    the curve at {hz} Hz now sits at {db:.1} dBFS");
    assert!(db < -8.0, "the curve has not fallen ({db:.1} dBFS)");
    assert!(db > floor as f32, "the curve fell all the way to {db:.1} dBFS at once");
}

#[then(expr = "the peak marker at {int} Hz is still at {int} dBFS within {int} dB")]
fn marker_still(world: &mut WidgetWorld, hz: u32, db: i32, tol: f32) {
    let plot = spectrum_geometry(world);
    let img = world.picture();
    let reference = world.reference();
    let x = (plot.min.x + hz_to_frac(hz as f32, 20.0, 20_000.0) * plot.width()) as u32;
    let y = first_lit(&img, &reference, x, plot.min.y as u32, plot.max.y as u32 - 2).expect("a peak marker");
    let got = world.spectrum.max_db - (y as f32 - plot.min.y) / plot.height() * (world.spectrum.max_db - world.spectrum.min_db);
    println!("    the peak marker at {hz} Hz is at {got:.1} dBFS");
    assert!((got - db as f32).abs() <= tol, "marker at {got:.1} dBFS");
}

#[then(expr = "the peak marker at {int} Hz is below {int} dBFS")]
fn marker_below(world: &mut WidgetWorld, hz: u32, db: i32) {
    let plot = spectrum_geometry(world);
    let img = world.picture();
    let reference = world.reference();
    let x = (plot.min.x + hz_to_frac(hz as f32, 20.0, 20_000.0) * plot.width()) as u32;
    let got = match first_lit(&img, &reference, x, plot.min.y as u32, plot.max.y as u32 - 2) {
        Some(y) => world.spectrum.max_db - (y as f32 - plot.min.y) / plot.height() * (world.spectrum.max_db - world.spectrum.min_db),
        None => f32::MIN,
    };
    println!("    the peak marker at {hz} Hz has fallen to {got:.1} dBFS");
    assert!(got < db as f32, "the marker is still at {got:.1} dBFS");
}

#[when(expr = "I hover the pointer over {int} Hz")]
fn hover_over(world: &mut WidgetWorld, hz: u32) {
    let plot = spectrum_geometry(world);
    let x = plot.min.x + hz_to_frac(hz as f32, 20.0, 20_000.0) * plot.width();
    world.pointer = PointerState { pos: Some(pos2(x, plot.center().y)), ..Default::default() };
    let bins = world.last_bins.clone();
    world.frame_spectrum(bins);
}

#[then(expr = "the readout is within {int} percent of {int} Hz")]
fn readout_hz(world: &mut WidgetWorld, pct: f32, hz: f32) {
    let hover = world.spec_resp.unwrap().hover.expect("the pointer is over the plot");
    assert!((hover.hz - hz).abs() <= hz * pct / 100.0, "{} Hz", hover.hz);
}

#[then(expr = "the readout level is within {int} dB of {int} dBFS")]
fn readout_db(world: &mut WidgetWorld, tol: f32, db: f32) {
    let hover = world.spec_resp.unwrap().hover.unwrap();
    assert!((hover.db - db).abs() <= tol, "{} dBFS", hover.db);
}

#[then(expr = "the note under {int} Hz is {string}")]
fn note_under(world: &mut WidgetWorld, _hz: u32, name: String) {
    let hover = world.spec_resp.unwrap().hover.unwrap();
    assert_eq!(note_name(hover.hz).unwrap().0, name);
}

#[then(expr = "exactly {int} of the {int} bars is tall")]
fn bars_tall(world: &mut WidgetWorld, tall: usize, count: usize) {
    let plot = spectrum_geometry(world);
    let img = world.picture();
    let reference = world.reference();
    let slot = plot.width() / count as f32;
    let y_at_minus_30 = (plot.max.y - db_to_frac(-30.0, -90.0, 0.0) * plot.height()) as u32;
    let n = (0..count).filter(|i| lit(&img, &reference, (plot.min.x + (*i as f32 + 0.5) * slot) as u32, y_at_minus_30)).count();
    println!("    {n} of {count} bars reach -30 dBFS");
    assert_eq!(n, tall);
}

// ------------------------------------------------------------------------------------------
// Scope steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a scope {int} px wide with the trigger {word}")]
fn scope_with_trigger(world: &mut WidgetWorld, width: usize, state: String) {
    world.kind = Kind::Scope;
    world.h = Harness::new(width + 40, 230);
    world.scope = ScopeOptions { trigger: state == "on", persistence: 0.0, height: 210.0, ..Default::default() };
}

#[given(expr = "a scope {int} px wide with the trigger off and a window of {int} frames")]
fn scope_wide_window(world: &mut WidgetWorld, width: usize, window: usize) {
    scope_with_trigger(world, width, "off".into());
    world.scope.window_frames = window;
}

#[given(expr = "a scope {int} px wide in stereo mode with the trigger {word}")]
fn stereo_scope(world: &mut WidgetWorld, width: usize, state: String) {
    scope_with_trigger(world, width, state);
    world.scope.mode = ScopeMode::Stereo;
}

/// Counts pixels close to the accent (mint) or the second-channel (salmon) trace colour.
fn trace_colours(world: &mut WidgetWorld) -> (usize, usize) {
    let plot = world.scope_resp.unwrap().plot;
    let img = world.picture();
    let (mut mint_n, mut hot_n) = (0, 0);
    for y in plot.min.y as u32 + 22..plot.max.y as u32 - 18 {
        for x in plot.min.x as u32..plot.max.x as u32 {
            let p = img.get_pixel(x, y);
            if p[1] > 200 && p[2] > 170 && p[0] < 170 { mint_n += 1; }
            if p[0] > 200 && p[1] < 170 && p[2] < 160 { hot_n += 1; }
        }
    }
    (mint_n, hot_n)
}

#[when(expr = "I show a {int} Hz sine on the left and a {int} Hz sine on the right")]
fn stereo_two_tones(world: &mut WidgetWorld, l: u32, r: u32) {
    world.frame_scope(&sine(l as f32, 0.6, 2048, 0.3), &sine(r as f32, 0.6, 2048, 0.3));
}

#[then("the trace is drawn in the accent colour and not the second channel colour")]
fn single_accent_trace(world: &mut WidgetWorld) {
    let (mint_n, hot_n) = trace_colours(world);
    println!("    accent pixels {mint_n}, second-channel pixels {hot_n}");
    assert!(mint_n > 300, "no accent-coloured trace on screen");
    assert!(hot_n < 20, "the second channel's colour is covering the trace ({hot_n} pixels)");
}

#[then("both channel colours are on screen")]
fn both_colours(world: &mut WidgetWorld) {
    let (mint_n, hot_n) = trace_colours(world);
    println!("    accent pixels {mint_n}, second-channel pixels {hot_n}");
    assert!(mint_n > 300 && hot_n > 300, "expected two traces, got {mint_n} accent and {hot_n} second-channel pixels");
}

/// Row of the trace in each plot column: the mean row of mint pixels, NaN where there are none.
fn trace_rows(world: &mut WidgetWorld) -> Vec<f32> {
    let plot = world.scope_resp.unwrap().plot;
    let img = world.picture();
    (plot.min.x as u32 + 2..plot.max.x as u32 - 2)
        .map(|x| {
            let rows: Vec<u32> = (plot.min.y as u32 + 22..plot.max.y as u32 - 18).filter(|y| mint(&img, x, *y)).collect();
            if rows.is_empty() { f32::NAN } else { rows.iter().sum::<u32>() as f32 / rows.len() as f32 }
        })
        .collect()
}

#[when(expr = "I show a {int} Hz sine at {int} different starting phases")]
fn sine_at_phases(world: &mut WidgetWorld, hz: u32, phases: usize) {
    world.traces.clear();
    for i in 0..phases {
        let s = sine(hz as f32, 0.6, 2048, 0.37 + i as f32 * 0.53);
        world.frame_scope(&s, &s);
        let rows = trace_rows(world);
        world.traces.push(rows);
    }
}

fn worst_column_spread(traces: &[Vec<f32>]) -> f32 {
    let n = traces[0].len();
    (0..n)
        .filter_map(|c| {
            let v: Vec<f32> = traces.iter().map(|t| t[c]).filter(|v| v.is_finite()).collect();
            if v.len() < traces.len() { return None; }
            Some(v.iter().cloned().fold(f32::MIN, f32::max) - v.iter().cloned().fold(f32::MAX, f32::min))
        })
        .fold(0.0, f32::max)
}

#[then(expr = "the trace has stayed within {float} px from frame to frame")]
fn trace_steady(world: &mut WidgetWorld, tol: f32) {
    let spread = worst_column_spread(&world.traces);
    println!("    worst per-column movement across {} frames: {spread:.2} px", world.traces.len());
    assert!(spread <= tol, "the trace moved {spread:.2} px");
}

#[then(expr = "the trace has moved by more than {int} px between frames")]
fn trace_crawls(world: &mut WidgetWorld, min: f32) {
    let spread = worst_column_spread(&world.traces);
    println!("    worst per-column movement across {} frames: {spread:.2} px (no trigger)", world.traces.len());
    assert!(spread > min, "the trace only moved {spread:.2} px, so this scenario does not show the problem the trigger solves");
}

#[then("the scope reports that it is triggered")]
fn is_triggered(world: &mut WidgetWorld) {
    assert!(world.scope_resp.unwrap().triggered);
}

#[then("the scope reports that it is free-running")]
fn is_free(world: &mut WidgetWorld) {
    assert!(!world.scope_resp.unwrap().triggered);
}

#[then(expr = "the scope reports a frequency within {float} Hz of {int}")]
fn scope_freq(world: &mut WidgetWorld, tol: f32, hz: f32) {
    let got = world.scope_resp.unwrap().frequency_hz.expect("a pitch");
    println!("    the scope reads {got:.2} Hz");
    assert!((got - hz).abs() <= tol, "{got} Hz");
}

#[when("I show a click that is a single sample wide")]
fn single_click(world: &mut WidgetWorld) {
    let mut s = vec![0.0f32; 16384];
    s[8000] = 0.9;
    world.frame_scope(&s, &s);
}

#[then("the spike is drawn at full height")]
fn spike_drawn(world: &mut WidgetWorld) {
    let plot = world.scope_resp.unwrap().plot;
    let img = world.picture();
    let want_y = plot.center().y - 0.9 * plot.height() / 2.0;
    let found = (plot.min.x as u32..plot.max.x as u32).any(|x| (want_y as u32 - 2..=want_y as u32 + 3).any(|y| mint(&img, x, y)));
    assert!(found, "no trace pixel at the spike's height (row {want_y:.0})");
}

// ------------------------------------------------------------------------------------------
// Goniometer steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a goniometer {int} px wide")]
fn goniometer(world: &mut WidgetWorld, width: usize) {
    world.kind = Kind::Scope;
    world.h = Harness::new(width + 20, 420);
    world.scope = ScopeOptions { mode: ScopeMode::Xy, persistence: 0.0, height: 400.0, gain: 1.0, ..Default::default() };
}

fn show_xy(world: &mut WidgetWorld, l: Vec<f32>, r: Vec<f32>) {
    world.frame_scope(&l, &r);
}

#[when(expr = "I show a {int} Hz sine identically in both channels")]
fn xy_mono(world: &mut WidgetWorld, hz: u32) {
    let s = sine(hz as f32, 0.6, 2048, 0.2);
    show_xy(world, s.clone(), s);
}

#[when(expr = "I show a {int} Hz sine with the right channel inverted")]
fn xy_inverted(world: &mut WidgetWorld, hz: u32) {
    let s = sine(hz as f32, 0.6, 2048, 0.2);
    let r = s.iter().map(|v| -v).collect();
    show_xy(world, s, r);
}

#[when(expr = "I show a {int} Hz sine in the left channel only")]
fn xy_left(world: &mut WidgetWorld, hz: u32) {
    show_xy(world, sine(hz as f32, 0.6, 2048, 0.2), vec![0.0; 2048]);
}

#[when(expr = "I show a {int} Hz sine in the left channel and a {int} Hz sine in the right")]
fn xy_wide(world: &mut WidgetWorld, l: u32, r: u32) {
    show_xy(world, sine(l as f32, 0.6, 2048, 0.2), sine(r as f32, 0.6, 2048, 0.9));
}

/// Offsets from the figure's centre (dx right, dy down) of every trace pixel.
fn figure_points(world: &mut WidgetWorld) -> Vec<(f32, f32)> {
    let plot = world.scope_resp.unwrap().plot;
    let img = world.picture();
    let c = plot.center();
    let mut pts = Vec::new();
    for y in plot.min.y as u32 + 16..plot.max.y as u32 - 24 {
        for x in plot.min.x as u32..plot.max.x as u32 {
            if mint(&img, x, y) {
                pts.push((x as f32 + 0.5 - c.x, y as f32 + 0.5 - c.y));
            }
        }
    }
    assert!(!pts.is_empty(), "nothing was drawn");
    pts
}

#[then(expr = "every drawn point lies within {int} px of the vertical axis")]
fn on_vertical(world: &mut WidgetWorld, tol: f32) {
    let worst = figure_points(world).iter().map(|p| p.0.abs()).fold(0.0, f32::max);
    println!("    furthest point from the vertical axis: {worst:.1} px");
    assert!(worst <= tol, "{worst} px off the axis");
}

#[then(expr = "every drawn point lies within {int} px of the horizontal axis")]
fn on_horizontal(world: &mut WidgetWorld, tol: f32) {
    let worst = figure_points(world).iter().map(|p| p.1.abs()).fold(0.0, f32::max);
    println!("    furthest point from the horizontal axis: {worst:.1} px");
    assert!(worst <= tol, "{worst} px off the axis");
}

#[then(expr = "every drawn point lies within {int} px of the left diagonal")]
fn on_left_diagonal(world: &mut WidgetWorld, tol: f32) {
    // Left-only puts x = -L/2 and y = L/2: up-left to down-right on screen, where dx == dy.
    let worst = figure_points(world).iter().map(|p| (p.0 - p.1).abs() / std::f32::consts::SQRT_2).fold(0.0, f32::max);
    println!("    furthest point from the left diagonal: {worst:.1} px");
    assert!(worst <= tol, "{worst} px off the diagonal");
}

#[then(expr = "the figure is wider than {int} px and taller than {int} px")]
fn figure_size(world: &mut WidgetWorld, w: f32, h: f32) {
    let pts = figure_points(world);
    let span = |f: fn(&(f32, f32)) -> f32| pts.iter().map(f).fold(f32::MIN, f32::max) - pts.iter().map(f).fold(f32::MAX, f32::min);
    let (sw, sh) = (span(|p| p.0), span(|p| p.1));
    println!("    figure is {sw:.0} x {sh:.0} px");
    assert!(sw > w && sh > h);
}

#[then(expr = "the reported correlation is {float} within {float}")]
fn correlation(world: &mut WidgetWorld, want: f32, tol: f32) {
    let got = world.scope_resp.unwrap().correlation;
    println!("    correlation {got:+.3}");
    assert!((got - want).abs() <= tol, "{got}");
}

// ------------------------------------------------------------------------------------------
// Meter steps
// ------------------------------------------------------------------------------------------

#[given("a level meter")]
fn level_meter(world: &mut WidgetWorld) {
    world.kind = Kind::Meter;
    world.h = Harness::new(140, 230);
    world.meter = MeterOptions { width: 44.0, height: 200.0, show_scale: true, ..Default::default() };
}

fn told(world: &mut WidgetWorld, l: Option<f32>, r: Option<f32>, frames: usize) {
    let peak = |db: Option<f32>| db.map_or(0.0, amp);
    let reading = MeterReading { peak: [peak(l), peak(r)], rms: [peak(l) * 0.7, peak(r) * 0.7] };
    for _ in 0..frames {
        world.frame_meter(reading, PointerState::default());
    }
}

#[when(expr = "the meter is told the left peak is {int} dBFS and the right peak is {int} dBFS for {int} frames")]
fn told_both(world: &mut WidgetWorld, l: i32, r: i32, frames: usize) {
    told(world, Some(l as f32), Some(r as f32), frames);
}

#[when(expr = "the meter is told the left peak is {int} dBFS for {int} frame(s)")]
fn told_left(world: &mut WidgetWorld, l: i32, frames: usize) {
    told(world, Some(l as f32), None, frames);
}

#[when(expr = "the meter is told silence for {int} frames")]
fn told_silence(world: &mut WidgetWorld, frames: usize) {
    told(world, None, None, frames);
}

fn bar_y(world: &WidgetWorld, ch: usize, db: f32) -> f32 {
    let col = world.meter_resp.unwrap().columns[ch];
    col.max.y - db_to_frac(db, world.meter.min_db, world.meter.max_db) * col.height()
}

/// Top of the coloured bar in one channel, read off the picture a couple of pixels in from the
/// column's edge (the RMS core runs down the middle and a hold tick spans the full width).
fn bar_top(world: &mut WidgetWorld, ch: usize) -> f32 {
    let col = world.meter_resp.unwrap().columns[ch];
    let img = world.picture();
    let reference = world.reference();
    let x = col.min.x as u32 + 3;
    top_of_fill(&img, &reference, x, col.min.y as u32, col.max.y as u32, 6).expect("a filled bar") as f32
}

#[then(expr = "the left bar reaches {int} dBFS within {int} px")]
fn left_reaches(world: &mut WidgetWorld, db: i32, tol: f32) {
    let (top, want) = (bar_top(world, 0), bar_y(world, 0, db as f32));
    println!("    left bar top {top:.1}px, {db} dBFS is at {want:.1}px");
    assert!((top - want).abs() <= tol);
}

#[then(expr = "the right bar reaches {int} dBFS within {int} px")]
fn right_reaches(world: &mut WidgetWorld, db: i32, tol: f32) {
    let (top, want) = (bar_top(world, 1), bar_y(world, 1, db as f32));
    println!("    right bar top {top:.1}px, {db} dBFS is at {want:.1}px");
    assert!((top - want).abs() <= tol);
}

#[then(expr = "the left bar has fallen below {int} dBFS")]
fn left_fell(world: &mut WidgetWorld, db: i32) {
    let (top, limit) = (bar_top(world, 0), bar_y(world, 0, db as f32));
    println!("    left bar top {top:.1}px, {db} dBFS is at {limit:.1}px");
    assert!(top > limit, "the bar is still above {db} dBFS");
}

#[then(expr = "the left peak tick is still at {int} dBFS within {int} px")]
fn left_tick(world: &mut WidgetWorld, db: i32, tol: f32) {
    let col = world.meter_resp.unwrap().columns[0];
    let img = world.picture();
    let reference = world.reference();
    let x = col.min.x as u32 + 3;
    let first = first_lit(&img, &reference, x, col.min.y as u32, col.max.y as u32).expect("a peak tick");
    let run = (first..col.max.y as u32).take_while(|y| lit(&img, &reference, x, *y)).count().min(3);
    let centre = first as f32 + run as f32 / 2.0;
    let want = bar_y(world, 0, db as f32);
    println!("    tick at {centre:.1}px, {db} dBFS is at {want:.1}px");
    assert!((centre - want).abs() <= tol);
}

#[then("the left channel is latched as clipped")]
fn left_clipped(world: &mut WidgetWorld) {
    assert!(world.meter_resp.unwrap().clipped[0]);
    // And the LED is red in the picture.
    let col = world.meter_resp.unwrap().columns[0];
    let img = world.picture();
    let p = img.get_pixel(col.center().x as u32, col.min.y as u32 - 5);
    assert!(p[0] > 200 && p[1] < 100, "the clip LED is {:?}", p.0);
}

#[then("the right channel is not")]
fn right_not_clipped(world: &mut WidgetWorld) {
    assert!(!world.meter_resp.unwrap().clipped[1]);
}

#[when("I click the meter")]
fn click_meter(world: &mut WidgetWorld) {
    let rect = world.meter_resp.unwrap().rect;
    let pos = Some(pos2(rect.center().x, rect.center().y));
    let reading = world.reading;
    world.cleared_seen = false;
    world.frame_meter(reading, PointerState { pos, ..Default::default() });
    world.frame_meter(reading, PointerState { pos, primary_down: true, primary_pressed: true, ..Default::default() });
    world.cleared_seen |= world.meter_resp.unwrap().cleared;
    world.frame_meter(reading, PointerState { pos, primary_released: true, ..Default::default() });
    world.cleared_seen |= world.meter_resp.unwrap().cleared;
}

#[then("no channel is latched as clipped")]
fn none_clipped(world: &mut WidgetWorld) {
    let r = world.meter_resp.unwrap();
    assert!(world.cleared_seen, "the click never reported a clear");
    assert_eq!(r.clipped, [false, false], "{r:?}");
}

fn main() {
    futures::executor::block_on(WidgetWorld::cucumber().max_concurrent_scenarios(1).fail_on_skipped().run_and_exit("tests/features/audio_widgets.feature"));
}

// ------------------------------------------------------------------------------------------
// Spectrogram steps
// ------------------------------------------------------------------------------------------

#[given(expr = "a spectrogram view {int} px wide")]
fn spectrogram_view(world: &mut WidgetWorld, width: usize) {
    world.kind = Kind::Spectrogram;
    world.h = Harness::new(width + 40, 270);
}

#[given(expr = "a spectrogram view {int} px wide with {string} color map")]
fn spectrogram_view_colormap(world: &mut WidgetWorld, width: usize, map: String) {
    world.kind = Kind::Spectrogram;
    world.h = Harness::new(width + 40, 270);
    world.spectrogram.color_map = match map.to_lowercase().as_str() {
        "magma" => SpectrogramColorMap::Magma,
        "phosphor" => SpectrogramColorMap::Phosphor,
        "fire" => SpectrogramColorMap::Fire,
        _ => SpectrogramColorMap::Turbo,
    };
}

fn spectrogram_geometry(world: &WidgetWorld) -> Rect {
    world.spectrogram_resp.expect("a frame was drawn").plot
}

#[then(expr = "the brightest column of the spectrogram is at {int} Hz within {int} px")]
fn brightest_column_at(world: &mut WidgetWorld, hz: u32, tol: f32) {
    let plot = spectrogram_geometry(world);
    let img = world.picture();
    let ref_img = world.reference();
    let y_start = (plot.min.y + 2.0) as u32;
    let y_end = (plot.min.y + 20.0).min(plot.max.y - 2.0) as u32;

    let mut best_x = 0;
    let mut max_diff = 0i32;
    for x in (plot.min.x as u32 + 1)..(plot.max.x as u32 - 1) {
        let col_d: i32 = (y_start..y_end).map(|y| diff(img.get_pixel(x, y), ref_img.get_pixel(x, y))).sum();
        if col_d > max_diff {
            max_diff = col_d;
            best_x = x;
        }
    }

    let want = plot.min.x + hz_to_frac(hz as f32, 20.0, 20_000.0) * plot.width();
    println!("    brightest column {best_x}, {hz} Hz should be at {want:.1}px");
    assert!((best_x as f32 - want).abs() <= tol, "brightest column {best_x} vs expected {want:.1}");
}

#[then(expr = "the spectrogram has two separate bright peaks, at {int} Hz and at {int} Hz, each within {int} px")]
fn two_peaks_spectrogram(world: &mut WidgetWorld, a: u32, b: u32, tol: f32) {
    let plot = spectrogram_geometry(world);
    let img = world.picture();
    let ref_img = world.reference();
    let y_start = (plot.min.y + 2.0) as u32;
    let y_end = (plot.min.y + 20.0).min(plot.max.y - 2.0) as u32;

    let split = plot.center().x as u32;
    let mut best_a = 0;
    let mut max_a = 0i32;
    for x in (plot.min.x as u32 + 1)..split {
        let col_d: i32 = (y_start..y_end).map(|y| diff(img.get_pixel(x, y), ref_img.get_pixel(x, y))).sum();
        if col_d > max_a {
            max_a = col_d;
            best_a = x;
        }
    }

    let mut best_b = 0;
    let mut max_b = 0i32;
    for x in split..(plot.max.x as u32 - 1) {
        let col_d: i32 = (y_start..y_end).map(|y| diff(img.get_pixel(x, y), ref_img.get_pixel(x, y))).sum();
        if col_d > max_b {
            max_b = col_d;
            best_b = x;
        }
    }

    let want_a = plot.min.x + hz_to_frac(a as f32, 20.0, 20_000.0) * plot.width();
    let want_b = plot.min.x + hz_to_frac(b as f32, 20.0, 20_000.0) * plot.width();
    println!("    spectrogram peaks: {best_a} (want {want_a:.1}) and {best_b} (want {want_b:.1})");
    assert!((best_a as f32 - want_a).abs() <= tol, "peak a {best_a} vs {want_a:.1}");
    assert!((best_b as f32 - want_b).abs() <= tol, "peak b {best_b} vs {want_b:.1}");
}

#[then(expr = "the spectrogram older history has a peak at {int} Hz while the newest rows are quiet")]
fn history_scrolls_down(world: &mut WidgetWorld, hz: u32) {
    let plot = spectrogram_geometry(world);
    let img = world.picture();
    let ref_img = world.reference();

    let x = (plot.min.x + hz_to_frac(hz as f32, 20.0, 20_000.0) * plot.width()) as u32;

    let top_y_start = (plot.min.y + 2.0) as u32;
    let top_y_end = (plot.min.y + 12.0) as u32;
    let quiet_diff: i32 = (top_y_start..top_y_end).map(|y| diff(img.get_pixel(x, y), ref_img.get_pixel(x, y))).sum();
    let quiet_avg = quiet_diff as f32 / (top_y_end - top_y_start) as f32;

    let old_y_start = (plot.min.y + 22.0) as u32;
    let old_y_end = (plot.min.y + 40.0).min(plot.max.y - 2.0) as u32;
    let lit_diff: i32 = (old_y_start..old_y_end).map(|y| diff(img.get_pixel(x, y), ref_img.get_pixel(x, y))).sum();
    let lit_avg = lit_diff as f32 / (old_y_end - old_y_start) as f32;

    println!("    spectrogram scroll: newest avg diff {quiet_avg:.1}, older avg diff {lit_avg:.1}");
    assert!(lit_avg > quiet_avg + 30.0, "older rows must be lit compared to quiet newest rows");
}

#[when(expr = "I hover the pointer over {int} Hz on the spectrogram")]
fn hover_spectrogram(world: &mut WidgetWorld, hz: u32) {
    let plot = spectrogram_geometry(world);
    let x = plot.min.x + hz_to_frac(hz as f32, 20.0, 20_000.0) * plot.width();
    let y = plot.center().y;
    world.pointer = PointerState { pos: Some(pos2(x, y)), ..Default::default() };
    let bins = world.last_bins.clone();
    world.frame_spectrogram(bins);
}

#[then(expr = "the spectrogram readout is within {int} percent of {int} Hz")]
fn hover_spectrogram_hz(world: &mut WidgetWorld, percent: u32, hz: u32) {
    let h = world.spectrogram_resp.as_ref().and_then(|r| r.hover).expect("spectrogram hover");
    let err = (h.hz - hz as f32).abs() / hz as f32;
    println!("    spectrogram hover hz: {:.1} Hz (target {hz})", h.hz);
    assert!(err <= percent as f32 / 100.0, "readout {} vs {}", h.hz, hz);
}

#[then(expr = "the spectrogram readout level is within {int} dB of {int} dBFS")]
fn hover_spectrogram_db(world: &mut WidgetWorld, tol: u32, db: i32) {
    let h = world.spectrogram_resp.as_ref().and_then(|r| r.hover).expect("spectrogram hover");
    println!("    spectrogram hover db: {:.1} dBFS (target {db})", h.db);
    assert!((h.db - db as f32).abs() <= tol as f32, "readout {} vs {}", h.db, db);
}
