As we move Entropy DAW towards a true physically-based DAW, we want to add the ability to create high quality sounds for use in songs. 
We can create these sounds in phases, just as we have done the phys mod strings and phys mod brass sections in phases.
Defintitely reference the strings and brass sections for guidance on what we are going for. They both sound spectacular.

I’d think of the next section as a small set of interacting physics systems rather than six unrelated features.

| System | First convincing targets | Then it generalizes into |
|---|---|---|
| **Membranes** | kick, tom, snare, timpani | arbitrary stretched surfaces, skin, fabric |
| **Plates/shells** | cymbal, gong, bell | sheet metal, panels, resonant objects |
| **Impact** | sticks/mallets, wood/metal/glass hits | footsteps, collisions, bouncing objects |
| **Friction** | drum brushes, scraping, rubbing | squeaks, dragging, sanding, bowed objects |
| **Fracture** | sticks snapping, glass breaking | cracking, crushing, tearing, destruction |
| **Granular** | sand, gravel, beads | dirt, snow, debris, seeds, particle-filled objects |
| **Water** | droplets, pouring, splashes | streams, sloshing, surf, waves |

The particularly beautiful thing is that **drums and cymbals give you a reason to build several of these primitives anyway**.

A snare isn't merely a membrane oscillator. It's membrane + shell + impact + contact + sympathetic coupling + many little wires colliding against a surface. A cymbal requires impact plus a nonlinear vibrating plate/shell. Brushes introduce friction and many-point contact. So an excellent drum kit can serve as the musically useful proving ground for a much more general physics engine.

### Impact might be the connective tissue

I'd prioritize a genuinely excellent generalized **contact/impact model** surprisingly high.

Instead of having a `DrumStickExciter`, you want something conceptually closer to:

**Object A ↔ contact geometry ↔ Object B**

with velocity, mass, hardness/compliance, contact area, angle, surface properties and perhaps deformation determining how energy enters both objects.

Then a drumstick hitting a membrane is just one case. The same interaction can produce:

wood → glass  
metal → concrete  
rock → rock  
finger → drumhead  
mallet → gong  
droplet → metal plate  
debris → resonating structure

That is extremely leveraged work.

### Friction is similarly universal

You already have some version of this problem if your violin bowing is convincing.

Generalizing it beyond bow/string interaction could unlock **scraping almost anything across anything**.

Imagine selecting two objects, enabling contact, pressing them together and dragging one in the viewport:

> rubber × glass  
> metal × stone  
> wood × steel  
> wet finger × membrane  
> brush × cymbal

Pressure, velocity and surface roughness become playable parameters.

That's simultaneously Foley and synthesis.

### Fracture could be spectacular

Fracture gets especially interesting if it isn't merely a procedural “breaking sound generator.”

Suppose an actual simulated resonating object develops cracks.

Before:

```text
──────────────
```

After impact:

```text
──────╲
       ╲──────
```

Its modal structure changes **because its geometry changed**.

Hit it again. The crack propagates. Resonances shift. Eventually a piece separates and falls, collides with the floor, and both fragments continue resonating independently.

Then “breaking glass” isn't a sound effect.

You create a glass object and **break it**.

That would be an extraordinary demonstration of what PBR-DAW means.

### Granular physics could become an instrument class

This one has enormous musical potential.

Make a container. Fill it with 2,000 simulated objects. Shake it.

Particle parameters become synthesis controls:

**count · size distribution · shape · density · elasticity · friction · container geometry**

Maraca presets become merely one coordinate.

Replace seeds with tiny steel spheres. Make them progressively larger. Change the vessel from wood to glass while it's shaking. Reduce gravity. Make particles sticky. Drop the entire thing.

You get sounds that would be tedious or impossible to construct conventionally but remain intuitively understandable.

### Water is probably the deepest rabbit hole

I'd stage this rather than immediately attempting Navier–Stokes-everything.

A first water system capable of **droplets, bubbles, splashes and resonant containers** could already be extremely impressive.

Then pouring and sloshing.

Then flowing water.

Eventually waves and surf.



And water becomes much more interesting when coupled to everything else.

Rain isn't a “rain generator.” It's thousands of water impacts against geometry.

