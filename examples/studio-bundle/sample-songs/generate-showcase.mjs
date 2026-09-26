// Five original arrangements. Run directly, or via generate.mjs. No random state or assets.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const voice = (waveform, p = {}) => ({ waveform, cutoff: 3800, resonance: 0.7,
  attack: 0.008, decay: 0.18, sustain: 0.55, release: 0.18,
  delayTime: 0, delayFeedback: 0.25, delayMix: 0,
  reverbRoomSize: 18, reverbTime: 1.8, reverbDamping: 0.65, reverbMix: 0, ...p });
const wt = (preset, p = {}) => ({ preset, position: 0.36, lfoRate: 0.18, lfoDepth: 0.12,
  sweep: 0.25, sweepTime: 0.24, velToPosition: 0.12, unison: 1, detuneCents: 10,
  spread: 0.65, ...p });
const pm = (instrument, p = {}) => ({ instrument, bodySize: { violin: 0, viola: 0.13, cello: 0.72 }[instrument],
  bowForce: 0.52, bowVelocity: 0.55, bowPosition: 0.15, vibratoRate: 5.2,
  vibratoDepth: 8, damping: 0.22, brightness: 0.5, bodyMix: 0.45, ...p });
const brass = (instrument, p = {}) => ({ instrument, style: 'section', breath: 0.56,
  articulation: 'tongued', tongue: 0.004, release: 0.16, attackSkill: 1,
  vibratoDepth: 0, mute: 'open', ...p });
const character = (p = {}) => ({ pump: 0, bounce: 0, gate: 0, gatePattern: 'sixteenths',
  acid: 0, grit: 0, space: 0, humanize: 0, ...p });
const rack = () => [['Kick','kick',50,36],['Snare','snare',200,38],['Hat','hihat',1000,42],
  ['Clap','clap',200,39],['Tom','tom',98,45]].map(([name,voice,freq,midi]) => ({name,voice,freq,midi,sample:null}));

