// "Voxi": Vocalo's friendly PS1-era robot.
//
// A real 3D head (raymarched rounded boxes) rendered at ~200 px and upscaled with hard
// pixels, then quantised to 15-bit colour with 4x4 ordered dithering, the way the
// PlayStation did it. Expressions live on an LED visor:
//   eyes     rounded LED blocks that blink, look around, and turn into ^ ^ when happy
//   mouth    a smile when idle, an equaliser that dances with the voice when speaking,
//            "…" loading dots while thinking, an open "o" when listening hard
//   cheeks   pink LEDs when smiling;  antenna ball glows in the state colour and wobbles
//   ears     ring lights pulse with your voice while it listens
// Same behaviour engine as the face (blinks, saccades, nods, springs): see face.js.
import { Face } from './face.js';

export const BOT_FRAG = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_gaze;
uniform float u_blink, u_lid, u_smile, u_brow, u_open, u_wide, u_breath, u_energy, u_think, u_listen, u_tilt, u_nod, u_lean, u_alert, u_mic, u_sway;
uniform vec3 u_bands;
uniform vec3 u_c0, u_c1, u_c2, u_c3;   // visor, shell, accent glow, LED
out vec4 o;

mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
mat3 rotZ(float a){ float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
float sdRoundBox(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r){ vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float sdCylX(vec3 p, float r, float h){ vec2 d = abs(vec2(length(p.yz), p.x)) - vec2(r, h); return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)); }
float sdBox2(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }

mat3 R; vec3 HP;   // head rotation + position
vec3 ANT;          // antenna tip (local)

// returns (distance, material): 1 shell, 2 visor, 3 ear, 4 antenna ball, 5 antenna stick
vec2 map(vec3 pw){
  vec3 p = R * (pw - HP);
  vec2 res = vec2(sdRoundBox(p, vec3(0.66, 0.52, 0.5), 0.24), 1.0);
  float vis = sdRoundBox(p - vec3(0.0, -0.03, 0.42), vec3(0.5, 0.34, 0.1), 0.13);
  if (vis < res.x) res = vec2(vis, 2.0);
  float ear = sdCylX(vec3(abs(p.x) - 0.7, p.y + 0.02, p.z), 0.17, 0.06);
  if (ear < res.x) res = vec2(ear, 3.0);
  float stick = sdCapsule(p, vec3(0.0, 0.5, 0.0), ANT, 0.028);
  if (stick < res.x) res = vec2(stick, 5.0);
  float ball = length(p - ANT) - 0.085;
  if (ball < res.x) res = vec2(ball, 4.0);
  return res;
}
vec3 normal(vec3 p){ vec2 e = vec2(0.002, 0.0);
  return normalize(vec3(map(p + e.xyy).x - map(p - e.xyy).x, map(p + e.yxy).x - map(p - e.yxy).x, map(p + e.yyx).x - map(p - e.yyx).x)); }