Rain on a:

**window / car roof / tent / lake / leaves / cymbal / giant membrane**

should naturally sound different because the receiving objects are different physical systems.

Likewise, throwing stones into water combines rigid-body motion, impact, displacement, splash generation and eventually underwater acoustics.

### This suggests a killer Entropy demo

Not another orchestral performance.

Start with an empty scene.

Create a sheet of metal. Hit it. Bend it into a cymbal. Hit it again. Change its material and thickness.

Create a glass vessel. Pour simulated beads into it. Shake it. Replace the beads with water. Tilt the vessel and hear it slosh.

Drop the vessel.

**It shatters.**

Fragments hit the floor, resonate and scatter. Water splashes across the floor. A fragment slides to a stop through physical friction.

And the user never loaded a sample.

That ~60-second sequence would communicate **“physically based DAW”** better than pages of explanation. The impressive violin and brass establish that Entropy can reproduce known instruments; something like this establishes that the underlying idea is much bigger.
---

# Plan

The strings and brass each had one exciter (a bow, a pair of lips) driving one resonator (a string,
an air column). This section is different: it is a small set of **resonating bodies** and a small
set of **interactions** between them, and every sound is some bodies plus some interactions. The
plan builds those two sets, not a list of sound generators, and it uses the drum kit as the proving
ground, because a good kit needs most of them.

The working rules are the ones the strings and brass were built by:

- **Physical units underneath.** Metres, kilograms, newtons, pascals, seconds. Knobs are mappings
  onto those quantities, never the other way round.
- **Measured, not tuned by ear.** Every claim below ends as a test that renders audio offline and
  measures it (pitch, mode ratios, decay times, contact times, spectra), with no one listening.
- **One object, two representations.** The same description drives the sound and the 3D view.
- **Nothing allocates on the audio thread.** Everything that is expensive (mode shapes, air loading,
  eigen-solves after a crack) happens off it.

## The two building blocks

### Bodies: modal resonators

Almost every object in the table above rings as a set of **modes**: a frequency, a decay, a modal
mass, and a shape (how much each point of the object moves in that mode). A drumhead, a cymbal, a
bell, a glass, a fragment of a broken glass, a bead, a water-filled container: each is a list of
modes. What changes from object to object is **where the modes come from**:

| Body | Where its modes come from |
|---|---|
| Membrane | Bessel functions of a stretched circular membrane, plus air loading, the enclosed air and radiation (Phase 1) |
| Plate / shell | Bessel functions of a thin plate (circular), and a reference solve for shells and bells (Phase 2) |
| Arbitrary solid | A finite-element eigen-solve of the object's mesh, off the audio thread (Phase 5) |
| Bubble | The Minnaert resonance of a bubble of that size at that depth (Phase 6) |

