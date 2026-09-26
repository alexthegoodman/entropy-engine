// The DAW's three instrument views, ported to Canvas 2D: BrassView, PhysModView and MatterView
// (src/entropy_gui/widgets_brass.rs, widgets_physmod.rs, widgets_matter.rs), drawn from the models'
// own state at each frame, plus the Physics View panels.
'use strict';

// =============================================================================================
// Brass
// =============================================================================================

const RADIUS_BASE = 0.012, RADIUS_GAIN = 1.3;
const drawnRadius = (r) => RADIUS_BASE + RADIUS_GAIN * r;

function brassFrame(name, f) {
  const P = D.brass[name];
  f = clamp(f, 0, P.frames.length - 1);
  return { P, fr: P.frames[f], f, geo: geometry(P.frames[f].geo), scaleRef: P.scaleRef[f], env: P.env[f], energyRef: P.energyRef[f] };
}

// o: { alpha, reveal (0..1 along the air column), physics, lips, beam, glowBoost, tint }
function drawBrass(ctx, proj, B, t, o = {}) {
  const alpha = o.alpha ?? 1;
  const reveal = o.reveal ?? 1;
  const { fr, geo } = B;
  const pts = geo.pts;
  const sounding = fr.on;
  const sref = B.scaleRef;
  const normP = (v) => clamp(v / sref, -1.5, 1.5);
  const shown = pts.filter((q) => q.along <= reveal + 1e-6);
  const tint = o.tint || C.brass;
  const boost = o.glowBoost ?? 1;

  // Idle valve loops: brass, but dark.
  if (reveal >= 0.999 && o.loops !== false) for (const l of geo.loops) glow(ctx, l.map((q) => proj.p(q)), C.dim, 0.55 * alpha, 4, 1.2);

  // Beam: the sound leaving the bell.
  if (o.beam !== false && reveal >= 0.999 && sounding && fr.rms > 1e-5) drawBeam(ctx, proj, pts[pts.length - 1], B, t, alpha * (o.beamGain ?? 1));

  // Both walls, glowing where the air moves most (the envelope's antinodes).
  for (const side of [-1, 1]) {
    const edge = shown.map((q) => {
      const g = sounding ? clamp01(pressureAt(B.env, q.along) / sref) * boost : 0;
      return [proj.p(v3.add(q.pos, v3.scale(q.n, side * drawnRadius(q.r)))), clamp01(g)];
    });
    for (let k = 1; k < edge.length; k++) {
      const [a, ga] = edge[k - 1], [b, gb] = edge[k];
      if (!a || !b) continue;
      const g = 0.5 * (ga + gb);
      const col = mix3(tint, [1.0, 0.95, 0.8], g * 0.6);
      seg(ctx, a, b, col, (0.12 + 0.2 * g) * alpha, 4 + 6 * g);
      seg(ctx, a, b, mix3(col, C.white, 0.15), (0.55 + 0.4 * g) * alpha, 1.4);
    }
  }
  // Rings: cross-sections lit by the pressure there now.
  for (let k = 0; k < shown.length; k += 6) {
    const q = shown[k];
    const r = drawnRadius(q.r);
    const ring = [];
    for (let j = 0; j <= 14; j++) {
      const a = (TAU * j) / 14;
      ring.push(proj.p(v3.add(q.pos, v3.add(v3.scale(q.n, r * Math.cos(a)), v3.scale(q.b, r * Math.sin(a))))));
    }
    const v = sounding ? normP(pressureAt(fr.bore, q.along)) * boost : 0;
    const col = v >= 0 ? mix3(tint, C.amber, v) : mix3(tint, C.violet, -v);
    glow(ctx, ring, col, (0.25 + 0.5 * Math.min(1, Math.abs(v))) * alpha, 0, 1.0);
  }
  // The drawing front while the instrument is being built.
  if (reveal < 0.999 && shown.length > 1) {
    const q = shown[shown.length - 1];
    const p = proj.p(q.pos);
    dot(ctx, p, 14, C.teal, 0.12 * alpha); dot(ctx, p, 6, C.teal, 0.35 * alpha); dot(ctx, p, 2.5, C.white, 0.95 * alpha);
  }
  if (o.physics && sounding) drawBrassPhysics(ctx, proj, B, shown, alpha, o.exaggeration ?? 1);
  if (o.lips !== false) drawLips(ctx, proj, B, t, alpha);
  if (reveal >= 0.999 && o.valves !== false) drawValves(ctx, proj, geo, alpha);
}

function drawBrassPhysics(ctx, proj, B, shown, alpha, ex) {
  const { fr } = B;
  const sref = B.scaleRef;
  const normP = (v) => clamp(v / sref, -1.5, 1.5);
  const gain = 0.09 * clamp(ex, 0.1, 4);
  const wave = shown.map((q) => proj.p(v3.add(q.pos, v3.scale(q.b, drawnRadius(q.r) + 0.03 + gain * normP(pressureAt(fr.bore, q.along))))));
  glow(ctx, wave, C.teal, 0.9 * alpha, 5, 1.6);
  for (const side of [-1, 1]) {
    const e = shown.map((q) => proj.p(v3.add(q.pos, v3.scale(q.b, drawnRadius(q.r) + 0.03 + side * gain * Math.min(1.5, pressureAt(B.env, q.along) / sref)))));
    glow(ctx, e, C.sky, 0.45 * alpha, 0, 1.0);
  }
}

function drawLips(ctx, proj, B, t, alpha) {
  const { fr } = B;
  const rim = drawnRadius(0.0127);
  const ring = [];
  for (let k = 0; k <= 18; k++) {
    const a = (TAU * k) / 18;
    ring.push(proj.p([-0.012, rim * Math.cos(a), rim * Math.sin(a)]));
  }
  glow(ctx, ring, C.brass, 0.8 * alpha, 3, 1.4);
  // One period of the real lip motion every 1.5 s, slowed so the eye can follow it.
  const phase = (t / 1.5) % 1;
  let opening = Math.max(0, fr.lipOpen || 0);
  if (fr.on && fr.lip) opening = Math.max(0, fr.lip[Math.min(63, Math.floor(phase * 64))]);
  const gap = Math.min(opening * 40, rim * 0.9);
  for (const side of [-1, 1]) {
    const lip = [];
    for (let k = 0; k <= 10; k++) {
      const z = -rim * 0.9 + (1.8 * rim * k) / 10;
      const bulge = 0.006 * (1 - (z / (rim * 0.9)) ** 2);
      lip.push(proj.p([-0.02, side * (gap * 0.5 + bulge), z]));
    }
    glow(ctx, lip, C.rose, (fr.on ? 0.95 : 0.5) * alpha, 6, 2.2);
  }
}

