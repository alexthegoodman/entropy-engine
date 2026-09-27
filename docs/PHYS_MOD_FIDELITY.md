# Phys Mod Fidelity

What to build next to make the modelled instruments (strings, brass, drums and cymbals, plus
friction and water) sound as good as they can. It draws on the "Known limits" and "Decisions" in
[PHYS_MOD_SYNTH.md](PHYS_MOD_SYNTH.md), [PHYS_MOD_BRASS.md](PHYS_MOD_BRASS.md) and
[PHYS_MOD_SOUNDS.md](PHYS_MOD_SOUNDS.md).

## Principles

1. **Quality sets the ceiling. The machine only decides how much of it plays live.** We don't
   leave out a better model because it is expensive. We build it, measure what it costs, and give
   slower machines ways to use it: quality tiers, freezing, rendering ahead, and export at full
   quality (Part A). Every instrument should have a best-sounding version even if only a fast
   machine, or an offline bounce, can play it.
2. **Keep measuring CPU.** Every item below records its cost per tier in release builds, the same
   way the docs record "about 4% of one core" today. A cost that goes up is fine when we say so
   and the tiers absorb it. A cost that goes up without anyone noticing is a bug.
3. **Remove workarounds, not only add detail.** Several current behaviours make up for a missing
   piece of physics: brass lips that play 50-110 cents sharp and get tuned back, a guided attack
   on strings and brass, and fitted laws. The most valuable upgrades are the ones that let us
   delete a workaround, because the instrument then behaves correctly in situations we never
   tuned for.
4. **Measured, then listened to.** The models were built without listening, and every claim is
   backed by a test. We keep that, and add a reference-comparison harness and regular listening
   sessions (Part C). "It measures right" is necessary, but it doesn't prove the instrument
   sounds right.

## Priorities at a glance

| # | Item | Family | Why it's near the top |
|---|---|---|---|
| 1 | Quality tiers, freeze, render-ahead | All | Unblocks every expensive item below |
| 2 | Per-note expression lanes | All | The models already respond; the sequencer can't say it yet |
| 3 | Cymbal wash above 2 kHz | Cymbals | The largest audible gap in the whole set |
| 4 | Hi-hat | Drums | A kit without one isn't a kit |
| 5 | Two-degree-of-freedom lips | Brass | Removes the tuning workaround; better soft playing and slurs |
| 6 | Rim, shell, rimshot, cross-stick | Drums | Common playing techniques that can't be played at all today |
| 7 | Measured-quality body and bridge | Strings | Most of a string instrument's character comes from its body |
| 8 | Thermal friction | Strings | Better attacks and bow changes; may retire the guided attack |
| 9 | Cymbal geometry: bell, taper, both mode pairs | Cymbals | Correct low modes, strikes anywhere, chokes |
| 10 | Frequency-dependent bore losses | Brass | Upper resonances in tune, correct decay, fixes the DC flow |
| 11 | Performer model | All | Stops identical notes sounding mechanical |
| 12 | Listening perspective: directivity, mics, room | All | How the dry sound turns into a recording |

---

# Part A — Making room for quality on any machine

This part comes first because it's what lets us say yes to the expensive items. Current costs, from
the status docs (one core, release):

| Instrument | Cost now |
|---|---|
| Violin (whole instrument) | ~4% (+1% per sympathetic string) |
| Brass player | ~3.9% |
| Kit, everything ringing | ~30% (snare 13%, kick 7%, floor tom 5.5%) |
| Crash / ride / splash after a hard hit | 56% / 63% / 29% |
| Brush on a snare set up all round | 55-75% |

Several fidelity items below will raise these numbers, some of them several times over. That's
acceptable as long as the following features exist.

### A1. Quality tiers per instrument

Each model gets three named settings: **Draft**, **Live** and **Render**. Each tier is a set of
concrete parameters, never a vague "quality" slider:

- Strings: number of radiating body modes, sympathetic strings on or off, oversampling 2x or 4x,
  the richer bow models (A-tier features such as bow width switch off below Render).
- Brass: 2x or 4x oversampling (the "high brassiness" mode the budget already allows), the full
  lip model or a cheaper one, loss filter order.
- Drums: modes per head, number of snare-wire groups (4/6/8 are already measured), high-band
  cutoff, cavity modes.
- Cymbals: size of the nonlinear set, how high the cascade reaches, whether the sampled band runs.

