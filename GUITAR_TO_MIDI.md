# Guitar-to-MIDI for Entropy DAW

**Status:** Draft v2 · **Scope:** v1 (monophonic) · **Platform:** Windows first (Entropy is currently only tested on Windows)

> **Benchmarking reminder:** every timing, CPU, latency, and accuracy number in this document must be measured with a **release build** (`cargo run --release`, `cargo bench`, `cargo test --release`). Debug builds of DSP code are often an order of magnitude or more slower and will not meet any target here. Never report or compare numbers from a debug build.

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

> **Run everything with the release flag.** Use `cargo run --release` (for example `cargo run --bin example_daw --release`, or whichever binary hosts the feature), `cargo bench`, and `cargo test --release` for timing-sensitive tests. Results from debug builds are invalid for this section.

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
9. **CI.** Run the replay-accuracy suite in release mode on each pull request and fail on regressions beyond a set threshold.

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
- Polyphonic / chord detection and per-string detection (hexaphonic pickups)
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
