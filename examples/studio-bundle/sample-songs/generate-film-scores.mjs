// Film Scores: five original cinematic cues played only by the physically modeled instruments -
// bowed strings (physmod), brass, the Matter kit and Water. No oscillators, wavetables, samples or
// drum-rack voices. Run directly, or via generate.mjs. No random state or assets.
//
// Everything is written in absolute time (bar, sixteenth) and pitch names, so the scores read like
// scores; `build()` then slices each track into one named pattern per section.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --- Pitch -------------------------------------------------------------------------------------

const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 'C4' -> 60, 'F#2' -> 42, 'Bb3' -> 58. A number passes through. */
export const m = name => {
  if (typeof name === 'number' || /^\d+$/.test(name)) return +name;
  const x = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!x) throw new Error(`bad pitch ${name}`);
  return 12 * (+x[3] + 1) + LETTER[x[1]] + (x[2] === '#' ? 1 : x[2] === 'b' ? -1 : 0);
};
const hz = midi => +(440 * 2 ** ((m(midi) - 69) / 12)).toFixed(2);

// --- Instruments -------------------------------------------------------------------------------

// Mirrors defaultPhysMod() in src/apps/daw_physmod.ts, so a preset's construction is saved exactly.
const PM_PRESETS = {
  violin: { bodySize: 0 }, viola: { bodySize: 0.13 }, cello: { bodySize: 0.72 }, bass: { bodySize: 1 },
  hardanger: { bodySize: -0.05, coupling: 0.55, sympathetic: [74, 76, 78, 81, 83].map(hz) },
  glass: { bodySize: -0.5, stiffness: 0.7, brightness: 0.95, bodyResonance: 0.85, stringMass: 0.3 },
  octobass: { bodySize: 1.8, stringMass: 0.8, brightness: 0.35, coupling: 0.5 },
};
const pm = (instrument, p = {}) => ({
  instrument, bowForce: 0.5, bowVelocity: 0.5, bowPosition: 0.12, articulation: 'arco', attackSkill: 0.9,
  vibratoRate: 5.5, vibratoDepth: 15, vibratoDelay: 0.15, slide: 0.06, damping: 0, brightness: 0.5, ring: 0.35,
  stringMass: 0.5, stiffness: 0, rosin: 0.5, bowNoise: 0.15, bodyMix: 0.85, bodyResonance: 0.5, coupling: 0.35,
  bodySeed: 1, sympathetic: [], tuningFollowsSize: false, audition: true, auditionNote: 60, physicsView: false,
  ...PM_PRESETS[instrument], ...p,
});
const PM_LOW = { violin: 55, viola: 48, cello: 36, bass: 28, hardanger: 57, glass: 55, octobass: 16 };

// Mirrors defaultBrass() plus the named playing styles in src/apps/daw_brass.ts.
const BRASS_STYLES = {
  chorale: { breath: 0.3, articulation: 'legato', tongue: 0.02 },
  section: { breath: 0.5, articulation: 'tongued', tongue: 0.004 },
  fanfare: { breath: 0.78, articulation: 'tongued', tongue: 0.002 },
  blazing: { breath: 0.95, articulation: 'tongued', tongue: 0.002 },
  glissando: { breath: 0.65, articulation: 'glissando', slideTime: 0.3 },
  rough: { breath: 0.7, articulation: 'tongued', attackSkill: 0.2, breathNoise: 0.35 },
};
export const BRASS_RANGE = { trombone: [40, 74], trumpet: [54, 84], horn: [41, 77], tuba: [28, 60] };
const brass = (instrument, style, p = {}) => ({
  instrument, style, breath: 0.5, lipTension: 0, aperture: 0.5, articulation: 'tongued', attackSkill: 1,
  tongue: 0.004, release: 0.08, vibratoRate: 5, vibratoDepth: 0, vibratoDelay: 0.3, slideTime: 0.07,
  breathNoise: 0.1, brassiness: 1, mute: 'open', hand: null, bellFacing: null,
  auditionNote: { trombone: 58, trumpet: 70, horn: 65, tuba: 41 }[instrument], physicsView: false,
  ...BRASS_STYLES[style], ...p,
});

// The Matter kit's rows (src/apps/daw_matter.ts MATTER_ROWS).
const K = { kick: 0, snare: 1, edge: 2, rack: 3, floor: 4, crash: 5, ride: 6, bell: 7, splash: 8, sweep: 9, swirl: 10 };
const MATTER_KITS = {
  // Felt mallets and yarn: timpani-like toms, and cymbals that swell instead of crash.
  mallets: { kick: 55, snare: 200, rackTom: 140, floorTom: 82, kickMuffling: 0.5, snares: false, snareTension: 0.15, sympathetic: true, brushes: false },
  // Low, loose "war drums": the toms glide down after a hard hit.
  war: { kick: 42, snare: 160, rackTom: 100, floorTom: 58, kickMuffling: 0.35, snares: false, snareTension: 0.15, sympathetic: true, brushes: false },
  rock: { kick: 48, snare: 190, rackTom: 115, floorTom: 70, kickMuffling: 1, snares: true, snareTension: 0.2, sympathetic: true, brushes: false },
};
const matter = (kit, hands, p = {}) => ({
  preset: hands === 'mallets' ? 'mallets' : 'rock', kit: { ...MATTER_KITS[kit] },
  mix: { kick: 3, snare: 1, 'rack-tom': 2, 'floor-tom': 2.5, crash: 2, ride: 3, splash: 1.5 },
  hands, beater: 'felt', dynamics: 6, physicsView: false, ...p,
});
const water = (play, p = {}) => ({
  preset: { glass: 'glass-harp', drip: 'drips', weather: 'lakeside' }[play], play, weatherSource: 'rain',
  rain: 'lake', vessel: 'bottle', spoon: false, dynamics: 0.7,
  mix: { drip: 5, glass: 1.5, fill: 4, rain: 1, brook: 0.7, surf: 0.5, slosh: 0.5 }, physicsView: false, ...p,
});
const character = (p = {}) => ({ pump: 0, bounce: 0, gate: 0, gatePattern: 'sixteenths', acid: 0, grit: 0,
  space: 0, humanize: 0, acidBase: null, ...p });
// The voice fields still matter for live playback (delay and reverb on the track's bus).
const voice = (waveform, p = {}) => ({ waveform, cutoff: 4000, resonance: 1, attack: 0.005, decay: 0.08,
  sustain: 0.6, release: 0.12, delayTime: 0, delayFeedback: 0.3, delayMix: 0, reverbRoomSize: 22,
  reverbTime: 2.6, reverbDamping: 0.55, reverbMix: 0, ...p });

// --- The score builder -------------------------------------------------------------------------

