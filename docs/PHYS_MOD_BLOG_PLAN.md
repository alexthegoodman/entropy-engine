# Physically Modelled Instruments: Blog Series Plan

Three deep-dive posts for Indie Machine covering the physically modelled instruments in Entropy's
DAW: the bowed string, brass, and the drum kit with cymbals. Each post is long, with many sub
sections. This doc is the checklist. Tick a sub-section when its evidence has been run and its text
is drafted; tick a post when it is in `indie-machine/app/posts/` and Alex has reviewed it.

We are aiming for 3,000 to 5,000 words per post, which can sometimes take multiple passes.

Source material: [PHYS_MOD_SYNTH.md](PHYS_MOD_SYNTH.md) (strings),
[PHYS_MOD_BRASS.md](PHYS_MOD_BRASS.md) and [PHYS_MOD_SOUNDS.md](PHYS_MOD_SOUNDS.md) (drums and
cymbals, plus the plan for everything after). Each has an "Implementation Status" section with the
measurements, decisions and known limits the posts draw on.

Nothing here has been drafted yet. Numbers in this plan are copied from those docs so the outlines
have something to aim at. They are not publishable until re-run (see "Gates").

## Series checklist

- [ ] **Post 1 - Strings:** a bowed string with a body that pushes back
- [ ] **Post 2 - Brass:** a tube, a pair of lips and a shock front
- [ ] **Post 3 - Drums and cymbals:** from one contact law to a kit that hears itself

Publish in that order (build order). Post 2 refers back to post 1 for the shared view and
verification patterns; post 3 refers back to both. Suggested slugs: `entropy-physmod-strings`,
`entropy-physmod-brass`, `entropy-physmod-drums`. Dates are set when each is written.

## Where the code came from

| PR | Merged | What landed | Post |
|---|---|---|---|
| #2 | 2026-09-24 | Bowed string rebuilt as waveguide strings, friction bow and a coupled body; Physics View; multi-string instrument with shared body | 1 |
| #5 | 2026-09-25 | Brass: trombone, trumpet, horn, tuba; lips, valves, mutes, the hand, bell facing; 3D view; DAW brass tracks | 2 |
| #6 | 2026-09-25 | Modal bodies, contact, membranes; kick, toms, timpani, snare | 3 |
| #7 | 2026-09-25 | Plates, von Karman nonlinearity, crash, ride, splash | 3 |
| #8 | 2026-09-25 | The whole kit as one live voice; 3D kit view; kit tracks in the DAW | 3 |

PRs #1, #3 and #4 (Linux support, Character knobs, the song library) are not part of this series.
The DAW sample songs added after #8 use these instruments; see "Not in these three posts".

## Read this first: the older strings post

`indie-machine/app/posts/2026-09-22-entropy-physical-modeling-strings.mdx` describes the first
string voice, an extended Karplus-Strong loop with regenerative sustain. PR #2 replaced it. Several
of that post's statements no longer describe the code:

- It says the voice does not solve stick-slip friction and does not model a bridge or body. It now
  does both (`friction.rs`, `body.rs`).
- It points at `src/audio/physmod.rs`, which is now the directory `src/audio/physmod/`.

Post 1 has to say plainly that it replaces that model, and link back. Whether to add a short
"superseded" note at the top of the 09-22 post is Alex's call; it is not edited as part of this plan.

## Gates

Each post is a Lane B post (CLAUDE.md, section 4A). These apply to all three, so they are not
repeated below.

- **It builds and runs on the machine that writes the post.** Windows 11, `--release`, printing the
  profile in any timing output. Several figures in the Sounds doc were measured in a Linux container
  (four cores, `perf`). CPU costs and thread scaling are re-measured, not carried over.
- **Pinned.** Commit or tag, exact crate versions from `Cargo.toml`, edition 2024, rustc, OS, audio
  backend. There are no tags yet, so `repo_link` needs a tag per post (or a stated commit). Tagging
  is Alex's step.
