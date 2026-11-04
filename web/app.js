// Vocalo web stage. Renders the show from Vocalo's event stream (SSE) and sends
// commands back. Visuals: @paper-design/shaders (WebGL2), audio-reactive.
//   background  MeshGradient   palette from the scene colour, tinted by state
//   orb         SmokeRing      breathes with the mic (listening) / the voice (speaking)
//   border      PulsingBorder  "attention": recording (push-to-talk) or waiting for permission
import { Face, FACE_PALETTES } from './face.js';
import { createBot, BOT_PALETTES } from './bot.js';
import { createHuman, HUMAN_PALETTES } from './human.js';
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const S = {
  state: 'idle', mic: 0, out: 0, lvl: 0, aspect: localStorage.getItem('vocalo.aspect') || '16:9',
  base: '#1b2a4a', plan: [], panel: null, permission: null, ptt: false, pttDown: false, stats: false, bands: [0, 0, 0],
  avatar: null,
  // user's explicit choice (URL or V key) beats the server config; config beats the default
  avatarPref: new URLSearchParams(location.search).get('avatar') || localStorage.getItem('vocalo.avatar') || null,
  cfgAvatar: null, ready: false,
};
let face = null, bot = null, human = null;
const AVATARS = ['human', 'bot', 'face', 'orb'];
/** the avatar currently on stage (bot or face share one API) */
const avatar = () => ({ human, bot, face })[S.avatar] ?? null;

// ------------------------------------------------------------------ comms
const send = (cmd) => fetch('/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) }).catch(() => {});
const command = (line) => send({ type: 'command', line });

function connect() {
  const es = new EventSource('/events');
  es.onopen = async () => {
    $('#conn').classList.add('ok');
    try { const snap = await (await fetch('/state')).json(); for (const ev of Object.values(snap).sort((a, b) => a.t - b.t)) handle(ev, true); } catch {}
  };
  es.onerror = () => $('#conn').classList.remove('ok');
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (e) { console.error(e); } };
}

// ------------------------------------------------------------------ events
function handle(ev, replay = false) {
  switch (ev.type) {
    case 'level': S.mic = ev.mic ?? 0; S.out = ev.out ?? 0; if (ev.bands) S.bands = ev.bands; break;
    case 'turn_end': if (!replay && ev.stopReason === 'end_turn' && ev.tools) avatar()?.delight(); break;
    case 'state': setState(ev.state); break;
    case 'subtitle': if (!replay) subtitle(ev.text, ev.durationMs); else $('#sub-assistant').textContent = ev.text; break;
    case 'user_partial': userLine(ev.text, true); break;
    case 'user': userLine(ev.text, false); if (!replay) avatar()?.nod(1); break;
    case 'scene': scene(ev); break;
    case 'code': showPanel({ kind: 'code', title: firstLineTitle(ev.code), body: ev.code }); break;
    case 'diff': showPanel({ kind: 'diff', title: ev.path, rows: ev.rows }); break;
    case 'plan': S.plan = ev.entries || []; renderPlan(); break;
    case 'tool': tool(ev); break;
    case 'agent': agent(ev); break;
    case 'metrics': stats(ev); break;
    case 'permission': permission(ev.title ? ev : null); break;
    case 'permission_resolved': permission(null); break;
    case 'open_url': $('#openurl').hidden = !ev.pending; attention(); break;
    case 'overlay': overlay(ev); break;
    case 'notice': toast(ev.text); break;
    case 'ptt': S.ptt = !!ev.active; attention(); break;
    case 'steered': toast(`↪ ${ev.text}`); break;
    case 'profile': if (ev.name && !replay) toast(`profile: ${ev.name}`); break;
    case 'config':
      if (ev.theme) S.theme = ev.theme;
      if (ev.avatar) S.cfgAvatar = ev.avatar;
      if (S.ready && !S.avatarPref && ev.avatar) setAvatar(ev.avatar, false); else applyTheme();
      break;
    case 'connection': $('#caption').textContent = ev.caption ?? $('#caption').textContent; break;
  }
}

function setState(st) {
  S.state = st;
  face?.setState(st); bot?.setState(st); human?.setState(st);
  stage.dataset.state = st;
  $('#live').hidden = st !== 'speaking';
  $('#chip-state').textContent = { idle: 'ready', listening: '● listening', thinking: '◌ thinking', speaking: '◉ speaking' }[st] ?? st;
  if (st === 'idle') $('#tool').hidden = true;
}