function drawValves(ctx, proj, geo, alpha) {
  for (const v of geo.valves) {
    const travel = v.down ? 0.012 : 0.034;
    const base = proj.p(v.pos), top = proj.p(v3.add(v.pos, [0, 0.02 + travel, 0]));
    if (!base || !top) continue;
    const col = v.down ? C.teal : C.amber;
    seg(ctx, base, top, col, 0.25 * alpha, 5);
    seg(ctx, base, top, col, 0.9 * alpha, 1.6);
    ctx.beginPath(); ctx.arc(top[0], top[1], 4 * S, 0, TAU); ctx.strokeStyle = rgba(col, (v.down ? 1 : 0.7) * alpha); ctx.lineWidth = 1.4 * S; ctx.stroke();
  }
}

function steepness01(s) { return clamp01((Math.log10(Math.max(s, 1)) - 5) / 2.5); }

function drawBeam(ctx, proj, mouth, B, t, alpha) {
  const { fr } = B;
  const level = Math.sqrt(clamp01(fr.rms / B.energyRef));
  const steep = steepness01(fr.steep);
  const half = Math.max(1.1 - 0.75 * steep, 0.2);
  const reach = 0.25 + 0.55 * level;
  const r0 = drawnRadius(mouth.r);
  const d = v3.norm(v3.sub(mouth.pos, B.geo.pts[B.geo.pts.length - 4].pos));
  const u = mouth.n;
  const phase0 = (t * 0.9) % 1;
  for (let k = 0; k < 4; k++) {
    const ph = (phase0 + k * 0.25) % 1;
    const r = r0 + ph * reach;
    const arc = [];
    for (let j = 0; j <= 16; j++) {
      const a = -half + (2 * half * j) / 16;
      arc.push(proj.p(v3.add(mouth.pos, v3.add(v3.scale(d, r * Math.cos(a)), v3.scale(u, r * Math.sin(a))))));
    }
    glow(ctx, arc, mix3(C.amber, C.teal, steep), (1 - ph) * 0.8 * alpha, 4, 1.2);
  }
}

function brassTone(steep) {
  if (steep > 2e7) return ['wavefront shocked — blazing', C.rose];
  if (steep > 4e6) return ['wavefront steepening — brassy', C.amber];
  return ['smooth wave — round tone', C.teal];
}

// =============================================================================================
// Bowed strings (PhysModView)
// =============================================================================================

const STR = { NUT: 0.26, BRIDGE: 0.52, BODY_TOP_X: -0.2, BODY_LEN: 2.15, PLATE_Y: -0.2, TARGET: [0.45, -0.05, 0] };
const BODY_W = [[0, 0], [0.03, 0.26], [0.1, 0.44], [0.2, 0.51], [0.3, 0.47], [0.4, 0.35], [0.5, 0.33], [0.6, 0.4], [0.7, 0.58], [0.8, 0.635], [0.9, 0.56], [0.97, 0.33], [1, 0]];
function bodyHalfWidth(u) {
  u = clamp01(u);
  for (let k = 1; k < BODY_W.length; k++) {
    if (u <= BODY_W[k][0]) {
      const [u0, w0] = BODY_W[k - 1], [u1, w1] = BODY_W[k];
      const s = (u - u0) / (u1 - u0);
      return w0 + (w1 - w0) * (s * s * (3 - 2 * s));
    }
  }
  return 0;
}
function stringZ(i, n, x) {
  if (n <= 1) return 0;
  const t = clamp((x + 1) / 2, 0, 1.2);
  const spread = STR.NUT + (STR.BRIDGE - STR.NUT) * t;
  return (0.5 - i / (n - 1)) * spread;
}
const fingerX = (finger) => -1 + 2 * clamp(finger, 0, 0.95);
const bowX = (beta, finger) => 1 - clamp(beta, 0.02, 0.5) * (1 - fingerX(finger));

function stringsFrame(name, f) {
  const P = D.strings[name];
  f = clamp(f, 0, P.frames.length - 1);
  const fr = P.frames[f];
  const strings = fr.strings.map((s) => ({ ...s, finger: s.hz > s.open * 1.0005 && s.hz > 0 ? 1 - s.open / s.hz : 0 }));
  let active = -1;
  strings.forEach((s, i) => { if (s.on && (active < 0 || s.lvl > strings[active].lvl)) active = i; });
  return { P, fr, f, strings, active, ref: P.ref[f], scaleRef: P.scaleRef[f], env: P.env[f], levelRef: P.levelRef[f] };
}

function regime(s) {
  if (!(s.f > 1e-4)) return 'free';
  if (Math.abs(s.spp - 1) <= 0.12) return 'helmholtz';
  if (s.fMin > 0 && s.fMax > 0) return s.f < Math.sqrt(s.fMin * s.fMax) ? 'surface' : 'raucous';
  return s.spp > 1 ? 'surface' : 'raucous';
}
const REGIME_COL = { helmholtz: C.teal, surface: C.sky, raucous: C.rose, free: C.violet };
const REGIME_LABEL = { helmholtz: 'Helmholtz motion', surface: 'surface sound', raucous: 'raucous', free: 'bow lifted' };

function shapeAt(shape, t) {
  const f = clamp01(t) * (shape.length - 1);
  const i0 = Math.floor(f), i1 = Math.min(i0 + 1, shape.length - 1);
  return shape[i0] * (1 - (f - i0)) + shape[i1] * (f - i0);
}