// Absolute MIDI pitches make harmonic intent and instrument ranges reviewable.
// One chord per bar, with close upper voicings and a separately voiced bass.
const scores = [
  { slug: 'event-horizon-trap', name: 'Event Horizon', bpm: 144, style: 'trap', key: 'D minor',
    chords: [[50,57,60,64],[46,53,57,60],[41,53,57,60],[45,52,57,61]],
    bridge: [[43,55,58,62],[46,53,57,62],[50,57,60,64],[45,52,57,61]],
    // D-F-A / held E, then a falling answer; C# resolves the dominant into D.
    theme: [[0,74,3],[4,77,2],[7,81,5],[14,76,2],[18,77,4],[24,74,7],
      [32,72,3],[36,77,3],[42,81,5],[48,76,6],[56,73,3],[60,74,4]],
    answer: [[2,81,5],[10,77,4],[18,74,8],[32,77,6],[42,76,4],[52,73,4],[60,74,4]],
    levels: [0,1,2,2,3,3,4,4,0,1,2,3,5,5,5,0],
    sections: ['Signal','Distant lights','Approach','Approach B','Gravity','Countdown','First impact','Impact answer',
      'Vacuum','Fragments','Re-entry','Ignition','Event horizon','Beyond the horizon','Last surge','Afterimage'],
    lead: 'bell', counter: 'violin', horns: 'horn', bassWave: 'sine',
  },
  { slug: 'black-glass-suspense', name: 'Black Glass', bpm: 108, style: 'suspense', key: 'E Phrygian',
    chords: [[40,55,59,64],[41,53,57,64],[48,55,59,64],[47,54,59,63]],
    bridge: [[45,52,57,60],[41,53,57,60],[40,52,55,59],[47,54,59,63]],
    theme: [[0,71,6],[10,72,2],[16,71,7],[28,65,3],[34,64,8],[48,66,4],[56,63,6]],
    answer: [[0,76,10],[14,77,2],[20,76,7],[32,72,6],[42,71,4],[52,75,8]],
    levels: [0,1,1,2,2,3,4,4,0,0,1,3,5,5,5,0],
    sections: ['Empty corridor','Footsteps','Wrong reflection','The lock','Behind the wall','Alarm',
      'Pursuit','No exit','Lights out','Breathing','Something moves','Run','The reveal','Glass breaks','Escape','One last shadow'],
    lead: 'triangle', counter: 'viola', horns: 'trombone', bassWave: 'square',
  },
  { slug: 'ion-runner-synthwave', name: 'Ion Runner', bpm: 118, style: 'synthwave', key: 'F# minor',
    chords: [[42,57,61,66],[38,54,57,61],[45,52,57,61],[40,56,59,64]],
    bridge: [[47,54,57,61],[38,54,57,61],[45,52,57,61],[49,56,61,65]],
    theme: [[0,78,3],[4,81,3],[8,85,6],[18,81,4],[24,78,6],[32,76,3],[36,73,3],
      [40,76,7],[50,80,3],[56,83,3],[60,80,4]],
    answer: [[0,85,6],[8,81,6],[16,78,7],[26,73,4],[32,76,6],[42,81,5],[52,80,4],[58,76,6]],
    levels: [0,1,2,2,3,3,4,4,0,1,2,3,5,5,5,0],
    sections: ['Dashboard glow','Ignition','City grid','Streetlights','Overdrive','On ramp','Night highway','Highway answer',
      'Underpass','Radio ghosts','Engine rising','Launch','Open sky','Skyline','Home stretch','Tail lights'],
    lead: 'saw', counter: 'triangle', horns: null, bassWave: 'saw',
  },
  { slug: 'velvet-switch-funk', name: 'Velvet Switch', bpm: 106, style: 'funk', key: 'C Dorian',
    chords: [[48,58,62,67],[41,57,60,67],[46,57,62,65],[43,59,62,65]],
    bridge: [[44,55,60,63],[46,57,60,65],[48,58,62,67],[43,59,62,65]],
    theme: [[2,67,2],[6,70,1],[9,72,3],[15,74,1],[18,72,3],[26,69,2],
      [34,65,2],[38,69,1],[42,74,3],[50,71,2],[55,69,2],[60,67,3]],
    answer: [[1,79,2],[5,77,2],[10,74,3],[18,72,2],[25,69,3],[33,77,2],[39,74,2],
      [44,72,3],[51,71,2],[57,69,2],[61,67,2]],
    levels: [0,1,2,2,3,3,4,4,0,1,2,3,5,5,5,0],
    sections: ['Keys at midnight','Pocket','Velvet verse','Bass reply','Brass knock','Door opens','Full room','Everybody in',
      'After the lights','Small talk','Trading fours','Drum turn','The switch','Roof comes off','Last dance','Walk home'],
    lead: 'triangle', counter: 'trumpet', horns: 'trombone', bassWave: 'square',
  },
  { slug: 'first-light-electronica', name: 'First Light', bpm: 124, style: 'melodic', key: 'A major',
    chords: [[45,56,61,64],[40,56,59,64],[42,57,61,66],[38,54,57,64]],
    bridge: [[47,54,57,61],[49,56,59,64],[38,54,57,61],[40,56,59,64]],
    theme: [[0,76,6],[8,73,4],[14,71,2],[18,73,6],[26,76,5],[32,78,6],[40,81,7],
      [48,78,6],[56,76,8]],
    answer: [[0,81,8],[10,80,4],[18,76,7],[28,73,4],[34,78,8],[44,76,3],[50,73,5],[58,69,6]],
    levels: [0,0,1,2,3,3,4,4,0,1,2,3,5,5,5,0],
    sections: ['Before dawn','A single window','Awakening','Waking city','Sun on water','Lift','First light','Reflections',
      'Stillness','Remembering','Gathering','Breathe in','Daybreak','Wide open','All the way home','The quiet after'],
    lead: 'bell', counter: 'violin', horns: 'horn', bassWave: 'sine',
  },
];

