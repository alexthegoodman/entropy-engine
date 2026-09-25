# Physical Modeling Brass Instrument

## Vision

As a musician using Entropy DAW, I want to play and design a physically modeled brass instrument
whose sound and 3D representation are two views of the same air column, lips and bell, so that I
can shape everything from a soft horn call to a full-section fortissimo blast through physical
relationships rather than through samples or abstract synthesizer controls.

The instrument should be able to produce convincing trumpet, trombone, French horn, tuba and
brass-section sounds with no recorded samples as its sound source. Above all it has to deliver
what brass is used for most in a score: **drama**. The swell from *pp* to *fff*, where the tone
does not just get louder but turns from round to blazing; the brassy rasp of a trombone section; the
menace of stopped horns; rips, falls, growls and the enormous low brass hit.

Those effects should come out of the physics, not be layered on top of it. A real trombone gets
bright at *fff* because the pressure wave in its long cylindrical bore steepens into a shock front
before it reaches the bell. A horn note cracks because the player's lips locked onto the wrong
resonance of the tube. If the model captures those mechanisms, the drama comes with them.

As with the strings, realism is only the starting point. The same system should let a musician
build brass instruments that cannot exist: forty-metre horns, bells that flare the wrong way, bores
that morph from trumpet to tuba while you play, several bells on one air column, a violin string
driving a horn (a Stroh violin taken to its limit), or a carnyx the size of a building.

**Don't just program a sound. Build an instrument.**

---

## What makes brass different from strings

The string model is **player → bow → string → bridge/body → output**. Brass has a different chain,
and the differences shape the whole plan:

**player (breath, embouchure) → lips → mouthpiece → bore (leadpipe, valves/slide, bell) → radiation → output**

| | Bowed string | Brass |
|---|---|---|
| Exciter | Bow: friction, stick/slip | Lips: a mass-spring valve blown open by the player's breath (an "outward-striking" valve in Fletcher's terms) |
| Resonator | A string: nearly harmonic, weakly lossy | An air column whose resonances are only made harmonic by the flare of the bell and the mouthpiece; strongly lossy |
| What sets the pitch | The finger (string length) | Tube length (valves, slide) picks a family of resonances; lip tension picks *which* resonance sounds |
| Main nonlinearity | Friction curve at the bow | Air flow through the lip opening (Bernoulli), lip collision, and *nonlinear propagation* in the bore at high levels |
| Radiation | Through the body's modes | From the bell: high frequencies leave, low frequencies reflect back and sustain the oscillation |
| Where "loud and bright" comes from | Bow force and speed within Schelleng's window | Mouth pressure: spectral enrichment from the lip flow, then shock-wave "brassiness" from the bore |
| Polyphony | One instrument plays double stops | One player plays one note; chords are sections of players |

Two consequences run through the phases below:

1. **The bore is the instrument.** Its profile (radius along its length) determines tuning, timbre,
   response, and what the 3D view should draw. The same profile should drive both.
2. **The player matters more.** On a string, the finger fixes the pitch. On brass, the player has to
   choose a valve combination *and* set the lips to land on the right resonance, and can miss. The
   virtual player is a bigger part of this instrument than it was for the violin.

---

## Core Experience

When I load the instrument, I see a playable 3D brass instrument, not only a synthesizer panel.

Playing MIDI makes the instrument respond visually and acoustically. The lips buzz in the
mouthpiece. Valves go down or the slide moves. A pressure wave travels down the bore, part of it
leaves the bell and part reflects back. At *fortissimo* the wave front visibly sharpens as it
travels. The bell's radiation lobe narrows and brightens. Motions that are too small or too fast
to see on a real instrument are exaggerated so they can be understood.

Conventional controls (knobs, sliders, numbers, modulation, automation) remain available and
stay synchronized with the 3D instrument. Pushing a valve in 3D is the same as changing the
fingering parameter. Dragging the slide is the same as the slide knob or pitch bend. Pushing a hand
or a mute into the bell changes both what you see and what you hear.

Brass is played with breath, so **continuous control of breath is a first-class input**: MIDI
breath controller (CC2), expression (CC11), aftertouch and MPE pressure all map to mouth pressure,
the brass equivalent of bow force and speed together.

---

# Phase 1 — Playable Modeled Brass

The first phase makes the instrument a genuinely playable, convincing brass synthesizer.

Following the strings plan, it starts with **one instrument**, the **tenor trombone**, and extends
to the family once the core model is right:

- Its bore is mostly cylindrical, so nonlinear steepening ("brassiness"), the key sound of dramatic
  brass, is strongest and easiest to verify on it.
- The slide is a single continuously variable length, so the first version needs no valve
  topology, and glissandi are there from the start.
- It covers the dramatic low-to-middle register that film and game scores lean on.

The trumpet, French horn and tuba follow in Phase 1c, reusing everything except the bore profile
and the valve/slide description.

### Phase 1a — The air column