// o: { alpha, bodySize, physics, exaggeration, bowTravel, stringsAlpha }
function drawStrings(ctx, proj, Sd, t, o = {}) {
  const alpha = o.alpha ?? 1;
  const n = Sd.strings.length;
  const ex = o.exaggeration ?? 1;
  const bodySize = o.bodySize ?? 0;
  const level = clamp01(Sd.fr.rms / Sd.levelRef);
  drawBody(ctx, proj, bodySize, level * 0.9, Sd.active >= 0, alpha);
  drawFingerboard(ctx, proj, n, alpha);
  const act = Sd.active >= 0 ? Sd.strings[Sd.active] : null;
  drawBridge(ctx, proj, level, o.physics, alpha);
  const scaleOf = (i) => Math.max(Sd.ref[i], Sd.scaleRef * 0.25);
  const dispY = (v, i) => clamp(v / scaleOf(i), -1.5, 1.5) * DISPLAY_GAIN * clamp(ex, 0.1, 4);
  const point = (i, t01, y) => { const xf = fingerX(Sd.strings[i].finger); const x = xf + (1 - xf) * t01; return [x, y, stringZ(i, n, x)]; };
  for (let i = 0; i < n; i++) {
    const s = Sd.strings[i];
    const isAct = i === Sd.active;
    if (o.physics && isAct) drawStringEnvelope(ctx, proj, Sd, i, point, alpha);
    const xf = fingerX(s.finger);
    if (s.finger > 0) {
      const back = [];
      for (let k = 0; k <= 6; k++) { const x = -1 + ((xf + 1) * k) / 6; back.push(proj.p([x, 0, stringZ(i, n, x)])); }
      glow(ctx, back, C.dim, 0.45 * alpha, 0, 1.0);
      const fp = proj.p([xf, 0.01, stringZ(i, n, xf)]);
      dot(ctx, fp, 5, C.amber, 0.35 * alpha); dot(ctx, fp, 2.5, mix3(C.amber, C.white, 0.5), 0.95 * alpha);
    }
    const pts = [];
    for (let k = 0; k <= 72; k++) { const u = k / 72; pts.push(proj.p(point(i, u, dispY(shapeAt(s.shape, u), i)))); }
    const lvl = clamp01(s.lvl * 3);
    let col, gw, cw, a;
    if (isAct && s.on) { col = mix3(C.teal, C.amber, 0.5 + 0.5 * Math.sin(t * 0.6)); gw = 10; cw = 2.6; a = 0.95; }
    else if (lvl > 0.02) { col = mix3(C.dim, C.violet, lvl); gw = 3 + 6 * lvl; cw = 1.4; a = 0.45 + 0.5 * lvl; }
    else { col = C.dim; gw = 3; cw = 1.0; a = 0.45; }
    glow(ctx, pts, col, a * alpha, gw, cw);
    const np = proj.p([-1.12, 0, stringZ(i, n, -1)]);
    if (np && o.names !== false) text(ctx, noteName(s.open), np[0] - 6, np[1] + 4, { size: 13, family: MONO, col: isAct ? C.amber : C.dim, alpha: 0.9 * alpha, align: 'right' });
    if (o.physics && isAct && s.on) drawCorner(ctx, proj, s, i, point, dispY, t, alpha);
  }
  if (act) drawBow(ctx, proj, Sd, Sd.active, t, o, alpha);
}

function drawBody(ctx, proj, bodySize, energy, sounding, alpha) {
  const s = 1 + 0.22 * clamp(bodySize, -1, 2.5);
  const len = STR.BODY_LEN * s;
  const top = 1 - (1 - STR.BODY_TOP_X) * s;
  const outline = [];
  for (let k = 0; k <= 48; k++) { const u = k / 48; outline.push([top + u * len, STR.PLATE_Y, bodyHalfWidth(u) * s]); }
  for (let k = 48; k >= 0; k--) { const u = k / 48; outline.push([top + u * len, STR.PLATE_Y, -bodyHalfWidth(u) * s]); }
  const pts = outline.map((w) => proj.p(w));
  const e = clamp01(energy);
  const col = mix3(C.wood, C.amber, e);
  ctx.globalCompositeOperation = 'source-over';
  fillPoly(ctx, pts, mix3(C.bgBot, C.wood, 0.08 + 0.12 * e), 0.85 * alpha);
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, pts, col, (sounding ? 0.55 + 0.45 * e : 0.45) * alpha, 7 + 6 * e, 1.6, true);
  for (const side of [-1, 1]) {
    const fh = [];
    for (let k = 0; k <= 12; k++) { const tt = k / 12; fh.push(proj.p([1 + (tt - 0.5) * 0.52 * s, STR.PLATE_Y, side * (0.29 + 0.05 * Math.sin(Math.PI * (tt * 2 - 1))) * s])); }
    glow(ctx, fh, col, (0.5 + 0.4 * e) * alpha, 3, 1.2);
  }
}

function drawFingerboard(ctx, proj, n, alpha) {
  const half = (x) => Math.abs(stringZ(0, Math.max(n, 2), x)) + 0.06;
  const [x0, x1] = [-1.02, 0.35];
  const quad = [[x0, -0.05, half(x0)], [x1, -0.05, half(x1)], [x1, -0.05, -half(x1)], [x0, -0.05, -half(x0)]].map((w) => proj.p(w));
  ctx.globalCompositeOperation = 'source-over';
  fillPoly(ctx, quad, [0.04, 0.04, 0.08], 0.9 * alpha);
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, quad, C.dim, 0.5 * alpha, 0, 1.0, true);
  seg(ctx, proj.p([-1, 0, half(-1)]), proj.p([-1, 0, -half(-1)]), mix3(C.dim, C.white, 0.3), 0.8 * alpha, 3);
}

