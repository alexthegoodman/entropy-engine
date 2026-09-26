// The reel's timeline: 15 s at 60 fps, cut to the score (120 BPM from 3.0 s; hits at 2.5 and 12.5).
'use strict';

let OV = null;
const HITS = { first: 2.5, final: 12.5, button: 14.12 };
const SECTIONS = [
  { t: 0.0, id: '01', name: 'AIR COLUMN' },
  { t: 3.0, id: '01', name: 'BRASS FAMILY' },
  { t: 5.0, id: '02', name: 'BOWED STRING' },
  { t: 7.0, id: '03', name: 'MEMBRANES' },
  { t: 9.0, id: '04', name: 'PLATES' },
  { t: 10.5, id: '05', name: 'PHYSICS VIEW' },
  { t: 12.5, id: '06', name: 'ENTROPY DAW' },
];

// ---------------------------------------------------------------------------------------------
// Frame-wide helpers
// ---------------------------------------------------------------------------------------------

function background(ctx, t, glowCol, glowAt, glowAmt) {
  ctx.globalCompositeOperation = 'source-over';
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgba(C.bgTop, 1));
  g.addColorStop(1, rgba(C.bgBot, 1));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  if (glowAmt > 0) {
    const r = ctx.createRadialGradient(glowAt[0], glowAt[1], 0, glowAt[0], glowAt[1], 900);
    r.addColorStop(0, rgba(glowCol, 0.16 * glowAmt));
    r.addColorStop(0.5, rgba(glowCol, 0.05 * glowAmt));
    r.addColorStop(1, rgba(glowCol, 0));
    ctx.fillStyle = r;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'lighter';
}

// Dust drifting in the dark, a little parallax with the camera's yaw.
function dust(ctx, t, yaw, alpha) {
  const rnd = mulberry32(99);
  for (let k = 0; k < 90; k++) {
    const z = 0.3 + rnd() * 0.7;
    const x = ((rnd() * W * 1.4 + t * 12 * z - yaw * 260 * z) % (W * 1.4) + W * 1.4) % (W * 1.4) - W * 0.2;
    const y = rnd() * H + Math.sin(t * 0.4 + k) * 8;
    const tw_ = 0.5 + 0.5 * Math.sin(t * (1 + rnd() * 2) + k);
    dot(ctx, [x, y], 0.9 * z + 0.3, C.label, alpha * (0.05 + 0.1 * tw_) * z);
  }
}

// Screen shake from the hits: decaying noise, in px and radians.
function shake(t) {
  let x = 0, y = 0, r = 0;
  const hit = (t0, amp, k) => {
    if (t < t0) return;
    const d = Math.exp(-(t - t0) * k) * amp;
    x += vnoise(t * 38 + t0 * 11) * d; y += vnoise(t * 41 + t0 * 7 + 5) * d; r += vnoise(t * 29 + t0) * d * 0.0012;
  };
  hit(HITS.first, 26, 7); hit(HITS.final, 30, 6); hit(HITS.button, 10, 9);
  hit(7.0, 8, 12); hit(9.0, 12, 9); hit(8.0, 5, 14); hit(8.5, 4, 14);
  for (const s of [3.5, 4.0, 4.5]) hit(s, 5, 14);
  return { x, y, r };
}

function withXf(ctx, { x = 0, y = 0, s = 1, r = 0, ox = W / 2, oy = H / 2 }, fn) {
  ctx.save();
  ctx.translate(ox + x, oy + y);
  ctx.rotate(r);
  ctx.scale(s, s);
  ctx.translate(-ox, -oy);
  fn();
  ctx.restore();
}

// A projector through a world transform (normalising an instrument's size).
function xfProj(proj, centre, scale) {
  const T = (w) => [(w[0] - centre[0]) * scale, (w[1] - centre[1]) * scale, (w[2] - centre[2]) * scale];
  return { p: (w) => proj.p(T(w)), raw: (w) => proj.raw(T(w)) };
}

// ---------------------------------------------------------------------------------------------
// HUD: the reel's chrome
// ---------------------------------------------------------------------------------------------

function scrim(x0, x1, alpha, y0 = 0, y1 = H) {
  if (alpha <= 0.01) return;
  const g = OV.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, `rgba(4,4,12,${0.62 * alpha})`);
  g.addColorStop(0.55, `rgba(4,4,12,${0.38 * alpha})`);
  g.addColorStop(1, 'rgba(4,4,12,0)');
  OV.fillStyle = g;
  OV.fillRect(0, y0, x1, y1 - y0);
}
function blob(x, y, rx, ry, alpha) {
  if (alpha <= 0.01) return;
  OV.save(); OV.translate(x, y); OV.scale(rx / ry, 1);
  const g = OV.createRadialGradient(0, 0, 0, 0, 0, ry);
  g.addColorStop(0, `rgba(4,4,12,${0.6 * alpha})`); g.addColorStop(1, 'rgba(4,4,12,0)');
  OV.fillStyle = g; OV.fillRect(-ry, -ry, 2 * ry, 2 * ry);
  OV.restore();
}
// A section's number rolling up, its title rising, and a rule drawing under them.
function sectionTitle(lx, t, t0, num, title, sub, col, f) {
  const la = ramp(t, t0, t0 + 0.15);
  maskRise(OV, num, lx, 330, tw(t, t0, t0 + 0.35, ease.outExpo), { size: 150, weight: 200, col, tracking: -4 });
  maskRise(OV, title, lx, 440, tw(t, t0 + 0.04, t0 + 0.42, ease.outExpo), { size: 96, weight: 900, col: C.white, tracking: 2 });
  const rw = 90 * tw(t, t0 + 0.1, t0 + 0.5, ease.outExpo);
  OV.fillStyle = rgba(col, 0.9 * la); OV.fillRect(lx + 4, 462, rw, 3);
  text(OV, decode(sub, ramp(t, t0 + 0.08, t0 + 0.5), f), lx + 4, 500, { size: 18, family: MONO, weight: 500, col: C.label, alpha: la, tracking: 4 });
}

function timecode(f) {
  const s = Math.floor(f / FPS), fr = f % FPS;
  return `00:00:${String(s).padStart(2, '0')}:${String(fr).padStart(2, '0')}`;
}

