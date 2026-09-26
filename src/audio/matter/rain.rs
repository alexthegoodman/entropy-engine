//! Rain: thousands of drops, each a striker, on whatever is under them.
//!
//! Rain isn't a "rain generator" here. It is a flux of drops with the sizes real rain has, each
//! falling at its terminal speed and landing somewhere on a body: on a lake, each drop may entrain
//! a bubble (`drop`); on a window, a steel roof, a tent's fly, a cymbal or a drum, each
//! drop is a splash on that body's modes. So rain on each sounds different because each is a
//! different body - the lake's 14 kHz whisper from the regularly entrained bubbles of millimetre
//! drops, the pane's glassy patter, the tent's soft drumming, the cymbal's shimmer.
//!
//! **The drops.** Marshall and Palmer's size distribution: `N(D) = N0 exp(-Lambda D)` drops per
//! cubic metre per millimetre of diameter, `N0 = 8000`, `Lambda = 4.1 R^-0.21` per mm for a rain rate
//! `R` in mm/h. What lands on a surface is that times each size's terminal speed, which weights the
//! larger drops further; heavier rain means more drops and larger ones. Arrivals are a Poisson
//! process at the total flux times the body's area. Where that is more than the model can afford a
//! simulated drop stands for several (a linear body adds them incoherently: `sqrt(count)`).
//!
//! Nothing here allocates after construction (the bodies are built with the rain).

use super::bubble::{pan_gains, Birth, BubbleBank, Rng};
use super::cymbal::{Cymbal, CymbalSpec};
use super::drop::{entrain, terminal_speed, Drop};
use super::drum::{Drum, DrumSpec, FULL_SCALE_PA};
use super::kit::NONLINEAR_FLOOR;
use super::rub::{SurfaceKind, ToolSpec};
use super::sheet::{Sheet, SheetSpec};

/// Drop diameters tabulated, and the table's points.
const D_MIN: f32 = 0.2e-3;
const D_MAX: f32 = 6.0e-3;
const TABLE: usize = 128;
/// Most drops simulated per second on a lake, and on a body.
pub const LAKE_RATE: f32 = 6000.0;
pub const BODY_RATE: f32 = 2500.0;

/// What the rain falls on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RainTarget {
    /// Open water, all around the listener.
    Lake,
    /// A pane of glass (60 cm, 4 mm).
    Window,
    /// A corrugated steel roof panel (1 m, 0.5 mm sheet, 18 mm corrugations): a shed's roof.
    Roof,
    /// A tent's fly.
    Tent,
    /// A 20" ride cymbal.
    Cymbal,
    /// A 16" floor tom.
    Drum,
}

impl RainTarget {
    pub const ALL: [RainTarget; 6] = [RainTarget::Lake, RainTarget::Window, RainTarget::Roof, RainTarget::Tent, RainTarget::Cymbal, RainTarget::Drum];

    pub fn name(self) -> &'static str {
        match self {
            RainTarget::Lake => "lake",
            RainTarget::Window => "window",
            RainTarget::Roof => "roof",
            RainTarget::Tent => "tent",
            RainTarget::Cymbal => "cymbal",
            RainTarget::Drum => "drum",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|t| t.name() == name)
    }
}

/// The window's pane and the roof's sheet.
pub fn window() -> SheetSpec {
    SheetSpec { surface: SurfaceKind::Glass, radius: 0.3, thickness: 0.004, loss: 2.0, loss_hf: 0.6, complete_freq: 2500.0, density: 0.0 }
}

