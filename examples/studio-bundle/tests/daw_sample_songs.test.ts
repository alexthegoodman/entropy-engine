import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import neon from '../sample-songs/neon-tide-edm.json';
import house from '../sample-songs/afterhours-house.json';
import hiphop from '../sample-songs/lowlight-hip-hop.json';
import beacon from '../sample-songs/the-beacon-cinematic.json';
import shadow from '../sample-songs/shadow-passage-cinematic.json';
import homeward from '../sample-songs/homeward-light-cinematic.json';
import eventHorizon from '../sample-songs/event-horizon-trap.json';
import blackGlass from '../sample-songs/black-glass-suspense.json';
import ionRunner from '../sample-songs/ion-runner-synthwave.json';
import velvetSwitch from '../sample-songs/velvet-switch-funk.json';
import firstLight from '../sample-songs/first-light-electronica.json';
import foldedCity from '../sample-songs/folded-city-score.json';
import tidewater from '../sample-songs/tidewater-signal-score.json';
import ashenCrown from '../sample-songs/ashen-crown-score.json';
import rooftop from '../sample-songs/rooftop-pursuit-score.json';
import lanterns from '../sample-songs/lanterns-over-the-sound-score.json';
import { allModeled, matchesTemplate, songLength, templateRows, voiceFamily } from '../src/apps/daw_templates';
import { createWorld } from './daw_test_world';

const showcases = [eventHorizon, blackGlass, ionRunner, velvetSwitch, firstLight];
const filmScores = [foldedCity, tidewater, ashenCrown, rooftop, lanterns] as any[];
const songs = [neon, house, hiphop, beacon, shadow, homeward, ...showcases, ...filmScores] as any[];
const names = ['Neon Tide', 'Afterhours', 'Lowlight', 'The Beacon', 'Shadow Passage', 'Homeward Light',
  'Event Horizon', 'Black Glass', 'Ion Runner', 'Velvet Switch', 'First Light',
  'Folded City', 'Tidewater Signal', 'Ashen Crown', 'Rooftop Pursuit', 'Lanterns Over the Sound'];