function compose(s) {
  const tracks = [], arrangement = [];
  function instrument(role, name, waveform, gain, extras = {}, patch = {}) {
    const t = { id: `${s.slug}-${role}`, name, kind: role === 'drums' ? 'drum' : 'synth',
      channel: tracks.length, colorIndex: tracks.length, rootNote: 24, scale: 'chromatic', rows: 73,
      voice: voice(waveform, patch), gain, muted: false, solo: false,
      patterns: [], activePatternId: '', ...extras };
    if (t.kind === 'drum') Object.assign(t, { rows: 5, rack: rack() });
    tracks.push(t); return t;
  }
  const drum = instrument('drums', s.style === 'trap' ? 'Half-time / rolls' : 'Pocket / fills', 'kick', 0.34);
  const bass = instrument('bass', 'Foundation', s.bassWave, 0.19, {},
    { cutoff: s.style === 'funk' ? 950 : 550, sustain: 0.72, release: 0.09 });
  const keys = instrument('keys', s.style === 'funk' ? 'Velvet electric keys' : 'Warm chord bed', 'triangle', 0.085, {},
    { attack: s.style === 'funk' ? 0.005 : 0.18, decay: 0.35, sustain: 0.38, release: 0.6, reverbMix: 0.12 });
  const arp = instrument('arp', s.style === 'suspense' ? 'Unreliable clock' : 'Pulse constellation', 'square', 0.048,
    { character: character({ pump: s.style === 'melodic' ? 0.32 : 0 }) },
    { cutoff: 2200, attack: 0.004, decay: 0.12, sustain: 0.2, release: 0.08, delayTime: 90 / s.bpm, delayMix: 0.14 });
  const lead = instrument('lead', s.style === 'trap' ? 'Obsidian bells' : 'Main theme',
    s.lead === 'bell' ? 'wavetable' : s.lead, s.lead === 'saw' ? 0.08 : 0.12,
    s.lead === 'bell' ? { wavetable: wt('bell', { position: 0.3, sweep: 0.45, sweepTime: 0.5 }) } : {},
    { cutoff: 4500, attack: 0.015, decay: 0.4, sustain: 0.45, release: 0.35, delayTime: 90 / s.bpm, delayMix: 0.15, reverbMix: 0.12 });
  const modeledString = ['violin','viola'].includes(s.counter);
  const counter = instrument('counter', modeledString ? 'Bowed answer' : s.counter === 'trumpet' ? 'Trumpet answers' : 'High voltage answer',
    modeledString ? 'physmod' : s.counter === 'trumpet' ? 'brass' : 'triangle', 0.11,
    modeledString ? { physmod: pm(s.counter) } : s.counter === 'trumpet' ? { brass: brass('trumpet', { mute: 'cup', breath: 0.52 }) } : {},
    { release: 0.22, cutoff: 4800 });
  const wide = instrument('wide', s.style === 'synthwave' ? 'Analog horizon' : 'Finale halo', 'wavetable', 0.058,
    { wavetable: wt('saw', { position: 0.5, unison: 3, detuneCents: 13, lfoDepth: 0.035 }),
      character: character({ pump: ['synthwave','melodic'].includes(s.style) ? 0.35 : 0 }) },
    { cutoff: 3200, attack: 0.3, sustain: 0.72, release: 0.85 });
  const horns = s.horns ? instrument('horn', s.style === 'funk' ? 'Trombone punches' : 'Low brass horizon', 'brass', 0.13,
    { brass: brass(s.horns, { breath: s.style === 'suspense' ? 0.48 : 0.64 }) }) : null;
  const cello = s.style === 'suspense' ? instrument('cello', 'Col legno footsteps', 'physmod', 0.14,
    { physmod: pm('cello', { articulation: 'colLegno', brightness: 0.38, damping: 0.35 }) }) : null;
  const fx = instrument('fx', 'Air / transition swells', 'noise', 0.023, {},
    { cutoff: 2800, attack: 1.5, decay: 0.2, sustain: 0.6, release: 0.5, reverbMix: 0.1 });
  // Matter adds physical cymbals/toms to the electronic kit, with discrete hits at structural moments.
  const matter = instrument('matter', 'Matter / impacts and toms', 'matter', 0.23,
    { rows: 9, matter: { preset: 'studio', kit: { kick: 55, snare: 220, rackTom: 140, floorTom: 82,
      kickMuffling: 1, snares: true, snareTension: 0.15, sympathetic: true },
      mix: { kick: 3, snare: 1, 'rack-tom': 2, 'floor-tom': 2.5, crash: 2, ride: 3, splash: 1.5 },
      hands: 'sticks', beater: 'felt', dynamics: 5, physicsView: false } });

  function add(t, phrase, notes) {
    if (!notes.length) return;
    const p = { id: `${t.id}-${phrase}`, name: s.sections[phrase], steps: 64,
      notes: notes.sort((a,b) => a.step - b.step || a.row - b.row) };
    t.patterns.push(p); t.activePatternId ||= p.id;
    arrangement.push({ id: `${p.id}-clip`, trackId: t.id, patternId: p.id, startStep: phrase * 64, lengthSteps: 64 });
  }
  for (let phrase = 0; phrase < 16; phrase++) {
    const energy = s.levels[phrase], final = phrase >= 12 && phrase < 15, outro = phrase === 15;
    const harmony = phrase === 8 || phrase === 9 || phrase === 11 ? s.bridge : s.chords;
    const buckets = new Map(tracks.map(t => [t, []]));
    const hit = (t, midi, step, length = 1, velocity = 0.65, extra = {}) => {
      buckets.get(t).push({ row: t === drum || t === matter ? midi : midi - t.rootNote,
        step, length: Math.min(length, 64-step), velocity: +velocity.toFixed(3), ...extra });
    };
    for (let bar = 0; bar < 4; bar++) {
      const pos = bar * 16, c = harmony[bar], dynamic = energy === 0 ? 0.43 : 0.58;
      // The coda lands on the tonic for two bars, then leaves room for release tails.
      if (outro) {
        if (bar === 0) {
          s.chords[0].slice(1).forEach(n => hit(keys,n,pos,28,0.42));
          hit(lead,s.theme[0][1],pos,12,0.48);
          hit(bass,s.chords[0][0]-12,pos,24,0.5);
        }
        if (bar === 1) hit(lead,s.style === 'suspense' ? 77 : s.theme[0][1]-12,pos+8,4,0.25);
        continue;
      }
      if (s.style === 'funk') {
        for (const step of energy ? [1,7,10,14] : [0,10])
          c.slice(1).forEach((n,i) => hit(keys,n,pos+step,step === 14 ? 1 : 2,dynamic-i*0.045));
      } else c.slice(1).forEach((n,i) => hit(keys,n,pos,14,dynamic-i*0.055));
      if (energy >= 2) {
        const root = c[0] < 43 ? c[0] : c[0]-12;
        const rhythm = s.style === 'trap' ? [0,7,10,14] : s.style === 'funk' ? [0,3,6,10,13,15]
          : s.style === 'suspense' ? [0,6,12] : [0,2,4,6,8,10,12,14];
        rhythm.forEach((step,i) => hit(bass,root + (i === rhythm.length-1 && bar === 3 ? 12 : 0),
          pos+step, s.style === 'trap' ? (i === 0 ? 6 : 2) : 1.5, i === 0 ? 0.85 : 0.68));
      }
      if (energy >= 1 && (phrase !== 9 || bar > 1)) {
        const rhythm = s.style === 'suspense' ? [0,3,6,10,13] : s.style === 'funk' ? [3,11,15] : [0,2,4,6,8,10,12,14];
        rhythm.forEach((step,i) => hit(arp,c[1+i%3]+12,pos+step,0.8,0.4 + (i%3)*0.065,
          { tone: energy >= 3 ? 1.4 : 0.65 }));
      }
      if (energy >= 1) {
        const sparse = energy === 1;
        const kicks = sparse ? [0] : s.style === 'trap' ? [0,7,10] : s.style === 'suspense' ? [0,10]
          : s.style === 'funk' ? [0,6,10,15] : [0,4,8,12];
        kicks.forEach(st => hit(drum,0,pos+st,1,st === 0 ? 0.88 : 0.73));
        (sparse ? [] : s.style === 'trap' || s.style === 'suspense' ? [8] : [4,12])
          .forEach(st => { hit(drum,1,pos+st,1,0.76); if (energy >= 4) hit(drum,3,pos+st,1,0.44); });
        const hats = sparse ? [6,14] : [0,2,4,6,8,10,12,14];
        hats.forEach((st,i) => hit(drum,2,pos+st,0.5,i%2 ? 0.34 : 0.49,
          s.style === 'funk' && i%2 ? {offset:0.18} : {}));
        // Rolls use supported substep offsets. A breath before each impact stays truly empty.
        if (s.style === 'trap' && energy >= 3 && bar%2) {
          [13,15].forEach(st => { hit(drum,2,pos+st,0.25,0.4); hit(drum,2,pos+st,0.25,0.31,{offset:0.5}); });
        }
        if (bar === 3 && energy >= 3) {
          [12,13,14,15].forEach((st,i) => hit(drum,4,pos+st,0.5,0.48+i*0.09));
        }
      }
      if (final || energy === 4) {
        c.slice(1).forEach(n => hit(wide,n,pos,14,final ? 0.64 : 0.48));
        if (horns) {
          const pitch = s.horns === 'trombone' ? c[1]-12 : c[1];
          (s.style === 'funk' ? [2,7,14] : [0,10]).forEach(st => hit(horns,pitch,pos+st,
            s.style === 'funk' ? 1.5 : 5,final ? 0.77 : 0.62));
        }
        if (bar === 0) hit(matter,5,pos,1,0.68);
        if (final && bar === 3) [10,12,14].forEach((st,i) => hit(matter,i === 2 ? 4 : 3,pos+st,1,0.6+i*0.08));
      }
      if (cello && energy >= 1) [0,3,6,10,13].forEach(st => hit(cello,c[0]+12,pos+st,1.2,0.48));
    }
    if (!outro) {
      // The signature theme is introduced sparsely, returns in full, and hands off to a new answer.
      const melody = phrase%2 ? s.answer : s.theme;
      if ([0,1,4,5,6,7,8,9,12,13,14].includes(phrase)) {
        melody.forEach(([st,pitch,len],i) => {
          if (energy === 0 && i%3 !== 0) return;
          hit(lead,pitch,st,len,energy === 0 ? 0.44 : final ? 0.8 : 0.65);
        });
      }
      if (energy >= 4 || phrase === 9) {
        // A second voice answers in the gaps; the full finale adds a separate countermelody.
        const line = final ? [[6,0,6],[22,1,6],[38,2,6],[54,3,8]] : [[12,0,3],[28,1,3],[44,2,3],[60,3,3]];
        line.forEach(([st,b,len]) => {
          let pitch = harmony[b][2] + (s.counter === 'trumpet' ? 12 : 0);
          hit(counter,pitch,st,len,phrase === 9 ? 0.4 : 0.65);
        });
      }
      if ([5,11].includes(phrase)) {
        hit(fx,72,32,27,0.64,{tone:2});
        // Remove all onsets in the final beat before the drop, including the fill.
        // Clip lengths below also cut any still-held notes at that beat.
        for (const [t,ns] of buckets) buckets.set(t,ns.filter(n => n.step < 60)
          .map(n => ({...n,length:Math.min(n.length,60-n.step)})));
      }
    }
    for (const [t,ns] of buckets) add(t,phrase,ns);
  }
  return { bpm:s.bpm, stepsPerBeat:4, songBars:64, snap:'bar', arrangement, tracks, activeTrackId:lead.id };
}

for (const score of scores) {
  const project = compose(score);
  writeFileSync(fileURLToPath(new URL(`./${score.slug}.json`, import.meta.url)), JSON.stringify(project,null,2)+'\n');
}