- **One primary source at minimum per major claim area**, read at draft time, not remembered. The
  code's own comments already cite McIntyre, Schumacher and Woodhouse (JASA 74, 1983), Woodhouse
  2003, Smith's *Physical Audio Signal Processing* (CCRMA) and Schelleng. Others are named per
  section below as candidates.
- **No claim that it sounds like the real instrument** unless Alex has listened and said so. The
  docs state the models were built and tuned from rendered audio without anyone listening. What can
  be claimed is what the tests measure. The ignored `*_listening_examples` tests render WAVs so Alex
  can listen; his notes go into the post as his observations.
- **Screenshots come from BDD features**, not hand-driven input. The view tests
  (`tests/physmod_view.rs`, `brass_view.rs`, `matter_view.rs`) write pictures to `test-artifacts/`,
  which is generated on each run and is not in the tree today. The `daw_*_live` features need a
  desktop session and an audio device.
- **Contradictions and failures are written up**, with each doc's "Decisions the measurements made"
  and "Known limits" as the raw material.
- **Length.** These are deep dives, so each gets a table of contents up top, a version/environment
  block near the top (crate versions, edition, OS, backend), and a "Known limits" section at the end.
- No commits from these sessions; Alex reviews first.

---

## Post 1 - Strings

**Working title:** A bowed string with a body that pushes back
**Type:** A (series), replacing the 09-22 post's model; links back to it, forward to post 2.
**Sources to read at draft time:** McIntyre, Schumacher and Woodhouse (1983); Woodhouse 2003;
Schelleng's bowed-string paper; Smith, *Physical Audio Signal Processing*.
**Commands from the doc:** `cargo test --release --lib physmod`, `--test physmod_synth_bdd`,
`--test physmod_view`, `--test physmod_no_alloc`; `npx vitest run tests/daw_physmod.test.ts` in
`examples/studio-bundle`.

- [ ] **1.1 The model in one chain.** Player, bow, string, bridge and body, output. What the earlier
  post got wrong and why this one replaces it. The shape of `src/audio/physmod/`: `string.rs`,
  `friction.rs`, `body.rs`, `engine.rs`, `analysis.rs`, `mod.rs`.
- [ ] **1.2 The string.** Four-segment digital waveguide (finger to bow, bow to bridge, both
  directions), cubic-Lagrange fractional delays, losses at bridge, nut and fingertip, optional
  stiffness dispersion solved per note for a target inharmonicity, 2x oversampling. Evidence:
  in tune within 6 cents across the violin (cello and bass low notes within 8-10).
- [ ] **1.3 The bow.** McIntyre-Schumacher-Woodhouse friction curve solved in closed form against the
  string impedance each sample, stick/slip hysteresis, physical units underneath (newtons, m/s,
  fraction of string). Evidence: normal stroke is Helmholtz motion (one release per period, stuck
  about 1 - beta of it), settles in under 0.2 s; faster bow is about 6 dB louder per doubling;
  ponticello brighter than tasto. A waveform plot from `analysis.rs`.
- [ ] **1.4 Schelleng's window, fitted from the model.** The self-contained "the model disagrees with
  the textbook" section. The sweep: 37 notes (bass E1 to violin G6) for the force centre, 180 window
  edges at three bow positions; fitted `F_min` proportional to `beta^-2.5` and `F_max` to `beta^-1.4`
  against Schelleng's -2 and -1; good to about a factor of 1.35. Re-run the sweep, plot edges against
  the fit, print the residual. Do not explain why the exponents differ until it has been tested; "the
  model disagrees, here is by how much" is a valid finding. Also the raucous, surface-sound and
  Helmholtz regimes.
- [ ] **1.5 The body.** `body.rs`: 10 coupled modes (A0, CBR, B1+/-, the bridge hill) whose summed
  velocity is the bridge's motion, fed back into every string; 40 seeded radiating modes to about
  10 kHz, stereo. Decision log: why hand-chosen coupled modes rather than a measured body.