function hud(ctx, t, f, alpha) {
  if (alpha <= 0.01) return;
  const a = alpha;
  const m = 40, L = 26;
  ctx.globalCompositeOperation = 'source-over';
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]]) {
    seg(ctx, [x, y], [x + sx * L, y], C.label, 0.35 * a, 1);
    seg(ctx, [x, y], [x, y + sy * L], C.label, 0.35 * a, 1);
  }
  const top = m + 30;
  const w0 = text(OV, 'ENTROPY DAW', m + 36, top, { size: 14, family: MONO, weight: 700, col: C.white, alpha: 0.8 * a, tracking: 3 });
  text(OV, '/  PHYSICALLY MODELLED — REEL 2026', m + 36 + w0 + 18, top, { size: 14, family: MONO, col: C.label, alpha: 0.55 * a, tracking: 2 });
  text(OV, timecode(f), W - m - 36, top, { size: 14, family: MONO, weight: 500, col: C.white, alpha: 0.75 * a, align: 'right', tracking: 2 });
  // Recording-light dot pulsing with the music.
  const lv = D.mixEnv ? clamp01((D.mixEnv[Math.min(f, 899)] || 0) * 4) : 0;
  dot(ctx, [W - m - 36 - 196, top - 5], 4, C.rose, 0.35 + 0.6 * lv);
  // Section.
  let sec = SECTIONS[0];
  for (const s of SECTIONS) if (t >= s.t) sec = s;
  const bot = H - m - 22;
  const since = t - sec.t;
  const label = decode(`${sec.id} — ${sec.name}`, ramp(since, 0, 0.35), f * 7 + 3);
  text(OV, label, m + 36, bot, { size: 14, family: MONO, weight: 500, col: C.white, alpha: 0.75 * a, tracking: 3 });
  // Reel progress: a hairline with the sections ticked.
  const x0 = m + 36, x1 = W - m - 36, py = H - m - 6;
  seg(ctx, [x0, py], [x1, py], C.label, 0.18 * a, 1);
  seg(ctx, [x0, py], [x0 + (x1 - x0) * (t / 15), py], C.teal, 0.8 * a, 1.2);
  for (const s of SECTIONS) { const x = x0 + (x1 - x0) * (s.t / 15); seg(ctx, [x, py - 5], [x, py + 5], t >= s.t ? C.teal : C.label, (t >= s.t ? 0.9 : 0.3) * a, 1); }
  if (D.spec) {
    const sp = D.spec[Math.min(f, D.spec.length - 1)];
    const bw = 9, gapx = 4, n = sp.length, x0s = W - m - 36 - n * (bw + gapx), yb = bot - 34;
    for (let k = 0; k < n; k++) {
      const hgt = 2 + 30 * sp[k];
      ctx.fillStyle = rgba(mix3(C.teal, C.amber, k / n), (0.25 + 0.6 * sp[k]) * a);
      ctx.fillRect(x0s + k * (bw + gapx), yb - hgt, bw, hgt);
    }
    text(ctx, 'MASTER', x0s - 12, yb, { size: 11, family: MONO, weight: 500, col: C.label, alpha: 0.6 * a, align: 'right', tracking: 2 });
  }
  const claim = 'RECORDED SAMPLES USED: 0';
  text(OV, claim, W - m - 36, bot, { size: 14, family: MONO, weight: 500, col: C.teal, alpha: 0.8 * a, align: 'right', tracking: 3 });
}

// ---------------------------------------------------------------------------------------------
// Scene 1 (0 - 2.5 s): one breath, pianissimo to a shocked wavefront. The air column builds the
// instrument; the camera pulls back from the lips.
// ---------------------------------------------------------------------------------------------

function tromboneCam(t, geoFit) {
  const [lo, hi] = [[-0.45, -0.04, -0.16], [0.86, 0.45, 0.16]];
  const centre = v3.scale(v3.add(lo, hi), 0.5);
  const u = tw(t, 0.35, 1.9, ease.inOutQuint);
  const push = tw(t, 1.9, 2.5, ease.inCubic);
  const drift = tw(t, 1.2, 2.45, ease.inOutQuad);
  const yaw = lerp(1.35, 0.52, u) - 0.12 * push + 0.26 * drift;
  const pitch = lerp(0.22, 0.4, u) + 0.05 * push + 0.05 * drift;
  // Framing of the whole instrument on the right two thirds.
  const wide = new Proj({ target: centre, yaw, pitch, dist: 4.4, focal: 1000 });
  const fit = wide.fit(boxCorners(lo, hi), [900, 170, 1840, 930], 0.94);
  const lipsT = [-0.03, 0.0, 0.0];
  const target = v3.lerp(lipsT, centre, u);
  const dist = Math.exp(lerp(Math.log(0.42), Math.log(4.4), u));
  // Focal that keeps the same scale per metre at the target as the fit, from the close-up's.
  const closeFocal = 3400;
  const focal = Math.exp(lerp(Math.log(closeFocal), Math.log(fit.focal), u));
  let cx = lerp(W * 0.7, fit.cx, u), cy = lerp(H * 0.5, fit.cy, u);
  // The push toward the bell on the way into the hit.
  const bell = [0.62, 0.21, 0.0];
  const tgt = v3.lerp(target, bell, push * 0.85);
  const f2 = focal * Math.exp(push * push * 1.6);
  cx = lerp(cx, W * 0.5, push); cy = lerp(cy, H * 0.5, push);
  return new Proj({ target: tgt, yaw, pitch, dist: dist * (1 - 0.35 * push), focal: f2, cx, cy, roll: -0.03 * push });
}

function sceneBreath(ctx, t, f, post) {
  if (t >= 2.5) return;
  const B = brassFrame('tbn1', f);
  const proj = tromboneCam(t, B.P.fit);
  const reveal = ease.inOutCubic(ramp(t, 0.18, 1.45));
  const intro = ramp(t, 0.0, 0.35);
  const steep = steepness01(B.fr.steep);
  background(ctx, t, mix3(C.amber, C.rose, steep), proj.p([0.5, 0.2, 0]) || [W * 0.6, H / 2], 0.4 + 1.2 * clamp01(B.fr.rms / 0.2));
  dust(ctx, t, 0.3 * t, intro);
  drawBrass(ctx, proj, B, t, { alpha: intro, reveal: Math.max(reveal, 0.001), physics: false, glowBoost: 1.1 });

  // Cold open: the equations the lips are solved with (docs/PHYS_MOD_BRASS.md), typing on.
  const ea = env(t, 0.1, 1.25, 0.1, 0.3);
  if (ea > 0) {
    const eq1 = 'm·h″ + (m·ω/Q)·h′ + m·ω²·(h − h₀) = S·(p_m − p)';
    const eq2 = 'U = w·h·√(2·|p_m − p| / ρ)';
    const n1 = Math.floor(eq1.length * ramp(t, 0.12, 0.62)), n2 = Math.floor(eq2.length * ramp(t, 0.45, 0.8));
    const ex = W * 0.7, ey = 870 - 60 * tw(t, 0.6, 1.25, ease.inOutCubic);
    blob(ex, ey + 4, 520, 80, ea);
    text(OV, eq1.slice(0, n1), ex, ey, { size: 24, family: MONO, col: C.label, alpha: 0.9 * ea, align: 'center' });
    text(OV, eq2.slice(0, n2), ex, ey + 38, { size: 24, family: MONO, col: C.label, alpha: 0.7 * ea, align: 'center' });
    text(OV, decode('THE LIPS — A MASS ON A SPRING, BLOWN OPEN BY THE BREATH', ramp(t, 0.2, 0.7), f), ex, ey - 46, { size: 13, family: MONO, weight: 500, col: C.rose, alpha: 0.85 * ea, align: 'center', tracking: 3 });
  }
  // Words.
  const tx = 150;
  const outT = tw(t, 2.22, 2.42, ease.inCubic);
  OV.save();
  OV.globalAlpha = 1 - outT;
  maskRise(OV, 'THIS IS NOT', tx, 470 - outT * 30, tw(t, 0.5, 1.05, ease.outExpo), { size: 104, weight: 300, col: C.label, tracking: 2 });
  maskRise(OV, 'A SAMPLE.', tx, 612 - outT * 30, tw(t, 0.68, 1.25, ease.outExpo), { size: 150, weight: 900, col: C.white, tracking: -2 });
  OV.restore();
  ctx.save();
  ctx.globalAlpha = (1 - outT) * 0.35;
  maskRise(ctx, 'A SAMPLE.', tx, 612 - outT * 30, tw(t, 0.68, 1.25, ease.outExpo), { size: 150, weight: 900, col: mix3(C.amber, C.rose, steep), tracking: -2 });
  ctx.restore();

  // Live readout from the model.
  const ra = env(t, 0.95, 2.45, 0.25, 0.08);
  if (ra > 0) {
    const y0 = 770;
    const fr = B.fr;
    const hz = fr.hz > 0 ? fr.hz : fr.target;
    text(OV, decode(`TENOR TROMBONE  ${noteName(fr.target)}  ${hz.toFixed(1)} Hz`, ramp(t, 0.95, 1.35), f), tx, y0, { size: 18, family: MONO, weight: 500, col: C.brass, alpha: ra, tracking: 1 });
    const kpa = fr.pm / 1000;
    text(OV, `breath ${kpa.toFixed(1).padStart(4, ' ')} kPa`, tx, y0 + 34, { size: 16, family: MONO, col: C.label, alpha: ra });
    // Breath bar: 0.5 kPa .. 16 kPa, log.
    const bx = tx + 210, bw = 300;
    const bt = clamp01(Math.log(Math.max(kpa, 0.5) / 0.5) / Math.log(32));
    ctx.fillStyle = rgba(C.dim, 0.35 * ra); ctx.fillRect(bx, y0 + 26, bw, 6);
    ctx.fillStyle = rgba(mix3(C.teal, C.rose, steep), 0.9 * ra); ctx.fillRect(bx, y0 + 26, bw * bt, 6);
    text(OV, `bell slope ${sci(fr.steep)} Pa/s`, tx, y0 + 64, { size: 16, family: MONO, col: C.label, alpha: ra });
    const [lab, col] = brassTone(fr.steep);
    text(OV, lab, tx, y0 + 100, { size: 22, family: MONO, weight: 700, col, alpha: ra });
  }
  post.bloom = 0.8 + 0.7 * steep;
  post.zoomBlur = 0.1 * tw(t, 2.2, 2.5, ease.inExpo);
  post.ca = 0.0015 + 0.004 * tw(t, 2.1, 2.5, ease.inExpo);
  return proj;
}

