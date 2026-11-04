// "TV" terminal UI: a 16:9 / 4:3 stage with background colour, lower-third title,
// optional image/screenshot, on-screen code, and broadcast-style subtitles for
// both speakers. Pure ANSI (truecolor), no dependencies.
// Images: iTerm2 (OSC 1337) and kitty/Ghostty/WezTerm (kitty graphics) protocols.
import { readFile } from 'node:fs/promises';

const ESC = '\x1b[';
const hex = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const bg = ([r, g, b]) => `${ESC}48;2;${r};${g};${b}m`;
const fg = ([r, g, b]) => `${ESC}38;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`, BOLD = `${ESC}1m`, DIM = `${ESC}2m`;
const shade = ([r, g, b], f) => [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
const visLen = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;

function wrap(text, width, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (visLen(cur ? cur + ' ' + w : w) > width) { if (cur) lines.push(cur); cur = w.length > width ? w.slice(0, width) : w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return maxLines ? lines.slice(-maxLines) : lines; // keep the most recent lines, like live captions
}

function detectImageProtocol() {
  const t = process.env.TERM_PROGRAM || '';
  if (process.env.KITTY_WINDOW_ID || /ghostty/i.test(t) || /WezTerm/i.test(t) || /kitty/i.test(process.env.TERM || '')) return 'kitty';
  if (/iTerm/i.test(t)) return 'iterm';
  return null;
}

export class TvUI {
  constructor({ aspect = '16:9', out = process.stdout, inp = process.stdin } = {}) {
    this.out = out; this.inp = inp;
    this.aspect = aspect;
    this.imgProto = detectImageProtocol();
    this.s = {
      state: 'idle', bg: [16, 24, 32], title: 'Vocalo', caption: '', image: null, code: null,
      assistant: '', assistantShown: '', user: '', userPartial: '', tool: '', metrics: null,
      permission: null, typing: false, input: '', mode: 'vad', muted: false, notice: '',
    };
    this.handlers = {};
    this.dirty = true;
    this.imageDrawnKey = null;
  }

  on(evt, fn) { this.handlers[evt] = fn; return this; }
  #fire(evt, ...a) { this.handlers[evt]?.(...a); }

  start() {
    this.out.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.setEncoding('utf8');
    this.inp.on('data', (k) => this.#onKey(k));
    this.out.on('resize', () => { this.imageDrawnKey = null; this.out.write(`${ESC}2J`); this.dirty = true; });
    this.timer = setInterval(() => { this.#tick(); if (this.dirty) this.render(); }, 33);
    return this;
  }

  stop() {
    clearInterval(this.timer);
    if (this.inp.isTTY) this.inp.setRawMode(false);
    this.out.write(`${RESET}\x1b[?25h\x1b[?1049l`);
  }

  set(patch) {
    if (patch.notice) { // notices fade after a while instead of sticking forever
      clearTimeout(this.noticeTimer);
      this.noticeTimer = setTimeout(() => this.set({ notice: '' }), 8000);
    }
    Object.assign(this.s, patch); this.dirty = true;
  }

  // Subtitle reveal paced to the audio duration -> words appear as they are spoken.
  subtitle(text, durationMs = 2000) {
    this.reveal = { words: text.split(/\s+/), start: Date.now(), dur: Math.max(300, durationMs * 0.92) };
    this.set({ assistant: text, assistantShown: '' });
  }
  #tick() {
    const r = this.reveal;
    if (!r) return;
    const n = Math.min(r.words.length, Math.ceil(((Date.now() - r.start) / r.dur) * r.words.length));
    const shown = r.words.slice(0, Math.max(1, n)).join(' ');
    if (shown !== this.s.assistantShown) this.set({ assistantShown: shown });
    if (n >= r.words.length) this.reveal = null;
  }

  scene(tag) {
    if (tag.kind === 'scene') {
      const patch = {};
      if (tag.bg) patch.bg = hex(tag.bg) ?? this.s.bg;
      if (tag.title !== undefined) patch.title = tag.title;
      if (tag.caption !== undefined) patch.caption = tag.caption;
      if (tag.image) patch.image = { src: tag.image };
      this.set(patch);
    } else if (tag.kind === 'show') {
      this.set({ image: tag.image || tag.imageData ? { src: tag.image, data: tag.imageData } : null, caption: tag.caption ?? this.s.caption, code: null });
    } else if (tag.kind === 'clear') {
      this.set({ image: null, code: null, caption: '' });
    }
    this.imageDrawnKey = null;
  }

  #onKey(data) {
    // Pasted/batched input arrives as one chunk: process char by char (escape sequences whole).
    if (data.startsWith('\x1b[') || data.startsWith('\x1bO')) return; // arrows etc. ignored
    for (const ch of data) this.#key(ch);
  }

  #key(k) {
    if (k === '\x03') return this.#fire('quit');
    const s = this.s;
    if (s.typing) {
      if (k === '\r' || k === '\n') { const t = s.input; this.set({ typing: false, input: '' }); if (t.trim()) this.#fire('text', t); }
      else if (k === '\x1b') this.set({ typing: false, input: '' });
      else if (k === '\x7f') this.set({ input: s.input.slice(0, -1) });
      else if (k >= ' ') this.set({ input: s.input + k });
      return;
    }
    if (s.permission) {
      if (k === 'y') return this.#fire('permission', 'allow');
      if (k === 'a') return this.#fire('permission', 'always');
      if (k === 'n') return this.#fire('permission', 'reject');
    }
    switch (k) {
      case 'q': return this.#fire('quit');
      case ' ': return this.#fire('ptt');
      case '\t': case 't': return this.set({ typing: true });
      case 'm': return this.#fire('mute');
      case 'i': case '\x1b': return this.#fire('interrupt');
      case 'v': return this.#fire('mode');
      case 'r': this.aspect = this.aspect === '16:9' ? '4:3' : '16:9'; this.imageDrawnKey = null; this.out.write(`${ESC}2J`); this.dirty = true; return;
    }
  }

  #frame() {
    const cols = this.out.columns || 100, rows = this.out.rows || 32;
    const [aw, ah] = this.aspect === '4:3' ? [4, 3] : [16, 9];
    const availRows = rows - 3; // footer lines
    let W = cols - 2, H = Math.round((W * ah) / aw / 2.1);
    if (H > availRows) { H = availRows; W = Math.round((H * 2.1 * aw) / ah); }
    W = Math.max(40, Math.min(W, cols)); H = Math.max(12, H);
    return { W, H, x0: Math.max(1, Math.floor((cols - W) / 2) + 1), y0: 1, cols, rows };
  }

  render() {
    this.dirty = false;
    const s = this.s;
    const { W, H, x0, y0, rows } = this.#frame();
    const base = s.bg, dark = shade(base, 0.55), light = shade(base, 1.6);
    const out = [];
    const at = (y, x) => `${ESC}${y};${x}H`;
    const center = (txt, width = W) => { const l = visLen(txt); const p = Math.max(0, Math.floor((width - l) / 2)); return ' '.repeat(p) + txt + ' '.repeat(Math.max(0, width - p - l)); };
    const pad = (txt, width = W) => txt + ' '.repeat(Math.max(0, width - visLen(txt)));

    // Image box (cells we must not overwrite)
    const imgBox = s.image ? { x: x0 + Math.floor(W * 0.2), y: y0 + 3, w: Math.floor(W * 0.6), h: Math.max(4, H - 12) } : null;

    const lines = new Array(H).fill(null);
    // header
    const live = s.state === 'speaking' ? `${bg([200, 30, 45])}${fg([255, 255, 255])}${BOLD} LIVE ${RESET}${bg(base)}` : '';
    const stateIcon = { idle: '○ ready', listening: '● listening', thinking: '◌ thinking', speaking: '◉ speaking' }[s.state] || s.state;
    const left = `${fg(light)}${BOLD} ▌VOCALO ${RESET}${bg(base)} ${live}`;
    const right = `${fg(shade(light, 1.2))}${stateIcon}${s.muted ? ' · mic off' : ''} · ${s.mode === 'ptt' ? 'push-to-talk' : 'hands-free'} `;
    const mid = (s.code || s.image) && s.title ? `${fg([255, 255, 255])}${BOLD}${s.title}${RESET}${bg(base)}` : '';
    const gap = Math.max(2, W - visLen(left) - visLen(right) - visLen(mid));
    lines[0] = left + ' '.repeat(Math.floor(gap / 2)) + mid + ' '.repeat(Math.ceil(gap / 2)) + right;

    // center: code or title/caption
    const midTop = 3;
    if (s.code && !s.image) {
      const codeLines = s.code.replace(/\t/g, '  ').split('\n').slice(0, H - 11);
      const cw = Math.min(W - 6, Math.max(...codeLines.map((l) => l.length), 20) + 2);
      const cx = Math.floor((W - cw) / 2);
      codeLines.forEach((l, i) => {
        lines[midTop + i] = ' '.repeat(cx) + `${bg([12, 12, 16])}${fg([190, 230, 190])} ${l.slice(0, cw - 2).padEnd(cw - 1)}${RESET}${bg(base)}`;
      });
    } else if (!s.image && s.title) {
      const ty = Math.floor(H / 2) - 3;
      lines[ty] = `${fg([255, 255, 255])}${BOLD}` + center(s.title.toUpperCase().split('').join(' ')) + RESET;
      if (s.caption) lines[ty + 2] = `${fg(light)}` + center(s.caption) + RESET;
    }

    // tool ticker
    if (s.tool) lines[H - 7] = `${fg(shade(light, 1.1))}${DIM}` + center(`⚙ ${s.tool}`) + RESET;

    // subtitles (assistant 2 lines, user 1-2 lines)
    const subW = Math.floor(W * 0.84);
    const aLines = wrap(s.assistantShown || '', subW - 2, 2);
    const subBg = [0, 0, 0];
    aLines.forEach((l, i) => {
      const y = H - 5 + i;
      const box = `${bg(subBg)}${fg([255, 255, 255])}${BOLD} ${l} ${RESET}${bg(base)}`;
      lines[y] = center(box);
    });
    const userTxt = s.userPartial || s.user;
    if (userTxt) {
      const uLines = wrap(userTxt, subW - 6, 2);
      uLines.forEach((l, i) => {
        const y = H - 3 + i;
        const col = s.userPartial ? fg([255, 225, 120]) + DIM : fg([255, 210, 80]);
        lines[y] = center(`${col}${i === 0 ? 'YOU ▸ ' : '      '}${l}${RESET}${bg(base)}`);
      });
    }

    // caption under image
    if (s.image && s.caption) lines[imgBox.y - y0 + imgBox.h] = `${fg(light)}` + center(s.caption) + RESET;

    // paint
    for (let r = 0; r < H; r++) {
      const y = y0 + r;
      const rowBg = r === 0 ? dark : base;
      const content = lines[r] ?? '';
      if (imgBox && y >= imgBox.y && y < imgBox.y + imgBox.h && !lines[r]) {
        const leftW = imgBox.x - x0, rightW = W - leftW - imgBox.w;
        out.push(at(y, x0) + bg(rowBg) + ' '.repeat(leftW) + at(y, imgBox.x + imgBox.w) + ' '.repeat(rightW));
      } else {
        out.push(at(y, x0) + bg(rowBg) + pad(content.replaceAll(bg(base), bg(rowBg))) + RESET);
      }
    }

    // footer (outside the frame)
    const m = s.metrics;
    const metr = m ? `voice→voice ${m.voiceToVoiceMs ?? '–'}ms · stt ${m.sttMs ?? '–'} · agent ${m.agentFirstTokenMs ?? '–'} · tts ${m.ttsFirstAudioMs ?? '–'}` : '';
    const keys = s.typing ? `${BOLD}type ▸ ${RESET}${s.input}█  (Enter send · Esc cancel)` :
      s.permission ? `${BOLD}${fg([255, 200, 0])}Permission: ${s.permission}${RESET}  [y] allow  [a] always  [n] deny  (or say yes / no)` :
      `${DIM}[space] talk  [t] type  [i] interrupt  [m] mute  [v] hands-free/PTT  [r] 16:9/4:3  [q] quit${RESET}`;
    out.push(at(y0 + H, 1) + `${ESC}2K` + ' ' + keys);
    out.push(at(y0 + H + 1, 1) + `${ESC}2K` + ` ${DIM}${metr}${s.notice ? '  · ' + s.notice : ''}${RESET}`);
    for (let y = y0 + H + 2; y <= rows; y++) out.push(at(y, 1) + `${ESC}2K`);
    this.out.write(out.join(''));

    if (imgBox) this.#drawImage(imgBox);
  }

  async #drawImage(box) {
    if (!this.imgProto) return;
    const key = `${this.s.image.src ?? 'data'}|${box.x},${box.y},${box.w},${box.h}`;
    if (this.imageDrawnKey === key) return;
    this.imageDrawnKey = key;
    try {
      let b64 = this.s.image.data;
      if (!b64) {
        const src = this.s.image.src;
        const buf = /^https?:/.test(src) ? Buffer.from(await (await fetch(src)).arrayBuffer()) : await readFile(src);
        b64 = buf.toString('base64');
      }
      if (this.imageDrawnKey !== key) return;
      const pos = `${ESC}${box.y};${box.x}H`;
      if (this.imgProto === 'iterm') {
        this.out.write(`${pos}\x1b]1337;File=inline=1;width=${box.w};height=${box.h};preserveAspectRatio=1:${b64}\x07`);
      } else {
        this.out.write(`${pos}\x1b_Ga=d\x1b\\`); // delete previous placements
        for (let i = 0; i < b64.length; i += 4096) {
          const chunk = b64.slice(i, i + 4096), more = i + 4096 < b64.length ? 1 : 0;
          const ctl = i === 0 ? `a=T,f=100,c=${box.w},r=${box.h},m=${more}` : `m=${more}`;
          this.out.write(`\x1b_G${ctl};${chunk}\x1b\\`);
        }
      }
    } catch (err) {
      this.set({ notice: `image failed: ${err.message}` });
    }
  }
}