Rules: export and bounce always use Render. The track header shows which tier is playing. Each tier
has its own tests: the tests pin Render, and the lower tiers must stay within a stated distance of
it (for example ±1 dB per third-octave band, the same pitch within 3 cents).

### A2. Freeze a track

`render_performance` already exists for strings, brass, matter and water. Freezing a track renders
it in the background at Render quality and plays back the audio instead. Editing the track
unfreezes it, and the view can still replay the frozen state if we keep `Shared` snapshots. This
is the most direct way to have the best quality on a slow machine, and it builds on code that's
already written.

### A3. Render ahead for sequenced tracks

A sequenced track (as opposed to one being played live) has no need to be real-time. It can be
rendered a few seconds ahead on worker threads into a buffer. Only live-played or armed tracks
need to meet the audio deadline. This could let an eight-cymbal song play on a laptop that can't
run one cymbal live. Changes to automation or a note inside the lookahead window restart the
render from that point.

### A4. Adaptive degradation that doesn't glitch

The audio thread already knows how long each block took. If headroom falls below a threshold,
step the least audible voices down one tier, with hysteresis, and step back up when there's
headroom again. It never drops audio. "Least audible" comes from level after the track gain and
from masking by louder tracks. A small indicator on the track shows that it's playing below its
tier.

### A5. Cheaper per unit of quality

These keep the tiers high on ordinary machines:

- **Audibility culling everywhere.** Matter already puts silent pieces to sleep and flushes quiet
  modes. Extend this to skip modes below a masking floor relative to the voice's loudest, and apply
  it to string bodies and brass as well.
- **Wider SIMD.** Add AVX2 and NEON versions of the von Karman blocks, the modal banks and the
  Kelly-Lochbaum cells (SSE2 only today), selected at runtime.
- **GPU compute for Render tier.** Large modal banks and the cymbal coupling are dense linear
  algebra, and the engine already has a GPU. Worth trying for offline renders and freezing, where
  latency doesn't matter.
- **Shared solves in the kit.** The kit status doc already lists skipping silent heads and modes,
  sharing the wires' contact solves, and having the drums share a voice.

### A6. CPU tracking as a test

Add a benchmark suite (`cargo bench` or an ignored test) that records the cost of each instrument
at each tier into a table checked into the repo, compared against a stated reference machine. A
change that makes something more expensive has to update the table. Also publish a minimum-spec
machine: the tier each instrument gets live on that machine is part of the product description.

## Part A status

### Done: no more stall on a track's first note

When a song first reached a string or brass track, the instrument was built on the thread that runs
the UI and sequencer. A brass instrument's first build computes its resonance table, **1-2 s in a
release build** (much longer in a debug build), so the whole editor and transport froze.

- The engine builds string and brass instruments on their own thread
  (`AudioEngine::physmod_prepare` / `brass_prepare`, `Audio.preparePhysMod` / `prepareBrass`). A
  note sent while an instrument is building waits in its queue. Nothing waits for a build any more
  (`audio::preload_tests`).
- The DAW prepares every string and brass track as soon as it has a bus, and again whenever its
  construction changes (`prepareModelledInstruments`, checked once a second).
- A silent instrument now **sleeps** instead of shutting down after 3 s: it outputs silence for
  almost no CPU (under 1% of a core, tested) and wakes on the next note with nothing to rebuild. It
  shuts down only after 10 minutes of rest, so resting for a few bars no longer loses an
  instrument.
- Removing a track's bus (a song reloaded) drops its instruments, so a new bus never reuses one on
  the old bus.

Drum kits and water already built off the audio thread and were prepared when a song loaded.

### A1: first tiers

- `audio::quality::Quality` (`Draft`, `Live`, `Render`). An export always renders at `Render`.
- **Kit:** `KitSpec::quality`, with a Quality switch in the Kit window and a `quality` param on the
  `daw_matter` tool. Exported kit hits are sent at `render` whatever the track plays live.
- **Draft cymbals** use a nonlinear set up to 1.4 kHz (instead of 2 kHz), evaluated every 3 samples
  (instead of 2), for a third of the cost. A cymbal's wash is chaotic: struck just 1% harder, a
  full crash already moves its third-octave bands 1.75 dB on average. Draft moves them about twice
  that. `matter::tier_tests` holds it there: within twice the 1%-harder change plus 1.5 dB, at under
  half the cost. Thinning the cymbals' linear bands above saved nothing measurable and cost
  accuracy, so they stay.