describe('bundled DAW sample songs', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete (globalThis as any).Entropy; });

  it('creates a new song from each JSON template, without structuredClone and without replacing the open song', async () => {
    vi.resetModules();
    const world = createWorld();
    await world.open();
    vi.stubGlobal('structuredClone', undefined);
    for (const [index, expected] of songs.entries()) {
      world.w.buttons.get('songs_toggle')!();
      world.render();
      const browser = world.w.trees.get('song_templates');
      browser.onSelect(browser.nodes.find((n: any) => n.label === names[index]).id);
      world.render();
      world.w.buttons.get('new_song_create')!();
      expect(world.w.saved.bpm).toBe(expected.bpm);
      expect(world.w.saved.tracks.map((t: any) => t.id)).toEqual(expected.tracks.map(t => t.id));
      expect(world.w.saved.tracks.map((t: any) => t.patterns)).toEqual(expected.tracks.map(t => t.patterns));
      expect(world.w.buses.size).toBe(expected.tracks.length);
      world.render();
    }
    const library = JSON.parse(world.w.files.get('library.json')!);
    expect(library.songs.map((s: any) => s.name)).toEqual(['Demo song', ...names]);
  });

  it.each(songs)('has playable project references and notes in every clip', song => {
    expect(song.stepsPerBeat).toBe(4);
    expect([32,64]).toContain(song.songBars);
    expect(song.tracks.length).toBeGreaterThanOrEqual(4);
    expect(song.tracks.some((t: any) => t.id === song.activeTrackId)).toBe(true);
    for (const track of song.tracks) {
      expect(track.patterns.some(p => p.id === track.activePatternId)).toBe(true);
      if (track.kind === 'drum') {
        expect(track.rack).toHaveLength(track.rows);
        expect(track.rack?.every(p => p.sample === null && !!p.voice)).toBe(true);
      }
      for (const pattern of track.patterns) {
        expect(pattern.notes.length).toBeGreaterThan(0);
        for (const note of pattern.notes) {
          expect(note.row).toBeGreaterThanOrEqual(0);
          expect(note.row).toBeLessThan(track.rows);
          expect(note.step).toBeGreaterThanOrEqual(0);
          expect(note.step + note.length).toBeLessThanOrEqual(pattern.steps + 1);
          expect(note.velocity).toBeGreaterThan(0);
          expect(note.velocity).toBeLessThanOrEqual(1);
        }
      }
    }
    for (const clip of song.arrangement) {
      const track = song.tracks.find(t => t.id === clip.trackId);
      expect(track).toBeDefined();
      expect(track!.patterns.some(p => p.id === clip.patternId)).toBe(true);
      expect(clip.startStep + clip.lengthSteps).toBeLessThanOrEqual(song.songBars * 16);
    }
  });

  it('uses physically modeled strings for both dance songs', () => {
    expect(neon.tracks.some(t => t.voice.waveform === 'physmod' && t.physmod?.instrument === 'violin')).toBe(true);
    expect(house.tracks.some(t => t.voice.waveform === 'physmod' && t.physmod?.instrument === 'cello')).toBe(true);
  });

  it.each(showcases)('keeps unique references, valid instruments and clear build/drop contrast at $bpm BPM', song => {
    expect(new Set(song.tracks.map(t => t.id)).size).toBe(song.tracks.length);
    expect(new Set(song.arrangement.map(c => c.id)).size).toBe(song.arrangement.length);
    const ranges: Record<string, number[]> = { horn:[41,77], trumpet:[54,84], trombone:[40,74] };
    for (const t of song.tracks) {
      const clips = song.arrangement.filter(c => c.trackId === t.id).sort((a,b) => a.startStep-b.startStep);
      expect(clips.length).toBeGreaterThan(0);
      for (let i=1;i<clips.length;i++) expect(clips[i-1].startStep+clips[i-1].lengthSteps).toBeLessThanOrEqual(clips[i].startStep);
      for (const p of t.patterns) for (const n of p.notes) {
        expect(n.step+(('offset' in n ? n.offset : 0) ?? 0)+n.length).toBeLessThanOrEqual(p.steps);
        if ('brass' in t && t.brass) {
          const [lo,hi] = ranges[t.brass.instrument];
          expect(t.rootNote+n.row).toBeGreaterThanOrEqual(lo);
          expect(t.rootNote+n.row).toBeLessThanOrEqual(hi);
        }
      }
    }
    const active = (bar:number) => song.arrangement.filter(c => c.startStep <= bar*16 && c.startStep+c.lengthSteps > bar*16).length;
    expect(active(48)).toBeGreaterThan(active(32)+3);
    expect(song.cuts.map(c => [c.startStep,c.endStep])).toEqual([[380,384],[764,768]]);
    expect(active(63)).toBeLessThan(active(48));
  });

  it.each(showcases)('exports every voice family and the final coda through the production addon at $bpm BPM', async song => {
    vi.resetModules();
    const world = createWorld(JSON.parse(JSON.stringify(song)));
    await world.open();
    world.render();
    world.w.buttons.get('export_wav')!();
    const w = world.w;
    const events = [...w.exports.at(-1)!, ...w.wavetableExports.at(-1)!, ...w.physModExports.at(-1)!,
      ...w.brassExports.at(-1)!, ...w.matterExports.at(-1)!];
    expect(events.length).toBeGreaterThan(800);
    expect(w.sampleExports.at(-1)).toEqual([]);
    expect(w.vst3Exports.at(-1)).toEqual([]);
    expect(w.busExports.at(-1)).toHaveLength(song.tracks.length);
    expect(Math.max(...events.map(e => e.startTime))).toBeGreaterThan(60*4*60/song.bpm);
    for (const t of song.tracks) {
      expect(events.some(e => (e.track ?? e.trackId) === t.id),t.name).toBe(true);
    }
    for (const e of events) {
      expect(Number.isFinite(e.startTime)).toBe(true);
      expect(e.startTime).toBeGreaterThanOrEqual(0);
      if ('freq' in e) expect(e.freq).toBeGreaterThan(20);
    }
    // Optional handoff of the actual production export payload to the native audio test.
    if (process.env.ENTROPY_SHOWCASE_FIXTURES) {
      mkdirSync(process.env.ENTROPY_SHOWCASE_FIXTURES, {recursive:true});
      writeFileSync(join(process.env.ENTROPY_SHOWCASE_FIXTURES, `${song.bpm}.json`), JSON.stringify({
        bpm:song.bpm, notes:w.exports.at(-1), wavetable:w.wavetableExports.at(-1),
        physmod:w.physModExports.at(-1), brass:w.brassExports.at(-1), matter:w.matterExports.at(-1),
        buses:w.busExports.at(-1), tables:song.tracks.filter(t => 'wavetable' in t).map(t => ({id:t.id, preset:(t as any).wavetable.preset})),
      }));
    }
  });

  it('gives each cinematic score playable modeled horns and strings in their instrument ranges', () => {
    const brassRanges: Record<string, [number, number]> = {
      horn: [41, 77], trumpet: [54, 84], trombone: [40, 74], tuba: [28, 60],
    };
    for (const score of [beacon, shadow, homeward]) {
      expect(score.tracks.filter(t => t.voice.waveform === 'physmod').length).toBeGreaterThanOrEqual(2);
      const brassTracks = score.tracks.filter(t => t.voice.waveform === 'brass');
      expect(brassTracks.length).toBeGreaterThanOrEqual(1);
      for (const track of brassTracks) {
        const [low, high] = brassRanges[track.brass!.instrument];
        expect(score.arrangement.some(c => c.trackId === track.id)).toBe(true);
        for (const pattern of track.patterns) for (const note of pattern.notes) {
          expect(track.rootNote + note.row).toBeGreaterThanOrEqual(low);
          expect(track.rootNote + note.row).toBeLessThanOrEqual(high);
        }
      }
    }
  });

  it('gives every song a drum breakdown with fewer kick hits than its main groove', () => {
    for (const song of [neon, house, hiphop]) {
      const drums = song.tracks.find(t => t.kind === 'drum')!;
      const breakdown = drums.patterns.find(p => /break/i.test(p.name))!;
      const main = drums.patterns.find(p => /drop|open groove|hook/i.test(p.name))!;
      expect(breakdown.notes.filter(n => n.row === 0).length)
        .toBeLessThan(main.notes.filter(n => n.row === 0).length);
      expect(song.arrangement.some(c => c.patternId === breakdown.id)).toBe(true);
    }
  });
});