// ---------------------------------------------------------------------------------------------
// Scene 2 (2.5 - 3.0 s): THE HIT.
// ---------------------------------------------------------------------------------------------

function sceneHit(ctx, t, f, post) {
  if (t < 2.5 || t >= 3.0) return;
  const lt = t - 2.5;
  const B = brassFrame('tbn1', f);
  // Down the bell's axis, a little off it: the rim a big ring behind the words, the tubing
  // coiling away into the dark behind it.
  const pts = B.geo.pts;
  const mouthPt = pts[pts.length - 1];
  const mouth = mouthPt.pos;
  const axis = v3.norm(v3.sub(mouth, pts[pts.length - 8].pos));
  const yaw = Math.atan2(axis[0], axis[2]) + 0.22 + 0.25 * lt;
  const pitch = Math.asin(clamp(axis[1], -1, 1)) + 0.16;
  const zoom = 1.1 - 0.1 * ease.outExpo(clamp01(lt / 0.5));
  const proj = new Proj({ target: mouth, yaw, pitch, dist: 0.95, focal: 1650 * zoom, cx: W / 2, cy: H / 2 - 30, roll: 0.05 - 0.08 * lt });
  background(ctx, t, C.rose, [W / 2, H / 2], 1.6);
  // Shock rings leaving the bell, filling the frame.
  const bellP = proj.p(B.geo.pts[B.geo.pts.length - 1].pos) || [W / 2, H / 2];
  for (let k = 0; k < 5; k++) {
    const age = lt - k * 0.06;
    if (age < 0) continue;
    const r = 60 + ease.outCubic(clamp01(age / 0.55)) * 1500;
    const a = (1 - clamp01(age / 0.55)) * 0.8;
    ctx.beginPath(); ctx.arc(bellP[0], bellP[1], r, 0, TAU);
    ctx.strokeStyle = rgba(mix3(C.rose, C.amber, k / 5), a * 0.3); ctx.lineWidth = 26; ctx.stroke();
    ctx.strokeStyle = rgba(mix3(C.white, C.amber, 0.3), a); ctx.lineWidth = 2.5; ctx.stroke();
  }
  drawBrass(ctx, proj, B, t, { alpha: 0.8, physics: false, glowBoost: 1.3, beamGain: 0, lips: false });
  // The rim, blazing.
  const rimR = drawnRadius(mouthPt.r);
  const rim = [];
  for (let j = 0; j <= 48; j++) { const a = (TAU * j) / 48; rim.push(proj.p(v3.add(mouth, v3.add(v3.scale(mouthPt.n, rimR * Math.cos(a)), v3.scale(mouthPt.b, rimR * Math.sin(a)))))); }
  glow(ctx, rim, mix3(C.rose, C.amber, 0.35), 0.95, 22, 3);
  // The words.
  const p = ease.outExpo(clamp01(lt / 0.32));
  const out = tw(t, 2.9, 3.0, ease.inCubic);
  const s = lerp(1.35, 1.0, p) * (1 - 0.15 * out);
  const tr = lerp(60, -4, p);
  withXf(ctx, { s, y: -40 }, () => {
    ctx.globalCompositeOperation = 'source-over';
    text(ctx, "IT'S PHYSICS.", W / 2, H / 2 + 66, { size: 220, weight: 900, col: [0.03, 0.02, 0.05], alpha: 0.55 * (1 - out), align: 'center', tracking: tr });
    ctx.globalCompositeOperation = 'lighter';
    text(ctx, "IT'S PHYSICS.", W / 2, H / 2 + 60, { size: 220, weight: 900, col: [1, 0.55, 0.5], alpha: 0.5 * (1 - out) * p, align: 'center', tracking: tr });
  });
  withXf(OV, { s, y: -40 }, () => {
    text(OV, "IT'S PHYSICS.", W / 2, H / 2 + 60, { size: 220, weight: 900, col: C.white, alpha: (0.25 + 0.75 * p) * (1 - out), align: 'center', tracking: tr });
  });
  const sub = tw(t, 2.62, 2.8, ease.outCubic) * (1 - out);
  blob(W / 2, H / 2 + 143, 620, 60, sub);
  text(OV, decode('LIPS · AIR COLUMN · BELL — SOLVED 88,200 TIMES A SECOND', ramp(t, 2.6, 2.85), f * 3), W / 2, H / 2 + 150, { size: 20, family: MONO, weight: 500, col: C.label, alpha: sub, align: 'center', tracking: 4 });
  post.flash = 0.9 * decayAfter(t, 2.5, 22);
  post.flashCol = [1, 0.93, 0.85];
  post.bloom = 1.5 - 0.5 * clamp01(lt / 0.5);
  post.ca = 0.014 * decayAfter(t, 2.5, 8) + 0.002;
  post.zoomBlur = 0.12 * decayAfter(t, 2.5, 10);
  return proj;
}

// ---------------------------------------------------------------------------------------------
// Scene 3 (3.0 - 5.0 s): the brass family, one tube morphing player to player on the stabs.
// ---------------------------------------------------------------------------------------------

const FAMILY = [
  { name: 'tbn1', t: 3.0, label: 'TENOR TROMBONE', word: 'TROMBONE' },
  { name: 'tpt1', t: 3.5, label: 'TRUMPET', word: 'TRUMPET' },
  { name: 'hn1', t: 4.0, label: 'FRENCH HORN', word: 'HORN' },
  { name: 'tuba', t: 4.5, label: 'TUBA', word: 'TUBA' },
];

function normalised(B) {
  const [lo, hi] = B.P.fit;
  const c = v3.scale(v3.add(lo, hi), 0.5);
  const d = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  return { c, s: 1.6 / d };
}

function morphedBrass(A, Bb, u) {
  const na = normalised(A), nb = normalised(Bb);
  const pa = A.geo.pts, pb = Bb.geo.pts;
  const pts = pa.map((q, k) => {
    const r = pb[k];
    const posA = v3.scale(v3.sub(q.pos, na.c), na.s), posB = v3.scale(v3.sub(r.pos, nb.c), nb.s);
    return { pos: v3.lerp(posA, posB, u), n: v3.norm(v3.lerp(q.n, r.n, u)), b: v3.norm(v3.lerp(q.b, r.b, u)), r: lerp(q.r * na.s, r.r * nb.s, u), open: lerp(q.open * na.s, r.open * nb.s, u), along: q.along };
  });
  return { ...Bb, geo: { ...Bb.geo, pts, loops: [], valves: [] } };
}

