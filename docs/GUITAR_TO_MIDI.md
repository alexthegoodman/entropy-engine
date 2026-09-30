# Guitar-to-MIDI for Entropy DAW

**Status:** Draft v3 · **Scope:** v1 (monophonic) plus chord mode ([Section 12](#12-chord-mode-polyphonic-2026-09-30)) · **Platform:** Windows first (Entropy is currently only tested on Windows)

> **Build reminder:** use **release builds for anything that measures time**: CPU per callback, wall-clock latency on hardware, soak tests and `guitar_bench cpu`. Debug DSP code can be an order of magnitude slower, so never report or compare timing from a debug build. Everything else (everyday builds, the unit tests, the BDD scenarios, the accuracy and invariant suites) is fine in a **debug build**, which is much faster to compile. The engine is deterministic and its latencies are counted in input samples, not wall time, so debug and release give the same events. The accuracy tables below come from `guitar_bench`, which is simply run in release because it replays thousands of recordings.

---

## 1. Summary

Entropy DAW will let a guitarist plug an electric guitar into an audio interface and play Entropy's instruments directly. A real-time pitch-tracking engine written in Rust converts the guitar signal into note events (Note On, Note Off, velocity, pitch bend) that flow through the same path as any other note source in the DAW.

This is a feature of Entropy DAW, not a standalone application, and it will be open source. It uses Entropy's existing windowing, UI, audio, and persistence facilities rather than duplicating them.

v1 targets **monophonic** playing: one note at a time.

## 2. Goals, priorities, and non-goals

**Priorities, in order (use these to break ties in design decisions):**

1. Low perceived latency.
2. Accurate note detection.
3. Stable output with no false or oscillating notes.
4. Natural handling of vibrato and bends.
5. Real-time reliability (no dropouts, no stuck notes).
6. A clean integration that other contributors can understand, test, and extend.

**Non-goals for v1** are listed in [Section 9](#9-scope-v1-and-later-phases). In short: chords, per-string detection, technique detection (hammer-ons, palm muting), external MIDI hardware/virtual ports, MPE, and machine-learning detection.

---

## 3. User stories and acceptance scenarios

### 3.1 First-time setup

**As a guitarist** opening Entropy DAW for the first time with my guitar connected to an audio interface, **I want** to choose my input and confirm the signal is healthy, **so that** I can start playing without knowing anything about DSP.

- **Given** an audio interface is connected, **when** I open the Guitar Input panel, **then** I see the available input devices and channels and can pick one.
- **When** I play, **then** a level meter responds, a clip indicator warns me above −1 dBFS, and a "signal too low" hint appears if my picked notes consistently peak below −30 dBFS.
- **When** I run **Calibrate** (stay silent for ~3 s, then play a few soft and hard notes for ~5 s), **then** the noise gate threshold and velocity range are set automatically.
- **Given** I skip calibration, **then** sensible defaults still work for a typical guitar and interface.

### 3.2 Playing single notes

**As a guitarist,** **I want** each picked note to sound the matching note on a Entropy instrument, **so that** I can play the instrument with my guitar.

- **Given** processing is enabled and a target instrument is selected, **when** I pick a note, **then** one Note On is emitted within the latency budget ([Section 5](#5-benchmarks-and-acceptance-targets)) with a velocity that reflects how hard I picked.
- **When** I hold a note for 5 seconds while it decays naturally, **then** exactly one Note On and one Note Off are emitted (no retriggering).
- **When** I mute or release the string, **then** Note Off is emitted promptly.
- **When** I re-pick the same pitch, **then** a new Note Off/Note On pair is emitted.
- **When** only background noise is present (hum, handling noise, room noise) below threshold, **then** no notes are emitted.

### 3.3 Expressive playing (vibrato, bends, slides)

**As a guitarist,** **I want** vibrato and bends to come through as smooth pitch movement, **so that** my playing feels natural and doesn't stutter between neighboring notes.

- **When** I play normal vibrato (about ±50 cents at 4–8 Hz), **then** no neighboring notes are triggered and the pitch bend follows the movement smoothly.
- **When** I bend a note up a whole tone, **then** pitch-bend values rise continuously from center without retriggering, and settle at the correct value.
- **When** I slide or bend beyond the configured pitch-bend range, **then** a new note is started instead.
- **When** the next note starts, **then** pitch bend has been reset to center first.

### 3.4 Recording a take *(SHOULD for v1)*

**As a guitarist,** **I want** to record my playing onto an instrument track, **so that** I can edit it like any other MIDI-style performance.

- **Given** a track is armed for recording, **when** I play, **then** notes appear on the track (e.g., in the piano roll) with pitch, velocity, and bend data.
- **Then** recorded note timing reflects when I actually played, compensating for the known detection latency, not when the event happened to be emitted.

### 3.5 Tuning and troubleshooting

**As a guitarist,** **I want** to see what the engine is hearing and adjust responsiveness, **so that** I can fix problems without guessing.

- **When** I open diagnostics, **then** I see input level, detected frequency, detected note, cents deviation, confidence, tracker state, velocity, pitch-bend value, buffer configuration, approximate latency, and any audio overruns/underruns.
- **When** I choose **Fast**, **Balanced**, or **Accurate**, **then** the engine trades latency against stability accordingly.
- **When** I adjust the gate threshold or sensitivity, **then** the change takes effect immediately.

### 3.6 Recovering from failures

**As a guitarist,** **I want** problems to be handled gracefully, **so that** a glitch never ruins a session or leaves a note droning.

- **When** I stop processing, change devices, or close Entropy, **then** all active notes are released and pitch bend is reset.
- **When** my interface is unplugged mid-performance, **then** active notes are released, Entropy keeps running, and I get a clear message explaining what happened and how to recover.
- **When** I request an unsupported sample rate or buffer size, **then** I'm told what was rejected and what the engine fell back to.

---

## 4. Requirements

Keywords follow RFC 2119: **MUST** = required for v1, **SHOULD** = expected for v1 unless there is a good reason not to, **MAY** = optional.

### 4.1 Audio input

- **AUD-1 (MUST)** Capture a mono guitar signal from a user-selected audio device and channel using a low-latency backend. ASIO is the primary Windows target.
- **AUD-2 (MUST)** Isolate the audio backend behind a small interface so WASAPI, CoreAudio, and other backends can be added later.
- **AUD-3 (MUST)** Let the user configure sample rate and buffer size where the driver supports it. Defaults: 48 kHz, 128 samples.
- **AUD-4 (MUST)** Let the user start and stop processing, and display input level plus clip and low-signal indicators.
- **AUD-5 (SHOULD)** Reuse Entropy's existing audio infrastructure where it fits, rather than introducing a parallel audio stack (see [open questions](#10-open-questions)).

### 4.2 Signal conditioning

- **DSP-1 (MUST)** DC removal.
- **DSP-2 (MUST)** Noise gate with hysteresis (separate open and close thresholds).
- **DSP-3 (MUST)** Amplitude envelope follower.
- **DSP-4 (MUST)** Transient/onset detection to identify new picked attacks.
- **DSP-5 (SHOULD)** Input gain and high-pass/low-pass filtering, with defaults chosen so the filters never attenuate the detection range.
- **DSP-6 (SHOULD)** Defaults work out of the box; parameters are structured so they can be exposed to users later.

### 4.3 Pitch detection

- **PIT-1 (MUST)** Continuously estimate the fundamental frequency of the monophonic signal.
- **PIT-2 (MUST)** Each result carries: frequency, confidence, amplitude, and sample position/timestamp.
- **PIT-3 (MUST)** Nominal detection range **70 Hz to 1400 Hz**. This covers standard tuning from E2 (82.4 Hz) through the 24th fret of the high E string (~1318.5 Hz), plus Drop D (73.4 Hz) with margin.
- **PIT-4 (MUST)** Reject estimates below minimum confidence or signal level.
- **PIT-5 (MUST)** Use an algorithm suited to low-latency monophonic detection (YIN, McLeod Pitch Method, or a hybrid). Put the detector behind an interface and choose the v1 default by benchmarking candidates on the test corpus.
- **PIT-6 (SHOULD)** Adapt the analysis window to the candidate pitch so high notes don't pay the latency cost of low notes. A low E period is ~12 ms; a high E period is ~3 ms.
- **PIT-7 (SHOULD)** Refine frequency estimates with interpolation for sub-semitone accuracy.

### 4.4 Note tracking

Pitch estimates never generate events directly; they pass through a state machine: **Silent → Attack → Playing → Release → Silent**.

- **TRK-1 (MUST)** A new note requires an onset **and** a pitch that is stable within the active responsiveness mode's stability window.
- **TRK-2 (MUST)** Hysteresis and smoothing prevent oscillation near a semitone boundary.
- **TRK-3 (MUST)** While a note is held, pitch movement within the configured bend range is treated as continuous pitch (bend/vibrato), not new notes.
- **TRK-4 (MUST)** A pitch outside the bend range without a fresh onset (e.g., a long slide) starts a new note.
- **TRK-5 (MUST)** Detect and suppress likely octave/harmonic errors, for example a sudden jump of about ±1200 cents that isn't accompanied by an onset.
- **TRK-6 (MUST)** Ignore transient noise (pick clicks, handling noise) that doesn't produce a stable pitch.
- **TRK-7 (MUST)** End a note when the envelope stays below the release threshold for the mode's release time.
- **TRK-8 (MUST)** Distinguish a same-pitch re-pick (new onset) from a sustained note.

**Post-Note-On refinement policy.** Note events can't be retracted once sent, so v1 uses this rule: Note On is emitted only after the stability window has passed. After that, refinement is limited to pitch bend. If an octave error is discovered after Note On, emit Note Off followed by Note On for the corrected note, and count it in diagnostics.

**Known v1 limitation.** Hammer-ons and pull-offs don't create a fresh onset. Within the bend range they will be rendered as fast pitch-bend steps rather than new notes. Proper legato handling is planned for a later phase.

### 4.5 Note events and velocity

- **EVT-1 (MUST)** Convert frequency to a note number using a configurable reference pitch (default A4 = 440 Hz).
- **EVT-2 (MUST)** Derive velocity (1–127) from the peak amplitude in a short window after the attack. The window must fit inside the pitch-stability window so velocity adds no extra latency.
- **EVT-3 (MUST)** Map amplitude to velocity through a curve, with defaults that can be adjusted by calibration.
- **EVT-4 (MUST)** Emit Note Off before the next Note On, and reset pitch bend to center before the next Note On when the bend is non-zero.
- **EVT-5 (MUST)** Track active-note state so a note can never remain on due to a missed transition.
- **EVT-6 (MUST)** On stop, device change, device loss, or app exit, release all active notes and reset pitch bend.
- **EVT-7 (MUST)** Events carry a sample-accurate timestamp so the DAW can schedule and record them precisely.

### 4.6 Pitch bend

- **BND-1 (MUST)** After Note On, represent pitch deviation from the note center as pitch bend, using 14-bit resolution.
- **BND-2 (MUST)** Configurable bend range in semitones. Default ±2, allowed 1–12.
- **BND-3 (MUST)** Bend output reflects the actual deviation from the note center (an out-of-tune string produces a constant offset). A deadzone or snap-to-center option is a later-phase feature.
- **BND-4 (MUST)** Apply light smoothing and rate-limit bend messages (see [Section 5](#5-benchmarks-and-acceptance-targets)) so they cannot flood the event queue. Only emit on change.
- **BND-5 (SHOULD)** Keep the receiving instrument's bend range in sync with the configured range (see [open questions](#10-open-questions)).

### 4.7 Output and DAW integration

- **OUT-1 (MUST)** Guitar events enter Entropy through the same note-event path used by other note sources, so any Entropy instrument can be played by the guitar without special-casing.
- **OUT-2 (MUST)** The user selects a target instrument or track in the Guitar Input panel.
- **OUT-3 (MUST)** Events are delivered from the audio thread over a lock-free, bounded queue. Overflow drops the oldest bend messages first and never blocks.
- **OUT-4 (SHOULD)** When a track is armed, guitar events are recordable with latency-compensated timestamps.
- **OUT-5 (MUST)** The engine core does not depend on Entropy's UI or on a specific audio backend, so it can be tested offline and embedded elsewhere later.

### 4.8 Responsiveness modes

| Mode | Intent | Tradeoff |
| --- | --- | --- |
| **Fast** | Lowest latency | Shorter stability window; more potential detection errors |
| **Balanced** (default) | Compromise | Default for most players and signals |
| **Accurate** | Difficult signals (noisy pickups, low tunings) | Longer stability and release windows; higher latency |

Each mode is a named set of parameters (stability window, minimum confidence, release time) in a single config struct. Exact values are tuned against the test corpus and recorded in this document once known.

### 4.9 Monitoring and diagnostics

- **DIA-1 (MUST)** Show: input level, detected frequency, detected note, cents deviation, confidence, tracker state, velocity, current pitch-bend value, buffer configuration, approximate processing latency, and overrun/underrun counts.
- **DIA-2 (MUST)** Diagnostics reach the UI through a lock-free snapshot or queue. The audio thread never waits on the UI.
- **DIA-3 (SHOULD)** A debug mode exposes more DSP and timing detail (per-stage timings, raw vs. tracked pitch, rejected estimates and reasons).

### 4.10 Configuration

- **CFG-1 (MUST)** Persist between sessions: audio device, channel, sample rate, buffer size, target instrument/track, pitch-bend range, gate threshold, detection sensitivity, responsiveness mode, reference pitch.
- **CFG-2 (MUST)** Use Entropy's existing persistence mechanism rather than a new one.
- **CFG-3 (MUST)** Ship usable defaults; a stored device that isn't present is shown as unavailable, and the setting is retained.
- **CFG-4 (SHOULD)** Version the settings schema and tolerate unknown fields.

### 4.11 Error handling

| Condition | Required behavior |
| --- | --- |
| Selected device unavailable or disconnects | Release all notes, stop processing, show actionable message; Entropy keeps running |
| Driver fails to initialize | Show driver error and suggest fallbacks |
| Unsupported sample rate or buffer size | Report what was rejected and the fallback used |
| Target instrument/track removed | Release all notes, pause output, prompt for a new target |
| Audio overrun/underrun | Count and display; never crash |
| Signal too weak / clipping | Indicator plus guidance |
| Low pitch confidence | Emit no events; visible in diagnostics |

Errors are reported outside the real-time path and must never destabilize the audio thread.

### 4.12 Real-time safety

- **RT-1 (MUST)** No heap allocation, locks, blocking I/O, file/network access, or logging in the audio callback.
- **RT-2 (MUST)** All buffers preallocated; execution time predictable.
- **RT-3 (MUST)** The audio callback must not panic. On an unrecoverable internal error, release all notes and disable the engine cleanly.
- **RT-4 (SHOULD)** Guard against denormals in filters and envelope followers.
- **RT-5 (MUST)** DSP and tracking are separated from UI and configuration code.

---

## 5. Benchmarks and acceptance targets

> **Timing needs the release flag.** CPU and wall-clock numbers in this section need `cargo run --release` (for example `cargo run --release --bin guitar_bench -- cpu`) or `cargo bench`. Pick-to-Note-On latencies are counted in input samples, so they are the same in any build; the benchmark runs in release only because it replays thousands of recordings.

These are **starting targets**, chosen to be plausible for a well-built YIN/MPM-class detector. Revise them once the first real measurements exist, and record the actual results in the repo.

**Reference conditions** (record all of these with every result): CPU model, OS version, audio interface and driver, sample rate (48 kHz), buffer size (128 samples ≈ 2.67 ms), responsiveness mode, and git commit hash.

### 5.1 Latency (internal pipeline)

Measured from the input buffer containing the attack onset to the emitted Note On, 95th percentile, over the test corpus. Excludes interface hardware latency and instrument output latency. Physics matters here: a detector needs roughly two periods of the note, so low strings cannot match high strings.

| Register | Notes | Fast | Balanced | Accurate |
| --- | --- | --- | --- | --- |
| High | E4 and above (≥ 330 Hz) | ≤ 10 ms | ≤ 15 ms | ≤ 25 ms |
| Mid | A2–D#4 (110–330 Hz) | ≤ 15 ms | ≤ 20 ms | ≤ 35 ms |
| Low | E2–G#2 (< 110 Hz) | ≤ 30 ms | ≤ 40 ms | ≤ 55 ms |

**End-to-end latency** (guitar in to instrument audio out, measured with an external loopback rig): informational for v1, with a starting goal of ≤ 35 ms for mid and high registers in Balanced mode. Promote it to a gating target after the first measurements.

### 5.2 CPU and real-time behavior

| Metric | Target |
| --- | --- |
| DSP time per audio callback (128 samples @ 48 kHz) | Mean ≤ 10% of the buffer period (~0.27 ms); p99.9 ≤ 50% (~1.3 ms) |
| Heap allocations in the audio callback | 0 (verified by an allocation-tracking test) |
| Locks or blocking calls in the audio callback | 0 |
| Audio xruns during a 2-hour soak test (Balanced, with a representative Entropy project loaded) | 0 |
| Memory growth over the soak test | No unbounded growth |

### 5.3 Detection accuracy (labeled recorded corpus, Balanced mode)

| Metric | Target |
| --- | --- |
| Correct note on picked single notes, E2–E6 | ≥ 95% overall, no register below 90% |
| Octave errors | ≤ 2% of Note Ons |
| Pitch error on sustained notes | Median ≤ 5 cents, p95 ≤ 10 cents |
| Spurious Note Ons on noise-only recordings (hum, handling noise) at default threshold | ≤ 1 per minute; 0 after calibration on a room-noise file |
| Sustained 5-second decaying note | Exactly 1 Note On and 1 Note Off, 0 retriggers |
| Fast repeated notes (mid/high registers) | Distinguishes notes ≥ 100 ms apart in Balanced, ≥ 75 ms apart in Fast, at ≥ 95% correct |

### 5.4 Expression and note ending

| Metric | Target |
| --- | --- |
| Vibrato (±50 cents, 4–8 Hz) | 0 neighboring-note retriggers; median bend tracking error ≤ 10 cents |
| Whole-tone bend | Monotonic bend values, 0 retriggers, final value within ±10 cents of target |
| Note Off after string mute | ≤ 50 ms after the envelope drops below the release threshold |
| Pitch-bend message rate | ≤ 200 messages/s, only on change |
| Stuck notes across stop, device change, disconnect, and exit tests, and across the soak test | 0 |

---

## 6. Test strategy

1. **Offline replay harness.** The engine core takes sample buffers and returns events and diagnostics deterministically, with no audio device or UI. This is the foundation for everything below.
2. **Labeled recording corpus.** Recorded guitar clips with ground-truth labels: notes across E2–E6, soft/hard picking, sustained and muted notes, re-picks, vibrato, bends, slides, fast runs, and noise-only files (hum, handling noise, room noise). Because the project is open source, record the corpus under a permissive license (e.g., CC0) so anyone can run the suite.
3. **Synthetic signal tests.** Pure tones, harmonic-rich waveforms, and missing-fundamental signals for the detector; pitch sweeps and vibrato for the tracker.
4. **Event-stream invariants.** Property/fuzz tests that for any input, the output is well-formed: no Note On while a note is active, every Note On eventually has a Note Off, bend is centered before each new note.
5. **Real-time safety tests.** Allocation tracking on the audio path (a test allocator or a crate such as `assert_no_alloc`) and callback-time histograms.
6. **Benchmarks.** `cargo bench` for per-stage and per-callback timings. **Release builds only.**
7. **Soak test.** At least 2 hours of continuous processing with a representative Entropy project, checking xruns, memory, and stuck notes.
8. **Loopback measurement.** External measurement of end-to-end latency for the informational target.
9. **CI.** Run the replay-accuracy suite on each pull request and fail on regressions beyond a set threshold (debug is fine for accuracy; release for any timing check).

---

## 7. Architecture

Each stage is independent and testable in isolation:

```text
┌────────────────────────────┐
│   Audio Input Backend      │  ASIO first; WASAPI/CoreAudio later
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│   Signal Conditioning      │  DC removal / filters / gate / envelope / onset
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│   Pitch Detector           │  frequency + confidence + amplitude
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│   Note Tracker             │  Silent → Attack → Playing → Release
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│   Note Event Translator    │  Note On/Off, velocity, pitch bend
└─────────────┬──────────────┘
              ▼
┌────────────────────────────┐
│   Entropy DAW Note Path    │  target instrument / track / recording
└────────────────────────────┘

   Settings persistence  +  Diagnostics UI panel
```

**Threading.** The audio callback thread runs conditioning, detection, tracking, and event generation. It communicates with the rest of Entropy only through lock-free bounded queues (events out; diagnostics snapshots out; parameter changes in).

**Language split.** The real-time path lives in the Rust core. The UI panel (device pickers, meters, calibration, diagnostics) may be a TypeScript addon that talks to the engine through a small control and diagnostics API (namespace name TBD). No per-sample or per-buffer data crosses into TypeScript.

**Module boundaries.** The DSP, pitch, and tracker modules must not depend on Entropy's UI, on ASIO, or on the DAW's audio engine. Exact crate/module placement is to be decided against Entropy's current source layout.

---

## 8. Configuration defaults (initial)

| Setting | Default |
| --- | --- |
| Sample rate | 48 kHz |
| Buffer size | 128 samples |
| Responsiveness mode | Balanced |
| Pitch-bend range | ±2 semitones |
| Reference pitch | A4 = 440 Hz |
| Detection range | 70–1400 Hz |
| Gate / sensitivity | Sensible defaults, refined by Calibrate |

---

## 9. Scope: v1 and later phases

### Included in v1

Monophonic guitar detection, real-time audio capture, signal conditioning, pitch detection, note tracking, velocity, Note On/Off, pitch bend (including vibrato, bends, and range-limited slides), integration with Entropy's instruments, device selection, basic sensitivity and responsiveness settings, calibration, diagnostics, persistent settings, and the offline test/benchmark suite.

### Later phases (explicitly deferred, but the architecture must not block them)

**Phase 2: guitar technique and refinement**
- Hammer-on and pull-off (legato) detection
- Palm-mute detection (mapped to velocity or a controller)
- Suppression of sympathetic string ringing
- Pitch-bend deadzone / snap-to-center option
- Alternate tunings and lower ranges (e.g., below Drop D) with a configurable detection floor
- Automatic latency compensation refinements for recording
- Harmonics and tapping

**Phase 3: broader capabilities**
- ~~Polyphonic / chord detection~~ (chord mode, [Section 12](#12-chord-mode-polyphonic-2026-09-30)); per-string detection (hexaphonic pickups)
- MPE and MIDI 2.0
- External MIDI hardware output and virtual MIDI ports
- Machine-learning pitch detection
- Tablature transcription and automatic chord recognition
- Additional platforms and audio backends (CoreAudio, ALSA/JACK)
- Plugin packaging (VST/AU/CLAP)

---

## 10. Open questions

These come from reading Entropy's public README only; they need checking against the actual source.

1. **Event path.** How do notes enter Entropy's audio engine today? The README describes the `Audio` namespace as synth playback plus one-shot notes and drum voices. Does that path support sample-accurate timestamps, pitch bend, and monophonic legato-style behavior, or does the synth need extending?
2. **Audio input.** Does Entropy's Rust core already capture audio input? If so, through which backend? If not, which Rust audio library should provide ASIO and WASAPI access?
3. **ASIO licensing.** Confirm the ASIO SDK's license is compatible with Entropy's open-source license before committing to ASIO as the primary backend. We can certainly use another backend.
4. **Module placement.** Where should the engine live (separate crate vs. module), and can it build and test without the GUI?
5. **Recording.** Does the piano roll or track system have a model for live-recorded input that can accept latency-compensated timestamps?
6. **Bend range sync.** Does Entropy's instrument expose a pitch-bend range setting the guitar feature can keep in sync?
7. **Persistence.** Which mechanism should hold settings (for addons, the README describes `addon.IO.save`/`load`)? Confirm it fits a Rust-side feature.
8. **Test corpus.** Who records it, on what gear, and under what license?

## Additional Notes

Ultimately, we do want users to be able to play VST3 instruments with their guitar, just as they can play one of our built-in synths with their guitar.

For testing, get as far as you can on your own, then I will test by hooking up my real guitar to the computer.
---

## 11. Implementation status and measured results (2026-09-20)

Written after the first implementation session. Nothing here was measured with a real guitar yet: every accuracy and latency number below is from the synthetic corpus (`src/guitar/testsig.rs`), and the capture-device check ran on a webcam microphone because no interface was attached. All numbers are `--release`; the benchmark binary prints its build profile.

**Where it lives.** Engine core `src/guitar/` (no UI, no backend, no allocation after `new`). Live layer `src/guitar_live/` (cpal input, lock-free queue, router thread, sustained built-in voice, recorder, calibration). Addon ops `src/deno/guitar_ops.rs`, JS `Entropy.Guitar`, DAW panel `examples/studio-bundle/src/apps/daw_guitar.ts` and `daw_synth_addon.ts`.

**Answers to section 10.**
1. *Event path.* The old path renders fixed-length notes, so a new sustained, bendable voice (`guitar_live/voice.rs`) was added. VST3 gained held notes and pitch bend (`Vst3Sender`, usable from any thread; the plugin registry itself is main-thread only).
2. *Audio input.* None existed (rodio is output only). cpal 0.16, the same version rodio uses, is now a direct dependency.
3. *ASIO licensing.* Not resolved. ASIO is an opt-in cargo feature (`--features asio`) that needs the Steinberg SDK at build time. Not built or tested; the default build is WASAPI.
4. *Placement.* Same crate, separate modules; `src/guitar` builds and tests without any of the rest.
5. *Recording.* The DAW's note cells have no bend field, so a take keeps pitch, velocity and timing (quantized, latency-compensated) and drops bends. The recorder itself keeps them.
6. *Bend range.* The built-in voice is kept in sync. A VST3 instrument has its own range setting, which the panel reminds you to match.
7. *Persistence.* Settings are saved inside the DAW project (`project.guitar`), tolerant of unknown or missing fields.
8. *Corpus.* Synthetic only so far. A recorded, labeled corpus is still needed.

**Design decisions the measurements forced.**
- Detector: YIN and MPM share an FFT autocorrelation front end. Both reach 100% on the clean corpus; they differ on octave-ambiguous signals (YIN 40% correct on low notes with a weak fundamental and weak odd partials, MPM 80%, before the fixes below). YIN is the default.
- Window lengths adapt to pitch (PIT-6): 6 windows from 262 to 1234 samples (spacing 1.35, window 0.8 of the longest lag). Finer spacing (1.25) was faster but dropped mid-register accuracy to 94.7%, because a period sitting at a window's largest lag leaves no room to interpolate.
- Octave errors: a shallow first dip yields to a much deeper dip at a multiple lag, and an unsure estimate waits for a window long enough to see two of its periods. On the weak-fundamental, weak-odd-partial case (`guitar_bench fixes`), neither fix gives 0% correct on low notes and 44.7% on mid; the deeper-dip check alone gives 30.0% and 60.5%; the wait alone gives 100% but 2.6 ms later at the mid median (17.3 vs 14.7 ms) and 5.3 ms later at the low p95 (36.0 vs 30.7 ms); together 100% at the lower latency.
- Level window is 15 ms, not 8. Under one period of a low string, a weak-fundamental note rippled by more than the onset threshold and re-triggered every 40 to 80 ms.
- A same-pitch re-pick is confirmed 35 ms after the onset and only if the level is still raised, so a fret-hand slap does not re-trigger a ringing note.
- A gate below the room's noise floor leaves decayed notes hanging (the level never drops under the close threshold). Calibration puts the gate above the room; both tiers test this with a control.

**Results, Balanced mode, synthetic corpus, 48 kHz, 128-sample buffers** (`cargo run --release --bin guitar_bench`):

| Register | Correct | Latency p50 / p95 (pick to Note On, engine only) | Spec target (5.1) |
| --- | --- | --- | --- |
| Low E2-G#2 | 100% | 30.7 / 32.0 ms | 40 ms met |
| Mid A2-D#4 | 100% | 14.7 / 22.7 ms | 20 ms **missed by 2.7 ms** at the bottom of the register (110 Hz needs 18 ms of signal by itself) |
| High E4-E6 | 100% | 9.3 / 9.3 ms | 15 ms met |

Fast mode: 6.7 ms high, 12 / 28 ms mid, 28 ms low, but 93.3% correct on low notes. Accurate: 13.3 / 18.7 / 34.7 ms p50. CPU (5.2): mean 0.7-0.8%, p99.9 2.2-6.5% of a 128-sample period across runs on an i5-12500 (the tail moves between runs; the live pipeline in a callback averaged 14.7 us). Allocations on the audio path: 0 in all three modes (`tests/guitar_no_alloc.rs`). 80 random recordings (28,462 events) and nine hostile inputs (NaN, infinities, DC, Nyquist, clipping, denormals) all produce well-formed event streams. Not run: the 2-hour soak, the external loopback rig, CI.

**Known limits (each has a scenario that pins it).**
- A re-pick that adds under 6 dB over a still-ringing string of the same pitch is not heard as a pick.
- Soft picks below about -37 dBFS peak play nothing until calibrated (default gate).
- Slides commit a note where they slow down, so a fast slide can split into two notes; the pitch you hear is still right because the bend carries the rest.
- Monophonic only: two strings ringing together confuse it (the take scenario mutes each string, as a player would).
- Bends are not stored in DAW patterns.

**Measured on hardware.** On this machine WASAPI shared mode ignores the requested buffer size: asked for 128, 256 and 512 frames, every callback was 160 frames at 16 kHz, a fixed 10 ms. That is the latency floor of the WASAPI path, against the 2.67 ms of the spec's reference conditions. Pick to sound in a DAW track, engine plus router plus voice plus mixer, measured 9.4 to 16.6 ms (median 14.1 ms); the capture and output devices' own buffers come on top. The panel shows the measured buffer, not the requested one.

**Live checks still to do by hand, with a guitar.** Play single notes across the neck and watch the diagnostics; hold and mute a note; vibrato and a whole-tone bend; a slide; play Vital or Massive and check the bend range; record a take; unplug the cable mid-note; run Calibrate room then Calibrate playing; note the pick-to-sound feel in each mode. Report anything that reads wrong with the note, the mode and the diagnostics line.

**By-hand report (2026-09-21).** Alex played it on a real guitar and reported that it feels real-time. No measurements, mode, device or notes were recorded, so every number above is still from the synthetic corpus and the checklist above is still open.

---

## 12. Chord mode (polyphonic), 2026-09-30

Added for chords, arpeggios left to ring, and the planned tab-learning companion app. Everything below
is from the synthetic corpus: no real guitar has been played through chord mode yet.

**Two modes, chosen per song section.** Pick mode (`polyphony: "mono"`, the default) is the engine above:
one note at a time, 7 to 36 ms, with pitch bend. Chord mode (`"poly"`) hears several strings at once but
needs about 60 to 90 ms to separate them, and sends no pitch bend (one MIDI bend cannot follow six
strings; per-string bend needs MPE, still Phase 3). A single "auto" mode would make lead lines slower
and chords less reliable, so both exist and the app switches between them. `Guitar.set({ polyphony })`
switches instantly while playing: the pipeline builds both engines when the input opens, so the switch
allocates nothing on the audio thread, releases whatever sounds, and keeps event times on the input's
clock. The teaching app knows from the tab which sections are single-note lines and which are chords,
so it can switch as the song goes.

**Where it lives.** `src/guitar/poly.rs` (the multi-pitch detector), `src/guitar/poly_engine.rs`
(spectral-flux onsets, the chord tracker, the engine), `src/guitar/tab.rs` (which string can play which
note). `GuitarEngine` is now a wrapper over `MonoEngine` and `PolyEngine`, so the live pipeline, the
replay harness and the benchmarks run either one. The router plays the built-in voice as a pool of six
voices, one per string, and the recorder keeps overlapping notes. The DAW panel has a "Play: Single notes
(bends) / Chords" switch, and a chord-mode take keeps a chord's notes on one step. `Guitar.status()`
reports every note sounding (`notesSounding`) and the most compact way to fret them (`fingering`, e.g.
`x32010`).

**How it works.**
- *Onsets* are spectral flux: the summed rise in dB, bin by bin, over the louder of the two previous
  frames with each bin allowed its neighbours' level (so vibrato is not new energy). A string picked
  while louder ones ring barely moves the overall level but lights up bins that were quiet, which the
  level-based onset of pick mode cannot hear.
- *Detection* is Klapuri-style iterative estimation and cancellation on a Hann-windowed, zero-padded FFT
  of the signal since the pick (up to 85 ms): score every candidate note by the weighted amplitudes at
  its partials (followed up a stretched series, for stiff strings), take the best, subtract its
  partials after smoothing them against their neighbours, repeat. Guitar knowledge narrows it: only
  notes the tuning reaches are candidates, a set needing two notes on one string is refused (a bipartite
  matching over six strings), and a new note more than 20 dB under the loudest is not believed.
- *Octave doublings* (E2 with E3, E4) hide entirely in the lower string's partials. Before an upper note
  is taken, the octave, twelfth and two octaves below are tried and preferred if they have partials of
  their own; after a note is found, its octave above is added if the lower note's even partials come
  out stronger than their odd neighbours predict (alone a string measured 6 to 12% over, with its
  octave 36 to 69%).
- *Tracking*: after a pick the detector reads only the signal since it, once the mode's
  `chord_wait_ms` has passed (Fast 30, Balanced 60, Accurate 70 ms). A new note must be found in several
  frames running (2, 3, 4) and within 90 ms of the strum to belong to it; a note with no pick of its own
  (a hammer-on) must hold 50 ms, next to a sounding note and within 6 dB of it. Picks within 35 ms are one
  strum. Short windows (under 62 ms) are read more sceptically and look for no doublings. A string held
  over a strum loses the benefit of the doubt until it shows it is still ringing: found 12 dB under its
  pre-strum level, or missing from the first window with nothing left at its fundamental, it was muted
  and ends at the strum. A sounding note's own partials rising 4 dB at a pick is a re-pick.

**Measured** (`cargo run --release --bin guitar_bench -- poly`; 40 chord shapes from open chords to
barre chords up the neck, power chords, triads and intervals, 3 seeds, each strummed low to high over
25 ms with its own level, seed and pluck position per string; 49 single notes E2 to E6; notes counted
by pitch):

| | Fast | Balanced | Accurate |
| --- | --- | --- | --- |
| Chord notes: precision / recall | 73 / 91% | 91 / 87% | 92 / 86% |
| Chords with every pitch class right | 56% | 88% | 88% |
| Chords exactly right, octave doublings included | 26% | 50% | 50% |
| Single notes correct, and never more than one Note On | 100% | 100% | 100% |
| First note of a chord / last correct note, p50 (from the first string) | 40 / 77 ms | 77 / 83 ms | 93 / 93 ms |
| Last correct note, p95 | 173 ms | 131 ms | 131 ms |
| Progression of 8 chords, precision; notes left hanging into the next chord | 77%; 0 | 97%; 0 | 100%; 0 |
| 30 s of room noise and 20 handling thumps | 0 notes | 0 notes | 0 notes |

Every event stream in the corpus, the 80 random recordings and the hostile inputs of
`tests/guitar_invariants.rs` is well formed; the audio path allocates nothing in any mode
(`tests/guitar_no_alloc.rs`). CPU per 128-sample callback on this cloud machine: pick mode mean 1.2%,
p99.9 3.0%; chord mode mean 9.6%, p99.9 45% (the analysis runs every 256 samples, so every other
callback carries it). That is inside the budget of section 5.2, with little headroom. Balanced is the
mode for chords. Fast gives up a fifth of its precision for 37 ms and is not recommended for chords.

**The detector alone** (`guitar_bench chords`, one window read 100 ms from the first string): precision
92%, recall 82%, every pitch class right in 86% of chords, single notes 100%. Most misses are doubled octaves
(the fifth or root repeated an octave up); most false notes sit an octave or a twelfth above a real one.

**Known limits** (each is in the benchmark or a scenario):
- Octave doublings are best effort: a note that sits entirely on another string's partials can be
  missed (in the G barre shape, D3, G3, D4 and G4 all sit on G2's partials). The chord's pitch classes and
  bass note are the reliable part.
- Two notes a semitone apart around 250 Hz (B3 with C4) merge into one peak in an 85 ms window; one is
  reported, sometimes with a ghost an octave up. Close-voiced major sevenths are affected.
- A light re-strum of a chord that is still ringing is not heard as new notes: a sounding note is only
  re-picked when its partials rise 4 dB. *To do later*, for strumming patterns in the teaching app.
- Live, the old chord can overlap the new one by up to about 200 ms on a chord change (the first string
  over strings being muted is a weak onset, and the first short windows cannot yet prove the old strings
  gone). A recording keeps the right end: at the strum.
- Let-ring arpeggios in Balanced sometimes restart a ringing string when the next is picked (Off/On,
  no wrong notes); Accurate keeps them ringing.
- Hammer-ons and pull-offs start a note only after 50 ms, and bends past a semitone become a new note
  (there is no bend in chord mode).

**The teaching app** is built: [Guitar Tabs](GUITAR_TABS.md). It does the score-informed check on the
app side, from `Guitar.status()`: the notes a step expects are looked for among the notes sounding
(a chord by its bass note and pitch classes when played leniently), and it switches pick and chord mode
as the tab goes. A check inside the detector itself (per-note salience against the expected notes,
`fundamental_db`, the string assignment) and an onset event of its own, so strumming rhythm can be
graded even when the chord does not change, are still the natural next steps.

**Pick-mode fidelity re-checked.** The synthetic benchmark reproduces section 11 exactly after the
refactor (same correct rates and latencies in all three modes), and the monophonic BDD scenarios all
pass. The checks with a real guitar listed in section 11 are still open, and now include chord mode:
open chords, a barre chord, a progression, an arpeggio left to ring, and switching modes mid-song.