// The Film scores collection: full cues played only by physically modeled instruments.
const BRASS: Record<string, [number, number]> = { horn: [41, 77], trumpet: [54, 84], trombone: [40, 74], tuba: [28, 60] };
// The lowest open string of each bowed instrument used (src/apps/daw_physmod.ts).
const LOWEST: Record<string, number> = { violin: 55, viola: 48, cello: 36, bass: 28, hardanger: 57, glass: 55, octobass: 16 };

describe('Film scores: physically modeled sample songs', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete (globalThis as any).Entropy; });

  it.each(filmScores)('plays only modeled strings, brass, Matter and Water, each within its range, at $bpm BPM', song => {
    expect(allModeled(song)).toBe(true);
    const waveforms = new Set(song.tracks.map((t: any) => t.voice.waveform));
    for (const family of ['physmod', 'brass', 'matter']) expect(waveforms.has(family)).toBe(true);
    expect(new Set(song.tracks.map((t: any) => t.id)).size).toBe(song.tracks.length);
    expect(new Set(song.arrangement.map((c: any) => c.id)).size).toBe(song.arrangement.length);
    for (const t of song.tracks) {
      // Each modeled track carries its complete settings, and a hall on its bus.
      expect(t[{ physmod: 'physmod', brass: 'brass', matter: 'matter', water: 'water' }[t.voice.waveform as string]!]).toBeTruthy();
      expect(t.character.space).toBeGreaterThan(0);
      const clips = song.arrangement.filter((c: any) => c.trackId === t.id).sort((a: any, b: any) => a.startStep - b.startStep);
      expect(clips.length).toBeGreaterThan(0);
      for (let i = 1; i < clips.length; i++) expect(clips[i - 1].startStep + clips[i - 1].lengthSteps).toBeLessThanOrEqual(clips[i].startStep);
      for (const p of t.patterns) for (const n of p.notes) {
        const pitch = t.rootNote + n.row;
        expect(n.step + n.length).toBeLessThanOrEqual(p.steps + 0.25);
        if (t.brass) {
          expect(pitch, `${t.name} in ${p.name}`).toBeGreaterThanOrEqual(BRASS[t.brass.instrument][0]);
          expect(pitch, `${t.name} in ${p.name}`).toBeLessThanOrEqual(BRASS[t.brass.instrument][1]);
        }
        if (t.physmod) expect(pitch, `${t.name} in ${p.name}`).toBeGreaterThanOrEqual(LOWEST[t.physmod.instrument]);
        if (t.matter) expect(n.row).toBeLessThan(t.rows);
        if (t.water?.play === 'glass') { expect(pitch).toBeGreaterThanOrEqual(60); expect(pitch).toBeLessThanOrEqual(96); }
      }
    }
    // Every cue runs about two to three minutes and has named sections.
    const seconds = song.songBars * 240 / song.bpm;
    expect(seconds).toBeGreaterThan(95);
    expect(seconds).toBeLessThan(180);
    expect(new Set(song.tracks.flatMap((t: any) => t.patterns.map((p: any) => p.name))).size).toBeGreaterThanOrEqual(8);
  });

  it('covers every modeled family across the collection, including invented instruments and each water play', () => {
    const tracks = filmScores.flatMap(s => s.tracks);
    expect(new Set(tracks.filter(t => t.physmod).map(t => t.physmod.instrument)))
      .toEqual(new Set(['violin', 'viola', 'cello', 'bass', 'hardanger', 'glass', 'octobass']));
    expect(new Set(tracks.filter(t => t.brass).map(t => t.brass.instrument))).toEqual(new Set(['horn', 'trumpet', 'trombone', 'tuba']));
    expect(new Set(tracks.filter(t => t.physmod).map(t => t.physmod.articulation))).toEqual(new Set(['arco', 'pizzicato', 'colLegno']));
    expect(new Set(tracks.filter(t => t.water).map(t => t.water.play === 'weather' ? t.water.weatherSource : t.water.play)))
      .toEqual(new Set(['glass', 'drip', 'surf', 'brook']));
    expect(new Set(tracks.map(t => voiceFamily(t)))).not.toContain('drum rack');
  });

  it('builds with dynamics: each cue has a quiet start, a louder middle and a hard cut or a quiet end', () => {
    for (const song of filmScores) {
      // Note onsets per bar, across the whole orchestra.
      const onsets = new Array(song.songBars).fill(0);
      for (const c of song.arrangement) {
        const p = song.tracks.find((t: any) => t.id === c.trackId).patterns.find((x: any) => x.id === c.patternId);
        for (const n of p.notes) onsets[Math.floor((c.startStep + n.step) / 16)]++;
      }
      const peak = Math.max(...onsets);
      expect(onsets[0]).toBeLessThan(peak / 3);
      // It ends quietly, or it swells and cuts to black on a hard cut at the very end.
      const cutToBlack = song.cuts.some((c: any) => c.endStep === song.songBars * 16);
      if (!cutToBlack) expect(onsets[song.songBars - 1]).toBeLessThan(peak / 2);
    }
    // The hard cuts silence every track, so the dream, the hatch and the jump stop dead.
    for (const song of [foldedCity, tidewater, rooftop]) {
      expect(song.cuts.length).toBeGreaterThan(0);
      for (const c of song.cuts) expect(c.trackIds).toHaveLength(song.tracks.length);
    }
  });

  it.each(filmScores)('exports every modeled voice through the production addon, with no synth, sample or plugin events, at $bpm BPM', async song => {
    vi.resetModules();
    const world = createWorld(JSON.parse(JSON.stringify(song)));
    await world.open();
    world.render();
    world.w.buttons.get('export_wav')!();
    const w = world.w;
    expect(w.exports.at(-1)).toEqual([]);
    expect(w.wavetableExports.at(-1)).toEqual([]);
    expect(w.sampleExports.at(-1)).toEqual([]);
    expect(w.vst3Exports.at(-1)).toEqual([]);
    const events = [...w.physModExports.at(-1)!, ...w.brassExports.at(-1)!, ...w.matterExports.at(-1)!, ...w.waterExports.at(-1)!];
    expect(events.length).toBeGreaterThan(250);
    expect(w.busExports.at(-1)).toHaveLength(song.tracks.length);
    for (const t of song.tracks) expect(events.some(e => (e.track ?? e.trackId) === t.id), t.name).toBe(true);
    const end = song.songBars * 240 / song.bpm;
    for (const e of events) {
      expect(Number.isFinite(e.startTime)).toBe(true);
      expect(e.startTime).toBeGreaterThanOrEqual(0);
      expect(e.startTime).toBeLessThan(end);
      if ('freq' in e) expect(e.freq).toBeGreaterThan(20);
    }
    expect(Math.max(...events.map(e => e.startTime))).toBeGreaterThan(end - 240 / song.bpm * 4);
    // Optional handoff to the native render test (tests/daw_film_score_audio.rs).
    if (process.env.ENTROPY_FILM_SCORE_FIXTURES) {
      mkdirSync(process.env.ENTROPY_FILM_SCORE_FIXTURES, { recursive: true });
      const slug = song.tracks[0].id.split('-').slice(0, -1).join('-');
      writeFileSync(join(process.env.ENTROPY_FILM_SCORE_FIXTURES, `${song.bpm}.json`), JSON.stringify({
        bpm: song.bpm, bars: song.songBars, slug, physmod: w.physModExports.at(-1), brass: w.brassExports.at(-1),
        matter: w.matterExports.at(-1), water: w.waterExports.at(-1), buses: w.busExports.at(-1),
      }));
    }
  });
});