function drawBridge(ctx, proj, force, physics, alpha) {
  const half = STR.BRIDGE * 0.5 + 0.08;
  const pts = [];
  for (let k = 0; k <= 16; k++) { const tt = k / 16; const z = -half + 2 * half * tt; const arch = 0.035 * (1 - (2 * tt - 1) ** 2); pts.push(proj.p([1, -0.005 + arch - 0.035, z])); }
  const pulse = clamp01(force);
  glow(ctx, pts, mix3(C.amber, C.white, 0.3 * pulse), 0.85 * alpha, 6 + (physics ? 10 * pulse : 0), 2.2);
  for (const side of [-1, 1]) seg(ctx, proj.p([1, -0.04, side * half * 0.7]), proj.p([1, STR.PLATE_Y, side * half * 0.7]), C.amber, 0.6 * alpha, 2);
}

function drawStringEnvelope(ctx, proj, Sd, i, point, alpha) {
  const env = Sd.env[i];
  let peak = 0; for (const v of env) peak = Math.max(peak, v);
  if (peak < 1e-3) return;
  const topP = [], botP = [];
  for (let k = 0; k < 64; k++) { const u = k / 63; topP.push(proj.p(point(i, u, env[k]))); botP.push(proj.p(point(i, u, -env[k]))); }
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 1; k < 64; k++) fillPoly(ctx, [topP[k - 1], topP[k], botP[k], botP[k - 1]], C.violet, 0.16 * alpha);
  glow(ctx, topP, C.violet, 0.45 * alpha, 0, 1.0);
  glow(ctx, botP, C.violet, 0.45 * alpha, 0, 1.0);
  for (let k = 2; k < 62; k++) {
    if (env[k] < env[k - 1] && env[k] <= env[k + 1] && env[k] < 0.35 * peak) {
      const p = proj.p(point(i, k / 63, 0));
      if (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 3.5 * S, 0, TAU); ctx.strokeStyle = rgba(C.sky, 0.85 * alpha); ctx.lineWidth = 1.2 * S; ctx.stroke(); }
    }
  }
}

function drawCorner(ctx, proj, s, i, point, dispY, t, alpha) {
  let k = 0, best = 0;
  s.shape.forEach((v, j) => { if (Math.abs(v) > best) { best = Math.abs(v); k = j; } });
  if (k === 0 || k === 63) return;
  const p = proj.p(point(i, k / 63, dispY(s.shape[k], i)));
  if (!p) return;
  const pulse = 0.6 + 0.4 * Math.sin(t * 9);
  dot(ctx, p, 9, C.amber, 0.18 * pulse * alpha);
  dot(ctx, p, 4, [1, 0.95, 0.8], 0.95 * alpha);
  text(ctx, 'corner', p[0] + 10, p[1] - 12, { size: 13, family: MONO, col: C.amber, alpha: 0.85 * alpha });
}

function drawBow(ctx, proj, Sd, i, t, o, alpha) {
  const s = Sd.strings[i];
  const n = Sd.strings.length;
  const beta = s.beta > 0 ? s.beta : 0.12;
  const x = bowX(beta, s.finger);
  const z = stringZ(i, n, x);
  const reg = s.on || s.f > 0 ? regime(s) : 'free';
  const col = REGIME_COL[reg];
  const lifted = reg === 'free';
  const lift = lifted ? 0.08 : 0.012;
  const half = 0.75;
  const off = -(o.bowTravel ?? 0) * 0.45;
  const [za, zb] = [z - half + off, z + half + off];
  const skew = 0.1;
  const hair = [proj.p([x - skew, lift, za]), proj.p([x + skew, lift, zb])];
  const stick = [proj.p([x - skew, lift + 0.07, za]), proj.p([x + skew, lift + 0.05, zb])];
  const force = s.k > 0 ? s.k : 0.5;
  const g = lifted ? 0.25 : Math.min(1, 0.35 + clamp01(force) * 0.65);
  seg(ctx, hair[0], hair[1], col, g * 0.3 * alpha, 10);
  seg(ctx, hair[0], hair[1], mix3(col, C.white, 0.5), 0.9 * alpha, 2.4);
  seg(ctx, stick[0], stick[1], C.wood, 0.8 * alpha, 2);
  seg(ctx, hair[0], stick[0], C.wood, 0.8 * alpha, 2);
  seg(ctx, hair[1], stick[1], C.wood, 0.8 * alpha, 2);
  if (!lifted) dot(ctx, proj.p([x, 0, z]), 4 + 5 * force, col, 0.35 * alpha);
}

// =============================================================================================
// The kit (MatterView)
// =============================================================================================

const FIELD_RINGS = 6, FIELD_SPOKES = 24;
const PIECE_COL = [C.violet, C.teal, C.sky, C.sky, C.brass, C.amber, C.brass];
const KIT_FIT = [[-0.86, 0.15, -0.6], [0.95, 1.3, 0.3]];

function face(i) {
  const pl = D.T.kit.pieces[i];
  const n = pl.normal;
  const tw_ = v3.sub([0, 0, -1], v3.scale(n, v3.dot([0, 0, -1], n)));
  const u = v3.dot(tw_, tw_) < 1e-4 ? v3.norm(v3.sub([0, -1, 0], v3.scale(n, -n[1]))) : v3.norm(tw_);
  const v = v3.cross(n, u);
  const dome = pl.dome;
  const rise = (r) => {
    if (dome <= 0) return 0;
    const a = pl.radius;
    return 1.6 * (Math.sqrt(Math.max(0, dome * dome - (r * a) ** 2)) - Math.sqrt(Math.max(0, dome * dome - a * a)));
  };
  return {
    pl, u, v, n, rise,
    point(r, th, w) {
      const radial = v3.add(v3.scale(u, Math.cos(th) * r * pl.radius), v3.scale(v, Math.sin(th) * r * pl.radius));
      return v3.add(v3.add(pl.centre, radial), v3.scale(n, rise(r) + w));
    },
    ringPoint(r, th, back) {
      const radial = v3.add(v3.scale(u, Math.cos(th) * r * pl.radius), v3.scale(v, Math.sin(th) * r * pl.radius));
      return v3.add(v3.add(pl.centre, radial), v3.scale(n, -back));
    },
  };
}
function fieldPoint(i) {
  if (i === 0) return [0, 0];
  const ring = Math.floor((i - 1) / FIELD_SPOKES), spoke = (i - 1) % FIELD_SPOKES;
  return [(ring + 1) / FIELD_RINGS, (TAU * spoke) / FIELD_SPOKES];
}

