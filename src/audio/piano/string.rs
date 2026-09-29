//! Stiff-string modal solution. Each mode integrates q'' + 2 sigma q' + w? q = F sin(n pi beta)/m.
//! Exact rotations avoid the pitch drift and excessive high-partial loss of short delay loops.
//! Fundamental-normalized dispersion: fn = n f1 sqrt((1+B n?)/(1+B)).
use std::f32::consts::{PI, TAU};
/// Specifications for a single piano string.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PianoStringSpec {
    /// Fundamental frequency in Hz (nominal pitch).
    pub freq: f32,
    /// Characteristic impedance sqrt(T * rho) in kg/s.
    pub impedance: f32,
    /// Inharmonicity coefficient B: f_n = n * f0 * sqrt(1 + B * n^2).
    pub inharmonicity: f32,
    /// T60 decay time in seconds when undamped.
    pub t60_undamped: f32,
    /// T60 decay time in seconds when damper is engaged.
    pub t60_damped: f32,
    /// High-frequency loss cutoff in Hz.
    pub loss_cutoff_hz: f32,
    /// Whether this string has a damper (high treble keys do not).
    pub has_damper: bool,
}

impl PianoStringSpec {
    /// Constructs realistic piano string parameters for key index 0..=87 (A0 to C8).
    pub fn for_key(key: usize, freq: f32) -> Self {
        let k = (key.min(87) as f32) / 87.0;

        // Inharmonicity B: lowest in bass (~0.00015), rising sharply in short stiff treble strings (~0.003).
        let inharmonicity = 0.00015 * (1.0 + 20.0 * k.powi(3));

        // Impedance: heavy wound bass strings (~4.5 kg/s) down to light treble wires (~0.8 kg/s).
        let impedance = 4.5 - 3.7 * k.powf(0.6);

        // Undamped sustain T60: long ringing bass (up to 32s), mid register (~13-16s), shortening toward treble (~3.5s).
        let t60_undamped = 32.0 * (1.0 - 0.78 * k.powf(0.5)).max(0.3);

        // Damped decay time: felt damper drops note within ~0.12 - 0.18 seconds.
        let t60_damped = 0.14 + 0.04 * (1.0 - k);

        // Treble keys above key 68 (around F#6 and above) have no dampers on acoustic grand pianos.
        let has_damper = key < 69;

        // Loop loss filter cutoff: higher register has brighter initial transmission.
        let loss_cutoff_hz = (7000.0 + 9000.0 * k).min(18000.0);

        Self {
            freq,
            impedance,
            inharmonicity,
            t60_undamped,
            t60_damped,
            loss_cutoff_hz,
            has_damper,
        }
    }
}


struct Mode {
    q: f32, v: f32, qh: f32, vh: f32, hdecay: f32, c: f32, sw: f32, ws: f32,
    force_q: f32, force_v: f32, shape: f32, bridge: f32,
    decay: f32, omega: f32,
}

pub struct SinglePianoString {
    spec: PianoStringSpec,
    modes: Vec<Mode>,
    damper: f32,
    damper_target: f32,
    damper_decay: f32,
    pub hammer_disp: f32,
    pub bridge_vel: f32,
    pub energy: f32,
}

