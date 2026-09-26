//! Moving water: sloshing, streams and surf, as bubble populations driven by a coarse simulation of
//! the water's surface.
//!
//! The surface is simulated along one line - a tank's length, a brook's course, a beach's profile -
//! with the **shallow-water equations** over the bed (a finite-volume scheme: HLL fluxes with
//! Audusse's hydrostatic reconstruction, which keeps still water still over rocks and lets a beach
//! run dry), at a physics rate of a few hundred to a few thousand steps a second. The equations know
//! nothing about sound. What connects them to it is **breaking**: in shallow water every steep wave
//! becomes a bore - a travelling jump in depth - and a bore stronger than `h2 / h1 = 1.28` breaks
//! (weaker ones stay undular, smooth trains of waves: Favre). A breaking bore turns the flow's energy
//! into turbulence at the rate the jump conditions fix,
//!
//! ```text
//! D = rho g q_rel (h2 - h1)^3 / (4 h1 h2)          (W per metre of crest)
//! ```
//!
//! (the classical head loss of a hydraulic jump, `q_rel` the flow through it), and 30-50% of that
//! power goes into dragging air under (Lamarre and Melville) - 40% here. The air goes down as
//! bubbles with the size distribution Deane and Stokes measured under breaking waves: `R^(-3/2)`
//! below the Hinze scale (about a millimetre, where turbulence stops being able to split them) and
//! `R^(-10/3)` above. Each bubble costs its buoyancy's work to the depth it is carried to plus its
//! surface energy, so the dissipated power fixes how many are made. Surf makes millions a second;
//! the bank rings a few thousand, each standing for its share (see `bubble`). When a bore first
//! forms, its crest plunges and traps a pocket of air under its lip, which rings as one large
//! bubble: the slosh's glug, the breaker's thud.
//!
//! So a gently sloshing tank is silent until its wave steepens and breaks against the wall; a brook
//! babbles where its flow drops off rocks into standing jumps, more as it runs faster; surf roars
//! where its waves break, in bursts at their period.
//!
//! Nothing here allocates after construction.

use super::bubble::{pan_gains, Birth, BubbleBank, Rng, TurbulentSizes, G, MIN_RADIUS, RHO_WATER, SURFACE_TENSION};
pub use super::bubble::HINZE;

/// Most cells along the line.
pub const MAX_CELLS: usize = 256;
/// Share of a breaking bore's dissipation that entrains air.
pub const ENTRAINING: f32 = 0.4;
/// Bores breaking: `h2 / h1` above this.
pub const BREAKING: f32 = 1.28;
/// The largest bubble a breaking bore makes, m.
pub const MAX_BUBBLE: f32 = 5.0e-3;
/// Samples per physics block.
pub const WAVE_BLOCK: usize = 32;
/// Most bubbles simulated per bore per block, and births waiting for their sample.
const BIRTHS_PER_BORE: u32 = 3;
const PENDING: usize = 96;
/// Water shallower than this is dry, m.
const DRY: f32 = 1.0e-4;

/// What is at one end of the line.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum End {
    /// A wall (a tank's end).
    Wall,
    /// Water flowing in at `discharge` m^2/s (per metre of width).
    Inflow { discharge: f32 },
    /// Water flowing out freely.
    Outflow,
    /// Waves coming in from open water of `depth`: height (trough to crest, m) and period (s).
    Sea { depth: f32, height: f32, period: f32 },
}

/// What the bed is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Bed {
    Flat,
    /// `count` rocks (smooth bumps up to `height` m high and `size` m across) spread along it.
    Rocks { count: u32, height: f32, size: f32, seed: u32 },
    /// Flat at the far end for `flat` of its length, then rising at `slope` up to the shore.
    Beach { flat: f32, slope: f32 },
}

/// How the container is moved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Motion {
    Still,
    /// Shaken back and forth: amplitude (m) and frequency (Hz).
    Shake { amplitude: f32, freq: f32 },
    /// Tilted by `angle` radians, reached over `time` s, then held.
    Tilt { angle: f32, time: f32 },
    /// Tilted back and forth by `angle` at `freq` Hz (rocking a tub).
    Rock { angle: f32, freq: f32 },
}