// LED pattern on the visor (2D, visor-local coordinates), returns intensity and colour
vec4 leds(vec2 uv){
  float I = 0.0; vec3 col = u_c3;
  vec2 g = u_gaze * vec2(0.07, 0.045);
  float open = (1.0 - u_blink) * mix(1.0, 0.35, u_lid) * (1.0 + 0.2 * u_alert + 0.15 * u_listen);
  float happy = smoothstep(0.45, 0.75, u_smile);
  for (int i = 0; i < 2; i++){
    float sx = i == 0 ? -1.0 : 1.0;
    vec2 e = uv - vec2(sx * 0.2, 0.07) - g;
    float block = sdBox2(e, vec2(0.062, max(0.075 * open, 0.008)), 0.03);
    float arc = max(abs(length(e - vec2(0.0, -0.045)) - 0.07) - 0.022, -(e.y + 0.0));   // ^ shape
    float d = mix(block, arc, happy);
    I = max(I, smoothstep(0.008, -0.004, d));
    // tiny highlight pixel (cuteness)
    float hl = sdBox2(e - vec2(-0.025, 0.03 * open), vec2(0.014, 0.014 * open), 0.006);
    I -= smoothstep(0.004, -0.004, hl) * 0.55 * (1.0 - happy) * step(0.3, open);
  }
  // brows: little LED dashes when interested
  for (int i = 0; i < 2; i++){
    float sx = i == 0 ? -1.0 : 1.0;
    // thinking: one brow up, slightly tilted (curious, not worried)
    vec2 b = uv - vec2(sx * 0.2, 0.2 + 0.03 * u_brow + (sx > 0.0 ? 0.035 : -0.005) * u_think) - g * 0.5;
    b.y -= sx * b.x * (0.35 * u_think) * (sx > 0.0 ? 1.0 : -0.4);
    float d = sdBox2(b, vec2(0.05, 0.008), 0.008);
    I = max(I, smoothstep(0.006, -0.004, d) * smoothstep(0.15, 0.4, u_brow + u_think * 0.3));
  }
  // mouth
  vec2 m = uv - vec2(0.0, -0.17);
  float speak = smoothstep(0.02, 0.1, u_energy + u_open);
  // idle/listening smile
  float sm = abs(m.y - 4.2 * u_smile * m.x * m.x + 0.012 * u_smile) - 0.013;
  sm = max(sm, abs(m.x) - 0.085 - 0.03 * u_smile);
  float smileI = smoothstep(0.006, -0.004, sm) * (1.0 - speak) * (1.0 - u_think) * (1.0 - smoothstep(0.08, 0.2, u_mic) * u_listen);
  // listening hard: small round "o"
  float oo = abs(length(m / vec2(1.0, 1.25)) - 0.03 - 0.025 * u_mic) - 0.012;
  float ooI = smoothstep(0.006, -0.004, oo) * smoothstep(0.08, 0.2, u_mic) * u_listen;
  I = max(I, max(smileI, ooI));
  // speaking: equaliser bars driven by the voice bands
  float bars = 0.0;
  for (int k = 0; k < 7; k++){
    float fk = float(k) - 3.0;
    float w = abs(fk) / 3.0;
    float lvl = mix(mix(u_bands.x, u_bands.y, smoothstep(0.0, 0.6, w)), u_bands.z, smoothstep(0.5, 1.0, w));
    float h = 0.012 + (0.5 * lvl + 0.35 * u_open) * (0.075 - 0.025 * w) * (0.85 + 0.3 * sin(u_time * 17.0 + fk * 1.7));
    float d = sdBox2(m - vec2(fk * 0.034, 0.0), vec2(0.011, h), 0.006);
    bars = max(bars, smoothstep(0.004, -0.004, d));
  }
  I = max(I, bars * speak);
  // thinking: … dots, lighting up in turn
  for (int k = 0; k < 3; k++){
    float fk = float(k);
    float on = 0.35 + 0.65 * smoothstep(0.4, 1.0, sin(u_time * 5.0 - fk * 1.1));
    float d = length(m - vec2((fk - 1.0) * 0.06, 0.0)) - 0.016;
    I = max(I, smoothstep(0.006, -0.004, d) * on * u_think * (1.0 - speak));
  }
  // cheeks
  float ck = 0.0;
  for (int i = 0; i < 2; i++){
    float sx = i == 0 ? -1.0 : 1.0;
    ck = max(ck, smoothstep(0.006, -0.004, sdBox2(uv - vec2(sx * 0.36, -0.07), vec2(0.045, 0.02), 0.02)));
  }
  float cheekI = ck * smoothstep(0.15, 0.5, u_smile);
  if (cheekI > I) col = vec3(1.0, 0.45, 0.62);
  I = max(I, cheekI * 0.85);
  return vec4(col, clamp(I, 0.0, 1.0));
}