- [ ] **1.6 The virtual player.** String choice, double stops against slurs (40 ms chord window), bow
  reversal, guided attack and attack assist (`attack_skill`), intonation by ear, delayed vibrato,
  pizzicato, col legno, ring and damp on release, `force_center`.
- [ ] **1.7 The instrument laboratory.** Continuous size axis (`body_size` -1 to 2.5, tuning
  optionally following: violin to viola to cello to bass and beyond), string mass, stiffness, rosin,
  bow grit, bridge coupling up to wolf notes, sympathetic strings (up to six), the invented presets
  (Hardanger, glass violin, octobass, wolf cello). Evidence: the wolf note on a strongly coupled cello,
  tamed by a firmer bow, absent at normal coupling; sympathetic strings ring when they share a
  harmonic; bounded output for impossible instruments. BDD scenarios in
  `tests/features/physmod_synth.feature`.
- [ ] **1.8 Physics View and one held note.** `PhysModShared` (lock-free state the view reads),
  `widgets_physmod.rs` (strings drawn from their simulated shape, the bow coloured by friction regime),
  Physics View (standing-wave envelopes, the travelling Helmholtz corner, body-mode levels, a live
  Schelleng diagram, the "ringing in sympathy" readout), and `PhysModLive`: a bow drag in 3D, a drag in
  the diagram, the knobs, the AI tool and automation all move the same held note. Introduces the
  "one instrument, two representations" pattern that posts 2 and 3 reuse.
- [ ] **1.9 In the DAW.** `PhysModInstrumentVoice` (notes share strings and body), `daw_physmod.ts`,
  the laboratory controls, offline export through `render_performance`. Cost of a whole instrument
  (docs: about 4% of one core plus about 1% per sympathetic string; re-measure).
- [ ] **1.10 How this was verified without listening.** The method, written once here: every behaviour
  measured from rendered audio; `analysis.rs` shared by the tests, `Entropy.PhysMod.analyzeNote` and the
  DAW's AI tool; the no-allocation test on the audio thread while notes arrive, slur and release; the
  view tests and their pictures. A "claim, then the test that holds it" table from the doc. Then where
  measurement ended and Alex's listening begins.
- [ ] **1.11 Failure notes and known limits.** The regenerative voice it replaces; the bottom five or
  so bass notes take 0.3-0.5 s to settle; the window fit is an estimate in the view while the sound is
  the simulation; not modelled: bow width, torsional waves, thermal friction, the string's second
  polarisation; direct manipulation of construction from the 3D view is not built. The pitch and
  damping assertions flagged on the CC Manager board (`physmod-pitch-and-damping-tests`) predate the
  rewrite of `physmod_synth.feature`, and the feature no longer contains those phrases, so check
  whether that card still applies before citing the feature as evidence.

**Gaps:** no listening comparison; the live DAW feature needs a desktop session and audio device.
Gate: [ ] evidence run  [ ] drafted  [ ] reviewed by Alex  [ ] tag or commit pinned

---

## Post 2 - Brass

**Working title:** A tube, a pair of lips and a shock front
**Type:** C (hard goal). Where post 1's resonator was a string, here the resonator is the whole
instrument and the player matters more; links back to post 1, forward to post 3.
**Sources to read at draft time:** whichever transfer-matrix and waveguide-brass papers the code's
comments and the plan name; Smith for Kelly-Lochbaum cells; the published work on shock waves in
trombones that the plan builds on, read before any claim about what real trombones do.
**Commands from the doc:** `cargo test --release --lib brass`, `--test brass_no_alloc`,
`--test brass_view`; `npx vitest run tests/daw_brass.test.ts`.

- [ ] **2.1 What is different from the string.** The chain (player, lips, mouthpiece, bore, radiation)
  and the plan's comparison table, cut to what the post proves. Two consequences: the bore is the
  instrument, and the player matters more.