// Subtitles: words fade in at speaking pace, synced to when the audio starts.
let revealTimer = null;
function subtitle(text, durationMs = 2000) {
  const el = $('#sub-assistant');
  clearInterval(revealTimer);
  const words = text.split(/\s+/).filter(Boolean);
  el.replaceChildren(...words.flatMap((w, i) => { const s = document.createElement('span'); s.className = 'w'; s.textContent = w; return i ? [document.createTextNode(' '), s] : [s]; }));
  const spans = [...el.querySelectorAll('.w')];
  const step = Math.max(40, (durationMs * 0.92) / Math.max(1, spans.length));
  let i = 0;
  spans[i++]?.classList.add('on');
  revealTimer = setInterval(() => { if (i >= spans.length) return clearInterval(revealTimer); spans[i++].classList.add('on'); }, step);
}
function userLine(text, partial) {
  const el = $('#sub-user');
  el.classList.toggle('partial', partial);
  el.classList.toggle('empty', !text);
  el.querySelector('.txt').textContent = text || '';
}

function scene(tag) {
  if (tag.kind === 'scene') {
    if (tag.bg) S.base = tag.bg;
    if (tag.title !== undefined) { $('#title').textContent = tag.title; lowerThird(tag.title); }
    if (tag.caption !== undefined) $('#caption').textContent = tag.caption;
    if (tag.image || tag.imageData) showPanel({ kind: 'image', title: tag.caption || tag.title || '', src: imgSrc(tag) });
  } else if (tag.kind === 'show') {
    if (tag.image || tag.imageData) showPanel({ kind: 'image', title: tag.caption || tag.image || '', src: imgSrc(tag) });
  } else if (tag.kind === 'clear') {
    hidePanel();
  }
}
const imgSrc = (t) => t.imageData ? `data:${t.mimeType || 'image/png'};base64,${t.imageData}` : t.image;
function lowerThird(text) {
  const lt = $('#lower-third');
  if (!text || text === 'Vocalo') { lt.hidden = true; return; }
  $('#lt-text').textContent = text;
  lt.hidden = false;
  clearTimeout(lowerThird.t);
  lowerThird.t = setTimeout(() => { lt.hidden = true; }, 12000); // TV lower thirds don't overstay
  lt.style.animation = 'none'; void lt.offsetWidth; lt.style.animation = '';
}

