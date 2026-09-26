const { ops } = Deno.core;

globalThis.registered_npcs = [];

// ---------------------------------------------------------------------------
// Shared namespace implementations.
//
// A handful of namespaces used to be hand-copied once for the scoped API
// (returned from Entropy.Addon.register()) and once again for the top-level
// globalThis.Entropy object, differing only in how the "owning addon" name
// was resolved (or, for several of them, not differing at all). That drift
// is exactly how global Landscape.create silently lost its size/scale
// fields and global Lighting never got updateSun even though addon.d.ts
// promised it. These are now defined once and reused from both places.
// ---------------------------------------------------------------------------

// Namespaces below take no addon-name/context argument at the ops layer, so
// the scoped and global surfaces are identical - build them once and share
// the same object.
// Only the fields that were given are sent, so the engine's own defaults (gain 1, whole sample,
// no pitch shift, one-shot) apply to the rest.
function sampleParams(c) {
    const out = {};
    if (c && typeof c.gain === "number") out.gain = c.gain;
    if (c && typeof c.semitones === "number") out.semitones = c.semitones;
    if (c && typeof c.start === "number") out.start = c.start;
    if (c && typeof c.end === "number") out.end = c.end;
    if (c && typeof c.hold === "number") out.hold = c.hold;
    return out;
}

const audioAPI = {
    playSynth: (config) => {
        ops.op_audio_play_synth({
            freq: config.freq || 440.0,
            waveform: config.waveform || "sine",
            duration: config.duration || 0.5,
            cutoff: config.cutoff || 20000.0,
            gain: config.gain || 0.2
        });
    },
    playNote: (config) => {
        ops.op_audio_play_note({
            freq: config.freq || 440.0,
            waveform: config.waveform || "sine",
            duration: config.duration || 0.5,
            cutoff: config.cutoff || 20000.0,
            resonance: config.resonance || 1.0,
            gain: config.gain || 0.2,
            attack: config.attack ?? 0.005,
            decay: config.decay ?? 0.05,
            sustain: config.sustain ?? 0.85,
            release: config.release ?? 0.05,
            // Delay/reverb are always in the note's own signal graph engine-side; leaving
            // these at 0 mix reproduces the exact old (pre-FX-chain) behavior.
            delayTime: config.delayTime ?? 0.0,
            delayFeedback: config.delayFeedback ?? 0.0,
            delayMix: config.delayMix ?? 0.0,
            reverbRoomSize: config.reverbRoomSize ?? 10.0,
            reverbTime: config.reverbTime ?? 1.0,
            reverbDamping: config.reverbDamping ?? 0.5,
            reverbMix: config.reverbMix ?? 0.0
        });
    },
    playTestTone: () => {
        ops.op_audio_play_test();
    },
    // Renders a whole list of pre-scheduled note events offline to a WAV file (opens a native
    // save dialog engine-side); see `op_audio_render_pattern_wav` for the shape of `events`.
    // vst3Events: [{path, state? (base64), notes: [{startTime, duration, note, velocity?, channel?}]}] -
    // each track is rendered through its own fresh plugin instance, separate from anything already
    // loaded live on that track's bus. Result gains `vst3Warnings`: one message per track that could
    // not be rendered (bad path, state that would not load) - the rest of the export still succeeds.
    // trackBuses: [{track, gain?, effects?: [{kind, amount, pattern?, bpm?}], silences?: [[start, end]]}] -
    // an event (or VST3 track) whose `track` names one is mixed through that bus's character chain
    // first (see render_mix_to_wav); anything else goes straight to the master as before.
    // brassEvents: [{trackId, instrument?, freq, startTime, duration, breath, ...}] - brass notes
    // (see Entropy.Brass); notes on one track are played by one player, so overlaps slur.
    // matterEvents: [{trackId, kit, mix?, piece, speed, position?, striker?, startTime}] - drum-kit
    // hits (see Entropy.Matter); hits on one track are played on one kit, so the pieces ring on and
    // hear each other.
    // waterEvents: [{trackId, water?, mix?, action, pitch?, speed?, ..., startTime}] - water notes
    // (see Entropy.Water); notes on one track are played on one water instrument.
    renderPatternToWav: (events, suggestedName, sampleEvents, wavetableEvents, physModEvents, vst3Events, trackBuses, brassEvents, matterEvents, waterEvents) => {
        return ops.op_audio_render_pattern_wav(events.map(e => ({
            startTime: e.startTime || 0.0,
            freq: e.freq || 440.0,
            waveform: e.waveform || "sine",
            duration: e.duration || 0.5,
            cutoff: e.cutoff || 20000.0,
            resonance: e.resonance || 1.0,
            gain: e.gain || 0.2,
            attack: e.attack ?? 0.005,
            decay: e.decay ?? 0.05,
            sustain: e.sustain ?? 0.85,
            release: e.release ?? 0.05,
            delayTime: e.delayTime ?? 0.0,
            delayFeedback: e.delayFeedback ?? 0.0,
            delayMix: e.delayMix ?? 0.0,
            reverbRoomSize: e.reverbRoomSize ?? 10.0,
            reverbTime: e.reverbTime ?? 1.0,
            reverbDamping: e.reverbDamping ?? 0.5,
            reverbMix: e.reverbMix ?? 0.0,
            filterEnv: e.filterEnv ?? 0.0,
            filterDecay: e.filterDecay ?? 0.2,
            drive: e.drive ?? 1.0,
            track: e.track ?? null
        })), suggestedName || "pattern.wav", (sampleEvents || []).map(e => ({
            startTime: e.startTime || 0.0,
            path: e.path,
            params: sampleParams(e),
            track: e.track ?? null
        })), wavetableEvents || [], physModEvents || [], (vst3Events || []).map(t => ({
            path: t.path,
            state: t.state ?? null,
            notes: (t.notes || []).map(n => ({
                startTime: n.startTime || 0.0,
                duration: n.duration ?? 0.5,
                note: n.note,
                velocity: n.velocity ?? 100,
                channel: n.channel ?? 0
            })),
            track: t.track ?? null
        })), (trackBuses || []).map(b => ({
            track: b.track,
            gain: b.gain ?? 1.0,
            effects: (b.effects || []).map(characterConfig),
            silences: b.silences || []
        })), brassEvents || [], matterEvents || [], waterEvents || []);
    },
    // --- Persistent per-track mixing bus (see src/audio/mod.rs's TrackBus) ---
    // Creates the bus on first call for a given trackId, or updates its gain/mute/solo/effect
    // chain on every call after that - call this any time a track's own params change, not just
    // once at creation. `effectIds` are ids returned by Entropy.AudioEffect.createDelay/createReverb.
    ensureTrackBus: (trackId, config) => {
        ops.op_audio_ensure_track_bus({
            trackId,
            gain: config?.gain ?? 0.5,
            muted: config?.muted ?? false,
            solo: config?.solo ?? false,
            effectIds: config?.effectIds ?? []
        });
    },
    removeTrackBus: (trackId) => {
        ops.op_audio_remove_track_bus(trackId);
    },
    // Reads a source back without drawing anything: `source` is "master" (the whole mix) or a
    // track id. Returns {peakL, peakR, rmsL, rmsR (dBFS, -120 = silence), peakHz, peakDb,
    // centroidHz, framesWritten, windowFrames}, or null if there is no such source. This is what
    // the analyzer widgets compute from, so it lets an addon or an AI tool check what a mix
    // actually contains.
    analyze: (source, fftSize) => ops.op_audio_analyze(source || "master", fftSize || 4096),
    // --- Samples (see src/audio/samples.rs) ---
    // Decodes a file (or finds it in memory) and describes it: {ok, error?, seconds, fullSeconds,
    // truncated, sourceRate, channels, peak, waveform}. Only the first 12 s of a file are decoded.
    // Call it when a sample is assigned so the first hit does not wait on the decode.
    loadSample: (path, bins) => ops.op_audio_load_sample(path, bins || 96),
    // A drum-rack hit: plays `path` on a track bus. config: {gain, semitones, start, end, hold}.
    // Returns {ok, error?}.
    playSampleOnTrack: (trackId, path, config) => ops.op_audio_play_sample_on_track(trackId, path, sampleParams(config)),
    // Auditions a file through the shared preview bus, cutting off the previous audition.
    previewSample: (path, config) => ops.op_audio_preview_sample(path, sampleParams(config)),
    stopPreview: () => ops.op_audio_stop_preview(),
    // A wavetable note on a track's bus (see Entropy.Wavetable). config: {table, freq, velocity,
    // gain, position, lfoRate, lfoDepth, sweep, sweepTime, velToPosition, unison, detuneCents,
    // spread, cutoff, resonance, attack, decay, sustain, release, duration}. The note reads the
    // table as it is at every sample, so sculpting it changes a note that is already sounding.
    // Returns {ok, error?}.
    playWavetableOnTrack: (trackId, config) => ops.op_audio_play_wavetable_on_track({ ...config, trackId }),
    // Starts a note that sounds until wavetableNoteOff(voice). Returns {ok, voice?, error?}.
    wavetableNoteOn: (trackId, config) => ops.op_audio_wavetable_note_on({ ...config, trackId }),
    wavetableNoteOff: (voice) => ops.op_audio_wavetable_note_off(voice),
    // Moves a held note through its table (0..1 across the frames) while it sounds.
    wavetableSetPosition: (voice, position) => ops.op_audio_wavetable_set_position(voice, position),
    // A bowed-string (physmod) note on a track's bus (see Entropy.PhysMod). config: {instrument,
    // freq, velocity, gain, bowForce, bowVelocity, bowPosition, vibratoRate, vibratoDepth, damping,
    // brightness, bodySize, bodyMix, attack, release, duration}. Returns {ok, error?}.
    playPhysModOnTrack: (trackId, config) => ops.op_audio_play_physmod_on_track({ ...config, trackId }),
    // Starts a note that sounds until physModNoteOff(voice). Returns {ok, voice?, error?}.
    physModNoteOn: (trackId, config) => ops.op_audio_physmod_note_on({ ...config, trackId }),
    physModNoteOff: (voice) => ops.op_audio_physmod_note_off(voice),
    // Moves a held note's bow while it sounds. which: "force", "velocity", "position" or "vibratoDepth".
    physModSetBow: (voice, which, value) => ops.op_audio_physmod_set_bow(voice, which, value),
    // A physically modeled brass note on a track's bus (see Entropy.Brass). config: {instrument,
    // freq, velocity, gain, breath, lipTension, aperture, vibratoRate, vibratoDepth, vibratoDelay,
    // attack, release, duration, articulation ("tongued" | "legato" | "glissando"), attackSkill,
    // breathNoise, slideTime, brassiness}. Notes on one track are played by one player: a note that
    // starts before the last one ends slurs into it. Returns {ok, error?}.
    playBrassOnTrack: (trackId, config) => ops.op_audio_play_brass_on_track({ ...config, trackId }),
    // Starts a brass note that sounds until brassNoteOff(voice). Returns {ok, voice?, error?}.
    brassNoteOn: (trackId, config) => ops.op_audio_brass_note_on({ ...config, trackId }),
    brassNoteOff: (voice) => ops.op_audio_brass_note_off(voice),
    // Moves a held brass note while it sounds. which: "breath" (0..1, a breath controller's home),
    // "lipTension" (-1..1), "vibratoDepth" (cents) or "bend" (cents; on the trombone, the slide).
    brassSetControl: (voice, which, value) => ops.op_audio_brass_set_control(voice, which, value),
    // A physically modeled drum kit on a track's bus (see Entropy.Matter). kit: {kick, snare,
    // rackTom, floorTom (tunings, Hz), kickMuffling (0..1), snares (bool), snareTension (N),
    // sympathetic (bool), brushes (bool: the snare set up to be swirled all round)}. A kit takes a
    // moment to build the first time: prepareMatter builds it off
    // the audio thread and answers {ok, status: "ready" | "building" | "rebuilding"}; hits sent
    // while it is first being built are dropped. Cheap to call every frame.
    prepareMatter: (trackId, config) => ops.op_audio_matter_prepare({ ...config, trackId }),
    // Strikes a piece of the track's kit. config: {kit, mix? ({piece: level}), piece ("kick",
    // "snare", "rack-tom", "floor-tom", "crash", "ride", "splash"), speed (m/s at impact), position
    // (0 centre .. 1 edge), angle?, striker? ("stick", "shoulder", "felt", "plastic", "mallet",
    // "hard-mallet", "yarn")}. Returns {ok, played, error?}.
    // With stroke: "sweep" | "swirl" it rubs instead (not the kick): speed is the hand's (m/s),
    // pressure (N), duration (s), tool? ("brush" default, "finger", "wet-finger", "rubber", "rod",
    // "stick-tip").
    playMatterOnTrack: (trackId, config) => ops.op_audio_play_matter_on_track({ ...config, trackId }),
    // Holds a tool on a piece of the track's kit live (a drag): config {kit, piece, x, y (fractions of
    // the face's radius from its centre), pressure (N; 0 lifts it)}. Send it every frame of a drag.
    holdMatterOnTrack: (trackId, config) => ops.op_audio_hold_matter_on_track({ ...config, trackId }),
    // Stops a track's kit.
    removeMatter: (trackId, kitId) => ops.op_audio_matter_remove(trackId, kitId || trackId),
    // Water on a track's bus (see Entropy.Water). water: {rain ("lake", "window", "roof", "tent",
    // "cymbal", "drum": what its rain falls on), vessel ("bottle", "vase", "jug": what fills pour
    // into)}. It takes a moment to build (a brook and a beach are set flowing): prepareWater builds
    // it off the audio thread and answers {ok, status}; notes sent while it is first built are
    // dropped. Cheap to call every frame.
    prepareWater: (trackId, config) => ops.op_audio_water_prepare({ ...config, trackId }),
    // Plays a water note. config: {water, mix? ({drip, glass, fill, rain, brook, surf, slosh}:
    // level), action, ...}: "drip" {pitch? (Hz; the drop whose bubble rings at it), x? (-1..1)},
    // "glass" {pitch, speed (m/s), spoon? (else a soft mallet)}, "fill" {pitch (where the air column
    // rises to), duration}, "rain" {rate (mm/h), duration}, "brook" {speed (m/s), duration}, "surf"
    // {height (m), duration}, "slosh" {strength (0..1), duration}. Returns {ok, played, error?}.
    playWaterOnTrack: (trackId, config) => ops.op_audio_play_water_on_track({ ...config, trackId }),
    // Stops a track's water.
    removeWater: (trackId, waterId) => ops.op_audio_water_remove(trackId, waterId || trackId),
    // Triggers one note on an already-created track bus (see ensureTrackBus). No delay/reverb
    // fields here - FX lives on the bus itself now, shared by every note passing through it.
    playNoteOnTrack: (trackId, config) => {
        ops.op_audio_play_note_on_track({
            trackId,
            freq: config.freq || 440.0,
            waveform: config.waveform || "sine",
            duration: config.duration || 0.5,
            cutoff: config.cutoff || 20000.0,
            resonance: config.resonance || 1.0,
            gain: config.gain || 0.2,
            attack: config.attack ?? 0.005,
            decay: config.decay ?? 0.05,
            sustain: config.sustain ?? 0.85,
            release: config.release ?? 0.05,
            filterEnv: config.filterEnv ?? 0.0,
            filterDecay: config.filterDecay ?? 0.2,
            drive: config.drive ?? 1.0
        });
    }
};