describe('the template catalog', () => {
  const info = (p: any) => ({ id: p.id, name: p.name, collection: p.collection, style: p.style ?? '', blurb: p.blurb ?? '', key: p.key });

  it('lists collections in order, folds them, and searches every word', () => {
    const templates = [
      info({ id: 'a', name: 'Alpha', collection: 'beats', style: 'House' }),
      info({ id: 'b', name: 'Bravo', collection: 'film', style: 'Epic', blurb: 'war drums and horns' }),
      info({ id: 'c', name: 'Charlie', collection: 'film', style: 'Chase', blurb: 'horns and strings' }),
    ];
    const rows = (o: any) => templateRows(templates, { collection: 'all', query: '', collapsed: new Set(), selected: 'b', detail: t => t.style, ...o });
    expect(rows({}).map(r => r.label)).toEqual(['Beats and dance', 'Alpha', 'Film scores', 'Bravo', 'Charlie']);
    expect(rows({}).find(r => r.label === 'Bravo')!.selected).toBe(true);
    expect(rows({ collapsed: new Set(['film']) }).map(r => r.label)).toEqual(['Beats and dance', 'Alpha', 'Film scores']);
    expect(rows({ collection: 'film' }).map(r => r.detail)).toEqual(['2 songs', 'Epic', 'Chase']);
    // A search opens folded collections that have a match.
    expect(rows({ query: 'HORNS war', collapsed: new Set(['film']) }).map(r => r.label)).toEqual(['Film scores', 'Bravo']);
    expect(matchesTemplate(templates[2], 'film chase')).toBe(true);
    expect(rows({ query: 'polka' })).toEqual([]);
  });

  it('describes a song by its instruments and length', () => {
    expect(songLength({ bpm: 64, songBars: 32 })).toBe('2:00');
    expect(songLength({ bpm: 66, songBars: 32 })).toBe('1:56');
    expect(allModeled(neon as any)).toBe(false);
    expect(voiceFamily({ name: 'x', kind: 'synth', voice: { waveform: 'water' }, water: { play: 'weather' } })).toBe('Water weather');
    expect(voiceFamily({ name: 'x', kind: 'synth', voice: { waveform: 'physmod' }, physmod: { instrument: 'hardanger' } })).toBe('bowed hardanger');
  });
});