function sceneFamily(ctx, t, f, post, xo = 0) {
  if (t < 3.0 || t >= 5.12) return;
  let cur = 0;
  for (let i = 0; i < FAMILY.length; i++) if (t >= FAMILY[i].t - 0.14) cur = i;
  const item = FAMILY[cur];
  const prev = FAMILY[Math.max(0, cur - 1)];
  const u = cur === 0 ? 1 : tw(t, item.t - 0.14, item.t, ease.inOutQuint);
  const Bcur = brassFrame(item.name, f);
  const Bprev = brassFrame(prev.name, f);
  const YAW = { tbn1: 0.3, tpt1: 0.25, hn1: 0.1, tuba: 0.2 };
  const yaw = lerp(YAW[prev.name], YAW[item.name], u) + 0.3 * Math.sin((t - 3.0) * 0.9), pitch = 0.3 + 0.08 * Math.sin(t * 1.3);
  const punch = FAMILY.reduce((acc, it) => acc + (it.t > 3.0 ? 0.06 * decayAfter(t, it.t, 9) : 0), 0);
  const base = new Proj({ target: [0, 0.02, 0], yaw, pitch, dist: 4.0, focal: 1000 });
  const box = boxCorners([-0.8, -0.35, -0.35], [0.8, 0.35, 0.35]);
  const fit = base.fit(box, [720, 190, 1800, 900], 0.95);
  const proj = new Proj({ target: [0, 0.02, 0], yaw, pitch, dist: 4.0, focal: fit.focal * (1 + punch), cx: fit.cx + xo, cy: fit.cy });
  background(ctx, t, C.brass, [W * 0.66 + xo, H / 2], 0.8 + 3 * punch);
  dust(ctx, t, yaw, 1);
  // Ghost word behind.
  const wa = u < 1 ? 1 - Math.abs(u - 0.5) * 2 : 1;
  ctx.save();
  font(ctx, 300, 900, DISPLAY, 10);
  ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
  ctx.strokeStyle = rgba(C.brass, 0.11 * (u < 1 ? u : 1)); ctx.lineWidth = 2;
  ctx.strokeText(item.word, W - 60 + xo - (t - item.t) * 40, 700);
  ctx.restore();
  if (u < 1) {
    drawBrass(ctx, proj, morphedBrass(Bprev, Bcur, u), t, { alpha: 1, lips: false, beam: false });
  } else {
    const n = normalised(Bcur);
    drawBrass(ctx, xfProj(proj, n.c, n.s), Bcur, t, { alpha: 1, glowBoost: 1.2, lips: true });
  }
  // Labels.
  const lx = 150 + xo;
  const la = env(t, 3.02, 5.1, 0.2, 0.1);
  scrim(xo, 820 + xo, la);
  sectionTitle(lx, t, 3.0, '01', 'BRASS', 'LIPS · AIR COLUMN · BELL', C.brass, f);
  const fr = Bcur.fr;
  const ia = cur === 0 ? la : tw(t, item.t, item.t + 0.12, ease.outCubic) * la;
  const valves = fr.valves ? `valves ${fr.valves & 128 ? 'T+' : ''}${[1, 2, 3, 4].filter((v) => fr.valves & (1 << (v - 1))).join('+') || '—'}` : (item.name === 'tbn1' ? `slide pos ${fr.pos.toFixed(1)}` : 'valves open');
  maskRise(OV, item.label, lx, 640, ia, { size: 40, weight: 700, col: C.brass, tracking: 3 });
  text(OV, `${noteName(fr.target)}  ${(fr.hz || fr.target).toFixed(1)} Hz  ·  partial ${fr.partial}  ·  ${valves}`, lx, 680, { size: 17, family: MONO, col: C.label, alpha: ia * 0.95 });
  const [lab, col] = brassTone(fr.steep);
  text(OV, fr.on ? lab : ' ', lx, 712, { size: 17, family: MONO, weight: 700, col, alpha: ia });
  // A strip of the four, the current one lit.
  FAMILY.forEach((it, k) => {
    const x = lx + k * 120, y = 790;
    const on = k === cur;
    seg(ctx, [x, y], [x + 100, y], on ? C.brass : C.dim, (on ? 0.95 : 0.5) * la, on ? 3 : 1.5);
    text(OV, it.word, x, y + 26, { size: 12, family: MONO, col: on ? C.white : C.label, alpha: (on ? 0.95 : 0.5) * la, tracking: 2 });
  });
  post.flash = FAMILY.reduce((acc, it) => acc + (it.t > 3.0 ? 0.14 * decayAfter(t, it.t, 18) : 0), 0) + 0.25 * decayAfter(t, 3.0, 16);
  post.bloom = 0.95 + 2 * punch;
  post.ca = 0.002 + 0.05 * punch;
  if (u < 1) post.zoomBlur = 0.05 * Math.sin(Math.PI * u);
  return proj;
}

// ---------------------------------------------------------------------------------------------
// Scene 4 (5.0 - 7.0 s): the bowed string.
// ---------------------------------------------------------------------------------------------

function sceneStrings(ctx, t, f, post, xo = 0) {
  if (t < 4.9 || t >= 7.05) return;
  const Sd = stringsFrame('violin', f);
  const lt = t - 5.0;
  const yaw = 0.12 + 0.3 * ease.inOutCubic(clamp01(lt / 2)), pitch = 0.82 - 0.1 * lt;
  const base = new Proj({ target: STR.TARGET, yaw, pitch, dist: 5.4, focal: 1000 });
  const box = boxCorners([-1.05, STR.PLATE_Y, -0.62], [STR.BODY_TOP_X + STR.BODY_LEN, 0.34 * 0.6, 0.62]);
  const fit = base.fit(box, [560, 150, 1840, 960], 1.0);
  const e2 = ease.inOutCubic(clamp01(lt / 2));
  const notePunch = [5.75, 6.0, 6.5].reduce((a, n) => a + 0.035 * decayAfter(t, n, 10), 0);
  const push = (1 + 0.32 * e2) * (1 + notePunch);
  const target = v3.lerp(STR.TARGET, [0.9, -0.02, 0], 0.55 * e2);
  const tp = base.raw(target), cp = base.raw(STR.TARGET);
  const proj = new Proj({ target, yaw, pitch, dist: 5.4, focal: fit.focal * push, cx: fit.cx + xo + 40 + (tp && cp ? (tp[0] - cp[0]) * fit.focal : 0), cy: fit.cy + 10 + (tp && cp ? (tp[1] - cp[1]) * fit.focal : 0) });
  background(ctx, t, C.teal, [W * 0.62 + xo, H * 0.55], 0.9);
  dust(ctx, t, yaw, 1);
  // Bow travel: a stroke per note, alternating direction.
  const notes = [5.0, 5.75, 6.0, 6.5];
  let k = 0; for (let i = 0; i < notes.length; i++) if (t >= notes[i]) k = i;
  const ph = clamp01((t - notes[k]) / 0.7);
  const bowTravel = (k % 2 === 0 ? 1 : -1) * lerp(-0.8, 0.8, ph);
  drawStrings(ctx, proj, Sd, t, { alpha: 1, bodySize: 0, physics: true, exaggeration: 1.3, bowTravel });
  // Labels.
  const lx = 150 + xo;
  const la = env(t, 5.0, 7.05, 0.18, 0.1);
  scrim(xo, 820 + xo, la);
  sectionTitle(lx, t, 5.0, '02', 'STRINGS', 'BOW · STICK–SLIP FRICTION · BODY', C.teal, f);
  const s = Sd.active >= 0 ? Sd.strings[Sd.active] : null;
  if (s) {
    const reg = regime(s);
    maskRise(OV, 'VIOLIN', lx, 640, tw(t, 5.15, 5.5, ease.outExpo), { size: 40, weight: 700, col: C.teal, tracking: 3 });
    text(OV, `${noteName(s.hz)}  ${s.hz.toFixed(1)} Hz  ·  bow ${(s.v * 100).toFixed(0)} cm/s, ${s.f.toFixed(2)} N`, lx, 680, { size: 17, family: MONO, col: C.label, alpha: la * 0.95 });
    text(OV, REGIME_LABEL[reg], lx, 712, { size: 17, family: MONO, weight: 700, col: REGIME_COL[reg], alpha: la });
  }
  panelSchelleng(ctx, [lx - 4, 770, 420, 200], Sd, la * tw(t, 5.3, 5.6, ease.outCubic));
  post.bloom = 0.95;
  return proj;
}