class Score {
  constructor({ slug, name, bpm, bars }) {
    Object.assign(this, { slug, name, bpm, bars });
    this.tracks = []; this.notes = new Map(); this.sections = []; this.cuts = [];
  }
  /** kind: strings | brass | matter | water. `space` is the Space knob: the hall. */
  add(role, name, kind, gain, settings, { space = 0.3, humanize = 0.1, reverbMix = 0.18 } = {}) {
    const waveform = { strings: 'physmod', brass: 'brass', matter: 'matter', water: 'water' }[kind];
    const t = { id: `${this.slug}-${role}`, name, kind: 'synth', channel: this.tracks.length,
      colorIndex: this.tracks.length, rootNote: kind === 'matter' ? 0 : 24, scale: 'chromatic',
      rows: kind === 'matter' ? 11 : 73, voice: voice(waveform, { reverbMix }), gain, muted: false, solo: false,
      patterns: [], activePatternId: '', character: character({ space, humanize }),
      [{ strings: 'physmod', brass: 'brass', matter: 'matter', water: 'water' }[kind]]: settings };
    this.tracks.push(t); this.notes.set(t, []);
    return t;
  }
  section(name, bar, bars) { this.sections.push({ name, bar, bars }); }
  /** One note at bar (0-based) + step (sixteenths), `len` sixteenths long. */
  n(t, bar, step, pitch, len, vel, extra = {}) {
    const at = bar * 16 + step;
    const row = t.voice.waveform === 'matter' ? pitch : m(pitch) - t.rootNote;
    this.notes.get(t).push({ at, row, len, velocity: +Math.min(1, Math.max(0.05, vel)).toFixed(3), ...extra });
  }
  chord(t, bar, step, pitches, len, vel) { pitches.forEach((p, i) => this.n(t, bar, step, p, len, vel - i * 0.02)); }
  /** A melody: 'D4:4 F4:2 r:2 A4:8' - pitch:sixteenths, r for a rest. Legato overlaps each note
   *  into the next a little, so a bowed string or a brass player slurs them. Returns the end step. */
  line(t, bar, step, text, vel, { legato = false, accent = null, crescendo = 0 } = {}) {
    const items = text.trim().split(/\s+/).filter(x => x !== '|').map(x => x.split(':'));
    const total = items.reduce((s, [, d]) => s + +d, 0);
    let at = bar * 16 + step, i = 0;
    for (const [p, d] of items) {
      const len = +d;
      if (p !== 'r') {
        const next = items[i + 1];
        const slur = legato && next && next[0] !== 'r' ? 0.2 : 0;
        const v = vel + crescendo * ((at - bar * 16 - step) / total) + (accent && accent(i) ? 0.08 : 0);
        this.n(t, 0, at, p, len + slur, v);
      }
      at += len; i++;
    }
    return at;
  }
  /** Rests every track for the given steps, reverb tails included (the DAW's saved hard cuts). */
  silence(bar, step, bars, steps) {
    this.cuts.push({ id: `${this.slug}-cut-${bar}-${step}`, trackIds: this.tracks.map(t => t.id),
      startStep: bar * 16 + step, endStep: bars * 16 + steps });
  }
  build(activeRole) {
    const arrangement = [];
    const stepsTotal = this.bars * 16;
    this.sections.sort((a, b) => a.bar - b.bar);
    for (const t of this.tracks) {
      const notes = this.notes.get(t);
      if (!notes.length) throw new Error(`${t.id} plays nothing`);
      // Keep the piano roll around the notes the track actually plays.
      if (t.voice.waveform !== 'matter') {
        const pitches = notes.map(n => n.row + t.rootNote);
        const root = Math.floor(Math.min(...pitches) / 12) * 12;
        notes.forEach(n => { n.row += t.rootNote - root; });
        t.rootNote = root;
        t.rows = Math.max(25, Math.max(...pitches) - root + 1);
      }
      this.sections.forEach((s, i) => {
        const start = s.bar * 16, steps = s.bars * 16, end = start + steps;
        for (const n of notes) if (n.at >= start && n.at < end && n.at + n.len > end + 0.25)
          console.warn(`${t.id}: a note at bar ${Math.floor(n.at / 16) + 1} is cut at the end of "${s.name}"`);
        const inside = notes.filter(n => n.at >= start && n.at < end)
          .map(n => ({ row: n.row, step: n.at - start, length: +Math.min(n.len, end - n.at).toFixed(3),
            velocity: n.velocity, ...(n.offset ? { offset: n.offset } : {}) }))
          .sort((a, b) => a.step - b.step || a.row - b.row);
        if (!inside.length) return;
        const id = `${t.id}-${String(i + 1).padStart(2, '0')}`;
        t.patterns.push({ id, name: s.name, steps, notes: inside });
        t.activePatternId ||= id;
        arrangement.push({ id: `${id}-clip`, trackId: t.id, patternId: id, startStep: start, lengthSteps: steps });
      });
      if (notes.some(n => n.at + n.len > stepsTotal + 1e-9)) throw new Error(`${t.id} runs past the end`);
    }
    return { bpm: this.bpm, stepsPerBeat: 4, songBars: this.bars, snap: 'bar', arrangement,
      tracks: this.tracks, cuts: this.cuts, activeTrackId: `${this.slug}-${activeRole}` };
  }
}

// Repeats `fn(bar, i)` for bars [from, to).
const each = (from, to, fn) => { for (let b = from; b < to; b++) fn(b, b - from); };
const pick = (list, i) => list[i % list.length];

// =================================================================================================
// 1. Folded City - E minor, 64 BPM, 32 bars. A dream folding in on itself: a spinning glass
//    "totem", foghorn brass blasts, and a string ostinato that never stops accelerating in density.
// =================================================================================================
function foldedCity() {
  const s = new Score({ slug: 'folded-city', name: 'Folded City', bpm: 64, bars: 32 });
  const glass = s.add('totem', 'Spinning totem (glass harp)', 'water', 0.34, water('glass', { dynamics: 0.55 }), { space: 0.45, humanize: 0 });
  const vln = s.add('violins', 'Violins', 'strings', 0.2, pm('violin', { bowForce: 0.5, bowVelocity: 0.48, vibratoDepth: 12, bodyMix: 0.75 }));
  const vla = s.add('violas', 'Violas - ostinato', 'strings', 0.19, pm('viola', { bowForce: 0.58, bowVelocity: 0.6, bowPosition: 0.1, vibratoDepth: 4, attackSkill: 1 }), { space: 0.25 });
  const vc = s.add('cellos', 'Cellos', 'strings', 0.22, pm('cello', { bowForce: 0.6, bowVelocity: 0.55, vibratoDepth: 10 }));
  const ob = s.add('octobass', 'Octobass drone', 'strings', 0.3, pm('octobass', { bowForce: 0.7, bowVelocity: 0.4, vibratoDepth: 0 }), { space: 0.2 });
  const hn = s.add('horns', 'Horns - theme', 'brass', 0.17, brass('horn', 'section', { breath: 0.55, articulation: 'legato', tongue: 0.012 }), { space: 0.4 });
  const tbn = s.add('trombones', 'Trombones - foghorn', 'brass', 0.16, brass('trombone', 'blazing', { release: 0.4 }), { space: 0.35 });
  const tuba = s.add('tuba', 'Tuba - foghorn', 'brass', 0.2, brass('tuba', 'blazing', { release: 0.5 }), { space: 0.3 });
  const kit = s.add('drums', 'Matter - mallet toms and swells', 'matter', 0.3, matter('mallets', 'mallets', { dynamics: 8 }), { space: 0.35, humanize: 0 });

  s.section('The totem spins', 0, 4); s.section('First blast', 4, 4); s.section('Limbo ostinato', 8, 4);
  s.section('Theme under water', 12, 4); s.section('The kick', 16, 4); s.section('City folds', 20, 4);
  s.section('Collapse', 24, 4); s.section('Waking?', 28, 4);

  // Em | Cmaj7 | G/D | B7sus4 -> B. Upper voicings for violas, basses for cellos and the drone.
  const prog = [
    { bass: 'E2', low: 'E1', tones: ['E3', 'G3', 'B3', 'E4'], top: 'B4' },
    { bass: 'C2', low: 'C1', tones: ['C3', 'G3', 'B3', 'E4'], top: 'E5' },
    { bass: 'D2', low: 'D1', tones: ['D3', 'G3', 'B3', 'D4'], top: 'D5' },
    { bass: 'B1', low: 'B0', tones: ['B2', 'F#3', 'A3', 'E4'], top: 'D#5' },
  ];
  // The totem: two glasses a fourth apart, ticking like a top that slowly loses speed.
  const spin = (bar, vel, rate = 2) => {
    for (let st = 0; st < 16; st += rate) s.n(glass, bar, st, st % (rate * 2) ? 'E6' : 'B5', rate, vel - (st % 4 ? 0.1 : 0));
  };
  each(0, 4, (b, i) => spin(b, 0.42 + i * 0.04, i < 2 ? 4 : 2));
  // A drone on the octobass, and a thin high violin line like a distant signal.
  each(0, 8, b => s.n(ob, b, 0, pick(prog, b).low, 16, 0.5));
  s.line(vln, 1, 0, 'B5:24 C6:8 B5:16 A5:16', 0.34, { legato: true });

  // Foghorn blasts: one enormous chord, then air. Bars 4 and 6 (the cellos answer).
  const blast = (bar, vel = 0.9, len = 12) => {
    const c = pick(prog, bar);
    s.n(tuba, bar, 0, c.bass === 'B1' ? 'B1' : c.bass, len, vel);
    s.n(tbn, bar, 0, m(c.bass) + 12, len, vel - 0.04);
    s.n(tbn, bar, 0.1, m(c.bass) + 19, len, vel - 0.08);
    s.n(kit, bar, 0, K.kick, 1, vel); s.n(kit, bar, 0, K.floor, 1, vel - 0.1);
  };
  blast(4); blast(6);
  each(4, 8, (b, i) => {
    const c = pick(prog, b);
    s.n(vc, b, i % 2 ? 0 : 8, c.tones[0], i % 2 ? 16 : 8, 0.5);
    spin(b, 0.34, 4);
  });
  s.n(kit, 7, 8, K.crash, 8, 0.45); // yarn on the crash: a swell into the ostinato

  // The ostinato: violas in running sixteenths over the chord, cellos in eighths, never resting.
  const ostinato = (b, vel) => {
    const c = pick(prog, b), shape = [1, 2, 3, 2];
    for (let st = 0; st < 16; st++) s.n(vla, b, st, c.tones[shape[st % 4]], 1, vel + (st % 4 === 0 ? 0.08 : 0));
  };
  // (A cello's lowest string is C2, so the B chord's bass is taken up an octave.)
  const eighths = (b, vel) => {
    const c = pick(prog, b), bass = m(c.bass) < 36 ? m(c.bass) + 12 : m(c.bass);
    for (let st = 0; st < 16; st += 2) s.n(vc, b, st, st % 4 ? c.tones[0] : bass, 2, vel);
  };
  each(8, 24, (b, i) => { ostinato(b, 0.42 + Math.min(i, 12) * 0.02); eighths(b, 0.46 + Math.min(i, 12) * 0.02); });
  each(8, 24, b => s.n(ob, b, 0, pick(prog, b).low, 16, 0.55));
  each(8, 16, b => { s.n(kit, b, 0, K.floor, 1, 0.55); s.n(kit, b, 8, K.floor, 1, 0.42); spin(b, 0.3, 4); });

  // The theme: four long notes a bar apart, like a slowed-down memory. Horns first.
  const theme = 'E4:16 | D4:12 C4:4 | B3:16 | B3:8 D#4:8';
  const theme2 = 'G4:16 | E4:16 | D4:12 E4:4 | F#4:16';
  s.line(hn, 12, 0, theme, 0.58, { legato: true });
  s.line(hn, 16, 0, theme, 0.7, { legato: true });
  s.line(hn, 20, 0, theme2, 0.76, { legato: true });
  // The kick: the violins take it an octave (then two) up and everything plays.
  s.line(vln, 16, 0, 'E5:16 | D5:12 C5:4 | B4:16 | B4:8 D#5:8', 0.62, { legato: true });
  s.line(vln, 20, 0, 'G5:16 | E5:16 | D5:12 E5:4 | F#5:8 A5:4 B5:4', 0.74, { legato: true, crescendo: 0.1 });
  each(16, 24, b => {
    blast(b, b % 2 ? 0.74 : 0.92, b % 2 ? 6 : 14);
    [0, 6, 10].forEach((st, i) => s.n(kit, b, st, i ? K.rack : K.floor, 1, 0.62 + (i ? 0 : 0.12)));
    if (b % 4 === 3) [12, 13, 14, 15].forEach((st, i) => s.n(kit, b, st, K.floor, 1, 0.5 + i * 0.1));
  });
  s.n(kit, 16, 0, K.crash, 1, 0.8); s.n(kit, 20, 0, K.crash, 1, 0.85);
  s.n(kit, 23, 4, K.crash, 12, 0.55);

  // Collapse: the orchestra falls out one floor at a time; only the ostinato and the top remain.
  each(24, 27, (b, i) => { ostinato(b, 0.5 - i * 0.06); s.n(ob, b, 0, pick(prog, b).low, 16, 0.5 - i * 0.08); spin(b, 0.36, 2); });
  s.n(tuba, 24, 0, 'E2', 16, 0.62);
  s.n(kit, 24, 0, K.kick, 1, 0.85);
  // Bar 27: the top spins faster and faster, then the dream cuts out on the last beat.
  for (let st = 0; st < 12; st++) s.n(glass, 27, st, st % 2 ? 'E6' : 'B5', 1, 0.3 + st * 0.03);
  s.silence(27, 12, 28, 0);

  // Waking? The theme once more, alone on a violin, with the cello on the tonic... and the top.
  s.line(vln, 28, 0, 'E5:16 | D5:12 C5:4 | B4:32', 0.46, { legato: true });
  s.n(vc, 28, 0, 'E2', 32, 0.4); s.n(vc, 30, 0, 'C3', 32, 0.36);
  s.n(ob, 28, 0, 'E1', 32, 0.4);
  each(28, 32, (b, i) => spin(b, 0.4 - i * 0.05, 4));
  // Does it fall? The last tick is left hanging a beat early.
  s.n(glass, 31, 14, 'B5', 2, 0.26);
  return s.build('violas');
}

