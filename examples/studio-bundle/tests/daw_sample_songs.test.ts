import { afterEach, describe, expect, it, vi } from 'vitest';
import neon from '../sample-songs/neon-tide-edm.json';
import house from '../sample-songs/afterhours-house.json';
import hiphop from '../sample-songs/lowlight-hip-hop.json';
import { createWorld } from './daw_test_world';

const songs = [neon, house, hiphop];

describe('bundled DAW sample songs', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); delete (globalThis as any).Entropy; });

  it('creates a new song from each JSON template, without structuredClone and without replacing the open song', async () => {
    vi.resetModules();
    const world = createWorld();
    await world.open();
    vi.stubGlobal('structuredClone', undefined);
    const names = ['Neon Tide', 'Afterhours', 'Lowlight'];
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
    expect(song.songBars).toBe(32);
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

  it('gives every song a drum breakdown with fewer kick hits than its main groove', () => {
    for (const song of songs) {
      const drums = song.tracks.find(t => t.kind === 'drum')!;
      const breakdown = drums.patterns.find(p => /break/i.test(p.name))!;
      const main = drums.patterns.find(p => /drop|open groove|hook/i.test(p.name))!;
      expect(breakdown.notes.filter(n => n.row === 0).length)
        .toBeLessThan(main.notes.filter(n => n.row === 0).length);
      expect(song.arrangement.some(c => c.patternId === breakdown.id)).toBe(true);
    }
  });
});