// ------------------------------------------------------------------ panel
function showPanel(p) {
  S.panel = p;
  $('#panel-title').textContent = p.title || '';
  const body = $('#panel-body');
  if (p.kind === 'image') {
    const img = new Image(); img.src = p.src; img.alt = p.title || '';
    body.replaceChildren(img);
  } else if (p.kind === 'code') {
    const pre = document.createElement('pre');
    pre.innerHTML = highlight(stripTitleLine(p.body));
    body.replaceChildren(pre);
  } else if (p.kind === 'diff') {
    const pre = document.createElement('pre'); pre.className = 'diff';
    pre.innerHTML = (p.rows || []).map(([op, l]) => `<span class="${{ '+': 'add', '-': 'del', '@': 'gap' }[op] ?? 'ctx'}">${op === '@' ? '  ⋯' : `${op} ${esc(l)}`}</span>`).join('');
    body.replaceChildren(pre);
  }
  $('#panel').hidden = false;
  stage.classList.add('has-panel');
  avatar()?.lookAt(-0.85, 0.75, 2600); // glance at what's being shown
}
function hidePanel() { S.panel = null; $('#panel').hidden = true; stage.classList.remove('has-panel'); }
$('#panel-close').onclick = hidePanel;

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function firstLineTitle(code) { const l = code.split('\n')[0]; return /^[\w./~-]+\.\w+$|^\$ /.test(l) ? l : 'on screen'; }
function stripTitleLine(code) { const [a, b, ...rest] = code.split('\n'); return /^─+$/.test(b ?? '') ? rest.join('\n') : code; }
function highlight(src) {
  // tiny language-agnostic highlighter, single pass over the RAW text (escape each token once)
  const RE = /(\/\/.*$|#(?!!).*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|\b(const|let|var|function|return|if|else|for|while|import|from|export|class|def|async|await|new|try|catch|true|false|null|None|self|this|fn|pub|use|struct|impl|of|in)\b/gm;
  const cls = ['tok-c', 'tok-s', 'tok-n', 'tok-k'];
  let out = '', last = 0;
  for (const m of src.matchAll(RE)) {
    out += esc(src.slice(last, m.index));
    const g = [1, 2, 3, 4].find((i) => m[i] !== undefined);
    out += `<span class="${cls[g - 1]}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}

// ------------------------------------------------------------------ plan / tools / agent
function renderPlan() {
  const show = S.plan.length > 0;
  $('#plan').hidden = !show;
  stage.classList.toggle('has-plan', show);
  $('#plan ol').replaceChildren(...S.plan.map((e) => { const li = document.createElement('li'); li.className = e.status; li.textContent = e.content; return li; }));
}
const toolTitles = new Map();
function tool(t) {
  if (t.title) toolTitles.set(t.id, t.title);
  const title = t.title ?? toolTitles.get(t.id);
  const el = $('#tool');
  if (!title || t.status === 'completed' || t.status === 'failed') { el.hidden = true; return; }
  el.textContent = title;
  el.hidden = false;
}
function chip(id, text) { const el = $(id); el.hidden = !text; if (text) el.textContent = text; }
function agent(a) {
  chip('#chip-where', a.where && a.where !== 'local' ? `⇄ ${a.where}` : '');
  chip('#chip-model', a.model);
  chip('#chip-mode', a.mode);
  chip('#chip-effort', a.effort ? `effort ${a.effort}` : '');
  const c = $('#chip-ctx');
  c.hidden = a.contextPct == null;
  if (a.contextPct != null) { c.querySelector('b').textContent = `${Math.round(a.contextPct)}%`; c.style.setProperty('--pct', `${Math.min(100, a.contextPct)}%`); }
}
function stats(m) {
  $('#stats').textContent = `voice→voice ${m.voiceToVoiceMs ?? '–'} ms · ack ${m.fillerMs ?? '–'} · stt ${m.sttMs ?? '–'} · agent ${m.agentFirstTokenMs ?? '–'} · tts ${m.ttsFirstAudioMs ?? '–'}`;
}

// ------------------------------------------------------------------ permission / overlay / toasts
function permission(p) {
  S.permission = p;
  $('#permission').hidden = !p;
  if (p) { $('#perm-title').textContent = p.title; $('#perm-res').textContent = p.resource || ''; }
  attention();
}
document.querySelectorAll('[data-perm]').forEach((b) => (b.onclick = () => send({ type: 'permission', choice: b.dataset.perm })));
$('#openurl-btn').onclick = () => { send({ type: 'open_url' }); $('#openurl').hidden = true; attention(); };

function overlay({ title, lines = [], picks = [] }) {
  const ov = $('#overlay');
  ov.querySelector('h2').textContent = title;
  ov.querySelector('ul').replaceChildren(...lines.map((l, i) => {
    const li = document.createElement('li'); li.textContent = l;
    if (picks[i]) { li.className = 'pick'; li.onclick = () => { command(picks[i]); ov.hidden = true; }; }
    return li;
  }));
  ov.hidden = false;
}
$('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#overlay').hidden = true; };
function toast(text) {
  if (!text) return;
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = text;
  $('#toasts').append(t);
  setTimeout(() => { t.style.opacity = 0; setTimeout(() => t.remove(), 600); }, 4200);
}
function attention() { stage.dataset.attn = S.ptt || S.pttDown || S.permission || !$('#openurl').hidden ? '1' : '0'; }

// ------------------------------------------------------------------ keyboard
// day theme (pastel, PS1 robot) vs night theme (dark stage, light face/orb); "auto" follows the avatar
function applyTheme() {
  const th = S.theme && S.theme !== 'auto' ? S.theme : (S.avatar === 'bot' || S.avatar === 'human') ? 'day' : 'night';
  if (document.documentElement.dataset.theme !== th) S.snapPalette = true;  // jump, don't fade dark->pastel
  document.documentElement.dataset.theme = th;
}
function setAvatar(a, remember = true) {
  if (!AVATARS.includes(a)) a = 'human';
  if (a !== 'orb' && !({ human, bot, face })[a]) a = human ? 'human' : bot ? 'bot' : face ? 'face' : 'orb';
  S.avatar = a; document.documentElement.dataset.avatar = a;
  applyTheme();
  if (remember) { S.avatarPref = a; try { localStorage.setItem('vocalo.avatar', a); } catch {} }
  orbMount?.setSpeed(a === 'orb' ? 0.5 : 0);
}
function setAspect(a) { S.aspect = a; stage.dataset.aspect = a; try { localStorage.setItem('vocalo.aspect', a); } catch {} }
setAspect(S.aspect);
function openInput(id) { $('#palette').hidden = id !== '#palette'; $('#typebox').hidden = id !== '#typebox'; const i = $(`${id} input`); i.value = ''; i.focus(); }
function closeInputs() { $('#palette').hidden = $('#typebox').hidden = true; document.activeElement?.blur(); }
$('#palette-input').onkeydown = (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); closeInputs(); if (v) command(v); } else if (e.key === 'Escape') closeInputs(); e.stopPropagation(); };
$('#type-input').onkeydown = (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); closeInputs(); if (v) send({ type: 'text', text: v }); } else if (e.key === 'Escape') closeInputs(); e.stopPropagation(); };

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat && !S.pttDown) { S.pttDown = true; attention(); send({ type: 'ptt', active: true }); } return; }
  if (e.metaKey && e.key === 'k') { e.preventDefault(); return openInput('#palette'); }
  if (!$('#overlay').hidden && e.key === 'Escape') { $('#overlay').hidden = true; return; }
  if (S.permission && 'yan'.includes(e.key)) return send({ type: 'permission', choice: { y: 'allow', a: 'always', n: 'reject' }[e.key] });
  switch (e.key) {
    case ':': case '/': e.preventDefault(); return openInput('#palette');
    case 't': e.preventDefault(); return openInput('#typebox');
    case 'Escape': return send({ type: 'interrupt' });
    case 'm': return send({ type: 'mute' });
    case 'r': return setAspect(S.aspect === '16:9' ? '4:3' : '16:9');
    case 'f': return document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
    case 'd': S.stats = !$('#stats').hidden ? false : true; $('#stats').hidden = !S.stats; return;
    case 'c': return hidePanel();
    case 'p': $('#plan').hidden = !$('#plan').hidden || !S.plan.length; return;
    case 'o': if (!$('#openurl').hidden) $('#openurl-btn').click(); return;
    case '?': return command('help');
    case 'v': return setAvatar(AVATARS[(AVATARS.indexOf(S.avatar) + 1) % AVATARS.length]);
  }
});
addEventListener('keyup', (e) => { if (e.code === 'Space' && S.pttDown) { S.pttDown = false; attention(); send({ type: 'ptt', active: false }); } });
addEventListener('blur', () => { if (S.pttDown) { S.pttDown = false; attention(); send({ type: 'ptt', active: false }); } });

// ------------------------------------------------------------------ visuals
const hexToRgb = (h) => { const n = parseInt(h.replace('#', '').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; }
  return [h * 360, s, l];
}
const hsl = (h, s, l, a = 1) => { // -> [r,g,b,a] 0..1 for shader uniforms
  h = ((h % 360) + 360) % 360 / 360;
  const f = (n) => { const k = (n + h * 12) % 12; const q = s * Math.min(l, 1 - l); return l - q * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4), a];
};
const STATE_TINT = { idle: [0, 1, 1], listening: [28, 1.15, 1.08], thinking: [250, 1.05, 1.0], speaking: [190, 1.1, 1.18] };
const ORB = {
  idle: (h) => [hsl(h + 20, 0.5, 0.75), hsl(h - 30, 0.5, 0.55)],
  listening: () => [hsl(38, 1, 0.68), hsl(8, 0.95, 0.6), hsl(330, 0.8, 0.6)],
  thinking: () => [hsl(255, 0.9, 0.7), hsl(195, 0.95, 0.6), hsl(285, 0.8, 0.55)],
  speaking: () => [hsl(0, 0, 1), hsl(190, 0.95, 0.72), hsl(275, 0.9, 0.72)],
};
function paletteFor(base, state) {
  const [h0, s0, l0] = rgbToHsl(hexToRgb(base));
  if (document.documentElement.dataset.theme === 'day') {          // soft pastel sky
    const tint = { idle: 0, listening: 30, thinking: 270, speaking: 195 }[state] ?? 0;
    const h = state === 'idle' ? h0 : h0 * 0.5 + tint * 0.5;
    // analogous hues only: complementary pastels mix to grey
    return [hsl(h + 5, 0.85, 0.87), hsl(h + 35, 0.9, 0.85), hsl(h - 30, 0.85, 0.88), hsl(h + 60, 0.8, 0.9)];
  }
  const [shift, sat, light] = STATE_TINT[state] ?? STATE_TINT.idle;
  const h = state === 'idle' ? h0 : h0 * 0.55 + shift * 0.45;
  const s = Math.min(1, Math.max(0.35, s0) * sat);
  const l = Math.min(0.42, Math.max(0.1, l0)) * light;
  return [hsl(h, s, l * 0.45), hsl(h + 35, s, l * 1.15), hsl(h - 28, s * 0.9, l * 0.85), hsl(h + 180, s * 0.5, l * 0.6)];
}

// face palette per state: [deep, body, rim, eyes], eased in frame()
let avCur = null, avCurFor = null;
function avatarColors(st) {
  const P = { bot: BOT_PALETTES, human: HUMAN_PALETTES }[S.avatar] ?? FACE_PALETTES;
  const goal = (P[st] ?? P.idle)(rgbToHsl(hexToRgb(S.base))[0]);
  if (avCurFor !== S.avatar) { avCur = goal; avCurFor = S.avatar; }
  avCur = avCur.map((c, i) => c.map((v, j) => lerp(v, goal[i][j], 0.06)));
  return avCur;
}
let bgMount, orbMount, borderMount, sizing;
// ?lite renders at lower resolution (software GL, old GPUs, battery saver)
const LITE = new URLSearchParams(location.search).has('lite');
const PX = LITE ? [1, 640 * 360] : [2, 1920 * 1080 * 2];
async function initShaders() {
  try {
    const P = await import('/vendor/shaders/index.js');
    const sz = (o = {}) => ({ u_fit: P.ShaderFitOptions[o.fit ?? 'cover'], u_scale: o.scale ?? 1, u_rotation: 0, u_offsetX: 0, u_offsetY: 0, u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0 });
    sizing = sz;
    const noise = P.getShaderNoiseTexture();
    await (noise.decode ? noise.decode() : new Promise((r) => { noise.onload = r; })); // must be fully loaded before mounting
    const pal = paletteFor(S.base, S.state);
    bgMount = new P.ShaderMount($('#bg'), P.meshGradientFragmentShader, {
      u_colors: pal, u_colorsCount: pal.length, u_distortion: 0.8, u_swirl: 0.15, u_grainMixer: 0, u_grainOverlay: 0.05, ...sz({ fit: 'cover', scale: 1.1 }),
    }, undefined, 0.25, 0, 1, LITE ? PX[1] : 1920 * 1080);
    orbMount = new P.ShaderMount($('#orb'), P.smokeRingFragmentShader, {
      u_colorBack: [0, 0, 0, 0], u_colors: ORB.idle(200), u_colorsCount: 2, u_noiseScale: 3, u_noiseIterations: 8,
      u_thickness: 0.6, u_radius: 0.25, u_innerShape: 0.7, u_noiseTexture: noise, ...sz({ fit: 'contain', scale: 0.62 }),
    }, { premultipliedAlpha: true, alpha: true }, 0.5, 0, PX[0], PX[1]);
    try { human = createHuman($('#human'), { lite: LITE }); human.setState(S.state); } catch (e) { console.warn('human unavailable', e); }
    try { bot = createBot($('#bot'), { lite: LITE }); bot.setState(S.state); } catch (e) { console.warn('bot unavailable', e); }
    try { face = new Face($('#face'), { lite: LITE }); face.setState(S.state); } catch (e) { console.warn('face unavailable', e); }
    window.__vocalo = { face, bot, human, S };
    S.ready = true;
    setAvatar(S.avatarPref || S.cfgAvatar || 'human', false);
    if (LITE) document.documentElement.classList.add('no-border');
    else borderMount = new P.ShaderMount($('#border'), P.pulsingBorderFragmentShader, {
      u_colorBack: [0, 0, 0, 0], u_colors: [hsl(38, 1, 0.6), hsl(330, 0.9, 0.6), hsl(200, 0.9, 0.6)], u_colorsCount: 3,
      u_roundness: 0.06, u_thickness: 0.05, u_softness: 0.8, u_marginLeft: 0, u_marginRight: 0, u_marginTop: 0, u_marginBottom: 0,
      u_aspectRatio: 0, u_intensity: 0.25, u_bloom: 0.35, u_spots: 4, u_spotSize: 0.45, u_pulse: 0.35, u_smoke: 0.25, u_smokeSize: 0.5,
      u_noiseTexture: noise, ...sz({ fit: 'cover', scale: 1 }),
    }, { premultipliedAlpha: true, alpha: true }, 1, 0, PX[0], PX[1]);
  } catch (err) {
    console.warn('shaders unavailable, using CSS fallback', err);
    document.documentElement.classList.add('no-webgl', 'no-border');
  }
}

// One rAF loop eases everything toward state + audio targets.
let cur = { pal: paletteFor(S.base, 'idle'), radius: 0.25, thick: 0.6, distortion: 0.8, swirl: 0.15, speed: 0.25, orbSpeed: 0.5 };
const lerp = (a, b, t) => a + (b - a) * t;
const lerpCol = (a, b, t) => a.map((c, i) => c.map((v, j) => lerp(v, b[i]?.[j] ?? v, t)));
function frame() {
  const st = S.state;
  // envelope follower: fast attack, slow release
  const target = st === 'speaking' ? S.out : st === 'listening' || S.pttDown ? S.mic : Math.max(S.mic * 0.4, S.out);
  S.lvl = target > S.lvl ? lerp(S.lvl, target, 0.5) : lerp(S.lvl, target, 0.08);
  const L = Math.min(1, S.lvl * 1.6);
  const goal = {
    pal: paletteFor(S.base, st),
    radius: { idle: 0.22, listening: 0.24 + L * 0.14, thinking: 0.2, speaking: 0.23 + L * 0.16 }[st] ?? 0.22,
    thick: { idle: 0.55, listening: 0.62 + L * 0.3, thinking: 0.85, speaking: 0.6 + L * 0.35 }[st] ?? 0.6,
    distortion: 0.7 + L * 0.3, swirl: st === 'thinking' ? 0.6 : 0.12 + L * 0.25,
    speed: { idle: 0.18, listening: 0.3, thinking: 0.9, speaking: 0.35 + L * 0.8 }[st] ?? 0.25,
    orbSpeed: { idle: 0.35, listening: 0.6 + L, thinking: 1.6, speaking: 0.7 + L * 1.4 }[st] ?? 0.5,
  };
  const k = 0.06;
  if (S.snapPalette) { cur.pal = goal.pal; S.snapPalette = false; }
  cur = {
    pal: lerpCol(cur.pal, goal.pal, 0.03), radius: lerp(cur.radius, goal.radius, 0.25), thick: lerp(cur.thick, goal.thick, 0.2),
    distortion: lerp(cur.distortion, goal.distortion, k), swirl: lerp(cur.swirl, goal.swirl, k), speed: lerp(cur.speed, goal.speed, k), orbSpeed: lerp(cur.orbSpeed, goal.orbSpeed, 0.1),
  };
  if (bgMount) { bgMount.setUniforms({ u_colors: cur.pal, u_distortion: cur.distortion, u_swirl: cur.swirl }); bgMount.setSpeed(cur.speed); }
  if (orbMount) {
    const oc = (ORB[st] ?? ORB.idle)(rgbToHsl(hexToRgb(S.base))[0]);
    orbMount.setUniforms({ u_radius: cur.radius, u_thickness: cur.thick, u_colors: oc, u_colorsCount: oc.length });
    orbMount.setSpeed(cur.orbSpeed);
  }
  const av = avatar();
  if (av) {
    av.setLevels(S.mic, S.out, S.bands);
    av.setColors(avatarColors(st));
    av.frame();
  }
  document.documentElement.style.setProperty('--lvl', String(1 + L * 0.25));
  $('#bg-fallback').style.background = `radial-gradient(120% 90% at 30% 20%, rgba(${cur.pal[1].slice(0, 3).map((v) => v * 255 | 0)}) 0%, rgba(${cur.pal[0].slice(0, 3).map((v) => v * 255 | 0)}) 60%, #05060a 100%)`;
  requestAnimationFrame(frame);
}

initShaders().then(() => requestAnimationFrame(frame));
connect();

// the face follows the pointer a little (it knows you're there)
addEventListener('pointermove', (e) => {
  const face = avatar();
  if (!face) return;
  const r = $('#orb-wrap').getBoundingClientRect();
  const x = (e.clientX - (r.left + r.width / 2)) / (innerWidth / 2), y = -(e.clientY - (r.top + r.height / 2)) / (innerHeight / 2);
  face.lookAt(Math.max(-1, Math.min(1, x)) * 0.8, Math.max(-1, Math.min(1, y)) * 0.8, 1200);
});