// =================================================================================================
// 2. Tidewater Signal - A minor, 66 BPM, 32 bars. Castaways on an island that isn't what it seems:
//    surf, a glass-harp lullaby, sliding trombone shrieks, and banging on hollow metal.
// =================================================================================================
function tidewaterSignal() {
  const s = new Score({ slug: 'tidewater-signal', name: 'Tidewater Signal', bpm: 66, bars: 32 });
  const surf = s.add('surf', 'Surf on the reef', 'water', 0.45, water('weather', { weatherSource: 'surf', dynamics: 0.6 }), { space: 0.1, humanize: 0 });
  const harp = s.add('glass', 'Glass harp - lullaby', 'water', 0.36, water('glass', { dynamics: 0.6 }), { space: 0.4, humanize: 0.12 });
  const eerie = s.add('glassviolin', 'Glass violin - the signal', 'strings', 0.13, pm('glass', { bowForce: 0.34, bowVelocity: 0.35, bowPosition: 0.06, vibratoDepth: 3, bowNoise: 0.3 }), { space: 0.55 });
  const vln = s.add('violins', 'Violins', 'strings', 0.19, pm('violin', { vibratoDepth: 16, vibratoDelay: 0.25 }), { space: 0.35 });
  const vla = s.add('violas', 'Violas', 'strings', 0.17, pm('viola', { bowForce: 0.45, vibratoDepth: 10 }));
  const vc = s.add('cello', 'Solo cello', 'strings', 0.23, pm('cello', { vibratoDepth: 20, vibratoRate: 5, bowForce: 0.55, slide: 0.12 }));
  const cb = s.add('basses', 'Basses - pizzicato heartbeat', 'strings', 0.32, pm('bass', { articulation: 'pizzicato', ring: 0.6 }), { space: 0.2 });
  const tbn = s.add('trombones', 'Trombone shrieks', 'brass', 0.14, brass('trombone', 'glissando', { breath: 0.8, slideTime: 0.45, release: 0.3 }), { space: 0.4 });
  const hn = s.add('horns', 'Horns - campfire chorale', 'brass', 0.15, brass('horn', 'chorale', { breath: 0.4 }), { space: 0.45 });
  const kit = s.add('metal', 'Matter - hollow metal and toms', 'matter', 0.3, matter('war', 'sticks', { dynamics: 8, mix: { kick: 3, snare: 1, 'rack-tom': 2.5, 'floor-tom': 3, crash: 1.5, ride: 3.5, splash: 1.5 } }), { space: 0.3, humanize: 0 });

  s.section('Shoreline', 0, 4); s.section('Something in the trees', 4, 4); s.section('By the fire', 8, 4);
  s.section('By the fire, answered', 12, 4); s.section('The hatch', 16, 4); s.section('We have to go back', 20, 4);
  s.section('Everyone together', 24, 4); s.section('The signal', 28, 4);

  // Am | F | C/G | E  and a warmer  F | C | Dm | E  for the second half of the theme.
  const A = [['A2', 'E3', 'C4'], ['F2', 'C3', 'A3'], ['G2', 'E3', 'C4'], ['E2', 'B2', 'G#3']];
  const B = [['F2', 'C3', 'A3'], ['C3', 'G3', 'E4'], ['D3', 'F3', 'A3'], ['E2', 'B2', 'G#3']];

  // Surf breathes in long waves through the intro, the hatch and the end.
  [[0, 4, 0.5], [4, 4, 0.6], [8, 4, 0.3], [12, 4, 0.28], [28, 4, 0.6]].forEach(([b, len, v]) => s.n(surf, b, 0, 'C4', len * 16, v));
  // The signal: a high, glassy cluster that won't resolve.
  s.n(eerie, 0, 0, 'E6', 32, 0.4); s.n(eerie, 2, 0, 'F6', 32, 0.44);
  // A pizzicato heartbeat: long-short, like something waiting.
  const heart = (b, pitch, v) => { s.n(cb, b, 0, pitch, 3, v); s.n(cb, b, 3, pitch, 3, v - 0.12); };
  each(0, 8, (b, i) => heart(b, i % 4 === 3 ? 'E1' : 'A1', 0.52 + i * 0.03));

  // Something in the trees: trombones slide up out of nowhere, then metal is struck.
  const shriek = (b, st, from, to, v) => { s.n(tbn, b, st, from, 3, v - 0.15); s.n(tbn, b, st + 2.5, to, 6, v); };
  shriek(5, 4, 'A2', 'E3', 0.8); shriek(7, 0, 'Bb2', 'F3', 0.86);
  [[5, 12, K.bell, 0.7], [6, 0, K.floor, 0.8], [6, 6, K.bell, 0.55], [7, 8, K.floor, 0.85], [7, 11, K.rack, 0.7], [7, 14, K.bell, 0.8]]
    .forEach(([b, st, row, v]) => s.n(kit, b, st, row, 1, v));
  s.n(vc, 4, 0, 'A2', 16, 0.34); s.n(vc, 5, 0, 'Bb2', 16, 0.4); s.n(vc, 6, 0, 'A2', 32, 0.36);
  s.n(eerie, 4, 0, 'E6', 16, 0.34); s.n(eerie, 6, 0, 'D#6', 32, 0.4);

  // By the fire: the lullaby on glasses, the cello answering, violas holding the chords.
  const lullaby = 'A5:4 E5:4 C6:6 B5:2 | A5:4 C5:4 F5:8 | E5:4 G5:4 C6:4 D6:4 | B5:12 r:4';
  const lullaby2 = 'A5:4 C6:4 F6:6 E6:2 | E6:4 D6:2 C6:2 G5:8 | F5:4 A5:4 D6:4 C6:4 | B5:8 G#5:4 E5:4';
  s.line(harp, 8, 0, lullaby, 0.55); s.line(harp, 12, 0, lullaby2, 0.58);
  s.line(vc, 9, 0, 'r:8 A3:4 G3:4 | F3:8 E3:4 C3:4 | B2:16', 0.52, { legato: true });
  s.line(vc, 13, 0, 'r:8 E4:4 D4:4 | C4:8 B3:4 A3:4 | G#3:12 B3:4', 0.58, { legato: true });
  each(8, 16, (b, i) => {
    const c = pick(i < 4 ? A : B, i);
    const viola = p => (m(p) < 48 ? m(p) + 12 : m(p)); // the viola's lowest string is C3
    s.n(vla, b, 0, viola(c[1]), 15, 0.38); s.n(vla, b, 0.1, c[2], 15, 0.35);
    s.n(cb, b, 0, m(c[0]) - 12, 4, 0.5); s.n(cb, b, 8, m(c[0]) - 12, 4, 0.4);
  });

  // The hatch: the heartbeat doubles, the toms pound, the trombones pile up, and it slams shut.
  each(16, 20, (b, i) => {
    for (let st = 0; st < 16; st += 2) s.n(cb, b, st, st % 4 ? 'E2' : 'A1', 2, 0.5 + i * 0.07);
    [0, 3, 6, 10, 12].forEach(st => s.n(kit, b, st, st === 0 ? K.floor : K.rack, 1, 0.52 + i * 0.1));
    if (i >= 1) s.n(kit, b, 14, K.bell, 1, 0.6 + i * 0.08);
    s.n(vla, b, 0, pick(['E4', 'F4', 'F#4', 'G4'], i), 16, 0.45 + i * 0.08);
    s.n(vln, b, 0, pick(['A4', 'Bb4', 'B4', 'C5'], i), 16, 0.45 + i * 0.08);
    s.n(vc, b, 0, 'A2', 16, 0.5 + i * 0.08);
  });
  shriek(17, 8, 'A2', 'E3', 0.82); shriek(18, 4, 'Bb2', 'F3', 0.88); shriek(19, 0, 'B2', 'F#3', 0.92);
  s.n(eerie, 18, 0, 'A6', 28, 0.5);
  s.n(kit, 19, 12, K.crash, 1, 0.9); s.n(kit, 19, 12, K.kick, 1, 0.95); s.n(kit, 19, 12, K.floor, 1, 0.95);
  s.silence(19, 13, 20, 0);

  // We have to go back: the lullaby in the violins, horns below it like a warm fire.
  s.line(vln, 20, 0, lullaby.replace(/(\D+)(\d):/g, (_, n, o) => `${n}${o - 1}:`), 0.54, { legato: true });
  s.line(harp, 20, 0, 'r:8 C6:8 | r:8 F6:8 | r:8 D6:8 | B5:16', 0.45);
  each(20, 24, (b, i) => {
    const c = pick(A, i);
    s.chord(hn, b, 0, [m(c[1]) + 12, m(c[2])].filter(p => p <= 77), 15, 0.5);
    s.n(vc, b, 0, c[0], 15, 0.5); s.n(cb, b, 0, m(c[0]) - 12, 6, 0.48);
  });

  // Everyone together: the second half of the theme, full strings, horns on the tune.
  s.line(vln, 24, 0, lullaby2.replace(/(\D+)(\d):/g, (_, n, o) => `${n}${o - 1}:`), 0.66, { legato: true });
  s.line(hn, 24, 0, 'A4:4 C5:4 F4:8 | E4:8 G4:8 | F4:4 A4:4 D4:8 | E4:16', 0.62, { legato: true });
  each(24, 28, (b, i) => {
    const c = pick(B, i);
    s.n(vla, b, 0, c[2], 15, 0.52); s.n(vc, b, 0, c[1], 15, 0.55);
    s.n(cb, b, 0, m(c[0]) - 12, 6, 0.58); s.n(cb, b, 8, m(c[0]) - 12, 4, 0.46);
    s.n(kit, b, 0, K.floor, 1, 0.5);
  });
  s.n(kit, 27, 8, K.crash, 8, 0.5);

  // The signal: one last phrase on the glasses over the surf, a swell that grows and grows ...
  s.line(harp, 28, 0, 'A5:4 E5:4 C6:6 B5:2 | A5:16', 0.5);
  s.n(vc, 28, 0, 'A2', 32, 0.4);
  s.n(eerie, 29, 0, 'E6', 40, 0.3); s.n(eerie, 30, 0, 'F6', 24, 0.42);
  s.n(vla, 30, 0, 'Bb4', 31, 0.3); s.n(vln, 30, 0, 'B5', 31, 0.3);
  s.n(tbn, 30, 0, 'A2', 8, 0.5); s.n(tbn, 30, 7.5, 'D#3', 8, 0.7); s.n(tbn, 30, 15.5, 'A3', 15, 0.9);
  each(30, 32, (b, i) => [0, 4, 8, 10, 12, 13, 14, 15].forEach((st, j) => s.n(kit, b, st, j % 2 ? K.rack : K.floor, 1, 0.45 + i * 0.2 + j * 0.03)));
  // ... and cuts to black on the last beat.
  s.n(kit, 31, 12, K.crash, 1, 1); s.n(kit, 31, 12, K.kick, 1, 1); s.n(cb, 31, 12, 'A1', 2, 0.9);
  s.silence(31, 13, 32, 0);
  return s.build('glass');
}

