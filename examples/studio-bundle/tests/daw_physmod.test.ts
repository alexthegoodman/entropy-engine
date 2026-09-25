import { describe, expect, it } from 'vitest';
import {
    PHYSMOD_INSTRUMENT_PRESETS,
    applyPreset,
    defaultPhysMod,
    instrumentPresetById,
    noteConfig,
    openStrings,
    repairPhysMod,
    stringForFreq,
    stringsForSize,
} from '../src/apps/daw_physmod';

const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

describe('bowed-string instrument presets', () => {
  it('tunes the orchestral family in fifths (and the bass in fourths)', () => {
    for (const id of ['violin', 'viola', 'cello']) {
      const s = instrumentPresetById(id)!.strings;
      for (let i = 1; i < s.length; i++) expect(Math.abs(cents(s[i], s[i - 1]) - 700)).toBeLessThan(3);
    }
    const bass = instrumentPresetById('bass')!.strings;
    for (let i = 1; i < bass.length; i++) expect(Math.abs(cents(bass[i], bass[i - 1]) - 500)).toBeLessThan(3);
  });

  it('orders instruments by size, and marks the invented ones', () => {
    const size = (id: string) => instrumentPresetById(id)!.bodySize;
    expect(size('violin')).toBeLessThan(size('viola'));
    expect(size('viola')).toBeLessThan(size('cello'));
    expect(size('cello')).toBeLessThan(size('bass'));
    expect(PHYSMOD_INSTRUMENT_PRESETS.filter(p => p.invented).map(p => p.id)).toEqual(expect.arrayContaining(['glass', 'octobass', 'wolfcello']));
    expect(instrumentPresetById('hardanger')!.sympathetic!.length).toBeGreaterThan(0);
  });
});

describe('the violin-to-bass morph', () => {
  it('lands exactly on each family member at its size', () => {
    for (const id of ['violin', 'viola', 'cello', 'bass']) {
      const p = instrumentPresetById(id)!;
      stringsForSize(p.bodySize).forEach((f, i) => expect(Math.abs(cents(f, p.strings[i]))).toBeLessThan(0.01));
    }
  });

  it('moves continuously in between and keeps going past either end', () => {
    const between = stringsForSize(0.4);
    const viola = instrumentPresetById('viola')!.strings, cello = instrumentPresetById('cello')!.strings;
    between.forEach((f, i) => { expect(f).toBeLessThan(viola[i]); expect(f).toBeGreaterThan(cello[i]); });
    const tiny = stringsForSize(-0.5), giant = stringsForSize(2.0);
    expect(tiny[0]).toBeGreaterThan(instrumentPresetById('violin')!.strings[0]);
    expect(giant[0]).toBeLessThan(instrumentPresetById('bass')!.strings[0]);
    expect(giant.every(f => f > 0 && Number.isFinite(f))).toBe(true);
  });

  it('only changes the tuning when asked to', () => {
    const pm = defaultPhysMod('violin');
    pm.bodySize = 0.72;
    expect(openStrings(pm)).toEqual(instrumentPresetById('violin')!.strings);
    pm.tuningFollowsSize = true;
    openStrings(pm).forEach((f, i) => expect(Math.abs(cents(f, instrumentPresetById('cello')!.strings[i]))).toBeLessThan(0.01));
  });
});

describe('bowed-string track settings', () => {
  it('repairs a song saved before the laboratory controls existed', () => {
    const old = { instrument: 'cello', bowForce: 0.67, bowVelocity: 0.5, bowPosition: 0.15, vibratoRate: 5.5, vibratoDepth: 15, damping: 0.2, brightness: 0.57, bodySize: 0.6, bodyMix: 0.55, audition: true, auditionNote: 60 };
    const pm = repairPhysMod(old);
    expect(pm.instrument).toBe('cello');
    expect(pm.bowForce).toBe(0.67);
    expect(pm.bodySize).toBe(0.6);
    expect(pm.articulation).toBe('arco');
    expect(pm.coupling).toBeGreaterThan(0);
    expect(pm.sympathetic).toEqual([]);
    expect(pm.physicsView).toBe(false);
  });

  it('clamps nonsense and drops invalid sympathetic strings', () => {
    const pm = repairPhysMod({ instrument: 'kazoo', bowForce: 7, bowPosition: -1, bodySize: 99, articulation: 'slap', sympathetic: [440, -3, 'x', NaN, 220] });
    expect(pm.instrument).toBe('violin');
    expect(pm.bowForce).toBe(1);
    expect(pm.bowPosition).toBe(0.02);
    expect(pm.bodySize).toBe(2.5);
    expect(pm.articulation).toBe('arco');
    expect(pm.sympathetic).toEqual([440, 220]);
  });

  it('switching preset changes the instrument but keeps the playing', () => {
    const pm = defaultPhysMod('violin');
    pm.bowForce = 0.7; pm.vibratoDepth = 30; pm.articulation = 'pizzicato';
    expect(applyPreset(pm, 'glass')).toBe(true);
    expect(pm.instrument).toBe('glass');
    expect(pm.stiffness).toBeGreaterThan(0.5);
    expect(pm.bowForce).toBe(0.7);
    expect(pm.vibratoDepth).toBe(30);
    expect(pm.articulation).toBe('pizzicato');
    expect(applyPreset(pm, 'nope')).toBe(false);
  });

  it('sends a note with the whole instrument, played on the track', () => {
    const pm = defaultPhysMod('hardanger');
    const cfg = noteConfig('t1', pm, { freq: 587.33, velocity: 0.7, duration: 0.5, startTime: 1.25 });
    expect(cfg.instrument).toBe('t1');
    expect(cfg.strings).toEqual(instrumentPresetById('hardanger')!.strings);
    expect(cfg.sympathetic.length).toBe(5);
    expect(cfg.articulation).toBe('arco');
    expect(cfg.duration).toBe(0.5);
    expect(cfg.startTime).toBe(1.25);
  });

  it('picks the string a player would', () => {
    const violin = instrumentPresetById('violin')!.strings;
    expect(stringForFreq(violin, 196)).toBe(0);
    expect(stringForFreq(violin, 440)).toBe(2);
    expect(stringForFreq(violin, 100)).toBe(0);
    expect(stringForFreq(violin, 2000)).toBe(3);
  });
});