// ---------------------------------------------------------------------------------------------
// Scene 5 (7.0 - 9.0 s): the drums. Cuts land on the hits.
// ---------------------------------------------------------------------------------------------

function kitCamAt(t) {
  // Shots: [start, kind, piece]
  const shots = [[7.0, 'wide'], [7.5, 'close', 1], [7.75, 'close', 2], [8.0, 'wide2'], [8.5, 'close', 1], [8.625, 'sweep']];
  let s = shots[0];
  for (const sh of shots) if (t >= sh[0]) s = sh;
  return s;
}

function sceneDrums(ctx, t, f, post) {
  if (t < 7.0 || t >= 9.0) return;
  const Kf = kitFrame(f);
  const shot = kitCamAt(t);
  const lt = t - shot[0];
  let proj;
  const kitCentre = [0.05, 0.75, -0.15];
  const punchT = hitsIn(7.0, t + 1e-6).reduce((acc, h) => acc + 0.05 * decayAfter(t, h[0], 12) * clamp01(h[2] / 8), 0);
  if (shot[1] === 'wide' || shot[1] === 'wide2') {
    const yaw = (shot[1] === 'wide' ? -0.55 : 0.35) + 0.25 * lt, pitch = 0.62 - 0.05 * lt;
    const base = new Proj({ target: kitCentre, yaw, pitch, dist: 3.1, focal: 1000 });
    const fit = base.fit(boxCorners(...KIT_FIT), [560, 150, 1840, 960], 1.0);
    proj = new Proj({ target: kitCentre, yaw, pitch, dist: 3.1, focal: fit.focal * (1.04 + 0.05 * lt + punchT), cx: fit.cx, cy: fit.cy });
  } else if (shot[1] === 'close') {
    const pl = D.T.kit.pieces[shot[2]];
    const n = pl.normal;
    const yaw = Math.atan2(-0.9, 0.35) + 0.3 * lt + (shot[2] === 2 ? 0.8 : 0), pitch = 0.95 - 0.1 * lt;
    proj = new Proj({ target: v3.add(pl.centre, v3.scale(n, 0.02)), yaw, pitch, dist: 1.2, focal: 2000 * (1 + 0.2 * ease.outExpo(clamp01(lt / 0.2))) * (1 + punchT), cx: W * 0.66, cy: H * 0.52 });
  } else {
    // Sweep across the toms with the fill: rack, rack, floor.
    const a = D.T.kit.pieces[2].centre, b = D.T.kit.pieces[3].centre;
    const u = ease.inOutCubic(clamp01(lt / 0.375));
    const target = v3.lerp(a, b, u);
    proj = new Proj({ target, yaw: lerp(-0.2, 0.6, u), pitch: 0.85, dist: 1.6, focal: 1700 * (1 + punchT), cx: W * 0.64, cy: H * 0.5 });
    post.whip = [0.03 * Math.sin(Math.PI * u), 0];
  }
  background(ctx, t, C.violet, [W * 0.62, H * 0.5], 0.9 + 4 * punchT);
  dust(ctx, t, 0.2 * t, 1);
  const boost = [1, 1, 1, 1, 1, 1, 1];
  for (const h of hitsIn(t - 0.3, t + 1e-6)) boost[h[1]] += 1.5 * decayAfter(t, h[0], 8);
  drawKit(ctx, proj, Kf, t, { alpha: 1, boost, exaggeration: 1.2 });
  // Labels.
  const lx = 150;
  const la = env(t, 7.0, 9.0, 0.15, 0.06);
  scrim(0, 880, la * (shot[1] === 'wide' || shot[1] === 'wide2' ? 0.7 : 1.1));
  sectionTitle(lx, t, 7.0, '03', 'DRUMS', 'HERTZ CONTACT · BESSEL MODES · SNARE WIRES', C.violet, f);
  // The latest strike, as the contact measured it.
  const last = hitsIn(7.0, t + 1e-6).slice(-1)[0];
  if (last) {
    const i = last[1];
    const pv = Kf.fr.pieces[i];
    const a = la * tw(t, last[0], last[0] + 0.06, ease.outCubic);
    maskRise(OV, PIECE_NAMES[i], lx, 640, tw(t, last[0], last[0] + 0.12, ease.outExpo), { size: 40, weight: 700, col: PIECE_COL[i], tracking: 3 });
    text(OV, `in ${pv.vin.toFixed(1)} m/s  ·  out ${pv.vout.toFixed(1)} m/s  ·  ${Math.round(pv.force)} N`, lx, 680, { size: 17, family: MONO, col: C.label, alpha: a });
    text(OV, `contact ${pv.contactMs.toFixed(2)} ms${i === 1 ? `  ·  wires lifted ${pv.wires}` : ''}`, lx, 712, { size: 17, family: MONO, weight: 700, col: C.amber, alpha: a });
    panelForce(ctx, [lx - 4, 770, 420, 200], Kf, i, la);
  }
  post.flash = 0.35 * decayAfter(t, 7.0, 14) + 0.12 * decayAfter(t, 8.0, 16);
  post.bloom = 0.95 + 3 * punchT;
  post.ca = 0.002 + 0.06 * punchT;
  return proj;
}

// ---------------------------------------------------------------------------------------------
// Scene 6 (9.0 - 10.5 s): the crash - a plate bending, the von Karman couplings at work.
// ---------------------------------------------------------------------------------------------

function sceneCymbal(ctx, t, f, post, xo = 0) {
  if (t < 9.0 || t >= 10.6) return;
  const Kf = kitFrame(f);
  const lt = t - 9.0;
  const pl = D.T.kit.pieces[4];
  const out = tw(t, 10.1, 10.5, ease.inOutCubic);
  const yaw = -2.3 + 0.62 * lt, pitch = lerp(1.1 - 0.12 * lt, 0.7, out);
  const target = v3.lerp(pl.centre, [0.05, 0.75, -0.15], out);
  const near = lerp(4300, 2900, ease.outCubic(clamp01(lt / 1.0)));
  const focal = lerp(near, 900, out) * (1 + 0.1 * decayAfter(t, 9.0, 6) + 0.05 * decayAfter(t, 9.75, 10) + 0.04 * decayAfter(t, 10.0, 10));
  const proj = new Proj({ target, yaw, pitch, dist: lerp(1.3, 3.1, out), focal, cx: W * 0.6 + xo, cy: H * 0.5 });
  background(ctx, t, C.brass, [W * 0.6 + xo, H * 0.5], 1.2 * decayAfter(t, 9.0, 1.5) + 0.5);
  dust(ctx, t, yaw, 1);
  const boost = [1, 1, 1, 1, 1.4, 1, 1];
  for (const h of hitsIn(t - 0.3, t + 1e-6)) boost[h[1]] += 1.2 * decayAfter(t, h[0], 8);
  drawKit(ctx, proj, Kf, t, { alpha: 1, boost, exaggeration: lerp(2.3, 1.2, tw(t, 9.8, 10.35, ease.inOutCubic)), only: out > 0.05 ? null : [4, 6, 5], floor: out });
  const lx = 150 + xo;
  const la = env(t, 9.0, 10.55, 0.15, 0.12);
  scrim(xo, 860 + xo, la);
  sectionTitle(lx, t, 9.0, '04', 'CYMBALS', 'BENDING PLATE · VON KÁRMÁN NONLINEARITY', C.brass, f);
  const pv = Kf.fr.pieces[4];
  maskRise(OV, '16" CRASH', lx, 640, tw(t, 9.05, 9.4, ease.outExpo), { size: 40, weight: 700, col: C.brass, tracking: 3 });
  text(OV, `energy ${sci(pv.energy)} J  ·  ${pv.nonlinear ? 'stretching couples the modes' : 'linear again'}`, lx, 680, { size: 17, family: MONO, col: C.label, alpha: la });
  text(OV, pv.nonlinear ? 'energy cascading up the spectrum' : ' ', lx, 712, { size: 17, family: MONO, weight: 700, col: C.rose, alpha: la });
  panelModes(ctx, [lx - 4, 770, 420, 200], Kf, 4, la, 'MODES — CRASH');
  post.flash = 0.45 * decayAfter(t, 9.0, 12) + 0.1 * decayAfter(t, 9.75, 18);
  post.bloom = 1.0 + 0.5 * decayAfter(t, 9.0, 3);
  post.ca = 0.002 + 0.01 * decayAfter(t, 9.0, 8);
  return proj;
}