/// A body of moving water.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WavesSpec {
    /// Length along the line, and width across it, m.
    pub length: f32,
    pub width: f32,
    /// Still depth at the start, m (measured from the lowest bed).
    pub depth: f32,
    pub cells: usize,
    pub left: End,
    pub right: End,
    pub bed: Bed,
    pub motion: Motion,
    /// Manning's roughness of the bed (0.01 smooth glass, 0.03-0.05 a rocky brook).
    pub manning: f32,
    /// The listener: along the line (m from the left end), off to the side (m), and how high.
    pub listener: [f32; 3],
    pub seed: u64,
}

impl WavesSpec {
    /// A plastic tub or a fish tank, 40 cm by 25 cm with 8 cm of water, shaken at its sloshing
    /// frequency (the lowest mode, `sqrt(g k tanh(k d)) / 2 pi` with `k = pi / L`) hard enough to
    /// break.
    pub fn tub() -> Self {
        let (l, d) = (0.4f32, 0.08f32);
        let k = std::f32::consts::PI / l;
        let f = (G * k * (k * d).tanh()).sqrt() / std::f32::consts::TAU;
        Self { length: l, width: 0.25, depth: d, cells: 160, left: End::Wall, right: End::Wall, bed: Bed::Flat, motion: Motion::Shake { amplitude: 0.012, freq: f }, manning: 0.012, listener: [0.2, 0.5, 0.3], seed: 1 }
    }

    /// A brook: 4 m of it, half a metre wide, 8 cm deep, running at `speed` m/s over rocks.
    pub fn brook(speed: f32) -> Self {
        let d = 0.08;
        Self { length: 4.0, width: 0.5, depth: d, cells: 200, left: End::Inflow { discharge: d * speed }, right: End::Outflow, bed: Bed::Rocks { count: 6, height: 0.055, size: 0.12, seed: 3 }, motion: Motion::Still, manning: 0.035, listener: [2.0, 1.2, 0.8], seed: 2 }
    }

    /// A beach: waves of `height` m and `period` s from 3 m of water, breaking on a 1:25 slope; the
    /// listener stands 8 m up the beach.
    pub fn surf(height: f32, period: f32) -> Self {
        Self { length: 110.0, width: 30.0, depth: 3.0, cells: 256, left: End::Sea { depth: 3.0, height, period }, right: End::Wall, bed: Bed::Beach { flat: 0.3, slope: 1.0 / 25.0 }, motion: Motion::Still, manning: 0.02, listener: [110.0 * 0.3 + 3.0 * 25.0 + 8.0, 0.0, 1.7], seed: 3 }
    }
}

/// What the water is doing, for the view and the ops.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct WavesReport {
    /// Breaking bores now, and the power they dissipate, W.
    pub bores: u32,
    pub dissipation: f32,
    /// Bubbles made (real ones, counting what each simulated one stands for) and simulated.
    pub entrained: f64,
    pub simulated: u64,
    /// Crests that have broken (each trapping an air pocket).
    pub breakers: u64,
    /// Highest surface slope now.
    pub steepest: f32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Pending {
    birth: Option<Birth>,
    at: usize,
}

/// A body of moving water and its bubbles. See the module notes.
pub struct Waves {
    pub spec: WavesSpec,
    sr: f32,
    n: usize,
    dx: f32,
    bed: [f32; MAX_CELLS],
    h: [f32; MAX_CELLS],
    hu: [f32; MAX_CELLS],
    flux_h: [f32; MAX_CELLS + 1],
    flux_m: [f32; MAX_CELLS + 1],
    /// Hydrostatic-reconstruction depths either side of each interface.
    left_h: [f32; MAX_CELLS + 1],
    right_h: [f32; MAX_CELLS + 1],
    /// When a bore was last at each cell, s (for telling a newly broken crest from one already
    /// breaking, which flickers as it runs).
    bore_seen: [f32; MAX_CELLS],
    time: f64,
    counter: usize,
    rng: Rng,
    sizes: TurbulentSizes,
    bubbles: BubbleBank,
    pending: [Pending; PENDING],
    /// A slow wander of the inflow (a brook's flow is never steady).
    wander: f32,
    /// Whether the water is moving at all (to sleep when it is still and silent).
    moving: bool,
    pub report: WavesReport,
    /// A running cap on the bubbles simulated per second across the whole body, and the real bubbles
    /// not yet given to a simulated one.
    budget: f32,
    carry: f32,
}

