// Vocalo's face: an abstract, living presence made of light.
//
// Not a human face (that lands in the uncanny valley), but unmistakably someone:
// a breathing nebula head with glowing eyes, brows and a mouth. Everything moves on
// critically-damped springs so motion has weight; nothing is keyframed.
//
//   eyes   blink on a natural random schedule (sometimes double), saccade between gaze
//          targets, look at you while listening, up-and-away while thinking, and at the
//          code when the panel opens; follow the mouse a little
//   mouth  driven live by the voice: openness from low/mid energy, width from the
//          high band (ee vs oo); a soft smile curve when closed
//   brows  rise with interest (listening, emphasis), relax when idle
//   head   breathes, tilts while thinking, leans in while you talk, nods when you pause
//   aura   thought particles while thinking; inward ripples while listening

const VERT = `#version 300 es
in vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_gaze;
uniform float u_blink, u_lid, u_smile, u_brow, u_open, u_wide, u_breath, u_energy, u_think, u_listen, u_tilt, u_nod, u_lean, u_alert;
uniform vec3 u_c0, u_c1, u_c2, u_c3;
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; } return v; }
mat2 rot(float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float sdCapsuleV(vec2 p, float h, float r){ p.y -= clamp(p.y, -h, h); return length(p) - r; }
float sdCapsuleH(vec2 p, float h, float r){ p.x -= clamp(p.x, -h, h); return length(p) - r; }

void main(){
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y) * 2.0;
  float t = u_time;

  // ---- head transform: nod, tilt, breathing, leaning in
  vec2 q = p;
  q.y += u_nod * 0.045;
  q = rot(u_tilt) * q;
  q /= 1.0 + 0.018 * u_breath + 0.035 * u_energy + 0.05 * u_lean;

  // ---- body: domain-warped nebula inside a soft head shape
  vec2 w = q * 1.7 + vec2(fbm(q * 2.1 + t * 0.13), fbm(q * 2.1 - t * 0.11 + 3.1)) * (0.8 + 0.5 * u_think);
  float n = fbm(w * 1.25 + vec2(0.0, t * 0.06));
  float r = length(q / vec2(0.64, 0.76));
  float edge = r - 1.0 + (n - 0.5) * (0.24 + 0.12 * u_energy);
  float body = smoothstep(0.34, -0.30, edge);
  float rim = exp(-abs(edge) * 6.5);
  float core = exp(-r * r * 1.6);                                          // light gathered in the middle
  vec3 col = mix(u_c0, u_c1, 0.35 + 0.65 * smoothstep(0.2, 0.8, n)) * body;
  col += mix(u_c1, u_c3, 0.25) * core * (0.42 + 0.4 * u_energy + 0.15 * sin(t * 1.05)) * body;  // subsurface glow
  col += u_c2 * rim * (0.22 + 0.35 * u_energy + 0.08 * u_listen);         // soft edge light
  // cheeks warm up when smiling
  float cheeks = exp(-pow(length(vec2(abs(q.x) - 0.33, q.y + 0.1)) * 7.0, 2.0)) * u_smile;
  col += vec3(1.0, 0.45, 0.55) * cheeks * 0.12 * body;
  float alpha = clamp(body * 0.94 + rim * 0.35, 0.0, 1.0);

  // ---- eyes
  vec2 g = u_gaze * vec2(0.075, 0.055);
  float open = (1.0 - u_blink) * mix(1.0, 0.42, u_lid) * (1.0 + 0.18 * u_alert);
  for (int i = 0; i < 2; i++) {
    float sx = i == 0 ? -1.0 : 1.0;
    vec2 e = q - vec2(sx * 0.245, 0.095) - g;
    float h = 0.052 * open;
    float rad = 0.052 * mix(0.82, 1.0, open);
    float d = sdCapsuleV(e, max(h, 0.0), rad);
    // happy crescent: carve the lower part when smiling (eyes "^ ^")
    float carve = length(e - vec2(0.0, -0.105)) - 0.09;
    d = mix(d, max(d, -carve), clamp(u_smile * 1.15 - 0.15, 0.0, 1.0) * open);
    float core = smoothstep(0.010, -0.006, d);
    float glow = exp(-max(d, 0.0) * 26.0);
    vec3 eyeCol = mix(u_c3, vec3(1.0), 0.25);
    col = mix(col, eyeCol, core);
    col += u_c3 * glow * (0.30 + 0.15 * u_listen + 0.25 * u_alert);
    // catchlight: a tiny highlight that shifts against the gaze (reads as depth)
    vec2 hl = e - vec2(-0.018 * sx * 0.3 - g.x * 0.25, h * 0.55 + 0.018);
    col += vec3(1.0) * smoothstep(0.016, 0.0, length(hl)) * 0.55 * core;
    alpha = max(alpha, core + glow * 0.35);

    // brows: soft arcs that rise with interest
    vec2 b = q - vec2(sx * 0.245, 0.205 + 0.045 * u_brow + 0.02 * u_alert) - g * 0.4;
    b = rot(sx * (0.12 - 0.18 * u_brow + 0.10 * u_think * sx)) * b;
    float bd = abs(b.y + 3.2 * b.x * b.x) - 0.0045;
    float browA = exp(-max(bd, 0.0) * 70.0) * smoothstep(0.085, 0.05, abs(b.x));
    col += u_c3 * browA * (0.22 + 0.35 * u_brow);
    alpha = max(alpha, browA * 0.4);
  }

  // ---- mouth: shaped by the voice (a stadium that opens into an oval)
  vec2 m = q - vec2(0.0, -0.265 - 0.022 * u_open);           // the jaw drops a little as it opens
  float mw = 0.075 + 0.05 * u_wide + 0.025 * u_open;          // half width
  float mo = 0.004 + 0.075 * u_open;                          // half height (opening)
  // smile: bend the mouth line upward at the corners
  m.y -= u_smile * (0.034 * (m.x * m.x) / (mw * mw) - 0.014) * (1.0 - 0.6 * u_open);
  // flatter upper lip, fuller lower lip
  vec2 mm = vec2(m.x, m.y * (m.y > 0.0 ? 1.4 : 1.0));
  float dm = sdCapsuleH(vec2(mm.x * (1.0 + 0.6 * u_open * mm.x * mm.x / (mw * mw)), mm.y), max(mw - mo, 0.0), mo);
  dm += (noise(vec2(m.x * 34.0, t * 9.0)) - 0.5) * 0.004 * u_open;
  float inside = smoothstep(0.003, -0.004, dm) * smoothstep(0.0, 0.02, u_open);
  float lip = exp(-max(abs(dm) - 0.002, 0.0) * 95.0) * smoothstep(mw + 0.03, mw - 0.01, abs(m.x));
  vec3 mouthIn = mix(u_c1 * 0.30 + vec3(0.10, 0.02, 0.05), u_c0 * 0.9, smoothstep(-mo, mo, m.y)); // warm depth, darker under the top lip
  col = mix(col, mouthIn, inside * 0.85);
  col += mix(u_c2, u_c3, 0.35) * lip * (0.28 + 0.35 * u_open + 0.15 * u_smile);
  alpha = max(alpha, inside * 0.95 + lip * 0.4);

  // ---- thinking: particles orbiting like thoughts
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float ang = t * (0.55 + 0.07 * fi) + fi * 0.897;
    vec2 pos = vec2(cos(ang), sin(ang)) * vec2(0.80, 0.90) * (1.0 + 0.05 * sin(t * 1.7 + fi * 2.1));
    float s = exp(-length(q - pos) * (38.0 - 6.0 * sin(t * 2.0 + fi)));
    col += u_c2 * s * u_think * 0.9;
    alpha = max(alpha, s * u_think * 0.8);
  }

  // ---- listening: soft ripples flowing inward toward the face
  float rr = length(q / vec2(0.64, 0.76));
  float ph = fract(rr * 1.8 + t * 0.45);
  float ring = exp(-pow((ph - 0.5) * 22.0, 2.0)) * smoothstep(1.08, 1.3, rr) * smoothstep(1.9, 1.35, rr);
  col += u_c2 * ring * u_listen * (0.10 + 0.25 * u_energy);
  alpha = max(alpha, ring * u_listen * 0.08);

  // ---- film grain, premultiplied output (glows act like light)
  col += (hash(gl_FragCoord.xy + fract(t) * 91.0) - 0.5) * 0.025 * alpha;
  float lum = max(col.r, max(col.g, col.b));
  o = vec4(col, clamp(max(alpha, lum), 0.0, 1.0));
}`;