// Hosts real VST3 plugins as a track's instrument (see src/audio/vst3.rs). A track's bus must exist
// first (Audio.ensureTrackBus). Every call returns {ok, error?, ...} instead of throwing: a plugin
// failing to load is an ordinary runtime condition the addon's UI should surface.
// Wavetables: a stack of single-cycle waves you sculpt as terrain (see src/audio/wavetable.rs and
// Widget.wavetable). A table is named by an id you choose (the DAW uses the track's id) and lives
// engine-side, so the editor widget, these calls and a playing note all see the same table. Calls
// return {ok, error?, ...} instead of throwing.
// Phosphor icons as characters (see entropy_gui/icons.rs). `get` returns a string to put in any
// label; a Bold or Fill icon is drawn by the same widgets with no extra option.
let _iconTable = null;
const _iconWarned = new Set();
function _loadIcons() {
    if (!_iconTable) {
        const raw = ops.op_icon_table();
        _iconTable = { styles: raw.styles, byName: new Map(raw.icons) };
    }
    return _iconTable;
}
const iconsAPI = {
    get: (name, style = "regular") => {
        const t = _loadIcons();
        const cp = t.byName.get(name);
        const add = t.styles[style];
        if (cp === undefined || add === undefined) {
            const key = name + "/" + style;
            if (!_iconWarned.has(key)) {
                _iconWarned.add(key);
                ops.op_println("Entropy.Icons: unknown icon '" + name + "' (style '" + style + "')");
            }
            return "";
        }
        return String.fromCodePoint(cp + add);
    },
    // "<icon> <text>", for a button that shows both.
    label: (name, text, style = "regular") => iconsAPI.get(name, style) + " " + text,
    has: (name) => _loadIcons().byName.has(name),
    names: () => Array.from(_loadIcons().byName.keys()),
};

const systemAPI = {
    // Starts one of this build's own example apps as a separate process and returns its pid.
    // `name` must be one of Entropy's LAUNCHABLE_EXAMPLES (src/lib.rs); anything else throws.
    // The pid is the only handle: nothing here can poll, wait on or close the child.
    launchExample: (name) => ops.op_launch_example(name),
};

const wavetableAPI = {
    // Creates the table if there is none (a stack of sines) and describes it:
    // {ok, frames, tableSize, revision, version, canUndo, canRedo}. options: {preset, frames}.
    // A preset on a table that exists replaces its contents (one undo step). Presets: sine, saw,
    // square, pwm, vowels, bell, terrain, glass.
    ensure: (id, options) => ops.op_wavetable_ensure(id, options || {}),
    presets: ["sine", "saw", "square", "pwm", "vowels", "bell", "terrain", "glass"],
    remove: (id) => ops.op_wavetable_remove(id),
    // Like ensure, plus {activity: {position, energy} | null, activeVoices}: where the sounding
    // note is reading right now.
    info: (id) => ops.op_wavetable_info(id),
    // A whole-table operation: "normalize" (arg = peak, default 0.9), "smooth" (arg = passes),
    // "invert", "reverse", "flip_frames", "randomize" (arg = seed), "undo", "redo".
    op: (id, name, arg) => ops.op_wavetable_op(id, name, arg || 0),
    // Brush dabs, the same brush the editor uses, as one undo step. Each stamp: {tool: "raise" |
    // "lower" | "smooth" | "level", frame (fractional, 0-based), phase (cycles, wraps), radius
    // (world units, default 0.16), aspect, angle, amount (0.3 is firm, 1+ saturates), target}.
    stamp: (id, stamps) => ops.op_wavetable_stamp(id, stamps),
    // Sets one frame from samples in -1..1 (any length, resampled to one cycle).
    setFrame: (id, frame, samples) => ops.op_wavetable_set_frame(id, frame, samples),
    // The whole table as a base64 string (16-bit, with a header); null if there is no such table.
    exportData: (id) => { const r = ops.op_wavetable_export(id); return r && r.ok ? r.data : null; },
    importData: (id, data) => ops.op_wavetable_import(id, data),
    // {ok, frame, harmonics: number[], peak, rms}: what a frame is made of (a unit sine's first
    // harmonic reads 1).
    harmonics: (id, frame, count) => ops.op_wavetable_harmonics(id, frame || 0, count || 32),
    // Plays one note offline and reads it back: {ok, seconds, peakDb, rmsDb, peakHz, centroidHz}.
    // config is a wavetable note (see Audio.playWavetableOnTrack) plus `table`. No audio device
    // is used, so this is how to check what a table sounds like.
    analyzeNote: (config, seconds) => ops.op_wavetable_render_analyze(config, seconds || 0)
};

// Physically-modeled bowed strings (see src/audio/physmod.rs and Widget.physModString). An
// instrument is named by an id you choose (the DAW uses the track's id); unlike a wavetable there is
// nothing to create ahead of time - a bowed string has no persistent content, only live bow state,
// so the widget, these calls and a playing note all just publish to and read the same id.
const physModAPI = {
    // {ok, id, activeVoices, activity: {bowPosition, bowForce, bowVelocity, energy} | null}.
    info: (id) => ops.op_physmod_info(id),
    remove: (id) => ops.op_physmod_remove(id),
    // The loop's current cycle shape for the visualization: {ok, version, points: number[]}.
    shape: (id) => ops.op_physmod_shape(id),
    // Plays one note offline and reads it back: {ok, seconds, peakDb, rmsDb, peakHz, centroidHz}.
    // config is a physmod note (see Audio.playPhysModOnTrack) plus `instrument`. No audio device is
    // used, so this is how to check what a bowed string sounds like.
    analyzeNote: (config, seconds) => ops.op_physmod_render_analyze(config, seconds || 0)
};

// Physically-modeled brass (see src/audio/brass and Widget.brass). A player is named by an id you
// choose (the DAW uses the track's id); the widget, these calls and a playing note publish to and
// read the same id.
const brassAPI = {
    // {ok, id, instrument, playing, partial, position, slideExtension, mouthPressurePa, breath,
    //  lipTension, lipHz, lipOpeningMm, targetHz, resonanceHz, soundingHz, waveSteepness,
    //  mouthpieceLevelPa, resonances: [{partial, hz, impedance}]}.
    info: (id) => ops.op_brass_info(id),
    remove: (id) => ops.op_brass_remove(id),
    // Plays one note offline and reads it back: {ok, seconds, rmsDb, pitchHz, centsOff, centroidHz,
    // harmonicsDb, partial, position, mouthPressurePa, waveSteepness, attackSeconds}. No audio
    // device is used, so this is how to check what a brass note sounds like.
    analyzeNote: (config, seconds) => ops.op_brass_render_analyze(config, seconds || 0)
};

// Water (see src/audio/matter/water_voice.rs): drips, glasses, fills, rain, a brook, surf, a tub,
// named by an id you choose (the DAW uses the track's id).
const waterAPI = {
    // {ok, id, active, levels: {drip, glass, ...}, drip: {lastHz, drops, bubbles}, glasses:
    //  [{pitchHz, energyJ, levelMm, heightMm}], fills: [{level, airHz, pouring}], rain: {rateMmH,
    //  drops}, brook: {speed, dissipationW}, surf: {heightM, breakers}, slosh: {strength, bores}}.
    info: (id) => ops.op_water_info(id),
    remove: (id) => ops.op_water_remove(id),
    // Plays one note offline on a fresh instrument and measures it (config as playWaterOnTrack's):
    // {ok, action, peakDb, rmsDb?, centroidHz?, strongestHz?, and what the physics made of it: drop
    // {radiusMm, speed, fallCm, regime} and bubble {radiusMm, bornHz, depthMm}, glass {radiusMm,
    // heightMm, levelMm, emptyHz, fullHz, pitchHz}, vessel {... fromMm, toMm, startHz, endHz,
    // flowMlPerS}, rain / brook / surf / slosh}. No audio device is used.
    analyze: (config, seconds) => ops.op_water_render_analyze(config, seconds || 0)
};

// Physically-modeled sounding objects: the drum kit (see src/audio/matter and Widget.matter). A kit
// is named by an id you choose (the DAW uses the track's id); the widget, these calls and a playing
// kit publish to and read the same id.
const matterAPI = {
    // {ok, id, activeKits, workers, focus, kit: {...}, pieces: [{piece, awake, energyJ, level,
    //  strikes, position, speedIn, speedOut, contactMs, peakForceN, mix, glideCents? | nonlinear?,
    //  wiresLifted?, wireLandings?, rubs?, rubbing?, rubSpeed?, rubPressureN?, rubNormalN?,
    //  rubFrictionN?, stickFraction?, releases?}]}.
    info: (id) => ops.op_matter_info(id),
    remove: (id) => ops.op_matter_remove(id),
    // Strikes one piece offline, alone, and measures it: {ok, piece, striker, speed, peakDb, rmsDb,
    // centroidHz, above4kDb (the crack: the attack's energy above 4 kHz), strongestHz, decaySeconds, contactMs, peakForceN, reboundSpeed, glideCents?,
    // wireLandings?}. No audio device is used, so this is how to check what a hit sounds like.
    analyzeHit: (config, seconds) => ops.op_matter_render_analyze(config, seconds || 0),
    // Rubs one piece (or "glass", "steel-sheet") offline, alone, and measures it. config as
    // playMatterOnTrack's with a stroke: {ok, piece, stroke, tool, speed, pressureN, duration, peakDb,
    // rmsDb, centroidHz, above4kDb, flatnessDb (near 0 for noise-like sliding, far below for a
    // squeak), stickFraction, releasesPerSecond (stick-slip), landings}.
    analyzeStroke: (config, seconds) => ops.op_matter_render_analyze(config, seconds || 0)
};

const vst3API = {
    // Installed plugins from the standard VST3 folders: {plugins: [{name, vendor, category, path,
    // isInstrument, hasGui, hasMidiInput, hasMidiOutput, ...}], skipped: string[]}. Cached for the
    // session (reading Maschine's metadata alone takes ~2s); pass refresh=true to rescan.
    scan: (refresh) => ops.op_vst3_scan(!!refresh),
    // state is base64 from a previous saveState/pollState; omit for the plugin's default patch.
    load: (trackId, config) => ops.op_vst3_load({ trackId, path: config.path, state: config.state ?? null }),
    unload: (trackId) => ops.op_vst3_unload(trackId),
    // channel is 0-15; duration is seconds until the note-off. Notes land on the next 11.6ms block.
    noteOn: (trackId, config) => ops.op_vst3_note_on({
        trackId,
        note: config.note,
        velocity: config.velocity ?? 100,
        duration: config.duration ?? 0.25,
        channel: config.channel ?? 0
    }),
    allNotesOff: (trackId) => ops.op_vst3_all_notes_off(trackId),
    openEditor: (trackId) => ops.op_vst3_open_editor(trackId),
    closeEditor: (trackId) => ops.op_vst3_close_editor(trackId),
    // Base64 state captured when the editor closed or parameters were edited; null if nothing new.
    pollState: (trackId) => ops.op_vst3_poll_state(trackId),
    // Base64 state taken right now.
    saveState: (trackId) => ops.op_vst3_save_state(trackId),
    findParameters: (trackId, query, limit) => ops.op_vst3_find_parameters(trackId, query ?? "", limit ?? 20),
    setParameter: (trackId, id, value) => ops.op_vst3_set_parameter(trackId, id, value),
    // Linear peak rendered since the previous call (a level meter), or null with no instrument.
    takePeak: (trackId) => ops.op_vst3_take_peak(trackId),
    stats: () => ops.op_vst3_stats()
};

// Guitar-to-MIDI (src/guitar_live, spec GUITAR_TO_MIDI.md): a real-time monophonic pitch tracker on an
// audio input. Notes play the built-in voice on a track's bus and/or a hosted VST3 instrument. Every
// call returns {ok, error?, ...}; a device that will not open is reported, not thrown. Nothing
// per-sample or per-buffer crosses into JS: status() is a small snapshot of what the engine decided.
const guitarAPI = {
    // {devices: [{host, name, channels, defaultSampleRate, isDefault}], hosts: string[]}
    listInputs: () => ops.op_guitar_list_inputs(),
    // config: {host?, device?, channel? (0-based), sampleRate?, bufferFrames?, mode? ("fast"|"balanced"|
    // "accurate"), sensitivity?, gateOpenDb?, gateCloseDb?, bendRange? (1-12 semitones), referencePitch?,
    // inputGainDb?, trackId? (play the built-in voice on this track), waveform?, wavetable?, vst3Track?,
    // vst3Channel?}.
    // Returns {ok, opened: {host, device, sampleRate, channels, bufferFrames, sampleFormat, notes[]}}
    // where `notes` lists anything the driver would not do as asked (rate, buffer).
    start: (config) => ops.op_guitar_start(config ?? {}),
    stop: () => ops.op_guitar_stop(),
    // Same fields as start's settings; takes effect within one input buffer.
    set: (config) => ops.op_guitar_set(config ?? {}),
    // {trackId?, waveform?, wavetable?, vst3Track?, vst3Channel?}; an empty trackId or vst3Track switches
    // that output off. waveform "wavetable" plays the table named by `wavetable.table` (a note config as
    // for Audio.wavetableNoteOn: position, unison, cutoff, envelope...; pitch and velocity come from the
    // string). The table is read live, so sculpting it is heard on a note already sounding.
    target: (target) => ops.op_guitar_target(target ?? {}),
    // Moves the wavetable voice through its table (0..1), a sounding note included.
    setPosition: (position) => ops.op_guitar_set_position(position),
    status: () => ops.op_guitar_status(),
    // playing=false listens to the room and sets the gate; playing=true listens to soft and hard notes
    // and sets the velocity range. status().calibration.finished reports the result once.
    calibrate: (playing, seconds) => ops.op_guitar_calibrate({ playing: !!playing, seconds: seconds ?? null }),
    // record("start") arms a take; record("stop") returns {ok, notes: [{note, velocity, startS, endS,
    // bends: [[seconds, cents]]}]}.
    record: (action) => ops.op_guitar_record(action),
    releaseAll: () => ops.op_guitar_release_all()
};

function characterConfig(c) {
    return {
        kind: c?.kind ?? "",
        amount: c?.amount ?? 0.0,
        pattern: c?.pattern ?? 0,
        bpm: c?.bpm ?? 120.0,
        beat: typeof c?.beat === "number" ? c.beat : null
    };
}

// A shared, reusable effect registry - create an effect once (createDelay/createReverb), then
// attach it to one or more track buses by id via Entropy.Audio.ensureTrackBus's `effectIds`
// instead of baking delay/reverb fields into every note/track config. See the doc comment above
// `StereoDelayLine` in src/audio/mod.rs for why.
const audioEffectAPI = {
    createDelay: (config) => ops.op_audio_effect_create_delay({
        time: config?.time ?? 0.3,
        feedback: config?.feedback ?? 0.35,
        mix: config?.mix ?? 0.0
    }),
    createReverb: (config) => ops.op_audio_effect_create_reverb({
        roomSize: config?.roomSize ?? 10.0,
        time: config?.time ?? 1.2,
        damping: config?.damping ?? 0.5,
        mix: config?.mix ?? 0.0
    }),
    setDelayParams: (effectId, config) => ops.op_audio_effect_set_delay(effectId, {
        time: config?.time ?? 0.3,
        feedback: config?.feedback ?? 0.35,
        mix: config?.mix ?? 0.0
    }),
    setReverbParams: (effectId, config) => ops.op_audio_effect_set_reverb(effectId, {
        roomSize: config?.roomSize ?? 10.0,
        time: config?.time ?? 1.2,
        damping: config?.damping ?? 0.5,
        mix: config?.mix ?? 0.0
    }),
    // Character effects (src/audio/character.rs): kind "pump" | "gate" | "grit" | "space" | "fader".
    // They replace the signal rather than mixing a wet copy in, so put them after delay/reverb.
    createCharacter: (config) => ops.op_audio_effect_create_character(characterConfig(config)),
    setCharacterParams: (effectId, config) => ops.op_audio_effect_set_character(effectId, characterConfig(config)),
    destroy: (effectId) => ops.op_audio_effect_destroy(effectId)
};