- **Drums are the same at every tier.** A measurement overturned the plan here: most of a drum's
  cost doesn't scale with its modes. A kick with 147 modes still costs half as much as one with
  685 (3.3% vs 6.2% of a core), while dropping modes moves its spectrum by 4-5 dB. Fewer snare-wire
  groups saved nothing measurable either.
- Strings and brass have no Draft yet: at ~4% of a core they don't need one. Their `Render` tier
  will come with the fidelity work (4x oversampling, richer bow and lips).

| Piece (`tier_report`) | Draft vs full: mean band change (dB) | Largest | 1% harder: mean | Largest | Draft cost |
|---|---|---|---|---|---|
| Crash | 3.14 | 10.6 | 1.75 | 5.8 | 34% |
| Ride | 1.25 | 3.2 | 0.13 | 0.4 | 29% |
| Splash | 4.40 | 20.4 | 2.51 | 10.6 | 35% |

### A6: measured costs

`cargo test --release --test phys_mod_cost -- --ignored --nocapture`, on the 4-core container this
was built in. A kit's figure is wall time over audio time with its worker threads, which is what
the audio thread waits for.

| Instrument | Build, cold (ms) | Build, warm (ms) | One core, playing (%) |
|---|---|---|---|
| Strings: violin | 0 | 0 | 4.0 |
| Strings: cello | 0 | 0 | 4.1 |
| Strings: bass | 0 | 0 | 4.0 |
| Brass: trombone | 1144 | 0 | 3.6 |
| Brass: trumpet | 2025 | 0 | 3.1 |
| Brass: horn | 2378 | 0 | 3.5 |
| Brass: tuba | 2077 | 1 | 5.0 |
| Kit: groove with crash | 1281 | 115 | 56.1 |
| Kit (draft): groove with crash | 374 | 99 | 34.7 |
| Kit: one hard crash | 123 | 141 | 58.6 |
| Kit (draft): one hard crash | 102 | 100 | 33.4 |
| Kit: one snare hit | 133 | 135 | 53.8 |

What the table says next: **a single snare hit costs the kit about as much as a whole groove.** The
kit's fixed cost dominates, most likely the threads meeting every 32-sample block and sympathy
waking the other drums. That is the first A5 target, ahead of anything per mode.

### Next

- **A2 freeze** and **A3 render ahead**: both are DAW features on top of `render_performance`.
  Freeze plays a pre-rendered track as audio. Render ahead does the same for the part of a
  sequenced track just ahead of the playhead.
- **A4 adaptive**: step a kit from Live to Draft when the audio thread runs short of time. Draft is
  now a rebuild away.
- **A5**: the kit's fixed cost (above), then wider SIMD for the von Karman blocks.

---

# Part B — The instruments

## B1. Everything: per-note expression in the piano roll

At the moment a note carries a pitch and a velocity, and everything else (breath, bow force, lip
tension, bow position, strike position) is a setting on the whole track. The models already
respond continuously to all of these. The piano roll needs to be able to write them down:

- **Per-note values** (set on the note) and **per-note curves** (drawn over the note), like MPE
  but named in each instrument's own physical terms: bow force, speed, position and contact point;
  breath, lip tension and tongue; strike position, stick height and implement.
- **Articulation per note** rather than per track (tongued, legato, glissando; arco, pizzicato,
  col legno; center, edge, rim).
- **Import and export.** MIDI CC / MPE mapping for bringing performances in, with a documented
  mapping for each instrument.
- The AI tools (`daw_brass`, `daw_physmod`, `daw_matter`) write the same lanes.

This comes early because it costs almost no CPU and makes every later improvement usable in a song.

## B2. Strings

In order:

1. **Measured-quality body and bridge.** Replace the 10 coupled + 40 radiating illustrative modes
   with a body fitted to published violin, viola, cello and bass admittance data (bridge mobility
   in both directions, several hundred modes up to ~10 kHz at Render tier). Model the bridge's
   rocking and bouncing separately, so the bridge hill and the two string polarisations have
   something to couple through. Measure against published bridge admittance curves.
2. **Thermal friction.** Make friction depend on the temperature of the rosin at the contact, so
   the contact has a memory of recent sliding. The research shows it changes attack transients and
   bow reversals. Goal: with `attack_skill` at its default, reach clean Helmholtz motion as quickly
   as the guided attack does now, then reduce or remove the guide. That also fixes the known
   limitation on the low strings (surface sound and crunch are unreachable during the guided
   periods).
3. **Second polarisation.** Couple the two polarisations through the bridge. It matters most for
   pizzicato and ringing notes (a two-stage decay and gentle beating), and it's cheap: roughly
   one more waveguide per string.
