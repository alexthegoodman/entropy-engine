// Post: bloom (a 13-tap downsample / tent upsample mip chain on float targets), a directional blur
// for whip pans, chromatic aberration, vignette, grain, and a soft roll-off of the highlights.
'use strict';

const Post = (() => {
  let gl, progs = {}, quad, srcTex, ovTex, levels = [], out;

  const VS = `#version 300 es
  in vec2 p; out vec2 uv;
  void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

  const DOWN = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 o;
  uniform sampler2D t; uniform vec2 texel; uniform float prefilter; uniform float threshold; uniform float knee;
  vec3 s(vec2 d) { return texture(t, uv + d * texel).rgb; }
  void main() {
    vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
    vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
    vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
    vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
    vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
    if (prefilter > 0.5) {
      float br = max(col.r, max(col.g, col.b));
      float soft = clamp(br - threshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee + 1e-5);
      float w = max(soft, br - threshold) / max(br, 1e-5);
      col *= w;
    }
    o = vec4(col, 1.0);
  }`;

  const UP = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 o;
  uniform sampler2D t; uniform vec2 texel; uniform float radius;
  vec3 s(vec2 d) { return texture(t, uv + d * texel * radius).rgb; }
  void main() {
    vec3 col = s(vec2(0, 0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
      + s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
    o = vec4(col / 16.0, 1.0);
  }`;

  const COMP = `#version 300 es
  precision highp float;
  in vec2 uv; out vec4 o;
  uniform sampler2D src; uniform sampler2D bloom; uniform sampler2D overlay;
  uniform vec2 res; uniform float bloomStrength; uniform float ca; uniform vec2 whip; uniform float vignette;
  uniform float grain; uniform float frame; uniform float flash; uniform vec3 flashCol; uniform float fade; uniform float exposure;
  uniform vec2 zoomBlur; // strength, 0
  float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
  vec3 sampleSrc(vec2 q) {
    vec2 d = (q - 0.5);
    float r = texture(src, q + d * ca).r;
    float g = texture(src, q).g;
    float b = texture(src, q - d * ca).b;
    return vec3(r, g, b);
  }
  void main() {
    vec3 col;
    float wl = length(whip);
    if (wl > 0.0005 || zoomBlur.x > 0.0005) {
      col = vec3(0.0); float tot = 0.0;
      for (int k = 0; k < 24; k++) {
        float f = float(k) / 23.0 - 0.5;
        float w = 1.0 - abs(f) * 1.2;
        vec2 q = uv + whip * f + (uv - 0.5) * zoomBlur.x * f;
        col += sampleSrc(q) * w; tot += w;
      }
      col /= tot;
    } else {
      col = sampleSrc(uv);
    }
    vec3 b = texture(bloom, uv).rgb;
    col += b * bloomStrength;
    col *= exposure;
    // Roll the highlights off instead of clipping them.
    vec3 hi = max(col - 0.82, 0.0);
    col = min(col, 0.82) + hi / (1.0 + hi * 2.2);
    // Vignette.
    vec2 d = (uv - 0.5) * vec2(res.x / res.y, 1.0);
    float v = smoothstep(0.35, 1.05, length(d));
    col *= 1.0 - vignette * v;
    // Type and chrome: over the image, not bloomed or blurred.
    vec4 ov = texture(overlay, uv);
    col = col * (1.0 - ov.a) + ov.rgb * ov.a;
    col = mix(col, flashCol, flash);
    col *= fade;
    // Grain (luma, strongest in the mids), and a little dither.
    float n = hash(uv * res + frame * 17.13) + hash(uv * res * 1.7 - frame * 3.71) - 1.0;
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col += n * grain * (0.35 + 0.65 * smoothstep(0.0, 0.25, l) * (1.0 - smoothstep(0.6, 1.0, l)));
    col += (hash(uv * res + 0.5) - 0.5) / 255.0;
    o = vec4(clamp(col, 0.0, 1.0), 1.0);
  }`;

  function compile(fs) {
    const p = gl.createProgram();
    for (const [type, srcText] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, srcText); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      gl.attachShader(p, sh);
    }
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  function init(canvas) {
    gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('webgl2 unavailable');
    gl.getExtension('EXT_color_buffer_float');
    progs.down = compile(DOWN); progs.up = compile(UP); progs.comp = compile(COMP);
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    ovTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, ovTex);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    let w = W, h = H;
    for (let i = 0; i < 6; i++) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); levels.push(target(w, h)); }
  }

  function draw(prog, fb, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function render(canvas2d, overlay2d, o) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ovTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, overlay2d);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d);
    gl.disable(gl.BLEND);
    // Down the chain.
    let prevTex = srcTex, pw = W, ph = H;
    for (let i = 0; i < levels.length; i++) {
      const L = levels[i];
      gl.useProgram(progs.down.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, prevTex);
      gl.uniform1i(progs.down.u.t, 0);
      gl.uniform2f(progs.down.u.texel, 1 / pw, 1 / ph);
      gl.uniform1f(progs.down.u.prefilter, i === 0 ? 1 : 0);
      gl.uniform1f(progs.down.u.threshold, o.threshold ?? 0.5);
      gl.uniform1f(progs.down.u.knee, 0.22);
      draw(progs.down, L.fb, L.w, L.h);
      prevTex = L.tex; pw = L.w; ph = L.h;
    }
    // Up the chain, adding.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = levels.length - 1; i > 0; i--) {
      const from = levels[i], to = levels[i - 1];
      gl.useProgram(progs.up.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.tex);
      gl.uniform1i(progs.up.u.t, 0);
      gl.uniform2f(progs.up.u.texel, 1 / from.w, 1 / from.h);
      gl.uniform1f(progs.up.u.radius, 1.0);
      draw(progs.up, to.fb, to.w, to.h);
    }
    gl.disable(gl.BLEND);
    // Composite to the screen.
    const c = progs.comp;
    gl.useProgram(c.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(c.u.src, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, levels[0].tex); gl.uniform1i(c.u.bloom, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, ovTex); gl.uniform1i(c.u.overlay, 2);
    gl.uniform2f(c.u.res, W, H);
    gl.uniform1f(c.u.bloomStrength, o.bloom ?? 0.9);
    gl.uniform1f(c.u.ca, o.ca ?? 0.002);
    gl.uniform2f(c.u.whip, o.whip ? o.whip[0] : 0, o.whip ? o.whip[1] : 0);
    gl.uniform2f(c.u.zoomBlur, o.zoomBlur ?? 0, 0);
    gl.uniform1f(c.u.vignette, o.vignette ?? 0.45);
    gl.uniform1f(c.u.grain, o.grain ?? 0.035);
    gl.uniform1f(c.u.frame, o.frame ?? 0);
    gl.uniform1f(c.u.flash, o.flash ?? 0);
    gl.uniform3f(c.u.flashCol, ...(o.flashCol || [1, 1, 1]));
    gl.uniform1f(c.u.fade, o.fade ?? 1);
    gl.uniform1f(c.u.exposure, o.exposure ?? 1);
    draw(c, null, W, H);
    gl.activeTexture(gl.TEXTURE0);
  }

  return { init, render };
})();