impl Waves {
    pub fn new(spec: WavesSpec, sr: f32) -> Self {
        let n = spec.cells.clamp(8, MAX_CELLS);
        let dx = spec.length / n as f32;
        let mut w = Self {
            spec,
            sr,
            n,
            dx,
            bed: [0.0; MAX_CELLS],
            h: [0.0; MAX_CELLS],
            hu: [0.0; MAX_CELLS],
            flux_h: [0.0; MAX_CELLS + 1],
            flux_m: [0.0; MAX_CELLS + 1],
            left_h: [0.0; MAX_CELLS + 1],
            right_h: [0.0; MAX_CELLS + 1],
            bore_seen: [-1.0e9; MAX_CELLS],
            time: 0.0,
            counter: 0,
            rng: Rng::new(spec.seed),
            sizes: TurbulentSizes::new(MAX_BUBBLE),
            bubbles: BubbleBank::new(sr),
            pending: [Pending::default(); PENDING],
            wander: 0.0,
            moving: true,
            report: WavesReport::default(),
            budget: 0.0,
            carry: 0.0,
        };
        w.lay_bed();
        w.bubbles.water_depth = spec.depth;
        // Still water to the rest level, or the flow a stream already has.
        let inflow = match spec.left {
            End::Inflow { discharge } => discharge,
            _ => 0.0,
        };
        for i in 0..n {
            w.h[i] = (spec.depth - w.bed[i]).max(0.0);
            w.hu[i] = if w.h[i] > DRY { inflow } else { 0.0 };
        }
        w
    }

    fn lay_bed(&mut self) {
        let (n, dx) = (self.n, self.dx);
        match self.spec.bed {
            Bed::Flat => {}
            Bed::Rocks { count, height, size, seed } => {
                let mut rng = Rng::new(seed as u64);
                for r in 0..count {
                    // Spread along the middle of the line, a little irregularly.
                    let x = self.spec.length * (0.15 + 0.7 * (r as f32 + 0.5 + 0.3 * (rng.uniform() - 0.5)) / count.max(1) as f32);
                    let hgt = height * rng.range(0.6, 1.0);
                    for i in 0..n {
                        let xi = (i as f32 + 0.5) * dx;
                        let z = (xi - x) / (0.5 * size);
                        self.bed[i] += hgt * (-z * z).exp();
                    }
                }
            }
            Bed::Beach { flat, slope } => {
                let x0 = flat * self.spec.length;
                for i in 0..n {
                    let xi = (i as f32 + 0.5) * dx;
                    self.bed[i] = ((xi - x0) * slope).max(0.0);
                }
            }
        }
    }

    pub fn cells(&self) -> usize {
        self.n
    }

    /// Surface elevation of cell `i` (bed plus depth), m.
    pub fn surface(&self, i: usize) -> f32 {
        self.bed[i.min(self.n - 1)] + self.h[i.min(self.n - 1)]
    }

    pub fn depth(&self, i: usize) -> f32 {
        self.h[i.min(self.n - 1)]
    }

    pub fn bed(&self, i: usize) -> f32 {
        self.bed[i.min(self.n - 1)]
    }

    pub fn velocity(&self, i: usize) -> f32 {
        let i = i.min(self.n - 1);
        if self.h[i] > DRY { self.hu[i] / self.h[i] } else { 0.0 }
    }

    pub fn bubbles(&self) -> &BubbleBank {
        &self.bubbles
    }

    pub fn time(&self) -> f64 {
        self.time
    }

    /// The water's mechanical energy (per the whole width), J.
    pub fn energy(&self) -> f32 {
        let mut e = 0.0;
        for i in 0..self.n {
            let (h, b) = (self.h[i], self.bed[i]);
            let u = if h > DRY { self.hu[i] / h } else { 0.0 };
            e += 0.5 * h * u * u + 0.5 * G * ((h + b) * (h + b) - b * b);
        }
        e * RHO_WATER * self.dx * self.spec.width
    }

    /// Where the container is now: its displacement along the line (m) and its tilt (radians,
    /// down to the right), as its motion moves it.
    pub fn pose(&self) -> (f32, f32) {
        let t = self.time as f32;
        let tau = std::f32::consts::TAU;
        match self.spec.motion {
            Motion::Still => (0.0, 0.0),
            Motion::Shake { amplitude, freq } => (amplitude * (tau * freq * t).sin() * (t * freq).min(1.0), 0.0),
            Motion::Tilt { angle, time } => (0.0, angle * (t / time.max(1.0e-3)).min(1.0)),
            Motion::Rock { angle, freq } => (0.0, angle * (tau * freq * t).sin()),
        }
    }