4. **The finger as an object** *(new)*. At the moment the stopping finger is a loss at a point.
   Give it width and softness, and allow a light touch. That gives natural harmonics (flageolet),
   an audible portamento slide, and the difference between a stopped note and an open string. It
   can be tested directly: a light touch at 1/2, 1/3 and 1/4 of the string should produce those
   harmonics.
5. **Finite bow width** at Render tier only, to be kept if the measurements show a change in the
   attack or in the Schelleng window.

Cut or deferred: torsional motion and bow-hair compliance. Research says both affect the bow
contact, but the audible benefit is small next to the items above. We come back to them if thermal
friction and bow width leave attacks sounding wrong.

## B3. Brass

1. **Two-degree-of-freedom lips.** Model outward and upward (opening) motion, with collision. The
   status doc names this as the fix for the one-mass lip's 50-110 cent sharpness. Success means:
   `sounding_offset` shrinks towards zero, the tuning-slide compensation goes away, and soft
   entrances, lip slurs and pitch bends around a resonance behave more like a player's lips.
   Refit the fitted laws afterwards, or better, find that fewer of them are needed.
2. **Frequency-dependent losses and dispersion.** Replace the single lumped loss filter and "slowing
   at the played pitch" with a filter that matches boundary-layer loss and dispersion across the
   band (a higher-order or fractional-delay design). That removes the ~15 cents flat drift eight
   partials up, the DC flow resistance that's ~7x too high, and part of the register imbalance.
   The transfer-matrix reference in `impedance.rs` is the target, so this is directly measurable.
3. **Continuous valves** *(expanded)*. Model the valve junction as a pair of ports that opens and
   closes, so a valve partly pressed and the moment of changing between combinations have their
   own sound: the half-valve effect, a smear between notes, and "ghost" notes. A modest cost, only
   while a valve is moving.
4. **Mutes as acoustic cavities.** Model the cup and the harmon chamber as small acoustic elements
   attached to the bore, not filters. The harmon mute's 20 cent flatness is a sign the filter
   version isn't sufficient.
5. **Register balance** *(from known limits)*. At the same breath the low register radiates ~15 dB
   less. Players compensate automatically, so the virtual player should too: have the breath
   follow the register.
6. **Growl and flutter tongue** *(new)*. A simple periodic disturbance in the breath or tongue
   gives two common jazz and film techniques without needing a full vocal-tract model.

Cut: an elaborate vocal-tract model (lower priority than lips and bore for normal playing). Bell
radiation has moved to Part B7, where it's shared with the other families.

## B4. Drums

1. **Hi-hat** *(new, missing)*. Two plates clamped together by a pedal that controls the
   pressure between them: closed, half-open (sizzle through the plates repeatedly meeting), open,
   the foot "chick", and a splash made by the foot. The contact solve and the plate model already
   exist, and the cymbal tiers (Part A1) apply. The DAW needs a pedal lane (Part B1).
2. **Rim and shell.** Give the rim and shell their own modes, coupled at the bearing edge. That
   makes rimshots (stick hits head and rim together), cross-stick and shell ring possible. It's
   listed as a known limit on both the snare and the kit.
3. **Non-uniform tension and head stiffness.** Tension that varies around the rim splits the
   degenerate mode pairs, which makes the partials beat, a large part of why a real tom doesn't
   sound like a synthetic one. Bending stiffness sharpens the higher modes a little. Both are
   cheap because the mode frequencies are computed when the drum is built. Add a "tuned evenly /
   roughly" control per drum.
4. **Glancing strikes and a buried beater.** Strikes along the head's surface as well as into it,
   and a kick beater left pressed against the head (a common kick technique).
5. **Local muffling.** Gel, tape or a hand on the head, as a contact whose area changes as the head
   moves. It's how every recorded drum is actually set up.
6. **Kick port and timpani kettle.** A port in the resonant head, and a better air load from the
   kettle for timpani tuning (the air load is part of what makes timpani sound in tune).

Moved down: more detailed snare-wire placement. Six groups is already converged within a couple of
dB, so time is better spent on items 1-3.

## B5. Cymbals