impl SinglePianoString {
    pub fn new(spec: PianoStringSpec, tuned_freq: f32, strike_ratio: f32, sr: f32) -> Self {
        let mut modes = Vec::new();
        let modal_mass = spec.impedance / (4.0 * tuned_freq);
        for n in 1..=96 {
            let nf = n as f32;
            let hz = nf * tuned_freq * ((1.0 + spec.inharmonicity * nf * nf) / (1.0 + spec.inharmonicity)).sqrt();
            if hz > (sr * 0.21).min(18000.0) { break; }
            let omega = TAU * hz;
            let (s,c) = (omega / sr).sin_cos();
            // Finite hammer width suppresses very short spatial wavelengths.
            let shape = (nf * PI * strike_ratio).sin() * (-0.00018 * nf * nf).exp();
            let sigma = 6.9078 / spec.t60_undamped + 0.10 * nf.powf(1.35) + 0.6 * (hz / spec.loss_cutoff_hz).powi(2);
            modes.push(Mode { q: 0.0, v: 0.0, qh:0.0, vh:0.0, hdecay:(-sigma*0.65/sr).exp(), c, sw: s / omega, ws: omega * s,
                force_q: (1.0-c) / (omega*omega*modal_mass) * shape,
                force_v: s / (omega*modal_mass) * shape, shape,
                bridge: TAU * tuned_freq * spec.impedance * nf * if n % 2 == 0 { 1.0 } else { -1.0 },
                decay: (-sigma/sr).exp(), omega });
        }
        Self { spec, modes, damper: 0.0, damper_target: if spec.has_damper {1.0} else {0.0},
            damper_decay: (-6.9078 / (spec.t60_damped * sr)).exp(), hammer_disp: 0.0, bridge_vel: 0.0, energy: 0.0 }
    }
    pub fn set_damper(&mut self, down: bool) { self.set_damper_amount(if down {1.0} else {0.0}); }
    pub fn set_damper_amount(&mut self, amount: f32) { self.damper_target = if self.spec.has_damper { amount.clamp(0.0,1.0) } else {0.0}; }
    pub fn is_damper_down(&self) -> bool { self.damper_target > 0.5 }
    pub fn clear(&mut self) { for m in &mut self.modes { m.q=0.0; m.v=0.0; m.qh=0.0; m.vh=0.0; } self.energy=0.0; self.hammer_disp=0.0; }
    pub fn predict(&self) -> (f32,f32) {
        let mut q=0.0; let mut compliance=0.0;
        for m in &self.modes {
            q += ((m.c*m.q + m.sw*m.v)*m.decay+0.3*(m.c*m.qh+m.sw*m.vh)*m.hdecay)*m.shape;
            compliance += 1.09*m.force_q*m.shape;
        }
        (q,compliance)
    }
    pub fn step(&mut self, hammer_force: f32, bridge_feedback_vel: f32, dt: f32) -> f32 {
        self.damper += (self.damper_target-self.damper) * (dt*500.0).min(1.0);
        let damping=1.0-self.damper*(1.0-self.damper_decay);
        let mut force=0.0; let mut displacement=0.0; let mut energy=0.0;
        for m in &mut self.modes {
            let q=(m.c*m.q + m.sw*m.v)*m.decay*damping + m.force_q*hammer_force;
            let v=(m.c*m.v - m.ws*m.q)*m.decay*damping + m.force_v*hammer_force;
            // Weak bridge transmission into the string's modes; disabled with coupling=0.
            m.v=v + bridge_feedback_vel * m.bridge.signum() * dt * 12.0;
            m.q=q;
            // Weakly radiating transverse polarization: less bridge loss, responsible
            // for a singing tail after the vertical prompt motion has decayed.
            let qh=(m.c*m.qh+m.sw*m.vh)*m.hdecay*damping + m.force_q*hammer_force*0.3;
            m.vh=(m.c*m.vh-m.ws*m.qh)*m.hdecay*damping + m.force_v*hammer_force*0.3;
            m.qh=qh;
            displacement += (q+0.3*m.qh)*m.shape;
            force += (q+0.6*m.qh)*m.bridge;
            energy += v*v + (m.omega*q).powi(2) + m.vh*m.vh + (m.omega*m.qh).powi(2);
        }
        self.hammer_disp=displacement;
        self.bridge_vel=bridge_feedback_vel;
        self.energy=energy;
        force
    }
}

pub struct PianoUnison {
    pub key: usize,
    pub strings: Vec<SinglePianoString>,
    pub spec: PianoStringSpec,
    pub energy: f32,
}
impl PianoUnison {
    pub fn new(key: usize, freq: f32, count: usize, beta: f32, sr: f32) -> Self {
        Self::configured(key,freq,count,beta,sr,1.0,1.0)
    }
    pub fn configured(key: usize, freq: f32, count: usize, beta: f32, sr: f32, stiffness: f32, decay: f32) -> Self {
        let mut spec=PianoStringSpec::for_key(key,freq);
        spec.inharmonicity *= stiffness;
        spec.t60_undamped *= decay;
        let offsets: &[f32]=match count {1=>&[0.0],2=>&[-0.5,0.5],_=>&[-0.65,0.0,0.65]};
        let strings=offsets.iter().map(|c|SinglePianoString::new(spec,freq*2.0f32.powf(c/1200.0),beta,sr)).collect();
        Self {key,strings,spec,energy:0.0}
    }
    pub fn set_damper(&mut self, down: bool) { for s in &mut self.strings {s.set_damper(down);} }
    pub fn set_damper_amount(&mut self, amount: f32) {for s in &mut self.strings {s.set_damper_amount(amount);} }
    pub fn is_damper_down(&self)->bool {self.strings[0].is_damper_down()}
    pub fn clear(&mut self) {for s in &mut self.strings {s.clear();} self.energy=0.0;}
    pub fn hammer_displacement(&self)->f32 {self.strings.iter().map(|s|s.hammer_disp).sum::<f32>()/self.strings.len() as f32}
    pub fn predict(&self)->(f32,f32) {
        let n=self.strings.len() as f32;
        let (mut q,mut c)=(0.0,0.0);
        for s in &self.strings {let (sq,sc)=s.predict(); q+=sq/n; c+=sc/(n*n);}
        (q,c)
    }
    pub fn step(&mut self, force: f32, bridge: f32, dt: f32)->f32 {
        let n=self.strings.len() as f32;
        let mut out=0.0; let mut energy=0.0;
        for s in &mut self.strings {out+=s.step(force/n,bridge,dt); energy+=s.energy;}
        // A dissipative shared bridge damps the in-phase component faster than the
        // differential unison motion. The latter supplies the sustained aftersound.
        if self.strings.len()>1 {
            let count=self.strings.iter().map(|s|s.modes.len()).min().unwrap();
            for i in 0..count {
                let mean=self.strings.iter().map(|s|s.modes[i].v).sum::<f32>()/n;
                for s in &mut self.strings {s.modes[i].v -= mean * (dt*4.0);}
            }
        }
        self.energy=0.995*self.energy+0.005*energy;
        out
    }
}