    /// Changes how the container moves (live).
    pub fn set_motion(&mut self, m: Motion) {
        self.spec.motion = m;
        self.moving = true;
    }

    /// Changes the inflow (a brook running faster), m^2/s.
    pub fn set_inflow(&mut self, discharge: f32) {
        if let End::Inflow { .. } = self.spec.left {
            self.spec.left = End::Inflow { discharge: discharge.max(0.0) };
            self.moving = true;
        }
    }

    /// Changes the sea's waves (height m, period s).
    pub fn set_sea(&mut self, height: f32, period: f32) {
        if let End::Sea { depth, .. } = self.spec.left {
            self.spec.left = End::Sea { depth, height: height.max(0.0), period: period.max(0.5) };
            self.moving = true;
        }
    }

    /// The container's horizontal acceleration now, m/s^2 (in its own frame the water feels minus
    /// this), and gravity's component along the line when tilted.
    fn forcing(&self, t: f32) -> f32 {
        let tau = std::f32::consts::TAU;
        match self.spec.motion {
            Motion::Still => 0.0,
            Motion::Shake { amplitude, freq } => {
                let w = tau * freq;
                // Eased in over a period so the start is not a jolt.
                let ease = (t * freq).min(1.0);
                -amplitude * w * w * (w * t).sin() * ease
            }
            Motion::Tilt { angle, time } => {
                let a = angle * (t / time.max(1.0e-3)).min(1.0);
                // Tilting down to the right pulls the water right: the same as accelerating left.
                -G * a.sin()
            }
            Motion::Rock { angle, freq } => -G * (angle * (tau * freq * t).sin()).sin(),
        }
    }

    fn ghost(&self, end: End, inner: usize, left: bool, t: f32) -> (f32, f32, f32) {
        let (h, hu, b) = (self.h[inner], self.hu[inner], self.bed[inner]);
        match end {
            End::Wall => (h, -hu, b),
            End::Outflow => (h, hu, b),
            End::Inflow { discharge } => {
                let q = discharge * (1.0 + self.wander);
                (h, if left { q } else { -q }, b)
            }
            End::Sea { depth, height, period } => {
                // Absorbing and generating: the incoming Riemann invariant `u + 2c` is the incoming
                // wave's (a simple wave on still water of `depth`: `u = 2 (c - c0)`), the outgoing
                // `u - 2c` is the water's own, so waves reflected from the beach leave freely.
                let ease = ((t / period) as f32).min(1.0);
                let eta = 0.5 * height * (std::f32::consts::TAU * t / period).sin() * ease;
                let (c0, cin) = ((G * depth).sqrt(), (G * (depth + eta).max(DRY)).sqrt());
                let sign = if left { 1.0 } else { -1.0 };
                let incoming = 4.0 * cin - 2.0 * c0;
                let u_in = if h > DRY { sign * hu / h } else { 0.0 };
                let outgoing = u_in - 2.0 * (G * h.max(DRY)).sqrt();
                let c = ((incoming - outgoing) / 4.0).max(0.0);
                let u = 0.5 * (incoming + outgoing);
                let hg = (c * c / G).max(DRY);
                (hg, sign * hg * u, b)
            }
        }
    }

    /// HLL flux between two states: (mass, momentum).
    fn hll(hl: f32, ul: f32, hr: f32, ur: f32) -> (f32, f32) {
        let (cl, cr) = ((G * hl).sqrt(), (G * hr).sqrt());
        let sl = (ul - cl).min(ur - cr);
        let sr = (ul + cl).max(ur + cr);
        let fl = (hl * ul, hl * ul * ul + 0.5 * G * hl * hl);
        let fr = (hr * ur, hr * ur * ur + 0.5 * G * hr * hr);
        if sl >= 0.0 {
            fl
        } else if sr <= 0.0 {
            fr
        } else {
            let d = sr - sl;
            ((sr * fl.0 - sl * fr.0 + sl * sr * (hr - hl)) / d, (sr * fl.1 - sl * fr.1 + sl * sr * (hr * ur - hl * ul)) / d)
        }
    }

