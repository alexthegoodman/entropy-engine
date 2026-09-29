# Physically Modelled Concert Grand Piano

## 1. Vision & Acoustic Architecture

The grand piano is one of the most acoustically intricate acoustic instruments ever engineered. Across an 88-key compass (A0 at 27.5 Hz to C8 at 4186.0 Hz), a concert grand piano encompasses over 230 strings under 18 to 20 metric tons of tension, anchored to a cast-iron frame and spruce soundboard.

Rather than relying on Gigabytes of static multi-sampled velocities, Entropy's grand piano models the instrument entirely from first-principles acoustics:
* **Nonlinear Felt Hammer Contact Dynamics**: Felt compression with power-law stiffening, hysteretic dissipation, and escapement catch.
* **88-Key Inharmonic Waveguide Strings**: Finite string stiffness generating inharmonic overtones matched to the empirical Railsback stretch tuning curve.
* **Coupled Unisons & Two-Stage Decay**: Trichord and bichord strings detuned by fractions of a cent, coupling through the bridge to produce an initial singing "prompt" sound followed by a long, sustained "aftersound".
* **2D Spruce Soundboard Plate**: High modal density plate resonator driven by bridge force, radiating stereo spatial sound and returning bridge velocity feedback to all strings.
* **Sympathetic Pedal Resonance**: Damper release allowing all undamped strings to vibrate sympathetically with sounding strings through soundboard admittance.
* **Quality Tiers**: Draft (compact modes, 88 strings), Live (48 soundboard modes, active unisons), and Render (128 soundboard modes, full 230+ string simulation at 2x oversampling).

---

## 2. Physical Modeling Equations

### 2.1 Nonlinear Felt Hammer Law

Real piano hammer felt stiffens dramatically as it compresses under high dynamic strikes. Following the experimental findings of Chaigne, Doutaut, and Suzuki, the hammer force $F(\delta, \dot{\delta})$ as a function of felt compression $\delta = (y_h - y_s)^+$ and compression velocity $\dot{\delta}$ is modelled as:

$$F(\delta, \dot{\delta}) = K_h \, \delta^p \, \left[ 1 + \lambda \, \dot{\delta} \right]$$

where:
* $K_h$ is the hammer stiffness parameter ($10^8$ to $10^{10} \text{ N/m}^p$), graduated smoothly from bass to treble.
* $p \approx 2.3 \dots 2.8$ is the nonlinear stiffening exponent. Under pianissimo ($pp$) touch, contact is soft and rounded; under fortissimo ($ff$) touch, felt stiffness rises by orders of magnitude, concentrating energy into upper partials.
* $\lambda \approx 0.1 \dots 0.4 \text{ s/m}$ models internal felt viscoelastic hysteresis (dissipating energy on rebound).
* **Escapement and Backcheck Catch**: Once the hammer rebounds from the string, mechanical escapement prevents secondary bouncing until the key is retriggered.

### 2.2 Waveguide Strings & Railsback Inharmonicity

Due to the finite bending stiffness of steel piano wire, string partials are inharmonic according to the Fletcher-Rossing dispersion relation:

$$f_n = n \, f_0 \, \sqrt{1 + B \, n^2}$$

where $B = \frac{\pi^3 E d^4}{64 T L^2}$ is the inharmonicity coefficient:
* Bass strings: Thick wound core wire yields $B \approx 0.0001 \dots 0.0004$.
* Treble strings: Short, stiff plain steel wire yields $B \approx 0.003 \dots 0.015$.

To preserve natural piano octaves, acoustic pianos are tuned according to the **Railsback curve**, where bass fundamentals are tuned flat (down to -28 cents at A0) and treble fundamentals are tuned sharp (up to +32 cents at C8). In Entropy, inharmonic dispersion is simulated via a cascade of 8 first-order allpass filters within each digital waveguide loop:

$$A(z) = \frac{a + z^{-1}}{1 + a \, z^{-1}}$$

where the coefficient $a$ is calibrated to the required inharmonicity parameter $B$ for each key.

### 2.3 Unison Coupling and Two-Stage Decay

In a grand piano, notes in the tenor register have 2 strings (bichords), and notes in the treble have 3 strings (trichords). The unisons are tuned with micro-detuning ($\pm 0.35 \dots 0.45$ cents).

When struck, the strings initially move in-phase, transferring high energy to the bridge (the rapid **prompt sound**, decaying at 10 to 20 dB/s). As motion continues, minute phase differences cause the strings to vibrate anti-phase, cancelling net force at the bridge and preserving energy inside the string waveguides (the singing **aftersound**, decaying at 1 to 4 dB/s). This produces the signature two-stage decay ratio ($> 1.5$) essential to concert grand realism.

### 2.4 Spruce Soundboard & Sympathetic Bridge Admittance

The soundboard is a tapered spruce plate acting as an acoustic radiator and mechanical coupling medium. Bridge velocity $v_{\text{bridge}}$ feeds back into all strings:

$$v_{\text{bridge}}(t) = \sum_{m=1}^{M} v_m(t)$$

$$\ddot{y}_m + 2 \gamma_m \dot{y}_m + \omega_m^2 y_m = \beta_m F_{\text{bridge}}(t)$$

When the sustain pedal is depressed ($sustain = 1.0$), all 88 individual felt dampers lift from the strings. Bridge vibrations from any played note excite all harmonically related strings across the harp, creating a rich, wash of sympathetic resonance.

---

## 3. Presets & Voicings

1. **Concert Grand**: Deep, expansive resonance modelled on a 9-foot German concert grand. Full soundboard coupling, balanced Railsback stretch, and rich bass singlets.
2. **Studio Grand**: Tight, focused decay with reduced modal bloom, ideal for modern mixes, pop, and jazz rhythm sections.
3. **Bright Grand**: Stiffer felt hammers, enhanced treble dispersion, and immediate attack clarity for solo passages.
4. **Warm Grand**: Softer felt compression ($p \approx 2.2$), gentle treble loss, and prominent low spruce soundboard modes.

---

## 4. Real-Time Safety & DSP Performance

* **Zero Allocation on Audio Thread**: Note-on, note-off, continuous pedal commands, and lock-free UI telemetry publish without heap allocations.
* **2x Oversampling**: Simulation runs at 88.2 kHz internally to prevent aliasing during ultra-fast hammer-string collisions, decimated to 44.1 kHz via half-band `Decimator2`.
* **Lock-Free Telemetry**: `PianoShared` publishes per-key atomic energy, hammer positions, damper states, soundboard modal energy, and latest contact metrics for UI widgets.
