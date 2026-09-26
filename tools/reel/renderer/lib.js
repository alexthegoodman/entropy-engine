// Shared pieces of the reel renderer: the instrument views' palette, easing, the orbit projector
// the views use, glowing strokes and type. Everything is a pure function of time, so any frame can
// be rendered on its own.
'use strict';

const W = 1920, H = 1080, FPS = 60;

// The palette of BrassView / PhysModView / MatterView (src/entropy_gui/widgets_*.rs).
const C = {
  bgTop: [0.028, 0.032, 0.070],
  bgBot: [0.060, 0.050, 0.120],
  brass: [1.0, 0.74, 0.30],
  amber: [1.0, 0.78, 0.36],
  teal: [0.28, 0.90, 0.84],
  violet: [0.58, 0.45, 1.0],
  rose: [1.0, 0.36, 0.42],
  sky: [0.45, 0.62, 1.0],
  dim: [0.34, 0.34, 0.46],
  head: [0.70, 0.74, 0.90],
  wood: [0.85, 0.52, 0.22],
  label: [170 / 255, 176 / 255, 205 / 255],
  white: [1, 1, 1],
  black: [0, 0, 0],
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => { t = clamp01(t); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
const rgba = (c, a = 1) => `rgba(${Math.round(clamp01(c[0]) * 255)},${Math.round(clamp01(c[1]) * 255)},${Math.round(clamp01(c[2]) * 255)},${clamp01(a).toFixed(4)})`;
const ramp = (t, a, b) => clamp01((t - a) / (b - a));
const TAU = Math.PI * 2;

const ease = {
  inOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  outCubic: (x) => 1 - Math.pow(1 - x, 3),
  inCubic: (x) => x * x * x,
  inOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  inOutQuint: (x) => (x < 0.5 ? 16 * x ** 5 : 1 - Math.pow(-2 * x + 2, 5) / 2),
  outExpo: (x) => (x >= 1 ? 1 : 1 - Math.pow(2, -10 * x)),
  inExpo: (x) => (x <= 0 ? 0 : Math.pow(2, 10 * x - 10)),
};

// Eased 0..1 over [a, b].
const tw = (t, a, b, e = ease.inOutCubic) => e(ramp(t, a, b));
// Visibility envelope: fades in over [a, a+fi], out over [b-fo, b].
const env = (t, a, b, fi = 0.2, fo = 0.2) => Math.min(ramp(t, a, a + fi), 1 - ramp(t, b - fo, b));
const decayAfter = (t, t0, k) => (t < t0 ? 0 : Math.exp(-(t - t0) * k));

// Deterministic noise.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash1(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function vnoise(x) { const i = Math.floor(x), f = x - i; const u = f * f * (3 - 2 * f); return lerp(hash1(i), hash1(i + 1), u) * 2 - 1; }

// ---------------------------------------------------------------------------------------------
// Vectors and the orbit projector (the views' `Projector`, with a cinematic zoom, pan and roll)
// ---------------------------------------------------------------------------------------------

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.max(1e-9, Math.hypot(a[0], a[1], a[2])); return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

class Proj {
  // target: world point looked at; yaw/pitch/dist as the views' Camera; focal in px; (cx, cy) the
  // screen point the target lands on; roll in radians.
  constructor({ target, yaw, pitch, dist, focal = 1000, cx = W / 2, cy = H / 2, roll = 0 }) {
    const sy = Math.sin(yaw), cyw = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    this.eye = [target[0] + dist * cp * sy, target[1] + dist * sp, target[2] + dist * cp * cyw];
    this.fwd = v3.norm(v3.sub(target, this.eye));
    this.right = v3.norm(v3.cross(this.fwd, [0, 1, 0]));
    this.up = v3.cross(this.right, this.fwd);
    this.focal = focal; this.cx = cx; this.cy = cy;
    this.cr = Math.cos(roll); this.sr = Math.sin(roll);
  }
  raw(w) {
    const v = v3.sub(w, this.eye);
    const depth = v3.dot(v, this.fwd);
    if (depth < 0.02) return null;
    return [v3.dot(v, this.right) / depth, -v3.dot(v, this.up) / depth, depth];
  }
  p(w) {
    const r = this.raw(w);
    if (!r) return null;
    const x = r[0] * this.focal, y = r[1] * this.focal;
    return [this.cx + x * this.cr - y * this.sr, this.cy + x * this.sr + y * this.cr, r[2]];
  }
  // Fit: the focal and centre that fit `pts` (world) into `rect` [x0, y0, x1, y1], as the views do.
  fit(pts, rect, fill = 0.96) {
    let lo = [1e9, 1e9], hi = [-1e9, -1e9];
    for (const w of pts) {
      const r = this.raw(w);
      if (!r) continue;
      lo = [Math.min(lo[0], r[0]), Math.min(lo[1], r[1])];
      hi = [Math.max(hi[0], r[0]), Math.max(hi[1], r[1])];
    }
    const bw = Math.max(1e-3, hi[0] - lo[0]), bh = Math.max(1e-3, hi[1] - lo[1]);
    const aw = rect[2] - rect[0], ah = rect[3] - rect[1];
    const focal = Math.min(aw / bw, ah / bh) * fill;
    // Screen position the target's projection (0,0) must go to for the box to be centred.
    return { focal, cx: (rect[0] + rect[2]) / 2 - ((lo[0] + hi[0]) / 2) * focal, cy: (rect[1] + rect[3]) / 2 - ((lo[1] + hi[1]) / 2) * focal };
  }
}

function boxCorners(lo, hi) {
  const out = [];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) out.push([x, y, z]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Glowing strokes: the views' `polyline` (a wide faint glow under a bright core), additive
// ---------------------------------------------------------------------------------------------

const S = 1.35; // stroke scale: the views are drawn at ~800 px tall, the reel at 1080

function pathOf(ctx, pts, closed) {
  ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (!p) { started = false; continue; }
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
  }
  if (closed) ctx.closePath();
}

function glow(ctx, pts, col, alpha, glowW, coreW, closed = false) {
  if (!pts || pts.length < 2 || alpha <= 0.002) return;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  pathOf(ctx, pts, closed);
  if (glowW > 0) {
    ctx.strokeStyle = rgba(col, alpha * 0.28);
    ctx.lineWidth = glowW * S;
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(mix3(col, C.white, 0.25), alpha);
  ctx.lineWidth = coreW * S;
  ctx.stroke();
}

function seg(ctx, a, b, col, alpha, w) {
  if (!a || !b || alpha <= 0.002) return;
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = rgba(col, alpha); ctx.lineWidth = w * S; ctx.stroke();
}

function dot(ctx, p, r, col, alpha) {
  if (!p || alpha <= 0.002) return;
  ctx.beginPath(); ctx.arc(p[0], p[1], r * S, 0, TAU);
  ctx.fillStyle = rgba(col, alpha); ctx.fill();
}

function fillPoly(ctx, pts, col, alpha) {
  if (!pts || pts.length < 3 || alpha <= 0.002) return;
  pathOf(ctx, pts, true);
  ctx.fillStyle = rgba(col, alpha); ctx.fill();
}

// ---------------------------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------------------------

const DISPLAY = 'Figtree';
const MONO = 'JetBrains Mono';

function font(ctx, size, weight = 400, family = DISPLAY, tracking = 0) {
  ctx.font = `${weight} ${size}px "${family}"`;
  ctx.letterSpacing = `${tracking}px`;
}

function text(ctx, str, x, y, { size = 16, weight = 400, family = DISPLAY, col = C.label, alpha = 1, align = 'left', base = 'alphabetic', tracking = 0 } = {}) {
  if (alpha <= 0.002) return 0;
  font(ctx, size, weight, family, tracking);
  ctx.textAlign = align; ctx.textBaseline = base;
  ctx.fillStyle = rgba(col, alpha);
  ctx.fillText(str, x, y);
  return ctx.measureText(str).width;
}

function measure(ctx, str, size, weight = 400, family = DISPLAY, tracking = 0) {
  font(ctx, size, weight, family, tracking);
  return ctx.measureText(str).width;
}

// A line of type revealed from behind a mask: it rises out of a slot (p: 0..1).
function maskRise(ctx, str, x, y, p, opts) {
  const size = opts.size;
  const off = (1 - p) * size * 1.05;
  ctx.save();
  ctx.beginPath();
  const w = measure(ctx, str, size, opts.weight, opts.family, opts.tracking || 0) + size;
  const x0 = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x - size * 0.1;
  ctx.rect(x0, y - size * 1.0, w + size * 0.2, size * 1.28);
  ctx.clip();
  text(ctx, str, x, y + off, opts);
  ctx.restore();
}

// Mono label that decodes from scrambled glyphs (p: 0..1), deterministic per frame.
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%/<>=+*';
function decode(str, p, seed) {
  const n = str.length;
  if (p >= 1) return str;
  const shown = Math.floor((n + 3) * clamp01(p));
  const rnd = mulberry32(seed);
  let out = '';
  for (let i = 0; i < n; i++) {
    const c = str[i];
    if (i < shown - 3 || c === ' ') out += c;
    else if (i < shown) out += GLYPHS[Math.floor(rnd() * GLYPHS.length)];
    else out += ' ';
  }
  return out;
}

function noteName(freq) {
  if (!(freq > 0)) return '';
  const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  const midi = Math.round(69 + 12 * Math.log2(freq / 440));
  return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

function sci(v, d = 1) {
  if (!(v > 0)) return '0';
  const e = Math.floor(Math.log10(v));
  return `${(v / 10 ** e).toFixed(d)}e${e}`;
}