// =================================================================================================
// 3. Ashen Crown - D Dorian, 92 BPM, 64 bars. A realm's theme: a 3+3+2 cello gallop, a Hardanger
//    fiddle folk melody, war drums, and brass that grows from one horn into the full court.
// =================================================================================================
function ashenCrown() {
  const s = new Score({ slug: 'ashen-crown', name: 'Ashen Crown', bpm: 92, bars: 64 });
  const fid = s.add('fiddle', 'Hardanger fiddle - theme', 'strings', 0.2, pm('hardanger', { sympathetic: ['D4', 'A4', 'D5', 'F5', 'A5'].map(hz), vibratoDepth: 9, bowForce: 0.55, bowVelocity: 0.58 }), { space: 0.35, humanize: 0.14 });
  const vln = s.add('violins', 'Violins', 'strings', 0.19, pm('violin', { vibratoDepth: 14 }));
  const vla = s.add('violas', 'Violas', 'strings', 0.17, pm('viola', { bowForce: 0.56, bowVelocity: 0.6 }));
  const vc = s.add('cellos', 'Cellos - gallop', 'strings', 0.24, pm('cello', { bowForce: 0.66, bowVelocity: 0.66, bowPosition: 0.1, vibratoDepth: 6, attackSkill: 1 }), { space: 0.22, humanize: 0.06 });
  const cb = s.add('basses', 'Basses', 'strings', 0.26, pm('bass', { bowForce: 0.62, vibratoDepth: 4 }), { space: 0.22 });
  const hn = s.add('horns', 'Horns', 'brass', 0.17, brass('horn', 'section', { breath: 0.62 }), { space: 0.4 });
  const tpt = s.add('trumpets', 'Trumpets - the court', 'brass', 0.12, brass('trumpet', 'fanfare'), { space: 0.4 });
  const tbn = s.add('trombones', 'Trombones', 'brass', 0.15, brass('trombone', 'section', { breath: 0.66 }), { space: 0.35 });
  const tuba = s.add('tuba', 'Tuba', 'brass', 0.17, brass('tuba', 'section', { breath: 0.62 }), { space: 0.3 });
  const war = s.add('drums', 'Matter - war drums', 'matter', 0.32, matter('war', 'mallets', { dynamics: 9 }), { space: 0.3, humanize: 0.05 });

  const names = ['Cold throne', 'The gallop', 'A song from the north', 'The song, answered', 'Banners', 'Banners raised',
    'Snowfall', 'Mustering', 'The Ashen Crown', 'Long live', 'Winter march', 'Winter march, ascending',
    'Last stand', 'Last stand, fire', 'The fall', 'Embers'];
  names.forEach((name, i) => s.section(name, i * 4, 4));

  // Dm | C | Bb | A  (the gallop), and the bridge  Bb | F | C | Dm.
  const main = [
    { root: 'D2', gallop: ['D3', 'A2', 'D3', 'F3', 'E3', 'C#3'], tones: ['D4', 'F4', 'A4'] },
    { root: 'C2', gallop: ['C3', 'G2', 'C3', 'E3', 'D3', 'B2'], tones: ['C4', 'E4', 'G4'] },
    { root: 'Bb1', gallop: ['Bb2', 'F2', 'Bb2', 'D3', 'C3', 'A2'], tones: ['Bb3', 'D4', 'F4'] },
    { root: 'A1', gallop: ['A2', 'E2', 'A2', 'C#3', 'B2', 'G#2'], tones: ['A3', 'C#4', 'E4'] },
  ];
  const bridge = [
    { root: 'Bb1', gallop: ['Bb2', 'F2', 'Bb2', 'D3', 'C3', 'A2'], tones: ['Bb3', 'D4', 'F4'] },
    { root: 'F1', gallop: ['F2', 'C3', 'F2', 'A2', 'G2', 'E2'], tones: ['A3', 'C4', 'F4'] },
    { root: 'C2', gallop: ['C3', 'G2', 'C3', 'E3', 'D3', 'B2'], tones: ['G3', 'C4', 'E4'] },
    { root: 'D2', gallop: ['D3', 'A2', 'D3', 'F3', 'E3', 'C#3'], tones: ['A3', 'D4', 'F4'] },
  ];
  const harmonyAt = b => (b >= 24 && b < 28) || (b >= 40 && b < 48) ? pick(bridge, b) : pick(main, b);
  // The gallop: 3 + 3 + 2 sixteenths, twice a bar - the thing that makes it ride.
  const GROUPS = [[0, 3], [3, 3], [6, 2], [8, 3], [11, 3], [14, 2]];
  const gallop = (t, b, vel, up = 0) => GROUPS.forEach(([st, len], i) =>
    s.n(t, b, st, m(harmonyAt(b).gallop[i]) + up, len - 0.4, vel + (i % 3 === 0 ? 0.1 : 0)));
  const drums = (b, level) => {
    if (level >= 1) { s.n(war, b, 0, K.floor, 1, 0.6 + level * 0.08); s.n(war, b, 8, K.floor, 1, 0.5 + level * 0.06); }
    if (level >= 2) { [3, 6, 11, 14].forEach(st => s.n(war, b, st, K.rack, 1, 0.42 + level * 0.06)); s.n(war, b, 0, K.kick, 1, 0.8); }
    if (level >= 3) { s.n(war, b, 8, K.kick, 1, 0.75); if (b % 4 === 3) [12, 13, 14, 15].forEach((st, i) => s.n(war, b, st, K.floor, 1, 0.6 + i * 0.1)); }
  };

  // The theme - a folk tune in Dorian (B natural), rising a sixth and coming home.
  const themeA = 'D5:6 A4:2 D5:4 E5:4 | F5:6 E5:2 C5:4 D5:4 | Bb4:6 C5:2 D5:4 F5:4 | E5:12 r:4';
  const themeB = 'F5:6 G5:2 A5:4 C6:4 | B5:6 A5:2 G5:4 F5:4 | E5:4 D5:4 C5:4 Bb4:4 | A4:8 C#5:4 E5:4';
  const down = (text, n) => text.replace(/([A-G][#b]?)(\d):/g, (_, p, o) => `${p}${+o - n}:`);

  // Cold throne: a bass drone and a lonely cello quoting the first bar of the theme.
  s.n(cb, 0, 0, 'D2', 64, 0.42);
  s.line(vc, 1, 0, down('D5:6 A4:2 D5:4 E5:4 | F5:6 E5:2 C5:4 D5:4', 2), 0.46, { legato: true });
  s.n(war, 0, 0, K.floor, 1, 0.5); s.n(war, 2, 0, K.floor, 1, 0.55); s.n(war, 3, 8, K.crash, 8, 0.35);
  // The gallop arrives, cellos then violas an octave up.
  each(4, 8, (b, i) => { gallop(vc, b, 0.5 + i * 0.03); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.46); drums(b, i >= 2 ? 1 : 0); });
  each(6, 8, b => gallop(vla, b, 0.4, 12));
  // The fiddle's song over the gallop.
  s.line(fid, 8, 0, themeA, 0.6, { legato: true }); s.line(fid, 12, 0, themeB, 0.64, { legato: true });
  each(8, 16, b => { gallop(vc, b, 0.54); gallop(vla, b, 0.42, 12); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.5); drums(b, 1); });
  // Banners: horns take the tune, violins sing a counter-line above, the low brass holds the ground.
  s.line(hn, 16, 0, down(themeA, 1), 0.66, { legato: true }); s.line(hn, 20, 0, down(themeB, 1), 0.7, { legato: true });
  s.line(vln, 16, 0, 'A5:16 | A5:8 G5:8 | F5:16 | E5:16', 0.52, { legato: true });
  s.line(vln, 20, 0, 'C6:16 | D6:8 B5:8 | C6:8 Bb5:8 | A5:16', 0.58, { legato: true });
  each(16, 24, (b, i) => {
    gallop(vc, b, 0.58); gallop(vla, b, 0.46, 12); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.56);
    s.n(tuba, b, 0, harmonyAt(b).root, 14, 0.5); s.n(tbn, b, 0, m(harmonyAt(b).root) + 12, 14, 0.46);
    drums(b, i < 4 ? 2 : 3);
  });
  s.n(war, 16, 0, K.crash, 1, 0.7); s.n(war, 20, 0, K.crash, 1, 0.75);
  // Snowfall: everything drops away but the fiddle and a drone - bridge harmony.
  s.line(fid, 24, 0, 'D5:8 F5:8 | E5:8 C5:8 | E5:6 D5:2 C5:8 | D5:16', 0.5, { legato: true });
  each(24, 28, b => { s.n(vla, b, 0, harmonyAt(b).tones[1], 16, 0.34); s.n(cb, b, 0, harmonyAt(b).root, 16, 0.36); });
  // Mustering: the gallop returns pizzicato-short and low, drums and trombones rising.
  each(28, 32, (b, i) => {
    gallop(vc, b, 0.5 + i * 0.06); drums(b, i < 2 ? 1 : 2); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.5 + i * 0.05);
    s.n(tbn, b, 0, harmonyAt(b).tones[0].replace(/\d$/, '3'), 15, 0.4 + i * 0.1);
  });
  s.n(war, 31, 0, K.crash, 16, 0.55);

  // The Ashen Crown: tutti. Fiddle and violins in octaves, horns in harmony, trumpets calling.
  const tutti = (from, text, textB, vel) => {
    s.line(fid, from, 0, text, vel, { legato: true }); s.line(vln, from, 0, down(text, 1), vel - 0.04, { legato: true });
    s.line(hn, from, 0, down(text, 1), vel, { legato: true });
    s.line(fid, from + 4, 0, textB, vel + 0.04, { legato: true }); s.line(vln, from + 4, 0, down(textB, 1), vel, { legato: true });
    s.line(hn, from + 4, 0, down(textB, 1), vel + 0.04, { legato: true });
  };
  tutti(32, themeA, themeB, 0.72);
  const fanfare = b => s.line(tpt, b, 0, 'D5:2 D5:1 D5:1 A5:4 r:8', 0.72);
  [33, 35, 37, 39].forEach(fanfare);
  each(32, 40, (b, i) => {
    gallop(vc, b, 0.64); gallop(vla, b, 0.52, 12); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.62);
    s.n(tuba, b, 0, harmonyAt(b).root, 14, 0.62); s.chord(tbn, b, 0, [m(harmonyAt(b).root) + 12, m(harmonyAt(b).root) + 19], 14, 0.58);
    drums(b, 3);
  });
  s.n(war, 32, 0, K.crash, 1, 0.9); s.n(war, 36, 0, K.crash, 1, 0.85);

  // Winter march: the bridge harmony as a slow brass chorale; violins soar, drums in half time.
  each(40, 48, (b, i) => {
    const h = harmonyAt(b);
    s.n(tuba, b, 0, h.root, 15, 0.52 + i * 0.03); s.chord(tbn, b, 0, [m(h.tones[0]) - 12, m(h.tones[1]) - 12].filter(p => p >= 40), 15, 0.5 + i * 0.03);
    s.chord(hn, b, 0, h.tones.slice(0, 2), 15, 0.52 + i * 0.03);
    s.n(cb, b, 0, h.root, 15, 0.5); s.n(vc, b, 0, m(h.root) + 12, 15, 0.52);
    s.n(war, b, 0, K.floor, 1, 0.6 + i * 0.03); if (i >= 4) s.n(war, b, 8, K.rack, 1, 0.55);
  });
  s.line(vln, 40, 0, 'D6:8 C6:4 Bb5:4 | A5:16 | G5:8 A5:4 C6:4 | D6:16', 0.6, { legato: true });
  s.line(vln, 44, 0, 'F6:8 E6:4 D6:4 | C6:16 | E6:8 D6:4 C6:4 | D6:8 E6:8', 0.66, { legato: true, crescendo: 0.1 });
  s.line(vla, 44, 0, 'F4:16 | F4:16 | G4:16 | A4:16', 0.48, { legato: true });
  s.n(war, 47, 0, K.crash, 16, 0.6);

  // Last stand: the theme in the brass at full cry; the strings gallop underneath.
  s.line(tpt, 48, 0, themeA, 0.8);
  s.line(hn, 48, 0, down(themeA, 1), 0.8, { legato: true });
  s.line(tpt, 52, 0, themeB, 0.84);
  s.line(hn, 52, 0, down(themeB, 1), 0.84, { legato: true });
  s.line(vln, 48, 0, themeA, 0.7, { legato: true });
  s.line(vln, 52, 0, themeB, 0.74, { legato: true });
  each(48, 56, b => {
    gallop(vc, b, 0.68); gallop(vla, b, 0.56, 12); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.66);
    s.n(tuba, b, 0, harmonyAt(b).root, 14, 0.7); s.chord(tbn, b, 0, [m(harmonyAt(b).root) + 12, m(harmonyAt(b).root) + 19], 14, 0.66);
    drums(b, 3);
  });
  s.n(war, 48, 0, K.crash, 1, 0.95); s.n(war, 52, 0, K.crash, 1, 0.95);
  // The fall: the gallop thins to the cellos alone, slowing to long notes.
  each(56, 58, (b, i) => { gallop(vc, b, 0.6 - i * 0.1); s.n(cb, b, 0, harmonyAt(b).root, 15, 0.5); drums(b, 1); });
  s.line(vc, 58, 0, 'Bb2:16 | A2:16', 0.5, { legato: true });
  s.line(hn, 56, 0, 'D4:12 C4:4 | Bb3:16 | A3:32', 0.56, { legato: true });
  s.n(cb, 58, 0, 'A1', 32, 0.4);
  s.n(war, 56, 0, K.floor, 1, 0.8); s.n(war, 58, 0, K.floor, 1, 0.6); s.n(war, 59, 8, K.floor, 1, 0.4);
  // Embers: the fiddle alone over an open fifth. No third: the realm's fate is left undecided.
  s.line(fid, 60, 0, 'D5:6 A4:2 D5:4 E5:4 | F5:6 E5:2 C5:4 A4:4 | D5:32', 0.5, { legato: true });
  s.n(cb, 60, 0, 'D2', 64, 0.36); s.n(vla, 61, 0, 'A3', 48, 0.3);
  return s.build('fiddle');
}