- [ ] **2.2 The bore.** `bore.rs`: cones, cylinders and Bessel flares in three runs (front, cylinder,
  bell); stock tenor trombone (.547" bore, 8.5" bell, about 2.8 m), B-flat trumpet, double horn, F tuba,
  with tapers and flares found by search so the resonances line up.
- [ ] **2.3 The reference: transfer-matrix impedance.** `impedance.rs`, 1 mm staircase, visco-thermal
  loss, lumped radiation load. Build and test time only. Evidence: the quarter-wave cylinder check
  within 3 cents; trombone resonances 2-10 within 30 cents of the B-flat series with the first below
  0.75 of the fundamental; seventh position lowers resonances 3-10 by 5.4-6.4 semitones.
- [ ] **2.4 The runtime waveguide.** `airbore.rs`: Kelly-Lochbaum cells (one sample, about 3.9 mm
  each), fractional delay lines for the cylinder, one lumped linear-phase loss filter per direction,
  radiation reflection. Evidence: runtime peaks 2-8 within 12 cents of the reference. Failure note:
  the plan assumed a first-order allpass could carry the boundary layer's slowing; at the model's rate
  it swings the delay by hundreds of samples where the boundary layer moves it by about nine, so the
  slowing is applied at the played pitch (about 15 cents flat eight partials up). The lumped loss
  filter also leaves the DC flow resistance about 7x too high.
- [ ] **2.5 The lips.** `lips.rs`: one-mass outward-striking valve, Bernoulli flow solved in closed
  form against the mouthpiece each sample, lip collision. Lip mass following the note
  (`3 (233 / f)^2` kg/m^2). Evidence: a breath threshold of 150-600 Pa for partials 2-8; partial 12
  needs more than twice partial 4's.
- [ ] **2.6 Why it plays sharp, and a player fitted from the model.** The one-mass lip sounds 50-110
  cents above the resonance, so the player pulls the slide and tunes by ear. Fitted laws:
  `lip_center` (0.85 `(p / 700 Pa)^-0.073` of the resonance, aimed 3% high) and `sounding_offset`.
  Evidence: in tune within 6 cents at pp and mf, 16 at ff; loose lips drop B-flat3 to F3, pinched
  lips pop it to D4. The planned two-degree-of-freedom lip is not built.
- [ ] **2.7 Attacks.** Released from rest the lips ring at about 0.8 of the note and take about 150 ms
  to be pulled round; guided attack and `attack_skill`, the tongue, cracks and retries. Evidence:
  skilled attacks reach half level within 40 ms and 90% within 80 ms; an unskilled start blooms 2.5x
  slower and high notes start 60+ cents off; a glissando passes through the pitches between.
- [ ] **2.8 Brassiness: nonlinear propagation and shock fronts.** Pressure-dependent propagation in
  four forward segments (the generalized-Burgers steepening). It was planned as `burgers.rs` and lives
  in `airbore.rs`; say so where the plan is quoted. The shock-front rule: the read point may move at
  most half a sample per sample. The one clean A/B: the same breath with and without the air's
  nonlinearity. Evidence: ff at least 12 dB louder than mf with the centroid more than doubled; with
  the nonlinearity off the 10th harmonic is 15 dB+ weaker; the wavefront at the bell steepens 8x+
  from mf to ff. Spectra and a waveform at the bell for both.
