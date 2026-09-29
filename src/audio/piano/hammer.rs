//! Felt hammer mechanics and nonlinear contact dynamics for the grand piano.
//!
//! A piano hammer is not a linear spring or an instantaneous impulse: it is an elastic mass
//! tipped with compressed wool felt that strikes the string at a precise point (typically 1/7 to 1/9
//! of the string length, which suppresses undesirable partials).
//!
//! ### Nonlinear Felt Law
//! Following Suzuki (1987), Hall (1987), and Chaigne & Askenfelt (1994), the compression force
//! follows a stiffening power law with hysteresis:
//!
//! ```text
//! F(t) = K_h * [max(0, delta)]^p * [1 + lambda * d(delta)/dt]
//! ```
//!
//! where:
//! * `delta = y_hammer - y_string` is felt compression (m)
//! * `p` is the felt nonlinearity exponent (typically 2.2 to 2.8; bass felt is softer, treble harder)
//! * `K_h` is felt stiffness, increasing from bass to treble
//! * `lambda` is felt dissipation / hysteresis loss
//!
//! ### Escapement and Catch
//! Once the rebounding string throws the hammer away from contact (`delta <= 0`), the action's
//! escapement and backcheck prevent double-striking until the key is released and re-struck.

/// Physical parameters for a piano hammer at a specific key (0 = A0, 87 = C8).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HammerSpec {
    /// Hammer mass in kg (typically ~11.5 g at A0 down to ~5.0 g at C8).
    pub mass: f32,
    /// Felt stiffness constant K_h (N / m^p).
    pub stiffness: f32,
    /// Nonlinear exponent p (2.2 in bass up to 2.8 in high treble).
    pub exponent: f32,
    /// Contact point as fraction of string length (typically 1/8 to 1/7).
    pub strike_ratio: f32,
    /// Felt hysteresis damping parameter (s/m).
    pub damping: f32,
}

impl HammerSpec {
    /// Generates physical hammer parameters for key index 0..=87 (A0 to C8).
    pub fn for_key(key: usize) -> Self {
        let k = (key.min(87) as f32) / 87.0;
        // Hammer mass decreases from bass to treble.
        let mass = 0.0115 - 0.0065 * k;
        // Felt stiffness increases by orders of magnitude from thick soft bass to hard compressed treble.
        let stiffness = 2.0e8 * (300.0f32).powf(k);
        // Nonlinear exponent rises slightly from bass to treble.
        let exponent = 2.3 + 0.45 * k;
        // Striking position: 1/8.5 in bass up to 1/7.0 in treble.
        let strike_ratio = 1.0 / (8.5 - 1.5 * k);
        let damping = 0.9 + 0.4 * k;

        Self {
            mass,
            stiffness,
            exponent,
            strike_ratio,
            damping,
        }
    }
}

/// State of the hammer during a stroke.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HammerState {
    /// Hammer is resting on the action rail.
    Rest,
    /// Hammer is in contact with the string, exchanging force.
    InContact,
    /// Hammer has bounced off the string and is held by the backcheck.
    Caught,
}

/// A simulated felt hammer striking a piano string unison.
#[derive(Clone, Copy, Debug)]
pub struct Hammer {
    pub spec: HammerSpec,
    pub state: HammerState,
    /// Hammer vertical position (m).
    pub pos: f32,
    /// Hammer velocity (m/s).
    pub vel: f32,
    /// Previous penetration (for velocity estimation).
    prev_delta: f32,
    contact: crate::audio::matter::contact::Contact,
    /// Maximum force reached in the last stroke (N).
    pub peak_force: f32,
    /// Total duration in contact during the last stroke (s).
    pub contact_time: f32,
    /// Una corda attenuation factor (1.0 = normal, ~0.75 = soft pedal).
    pub una_corda: f32,
}