// ---------------------------------------------------------------- colour
const hsl = (h, s, l) => {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
};
/** [deep, body, rim, eyes] per state; `h` = hue of the current scene colour */
export const FACE_PALETTES = {
  idle: (h) => [hsl(h, 0.45, 0.08), hsl(h + 20, 0.55, 0.45), hsl(h + 45, 0.8, 0.72), hsl(h + 30, 0.6, 0.94)],
  listening: () => [hsl(18, 0.55, 0.09), hsl(26, 0.7, 0.44), hsl(38, 0.95, 0.64), hsl(42, 1, 0.9)],
  thinking: () => [hsl(255, 0.5, 0.09), hsl(258, 0.6, 0.5), hsl(195, 0.95, 0.68), hsl(220, 1, 0.94)],
  speaking: (h) => [hsl(h, 0.5, 0.09), hsl(205, 0.65, 0.52), hsl(285, 0.85, 0.76), hsl(0, 0, 1)],
};

// ---------------------------------------------------------------- motion
export class Spring {
  // Critically damped smoothing in closed form (as in Unity's SmoothDamp): stable for ANY
  // frame time, so a dropped frame or a slow GPU never makes a feature explode.
  constructor(v = 0, speed = 8) { this.v = v; this.vel = 0; this.target = v; this.speed = speed; }
  kick(dv) { this.vel += dv; }
  step(dt) {
    const w = this.speed, x = w * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const change = this.v - this.target;
    const temp = (this.vel + w * change) * dt;
    this.vel = (this.vel - w * temp) * decay;
    this.v = this.target + (change + temp) * decay;
    if (!Number.isFinite(this.v) || !Number.isFinite(this.vel)) { this.v = this.target; this.vel = 0; }
    return this.v;
  }
}
const rand = (a, b) => a + Math.random() * (b - a);

