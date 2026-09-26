import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { createWorld } from './daw_test_world';

const showcases = [eventHorizon, blackGlass, ionRunner, velvetSwitch, firstLight];
const songs = [neon, house, hiphop, beacon, shadow, homeward, ...showcases];

describe('bundled DAW sample songs', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete (globalThis as any).Entropy; });

  it('creates a new song from each JSON template, without structuredClone and without replacing the open song', async () => {
    vi.resetModules();
    const world = createWorld();
    await world.open();
    vi.stubGlobal('structuredClone', undefined);
    const names = ['Neon Tide', 'Afterhours', 'Lowlight', 'The Beacon', 'Shadow Passage', 'Homeward Light',
      'Event Horizon', 'Black Glass', 'Ion Runner', 'Velvet Switch', 'First Light'];
    for (const [index, expected] of songs.entries()) {
      world.w.buttons.get('songs_toggle')!();
      world.render();
      const picker = world.w.dropdowns.get('new_song_template');
      picker.onChange(String(picker.options.findIndex((o: string) => o.startsWith(names[index]))));
      world.w.buttons.get('new_song_create')!();
      expect(world.w.saved.bpm).toBe(expected.bpm);
      expect(world.w.saved.tracks.map((t: any) => t.id)).toEqual(expected.tracks.map(t => t.id));
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
    expect(song.tracks.some(t => t.id === song.activeTrackId)).toBe(true);
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