float bayer4(vec2 p){ ivec2 i = ivec2(mod(p, 4.0)); int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5); return float(m[i.y * 4 + i.x]) / 16.0 - 0.5; }

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time;
  // head pose from the behaviour engine
  float bob = 0.025 * u_breath + 0.02 * sin(t * 2.1) * u_energy;
  R = rotZ(-u_tilt * 1.6) * rotX(-u_gaze.y * 0.22 + u_nod * 0.35 - 0.06) * rotY(u_gaze.x * 0.38);
  HP = vec3(0.0, 0.05 + bob - 0.06 * u_nod, 0.15 * u_lean);
  ANT = vec3(0.12 * u_sway + 0.04 * sin(t * 1.3), 0.86, -0.05 * u_sway);

  vec3 ro = vec3(0.0, 0.18, 3.9);
  vec3 rd = normalize(vec3(uv * 0.95, -1.6));
  float d = 0.0; vec2 h = vec2(0.0);
  for (int i = 0; i < 72; i++){ h = map(ro + rd * d); if (h.x < 0.0015 || d > 6.0) break; d += h.x; }

  vec3 col = vec3(0.0); float alpha = 0.0;
  vec3 L = normalize(vec3(-0.5, 0.75, 0.7));
  if (d < 6.0){
    vec3 p = ro + rd * d, n = normal(p);
    vec3 pl = R * (p - HP);
    float diff = max(dot(n, L), 0.0), amb = 0.45 + 0.25 * n.y;
    float spec = pow(max(dot(reflect(rd, n), L), 0.0), 24.0);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    float mat = h.y;
    if (mat < 1.5) {                       // shell: cream plastic with a soft accent band
      vec3 base = u_c1;
      base = mix(base, u_c2 * 0.9 + 0.1, smoothstep(0.02, 0.0, abs(pl.y + 0.47) - 0.04) * 0.8); // chin stripe
      col = base * (amb + 0.75 * diff) + vec3(1.0) * spec * 0.35 + u_c2 * rim * 0.25;
    } else if (mat < 2.5) {                // visor: dark glossy screen with LEDs
      vec2 v = pl.xy - vec2(0.0, -0.03);
      vec4 led = leds(v);
      float scan = 0.85 + 0.15 * step(0.5, fract(gl_FragCoord.y * 0.5));
      col = u_c0 * (0.6 + 0.4 * diff) + vec3(1.0) * spec * 0.6;
      col += led.rgb * led.a * 1.25 * scan;
      // glow spill inside the visor
      col += led.rgb * 0.12 * smoothstep(0.35, 0.0, length(v * vec2(0.8, 1.2)));
    } else if (mat < 3.5) {                // ears: ring lights pulse with your voice
      float ring = smoothstep(0.03, 0.0, abs(length(pl.yz - vec2(-0.02, 0.0)) - 0.11));
      col = u_c1 * 0.75 * (amb + 0.6 * diff) + vec3(1.0) * spec * 0.3;
      col += u_c2 * ring * (0.45 + 1.2 * u_mic * u_listen + 0.35 * u_energy + 0.3 * u_think * (0.5 + 0.5 * sin(t * 6.0)));
    } else if (mat < 4.5) {                // antenna ball: state light
      col = u_c2 * (1.1 + 0.4 * sin(t * (u_think > 0.5 ? 7.0 : 2.0))) + vec3(1.0) * spec;
    } else {                               // antenna stick
      col = u_c1 * 0.6 * (amb + diff);
    }
    alpha = 1.0;
  } else {
    // PS1 blob shadow on an invisible floor
    float tf = (-0.95 - ro.y) / rd.y;
    if (tf > 0.0) {
      vec3 fp = ro + rd * tf;
      float sh = smoothstep(0.85, 0.2, length((fp.xz - HP.xz) * vec2(1.0, 1.6)));
      alpha = sh * 0.28; col = vec3(0.05, 0.04, 0.12) * alpha;
    }
    // soft glow of the antenna light into the air
    vec3 aw = HP + transpose(R) * ANT;
    float gd = length(cross(rd, aw - ro));
    float glow = exp(-gd * 16.0) * 0.5;
    col += u_c2 * glow; alpha = max(alpha, glow);
  }
  // 15-bit colour with 4x4 ordered dither: the PlayStation look
  col = clamp(col, 0.0, 1.0);
  col = floor(col * 31.0 + 0.5 + bayer4(gl_FragCoord.xy) * 0.9) / 31.0;
  o = vec4(col * (alpha > 0.0 ? 1.0 : 0.0), alpha);
}`;

const hsl = (h, s, l) => {
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
};
/** [visor, shell, accent light, LED] per state */
export const BOT_PALETTES = {
  idle: () => [hsl(225, 0.35, 0.12), hsl(40, 0.45, 0.9), hsl(175, 0.75, 0.55), hsl(170, 0.9, 0.62)],
  listening: () => [hsl(225, 0.35, 0.12), hsl(40, 0.45, 0.9), hsl(35, 1, 0.58), hsl(42, 1, 0.62)],
  thinking: () => [hsl(245, 0.35, 0.13), hsl(40, 0.4, 0.88), hsl(270, 0.8, 0.66), hsl(265, 0.9, 0.72)],
  speaking: () => [hsl(225, 0.35, 0.12), hsl(40, 0.45, 0.92), hsl(195, 0.9, 0.58), hsl(185, 1, 0.65)],
};

export function createBot(container, { lite = false } = {}) {
  return new Face(container, { lite, frag: BOT_FRAG, pixelHeight: lite ? 170 : 220 });
}