    /// One step of the surface, `dt` s.
    fn step(&mut self, dt: f32, t: f32) {
        let n = self.n;
        let (gl, gr) = (self.ghost(self.spec.left, 0, true, t), self.ghost(self.spec.right, n - 1, false, t));
        let state = |w: &Self, i: isize| -> (f32, f32, f32) {
            if i < 0 {
                gl
            } else if i as usize >= n {
                gr
            } else {
                let i = i as usize;
                (w.h[i], w.hu[i], w.bed[i])
            }
        };
        for f in 0..=n {
            let (hl, hul, bl) = state(self, f as isize - 1);
            let (hr, hur, br) = state(self, f as isize);
            let b = bl.max(br);
            let (hls, hrs) = ((hl + bl - b).max(0.0), (hr + br - b).max(0.0));
            let ul = if hl > DRY { hul / hl } else { 0.0 };
            let ur = if hr > DRY { hur / hr } else { 0.0 };
            let (fh, fm) = Self::hll(hls, ul, hrs, ur);
            self.flux_h[f] = fh;
            self.flux_m[f] = fm;
            self.left_h[f] = hls;
            self.right_h[f] = hrs;
        }
        let a = self.forcing(t);
        let k = dt / self.dx;
        let manning2 = self.spec.manning * self.spec.manning;
        for i in 0..n {
            let h0 = self.h[i];
            // Audusse: the flux either side corrected by the reconstructed depths' pressure.
            let fr_m = self.flux_m[i + 1] + 0.5 * G * (h0 * h0 - self.left_h[i + 1] * self.left_h[i + 1]);
            let fl_m = self.flux_m[i] + 0.5 * G * (h0 * h0 - self.right_h[i] * self.right_h[i]);
            let h1 = (h0 - k * (self.flux_h[i + 1] - self.flux_h[i])).max(0.0);
            let mut hu1 = self.hu[i] - k * (fr_m - fl_m) - dt * h0 * a;
            if h1 > DRY {
                // Bed friction (Manning), implicit so it can only slow the flow.
                let u = hu1 / h1;
                let c = G * manning2 * u.abs() / h1.powf(4.0 / 3.0);
                hu1 /= 1.0 + dt * c;
            } else {
                hu1 = 0.0;
            }
            self.h[i] = h1;
            self.hu[i] = hu1;
        }
    }

    fn max_speed(&self) -> f32 {
        let mut s = 0.1f32;
        for i in 0..self.n {
            let h = self.h[i];
            if h > DRY {
                s = s.max((self.hu[i] / h).abs() + (G * h).sqrt());
            }
        }
        s
    }

    /// Moves the water one block and makes the bubbles its breaking bores entrain.
    fn block(&mut self) {
        let dt_block = WAVE_BLOCK as f32 / self.sr;
        if let End::Inflow { .. } = self.spec.left {
            // A slow wander of the flow, a few percent over a second or so.
            let a = (-dt_block / 1.5).exp();
            self.wander = self.wander * a + 0.05 * (1.0 - a * a).sqrt() * self.rng.normal();
        }
        let mut done = 0.0f32;
        while done < dt_block {
            let dt = (0.45 * self.dx / self.max_speed()).min(dt_block - done);
            self.step(dt, self.time as f32 + done);
            done += dt;
        }
        self.time += dt_block as f64;
        self.breaking(dt_block);
    }

