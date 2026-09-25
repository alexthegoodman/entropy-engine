# Physical Modeling String Instrument

## Vision

As a musician using Entropy DAW, I want to play and design a physically modeled bowed-string instrument whose sound and 3D representation are two views of the same underlying instrument, so that I can understand and shape sound through intuitive physical relationships rather than relying exclusively on abstract synthesizer controls.

The instrument should be capable of producing convincing violin, viola, cello, bass, and string-section sounds without requiring recorded samples as its fundamental sound source.

However, realism is only the starting point.

The same system should eventually allow musicians to construct instruments that cannot exist in the physical world: unusual string lengths and materials, impossible body dimensions, unconventional bridges and resonators, sympathetic strings, novel excitation mechanisms, and other combinations that turn acoustic-instrument design itself into a form of synthesis.

The guiding idea is:

**Don't just program a sound. Build an instrument.**

---

## Core Experience

When I load the instrument, I see a playable 3D string instrument rather than only a conventional synthesizer panel.

Playing MIDI causes the modeled instrument to respond visually and acoustically. Strings vibrate. The bow interacts with them. Energy travels through the bridge and into the resonating body. Vibrational motion may be visually exaggerated so that phenomena too small or fast to see on a real instrument become understandable.

Traditional controls such as knobs, sliders, numerical inputs, modulation assignments, and automation remain available. The 3D instrument does not replace precise controls; it provides a more intuitive representation of what those controls mean.

Whenever practical, these two interfaces remain synchronized. Moving a bow-position control moves the bow's contact point in the visualization. Manipulating the bow directly updates the corresponding parameter. Changing the instrument's physical properties changes both its appearance or physics visualization and its sound.

The result should feel less like controlling an animation attached to a synthesizer and more like interacting with a virtual acoustic object.

---

# Phase 1 — Playable Modeled String

The first phase establishes the instrument as a genuinely playable synthesizer.

The initial target should be a single bowed string instrument, such as a violin or cello, rather than attempting an entire orchestra immediately.

The sound is generated from a physical model of the instrument. At minimum, the model represents the interaction between:

**player → bow → string → bridge/body → audible output**

The performer can play the instrument from MIDI and continuously control the most musically important dimensions of the model, including dynamics, bow force, bow velocity, bow position, vibrato, fingering/pitch, damping, and related expressive characteristics.

These parameters should behave as properties of a physical system rather than merely conventional synthesizer macros. Increasing bow pressure, for example, should alter the behavior and harmonic structure of the string rather than simply increasing volume.

A 3D representation of the instrument accompanies the synthesis. It reacts in real time to the state of the model, including the currently sounding string, fingering position, bow position and motion, and string vibration.

The visualization does not need to reproduce microscopic physics literally. Displacements and vibrations may be exaggerated substantially to communicate what the model is doing.

### Phase 1 success

A musician can load the instrument, play a convincing and expressive bowed-string performance from MIDI, and immediately develop an intuitive relationship between what they hear and what they see.

Someone unfamiliar with terms such as "bow position" should be able to manipulate the instrument visually and begin understanding the parameter by hearing the result.

---

# Phase 2 — Physics as the Interface

Once the underlying instrument is convincing, the 3D representation becomes a primary sound-design interface.

The musician can directly manipulate meaningful parts of the virtual instrument. Depending on the selected component, they can modify properties such as string characteristics, bow contact, bridge behavior, damping, resonances, body response, and coupling between components.

Traditional controls remain available for precision and automation, but manipulating the physical object and manipulating its parameters are two interfaces into the same state.

The instrument gains a dedicated **Physics View** alongside its normal visual presentation.

Physics View reveals otherwise invisible behavior: standing waves along strings, nodes and antinodes, energy entering the bridge, resonant modes of the body, damping, excitation, and other useful representations of the synthesis state.

These visualizations should prioritize musical understanding over strict scientific visualization. Microscopic motion can be exaggerated, slowed, colored, isolated, or otherwise transformed when doing so makes the behavior easier to understand.

The musician should increasingly be able to answer:

**"Why did that change the sound?"**

simply by looking at the instrument.

### Phase 2 success

Sound design no longer feels primarily like adjusting unrelated parameters.