// ---------------------------------------------------------------------------------------------
// Scene 7 (10.5 - 12.33 s): Physics View - the smear, then everything at once.
// ---------------------------------------------------------------------------------------------

function sceneSmear(ctx, t, f, post, xo = 0) {
  if (t < 10.4 || t >= 11.62) return;
  const B = brassFrame('tbn1', f);
  const [lo, hi] = [[-0.45, -0.05, -0.2], [1.3, 0.45, 0.2]];
  const c = v3.scale(v3.add(lo, hi), 0.5);
  const lt = t - 10.5;
  const yaw = 0.3 + 0.15 * lt, pitch = 0.62 - 0.1 * lt;
  const base = new Proj({ target: c, yaw, pitch, dist: 4.6, focal: 1000 });
  const fit = base.fit(boxCorners(lo, hi), [40, 470, 1290, 1010], 1.12);
  const proj = new Proj({ target: c, yaw, pitch, dist: 4.6, focal: fit.focal * (1.0 + 0.06 * lt), cx: fit.cx + xo, cy: fit.cy });
  background(ctx, t, C.teal, [W * 0.35 + xo, H * 0.5], 0.9);
  dust(ctx, t, yaw, 1);
  drawBrass(ctx, proj, B, t, { alpha: 1, physics: true, exaggeration: 1.4, glowBoost: 1.1 });
  // The slide readout, big: it is moving.
  const fr = B.fr;
  const px = 150 + xo;
  const la = env(t, 10.5, 11.5, 0.12, 0.12);
  maskRise(OV, '05', px, 250, tw(t, 10.5, 10.8, ease.outExpo), { size: 110, weight: 200, col: C.teal, tracking: -3 });
  maskRise(OV, 'SEE WHY IT SOUNDS', px, 350, tw(t, 10.52, 10.85, ease.outExpo), { size: 70, weight: 300, col: C.label, tracking: 1 });
  maskRise(OV, 'THE WAY IT DOES.', px, 428, tw(t, 10.6, 10.95, ease.outExpo), { size: 70, weight: 900, col: C.white, tracking: 0 });
  text(OV, `slide position ${fr.pos.toFixed(2)}  ·  partial ${fr.partial}  ·  ${(fr.hz || 0).toFixed(1)} Hz`, px, 482, { size: 18, family: MONO, weight: 500, col: C.teal, alpha: la });
  const [lab, col] = brassTone(fr.steep);
  text(OV, lab, px, 514, { size: 18, family: MONO, weight: 700, col, alpha: la });
  // The Physics View panels, sliding in one after another.
  const rx = 1300 + xo;
  const pw = 520, ph = 222;
  const pa = (k) => tw(t, 10.55 + 0.08 * k, 10.85 + 0.08 * k, ease.outExpo);
  withXf(ctx, { x: (1 - pa(0)) * 600 }, () => panelLadder(ctx, [rx, 150, pw, ph], B, la, 1));
  withXf(ctx, { x: (1 - pa(1)) * 600 }, () => panelMap(ctx, [rx, 150 + ph + 18, pw, ph], B, la));
  withXf(ctx, { x: (1 - pa(2)) * 600 }, () => panelTraces(ctx, [rx, 150 + 2 * (ph + 18), pw, ph], B, t, la));
  post.bloom = 1.0;
  post.flash = 0.2 * decayAfter(t, 10.5, 14);
  return proj;
}

// Everything at once: a grid of live views, filling with the snare roll.
const GRID = { cols: 4, rows: 3, gap: 14 };
function gridRect(ci) {
  const { cols, rows, gap } = GRID;
  const gw = (W - 120 - gap * (cols - 1)) / cols, gh = (H - 180 - gap * (rows - 1)) / rows;
  return [60 + (ci % cols) * (gw + gap), 110 + Math.floor(ci / cols) * (gh + gap), gw, gh];
}
function sceneGrid(ctx, t, f, post) {
  if (t < 11.36 || t >= 12.36) return;
  const lt = t - 11.5;
  background(ctx, t, C.teal, [W / 2, H / 2], 0.6 + 1.5 * clamp01(lt / 0.8));
  const zoom = 1 + 0.06 * ease.inCubic(clamp01(lt / 0.83));
  const Bt = brassFrame('tbn1', f), Bh = brassFrame('hn1', f), Bu = brassFrame('tuba', f), Bp = brassFrame('tpt2', f);
  const Sv = stringsFrame('bass', f), Sc = stringsFrame('cello', f);
  const Kf = kitFrame(f);
  const cells = [
    (r) => cellBrass(ctx, r, Bt, t, 0.4 + 0.3 * lt),
    (r) => panelLadder(ctx, r, Bt, 1, 1),
    (r) => cellKit(ctx, r, Kf, t, 1, [0, 1, 2, 3, 4, 5, 6]),
    (r) => cellBrass(ctx, r, Bh, t, 1.2 + 0.2 * lt),
    (r) => panelModes(ctx, r, Kf, 1, 1, 'MODES — SNARE'),
    (r) => cellStrings(ctx, r, Sv, t, 1.0),
    (r) => panelMap(ctx, r, Bt, 1),
    (r) => cellBrass(ctx, r, Bu, t, 2.0 + 0.2 * lt),
    (r) => panelTraces(ctx, r, Bt, t, 1),
    (r) => cellKit(ctx, r, Kf, t, 2, [1]),
    (r) => panelEnergy(ctx, r, Kf, 1),
    (r) => cellBrass(ctx, r, Bp, t, 0.8 + 0.2 * lt),
  ];
  // The trombone's cell first (the shot that shrinks into it), then the rest with the roll.
  const order = [0, 5, 2, 9, 7, 10, 3, 6, 1, 11, 4, 8];
  withXf(ctx, { s: zoom }, () => {
    order.forEach((ci, k) => {
      const appear = k === 0 ? 11.6 : 11.64 + (k - 1) * 0.05;
      if (t < appear) return;
      const a = k === 0 ? 1 : ease.outExpo(clamp01((t - appear) / 0.18));
      const r = gridRect(ci);
      ctx.save();
      ctx.beginPath(); ctx.rect(r[0], r[1], r[2], r[3]); ctx.clip();
      ctx.globalAlpha = a;
      const s = lerp(0.85, 1, a);
      withXf(ctx, { s, ox: r[0] + r[2] / 2, oy: r[1] + r[3] / 2 }, () => {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = rgba([0.02, 0.02, 0.05], 0.7); ctx.fillRect(r[0], r[1], r[2], r[3]);
        ctx.globalCompositeOperation = 'lighter';
        cells[ci](r);
      });
      ctx.restore();
      const edge = 0.35 + 0.65 * decayAfter(t, appear, 6);
      ctx.strokeStyle = rgba(C.teal, 0.45 * edge * a); ctx.lineWidth = 1.2; ctx.strokeRect(r[0], r[1], r[2], r[3]);
    });
  });
  post.bloom = 0.9 + 0.8 * clamp01(lt / 0.8);
  post.flash = 0.25 * decayAfter(t, 11.5, 12);
  post.exposure = 1 + 0.25 * ease.inCubic(clamp01(lt / 0.83));
  post.zoomBlur = 0.04 * ease.inExpo(clamp01(lt / 0.83));
}