/// A corrugated sheet is far stiffer across its corrugations than a flat one (`D_x ~ E t d^2 / 8`
/// for corrugations `d` deep) and as flexible as flat along them; it is modelled as the isotropic
/// plate with their geometric mean stiffness and the sheet's own mass per area - which is what
/// brings its coincidence down from 23 kHz (flat) to a few kHz and makes a roof loud in the rain.
pub fn roof() -> SheetSpec {
    let (e, nu, rho) = (200.0e9f32, 0.29f32, 7850.0f32);
    let (t, d) = (0.0005f32, 0.018f32);
    let flat = e * t.powi(3) / (12.0 * (1.0 - nu * nu));
    let across = e * t * d * d / 8.0;
    let stiffness = (flat * across).sqrt();
    let thickness = (12.0 * (1.0 - nu * nu) * stiffness / e).cbrt();
    let density = rho * t / thickness;
    SheetSpec { surface: SurfaceKind::Steel, radius: 0.5, thickness, loss: 3.0, loss_hf: 0.8, complete_freq: 2000.0, density: 0.0 }.with_density(density)
}

enum Body {
    Lake { bubbles: Box<BubbleBank> },
    Sheet(Box<Sheet>),
    Drum(Box<Drum>),
    Cymbal(Box<Cymbal>),
}

/// What the rain has done, for the view and the ops.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct RainReport {
    /// Drops that have landed (real ones, counting what each simulated one stands for), and simulated.
    pub landed: f64,
    pub simulated: u64,
    /// Bubbles entrained (simulated).
    pub bubbles: u64,
    /// The flux now, drops per square metre per second, and the body's area, m^2.
    pub flux: f32,
    pub area: f32,
}

/// Rain on a body. See the module notes.
pub struct Rain {
    pub target: RainTarget,
    sr: f32,
    h: f32,
    body: Body,
    /// The rate now (mm/h) and the flux and size table it gives.
    rate: f32,
    flux: f32,
    cdf: [f32; TABLE],
    area: f32,
    /// Where the listener is: the lake's radius around its point, or the distance from the body.
    pub distance: f32,
    lake_radius: f32,
    next: f32,
    rng: Rng,
    births: [Birth; 2],
    pub report: RainReport,
    /// Where the last [`RECENT`] simulated drops landed, as fractions of the face's radius (the
    /// lake's: of the water around the listener), oldest overwritten first; `landed_view` counts
    /// them all (a slot is `landed_view % RECENT`).
    pub recent: [[f32; 2]; RECENT],
    pub landed_view: u64,
}

/// Landings remembered for the view.
pub const RECENT: usize = 24;

/// Marshall-Palmer drops per m^3 per mm at `d` m, for `rate` mm/h.
fn marshall_palmer(d: f32, rate: f32) -> f32 {
    let lambda = 4.1 * rate.max(0.01).powf(-0.21);
    8000.0 * (-lambda * d * 1000.0).exp()
}

impl Rain {
    /// Rain of `rate` mm/h on `target`, heard from `distance` m (for the lake: its size around the
    /// listener, m). Builds the body, which takes a moment for the plates and membranes (cached
    /// after): call off the audio thread.
    pub fn new(target: RainTarget, rate: f32, distance: f32, seed: u64, sr: f32) -> Self {
        let body = match target {
            RainTarget::Lake => Body::Lake { bubbles: Box::new(BubbleBank::new(sr)) },
            RainTarget::Window => Body::Sheet(Box::new(Sheet::new(window(), ToolSpec::finger(), sr))),
            RainTarget::Roof => Body::Sheet(Box::new(Sheet::new(roof(), ToolSpec::finger(), sr))),
            RainTarget::Tent => Body::Drum(Box::new(Drum::new(DrumSpec::tent(), sr))),
            RainTarget::Drum => Body::Drum(Box::new(Drum::new(DrumSpec::floor_tom(82.0), sr))),
            RainTarget::Cymbal => {
                // A raindrop moves a ride far less than its thickness: the plate is linear.
                let mut c = Cymbal::new(CymbalSpec::ride().linear(), sr);
                c.set_nonlinear_floor(NONLINEAR_FLOOR);
                Body::Cymbal(Box::new(c))
            }
        };
        let (area, lake_radius) = match &body {
            Body::Lake { .. } => (std::f32::consts::PI * distance * distance, distance),
            Body::Sheet(s) => (std::f32::consts::PI * s.spec.radius * s.spec.radius, 0.0),
            Body::Drum(d) => (d.spec.batter.area(), 0.0),
            Body::Cymbal(c) => (std::f32::consts::PI * c.spec.plate.radius * c.spec.plate.radius, 0.0),
        };
        let mut r = Self { target, sr, h: 1.0 / sr, body, rate: 0.0, flux: 0.0, cdf: [0.0; TABLE], area, distance: if lake_radius > 0.0 { 1.6 } else { distance }, lake_radius, next: 0.0, rng: Rng::new(seed), births: [Birth::new(1.0e-3, 1.0e-3); 2], report: RainReport::default(), recent: [[0.0; 2]; RECENT], landed_view: 0 };
        // Enable the splashes now (mapping the face allocates).
        match &mut r.body {
            Body::Sheet(s) => s.enable_splashes(),
            Body::Drum(d) => d.enable_splashes(),
            Body::Cymbal(c) => c.enable_splashes(),
            Body::Lake { .. } => {}
        }
        r.set_rate(rate);
        r
    }