    /// Finds the breaking bores and spends their dissipation on bubbles.
    fn breaking(&mut self, dt: f32) {
        let n = self.n;
        let w = 2usize;
        let mut bores = 0;
        let mut total = 0.0f32;
        let mut steepest = 0.0f32;
        let mut i = w;
        // A bore is a jump in the surface (not the depth: over a rock the water is shallower and
        // perfectly still) with the flow converging into it.
        let jump = |w_: &Self, a: usize, b: usize| -> Option<(f32, f32, f32)> {
            let (ea, eb) = (w_.surface(a), w_.surface(b));
            let (ua, ub) = (w_.velocity(a), w_.velocity(b));
            // The shallow side and the jump's height.
            let (h1, rise) = if ea < eb { (w_.h[a], eb - ea) } else { (w_.h[b], ea - eb) };
            if h1 <= DRY * 10.0 || ua <= ub + 1.0e-3 {
                return None;
            }
            Some((h1, rise, (eb - ea).abs()))
        };
        while i + w < n {
            let (a, b) = (i - w, i + w);
            steepest = steepest.max(((self.surface(i + 1) - self.surface(i)) / self.dx).abs());
            let breaking = jump(self, a, b).is_some_and(|(h1, rise, _)| (h1 + rise) / h1 > BREAKING);
            if breaking {
                // The strongest jump in this stretch.
                let mut j = i;
                let mut best = 0.0f32;
                let mut k = i;
                while k + w < n && k < i + 3 * w {
                    let d = (self.surface(k + w) - self.surface(k - w)).abs();
                    if d > best {
                        best = d;
                        j = k;
                    }
                    k += 1;
                }
                let (a, b) = (j - w, j + w);
                if let Some((h1, rise, _)) = jump(self, a, b) {
                    let h2 = h1 + rise;
                    // The jump's speed from mass conservation, and the flow through it.
                    let (qa, qb) = (self.hu[a], self.hu[b]);
                    let de = self.surface(b) - self.surface(a);
                    let speed = (qb - qa) / de;
                    let (hs, us) = if self.surface(a) < self.surface(b) { (self.h[a], self.velocity(a)) } else { (self.h[b], self.velocity(b)) };
                    let q = (hs * (us - speed)).abs();
                    let d = RHO_WATER * G * q * rise.powi(3) / (4.0 * h1 * h2) * self.spec.width;
                    total += d;
                    bores += 1;
                    // Fresh if no bore has been near here in the last half second.
                    let t = self.time as f32;
                    let near = j.saturating_sub(4 * w)..(j + 4 * w + 1).min(n);
                    let fresh = !near.clone().any(|c| t - self.bore_seen[c] < 0.5);
                    self.entrain(j, d * dt, rise, h1, fresh);
                    for c in a..=b.min(n - 1) {
                        self.bore_seen[c] = t;
                    }
                }
                i = j + 3 * w;
            } else {
                i += 1;
            }
        }
        self.report.bores = bores;
        self.report.dissipation = total;
        self.report.steepest = steepest;
        self.moving = total > 0.0 || self.forcing(self.time as f32) != 0.0 || !matches!(self.spec.left, End::Wall) || self.energy_moving();
    }

    fn energy_moving(&self) -> bool {
        (0..self.n).any(|i| self.velocity(i).abs() > 1.0e-4)
    }

    /// Where the listener hears cell `i` from: (pan, distance), for a point `across` m off the line.
    fn heard(&self, i: usize, across: f32) -> (f32, f32) {
        let x = (i as f32 + 0.5) * self.dx;
        let [lx, ly, lz] = self.spec.listener;
        let (dx, dy) = (x - lx, across - ly);
        let dist = (dx * dx + dy * dy + lz * lz).sqrt();
        // The line runs left to right in front of the listener.
        (dx / dist.max(1.0e-3), dist)
    }

    /// Spends `energy` J of a breaking bore at cell `i` (a jump of `dh` over `h` m of water) on
    /// bubbles, and, for a crest that has just broken, an impact.
    fn entrain(&mut self, i: usize, energy: f32, dh: f32, h: f32, fresh: bool) {
        let air = ENTRAINING * energy;
        // Carried down through the roller: uniformly to the jump's height (at most the depth).
        let depth = dh.min(h + dh).max(2.0 * MIN_RADIUS);
        let mean_z = 0.5 * depth;
        let each = RHO_WATER * G * 4.0 / 3.0 * std::f32::consts::PI * self.sizes.r3 * mean_z + 4.0 * std::f32::consts::PI * self.sizes.r2 * SURFACE_TENSION;
        let expected = air / each.max(1.0e-12);
        self.report.entrained += expected as f64;
        // Simulate a few; each stands for its share. The body's whole budget is a few thousand a
        // second; what can't be simulated now is carried to the next births, so nothing is lost.
        self.carry += expected;
        let allowed = (self.budget.max(0.0) as u32).min(BIRTHS_PER_BORE);
        if allowed == 0 {
            return self.crest(i, dh, fresh);
        }
        let (sims, count) = if self.carry <= BIRTHS_PER_BORE as f32 {
            // Few enough to make one by one: a Poisson number of them.
            let n = self.rng.poisson(self.carry).min(allowed);
            (n, 1.0)
        } else {
            (allowed, self.carry / allowed as f32)
        };
        self.carry = 0.0;
        for _ in 0..sims {
            let r = self.sizes.sample(&mut self.rng);
            let across = self.rng.range(-0.5, 0.5) * self.spec.width;
            let (pan, dist) = self.heard(i, across);
            let mut b = Birth::new(r, self.rng.range(1.1 * r, depth.max(1.2 * r)));
            b.pan = pan;
            b.distance = dist;
            b.count = count;
            self.queue(b);
            self.budget -= 1.0;
        }
        self.crest(i, dh, fresh);
    }