1. **Carry the wash above 2 kHz.** At the moment the energy cascade stops at the top of the
   nonlinear set, the energy piles up just below 2 kHz, and the sound's brightness (centroid) never
   rises the way a real crash does. Two approaches, used at different tiers:
   - **Render tier:** a larger nonlinear set reaching 6-8 kHz, run on the GPU or a render-ahead
     worker (Part A3/A5). This is the version to aim for, without holding it back.
   - **Live and Draft tiers** *(new idea)*: measure the energy flowing to the top of the set,
     then feed it into the linear high band according to a transfer law fitted from Render-tier
     runs. That gives a plausible wash at much lower cost, checked against Render-tier renders.
   Success: the radiated centroid rises after a hard crash as it does in recordings, not only the
   energy-weighted frequency of the modes.
2. **Geometry: bell, taper, lathing.** Thickness that varies from bell to edge, and a bell as a
   separate region of curvature. This raises the lowest modes (the crash's `(2,0)` is 22 Hz now)
   and separates the bell sound from the bow sound. Research on cymbal modelling identifies
   geometry as a major factor. This is a build-time cost only (the eigen-solve), so it's cheap
   at runtime.
3. **Both members of each mode pair.** Needed to strike anywhere other than the `theta = 0`
   diameter, for a stick to land on a cymbal that's already ringing in a different pattern, for
   swirled brush paths, and for chokes. It roughly doubles the linear mode count, which the tiers
   absorb.
4. **Chokes and edge contact.** A hand gripping the edge (a contact spread over part of the rim,
   with damping), and the stick's shoulder as a line contact. Both are common playing techniques.
5. **Edge short-circuit and stand coupling.** Low frequencies cancel around the edge of an
   unbaffled plate (both faces are treated as baffled now). Couple the stand to the plate's own
   modes rather than using two rigid ones.

Adding more linear high-frequency modes won't fix the wash, because the problem is how energy
moves between modes. Item 1 is therefore about that transfer, not about a brighter first hit.

## B6. Friction and water (lower priority)

These are real improvements, but they come after the core instruments:

- **Friction:** a 2D roughness texture (so a swirl crossing its own path meets the same bumps),
  sideways stick-slip, and the tool's own vibration (a brush's ringing wires, a rod's modes). The
  wet-finger glass harmonica (rubbing a glass rim) needs the rim's in-plane traction, the same
  thing a bowed cymbal edge needs, so build that once for both.
- **Water:** bubbles that pop at the surface, collective bubble-cloud modes (the low rumble under
  surf), and water loading and damping in glasses. The 1D shallow-water model stays until its
  limits are audible in a song.

## B7. Performer model and listening perspective (all families)

**Performer.** A physical model driven with identical gestures still sounds machine-made. Model
the constraints a player works under, not random jitter: bow acceleration limits and the bow
running out; a finger taking time to land; tongue release and breath running down across a
phrase; shape that follows the phrase (the note before and after, where the beat falls). Each is
testable, e.g. "a long crescendo on one bow slows the bow as the bow runs out". Sections *(new)*:
several players on one part with realistic differences in timing, intonation and vibrato. Brass
Phase 4 already plans this, and it's worth doing for strings too. It scales linearly in cost, so
it relies on Part A.

**What the microphone hears.** Keep the vibrating instrument separate from the recording of it:

- Directivity of radiation per instrument, varying with frequency (bell facing already does a
  version of this; strings and drums need their own).
- Distance, early reflections, and microphone position and pattern, shared by all families. The
  kit already has per-piece mics; generalise that.
- A shared room *(new)*: instruments on one track hearing others through the air (the kit already
  does this internally), so a loud brass chord makes the snare wires buzz and open strings ring.
  A Render-tier option.
- Always evaluate the dry sound as well as the recorded one, so the room can't hide problems in
  the source.

---

# Part C — Knowing that it sounds better *(new)*

1. **Reference comparison harness.** Take a small, properly licensed set of recorded notes and hits
   (violin open G and a scale, a trombone swell, a snare at three dynamics, a crash left to ring).
   Compare the model with them on descriptors we already have (`analyzeNote`, `analyzeHit`), plus
   decay time per partial, the spectrum over time, and attack shape. A fidelity item is done when
   it moves those numbers towards the reference without breaking existing tests.
2. **Listening sessions.** At a regular point, Alex listens to the `listening_examples` renders
   (strings, brass and matter each have them) side by side with the references, at every tier.
   Notes from the session go into the relevant doc's "Decisions" section, the same way the
   measurement notes do today.
3. **Tier-accuracy tests.** Draft and Live renders compared with Render as in Part A1, so the tiers
   can't drift apart without anyone noticing.
4. **Record the before and after.** Each item in Part B keeps its previous render next to the new
   one in `test-artifacts/`, which is also material for the blog series.