// =================================================================================================
// 4. Rooftop Pursuit - F minor rising to F# minor, 140 BPM, 64 bars. A chase: col legno ticks,
//    spiccato strings, a rock kit played like taiko, brass stabs and a key change for the last sprint.
// =================================================================================================
function rooftopPursuit() {
  const s = new Score({ slug: 'rooftop-pursuit', name: 'Rooftop Pursuit', bpm: 140, bars: 64 });
  const vln = s.add('violins', 'Violins - spiccato', 'strings', 0.18, pm('violin', { bowForce: 0.6, bowVelocity: 0.7, bowPosition: 0.08, vibratoDepth: 5, attackSkill: 1 }), { space: 0.22, humanize: 0.05 });
  const vla = s.add('violas', 'Violas - off-beats', 'strings', 0.16, pm('viola', { bowForce: 0.6, bowVelocity: 0.66, vibratoDepth: 4 }), { space: 0.22, humanize: 0.05 });
  const legno = s.add('legno', 'Cellos - col legno', 'strings', 0.26, pm('cello', { articulation: 'colLegno', brightness: 0.45, damping: 0.3 }), { space: 0.18, humanize: 0 });
  const vc = s.add('cellos', 'Cellos and basses - drive', 'strings', 0.24, pm('cello', { bowForce: 0.7, bowVelocity: 0.72, bowPosition: 0.09, vibratoDepth: 3, attackSkill: 1 }), { space: 0.18, humanize: 0.04 });
  const cb = s.add('basses', 'Basses', 'strings', 0.26, pm('bass', { bowForce: 0.7, bowVelocity: 0.66, vibratoDepth: 0 }), { space: 0.15, humanize: 0.04 });
  const hn = s.add('horns', 'Horns - motif', 'brass', 0.16, brass('horn', 'fanfare', { breath: 0.72 }), { space: 0.35 });
  const tpt = s.add('trumpets', 'Trumpets - sprint', 'brass', 0.11, brass('trumpet', 'fanfare'), { space: 0.35 });
  const tbn = s.add('trombones', 'Trombones - stabs', 'brass', 0.15, brass('trombone', 'rough', { breath: 0.85, attackSkill: 0.6 }), { space: 0.3 });
  const kit = s.add('drums', 'Matter - pursuit percussion', 'matter', 0.3, matter('rock', 'sticks', { dynamics: 8, beater: 'plastic' }), { space: 0.2, humanize: 0.04 });
  const drip = s.add('drain', 'Water - drainpipe drips', 'water', 0.3, water('drip', { dynamics: 0.8 }), { space: 0.35, humanize: 0.2 });

  const names = ['Alarm', 'Footsteps', 'The chase', 'Over the rail', 'Rooftops', 'The jump', 'Full pursuit', 'Neck and neck',
    'Hiding in the drain', 'Spotted', 'Crossfire', 'Crossfire, closing', 'Final sprint', 'Final sprint, higher', 'The edge', 'Gone'];
  names.forEach((name, i) => s.section(name, i * 4, 4));

  // Fm | Db | Bb m | C  (then up a semitone to F#m for the last sprint).
  const prog = [['F', 'Ab', 'C'], ['Db', 'F', 'Ab'], ['Bb', 'Db', 'F'], ['C', 'E', 'G']];
  const root = (b, oct) => m(`${pick(prog, b)[0]}${oct}`) + (b >= 52 ? 1 : 0);
  // The basses' lowest string is E1: roots below it are played an octave up.
  const bassRoot = b => { const r = root(b, 1); return r < 28 ? r + 12 : r; };
  const tone = (b, i, oct) => m(`${pick(prog, b)[i]}${oct}`) + (b >= 52 ? 1 : 0);

  // Spiccato sixteenths on the violins: an arpeggio that turns back on itself.
  const spiccato = (b, vel) => [0, 1, 2, 1, 0, 1, 2, 1, 0, 1, 2, 1, 2, 1, 0, 1].forEach((i, st) =>
    s.n(vln, b, st, tone(b, i, 5), 0.7, vel + (st % 4 === 0 ? 0.1 : 0)));
  const offbeats = (b, vel) => [2, 6, 10, 14].forEach(st => { s.n(vla, b, st, tone(b, 1, 4), 1.5, vel); s.n(vla, b, st, tone(b, 2, 4), 1.5, vel - 0.04); });
  const drive = (b, vel) => { for (let st = 0; st < 16; st += 2) s.n(vc, b, st, st % 8 === 6 ? root(b, 3) : root(b, 2), 1.6, vel + (st % 8 ? 0 : 0.1)); s.n(cb, b, 0, bassRoot(b), 7.5, vel); s.n(cb, b, 8, bassRoot(b), 7.5, vel - 0.05); };
  const ticks = (b, vel) => [0, 3, 6, 8, 11, 14].forEach(st => s.n(legno, b, st, root(b, 3), 1, vel));
  const beat = (b, level) => {
    s.n(kit, b, 0, K.kick, 1, 0.9); s.n(kit, b, 6, K.kick, 1, 0.7); s.n(kit, b, 10, K.kick, 1, 0.78);
    if (level >= 1) [4, 12].forEach(st => s.n(kit, b, st, K.snare, 1, 0.8));
    if (level >= 2) { [2, 7, 9, 15].forEach(st => s.n(kit, b, st, st > 8 ? K.floor : K.rack, 1, 0.62)); for (let st = 0; st < 16; st += 2) s.n(kit, b, st, K.ride, 1, st % 4 ? 0.34 : 0.46); }
    if (b % 4 === 3 && level >= 1) [12, 13, 14, 15].forEach((st, i) => s.n(kit, b, st, i < 2 ? K.rack : K.floor, 1, 0.66 + i * 0.08));
  };
  // The motif: three notes up, one hammered down - the pursuer.
  // (It is transposed as MIDI numbers, which `m` accepts.)
  const motif = (t, b, vel, shift = 0) => s.line(t, b, 0, 'C4:3 Db4:3 F4:2 C4:8 | Ab3:3 Bb3:3 C4:2 Db4:4 C4:4'
    .replace(/([A-G][#b]?\d):/g, (_, p) => `${m(p) + shift}:`), vel);

  // Alarm: col legno ticks and a snare-edge clock, nothing else.
  each(0, 4, (b, i) => { ticks(b, 0.5 + i * 0.05); [0, 4, 8, 12].forEach(st => s.n(kit, b, st, K.edge, 1, 0.4 + (st ? 0 : 0.15))); });
  // Footsteps: the basses and kick join.
  each(4, 8, (b, i) => { ticks(b, 0.6); beat(b, 0); s.n(cb, b, 0, bassRoot(b), 7.5, 0.58); s.n(cb, b, 8, bassRoot(b), 7.5, 0.5); });
  // The chase: spiccato and drive; the horns name the pursuer.
  each(8, 16, (b, i) => { spiccato(b, 0.46 + (i >= 4 ? 0.06 : 0)); drive(b, 0.56); ticks(b, 0.46); beat(b, i >= 4 ? 2 : 1); });
  [8, 10, 12, 14].forEach((b, i) => motif(hn, b, 0.66 + i * 0.03));
  // Rooftops: the trombones stab the offbeats.
  const stabs = (b, vel) => [3, 6, 11].forEach(st => s.chord(tbn, b, st, [root(b, 2) + 12, tone(b, 2, 3)].filter(p => p <= 74), 1.2, vel));
  each(16, 24, (b, i) => { spiccato(b, 0.52); offbeats(b, 0.5); drive(b, 0.6); beat(b, 2); stabs(b, 0.68 + (i % 4) * 0.04); });
  [16, 18].forEach(b => motif(hn, b, 0.72));
  // The jump: the drive climbs chromatically and everything holds its breath on the last beat.
  s.line(hn, 20, 0, 'F4:16 | Gb4:16 | G4:16 | Ab4:12', 0.7, { legato: true });
  s.n(kit, 23, 0, K.crash, 1, 0.8);
  s.silence(23, 12, 24, 0);
  // Full pursuit: the motif in horns and trumpets, everything playing.
  each(24, 32, (b, i) => { spiccato(b, 0.58); offbeats(b, 0.56); drive(b, 0.66); ticks(b, 0.5); beat(b, 2); stabs(b, 0.74); });
  [24, 26, 28, 30].forEach(b => { motif(hn, b, 0.78); motif(tpt, b, 0.7, 12); });
  s.n(kit, 24, 0, K.crash, 1, 0.9); s.n(kit, 28, 0, K.crash, 1, 0.85);

  // Hiding in the drain: only drips, a held cello and a heartbeat kick.
  each(32, 36, (b, i) => {
    [[0, 'C6'], [5, 'Ab5'], [9, 'F6'], [14, 'Db6']].forEach(([st, p], j) => (i + j) % 2 === 0 && s.n(drip, b, st, p, 2, 0.6));
    s.n(kit, b, 0, K.kick, 1, 0.5); s.n(kit, b, 3, K.kick, 1, 0.38);
  });
  s.n(vc, 32, 0, 'F2', 32, 0.36); s.n(vc, 34, 0, 'Gb2', 32, 0.4);
  s.n(vln, 33, 0, 'C6', 48, 0.26);
  // Spotted: ticks, then the whole engine starts again.
  each(36, 40, (b, i) => { ticks(b, 0.48 + i * 0.07); if (i >= 2) { spiccato(b, 0.44 + i * 0.03); beat(b, 1); } });
  s.n(drip, 36, 0, 'C6', 2, 0.7);
  s.line(hn, 38, 0, 'C4:16 | Db4:8 E4:8', 0.62, { legato: true, crescendo: 0.2 });
  // Crossfire: new harmony underneath, trombones and horns trading.
  each(40, 48, (b, i) => { spiccato(b, 0.58); offbeats(b, 0.58); drive(b, 0.68); ticks(b, 0.5); beat(b, 2); if (i % 2) stabs(b, 0.76); });
  [40, 42, 44, 46].forEach(b => motif(hn, b, 0.8));
  s.line(tpt, 44, 0, 'F4:4 Ab4:4 C5:8 | Db5:4 C5:4 Ab4:8 | Bb4:4 Db5:4 F5:8 | E5:16', 0.72);
  s.n(kit, 44, 0, K.crash, 1, 0.85);
  // Final sprint: up a semitone (F#m); trumpets lead, horns and trombones underneath.
  each(48, 52, (b, i) => { spiccato(b, 0.6); offbeats(b, 0.6); drive(b, 0.7); beat(b, 2); stabs(b, 0.78); });
  [48, 50].forEach(b => { motif(hn, b, 0.82); motif(tpt, b, 0.76, 12); });
  each(52, 56, (b, i) => { spiccato(b, 0.64); offbeats(b, 0.62); drive(b, 0.74); ticks(b, 0.52); beat(b, 2); stabs(b, 0.82); });
  [52, 54].forEach(b => { motif(hn, b, 0.86, 1); motif(tpt, b, 0.8, 13); });
  s.n(kit, 52, 0, K.crash, 1, 0.95); s.n(kit, 52, 0, K.splash, 1, 0.7);
  // The edge: a held chord over rolling toms, then two hits and it's over.
  s.chord(hn, 56, 0, ['F#3', 'C#4', 'A4'], 64, 0.8); s.chord(tbn, 56, 0, ['F#2', 'C#3'], 64, 0.78);
  s.line(tpt, 56, 0, 'A5:16 | G#5:16 | A5:16 | B5:16', 0.8, { legato: true });
  s.n(vln, 56, 0, 'F#5', 64, 0.6); s.n(vla, 56, 0, 'C#5', 64, 0.56); s.n(vc, 56, 0, 'F#3', 64, 0.62); s.n(cb, 56, 0, 'F#1', 64, 0.64);
  each(56, 60, (b, i) => { for (let st = 0; st < 16; st += 2) s.n(kit, b, st, st % 4 ? K.rack : K.floor, 1, 0.5 + i * 0.08); });
  s.n(kit, 56, 0, K.crash, 1, 0.95);
  // Gone.
  [[60, 0], [60, 6]].forEach(([b, st]) => {
    s.chord(tbn, b, st, ['F#2', 'C#3'], 1.5, 0.9); s.chord(hn, b, st, ['F#3', 'A3', 'C#4'], 1.5, 0.88);
    s.n(tpt, b, st, 'F#5', 1.5, 0.86); s.n(cb, b, st, 'F#1', 1.5, 0.9); s.n(vc, b, st, 'F#2', 1.5, 0.9);
    s.n(vln, b, st, 'F#5', 1.5, 0.8); s.n(kit, b, st, K.kick, 1, 1); s.n(kit, b, st, K.floor, 1, 0.95);
  });
  s.n(kit, 60, 6, K.crash, 1, 1);
  s.n(legno, 61, 0, 'F#3', 1, 0.4); s.n(legno, 61, 3, 'F#3', 1, 0.3); s.n(legno, 61, 6, 'F#3', 1, 0.2);
  s.n(drip, 62, 4, 'C#6', 2, 0.55);
  return s.build('violins');
}

// =================================================================================================
// 5. Lanterns Over the Sound - D major, 76 BPM, 32 bars. The end-credits cue: a brook, glass-harp
//    arpeggios, a hymn passed from solo cello to the whole orchestra, and a quiet last lantern.
// =================================================================================================
function lanterns() {
  const s = new Score({ slug: 'lanterns-over-the-sound', name: 'Lanterns Over the Sound', bpm: 76, bars: 32 });
  const brook = s.add('brook', 'Brook', 'water', 0.5, water('weather', { weatherSource: 'brook', dynamics: 0.5 }), { space: 0.1, humanize: 0 });
  const harp = s.add('glass', 'Glass harp - arpeggios', 'water', 0.3, water('glass', { dynamics: 0.5 }), { space: 0.4, humanize: 0.1 });
  const vln1 = s.add('violins1', 'Violins I', 'strings', 0.19, pm('violin', { vibratoDepth: 16, vibratoDelay: 0.2 }), { space: 0.35 });
  const vln2 = s.add('violins2', 'Violins II', 'strings', 0.15, pm('violin', { vibratoDepth: 12, bodySeed: 7 }), { space: 0.35 });
  const vla = s.add('violas', 'Violas', 'strings', 0.16, pm('viola', { vibratoDepth: 12 }));
  const vc = s.add('cello', 'Cellos - the hymn', 'strings', 0.23, pm('cello', { vibratoDepth: 18, slide: 0.1, bowForce: 0.55 }));
  const cb = s.add('basses', 'Basses', 'strings', 0.24, pm('bass', { vibratoDepth: 5 }), { space: 0.25 });
  const hn = s.add('horns', 'Horns', 'brass', 0.16, brass('horn', 'chorale', { breath: 0.45, vibratoDepth: 6 }), { space: 0.45 });
  const tpt = s.add('trumpet', 'Trumpet - distant', 'brass', 0.1, brass('trumpet', 'chorale', { breath: 0.42, mute: 'straight', vibratoDepth: 8 }), { space: 0.55 });
  const low = s.add('lowbrass', 'Trombone and tuba', 'brass', 0.14, brass('trombone', 'chorale', { breath: 0.4 }), { space: 0.4 });
  const kit = s.add('drums', 'Matter - timpani and swells', 'matter', 0.26, matter('mallets', 'mallets', { dynamics: 6 }), { space: 0.4, humanize: 0 });

  s.section('Still water', 0, 4); s.section('The hymn', 4, 4); s.section('The hymn, second verse', 8, 4);
  s.section('Lanterns rise', 12, 4); s.section('Across the sound', 16, 4); s.section('Across the sound, together', 20, 4);
  s.section('Homecoming', 24, 4); s.section('The last lantern', 28, 4);

  // D | A/C# | Bm | G  -  D/F# | Em7 | Asus4 | A   (two bars of each line per four-bar phrase)
  const I = [
    { bass: 'D2', tones: ['A3', 'D4', 'F#4'], arp: ['D5', 'F#5', 'A5', 'D6'] },
    { bass: 'C#2', tones: ['A3', 'C#4', 'E4'], arp: ['C#5', 'E5', 'A5', 'C#6'] },
    { bass: 'B1', tones: ['B3', 'D4', 'F#4'], arp: ['B4', 'D5', 'F#5', 'B5'] },
    { bass: 'G1', tones: ['B3', 'D4', 'G4'], arp: ['G5', 'B5', 'D6', 'G6'] },
  ];
  const II = [
    { bass: 'F#2', tones: ['A3', 'D4', 'F#4'], arp: ['F#5', 'A5', 'D6', 'F#6'] },
    { bass: 'E2', tones: ['G3', 'D4', 'E4'], arp: ['E5', 'G5', 'B5', 'D6'] },
    { bass: 'A1', tones: ['A3', 'D4', 'E4'], arp: ['A5', 'D6', 'E6', 'A6'] },
    { bass: 'A1', tones: ['A3', 'C#4', 'E4'], arp: ['A5', 'C#6', 'E6', 'A6'] },
  ];
  const at = b => pick(Math.floor(b / 4) % 2 ? II : I, b);
  const arps = (b, vel, fast = false) => {
    const a = at(b).arp, order = [0, 1, 2, 3, 2, 1];
    for (let st = 0, i = 0; st < 16; st += fast ? 2 : 4, i++) s.n(harp, b, st, a[order[i % order.length]], fast ? 2 : 4, vel - (st % 8 ? 0.08 : 0));
  };
  const pad = (b, vel, t = vla) => { const c = at(b); s.n(t, b, 0, c.tones[0], 15.6, vel); s.n(t, b, 0.1, c.tones[2], 15.6, vel - 0.03); };

  // The hymn: an eight-bar tune that rises and settles (Violins I take it an octave up later).
  const hymn1 = 'F#3:8 A3:4 B3:4 | A3:8 E3:8 | F#3:4 G3:4 A3:4 D4:4 | B3:16';
  const hymn2 = 'A3:8 F#3:4 D3:4 | E3:8 G3:4 B3:4 | A3:6 G3:2 F#3:4 E3:4 | E3:16';
  const oct = (text, n) => text.replace(/([A-G][#b]?)(\d):/g, (_, p, o) => `${p}${+o + n}:`);

  s.n(brook, 0, 0, 'C4', 64, 0.5); s.n(brook, 4, 0, 'C4', 64, 0.35); s.n(brook, 24, 0, 'C4', 64, 0.35); s.n(brook, 28, 0, 'C4', 64, 0.5);
  each(0, 4, (b, i) => arps(b, 0.44 + i * 0.02));
  each(2, 4, b => pad(b, 0.34));
  // The hymn: solo cello, then again with Violins II.
  s.line(vc, 4, 0, hymn1, 0.56, { legato: true }); s.line(vc, 8, 0, hymn2, 0.58, { legato: true });
  each(4, 12, b => { arps(b, 0.4); pad(b, 0.36); s.n(cb, b, 0, at(b).bass, 15.6, 0.4); });
  s.line(vln2, 8, 0, oct(hymn2, 1).replace(/^A4:8/, 'C#5:8'), 0.38, { legato: true });
  // Lanterns rise: Violins I take the tune an octave above the cello; arps double speed; horns warm.
  s.line(vln1, 12, 0, oct(hymn1, 2), 0.58, { legato: true });
  s.line(vc, 12, 0, 'D3:16 | C#3:16 | B2:16 | G2:16', 0.46, { legato: true });
  each(12, 16, (b, i) => { arps(b, 0.42, true); pad(b, 0.4); pad(b, 0.36, hn); s.n(cb, b, 0, at(b).bass, 15.6, 0.44); });
  s.n(kit, 15, 4, K.crash, 12, 0.45); s.n(kit, 15, 12, K.floor, 1, 0.4);
  // Across the sound: tutti. Horns and Violins I on the hymn, a distant trumpet descant.
  const full = (from, text, vel) => {
    s.line(vln1, from, 0, oct(text, 2), vel, { legato: true });
    s.line(hn, from, 0, oct(text, 1), vel - 0.02, { legato: true });
    s.line(vc, from, 0, text, vel - 0.06, { legato: true });
  };
  full(16, hymn1, 0.68); full(20, hymn2, 0.72);
  s.line(tpt, 18, 0, 'F#5:16 | G5:16', 0.46, { legato: true }); s.line(tpt, 22, 0, 'E5:8 D5:8 | C#5:16', 0.5, { legato: true });
  each(16, 24, (b, i) => {
    const c = at(b);
    arps(b, 0.44, true); pad(b, 0.5); s.n(vln2, b, 0, c.tones[2].replace(/4$/, '5'), 15.6, 0.44);
    s.n(cb, b, 0, c.bass, 15.6, 0.54); s.n(low, b, 0, m(c.bass) + 12, 15.6, 0.44);
    s.n(kit, b, 0, K.floor, 1, 0.55 + (i % 4 === 0 ? 0.15 : 0));
  });
  s.n(kit, 16, 0, K.crash, 1, 0.6); s.n(kit, 20, 0, K.crash, 1, 0.66);
  [12, 13, 14, 15].forEach((st, i) => s.n(kit, 23, st, K.floor, 1, 0.45 + i * 0.1));
  // Homecoming: fragments of the tune, answering each other over the brook.
  s.line(vln1, 24, 0, 'F#5:8 A5:4 B5:4 | A5:16', 0.5, { legato: true });
  s.line(vc, 26, 0, 'F#3:4 G3:4 A3:4 D4:4 | B3:16', 0.48, { legato: true });
  each(24, 28, (b, i) => { arps(b, 0.4); pad(b, 0.36); s.n(cb, b, 0, at(b).bass, 15.6, 0.4); s.n(kit, b, 0, K.crash, 1, 0.1 + 0.05 * (i % 2)); });
  // The last lantern: the tune's opening on a solo violin, a horn under it, and the final chord.
  s.line(vln1, 28, 0, 'F#5:8 A5:4 B5:4 | A5:24 G5:4 E5:4 | D5:16', 0.46, { legato: true });
  s.n(hn, 29, 0, 'A3', 16, 0.34); s.n(hn, 30, 0, 'F#3', 32, 0.32);
  each(28, 30, b => arps(b, 0.36));
  s.chord(vla, 30, 0, ['A3', 'D4'], 32, 0.32); s.n(vc, 30, 0, 'D3', 32, 0.36); s.n(cb, 30, 0, 'D2', 32, 0.32);
  s.n(harp, 31, 0, 'D6', 4, 0.36); s.n(harp, 31, 4, 'A5', 4, 0.3); s.n(harp, 31, 8, 'F#6', 8, 0.28);
  return s.build('cello');
}

export const FILM_SCORES = [
  ['folded-city-score', foldedCity],
  ['tidewater-signal-score', tidewaterSignal],
  ['ashen-crown-score', ashenCrown],
  ['rooftop-pursuit-score', rooftopPursuit],
  ['lanterns-over-the-sound-score', lanterns],
];

for (const [slug, compose] of FILM_SCORES) {
  writeFileSync(fileURLToPath(new URL(`./${slug}.json`, import.meta.url)), JSON.stringify(compose(), null, 2) + '\n');
}