const STATE = {
  //           lid   smile brow  think listen gazeX gazeY tilt   lean
  idle:      [0.18, 0.28, 0.10, 0,    0,     0,    0,    0,     0],
  listening: [0.00, 0.16, 0.45, 0,    1,     0,    0.05, 0,     1],
  thinking:  [0.48, 0.00, 0.30, 1,    0,     0.62, 0.72, 0.07,  0],
  speaking:  [0.10, 0.34, 0.25, 0,    0,     0,    0.02, 0,     0],
};

export class Face {
  /**
   * @param {HTMLElement} container
   * @param {object} [o]
   * @param {boolean} [o.lite]          lower resolution
   * @param {string}  [o.frag]          alternative fragment shader (same uniforms), e.g. the PS1 robot
   * @param {number}  [o.pixelHeight]   render at this many pixels tall and upscale with hard pixels (retro)
   */
  constructor(container, { lite = false, frag = FRAG, pixelHeight = 0 } = {}) {
    this.el = container;
    const c = this.canvas = document.createElement('canvas');
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;' + (pixelHeight ? 'image-rendering:pixelated;' : '');
    this.pixelHeight = pixelHeight;
    container.append(c);
    const gl = this.gl = c.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 unavailable');
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = this.prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['res', 'time', 'gaze', 'blink', 'lid', 'smile', 'brow', 'open', 'wide', 'breath', 'energy', 'think', 'listen', 'tilt', 'nod', 'lean', 'alert', 'c0', 'c1', 'c2', 'c3', 'bands', 'mic', 'sway'])
      this.u[n] = gl.getUniformLocation(prog, `u_${n}`);
    this.scale = lite ? 0.6 : Math.min(2, devicePixelRatio || 1);

