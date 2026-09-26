// Telemetry: what the physical models were doing at every video frame (written by the reel's
// Rust exporter), plus the views' smoothing state (scale references, envelopes), precomputed so
// that any frame can be drawn on its own.
'use strict';

const D = { T: null, brass: {}, strings: {}, kit: null, geo: [], mixEnv: null };
const DT = 1 / FPS;

async function loadData() {
  const T = await (await fetch('../out/telemetry.json')).json();
  D.T = T;
  try { const m = await (await fetch('../out/mix_env.json')).json(); D.mixEnv = m.rms; D.spec = m.spec; } catch (e) { D.mixEnv = T.mixRms; }
  for (const p of T.brass) D.brass[p.name] = prepBrass(p);
  for (const p of T.strings) D.strings[p.name] = prepStrings(p);
  D.kit = prepKit(T.kit);
  D.slot = T.slotCentre;
}

const INSTRUMENT_NAMES = ['TENOR TROMBONE', 'TRUMPET', 'FRENCH HORN', 'TUBA'];

function prepBrass(p) {
  const n = p.frames.length;
  const scaleRef = new Float32Array(n), energyRef = new Float32Array(n);
  const env = [];
  let sr = 50, er = 1e-4, e = new Float32Array(96);
  const decay = Math.exp(-DT / 0.5);
  for (let f = 0; f < n; f++) {
    const fr = p.frames[f];
    let peak = 0;
    for (const v of fr.bore) peak = Math.max(peak, Math.abs(v));
    sr = peak > sr ? peak : Math.max(sr * Math.exp(-DT / 2), peak, 50);
    scaleRef[f] = sr;
    const e2 = new Float32Array(96);
    for (let i = 0; i < 96; i++) e2[i] = Math.max(e[i] * decay, Math.abs(fr.bore[i]));
    env.push(e2); e = e2;
    er = fr.rms > er ? fr.rms : Math.max(er * Math.exp(-DT / 3), 1e-4);
    energyRef[f] = er;
  }
  return { ...p, scaleRef, energyRef, env };
}

function geometry(id) {
  if (D.geo[id]) return D.geo[id];
  const g = D.T.geometry[id];
  const a = g.pts, n = a.length / 11, pts = [];
  for (let k = 0; k < n; k++) {
    const o = k * 11;
    pts.push({ pos: [a[o], a[o + 1], a[o + 2]], n: [a[o + 3], a[o + 4], a[o + 5]], b: [a[o + 6], a[o + 7], a[o + 8]], r: a[o + 9], open: a[o + 10], along: k / (n - 1) });
  }
  const loops = g.loops.map((l) => { const out = []; for (let k = 0; k < l.length; k += 3) out.push([l[k], l[k + 1], l[k + 2]]); return out; });
  D.geo[id] = { inst: g.inst, pts, loops, valves: g.valves };
  return D.geo[id];
}

function pressureAt(values, along) {
  const f = clamp01(along) * (values.length - 1);
  const i = Math.min(Math.floor(f), values.length - 2);
  const t = f - i;
  return values[i] * (1 - t) + values[i + 1] * t;
}

// Bowed strings: each string's display reference (its own recent peak), the instrument's, and the
// standing-wave envelope in display units.
const DISPLAY_GAIN = 0.16;
function prepStrings(p) {
  const n = p.frames.length;
  const ns = p.frames[0].strings.length;
  const ref = [], scaleRef = new Float32Array(n), env = [], level = new Float32Array(n);
  let r = new Float32Array(ns).fill(1e-6), sref = 1e-6, e = Array.from({ length: ns }, () => new Float32Array(64));
  let lv = 1e-4;
  for (let f = 0; f < n; f++) {
    const fr = p.frames[f];
    const r2 = new Float32Array(ns);
    let top = 0;
    for (let s = 0; s < ns; s++) {
      let peak = 0;
      for (const v of fr.strings[s].shape) peak = Math.max(peak, Math.abs(v));
      r2[s] = peak > r[s] ? peak : Math.max(r[s] * Math.exp(-DT / 1.2), peak, 1e-6);
      top = Math.max(top, r2[s]);
    }
    sref = top > sref ? top : Math.max(sref * Math.exp(-DT / 1.2), top, 1e-6);
    const e2 = [];
    for (let s = 0; s < ns; s++) {
      const scale = Math.max(r2[s], sref * 0.25);
      const arr = new Float32Array(64);
      const dec = Math.exp(-DT / 0.35);
      for (let k = 0; k < 64; k++) arr[k] = Math.max(e[s][k] * dec, Math.abs(clamp(fr.strings[s].shape[k] / scale, -1.5, 1.5) * DISPLAY_GAIN));
      e2.push(arr);
    }
    ref.push(r2); scaleRef[f] = sref; env.push(e2); e = e2; r = r2;
    lv = fr.rms > lv ? fr.rms : Math.max(lv * Math.exp(-DT / 2), 1e-4);
    level[f] = lv;
  }
  return { ...p, ref, scaleRef, env, levelRef: level };
}

// The kit: each piece's display reference and the snare wires' glow.
function prepKit(k) {
  const n = k.frames.length;
  const sref = [], wires = new Float32Array(n);
  let s = new Float32Array(7).fill(1e-7), w = 0;
  let etop = 1e-12;
  const energyTop = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    const fr = k.frames[f];
    const s2 = new Float32Array(7);
    for (let i = 0; i < 7; i++) {
      const pv = fr.pieces[i];
      let peak = 0;
      if (pv.field) for (const v of pv.field) peak = Math.max(peak, Math.abs(v));
      s2[i] = peak > s[i] ? peak : Math.max(s[i] * Math.exp(-DT / 1.5), peak, 1e-7);
      etop = Math.max(etop * Math.exp(-DT / 4), pv.energy || 0, 1e-12);
    }
    energyTop[f] = etop;
    sref.push(s2); s = s2;
    w = Math.max(w * Math.exp(-DT / 0.12), Math.min(1, (fr.pieces[1].wires || 0) / 4));
    wires[f] = w;
  }
  return { ...k, sref, wires, energyTop };
}

// Hits on one piece up to time t (from the exported hit list): [time, piece, speed, position, angle].
function lastHit(piece, t) {
  let best = null;
  for (const h of D.T.kit.hits) if (h[1] === piece && h[0] <= t + 1e-6) best = h;
  return best;
}
function hitsIn(t0, t1, piece = -1) {
  return D.T.kit.hits.filter((h) => h[0] >= t0 && h[0] < t1 && (piece < 0 || h[1] === piece));
}

const PIECE_NAMES = ['KICK', 'SNARE', 'RACK TOM', 'FLOOR TOM', 'CRASH', 'RIDE', 'SPLASH'];