A musician can hear an undesirable or interesting characteristic, inspect what the virtual instrument is doing, manipulate the relevant physical component, and immediately hear and see the consequences.

The 3D model has become a functional synthesis interface rather than a visualizer.

---

# Phase 3 — Instrument Laboratory

The final phase deliberately moves beyond simulation of existing instruments.

The musician can modify the architecture of the modeled instrument itself.

They might lengthen a violin body, alter string dimensions or materials, modify the bridge, change the resonating body, introduce sympathetic strings, create unusual couplings between resonators, or construct configurations with no practical real-world equivalent.

Parameters should be allowed to move beyond physically conventional ranges where the synthesis model remains stable and musically useful.

Presets can therefore represent both familiar instruments:

**Violin → Viola → Cello → Bass**

and entirely invented families of instruments.

Where appropriate, physical dimensions become continuous dimensions of synthesis. Rather than selecting "violin" or "cello," for example, the musician could move through the physical space between them and continue beyond either.

The ultimate experience resembles a virtual instrument workshop. A musician can begin with a recognizable violin, pull and reshape its physical properties while playing it, and gradually transform it into an instrument that has never existed.

### Phase 3 success

Users are no longer asking only:

**"How realistic is the violin?"**

They are also asking:

**"What happens if I build this?"**

A sound created in the instrument can be understood not merely as a collection of synthesizer settings, but as the behavior of a particular virtual acoustic object.

---

## Important Product Principle: One Instrument, Two Representations

The audio simulation and visual simulation do not need to operate at the same fidelity or update rate.

The audio engine should use whatever representation is appropriate for stable, low-latency synthesis. The visualization should consume meaningful state from that model and render an intuitive representation at graphical frame rates.

Therefore, visual geometry does not necessarily need a one-to-one correspondence with the mathematical representation used by the audio engine.

What matters is **semantic correspondence**:

When the user changes something they can see, the appropriate physical property of the synthesis model changes.

When the synthesis model changes in a musically meaningful way, the visualization communicates that change.

The visualization should never imply a physical relationship that is unrelated to the resulting sound merely for the sake of animation.

---

## Interaction Principle

Every major parameter should be considered for three possible representations:

**Physical interaction** — manipulate something on the instrument.

**Precision control** — manipulate a knob, slider, numerical value, or other conventional control.

**Modulation/automation** — allow the DAW, MIDI, envelopes, LFOs, controllers, or other sources to manipulate it over time.

These should converge on the same underlying parameter wherever possible.

For example, bow position might be changed by dragging the bow in 3D, turning a knob, recording automation, mapping MIDI CC, or assigning modulation. Regardless of how it is changed, the 3D instrument and conventional UI remain synchronized.

This allows the interface to remain approachable without sacrificing the precision expected from a serious synthesizer.

---

## North Star

The feature succeeds when the visualization stops feeling like a visualization.

The user should gradually develop the mental model that there is an **instrument inside Entropy**.

It has strings.

It has a body.

It has resonances.

Energy moves through it.

The performer excites it.

Its construction determines its voice.

And because it is virtual, its construction does not have to obey the practical limitations of wood, strings, gravity, manufacturing, or even conventional instrument design.

**Physical modeling provides the sound.
3D provides the intuition.
Entropy turns the instrument itself into the synthesizer.**

---

# Implementation Status

What exists today, where it lives, and how each claim is checked. The model was built and tuned
without anyone listening to it: every behaviour below is measured from rendered audio, and the
tests keep those measurements in place.

## The model (`src/audio/physmod/`)

