// "Vo": Vocalo as a PS1-era human character, like a dialogue portrait from a late-90s RPG.
//
// Geometry is raymarched (skull + jaw + nose + ears + neck + shoulders, bob haircut with
// bangs) and rendered at ~200 px with hard-pixel upscale, 15-bit colour, ordered dither and
// snapped head rotation (that slight PS1 vertex wobble). The face is *painted on* like a
// low-res texture: big friendly eyes with moving irises and blinking lids, brows, lips that
// open with the voice (teeth, tongue), blush. Warm light, warm skin, no dark eye sockets:
// friendly, not uncanny. Same behaviour engine as the other avatars (face.js).
import { Face } from './face.js';

export const HUMAN_FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_gaze;
uniform float u_blink, u_lid, u_smile, u_brow, u_open, u_wide, u_breath, u_energy, u_think, u_listen, u_tilt, u_nod, u_lean, u_alert, u_mic, u_sway;
uniform vec3 u_bands;
uniform vec3 u_c0, u_c1, u_c2, u_c3;   // hair, skin, sweater (state colour), rim light
out vec4 o;

mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdEll(vec3 p, vec3 r){ float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / k1; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){ vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float sdRoundBox(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float ell2(vec2 p, vec2 r){ return (length(p / r) - 1.0) * min(r.x, r.y); }

mat3 R; vec3 HP;

float bangs(float x){ return 0.27 + 0.022 * sin(x * 21.0) - 0.22 * x * x + 0.03 * smoothstep(0.0, 0.06, -x); } // side part

// (distance, material) 1 skin, 2 hair, 3 sweater
vec2 map(vec3 pw){
  // head space
  vec3 p = R * (pw - HP);
  float head = sdEll(p - vec3(0.0, 0.08, 0.0), vec3(0.43, 0.53, 0.48));
  head = smin(head, sdEll(p - vec3(0.0, -0.2, 0.07), vec3(0.32, 0.3, 0.36)), 0.16);     // jaw + chin
  head = smin(head, sdEll(p - vec3(0.0, -0.045, 0.455), vec3(0.036, 0.065, 0.05)), 0.04);  // small nose
  head = smin(head, sdEll(vec3(abs(p.x) - 0.43, p.y + 0.01, p.z - 0.01), vec3(0.05, 0.1, 0.05)), 0.03); // ears
  // neck lives in body space (so a head tilt doesn't bend it out of the collar), blended into the head
  float neck = sdCapsule(pw, HP + transpose(R) * vec3(0.0, -0.3, -0.06), vec3(0.0, -0.72, -0.1), 0.15);
  head = smin(head, neck, 0.08);
  vec2 res = vec2(head, 1.0);

  // hair: cap + bob, front cut out along the bangs, ends at the jaw
  vec3 hp = p;
  hp.x += 0.012 * u_sway * smoothstep(0.0, -0.4, p.y);              // ends sway a little
  float hair = sdEll(hp - vec3(0.0, 0.13, -0.05), vec3(0.5, 0.6, 0.56));
  hair = smin(hair, sdEll(hp - vec3(0.0, -0.08, -0.08), vec3(0.52, 0.42, 0.5)), 0.1);
  float face = max(max(0.0 - p.z, p.y - bangs(p.x)), abs(p.x) - 0.37);   // the face window
  hair = max(hair, -face);
  hair = max(hair, -(p.y + 0.33 + 0.04 * sin(p.x * 9.0)));              // bob length, uneven ends
  if (hair < res.x) res = vec2(hair, 2.0);

  // shoulders / sweater (world-ish space: only follows the head a little)
  vec3 q = pw - vec3(0.0, -1.0 + HP.y * 0.3, -0.12);
  float shoulders = sdEll(q, vec3(0.86, 0.3, 0.36));
  float chest = sdRoundBox(q - vec3(0.0, -0.6, 0.0), vec3(0.74, 0.62, 0.34), 0.3);  // runs out of frame
  float body = smin(shoulders, chest, 0.25);
  body = smin(body, sdCapsule(pw, vec3(0.0, -0.66 + HP.y * 0.5, -0.1), vec3(0.0, -0.85, -0.1), 0.19), 0.1); // turtleneck
  if (body < res.x) res = vec2(body, 3.0);
  return res;
}
vec3 normal(vec3 p){ vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(map(p + e.xyy).x - map(p - e.xyy).x, map(p + e.yxy).x - map(p - e.yxy).x, map(p + e.yyx).x - map(p - e.yyx).x)); }

// the painted face texture (head-local front projection)
vec3 paintFace(vec3 p, vec3 skin){
  vec3 col = skin;
  vec2 f = p.xy;
  // blush
  float blush = exp(-pow(length(vec2(abs(f.x) - 0.2, f.y + 0.1) * vec2(1.0, 1.6)) * 8.0, 2.0));
  col = mix(col, vec3(0.96, 0.52, 0.55), blush * (0.32 + 0.35 * u_smile));

  // eyes
  float open = (1.0 - u_blink) * mix(1.0, 0.45, u_lid * 0.3) * (1.0 + 0.15 * u_alert);
  for (int i = 0; i < 2; i++){
    float sx = i == 0 ? -1.0 : 1.0;
    vec2 e = f - vec2(sx * 0.158, 0.04);
    vec2 er = vec2(0.082, 0.058);
    float shape = ell2(vec2(e.x, e.y * (e.y > 0.0 ? 1.0 : 1.25)), er);   // almond-ish
    float lidY = er.y * (2.0 * open - 1.0);                               // upper lid comes down to blink
    float lower = -er.y * (1.0 - 0.35 * smoothstep(0.45, 0.9, u_smile));  // a real (big) smile lifts the lower lid
    float inEye = step(shape, 0.0) * step(e.y, lidY) * step(lower, e.y);
    vec2 ir = e - u_gaze * vec2(0.032, 0.016) - vec2(0.0, -0.004);
    float iris = length(ir);
    vec3 eye = vec3(0.97, 0.96, 0.95);                                    // sclera
    eye = mix(eye, vec3(0.42, 0.26, 0.14), step(iris, 0.043));            // warm brown iris
    eye = mix(eye, vec3(0.62, 0.42, 0.22), step(iris, 0.043) * smoothstep(0.036, 0.0, iris) * 0.5);
    eye = mix(eye, vec3(0.06, 0.04, 0.04), step(iris, 0.019));            // pupil
    eye = mix(eye, vec3(1.0), step(length(ir - vec2(-0.014, 0.015)), 0.011)); // catchlight
    col = mix(col, eye, inEye);
    // lash line on the upper lid (also where the lid is when blinking)
    float lash = step(abs(e.y - min(lidY, er.y * sqrt(max(0.0, 1.0 - pow(e.x / er.x, 2.0))))), 0.009) * step(abs(e.x), er.x * 1.05);
    lash *= step(-0.004, e.y - lower);
    col = mix(col, vec3(0.16, 0.09, 0.07), lash * 0.95);
    // brows
    vec2 b = e - vec2(0.006 * sx, 0.098 + 0.025 * u_brow + 0.012 * u_think);
    float browC = b.y + 2.4 * b.x * b.x + sx * b.x * 0.06;
    float thick = 0.0075 * smoothstep(0.08, 0.0, sx * b.x + 0.03);           // tapers toward the outer end
    float brow = step(abs(browC), thick + 0.002) * step(abs(b.x), 0.072);
    col = mix(col, u_c0 * 0.9, brow);
  }

  // nose shading (a tiny painted shadow under the tip, very PS1)
  col *= 1.0 - 0.08 * exp(-pow(length((f - vec2(0.01, -0.105)) * vec2(1.8, 3.2)) * 13.0, 2.0));

  // mouth
  vec2 m = f - vec2(0.0, -0.225 - 0.015 * u_open);
  float mw = 0.075 + 0.025 * u_wide + 0.018 * u_smile;
  float mo = 0.004 + 0.05 * u_open;
  float curve = u_smile * 0.045 * (m.x * m.x) / (mw * mw) - 0.01 * u_smile;
  vec2 mm = vec2(m.x, m.y - curve);
  float inner = ell2(mm, vec2(mw, mo));
  float lips = ell2(mm, vec2(mw + 0.012, mo + 0.016));
  vec3 lip = vec3(0.82, 0.42, 0.45);
  col = mix(col, lip, step(lips, 0.0) * smoothstep(0.0, 0.25, u_open + 0.25));
  if (inner < 0.0 && u_open > 0.05) {
    vec3 mouth = vec3(0.33, 0.1, 0.12);
    mouth = mix(mouth, vec3(0.95, 0.93, 0.9), step(mo * 0.55, mm.y));             // top teeth
    mouth = mix(mouth, vec3(0.75, 0.33, 0.36), step(mm.y, -mo * 0.45) * step(0.025, u_open)); // tongue
    col = mouth;
  } else {
    // closed: a soft smile line
    col = mix(col, vec3(0.55, 0.22, 0.24), step(abs(mm.y), 0.006) * step(abs(m.x), mw) * (1.0 - smoothstep(0.03, 0.08, u_open)));
  }
  return col;
}

float bayer4(vec2 p){ ivec2 i = ivec2(mod(p, 4.0)); int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5); return float(m[i.y * 4 + i.x]) / 16.0 - 0.5; }

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;
  // PS1 wobble: rotation snapped to coarse steps
  float st = 0.012;
  float yaw = floor((u_gaze.x * 0.32) / st + 0.5) * st;
  float pitch = floor((-u_gaze.y * 0.18 + u_nod * 0.3 - 0.03) / st + 0.5) * st;
  float roll = floor((-u_tilt * 0.8) / st + 0.5) * st;
  R = rotZ(roll) * rotX(pitch) * rotY(yaw);
  HP = vec3(0.0, 0.12 + 0.012 * u_breath - 0.04 * u_nod, 0.1 * u_lean);

  vec3 ro = vec3(0.0, -0.12, 3.75);
  vec3 rd = normalize(vec3(uv * 1.05, -1.6));
  float d = 0.0; vec2 h = vec2(0.0);
  for (int i = 0; i < 90; i++){ h = map(ro + rd * d); if (h.x < 0.0015 || d > 6.0) break; d += h.x * 0.9; }

  vec3 col = vec3(0.0); float alpha = 0.0;
  vec3 L = normalize(vec3(-0.45, 0.6, 0.8));
  if (d < 6.0){
    vec3 p = ro + rd * d, n = normal(p);
    vec3 pl = R * (p - HP), nl = R * n;
    float diff = max(dot(n, L), 0.0);
    float amb = 0.55 + 0.2 * n.y;                       // generous ambient: no spooky shadows
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
    float spec = pow(max(dot(reflect(rd, n), L), 0.0), 20.0);
    if (h.y < 1.5) {
      vec3 skin = u_c1;
      if (nl.z > 0.15 && pl.y > -0.36 && pl.y < bangs(pl.x) + 0.02) skin = paintFace(pl, skin);
      col = skin * (amb + 0.6 * diff) + u_c3 * rim * 0.25 + vec3(1.0) * spec * 0.08;
    } else if (h.y < 2.5) {
      // hair: painted sheen band (anisotropic highlight, PS1-texture style)
      float band = smoothstep(0.05, 0.0, abs(pl.y - 0.42 - 0.07 * cos(pl.x * 4.0))) * smoothstep(-0.1, 0.25, pl.z) * 0.6;
      float strands = 0.88 + 0.12 * sin(pl.x * 70.0 + pl.y * 8.0);
      col = u_c0 * strands * (amb + 0.55 * diff) + mix(u_c0, vec3(1.0), 0.5) * band * 0.25 + u_c3 * rim * 0.2;
    } else {
      float knit = 0.9 + 0.1 * step(0.5, fract(p.x * 18.0 + floor(p.y * 14.0) * 0.5));
      col = u_c2 * knit * (amb + 0.55 * diff) + u_c3 * rim * 0.15;
    }
    alpha = 1.0;
  } else {
    float tf = (-1.6 - ro.y) / rd.y;   // soft floor shadow (portrait framing usually hides it)
    if (tf > 0.0) { vec3 fp = ro + rd * tf; float sh = smoothstep(1.0, 0.3, length(fp.xz * vec2(1.0, 1.6))); alpha = sh * 0.2; col = vec3(0.05, 0.04, 0.1) * alpha; }
  }
  col = clamp(col, 0.0, 1.0);
  col = floor(col * 31.0 + 0.5 + bayer4(gl_FragCoord.xy) * 0.9) / 31.0;   // 15-bit + ordered dither
  o = vec4(col * (alpha > 0.0 ? 1.0 : 0.0), alpha);
}`;

const hsl = (h, s, l) => {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
};
const HAIR = hsl(18, 0.42, 0.24), SKIN = hsl(24, 0.52, 0.74);
/** [hair, skin, sweater (state colour), rim light] */
export const HUMAN_PALETTES = {
  idle: () => [HAIR, SKIN, hsl(175, 0.45, 0.52), hsl(190, 0.6, 0.8)],
  listening: () => [HAIR, SKIN, hsl(35, 0.75, 0.6), hsl(40, 1, 0.75)],
  thinking: () => [HAIR, SKIN, hsl(262, 0.45, 0.6), hsl(270, 0.8, 0.8)],
  speaking: () => [HAIR, SKIN, hsl(200, 0.6, 0.56), hsl(195, 0.9, 0.8)],
};

export function createHuman(container, { lite = false } = {}) {
  return new Face(container, { lite, frag: HUMAN_FRAG, pixelHeight: lite ? 180 : 240 });
}