    /// Rain rate, mm/h (0 stops it; light rain ~1, moderate ~5, heavy ~20, a downpour 50+).
    pub fn rate(&self) -> f32 {
        self.rate
    }

    /// Changes the rain rate (live; no allocation).
    pub fn set_rate(&mut self, rate: f32) {
        let rate = rate.clamp(0.0, 200.0);
        if rate == self.rate {
            return;
        }
        self.rate = rate;
        if rate <= 0.0 {
            self.flux = 0.0;
            self.report.flux = 0.0;
            return;
        }
        // The flux of each size through a horizontal surface: N(D) v(D), integrated by the
        // trapezoid rule into a cumulative table.
        let step = (D_MAX - D_MIN) / (TABLE - 1) as f32;
        let f = |i: usize| {
            let d = D_MIN + step * i as f32;
            marshall_palmer(d, rate) * terminal_speed(d)
        };
        let mut acc = 0.0;
        self.cdf[0] = 0.0;
        for i in 1..TABLE {
            acc += 0.5 * (f(i - 1) + f(i)) * step * 1000.0;
            self.cdf[i] = acc;
        }
        self.flux = acc;
        for v in self.cdf.iter_mut() {
            *v /= acc.max(1.0e-30);
        }
        self.report.flux = self.flux;
        self.report.area = self.area;
    }

    /// A drop's diameter drawn from the flux, m.
    fn diameter(&mut self) -> f32 {
        let u = self.rng.uniform();
        let i = self.cdf.partition_point(|&c| c < u).clamp(1, TABLE - 1);
        let (c0, c1) = (self.cdf[i - 1], self.cdf[i]);
        let w = if c1 > c0 { (u - c0) / (c1 - c0) } else { 0.0 };
        let step = (D_MAX - D_MIN) / (TABLE - 1) as f32;
        D_MIN + step * (i as f32 - 1.0 + w)
    }

    /// Whether anything can be heard.
    pub fn busy(&self) -> bool {
        self.rate > 0.0
            || match &self.body {
                Body::Lake { bubbles } => !bubbles.is_silent(),
                Body::Sheet(s) => s.striking() || s.energy() > 1.0e-12,
                Body::Drum(d) => d.striking() || d.energy() > 1.0e-12,
                Body::Cymbal(c) => c.striking() || c.energy() > 1.0e-12,
            }
    }