| Piece | File | What it is |
|---|---|---|
| String | `string.rs` | Four-segment digital waveguide (finger↔bow, bow↔bridge, both directions), cubic-Lagrange fractional delays, losses at bridge / nut / fingertip, optional stiffness dispersion solved per note for a target inharmonicity `B`. Rebuilds its own displacement shape for the view. |
| Bow | `friction.rs` | McIntyre–Schumacher–Woodhouse friction: hyperbolic curve solved in closed form against the string impedance each sample, stick/slip hysteresis. Physical units underneath (N, m/s, fraction of string). |
| Body | `body.rs` | 10 coupled modes (A0, CBR, B1±, …, the bridge hill) whose summed velocity is the bridge's motion, fed back into every string; 40 seeded radiating modes up to ~10 kHz, stereo. Scales continuously with instrument size. |
| Instrument + player | `engine.rs` | Strings (4 bowed + up to 6 sympathetic), shared body, 2× oversampling. A virtual player per string: string choice, double stops vs slurs (40 ms chord window), bow reversal, guided attack and attack assist (`attack_skill`), intonation by ear, delayed vibrato, pizzicato, col legno, ring/damp on release. |
| Measurement | `analysis.rs` | Pitch (cents), level, centroid, harmonics, bow regime, attack time. Shared by tests, `Entropy.PhysMod.analyzeNote`, and the DAW's AI tool. |
| Runtime | `mod.rs` | `PhysModShared` (lock-free state for the view), `PhysModVoice` (one self-contained note), `PhysModInstrumentVoice` (one live instrument per track: notes share strings and body), `render_performance` (offline bounces through one instrument). |

## Phase 1 — Playable modeled string: done

- Player → bow → string → bridge/body → output, with bow force, speed, position, vibrato,
  fingering, damping and dynamics as physical controls. More force changes the motion (brighter,
  then raucous), not just the level.
- Violin, viola, cello and bass presets; notes go to the string a player would use.
- The 3D view (`src/entropy_gui/widgets_physmod.rs`) draws every string's simulated shape, the
  finger, the bow coloured by friction regime, the body and sympathetic strings.

## Phase 2 — Physics as the interface: largely done

- **Physics View**: standing-wave envelopes with nodes, the travelling Helmholtz corner, body-mode
  levels, a live Schelleng (playable-window) diagram, "ringing in sympathy" readout.
- Dragging the bow in 3D or in the Schelleng diagram, the knobs, the AI tool and live automation
  all move the same held note (`PhysModLive`).
- Not yet: direct manipulation of body/bridge/string construction from the 3D view (those are knobs).

## Phase 3 — Instrument laboratory: started

- Continuous size axis (`body_size` -1 … 2.5) with optional tuning that follows it (violin →
  viola → cello → bass and beyond); string mass, stiffness, rosin, bow grit, bridge coupling (up to
  wolf notes), body resonance, "maker" seed, sympathetic strings.
- Invented presets: Hardanger (understrings), glass violin, octobass, wolf cello.

## How it is verified (no audio device needed)

| Claim | Where |
|---|---|
| In tune within 6 cents across the violin; cello/bass low notes within 8–10 | `physmod::tests`, `physmod_synth.feature` |
| Normal stroke = Helmholtz motion (1 release/period, stuck ≈ 1−β of it), settles < 0.2 s | same |
| Schelleng window: surface sound below F_min, raucous above F_max; F_min rises steeply toward the bridge | same |
| Faster bow louder (~6 dB per doubling); ponticello brighter than tasto | same |
| Open strings / sympathetic strings ring when they share a harmonic; coupling controls it | same |
| Wolf note on a strongly coupled cello, tamed by a firmer bow, absent at normal coupling | `physmod_synth.feature` |
| Pizzicato decays; stiffness stretches partials; bounded output for impossible instruments | `physmod::tests` |
| View draws the instrument, Physics View overlays, chip + diagram interactions | `tests/physmod_view.rs` (pictures in `test-artifacts/physmod-view/`) |
| No allocation on the audio thread while notes arrive, slur and release | `tests/physmod_no_alloc.rs` |
| DAW settings, presets, morph, repair of old songs | `examples/studio-bundle/tests/daw_physmod.test.ts` |

The fitted laws the engine uses — `force_center` (where the middle of the force knob sits) and
`schelleng_window` — come from sweeps of the model itself: 37 notes (bass E1 … violin G6) for the
centre, 180 window edges at three bow positions for the window (fitted exponents: F_min ∝ β^-2.5,
F_max ∝ β^-1.4, against Schelleng's -2 and -1).

## Known limits

- The bottom five or so bass notes take 0.3–0.5 s to settle into clean motion (25–35 periods).
- The fitted window laws are good to about ×1.35; the view's diagram is an estimate, while the
  sound is always the simulation itself.
- Not modelled yet: bow width, torsional waves, thermal (temperature-dependent) friction, the
  string's second polarisation.
- A whole instrument costs about 4% of one core (plus ~1% per sympathetic string) in release builds.