const textureAPI = {
    create: (width, height, data) => ops.op_texture_create(width, height, data),
    // `id`: give a storage texture a stable id and, across a hot reload, re-creating it with
    // the same id returns the existing GPU texture instead of a fresh zeroed one - this is
    // what lets a compute simulation's storage-texture state (e.g. a ripple height field)
    // survive a reload instead of resetting.
    createStorage: (width, height, format = "Rgba32Float", id = null) => ops.op_texture_create_ex({
        width,
        height,
        format,
        usage: ["Texture", "Storage", "CopyDst", "CopySrc"],
        id
    }, null),
    createEx: (config, data = null) => ops.op_texture_create_ex({ ...config, id: config.id || null }, data),
    update: (textureId, data) => ops.op_texture_update(textureId, data),
    load: (filename) => ops.op_texture_load(filename)
};

// Windows/Media-Foundation only (see src/media_player/mod.rs). `poll` writes decoded frame
// bytes straight into the texture bound via `bindTexture` on the Rust side - it does not hand
// frame bytes back to JS, so call it once per `onUpdate` tick rather than trying to read pixels
// here.
const videoAPI = {
    open: (path) => ops.op_video_open(path),
    bindTexture: (handle, textureId) => ops.op_video_bind_texture(handle, textureId),
    play: (handle) => ops.op_video_play(handle),
    pause: (handle) => ops.op_video_pause(handle),
    seek: (handle, ms) => ops.op_video_seek(handle, ms),
    setVolume: (handle, volume) => ops.op_video_set_volume(handle, volume),
    setSpeed: (handle, speed) => ops.op_video_set_speed(handle, speed),
    readSubtitles: (path) => ops.op_video_read_subtitles(path),
    close: (handle) => ops.op_video_close(handle),
    poll: (handle) => ops.op_video_poll(handle),
    export: (config) => ops.op_video_export_start(config.outputPath, config.fps, config.durationMs),
    pollExport: () => ops.op_video_export_poll()
};

// A visual node graph (Input -> Dense... -> Loss, see ml_graph_demo_addon.ts) compiled into a
// real Burn MLP and trained on a background thread (crate::ml_graph). `trainGraph` validates and
// starts synchronously (a malformed graph throws right away, no thread spun up); `poll` drains
// whatever per-epoch updates have queued since the last call - usually one or zero, since a tiny
// MLP on a tiny dataset can finish many epochs between two animation frames.
const mlAPI = {
    trainGraph: (id, config) => ops.op_ml_graph_train(
        id,
        JSON.stringify({ nodes: config.nodes, links: config.links }),
        config.dataset,
        config.epochs ?? 200,
        config.lr ?? 0.02,
        config.seed ?? 42
    ),
    poll: (id) => ops.op_ml_graph_poll(id),
    trainArchitecture: (id, config) => ops.op_ml_architecture_train(
        id, JSON.stringify(config.graph), config.task, config.epochs ?? 20,
        config.lr ?? 0.01, config.seed ?? 42
    ),
    pollArchitecture: (id) => ops.op_ml_architecture_poll(id)
};

const noiseAPI = {
    create: (config) => ops.op_noise_create({
        noiseType: config.type || "fbm",
        source: config.source || "perlin",
        seed: config.seed || 0,
        octaves: config.octaves || 6,
        frequency: config.frequency || 0.01,
        persistence: config.persistence || 0.5,
        lacunarity: config.lacunarity || 2.0
    })
};

const bufferAPI = {
    // `id`: give a buffer a stable id and, across a hot reload, re-creating it with the same
    // id (and the same size) returns the existing GPU buffer instead of a fresh zeroed one -
    // so simulation state living in it (e.g. a ripple height field) survives the reload.
    create: (config) => ops.op_buffer_create({
        size: BigInt(config.size),
        usage: config.usage || "Storage",
        id: config.id || null
    }),
    write: (bufferId, data, offset = 0) => {
        const bufferData = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
        ops.op_buffer_write(bufferId, BigInt(offset), bufferData);
    }
};

const createComputePipeline = (config) => ops.op_compute_pipeline_create({
    name: config.name || "unnamed_compute",
    shaderSource: config.shaderSource,
    bindGroups: config.bindGroups || []
});

const computeAPI = {
    createPipeline: createComputePipeline,
    dispatch: (config) => ops.op_compute_dispatch({
        pipelineId: config.pipelineId,
        groups: config.groups || [1, 1, 1],
        bindings: config.bindings || []
    })
};

// Namespaces below DO take an addon-name/context, but the only difference
// between the scoped and global surfaces is how that context is resolved:
// the scoped API resolves it from the registering addon's own metadata,
// while the global API resolves it from the current override (or "Global").
function createAddonContextualAPI(resolveTarget) {
    return {
        Landscape: {
            create: (config) => ops.op_landscape_create(resolveTarget(), {
                id: config.id || null,
                width: config.width,
                height: config.height,
                heights: config.heights || null,
                noiseId: config.noiseId || null,
                position: config.position || [0, 0, 0],
                pipelineId: config.pipelineId || null,
                render_role: config.renderRole || null,
                size: config.size,
                scale: config.scale
            }),
            updateTexture: (textureId, kind) => ops.op_landscape_update_texture(resolveTarget(), textureId, kind),
            updatePbrTexture: (textureId, kind, materialType) => ops.op_landscape_update_pbr_texture(resolveTarget(), textureId, kind, materialType),
            getHeightAt: (x, z) => ops.op_landscape_get_height(x, z)
        },
        Landscape3D: {
            create: (config) => ops.op_landscape3d_create(resolveTarget(), {
                id: config.id || null,
                vertices: config.vertices || [],
                indices: config.indices || [],
                position: config.position || [0, 0, 0],
                pipelineId: config.pipelineId || null,
                renderRole: config.renderRole || null
            })
        },
        Particles: {
            createHair: (config) => ops.op_grass_create(resolveTarget(), {
                id: config.id || null,
                gridSize: config.gridSize || 2.0,
                renderDistance: config.renderDistance || 150.0,
                windStrength: config.windStrength || 2.5,
                windSpeed: config.windSpeed || 0.3,
                bladeHeight: config.bladeHeight || 2.75,
                bladeWidth: config.bladeWidth || 0.03,
                brownianStrength: config.brownianStrength || 0.03,
                bladeDensity: config.bladeDensity || 15.0,
                landscapeSize: config.landscapeSize || 4096.0,
                landscapeHeight: config.landscapeHeight || 0.0,
                landscapeYOffset: config.landscapeYOffset || 0.0,
                baseColor: config.baseColor || [0.1, 0.4, 0.1, 1.0],
                tipColor: config.tipColor || [0.4, 0.8, 0.2, 1.0],
                pipelineId: config.pipelineId || null,
                render_role: config.renderRole || null,
                bindings: config.bindings || []
            })
        },
        Lighting: {
            createPointLight: (config) => ops.op_point_light_create(resolveTarget(), {
                id: config.id || Entropy.generateUUID(),
                position: config.position || [0, 0, 0],
                color: config.color || [1, 1, 1],
                intensity: config.intensity || 1.0,
                maxDistance: config.maxDistance || 20.0,
                falloffExponent: config.falloffExponent || 2.0,
                specularStrength: config.specularStrength === undefined ? 1.0 : config.specularStrength
            }),
            // Ids are the addon's own - createPointLight upserts by id, so re-supplying
            // the same id (e.g. on every slider onChange in a live editor) updates that
            // light in place instead of leaking a new one.
            removePointLight: (id) => ops.op_point_light_remove(resolveTarget(), id),
            updateSun: (config) => ops.op_lighting_update_sun({
                horizonColor: config.horizonColor || [0.7, 0.8, 1.0],
                zenithColor: config.zenithColor || [0.2, 0.3, 0.6],
                sunDirection: config.sunDirection || [0.0, 1.0, 0.0],
                sunColor: config.sunColor || [1.0, 0.9, 0.7],
                sunIntensity: config.sunIntensity || 5.0
            }),
            // Replaces the deferred lighting pass's point-light shading function with
            // this WGSL source (must define `fn point_light_contribution(...)` with the
            // same signature as the built-in one - see shaders/lighting.wgsl). The engine
            // recompiles the lighting pipeline behind a validation error scope, so a
            // broken shader is rejected and the previous pipeline keeps running.
            // Call with no argument (or an empty/falsy source) to reset to the default.
            setPointLightShader: (wgslSource) => ops.op_lighting_set_point_light_shader(wgslSource || ""),
            // Any field left out keeps its current value - only pass what you're changing.
            configureShadows: (config) => ops.op_shadow_configure({
                mapSize: config.mapSize,
                bias: config.bias,
                slopeScale: config.slopeScale,
                halfExtent: config.halfExtent
            })
        }
    };
}

const globalContextualAPI = createAddonContextualAPI(() => globalThis.__entropy_current_addon_context_override || "Global");

// ---------------------------------------------------------------------------
// UI widget helpers.
//
// Every widget used to hand-roll its own "generate an id from a counter
// unless one was given, then optionally remember a callback under that id"
// dance. Factored out so adding a new widget doesn't mean re-deriving it.
// ---------------------------------------------------------------------------
function nextWidgetId(windowId, label, explicitId) {
    const count = (globalThis._entropy_widget_counter || 0);
    const id = explicitId || (windowId + "_" + label + "_" + count);
    globalThis._entropy_widget_counter = count + 1;
    return id;
}

function bindListener(poolName, id, fn) {
    if (!fn) return;
    globalThis[poolName] = globalThis[poolName] || {};
    globalThis[poolName][id] = fn;
}