function kitFrame(f) {
  const K = D.kit;
  f = clamp(f, 0, K.frames.length - 1);
  return { K, fr: K.frames[f], f, sref: K.sref[f], wires: K.wires[f], energyTop: K.energyTop[f] };
}

function drawField(ctx, proj, F, field, sref, base, lift, awake, alpha, boost = 1) {
  const colOf = (w) => { const t = clamp(w / sref, -1, 1); return [t >= 0 ? mix3(base, C.amber, t) : mix3(base, C.teal, -t), Math.abs(t)]; };
  const fp = (i) => { const [r, th] = fieldPoint(i); const w = field ? field[i] : 0; return [proj.p(F.point(r, th, w * lift)), w]; };
  const P = []; for (let i = 0; i < 1 + FIELD_RINGS * FIELD_SPOKES; i++) P.push(fp(i));
  const sg = (a, b, core) => {
    if (!a[0] || !b[0]) return;
    const [col, g0] = colOf(0.5 * (a[1] + b[1]));
    const g = awake ? clamp01(g0 * boost) : 0;
    if (g > 0.05) seg(ctx, a[0], b[0], col, (0.1 + 0.25 * g) * alpha, 3 + 5 * g);
    seg(ctx, a[0], b[0], col, (0.4 + 0.5 * g) * alpha, core);
  };
  const idx = (ring, spoke) => 1 + ring * FIELD_SPOKES + (spoke % FIELD_SPOKES);
  for (let ring = 0; ring < FIELD_RINGS; ring++) for (let j = 0; j < FIELD_SPOKES; j++) sg(P[idx(ring, j)], P[idx(ring, j + 1)], ring + 1 === FIELD_RINGS ? 1.6 : 1.0);
  for (let j = 0; j < FIELD_SPOKES; j += 2) { let prev = P[0]; for (let ring = 0; ring < FIELD_RINGS; ring++) { const nx = P[idx(ring, j)]; sg(prev, nx, 0.8); prev = nx; } }
}

const liftFor = (sref, radius, ex = 1) => (0.14 * radius * ex) / Math.max(sref, 1e-9);

function drawDrum(ctx, proj, i, Kf, o) {
  const alpha = o.alpha ?? 1;
  const F = face(i);
  const pl = F.pl;
  const pv = Kf.fr.pieces[i];
  const col = PIECE_COL[i];
  const g = clamp01(Math.sqrt((pv.level || 0) * 6) * (o.glowBoost ?? 1));
  const ringPts = (back) => { const a = []; for (let j = 0; j <= 48; j++) a.push(proj.p(F.ringPoint(1, (TAU * j) / 48, back))); return a; };
  const front = ringPts(0), rear = ringPts(pl.depth);
  ctx.globalCompositeOperation = 'source-over';
  fillPoly(ctx, rear, mix3(C.bgBot, col, 0.12), 0.55 * alpha);
  ctx.globalCompositeOperation = 'lighter';
  glow(ctx, rear, col, (0.35 + 0.3 * g) * alpha, 3, 1.2);
  for (let j = 0; j < 16; j++) { const a = (TAU * j) / 16; seg(ctx, proj.p(F.ringPoint(1, a, 0)), proj.p(F.ringPoint(1, a, pl.depth)), col, (0.18 + 0.2 * g) * alpha, 1.0); }
  const lugs = i <= 1 ? 10 : 8;
  for (let j = 0; j < lugs; j++) { const a = (TAU * (j + 0.5)) / lugs; dot(ctx, proj.p(F.ringPoint(1.04, a, 0.015)), 1.8, mix3(col, C.white, 0.4), 0.6 * alpha); }
  ctx.globalCompositeOperation = 'source-over';
  fillPoly(ctx, front, mix3(C.bgTop, C.head, 0.1), 0.5 * alpha);
  ctx.globalCompositeOperation = 'lighter';
  if (i === 1) {
    const a = Kf.wires;
    for (let k = 0; k < 8; k++) {
      const y = -0.35 + (0.7 * (k + 0.5)) / 8;
      const jit = a > 0.05 ? 0.004 * a * Math.sin(k * 7.3 + Kf.f * 1.0) : 0;
      const p0 = F.ringPoint(0.9, 0, pl.depth + 0.004 + jit), p1 = F.ringPoint(0.9, Math.PI, pl.depth + 0.004 + jit);
      const off = v3.scale(F.v, y * pl.radius);
      const pa = proj.p(v3.add(p0, off)), pb = proj.p(v3.add(p1, off));
      if (a > 0.05) seg(ctx, pa, pb, C.amber, 0.25 * a * alpha, 3.5);
      seg(ctx, pa, pb, mix3(C.dim, C.amber, a), (0.5 + 0.5 * a) * alpha, 0.8);
    }
  }
  const sref = Kf.sref[i];
  drawField(ctx, proj, F, pv.field, sref, C.head, liftFor(sref, pl.radius, o.exaggeration ?? 1), pv.awake, alpha, o.glowBoost ?? 1);
  glow(ctx, front, col, (0.55 + 0.4 * g) * alpha, 4, 1.6);
}

function drawCymbal(ctx, proj, i, Kf, o) {
  const alpha = o.alpha ?? 1;
  const F = face(i);
  const pv = Kf.fr.pieces[i];
  const col = PIECE_COL[i];
  const g = clamp01(Math.sqrt((pv.level || 0) * 8) * (o.glowBoost ?? 1));
  const sref = Kf.sref[i];
  const lift = liftFor(sref, F.pl.radius, o.exaggeration ?? 1);
  const rim = [];
  for (let j = 0; j < FIELD_SPOKES; j++) { const k = 1 + (FIELD_RINGS - 1) * FIELD_SPOKES + j; const w = pv.field ? pv.field[k] : 0; const [r, th] = fieldPoint(k); rim.push(proj.p(F.point(r, th, w * lift))); }
  ctx.globalCompositeOperation = 'source-over';
  fillPoly(ctx, rim, mix3(C.bgBot, col, 0.18 + 0.2 * g), 0.45 * alpha);
  ctx.globalCompositeOperation = 'lighter';
  drawField(ctx, proj, F, pv.field, sref, mix3(col, C.dim, 0.35), lift, pv.awake, alpha, o.glowBoost ?? 1);
  const c = proj.p(F.point(0, 0, 0));
  dot(ctx, c, 4 + 6 * g, col, (0.25 + 0.3 * g) * alpha);
  dot(ctx, c, 2.2, mix3(col, C.white, 0.5), 0.9 * alpha);
}

