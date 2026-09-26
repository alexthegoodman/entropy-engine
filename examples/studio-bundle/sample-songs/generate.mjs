// Rebuild the standalone DAW project JSON files: node sample-songs/generate.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import './generate-showcase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const voice = (waveform, patch = {}) => ({
  waveform, cutoff: 4000, resonance: 1, attack: 0.005, decay: 0.08, sustain: 0.6, release: 0.12,
  delayTime: 0, delayFeedback: 0.35, delayMix: 0, reverbRoomSize: 10, reverbTime: 1.2,
  reverbDamping: 0.5, reverbMix: 0, ...patch,
});
const rack = () => [
  ['Kick', 'kick', 55, 36], ['Snare', 'snare', 200, 38], ['Hihat', 'hihat', 1000, 42],
  ['Clap', 'clap', 200, 39], ['Tom', 'tom', 110, 45],
].map(([name, v, freq, midi]) => ({ name, voice: v, freq, midi, sample: null }));
const note = (row, step, length = 1, velocity = 0.8) => ({ row, step, length, velocity });
const pat = (track, name, notes, steps = 16) => ({ id: `${track}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, steps, notes });
const track = (id, name, channel, kind, waveform, rootNote, patterns, patch = {}) => ({
  id, name, kind, channel, colorIndex: channel, rootNote, scale: 'chromatic',
  rows: kind === 'drum' ? 5 : 37, ...(kind === 'drum' ? { rack: rack() } : {}),
  voice: voice(waveform, patch.voice), gain: patch.gain ?? (kind === 'drum' ? 0.52 : 0.22),
  muted: false, solo: false, patterns,
  activePatternId: patterns[0].id,
  ...(patch.physmod ? { physmod: patch.physmod } : {}),
  ...(patch.brass ? { brass: patch.brass } : {}),
});
const pm = (instrument, patch = {}) => ({
  instrument, bowForce: 0.5, bowVelocity: 0.5, bowPosition: 0.15,
  vibratoRate: 5.5, vibratoDepth: 15, damping: 0.15, brightness: 0.5,
  bodySize: { violin: 0, viola: 0.25, cello: 0.6, bass: 1 }[instrument], bodyMix: 0.35,
  audition: true, auditionNote: 60, ...patch,
});
const brass = (instrument, style = 'section', patch = {}) => ({
  instrument, style, breath: { chorale: 0.3, section: 0.5, fanfare: 0.78 }[style],
  articulation: style === 'chorale' ? 'legato' : 'tongued',
  tongue: style === 'chorale' ? 0.02 : style === 'fanfare' ? 0.002 : 0.004,
  release: 0.14, attackSkill: 1, vibratoDepth: 0, mute: 'open', ...patch,
});
const chord = (rows, length = 15, velocity = 0.58) => rows.map(row => note(row, 0, length, velocity));
const cycle = (bars, progression) => Array.from({ length: bars }, (_, bar) => [progression[bar % progression.length], bar, 1]);
const beat = (kick, snare, hats, extras = []) => [
  ...kick.map(s => note(0, s, 1, 0.95)), ...snare.map(s => note(1, s, 1, 0.83)),
  ...hats.map((s, i) => note(2, s, 1, i % 2 ? 0.47 : 0.63)), ...extras,
];
const clip = (t, p, start, bars) => ({ id: `${t.id}-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${start}`,
  trackId: t.id, patternId: p.id, startStep: start * 16, lengthSteps: bars * 16 });
const place = (t, spans) => spans.map(([pattern, start, bars]) => clip(t, t.patterns[pattern], start, bars));
const song = (bpm, bars, tracks, spans) => ({ bpm, stepsPerBeat: 4, songBars: bars, snap: 'bar',
  arrangement: tracks.flatMap((t, i) => place(t, spans[i])), tracks, activeTrackId: tracks[0].id });

// EDM: strings enter one register at a time; an eight-bar drum break clears space before the drop.
{
  const d = track('edm-drums', 'Drop Drums', 0, 'drum', 'kick', 60, [
    pat('edm-drums', 'Pulse', beat([0, 8], [], [4, 12])),
    pat('edm-drums', 'Build', beat([0, 8], [12], [0, 4, 8, 10, 12, 14], [note(4, 15, 1, 0.8)])),
    pat('edm-drums', 'Drop', beat([0, 4, 8, 12], [4, 12], [2, 6, 10, 14], [note(3, 12, 1, 0.65)])),
    pat('edm-drums', 'Break', beat([], [4, 12], [6, 14], [note(4, 15, 1, 0.55)])),
    pat('edm-drums', 'Fill', beat([0, 4, 8, 12], [4, 12, 14, 15], [2, 6, 10, 14], [note(4, 13), note(4, 15)])),
  ]);
  const b = track('edm-bass', 'Sub Drive', 1, 'synth', 'square', 36, [
    pat('edm-bass', 'D pulse', [0, 3, 8, 11].map(s => note(2, s, 2, 0.78))),
    pat('edm-bass', 'Bb pulse', [0, 3, 8, 11].map(s => note(10, s, 2, 0.74))),
    pat('edm-bass', 'F pulse', [0, 3, 8, 11].map(s => note(5, s, 2, 0.74))),
    pat('edm-bass', 'C pulse', [0, 3, 8, 11].map(s => note(0, s, 2, 0.74))),
  ], { gain: 0.24, voice: { cutoff: 900, release: 0.08 } });
  const s = track('edm-strings', 'Rising Violins', 2, 'synth', 'physmod', 57, [
    pat('edm-strings', 'Low rise', [note(5, 0, 12, 0.46), note(8, 12, 4, 0.56)]),
    pat('edm-strings', 'High rise', [note(12, 0, 8, 0.62), note(15, 8, 8, 0.7)]),
    pat('edm-strings', 'Drop answer', [note(15, 0, 4, 0.7), note(12, 6, 3, 0.58), note(17, 10, 6, 0.75)]),
    pat('edm-strings', 'Break swell', [note(8, 0, 14, 0.45)]),
  ], { gain: 0.18, physmod: pm('violin', { bowForce: 0.63, bowVelocity: 0.62, brightness: 0.66, bodyMix: 0.48 }) });
  const l = track('edm-lead', 'Neon Hook', 3, 'synth', 'saw', 60, [
    pat('edm-lead', 'Hook', [note(2, 0, 2), note(5, 3, 1), note(9, 4, 4), note(5, 9, 2), note(12, 12, 4)]),
    pat('edm-lead', 'Answer', [note(10, 0, 2), note(5, 3, 1), note(2, 4, 4), note(0, 10, 2), note(5, 12, 4)]),
  ], { gain: 0.13, voice: { cutoff: 2800, attack: 0.015, delayTime: 0.22, delayMix: 0.12, reverbMix: 0.12 } });
  const tracks = [d, b, s, l];
  const spans = [
    [[0,0,4],[1,4,3],[4,7,1],[2,8,8],[3,16,4],[1,20,3],[4,23,1],[2,24,8]],
    [[0,8,2],[1,10,2],[2,12,2],[3,14,2],[0,24,2],[1,26,2],[2,28,2],[3,30,2]],
    [[0,0,4],[1,4,4],[2,8,8],[3,16,4],[0,20,4],[2,24,8]],
    [[0,8,4],[1,12,4],[0,24,4],[1,28,4]],
  ];
  writeFileSync(join(here, 'neon-tide-edm.json'), JSON.stringify(song(128, 32, tracks, spans), null, 2) + '\n');
}

// House: four-on-the-floor groove, pizzicato-like short cello stabs and a sparse drum breakdown.
{
  const d = track('house-drums', 'Club Kit', 0, 'drum', 'kick', 60, [
    pat('house-drums', 'Four Floor', beat([0,4,8,12], [4,12], [2,6,10,14])),
    pat('house-drums', 'Open Groove', beat([0,4,8,12], [4,12], [0,2,4,6,8,10,12,14], [note(3, 12, 1, 0.55)])),
    pat('house-drums', 'Break', beat([], [12], [6,14], [note(4, 15, 1, 0.5)])),
    pat('house-drums', 'Turnaround', beat([0,4,8,12], [4,12,14,15], [2,6,10,14], [note(4, 10), note(4, 15)])),
  ]);
  const b = track('house-bass', 'Rubber Bass', 1, 'synth', 'saw', 36, [
    pat('house-bass', 'Am', [note(9,2,2),note(9,6,1),note(12,10,2),note(7,14,2)]),
    pat('house-bass', 'F', [note(5,2,2),note(5,6,1),note(9,10,2),note(12,14,2)]),
    pat('house-bass', 'C', [note(0,2,2),note(0,6,1),note(4,10,2),note(7,14,2)]),
    pat('house-bass', 'G', [note(7,2,2),note(7,6,1),note(11,10,2),note(14,14,2)]),
  ], { gain: 0.18, voice: { cutoff: 750, release: 0.09 } });
  const s = track('house-strings', 'Cello Chops', 2, 'synth', 'physmod', 48, [
    pat('house-strings', 'Am chops', [note(9,0,3), note(12,4,3), note(16,8,3), note(12,12,3)]),
    pat('house-strings', 'F chops', [note(5,0,3), note(9,4,3), note(12,8,3), note(9,12,3)]),
    pat('house-strings', 'C chops', [note(0,0,3), note(4,4,3), note(7,8,3), note(4,12,3)]),
    pat('house-strings', 'G chops', [note(7,0,3), note(11,4,3), note(14,8,3), note(11,12,3)]),
    pat('house-strings', 'Swell', [note(9,0,16,0.55),note(16,0,16,0.45)]),
  ], { gain: 0.17, physmod: pm('cello', { bowForce: 0.67, damping: 0.2, brightness: 0.57, bodyMix: 0.55 }) });
  const c = track('house-chords', 'Air Chords', 3, 'synth', 'triangle', 60, [
    pat('house-chords', 'Am F', [note(9,0,7,0.5), note(12,0,7,0.5), note(16,0,7,0.5), note(5,8,7,0.5), note(9,8,7,0.5), note(12,8,7,0.5)]),
    pat('house-chords', 'C G', [note(0,0,7,0.5), note(4,0,7,0.5), note(7,0,7,0.5), note(7,8,7,0.5), note(11,8,7,0.5), note(14,8,7,0.5)]),
  ], { gain: 0.11, voice: { attack: 0.07, release: 0.5, reverbMix: 0.18 } });
  const tracks = [d,b,s,c];
  const spans = [
    [[0,0,4],[1,4,3],[3,7,1],[1,8,8],[2,16,4],[0,20,3],[3,23,1],[1,24,8]],
    [[0,4,1],[1,5,1],[2,6,1],[3,7,1],[0,8,1],[1,9,1],[2,10,1],[3,11,1],[0,12,1],[1,13,1],[2,14,1],[3,15,1],[0,24,1],[1,25,1],[2,26,1],[3,27,1],[0,28,1],[1,29,1],[2,30,1],[3,31,1]],
    [[4,0,4],[0,4,1],[1,5,1],[2,6,1],[3,7,1],[0,8,1],[1,9,1],[2,10,1],[3,11,1],[0,12,1],[1,13,1],[2,14,1],[3,15,1],[4,16,4],[0,20,4],[0,24,1],[1,25,1],[2,26,1],[3,27,1],[0,28,1],[1,29,1],[2,30,1],[3,31,1]],
    [[0,0,8],[1,8,8],[0,16,8],[1,24,8]],
  ];
  writeFileSync(join(here, 'afterhours-house.json'), JSON.stringify(song(122, 32, tracks, spans), null, 2) + '\n');
}

// Hip hop: half-time drums, syncopated low end, a drum-only break, then the full hook returns.
{
  const d = track('hiphop-drums', 'Dusty Kit', 0, 'drum', 'kick', 60, [
    pat('hiphop-drums', 'Verse', beat([0,7,10], [8], [0,2,4,6,8,10,12,14], [note(3,8,1,0.37)])),
    pat('hiphop-drums', 'Hook', beat([0,3,7,10,14], [8], [0,2,4,6,8,10,12,14], [note(3,8,1,0.6)])),
    pat('hiphop-drums', 'Breakdown', beat([0,10], [8,15], [2,6,10,14], [note(4,14,1,0.5)])),
    pat('hiphop-drums', 'Fill', beat([0,7,10], [8,12,14,15], [0,2,4,6,8,10,12,14], [note(4,11),note(4,15)])),
  ]);
  const b = track('hiphop-bass', 'Low End', 1, 'synth', 'sine', 33, [
    pat('hiphop-bass', 'A minor', [note(12,0,6),note(12,7,2),note(7,10,5)]),
    pat('hiphop-bass', 'F major', [note(8,0,6),note(8,7,2),note(3,10,5)]),
    pat('hiphop-bass', 'E minor', [note(7,0,6),note(7,7,2),note(2,10,5)]),
  ], { gain: 0.27, voice: { cutoff: 700, attack: 0.01, sustain: 0.78, release: 0.22 } });
  const keys = track('hiphop-keys', 'Muted Keys', 2, 'synth', 'triangle', 57, [
    pat('hiphop-keys', 'Am9', [note(0,0,5,0.54),note(3,0,5,0.5),note(7,0,5,0.5),note(14,0,5,0.44),note(0,10,4,0.48),note(7,10,4,0.43)]),
    pat('hiphop-keys', 'Fmaj7', [note(8,0,5,0.54),note(12,0,5,0.5),note(15,0,5,0.5),note(3,10,4,0.48),note(12,10,4,0.43)]),
    pat('hiphop-keys', 'Em7', [note(7,0,5,0.54),note(10,0,5,0.5),note(14,0,5,0.5),note(2,10,4,0.48),note(10,10,4,0.43)]),
  ], { gain: 0.12, voice: { cutoff: 1450, attack: 0.018, decay: 0.24, sustain: 0.35, release: 0.35, reverbMix: 0.12 } });
  const lead = track('hiphop-lead', 'Tape Whistle', 3, 'synth', 'sine', 69, [
    pat('hiphop-lead', 'Answer', [note(0,0,2,0.55),note(3,3,2,0.52),note(7,8,4,0.62),note(3,14,2,0.45)]),
    pat('hiphop-lead', 'Turn', [note(5,0,3,0.55),note(3,4,2,0.5),note(0,8,5,0.62)]),
  ], { gain: 0.08, voice: { attack: 0.04, release: 0.32, delayTime: 0.32, delayMix: 0.12 } });
  const tracks = [d,b,keys,lead];
  const spans = [
    [[0,0,7],[3,7,1],[1,8,8],[2,16,4],[0,20,3],[3,23,1],[1,24,8]],
    [[0,0,4],[1,4,4],[0,8,4],[2,12,4],[0,20,4],[1,24,4],[0,28,4]],
    [[0,0,4],[1,4,4],[0,8,4],[2,12,4],[0,20,4],[1,24,4],[0,28,4]],
    [[0,8,4],[1,12,4],[0,24,4],[1,28,4]],
  ];
  writeFileSync(join(here, 'lowlight-hip-hop.json'), JSON.stringify(song(92, 32, tracks, spans), null, 2) + '\n');
}

// The Beacon: a D-minor expedition theme grows from low strings to a horn and trumpet fanfare.
{
  const cellos = track('beacon-cellos', 'Expedition Cellos', 0, 'synth', 'physmod', 48, [
    pat('beacon-cellos', 'D minor', chord([2, 9, 14], 15, 0.48)),
    pat('beacon-cellos', 'B flat', chord([10, 17, 22], 15, 0.48)),
    pat('beacon-cellos', 'F major', chord([5, 12, 17], 15, 0.48)),
    pat('beacon-cellos', 'C major', chord([0, 7, 12], 15, 0.48)),
  ], { gain: 0.16, physmod: pm('cello', { bowForce: 0.55, bodySize: 0.72, bodyMix: 0.65 }) });
  const violins = track('beacon-violins', 'Summit Violins', 1, 'synth', 'physmod', 60, [
    pat('beacon-violins', 'D ascent', [note(2,0,6,0.57),note(5,6,4,0.62),note(9,10,6,0.68)]),
    pat('beacon-violins', 'B flat ascent', [note(10,0,6,0.58),note(14,6,4,0.63),note(17,10,6,0.7)]),
    pat('beacon-violins', 'F answer', [note(17,0,8,0.68),note(12,8,8,0.6)]),
    pat('beacon-violins', 'C answer', [note(12,0,6,0.63),note(7,6,4,0.57),note(9,10,6,0.65)]),
    pat('beacon-violins', 'D swell', [note(9,0,16,0.47)]),
  ], { gain: 0.13, physmod: pm('violin', { bowForce: 0.61, brightness: 0.66, bodyMix: 0.52 }) });
  const horn = track('beacon-horn', 'Far Horizon Horn', 2, 'synth', 'brass', 48, [
    pat('beacon-horn', 'D call', [note(14,0,6,0.68),note(17,6,3,0.74),note(21,10,6,0.8)]),
    pat('beacon-horn', 'B flat call', [note(10,0,6,0.7),note(17,6,3,0.74),note(22,10,6,0.8)]),
    pat('beacon-horn', 'F call', [note(17,0,8,0.78),note(21,8,8,0.82)]),
    pat('beacon-horn', 'C call', [note(19,0,6,0.76),note(16,6,3,0.72),note(14,10,6,0.8)]),
    pat('beacon-horn', 'D long', [note(14,0,16,0.65)]),
  ], { gain: 0.2, brass: brass('horn', 'fanfare', { release: 0.2 }) });
  const trumpet = track('beacon-trumpet', 'Beacon Trumpet', 3, 'synth', 'brass', 60, [
    pat('beacon-trumpet', 'D fanfare', [note(9,0,3,0.72),note(9,4,3,0.77),note(14,8,7,0.86)]),
    pat('beacon-trumpet', 'B flat fanfare', [note(5,0,3,0.72),note(5,4,3,0.77),note(10,8,7,0.86)]),
    pat('beacon-trumpet', 'F fanfare', [note(12,0,3,0.72),note(12,4,3,0.77),note(17,8,7,0.86)]),
    pat('beacon-trumpet', 'C fanfare', [note(7,0,3,0.72),note(7,4,3,0.77),note(12,8,7,0.86)]),
  ], { gain: 0.13, brass: brass('trumpet', 'fanfare') });
  const drums = track('beacon-drums', 'March Percussion', 4, 'drum', 'kick', 60, [
    pat('beacon-drums', 'March', beat([0,8], [4,12], [2,6,10,14], [note(4,15,1,0.43)])),
    pat('beacon-drums', 'Finale', beat([0,4,8,12], [4,12,14], [2,6,10,14], [note(4,15,1,0.7)])),
    pat('beacon-drums', 'Quiet crossing', beat([0], [], [8], [note(4,15,1,0.35)])),
  ], { gain: 0.32 });
  const progression = [0,1,2,3];
  const tracks = [cellos, violins, horn, trumpet, drums];
  const spans = [
    cycle(32, progression),
    [[4,0,4],...cycle(12, progression).map(([p,b]) => [p,b+4,1]),[4,16,4],...cycle(12, progression).map(([p,b]) => [p,b+20,1])],
    [...cycle(8, progression).map(([p,b]) => [p,b+8,1]),[4,16,4],...cycle(12, progression).map(([p,b]) => [p,b+20,1])],
    [...cycle(8, progression).map(([p,b]) => [p,b+8,1]),...cycle(8, progression).map(([p,b]) => [p,b+24,1])],
    [[2,0,4],[0,4,12],[2,16,4],[0,20,4],[1,24,8]],
  ];
  writeFileSync(join(here, 'the-beacon-cinematic.json'), JSON.stringify(song(104, 32, tracks, spans), null, 2) + '\n');
}

// Shadow Passage: a sparse, stalking ostinato and muted horn lead build to a low-brass reveal.
{
  const viola = track('shadow-viola', 'Restless Violas', 0, 'synth', 'physmod', 48, [
    pat('shadow-viola', 'E pulse', [0,4,8,12].map(s => note(4,s,2,0.5))),
    pat('shadow-viola', 'F pulse', [0,4,8,12].map(s => note(5,s,2,0.53))),
    pat('shadow-viola', 'C pulse', [0,4,8,12].map(s => note(0,s,2,0.5))),
    pat('shadow-viola', 'B pulse', [0,4,8,12].map(s => note(11,s,2,0.52))),
    pat('shadow-viola', 'Held E', [note(4,0,16,0.4)]),
  ], { gain: 0.16, physmod: pm('viola', { bodySize: 0.13, bowForce: 0.48, brightness: 0.38, damping: 0.28 }) });
  const cello = track('shadow-cello', 'Underfoot Cello', 1, 'synth', 'physmod', 36, [
    pat('shadow-cello', 'E minor', [note(4,0,12,0.52),note(11,12,4,0.46)]),
    pat('shadow-cello', 'F minor', [note(5,0,12,0.55),note(0,12,4,0.46)]),
    pat('shadow-cello', 'C major', [note(0,0,12,0.52),note(7,12,4,0.46)]),
    pat('shadow-cello', 'B major', [note(11,0,12,0.55),note(6,12,4,0.46)]),
  ], { gain: 0.19, physmod: pm('cello', { bodySize: 0.72, bowForce: 0.58, brightness: 0.32 }) });
  const horn = track('shadow-horn', 'Veiled Horn', 2, 'synth', 'brass', 48, [
    pat('shadow-horn', 'Question', [note(11,0,5,0.54),note(9,7,3,0.48),note(7,11,5,0.58)]),
    pat('shadow-horn', 'Threat', [note(8,0,6,0.61),note(11,7,3,0.63),note(16,11,5,0.68)]),
    pat('shadow-horn', 'Reveal', [note(16,0,8,0.75),note(11,8,8,0.72)]),
  ], { gain: 0.16, brass: brass('horn', 'chorale', { mute: 'cup', breath: 0.42, release: 0.28 }) });
  const trombone = track('shadow-trombone', 'Distant Trombone', 3, 'synth', 'brass', 40, [
    pat('shadow-trombone', 'E warning', [note(12,0,8,0.61),note(7,8,8,0.57)]),
    pat('shadow-trombone', 'F warning', [note(13,0,8,0.64),note(8,8,8,0.59)]),
    pat('shadow-trombone', 'C warning', [note(8,0,8,0.62),note(3,8,8,0.57)]),
    pat('shadow-trombone', 'B warning', [note(11,0,8,0.67),note(6,8,8,0.62)]),
  ], { gain: 0.14, brass: brass('trombone', 'section', { breath: 0.56, release: 0.25 }) });
  const drums = track('shadow-drums', 'Distant Impacts', 4, 'drum', 'kick', 60, [
    pat('shadow-drums', 'Heartbeat', beat([0,10], [], [6,14])),
    pat('shadow-drums', 'Pursuit', beat([0,7,10], [8], [2,6,10,14], [note(4,15,1,0.52)])),
    pat('shadow-drums', 'Suspended', beat([], [], [14], [note(4,15,1,0.38)])),
  ], { gain: 0.29 });
  const progression = [0,1,2,3];
  const tracks = [viola,cello,horn,trombone,drums];
  const spans = [
    [...cycle(16,progression),[4,16,4],...cycle(12,progression).map(([p,b]) => [p,b+20,1])],
    cycle(32,progression),
    [[0,4,4],[1,12,4],[0,20,4],[2,24,8]],
    [...cycle(8,progression).map(([p,b]) => [p,b+24,1])],
    [[0,0,8],[1,8,8],[2,16,4],[1,20,12]],
  ];
  writeFileSync(join(here, 'shadow-passage-cinematic.json'), JSON.stringify(song(88, 32, tracks, spans), null, 2) + '\n');
}

// Homeward Light: a gentle string theme with a chorale horn, then a fuller final reprise.
{
  const cello = track('homeward-cello', 'Warm Cello', 0, 'synth', 'physmod', 48, [
    pat('homeward-cello', 'G major', chord([7,14,19], 15, 0.47)),
    pat('homeward-cello', 'D major', chord([2,9,14], 15, 0.47)),
    pat('homeward-cello', 'E minor', chord([4,11,16], 15, 0.47)),
    pat('homeward-cello', 'C major', chord([0,7,12], 15, 0.47)),
  ], { gain: 0.14, physmod: pm('cello', { bodySize: 0.72, bowForce: 0.48, bodyMix: 0.7 }) });
  const viola = track('homeward-viola', 'Inner Voice Viola', 1, 'synth', 'physmod', 60, [
    pat('homeward-viola', 'G harmony', [note(2,0,8,0.44),note(7,8,8,0.48)]),
    pat('homeward-viola', 'D harmony', [note(2,0,8,0.44),note(6,8,8,0.48)]),
    pat('homeward-viola', 'E harmony', [note(4,0,8,0.44),note(7,8,8,0.48)]),
    pat('homeward-viola', 'C harmony', [note(0,0,8,0.44),note(4,8,8,0.48)]),
  ], { gain: 0.12, physmod: pm('viola', { bodySize: 0.13, bowForce: 0.43, brightness: 0.43 }) });
  const violin = track('homeward-violin', 'Homeward Melody', 2, 'synth', 'physmod', 67, [
    pat('homeward-violin', 'G theme', [note(0,0,4,0.58),note(4,4,4,0.59),note(7,8,8,0.65)]),
    pat('homeward-violin', 'D theme', [note(6,0,6,0.6),note(4,6,2,0.54),note(2,8,8,0.61)]),
    pat('homeward-violin', 'E theme', [note(0,0,4,0.57),note(4,4,4,0.59),note(7,8,8,0.64)]),
    pat('homeward-violin', 'C theme', [note(5,0,6,0.59),note(4,6,2,0.55),note(0,8,8,0.62)]),
    pat('homeward-violin', 'G ending', [note(7,0,16,0.6)]),
  ], { gain: 0.12, physmod: pm('violin', { bowForce: 0.49, brightness: 0.56, vibratoDepth: 18 }) });
  const horn = track('homeward-horn', 'Evening Horn', 3, 'synth', 'brass', 48, [
    pat('homeward-horn', 'G reply', [note(14,0,8,0.52),note(19,8,8,0.57)]),
    pat('homeward-horn', 'D reply', [note(18,0,8,0.52),note(14,8,8,0.56)]),
    pat('homeward-horn', 'E reply', [note(16,0,8,0.51),note(11,8,8,0.54)]),
    pat('homeward-horn', 'C reply', [note(12,0,8,0.52),note(16,8,8,0.56)]),
    pat('homeward-horn', 'G farewell', [note(19,0,16,0.58)]),
  ], { gain: 0.16, brass: brass('horn', 'chorale', { breath: 0.36, release: 0.35 }) });
  const progression = [0,1,2,3];
  const tracks = [cello,viola,violin,horn];
  const spans = [
    cycle(32,progression),
    [...cycle(12,progression).map(([p,b]) => [p,b+4,1]),...cycle(16,progression).map(([p,b]) => [p,b+16,1])],
    [...cycle(16,progression),...cycle(15,progression).map(([p,b]) => [p,b+16,1]),[4,31,1]],
    [...cycle(8,progression).map(([p,b]) => [p,b+8,1]),...cycle(15,progression).map(([p,b]) => [p,b+16,1]),[4,31,1]],
  ];
  writeFileSync(join(here, 'homeward-light-cinematic.json'), JSON.stringify(song(76, 32, tracks, spans), null, 2) + '\n');
}