globalThis.Entropy = {
    Addon: {
        register: (metadata) => {
            ops.op_addon_register(metadata);

            const getAddonName = () => {
                if (globalThis.__entropy_current_addon_context_override) {
                    return globalThis.__entropy_current_addon_context_override;
                }
                if (metadata.isAtom) {
                    return "__VOID__";
                }
                return metadata.name;
            };

            const contextualAPI = createAddonContextualAPI(getAddonName);

            // Return scoped API
            return {
                onInit: (callback) => {
                    ops.op_addon_on_init(metadata.name, callback);
                },
                onAllAddonsInitialized: (callback) => {
                    ops.op_addon_on_all_addons_initialized(callback);
                },
                onUpdate: (callback) => {
                    ops.op_addon_on_update(metadata.name, (time, pos, dir) => {
                        callback(time, pos, dir);
                    });
                },
                onUpdatePlus: (addonName, callback) => {
                    ops.op_addon_on_update(addonName, (time, pos, dir) => {
                        callback(time, pos, dir);
                    });
                },
                onCleanup: (callback) => {
                    ops.op_addon_on_cleanup(metadata.name, callback);
                },
                onAction: (callback) => {
                    ops.op_addon_on_action(metadata.name, callback);
                },
                onProjectChanged: (callback) => {
                    ops.op_addon_on_project_changed(metadata.name, callback);

                    // automatically call on init hooks
                    if (globalThis.Entropy.Composer && typeof globalThis.Entropy.Composer.initCallbacks[metadata.name] === "function") {
                        try {
                            globalThis.Entropy.Composer.initCallbacks[metadata.name]();
                        } catch (e) {
                            ops.op_println("Error in Composer initCallback for " + metadata.name + ": " + e);
                        }
                    }
                },
                onAllProjectsLoaded: (callback) => {
                    ops.op_addon_on_all_projects_loaded(metadata.name, callback);
                },
                getAddon: (name) => {
                    return globalThis.__ENTROPY_ADDONS__?.getAddon(name);
                },
                getVisual: (name) => {
                    return globalThis.__ENTROPY_ADDONS__?.getVisual(name);
                },
                getVisualProvider: (name) => {
                    return globalThis.__ENTROPY_ADDONS__?.getVisualProvider(name);
                },
                registerVisual: (name, provider) => {
                    return globalThis.__ENTROPY_ADDONS__?.registerVisual(name, provider);
                },
                registerTool: (definition, callback) => {
                    ops.op_addon_register_tool(definition, callback);
                },
                setVisibility: (visible) => {
                    ops.op_addon_set_visibility(metadata.name, visible);
                },
                UI: {
                    createTab: (config) => {
                        const tabId = ops.op_ui_create_tab(metadata.name, config, config.onRender);
                        return tabId;
                    },
                    drawRect: (config) => {
                        ops.op_ui_rect_create(metadata.name, {
                            position: config.position || [0, 0],
                            size: config.size || [100, 100],
                            color: config.color || [1, 1, 1, 1],
                            strokeThickness: config.strokeThickness || 0,
                            strokeColor: config.strokeColor || [0, 0, 0, 1],
                            layer: config.layer || 200
                        });
                    },
                    drawText: (config) => {
                        ops.op_ui_text_create(metadata.name, {
                            text: config.text || "",
                            fontFamily: config.fontFamily || "Basic",
                            fontSize: config.fontSize || 24,
                            position: config.position || [0, 0],
                            dimensions: config.dimensions || [200, 50],
                            color: config.color || [1, 1, 1, 1],
                            backgroundFill: config.backgroundFill || [0, 0, 0, 0],
                            layer: config.layer || 201
                        });
                    },
                    clear: () => {
                        ops.op_ui_clear();
                    },
                    selectDialogueOption: (index) => {
                        ops.op_dialogue_select_option(index);
                    },
                    Widget: globalThis.Entropy.UI.Widget
                },
                Model: {
                    load: (config) => {
                        const id = config.id || null;
                        if (id && config.visualName) {
                            globalThis.Entropy._entityVisuals = globalThis.Entropy._entityVisuals || {};
                            globalThis.Entropy._entityVisuals[id] = config.visualName;
                        }

                        if (config.isNpc && globalThis.registered_npcs) {
                            globalThis.registered_npcs.push({ id, type: "Enemy", position: config.position });
                        }

                        ops.op_model_load(getAddonName(), {
                            id: id,
                            path: config.path,
                            visualType: config.visualType || null,
                            modelId: config.modelId || null,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            pipeline_id: config.pipelineId || null,
                            render_role: config.renderRole || null,
                            physics: config.physics || null,
                            player: config.player || null,
                            npc: config.npc || null,
                            behaviorId: config.behaviorId || null,
                            yumonId: config.yumonId || null,
                            isNpc: config.isNpc || null
                        });
                    },
                    createProcedural: (config) => {
                        if (config.type === "cube") {
                            ops.op_cube_spawn(getAddonName(), {
                                position: config.parameters?.position || [0, 0, 0],
                                scale: config.parameters?.scale || [1, 1, 1],
                                pipeline_id: config.pipelineId || null,
                                render_role: config.renderRole || null
                            });
                        }
                    },
                    createMesh: (config) => {
                        if (config.isNpc && globalThis.registered_npcs) {
                            globalThis.registered_npcs.push({ id: config.id, type: "Enemy", position: config.position });
                        }

                        ops.op_mesh_create(getAddonName(), {
                            id: config.id || null,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            vertexData: config.vertexData || [],
                            indexData: config.indexData || [],
                            pipelineId: config.pipelineId,
                            render_role: config.renderRole || null,
                            instanceCount: config.instanceCount || 1,
                            bindings: config.bindings || [],
                            behaviorId: config.behaviorId || null,
                            yumonId: config.yumonId || null,
                            isNpc: config.isNpc || null,
                            player: config.player || null
                        });
                    },
                    clearMesh: (meshId) => {
                        ops.op_mesh_clear(getAddonName(), meshId);
                    },
                    clearMeshes: () => {
                        ops.op_meshes_clear(getAddonName());
                    },
                    setBoneTransform: (config) => {
                        ops.op_model_set_bone_transform(config);
                    }
                },
                AlphaModel: {
                    load: (config) => {
                        ops.op_alpha_model_load(getAddonName(), {
                            id: config.id || Entropy.generateUUID(),
                            path: config.path,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1]
                        });
                    }
                },
                Visual: {
                    load: (config) => {
                        const id = config.id || null;
                        if (id && config.visualName) {
                            globalThis.Entropy._entityVisuals = globalThis.Entropy._entityVisuals || {};
                            globalThis.Entropy._entityVisuals[id] = config.visualName;
                        }

                        ops.op_visual_load(getAddonName(), {
                            id: id,
                            visualName: config.visualName,
                            templateId: config.meshId || config.modelPath,
                            position: config.position || [0, 0, 0],
                            rotation: config.rotation || [0, 0, 0],
                            scale: config.scale || [1, 1, 1],
                            pipelineId: config.pipelineId || null,
                            renderRole: config.renderRole || null,
                            physics: config.physics || null,
                            player: config.player || null,
                            npc: config.npc || null,
                            behaviorId: config.behaviorId || null,
                            yumonId: config.yumonId || null,
                            isNpc: config.isNpc || null
                        });
                    }
                },
                Landscape: {
                    ...contextualAPI.Landscape,
                    updateTexturePlus: (addonName, textureId, kind) => {
                        ops.op_landscape_update_texture(addonName, textureId, kind);
                    },
                    updatePbrTexturePlus: (addonName, textureId, kind, materialType) => {
                        ops.op_landscape_update_pbr_texture(addonName, textureId, kind, materialType);
                    }
                },
                Quadscape: {
                    create: (config) => {
                        ops.op_quadscape_create(getAddonName(), {
                            id: config.id || null,
                            width: config.width,
                            height: config.height,
                            heights: config.heights || null,
                            noiseId: config.noiseId || null,
                            position: config.position || [0, 0, 0],
                            pipelineId: config.pipelineId || null,
                            render_role: config.renderRole || null,
                            size: config.size,
                            scale: config.scale
                        });
                    },
                },
                Landscape3D: contextualAPI.Landscape3D,
                Collectable: {
                    create: (config) => {
                        const id = globalThis.Entropy.generateUUID();
                        // For now, we represent collectables as small models/cubes
                        ops.op_model_load(getAddonName(), {
                            id,
                            path: config.modelPath,
                            position: config.position,
                            scale: [0.5, 0.5, 0.5],
                            physics: {
                                bodyType: "fixed",
                                colliderShape: "cuboid"
                            }
                        });

                        globalThis.Entropy._collectables = globalThis.Entropy._collectables || {};
                        globalThis.Entropy._collectables[id] = config;
                        return id;
                    },
                    remove: (id) => {
                        ops.op_meshes_clear(getAddonName()); // Note: this clears ALL meshes for the addon context.
                        // In a better version we'd have clearMesh(id).
                        if (globalThis.Entropy._collectables) delete globalThis.Entropy._collectables[id];
                    }
                },
                Quest: {
                    create: (id, config) => {
                        globalThis.Entropy._quests = globalThis.Entropy._quests || {};
                        globalThis.Entropy._quests[id] = { ...config, completed: false, status: "active" };
                    },
                    updateObjective: (id, index, completed) => {
                        if (globalThis.Entropy._quests && globalThis.Entropy._quests[id]) {
                            // Logic for objective tracking
                        }
                    },
                    getStatus: (id) => {
                        return globalThis.Entropy._quests ? globalThis.Entropy._quests[id] : null;
                    }
                },
                Inventory: {
                    addItem: (playerId, itemId, quantity) => {
                        globalThis.Entropy._inventories = globalThis.Entropy._inventories || {};
                        globalThis.Entropy._inventories[playerId] = globalThis.Entropy._inventories[playerId] || {};
                        globalThis.Entropy._inventories[playerId][itemId] = (globalThis.Entropy._inventories[playerId][itemId] || 0) + quantity;
                    },
                    removeItem: (playerId, itemId, quantity) => {
                        if (globalThis.Entropy._inventories && globalThis.Entropy._inventories[playerId]) {
                            globalThis.Entropy._inventories[playerId][itemId] = Math.max(0, (globalThis.Entropy._inventories[playerId][itemId] || 0) - quantity);
                        }
                    },
                    hasItem: (playerId, itemId) => {
                        return globalThis.Entropy._inventories && globalThis.Entropy._inventories[playerId] && globalThis.Entropy._inventories[playerId][itemId] > 0;
                    }
                },
                GameState: {
                    save: (key, data) => {
                        ops.op_addon_save_data("GlobalGameState_" + key, JSON.stringify(data));
                    },
                    load: (key) => {
                        const json = ops.op_addon_load_data("GlobalGameState_" + key);
                        return json ? JSON.parse(json) : null;
                    }
                },
                Particles: contextualAPI.Particles,
                Noise: noiseAPI,
                Texture: textureAPI,
                Lighting: contextualAPI.Lighting,
                Audio: audioAPI,
                AudioEffect: audioEffectAPI,
                Vst3: vst3API,
                Wavetable: wavetableAPI,
                PhysMod: physModAPI,
                Brass: brassAPI,
                Matter: matterAPI,
                Water: waterAPI,
                Icons: iconsAPI,
                System: systemAPI,
    Guitar: guitarAPI,
                Guitar: guitarAPI,
                IO: {
                    // Pretty-printing is opt-in: large saved states (for example canvas artwork)
                    // stay compact, while human-maintained files such as CC Manager's board can
                    // request stable, readable JSON.
                    save: (data, options = {}) => {
                        ops.op_println(String("Saving Data: " + metadata.name));
                        ops.op_addon_save_data(metadata.name, JSON.stringify(data, null, options.pretty ? 2 : undefined));
                    },
                    saveImage: (filename, width, height, data) => {
                        ops.op_addon_save_image(metadata.name, filename, width, height, data);
                    },
                    listModels: () => {
                        return ops.op_io_list_models();
                    },
                    // The user's Music folder (null if the OS has none). Also allows listDir under it.
                    musicDir: () => ops.op_io_music_dir() || null,
                    // A native folder dialog; the chosen folder becomes readable by listDir. Null if cancelled.
                    pickSampleFolder: () => ops.op_io_pick_sample_folder() || null,
                    // Folders first, then audio files, directly inside `path`: {ok, error?, entries:
                    // [{name, path, isDir, size, audioCount, dirCount}]}. Read-only, and refused
                    // outside the Music folder and folders chosen with pickSampleFolder.
                    listDir: (path) => ops.op_io_list_dir(path),
                    pickAndImportModel: () => {
                        return ops.op_io_pick_and_import_model();
                    },
                    // This addon's own document store, `<dataDir>/<addon name>/...`, for apps that
                    // keep many files (a song library, version history). Paths are relative, made of
                    // [A-Za-z0-9_.-] segments; writes are atomic. Every call throws if the app has no
                    // data folder, so a caller can tell "not stored" apart from "stored nothing".
                    store: {
                        read: (path) => ops.op_addon_store_read(metadata.name, path) ?? null,
                        write: (path, text) => ops.op_addon_store_write(metadata.name, path, text),
                        list: (path = "") => ops.op_addon_store_list(metadata.name, path),
                        remove: (path) => ops.op_addon_store_remove(metadata.name, path),
                    },
                    load: () => {
                        const json = ops.op_addon_load_data(metadata.name);
                        if (!json || json === "") return null;
                        try {
                            return JSON.parse(json);
                        } catch (e) {
                            ops.op_println("Error parsing saved data: " + e);
                            return null;
                        }
                    }
                },
                Scripts: {
                    list: () => {
                        return ops.op_script_list();
                    },
                    read: (filename) => {
                        return ops.op_script_read(filename);
                    },
                    write: (filename, content) => {
                        return ops.op_script_write(filename, content);
                    }
                },
                Buffer: bufferAPI,
                Compute: computeAPI,
                Yumon: {
                    create: (name) => ops.op_yumon_create(name),
                    tick: (name) => ops.op_yumon_tick(name),
                    sleep: (name) => ops.op_yumon_sleep(name),
                    brain: {
                        create: (id, archetype) => ops.op_yumon_brain_create(id, archetype),
                        observe: (id, world, self, action, rotation, reward) => ops.op_yumon_brain_observe(id, world, self, action, rotation, reward),
                        infer: (id) => ops.op_yumon_brain_infer(id),
                        testInfer: (id, context) => ops.op_yumon_brain_test_infer(id, context),
                        sleep: (id, epochs) => ops.op_yumon_brain_sleep(id, epochs),
                        save: (id) => ops.op_yumon_brain_save(id),
                        load: (archetype) => ops.op_yumon_brain_load(archetype),
                        getState: (id) => ops.op_yumon_brain_get_state(id),
                        augment: (id) => ops.op_yumon_brain_augment(id),
                    }
                }
            };
        },
        setVisibility: (addonName, visible) => {
            ops.op_addon_set_visibility(addonName, visible);
        }
    },
    AddonAtom: {
        register: (metadata) => {
            return globalThis.Entropy.Addon.register({ ...metadata, isAtom: true });
        }
    },
    Behavior: {
        register: (id, hooks) => {
            ops.op_behavior_register(
                id,
                hooks.onUpdate || null,
                hooks.onInteract || null,
                hooks.onAttack || null
            );
        }
    },
    Entity: {
        applyImpulse: (id, impulse) => {
            // ops.op_println("Applying impulse");
            ops.op_entity_apply_impulse(id, impulse);
        },
        setVelocity: (id, velocity) => {
            // ops.op_println("Applying velocity");
            ops.op_entity_set_velocity(id, velocity);
        },
        setXZVelocity: (id, velocity) => {
            ops.op_entity_set_xz_velocity(id, velocity);
        },
        setRotation: (id, rotation) => {
            ops.op_entity_set_rotation(id, rotation);
        },
        playAnimation: (id, animName) => {
            globalThis.Entropy._entityAnimations = globalThis.Entropy._entityAnimations || {};
            globalThis.Entropy._entityAnimations[id] = animName;

            // Trigger Visual Provider if applicable
            const visualName = globalThis.Entropy._entityVisuals?.[id];
            if (visualName && globalThis.__ENTROPY_ADDONS__) {
                const provider = globalThis.__ENTROPY_ADDONS__.getVisualProvider(visualName);
                if (provider && provider.onAnimate) {
                    provider.onAnimate(id, animName);
                }
            }

            ops.op_entity_play_animation(id, animName);
        },
        getAnimation: (id) => {
            return globalThis.Entropy._entityAnimations?.[id] || "Idle";
        },
        setStats: (id, stats) => {
            ops.op_entity_set_stats(id, stats);
        }
    },
    UI: {
        setWindowVisible: (id, visible) => ops.op_ui_set_window_visible(id, visible),
        createWindow: (config) => {
            // addon.d.ts documents `title?`, `width?`, `height?` as flat, optional fields, but
            // the op wants { title, resizable, defaultSize: { width, height } } - translate here
            // so addons that only pass a title (like most examples) don't have to know that.
            // `x`/`y` are optional too - unset centers the window on screen, same as before this
            // existed.
            const windowId = ops.op_ui_create_window({
                title: config.title || "",
                resizable: config.resizable !== undefined ? config.resizable : true,
                defaultSize: { width: config.width || 400, height: config.height || 300 },
                defaultPos: (config.x !== undefined && config.y !== undefined) ? [config.x, config.y] : null,
                glass: config.glass === true,
                decorations: config.decorations !== false
            }, config.onRender);
            return windowId;
        },
        createTab: (config) => {
            const tabId = ops.op_ui_create_tab("Global", config, config.onRender);
            return tabId;
        },
        miniMap: (windowId, config) => {
            globalThis.Entropy.UI.Widget.miniMap(windowId, config);
        },
        // Every field is optional - an addon only names the colors/knobs it wants to change,
        // and anything omitted falls back to the "Slate" default (see `style_from_theme` in
        // src/entropy_gui/style.rs). Colors are [r, g, b, a] in 0..1, same convention as
        // Widget.colorInput. Applies live and persists until the next setTheme call.
        setTheme: (theme) => {
            ops.op_ui_set_theme(theme || {});
        },
        Widget: {
            label: (windowId, config) => {
                const text = typeof config === 'string' ? config : (config?.text || "");
                const bold = typeof config === 'object' ? (config?.bold || false) : false;
                const fontSize = typeof config === 'object' ? (config?.fontSize || 0) : 0;
                const alpha = typeof config === 'object' && config?.alpha !== undefined ? config.alpha : 1;
                ops.op_ui_widget_label(windowId, text, bold, fontSize, alpha);
            },
            button: (windowId, config) => {
                const text = typeof config === 'string' ? config : (config?.text || "");
                const id = nextWidgetId(windowId, text, config?.id);
                const fontSize = typeof config === 'object' ? (config?.fontSize || 0) : 0;
                const alpha = typeof config === 'object' && config?.alpha !== undefined ? config.alpha : 1;
                const frame = typeof config === 'object' && config?.frame !== undefined ? config.frame : true;

                ops.op_ui_widget_button(windowId, text, id, fontSize, alpha, frame);
                bindListener('_entropy_event_listeners', id, config?.onClick);
            },
            colorInput: (windowId, config) => {
                const label = config?.label || "";
                const color = config?.color || [1, 1, 1, 1];
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_color_input(windowId, label, color, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            slider: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || 0;
                const min = config?.min || 0;
                const max = config?.max || 100;
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_slider(windowId, label, value, min, max, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            knob: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || 0;
                const min = config?.min || 0;
                const max = config?.max || 100;
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_knob(windowId, label, value, min, max, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            numericInput: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || 0;
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_numeric_input(windowId, label, value, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            dropdown: (windowId, config) => {
                const label = config?.label || "";
                const options = config?.options || [];
                const selectedIndex = BigInt(config?.selectedIndex || 0);
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_dropdown(windowId, label, options, selectedIndex, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            checkbox: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || false;
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_checkbox(windowId, label, value, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            codeEditor: (windowId, config) => {
                const label = config?.label || "";
                const content = config?.content || "";
                const language = config?.language || "javascript";
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_code_editor(windowId, label, content, language, id);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            miniMap: (windowId, config) => {
                const landscapeId = config?.landscapeId || "Global";
                const brushSize = config?.brushSize || 5.0;
                const markers = config?.markers || [];
                const polylines = config?.polylines || [];
                const id = nextWidgetId(windowId, "minimap", config?.id);

                ops.op_ui_widget_mini_map(windowId, landscapeId, brushSize, markers, polylines, id);
                bindListener('_entropy_event_listeners', id, config?.onDraw);
                bindListener('_entropy_hover_listeners', id, config?.onHover);
                bindListener('_entropy_click_listeners', id, config?.onClick);
            },
            horizontal: (windowId, render) => {
                ops.op_ui_widget_start_horizontal(windowId);
                render(windowId);
                ops.op_ui_widget_end_horizontal(windowId);
            },
            // A vertical stack, same shape as horizontal() - mainly useful inside a horizontal()
            // row, so each cell can itself hold several stacked widgets (a "column").
            vertical: (windowId, render) => {
                ops.op_ui_widget_start_vertical(windowId);
                render(windowId);
                ops.op_ui_widget_end_vertical(windowId);
            },
            // Like vertical(), but draws a visible frame/border around its contents - use for a
            // "channel strip" or boxed section instead of an unbroken flat stack of widgets.
            group: (windowId, render) => {
                ops.op_ui_widget_start_group(windowId);
                render(windowId);
                ops.op_ui_widget_end_group(windowId);
            },
            pianoRoll: (windowId, config) => {
                const rows = config?.rows || 12;
                const steps = config?.steps || 16;
                const stepsPerBeat = config?.stepsPerBeat || 4;
                const rowLabels = config?.rowLabels || null;
                const cells = config?.cells || [];
                const playhead = config?.playhead ?? -1;
                const id = nextWidgetId(windowId, "pianoroll", config?.id);

                ops.op_ui_widget_piano_roll(windowId, rows, steps, stepsPerBeat, rowLabels, cells, playhead, id);

                if (config?.onNoteDown || config?.onNoteDrag || config?.onNoteUp) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        const [row, step] = parts[2].split(',').map(Number);
                        if (type === "PIANOROLL_DOWN" && config.onNoteDown) config.onNoteDown(row, step);
                        else if (type === "PIANOROLL_DRAG" && config.onNoteDrag) config.onNoteDrag(row, step);
                        else if (type === "PIANOROLL_UP" && config.onNoteUp) config.onNoteUp(row, step);
                    });
                }
            },
            keyframeTimeline: (windowId, config) => {
                const durationMs = config?.durationMs || 1000;
                const playheadMs = config?.playheadMs ?? 0;
                const rows = config?.rows || [];
                const selected = config?.selected ? [config.selected.row, config.selected.keyframe] : null;
                const id = nextWidgetId(windowId, "keyframeTimeline", config?.id);

                ops.op_ui_widget_keyframe_timeline(windowId, durationMs, playheadMs, rows, selected, id);

                if (config?.onSeek || config?.onKeyframeMoved || config?.onKeyframeSelected || config?.onKeyframeAdd || config?.onKeyframeDelete || config?.onRowClicked || config?.onBackgroundClicked) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "KFTL_SEEK" && config.onSeek) config.onSeek(parseInt(parts[2], 10));
                        else if (type === "KFTL_KF_MOVED" && config.onKeyframeMoved) config.onKeyframeMoved(parts[2], parts[3], parseInt(parts[4], 10));
                        else if (type === "KFTL_KF_SELECTED" && config.onKeyframeSelected) config.onKeyframeSelected(parts[2], parts[3]);
                        else if (type === "KFTL_KF_ADD" && config.onKeyframeAdd) config.onKeyframeAdd(parts[2], parseInt(parts[3], 10));
                        else if (type === "KFTL_KF_DELETE" && config.onKeyframeDelete) config.onKeyframeDelete(parts[2], parts[3]);
                        else if (type === "KFTL_ROW_CLICKED" && config.onRowClicked) config.onRowClicked(parts[2]);
                        else if (type === "KFTL_BG_CLICKED" && config.onBackgroundClicked) config.onBackgroundClicked();
                    });
                }
            },
            tracks: (windowId, config) => {
                const durationMs = config?.durationMs || 1000;
                const playheadMs = config?.playheadMs ?? 0;
                const tracks = config?.tracks || [];
                const selected = config?.selected ? [config.selected.track, config.selected.clip] : null;
                const id = nextWidgetId(windowId, "tracks", config?.id);

                ops.op_ui_widget_tracks(windowId, durationMs, playheadMs, tracks, selected, id, config?.options ?? null);

                if (config?.onSeek || config?.onClipMoved || config?.onClipResized || config?.onClipSelected || config?.onClipDelete || config?.onClipDuplicate || config?.onClipCreate || config?.onTrackClicked || config?.onTrackMute || config?.onTrackSolo || config?.onBackgroundClicked) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "TRACKS_SEEK" && config.onSeek) config.onSeek(parseInt(parts[2], 10));
                        else if (type === "TRACKS_CLIP_MOVED" && config.onClipMoved) config.onClipMoved(parts[2], parts[3], parseInt(parts[4], 10));
                        else if (type === "TRACKS_CLIP_RESIZED" && config.onClipResized) config.onClipResized(parts[2], parts[3], parseInt(parts[4], 10), parseInt(parts[5], 10));
                        else if (type === "TRACKS_CLIP_SELECTED" && config.onClipSelected) config.onClipSelected(parts[2], parts[3]);
                        else if (type === "TRACKS_CLIP_DELETE" && config.onClipDelete) config.onClipDelete(parts[2], parts[3]);
                        else if (type === "TRACKS_CLIP_DUPLICATE" && config.onClipDuplicate) config.onClipDuplicate(parts[2], parts[3]);
                        else if (type === "TRACKS_CLIP_CREATE" && config.onClipCreate) config.onClipCreate(parts[2], parseInt(parts[3], 10), parseInt(parts[4], 10));
                        else if (type === "TRACKS_TRACK_MUTE" && config.onTrackMute) config.onTrackMute(parts[2]);
                        else if (type === "TRACKS_TRACK_SOLO" && config.onTrackSolo) config.onTrackSolo(parts[2]);
                        else if (type === "TRACKS_TRACK_CLICKED" && config.onTrackClicked) config.onTrackClicked(parts[2]);
                        else if (type === "TRACKS_BG_CLICKED" && config.onBackgroundClicked) config.onBackgroundClicked();
                    });
                }
            },
            kanban: (windowId, config) => {
                const columns = config?.columns || [];
                const selected = config?.selected ? [config.selected.column, config.selected.card] : null;
                const id = nextWidgetId(windowId, "kanban", config?.id);

                ops.op_ui_widget_kanban(windowId, columns, selected, id);

                if (config?.onCardMoved || config?.onCardSelected || config?.onCardDelete || config?.onAddCard || config?.onColumnClicked || config?.onBackgroundClicked) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "KANBAN_CARD_MOVED" && config.onCardMoved) config.onCardMoved(parts[2], parts[3], parts[4], parseInt(parts[5], 10));
                        else if (type === "KANBAN_CARD_SELECTED" && config.onCardSelected) config.onCardSelected(parts[2], parts[3]);
                        else if (type === "KANBAN_CARD_DELETE" && config.onCardDelete) config.onCardDelete(parts[2], parts[3]);
                        else if (type === "KANBAN_ADD_CARD" && config.onAddCard) config.onAddCard(parts[2]);
                        else if (type === "KANBAN_COLUMN_CLICKED" && config.onColumnClicked) config.onColumnClicked(parts[2]);
                        else if (type === "KANBAN_BG_CLICKED" && config.onBackgroundClicked) config.onBackgroundClicked();
                    });
                }
            },
            // A spreadsheet grid: lettered column headers, numbered rows, one selected cell with
            // arrow-key/Tab/Enter navigation, and an optional colored border per cell. Editing is
            // deliberately not built in here - drive a cell's content through your own textInput
            // bound to `selected` (like a real formula bar), and rebuild `cells` from your own
            // model each frame; this widget only ever draws the text it is handed.
            sheetGrid: (windowId, config) => {
                const cells = config?.cells || [];
                const selected = config?.selected ? [config.selected.row, config.selected.col] : null;
                const editing = config?.editing ? [config.editing.row, config.editing.col, config.editing.value ?? ""] : null;
                const id = nextWidgetId(windowId, "sheet", config?.id);

                ops.op_ui_widget_sheet_grid(windowId, cells, selected, editing, config?.options ?? {}, id);

                if (config?.onCellSelected || config?.onCellClear || config?.onEditStarted || config?.onEditChanged || config?.onEditCommitted || config?.onEditCancelled || config?.onInsertRow || config?.onDeleteRow || config?.onInsertColumn || config?.onDeleteColumn) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        // SHEET_EDIT_STARTED/CHANGED carry free-typed text as their last field,
                        // which may itself contain "|" - rejoin everything past the fixed fields
                        // instead of trusting parts[4] alone.
                        if (type === "SHEET_CELL_SELECTED" && config.onCellSelected) config.onCellSelected(parseInt(parts[2], 10), parseInt(parts[3], 10));
                        else if (type === "SHEET_CELL_CLEAR" && config.onCellClear) config.onCellClear(parseInt(parts[2], 10), parseInt(parts[3], 10));
                        else if (type === "SHEET_EDIT_STARTED" && config.onEditStarted) config.onEditStarted(parseInt(parts[2], 10), parseInt(parts[3], 10), parts.slice(4).join("|"));
                        else if (type === "SHEET_EDIT_CHANGED" && config.onEditChanged) config.onEditChanged(parseInt(parts[2], 10), parseInt(parts[3], 10), parts.slice(4).join("|"));
                        else if (type === "SHEET_EDIT_COMMITTED" && config.onEditCommitted) config.onEditCommitted(parseInt(parts[2], 10), parseInt(parts[3], 10));
                        else if (type === "SHEET_EDIT_CANCELLED" && config.onEditCancelled) config.onEditCancelled(parseInt(parts[2], 10), parseInt(parts[3], 10));
                        else if (type === "SHEET_INSERT_ROW" && config.onInsertRow) config.onInsertRow(parseInt(parts[2], 10));
                        else if (type === "SHEET_DELETE_ROW" && config.onDeleteRow) config.onDeleteRow(parseInt(parts[2], 10));
                        else if (type === "SHEET_INSERT_COL" && config.onInsertColumn) config.onInsertColumn(parseInt(parts[2], 10));
                        else if (type === "SHEET_DELETE_COL" && config.onDeleteColumn) config.onDeleteColumn(parseInt(parts[2], 10));
                    });
                }
            },
            // A Figma/VS Code-style outliner: one flat, already depth-computed `nodes` array,
            // rendered as real indented rows with a native disclosure triangle and a full-row
            // selection highlight - replaces a hand-stacked list of button()/checkbox() calls
            // (with indentation faked as literal leading spaces) that a tree like Canvas
            // Surfaces' "Groups & animation" hierarchy used before this widget existed.
            // Signal analysis widgets. `source` is "master" (the whole mix) or a track id; the audio
            // is read Rust-side when the widget is drawn, so no samples cross into JS.
            oscilloscope: (windowId, config) => {
                const id = nextWidgetId(windowId, "scope", config?.id);
                ops.op_ui_widget_oscilloscope(windowId, { source: "master", ...(config || {}) }, id);
            },
            spectrum: (windowId, config) => {
                const id = nextWidgetId(windowId, "spectrum", config?.id);
                ops.op_ui_widget_spectrum(windowId, { source: "master", ...(config || {}) }, id);
            },
            levelMeter: (windowId, config) => {
                const id = nextWidgetId(windowId, "levelmeter", config?.id);
                ops.op_ui_widget_level_meter(windowId, { source: "master", ...(config || {}) }, id);
            },
            // A wavetable as sculptable terrain, with a single-cycle pen strip, the harmonics of the
            // selected frame and a keyboard (see Entropy.Wavetable). The table lives engine-side and
            // is edited in place, so nothing crosses into JS per frame. config: {table, tool, radius,
            // strength, frame, height, width, keyboard, firstKey, octaves, held}; the caller owns
            // `tool` and `frame` and hears about changes through the callbacks: onEdit (a stroke
            // ended or undo/redo ran: save now), onStrokeStart/onStrokeEnd, onFrame(index),
            // onTool(name), onKeyDown(midi, velocity), onKeyUp(midi).
            wavetable: (windowId, config) => {
                const id = nextWidgetId(windowId, "wavetable", config?.id);
                ops.op_ui_widget_wavetable(windowId, { ...(config || {}) }, id);

                if (config) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "WAVETABLE_EDITED" && config.onEdit) config.onEdit();
                        else if (type === "WAVETABLE_STROKE_BEGAN" && config.onStrokeStart) config.onStrokeStart();
                        else if (type === "WAVETABLE_STROKE_ENDED" && config.onStrokeEnd) config.onStrokeEnd();
                        else if (type === "WAVETABLE_FRAME" && config.onFrame) config.onFrame(parseInt(parts[2], 10));
                        else if (type === "WAVETABLE_TOOL" && config.onTool) config.onTool(parts[2]);
                        else if (type === "WAVETABLE_KEY_DOWN" && config.onKeyDown) config.onKeyDown(parseInt(parts[2], 10), parseFloat(parts[3]));
                        else if (type === "WAVETABLE_KEY_UP" && config.onKeyUp) config.onKeyUp(parseInt(parts[2], 10));
                    });
                }
            },
            // A physically modeled bowed-string instrument, drawn the same neon way as Widget.wavetable
            // (see Entropy.PhysMod and entropy_gui::PhysModView). Nothing crosses into JS per frame:
            // the widget reads the engine's PhysModShared directly. config: {instrument, height,
            // width, bowPosition, bowForce, bodySize, activeString, keyboard, firstKey, octaves,
            // held, physicsView, exaggeration}; the caller owns every field and hears about changes
            // through the callbacks: onBowDrag(position, force), onKeyDown(midi, velocity),
            // onKeyUp(midi), onPhysicsView(on).
            physModString: (windowId, config) => {
                const id = nextWidgetId(windowId, "physmod", config?.id);
                ops.op_ui_widget_physmod(windowId, { ...(config || {}) }, id);

                if (config) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "PHYSMOD_BOW_DRAG" && config.onBowDrag) config.onBowDrag(parseFloat(parts[2]), parseFloat(parts[3]));
                        else if (type === "PHYSMOD_KEY_DOWN" && config.onKeyDown) config.onKeyDown(parseInt(parts[2], 10), parseFloat(parts[3]));
                        else if (type === "PHYSMOD_KEY_UP" && config.onKeyUp) config.onKeyUp(parseInt(parts[2], 10));
                        else if (type === "PHYSMOD_PHYSICS_VIEW" && config.onPhysicsView) config.onPhysicsView(parts[2] === "1");
                    });
                }
            },
            // A physically modeled brass instrument, drawn from its bore in the same neon way (see
            // Entropy.Brass and entropy_gui::BrassView). The widget reads the engine's BrassShared
            // directly. config: {instrument, height, width, breath, lipTension, keyboard, firstKey,
            // octaves, held, physicsView, exaggeration}; the caller owns every field and hears about
            // changes through the callbacks: onKeyDown(midi, velocity), onKeyUp(midi),
            // onSlideDrag(position 1..7), onPlayDrag(breath, lipTension), onPhysicsView(on).
            brass: (windowId, config) => {
                const id = nextWidgetId(windowId, "brass", config?.id);
                ops.op_ui_widget_brass(windowId, { ...(config || {}) }, id);

                if (config) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "BRASS_KEY_DOWN" && config.onKeyDown) config.onKeyDown(parseInt(parts[2], 10), parseFloat(parts[3]));
                        else if (type === "BRASS_KEY_UP" && config.onKeyUp) config.onKeyUp(parseInt(parts[2], 10));
                        else if (type === "BRASS_SLIDE_DRAG" && config.onSlideDrag) config.onSlideDrag(parseFloat(parts[2]));
                        else if (type === "BRASS_PLAY_DRAG" && config.onPlayDrag) config.onPlayDrag(parseFloat(parts[2]), parseFloat(parts[3]));
                        else if (type === "BRASS_PHYSICS_VIEW" && config.onPhysicsView) config.onPhysicsView(parts[2] === "1");
                    });
                }
            },
            // A physically modeled drum kit, drawn from the modes it rings with in the same neon way
            // (see Entropy.Matter and entropy_gui::MatterView). The widget reads the engine's
            // MatterShared directly. config: {kit, height, width, pads, physicsView, exaggeration,
            // status}; the caller hears about clicks through the callbacks: onStrike(piece,
            // position, angle, velocity) (a head or cymbal clicked where it was clicked),
            // onPad(piece, velocity), onPhysicsView(on).
            matter: (windowId, config) => {
                const id = nextWidgetId(windowId, "matter", config?.id);
                ops.op_ui_widget_matter(windowId, { ...(config || {}) }, id);

                if (config) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "MATTER_STRIKE" && config.onStrike) config.onStrike(parts[2], parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5]));
                        else if (type === "MATTER_PAD" && config.onPad) config.onPad(parts[2], parseFloat(parts[3]));
                        else if (type === "MATTER_RUB" && config.onRub) config.onRub(parts[2], parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5]));
                        else if (type === "MATTER_PHYSICS_VIEW" && config.onPhysicsView) config.onPhysicsView(parts[2] === "1");
                    });
                }
            },
            // A drum-machine pad bank: rounded pads with a waveform thumbnail, colour accent, selection
            // ring and a caller-driven glow. Events go through the same id-keyed listener path as
            // treeView.
            padGrid: (windowId, config) => {
                const id = nextWidgetId(windowId, "padgrid", config?.id);
                ops.op_ui_widget_pad_grid(windowId, { pads: [], ...(config || {}) }, id);

                if (config?.onPadClick || config?.onPadClear || config?.onAdd) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "PADGRID_CLICKED" && config.onPadClick) config.onPadClick(parts[2]);
                        else if (type === "PADGRID_CLEARED" && config.onPadClear) config.onPadClear(parts[2]);
                        else if (type === "PADGRID_ADD" && config.onAdd) config.onAdd();
                    });
                }
            },
            treeView: (windowId, config) => {
                const nodes = config?.nodes || [];
                const id = nextWidgetId(windowId, "treeview", config?.id);

                ops.op_ui_widget_tree_view(windowId, nodes, id, config?.maxHeight || 0, config?.width || 0);

                if (config?.onSelect || config?.onToggleExpand || config?.onMark) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        // The node id is the rest of the string, so an id with a "|" in it (a file path on a
                        // platform that allows one) still arrives whole.
                        if (type === "TREEVIEW_SELECTED" && config.onSelect) config.onSelect(parts.slice(2).join("|"));
                        else if (type === "TREEVIEW_TOGGLE" && config.onToggleExpand) config.onToggleExpand(parts.slice(2).join("|"));
                        else if (type === "TREEVIEW_MARKED" && config.onMark) config.onMark(parts[2], parts[3] === "true");
                    });
                }
            },
            // A non-fullscreen tab strip inside a window. The addon owns which tab is selected: pass
            // it as `selected`, update it in `onSelect`, and draw only that tab's widgets after it.
            tabBar: (windowId, config) => {
                const id = nextWidgetId(windowId, "tabbar", config?.id);
                ops.op_ui_widget_tab_bar(windowId, config?.tabs || [], config?.selected || "", id);

                if (config?.onSelect) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        if (parts[0] === "TABBAR_SELECTED") config.onSelect(parts.slice(2).join("|"));
                    });
                }
            },
            snarl: (windowId, config) => {
                const graph = config?.graph || { nodes: [], connections: [] };
                const id = nextWidgetId(windowId, "snarl", config?.id);

                ops.op_ui_widget_snarl(windowId, graph, id, config?.height ?? null);

                if (config?.onConnect || config?.onDisconnect || config?.onNodeMoved || config?.onNodeSelected) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        const type = parts[0];
                        if (type === "SNARL_NODE_SELECTED" && config.onNodeSelected) {
                            config.onNodeSelected(parts[2]);
                        } else if (type === "SNARL_CONNECT" && config.onConnect) {
                            config.onConnect(parts.slice(2));
                        } else if (type === "SNARL_DISCONNECT" && config.onDisconnect) {
                            config.onDisconnect(parts.slice(2));
                        } else if (type === "SNARL_NODE_MOVED" && config.onNodeMoved) {
                            config.onNodeMoved(parts[2], [parseFloat(parts[3].split(',')[0]), parseFloat(parts[3].split(',')[1])]);
                        }
                    });
                }
            },
            // `id` is optional and, when omitted, falls back to the same frame-counter-derived
            // auto id every other unlabeled widget uses - stable only as long as nothing earlier
            // in the same render pass conditionally adds/removes a widget call. Pass an explicit
            // id for any header a script (BDD or otherwise) needs to open/close by name.
            // `defaultOpen` only matters the first time this id is ever rendered in a session -
            // after that, the real open/closed state lives in the widget's own click-driven
            // memory (entropy_gui::Context, keyed by id), same as every other collapsingHeader.
            collapsingHeader: (windowId, title, render, id, defaultOpen) => {
                const widgetId = nextWidgetId(windowId, "collapsing", id || null);
                ops.op_ui_widget_collapsing_header(windowId, title, widgetId, defaultOpen ?? false);
                render(windowId);
                ops.op_ui_widget_end_collapsing_header(windowId);
            },
            separator: (windowId) => {
                ops.op_ui_widget_separator(windowId);
            },
            hyperlink: (windowId, config) => {
                const text = typeof config === 'string' ? config : (config?.text || "");
                const url = typeof config === 'object' ? (config?.url || "#") : "#";
                const id = nextWidgetId(windowId, text, config?.id);

                ops.op_ui_widget_hyperlink(windowId, text, url, id);
            },
            textInput: (windowId, config) => {
                const label = config?.label || "";
                const value = config?.value || "";
                const id = nextWidgetId(windowId, label, config?.id);

                ops.op_ui_widget_text_input(windowId, label, value, id, config?.width ?? 0);
                bindListener('_entropy_event_listeners', id, config?.onChange);
            },
            // A true multi-page document editor (see `entropy_gui::widgets_doc_editor`). Only
            // page geometry crosses this call - the document itself lives Rust-side, keyed by
            // `id`, so it is NOT round-tripped through JSON every frame like `tracks`/
            // `keyframeTimeline`'s data is. This widget draws only the page canvas - Bold/
            // Italic/font/size/color/pagination controls are the addon's own toolbar, built out
            // of ordinary widgets and wired to the `docEditorToggleBold`/etc. functions below.
            // `onStats` fires every frame with word/char/page counts and the current active
            // format, so the addon's own buttons can reflect current state.
            docEditor: (windowId, config) => {
                const pageWidth = config?.pageWidth ?? 816;
                const pageHeight = config?.pageHeight ?? 1056;
                const margin = config?.margin ?? 96;
                const id = nextWidgetId(windowId, "docEditor", config?.id);

                ops.op_ui_widget_doc_editor(windowId, pageWidth, pageHeight, margin, id);

                if (config?.onStats) {
                    bindListener('_entropy_event_listeners', id, (eventData) => {
                        const parts = eventData.split('|');
                        if (parts[0] === "DOCEDIT_STATS") {
                            const [cr, cg, cb, ca] = parts[9].split(',').map(Number);
                            config.onStats({
                                words: parseInt(parts[2], 10),
                                chars: parseInt(parts[3], 10),
                                pages: parseInt(parts[4], 10),
                                paginated: parts[5] === "true",
                                bold: parts[6] === "true",
                                italic: parts[7] === "true",
                                fontSize: parseFloat(parts[8]),
                                color: [cr, cg, cb, ca],
                                fontFamily: parts[10],
                            });
                        }
                    });
                }
            },
            // Imperative commands a caller's own toolbar sends into a `DocEditor` by its widget
            // id (the same `id` passed to/returned by `docEditor()` above, or the auto-generated
            // one if none was given) - applied once, in order, at the start of that widget's
            // next `show()`. Each is a fire-and-forget op call, not a per-frame widget.
            docEditorToggleBold: (id) => ops.op_doc_editor_toggle_bold(id),
            docEditorToggleItalic: (id) => ops.op_doc_editor_toggle_italic(id),
            docEditorSetFontFamily: (id, family) => ops.op_doc_editor_set_font_family(id, family),
            docEditorSetFontSize: (id, size) => ops.op_doc_editor_set_font_size(id, size),
            docEditorSetColor: (id, color) => ops.op_doc_editor_set_color(id, color),
            docEditorSetPaginated: (id, paginated) => ops.op_doc_editor_set_paginated(id, paginated),
            docEditorLoadSample: (id, count) => ops.op_doc_editor_load_sample(id, count ?? 300),
            // Every font family name the engine's ~60-font catalog offers, for a toolbar's font
            // dropdown - static, cheap to call once (e.g. from `addon.onInit`), no reason to
            // call it every frame.
            docEditorFontNames: () => ops.op_doc_editor_font_names(),
            // The HTML-as-UI-description experiment: parses `html` + any <style>/inline CSS in
            // Rust (see src/deno/html_layout.rs and html_css.rs) and lays it out with taffy
            // (Block by default, Flex opt-in via `display: flex`) - real box positions, but no
            // text wrapping and no specificity-aware cascade, see html_layout.rs's doc comment
            // for the full list of what "basics" does and doesn't cover. Re-parses on every
            // call, so pass the same string every frame from a render callback rather than
            // trying to mutate it incrementally. `options.baseUrl` resolves relative
            // `<img src>`/`<a href>` - pass the fetched page's own URL for real webpages.
            // `options.width` sets the layout viewport width (default 760px).
            // With `options.onLinkClick`, links emit their resolved URL to the addon instead of
            // launching the host browser. This is the safe building block for an in-engine
            // browser loop; remote scripts remain inert either way.
            html: (windowId, html, options) => {
                const id = nextWidgetId(windowId, "html", options?.id);
                ops.op_ui_render_html(windowId, html || "", options?.baseUrl || "", options?.width || 0, !!options?.onLinkClick, id);
                bindListener('_entropy_event_listeners', id, options?.onLinkClick
                    ? (event) => options.onLinkClick(event.split("|").slice(2).join("|"))
                    : null);
            }
        }
    },
    // Deliberately minimal: one blocking text fetch, meant for pulling down a real webpage's
    // HTML to feed into `Entropy.UI.Widget.html`. Call it once (e.g. from `addon.onInit`), not
    // from a per-frame render callback - see op_http_get_text's doc comment in addon_ops.rs.
    Net: {
        // Non-blocking counterpart to getText: start once, then poll from onUpdate/onRender.
        // It returns only raw text; it never evaluates a fetched page or script.
        fetchText: (url) => ops.op_http_fetch_text(url),
        pollText: (id) => ops.op_http_poll_text(id),
        cancelText: (id) => ops.op_http_cancel_text(id),
        getText: (url) => {
            return ops.op_http_get_text(url);
        }
    },
    _process_events: (events) => {
        for (const event of events) {
            let id = event;
            let payload = null;
            let isHover = false;
            let isClick = false;
            let isRaw = false; // payload is the whole raw event string; skip numeric parsing

            // ops.op_println(String("Process Addon Event: " + event));

            if (event.startsWith("HOVER|")) {
                isHover = true;
                const parts = event.split("|");
                id = parts[1];
                payload = parts[2];
            } else if (event.startsWith("CLICK|")) {
                isClick = true;
                const parts = event.split("|");
                id = parts[1];
                payload = parts[2];
            } else if (event.startsWith("SNARL_CONNECT|") || event.startsWith("SNARL_DISCONNECT|") || event.startsWith("SNARL_NODE_MOVED|") || event.startsWith("SNARL_NODE_SELECTED|")) {
                // SNARL_NODE_MOVED| was missing from this list until the node graph editor
                // actually became interactive (see NodeGraphEditor) - the snarl() listener
                // above already parsed this event shape, but it never reached the listener:
                // it fell through to the generic `id|payload` branch below, which reads
                // `id = parts[0]` ("SNARL_NODE_MOVED" itself, not the widget's id), so
                // `onNodeMoved` was silently unreachable dead code.
                const parts = event.split("|");
                id = parts[1]; // snarl_id
                payload = event; // pass the whole event to the listener
                isRaw = true;
            } else if (event.startsWith("PIANOROLL_")) {
                const parts = event.split("|");
                id = parts[1]; // pianoRoll id
                payload = event; // pass the whole event to the listener
                isRaw = true;
            } else if (event.startsWith("KFTL_") || event.startsWith("TRACKS_") || event.startsWith("DOCEDIT_") || event.startsWith("KANBAN_") || event.startsWith("TREEVIEW_") || event.startsWith("PADGRID_") || event.startsWith("WAVETABLE_") || event.startsWith("PHYSMOD_") || event.startsWith("BRASS_") || event.startsWith("MATTER_") || event.startsWith("TABBAR_") || event.startsWith("SHEET_") || event.startsWith("HTML_LINK|")) {
                const parts = event.split("|");
                id = parts[1]; // keyframeTimeline/tracks/docEditor/kanban/treeView/padGrid/sheetGrid widget id
                payload = event; // pass the whole event to the listener
                isRaw = true;
            } else if (event.includes("|")) {
                const parts = event.split("|");
                id = parts[0];
                payload = parts[1];
            }

            const listener_pool = isHover ? globalThis._entropy_hover_listeners :
                                 isClick ? globalThis._entropy_click_listeners :
                                 globalThis._entropy_event_listeners;

            if (listener_pool && listener_pool[id]) {
                if (payload !== null) {
                    if (isRaw) {
                        listener_pool[id](payload);
                    } else if (payload.includes(",")) {
                        const values = payload.split(",").map(v => parseFloat(v));

                        // For minimap draw/hover events: x, y, brushSize
                        if (values.length === 3) {
                             listener_pool[id](values[0], values[1], values[2]);
                        } else {
                             listener_pool[id](values);
                        }
                    } else {
                        listener_pool[id](payload);
                    }
                } else {
                    listener_pool[id]();
                }
            }
        }
    },
    _process_game_logic: () => {
        if (!globalThis.Entropy.gameMode) return;

        const [playerPos] = globalThis.Entropy.Camera.getTransform();
        const collectables = globalThis.Entropy._collectables;

        if (collectables) {
            for (const id in collectables) {
                const config = collectables[id];
                const dx = playerPos[0] - config.position[0];
                const dy = playerPos[1] - config.position[1];
                const dz = playerPos[2] - config.position[2];
                const distSq = dx*dx + dy*dy + dz*dz;

                if (distSq < 4.0) { // 2.0 meters radius
                    if (config.onCollect) {
                        try {
                            config.onCollect("player"); // We'll use a fixed ID for now or find it
                        } catch(e) {
                            globalThis.Entropy.println("Error in onCollect: " + e);
                        }
                    }
                    globalThis.Entropy.Collectable.remove(id);
                }
            }
        }
    },
    _game_events: {
        started: [],
        stopped: []
    },
    onGameStarted: (cb) => {
        globalThis.Entropy._game_events.started.push(cb);
    },
    onGameStopped: (cb) => {
        globalThis.Entropy._game_events.stopped.push(cb);
    },
    _dispatchGameStarted: (gameName) => {
        globalThis.Entropy.println("[Game Hooks] Dispatching Game Started. Event Count: " + globalThis.Entropy._game_events.started.length);
        globalThis.Entropy._game_events.started.forEach(cb => {
            try { cb(gameName); } catch(e) { globalThis.Entropy.println("Error in onGameStarted callback: " + e); }
        });
    },
    _dispatchGameStopped: (gameName) => {
        globalThis.Entropy.println("[Game Hooks] Dispatching Game Stopped. Event Count: " + globalThis.Entropy._game_events.stopped.length);
        globalThis.Entropy._game_events.stopped.forEach(cb => {
            try { cb(gameName); } catch(e) { globalThis.Entropy.println("Error in onGameStopped callback: " + e); }
        });
    },
    _process_input_events: (events) => {
        globalThis.Entropy._process_game_logic?.();
        if (!globalThis._entropy_input_listeners) return;
        const listeners = globalThis._entropy_input_listeners;

        // Each slot is an array of callbacks (see Input.* below) - fire all of
        // them, isolated by try/catch, so one addon's controls setup (e.g.
        // Entropy.Controls) can coexist with another addon's own onMouseMove
        // handler instead of the second registration silently replacing the
        // first.
        const fireAll = (name, ...args) => {
            const fns = listeners[name];
            if (!fns || fns.length === 0) return;
            for (const fn of fns.slice()) {
                try { fn(...args); } catch (e) { globalThis.Entropy.println(`Error in ${name} callback: ` + e); }
            }
        };

        for (const event of events) {
            switch (event.type) {
                case "MouseDown":
                    fireAll("onMouseDown", event.button, event.x, event.y);
                    break;
                case "MouseMove":
                    fireAll("onMouseMove", event.x, event.y);
                    break;
                case "MouseUp":
                    fireAll("onMouseUp", event.button);
                    break;
                case "KeyDown": {
                    // We need modifiers here too if requested by API
                    // For now keeping it simple as per NEEDED_APIS.md
                    const state = ops.op_input_get_state();
                    fireAll("onKeyDown", event.key, state.modifiers.ctrl, state.modifiers.shift, state.modifiers.alt);
                    break;
                }
                case "KeyUp":
                    fireAll("onKeyUp", event.key);
                    break;
                case "GamepadButton":
                    fireAll("onGamepadButton", event.button, event.pressed);
                    break;
                case "GamepadAxis":
                    fireAll("onGamepadAxis", event.leftStick, event.rightStick);
                    break;
                case "StylusDown":
                    fireAll("onStylusDown", { x: event.x, y: event.y, pressure: event.pressure, tiltX: event.tiltX, tiltY: event.tiltY });
                    break;
                case "StylusMove":
                    fireAll("onStylusMove", { x: event.x, y: event.y, pressure: event.pressure, tiltX: event.tiltX, tiltY: event.tiltY });
                    break;
                case "StylusUp":
                    fireAll("onStylusUp", { x: event.x, y: event.y });
                    break;
                case "MouseWheel":
                    fireAll("onMouseWheel", event.deltaX, event.deltaY);
                    break;
            }
        }
    },
    _reset_widget_counter: () => {
        globalThis._entropy_widget_counter = 0;
    },
    Pipeline: {
        create: (config) => {
            return ops.op_pipeline_create({
                ...config,
                lightingBindings: config.lightingBindings || null
            });
        },
        createCompute: createComputePipeline
    },
    Compute: {
        dispatch: computeAPI.dispatch
    },
    Buffer: bufferAPI,
    // Was create-only, even though createAddonContextualAPI's Landscape already had
    // updateTexture/updatePbrTexture/getHeightAt (used via addon.Landscape.* by
    // ComponentAddon-based addons like flexnoise_v2.ts) - a standalone addon using the
    // top-level Entropy.Landscape (AddonAtom.register(), no this.api) had no way to texture
    // a landscape it created with Entropy.Landscape.create. Same "Global" tagging as the
    // rest of globalContextualAPI's exports.
    Landscape: globalContextualAPI.Landscape,
    Landscape3D: globalContextualAPI.Landscape3D,
    Particles: globalContextualAPI.Particles,
    Noise: noiseAPI,
    Texture: textureAPI,
    Lighting: globalContextualAPI.Lighting,
    // Not exposed before. `addon.Model.*` (scoped, defined further down inside
    // `Addon.register`) tags meshes with the registering addon's own name via `getAddonName()`,
    // which render_addon_frame.rs's addon_models filter then drops unless it equals "Global" or
    // the Studio-chrome-only `current_workspace`'s active addon (same pattern already fixed for
    // Lighting above). Under EntropyApp/game_mode, current_workspace never becomes
    // Workspace::Addon(...), so scoped-API meshes were being silently skipped at render time
    // with no error. Unlike Landscape/Particles/Lighting, `Model` was never generalized into
    // `createAddonContextualAPI` in the first place - so this is a standalone minimal
    // implementation (just the two ops createWaterMesh actually needs) tagging "Global", not a
    // reuse of that factory.
    Model: {
        // Mirrors the addon-scoped Model.load (further down, inside Addon.register) but tags
        // "Global" like the rest of this object - loading a .glb from a bare EntropyApp requires
        // EntropyApp::with_art_assets_project(id) to be set (see its doc comment); without it,
        // op_model_load's pending entry is silently dropped every frame (AddonEngine.project_id
        // stays None, and the model-loading block in addon_engine.rs is gated behind `if let
        // Some(project_id) = self.project_id`).
        load: (config) => {
            ops.op_model_load(globalThis.__entropy_current_addon_context_override || "Global", {
                id: config.id || null,
                path: config.path,
                visualType: config.visualType || null,
                position: config.position || [0, 0, 0],
                rotation: config.rotation || [0, 0, 0],
                scale: config.scale || [1, 1, 1],
                pipelineId: config.pipelineId || null,
                renderRole: config.renderRole || null,
                physics: config.physics || null,
                player: config.player || null,
                npc: config.npc || null,
                behaviorId: config.behaviorId || null,
                yumonId: config.yumonId || null,
                isNpc: config.isNpc || null
            });
        },
        createMesh: (config) => {
            ops.op_mesh_create(globalThis.__entropy_current_addon_context_override || "Global", {
                id: config.id || null,
                position: config.position || [0, 0, 0],
                rotation: config.rotation || [0, 0, 0],
                scale: config.scale || [1, 1, 1],
                vertexData: config.vertexData || [],
                indexData: config.indexData || [],
                pipelineId: config.pipelineId,
                render_role: config.renderRole || null,
                instanceCount: config.instanceCount || 1,
                bindings: config.bindings || [],
                behaviorId: config.behaviorId || null,
                yumonId: config.yumonId || null,
                isNpc: config.isNpc || null,
                player: config.player || null
            });
        },
        clearMesh: (meshId) => {
            ops.op_mesh_clear(globalThis.__entropy_current_addon_context_override || "Global", meshId);
        },
        // Opens a native Save As dialog and writes a self-contained .glb built from
        // already-world-space mesh data the caller supplies directly (no engine-side mesh
        // registry lookup - unlike load/createMesh, this doesn't touch any live mesh, so it
        // works equally for a mesh that was never registered as a scene entity at all). See
        // src/art_assets/GLBExporter.rs for the actual glTF/GLB assembly.
        //
        // Every mesh's textureRgba is concatenated into ONE buffer here rather than passed as
        // a per-mesh field, invisibly to the caller - op_model_export_glb takes it as a single
        // top-level #[buffer] arg instead of a Vec<u8> field nested in each mesh's #[serde]
        // struct, since the latter has no zero-copy path in deno_core (confirmed: a single
        // ~2.3MB canvas passed that way looked like a hang - no crash, no dialog, no error -
        // for several seconds+ with nothing to show for it, going through serde_v8's generic
        // one-element-at-a-time Vec<T> path instead of a real buffer view).
        exportGlb: (meshes, suggestedName) => {
            let totalLen = 0;
            for (const m of meshes) totalLen += m.textureRgba.length;
            const textures = new Uint8Array(totalLen);
            let off = 0;
            for (const m of meshes) {
                textures.set(m.textureRgba, off);
                off += m.textureRgba.length;
            }
            return ops.op_model_export_glb(
                meshes.map(m => ({
                    name: m.name,
                    positions: m.positions,
                    normals: m.normals,
                    uvs: m.uvs,
                    indices: m.indices,
                    textureWidth: m.textureWidth,
                    textureHeight: m.textureHeight
                })),
                textures,
                suggestedName || "export.glb"
            );
        }
    },
    Audio: audioAPI,
    AudioEffect: audioEffectAPI,
    Vst3: vst3API,
    Wavetable: wavetableAPI,
    PhysMod: physModAPI,
    Brass: brassAPI,
    Matter: matterAPI,
    Water: waterAPI,
    Icons: iconsAPI,
    System: systemAPI,
    Video: videoAPI,
    ML: mlAPI,
    println: (msg) => {
        ops.op_println(String(msg));
    },
    generateUUID: () => {
        return ops.op_generate_uuid();
    },
    setGameMode: (enabled) => {
        ops.op_set_game_mode(enabled);
    },
    Window: {
        getSize: () => {
            return ops.op_window_get_size();
        },
        setFullscreen: (enabled) => ops.op_window_set_fullscreen(enabled)
    },
    Camera: {
        getTransform: () => {
            return ops.op_camera_get_transform();
        },
        setTransform: (position, target) => {
            ops.op_camera_set_transform(position || null, target || null);
        },
        setOrthographic: (enabled, viewHeight) => {
            ops.op_camera_set_orthographic(enabled, viewHeight === undefined ? null : viewHeight);
        },
        screenToWorldRay: (screenX, screenY) => {
            const [pos, dir] = ops.op_camera_get_transform(); // Default fallback
            try {
                const [w, h] = ops.op_window_get_size();
                return ops.op_camera_screen_to_world(screenX, screenY, w, h);
            } catch (e) {
                return { origin: pos, direction: dir };
            }
        }
    },
    // Ready-made camera control schemes ("formats"), built once here on top of
    // Entropy.Input + Entropy.Camera so a scene can opt in with one call
    // (Entropy.Controls.enable("orbit")) instead of every addon hand-rolling
    // its own mouse-drag-to-orbit math. Previously the only way to get e.g.
    // shift-drag-to-rotate was to wire Entropy.Input.onMouseDown/Move/Up and
    // Entropy.Input.isShiftPressed() together from scratch in each addon -
    // this is that logic, written once, reusable from any addon's TS without
    // rebuilding it and without needing an engine/Rust change (it's built
    // entirely from ops already exposed above).
    //
    // Deltas are POLLED from op_input_get_state()'s mouse_position every frame
    // (via a lazily-registered op_addon_on_update tick), not driven by
    // Input.onMouseMove. startup.rs only dispatches the addon-visible
    // MouseMove event when `!game_mode` (WindowEvent::CursorMoved's call to
    // handle_mouse_move is skipped entirely under game_mode, and the game_mode
    // DeviceEvent::MouseMotion path that could stand in for it only runs once
    // the cursor is grab-locked, which nothing here does) - and EntropyApp
    // (so every standalone addon, this one included) defaults game_mode to
    // true. Button state still comes from onMouseDown/onMouseUp, which push
    // unconditionally regardless of game_mode.
    Controls: {
        _state: null,
        _unsubs: [],
        _tickRegistered: false,

        // format: "orbit" (drag to rotate the camera around a target, optional
        //   drag-to-dolly zoom) | "pan" (drag to slide the target sideways) |
        //   "none" (alias for disable()).
        // options:
        //   trigger: "shift" (default) | "ctrl" | "alt" | "always" - modifier
        //     that must be held for the drag to move the camera at all, so a
        //     scene's own click handling isn't hijacked by a bare drag.
        //   button: mouse button that starts the drag (0 left/1 right/2
        //     middle, default 0).
        //   zoomButton: for "orbit", a second button (default 2) that dollies
        //     the camera in/out on vertical drag instead of rotating.
        //   rotateSpeed / panSpeed / zoomSpeed: sensitivity multipliers.
        //   minPitch / maxPitch: radians, clamps orbit pitch (default
        //     +-~85 degrees to avoid flipping over the pole).
        //   invertY: flip vertical drag direction.
        //   invertX: flip horizontal drag direction (orbit's yaw only).
        //   target: world-space point to orbit/pan around (defaults to the
        //     camera's current look-at target from Camera.getTransform()).
        enable(format, options = {}) {
            globalThis.Entropy.Controls.disable();

            if (!format || format === "none") return;
            if (format !== "orbit" && format !== "pan") {
                globalThis.Entropy.println(`Entropy.Controls: unknown format "${format}", ignoring.`);
                return;
            }

            const [pos, camTarget] = ops.op_camera_get_transform();
            const target = options.target || camTarget || [0, 0, 0];

            const state = {
                format,
                dragging: false,
                zooming: false,
                lastX: 0,
                lastY: 0,
                target: [target[0], target[1], target[2]],
                options: {
                    trigger: options.trigger || "shift",
                    button: options.button ?? 0,
                    zoomButton: options.zoomButton ?? 2,
                    rotateSpeed: options.rotateSpeed ?? 0.005,
                    panSpeed: options.panSpeed ?? 0.05,
                    zoomSpeed: options.zoomSpeed ?? 0.05,
                    minPitch: options.minPitch ?? -1.48,
                    maxPitch: options.maxPitch ?? 1.48,
                    invertY: options.invertY ?? false,
                    invertX: options.invertX ?? false,
                }
            };

            const dx0 = pos[0] - state.target[0], dy0 = pos[1] - state.target[1], dz0 = pos[2] - state.target[2];
            state.distance = Math.max(0.001, Math.sqrt(dx0 * dx0 + dy0 * dy0 + dz0 * dz0));
            state.yaw = Math.atan2(dz0, dx0);
            state.pitch = Math.asin(Math.max(-1, Math.min(1, dy0 / state.distance)));

            globalThis.Entropy.Controls._state = state;

            const isTriggerActive = () => {
                switch (state.options.trigger) {
                    case "always": return true;
                    case "ctrl": return globalThis.Entropy.Input.isCtrlPressed();
                    case "alt": return globalThis.Entropy.Input.isAltPressed();
                    case "shift": default: return globalThis.Entropy.Input.isShiftPressed();
                }
            };

            const applyOrbit = () => {
                const cosPitch = Math.cos(state.pitch);
                const dir = [
                    cosPitch * Math.cos(state.yaw),
                    Math.sin(state.pitch),
                    cosPitch * Math.sin(state.yaw),
                ];
                const newPos = [
                    state.target[0] + dir[0] * state.distance,
                    state.target[1] + dir[1] * state.distance,
                    state.target[2] + dir[2] * state.distance,
                ];
                ops.op_camera_set_transform(newPos, state.target);
            };

            const applyPan = (dxp, dyp) => {
                const [curPos] = ops.op_camera_get_transform();
                const fwd = [
                    state.target[0] - curPos[0],
                    state.target[1] - curPos[1],
                    state.target[2] - curPos[2],
                ];
                const fwdLen = Math.max(0.0001, Math.sqrt(fwd[0] * fwd[0] + fwd[1] * fwd[1] + fwd[2] * fwd[2]));
                const fn = [fwd[0] / fwdLen, fwd[1] / fwdLen, fwd[2] / fwdLen];
                // world up is (0,1,0); right = forward x worldUp, up = right x forward
                const right = [fn[2], 0, -fn[0]];
                const rightLen = Math.max(0.0001, Math.sqrt(right[0] * right[0] + right[2] * right[2]));
                const rn = [right[0] / rightLen, 0, right[2] / rightLen];
                const up = [
                    rn[1] * fn[2] - rn[2] * fn[1],
                    rn[2] * fn[0] - rn[0] * fn[2],
                    rn[0] * fn[1] - rn[1] * fn[0],
                ];

                const move = state.options.panSpeed;
                const offset = [
                    -rn[0] * dxp * move + up[0] * dyp * move,
                    -rn[1] * dxp * move + up[1] * dyp * move,
                    -rn[2] * dxp * move + up[2] * dyp * move,
                ];
                state.target = [state.target[0] + offset[0], state.target[1] + offset[1], state.target[2] + offset[2]];
                const newPos = [curPos[0] + offset[0], curPos[1] + offset[1], curPos[2] + offset[2]];
                ops.op_camera_set_transform(newPos, state.target);
            };

            const [mx0, my0] = ops.op_input_get_state().mousePosition;
            state.lastX = mx0;
            state.lastY = my0;

            const onDown = (button, x, y) => {
                globalThis.Entropy.println(`[Controls DEBUG] onDown button=${button} trigger=${isTriggerActive()} x=${x} y=${y}`);
                if (!isTriggerActive()) return;
                if (button === state.options.button) {
                    state.dragging = true;
                    state.lastX = x;
                    state.lastY = y;
                } else if (format === "orbit" && button === state.options.zoomButton) {
                    state.zooming = true;
                    state.lastX = x;
                    state.lastY = y;
                }
            };
            const onUp = (button) => {
                if (button === state.options.button) state.dragging = false;
                if (button === state.options.zoomButton) state.zooming = false;
            };
            // A real mouse scroll wheel or a drawing tablet's physical zoom wheel/dial - always
            // active regardless of trigger/dragging state (unlike drag-to-zoom, a wheel tick has
            // no other meaning to disambiguate from here, so it doesn't need gating). Only
            // "orbit" has a distance/target model to zoom along; "pan" has no forward-dolly
            // concept established here, so wheel ticks are a no-op for it.
            const onWheel = (_deltaX, deltaY) => {
                if (format !== "orbit" || deltaY === 0) return;
                state.distance = Math.max(0.5, state.distance - deltaY * state.options.zoomSpeed * state.distance * 0.1);
                applyOrbit();
            };

            globalThis.Entropy.Controls._unsubs = [
                globalThis.Entropy.Input.onMouseDown(onDown),
                globalThis.Entropy.Input.onMouseUp(onUp),
                globalThis.Entropy.Input.onMouseWheel(onWheel),
            ];

            // The tick reads Controls._state fresh every call, so it's safe to
            // register once ever (op_addon_on_update has no unregister) and let
            // later enable()/disable() calls just swap what _state points to.
            if (!globalThis.Entropy.Controls._tickRegistered) {
                globalThis.Entropy.Controls._tickRegistered = true;
                const target = globalThis.__entropy_current_addon_context_override || "Global";
                ops.op_addon_on_update(target, () => {
                    const s = globalThis.Entropy.Controls._state;
                    if (!s) return;

                    const [mx, my] = ops.op_input_get_state().mousePosition;
                    const dxp = mx - s.lastX;
                    const dyp = my - s.lastY;
                    s.lastX = mx;
                    s.lastY = my;

                    if (!s.dragging && !s.zooming) return;
                    globalThis.Entropy.println(`[Controls DEBUG] tick dragging=${s.dragging} trigger=${s._isTriggerActive()} mx=${mx} my=${my} dxp=${dxp} dyp=${dyp}`);
                    if (!s._isTriggerActive()) { s.dragging = false; s.zooming = false; return; }
                    if (dxp === 0 && dyp === 0) return;

                    const yDir = s.options.invertY ? -1 : 1;
                    const xDir = s.options.invertX ? -1 : 1;
                    if (s.zooming) {
                        s.distance = Math.max(0.5, s.distance - dyp * yDir * s.options.zoomSpeed * s.distance * 0.1);
                        s._applyOrbit();
                    } else if (s.format === "orbit") {
                        s.yaw -= xDir * dxp * s.options.rotateSpeed;
                        s.pitch = Math.max(s.options.minPitch, Math.min(s.options.maxPitch, s.pitch - yDir * dyp * s.options.rotateSpeed));
                        s._applyOrbit();
                    } else if (s.format === "pan") {
                        s._applyPan(dxp, dyp);
                    }
                });
            }

            // Stashed on state itself so the shared tick above (registered once,
            // outside this closure) can reach the current enable() call's
            // trigger check / orbit / pan implementations.
            state._isTriggerActive = isTriggerActive;
            state._applyOrbit = applyOrbit;
            state._applyPan = applyPan;
        },

        disable() {
            for (const unsub of globalThis.Entropy.Controls._unsubs) {
                try { unsub(); } catch (e) {}
            }
            globalThis.Entropy.Controls._unsubs = [];
            globalThis.Entropy.Controls._state = null;
        },

        isEnabled() {
            return globalThis.Entropy.Controls._state !== null;
        },

        getFormat() {
            return globalThis.Entropy.Controls._state?.format || null;
        }
    },
    Gizmo: {
        show: (config) => {
            const id = globalThis.Entropy.generateUUID();
            ops.op_gizmo_show({
                id,
                position: config.position,
                // [x, y, z, w] - omitted means identity, matching every pre-existing caller
                // that never used a rotate handle in the first place.
                rotation: config.rotation || [0, 0, 0, 1],
                mode: config.mode,
                space: config.space || "world"
            });
            // We'll store callbacks globally for the engine to trigger
            globalThis._entropy_gizmo_callbacks = globalThis._entropy_gizmo_callbacks || {};
            globalThis._entropy_gizmo_callbacks[id] = {
                onTransform: config.onTransform,
                onRotate: config.onRotate,
                onComplete: config.onComplete
            };
            return id;
        },
        hide: (id) => {
            ops.op_gizmo_hide();
            if (globalThis._entropy_gizmo_callbacks) {
                delete globalThis._entropy_gizmo_callbacks[id];
            }
        },
        updatePosition: (id, position) => {
            ops.op_gizmo_update(position[0], position[1], position[2]);
        },
        // Mirrors updatePosition - see op_gizmo_update_rotation's doc comment for why a
        // "rotate"/"translate_rotate" gizmo needs this pushed back after every onRotate.
        updateRotation: (id, rotation) => {
            ops.op_gizmo_update_rotation(rotation[0], rotation[1], rotation[2], rotation[3]);
        },
        getState: (id) => {
            // Need op_gizmo_get_state if we want to poll it
            return null;
        }
    },
    Input: {
        // Registering a callback used to overwrite whatever the previous
        // caller had registered for the same event - fine when only one
        // addon cared about mouse/key events, but it meant a second
        // registration (e.g. Entropy.Controls wiring up camera drag)
        // silently broke the first one. Each on* below now appends to a
        // list instead (see _process_input_events / fireAll above) and
        // returns an unsubscribe function so long-lived subsystems like
        // Controls can clean up after themselves on disable().
        _on: (name, callback) => {
            globalThis._entropy_input_listeners = globalThis._entropy_input_listeners || {};
            const listeners = globalThis._entropy_input_listeners;
            listeners[name] = listeners[name] || [];
            listeners[name].push(callback);
            return () => {
                const idx = listeners[name].indexOf(callback);
                if (idx !== -1) listeners[name].splice(idx, 1);
            };
        },
        onMouseDown: (callback) => globalThis.Entropy.Input._on("onMouseDown", callback),
        onMouseMove: (callback) => globalThis.Entropy.Input._on("onMouseMove", callback),
        onMouseUp: (callback) => globalThis.Entropy.Input._on("onMouseUp", callback),
        // A real mouse scroll wheel and a drawing tablet's physical zoom wheel/dial both arrive
        // here identically (WindowEvent::MouseWheel doesn't distinguish them) - deltaY > 0 is
        // "wheel up"/scroll away from the user, matching this engine's existing MouseScrollDelta
        // sign convention (see Entropy.Controls' own use of this below for zoom).
        onMouseWheel: (callback) => globalThis.Entropy.Input._on("onMouseWheel", callback),
        onKeyDown: (callback) => globalThis.Entropy.Input._on("onKeyDown", callback),
        onKeyUp: (callback) => globalThis.Entropy.Input._on("onKeyUp", callback),
        onGamepadButton: (callback) => globalThis.Entropy.Input._on("onGamepadButton", callback),
        onGamepadAxis: (callback) => globalThis.Entropy.Input._on("onGamepadAxis", callback),
        // Pen/stylus input (Windows only - see src/stylus.rs). Each callback receives one object:
        // { x, y, pressure, tiltX, tiltY } for down/move (pressure is 0..1; tiltX/tiltY are
        // degrees, 0 = perpendicular to the tablet, null if this pen's driver doesn't report that
        // axis), { x, y } for up. Never fires for plain mouse/touch input - only WM_POINTER
        // packets whose pointerType is PT_PEN.
        onStylusDown: (callback) => globalThis.Entropy.Input._on("onStylusDown", callback),
        onStylusMove: (callback) => globalThis.Entropy.Input._on("onStylusMove", callback),
        onStylusUp: (callback) => globalThis.Entropy.Input._on("onStylusUp", callback),
        isKeyPressed: (key) => {
            const state = ops.op_input_get_state();
            // if (state.pressedKeys?.length) {
            //     globalThis.Entropy.println("state.pressedKeys: " + JSON.stringify(state.pressedKeys));
            // }
            return state.pressedKeys?.includes(key);
        },
        isCtrlPressed: () => {
            const state = ops.op_input_get_state();
            return state.modifiers.ctrl;
        },
        isShiftPressed: () => {
            const state = ops.op_input_get_state();
            return state.modifiers.shift;
        },
        isAltPressed: () => {
            const state = ops.op_input_get_state();
            return state.modifiers.alt;
        },
        isPointerOverUI: () => {
            const state = ops.op_input_get_state();
            return state.pointerOverUi;
        }
    },
    Selection: {
        setMode: (mode) => {
            // op_selection_set_mode(mode)
        },
        getSelected: (meshId) => {
            const selectedId = ops.op_selection_get_selected();
            // Basic object selection for now
            return {
                vertices: [],
                edges: [],
                faces: [],
                objectId: selectedId === "" ? null : selectedId
            };
        },
        raycast: (screenX, screenY) => {
            // Need op_selection_raycast
            return null;
        },
        highlightElements: (meshId, config) => {
            // op_selection_highlight(meshId, config)
        },
        clear: () => {
            // op_selection_clear()
        }
    },
    Mesh: {
        getData: (meshId) => {
            return ops.op_mesh_get_data(meshId);
        },
        updateVertices: (meshId, vertexIndices, newPositions) => {
            // Check if it's a full update or partial
            // For now we'll pass it to native, which might just log or do partial buffer write
            ops.op_mesh_update_vertices(meshId, vertexIndices, newPositions);
        },
        appendGeometry: (meshId, vertices, indices) => {
            // op_mesh_append_geometry(meshId, vertices, indices)
        },
        removeGeometry: (meshId, faceIndices) => {
            // op_mesh_remove_geometry(meshId, faceIndices)
        },
        getVertexWorldPosition: (meshId, vertexIndex) => {
            // Need op_mesh_get_vertex_world_pos
            return [0, 0, 0];
        },
        recalculateNormals: (meshId) => {
            // op_mesh_recalculate_normals(meshId)
        }
    }
};