function drawStand(ctx, proj, i, alpha) {
  const pl = D.T.kit.pieces[i];
  const F = face(i);
  const a0 = 0.3 * alpha;
  const sg = (a, b, w) => seg(ctx, proj.p(a), proj.p(b), C.dim, a0, w);
  if (i === 0) {
    const front = F.ringPoint(0, 0, pl.depth);
    for (const s of [-1, 1]) sg([front[0] + s * 0.24, 0.12, front[2] - 0.02], [front[0] + s * 0.36, 0, front[2] + 0.08], 1.5);
  } else if (i === 2) {
    sg([0, pl.centre[1] - 0.05, -0.02], [0, 0.58, -0.05], 2);
  } else if (i === 3) {
    for (let k = 0; k < 3; k++) { const a = (TAU * k) / 3 + 0.4; const top = [pl.centre[0] + (pl.radius + 0.02) * Math.cos(a), pl.centre[1] - 0.05, pl.centre[2] + (pl.radius + 0.02) * Math.sin(a)]; sg(top, [top[0] + 0.05 * Math.cos(a), 0, top[2] + 0.05 * Math.sin(a)], 1.5); }
  } else {
    const under = v3.add(F.ringPoint(0, 0, pl.depth), v3.scale(pl.normal, i >= 4 ? -0.04 : -0.02));
    const foot = [under[0], 0, under[2]];
    sg(under, [foot[0], 0.18, foot[2]], 2);
    for (let k = 0; k < 3; k++) { const a = (TAU * k) / 3 + 0.3; sg([foot[0], 0.18, foot[2]], [foot[0] + 0.22 * Math.cos(a), 0, foot[2] + 0.22 * Math.sin(a)], 1.5); }
  }
}

function drawFloor(ctx, proj, alpha) {
  for (let k = 1; k <= 3; k++) {
    const r = 0.26 * k, pts = [];
    for (let j = 0; j <= 64; j++) { const a = (TAU * j) / 64; pts.push(proj.p([r * Math.cos(a), 0, -0.2 + 0.6 * r * Math.sin(a)])); }
    glow(ctx, pts, C.dim, 0.18 * alpha, 0, 1.0);
  }
}

// The stick replaying a strike: it lands where the strike landed and leaves at the measured rebound.
function drawStick(ctx, proj, i, t, alpha) {
  const h = lastHit(i, t);
  if (!h) return;
  const dt = t - h[0];
  const F = face(i);
  const kick = i === 0;
  const contact = 0.06;
  let lift;
  if (dt < contact) lift = 0;
  else lift = Math.min(0.16, 0.16 * ((dt - contact) / 0.35));
  // Before the hit: the stick coming down (from the previous rest).
  const fade = kick ? 1 : clamp01(1 - (dt - 0.5) / 0.3);
  if (fade <= 0) return;
  const tip = F.point(h[3], h[4], lift);
  const d = v3.norm([tip[0] * 0.3 - tip[0], 0.55, -0.9]);
  const hand = kick ? [0, 0.06, F.pl.centre[2] - 0.12] : v3.add(tip, v3.scale(d, 0.26));
  const pt = proj.p(tip), ph = proj.p(hand);
  if (dt < contact + 0.1) {
    const c = proj.p(F.point(h[3], h[4], 0));
    const k = 1 - clamp01(dt / (contact + 0.1));
    dot(ctx, c, 14, C.amber, 0.25 * k * alpha);
    dot(ctx, c, 6, [1, 0.95, 0.85], 0.7 * k * alpha);
  }
  seg(ctx, pt, ph, C.amber, 0.12 * fade * alpha, 5);
  seg(ctx, pt, ph, [0.95, 0.85, 0.65], 0.85 * fade * alpha, kick ? 2 : 2.4);
  dot(ctx, pt, kick ? 6 : 3, kick ? [0.9, 0.9, 0.95] : [1, 0.9, 0.7], 0.9 * fade * alpha);
}

function drawKit(ctx, proj, Kf, t, o = {}) {
  const alpha = o.alpha ?? 1;
  const only = o.only;
  drawFloor(ctx, proj, alpha * (o.floor ?? 1));
  // Far to near, so near pieces draw over far ones.
  const order = [0, 1, 2, 3, 4, 5, 6].filter((i) => !only || only.includes(i)).sort((a, b) => {
    const da = proj.raw(D.T.kit.pieces[a].centre), db = proj.raw(D.T.kit.pieces[b].centre);
    return (db ? db[2] : 0) - (da ? da[2] : 0);
  });
  for (const i of order) {
    const a = alpha * (o.pieceAlpha ? o.pieceAlpha[i] : 1);
    drawStand(ctx, proj, i, a);
    if (i >= 4) drawCymbal(ctx, proj, i, Kf, { ...o, alpha: a, glowBoost: o.boost ? o.boost[i] : 1 });
    else drawDrum(ctx, proj, i, Kf, { ...o, alpha: a, glowBoost: o.boost ? o.boost[i] : 1 });
    if (o.sticks !== false) drawStick(ctx, proj, i, t, a);
  }
}

// =============================================================================================
// Physics View panels
// =============================================================================================

function panelBox(ctx, r, title, alpha, col = C.label) {
  const [x, y, w, h] = r;
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 10);
  ctx.fillStyle = rgba([0.03, 0.03, 0.07], 0.82 * alpha); ctx.fill();
  ctx.strokeStyle = rgba(C.dim, 0.6 * alpha); ctx.lineWidth = 1.2; ctx.stroke();
  ctx.globalCompositeOperation = 'lighter';
  text(ctx, title, x + 14, y + 24, { size: 13, family: MONO, weight: 500, col, alpha: 0.95 * alpha, tracking: 1.5 });
}
const inner = (r) => [r[0] + 44, r[1] + 36, r[2] - 56, r[3] - 64];

