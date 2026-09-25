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