// IO Namespace (Scoped to addon)
globalThis.Entropy.IO = {
    // This is a placeholder, actual implementation needs scoped metadata.name access.
    // However, globalThis.Entropy structure is static.
    // The `register` function returns the SCOPED API.
    // So we should add IO to the returned object in `register`.
};

globalThis.Entropy.Composite = {
  register: (name, textureId, pipelineId, bindings = []) => {
    const target = globalThis.__entropy_current_addon_context_override || "Global";
    ops.op_register_composite_texture(target, { name, textureId, pipelineId, bindings });
  }
};

// ---------------------------------------------------------------------------
// Generic registries backing the Composer namespace below.
//
// registerEditor/getEditor, registerRenderer/getRenderer,
// registerTextureGenerator/getTextureGenerator and registerGame/getGame used
// to be four hand-copied "store a value under a key, look it up later"
// pairs. registerComponent/getComponents and registerAction/getAction are
// the same pattern one level deeper (addonName -> key -> value). Both
// shapes are now implemented once.
// ---------------------------------------------------------------------------
function makeFlatRegistry(store) {
    return {
        register: (key, value) => { store[key] = value; },
        get: (key) => store[key],
        all: () => store
    };
}

function makeNamespacedRegistry(store) {
    return {
        register: (namespace, key, value) => {
            if (!store[namespace]) store[namespace] = {};
            store[namespace][key] = value;
        },
        get: (namespace, key) => (store[namespace] || {})[key],
        allIn: (namespace) => store[namespace] || {}
    };
}