function panelLadder(ctx, r, B, alpha, p = 1) {
  panelBox(ctx, r, 'RESONANCES', alpha);
  const [x, y, w, h] = inner(r);
  const fr = B.fr;
  if (!fr.ladHz) return;
  const lo = Math.log(25), hi = Math.log(1100);
  const hzX = (hz) => x + ((Math.log(clamp(hz, 25, 1100)) - lo) / (hi - lo)) * w;
  const top = Math.max(1, ...fr.ladMag);
  const curve = [];
  const N = Math.floor(160 * p);
  for (let k = 0; k <= N; k++) {
    const xx = x + (w * k) / 160;
    const f = Math.exp(lo + ((xx - x) / w) * (hi - lo));
    let z = 0;
    for (let j = 0; j < fr.ladHz.length; j++) { const fr0 = fr.ladHz[j]; if (fr0 > 0) z = Math.max(z, fr.ladMag[j] / Math.sqrt(1 + (22 * (f / fr0 - fr0 / f)) ** 2)); }
    curve.push([xx, y + h - clamp01(z / top) * h]);
  }
  glow(ctx, curve, C.brass, 0.85 * alpha, 3, 1.2);
  fr.ladHz.forEach((fr0, j) => {
    if (fr0 > 25 && fr0 < 1100 && (j + 1 === fr.partial || j < 8)) {
      const xx = hzX(fr0);
      if (xx > x + w * p) return;
      const yy = y + h - clamp01(fr.ladMag[j] / top) * h;
      text(ctx, `${j + 1}`, xx, yy - 6, { size: 12, family: MONO, align: 'center', col: j + 1 === fr.partial ? C.amber : C.dim, alpha });
    }
  });
  const mark = (hz, col, label, row) => {
    if (!(hz > 0)) return;
    const xx = hzX(hz);
    seg(ctx, [xx, y], [xx, y + h], col, 0.9 * alpha, 1.2);
    text(ctx, label, xx + 5, y + 14 + row, { size: 12, family: MONO, col, alpha });
  };
  if (fr.on && p >= 1) { mark(fr.lipHz, C.rose, 'lips', 0); mark(fr.hz, C.teal, 'sounding', 16); }
  text(ctx, 'frequency (Hz, log)', x + w / 2, r[1] + r[3] - 12, { size: 12, family: MONO, align: 'center', col: C.label, alpha: 0.8 * alpha });
}

function panelMap(ctx, r, B, alpha) {
  panelBox(ctx, r, 'PLAYING MAP', alpha);
  const [x, y, w, h] = inner(r);
  const fr = B.fr;
  const lo = Math.log(0.5), hi = Math.log(1.25);
  const ratioY = (q) => y + h - ((Math.log(clamp(q, 0.5, 1.25)) - lo) / (hi - lo)) * h;
  const slot = (b) => { const f = clamp01(b) * 32; const i = Math.min(31, Math.floor(f)); return D.slot[i] * (1 - (f - i)) + D.slot[i + 1] * (f - i); };
  const n = Math.max(1, fr.partial);
  const res = (k) => (fr.ladHz && k >= 1 && k <= fr.ladHz.length ? fr.ladHz[k - 1] : 0);
  const r0 = Math.max(1, res(n));
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (const [k, col] of [[n - 1, C.sky], [n + 1, C.rose], [n, C.teal]]) {
    const fk = res(k);
    if (k < 1 || !(fk > 0)) continue;
    const up = [], dn = [];
    for (let j = 0; j <= 32; j++) { const b = j / 32; const c = (slot(b) * fk) / r0; up.push([x + b * w, ratioY(c * 1.08)]); dn.push([x + b * w, ratioY(c * 0.92)]); }
    fillPoly(ctx, up.concat(dn.reverse()), col, k === n ? 0.22 * alpha : 0.12 * alpha);
    const mid = up[16];
    text(ctx, `partial ${k}`, mid[0], mid[1] - 4, { size: 11, family: MONO, align: 'center', col, alpha: 0.9 * alpha });
  }
  ctx.restore();
  text(ctx, 'breath →', x + w / 2, r[1] + r[3] - 12, { size: 12, family: MONO, align: 'center', alpha: 0.8 * alpha });
  if (fr.on && fr.lipHz > 0) {
    const p = [x + clamp01(fr.breath) * w, ratioY(fr.lipHz / r0)];
    dot(ctx, p, 9, C.amber, 0.3 * alpha); dot(ctx, p, 4.5, mix3(C.amber, C.white, 0.4), alpha);
  }
}

function panelTraces(ctx, r, B, t, alpha) {
  panelBox(ctx, r, 'ONE PERIOD', alpha);
  const [x, y, w, h] = inner(r);
  const fr = B.fr;
  if (!fr.mp) return;
  let lo = 1e9, hi = -1e9; for (const v of fr.mp) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.max(hi - lo, 1);
  let top = 1e-6; for (const v of fr.lip) top = Math.max(top, v);
  const xs = (i) => x + (w * i) / 63;
  glow(ctx, fr.mp.map((v, i) => [xs(i), y + h - ((v - lo) / span) * h]), C.amber, 0.9 * alpha, 3, 1.3);
  glow(ctx, fr.lip.map((v, i) => [xs(i), y + h - (Math.max(0, v) / top) * h * 0.9]), C.rose, 0.9 * alpha, 3, 1.3);
  const px = x + ((t / 1.5) % 1) * w;
  seg(ctx, [px, y], [px, y + h], C.dim, 0.8 * alpha, 1);
  text(ctx, 'mouthpiece / lips', x + w, r[1] + 24, { size: 12, family: MONO, align: 'right', alpha: 0.8 * alpha });
}