- [ ] **2.9 One bore, four instruments.** `BrassInstrument` and `Mechanism` (slide, or valves whose
  tubes add), the valve chart and why the nearest-resonance fingering was rejected (the player takes
  the standard chart and trims by up to 45 cents), the horn's F side, the tuba as a mostly conical
  bore. Evidence: valve 1+3 comes out 15-40 cents sharp; each instrument in tune across its range
  within 8 cents (tuba's lowest within 20); a valve slur has no gap.
- [ ] **2.10 Mutes, the hand and the bell.** Straight, cup and harmon as an obstruction plus filters;
  the hand as part of the bore profile; bell facing as a blend of on-axis and radiated-power outputs.
  Evidence: stopping the horn puts a resonance 80-170 cents above each of partials 9-16 (stopped A4
  within 10 cents, brighter, 6 dB+ quieter, hence stopped horn sounding a semitone high); each mute
  keeps the trombone within 8 cents, harmon 12 dB+ quieter; a bell toward the listener 1.8x+
  brighter. Limits: a mute's body is a filter, not acoustics; the harmon pulls the trumpet about 20
  cents flat.
- [ ] **2.11 The view and the DAW.** `widgets_brass.rs` (each instrument laid out from its own bore:
  the drawing is as long as the air column, a valve loop as long as the tube it adds, the mute or hand
  drawn where the bore is obstructed), Physics View (standing wave, resonance ladder, playing map, one
  period of lips and mouthpiece), `BrassShared` and `BrassLive`, `daw_brass.ts` (playing styles,
  mutes, the Brass window, the `daw_brass` tool), offline export. Point at post 1.8 for the shared
  pattern rather than re-explaining it. Cost per player (docs: 3.9% of one core; re-measure).
- [ ] **2.12 Verification, failure notes and known limits.** The claim-and-test table for brass; the
  no-allocation test; the view pictures; the DAW tests. Limits: the low register radiates about 15 dB
  less than the high (no register balance yet); ff notes at the extremes are within 15 cents, not 6;
  some extreme notes miss (horn F2, G2, and F4 at some dynamics); pedal tones are tuba-only; changing
  instrument, mute, hand or bell applies from the next note; Phases 3 and 4 (laboratory, section) are
  not built.

**Gaps:** the docs say the live window is tested through callbacks and the headless view, not end to
end; `daw_brass_live.feature` screenshots need Alex's machine.
Gate: [ ] evidence run  [ ] drafted  [ ] reviewed by Alex  [ ] tag or commit pinned

---

## Post 3 - Drums and cymbals

**Working title:** From one contact law to a kit that hears itself
**Type:** C (hard goal), with the kit as a B (novel integration). The longest of the three: it holds
five PRs of work. The ordering below is one thread: each section adds what the next needs, and the
cymbals section carries a partial result, like the FFT-ocean posts.
**Sources to read at draft time:** Hunt and Crossley, Flores et al., Hertz; Rossing on timpani modes
and Fletcher and Rossing on membranes; Leissa's plate tables (the code cites them); the von Karman
plate and scalar-auxiliary-variable literature. Identify the exact papers from the code and docs.
**Commands from the doc:** `cargo test --release --lib matter`, `--test matter_no_alloc`,
`--test matter_view`; `npx vitest run tests/daw_matter.test.ts`. Ignored tests, run with
`--ignored --nocapture`: `matter::tests::cost`, `matter::cymbal_tests::cymbal_cost`, `cascade_report`,
`rate_report`, `inplane_report`, `matter::kit_tests::kit_report`, and the `*_listening_examples`.

- [ ] **3.1 Impact as the connective tissue.** Why the series' third instrument starts from a contact
  law, and the seven-system frame from the Sounds plan cut to what is built. The shape of
  `src/audio/matter/`.
- [ ] **3.2 Modal bodies.** `modal.rs`: modes as rotated complex states (exact for a force held over a
  sample), in tune in `f32` even at 30 Hz, never unstable, silent above Nyquist; `set_scale` retunes a
  ringing body with displacement and velocity continuous; quiet modes flushed before they turn
  subnormal. `bessel.rs`: Miller's backward recurrence and zeros. Evidence: `J_m` values and zeros
  against tables.
- [ ] **3.3 Contact.** `contact.rs`: materials, Hertz spheres and felt power laws, Hunt-Crossley with
  Flores' restitution relation, a per-sample bracketed Newton solve. Evidence: contact time and peak
  force at 44.1 kHz match a 4x finer step; contact time falls as `v^(-1/5)` and matches Hertz's closed
  form; rebound follows restitution 0.3, 0.6, 0.9. Failure note: wood on bronze peaks for tens of
  microseconds, which 44.1 kHz sees averaged; contact time, impulse and the spectrum below 8 kHz still
  match the finer step.
- [ ] **3.4 A drum head from Bessel zeros.** `membrane.rs`: mode shapes normalised to the head's mass,
  the radiation impedance of every mode from its Hankel transform, tension solved from a tuning.
  Evidence: the 26" timpani's `(m,1)` ratios 1 : 1.469 : 1.921 : 2.361 : 2.795 from the vacuum
  1 : 1.340 : 1.665 : 1.980 : 2.289, against Rossing's roughly 1 : 1.50 : 1.97 : 2.44; the `(0,1)` thud
  dying in 0.49 s against 1.74 s for the note; a centre strike leaving the asymmetric modes 30 dB+
  quieter.
- [ ] **3.5 Tension modulation and the glide.** The stretch coefficient `E h / (4 (1 - nu))`, capped
  at the film's yield strain (about 3%). Evidence: an 82 Hz floor tom starts 63 cents sharp at 6 m/s,
  16 at 3 m/s; a slacker head glides further. Failure notes: driving tension from the instantaneous
  `q^2`, or a lagged copy, pumps energy in (parametric amplification) and a hard hit runs away; the
  cycle-averaged amplitude fixed it. A hard beater on a slack kick starts about 400 cents sharp, which
  the docs call what uniform-tension stretching gives, not what a real pillowed kick does.
- [ ] **3.6 Kick, toms, timpani.** `drum.rs` presets, `cavity.rs`'s uniform mode as the air spring,
  contact times set by the head's give (timpani mallet about 8 ms, stick about 6 ms, kick beater about
  19 ms), the kick's pillow cutting the boom by 6 dB+, a plastic beater putting 6 dB+ more above 4 kHz
  than felt.