// Composer Registry (Global)
{
    const editors = {};
    const renderers = {};
    const games = {};
    const textureGenerators = {};
    const components = {};
    const instances = {};
    const actions = {};

    const editorsRegistry = makeFlatRegistry(editors);
    const renderersRegistry = makeFlatRegistry(renderers);
    const gamesRegistry = makeFlatRegistry(games);
    const textureGeneratorsRegistry = makeFlatRegistry(textureGenerators);
    const instancesRegistry = makeFlatRegistry(instances);
    const componentsRegistry = makeNamespacedRegistry(components);
    const actionsRegistry = makeNamespacedRegistry(actions);

    globalThis.Entropy.Composer = {
        editors,
        renderers,
        games,
        textureGenerators,
        components,
        instances,
        actions,
        initCallbacks: {}, // addonName -> initCallback()
        globalSettings: {
            landscapeSettings: {
                size: 1024,
                height: 150,
                yOffset: -200
            }
        },
        clearMesh: (meshId) => {
            ops.op_mesh_clear("Game Composer", meshId);
        },
        registerEditor: editorsRegistry.register,
        getEditor: editorsRegistry.get,
        registerRenderer: renderersRegistry.register,
        getRenderer: renderersRegistry.get,
        registerTextureGenerator: textureGeneratorsRegistry.register,
        getTextureGenerator: textureGeneratorsRegistry.get,
        registerGame: gamesRegistry.register,
        getGame: gamesRegistry.get,
        registerComponent: (addonName, componentId, name, params) => {
            componentsRegistry.register(addonName, componentId, { id: componentId, name, params });
        },
        getComponents: (addonName) => componentsRegistry.allIn(addonName),
        // Idempotent upsert so any addon can announce "this instance exists" without
        // clobbering whatever a consumer (e.g. Game Composer) already knows about it.
        // Only addonName/componentId/defaults are (re)written here - position, scale,
        // visibility and per-field overrides live downstream and must survive repeat calls,
        // since producers like Model Viewer's refreshModels() re-announce on every edit.
        registerInstance: (addonName, componentId, instanceId, defaults) => {
            instancesRegistry.register(instanceId, { addonName, componentId, defaults });
        },
        getInstances: () => instancesRegistry.all(),
        // General-purpose escape hatch for cross-addon integration: any addon can expose
        // a plain callable function under its own name/action-name pair, and any other
        // addon can look it up and call it directly (same shared JS realm, no engine
        // round-trip).
        registerAction: (addonName, actionName, fn) => actionsRegistry.register(addonName, actionName, fn),
        getAction: (addonName, actionName) => actionsRegistry.get(addonName, actionName),
        setRolePipeline: (role, pipelineId) => {
            ops.op_composer_set_role_pipeline(role, pipelineId);
        },
        enableGameComposerOverride: () => {
            globalThis.__entropy_current_addon_context_override = "Game Composer";
        },
        disableGameComposerOverride: () => {
            globalThis.__entropy_current_addon_context_override = null;
        },
        enableOverride: (name) => {
            globalThis.__entropy_current_addon_context_override = name;
        },
        disableOverride: () => {
            globalThis.__entropy_current_addon_context_override = null;
        },
        setGlobalSettings: (settings) => {
            globalThis.Entropy.Composer.globalSettings = settings;
        },
        getGlobalSettings: () => {
            return globalThis.Entropy.Composer.globalSettings;
        },
        getNPCs: () => {
            return globalThis.registered_npcs;
        },
        updateNPCPosition: (entityId, position) => {
            globalThis.registered_npcs.find((npc) => npc.id === entityId).position = position;
        }
    };
}

globalThis._createSystem = () => {
    return {
        spawn_particles: (pos, color, grav) => {
            // Need to make sure op_system_spawn_particles is registered in addon_engine.rs too!
            // Actually let's assume we'll add it or use a different way.
            // For now, mirroring old setup.js
            ops.op_system_spawn_particles(pos, color, grav);
        },
        vec3: (x, y, z) => ({ x, y, z }),
        log_particles: (pos, color, grav) => {
             // no-op
        },
        debug_name: (val) => "System"
    };
};

globalThis._createDialogue = () => {
    return {
        show: (text) => ops.op_dialogue_show(text),
        add_option: (text, next_node) => ops.op_dialogue_add_option(text, next_node),
        start_quest: (id) => ops.op_dialogue_start_quest(id),
        close: () => ops.op_dialogue_close(),
        get_node: () => ops.op_dialogue_get_node(),
        select_option: (index) => ops.op_dialogue_select_option(index),
    };
};

// Convenience global
globalThis.println = globalThis.Entropy.println;

export {};