    /// A crest that has just broken.
    fn crest(&mut self, i: usize, dh: f32, fresh: bool) {
        if fresh && dh > 0.005 {
            // A crest that has just broken plunges and traps a tube of air under its lip, about a
            // quarter of the jump high, which breaks into pockets about as long as they are round:
            // each rings as a bubble of the same volume, a low "glug" in a tub, a thud in surf.
            let tube = 0.25 * dh;
            let r = (0.75 * (0.5 * tube).powi(2) * std::f32::consts::PI * tube).cbrt();
            let across = self.rng.range(-0.5, 0.5) * self.spec.width;
            let (pan, dist) = self.heard(i, across);
            let mut b = Birth::new(r, (0.5 * dh).max(1.1 * r));
            b.pan = pan;
            b.distance = dist;
            b.count = (self.spec.width / (std::f32::consts::PI * tube)).max(1.0);
            self.queue(b);
            self.report.breakers += 1;
        }
    }

    fn queue(&mut self, b: Birth) {
        let at = (self.rng.uniform() * WAVE_BLOCK as f32) as usize;
        if let Some(p) = self.pending.iter_mut().find(|p| p.birth.is_none()) {
            *p = Pending { birth: Some(b), at };
            self.report.simulated += 1;
        }
    }

    /// Whether anything can be heard or is about to be.
    pub fn busy(&self) -> bool {
        self.moving || !self.bubbles.is_silent()
    }

    /// One sample, `[left, right]` in pascals.
    pub fn next_frame(&mut self) -> [f32; 2] {
        let phase = self.counter % WAVE_BLOCK;
        if phase == 0 {
            // At most ~3000 simulated bubbles a second.
            self.budget = (self.budget + 3000.0 * WAVE_BLOCK as f32 / self.sr).min(40.0);
            if self.moving {
                self.block();
            } else {
                self.time += (WAVE_BLOCK as f32 / self.sr) as f64;
            }
        }
        self.counter = self.counter.wrapping_add(1);
        for p in self.pending.iter_mut() {
            if let (Some(b), true) = (p.birth, p.at == phase) {
                self.bubbles.spawn(b);
                p.birth = None;
            }
        }
        self.bubbles.next().0
    }
}

/// Pan gains for a position (re-exported for the scene).
pub fn gains(pan: f32) -> (f32, f32) {
    pan_gains(pan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn still_water_stays_still_over_rocks() {
        let mut spec = WavesSpec::brook(0.0);
        spec.left = End::Wall;
        spec.right = End::Wall;
        let mut w = Waves::new(spec, 44_100.0);
        for _ in 0..4410 {
            w.next_frame();
        }
        let worst = (0..w.cells()).map(|i| (w.surface(i) - spec.depth).abs().max(w.velocity(i).abs())).fold(0.0f32, f32::max);
        assert!(worst < 1.0e-5, "{worst}");
        assert_eq!(w.report.simulated, 0);
    }

    #[test]
    fn deane_stokes_sizes_follow_their_power_laws() {
        let s = TurbulentSizes::new(MAX_BUBBLE);
        let mut rng = Rng::new(9);
        let (mut below, mut a, mut b) = (0, 0, 0);
        for _ in 0..200_000 {
            let r = s.sample(&mut rng);
            assert!((MIN_RADIUS..=MAX_BUBBLE * 1.0001).contains(&r));
            if r < HINZE {
                below += 1;
            }
            // Two octaves above the Hinze scale: R^(-10/3) means (1/2)^(7/3) fewer per octave.
            if (2.0e-3..4.0e-3).contains(&r) {
                b += 1;
            }
            if (1.0e-3..2.0e-3).contains(&r) {
                a += 1;
            }
        }
        assert!((below as f32 / 200_000.0 - s.below_hinze()).abs() < 0.01);
        let ratio = b as f32 / a as f32;
        let want = 0.5f32.powf(7.0 / 3.0);
        assert!((ratio / want - 1.0).abs() < 0.1, "{ratio} vs {want}");
    }
}