- [ ] **3.7 The snare.** Membrane, shell air, impact and many small contacts in one instrument.
  The cavity's transverse modes (the first near 565 Hz in a 14" by 5.5" shell); the wires (eight
  groups, lifting when the head accelerates away faster than `preload / mass`); the sampled high band a
  complete mode set stops short of (2-3 kHz). Evidence: wires land 50+ times on a mezzo hit and never
  with snares off; looser wires buzz longer (0.05 N to 130 ms, 1.2 N to 40 ms); snares add 4 dB+
  above 3 kHz in the first 50 ms; the snare side holds 6.5% of the head's energy in `m = 1` modes; a
  stick's crack above 4 kHz up 10 dB+ with the high band while the contact changes under 3%. Failure
  notes: coupling the high band both ways made the contact chatter, so it only listens; retuning in
  16-sample steps put sidebands at multiples of 2.8 kHz, 40 dB+ above the true top end, fixed by ramping
  every sample; a uniform-pressure-only cavity let the wires' energy radiate away in tens of
  milliseconds. Cost: 44% of a core down to 13% after profiling and SSE2 (Linux container; re-measure).
  Limits: no shell modes, rim, rimshot or cross-stick.
- [ ] **3.8 Cymbals: a shallow shell.** `plate.rs`: free-edge thin plate modes, bent into a shallow
  spherical dome, radiation by the Rayleigh integral. Evidence: a 20 mm dome lifts the crash's `(0,1)`
  from 38 Hz to 547 Hz; free-plate `lambda^2` within 2e-4 of the frequency equation and Leissa's table
  within 0.5%; the shell's short waves follow `omega^2 = omega_flat^2 + E / (rho R^2)` within 1%.
- [ ] **3.9 The von Karman nonlinearity.** `vonkarman.rs`: the stretching force run with a scalar
  auxiliary variable so total energy cannot grow, evaluated every other sample (every third aliases,
  90 dB errors). Evidence: a hard stroke about 10 dB louder than the same plate made linear;
  energy-weighted frequency rises 10%+ within 100 ms of a hard hit and falls back, where a linear
  plate's only falls; two 25 m/s hits stay finite; undamped drift about 0.1% in a second. Failure
  notes: dropping even the smallest 1% of couplings moved some bands 11 dB, so no pruning; sparse
  gather-scatter took 213% of a core, dense blocks and SSE2 56% with identical output; a coupling
  rested on one reading (at a zero crossing) lost 15 dB from the low bands. The honest negative result,
  said as a limit and not a caveat: the cascade stops at the nonlinear set's top (2 kHz), so the
  crash's rising wash above a few kHz is missing and the radiated centroid does not rise.