A `ModalBody` runs its modes as two-pole recurrences (the exact response of a damped mass-spring to
a force held for one sample), so a mode never goes unstable and a mode above Nyquist is simply
dropped. Its frequencies can be scaled while it rings (a membrane's tension rising with amplitude, a
cymbal's stiffening), which is where the first nonlinearities live.

### Interactions: contact, friction, and what follows from them

**Contact is the connective tissue.** One contact model covers *Object A ↔ contact ↔ Object B*:

- Each body answers two questions about a point on its surface: *where will this point be next
  sample if no contact force acts?* and *how far does it move per newton of contact force?* (its
  one-step driving-point compliance). A body with modes answers from its modes; a mallet or stick
  answers as a mass; a fixed floor answers "nowhere, and not at all".
- The contact force follows **Hunt–Crossley**: `F = K·δ^α·(1 + λ·δ̇)` for penetration `δ > 0`, zero
  otherwise. `K` and `α` come from the two materials and the contact geometry (Hertz: a sphere on a
  flat is `α = 3/2`, with `K` from the radii and the two Young's moduli; felt behaves as a much softer
  spring with a higher exponent, as piano hammers do), and `λ` from how much energy the contact
  loses.
- Because both bodies are linear over one sample, the penetration next sample is a straight line in
  the force. The force is found **per sample by a bounded, monotone scalar solve** (Newton with a
  bisection bracket), like the bow's friction solve - never guessed.

Then a drumstick on a membrane, a mallet on a gong, a droplet on a plate, a bead on a glass and a
fragment on the floor are all the same code with different bodies and materials. The things a
player controls are the physical ones: velocity, striker mass, hardness, tip size, where it lands.
What they change (contact time, brightness, which modes ring, the pitch glide of a loud hit) comes
out of the solve.

**Friction** (Phase 3) is the same pair of bodies with a tangential force: the bow's friction curve
from `physmod::friction`, generalized from bow/string to any two surfaces, with a surface roughness
profile along the drag path. **Fracture** (Phase 5) is a body whose modes are recomputed when its
geometry changes. **Granular** (Phase 4) is many small bodies making many contacts. **Water**
(Phase 6) adds bubbles as bodies and droplets as strikers.

## Where it lives

A new module `src/audio/matter/`, beside `physmod` and `brass`. It uses `physmod::dsp` and
`physmod::analysis` as brass does. (The brass plan's note stands: with a third family those two
files belong in a shared module; that move is a mechanical refactor to do once this family's needs
are clear.)

| Piece | File | What it is |
|---|---|---|
| Bessel functions | `bessel.rs` | `J_m(x)` and its zeros, build time only |
| Modal body | `modal.rs` | Modes (frequency, decay, mass, shape at named points), the per-sample recurrences, a frequency scale for nonlinear stiffening, radiated output |
| Contact | `contact.rs` | Strikers (mass, tip radius, material), materials (Young's modulus, Poisson ratio, contact loss), the Hertz/Hunt–Crossley law and the per-sample implicit solve between two bodies |
| Membrane | `membrane.rs` | A stretched circular membrane: mode shapes, tension, surface density, air loading (computed), radiation damping and radiated weights, tension modulation |
| Drums | `drum.rs` | Heads + shell + the enclosed air coupling them; kick, toms, timpani (kettle), then the snare |
| Runtime | `mod.rs` | `render_hit` offline; later `MatterShared`, a live voice per track, `render_performance` |
| Measurement | `analysis.rs` | Mode peaks, decay times, contact time, pitch glide |

## Phase 1 — The drum: membranes and impact

**Targets: kick, toms, timpani, then snare.**

### 1a — Modal body and contact

- `ModalBody` with exact two-pole modes; `Striker` as a point mass with a tip; the Hunt–Crossley
  solve.
- *Checks:* a mode struck alone rings at its frequency with its decay; the contact force is
  resolved (the contact time and peak force at 44.1 kHz match a 4x finer time step within a few
  percent); **Hertz scaling**: contact time falls as velocity rises, as `v^(-1/5)` for `α = 3/2`;
  a harder or lighter striker gives a shorter contact and a brighter spectrum; a struck body can
  throw the striker back (the stick bounces off - no "one-sample impulse" exciter anywhere).

### 1b — The membrane

- Modes of a circular membrane from the zeros of `J_m`, normalized so the modal mass is the head's
  mass. The shape at the strike point decides what rings: a strike at the centre excites only the
  axisymmetric modes (the "thud"); towards the rim it brings in the rest.
- **Air loading computed, not fitted.** The air next to the head moves with it and adds mass, most
  to the lowest modes. The added mass of each mode (per side, in units of `ρ_air·a`) is a universal
  number for that mode, computed once from its Hankel transform. It tends to `1/j_mn` for high
  modes, which is the check.
- **The enclosed air** is a spring on the modes that change the volume (the `m = 0` ones), which is
  what couples the two heads of a kick or tom and raises the timpani's lowest mode.
- **Radiation**: the volume-changing modes radiate as monopoles and are damped strongly by it (the
  short thud of a timpani stroke); the others radiate as multipoles, weakly at low frequency. The
  same efficiency sets each mode's weight in the output and its radiation damping.
- **Tension modulation**: a large displacement stretches the head, so the tension rises with the
  sum of `k²·q²` over the modes (exact for a membrane with uniform in-plane stretch), and every
  mode's frequency with it. A hard hit starts sharp and falls to its pitch - the pitch glide of a
  loud tom or a low-tuned kick - with the size of the glide set by the head's thickness and
  Young's modulus.
- *Checks:* the vacuum mode ratios equal the Bessel zero ratios; centre strikes leave the `m ≥ 1`
  modes silent; the air-loading table matches its asymptote; a loud hit glides downwards and a soft
  one does not; the glide is larger for a slacker head.

### 1c — Kick, toms, timpani

- **Kick and toms**: batter head + resonant head + the air in the shell between them; a felt or
  plastic beater, sticks for the toms. The player sets tuning (the batter head's pitch, from which the
  tension is solved), damping (a pillow, or a muffle ring), and the strike.
- **Timpani**: one head on a kettle. The pitch is the `(1,1)` mode; air loading pulls the
  `(m,1)` family toward the timpani's near-harmonic `1 : 1.5 : 2 : 2.5`. How close the computed air
  loading alone gets is a measurement, and whatever gap remains (the kettle's own shape) is recorded
  honestly in the status, not hidden in a fudge factor.
- *Checks:* the tom's sounding pitch follows the tuning; the kick's low end decays faster with the
  pillow; a harder beater is brighter; the timpani's `(1,1)` mode is the pitch and outlives the
  thud of `(0,1)`.

### 1d — The snare

A snare is membrane + shell + impact + contact + many small wires. The resonant head's motion is
the input to **a set of wire contacts**: each wire is a light, stiff body pressed against the head
with an adjustable snare tension, and it rattles because it is repeatedly thrown off and lands
again - the contact model with many instances, not a noise burst. The two heads couple through the
shell's air as the kick's do, and the shell adds its own few modes. The same wires sympathetically
buzz when other drums in the kit are hit.

*Checks:* snares off is a tom; snares on adds broadband energy that decays with the head, more of it
for a harder hit; looser snares buzz longer.

### 1e — Runtime, view and DAW

Following the brass integration step for step: `MatterShared` (lock-free state for the view: mode
amplitudes, the contact force, the striker), a live drum-kit voice per track (all pieces of the kit
in one voice so they can buzz each other), `render_performance` for export, `src/deno/matter_ops.rs`,
`Entropy.Matter`, a DAW drum track (waveform `"matter"`) with a kit map from MIDI notes to pieces
and strike positions, and a 3D view in which the heads are drawn from the same mode shapes the audio
rings with (the Chladni pattern of the sounding modes, exaggerated), and the stick or beater moves
with the contact.

### Phase 1 success

A kick, toms, a snare and timpani that sound convincing from ghost notes to rimshot-level hits,
whose tuning, damping, striker and strike position behave like the real controls, with no samples.

## Phase 2 — Plates and shells: cymbals, gongs, bells

- **Plates**: modes of a thin circular plate (free edge, clamped at the centre for a cymbal) from
  `J_m` and `I_m`; a curvature ("bend the sheet into a cymbal") morph that stiffens the low modes.
- **Nonlinearity**: a cymbal or gong is not linear. Large amplitudes couple its modes (the von Kármán
  terms), so energy cascades from the struck low modes into a dense high band over tens of
  milliseconds - the crash's build-up and the gong's delayed shimmer. Modelled as cubic couplings
  between modes (a reduced von Kármán model), which is where most of the section's CPU goes.
- **Bells**: modes from a reference shell solve (hum, prime, tierce, quint, nominal), with the minor
  third a real bell has.
- *Checks:* cymbal energy moves up in frequency after the strike (centroid rises, then falls); a
  gong struck softly is nearly linear and struck hard shimmers; a bell's partials sit at their
  named ratios.

## Phase 3 — Friction: brushes, scraping, rubbing

- The bow's friction law (`physmod::friction`) generalized to any contact pair, with the normal
  force from the contact model and a **surface profile** (roughness, grooves, ridges) along the path.
- **Brushes**: many bristles, each a light striker with its own friction, dragged across a head.
- The viewport interaction from the vision: select two objects, press them together, drag one.
  Pressure, velocity and roughness are the playable parameters.
- *Checks:* stick-slip appears at low velocity and high pressure (a squeak) and gives way to
  noise-like sliding at high velocity; a rougher surface is brighter and louder; a brush swirl on a
  snare is a continuous wash that follows the stroke speed.

## Phase 4 — Granular: containers of particles

- Particles as small rigid bodies (spheres to start) with a simple discrete-element simulation:
  gravity, contacts with each other and with the container, run off the audio thread at a physics
  rate and fed to the audio thread as timed collision events.
- Every collision is a contact: particle ↔ particle excites the two particles' own modes (tiny,
  high); particle ↔ container excites the container's modes. So the vessel (wood, glass, a drum)
  sounds through the particles.
- Controls are the physical ones from the vision: count, size distribution, density, elasticity,
  friction, container.
- *Checks:* collision rate follows shaking; larger particles make lower, louder impacts; the same
  shake in a glass container and a wooden one differs by the container's modes.

## Phase 5 — Fracture

- Objects with geometry: a mesh whose modes come from a finite-element eigen-solve done off the
  audio thread (the same solve can later give plates and shells arbitrary shapes).
- An impact whose contact stress passes the material's strength opens a crack: the mesh changes, the
  modes are recomputed and cross-faded in, and they shift **because the geometry changed**. When a
  crack separates a piece, it becomes a new body with its own modes, handed to the rigid-body
  simulation, and it falls, hits the floor and rings.
- The crack itself emits: a short, broadband burst as the new surfaces release their stored energy
  into the modes.
- *Checks:* a cracked plate's modes are lower and split; a separated fragment rings at higher
  frequencies than the whole; a stick snapping gives two bodies that ring independently.

## Phase 6 — Water

Staged, as the vision asks, rather than Navier–Stokes from the start:

1. **Bubbles**: a bubble is a mode (the Minnaert frequency from its radius and depth) with a damping
   from its size, and a rising-pitch chirp as it nears the surface.
2. **Droplets**: a drop hitting a surface is a contact with a soft, splashing striker; hitting water
   it entrains a bubble (the "plink" of a drip is the bubble, not the impact).
3. **Pouring and filling**: a stream of drops and bubbles into a container whose air column shortens
   as it fills (the rising pitch of a bottle being filled).
4. **Sloshing, streams, surf**: bubble populations driven by a coarse surface simulation.
5. **Rain on things**: thousands of droplets as strikers on whatever body is under them - a window,
   a tent, a lake, a cymbal - so each sounds different because the receiving body is different.

*Checks:* a bubble rings at its Minnaert frequency; a filling bottle's pitch rises as its air
column shortens; rain on a membrane and rain on a plate have their bodies' spectra.

## Phase 7 — The scene

The demo from the vision: objects placed in a scene, each a body; contacts, friction, particles,
cracks and water between them; the scene's own physics deciding what hits what. This phase is mostly
integration: the rigid-body simulation (Phase 4) extended to the scene, the view drawing each body
from its modes, and a scene track in the DAW whose events are physical actions (drop, strike, drag,
pour, shake) instead of notes.

## Build order and why

Contact first, because everything else is a client of it. Membranes second, because they are the
simplest real body with real nonlinearity and the drum kit is immediately musically useful. Plates
third, reusing both. Friction fourth (it extends contact). Granular before fracture, because it
needs only small bodies and many contacts, while fracture needs geometry-derived modes, which is the
largest new piece of machinery. Water last, because it builds on bubbles, droplets as strikers and
containers from all of the above.

## How it will be verified (no audio device needed)

As with the strings and brass: `cargo test --release --lib matter` for the model claims, a
no-allocation test for the live voice, view picture tests for the 3D view, and studio-bundle tests
for the DAW track. A listening-examples test (ignored by default) renders hits and phrases to
`test-artifacts/matter/` for ears.

## Budget

A drum is a few hundred modes, so a whole kit ringing at once must stay under about 5% of one core
in release builds. The contact solve runs only while something is in contact. Cymbals' cubic
couplings (Phase 2) are the expensive part and are budgeted separately.

---

# Implementation Status

What exists today, where it lives, and how each claim is checked. As with the strings and brass,
nothing was tuned by listening: every behaviour below is measured from rendered audio (or from the
head's own motion), and the tests keep those measurements in place.

## The model (`src/audio/matter/`)

| Piece | File | What it is |
|---|---|---|
| Bessel functions | `bessel.rs` | `J_m(x)` by Miller's backward recurrence, and its zeros |
| Modal body | `modal.rs` | Modes run as rotated complex states (the exact response to a force held for a sample): in tune in `f32` even for a 30 Hz mode, never unstable, silent above Nyquist. `predict` gives the free position and one-step compliance at any point; `set_scale` retunes a ringing body with displacement and velocity continuous (small changes by rotating the phasors, no transcendental calls); quiet modes are flushed before they turn subnormal. |
| Contact | `contact.rs` | Materials (hickory, nylon, polyester film, plastic, rubber, steel, brass, glass), tips (Hertz spheres, felt power laws), the Hunt-Crossley law with Flores' restitution relation, and the per-sample bracketed-Newton solve between two sides. `Striker`: a mass with a tip. |
| Membrane | `membrane.rs` | Circular head: Bessel mode shapes normalized to the head's mass; the **radiation impedance of every mode computed** from its Hankel transform (air mass from the evanescent part, radiation resistance from the propagating part, iterated with the frequency it changes); radiation damping and radiated weights from the same numbers; the tension-modulation coefficient `E h / (4 (1 - nu))`; tension solved from a tuning. Options: both members of each degenerate pair (for heads touched all round), orders limited, and a **sampled high band** (below). Built heads are cached by description. |
| Cavity | `cavity.rs` | The air inside a drum as the acoustic modes of a hard-walled cylinder (`J_m(alpha r / a) cos(m theta) cos(l pi z / L)`), driven by both heads and pressing back on them, with the overlaps in closed form; the uniform mode is the air spring, the others slosh below their resonance and tie the heads' asymmetric modes together. A kettle (no depth given) keeps only the uniform mode. |
| Drums | `drum.rs` | Batter head + optional resonant head + the cavity; up to four strikers in flight; tension modulation from the cycle-averaged stretch, capped at the film's yield strain and ramped every sample; **snare wires** (below). Presets: 22" kick (two-ply batter with a pillow, felt or plastic beater), 14" snare (coated batter, 3-mil snare side, twenty strands; snares off), 16" floor tom, 12" rack tom (sticks), 26" timpani (felt mallets, soft and hard). |
| Runtime | `mod.rs` | `render_hit`, `render_hits` (a sequence on one drum, so hits land on a ringing head) |

## Phase 1 progress

- **1a Modal body and contact - done.**
- **1b Membrane - done.**
- **1c Kick, toms, timpani - done** as offline models.
- **1d Snare - done** (wires, the cavity's modes, and the high band it needed). The shell's own
  modes and the rim (rimshots, cross-stick) are not modelled yet.
- **1e Runtime, view and DAW - not started.**

## Decisions the measurements made

- **Air loading is enough for the timpani.** With the Rayleigh integral per mode and no fitting, the
  26" timpani's `(m,1)` family lands at **1 : 1.469 : 1.921 : 2.361 : 2.795** from the vacuum
  1 : 1.340 : 1.665 : 1.980 : 2.289 (Rossing measures real timpani at about 1 : 1.50 : 1.97 : 2.44).
  The `(0,1)` mode carries about as much air as the head weighs (0.099 kg against 0.090 kg), and
  radiates as a monopole: its T60 is 0.49 s against 1.74 s for the `(1,1)` note, so the thud dies and
  the note sings on, as on the real drum.
- **Tension follows the averaged stretch.** Driving the tension from the instantaneous `q^2` - or
  from a lagged copy of it - pumps energy into the head (parametric amplification) and a hard hit
  runs away. Taking each mode's cycle-averaged amplitude from its rotating state gives the envelope
  (the glide) with no ripple and no lag. The film's yield strain (~3%) caps it.
- **Contacts on heads are long.** The head's compliance, not the tip, dominates: a 25 g mallet on the
  timpani is in contact for ~8 ms, a stick on the rack tom ~6 ms, the kick beater ~19 ms (a mass on
  the head's point stiffness, `pi sqrt(m / K)`). What the tip changes is the sharp start of the force,
  which is the top of the spectrum.
- **Glides.** A floor tom tuned to 82 Hz, struck at mid-radius, starts 63 cents sharp at 6 m/s, 16 at
  3 m/s and not measurably at 0.5 m/s; tuned slack (65 Hz) it glides 163 cents, tight (110 Hz) 14.
- **A resonant head only needs the modes the air can move.** On a tom or kick nothing but the air
  inside drives it, so it keeps only the orders the cavity's modes have (up to 4), no high band. A
  snare's snare side, touched by wires at points all over, keeps every mode, both members of each
  pair, and the high band.

### The snare, and what it needed

- **A sampled high band.** A membrane's modes crowd together quadratically, so a complete set stops
  at 2-3 kHz. Above it, each thin slice of frequency (1/40 octave) is represented by one real mode
  drawn from it, standing for all `count` modes of the slice: its mass divided by `count`, its
  radiated weight by `sqrt(count)` (incoherent sum), its share of the stretch by `count`. Three
  things the measurements forced:
  - *It only listens.* Coupled both ways, the sparse, lightly damped sampled modes made the contact
    chatter at their frequencies (the force itself had energy flat to 16 kHz); the real, dense band
    acts on a contact as a smooth load. Driven one way by the contact force, they pick up exactly the
    force's own sharp edges: a plastic beater now puts 11 dB more above 4 kHz into the kick than felt,
    and a stick on a tom 10 dB+ more than without the band, with the force pulse within 3%.
  - *Plane-wave shapes.* One real mode drawn at random can be enormous at the point struck (a high
    `m = 0` mode near the centre) or almost nothing; a sampled mode takes the local form high membrane
    modes have (a random plane wave with its wavenumber, mean square one everywhere).
  - *The slice's average radiation.* High modes are subsonic, and only the orders below `ka` radiate
    at all (the others by 1e-40), so each sampled mode gets the fraction of orders that radiate times
    their mean resistance, not its own all-or-nothing value.
- **Retuning must be smooth.** Changing the frequencies in 16-sample steps modulates every mode with a
  staircase: sidebands at multiples of 2.8 kHz, 40 dB+ above the true top end. The stretch is
  measured every 16 samples and the tension ramped every sample; a mode is retuned only once its
  change passes 1e-5 (0.02 cents). The sampled high band keeps its tuning.
- **The air inside is a set of modes.** With only a uniform pressure, nothing but the volume-changing
  modes reach the snare side, and they radiate their energy away within tens of milliseconds. The
  cavity's transverse modes (the first near 565 Hz in a 14" x 5.5" shell) carry the batter's
  `(1,1)`, `(2,1)`... motion to the snare side, which now holds 6.5% of its energy in `m = 1` modes a
  moment after the hit. Couplings that would change a head mode's stiffness by less than 0.1% are
  dropped (under a cent), which keeps a kick's 3900 possible couplings to about 370.
- **The snare side is short-lived, the batter carries the buzz.** A 3-mil head weighs 10 g and its
  modes radiate efficiently (`ka ~ 2` for its `(1,1)`): radiation alone damps them in ~40 ms. The
  batter's `(1,1)`-`(3,1)` modes ring for 0.25-0.6 s and keep driving it through the air.
- **The wires lift off at about gravity's scale.** Each group lifts when the head accelerates away
  faster than `preload / mass`. The strainer's pull, turned by the snare beds, presses the whole set
  on with only a fraction of a newton; the default is 0.15 N over 6 g of moving coil (~25 m/s^2).
  A mezzo hit then lands the wires a few hundred times over ~50-90 ms; loosened to 0.05 N they buzz
  to 130 ms, tightened to 1.2 N they stop at 40 ms.
- **Cost, measured with a profiler** (`perf`): the modes' step and the wires' predictions are written
  four modes at a time with SSE2 (the compiler would not vectorize them), the eight wire groups share
  one pass over the head's free motion plus a small cross-compliance table, and the contact solve uses
  its analytic slope. The snare went from 44% of a core to 13%.

## How it is verified (no audio device needed)

Run with `cargo test --release --lib matter`.

| Claim | Where |
|---|---|
| `J_m` values and zeros match tables | `matter::bessel::tests` |
| A contact is resolved at 44.1 kHz (contact time and peak force match a 4x finer step) | `matter::contact::tests` |
| Hertz: contact time falls as `v^(-1/5)`, and matches Hertz's closed form | same |
| The rebound speed follows the coefficient of restitution (0.3, 0.6, 0.9) | same |
| A harder or lighter striker has a shorter contact; a felt mallet's is a few ms | same |
| A struck mode rings at its frequency and decays at its rate; a 30 Hz mode stays in tune in `f32`; a retuned body is continuous and rings at its new pitch | `matter::tests` |
| A membrane in vacuum rings at the ratios of the Bessel zeros | same |
| A centre strike leaves the asymmetric modes 30 dB+ quieter | same |
| Air mass tends to `rho / k` for high modes and is far larger for the lowest; radiation of `(0,1)` matches the monopole law at low `ka` | same |
| The timpani sounds its note on `(1,1)` (within 5 cents); its `(m,1)` ratios are within 6% of 1.5, 2, 2.5 and three times closer than in vacuum; the `(0,1)` thud dies 10 dB+ faster than the note | same |
| A hard mallet: centroid 1.15x+, 3 dB+ more above 1 kHz; felt brightens when played harder | same |
| A hard hit glides down to its pitch, a soft one does not; a slacker head glides further (measured on a concert tom: one head, open shell) | same |
| A tom follows its tuning (within 25 cents of the ratio: the air inside loads the higher tuning a little more) | same |
| A stick leaves a tom after 1-8 ms | same |
| The kick's pillow shortens the boom by 6 dB+; a plastic beater puts 6 dB+ more above 4 kHz than felt | same |
| The shell's air drives the resonant head; with no air there is no coupling | same |
| Later hits land on a ringing head | same |
| The high band puts a stick's crack above 4 kHz (10 dB+) without changing the contact (within 3%); a felt kick's octaves from 1 to 16 kHz each fall below the last | same |
| The cavity's modes give the snare side's `m = 1` modes 3%+ of its energy; with only the uniform mode, none | same |
| Snare wires lift off and land 50+ times on a mezzo hit, never with the snares off; snares on add 4 dB+ above 3 kHz in the first 50 ms | same |
| A harder hit rattles more and longer; looser snares buzz longer than tight ones | same |
| `J_m'` zeros match tables | `matter::bessel::tests` |
| Every drum (snare included) stays finite for a 25 m/s hit at the rim and falls silent | same |

`matter::tests::listening_examples` (ignored) renders a kick pattern, a tom fill with a hard floor-tom
glide, a snare groove with ghost notes and a roll, one snare hit with the snares off, loose, normal
and tight, a timpani phrase on two drums, a timpani roll with a crescendo and a centre-versus-edge
stroke to `test-artifacts/matter/`. `matter::tests::cost` (ignored) times each drum.

## Known limits

- **Cost.** Per ringing drum, in release builds on one core: snare 13%, kick 7%, floor tom 5.5%, rack
  tom 4%, timpani 2%. A whole kit ringing at once is about 30%, well over the plan's 5%. Next: skip
  heads and modes that have gone silent, share the wires' contact solves, and let a kit's drums share
  one voice.
- **Build time.** A new drum takes 0.2-0.8 s to build (radiation integrals, the high band's zero
  searches), off the audio thread; the same description is then cached.
- The snare's shell and rim have no modes yet: no rimshot, cross-stick or shell ring. The wires don't
  buzz sympathetically with other drums until the kit shares one voice (1e).
- The inside of each head carries the same air mass as the outside, and the cavity's sloshing modes
  add their own below resonance, so the inner air is counted a little twice for the low modes; a
  kick's port is not modelled.
- Heads are ideal membranes: no bending stiffness (which sharpens high modes slightly), no
  non-uniform tension around the rim, so degenerate mode pairs don't split and beat.
- Strikes are along the head's normal only; a glancing blow and a buried beater (held against the
  head) are not modelled yet.
- A 25 m/s stick at the rim peaks at several hundred pascals at 1 m: physical for the speed (90 km/h),
  but the DAW will need gain staging (full scale is 20 Pa).