function cellBrass(ctx, r, B, t, yaw) {
  const [lo, hi] = B.P.fit;
  const c = v3.scale(v3.add(lo, hi), 0.5);
  const base = new Proj({ target: c, yaw, pitch: 0.4, dist: 4.2, focal: 1000 });
  const fit = base.fit(boxCorners(lo, hi), [r[0] + 16, r[1] + 16, r[0] + r[2] - 16, r[1] + r[3] - 16], 0.95);
  const proj = new Proj({ target: c, yaw, pitch: 0.4, dist: 4.2, focal: fit.focal, cx: fit.cx, cy: fit.cy });
  drawBrass(ctx, proj, B, t, { alpha: 1, glowBoost: 1.2 });
  text(ctx, INSTRUMENT_NAMES[B.P.instrument], r[0] + 14, r[1] + 24, { size: 13, family: MONO, weight: 500, col: C.brass, alpha: 0.95, tracking: 1.5 });
}
function cellStrings(ctx, r, Sd, t, yaw) {
  const base = new Proj({ target: STR.TARGET, yaw, pitch: 0.62, dist: 5.4, focal: 1000 });
  const box = boxCorners([-1.05, STR.PLATE_Y, -0.62], [STR.BODY_TOP_X + STR.BODY_LEN * 1.22, 0.2, 0.62]);
  const fit = base.fit(box, [r[0] + 12, r[1] + 12, r[0] + r[2] - 12, r[1] + r[3] - 12], 0.95);
  const proj = new Proj({ target: STR.TARGET, yaw, pitch: 0.62, dist: 5.4, focal: fit.focal, cx: fit.cx, cy: fit.cy });
  drawStrings(ctx, proj, Sd, t, { alpha: 1, bodySize: 1, physics: true, names: false });
  text(ctx, 'DOUBLE BASS', r[0] + 14, r[1] + 24, { size: 13, family: MONO, weight: 500, col: C.teal, alpha: 0.95, tracking: 1.5 });
}
function cellKit(ctx, r, Kf, t, zoomK, only) {
  let proj;
  if (only.length > 1) {
    const base = new Proj({ target: [0.05, 0.75, -0.15], yaw: -0.3 + 0.2 * (t - 11.5), pitch: 0.72, dist: 3.1, focal: 1000 });
    const fit = base.fit(boxCorners(...KIT_FIT), [r[0] + 10, r[1] + 10, r[0] + r[2] - 10, r[1] + r[3] - 10], 1.0);
    proj = new Proj({ target: [0.05, 0.75, -0.15], yaw: -0.3 + 0.2 * (t - 11.5), pitch: 0.72, dist: 3.1, focal: fit.focal, cx: fit.cx, cy: fit.cy });
  } else {
    const pl = D.T.kit.pieces[only[0]];
    proj = new Proj({ target: pl.centre, yaw: -1.2, pitch: 1.1, dist: 1.2, focal: 1200, cx: r[0] + r[2] / 2, cy: r[1] + r[3] / 2 + 10 });
  }
  const boost = [1, 1, 1, 1, 1, 1, 1];
  for (const h of hitsIn(t - 0.3, t + 1e-6)) boost[h[1]] += 1.2 * decayAfter(t, h[0], 8);
  drawKit(ctx, proj, Kf, t, { alpha: 1, boost, only, sticks: only.length === 1, floor: only.length > 1 ? 1 : 0, exaggeration: 1.4 });
  text(ctx, only.length > 1 ? 'DRUM KIT' : 'SNARE — HEAD FIELD', r[0] + 14, r[1] + 24, { size: 13, family: MONO, weight: 500, col: C.violet, alpha: 0.95, tracking: 1.5 });
}

// ---------------------------------------------------------------------------------------------
// The gap (12.33 - 12.5 s) and the end card (12.5 - 15 s).
// ---------------------------------------------------------------------------------------------

function sceneGap(ctx, t, f, post) {
  if (t < 12.33 || t >= 12.5) return;
  background(ctx, t, C.teal, [W / 2, H / 2], 0);
  const u = ease.outExpo(ramp(t, 12.34, 12.46));
  seg(ctx, [W / 2 - u * W * 0.42, H / 2], [W / 2 + u * W * 0.42, H / 2], C.teal, 0.25, 8);
  seg(ctx, [W / 2 - u * W * 0.42, H / 2], [W / 2 + u * W * 0.42, H / 2], mix3(C.teal, C.white, 0.4), 0.9, 1.4);
  post.bloom = 1.2;
}