- [ ] **3.10 The kit as one voice.** `kit.rs`: `placement` shared by the sound and the view, each
  piece's sound reaching every drum after `d / c` through the same pressure path the air uses,
  blocks of 32 samples, parked worker threads, pieces asleep when silent, builds off the audio
  thread (1.6 s cold, 0.15 s cached), `live.rs` (`KitVoice`, `KitHandle`, `MatterShared`). Evidence:
  the closest pair of pieces is 54 samples of sound travel apart, so a 32-sample block is exact;
  output identical sample for sample with 0, 1 and 3 workers; a rack tom sets the snare wires
  buzzing (12 landings at 2 m/s, 152 at 4, 322 at 6); a groove's audio-thread load (docs: 100% of
  real time on one thread, 68% with two workers in a four-core container; the Windows figure is the
  one to publish). Failure notes: the energy leak, where a 6 m/s felt beater left the slack kick at
  19 m/s because the high band's motion raised the tension, fixed by restricting the stretch to
  contact-coupled modes (5.2 m/s); more threads than work was slower (75% with three workers).
- [ ] **3.11 The kit in the DAW.** `widgets_matter.rs` (heads and plates as rings and spokes displaced
  by the published field, the lowest 64 modes on a 145-point grid about 85 times a second, the stick
  replaying each contact, snare wires glowing, click-to-strike, pads, Physics View), `daw_matter.ts`
  (kit rows with General MIDI notes, presets, velocity as stick speed from 0.4 m/s log-spaced, tunings
  committed after 350 ms of stillness, the mix as microphones, the `daw_matter` tool), `matter_ops.rs`
  (`analyzeHit`). Point at post 1.8 for the shared view pattern.
- [ ] **3.12 Verification, failure notes and known limits.** The claim-and-test table for matter;
  `matter_no_alloc.rs`; the view pictures; the DAW tests. Limits: no hi-hat, no rim; cymbals radiate
  into the kit but do not listen; a whole kit ringing costs about 30% of a core against the plan's 5%,
  and a crash 56% (ride 63%); no bell profile, lathing, chokes or glancing strikes on cymbals; hits
  sent while a kit is built are dropped (1.6 s cold); heads are ideal membranes (no bending stiffness,
  so degenerate pairs do not split and beat).

**Gaps:** `daw_matter_live.feature` has not been run in the environment the docs were written in;
it needs a desktop session and audio device. Split point if this runs too long: 3.1-3.7 (drums) and
3.8-3.12 (cymbals and kit) already stand alone.
Gate: [ ] evidence run  [ ] drafted  [ ] reviewed by Alex  [ ] tag or commit pinned

---

## Not in these three posts

- **Songs made with the instruments.** The eleven sample songs in
  `examples/studio-bundle/sample-songs/` use modelled strings and brass and Matter cymbals and toms.
  Wait for the CC Manager card `daw-showcase-song-collection` and for Alex to listen. The finale test
  covers bars 49-52 only.
- **Built later:** strings' direct manipulation of construction from the 3D view and second
  polarisation; brass Phase 3 (laboratory), Phase 4 (section and hall) and the two-degree-of-freedom
  lip; hi-hat, rim, the cymbals listening to the room, gongs and bells; Sounds phases 3-7 (friction,
  granular, fracture, water, the scene). Each becomes a post when its "Implementation Status" says
  done and its tests exist.

## Open questions for Alex

- Whether post 3 stays one post or splits at 3.7 / 3.8 if it runs past a comfortable read.