impl Hammer {
    pub fn new(spec: HammerSpec) -> Self {
        Self {
            spec,
            state: HammerState::Rest,
            pos: 0.0,
            vel: 0.0,
            prev_delta: 0.0,
            contact: crate::audio::matter::contact::Contact::new(crate::audio::matter::contact::ContactLaw { k: spec.stiffness, alpha: spec.exponent, restitution: 0.8 }),
            peak_force: 0.0,
            contact_time: 0.0,
            una_corda: 1.0,
        }
    }

    /// Strikes the hammer with MIDI velocity 0.0..1.0 and optional una corda factor (0.0..1.0).
    pub fn strike(&mut self, velocity: f32, una_corda_depth: f32) {
        let v_norm = velocity.clamp(0.01, 1.0);
        // Piano key touch velocity mapping: pp ~ 0.3 m/s, ff ~ 4.5 m/s.
        let touch_speed = 0.25 + 4.25 * v_norm.powf(1.4);
        // Una corda shifts hammer to softer felt, reducing strike speed and stiffness by up to 40%.
        let uc = 1.0 - 0.40 * una_corda_depth.clamp(0.0, 1.0);

        self.contact = crate::audio::matter::contact::Contact::new(crate::audio::matter::contact::ContactLaw { k: self.spec.stiffness * uc, alpha: self.spec.exponent, restitution: 0.8 });
        self.pos = 0.0;
        self.vel = touch_speed * uc;
        self.prev_delta = 0.0;
        self.state = HammerState::InContact;
        self.peak_force = 0.0;
        self.contact_time = 0.0;
        self.una_corda = uc;
    }

    /// Resets hammer to rest state (e.g. after key release).
    pub fn reset(&mut self) {
        self.state = HammerState::Rest;
        self.pos = 0.0;
        self.vel = 0.0;
        self.prev_delta = 0.0;
    }

    /// Solve felt compression against the string's predicted displacement and compliance.
    pub fn step_coupled(&mut self, free_string: f32, compliance: f32, dt: f32) -> f32 {
        if self.state != HammerState::InContact { return 0.0; }
        let hammer_compliance=dt*dt/self.spec.mass;
        let free_hammer=self.pos+self.vel*dt;
        let force=self.contact.solve(free_hammer-free_string, compliance+hammer_compliance,dt);
        self.vel-=force*dt/self.spec.mass;
        self.pos+=self.vel*dt;
        if force>0.0 {self.contact_time+=dt; self.peak_force=self.peak_force.max(force);}
        if self.contact_time>0.0 && force==0.0 && self.vel<0.0 {self.state=HammerState::Caught;}
        force
    }

    /// Steps the hammer dynamics against string displacement `y_string`.
    /// Returns the downward force `F` (N) applied to the string this sample.
    pub fn step(&mut self, y_string: f32, dt: f32) -> f32 {
        if self.state != HammerState::InContact {
            return 0.0;
        }

        // Felt compression: hammer position minus string displacement.
        let delta = self.pos - y_string;

        if delta <= 0.0 && self.prev_delta > 0.0 {
            // Hammer has rebounded away from the string: backcheck catch.
            self.state = HammerState::Caught;
            self.pos = 0.0;
            self.vel = 0.0;
            self.prev_delta = 0.0;
            return 0.0;
        }

        if delta <= 0.0 {
            // Not yet in contact or separated
            self.pos += self.vel * dt;
            self.prev_delta = delta;
            return 0.0;
        }

        // Delta rate of change
        let delta_rate = (delta - self.prev_delta) / dt;
        self.prev_delta = delta;

        // Nonlinear felt force with damping
        let k_effective = self.spec.stiffness * self.una_corda;
        let p = self.spec.exponent;
        let delta_p = delta.powf(p);
        let damping_term = (1.0 + self.spec.damping * delta_rate).max(0.0);
        let force = (k_effective * delta_p * damping_term).max(0.0);

        // Track metrics
        if force > self.peak_force {
            self.peak_force = force;
        }
        self.contact_time += dt;

        // Accelerate hammer backwards: m * a = -F
        let accel = -force / self.spec.mass;
        self.vel += accel * dt;
        self.pos += self.vel * dt;

        force
    }
}