    fn land(&mut self, count: f32) {
        let drop = Drop::raindrop(self.diameter());
        self.report.simulated += 1;
        self.report.landed += count as f64;
        // Anywhere on the face, uniformly.
        let (r, theta) = (self.rng.uniform().sqrt(), self.rng.range(0.0, std::f32::consts::TAU));
        self.recent[(self.landed_view % RECENT as u64) as usize] = [r * theta.cos(), r * theta.sin()];
        self.landed_view += 1;
        match &mut self.body {
            Body::Lake { bubbles } => {
                let (x, y) = (r * self.lake_radius * theta.cos(), r * self.lake_radius * theta.sin());
                let dist = (x * x + y * y + self.distance * self.distance).sqrt();
                let pan = x / dist;
                let n = entrain(drop, 100.0, &mut self.rng, &mut self.births);
                for i in 0..n {
                    let mut b = self.births[i];
                    b.pan = pan;
                    b.distance = dist;
                    b.count = count;
                    if bubbles.spawn(b) {
                        self.report.bubbles += 1;
                    }
                }
            }
            Body::Sheet(s) => {
                let a = s.spec.radius * r;
                s.splash_many(drop, a * theta.cos(), a * theta.sin(), count);
            }
            Body::Drum(d) => {
                let a = d.spec.batter.radius * r;
                d.splash_many(drop, a * theta.cos(), a * theta.sin(), count);
            }
            Body::Cymbal(c) => {
                let a = c.spec.plate.radius * r;
                c.splash_many(drop, a * theta.cos(), a * theta.sin(), count);
            }
        }
    }

    /// One sample, `[left, right]` in pascals.
    pub fn next_frame(&mut self) -> [f32; 2] {
        if self.flux > 0.0 {
            let rate = self.flux * self.area;
            let cap = if matches!(self.body, Body::Lake { .. }) { LAKE_RATE } else { BODY_RATE };
            let sim = rate.min(cap);
            self.next -= self.h;
            while self.next <= 0.0 {
                self.land(rate / sim);
                self.next += self.rng.exponential(1.0 / sim);
            }
        }
        match &mut self.body {
            Body::Lake { bubbles } => bubbles.next().0,
            body => {
                let v = match body {
                    Body::Sheet(s) => s.next_sample(),
                    Body::Drum(d) => d.next_sample(),
                    Body::Cymbal(c) => c.next_sample(),
                    Body::Lake { .. } => 0.0,
                } * FULL_SCALE_PA
                    / self.distance.max(0.1);
                let (l, r) = pan_gains(0.0);
                [v * l, v * r]
            }
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    /// How much the body the rain falls on is ringing, J (0 for the lake), and the lake's bubbles
    /// ringing (0 for a body).
    pub fn body_state(&self) -> (f32, usize) {
        match &self.body {
            Body::Lake { bubbles } => (0.0, bubbles.ringing()),
            Body::Sheet(s) => (s.energy(), 0),
            Body::Drum(d) => (d.energy(), 0),
            Body::Cymbal(c) => (c.energy(), 0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marshall_palmer_flux_grows_with_the_rate_and_favours_larger_drops() {
        let mut light = Rain::new(RainTarget::Lake, 1.0, 5.0, 1, 44_100.0);
        let heavy_flux = {
            let mut r = Rain::new(RainTarget::Lake, 25.0, 5.0, 1, 44_100.0);
            let mean: f32 = (0..20_000).map(|_| r.diameter()).sum::<f32>() / 20_000.0;
            (r.flux, mean)
        };
        let light_mean: f32 = (0..20_000).map(|_| light.diameter()).sum::<f32>() / 20_000.0;
        // A few hundred to a few thousand drops per square metre per second.
        assert!(light.flux > 200.0 && light.flux < 3000.0, "{}", light.flux);
        assert!(heavy_flux.0 > light.flux * 2.0);
        assert!(heavy_flux.1 > light_mean * 1.3, "{} vs {light_mean}", heavy_flux.1);
        // The flux integrates to the rain rate: sum of drop volumes per second is R mm/h.
        let mut r = Rain::new(RainTarget::Lake, 5.0, 5.0, 2, 44_100.0);
        let n = 50_000;
        let v: f64 = (0..n).map(|_| (r.diameter() as f64).powi(3) * std::f64::consts::PI / 6.0).sum::<f64>() / n as f64;
        let mm_per_hour = v * r.flux as f64 * 3600.0 * 1000.0;
        assert!((mm_per_hour / 5.0 - 1.0).abs() < 0.2, "{mm_per_hour}");
    }
}