    // animated parameters
    this.s = {
      lid: new Spring(0.18, 7), smile: new Spring(0.28, 4), brow: new Spring(0.1, 5), think: new Spring(0, 3), listen: new Spring(0, 4),
      gx: new Spring(0, 14), gy: new Spring(0, 14), tilt: new Spring(0, 3), lean: new Spring(0, 3), nod: new Spring(0, 9),
      open: new Spring(0, 28), wide: new Spring(0.3, 18), energy: new Spring(0, 12), alert: new Spring(0, 6),
      sway: new Spring(0, 5),                       // antenna: lags behind head motion, wobbles on nods
      b0: new Spring(0, 30), b1: new Spring(0, 30), b2: new Spring(0, 30), mic: new Spring(0, 14),
    };
    this.state = 'idle';
    this.blink = 0; this.nextBlink = performance.now() + 1500; this.blinkPhase = -1; this.doubleBlink = false;
    this.nextSaccade = 0; this.jitter = [0, 0];
    this.look = null;          // {x, y, until}: external gaze target (panel, mouse)
    this.mic = 0; this.out = 0; this.bands = [0, 0, 0];
    this.talkStart = 0; this.lastNod = 0; this.smileBoost = 0;
    this.colors = [[0.05, 0.06, 0.12], [0.35, 0.45, 0.85], [0.55, 0.75, 1.0], [0.85, 0.95, 1.0]];
    this.t0 = performance.now(); this.last = this.t0;
  }

  setState(st) {
    const prev = this.state;
    this.state = STATE[st] ? st : 'idle';
    if (prev === 'speaking' && st === 'listening') { this.s.alert.kick(4); this.s.open.target = 0; } // interrupted: attentive
    if (prev === 'thinking' && st === 'speaking') this.s.brow.kick(1.5);                           // "aha"
  }
  setLevels(mic = 0, out = 0, bands) { this.mic = mic; this.out = out; if (bands) this.bands = bands; }
  setColors(c4) { this.colors = c4; }                         // [[r,g,b] x4] 0..1
  lookAt(x, y, ms = 1500) { this.look = { x, y, until: performance.now() + ms }; }
  nod(strength = 1) { const now = performance.now(); if (now - this.lastNod < 900) return; this.lastNod = now; this.s.nod.kick(-5 * strength); this.s.sway.kick(3 * strength); }
  delight(ms = 1400) { this.smileBoost = performance.now() + ms; }   // e.g. a finished task

  #behave(now, dt) {
    const s = this.s, cfg = STATE[this.state];
    const [lid, smile, brow, think, listen, gx, gy, tilt, lean] = cfg;
    // levels -> features
    const [lo, mid, hi] = this.bands;
    const voice = this.state === 'speaking' ? this.out : 0;
    s.energy.target = Math.max(voice, this.state === 'listening' ? this.mic * 0.6 : 0);
    s.open.target = this.state === 'speaking' ? Math.min(1, (lo * 0.9 + mid * 1.2) * 1.4 + voice * 0.5) : 0;
    s.wide.target = this.state === 'speaking' ? Math.min(1, hi / (lo + mid + hi + 0.05) * 2.2) : 0.3;

    s.lid.target = lid - (this.state === 'listening' ? this.mic * 0.2 : 0);
    s.smile.target = (now < this.smileBoost ? 0.85 : smile) + (this.state === 'speaking' ? Math.sin(now / 1700) * 0.08 : 0);
    s.brow.target = brow + (this.state === 'listening' ? this.mic * 0.5 : 0) + (this.state === 'speaking' ? voice * 0.35 : 0);
    s.think.target = think; s.listen.target = listen; s.tilt.target = tilt + (this.state === 'idle' ? Math.sin(now / 5300) * 0.03 : 0);
    s.lean.target = lean * (0.4 + this.mic);
    s.alert.target = 0;
    s.sway.target = -(s.gx.v * 0.6) - s.tilt.v * 2;       // antenna trails the head's turn
    s.b0.target = this.state === 'speaking' ? lo : 0; s.b1.target = this.state === 'speaking' ? mid : 0; s.b2.target = this.state === 'speaking' ? hi : 0;
    s.mic.target = this.mic;

    // backchannel nods: while you talk, nod softly when your voice dips after a phrase
    if (this.state === 'listening') {
      if (this.mic > 0.12) this.talkStart ||= now;
      else if (this.talkStart && now - this.talkStart > 900) { this.nod(0.6); this.talkStart = 0; }
    } else this.talkStart = 0;

    // gaze: base target per state, overridden by look(), plus saccadic jitter
    let tx = gx, ty = gy;
    if (this.look && now < this.look.until) { tx = this.look.x; ty = this.look.y; }
    if (now > this.nextSaccade) {
      const calm = this.state === 'listening' ? 0.08 : this.state === 'thinking' ? 0.35 : 0.22;
      this.jitter = [rand(-calm, calm), rand(-calm * 0.6, calm * 0.6)];
      this.nextSaccade = now + rand(this.state === 'listening' ? 900 : 500, this.state === 'thinking' ? 1400 : 2600);
    }
    s.gx.target = Math.max(-1, Math.min(1, tx + this.jitter[0]));
    s.gy.target = Math.max(-1, Math.min(1, ty + this.jitter[1]));

    // blinks: ~every 2.5–6 s, sometimes double; rarer while thinking; quick close, slower open
    if (this.blinkPhase < 0 && now > this.nextBlink) { this.blinkPhase = 0; this.doubleBlink = Math.random() < 0.18; }
    if (this.blinkPhase >= 0) {
      this.blinkPhase += dt * 1000;
      const p = this.blinkPhase;
      this.blink = p < 70 ? p / 70 : p < 190 ? 1 - (p - 70) / 120 : 0;
      if (p >= 190) {
        this.blinkPhase = -1;
        this.nextBlink = now + (this.doubleBlink ? 140 : rand(this.state === 'thinking' ? 4000 : 2500, this.state === 'thinking' ? 8000 : 6000));
        this.doubleBlink = false;
      }
    }
  }

  frame(now = performance.now()) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    this.#behave(now, dt);
    for (const sp of Object.values(this.s)) sp.step(dt);
    const { gl, u, s, canvas } = this;
    const k = this.pixelHeight ? this.pixelHeight / Math.max(1, canvas.clientHeight) : this.scale;
    const w = Math.max(8, Math.round(canvas.clientWidth * k)), h = Math.max(8, Math.round(canvas.clientHeight * k));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    const t = (now - this.t0) / 1000;
    gl.uniform2f(u.res, w, h); gl.uniform1f(u.time, t);
    gl.uniform2f(u.gaze, s.gx.v, s.gy.v);
    gl.uniform1f(u.blink, this.blink); gl.uniform1f(u.lid, Math.max(0, s.lid.v));
    gl.uniform1f(u.smile, Math.max(0, s.smile.v)); gl.uniform1f(u.brow, s.brow.v);
    gl.uniform1f(u.open, Math.max(0, s.open.v)); gl.uniform1f(u.wide, Math.max(0, s.wide.v));
    gl.uniform1f(u.breath, Math.sin(t * 1.05)); gl.uniform1f(u.energy, Math.max(0, s.energy.v));
    gl.uniform1f(u.think, Math.max(0, s.think.v)); gl.uniform1f(u.listen, Math.max(0, s.listen.v));
    gl.uniform1f(u.tilt, s.tilt.v); gl.uniform1f(u.nod, s.nod.v); gl.uniform1f(u.lean, Math.max(0, s.lean.v));
    gl.uniform1f(u.alert, Math.max(0, s.alert.v));
    if (u.bands) gl.uniform3f(u.bands, Math.max(0, s.b0.v), Math.max(0, s.b1.v), Math.max(0, s.b2.v));
    if (u.mic) gl.uniform1f(u.mic, Math.max(0, s.mic.v));
    if (u.sway) gl.uniform1f(u.sway, s.sway.v);
    this.colors.forEach((c, i) => gl.uniform3f(u[`c${i}`], c[0], c[1], c[2]));
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