function panelSchelleng(ctx, r, Sd, alpha) {
  panelBox(ctx, r, 'PLAYABLE WINDOW', alpha);
  const [x, y, w, h] = inner(r);
  const s = Sd.active >= 0 ? Sd.strings[Sd.active] : null;
  const lo = Math.log(0.02), hi = Math.log(0.5);
  const bX = (b) => x + ((Math.log(clamp(b, 0.02, 0.5)) - lo) / (hi - lo)) * w;
  const kY = (k) => y + h - clamp01(k) * h;
  const [b0, kmin0, kmax0] = s && s.kMax > s.kMin && s.beta > 0 ? [s.beta, s.kMin, s.kMax] : [0.12, 0.2, 0.75];
  const top = [], bot = [];
  for (let k = 0; k <= 40; k++) {
    const xx = x + (w * k) / 40;
    const beta = Math.exp(lo + ((xx - x) / w) * (hi - lo));
    bot.push([xx, kY(kmin0 + 0.5 * 2.52 * Math.log10(b0 / beta))]);
    top.push([xx, kY(kmax0 + 0.5 * 1.41 * Math.log10(b0 / beta))]);
  }
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  for (let k = 1; k < top.length; k++) if (top[k][1] < bot[k][1]) fillPoly(ctx, [top[k - 1], top[k], bot[k], bot[k - 1]], C.teal, 0.14 * alpha);
  glow(ctx, top, C.rose, 0.85 * alpha, 0, 1.4);
  glow(ctx, bot, C.sky, 0.85 * alpha, 0, 1.4);
  ctx.restore();
  text(ctx, 'raucous', x + w - 4, y + 14, { size: 12, family: MONO, align: 'right', col: C.rose, alpha });
  text(ctx, 'surface sound', x + 4, y + h - 6, { size: 12, family: MONO, col: C.sky, alpha });
  text(ctx, 'bridge ← bow position → fingerboard', x + w / 2, r[1] + r[3] - 12, { size: 12, family: MONO, align: 'center', alpha: 0.8 * alpha });
  if (s && s.on && s.f > 0) {
    const col = REGIME_COL[regime(s)];
    const p = [bX(s.beta), kY(s.k)];
    dot(ctx, p, 9, col, 0.3 * alpha); dot(ctx, p, 4.5, mix3(col, C.white, 0.4), alpha);
  }
}

function panelModes(ctx, r, Kf, piece, alpha, title) {
  panelBox(ctx, r, title || `MODES — ${PIECE_NAMES[piece]}`, alpha);
  const [x, y, w, h] = inner(r);
  const pv = Kf.fr.pieces[piece];
  if (!pv.modeHz) return;
  const lo = Math.log(30), hi = Math.log(6000);
  const hzX = (hz) => x + ((Math.log(clamp(hz, 30, 6000)) - lo) / (hi - lo)) * w;
  let top = 1e-12; for (const a of pv.modeAmp) top = Math.max(top, a);
  const col = PIECE_COL[piece];
  pv.modeHz.forEach((hz, k) => {
    const a = pv.modeAmp[k];
    if (hz <= 30 || hz >= 6000 || !(a > 0)) return;
    const xx = hzX(hz);
    const tt = clamp01((20 * Math.log10(a / top) + 60) / 60);
    const yy = y + h - tt * h;
    seg(ctx, [xx, y + h], [xx, yy], col, (0.18 + 0.25 * tt) * alpha, 3);
    seg(ctx, [xx, y + h], [xx, yy], mix3(col, C.white, 0.3), (0.5 + 0.5 * tt) * alpha, 1);
  });
  for (const hz of [100, 1000]) text(ctx, hz < 1000 ? '100 Hz' : '1 kHz', hzX(hz), r[1] + r[3] - 12, { size: 12, family: MONO, align: 'center', alpha: 0.8 * alpha });
  if (pv.nonlinear) text(ctx, 'von Kármán: ON', x + w, r[1] + 24, { size: 12, family: MONO, align: 'right', col: C.rose, alpha });
  else if (pv.glide > 1) text(ctx, `glide ${pv.glide > 0 ? '+' : ''}${pv.glide.toFixed(0)} c`, x + w, r[1] + 24, { size: 12, family: MONO, align: 'right', col: C.rose, alpha });
}

function panelForce(ctx, r, Kf, piece, alpha) {
  panelBox(ctx, r, 'CONTACT FORCE', alpha);
  const [x, y, w, h] = inner(r);
  const pv = Kf.fr.pieces[piece];
  if (!pv.trace) return;
  let top = 1e-3; for (const v of pv.trace) top = Math.max(top, v);
  glow(ctx, pv.trace.map((v, i) => [x + (w * i) / 95, y + h - clamp01(v / top) * h]), C.amber, 0.95 * alpha, 3, 1.3);
  text(ctx, `${Math.round(pv.force)} N peak`, x + w, r[1] + 24, { size: 12, family: MONO, align: 'right', alpha: 0.85 * alpha });
  text(ctx, `${(pv.traceMs || 0).toFixed(1)} ms from the strike`, x + w / 2, r[1] + r[3] - 12, { size: 12, family: MONO, align: 'center', alpha: 0.8 * alpha });
}

function panelEnergy(ctx, r, Kf, alpha) {
  panelBox(ctx, r, 'ENERGY IN EACH PIECE', alpha);
  const [x, y, w, h] = inner(r);
  const top = Math.log10(Kf.energyTop);
  const bh = h / 7;
  Kf.fr.pieces.forEach((pv, i) => {
    const yy = y + bh * i;
    const tt = pv.energy > 0 ? clamp01((Math.log10(pv.energy) - top + 7) / 7) : 0;
    const x0 = x + 70;
    ctx.fillStyle = rgba(PIECE_COL[i], (0.25 + 0.5 * tt) * alpha);
    ctx.beginPath(); ctx.roundRect(x0, yy + 3, Math.max(1, tt * (w - 70)), bh - 6, 3); ctx.fill();
    text(ctx, PIECE_NAMES[i].split(' ')[0], x - 30, yy + bh / 2 + 4, { size: 11, family: MONO, col: pv.awake ? PIECE_COL[i] : C.label, alpha });
  });
}