The bore is represented once, as a **bore profile**: a list of segments (mouthpiece cup, throat,
backbore, leadpipe, cylindrical tubing, valve/slide sections, bell flare), each cylindrical,
conical, or a Bessel-horn flare `r(x) = b·(x₀ − x)^−γ`. Profiles for the stock instruments come from
published approximate dimensions. Like the violin body modes, they are illustrative defaults, not a
measurement of one instrument.

Two representations are derived from that profile:

- **Reference (offline, off the audio thread): the transfer-matrix method.** Chain the acoustic
  transfer matrices of the segments, including visco-thermal wall losses and a radiation impedance
  at the bell, to get the bore's **input impedance** `Z(f)` at the mouthpiece. This is the ground
  truth used for tuning and testing: it shows where the resonances are, how strong they are, and
  how well they line up with a harmonic series.
- **Runtime: a digital waveguide.** Cylindrical sections become fractional delay lines (the string
  model's cubic-Lagrange `Delay` from `physmod::dsp`) with one-pole visco-thermal loss filters.
  Conical sections become spherical-wave waveguides joined by scattering junctions with the usual
  one-pole junction filters, so the waveguide has no unstable growing modes. The bell becomes a pair
  of low-order filters: a **reflection filter**, which passes lows back up the bore, and a
  **transmission filter**, which passes highs out to the room. Both are fitted at build time to the
  reference model's bell reflection function.

The runtime waveguide is checked against the reference: the impedance peaks of the waveguide
(measured by exciting it with an impulse at the mouthpiece) have to match the TMM peaks. This
mirrors how the string engine's fitted laws came from sweeps of the model itself.

The slide is a length change of the two cylindrical slide delay lines, smoothed and read with
fractional delay so a glissando is click-free. Valves (Phase 1c) switch extra tubing into the
path. A **half-pressed valve** is a three-way scattering junction whose area ratios follow the
piston position, so half-valve effects and valve transients emerge from the model.

### Phase 1b — The lips and the player's breath

**Lip model.** The lips are a damped mass-spring oscillator (one mass to start, with a two-degree-of-
freedom "swinging door plus upward" model as an extension). The opening height `h` responds to the
pressure difference between mouth `p_m` and mouthpiece `p`, and the volume flow through the opening
follows Bernoulli:

```
m·ḧ + (m·ω_l/Q_l)·ḣ + m·ω_l²·(h − h₀) = S·(p_m − p)          (the lips)
U = w·h⁺·sqrt(2·|p_m − p|/ρ)·sign(p_m − p)                     (the flow)
p = mouthpiece response to U (the waveguide's incoming wave + Z_c·U)
```

When `h` reaches zero the lips collide: the flow stops and a stiff contact spring takes over. As
with the bow's friction solve, the flow/pressure coupling at the mouthpiece is solved **per sample
in closed form or with a short, bounded Newton iteration**, never by guessing. The lip equations use
a stable (semi-implicit) integrator at the engine's oversampled rate: 2× like the strings to start,
4× if the shock-wave work in 1d needs it.

The oscillation, its threshold, its pitch pulling and its spectrum all come out of this coupling,
not out of tuning:

- Below a **threshold mouth pressure** nothing sounds. Just above it the tone is nearly sinusoidal.
  The threshold rises with the resonance number and depends on how close the lip frequency is to it.
- As `p_m` rises, the lip opening waveform becomes more pulse-like and the spectrum grows richer.
  This is the first half of the brass "spectral enrichment" with dynamics.
- The sounding pitch sits slightly above the air-column resonance (the lips are an outward-striking
  valve), and moves with lip tension. That is how players "lip" notes into tune.

**Physical units underneath.** Mouth pressure is in pascals (a trombone runs from about 1 kPa at
*pp* to 10+ kPa at *fff*, a trumpet up to about 20 kPa), lip mass in kg/m², lip frequency in Hz,
and opening in mm. Knobs are logarithmic 0..1 mappings onto those quantities, like `bow_newtons`
and `bow_speed`, with a fitted `pressure_center` law. That law is found by sweeping the model, so
the middle of the dynamics knob is a comfortable *mezzo* on every note of every instrument.

**Performer controls** (the brass counterpart of `PhysModParams`' first group):

| Control | Physical meaning |
|---|---|
| Dynamics / breath | Mouth pressure `p_m` (velocity sets the target; breath CC / expression / aftertouch move it continuously) |
| Lip tension | Lip resonance `f_l` relative to the target resonance: low gives a dark, loose sound that falls toward the lower partial; high gives a pinched sound that pops up to the next one |
| Aperture | Rest opening `h₀`: small is focused and brilliant, large is airy and fat |
| Buzz / lip roughness | Asymmetry and a little turbulence in the lip motion: from pure to raw and growly |
| Breath noise | Turbulent noise in the flow (grows with pressure and aperture) |
| Vibrato | Lip vibrato (modulates `f_l`) or breath vibrato (modulates `p_m`), with rate, depth and delay |
| Articulation | Tonguing and slurs; see below |
| Slide / valves | Tube length; normally chosen by the player, or overridden |
| Attack skill | How cleanly the player lands the note; see below |

**The virtual player.** Every note has to be *found*. For a target pitch the player chooses:

1. A **fingering or slide position** and a **resonance (partial)** that together give the pitch,
   preferring the combinations a real player would use (trombone 1st–7th positions, standard
   trumpet and horn fingerings, alternates where they are better in tune).
2. A **lip frequency** just above that resonance, trimmed by ear (the same "intonation by ear" loop
   as the strings) using lip tension, slide trim or valve-slide kick.
3. An **articulation**:
   - *Tongued* ("ta"/"da"): the tongue closes the lip channel and releases it. The attack transient
     is the physics of the lips starting on a pressure step.
   - *Slurred*: lip slur (tension moves the lips to the neighbouring partial with the same
     fingering) or valve/slide slur (length changes while the lips hold). On trombone a
     same-partial slide slur *is* a glissando, so the player uses a soft "da" or a partial change,
     the way trombonists do, unless glissando is asked for.
   - *Accent, sforzando, fp, marcato*: pressure envelopes over the same physics.
   - *Falls, doits, rips, shakes, lip trills*: scripted moves of lip tension, pressure and length
     through which the model passes neighbouring partials, so they sound like the real gesture.
4. **Attack skill** (the counterpart of `attack_skill`): at 1 the player pre-sets the lips so the
   intended resonance wins the start transient. At lower values the lips can lock onto a
   neighbouring partial first, or stay there. **Cracked and split notes are therefore a real
   behaviour of the model**, and the high horn register is exactly where they happen, as on a real
   horn.

**Pedal tones** are a real test of the model. On a trumpet or trombone the lowest resonance is far
from the harmonic series, so the "pedal" note is held up by the upper resonances cooperating, not
by one peak. The model should play them with the right quality, not fake them.

### Phase 1c — The family

With the trombone right, the rest of the family is mostly new bore profiles and valve layouts:

| Instrument | Nominal length | Bore character | Notes |
|---|---|---|---|
| Tenor trombone (B♭, F attachment) | ~2.75 m (+~0.95 m) | mostly cylindrical, large bell | Phase 1 anchor |
| Bass trombone | ~2.75 m + two valves | wider bore, bigger bell | pedal register, the "low brass hit" |
| B♭ trumpet | ~1.37 m | cylindrical middle, fast flare | three piston valves |
| Flugelhorn | ~1.37 m | mostly conical | dark, round |
| French horn (F/B♭ double) | ~3.7 m / ~2.7 m | long narrow conical-cylindrical, wide flare | 4 rotary valves; plays high in its series, so its partials are close together; hand in the bell |
| Euphonium / baritone | ~2.7 m | conical | |
| Tuba (B♭B♭ / CC / F) | ~5.5 m | wide conical | 4–5 valves |

**Mutes and the hand.** Mutes and the horn player's hand are changes to the bell's termination:

- The **horn hand** adjusts pitch and colour a little. **Stopped horn** (hand sealing the bell)
  shifts the resonances so that the player lands about a semitone higher, and gives the metallic,
  menacing *cuivré* sound. That should emerge from the model, not be a filter.
- **Straight, cup, harmon and plunger mutes**: each is a small resonant cavity, modelled as a
  Helmholtz resonator and a partial obstruction at the bell. They change the reflection and
  radiation filters, add their own resonance, and move the pitch slightly, as real mutes do.
  Plunger *wah* is a continuous parameter.

**Radiation and direction.** The bell radiates highs in a narrow forward lobe and lows in all
directions. A **bell angle** parameter (bells toward the listener, bells up, horn bells facing
away) adjusts the on-axis brightness from that directivity. "Bells up" becomes a physical
parameter, not an EQ preset.

### Phase 1d — Brassiness: nonlinear propagation

This is what gives dramatic brass its edge, and it gets its own milestone.

At high pressures the peaks of the wave in the bore travel faster than its troughs, because the
speed of sound depends on the local pressure and particle velocity. Over the long cylindrical
sections of a trombone or trumpet, the wave front steepens toward a **shock**. The radiated sound
gains a burst of high harmonics that grows much faster than the level. That is the
"brassy", "cuivré", *blazing* sound of *fff*, and it is why a quiet trumpet played loud does not
sound like a loud trumpet.

The model handles this with the generalized Burgers approach used in brass synthesis research: each
cylindrical section is split into a few sub-segments, and each forward wave is delayed by an amount
that depends on its own instantaneous pressure (`c ≈ c₀·(1 + β·p/(ρc₀²))`, `β` the nonlinearity
coefficient of air). The wave travelling back from the bell, which is much weaker, stays linear.
Fractional delays keep this smooth. The oversampling and a gentle anti-alias stage keep the shock
front band-limited. **Brassiness is not an effect. It depends on the bore's cylindrical length, its
bore diameter and the pressure, so it varies correctly between instruments**: strongest on
trombone and trumpet, milder on the conical flugelhorn and euphonium, and characteristic on horn.

A **brassiness** control exists only in the laboratory (Phase 3), as a scale on `β`. On real
instruments it is left to the physics.

### Phase 1e — The 3D instrument

The 3D view is **generated from the same bore profile the acoustics use**: tube sections swept
along a coiled path, valves at their true positions along the tubing, the slide at its true
extension, the bell at its true flare. Changing the profile changes the drawn instrument, so the
semantic correspondence is built in.

It reacts in real time to the model's published state (lock-free, like `PhysModShared`):

- the lips opening and closing in a mouthpiece cut-away (slowed and exaggerated),
- valves down or up, the slide position, the hand or mute in the bell,
- the pressure wave along the bore, drawn as colour or swelling on a translucent tube and
  exaggerated. At high dynamics the steepening front is visible travelling toward the bell,
- the bell's radiation lobe, narrowing as the tone brightens,
- breath (mouth pressure) and the player's current partial.

### Phase 1 success

A musician loads the trombone (then the trumpet, horn and tuba), plays an expressive phrase from
MIDI or a breath controller, and hears convincing brass from *pp* to *fff*, where the loud end is
genuinely blazing because of the physics. Pushing the breath up shows and sounds the same thing:
the lips open wider, the wave sharpens, the bell's beam narrows.

---

# Phase 2 — Physics as the Interface

Once the instrument is convincing, the 3D representation becomes a primary sound-design interface.

The musician can grab meaningful parts of the virtual instrument: the slide, the valves (including
half-valve), the hand or mute in the bell, the mouthpiece (cup depth and backbore, which shape
response and brilliance), the lips (tension and aperture), and the bell's angle.

Traditional controls remain for precision and automation, and every path moves the same held note,
as `PhysModLive` does for the bow: 3D drags, knobs, automation, MIDI CC, breath controller and the
AI tool.

**Physics View** for brass shows:

- **The resonance ladder**: the bore's input impedance curve, its peaks marked as the partials of
  the current fingering, with the sounding pitch and the lip frequency shown on it. You can see *why*
  a note is sharp, why a pedal tone is weak, why a stopped horn jumps a semitone, and which
  neighbouring peak a cracked note fell onto.
- **The playing map**, the brass counterpart of the Schelleng diagram: mouth pressure against lip
  tension, with regions where the lips lock onto each partial, the threshold of oscillation below,
  and the areas where the tone jumps between partials or becomes unstable (multiphonic, raucous).
  Like the Schelleng window, its boundaries come from **fitted sweeps of the model**. The current
  playing point moves across it live, and dragging it plays the note there.
- **The standing wave in the bore**: pressure nodes and antinodes along the tubing for the current
  partial.
- **The travelling wave**: one period's pressure wave moving down the bore, its front steepening
  as brassiness grows, with a readout of the front's steepness.
- **The lips**: opening and flow waveforms for one period.
- **Spectral enrichment**: level against brightness, showing the rise that makes loud brass sound
  loud, and which part comes from the lips versus the bore's shocks.

### Phase 2 success

A musician can hear something (a thin high note, a note that won't sit in tune, a crack, a
fortissimo that isn't brassy enough), look at the instrument, see why, change the right physical
part, and hear the result.

---

# Phase 3 — Brass Laboratory

The final phase goes beyond simulating instruments that exist.

**Continuous dimensions of brass.** As `body_size` moves continuously from violin to bass, brass
gets continuous axes derived from the bore profile:

- **Size**: scales the whole bore, trumpet → trombone → tuba and beyond, with the same 4^size style
  law and an option for the tuning to follow.
- **Conicity**: moves the bore from mostly cylindrical (trombone, trumpet) to mostly conical
  (flugelhorn, euphonium, tuba). This morphs brilliance, brassiness and the "round" sound.
- **Bell flare**: the Bessel exponent `γ` and bell diameter, from a narrow post-horn to an enormous
  Wagnerian bell.
- **Mouthpiece**: cup depth and volume, throat, backbore; from a lead-trumpet shallow cup to a deep
  horn funnel.

**A bore designer**: edit the profile directly on the 3D instrument (drag the radius at any point,
insert a bulb or a constriction, add length) and hear the air column retune itself. The resonance
ladder in Physics View updates as you drag, so you can *design* a horn whose resonances line up, or
deliberately mis-align them.

**Real instruments that are rare or ancient:** alphorn (3–4 m, wooden, conical), natural horn and
natural trumpet (no valves: hand-stopped and lipped), cornett and serpent (lip-reed with finger
holes), the Roman **cornu** and the Celtic **carnyx** (the upright war horn), the **shofar**, the
**didgeridoo** (a lip-reed with vocal-tract coupling: the player's own tract resonances shape the
sound, so the mouth side of the lips becomes a modelled resonator too), and the Wagner tuba.

**Invented instruments:**

- A **leviathan**: a 40 m horn whose fundamental is below hearing, played high in its series where
  the partials are a quarter-tone apart. It gives huge, glassy low calls.
- **Many-belled horns**: one bore, several bells of different sizes (a branched scattering
  junction), each radiating its own band.
- **Sympathetic air columns**: extra tubes coupled at the mouthpiece or the bell that ring along,
  the brass counterpart of the Hardanger understrings.
- **Resonant walls**: the bell's metal vibrating (a real but small effect), exaggerated into a
  singing bell, a "glass trumpet", or a bell that rings like a gong after the note.
- **Beyond-physical brassiness**: `β` scaled far past air, so even *pp* crackles.
- **Cross-family exciters**, which join the two physical models:
  - the **bowed-string exciter** from the violin engine driving a brass bell instead of a wooden
    body (a Stroh violin, and then far beyond one),
  - a **reed** instead of lips: the same flow model with the valve inverted (inward-striking), which
    turns the brass bore into a saxophone- or clarinet-like instrument,
  - a **voice exciter** (sung pitch plus lip buzz, as in real growling and brass multiphonics).

**Presets** cover both familiar instruments (**trumpet → flugelhorn → horn → trombone → tuba**)
and invented families, and the continuous axes allow the space between and beyond them.

### Phase 3 success

Users stop asking only **"How real is the horn?"** and start asking **"What happens if I build
this?"**, and the answer is still a playable, convincing brass instrument.

---

# Phase 4 — Section and Hall

Brass for drama is rarely one player. A horn section in unison, eight trombones at *fff*, a
brass-and-low-brass hit: this phase makes ensembles part of the model, not a chorus effect.

- **Sections are several modelled players**, each with its own instrument (small construction
  variation, like the violin body's "maker" seed), its own small intonation errors, timing and
  vibrato, and its own attack transient. Unison sections then beat, blend and bloom as real ones
  do, because they *are* several oscillators.
- **Divisi and voicing**: a section track can receive chords and hand one note to each player,
  following the part the way a section leader would (horns 1–3 / 2–4 etc.).
- **Placement and direction**: each player has a position and bell direction. The directivity model
  from Phase 1c gives each one its own brightness toward the listener (horns bright only in their
  reflections, trumpets bright straight on). A simple early-reflection model gives the sense of a
  stage; the full reverb stays with the DAW.
- **The dramatic library**: a set of presets built as *performances*, not samples. Examples: the
  low-brass hit (bass trombones, tubas and horns at *fff* with a fast pressure attack and a
  brassy decay), the stopped-horn stab, the trombone glissando rise, the horn rip, the trumpet
  fall, the long crescendo swell that turns from dark to blazing.

### Phase 4 success

A composer can put one section track in a cue and get a brass section that swells, blares and
bites like a real one, and can open it to see and adjust any single player.

---

## Important Product Principle: One Instrument, Two Representations

This principle is the same as for the strings. The audio model runs at whatever resolution keeps
it stable and low-latency. The view reads meaningful state from it and draws it at frame rate.

Brass has an advantage: the **bore profile** is one shared description. The acoustics derive their
waveguide from it and the view derives its geometry from it, so "what you see is what sounds" is
true by construction for the air column. Everywhere else (lips, wave, radiation lobe) the
correspondence is **semantic**, not literal. The view never shows a physical relationship that has
nothing to do with the sound.

---

## Interaction Principle

Every major parameter gets up to three representations that drive one value:

- **Physical interaction**: push a valve, drag the slide, put a hand or mute in the bell, tip the
  bell up, drag the playing point on the playing map.
- **Precision control**: knobs, sliders, numbers.
- **Modulation and automation**: DAW automation, envelopes, LFOs, MIDI CC, **breath controller**,
  MPE pressure.

Pitch bend deserves one note: on a trombone it moves the slide, and on valved instruments it
moves lip tension (bending by the lip, with the resistance and colour change that implies) within a
settable range. Beyond that range, it can be switched to glissando through the partials, as a
horn rip does.

---

# Technical Plan

This section describes how the brass engine fits into the existing code, following the strings
engine's structure and its measurement-first approach.

## Where it lives

A new module `src/audio/brass/`, beside `src/audio/physmod/`. It depends on
`physmod::dsp` (`Delay`, `OnePole`, `Allpass1`, `DcBlock`, `Resonator`, `Decimator2`, `Noise`) and
`physmod::analysis` (`measure`, `spectrum`, `pitch`) instead of copying them. If a third model
family arrives, those two files move into a shared `src/audio/modeling/` module.

| Piece | File | What it is |
|---|---|---|
| Bore profile | `bore.rs` | Segments (cylinder, cone, Bessel flare), valves and slide as length switches; stock profiles for each instrument; scaling and morph axes |
| Reference acoustics | `impedance.rs` | Transfer-matrix input impedance with visco-thermal losses and bell radiation; peak finding; bell reflection function. Used at build time, in tests and by Physics View, **never on the audio thread** |
| Air column | `airbore.rs` | Runtime waveguide built from a profile: cylindrical delay lines, conical junctions, bell reflection/transmission filters, valve junctions, slide |
| Nonlinear propagation | `burgers.rs` | Pressure-dependent sub-segment delays for the forward wave in cylindrical sections |
| Lips | `lips.rs` | One-mass (then two-DOF) lip valve, Bernoulli flow, collision, and the per-sample mouthpiece coupling solve |
| Mutes and hand | `bell.rs` | Termination changes: hand position, stopping, mute resonators, directivity by bell angle |
| Instrument + player | `engine.rs` | One air column plus lips, 2× (or 4×) oversampling; the virtual player: fingering/position and partial choice, lip-tension targeting and intonation by ear, articulations, attack skill, vibrato, release |
| Measurement | `analysis.rs` | Brass-specific measurements on top of the shared ones: sounding partial, threshold pressure, spectral enrichment slope, waveform steepness, lip-locking regime |
| Runtime | `mod.rs` | `BrassShared` (lock-free view state), `BrassVoice`, `BrassInstrumentVoice` (one live instrument per track, and later one per section player), `render_performance` |

Around it, mirroring the strings integration:

- `src/deno/brass_ops.rs`: note on/off, live controls (`set_breath`, `set_lip`, `set_slide`,
  `set_valve`, `set_hand`), info/shape for the view, `op_brass_render_analyze` for the AI tool.
- `src/entropy_gui/widgets_brass.rs`: the 3D view and Physics View.
- `examples/studio-bundle/src/apps/daw_brass.ts`: saved settings, repair of old songs, presets,
  morphs, and note → engine call. A `"brass"` waveform id beside `"physmod"`.
- `Entropy.Brass.analyzeNote` and a DAW AI tool, like `Entropy.PhysMod.analyzeNote`.

## Building it, step by step

Each step ends with tests that pass **from rendered or computed data, with no one listening**, as
the strings were built.

1. **Bore and reference impedance.** Profiles for trombone and trumpet. TMM impedance.
   *Check:* impedance peaks 2–8 of the B♭ trumpet and the tenor trombone fall within a few percent
   of a harmonic series on their nominal fundamentals; peak 1 falls well below it (the reason pedal
   tones are special); the bell's reflection is strong below its cutoff and weak above it.
2. **Waveguide from the profile.** *Check:* the waveguide's impulse-measured impedance peaks match
   the TMM peaks to within ~10 cents for peaks 2–10; lossless-case energy conservation; stable
   for every stock and randomised profile.
3. **Lips on a fixed bore.** *Check:* no oscillation below a threshold pressure; above it, the
   sounding frequency sits just above the resonance nearest the lip frequency; moving lip tension
   up and down jumps between partials **with hysteresis**; the threshold rises with partial number.
4. **Player and tuning.** Fingering/position and partial choice, lip targeting, intonation by ear.
   *Check:* every note of the trombone's and trumpet's normal ranges within ~6 cents after the
   attack; slide positions 1–7 in tune; lip slurs land on the neighbouring partial.
5. **Dynamics and brassiness.** Burgers segments, pressure mapping and the fitted `pressure_center`
   law. *Check:* spectral centroid rises with level, and faster above a pressure threshold on the
   trombone (the brassiness knee); waveform steepness at the bell grows with pressure; the effect
   is weaker on the flugelhorn profile than the trumpet at the same level; output bounded.
6. **Articulation and attack skill.** *Check:* tongued attacks settle within a target time;
   at low attack skill, high horn notes sometimes start on or lock to a neighbouring partial, and
   never do at attack skill 1; falls and rips pass through the intermediate partials.
7. **Horn, tuba, mutes, hand.** *Check:* stopped horn sounds about a semitone above the unstopped
   fingering; each mute lowers the level and moves the spectral balance in its known direction;
   bell angle changes on-axis brightness and not the level of the lows.
8. **View, live controls, DAW.** 3D and Physics View from `BrassShared`; `BrassLive` for held-note
   controls; DAW settings, presets and AI tool. *Check:* view picture tests (like
   `tests/physmod_view.rs`) and studio-bundle tests (like `daw_physmod.test.ts`).
9. **Laboratory** (Phase 3) and **sections** (Phase 4), each with its own measured claims, e.g.
   a four-horn unison shows beating and a wider spectrum than one horn; an impossible bore stays
   bounded.

## How it will be verified (no audio device needed)

The same pattern as the strings: a Rust unit-test module, a Gherkin feature file driven offline,
a no-allocation test, view picture tests and studio-bundle tests.

| Claim | Where |
|---|---|
| Bore resonances line up with the harmonic series (peaks 2–8), peak 1 flat of it | `brass::tests` |
| Waveguide impedance peaks match the transfer-matrix reference | `brass::tests` |
| In tune within ~6 cents across trombone, trumpet, horn, tuba normal ranges | `brass::tests`, `brass_synth.feature` |
| Threshold of oscillation exists and rises with partial number | same |
| Lip tension selects partials, with hysteresis | same |
| Louder is brighter; above a knee, much brighter (brassiness), and stronger on cylindrical bores | same |
| Waveform steepening at the bell grows with pressure | same |
| Pedal tones sound at the right pitch with the right weakness | same |
| Stopped horn: ~ +1 semitone and metallic; mutes change level and spectrum as expected | same |
| Low attack skill can crack high horn notes; attack skill 1 never does | same |
| Bounded output for impossible instruments | `brass::tests` |
| No allocation on the audio thread while notes arrive, slur, valve-change and release | `tests/brass_no_alloc.rs` |
| 3D and Physics View draw the instrument and its overlays; drags steer the held note | `tests/brass_view.rs` |
| DAW settings, presets, morph, repair | `examples/studio-bundle/tests/daw_brass.test.ts` |

## Budget

The target is at most the violin's cost per player: **about 4% of one core** in release builds
for one player, including 2× oversampling and the Burgers segments. A 4× oversampled "high
brassiness" mode is allowed if the measurements show 2× aliases the shock fronts audibly (measured
as energy above the band edge folding back). Sections scale linearly with players, so an
8-player section should come in under about a third of a core.

## Risks and how to handle them

- **Lip model sensitivity.** Brass lip models are known to be touchy: a small change in lip
  parameters can move the threshold or the partial chosen. Mitigation: physical units, sweeps that
  map the playing region per instrument (the fitted playing map), and a player that aims its lip
  frequency relative to the measured resonance, not an absolute value.
- **Bore data.** Published instrument dimensions are approximate. Mitigation: judge profiles by
  their *resonance alignment* (a property good instruments share), not by matching one instrument's
  measurement, as the violin body's modes are illustrative defaults.
- **Shock fronts and aliasing.** Steep fronts are broadband. Mitigation: oversampling, band-limited
  fractional delays in the Burgers segments, and a measured aliasing test.
- **Low register settling.** As with the bass strings, the tuba's lowest notes may take longer to
  settle. Measure it, document it, and let the attack skill's pre-set lips shorten it.
- **Scope.** Brass has many extended techniques. Phase 1 covers normal playing, slurs, the basic
  articulations and the dramatic essentials (swells, brassiness, falls/rips, stopped horn, mutes).
  Growl and multiphonics (singing while playing) wait for the voice exciter in Phase 3.

---

## North Star

The feature succeeds when the visualization stops feeling like a visualization.

The user should come to feel there is a **horn inside Entropy**.

It has lips.

It has a bore.

It has a bell.

Breath pushes the lips open; the lips find a resonance; a wave travels down the tube, steepens, and
bursts from the bell.

The player's breath excites it.

Its shape determines its voice.

And because it is virtual, its shape does not have to obey the limits of brass, lungs,
manufacturing or tradition.

**Physical modeling provides the sound.
3D provides the intuition.
Entropy turns the instrument itself into the synthesizer.**

---

# Implementation Status

What exists today, where it lives, and how each claim is checked. As with the strings, the model
was built and tuned without anyone listening to it: every behaviour below is measured from
rendered audio, and the tests keep those measurements in place.

## The model (`src/audio/brass/`)

| Piece | File | What it is |
|---|---|---|
| Bore | `bore.rs` | Sections (cones, cylinders, Bessel flares) in three runs - front (mouthpiece, leadpipe), cylinder (slide), bell. Stock tenor trombone: .547" bore, 8.5" bell, ~2.8 m, bell stem and flare chosen (by search, as a maker would by trial) so the resonances line up. |
| Reference acoustics | `impedance.rs` | Transfer-matrix input impedance on a 1 mm staircase, visco-thermal losses and slowing (the boundary-layer `Gamma`), lumped radiation load; peak finding. Build time and tests only. |
| Air column | `airbore.rs` | Runtime waveguide: Kelly-Lochbaum cells (one sample, ~3.9 mm each) for the front and bell, fractional delay lines for the cylinder, one lumped linear-phase loss filter per direction, boundary-layer slowing at the played pitch, radiation reflection filter, and pressure-dependent propagation in four forward segments (the generalized-Burgers steepening - brassiness - planned as `burgers.rs`, folded in here). |
| Lips | `lips.rs` | One-mass outward-striking valve, Bernoulli flow solved in closed form against the mouthpiece each sample, lip collision. |
| Instrument + player | `engine.rs` | 2x oversampling. The player: partial and slide position from the reference resonances (precomputed once per instrument), lip setting from the fitted laws, tongue with breath built up behind it, guided attack (`attack_skill`), attack assist, slurs (soft "da" across positions, lip slurs), glissando, slide vibrato, intonation by ear (slide, or lips bent up at first position), remembered corrections for repeated notes. |
| Runtime | `mod.rs` | `render_note`, `render_phrase` (offline). |

## Phase 1 progress (build steps above)

1. **Bore and reference impedance - done** for the tenor trombone.
2. **Waveguide from the profile - done.** Peaks 2-8 within 12 cents of the reference.
3. **Lips on a fixed bore - done.** Threshold, partial selection by lip setting, hysteresis.
4. **Player and tuning - done.** In tune across the range at every dynamic (see below).
5. **Dynamics and brassiness - done.**
6. **Articulation and attack skill - done** (tongued, legato, glissando; cracked entrances).
7. **Trumpet, horn, tuba, mutes, hand, bell angle - not started.**
8. **Live voice, `BrassShared`, 3D view, Physics View, DAW integration - not started.** The engine
   is not yet reachable from the DAW; it renders offline.
9. **Laboratory and sections - not started.**

## Decisions the measurements made

- **Dispersion.** The plan assumed an allpass could carry the boundary layer's slowing. At the
  model's rate a first-order allpass that bends the delay between 100 Hz and 1 kHz swings it by
  hundreds of samples, where the boundary layer moves it by about nine. The slowing is applied at
  the pitch being played; resonances well above it come out a little flat of the reference (about
  15 cents eight partials up).
- **The one-mass lip plays sharp.** It sounds 50-110 cents above the air-column resonance (a known
  property of the outward-striking model; real lips, with their upward component, sit closer). The
  player pulls the tuning slide out by about 0.1 m, leaves first position ~25 cents sharp, and
  tunes by ear. The two-degree-of-freedom lip is the planned fix.
- **Lip mass follows the note.** With one mass for every note, low partials would not sound loud
  and high ones would not sound soft. With the vibrating mass as `3 (233 / f)^2` kg/m² (constant lip
  stiffness) every partial of the trombone plays from *pp* to *fff*.
- **The player's laws are fitted from the model.** `lip_center`: the slot's lip frequencies
  centre at `0.85 (p / 700 Pa)^-0.073` of the resonance for every partial; the player aims 3% high,
  where notes speak fastest. `sounding_offset`: +75 cents (partials 2-5) / +55 (6+) plus 6 cents per
  doubling of pressure - a first guess the ear refines.
- **Guided attack.** Released from rest, the lips ring at their own resonance (about 0.8 of the note)
  and the air column takes ~150 ms to pull them round. At `attack_skill` 1 the lips are guided
  through a buzz at the note's pitch for six periods, then left to the physics: half level in
  15-30 ms, 90% in 35-60 ms. At 0 there is no guide, the lip setting misses by up to 12%, and high
  notes crack.
- **What the listener hears.** A point source keeps getting brighter with frequency forever; above
  the bell's cutoff (`ka ~ 1`, ~500 Hz for this bell) the radiated power per unit flow stops rising.
  The output is the radiated power's pressure. An on-axis "bells toward you" beam arrives with the
  bell-angle control (step 7).
- **Shock fronts.** The nonlinear delay's read point may move at most half a sample per sample, so
  where the wave would overtake itself the front is held at the steepest a sampled wave can carry.

## How it is verified (no audio device needed)

Run with `cargo test --release --lib brass` and `cargo test --release --test brass_no_alloc`.

| Claim | Where |
|---|---|
| Trombone resonances 2-10 within 30 cents of the B♭ series; the first below 0.75 of the fundamental | `brass::tests` |
| Seventh position lowers resonances 3-10 by 5.4-6.4 semitones; the second moves further | same |
| Runtime waveguide's impedance peaks 2-8 within 12 cents of the transfer-matrix reference | same |
| Quarter-wave cylinder check of the reference machinery (with boundary-layer slowing) within 3 cents | `brass::impedance::tests` |
| A breath threshold exists (150-600 Pa for partials 2-8); partial 12 needs more than twice partial 4's | `brass::tests` |
| In tune within 6 cents at *pp* and *mf*, 16 at *ff*, B♭2-C5 | same |
| Partial and position a trombonist would use (B♭3 first, G3 fourth, C3 sixth, E3 second...) | same |
| Skilled attacks at half level within 40 ms, 90% within 80 ms; an unskilled start blooms 2.5x slower | same |
| Loose lips drop B♭3 to F3; pinched lips pop it up to D4 | same |
| Unskilled attacks on high notes start 60+ cents off (cracks); skilled within 20 | same |
| A glissando passes through the pitches between | same |
| *ff* 12 dB+ louder than *mf*, centroid more than doubled; with the air's nonlinearity off the same breath is far duller (10th harmonic 15 dB+ weaker) | same |
| The wavefront at the bell steepens 8x+ from *mf* to *ff* | same |
| Slide vibrato swings the pitch by the depth asked | same |
| Bounded output for impossible settings; released notes fall silent | same |
| No allocation while notes arrive, slur, glide, re-tongue and release | `tests/brass_no_alloc.rs` |

`brass::tests::listening_examples` (ignored by default) renders a scale, a *pp*-to-*fff* swell, a
fanfare, a glissando and a vibrato note to `test-artifacts/brass/` for ears.

## Known limits

- One mouthpiece-to-bell DC flow resistance ~7x too high (the lumped loss filter can't reach unity at
  DC): the mean mouthpiece pressure is somewhat high. It shifts the lips' operating point slightly;
  tuning and the fitted laws already include it.
- At the same breath the low register radiates ~15 dB less than the high (bell radiation efficiency
  falls at low frequency; players compensate with more air). A register balance for the DAW is
  still to do.
- *ff* notes at the bottom of the range and far out on the slide are within ~15 cents, not 6.
- Pedal tones (partial 1) are not played yet.
- About 3.9% of one core per player in release builds (the scattering cells vectorize).