function sceneLogo(ctx, t, f, post) {
  if (t < 12.5) return;
  const lt = t - 12.5;
  const B = brassFrame('tbn1', f);
  background(ctx, t, C.amber, [W / 2, H * 0.46], 0.9 * decayAfter(t, 12.5, 0.8) + 0.35 + 0.4 * decayAfter(t, HITS.button, 3));
  dust(ctx, t, 0.1 * t, 1);
  // The string: at the hit it takes the shape of the trombone's own pressure wave, then settles
  // under the wordmark, moving with the chord until the chord is released.
  const cy = H * 0.47;
  if (B.fr.mp) {
    const settle = tw(t, 12.62, 13.12, ease.inOutCubic);
    const yLine = lerp(H / 2, cy + 150, settle);
    const half = lerp(W * 0.42, 430, settle);
    const amp = lerp(120 * decayAfter(t, 12.5, 3.2), 30 * clamp01(B.fr.rms / 0.16), settle);
    let lo = 1e9, hi = -1e9; for (const v of B.fr.mp) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const pts = [];
    for (let k = 0; k <= 400; k++) {
      const x = W / 2 - half + (2 * half * k) / 400;
      const ph = ((k / 400) * 7 + lt * 2) % 1;
      const v = B.fr.mp[Math.floor(ph * 63)];
      const e = Math.sin((Math.PI * k) / 400);
      pts.push([x, yLine - ((v - (lo + hi) / 2) / Math.max(1, hi - lo)) * 2 * amp * e]);
    }
    glow(ctx, pts, mix3(C.teal, C.amber, 0.4), lerp(0.9, 0.6, settle), lerp(12, 7, settle), lerp(2, 1.4, settle));
  }
  // ENTROPY DAW.
  const wa = tw(t, 12.62, 13.15, ease.outExpo);
  const pulse = (1 + 0.03 * decayAfter(t, HITS.button, 10)) * (1 + 0.035 * ease.inOutQuad(ramp(t, 13.0, 15.0)));
  const logoXf = { s: (0.94 + 0.06 * wa) * pulse, y: -10 };
  withXf(OV, logoXf, () => {
    const size = 196;
    const wE = measure(ctx, 'ENTROPY', size, 900, DISPLAY, 14);
    const wD = measure(ctx, 'DAW', size, 200, DISPLAY, 14);
    const gap = 44;
    const x0 = W / 2 - (wE + gap + wD) / 2;
    // A light sweep reveals the letters left to right.
    const sweep = x0 - 80 + (wE + gap + wD + 160) * ease.inOutCubic(ramp(t, 12.56, 13.05));
    OV.save();
    OV.beginPath(); OV.rect(0, 0, sweep, H); OV.clip();
    text(OV, 'ENTROPY', x0, cy + size * 0.35, { size, weight: 900, col: C.white, alpha: 1, tracking: 14 });
    text(OV, 'DAW', x0 + wE + gap, cy + size * 0.35, { size, weight: 200, col: C.teal, alpha: 1, tracking: 14 });
    OV.restore();
    // A glint across the letters on the last hit: light only where there is type.
    const g = ramp(t, HITS.button - 0.02, HITS.button + 0.34);
    if (g > 0 && g < 1) {
      const gx = x0 - 200 + (wE + gap + wD + 400) * ease.inOutCubic(g);
      OV.save();
      OV.globalCompositeOperation = 'source-atop';
      const band = OV.createLinearGradient(gx - 90, 0, gx + 90, 0);
      band.addColorStop(0, 'rgba(255,255,255,0)'); band.addColorStop(0.5, 'rgba(255,250,235,0.9)'); band.addColorStop(1, 'rgba(255,255,255,0)');
      OV.fillStyle = band;
      OV.beginPath(); OV.moveTo(gx - 60, cy - size); OV.lineTo(gx + 120, cy - size); OV.lineTo(gx + 60, cy + size); OV.lineTo(gx - 120, cy + size); OV.closePath(); OV.fill();
      OV.restore();
    }
    // The same letters on the scene layer, so the bloom gives them a halo.
    withXf(ctx, logoXf, () => {
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, sweep, H); ctx.clip();
      text(ctx, 'ENTROPY', x0, cy + size * 0.35, { size, weight: 900, col: mix3(C.amber, C.white, 0.5), alpha: 0.55, tracking: 14 });
      text(ctx, 'DAW', x0 + wE + gap, cy + size * 0.35, { size, weight: 200, col: C.teal, alpha: 0.9, tracking: 14 });
      ctx.restore();
      if (t < 13.1) {
        const a = 1 - ramp(t, 12.95, 13.1);
        seg(ctx, [sweep, cy - size * 0.6], [sweep, cy + size * 0.55], C.white, 0.25 * a, 16);
        seg(ctx, [sweep, cy - size * 0.6], [sweep, cy + size * 0.55], C.white, 0.95 * a, 2);
      }
    });
  });
  // The rule and the line.
  maskRise(OV, 'Don’t just program a sound.', W / 2 - 16, cy + 222, tw(t, 13.15, 13.6, ease.outExpo), { size: 46, weight: 300, col: C.label, align: 'right' });
  maskRise(OV, 'Build an instrument.', W / 2 + 16, cy + 222, tw(t, 13.35, 13.8, ease.outExpo), { size: 46, weight: 800, col: C.brass, align: 'left' });
  const fa = tw(t, 13.8, 14.2, ease.outCubic);
  text(OV, decode('EVERY SOUND IN THIS REEL WAS PLAYED BY ENTROPY DAW’S PHYSICAL MODELS — NO SAMPLES.', ramp(t, 13.8, 14.4), f * 5), W / 2, cy + 292, { size: 16, family: MONO, weight: 500, col: C.label, alpha: 0.85 * fa, align: 'center', tracking: 3 });
  text(OV, 'BRASS · STRINGS · DRUMS · CYMBALS', W / 2, cy + 324, { size: 14, family: MONO, col: C.teal, alpha: 0.7 * fa, align: 'center', tracking: 6 });
  post.flash = 0.95 * decayAfter(t, 12.5, 16) + 0.06 * decayAfter(t, HITS.button, 14);
  post.flashCol = [1, 0.95, 0.88];
  post.bloom = 1.4 - 0.5 * clamp01(lt / 0.8) + 0.3 * decayAfter(t, HITS.button, 6);
  post.ca = 0.012 * decayAfter(t, 12.5, 7) + 0.0015;
  post.zoomBlur = 0.1 * decayAfter(t, 12.5, 9);
}

// ---------------------------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------------------------

function renderScene(ctx, ov, t, f) {
  OV = ov;
  const post = { bloom: 0.9, ca: 0.0018, vignette: 0.5, grain: 0.024, frame: f, flash: 0, fade: 1, exposure: 1, whip: [0, 0], zoomBlur: 0 };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  ov.setTransform(1, 0, 0, 1, 0, 0);
  ov.globalCompositeOperation = 'source-over';
  ov.clearRect(0, 0, W, H);
  const sh = shake(t);
  const push = (x, y = 0, r = 0) => { for (const c of [ctx, ov]) { c.save(); c.translate(W / 2 + x, H / 2 + y); c.rotate(r); c.translate(-W / 2, -H / 2); } };
  const pop = () => { ctx.restore(); ov.restore(); };
  push(sh.x, sh.y, sh.r);
  {
    // Whip pans between sections: the outgoing scene leaves left, the next arrives from the right.
    const whip = (tc, dur = 0.16) => { const u = ramp(t, tc - dur / 2, tc + dur / 2); return u > 0 && u < 1 ? u : null; };
    const u1 = whip(5.0);
    if (t < 3.0) { sceneBreath(ctx, t, f, post); sceneHit(ctx, t, f, post); }
    if (t >= 3.0 && t < 5.08) {
      if (u1 !== null) {
        const e = ease.inOutCubic(u1);
        push(-e * W * 0.9); sceneFamily(ctx, t, f, post); pop();
        push((1 - e) * W * 0.9); sceneStrings(ctx, Math.max(t, 5.0), f, post); pop();
        post.whip = [0.06 * Math.sin(Math.PI * u1), 0];
      } else if (t < 4.92) sceneFamily(ctx, t, f, post);
      else sceneStrings(ctx, t, f, post);
    } else if (t >= 5.08 && t < 7.0) sceneStrings(ctx, t, f, post);
    if (t >= 7.0 && t < 9.0) sceneDrums(ctx, t, f, post);
    const u3 = whip(10.5, 0.14);
    if (t >= 9.0 && t < 10.5 && u3 === null) sceneCymbal(ctx, t, f, post);
    if (u3 !== null) {
      const e = ease.inOutCubic(u3);
      push(-e * W * 0.9); sceneCymbal(ctx, Math.min(t, 10.49), f, post); pop();
      push((1 - e) * W * 0.9); sceneSmear(ctx, Math.max(t, 10.5), f, post); pop();
      post.whip = [0.06 * Math.sin(Math.PI * u3), 0];
    } else if (t >= 10.5 && t < 11.38) sceneSmear(ctx, t, f, post);
    if (t >= 11.38 && t < 12.33) sceneGrid(ctx, t, f, post);
    if (t >= 11.38 && t < 11.6) {
      // The shot shrinks into its tile of the grid.
      const e = ease.inOutCubic(ramp(t, 11.38, 11.6));
      const r0 = gridRect(0);
      const sc = lerp(1, r0[2] / W, e);
      for (const c of [ctx, ov]) { c.save(); c.translate(r0[0] * e, r0[1] * e); c.scale(sc, sc); }
      ov.globalAlpha = 1 - ramp(t, 11.38, 11.48);
      sceneSmear(ctx, t, f, post);
      ov.globalAlpha = 1;
      pop();
      ctx.strokeStyle = rgba(C.teal, 0.8 * e); ctx.lineWidth = 1.2;
      ctx.strokeRect(r0[0] * e, r0[1] * e, W * sc, H * sc);
    }
    if (t >= 12.33 && t < 12.5) sceneGap(ctx, t, f, post);
    if (t >= 12.5) sceneLogo(ctx, t, f, post);
  }
  pop();
  // Chrome over everything (not shaken).
  const hudA = ramp(t, 0.35, 0.9) * (t >= 12.33 && t < 12.5 ? 0 : 1) * (1 - 0.6 * ramp(t, 12.5, 13.0));
  hud(ov, t, f, hudA);
  post.fade = Math.min(ramp(t, 0.0, 0.3), 1 - ramp(t, 14.72, 15.0));
  return post;
}
